import type http from 'node:http';
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
 *   - No file contents. The phone is told git's own status letters and how many
 *     lines each file differs from HEAD. It is never sent a hunk, a line of
 *     source, or the text of an untracked file. That is a second promise, and
 *     this module is the only thing keeping it, so it is spelled out here: there
 *     is no patch route, on purpose.
 *
 * Everything is bounded, and every bound is *said* rather than applied quietly.
 * A capped list reports how many rows it did not send; a change set too large to
 * count refuses its line counts as a whole rather than shipping half of them as
 * if they were the total; a response that will not fit the JSON cap is refused
 * rather than trimmed until it does. A truncated answer that looks whole is
 * worse than no answer, because nothing on the screen says which one it is.
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
 * git's repository-relative path, re-rooted onto the project, or refused.
 *
 * Wanigan projects are whole repositories today — store.ts refuses to add a
 * subdirectory — but rows added before that rule exist, and for those git still
 * reports paths from the *repository* root while this screen is titled after the
 * project. Re-rooting is what keeps the label and the paths talking about the
 * same directory.
 *
 * The absolute, `~` and `..` refusals below are not reachable from git's own
 * porcelain output. They are here because this is the single function standing
 * between a filesystem and a phone, and the cost of it being wrong once is a
 * home directory — which is a username — leaving the machine.
 */
function projectRelative(raw: unknown, subpath: string | null): string | null {
  const value = wirePath(raw);
  if (!value) return null;
  if (value.startsWith('/') || value.startsWith('~') || /^[A-Za-z]:[\\/]/.test(value)) return null;
  if (value.split('/').some((part) => part === '..')) return null;
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
 */
function wireFiles(tree: GitStatus, counts: MobileRepoCounts): { files: MobileRepoFile[]; dropped: number } {
  const rows = new Map<string, MobileRepoFile>();
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
  return { files: [...rows.values()], dropped };
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

registerApiRoute({ path: '/api/repos', method: 'GET', scope: 'repo', handler: (_req, res) => serveRepos(res) });
registerApiRoute({ path: '/api/repo', method: 'GET', scope: 'repo', handler: (_req, res, url) => serveRepo(res, url) });
