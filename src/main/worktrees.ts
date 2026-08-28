import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db, dataDir } from './db';
import { listProjects } from './store';
import { listSessions } from './sessions';
import type { WorktreeInfo } from '../shared/types';

const exec = promisify(execFile);

/**
 * Three agents on one working tree overwrite each other's edits, and the loser
 * never finds out. A worktree gives each session its own checkout and its own
 * branch off the same repo, so "who wrote this file" has one answer.
 */

/* ── git ─────────────────────────────────────────────────────────────── */

type Git = { ok: boolean; stdout: string; stderr: string };

/**
 * Always argv, never a shell string: a branch label is user text, and
 * `foreman/fix; rm -rf ~` is not a bug you want to find in production. It also
 * means a label with a space stays one argument.
 *
 * Exit status is returned rather than thrown because half of what this module
 * does is ask git a question where "that failed" is the answer (is this a repo,
 * does this branch exist, is there anything to merge).
 */
async function git(cwd: string, args: string[], timeout = 20_000): Promise<Git> {
  try {
    const { stdout, stderr } = await exec('git', ['-C', cwd, ...args], {
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr || err.message || '' };
  }
}

/** git's own last word, for quoting inside a sentence the user has to act on. */
function gitSaid(r: Git): string {
  const lines = (r.stderr || r.stdout).split('\n').map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? 'no output';
}

/**
 * Every path is compared after realpath. On macOS the same worktree is
 * /var/… to git and /private/var/… to Node, and a mismatch here silently turns
 * one worktree into two rows — one of which can never be found again.
 */
function canon(p: string): string {
  const abs = path.resolve(p);
  try { return fs.realpathSync(abs); } catch { return abs; }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/* ── rows ────────────────────────────────────────────────────────────── */

type Row = {
  path: string;
  repo_root: string;
  branch: string | null;
  session_id: string | null;
  created_at: number;
  removed_at: number | null;
};

function rowFor(p: string): Row | undefined {
  return db().prepare('SELECT * FROM worktrees WHERE path = ? AND removed_at IS NULL').get(p) as Row | undefined;
}

function markRemoved(p: string) {
  db().prepare('UPDATE worktrees SET removed_at = ? WHERE path = ? AND removed_at IS NULL').run(Date.now(), p);
}

/* ── repo identity ───────────────────────────────────────────────────── */

/**
 * The repo root for any directory, or null when it is not a repo at all.
 *
 * Inside a linked worktree `--show-toplevel` is the *worktree*, not the repo it
 * belongs to. Everything here is keyed by repo, so without the common-dir hop
 * two worktrees of one repo look like two unrelated repos and reconcile stops
 * finding either of them.
 */
export async function repoRootFor(dir: string): Promise<string | null> {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) return null;

  const top = await git(abs, ['rev-parse', '--show-toplevel'], 8000);
  if (!top.ok || !top.stdout.trim()) return null;

  const common = await git(abs, ['rev-parse', '--git-common-dir'], 8000);
  if (common.ok && common.stdout.trim()) {
    // Relative ('.git') when git is run at the top, absolute from a subdir.
    const c = path.resolve(abs, common.stdout.trim());
    if (path.basename(c) === '.git') return canon(path.dirname(c));
  }
  return canon(top.stdout.trim());
}

async function currentBranch(dir: string): Promise<string | null> {
  const r = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], 8000);
  const b = r.ok ? r.stdout.trim() : '';
  return b && b !== 'HEAD' ? b : null;
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  const r = await git(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], 8000);
  return r.ok;
}

/**
 * The branch a worktree was cut from, written into the repo's own config at
 * creation.
 *
 * It lives in git rather than in the worktrees table because the merge target
 * has to survive the two things that routinely go missing: the row (a crash
 * before the INSERT, or a wiped database) and the repo's current HEAD (the user
 * switched branches an hour ago). The config travels with the repo.
 */
async function recordedBase(repoRoot: string, branch: string | null): Promise<string | null> {
  if (!branch) return null;
  const r = await git(repoRoot, ['config', '--get', `branch.${branch}.foremanbase`], 8000);
  const v = r.ok ? r.stdout.trim() : '';
  return v || null;
}

/**
 * For the ahead count only. A worktree Foreman did not create has no recorded
 * base, and "ahead of the branch the repo itself is on" is a useful number even
 * though it is a guess — which is exactly why merge refuses to use it.
 */
async function baseForCount(repoRoot: string, branch: string | null): Promise<string | null> {
  const recorded = await recordedBase(repoRoot, branch);
  if (recorded) return recorded;
  const main = await currentBranch(repoRoot);
  return main && main !== branch ? main : null;
}

/** Untracked files are counted too: `worktree remove` deletes them with the rest. */
function countPorcelain(z: string): number {
  const parts = z.split('\0').filter(Boolean);
  let n = 0;
  for (let i = 0; i < parts.length; i++) {
    const index = parts[i][0] ?? ' ';
    // A rename carries its source path as a second NUL-separated field.
    if (index === 'R' || index === 'C') i++;
    n++;
  }
  return n;
}

/** Null count means git could not tell us — which is not the same as clean. */
type Dirty = { count: number; said: null } | { count: null; said: string };

/**
 * Collapsing a failed `git status` to 0 was the bug this shape exists to stop:
 * a timeout on a large or network-mounted tree, or a maxBuffer overflow from a
 * huge untracked directory, read as "the tree is clean". Every caller treats 0
 * as proof of cleanliness, so the merge and remove refusals were skipped
 * precisely when git was in trouble — and a conflicted merge then runs
 * `merge --abort` / `reset --merge` over the user's uncommitted edits, which is
 * the exact loss those refusals exist to prevent.
 */
async function dirtyCount(dir: string): Promise<Dirty> {
  const r = await git(dir, ['status', '--porcelain=v1', '-z'], 30_000);
  return r.ok ? { count: countPorcelain(r.stdout), said: null } : { count: null, said: gitSaid(r) };
}

/* ── the worktree list git itself keeps ──────────────────────────────── */

type Record_ = { path: string; head: string | null; branch: string | null; locked: boolean; prunable: boolean };

async function porcelainWorktrees(repoRoot: string): Promise<Record_[]> {
  const r = await git(repoRoot, ['worktree', 'list', '--porcelain'], 20_000);
  if (!r.ok) return [];
  const out: Record_[] = [];
  let bare = false;
  let cur: Record_ | null = null;
  const flush = () => { if (cur && !bare) out.push(cur); cur = null; bare = false; };

  for (const raw of r.stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('worktree ')) {
      flush();
      cur = { path: line.slice(9), head: null, branch: null, locked: false, prunable: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice(5).trim() || null;
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '') || null;
    } else if (line === 'bare') {
      bare = true;
    } else if (line.startsWith('locked')) {
      cur.locked = true;
    } else if (line.startsWith('prunable')) {
      cur.prunable = true;
    }
  }
  flush();
  return out;
}

/* ── create ──────────────────────────────────────────────────────────── */

function slugify(label: string): string {
  const s = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return s || 'work';
}

function shortId(sessionId: string): string {
  const alnum = sessionId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return alnum.slice(-6) || Math.random().toString(36).slice(2, 8);
}

/**
 * A worktree per session, parked outside the repo.
 *
 * Outside is the whole point: a worktree inside the repo appears in the repo's
 * own `ls`, in every glob, and in the agent's file search — so a coding agent
 * finds a second copy of the codebase it is editing and starts patching the
 * wrong one. Under dataDir() it is invisible to the repo and still on the same
 * filesystem, which `git worktree add` needs.
 */

/* ── the thing a worktree silently loses ─────────────────────────────────
   `git worktree add` checks out TRACKED files. Everything gitignored stays
   behind — which on a Composer or npm project is the entire dependency tree,
   the local env file, and often the config a hook needs. The agent then lands
   in a checkout that cannot autoload, cannot run tests, and fails its
   SessionStart hook on a path that plainly exists in the repo it came from.
   That failure names the missing file, never the missing directory, so it
   reads as a broken hook rather than a broken checkout.

   So the ignored heavyweights are linked back to the source repo. Sharing them
   is what people already do by hand with worktrees: they are generated or
   machine-local, not the work under review, and a copy of 258 MB per session
   is its own bug.
   ──────────────────────────────────────────────────────────────────────── */

const LINK_DIRS = [
  'vendor', 'node_modules', 'bower_components', '.venv', 'venv', '.yarn',
  'Pods', '.bundle', 'target', '.gradle', '.next/cache', 'vendor/bin',
];
const LINK_FILES = [
  '.env', '.env.local', '.env.development', '.env.development.local',
  'auth.json', '.npmrc', '.tool-versions',
];

export type LinkedPath = { path: string; kind: 'dir' | 'file'; bytes: number | null };

/** Only link what git is actually ignoring — a tracked path is already there. */
async function isIgnored(repoRoot: string, rel: string): Promise<boolean> {
  const r = await git(repoRoot, ['check-ignore', '-q', rel], 5000);
  return r.ok;
}

async function linkIgnoredDeps(repoRoot: string, worktree: string): Promise<LinkedPath[]> {
  const linked: LinkedPath[] = [];
  const consider = [
    ...LINK_DIRS.map((p) => ({ rel: p, kind: 'dir' as const })),
    ...LINK_FILES.map((p) => ({ rel: p, kind: 'file' as const })),
  ];
  for (const { rel, kind } of consider) {
    const src = path.join(repoRoot, rel);
    const dst = path.join(worktree, rel);
    try {
      const st = fs.statSync(src);
      if (kind === 'dir' ? !st.isDirectory() : !st.isFile()) continue;
    } catch { continue; }
    if (fs.existsSync(dst)) continue;
    if (!(await isIgnored(repoRoot, rel))) continue;
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.symlinkSync(src, dst, kind === 'dir' ? 'dir' : 'file');
      let bytes: number | null = null;
      try { bytes = kind === 'file' ? fs.statSync(src).size : null; } catch { /* size is a nicety */ }
      linked.push({ path: rel, kind, bytes });
    } catch { /* a link we cannot make is not worth failing the worktree over */ }
  }
  return linked;
}

export async function createWorktree(repoRoot: string, label: string, sessionId: string): Promise<WorktreeInfo> {
  const root = await repoRootFor(repoRoot);
  if (!root) {
    throw new Error(`${repoRoot} is not a git repository, so there is nothing to branch from. Add the project's repo root instead, or run this session without isolation.`);
  }

  const headR = await git(root, ['rev-parse', 'HEAD'], 8000);
  if (!headR.ok) {
    throw new Error(`${path.basename(root)} has no commits yet — git cannot create a worktree from an empty history. Make one commit, then isolate the session.`);
  }
  const head = headR.stdout.trim();
  const baseBranch = await currentBranch(root);
  // Detached HEAD is legal; it just means merge later has no branch to aim at,
  // which mergeWorktree says out loud rather than guessing.
  const startPoint = baseBranch ?? head;

  const parent = path.join(dataDir(), 'worktrees');
  fs.mkdirSync(parent, { recursive: true });

  const short = shortId(sessionId);
  const slug = slugify(label);
  const stem = `${path.basename(root)}-${short}`;
  let dir = path.join(parent, stem);
  let branch = `foreman/${slug}-${short}`;
  // A re-run of the same session, or two labels colliding on one short id, must
  // not land on an existing branch — git would refuse, and forcing it would
  // reset someone else's work.
  for (let n = 2; fs.existsSync(dir) || (await branchExists(root, branch)); n++) {
    if (n > 50) {
      throw new Error(`Could not find a free worktree name for ${path.basename(root)} — 50 of them already exist under ${parent}. Remove the ones you are done with first.`);
    }
    dir = path.join(parent, `${stem}-${n}`);
    branch = `foreman/${slug}-${short}-${n}`;
  }

  // A worktree add is a full checkout; on a big repo that is minutes, and the
  // default timeout would abandon it half-written with the branch already made.
  const add = await git(root, ['worktree', 'add', '-b', branch, dir, startPoint], 10 * 60_000);
  if (!add.ok) {
    throw new Error(`Could not create a worktree for "${label}": ${gitSaid(add)}. The repo is untouched; check that ${parent} is writable and on the same filesystem as the repo.`);
  }

  // This config value is the only record of the merge target: recordedBase()
  // reads it and mergeWorktree hard-refuses without it. Discarding the result
  // turned a dropped write into a worktree that can never be merged from the
  // UI, blamed on a "missing record" rather than on the write that failed.
  // Two sessions launched at once contend for .git/config's lockfile and git
  // does not retry, so a lost race is the common case — retry once, briefly.
  const writeBase = () => git(root, ['config', `branch.${branch}.foremanbase`, startPoint], 8000);
  let cfg = await writeBase();
  if (!cfg.ok) {
    await new Promise((r) => setTimeout(r, 150));
    cfg = await writeBase();
  }
  if (!cfg.ok) {
    throw new Error(`The worktree at ${dir} was created, but Foreman could not record which branch it came from (${gitSaid(cfg)}), so merging it from Foreman would not work. Record it by hand and reconcile: git -C ${root} config branch.${branch}.foremanbase ${startPoint}`);
  }

  const abs = canon(dir);
  const now = Date.now();
  db().prepare(`
    INSERT INTO worktrees (path, repo_root, branch, session_id, created_at, removed_at)
    VALUES (?,?,?,?,?,NULL)
    ON CONFLICT(path) DO UPDATE SET
      repo_root = excluded.repo_root, branch = excluded.branch,
      session_id = excluded.session_id, created_at = excluded.created_at, removed_at = NULL
  `).run(abs, root, branch, sessionId, now);

  // Link before the caller launches an agent into it: a session that starts
  // without vendor/ fails its first hook and cannot autoload, and the error it
  // prints names a file rather than the directory that is really missing.
  const linked = await linkIgnoredDeps(root, abs);
  if (linked.length) {
    db().prepare('UPDATE worktrees SET linked_json = ? WHERE path = ?')
      .run(JSON.stringify(linked.map((l) => l.path)), abs);
  }

  return { path: abs, branch, head, repoRoot: root, sessionId, dirty: 0, ahead: 0, linked };
}

/**
 * Repair a worktree made before linking existed, or one whose links were
 * removed. Safe to run repeatedly: an existing path is never replaced.
 */
export async function relinkWorktree(worktreePath: string): Promise<LinkedPath[]> {
  const row = db().prepare('SELECT repo_root FROM worktrees WHERE path = ?').get(canon(worktreePath)) as
    { repo_root: string } | undefined;
  if (!row) throw new Error(`Foreman has no record of a worktree at ${worktreePath}.`);
  return linkIgnoredDeps(row.repo_root, canon(worktreePath));
}

/* ── inspect ─────────────────────────────────────────────────────────── */

/**
 * Everything worktreeStatus reports, plus whether the dirty count is a real
 * answer. WorktreeInfo.dirty is a plain number the UI renders, so the "git
 * could not say" case has to ride alongside it — the destructive operations
 * need it, and re-running `git status` in merge and remove would mean a second
 * 30s wait in exactly the case where the first one already timed out.
 */
async function inspect(p: string): Promise<{ info: WorktreeInfo; dirty: Dirty } | null> {
  const abs = canon(p);
  if (!fs.existsSync(abs)) return null;

  const inside = await git(abs, ['rev-parse', '--is-inside-work-tree'], 8000);
  if (!inside.ok || inside.stdout.trim() !== 'true') return null;

  const repoRoot = await repoRootFor(abs);
  if (!repoRoot) return null;

  const [branch, headR, dirty] = await Promise.all([
    currentBranch(abs),
    git(abs, ['rev-parse', 'HEAD'], 8000),
    dirtyCount(abs),
  ]);
  const head = headR.ok ? headR.stdout.trim() || null : null;

  let ahead = 0;
  const base = await baseForCount(repoRoot, branch);
  if (base && head) {
    const r = await git(abs, ['rev-list', '--count', `${base}..HEAD`], 20_000);
    if (r.ok) ahead = Number(r.stdout.trim()) || 0;
  }

  const info: WorktreeInfo = {
    path: abs, branch, head, repoRoot,
    sessionId: rowFor(abs)?.session_id ?? null,
    // Unknown shows as 0 in the list, which is only a display: nothing
    // destructive is decided from this field — merge and remove read `dirty`.
    dirty: dirty.count ?? 0,
    ahead,
  };
  return { info, dirty };
}

/** Null when the path is gone or was never a worktree — both are normal. */
export async function worktreeStatus(p: string): Promise<WorktreeInfo | null> {
  return (await inspect(p))?.info ?? null;
}

/** The repo's linked worktrees. The main working tree is not one of these. */
export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
  const root = await repoRootFor(repoRoot);
  if (!root) return [];

  const out: WorktreeInfo[] = [];
  for (const rec of await porcelainWorktrees(root)) {
    const abs = canon(rec.path);
    if (abs === root) continue;
    const info = await worktreeStatus(abs);
    // git still lists a worktree whose directory a user deleted by hand. Show it
    // so the UI has something to click; removeWorktree prunes it.
    out.push(info ?? {
      path: abs, branch: rec.branch, head: rec.head, repoRoot: root,
      sessionId: rowFor(abs)?.session_id ?? null, dirty: 0, ahead: 0,
    });
  }
  return out;
}

/* ── merge ───────────────────────────────────────────────────────────── */

async function conflictedFiles(dir: string): Promise<string[]> {
  const r = await git(dir, ['diff', '--name-only', '--diff-filter=U', '-z'], 20_000);
  return r.ok ? r.stdout.split('\0').filter(Boolean) : [];
}

function nameList(files: string[]): string {
  const shown = files.slice(0, 8).join(', ');
  return files.length > 8 ? `${shown}, and ${files.length - 8} more` : shown;
}

/**
 * Merges the worktree's branch back into the branch it was cut from.
 *
 * Refusals are returned, not thrown: every one of them is a state the user can
 * fix and retry, and a thrown error in the middle of a merge reads like the
 * repo broke. A conflict is never resolved here — the merge is aborted so the
 * target tree is exactly as it was, and the conflicting files are named so a
 * human can do it in the worktree where the context lives.
 */
export async function mergeWorktree(
  p: string,
  opts?: { squash?: boolean; message?: string }
): Promise<{ merged: boolean; detail: string }> {
  const found = await inspect(p);
  if (!found) throw new Error(`There is no git worktree at ${p} — it may already have been removed. Reconcile the worktree list and try again.`);
  const { info, dirty } = found;

  if (!info.branch) {
    return { merged: false, detail: `The worktree at ${info.path} is on a detached HEAD, not a branch, so there is nothing named to merge. Check out a branch in it first.` };
  }
  // "git could not answer" is refused rather than read as clean: merging half a
  // worktree is the failure this guard exists to prevent, and an unknown here
  // used to sail straight through it.
  if (dirty.count === null) {
    return { merged: false, detail: `git could not report the state of ${info.path}: ${dirty.said}. Refusing to merge until it can — an uncommitted file this check missed would be left behind. Run "git status" there and try again.` };
  }
  if (dirty.count > 0) {
    return { merged: false, detail: `${plural(dirty.count, 'uncommitted file')} in ${info.path}. Commit or stash them in the worktree first — merging now would take the committed half and leave the rest behind.` };
  }

  const base = await recordedBase(info.repoRoot, info.branch);
  if (!base) {
    return { merged: false, detail: `Foreman has no record of which branch ${info.branch} was created from, so it will not guess a merge target. Merge it by hand: git switch <target> && git merge ${info.branch}.` };
  }
  if (!(await branchExists(info.repoRoot, base))) {
    return { merged: false, detail: `${info.branch} was created from ${base}, which is no longer a branch in ${info.repoRoot} (it was a detached HEAD, or the branch has since been deleted). Pick a target and merge it by hand.` };
  }
  if (info.ahead === 0) {
    return { merged: false, detail: `${info.branch} has no commits that ${base} does not already have — nothing to merge. Commit the agent's work in the worktree first.` };
  }

  // The merge has to happen wherever base is checked out; git will not let two
  // worktrees hold the same branch, and merging into a branch with no working
  // tree needs plumbing that has no safe failure mode.
  const target = (await porcelainWorktrees(info.repoRoot)).find((w) => w.branch === base);
  if (!target) {
    return { merged: false, detail: `${base} is not checked out in any worktree, so there is nowhere to merge into. Run "git switch ${base}" in ${info.repoRoot} and try again.` };
  }
  const targetDirty = await dirtyCount(target.path);
  // The main working tree is the one that gets merged into, so this is the
  // check that matters most: if the merge conflicts, the recovery below runs
  // `merge --abort` / `reset --merge`, which destroys uncommitted edits. A
  // failed `git status` must not be allowed to look like an empty tree.
  if (targetDirty.count === null) {
    return { merged: false, detail: `git could not report the state of ${target.path}, where ${base} is checked out: ${targetDirty.said}. Refusing to merge until it can — if this merge conflicted, backing it out would discard any uncommitted work sitting there.` };
  }
  if (targetDirty.count > 0) {
    return { merged: false, detail: `${plural(targetDirty.count, 'uncommitted file')} in ${target.path}, where ${base} is checked out. Commit or stash them before merging into it — a merge on top of dirty files is not one you can cleanly undo.` };
  }

  const changed = await git(info.repoRoot, ['diff', '--name-only', '-z', `${base}...${info.branch}`], 30_000);
  const files = changed.ok ? changed.stdout.split('\0').filter(Boolean).length : 0;
  const squash = opts?.squash === true;
  const message = opts?.message?.trim() || `foreman: ${squash ? 'squash' : 'merge'} ${info.branch} into ${base}`;

  const merge = squash
    ? await git(target.path, ['merge', '--squash', info.branch], 5 * 60_000)
    : await git(target.path, ['merge', '--no-ff', '--no-edit', '-m', message, info.branch], 5 * 60_000);

  if (!merge.ok) {
    const conflicts = await conflictedFiles(target.path);
    // --abort needs MERGE_HEAD, which a conflicted --squash never wrote.
    let restored = await git(target.path, ['merge', '--abort'], 60_000);
    if (!restored.ok) restored = await git(target.path, ['reset', '--merge'], 60_000);
    const left = restored.ok
      ? `Nothing was merged and ${target.path} is back as it was.`
      : `${target.path} is still mid-merge — run "git merge --abort" there before doing anything else.`;
    if (conflicts.length) {
      return { merged: false, detail: `${info.branch} conflicts with ${base} in ${plural(conflicts.length, 'file')}: ${nameList(conflicts)}. ${left} Resolve them in the worktree, commit, and merge again.` };
    }
    return { merged: false, detail: `git refused the merge: ${gitSaid(merge)}. ${left}` };
  }

  if (squash) {
    const commit = await git(target.path, ['commit', '-m', message], 60_000);
    if (!commit.ok) {
      // The squash is staged and intact. Resetting it here to make the return
      // value tidy would throw away the merge the user just asked for.
      return { merged: false, detail: `The squashed changes are staged in ${target.path} but the commit failed: ${gitSaid(commit)}. Nothing is lost — fix that and commit there, or run "git reset --merge" to back it out.` };
    }
  }

  const how = squash ? `Squashed ${plural(info.ahead, 'commit')}` : `Merged ${plural(info.ahead, 'commit')}`;
  return {
    merged: true,
    detail: `${how} from ${info.branch} into ${base} in ${target.path}, touching ${plural(files, 'file')}. The worktree is untouched — remove it when you are done with it.`,
  };
}

/* ── remove ──────────────────────────────────────────────────────────── */

/**
 * Removing is the one operation that destroys work, so the refusal is the
 * feature: uncommitted files in a worktree exist nowhere else, and a misclick
 * that deletes an hour of an agent's editing is not recoverable from anything.
 * The branch is always kept — its commits are the record of what happened.
 */
export async function removeWorktree(p: string, force: boolean): Promise<{ removed: boolean; detail: string }> {
  const abs = canon(p);
  const row = rowFor(abs);

  if (!fs.existsSync(abs)) {
    markRemoved(abs);
    const root = row?.repo_root ?? null;
    if (root && fs.existsSync(root)) await git(root, ['worktree', 'prune'], 30_000);
    return { removed: true, detail: `Nothing on disk at ${abs}. Foreman's record was cleared and git's worktree list pruned.` };
  }

  const found = await inspect(abs);
  if (!found) {
    throw new Error(`${abs} is not a git worktree. Refusing to delete it — Foreman only removes directories git says it created.`);
  }
  const { info, dirty } = found;
  // Same reason as the merge guard, with the stakes reversed: here the refusal
  // is all that stands between a failed `git status` and deleting files that
  // exist nowhere else. force is still honoured — that is the user saying it.
  if (dirty.count === null && !force) {
    return {
      removed: false,
      detail: `git could not report the state of ${abs}: ${dirty.said}. Refusing to delete a worktree it cannot vouch for — any uncommitted file in there exists nowhere else. Run "git status" there, or remove again with force if you mean to lose whatever is in it.`,
    };
  }
  if ((dirty.count ?? 0) > 0 && !force) {
    return {
      removed: false,
      detail: `${plural(dirty.count ?? 0, 'uncommitted file')} in ${abs} would be deleted with the worktree, and they exist nowhere else. Commit them there first, or remove again with force if you mean to lose them.`,
    };
  }

  const res = await git(info.repoRoot, ['worktree', 'remove', ...(force ? ['--force'] : []), abs], 5 * 60_000);
  if (!res.ok) {
    const said = gitSaid(res);
    if (/lock/i.test(said)) {
      return { removed: false, detail: `git says this worktree is locked: ${said}. Unlock it with "git worktree unlock ${abs}" and try again. Nothing was deleted.` };
    }
    return { removed: false, detail: `git refused to remove the worktree: ${said}. Nothing was deleted.` };
  }

  await git(info.repoRoot, ['worktree', 'prune'], 30_000);
  markRemoved(abs);

  const kept = info.branch
    ? ` Branch ${info.branch} is kept${info.ahead ? ` with ${plural(info.ahead, 'unmerged commit')}` : ''} — delete it yourself when you are sure.`
    : '';
  return { removed: true, detail: `Removed the worktree at ${abs}.${kept}` };
}

/* ── reconcile ───────────────────────────────────────────────────────── */

/**
 * Worktrees outlive the app. A crash, a force quit or a `kill -9` leaves the
 * directory, the branch and git's admin files behind with nothing pointing at
 * them, and a stale worktree is a whole checkout of the repo costing disk
 * forever — a few of them will quietly outweigh the repo itself.
 *
 * So this reports and never deletes. An orphan can hold the only copy of an
 * hour of an agent's work, and the cost of showing one the user does not care
 * about is a row in a list; the cost of hiding one is either lost work or a
 * disk that fills up for reasons nobody can see. Showing beats hiding.
 */
export async function reconcileWorktrees(): Promise<WorktreeInfo[]> {
  const live = new Set(listSessions().filter((s) => s.status !== 'exited').map((s) => s.id));

  const rows = db().prepare('SELECT * FROM worktrees WHERE removed_at IS NULL').all() as Row[];

  const roots = new Set<string>();
  for (const project of listProjects()) {
    const root = await repoRootFor(project.path);
    if (root) roots.add(root);
  }
  // A row can name a repo that has since left the project list. A worktree of a
  // forgotten project is exactly the orphan this function exists to find.
  for (const r of rows) {
    if (fs.existsSync(r.repo_root)) roots.add(canon(r.repo_root));
  }

  const orphans: WorktreeInfo[] = [];
  const seen = new Set<string>();
  const adopt = db().prepare(`
    INSERT INTO worktrees (path, repo_root, branch, session_id, created_at, removed_at)
    VALUES (?,?,?,NULL,?,NULL)
    ON CONFLICT(path) DO UPDATE SET repo_root = excluded.repo_root, branch = excluded.branch, removed_at = NULL
  `);

  for (const root of roots) {
    for (const rec of await porcelainWorktrees(root)) {
      const abs = canon(rec.path);
      if (abs === root || seen.has(abs)) continue;
      seen.add(abs);
      // Gone from disk: git will drop it on the next prune and there is no
      // storage to reclaim, so it is not worth a row in front of the user.
      if (!fs.existsSync(abs)) continue;

      const row = rowFor(abs);
      // Never report a worktree a human made for themselves. Offering to delete
      // someone's hand-rolled checkout is how a tool loses trust permanently.
      const ours = Boolean(row) || (rec.branch?.startsWith('foreman/') ?? false);
      if (!ours) continue;
      if (row?.session_id && live.has(row.session_id)) continue;

      // Adopt what the database lost — a crash between `worktree add` and the
      // INSERT, or a moved database. Without a row there is no handle for the
      // UI to merge or remove it with, and it becomes invisible garbage.
      if (!row) {
        let createdAt = Date.now();
        try {
          const birth = fs.statSync(abs).birthtimeMs;
          if (Number.isFinite(birth) && birth > 0) createdAt = Math.round(birth);
        } catch { /* raced with a delete; the timestamp is cosmetic */ }
        adopt.run(abs, root, rec.branch, createdAt);
      }

      const info = await worktreeStatus(abs);
      if (info) orphans.push(info);
    }
  }

  // The directory is gone but the row survives, so the row is closed out rather
  // than deleted: the history of what Foreman created is worth keeping.
  for (const r of rows) {
    if (!fs.existsSync(r.path)) markRemoved(r.path);
  }

  return orphans.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Where a session's work actually lives. Synchronous because it sits on the hot
 * path of every launch and every code-panel read.
 *
 * A row can outlive its directory when a user deletes it by hand. Returning a
 * path that no longer exists makes the next spawn fail with an ENOENT far away
 * from here, with nothing pointing back at the worktree as the cause.
 */
export function worktreeForSession(sessionId: string): string | null {
  const row = db().prepare(
    'SELECT path FROM worktrees WHERE session_id = ? AND removed_at IS NULL ORDER BY created_at DESC LIMIT 1'
  ).get(sessionId) as { path: string } | undefined;
  if (!row) return null;
  return fs.existsSync(row.path) ? row.path : null;
}
