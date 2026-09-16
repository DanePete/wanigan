import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { db, dataDir } from './db';
import { OBJECT_NAME, runGit, head as headOf, repoState } from './git';
import { listProjects, projectById } from './store';
import {
  depsModeFor, latestWorktreeRun, projectForDirectory, runWorktreePhase, worktreeCommands,
} from './worktree-setup';
import type { WorktreeInfo } from '../shared/types';
import {
  DEFAULT_DEPS_MODE, INCLUDE_LIMITS, PORT_ATTEMPTS, PORT_BLOCK_SIZE, bytesText, includePatternCount,
  isPortBlockBase, isSafeRelative, portBlockBase, runFacts, seedFromHex, summarizeRun,
  type DepOutcome, type DepsMode, type IncludeLimits, type IncludeOutcome, type PortBlock, type WorktreeBootstrap,
  type WorktreeCommandEnv, type WorktreeCommandRun, type WorktreeRunSummary, type WorktreeSetupConfig,
} from '../shared/worktree-bootstrap';

/**
 * Three agents on one working tree overwrite each other's edits, and the loser
 * never finds out. A worktree gives each session its own checkout and its own
 * branch off the same repo, so "who wrote this file" has one answer.
 */

/* ── git ─────────────────────────────────────────────────────────────── */

type Git = { ok: boolean; stdout: string; stderr: string };

/**
 * Always argv, never a shell string: a branch label is user text, and
 * `wanigan/fix; rm -rf ~` is not a bug you want to find in production. It also
 * means a label with a space stays one argument.
 *
 * Exit status is returned rather than thrown because half of what this module
 * does is ask git a question where "that failed" is the answer (is this a repo,
 * does this branch exist, is there anything to merge).
 *
 * The process itself comes from git.ts so that the credential-prompt hardening
 * lives in exactly one place. This module runs `worktree add` against repos
 * with remotes; a git that stops to ask for a password it cannot ask for takes
 * the whole main process — and every PTY it pumps — down with it. The buffer
 * and timeout stay local because a checkout is not a rev-parse.
 */
async function git(cwd: string, args: string[], timeout = 20_000): Promise<Git> {
  const r = await runGit(cwd, args, { timeout, maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.ok, stdout: r.out, stderr: r.err };
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

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A `-z` list: NUL-terminated entries, empty ones dropped. */
const nul = (out: string) => out.split('\0').filter((entry) => entry.length > 0);

/* ── rows ────────────────────────────────────────────────────────────── */

type Row = {
  path: string;
  repo_root: string;
  branch: string | null;
  session_id: string | null;
  created_at: number;
  removed_at: number | null;
  project_id: string | null;
  port_base: number | null;
  bootstrap_json: string | null;
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
  const r = await git(repoRoot, ['config', '--get', `branch.${branch}.waniganbase`], 8000);
  const v = r.ok ? r.stdout.trim() : '';
  return v || null;
}

/**
 * For the ahead count only. A worktree Wanigan did not create has no recorded
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

/**
 * The same shape as Dirty, for the same reason and one step further along.
 *
 * A failed `rev-list --count` collapsed to 0, and 0 is precisely what merge
 * reads as "there is nothing here to merge". So a count that timed out on a big
 * history told the operator to go and commit work they had already committed,
 * and the merge they asked for never ran — a refusal that names the wrong cause
 * is worse than an error, because it sends someone off to fix the wrong thing.
 */
type Ahead = { count: number; said: null } | { count: null; said: string };

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

   So the ignored heavyweights are put back, in the way the project chose (see
   DepsMode in shared/worktree-bootstrap.ts). Linking them to the source repo
   is the default and what people already do by hand with worktrees: they are
   generated or machine-local, not the work under review, and a full copy of
   258 MB per session is its own bug. A link is also shared, so a project whose
   agents install packages can clone instead — copy-on-write, so the copy costs
   no disk until something writes — or skip them and install in setup.

   The small files are copied rather than linked, whatever the choice. A
   symlink is not a copy: an agent that writes .env inside its isolated
   worktree writes straight through to the user's real checkout, which is the
   one thing the isolation is there to stop. They are kilobytes, they are read
   far more often than written, and a copy that has gone stale is a local
   problem the operator can see — a write-through into the main checkout is
   neither.
   ──────────────────────────────────────────────────────────────────────── */

const LINK_DIRS = [
  'vendor', 'node_modules', 'bower_components', '.venv', 'venv', '.yarn',
  'Pods', '.bundle', 'target', '.gradle', '.next/cache', 'vendor/bin',
];
const COPY_FILES = [
  '.env', '.env.local', '.env.development', '.env.development.local',
  'auth.json', '.npmrc', '.tool-versions',
];

export type LinkedPath = { path: string; kind: 'dir' | 'file'; bytes: number | null };

/** Only link what git is actually ignoring — a tracked path is already there. */
async function isIgnored(repoRoot: string, rel: string): Promise<boolean> {
  const r = await git(repoRoot, ['check-ignore', '-q', rel], 5000);
  return r.ok;
}

/** The first line of the block Wanigan keeps in a repository's local exclude file. */
const EXCLUDE_HEADER = '# Wanigan links these dependency folders into agent worktrees. A symlink does not match a pattern ending in /.';

/**
 * Make git ignore a dependency link in every worktree of this repository.
 *
 * The link is to a folder the main checkout ignores, usually through a rule
 * like `node_modules/`. A pattern ending in a slash matches directories only,
 * and git does not treat a symlink as one, so every linked worktree listed the
 * link as untracked. Wanigan's own merge and removal then counted it as
 * uncommitted work, and an agent running `git add -A` committed a symlink to
 * the operator's checkout into its branch.
 *
 * The fix is one anchored line per linked path in the repository's local
 * exclude file, `info/exclude` under the common git directory. That file is
 * never committed, and every worktree reads it. It changes nothing in the main
 * checkout, where each path is only linked because git already ignores it
 * there. Lines are only added, only once, and under a comment naming Wanigan,
 * so the operator can see where they came from and remove them.
 *
 * Returns why the line could not be written, or null when git now ignores the link.
 */
async function excludeLink(repoRoot: string, rel: string): Promise<string | null> {
  const common = await git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 5000);
  const dir = common.ok ? common.stdout.trim() : '';
  if (!dir) return `the repository’s git directory could not be read (${gitSaid(common)})`;
  const file = path.join(dir, 'info', 'exclude');
  const line = `/${rel}`;
  try {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const lines = text.split(/\r?\n/);
    if (lines.includes(line)) return null;
    const lead = text && !text.endsWith('\n') ? '\n' : '';
    const header = lines.includes(EXCLUDE_HEADER) ? '' : `${text ? '\n' : ''}${EXCLUDE_HEADER}\n`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${lead}${header}${line}\n`);
    return null;
  } catch (e) {
    return `the line could not be added to ${file} (${message(e)})`;
  }
}

/**
 * Whether writing `dst` stays inside `root` (already canonical), judged from
 * the nearest ancestor that exists: every directory below it will be made
 * fresh, and a directory made fresh cannot be a link. A worktree checks out the
 * repository's tracked symlinks, so a tracked `config -> /elsewhere` would
 * otherwise carry a copy, a clone or a new link straight through to wherever it
 * points — and so would node_modules itself once it is linked to the main
 * checkout.
 */
function landsInside(dst: string, root: string): boolean {
  let dir = path.dirname(dst);
  for (;;) {
    try {
      const real = fs.realpathSync(dir);
      return real === root || real.startsWith(root + path.sep);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return false;
      const up = path.dirname(dir);
      if (up === dir) return false;
      dir = up;
    }
  }
}

/**
 * Whether a copy from one directory into another can be an APFS clone.
 *
 * Asked before `cp -c` runs, because cp will not say. Its manual: where the
 * two are on different filesystems or the target cannot clone, "cp will
 * fallback to using copyfile(2) instead to ensure the copy still succeeds" — a
 * scratch test here watched it exit 0 after a full copy onto a second volume.
 * A "clone" of a 2 GB node_modules that silently took 2 GB is the thing this
 * choice exists to avoid. So two facts the filesystem will state: both paths on
 * one device, and that device formatted like the boot volume, which has been
 * APFS since macOS 10.15 (statfs type 26 on the machine this was written on;
 * a mounted HFS+ image reported 25, and an APFS image a different device).
 * Node's COPYFILE_FICLONE_FORCE would be the direct question, but libuv
 * answers it with ENOSYS on macOS whatever the volume.
 */
function cloneable(from: string, to: string): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    return fs.statSync(from).dev === fs.statSync(to).dev && fs.statfsSync(from).type === fs.statfsSync('/').type;
  } catch {
    return false;
  }
}

/** Measured at about 15 seconds for 80,000 small files on APFS; five minutes is a tree a clone was never going to suit. */
const CLONE_TIMEOUT_MS = 5 * 60_000;

/** `cp -c -R`, as argv: a directory name may contain anything a shell would act on. */
function cloneTree(src: string, dst: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killer: NodeJS.Timeout | null = null;
    const child = spawn('/bin/cp', ['-c', '-R', src, dst], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr?.on('data', (b: Buffer) => { if (stderr.length < 8_192) stderr += b.toString(); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, CLONE_TIMEOUT_MS);
    const finish = (value: { ok: true } | { ok: false; reason: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killer) clearTimeout(killer);
      resolve(value);
    };
    child.once('error', (e) => finish({ ok: false, reason: `cp could not be started (${e.message})` }));
    child.once('close', (code, signal) => {
      if (timedOut) finish({ ok: false, reason: `cp -c was still cloning after ${CLONE_TIMEOUT_MS / 60_000} minutes and was stopped` });
      else if (code === 0) finish({ ok: true });
      else {
        const last = stderr.split('\n').map((l) => l.trim()).filter(Boolean).pop();
        finish({ ok: false, reason: `cp -c ${code === null ? `was stopped by ${signal ?? 'a signal'}` : `exited ${code}`}${last ? ` (${last})` : ''}` });
      }
    });
  });
}

/**
 * Puts the gitignored dependency folders and small config files a new
 * worktree lacks into it, the folders in the project's chosen way.
 *
 * A clone that fails falls back to a link rather than to nothing: a worktree
 * whose agent cannot autoload is the failure this section opened with, and a
 * link is the behaviour the project had before it chose to clone. The reason
 * is kept on the outcome, because a link where a clone was asked for is
 * exactly the sharing the operator chose to avoid, and they need to know it
 * happened. A half-made clone is removed first; if it cannot be, nothing is
 * linked over it and the folder is reported missing.
 */
async function placeDependencies(repoRoot: string, worktree: string, mode: DepsMode): Promise<{ linked: LinkedPath[]; deps: DepOutcome[] }> {
  const linked: LinkedPath[] = [];
  const deps: DepOutcome[] = [];
  const inside = canon(worktree);

  for (const rel of LINK_DIRS) {
    const src = path.join(repoRoot, rel);
    const dst = path.join(inside, rel);
    try { if (!fs.statSync(src).isDirectory()) continue; } catch { continue; }
    if (fs.existsSync(dst)) continue;
    if (!(await isIgnored(repoRoot, rel))) continue;
    const record = (result: DepOutcome['result'], detail: string | null = null, durationMs: number | null = null) =>
      deps.push({ path: rel, requested: mode, result, detail, durationMs });

    if (mode === 'skip') { record('skipped'); continue; }
    if (!landsInside(dst, inside)) {
      record('failed', 'its place in the worktree is reached through a link that leads outside the worktree');
      continue;
    }
    try { fs.mkdirSync(path.dirname(dst), { recursive: true }); } catch (e) {
      record('failed', `its parent folder could not be made (${message(e)})`);
      continue;
    }

    let fallback: string | null = null;
    if (mode === 'clone') {
      if (process.platform !== 'darwin') {
        fallback = 'copy-on-write clones use macOS cp -c, and this is not macOS';
      } else if (!cloneable(src, inside)) {
        fallback = 'it is not on the same APFS volume as the worktree, so cp -c would have made a full copy rather than a clone';
      } else {
        const started = Date.now();
        const cloned = await cloneTree(src, dst);
        if (cloned.ok) { record('cloned', null, Date.now() - started); continue; }
        fallback = cloned.reason;
        try { fs.rmSync(dst, { recursive: true, force: true }); } catch (e) {
          record('failed', `${fallback}, and the partial clone could not be removed (${message(e)})`);
          continue;
        }
      }
    }
    try {
      fs.symlinkSync(src, dst, 'dir');
      linked.push({ path: rel, kind: 'dir', bytes: null });
      const unexcluded = await excludeLink(repoRoot, rel);
      record('linked', [fallback, unexcluded && `git will list the link as untracked because ${unexcluded}`].filter(Boolean).join('; ') || null);
    } catch (e) {
      record('failed', `${fallback ? `${fallback}, and ` : ''}the link could not be made (${message(e)})`);
    }
  }

  for (const rel of COPY_FILES) {
    const src = path.join(repoRoot, rel);
    const dst = path.join(inside, rel);
    try { if (!fs.statSync(src).isFile()) continue; } catch { continue; }
    if (fs.existsSync(dst)) continue;
    if (!(await isIgnored(repoRoot, rel))) continue;
    if (!landsInside(dst, inside)) continue;
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      // EXCL rather than the existsSync above alone: the copy must never
      // overwrite something already sitting in the worktree. copyFileSync
      // creates the destination from the source's mode, so a 0600 auth.json
      // never widens on the way in.
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
      let bytes: number | null = null;
      try { bytes = fs.statSync(src).size; } catch { /* size is a nicety */ }
      linked.push({ path: rel, kind: 'file', bytes });
    } catch { /* a copy we cannot make is not worth failing the worktree over */ }
  }
  return { linked, deps };
}

/* ── .worktreeinclude ────────────────────────────────────────────────── */

const INCLUDE_FILE = '.worktreeinclude';
/** A pattern file is a few lines. One larger than this is not a pattern file anybody meant. */
const INCLUDE_FILE_MAX_BYTES = 64 * 1024;
/** Paths per check-ignore call, so one failing call leaves the rest countable as unexamined. */
const CHECK_CHUNK = 500;
/**
 * git with the repository's filesystem monitor off. collisions.ts gives the
 * reason: core.fsmonitor is a command git runs, an agent can write repository
 * config, and a question asked on the operator's behalf must not execute it.
 */
const QUIET = ['-c', 'core.fsmonitor=false'];

type IncludeFile = { state: 'absent' } | { state: 'unreadable'; detail: string } | { state: 'present'; file: string; patterns: number };

/** The repository root's `.worktreeinclude`. A symlinked one is followed: it only chooses among files already inside the repository. */
function readIncludeFile(repoRoot: string): IncludeFile {
  const file = path.join(repoRoot, INCLUDE_FILE);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? { state: 'absent' } : { state: 'unreadable', detail: `it could not be read (${message(e)})` };
  }
  if (!st.isFile()) return { state: 'unreadable', detail: 'it is not a regular file' };
  if (st.size > INCLUDE_FILE_MAX_BYTES) {
    return { state: 'unreadable', detail: `it is ${bytesText(st.size)}, past the ${bytesText(INCLUDE_FILE_MAX_BYTES)} a pattern file may be` };
  }
  try {
    return { state: 'present', file, patterns: includePatternCount(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    return { state: 'unreadable', detail: `it could not be read (${message(e)})` };
  }
}

function gitLast(r: { err: string; killed: boolean }): string {
  if (r.killed) return 'git timed out';
  return r.err.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? 'no output';
}

/**
 * Copies into a new worktree every file that matches a pattern in the
 * repository root's `.worktreeinclude` AND is ignored by git.
 *
 * That is Claude Code's rule (code.claude.com/docs/en/worktrees), kept because
 * the file is its convention and one repository's include file should mean one
 * thing in both tools. Both conditions are what make it safe: a tracked file is
 * already in the checkout, and an untracked file git does not ignore is
 * somebody's work in progress.
 *
 * git answers both halves, so the matching is git's own gitignore
 * implementation — negation, anchoring, `**`, core.ignorecase — rather than a
 * second one written here. `ls-files --others --ignored --exclude-from` lists
 * the untracked files the patterns match, and a tracked file cannot appear in
 * it; `check-ignore` keeps those the repository's own ignore rules cover, and
 * never reports a tracked path either. One difference from Claude Code
 * 2.1.271, read out of its shipped source: it looks inside an ignored directory
 * only when a pattern names that directory, so its `*.pem` finds a key at the
 * top level and not one under node_modules/. git, asked directly, finds both;
 * the listing took 0.4 seconds over 80,000 ignored files.
 *
 * Each copy is a clone where the volume allows (COPYFILE_FICLONE falls back to
 * a real copy), is never made over anything already in the worktree
 * (COPYFILE_EXCL), never follows a symlink, and never lands through a link
 * that leaves the worktree. The limits stop the copy rather than trim it
 * quietly, and the outcome says where it stopped and how much it did not look
 * at. `limits` is a parameter for the smoke suite.
 */
export async function copyWorktreeIncludes(repoRoot: string, worktree: string, limits: IncludeLimits = INCLUDE_LIMITS): Promise<IncludeOutcome> {
  const include = readIncludeFile(repoRoot);
  if (include.state !== 'present') return include;
  const inside = canon(worktree);
  const out: Extract<IncludeOutcome, { state: 'read' }> = {
    state: 'read', patterns: include.patterns, copied: 0, bytes: 0, present: 0, notIgnored: 0, symlinks: 0,
    outside: 0, failed: 0, failure: null, stopped: null, cloneable: cloneable(repoRoot, inside),
  };
  if (!include.patterns) return out;

  const listed = await runGit(repoRoot, [...QUIET, 'ls-files', '-z', '--others', '--ignored', `--exclude-from=${include.file}`],
    { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  if (!listed.ok) return { state: 'unreadable', detail: `git could not list what it matches (${gitLast(listed)})` };

  const fail = (why: string) => { out.failed++; out.failure ??= why; };
  const entries = [...new Set(nul(listed.out))].sort();
  // A directory entry is a nested repository git would not look inside. The
  // patterns chose it, so it is counted rather than dropped without a word.
  for (const dir of entries.filter((e) => e.endsWith('/'))) fail(`${dir} is a separate git repository, and only files are copied`);
  const candidates = entries.filter((e) => !e.endsWith('/'));

  let examined = 0;
  chunks: for (let i = 0; i < candidates.length; i += CHECK_CHUNK) {
    const chunk = candidates.slice(i, i + CHECK_CHUNK);
    // Paths on stdin, NUL-terminated both ways: `-z` is fatal without
    // `--stdin`, and the argv form C-quotes a name holding a quote, backslash
    // or newline, which would then never match the set below and be counted as
    // not ignored. No --literal-pathspecs: check-ignore refuses that magic
    // outright (checked against git 2.50), which failed every call. What that
    // costs is conservative — a name with glob characters that also matches a
    // tracked path is answered as tracked, so it is left out, never copied.
    const asked = await runGit(repoRoot, [...QUIET, 'check-ignore', '--stdin', '-z'],
      { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, input: chunk.map((rel) => `${rel}\0`).join('') });
    // Exit 1 is git answering "none of these is ignored", not failing.
    if (!asked.ok && asked.code !== 1) {
      out.failure ??= `git check-ignore failed (${gitLast(asked)})`;
      out.stopped = { by: 'git', limit: null, unexamined: candidates.length - examined };
      break;
    }
    const ignored = new Set(asked.ok ? nul(asked.out) : []);
    for (const rel of chunk) {
      if (!ignored.has(rel)) { out.notIgnored++; examined++; continue; }
      if (out.copied >= limits.files) {
        out.stopped = { by: 'files', limit: limits.files, unexamined: candidates.length - examined };
        break chunks;
      }
      if (!isSafeRelative(rel)) { fail(`git listed ${rel}, which is not a path inside the repository`); examined++; continue; }
      const src = path.join(repoRoot, rel);
      const dst = path.join(inside, rel);
      let st: fs.Stats;
      try { st = fs.lstatSync(src); } catch (e) { fail(message(e)); examined++; continue; }
      if (st.isSymbolicLink()) { out.symlinks++; examined++; continue; }
      if (!st.isFile()) { fail(`${rel} is not a regular file`); examined++; continue; }
      if (out.bytes + st.size > limits.bytes) {
        out.stopped = { by: 'bytes', limit: limits.bytes, unexamined: candidates.length - examined };
        break chunks;
      }
      if (!landsInside(dst, inside)) { out.outside++; examined++; continue; }
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
        out.copied++;
        out.bytes += st.size;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') out.present++;
        else fail(message(e));
      }
      examined++;
    }
  }
  return out;
}

/* ── ports ───────────────────────────────────────────────────────────── */

/** Long enough for loopback to answer under load; a refused connection on loopback arrives in well under a millisecond. */
const PROBE_TIMEOUT_MS = 400;

/**
 * Whether anything accepts a connection at host:port. A probe that hears
 * nothing in time counts as taken: silence is not proof the port is free.
 * Refused is the free answer, and so is an address family this machine has no
 * loopback for, which cannot be holding a port.
 */
function answers(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect({ port, host });
    const done = (taken: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(taken);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(true));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function blockAnswers(base: number): Promise<boolean> {
  const probes: Promise<boolean>[] = [];
  for (let port = base; port < base + PORT_BLOCK_SIZE; port++) {
    probes.push(answers(port, '127.0.0.1'), answers(port, '::1'));
  }
  return (await Promise.all(probes)).some(Boolean);
}

async function assignPortBlock(abs: string): Promise<PortBlock> {
  const row = db().prepare('SELECT port_base FROM worktrees WHERE path = ? AND removed_at IS NULL').get(abs) as
    { port_base: number | null } | undefined;
  if (row && isPortBlockBase(row.port_base)) {
    return { base: row.port_base, count: PORT_BLOCK_SIZE, state: 'recorded', skipped: 0 };
  }
  const held = new Set((db().prepare('SELECT port_base FROM worktrees WHERE removed_at IS NULL AND port_base IS NOT NULL AND path != ?')
    .all(abs) as { port_base: number }[]).map((r) => r.port_base));
  const seed = seedFromHex(createHash('sha256').update(abs).digest('hex'));
  let block: PortBlock | null = null;
  for (let attempt = 0; attempt < PORT_ATTEMPTS && !block; attempt++) {
    const base = portBlockBase(seed, attempt);
    if (held.has(base) || await blockAnswers(base)) continue;
    block = { base, count: PORT_BLOCK_SIZE, state: 'free', skipped: attempt };
  }
  block ??= { base: portBlockBase(seed), count: PORT_BLOCK_SIZE, state: 'busy', skipped: PORT_ATTEMPTS };
  if (row) db().prepare('UPDATE worktrees SET port_base = ? WHERE path = ? AND removed_at IS NULL').run(block.base, abs);
  return block;
}

/** One assignment at a time, so two worktrees made together cannot both take the block neither has recorded yet. */
let portChain: Promise<unknown> = Promise.resolve();

/**
 * Ten loopback ports a worktree can call its own.
 *
 * The ports are a convention the agent may use, not something Wanigan
 * enforces. Nothing is bound, held or firewalled: an agent that ignores the
 * variables can still take 3000, and any process on the machine can still take
 * one of these. What the block buys is that two agents who both honour it do
 * not start their dev servers on the same port — the collision Conductor's
 * ten-port block and worktrunk's hash_port exist for.
 *
 * The base is 42000–48999 in steps of ten, from a SHA-256 of the canonical
 * path, so a resumed session in the same worktree gets the ports it had. A
 * block is skipped while any of its ports answers on loopback — 127.0.0.1, and
 * ::1 as well, because Node resolves `localhost` to ::1 first and a dev server
 * started on it is invisible to an IPv4 probe — or while another live worktree
 * Wanigan made holds it, which covers two agents whose servers have not started
 * yet. After PORT_ATTEMPTS blocks it stops and hands out the path's own block,
 * marked busy.
 *
 * A worktree Wanigan made keeps its block on its row, and gets it back from
 * there unprobed: setup, the launch and teardown must all see the same ports,
 * and by teardown the worktree's own server may be the thing listening. A path
 * with no row is computed every time and recorded nowhere.
 */
export function worktreePortBlock(worktreePath: string): Promise<PortBlock> {
  const next = portChain.then(() => assignPortBlock(canon(worktreePath)));
  portChain = next.catch(() => undefined);
  return next;
}

/**
 * The environment an agent launched in a worktree is given: its port block and
 * its own path. The same convention as worktreePortBlock — the variables say
 * which ports are this worktree's to use, and Wanigan enforces none of it.
 * sessions.ts gives it to an attended agent and headless.ts to a headless run,
 * each after its worktree is chosen, so the agent sees the block setup saw.
 */
export async function worktreeLaunchEnv(worktreePath: string): Promise<{ WANIGAN_PORT: string; WANIGAN_PORT_COUNT: string; WANIGAN_WORKTREE: string }> {
  const abs = canon(worktreePath);
  const block = await worktreePortBlock(abs);
  return { WANIGAN_PORT: String(block.base), WANIGAN_PORT_COUNT: String(block.count), WANIGAN_WORKTREE: abs };
}

/** What setup and teardown are given: the launch variables plus the repository they came from. */
function commandEnv(worktree: string, repoRoot: string, block: PortBlock): WorktreeCommandEnv {
  return {
    WANIGAN_WORKTREE: worktree, WANIGAN_REPO_ROOT: repoRoot,
    WANIGAN_PORT: String(block.base), WANIGAN_PORT_COUNT: String(block.count),
  };
}

/* ── the project's settings, for the Git view ────────────────────────── */

export async function worktreeSetupConfig(projectId: unknown): Promise<WorktreeSetupConfig> {
  const project = typeof projectId === 'string' ? projectById(projectId) : undefined;
  if (!project) throw new Error('Project not found.');
  const commands = worktreeCommands(project.id);
  const root = await repoRootFor(project.path);
  const file: IncludeFile = root ? readIncludeFile(root) : { state: 'absent' };
  return {
    projectId: project.id, depsMode: depsModeFor(project.id),
    setup: commands.setup, teardown: commands.teardown, updatedAt: commands.updatedAt,
    include: file.state === 'present' ? { state: 'present', patterns: file.patterns } : file,
  };
}

/**
 * What creation recorded for a worktree, with its newest setup run read fresh.
 * Null for a worktree made before any of this was recorded, or by someone
 * else: there is nothing to say about it, which is not the same as a setup that
 * ran and said nothing.
 */
function bootstrapFor(abs: string): WorktreeBootstrap | null {
  const row = db().prepare('SELECT bootstrap_json FROM worktrees WHERE path = ? AND removed_at IS NULL').get(abs) as
    { bootstrap_json: string | null } | undefined;
  if (!row?.bootstrap_json) return null;
  let stored: Omit<WorktreeBootstrap, 'setup'>;
  try { stored = JSON.parse(row.bootstrap_json) as Omit<WorktreeBootstrap, 'setup'>; } catch { return null; }
  const setup = latestWorktreeRun(abs, 'setup');
  return { ...stored, setup: setup ? summarizeRun(setup) : null };
}

/**
 * `startPoint` cuts the worktree from one commit instead of from wherever the
 * repository's branch points when this runs. Attempts need that: a set records
 * its commit when it starts, its runs are cut minutes or hours later as slots
 * free up, and a branch that moved in between would hand later attempts a
 * different task than earlier ones while every row still read the same.
 *
 * The start point is validated as an object name before it reaches git — it is
 * an argument to `worktree add`, and a leading dash there is an option — and
 * must resolve to a commit in this repository. The worktree's HEAD is then read
 * back rather than assumed: a post-checkout hook can commit or check out during
 * `worktree add`, and a pinned attempt that silently started somewhere else is
 * the exact failure the pin exists to prevent. A mismatch is refused, and the
 * fresh worktree is removed without force.
 */
export async function createWorktree(
  repoRoot: string, label: string, sessionId: string, opts: { startPoint?: string } = {},
): Promise<WorktreeInfo> {
  const root = await repoRootFor(repoRoot);
  if (!root) {
    throw new Error(`${repoRoot} is not a git repository, so there is nothing to branch from. Add the project's repo root instead, or run this session without isolation.`);
  }

  // "No commits yet" and "git could not answer" both used to arrive here as a
  // failed rev-parse, and both were reported as the first one — which sends
  // someone off to commit work they have already committed.
  const state = await repoState(root);
  if (state.kind === 'unborn') {
    throw new Error(`${path.basename(root)} has no commits yet — git cannot create a worktree from an empty history. Make one commit, then isolate the session.`);
  }
  if (state.kind !== 'branch' && state.kind !== 'detached') {
    const why = state.kind === 'unreadable' ? state.reason : 'it is not a git repository';
    throw new Error(`Wanigan could not read ${path.basename(root)} to branch from it: ${why}. The repo is untouched.`);
  }
  const head = state.kind === 'detached' ? state.head : (await headOf(root)) ?? '';
  if (!head) {
    throw new Error(`Wanigan could not resolve HEAD in ${path.basename(root)}, so it will not guess what to branch from. The repo is untouched.`);
  }
  const baseBranch = state.kind === 'branch' ? state.branch : null;
  let pinned: string | null = null;
  if (opts.startPoint !== undefined) {
    if (typeof opts.startPoint !== 'string' || !OBJECT_NAME.test(opts.startPoint)) {
      throw new Error(`"${String(opts.startPoint).slice(0, 80)}" is not a commit id, so no worktree was cut from it. The repo is untouched.`);
    }
    const resolved = await git(root, ['rev-parse', '--verify', '--quiet', `${opts.startPoint}^{commit}`], 8000);
    pinned = resolved.ok ? resolved.stdout.trim() || null : null;
    if (!pinned) {
      throw new Error(`${opts.startPoint.slice(0, 12)} does not name a commit in ${path.basename(root)}, so no worktree was cut from it. The repo is untouched.`);
    }
  }
  // Detached HEAD is legal; it just means merge later has no branch to aim at,
  // which mergeWorktree says out loud rather than guessing. A pinned worktree
  // records its commit as the base for the same reason: it was cut from a
  // commit, not from a branch, and naming a branch there would be a guess.
  const startPoint = pinned ?? baseBranch ?? head;

  const parent = path.join(dataDir(), 'worktrees');
  fs.mkdirSync(parent, { recursive: true });

  const short = shortId(sessionId);
  const slug = slugify(label);
  const stem = `${path.basename(root)}-${short}`;
  let dir = path.join(parent, stem);
  let branch = `wanigan/${slug}-${short}`;
  // A re-run of the same session, or two labels colliding on one short id, must
  // not land on an existing branch — git would refuse, and forcing it would
  // reset someone else's work.
  for (let n = 2; fs.existsSync(dir) || (await branchExists(root, branch)); n++) {
    if (n > 50) {
      throw new Error(`Could not find a free worktree name for ${path.basename(root)} — 50 of them already exist under ${parent}. Remove the ones you are done with first.`);
    }
    dir = path.join(parent, `${stem}-${n}`);
    branch = `wanigan/${slug}-${short}-${n}`;
  }

  // A worktree add is a full checkout; on a big repo that is minutes, and the
  // default timeout would abandon it half-written with the branch already made.
  const add = await git(root, ['worktree', 'add', '-b', branch, dir, startPoint], 10 * 60_000);
  if (!add.ok) {
    throw new Error(`Could not create a worktree for "${label}": ${gitSaid(add)}. The repo is untouched; check that ${parent} is writable and on the same filesystem as the repo.`);
  }

  if (pinned) {
    const actual = await headOf(dir);
    if (actual !== pinned) {
      const removal = await removeWorktree(dir, false)
        .catch((error: unknown) => ({ removed: false, detail: error instanceof Error ? error.message : String(error) }));
      throw new Error(
        `The worktree for "${label}" was cut from ${pinned.slice(0, 12)}, but its HEAD reads ${actual ? actual.slice(0, 12) : 'nothing git could resolve'}: ` +
        'something moved it during checkout, and a post-checkout hook is the usual cause. It did not start from the pinned commit, so nothing was run in it. ' +
        (removal.removed ? 'The worktree was removed.' : `The worktree was left at ${dir}: ${removal.detail}`),
      );
    }
  }

  // This config value is the only record of the merge target: recordedBase()
  // reads it and mergeWorktree hard-refuses without it. Discarding the result
  // turned a dropped write into a worktree that can never be merged from the
  // UI, blamed on a "missing record" rather than on the write that failed.
  // Two sessions launched at once contend for .git/config's lockfile and git
  // does not retry, so a lost race is the common case — retry once, briefly.
  const writeBase = () => git(root, ['config', `branch.${branch}.waniganbase`, startPoint], 8000);
  let cfg = await writeBase();
  if (!cfg.ok) {
    await new Promise((r) => setTimeout(r, 150));
    cfg = await writeBase();
  }
  if (!cfg.ok) {
    throw new Error(`The worktree at ${dir} was created, but Wanigan could not record which branch it came from (${gitSaid(cfg)}), so merging it from Wanigan would not work. Record it by hand and reconcile: git -C ${root} config branch.${branch}.waniganbase ${startPoint}`);
  }

  const abs = canon(dir);
  const now = Date.now();
  // The project is found from the directory the caller named, since callers
  // pass a path, and kept on the row so teardown finds the same commands.
  const project = projectForDirectory(repoRoot, root);
  // A path can come back: the same stem after an earlier worktree was
  // removed. Its old port block and bootstrap record belong to a checkout that
  // no longer exists, so they are cleared rather than inherited.
  db().prepare(`
    INSERT INTO worktrees (path, repo_root, branch, session_id, created_at, removed_at, project_id)
    VALUES (?,?,?,?,?,NULL,?)
    ON CONFLICT(path) DO UPDATE SET
      repo_root = excluded.repo_root, branch = excluded.branch,
      session_id = excluded.session_id, created_at = excluded.created_at, removed_at = NULL,
      project_id = excluded.project_id, port_base = NULL, bootstrap_json = NULL
  `).run(abs, root, branch, sessionId, now, project?.id ?? null);

  // Placed before the caller launches an agent into it: a session that starts
  // without vendor/ fails its first hook and cannot autoload, and the error it
  // prints names a file rather than the directory that is really missing.
  const depsMode = project ? depsModeFor(project.id) : DEFAULT_DEPS_MODE;
  const { linked, deps } = await placeDependencies(root, abs, depsMode);
  if (linked.length) {
    db().prepare('UPDATE worktrees SET linked_json = ? WHERE path = ?')
      .run(JSON.stringify(linked.map((l) => l.path)), abs);
  }
  // An include copy that throws part-way is recorded as not used rather than
  // failing the creation: the worktree exists by now, and a thrown error here
  // would reach the operator as "could not create a worktree" beside one that
  // was created.
  let include: IncludeOutcome;
  try { include = await copyWorktreeIncludes(root, abs); } catch (e) {
    include = { state: 'unreadable', detail: `copying stopped on an error (${message(e)}), and what was already copied stays` };
  }
  const ports = await worktreePortBlock(abs);
  const recorded: Omit<WorktreeBootstrap, 'setup'> = { depsMode, deps, include, ports: { base: ports.base, count: ports.count } };
  // Written before setup starts, so a Git view opened during a ten-minute
  // setup already shows what was placed, beside a setup that reads as running.
  db().prepare('UPDATE worktrees SET bootstrap_json = ? WHERE path = ?').run(JSON.stringify(recorded), abs);

  // Setup is last, once everything it might need is in place, and its result
  // never removes the worktree: see worktree-setup.ts. A failing command is a
  // recorded run, not an exception. What can still throw is the recording
  // itself — a database that refuses the row — and that is caught here for the
  // include copy's reason: the callers would report "could not create an
  // isolated worktree" for one that exists and that nothing would clean up.
  let setup: WorktreeRunSummary | null = null;
  if (project) {
    try {
      const run = await runWorktreePhase('setup', { projectId: project.id, worktree: abs, env: commandEnv(abs, root, ports) });
      setup = run ? summarizeRun(run) : null;
    } catch (e) {
      setup = {
        id: '', phase: 'setup', status: 'failed', startedAt: Date.now(), endedAt: null, planned: 0, ran: 0, stoppedAt: null,
        note: `Setup could not be started or recorded (${message(e)}), so none of its commands ran`, tail: '', tailCut: false,
      };
    }
  }

  return {
    // For a pinned worktree, the HEAD read back above rather than the repo's.
    path: abs, branch, head: pinned ?? head, repoRoot: root, sessionId, dirty: 0, ahead: 0, linked,
    bootstrap: { ...recorded, setup },
  };
}

/**
 * Repair a worktree made before linking existed, or one whose links were
 * removed. Safe to run repeatedly: an existing path is never replaced. It
 * links whatever the project's dependency choice is — the name promises links.
 */
export async function relinkWorktree(worktreePath: string): Promise<LinkedPath[]> {
  const row = db().prepare('SELECT repo_root FROM worktrees WHERE path = ?').get(canon(worktreePath)) as
    { repo_root: string } | undefined;
  if (!row) throw new Error(`Wanigan has no record of a worktree at ${worktreePath}.`);
  return (await placeDependencies(row.repo_root, canon(worktreePath), 'link')).linked;
}

/* ── inspect ─────────────────────────────────────────────────────────── */

/**
 * Everything worktreeStatus reports, plus the reason git gave when it could
 * not count. WorktreeInfo.dirty/ahead carry null for that case, so the UI can
 * say "unreadable" rather than "none"; the Dirty and Ahead shapes ride
 * alongside because they also carry git's own words, and re-running
 * `git status` in merge and remove would mean a second 30s wait in exactly the
 * case where the first one already timed out.
 */
async function inspect(p: string): Promise<{ info: WorktreeInfo; dirty: Dirty; ahead: Ahead } | null> {
  const abs = canon(p);
  if (!fs.existsSync(abs)) return null;

  const inside = await git(abs, ['rev-parse', '--is-inside-work-tree'], 8000);
  if (!inside.ok || inside.stdout.trim() !== 'true') return null;

  const repoRoot = await repoRootFor(abs);
  if (!repoRoot) return null;

  const [branch, head, dirty] = await Promise.all([
    currentBranch(abs),
    headOf(abs),
    dirtyCount(abs),
  ]);

  // No base is "there is nothing to count from", which is not a failure and is
  // not reported as one: merge refuses on a missing recorded base long before
  // it reads this, so only a git call that actually went wrong becomes unknown.
  let ahead: Ahead = { count: 0, said: null };
  const base = await baseForCount(repoRoot, branch);
  if (base) {
    if (!head) {
      ahead = { count: null, said: `git could not resolve HEAD in ${abs}` };
    } else {
      const r = await git(abs, ['rev-list', '--count', `${base}..HEAD`], 20_000);
      const text = r.stdout.trim();
      const n = r.ok && text ? Number(text) : NaN;
      ahead = Number.isFinite(n) ? { count: n, said: null } : { count: null, said: gitSaid(r) };
    }
  }

  const info: WorktreeInfo = {
    path: abs, branch, head, repoRoot,
    sessionId: rowFor(abs)?.session_id ?? null,
    // Null travels. It used to be flattened to 0 here, on the grounds that
    // "nothing destructive is decided from these two fields" — but the
    // renderer's force-delete confirmation is built from them, and it renders
    // 0 as "none". An operator shown "none" who presses "yes, delete" sends
    // force: true, which is precisely the flag that skips the refusal below.
    dirty: dirty.count,
    ahead: ahead.count,
  };
  return { info, dirty, ahead };
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
    out.push({
      ...(info ?? {
        path: abs, branch: rec.branch, head: rec.head, repoRoot: root,
        sessionId: rowFor(abs)?.session_id ?? null, dirty: 0, ahead: 0,
      }),
      bootstrap: bootstrapFor(abs),
    });
  }
  return out;
}

/* ── merge ───────────────────────────────────────────────────────────── */

/** Repo roots with a merge in flight. See mergeWorktree for why this exists. */
const merging = new Set<string>();

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
  // Keyed on the repo, not the worktree: every merge for a repo lands in
  // whichever tree holds the base branch, so two merges started from two
  // *different* worktrees of one repo are the pair that collides. Behind a
  // button this is one double-click away, and the collision is not a wasted
  // run — it is the second merge's `git merge --abort` reaching into the first
  // one's finished merge and backing it out, in the tree that holds the only
  // copy of the work.
  const key = (await repoRootFor(p)) ?? canon(p);
  if (merging.has(key)) {
    return {
      merged: false,
      detail: `Another merge into ${key} is already running. Wait for it to finish and try again — both land in the same working tree, and backing one out on a conflict would undo the other.`,
    };
  }
  merging.add(key);
  try {
    return await runMerge(p, opts);
  } finally {
    merging.delete(key);
  }
}

async function runMerge(
  p: string,
  opts?: { squash?: boolean; message?: string }
): Promise<{ merged: boolean; detail: string }> {
  const found = await inspect(p);
  if (!found) throw new Error(`There is no git worktree at ${p} — it may already have been removed. Reconcile the worktree list and try again.`);
  const { info, dirty, ahead } = found;

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
    return { merged: false, detail: `Wanigan has no record of which branch ${info.branch} was created from, so it will not guess a merge target. Merge it by hand: git switch <target> && git merge ${info.branch}.` };
  }
  if (!(await branchExists(info.repoRoot, base))) {
    return { merged: false, detail: `${info.branch} was created from ${base}, which is no longer a branch in ${info.repoRoot} (it was a detached HEAD, or the branch has since been deleted). Pick a target and merge it by hand.` };
  }
  if (ahead.count === null) {
    return { merged: false, detail: `git could not count how far ${info.branch} is ahead of ${base}: ${ahead.said}. Refusing to merge until it can — "nothing to merge" and "git could not tell" are not the same answer, and only one of them is your problem to fix. Run "git log ${base}..${info.branch}" in ${info.path} and try again.` };
  }
  if (ahead.count === 0) {
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
  // null, not 0. This is the number a person reads to see whether the merge did
  // anything, and a diff that timed out reporting "touching 0 files" next to
  // "Merged" is the app saying the merge was empty when it was not.
  const files = changed.ok ? changed.stdout.split('\0').filter(Boolean).length : null;
  const squash = opts?.squash === true;
  const message = opts?.message?.trim() || `wanigan: ${squash ? 'squash' : 'merge'} ${info.branch} into ${base}`;

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

  const how = squash ? `Squashed ${plural(ahead.count, 'commit')}` : `Merged ${plural(ahead.count, 'commit')}`;
  const touched = files === null
    ? `. git could not list the files it touched (${gitSaid(changed)}), so that count is missing rather than zero`
    : `, touching ${plural(files, 'file')}`;
  return {
    merged: true,
    detail: `${how} from ${info.branch} into ${base} in ${target.path}${touched}. The worktree is untouched — remove it when you are done with it.`,
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
    return {
      removed: true,
      detail: `Nothing on disk at ${abs}. Wanigan's record was cleared and git's worktree list pruned.${teardownNotRun(row)}`,
    };
  }

  const found = await inspect(abs);
  if (!found) {
    throw new Error(`${abs} is not a git worktree. Refusing to delete it — Wanigan only removes directories git says it created.`);
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

  // Teardown runs here: after every refusal, so a worktree that is kept is
  // never torn down underneath its uncommitted files, and before git deletes
  // anything, so the commands still have the directory and its port block. A
  // failed teardown does not stop the removal. Whether to keep a worktree is
  // the dirty check's decision, made above on what the worktree holds; a
  // teardown that could not stop a container is recorded and said below, not
  // turned into a checkout left on disk that exit cleanup would retry forever.
  const teardown = await teardownBefore(abs, info.repoRoot, row);

  const res = await git(info.repoRoot, ['worktree', 'remove', ...(force ? ['--force'] : []), abs], 5 * 60_000);
  if (!res.ok) {
    const said = gitSaid(res);
    if (/lock/i.test(said)) {
      return { removed: false, detail: `git says this worktree is locked: ${said}. Unlock it with "git worktree unlock ${abs}" and try again. Nothing was deleted.${teardownSaid(teardown, false)}` };
    }
    return { removed: false, detail: `git refused to remove the worktree: ${said}. Nothing was deleted.${teardownSaid(teardown, false)}` };
  }

  await git(info.repoRoot, ['worktree', 'prune'], 30_000);
  markRemoved(abs);

  const kept = info.branch
    ? ` Branch ${info.branch} is kept${info.ahead ? ` with ${plural(info.ahead, 'unmerged commit')}` : ''} — delete it yourself when you are sure.`
    : '';
  return { removed: true, detail: `Removed the worktree at ${abs}.${kept}${teardownSaid(teardown, true)}` };
}

/** The project a recorded worktree was made for: the row's own, or the one its repository is registered as. */
function projectIdFor(row: Row | undefined): string | null {
  if (!row) return null;
  return row.project_id ?? projectForDirectory(row.repo_root, row.repo_root)?.id ?? null;
}

/**
 * Runs the project's teardown in a worktree about to be removed. Only for a
 * worktree Wanigan has a row for — one it made, or adopted as an orphan — so a
 * checkout a person made by hand never has a project's commands run in it.
 */
async function teardownBefore(abs: string, repoRoot: string, row: Row | undefined): Promise<WorktreeCommandRun | null> {
  const projectId = projectIdFor(row);
  if (!projectId) return null;
  // Nothing to run means no port block to look up either — an adopted orphan
  // has none recorded, and probing for one on its way out would be waste. A
  // row that cannot be read goes on to runWorktreePhase, which records that.
  try { if (!worktreeCommands(projectId).teardown.length) return null; } catch { /* recorded by the run */ }
  const ports = await worktreePortBlock(abs);
  return runWorktreePhase('teardown', { projectId, worktree: abs, env: commandEnv(abs, repoRoot, ports) });
}

function teardownSaid(run: WorktreeCommandRun | null, removed: boolean): string {
  if (!run) return '';
  if (run.status === 'passed') return ' Teardown ran first and passed.';
  return ` Teardown ran first and failed (${runFacts(summarizeRun(run))}); its output is recorded under Worktree setup in Changes`
    + `${removed ? ', and the worktree was removed anyway' : ''}.`;
}

/** Said when the directory is already gone and the project has teardown commands that therefore could not run. */
function teardownNotRun(row: Row | undefined): string {
  const projectId = projectIdFor(row);
  if (!projectId) return '';
  try {
    return worktreeCommands(projectId).teardown.length
      ? ' Its teardown commands were not run: there was no directory left to run them in.'
      : '';
  } catch {
    return ' Wanigan could not read its teardown commands, and there was no directory left to run them in anyway.';
  }
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
// The live set is passed in rather than read here. Asking sessions.ts which
// sessions are running made worktrees import it, and sessions.ts imports this
// file to create and remove worktrees — the last two-module runtime cycle in
// src/main. Both callers are in index.ts, which already knows both modules;
// composing them there is where that belongs.
export async function reconcileWorktrees(live: ReadonlySet<string>): Promise<WorktreeInfo[]> {

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
      const ours = Boolean(row) || (rec.branch?.startsWith('wanigan/') ?? false);
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
  // than deleted: the history of what Wanigan created is worth keeping.
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
