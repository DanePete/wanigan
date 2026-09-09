import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const exec = promisify(execFile);

/**
 * Git, for the repo you already have open.
 *
 * Wanigan could already read git — diffs, baselines, worktrees — but never act
 * on it, so every commit meant leaving the app. This is the acting half, kept
 * deliberately short of a full client: the operations someone running agents
 * actually performs, and none of the ones where a GUI's guess is worse than a
 * terminal's explicitness.
 *
 * Every call goes through execFile with an argument array, never a shell
 * string. A branch named `; rm -rf ~` is a thing a person can create.
 */

/** Unit separator: it cannot appear in a commit subject, unlike any character. */
const SEP = '\x1f';

export type GitFile = {
  path: string; index: string; work: string;
  staged: boolean; untracked: boolean; conflicted: boolean;
};

export type GitStatus = {
  isRepo: boolean; root: string;
  /** The repository `root` belongs to. The same path for a whole-repo project. */
  repoRoot: string;
  /**
   * Set when the project is a subdirectory of a larger repository: its path
   * from the repository root. File paths below stay repository-relative
   * because that is what git reports and what every later call expects.
   * While this is set the reads are scoped to the subdirectory and every
   * acting call refuses, because git cannot commit or discard for part of a
   * repository.
   */
  subpath: string | null;
  branch: string | null; detached: boolean;
  upstream: string | null; ahead: number; behind: number;
  staged: GitFile[]; unstaged: GitFile[]; untracked: GitFile[]; conflicted: GitFile[];
  clean: boolean; operation: string | null;
};

export type Commit = {
  hash: string; short: string; parents: string[];
  author: string; email: string; at: number; subject: string; body: string;
  refs: string[]; head: boolean;
  /** Assigned here so the renderer draws a graph rather than deriving one. */
  lane: number; color: number;
};

export type Branch = {
  name: string; current: boolean; remote: boolean; upstream: string | null;
  ahead: number; behind: number; at: number | null; subject: string | null;
};

export type Stash = { index: number; label: string; at: number | null; subject: string };

/* -- running git ----------------------------------------------------- */

export type GitRun = {
  ok: boolean; out: string; err: string;
  /**
   * git's own exit status, or null when there was not one — it was killed at
   * the timeout, or never started. "git answered no" and "git never answered"
   * are different facts, and several callers have to tell them apart: an
   * unresolvable revision exits 1 quietly, and so does nothing else here.
   */
  code: number | null;
  killed: boolean;
};
export type GitRunOpts = {
  timeout?: number;
  maxBuffer?: number;
  /** Extra variables (e.g. GIT_INDEX_FILE). The prompt hardening always wins. */
  env?: Record<string, string>;
};

/**
 * The environment every git in this process runs under.
 *
 * Against a repo with an HTTPS remote, a git that decides it needs a
 * credential asks for one — and there is no terminal attached to answer, so
 * the call never returns. The main process pumps every PTY, so one blocked
 * `git fetch` stops the whole app with nothing in the log to explain it.
 * `GIT_TERMINAL_PROMPT` turns that hang into an error the caller can show.
 *
 * The askpass pair closes the same door one step further out: an inherited
 * `GIT_ASKPASS` (a terminal opened from an editor routinely sets one) makes
 * git ask a helper instead of the terminal, and a helper that opens a dialog
 * waits just as long. Empty rather than deleted, because git only consults it
 * when it is non-empty. `GIT_SSH_COMMAND` defers to an operator who set their
 * own transport; the default merely refuses to sit on a passphrase prompt
 * nobody can see.
 */
function gitEnv(overlay?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Overlay sits below the hardening: a caller can point git at a scratch
    // index, never back at an interactive prompt.
    ...overlay,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -oBatchMode=yes',
  };
}

/**
 * The one place this process runs git.
 *
 * Timeout and buffer stay per-call because the calls are not alike: a
 * `rev-parse` that takes eight seconds is broken, while `worktree add` on a
 * large repo legitimately takes minutes. What is not per-call is the hardened
 * environment — a wrapper that forgets it is a wrapper that can hang the app.
 *
 * Exit status is returned rather than thrown: half of what callers ask git is
 * a question where "that failed" is the answer.
 */
export async function runGit(cwd: string, args: string[], opts: GitRunOpts = {}): Promise<GitRun> {
  if (typeof cwd !== 'string' || !cwd.trim()) {
    return { ok: false, out: '', err: 'No directory was given for this git command.', code: null, killed: false };
  }
  try {
    const { stdout, stderr } = await exec('git', ['-C', cwd, ...args], {
      timeout: opts.timeout ?? 30_000,
      maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
      env: gitEnv(opts.env),
    });
    return { ok: true, out: stdout, err: stderr, code: 0, killed: false };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; message?: string; code?: number | string; killed?: boolean };
    return {
      ok: false, out: x.stdout ?? '', err: (x.stderr || x.message || 'git failed').trim(),
      code: typeof x.code === 'number' ? x.code : null, killed: x.killed === true,
    };
  }
}

/**
 * The same runner for the few callers that cannot await — a value read inside
 * a better-sqlite3 transaction, for instance. Same environment, same reason:
 * a synchronous git that blocks on a prompt blocks the process outright, so
 * the timeout here is deliberately short.
 */
export function runGitSync(cwd: string, args: string[], opts: GitRunOpts = {}): GitRun {
  if (typeof cwd !== 'string' || !cwd.trim()) {
    return { ok: false, out: '', err: 'No directory was given for this git command.', code: null, killed: false };
  }
  try {
    const out = execFileSync('git', ['-C', cwd, ...args], {
      timeout: opts.timeout ?? 8_000,
      maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
      env: gitEnv(opts.env),
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { ok: true, out, err: '', code: 0, killed: false };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; message?: string; status?: number | null; signal?: string | null };
    return {
      ok: false, out: x.stdout ?? '', err: (x.stderr || x.message || 'git failed').trim(),
      code: typeof x.status === 'number' ? x.status : null, killed: x.signal != null,
    };
  }
}

/** This module's own shorthand; every call it makes wants the same buffer. */
function git(root: string, args: string[], timeout = 30_000): Promise<GitRun> {
  return runGit(root, args, { timeout });
}

/**
 * The commit HEAD names, or null when there is not one.
 *
 * Every module that wanted this used to spell it itself, which is how a
 * hardened wrapper in one file and a bare `execFileSync` in another ended up
 * asking git the same question with different consequences.
 */
export async function head(cwd: string): Promise<string | null> {
  const r = await runGit(cwd, ['rev-parse', 'HEAD'], { timeout: 8_000, maxBuffer: 1024 * 1024 });
  return r.ok ? r.out.trim() || null : null;
}

/** The synchronous twin, for callers that cannot await. */
export function headSync(cwd: string): string | null {
  const r = runGitSync(cwd, ['rev-parse', 'HEAD'], { timeout: 5_000, maxBuffer: 1024 * 1024 });
  return r.ok ? r.out.trim() || null : null;
}

/**
 * Why a directory has no branch name — which is five different answers, and
 * collapsing them to null told the operator "not a repo" when the truth was a
 * fresh `git init`, a detached checkout, or a git that timed out on a network
 * share. A feature is then disabled for a reason nobody is shown.
 */
export type RepoState =
  | { kind: 'branch'; branch: string }
  /** A checkout with no branch: HEAD points straight at a commit. */
  | { kind: 'detached'; head: string }
  /** A repo whose branch has no commits yet, so most of git cannot answer. */
  | { kind: 'unborn'; branch: string | null }
  /** Not a git repository at all. */
  | { kind: 'absent' }
  /** A repo git could not read: a timeout, a permission, a broken .git. */
  | { kind: 'unreadable'; reason: string };

const firstLine = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? 'git gave no reason.';
/** A killed git printed nothing worth quoting; say what happened instead. */
const reasonFor = (r: GitRun) => (r.killed ? 'git did not answer in time.' : firstLine(r.err));

export async function repoState(dir: string): Promise<RepoState> {
  const small = { timeout: 8_000, maxBuffer: 1024 * 1024 };
  const inside = await runGit(dir, ['rev-parse', '--is-inside-work-tree'], small);
  if (!inside.ok) {
    // Only git's own "not a repository" means absent. Anything else — a
    // timeout, an unreadable .git, a path that vanished — is a failure to
    // read, and must not be reported as an answer about the directory.
    return /not a git repository/i.test(inside.err) ? { kind: 'absent' } : { kind: 'unreadable', reason: reasonFor(inside) };
  }
  if (inside.out.trim() !== 'true') {
    return { kind: 'unreadable', reason: 'This is a bare repository, so it has no working tree to read.' };
  }
  const current = await runGit(dir, ['branch', '--show-current'], small);
  if (!current.ok) return { kind: 'unreadable', reason: reasonFor(current) };
  const branch = current.out.trim() || null;

  // `--quiet` turns an unresolvable HEAD into a silent exit 1 and prints
  // nothing, so the exit status is the only thing that separates "this repo
  // has no commits" from "git was killed at the timeout" — which is the
  // distinction this whole function exists to keep.
  const commit = await runGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], small);
  const hash = commit.out.trim();
  if (!commit.ok && !(commit.code === 1 && !hash)) return { kind: 'unreadable', reason: reasonFor(commit) };
  if (!hash) return { kind: 'unborn', branch };
  return branch ? { kind: 'branch', branch } : { kind: 'detached', head: hash };
}

/** git's own message is almost always the most useful thing available. */
function fail(err: string): never {
  throw new Error(err.split('\n').slice(0, 6).join('\n'));
}

/* -- scope ----------------------------------------------------------- */

/**
 * Which repository a caller's directory belongs to, and where inside it.
 *
 * A project can be registered at `monorepo/packages/web`. This module used to
 * answer `rev-parse --show-toplevel` and then thread the *repository* root
 * through every read and every act, so a view titled after one package listed
 * the whole monorepo's dirty files — and its Discard button reached all of
 * them. That is a repo-wide destructive action presented as a scoped one.
 *
 * So the subdirectory is carried instead of erased: reads are scoped to it
 * with a pathspec, and acting is refused (see `acting`) because git has no
 * scoped equivalent — a commit, a checkout or a push is a whole-repository
 * event however the button was labelled.
 */
export type Scope = {
  /** The directory the caller named, canonical. */
  root: string;
  /** The repository it belongs to. */
  repoRoot: string;
  /** Its path from the repository root, or null when it is the root. */
  sub: string | null;
};

function real(p: string): string {
  const abs = path.resolve(p);
  try { return fs.realpathSync(abs); } catch { return abs; }
}

/** Exported for the other readers of a project directory, who have the same
 *  question and must not answer it with a different rule. */
export async function scopeOf(dir: string): Promise<Scope | null> {
  const top = await git(dir, ['rev-parse', '--show-toplevel'], 8_000);
  if (!top.ok || !top.out.trim()) return null;
  const repoRoot = top.out.trim();
  const asked = real(dir);
  if (asked === real(repoRoot)) return { root: repoRoot, repoRoot, sub: null };
  const rel = path.relative(real(repoRoot), asked);
  // git placed this directory in that repo; if the two paths still do not
  // nest after realpath (a symlinked checkout reached the long way round),
  // say so rather than inventing a pathspec from a `..` relative path.
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { root: repoRoot, repoRoot, sub: null };
  return { root: asked, repoRoot, sub: rel };
}

/**
 * The gate in front of everything that writes. Reads degrade to the
 * subdirectory; acts stop, and say which repository they would have reached.
 */
async function acting(dir: string, what: string): Promise<Scope> {
  const scope = await scopeOf(dir);
  if (!scope) fail(`${path.resolve(dir)} is not a git repository, so there is nothing to ${what}.`);
  if (scope.sub) {
    fail(
      `This project is the subdirectory ${scope.sub} of the repository at ${scope.repoRoot}. ` +
      `Git has no way to ${what} for one directory only, so doing it here would reach every ` +
      `other directory in that repository — including ones this view never showed you. ` +
      `Wanigan projects are whole repositories: add ${scope.repoRoot} as a project to work on it.`,
    );
  }
  return scope;
}

/** A read limited to the project's own directory, when it is not the repo root. */
function within(scope: Scope, args: string[]): string[] {
  return scope.sub ? [...args, '--', scope.sub] : args;
}

/* -- status ---------------------------------------------------------- */

/** git's own prefix on the porcelain branch header of a branch with no commits. */
const UNBORN = 'No commits yet on ';

export async function status(dir: string): Promise<GitStatus> {
  const scope = await scopeOf(dir);
  if (!scope) {
    const here = path.resolve(dir);
    return {
      isRepo: false, root: here, repoRoot: here, subpath: null,
      branch: null, detached: false, upstream: null,
      ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [],
      clean: true, operation: null,
    };
  }
  const root = scope.repoRoot;
  const r = await git(root, within(scope, ['status', '--porcelain=v1', '--branch', '-z']));
  if (!r.ok) fail(r.err);

  let branch: string | null = null, upstream: string | null = null;
  let ahead = 0, behind = 0, detached = false;
  const staged: GitFile[] = [], unstaged: GitFile[] = [], untracked: GitFile[] = [], conflicted: GitFile[] = [];

  const parts = r.out.split('\0').filter((x) => x !== '');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (line.startsWith('##')) {
      // A branch with no commits yet is announced as prose: git prints the
      // literal `No commits yet on ` in front of the name (porcelain forces the
      // untranslated string, so this is the spelling in every locale). Only the
      // detached spelling was special-cased, so a freshly `git init`-ed project
      // put the whole sentence where a branch name goes — the view's branch chip
      // read "No commits yet on main", and Push turned it into
      // `git push -u origin "No commits yet on main"`.
      //
      // The prefix is stripped rather than matched-and-skipped: the rest of the
      // header is unchanged by it, so an unborn branch that already has an
      // upstream configured still parses. `## No commits yet on fresh...origin/main [gone]`
      // is a real header, and it carries both the `...` and the `[…]` fields.
      const raw = line.slice(2).trim();
      const head = raw.startsWith(UNBORN) ? raw.slice(UNBORN.length) : raw;
      if (head.startsWith('HEAD (no branch)')) { detached = true; continue; }
      const [names, track] = head.split(/\s+\[/);
      const [local, up] = names.split('...');
      branch = local || null;
      upstream = up || null;
      if (track) {
        const a = /ahead (\d+)/.exec(track); const b = /behind (\d+)/.exec(track);
        ahead = a ? Number(a[1]) : 0; behind = b ? Number(b[1]) : 0;
      }
      continue;
    }
    const x = line[0] ?? ' ';
    const y = line[1] ?? ' ';
    let file = line.slice(3);
    // A rename carries its source path as the next NUL-separated field.
    if (x === 'R' || x === 'C') i++;
    const entry: GitFile = {
      path: file, index: x, work: y,
      staged: x !== ' ' && x !== '?',
      untracked: x === '?',
      conflicted: x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D'),
    };
    if (entry.conflicted) conflicted.push(entry);
    else if (entry.untracked) untracked.push(entry);
    else {
      if (x !== ' ') staged.push(entry);
      if (y !== ' ') unstaged.push({ ...entry, staged: false });
    }
  }

  // A merge or rebase in flight changes what every button should say.
  let operation: string | null = null;
  const gd = await git(root, ['rev-parse', '--git-dir']);
  if (gd.ok) {
    const g = path.resolve(root, gd.out.trim());
    if (fs.existsSync(path.join(g, 'MERGE_HEAD'))) operation = 'merge';
    else if (fs.existsSync(path.join(g, 'rebase-merge')) || fs.existsSync(path.join(g, 'rebase-apply'))) operation = 'rebase';
    else if (fs.existsSync(path.join(g, 'CHERRY_PICK_HEAD'))) operation = 'cherry-pick';
    else if (fs.existsSync(path.join(g, 'REVERT_HEAD'))) operation = 'revert';
  }

  return {
    isRepo: true, root: scope.root, repoRoot: scope.repoRoot, subpath: scope.sub,
    branch, detached, upstream, ahead, behind,
    staged, unstaged, untracked, conflicted,
    clean: !staged.length && !unstaged.length && !untracked.length && !conflicted.length,
    operation,
  };
}

/* -- the graph ------------------------------------------------------- */

/**
 * Lane packing, done here so the renderer draws rather than derives.
 *
 * Walk newest-first holding one slot per open line of history, each waiting
 * for a specific hash. A commit takes the slot waiting for it, or the leftmost
 * free one; its first parent inherits that slot and any other parents open
 * their own. That is the shape every git GUI converges on, and it is stable as
 * long as the walk is.
 */
function assignLanes(commits: Commit[]): void {
  const expected = new Set(commits.map((c) => c.hash));
  const lanes: (string | null)[] = [];
  for (const c of commits) {
    let lane = lanes.indexOf(c.hash);
    if (lane === -1) {
      lane = lanes.indexOf(null);
      if (lane === -1) { lanes.push(null); lane = lanes.length - 1; }
    }
    c.lane = lane;
    c.color = lane % 6;
    lanes[lane] = c.parents[0] && expected.has(c.parents[0]) ? c.parents[0] : null;
    for (const p of c.parents.slice(1)) {
      if (!expected.has(p) || lanes.includes(p)) continue;
      const free = lanes.indexOf(null);
      if (free === -1) lanes.push(p); else lanes[free] = p;
    }
  }
}

export async function log(dir: string, opts: { limit?: number; all?: boolean } = {}): Promise<Commit[]> {
  const scope = await scopeOf(dir);
  if (!scope) return [];
  const root = scope.repoRoot;
  const fmt = ['%H', '%P', '%an', '%ae', '%at', '%D', '%s', '%b'].join(SEP);
  const args = ['log', '--pretty=format:' + fmt + '%x00', '-n' + String(opts.limit ?? 150)];
  if (opts.all) args.push('--all');
  // Scoped to the project's own directory when it is not the repo root: a
  // graph of commits that never touched it is a graph about something else.
  const r = await git(root, within(scope, args));
  const tip = (await head(root)) ?? '';
  // An unborn branch has no commits and `git log` exits non-zero saying so:
  // that is an empty history, not a failed read. Every other failure is a
  // failed read, and returning [] for it drew a timeout or a locked index as
  // a repository with no history — a claim nobody observed.
  if (!r.ok) {
    if (!tip) return [];
    fail(r.err);
  }
  const commits: Commit[] = [];
  for (const block of r.out.split('\0')) {
    const line = block.replace(/^\n/, '');
    if (!line.trim()) continue;
    const f = line.split(SEP);
    if (f.length < 7) continue;
    commits.push({
      hash: f[0], short: f[0].slice(0, 7),
      parents: f[1].trim() ? f[1].trim().split(' ') : [],
      author: f[2], email: f[3], at: Number(f[4]) * 1000,
      refs: f[5] ? f[5].split(',').map((s) => s.trim()).filter(Boolean) : [],
      subject: f[6], body: (f[7] ?? '').trim(),
      head: f[0] === tip, lane: 0, color: 0,
    });
  }
  assignLanes(commits);
  return commits;
}

/** Object names only. `git show` takes diff options, and one of them is
 *  `--output=<file>`: an unvalidated leading dash from the renderer is a
 *  write-anywhere primitive, not a bad lookup. */
const OBJECT_NAME = /^[0-9a-fA-F]{4,64}$/;

/** A patch this long is not going to be read in a pane; the cut is announced
 *  rather than silently returning a diff that stops mid-hunk. */
const PATCH_MAX_BYTES = 400_000;

export async function commitDiff(dir: string, hash: string) {
  if (!OBJECT_NAME.test(hash)) return { files: [], patch: '' };
  const scope = await scopeOf(dir);
  if (!scope) return { files: [], patch: '' };
  const root = scope.repoRoot;
  const stat = await git(root, within(scope, ['show', '--numstat', '--format=', hash]));
  const files = stat.ok ? stat.out.split('\n').filter(Boolean).map((l) => {
    const [a, d, p] = l.split('\t');
    return { path: p ?? '', added: Number(a) || 0, removed: Number(d) || 0 };
  }).filter((f) => f.path) : [];
  const patch = await git(root, within(scope, ['show', '--patch', '--format=medium', hash]));
  // An empty commit and a `git show` that failed both used to answer '' here,
  // so a locked index or a timeout was shown as a commit that changed nothing.
  if (!patch.ok) fail(patch.err);
  const cut = patch.out.length > PATCH_MAX_BYTES;
  return { files, patch: cut ? patch.out.slice(0, PATCH_MAX_BYTES) : patch.out, truncated: cut, bytes: patch.out.length };
}

/* -- branches, stash ------------------------------------------------- */

export async function branches(root: string): Promise<Branch[]> {
  // The full refname is the only reliable local/remote discriminator: the short
  // form collapses refs/remotes/origin/main and a local feature/login branch
  // into names that both merely contain a slash.
  const f = ['%(refname:short)', '%(HEAD)', '%(upstream:short)', '%(upstream:track)',
             '%(committerdate:unix)', '%(contents:subject)', '%(refname)'].join(SEP);
  const r = await git(root, ['for-each-ref', '--format=' + f, 'refs/heads', 'refs/remotes']);
  // A repository with no branches answers with an empty list, not an error, so
  // any failure here is a failed read and says so rather than rendering as a
  // repository that has no branches.
  if (!r.ok) fail(r.err);
  const out: Branch[] = [];
  for (const line of r.out.split('\n')) {
    if (!line.trim()) continue;
    const [name, head, up, track, date, subject, full] = line.split(SEP);
    if (name.endsWith('/HEAD')) continue;
    const a = /ahead (\d+)/.exec(track ?? ''); const b = /behind (\d+)/.exec(track ?? '');
    out.push({
      name, current: (head ?? '').trim() === '*', remote: (full ?? '').startsWith('refs/remotes/'),
      upstream: up || null, ahead: a ? Number(a[1]) : 0, behind: b ? Number(b[1]) : 0,
      at: date ? Number(date) * 1000 : null, subject: subject || null,
    });
  }
  return out.sort((a, b) => Number(b.current) - Number(a.current) || (b.at ?? 0) - (a.at ?? 0));
}

export async function stashes(root: string): Promise<Stash[]> {
  const r = await git(root, ['stash', 'list', '--format=%gd' + SEP + '%ct' + SEP + '%gs']);
  // `stash list` succeeds with empty output when there are no stashes, here too.
  if (!r.ok) fail(r.err);
  return r.out.split('\n').filter(Boolean).map((l, i) => {
    const [label, at, subject] = l.split(SEP);
    return { index: i, label, at: at ? Number(at) * 1000 : null, subject: subject ?? '' };
  });
}

/* -- acting ---------------------------------------------------------- */

/**
 * A ref the renderer named, checked before it becomes argv.
 *
 * There are two separate holes here and each one stays open when only the
 * other is closed, which is why this check and a `--` are both present on the
 * checkout, merge and branch-delete argv below — trailing on the first two,
 * and before the name on `branch -d`, whose ref comes last. `push` is the one
 * callsite that takes this check alone: what `git push` does with a `--` was
 * not checked, so it did not get one.
 *
 * A branch whose name begins with a dash is creatable — `git update-ref
 * refs/heads/-f HEAD` succeeds — and `branches()` above lists it like any
 * other, so the checkout button beside it ran `git checkout -f`. git read
 * that as the option: it reverted every uncommitted modification in the
 * repository and exited 0, so the UI reported a successful branch switch. A
 * trailing `--` does not stop it; `git checkout -f --` discards too.
 *
 * And `.` is a pathspec that no name check can tell apart from a ref, so
 * `git checkout .` restored the whole working tree from the index, also at
 * exit 0. Only the trailing `--` refuses that one: `git checkout . --` exits
 * 128 with `invalid reference: .`, while `git checkout <branch> --` switches
 * normally (checked against git 2.50.1).
 *
 * The pattern is deliberately narrow — a leading dash, whitespace, a control
 * character, a length — because git's own ref rules are much stricter than
 * this and git enforces them itself, so a check that guessed at them here
 * would take legal refs away from the UI. The price of the dash rule is that
 * a ref genuinely named `-f` becomes unreachable from Wanigan altogether,
 * including to delete it; that one needs a terminal.
 */
const REF_MAX = 250;

function refArg(ref: unknown, what: string): string {
  if (typeof ref !== 'string') fail(`${what} needs a branch or commit name, and this was not text.`);
  const name = ref.trim();
  if (!name) fail(`${what} needs a branch or commit name.`);
  // Quoted back into a UI string, so the control characters this refuses do not
  // travel with it.
  const shown = name.slice(0, 80).replace(/[\u0000-\u001f\u007f]/g, '');
  if (name.startsWith('-')) {
    fail(
      `"${shown}" begins with a dash, which git reads as an option rather than a ref, ` +
      `so Wanigan will not pass it. A branch really named that has to be renamed or ` +
      `deleted from a terminal.`,
    );
  }
  if (/\s/.test(name) || /[\u0000-\u001f\u007f]/.test(name)) {
    fail(`"${shown}" contains a space or a control character, which a git ref cannot.`);
  }
  if (name.length > REF_MAX) {
    fail(`That name is ${name.length} characters; ${REF_MAX} is the most this will pass to git.`);
  }
  return name;
}

export async function stage(dir: string, files: string[]) {
  const { repoRoot } = await acting(dir, 'stage files');
  const r = await git(repoRoot, ['add', '--'].concat(files));
  if (!r.ok) fail(r.err);
  return true;
}
export async function unstage(dir: string, files: string[]) {
  const { repoRoot } = await acting(dir, 'unstage files');
  const r = await git(repoRoot, ['restore', '--staged', '--'].concat(files));
  if (!r.ok) fail(r.err);
  return true;
}
/**
 * Discarding tracked changes and deleting untracked files are different acts
 * with different consequences, so they are separate arguments rather than one
 * button that quietly does both.
 */
export async function discard(dir: string, tracked: string[], untracked: string[] = []) {
  const { repoRoot } = await acting(dir, 'discard changes');
  if (tracked.length) {
    const r = await git(repoRoot, ['restore', '--worktree', '--'].concat(tracked));
    if (!r.ok) fail(r.err);
  }
  if (untracked.length) {
    const r = await git(repoRoot, ['clean', '-f', '--'].concat(untracked));
    if (!r.ok) fail(r.err);
  }
  return true;
}
export async function commit(dir: string, message: string, opts: { amend?: boolean; all?: boolean } = {}) {
  if (!message.trim() && !opts.amend) throw new Error('A commit needs a message.');
  const { repoRoot } = await acting(dir, 'commit');
  const args = ['commit', '-m', message];
  if (opts.amend) args.push('--amend');
  if (opts.all) args.push('-a');
  const r = await git(repoRoot, args);
  if (!r.ok) fail(r.err);
  return r.out.trim();
}
export async function checkout(dir: string, ref: string, create = false) {
  const name = refArg(ref, 'A checkout');
  const { repoRoot } = await acting(dir, 'check out a branch');
  const r = await git(repoRoot, create ? ['checkout', '-b', name, '--'] : ['checkout', name, '--']);
  if (!r.ok) fail(r.err);
  return true;
}
export async function deleteBranch(dir: string, name: string, force = false) {
  const branch = refArg(name, 'A branch delete');
  const { repoRoot } = await acting(dir, 'delete a branch');
  const r = await git(repoRoot, ['branch', force ? '-D' : '-d', '--', branch]);
  if (!r.ok) fail(r.err);
  return true;
}
export async function merge(dir: string, ref: string) {
  const name = refArg(ref, 'A merge');
  const { repoRoot } = await acting(dir, 'merge');
  const r = await git(repoRoot, ['merge', '--no-edit', name, '--']);
  if (!r.ok) fail(r.err);
  return r.out.trim();
}
export async function fetchAll(dir: string) {
  const { repoRoot } = await acting(dir, 'fetch');
  const r = await git(repoRoot, ['fetch', '--all', '--prune'], 120_000);
  if (!r.ok) fail(r.err);
  return (r.err || r.out).trim() || 'Up to date.';
}
/** Fast-forward only: a pull that silently merges is a pull that surprises. */
export async function pull(dir: string) {
  const { repoRoot } = await acting(dir, 'pull');
  const r = await git(repoRoot, ['pull', '--ff-only'], 120_000);
  if (!r.ok) fail(r.err);
  return r.out.trim() || 'Already up to date.';
}
/** Push leaves the machine, so there is no force flag to reach for by accident. */
export async function push(dir: string, opts: { setUpstream?: boolean; branch?: string } = {}) {
  const { repoRoot } = await acting(dir, 'push');
  const args = ['push'];
  if (opts.setUpstream && opts.branch) args.push('-u', 'origin', refArg(opts.branch, 'A push'));
  const r = await git(repoRoot, args, 180_000);
  if (!r.ok) fail(r.err);
  return (r.err || r.out).trim() || 'Pushed.';
}
export async function stashSave(dir: string, message: string) {
  const { repoRoot } = await acting(dir, 'stash');
  const args = ['stash', 'push', '-u'];
  if (message.trim()) args.push('-m', message.trim());
  const r = await git(repoRoot, args);
  if (!r.ok) fail(r.err);
  return r.out.trim();
}
/**
 * A stash position, checked before it becomes part of a revision.
 *
 * `stash@{<n>}` is not an index expression — it is a reflog expression, and git
 * only reads the braces as a position when they hold an integer. Anything else
 * is parsed as a *date*: `stash@{1.5}` resolves to whatever the stash reflog
 * held at that time, which on a three-entry list is the oldest entry, not the
 * second (checked against git 2.50.1, which answers it with a `log for 'stash'
 * only goes back to …` warning and a hash). So a non-integer here does not
 * fail loudly the way a bad ref does; `apply` and `pop` quietly act on a stash
 * the operator never picked, and pop then drops it.
 *
 * The renderer derives this from the position in `stashes()` and so always
 * sends a whole number today. That is exactly the argument that was made for
 * the ref strings above until a branch named `-f` reverted a working tree:
 * main validates renderer input because main is where the guarantee has to
 * live, not because the current caller is suspect.
 */
function stashArg(index: unknown, what: string): string {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    fail(`${what} needs a whole stash position; git reads anything else as a date and would act on a different stash.`);
  }
  return 'stash@{' + String(index) + '}';
}

export async function stashApply(dir: string, index: number, drop: boolean) {
  const at = stashArg(index, drop ? 'Popping a stash' : 'Applying a stash');
  const { repoRoot } = await acting(dir, drop ? 'pop a stash' : 'apply a stash');
  const r = await git(repoRoot, ['stash', drop ? 'pop' : 'apply', at]);
  if (!r.ok) fail(r.err);
  return r.out.trim();
}
export async function stashDrop(dir: string, index: number) {
  const at = stashArg(index, 'Dropping a stash');
  const { repoRoot } = await acting(dir, 'drop a stash');
  const r = await git(repoRoot, ['stash', 'drop', at]);
  if (!r.ok) fail(r.err);
  return true;
}
/**
 * Paths arrive as git reported them — relative to the repository root — so the
 * diff has to run there even when the project is a subdirectory of it.
 */
export async function fileDiff(dir: string, file: string, staged: boolean) {
  const scope = await scopeOf(dir);
  if (!scope) return '';
  const r = await git(scope.repoRoot, staged ? ['diff', '--staged', '--', file] : ['diff', '--', file]);
  // '' means git had nothing to print (binary, or a mode change only). A failed
  // read is not that, and the renderer's fallback sentence said it was.
  if (!r.ok) fail(r.err);
  return r.out;
}
