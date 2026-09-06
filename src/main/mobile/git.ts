import type http from 'node:http';
import { createHash } from 'node:crypto';
import { devNull } from 'node:os';
import { commit as gitCommit, runGit, status, type GitFile, type GitStatus } from '../git';
import { history as gateHistory, recipe as gateRecipe, run as startGate } from '../review';
import { listProjects } from '../store';
import { mobileRepositoryReview } from '../settings';
import type { ReviewRun } from '../../shared/types';
import { mobileConfig } from './config';
import { json, registerApiRoute, registerRepoGate, requestJson, send } from './dispatch';
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
 *   - No contents arrive unasked. A repository reading is status letters and
 *     line counts. Source lines travel for one file at a time, as git's own
 *     patch, and only because the operator tapped that file — a review that
 *     hides what changed is not a review, and an operator deciding about an
 *     agent's work from a phone is deciding about the hunks. The widening stops
 *     there: the path asked for has to be one git itself has just reported as
 *     changed, matched against that reading rather than resolved against the
 *     filesystem, so this route cannot be pointed at a file the screen never
 *     offered — an ignored `.env` among them.
 *   - Two routes write, and the list is deliberately that short: a phone may
 *     run the project's own review gate, and commit what git already tracks.
 *     Neither invents a definition of its own. The gate is ../review's — the
 *     commands the project saved, the runner the desktop drives, the rows the
 *     desktop reads — and the commit is ../git's `commit` with `all`, which is
 *     `git commit -a`. There is no `add`, no `-A` and no `push` here, and no way
 *     to reach one: an untracked file the operator has never seen is exactly
 *     what must not be swept into a commit by someone tapping a button on a
 *     train, and a push is the one act on this screen that would leave the
 *     machine. Committing is reversible on the Mac; publishing is not.
 *   - A commit is refused unless the working tree still matches the reading the
 *     device was shown. The digest is computed here, from the same rows that
 *     response carried, so the screen and the Mac cannot drift apart about what
 *     was on offer; the last few readings are kept in memory so the refusal can
 *     name what moved rather than only saying 'stale'. A reading that hit a cap
 *     cannot be committed from at all — the screen did not show the whole of
 *     what the commit would carry, and that is the condition CLAUDE.md puts on
 *     a destructive git action being deliberate.
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
  /**
   * A commit message, as accepted. Room for a subject and a real body, and no
   * room for a phone to write a megabyte into a history nobody can rewrite.
   */
  messageBytes: 4 * 1024,
  /**
   * How many working-tree readings are remembered so a refused commit can say
   * what moved. Small on purpose: this is a memory of what was on a screen a
   * moment ago, not a second record of the repository.
   */
  readings: 24,
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

/* ── the reading a commit is made against ────────────────────────────── */

/**
 * One row of a working-tree reading, as the staleness check sees it.
 *
 * Three fields, and they are the three the screen showed: where git reported
 * the change, git's own two porcelain letters, and the path. Line counts are
 * deliberately not among them — a file whose diff grew by a line is the same
 * file in the same state, and a reading that moved on every keystroke would
 * refuse every commit anyone tried to make while an agent was still typing.
 */
export type MobileRepoRow = { path: string; status: string; where: MobileRepoFile['where'] };

/** One whole working tree, as one screen was shown it. */
export type MobileRepoReading = {
  branch: string | null;
  detached: boolean;
  operation: string | null;
  /** Every distinct changed path, including any the list cap kept off screen. */
  rows: MobileRepoRow[];
  /** Rows git reported that could not be re-rooted onto the project. */
  dropped: number;
};

function readingOf(tree: GitStatus, rows: readonly MobileRepoFile[], dropped: number): MobileRepoReading {
  return {
    branch: tree.branch === null ? null : safeString(tree.branch, 200) || null,
    detached: tree.detached === true,
    operation: tree.operation === null ? null : safeString(tree.operation, 40) || null,
    rows: rows.map((file) => ({ path: file.path, status: file.status, where: file.where })),
    dropped,
  };
}

/**
 * A plain comparison rather than localeCompare: two reads of one unchanged tree
 * have to produce the same string, and a locale-aware collation is a property
 * of the process rather than of the repository.
 */
function sortedRows(reading: MobileRepoReading): MobileRepoRow[] {
  return [...reading.rows].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The reading, as one short string a device can hand back with a commit.
 *
 * Computed in this process from the rows a response carries, never in the page.
 * A digest the phone assembled would be the phone's opinion of what it was
 * shown, which is exactly the thing under test — the two must not be able to
 * disagree. It is an integrity check on a screen rather than a credential: a
 * device already holding the bearer token could read this tree and compute it,
 * so it is short enough to travel and long enough that two different trees do
 * not collide.
 */
export function repoDigest(reading: MobileRepoReading): string {
  const text = [
    'branch:' + (reading.branch ?? ''),
    'detached:' + (reading.detached ? '1' : '0'),
    'operation:' + (reading.operation ?? ''),
    'dropped:' + reading.dropped,
    ...sortedRows(reading).map((row) => row.where + '\t' + row.status + '\t' + row.path),
  ].join('\n');
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

function nameList(paths: readonly string[], limit: number): string {
  if (paths.length <= limit) return paths.join(', ');
  return paths.slice(0, limit).join(', ') + ' and ' + (paths.length - limit) + ' more';
}

function fileWord(n: number): string {
  return n + (n === 1 ? ' file' : ' files');
}

/**
 * What moved between the reading a device was shown and the tree as it is now.
 *
 * 'This reading is stale' on its own is the refusal that teaches nobody
 * anything: the operator is told to look again with no idea what they are
 * looking for, and the second attempt is the same tap made blind. So the
 * readings this module served are kept for a little while and diffed against
 * the tree, and the sentence names the paths — which this scope is allowed to
 * do, and which is why the diffing is worth doing here rather than on the phone.
 */
export function driftSentence(before: MobileRepoReading, after: MobileRepoReading, limit = 4): string {
  const was = new Map(before.rows.map((row) => [row.path, row]));
  const now = new Map(after.rows.map((row) => [row.path, row]));
  const appeared: string[] = [];
  const differs: string[] = [];
  for (const row of sortedRows(after)) {
    const old = was.get(row.path);
    if (!old) appeared.push(row.path);
    else if (old.status !== row.status || old.where !== row.where) differs.push(row.path);
  }
  const gone = sortedRows(before).filter((row) => !now.has(row.path)).map((row) => row.path);
  const clauses: string[] = [];
  if (before.branch !== after.branch || before.detached !== after.detached) {
    clauses.push('the branch is now ' + (after.detached ? 'a detached HEAD'
      : after.branch ? '"' + after.branch + '"' : 'no branch'));
  }
  if (before.operation !== after.operation) {
    clauses.push(after.operation
      ? 'a ' + after.operation + ' is in progress that was not'
      : 'the operation that was in progress has finished');
  }
  if (appeared.length) {
    clauses.push(fileWord(appeared.length) + ' changed that had not (' + nameList(appeared, limit) + ')');
  }
  if (gone.length) {
    clauses.push(fileWord(gone.length) + ' no longer changed (' + nameList(gone, limit) + ')');
  }
  if (differs.length) {
    clauses.push(fileWord(differs.length) + ' with a different status (' + nameList(differs, limit) + ')');
  }
  if (before.dropped !== after.dropped) clauses.push('a different number of rows Wanigan could not show');
  // Two digests that differ with nothing to name is a bug in this function
  // rather than a tree that stood still, and saying so is better than printing
  // a sentence with a hole in the middle of it.
  if (!clauses.length) clauses.push('Wanigan could not name what moved, which is itself worth reporting');
  return 'The working tree has changed since this device read it: ' + clauses.join('; ') +
    '. Nothing was committed. Read this repository again and check what it shows before committing.';
}

/* ── the commit ──────────────────────────────────────────────────────── */

export type MobileCommitMessage = { ok: true; message: string } | { ok: false; error: string };

/**
 * The one thing on this route that legitimately comes from the phone.
 *
 * Newlines and tabs survive, unlike ./snapshot's safeString: a commit message
 * has a subject and a body, and collapsing it the way a title is collapsed
 * would file the operator's paragraphs as one line for ever. The rest of the
 * C0 range goes, because it cannot be typed deliberately and can only make
 * `git log` unreadable. What is bounded here is the record rather than an
 * injection — the message reaches git as an argv entry through ../git, and no
 * shell ever sees it.
 */
export function commitMessage(raw: unknown, limitBytes = MOBILE_REPO_LIMITS.messageBytes): MobileCommitMessage {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'A commit needs a message, and this device did not send one.' };
  }
  const message = raw
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  if (!message) {
    return {
      ok: false,
      error: 'A commit needs a message. An empty one records a change with nothing saying what it was for.',
    };
  }
  const bytes = Buffer.byteLength(message);
  if (bytes > limitBytes) {
    return {
      ok: false,
      error: `That message is ${bytes} bytes and Wanigan accepts at most ${limitBytes} from a phone, ` +
        'so nothing was committed. Write the long version on the Mac.',
    };
  }
  return { ok: true, message };
}

/** What a commit from one reading would carry, and what it would leave behind. */
export type MobileRepoCommitOffer = {
  /** Rows git already tracks: exactly what `git commit -a` would record. */
  tracked: number;
  /** Rows git does not track. Never committed from here, and counted so the screen can say so. */
  untracked: number;
  /** Rows with conflicts, which stop a commit outright. */
  conflicted: number;
  /** Why this reading may not be committed from, or null when it may. */
  blocked: string | null;
};

/**
 * Why this working tree may not be committed from a phone, or null.
 *
 * One function called twice: once to decide what the screen offers, and once,
 * against the tree as it is at the moment of the tap, to decide what actually
 * happens. A second copy of these rules is how a button and a route come to
 * disagree, and the disagreement anybody would notice is the one where the
 * button was right and the route was not.
 */
export function whyNotCommittable(reading: MobileRepoReading): string | null {
  const omitted = reading.dropped + Math.max(0, reading.rows.length - MOBILE_REPO_LIMITS.files);
  if (omitted > 0) {
    return `This reading left ${fileWord(omitted)} out, so the screen did not show the whole of what a ` +
      'commit would record. Wanigan will not commit a change set from a phone that the phone was not ' +
      'shown in full. Commit this one on the Mac.';
  }
  if (reading.operation) {
    return `A ${reading.operation} is in progress in this repository. Finishing one decides how two ` +
      'histories join, which is a different act from recording a change, so Wanigan will not do it from ' +
      'a phone. Finish it on the Mac.';
  }
  const conflicted = reading.rows.filter((row) => row.where === 'conflicted').length;
  if (conflicted > 0) {
    return `git reports ${fileWord(conflicted)} with conflicts in this repository. Committing now would ` +
      'record the conflict markers as the resolution. Resolve them on the Mac.';
  }
  const tracked = reading.rows.filter((row) => row.where !== 'untracked').length;
  if (tracked === 0 && reading.rows.length > 0) {
    return 'The only changes here are files git is not tracking. This device never adds a file to a ' +
      'commit, so there is nothing here for it to record. Add them on the Mac if they belong in the ' +
      'history.';
  }
  if (tracked === 0) {
    return 'git reports no tracked changes in this repository, so there is nothing to commit.';
  }
  return null;
}

export function commitOffer(reading: MobileRepoReading): MobileRepoCommitOffer {
  const tracked = reading.rows.filter((row) => row.where !== 'untracked').length;
  return {
    tracked,
    untracked: reading.rows.length - tracked,
    conflicted: reading.rows.filter((row) => row.where === 'conflicted').length,
    blocked: whyNotCommittable(reading),
  };
}

/* ── the project's own review gate ───────────────────────────────────── */

export type MobileGateStatus = 'running' | 'passed' | 'failed' | 'unknown';

/**
 * The step that failed, as much of it as may leave this Mac.
 *
 * A review command is written by the operator and can name an absolute path —
 * `/Users/someone/bin/check` — and a home directory is a username. So the
 * position always travels and the text only when it carries no absolute path,
 * no `~` and no drive letter. The test is deliberately over-eager: it withholds
 * `npm test 2>/dev/null` as well, and a step named 'the 3rd of 5 commands' is a
 * far smaller loss than a username.
 *
 * The command's *output* never travels at all, under any test. A failing build
 * prints stack traces, environment values and absolute paths by the screenful,
 * and there is no rule that could sort the harmless ones from the rest.
 */
export type MobileGateStep = {
  /** 1-based, so the sentence can say 'the 3rd of 5'. */
  position: number;
  total: number;
  command: string | null;
  /** Why the command text is not here, when it is not. */
  withheld: string | null;
  exitCode: number | null;
};

/** A `/` starting a path segment, a `~`, or a drive letter: all of them absolute. */
const ABSOLUTE_IN_COMMAND = /(^|[^A-Za-z0-9_.\-])\/|~|(^|\s)[A-Za-z]:[\\/]/;

export function gateStep(
  results: readonly { command: string; exitCode: number | null }[],
  commands: number,
): MobileGateStep | null {
  const index = results.findIndex((result) => result.exitCode !== 0);
  if (index < 0) return null;
  const failed = results[index];
  // safeString, not wirePath: a command is a sentence rather than a filename,
  // and collapsing its runs of whitespace is right for one and wrong for the
  // other. What is tested is exactly what is sent, so a truncation cannot
  // smuggle half a path past the check below.
  const command = safeString(failed.command, 240);
  const sendable = command.length > 0 && !ABSOLUTE_IN_COMMAND.test(command);
  return {
    position: index + 1,
    total: Math.max(commands, results.length),
    command: sendable ? command : null,
    withheld: sendable ? null
      : 'That command names a path on this Mac, so Wanigan did not send its text. Open the gate on the ' +
        'Mac to read it.',
    exitCode: typeof failed.exitCode === 'number' ? failed.exitCode : null,
  };
}

export type MobileGateRun = {
  id: string;
  status: MobileGateStatus;
  /** Whether Wanigan still has commands running for this gate. */
  live: boolean;
  startedAt: number;
  endedAt: number | null;
  /** Commands the recipe holds now, and how many this run has reported on. */
  commands: number;
  reported: number;
  /** The first command that did not exit 0, or null when none has. */
  failed: MobileGateStep | null;
  /**
   * The working-tree digest this run was started against, or null when Wanigan
   * did not record one — a gate started on the Mac, or one that outlived the
   * process that started it. Null means 'not known', never 'the same tree'.
   */
  ranAgainst: string | null;
  /**
   * Set only when this process's own run of this gate ended in an error while
   * the record still says it is running.
   */
  stalled: string | null;
};

export type MobileRepoGate = {
  /** Did Wanigan's record of this project's gate open at all. */
  readable: boolean;
  /** Commands saved for this project. Zero means the project has no gate. */
  commands: number;
  latest: MobileGateRun | null;
  /** Wanigan's own sentence when the record would not open. Never the database's. */
  reason: string | null;
};

/**
 * The stored statuses, mapped onto what the phone may claim.
 *
 * A Map rather than an object literal for ./manage-runs' reason: a status read
 * out of a row is a string, and `toString` or `constructor` resolving to
 * something inherited from Object.prototype would be a lookup hit that never
 * came from this table. 'unknown' is what a status this build has never been
 * taught to read becomes, and it must never be smoothed into 'passed'.
 */
const GATE_STATUSES = new Map<string, MobileGateStatus>([
  ['running', 'running'], ['passed', 'passed'], ['failed', 'failed'],
]);

/** Insertion-ordered, bounded, oldest out: three small memories, one rule. */
function remember<V>(store: Map<string, V>, key: string, value: V, limit: number): void {
  store.delete(key);
  store.set(key, value);
  while (store.size > limit) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

/** Readings this module served, so a refused commit can name what moved. */
const servedReadings = new Map<string, MobileRepoReading>();
/** The tree each gate run this process started was launched against. */
const gateReadings = new Map<string, string>();
/** Runs this process started whose work errored while the row still says running. */
const gateStalls = new Map<string, string>();

function wireGateRun(run: ReviewRun, commands: number): MobileGateRun {
  const status = GATE_STATUSES.get(String(run.status)) ?? 'unknown';
  const results = Array.isArray(run.results) ? run.results : [];
  const total = Math.max(commands, results.length);
  return {
    id: safeString(run.id, 120),
    status,
    live: status === 'running',
    startedAt: count(run.startedAt),
    endedAt: run.endedAt === null ? null : count(run.endedAt) || null,
    commands: total,
    reported: results.length,
    failed: gateStep(results, total),
    ranAgainst: gateReadings.get(run.id) ?? null,
    stalled: gateStalls.get(run.id) ?? null,
  };
}

/**
 * A gate record that will not open is not a gate that has never run, and the
 * two must not render the same. The sentence is this module's own: a database
 * error can carry a local path or a table name.
 */
const GATE_UNREADABLE =
  'The Mac answered, but its record of this project\'s review gate would not open. Nothing was run.';

function readGate(projectId: string): MobileRepoGate {
  try {
    const commands = gateRecipe(projectId).commands.length;
    const latest = gateHistory(projectId, 1)[0];
    return { readable: true, commands, latest: latest ? wireGateRun(latest, commands) : null, reason: null };
  } catch {
    return { readable: false, commands: 0, latest: null, reason: GATE_UNREADABLE };
  }
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
      // The same three fields the branch below carries, so the screen reads one
      // shape rather than testing whether each exists. A folder has no reading
      // to commit from and no gate to have run, and null says exactly that.
      digest: null, commit: null, gate: null,
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
  // The digest the commit route will demand back, taken from the rows this very
  // response carries rather than from a second read of the tree. That is the
  // whole point of computing it here: a device is refused because the tree
  // moved, never because two reads of one tree disagreed with each other.
  const reading = readingOf(tree, files, dropped);
  const digest = repoDigest(reading);
  remember(servedReadings, project.id + ':' + digest, reading, MOBILE_REPO_LIMITS.readings);
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
    digest,
    commit: commitOffer(reading),
    // The gate rides on the reading rather than on a route of its own. A gate
    // run takes minutes and its outcome is a fact about this working tree, so
    // the screen learns it from the same watched read it is already making
    // instead of holding a second cadence for a second endpoint.
    gate: readGate(project.id),
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


/* ── running the project's gate ──────────────────────────────────────── */

/**
 * Run the project's own review gate, and answer with a handle rather than a
 * result.
 *
 * A gate is `npm test`: minutes of real work. So the response cannot be the
 * outcome. An HTTP request held open for ten minutes over a cellular radio is a
 * request that dies somewhere in the middle and takes the operator's only
 * evidence with it, and a phone that has to stay awake and foregrounded for the
 * whole of a build is not a phone anybody can walk with. The run is started,
 * the record is read back, and the screen watches for the outcome through the
 * /api/repo reading it was already watching. That is the shape ./manage-runs
 * uses to report a fan-out that is still going, and this is the same problem.
 *
 * The gate itself is ../review's, unchanged: the commands the project saved,
 * the runner the desktop drives, the rows the desktop reads. A second
 * definition of 'the gate' living in this module would be the one nobody
 * audits, and the one that ran from a pocket would be it.
 */
async function serveGate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await requestJson(req, 2_048);
  const projectId = safeString(body?.project, 160);
  if (!projectId) { json(res, 400, { error: 'Choose a project.' }); return; }
  const project = listProjects().find((value) => value.id === projectId);
  if (!project) { json(res, 404, { error: 'Wanigan has no project with that id.' }); return; }

  const before = readGate(projectId);
  if (!before.readable) { json(res, 503, { error: before.reason ?? GATE_UNREADABLE }); return; }
  // A gate that could not run is not a gate that passed, so a project with no
  // commands saved is a refusal carrying the reason rather than a green tick.
  if (before.commands === 0) {
    json(res, 409, {
      error: 'This project has no review gate. Wanigan runs the commands saved for the project on the ' +
        'Mac, and this project has none saved, so there is nothing here to run.',
    });
    return;
  }
  // A second tap while one is running gets the running one. Starting a second
  // `npm test` in the same checkout is not a second opinion, it is two builds
  // fighting over one node_modules — and the record would then hold two rows
  // for one question with no way to say which answered it.
  if (before.latest && before.latest.live) {
    json(res, 200, { ok: true, started: false, gate: before });
    return;
  }

  // Which working tree this run is about to see, written down before it starts.
  // A gate that passed against a different tree is not evidence about this one,
  // and the screen can only say so if something recorded which tree it was.
  let ranAgainst: string | null = null;
  try {
    const tree = await withTimeout(status(project.path), MOBILE_REPO_LIMITS.timeoutMs);
    if (tree.isRepo) {
      const { files, dropped } = wireFiles(tree, { counted: false, reason: '' });
      ranAgainst = repoDigest(readingOf(tree, files, dropped));
    }
  } catch {
    // The gate does not depend on this read, so a tree Wanigan could not read
    // leaves this null — which the screen renders as 'Wanigan did not record
    // which tree this saw', never as a match.
  }

  const pending = startGate(projectId);
  // ../review inserts the run row before it awaits its first command, so the
  // record already names this run by the time control comes back here. Reading
  // it rather than describing what was asked for is the same rule ./manage-runs
  // keeps: what comes back is the Mac's record, not this handler's intention.
  const after = readGate(projectId);
  const started = after.latest && after.latest.live ? after.latest : null;
  if (!started) {
    pending.catch(() => { /* nothing was started; there is no record to correct */ });
    json(res, 503, {
      error: 'Wanigan could not start the review gate for this project. Nothing is running. Open the ' +
        'project on the Mac to see what happened.',
    });
    return;
  }
  if (ranAgainst) remember(gateReadings, started.id, ranAgainst, MOBILE_REPO_LIMITS.readings);
  pending.catch(() => {
    // ../review closes its own row on every path it controls, so arriving here
    // means the record may still say 'running' for a gate that is not. This
    // module does not write that row — one owner per table — so it remembers
    // the fact and the screen says it, until ../review's own sweep closes the
    // row at the next start. A gate silently stuck on 'running' would read as
    // work still in progress, which is the one thing it is not.
    remember(gateStalls, started.id,
      'Wanigan\'s run of this gate ended in an error and the record still says it is running. It is ' +
      'not running. The record is closed the next time Wanigan starts; run the gate on the Mac to get ' +
      'an answer now.', 8);
  });
  json(res, 200, { ok: true, started: true, gate: readGate(projectId) });
}

/* ── committing what is already tracked ──────────────────────────────── */

/**
 * git's own refusal text is never forwarded, for this module's standing reason:
 * `fatal: … /Users/…` is an ordinary git message and it carries the one thing
 * this wire must not. A hook that rejected the commit, an unset user.email, an
 * index lock — all of them are readable on the Mac, in git's words, in full.
 */
const COMMIT_REFUSED =
  'git refused this commit, so nothing was committed. Wanigan does not forward git\'s own words to a ' +
  'phone because they routinely carry absolute paths; open the project on the Mac to read what it said.';

/**
 * The reading this device is holding is one Wanigan has forgotten, so the
 * refusal cannot name what moved — only that the tree does not match it.
 */
const READING_FORGOTTEN =
  'The working tree no longer matches the reading this device is showing, and Wanigan keeps only the ' +
  'last few readings it served, so it cannot say what moved. Nothing was committed. Read this ' +
  'repository again and commit from what it shows.';

/**
 * Commit the tracked changes the device was shown, or refuse and say why.
 *
 * Three refusals matter more than the commit itself.
 *
 * Untracked files are never included, and that is `git commit -a` rather than a
 * filter written here: ../git's `commit` with `all` stages what git already
 * tracks and nothing else. A phone must not be able to sweep a file the
 * operator has never seen into a commit — a stray key, a scratch dump, an
 * agent's leftover — and the way to be sure of that is to have no code path
 * that could.
 *
 * A stale reading is refused rather than committed through. The device sends
 * back the digest of the tree it was shown; this recomputes it from git and
 * refuses on any difference, then names the difference from the reading it kept.
 * CLAUDE.md asks for deliberate user action before a destructive git operation,
 * and a tap is only deliberate about what the screen showed — if the tree has
 * moved, the tap was about something else.
 *
 * Nothing is pushed. Committing is reversible on the Mac; publishing is the one
 * act on this screen that would leave the machine, so there is no route for it
 * here and the answer says so in a field rather than in a release note.
 */
async function serveCommit(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: Record<string, unknown> | null;
  try {
    body = await requestJson(req, MOBILE_REPO_LIMITS.messageBytes + 4_096);
  } catch {
    json(res, 413, {
      error: 'That request was larger than Wanigan accepts from a phone, so nothing was committed.',
    });
    return;
  }
  const projectId = safeString(body?.project, 160);
  if (!projectId) { json(res, 400, { error: 'Choose a project.' }); return; }
  const project = listProjects().find((value) => value.id === projectId);
  if (!project) { json(res, 404, { error: 'Wanigan has no project with that id.' }); return; }
  const asked = safeString(body?.digest, 128);
  if (!asked) {
    json(res, 400, {
      error: 'This device did not say which reading of the working tree it was shown, so Wanigan ' +
        'refused rather than commit a change set nobody has looked at. Read this repository again.',
    });
    return;
  }
  const message = commitMessage(body?.message);
  if (!message.ok) { json(res, 400, { error: message.error }); return; }

  let tree: GitStatus;
  try {
    tree = await withTimeout(status(project.path), MOBILE_REPO_LIMITS.timeoutMs);
  } catch {
    json(res, 503, { error: UNREADABLE });
    return;
  }
  if (!tree.isRepo) {
    json(res, 409, {
      error: 'This project is a folder, not a git repository, so there is nothing here to commit.',
    });
    return;
  }
  // ../git refuses this too, and refuses it well — but its sentence names the
  // repository root, which is an absolute path. So the refusal that travels is
  // this one, and the guard stands here rather than being left to the error.
  if (tree.subpath) {
    json(res, 409, {
      error: 'This project is a subdirectory of a larger repository, and git commits a whole repository ' +
        'however the button was labelled. A commit here would record directories this screen never ' +
        'showed you, so it is refused. Commit it on the Mac.',
    });
    return;
  }

  // Rebuilt from git rather than trusted from the request, exactly as the diff
  // route rebuilds the file list: what the device sent is one short string, and
  // everything it is checked against comes from this process.
  const { files, dropped } = wireFiles(tree, { counted: false, reason: '' });
  const reading = readingOf(tree, files, dropped);
  const digest = repoDigest(reading);
  if (digest !== asked) {
    const shown = servedReadings.get(projectId + ':' + asked);
    // 409 rather than 400: the request is well formed and the id is real, and
    // what is wrong is that the Mac moved underneath it. The page tells the two
    // apart so it can re-read instead of printing 'bad request'.
    json(res, 409, { stale: true, error: shown ? driftSentence(shown, reading) : READING_FORGOTTEN });
    return;
  }
  const offer = commitOffer(reading);
  if (offer.blocked) { json(res, 409, { error: offer.blocked }); return; }

  try {
    // `all`, which is `git commit -a`: every tracked file git reports as
    // changed, and no file it does not track. Never `add`, and never `-A`.
    await gitCommit(project.path, message.message, { all: true });
  } catch {
    json(res, 409, { error: COMMIT_REFUSED });
    return;
  }

  // What comes back is the repository re-read. `git commit`'s own stdout is not
  // forwarded: its shape is git's to change, and it prints 'create mode' lines
  // this module would then be re-deriving paths from.
  let commitId: string | null = null;
  const named = await runGit(tree.repoRoot, ['rev-parse', '--short', 'HEAD'], {
    timeout: MOBILE_REPO_LIMITS.timeoutMs,
  });
  if (named.ok && /^[0-9a-f]{4,40}$/.test(named.out.trim())) commitId = named.out.trim();

  let after: MobileRepoReading | null = null;
  try {
    const now = await withTimeout(status(project.path), MOBILE_REPO_LIMITS.timeoutMs);
    if (now.isRepo) {
      const rebuilt = wireFiles(now, { counted: false, reason: '' });
      after = readingOf(now, rebuilt.files, rebuilt.dropped);
    }
  } catch {
    // The commit happened. A read that fails after it is not a reason to report
    // a failure, and the fields below go null rather than repeating the reading
    // from before the commit as though it were the one after.
    after = null;
  }
  if (after) {
    remember(servedReadings, projectId + ':' + repoDigest(after), after, MOBILE_REPO_LIMITS.readings);
  }
  sendRepoJson(res, {
    ok: true,
    generatedAt: Date.now(),
    id: safeString(project.id, 160),
    name: safeString(project.name, 160, 'Unnamed project'),
    // The tracked rows this reading held, which is what `git commit -a` carries
    // — not 'everything that was changed', which would include the untracked
    // files beside them.
    committed: offer.tracked,
    left: offer.untracked,
    commit: commitId,
    branch: after ? after.branch : reading.branch,
    remaining: after ? after.rows.length : null,
    digest: after ? repoDigest(after) : null,
    // Stated in the answer as well as on the screen. The next question a device
    // that has just committed asks is whether anyone else can see it, and the
    // answer is no until someone pushes from the Mac.
    pushed: false,
  });
}

registerApiRoute({ path: '/api/repos', method: 'GET', scope: 'repo', handler: (_req, res) => serveRepos(res) });
registerApiRoute({ path: '/api/repo', method: 'GET', scope: 'repo', handler: (_req, res, url) => serveRepo(res, url) });
// The third read on this scope, and the only one that carries source lines. It
// is registered beside the other two so `grep "scope: 'repo'"` still answers the
// whole question of what a paired phone can be shown of a repository.
registerApiRoute({ path: '/api/repo/file', method: 'GET', scope: 'repo', handler: (_req, res, url) => serveRepoFile(res, url) });
// The two routes that write, on the same scope and in the same table as the
// three that read, so that one grep still answers the whole question — which is
// now 'what may a paired phone be shown of a repository, and what may it do to
// one'. POST, so both draw on the dispatcher's twenty-writes-a-minute window
// alongside launching an agent; neither is reachable while the repository-review
// opt-in is off, because the route table refuses them before a handler runs.
registerApiRoute({ path: '/api/repo/gate', method: 'POST', scope: 'repo', handler: (req, res) => serveGate(req, res) });
registerApiRoute({ path: '/api/repo/commit', method: 'POST', scope: 'repo', handler: (req, res) => serveCommit(req, res) });
