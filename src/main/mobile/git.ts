import type http from 'node:http';
import { devNull } from 'node:os';
import { runGit, status, type GitFile, type GitStatus } from '../git';
import { listProjects } from '../store';
import { mobileRepositoryReview } from '../settings';
import { mobileConfig } from './config';
import { json, registerApiRoute, registerRepoGate, send } from './dispatch';
import { safeString } from './snapshot';

/**
 * The one mobile route family that puts file paths on the wire, and the opt-in
 * that has to be on before it will.
 *
 * ./snapshot.ts states the promise the rest of this server keeps: no filesystem
 * path, pid, worktree or transcript reaches a phone, enforced by rebuilding
 * every field of every response from an allow-list. A repository review is made
 * of paths — a changed-file list is nothing else — so this module does not
 * route around that promise, it widens it, and the widening is the visible part
 * of the feature rather than a detail:
 *
 *   - It is a separate setting. `mobileRepositoryReview` in ../settings is off
 *     on every install and every upgrade, and is not implied by the phone
 *     monitor or by remote control. Turning either of those on does not turn
 *     this on.
 *   - It is enforced by the dispatcher's scope, not by a condition in a handler
 *     here. `scope: 'repo'` means the route table itself refuses the request
 *     with 403 before a handler runs, so the set of widened routes stays
 *     enumerable — grep the scope, get the list — and a later handler edit
 *     cannot quietly relax it. That is deliberately the shape the remote-control
 *     opt-in already has.
 *   - Paths are relative to the project, always. git reports repository-relative
 *     paths and this module re-roots them onto the project and refuses anything
 *     absolute, anything beginning `~`, and anything containing `..`. A home
 *     directory is a username; where a checkout sits on someone's disk is not
 *     part of what "which files changed" means.
 *   - No contents arrive unasked, and none are ever written. A repository
 *     reading is status letters and line counts. Source lines travel for one
 *     file at a time, as git's own patch, and only because the operator tapped
 *     that file — a review that hides what changed is not a review, and an
 *     operator deciding about an agent's work from a phone is deciding about
 *     the hunks. The widening stops there: the path asked for has to be one git
 *     itself has just reported as changed, matched against that reading rather
 *     than resolved against the filesystem, so this route cannot be pointed at a
 *     file the screen never offered — an ignored `.env` among them. There is
 *     still nothing here that stages, applies, commits or writes, on purpose.
 *
 * Everything is bounded, and every bound is *said* rather than applied quietly.
 * A capped list reports how many rows it did not send; a change set too large to
 * count refuses its line counts as a whole rather than shipping half of them as
 * if they were the total; a diff too large to send names the size it was and the
 * size allowed instead of arriving as a patch that stops mid-hunk; a response
 * that will not fit the JSON cap is refused rather than trimmed until it does. A
 * truncated answer that looks whole is worse than no answer, because nothing on
 * the screen says which one it is.
 */

/** Every bound this module applies, in one place so the page can be told them. */
export const MOBILE_REPO_LIMITS = {
  /** Projects read for one overview. More than this is a fleet, not a review. */
  projects: 40,
  /** Changed files listed for one repository. */
  files: 300,
  /** Concurrent working-tree reads. Each one is three `git` processes. */
  concurrency: 6,
  /** The whole read, including every git it spawns. */
  timeoutMs: 12_000,
  /** git's own stdout ceiling for the numstat that produces the line counts. */
  diffBytes: 1024 * 1024,
  /** One file's patch, as sent. Deliberately well under the JSON cap below. */
  patchBytes: 128 * 1024,
  /**
   * How much of one file's patch git is allowed to print before it is killed.
   *
   * Two ceilings rather than one, because the refusal has to be able to say
   * *how big* the diff was, and a read stopped at the send cap cannot: it only
   * knows the diff was bigger than the number already on the screen. Reading up
   * to this and then refusing turns 'too large' into '1.4 MB, and Wanigan sends
   * at most 128 KB', which is the difference between a bound and an excuse. Past
   * this the honest answer really is 'larger than 4 MB', and it says that.
   */
  patchReadBytes: 4 * 1024 * 1024,
  /** The same JSON ceiling /api/status holds itself to. */
  jsonBytes: 512 * 1024,
} as const;

/** A path is shown beside a status letter, so it is bounded, never rewritten. */
const PATH_MAX = 400;

/* ── the wire ────────────────────────────────────────────────────────── */

/** What git says about one project, with nothing of where it lives on disk. */
export type MobileRepoSummary = {
  id: string;
  name: string;
  /** 'unreadable' is a failure to read, not an answer about the directory. */
  state: 'clean' | 'dirty' | 'not-a-repo' | 'unreadable';
  branch: string | null;
  detached: boolean;
  ahead: number;
  behind: number;
  /** Distinct paths git reports as changed, however many ways each changed. */
  changed: number;
  /** A merge, rebase, cherry-pick or revert in flight, or null. */
  operation: string | null;
  /** Wanigan's own sentence when there is nothing to report; never git's text. */
  reason: string | null;
};

export type MobileRepoFile = {
  /** Relative to the project directory. Never absolute, never `..`. */
  path: string;
  /** git's own two-character porcelain code: index letter, then worktree letter. */
  status: string;
  where: 'conflicted' | 'staged' | 'unstaged' | 'both' | 'untracked';
  /** Lines differing from HEAD, or null when git did not count them. */
  added: number | null;
  removed: number | null;
  /** Why there is no count, when there is not one. */
  uncounted: 'binary' | 'untracked' | 'not-counted' | null;
};

/**
 * One file's diff, as the phone receives it.
 *
 * `patch` and `reason` are exclusive and one of them is always null: either
 * git's own patch text, unedited, or Wanigan's sentence for why there is none.
 * A response carrying neither would be a screen that shows nothing and explains
 * nothing, which is the state this whole surface exists to refuse.
 */
export type MobileRepoFileDiff = {
  path: string;
  status: string;
  where: MobileRepoFile['where'];
  added: number | null;
  removed: number | null;
  /** git's own unified diff for this one path, or null. Never truncated. */
  patch: string | null;
  /** Why there is no patch — binary, too large, changed back. Never git's text. */
  reason: string | null;
};

/* ── the gate ────────────────────────────────────────────────────────── */

/**
 * Both switches, because this is a widening of the monitor rather than a second
 * product: with the phone monitor off there is no listener to reach at all, and
 * a review opt-in that outlived it would be a setting still described as on
 * while nothing enforced it.
 *
 * Registered rather than imported by ./dispatch, for the same reason the control
 * gate is: the route table has to sit below every module that fills it, and an
 * unregistered gate refuses everything, so a mis-wired build fails closed.
 */
export function repoReviewAllowed(): boolean {
  return mobileConfig().dashboardEnabled && mobileRepositoryReview();
}

registerRepoGate(repoReviewAllowed);

/* ── bounding what leaves ────────────────────────────────────────────── */

/**
 * A path, bounded and stripped of control characters — and of nothing else.
 *
 * Deliberately not ./snapshot's safeString, which collapses runs of whitespace:
 * that is right for a title and wrong for a filename, because `my  notes.md`
 * rewritten to `my notes.md` is a file the operator cannot find. Spaces are
 * legal in a path and survive exactly as git reported them.
 */
function wirePath(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, PATH_MAX);
}

/**
 * The one refusal every path crosses this wire through, in both directions.
 *
 * Going out, an absolute, `~` or `..` path is not reachable from git's own
 * porcelain output — this stands there anyway, because it is the single function
 * between a filesystem and a phone and the cost of being wrong once is a home
 * directory, which is a username, leaving the machine. Coming in, from a device
 * asking for one file's diff, exactly the same shapes are exactly the attack,
 * and they are refused by this function rather than by a second copy of it: two
 * guards is how one of them ends up a character weaker than the other.
 */
function safeRelative(raw: unknown): string | null {
  const value = wirePath(raw);
  if (!value) return null;
  if (value.startsWith('/') || value.startsWith('~') || /^[A-Za-z]:[\\/]/.test(value)) return null;
  if (value.split('/').some((part) => part === '..')) return null;
  return value;
}

/**
 * git's repository-relative path, re-rooted onto the project, or refused.
 *
 * Wanigan projects are whole repositories today — store.ts refuses to add a
 * subdirectory — but rows added before that rule exist, and for those git still
 * reports paths from the *repository* root while this screen is titled after the
 * project. Re-rooting is what keeps the label and the paths talking about the
 * same directory.
 */
function projectRelative(raw: unknown, subpath: string | null): string | null {
  const value = safeRelative(raw);
  if (!value) return null;
  if (!subpath) return value;
  const prefix = subpath.endsWith('/') ? subpath : `${subpath}/`;
  if (!value.startsWith(prefix)) return null;
  return value.slice(prefix.length) || null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

/**
 * The one place a repository answer becomes bytes.
 *
 * A body over the cap is refused whole. The alternative — dropping rows until it
 * fits — produces a page that looks complete and is not, and the operator has no
 * way to tell the two apart from the screen. Exported so the offline suite can
 * drive the refusal without building a repository large enough to trigger it.
 */
export function repoJson(body: unknown, limitBytes = MOBILE_REPO_LIMITS.jsonBytes):
{ ok: true; text: string } | { ok: false; error: string } {
  let text: string;
  try {
    text = JSON.stringify(body);
  } catch {
    return { ok: false, error: 'Wanigan could not turn this working-tree reading into a reply.' };
  }
  const bytes = Buffer.byteLength(text);
  if (bytes > limitBytes) {
    return {
      ok: false,
      error: `This reading is ${Math.round(bytes / 1024)} KB and Wanigan sends at most ` +
        `${Math.round(limitBytes / 1024)} KB to a phone, so it was refused rather than cut short. ` +
        'Open this repository on the Mac to see all of it.',
    };
  }
  return { ok: true, text };
}

function sendRepoJson(res: http.ServerResponse, body: unknown): void {
  const encoded = repoJson(body);
  if (!encoded.ok) { json(res, 503, { error: encoded.error }); return; }
  send(res, 200, 'application/json; charset=utf-8', encoded.text);
}

/* ── counting lines ──────────────────────────────────────────────────── */

export type MobileRepoCounts =
  | { counted: true; byPath: Map<string, { added: number | null; removed: number | null }> }
  | { counted: false; reason: string };

/**
 * `git diff HEAD --numstat -z`, parsed.
 *
 * One diff rather than two, and against HEAD rather than against the index,
 * because "how many lines does this file differ from the last commit" is one
 * question with one answer. Reporting the staged and the unstaged diff of the
 * same file as a single figure would be a sum of two different questions.
 *
 * The -z record is `added TAB removed TAB path NUL`, except for a rename or a
 * copy, where the path field is empty and the preimage and postimage follow as
 * two further NUL-separated fields. The preimage is deliberately dropped: the
 * source of a rename is a path that no longer exists, and this screen is about
 * what is there now. A binary file's counts are `-`, which is git declining to
 * count rather than a zero, and is carried as null for the same reason.
 *
 * Exported for the offline suite, which needs the over-cap branch and has no
 * cheap way to build a repository big enough to reach it.
 */
export function numstatCounts(out: string, limitBytes = MOBILE_REPO_LIMITS.diffBytes): MobileRepoCounts {
  if (Buffer.byteLength(out) > limitBytes) {
    return {
      counted: false,
      reason: `This repository's change set is larger than the ${Math.round(limitBytes / 1024)} KB ` +
        'Wanigan will read for a phone, so no line counts are on this reading. Nothing was cut ' +
        'short: a half-counted diff is a number that is wrong rather than one that is missing.',
    };
  }
  const byPath = new Map<string, { added: number | null; removed: number | null }>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i];
    if (!record) continue;
    const fields = record.split('\t');
    if (fields.length < 3) continue;
    const [addedRaw, removedRaw] = fields;
    let file = fields.slice(2).join('\t');
    if (file === '') {
      // A rename or a copy: the preimage is the next field and the postimage the
      // one after it. Step over the first and take the second.
      file = parts[i + 2] ?? '';
      i += 2;
    }
    if (!file) continue;
    byPath.set(file, {
      added: addedRaw === '-' ? null : Number(addedRaw) || 0,
      removed: removedRaw === '-' ? null : Number(removedRaw) || 0,
    });
  }
  return { counted: true, byPath };
}

/* ── one file's patch ────────────────────────────────────────────────── */

export type MobileRepoPatch =
  | { ok: true; patch: string }
  | { ok: false; reason: string };

/** What one `git diff` of one file came back as, with git's own words dropped. */
export type MobileRepoPatchRead = {
  /**
   * Did git answer this question at all. Not `run.ok`: `diff --no-index` exits 1
   * when the two files differ, which is the answer rather than a failure, so the
   * caller decides what an exit status meant and this function is told.
   */
  answered: boolean;
  out: string;
  /** git was killed for printing past the read ceiling, so `out` is a fragment. */
  overRead: boolean;
};

/**
 * The one place a file's diff becomes something to send, or a sentence saying
 * why it is not.
 *
 * Every branch here refuses whole. A patch cut to fit is the worst artefact this
 * screen could produce: a hunk that ends early reads exactly like a hunk that
 * ended, and an operator deciding whether an agent's change is safe would be
 * deciding about a change they have only seen part of, with nothing on the
 * screen saying so.
 *
 * `run.err` is never read here, and that is deliberate rather than incidental:
 * git's failure text routinely carries absolute paths (`fatal: … /Users/…`), so
 * the reasons below are Wanigan's own sentences and the operator is pointed at
 * the Mac, where git's words are available in full.
 *
 * Exported for the offline suite, which would otherwise need a repository with a
 * four-megabyte diff in it to reach the branches that matter most.
 */
export function patchFor(read: MobileRepoPatchRead, limits = MOBILE_REPO_LIMITS): MobileRepoPatch {
  if (read.overRead) {
    return {
      ok: false,
      reason: `This file's diff is larger than the ${Math.round(limits.patchReadBytes / (1024 * 1024))} MB ` +
        'Wanigan will read for a phone, so none of it was sent and its exact size is not known. Nothing ' +
        'was cut short: half a patch reads like a whole one. Open this file on the Mac to see the change.',
    };
  }
  if (!read.answered) {
    return {
      ok: false,
      reason: 'git did not produce a diff for this file. It may have been moved or removed since this ' +
        'list was read. Open the project on the Mac to see what git said.',
    };
  }
  const bytes = Buffer.byteLength(read.out);
  if (bytes > limits.patchBytes) {
    return {
      ok: false,
      reason: `This file's diff is ${Math.round(bytes / 1024)} KB and Wanigan sends at most ` +
        `${Math.round(limits.patchBytes / 1024)} KB to a phone, so it was refused rather than cut short. ` +
        'Open this file on the Mac to read all of it.',
    };
  }
  // git printing nothing is not an empty diff, it is no diff: between the file
  // list this device is showing and the tap that asked about one row, the file
  // was changed back. Saying that is more use than an empty monospace box.
  if (!read.out.trim()) {
    return {
      ok: false,
      reason: 'git reports no difference in this file now. The list you tapped was read a moment ' +
        'earlier, so it may have been changed back since.',
    };
  }
  return { ok: true, patch: read.out };
}

/* ── reading working trees ───────────────────────────────────────────── */

/**
 * git's error text is never forwarded. `fatal: not a git repository: /Users/…`
 * is an ordinary git message and it carries the one thing this wire must not: an
 * absolute path. A failed read is therefore reported with a sentence this module
 * wrote, and the operator is pointed at the Mac, where git's own words are
 * available in full.
 */
const UNREADABLE = 'Wanigan could not read this working tree. Open the project on the Mac to see what git said.';

function distinctChanged(tree: GitStatus): number {
  const paths = new Set<string>();
  for (const group of [tree.conflicted, tree.staged, tree.unstaged, tree.untracked]) {
    for (const file of group) paths.add(file.path);
  }
  return paths.size;
}

async function summarise(project: { id: string; name: string; path: string }): Promise<MobileRepoSummary> {
  const base: MobileRepoSummary = {
    id: safeString(project.id, 160),
    name: safeString(project.name, 160, 'Unnamed project'),
    state: 'unreadable',
    branch: null,
    detached: false,
    ahead: 0,
    behind: 0,
    changed: 0,
    operation: null,
    reason: UNREADABLE,
  };
  let tree: GitStatus;
  try {
    tree = await status(project.path);
  } catch {
    return base;
  }
  if (!tree.isRepo) {
    return {
      ...base,
      state: 'not-a-repo',
      reason: 'This project is a folder, not a git repository, so there is no working tree to review.',
    };
  }
  return {
    ...base,
    state: tree.clean ? 'clean' : 'dirty',
    branch: tree.branch === null ? null : safeString(tree.branch, 200) || null,
    detached: tree.detached === true,
    ahead: count(tree.ahead),
    behind: count(tree.behind),
    changed: distinctChanged(tree),
    operation: tree.operation === null ? null : safeString(tree.operation, 40) || null,
    reason: null,
  };
}

/**
 * Bounded fan-out. Each working-tree read spawns three git processes, so an
 * operator with thirty projects would otherwise get ninety of them at once on
 * the first tap — which is a laptop fan, not a review.
 */
async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      out[index] = await run(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('working-tree read timed out')), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/* ── the overview ────────────────────────────────────────────────────── */

async function serveRepos(res: http.ServerResponse): Promise<void> {
  const all = listProjects();
  const shown = all.slice(0, MOBILE_REPO_LIMITS.projects);
  const omitted = all.length - shown.length;
  let repos: MobileRepoSummary[];
  try {
    repos = await withTimeout(
      mapLimited(shown, MOBILE_REPO_LIMITS.concurrency, summarise),
      MOBILE_REPO_LIMITS.timeoutMs,
    );
  } catch {
    // A timeout here is one slow repository — a network share that has not woken
    // up, a checkout on a disk that is spinning back up — and there is no honest
    // partial answer to give, because the missing rows are exactly the busy ones.
    json(res, 503, { error: 'Wanigan did not finish reading the working trees in time. Try again in a moment.' });
    return;
  }
  // Dirty first, then the ones that could not answer for themselves, then the
  // quiet ones: the question this screen exists to answer is which repository
  // needs you.
  const rank: Record<MobileRepoSummary['state'], number> = { dirty: 0, unreadable: 1, clean: 2, 'not-a-repo': 3 };
  repos.sort((a, b) => rank[a.state] - rank[b.state] || b.changed - a.changed || a.name.localeCompare(b.name));
  sendRepoJson(res, {
    generatedAt: Date.now(),
    repos,
    omitted,
    note: omitted > 0
      ? `${shown.length} of ${all.length} projects were read. Wanigan caps one reading at ` +
        `${MOBILE_REPO_LIMITS.projects} so a long project list cannot hold the phone waiting on git.`
      : null,
  });
}

/* ── one repository ──────────────────────────────────────────────────── */

/**
 * One row per distinct path. git reports a file that is modified in both the
 * index and the working tree twice, and two rows for one file reads as two
 * changed files; the second sighting upgrades the row to 'both' instead.
 *
 * `gitPaths` maps each row back to the path git actually said, which is what the
 * diff route runs git against. The two differ in two ways that both matter: a
 * row's path is re-rooted onto the project, and it is cut at PATH_MAX. Diffing
 * the wire form would ask git about a shortened path — a file that does not
 * exist — so the wire form is what a request is *matched* against and git's own
 * form is what it is *run* with.
 */
function wireFiles(tree: GitStatus, counts: MobileRepoCounts):
{ files: MobileRepoFile[]; dropped: number; gitPaths: Map<string, string> } {
  const rows = new Map<string, MobileRepoFile>();
  const gitPaths = new Map<string, string>();
  let dropped = 0;
  const mark = (file: GitFile, where: MobileRepoFile['where']) => {
    const relative = projectRelative(file.path, tree.subpath);
    // A path that cannot be re-rooted onto the project is counted, not sent: the
    // operator is told a file was left out rather than shown one that is not
    // theirs, and the count is what keeps that from being silent.
    if (!relative) { dropped += 1; return; }
    const existing = rows.get(relative);
    if (existing) {
      if ((existing.where === 'staged' && where === 'unstaged') || (existing.where === 'unstaged' && where === 'staged')) {
        existing.where = 'both';
      }
      return;
    }
    // git's own letters, rebuilt one character each: the phone shows the code an
    // operator would see from `git status`, and nothing this module invented.
    const index = typeof file.index === 'string' ? file.index.slice(0, 1) || ' ' : ' ';
    const work = typeof file.work === 'string' ? file.work.slice(0, 1) || ' ' : ' ';
    const measured = counts.counted ? counts.byPath.get(file.path) : undefined;
    gitPaths.set(relative, file.path);
    rows.set(relative, {
      path: relative,
      status: `${index}${work}`,
      where,
      added: measured ? measured.added : null,
      removed: measured ? measured.removed : null,
      // Three different reasons a file has no number, kept apart because they
      // have three different answers: git will not count a binary, git does not
      // diff a file it is not tracking, and git was not asked at all when the
      // whole count was refused.
      uncounted: measured
        ? (measured.added === null ? 'binary' : null)
        : where === 'untracked' ? 'untracked' : 'not-counted',
    });
  };
  for (const file of tree.conflicted) mark(file, 'conflicted');
  for (const file of tree.untracked) mark(file, 'untracked');
  for (const file of tree.staged) mark(file, 'staged');
  for (const file of tree.unstaged) mark(file, 'unstaged');
  return { files: [...rows.values()], dropped, gitPaths };
}

async function serveRepo(res: http.ServerResponse, url: URL): Promise<void> {
  const projectId = safeString(url.searchParams.get('project'), 160);
  if (!projectId) { json(res, 400, { error: 'Choose a project.' }); return; }
  const project = listProjects().find((value) => value.id === projectId);
  // The id is opaque and this answer says nothing about the filesystem: a phone
  // asking after a project this Mac does not have learns only that.
  if (!project) { json(res, 404, { error: 'Wanigan has no project with that id.' }); return; }

  let tree: GitStatus;
  try {
    tree = await withTimeout(status(project.path), MOBILE_REPO_LIMITS.timeoutMs);
  } catch {
    json(res, 503, { error: UNREADABLE });
    return;
  }
  const name = safeString(project.name, 160, 'Unnamed project');
  if (!tree.isRepo) {
    sendRepoJson(res, {
      generatedAt: Date.now(), id: safeString(project.id, 160), name,
      state: 'not-a-repo', branch: null, detached: false, ahead: 0, behind: 0, operation: null,
      changed: 0, listed: 0, omitted: 0, counts: 'unavailable',
      countsNote: 'This project is a folder, not a git repository, so there is no working tree to review.',
      files: [], note: null,
    });
    return;
  }

  // `--no-ext-diff` because a repository's own config can name an external diff
  // program, and reading a working tree for a phone must not become the way a
  // checked-out repo gets one run. numstat has no use for it either way.
  const args = ['diff', 'HEAD', '--numstat', '--no-ext-diff', '-z'];
  const scoped = tree.subpath ? [...args, '--', tree.subpath] : args;
  const run = await runGit(tree.repoRoot, scoped, {
    timeout: MOBILE_REPO_LIMITS.timeoutMs,
    maxBuffer: MOBILE_REPO_LIMITS.diffBytes,
  });
  const counts: MobileRepoCounts = run.ok
    ? numstatCounts(run.out)
    // execFile reports an over-cap read by killing git and saying so in stderr.
    // The same refusal sentence is the honest answer either way, so it is asked
    // for by feeding the parser a body it will refuse rather than written twice.
    : /maxbuffer/i.test(run.err)
      ? numstatCounts('x'.repeat(MOBILE_REPO_LIMITS.diffBytes + 1))
      : {
        counted: false,
        // An unborn branch is the common one: there is no HEAD to compare
        // against, so git refuses, and the honest report is that nothing was
        // counted — not that every file changed by zero lines.
        reason: 'git did not count the lines for this reading, so no line counts are shown. That is ' +
          'usually a branch with no commits yet, which has nothing to compare against.',
      };

  const { files, dropped } = wireFiles(tree, counts);
  const listed = files.slice(0, MOBILE_REPO_LIMITS.files);
  const omitted = files.length - listed.length + dropped;
  const changed = files.length + dropped;
  sendRepoJson(res, {
    generatedAt: Date.now(),
    id: safeString(project.id, 160),
    name,
    state: tree.clean ? 'clean' : 'dirty',
    branch: tree.branch === null ? null : safeString(tree.branch, 200) || null,
    detached: tree.detached === true,
    ahead: count(tree.ahead),
    behind: count(tree.behind),
    operation: tree.operation === null ? null : safeString(tree.operation, 40) || null,
    changed,
    listed: listed.length,
    omitted,
    counts: counts.counted ? 'reported' : 'unavailable',
    countsNote: counts.counted ? null : counts.reason,
    files: listed,
    note: omitted > 0
      ? `${listed.length} of ${changed} changed files are listed. Wanigan caps one reading at ` +
        `${MOBILE_REPO_LIMITS.files} files so a single repository cannot fill the phone; open it ` +
        'on the Mac to see the rest.'
      : null,
  });
}

/* ── one file ────────────────────────────────────────────────────────── */

/**
 * One refusal for every 'you may not ask about that path'.
 *
 * A malformed path, a path outside the project, and a path git simply has not
 * reported as changed are three findings and one answer, deliberately: told
 * apart, they would make this route an oracle for whether a file exists on
 * someone's Mac, which is a question a changed-file list never asked.
 */
const NOT_A_CHANGED_FILE =
  'git does not report a change to that file in this project, so there is nothing here to show.';

/**
 * No count, no patch — and this is the sentence for it.
 *
 * The line count is also how a binary is recognised, so a read that failed to
 * count cannot be followed by a read of the bytes: Wanigan would not know
 * whether it was about to render a source file or a PNG as text.
 */
const UNCOUNTED_SO_UNREAD =
  'git did not count this file\'s lines, so Wanigan did not read its diff either. Without that count ' +
  'it cannot tell a binary file from a text one, and a binary rendered as text is worse than a file ' +
  'left unread. Open the project on the Mac to see the change.';

async function serveRepoFile(res: http.ServerResponse, url: URL): Promise<void> {
  const projectId = safeString(url.searchParams.get('project'), 160);
  if (!projectId) { json(res, 400, { error: 'Choose a project.' }); return; }
  const project = listProjects().find((value) => value.id === projectId);
  if (!project) { json(res, 404, { error: 'Wanigan has no project with that id.' }); return; }
  // The same guard the outbound paths cross, run before anything reaches a
  // filesystem: an absolute path, a leading `~` or any `..` segment is refused
  // rather than cleaned into something that resolves.
  const asked = safeRelative(url.searchParams.get('file'));
  if (!asked) { json(res, 404, { error: NOT_A_CHANGED_FILE }); return; }

  let tree: GitStatus;
  try {
    tree = await withTimeout(status(project.path), MOBILE_REPO_LIMITS.timeoutMs);
  } catch {
    json(res, 503, { error: UNREADABLE });
    return;
  }
  if (!tree.isRepo) { json(res, 404, { error: NOT_A_CHANGED_FILE }); return; }

  // The list is rebuilt here rather than trusted from the request, and the row
  // is looked up inside it. Membership in git's own reading is the real guard on
  // this route: a path git did not just report as changed is refused whatever it
  // looks like, which is what keeps an ignored `.env` sitting beside the changed
  // files out of reach even though it is a perfectly ordinary relative path.
  const { files, gitPaths } = wireFiles(tree, { counted: false, reason: '' });
  const row = files.find((file) => file.path === asked);
  const gitPath = gitPaths.get(asked);
  if (!row || !gitPath) { json(res, 404, { error: NOT_A_CHANGED_FILE }); return; }

  const answer = (added: number | null, removed: number | null, patch: MobileRepoPatch): void => {
    sendRepoJson(res, {
      generatedAt: Date.now(),
      id: safeString(project.id, 160),
      name: safeString(project.name, 160, 'Unnamed project'),
      path: row.path,
      status: row.status,
      where: row.where,
      added,
      removed,
      patch: patch.ok ? patch.patch : null,
      reason: patch.ok ? null : patch.reason,
    } satisfies MobileRepoFileDiff & { generatedAt: number; id: string; name: string });
  };

  // The one project shape this route declines. git writes a patch header from
  // the *repository* root — `--- a/packages/app/src/x.ts` — and this screen's
  // promise is that its paths are relative to the project. Rewriting git's own
  // diff text to re-root it would mean the promise was being kept by an edit to
  // the patch rather than by the patch, so the honest answer is that this shape
  // is readable on the Mac instead. store.ts refuses to create such a project;
  // only rows added before that rule can reach here.
  if (tree.subpath) {
    answer(null, null, {
      ok: false,
      reason: 'This project is a subdirectory of a larger repository, and git writes a diff header from ' +
        'that repository\'s root. Wanigan only sends paths relative to the project, so this file\'s ' +
        'diff is readable on the Mac rather than here.',
    });
    return;
  }
  // git collapses an entirely new directory into a single row with a trailing
  // slash, so the row an operator tapped can be a folder rather than a file.
  if (gitPath.endsWith('/')) {
    answer(null, null, {
      ok: false,
      reason: 'git reports this whole folder as new, so it lists the folder rather than each file in ' +
        'it. Open the project on the Mac to read what is inside.',
    });
    return;
  }

  // An untracked file has no counterpart in HEAD, so `diff HEAD` says nothing at
  // all about it — and on a screen watching agents work, the file that matters
  // is very often the one that was just created. `--no-index` against the null
  // device is git's own way of asking what adding it would look like, and it is
  // reached only for a path git itself listed as untracked, which is never a
  // file the repository ignores.
  const noIndex = row.where === 'untracked';
  // `--no-ext-diff` because a repository's own config can name an external diff
  // program, and reading a file for a phone must not become the way a checked-out
  // repo gets one run. `--no-textconv` closes the same door one step in: a
  // .gitattributes filter is a program too, and what belongs on this screen is
  // git's own bytes rather than whatever a repository configured to stand in for
  // them.
  const diffArgs = (extra: string[]): string[] => (noIndex
    ? ['diff', '--no-index', ...extra, '--no-ext-diff', '--no-textconv', '--', devNull, gitPath]
    : ['diff', 'HEAD', ...extra, '--no-ext-diff', '--no-textconv', '--', gitPath]);
  // `diff --no-index` exits 1 when the two files differ, which is the answer
  // rather than a failure; anywhere else a non-zero status is a failure.
  const answered = (run: { ok: boolean; code: number | null }): boolean => run.ok || (noIndex && run.code === 1);

  // Counted first, and the patch read only if that succeeded. The count carries
  // two facts this needs: the +/- pair the header shows, and whether git will
  // diff the file at all — a binary's counts are `-`, in every locale, whereas
  // spotting `Binary files … differ` in the patch would be spotting an English
  // sentence and calling it a fact.
  const measured = await runGit(tree.repoRoot, diffArgs(['--numstat', '-z']), {
    timeout: MOBILE_REPO_LIMITS.timeoutMs,
    maxBuffer: MOBILE_REPO_LIMITS.diffBytes,
  });
  if (!answered(measured)) { answer(null, null, { ok: false, reason: UNCOUNTED_SO_UNREAD }); return; }
  const counts = numstatCounts(measured.out);
  if (!counts.counted) { answer(null, null, { ok: false, reason: UNCOUNTED_SO_UNREAD }); return; }
  const entry = counts.byPath.get(gitPath);
  // git counted the change set and this path was not in it: it was changed back
  // between the list this device is showing and the tap that asked about it.
  if (!entry) { answer(null, null, patchFor({ answered: true, out: '', overRead: false })); return; }
  if (entry.added === null) {
    answer(entry.added, entry.removed, {
      ok: false,
      reason: 'This is a binary file. git does not diff one line by line, so there are no hunks to ' +
        'read — and Wanigan will not render its bytes as text to fill the space.',
    });
    return;
  }

  const run = await runGit(tree.repoRoot, diffArgs([]), {
    timeout: MOBILE_REPO_LIMITS.timeoutMs,
    maxBuffer: MOBILE_REPO_LIMITS.patchReadBytes,
  });
  answer(entry.added, entry.removed, patchFor({
    answered: answered(run),
    out: run.out,
    // execFile reports an over-cap read by killing git and saying so in stderr,
    // which leaves a fragment of a patch in stdout that must not be used.
    overRead: /maxbuffer/i.test(run.err),
  }));
}

registerApiRoute({ path: '/api/repos', method: 'GET', scope: 'repo', handler: (_req, res) => serveRepos(res) });
registerApiRoute({ path: '/api/repo', method: 'GET', scope: 'repo', handler: (_req, res, url) => serveRepo(res, url) });
// The third and last route on this scope, and the only one that carries source
// lines. It is registered beside the other two so `grep "scope: 'repo'"` still
// answers the whole question of what a paired phone can be shown of a repository.
registerApiRoute({ path: '/api/repo/file', method: 'GET', scope: 'repo', handler: (_req, res, url) => serveRepoFile(res, url) });
