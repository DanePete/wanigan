/**
 * Merge readiness, the part that needs no process: reading what gh printed
 * about a branch's pull request, and deciding what each answer amounts to.
 * src/main/pr-readiness.ts runs gh and hands its output here.
 *
 * What it is for. A branch with an open pull request can stop being ready to
 * land in three ways nobody is told about. GitHub sends no webhook when the base
 * moves and creates a conflict, so mergeability has to be read. A check fails on
 * a push an agent made and walked away from. A reviewer leaves an inline comment,
 * which `gh pr view --comments` does not show — inline threads come only from
 * the review-thread API. Each is read here when the operator asks, and each keeps
 * "could not read" apart from "none", because a check list that failed to load
 * and a pull request with no checks look identical as an empty array.
 *
 * Everything in these answers is text other people wrote — reviewers, workflow
 * authors, CI output — so every string that leaves this module has had escape
 * sequences and control characters removed, has been passed through the
 * caller's credential redactor, and has been cut to a stated bound. The
 * redactor is injected rather than imported because the one Wanigan trusts is
 * src/main/redact.ts; a copy here would be a fifth version of that filter, and
 * four drifting versions is the failure that file was written to end.
 *
 * Every fixture in pr-readiness.test.ts is the byte shape gh 2.94.0 printed
 * against a real public pull request, captured before this was written.
 */

export type Redact = (text: string) => string;

/** GitHub's own words for whether the head merges into the base. */
export type Mergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
/** GraphQL MergeStateStatus: what, beyond conflicts, stands between the pull request and a merge. */
export type MergeStateStatus = 'BEHIND' | 'BLOCKED' | 'CLEAN' | 'DIRTY' | 'DRAFT' | 'HAS_HOOKS' | 'UNKNOWN' | 'UNSTABLE';
/** gh pr checks' `bucket`, which it derives from each check's state. */
export type CheckBucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';

export type ReadinessPr = {
  number: number;
  /** Validated https, or null when gh's answer did not validate. */
  url: string | null;
  title: string;
  isDraft: boolean;
  state: 'open' | 'merged' | 'closed';
  baseRef: string;
  headRef: string;
  /** The commit GitHub ran the checks on; null when gh did not name a full object id. */
  headSha: string | null;
};

/** A GitHub Actions run, and the job inside it when the link names one. */
export type ActionsJob = {
  /** HOST/OWNER/REPO, the form `gh --repo` takes. */
  repo: string;
  runId: string;
  jobId: string | null;
};

export type PrCheck = {
  name: string;
  /** Null for a check no workflow produced — a GitHub App's check run, or a commit status. */
  workflow: string | null;
  bucket: CheckBucket;
  /** GitHub's own state word, such as FAILURE or TIMED_OUT, kept beside the bucket it was sorted into. */
  state: string;
  link: string | null;
  startedAt: number | null;
  completedAt: number | null;
  description: string | null;
  /**
   * Set only when the link is a GitHub Actions run: the one kind of check gh can
   * fetch a failed log for. A GitHub App's check run links to `/runs/<id>`, whose
   * number is a check-run id and not a workflow run — passing it to `gh run view`
   * asks about some other run, or none.
   */
  actions: ActionsJob | null;
};

export type ChecksRead =
  | { read: 'ok'; items: PrCheck[]; omitted: number }
  /** The pull request's head reports no checks at all. An answer, not a failure. */
  | { read: 'none' }
  | { read: 'failed'; detail: string };

export type PrThreadComment = {
  /** Null for an account GitHub no longer has. */
  author: string | null;
  body: string;
  /** Characters of the body left out by the bound. */
  bodyCut: number;
  createdAt: number | null;
  url: string | null;
};

export type PrThread = {
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  /** Where the thread sits in the current diff; null once the lines it was left on are gone. */
  line: number | null;
  startLine: number | null;
  /** Where it was left, in the diff it was left on. */
  originalLine: number | null;
  originalStartLine: number | null;
  /** RIGHT is the new side of the diff, LEFT the old. */
  side: 'LEFT' | 'RIGHT' | null;
  /** A comment on the whole file carries no line at all. */
  subject: 'line' | 'file';
  comments: PrThreadComment[];
  /** Comments in the thread beyond the ones read. */
  commentsOmitted: number;
};

export type ThreadsRead =
  | { read: 'ok'; items: PrThread[]; total: number; capped: boolean }
  | { read: 'failed'; detail: string };

export type PrReadiness = {
  pr: ReadinessPr;
  /** The commit the branch points at on this machine; null when git could not say. */
  localHead: string | null;
  mergeable: Mergeable | null;
  mergeStateStatus: MergeStateStatus | null;
  checks: ChecksRead;
  threads: ThreadsRead;
};

/**
 * Every arm is an honest state the Git view renders as itself. "gh is not
 * installed", "not signed in" and "this is not a GitHub repository" are answers
 * about the machine, not failures to hide behind an empty panel.
 */
export type PrReadinessStatus =
  | { kind: 'missing' }
  | { kind: 'unauthenticated'; detail: string }
  | { kind: 'not-github'; detail: string }
  | { kind: 'no-branch'; detail: string }
  | { kind: 'no-pr'; branch: string }
  | { kind: 'error'; detail: string }
  | { kind: 'ok'; branch: string; readiness: PrReadiness };

export type PrReadinessReport = {
  status: PrReadinessStatus;
  fetchedAt: number;
  gh: { path: string; version: string | null } | null;
};

export type FailedLog = {
  /** The excerpt, oldest line first, each line bounded. */
  lines: string[];
  /** True when the excerpt ends at GitHub's last `##[error]` line rather than the end of the log. */
  anchored: boolean;
  /** Lines of the log before the excerpt, including any let go before the tail was kept. */
  before: number;
  /** Lines after it — the cleanup steps a job runs after a failure. */
  after: number;
};

export type FailedLogReport =
  | { kind: 'ok'; log: FailedLog; fetchedAt: number }
  /** gh succeeded and printed no failed-step log. */
  | { kind: 'empty'; fetchedAt: number }
  | { kind: 'not-actions'; detail: string }
  | { kind: 'missing' }
  /** gh exited non-zero, or was stopped at the timeout (code null). */
  | { kind: 'failed'; code: number | null; detail: string };

export const MAX_CHECKS = 200;
export const MAX_THREADS = 100;
export const MAX_THREAD_COMMENTS = 10;
export const MAX_COMMENT_CHARS = 4_000;
export const MAX_LOG_LINES = 80;
export const MAX_LOG_LINE_CHARS = 400;
const MAX_NAME = 200;
const MAX_TITLE = 300;
const MAX_PATH = 500;
const MAX_DESCRIPTION = 500;
const MAX_DETAIL = 300;

/**
 * The review threads of one pull request, capped at MAX_THREADS with the total
 * and whether GitHub holds more, so a cap is said rather than silently applied.
 * Every field the parser reads is asked for here; pr-readiness.test.ts holds
 * the two to each other.
 */
export const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${MAX_THREADS}) {
        totalCount
        pageInfo { hasNextPage }
        nodes {
          isResolved isOutdated path line startLine originalLine originalStartLine diffSide subjectType
          comments(first: ${MAX_THREAD_COMMENTS}) { totalCount nodes { author { login } body createdAt url } }
        }
      }
    }
  }
}`;

/* ── cleaning untrusted text ─────────────────────────────────────────── */

// CSI and OSC escape sequences (a CI log colours its output with them), then
// every C0 and C1 control except tab and newline, then the bidirectional
// overrides that make text display in an order other than the order it is read
// in — the "Trojan Source" shape, which in a review comment could show the
// operator one sentence and hand the agent another.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]/g;
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export function plainText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(ESCAPES, '').replace(CONTROLS, '');
}

/** A prefix of at most `max` UTF-16 units that does not end inside a surrogate pair. */
function prefix(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/**
 * Redacted first, bounded second: bounding first can cut a credential in half
 * and leave a prefix the redactor's patterns no longer recognise.
 */
function clean(raw: unknown, max: number, redact: Redact, oneLine = true): string {
  if (typeof raw !== 'string') return '';
  const text = redact(plainText(raw));
  return prefix(oneLine ? text.replace(/\s+/g, ' ').trim() : text, max);
}

function cleanBody(raw: unknown, redact: Redact): { body: string; bodyCut: number } {
  const text = typeof raw === 'string' ? redact(plainText(raw)).replace(/\s+$/, '') : '';
  const body = prefix(text, MAX_COMMENT_CHARS);
  return { body, bodyCut: text.length - body.length };
}

/** The first line of a program's complaint, cleaned and bounded. */
export function firstLineOf(text: string, redact: Redact): string {
  const line = plainText(text).split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return prefix(redact(line), MAX_DETAIL);
}

function positiveInt(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null;
}

/**
 * gh prints Go's zero time, 0001-01-01T00:00:00Z, for a check that has not
 * finished or a commit status that never records one. Read literally that is a
 * date two thousand years ago; it means "not recorded".
 */
function isoTime(raw: unknown): number | null {
  const at = typeof raw === 'string' ? Date.parse(raw) : NaN;
  return Number.isFinite(at) && at > 0 ? at : null;
}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Only an https URL leaves this module, and never one that carries a
 * credential. A link is the one field the renderer hands to the operating
 * system, so it is validated here and again in the shell:openExternal handler.
 */
export function httpsUrl(raw: unknown, redact: Redact): string | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2_048) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || url.username || url.password || !HOSTNAME.test(url.hostname)) return null;
    const text = url.toString();
    return redact(text) === text ? text : null;
  } catch { return null; }
}

/* ── the pull request ─────────────────────────────────────────────────── */

const MERGEABLE = new Set<Mergeable>(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']);
const MERGE_STATES = new Set<MergeStateStatus>(['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE']);
const PR_STATES: Record<string, ReadinessPr['state']> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' };

export type PullRequestPick = {
  pr: ReadinessPr;
  mergeable: Mergeable | null;
  mergeStateStatus: MergeStateStatus | null;
  /** How many entries the status rollup holds; zero means the head reports no checks. */
  checkCount: number;
};

/**
 * Reads `gh pr list --head=BRANCH --state=all --json …`. The list form, not
 * `pr view`: an empty array is "no pull request for this branch" by
 * construction, where `pr view` says so only in stderr prose. The open pull
 * request wins; failing that, whichever GitHub touched last — the same rule the
 * PR chip uses, so the two never describe different pull requests.
 */
export function parsePullRequestList(stdout: string, redact: Redact):
  | { ok: true; found: PullRequestPick | null }
  | { ok: false; detail: string } {
  let rows: unknown;
  try { rows = JSON.parse(stdout.trim() || '[]'); } catch {
    return { ok: false, detail: 'gh answered with something that was not JSON.' };
  }
  if (!Array.isArray(rows)) return { ok: false, detail: 'gh answered with something that was not a list of pull requests.' };
  const picks: Array<PullRequestPick & { updatedAt: number }> = [];
  for (const entry of rows) {
    const row = (entry ?? {}) as Record<string, unknown>;
    const number = positiveInt(row.number);
    if (number === null) continue;
    const mergeable = String(row.mergeable ?? '').toUpperCase() as Mergeable;
    const mergeState = String(row.mergeStateStatus ?? '').toUpperCase() as MergeStateStatus;
    const headSha = typeof row.headRefOid === 'string' && OID.test(row.headRefOid) ? row.headRefOid : null;
    picks.push({
      pr: {
        number,
        url: httpsUrl(row.url, redact),
        title: clean(row.title, MAX_TITLE, redact),
        isDraft: row.isDraft === true,
        state: PR_STATES[String(row.state ?? '').toUpperCase()] ?? 'closed',
        baseRef: clean(row.baseRefName, MAX_NAME, redact),
        headRef: clean(row.headRefName, MAX_NAME, redact),
        headSha,
      },
      mergeable: MERGEABLE.has(mergeable) ? mergeable : null,
      mergeStateStatus: MERGE_STATES.has(mergeState) ? mergeState : null,
      checkCount: Array.isArray(row.statusCheckRollup) ? row.statusCheckRollup.length : 0,
      updatedAt: isoTime(row.updatedAt) ?? 0,
    });
  }
  if (!picks.length) return { ok: true, found: null };
  const newest = (a: { updatedAt: number }, b: { updatedAt: number }) => b.updatedAt - a.updatedAt;
  const open = picks.filter((p) => p.pr.state === 'open').sort(newest);
  const best = open[0] ?? [...picks].sort(newest)[0];
  return { ok: true, found: { pr: best.pr, mergeable: best.mergeable, mergeStateStatus: best.mergeStateStatus, checkCount: best.checkCount } };
}

/** HOST, OWNER and NAME from a pull request's own link, which is what the review-thread query is asked about. */
export function repoOfPullUrl(url: string | null): { host: string; owner: string; name: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const m = /^\/([A-Za-z0-9][A-Za-z0-9_-]{0,99})\/([A-Za-z0-9._-]{1,100})\/pull\/\d+\/?$/.exec(u.pathname);
    if (u.protocol !== 'https:' || !HOSTNAME.test(u.hostname) || !m || m[2] === '.' || m[2] === '..') return null;
    return { host: u.hostname, owner: m[1], name: m[2] };
  } catch { return null; }
}

/* ── checks ───────────────────────────────────────────────────────────── */

const BUCKETS = new Set<CheckBucket>(['pass', 'fail', 'pending', 'skipping', 'cancel']);

/** gh's own sorting of a state into a bucket, for a row that arrives without one. */
function bucketOfState(state: string): CheckBucket {
  if (state === 'SUCCESS') return 'pass';
  if (state === 'SKIPPED' || state === 'NEUTRAL') return 'skipping';
  if (state === 'ERROR' || state === 'FAILURE' || state === 'TIMED_OUT' || state === 'ACTION_REQUIRED' || state === 'STARTUP_FAILURE') return 'fail';
  if (state === 'CANCELLED') return 'cancel';
  return 'pending';
}

/** What a reader has to act on first. */
const BUCKET_ORDER: Record<CheckBucket, number> = { fail: 0, cancel: 1, pending: 2, pass: 3, skipping: 4 };

const ACTIONS_PATH = /^\/([A-Za-z0-9][A-Za-z0-9_-]{0,99})\/([A-Za-z0-9._-]{1,100})\/actions\/runs\/(\d{1,20})(?:\/job\/(\d{1,20}))?\/?$/;

/**
 * The run and job a check's link names, or null when the link is not a GitHub
 * Actions run. Only digits and a validated HOST/OWNER/REPO come out, because
 * they become argv for `gh run view`.
 */
export function actionsJobOf(link: string | null): ActionsJob | null {
  if (!link) return null;
  try {
    const url = new URL(link);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !HOSTNAME.test(url.hostname)) return null;
    const m = ACTIONS_PATH.exec(url.pathname);
    if (!m || m[2] === '.' || m[2] === '..') return null;
    return { repo: `${url.hostname}/${m[1]}/${m[2]}`, runId: m[3], jobId: m[4] ?? null };
  } catch { return null; }
}

/**
 * Reads `gh pr checks N --json name,workflow,bucket,state,link,startedAt,completedAt,description`.
 * gh exits 0 with failures in the list when asked for JSON, so the rows are the
 * whole answer; the caller treats a non-zero exit as a failed read.
 */
export function parseChecks(stdout: string, redact: Redact): ChecksRead {
  let rows: unknown;
  try { rows = JSON.parse(stdout.trim()); } catch {
    return { read: 'failed', detail: 'gh answered with something that was not JSON.' };
  }
  if (!Array.isArray(rows)) return { read: 'failed', detail: 'gh answered with something that was not a list of checks.' };
  const items: PrCheck[] = rows.map((entry) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    const state = clean(row.state, 40, redact).toUpperCase();
    const rawBucket = String(row.bucket ?? '') as CheckBucket;
    const link = httpsUrl(row.link, redact);
    return {
      name: clean(row.name, MAX_NAME, redact) || '(no name given)',
      workflow: clean(row.workflow, MAX_NAME, redact) || null,
      bucket: BUCKETS.has(rawBucket) ? rawBucket : bucketOfState(state),
      state: state || 'UNKNOWN',
      link,
      startedAt: isoTime(row.startedAt),
      completedAt: isoTime(row.completedAt),
      description: clean(row.description, MAX_DESCRIPTION, redact) || null,
      actions: actionsJobOf(link),
    };
  });
  // Stable within a bucket: gh's own order, which follows the head commit's rollup.
  const ordered = items.map((c, i) => ({ c, i }))
    .sort((a, b) => BUCKET_ORDER[a.c.bucket] - BUCKET_ORDER[b.c.bucket] || a.i - b.i)
    .map((x) => x.c);
  return { read: 'ok', items: ordered.slice(0, MAX_CHECKS), omitted: Math.max(0, ordered.length - MAX_CHECKS) };
}

/* ── review threads ───────────────────────────────────────────────────── */

/** Reads the JSON `gh api graphql` printed for REVIEW_THREADS_QUERY. */
export function parseThreads(stdout: string, redact: Redact): ThreadsRead {
  let body: unknown;
  try { body = JSON.parse(stdout.trim()); } catch {
    return { read: 'failed', detail: 'gh answered with something that was not JSON.' };
  }
  const root = (body ?? {}) as { data?: unknown; errors?: unknown };
  const pullRequest = ((((root.data ?? {}) as Record<string, unknown>).repository ?? {}) as Record<string, unknown>).pullRequest;
  const threads = ((pullRequest ?? {}) as Record<string, unknown>).reviewThreads as
    | { totalCount?: unknown; pageInfo?: { hasNextPage?: unknown }; nodes?: unknown }
    | undefined;
  if (!threads || !Array.isArray(threads.nodes)) {
    const said = Array.isArray(root.errors)
      ? root.errors.map((e) => (e && typeof (e as { message?: unknown }).message === 'string' ? (e as { message: string }).message : '')).find(Boolean)
      : undefined;
    return { read: 'failed', detail: said ? firstLineOf(said, redact) : 'GitHub answered without this pull request’s review threads.' };
  }
  const items = threads.nodes.slice(0, MAX_THREADS).map((entry): PrThread => {
    const node = (entry ?? {}) as Record<string, unknown>;
    const connection = (node.comments ?? {}) as { totalCount?: unknown; nodes?: unknown };
    const nodes = Array.isArray(connection.nodes) ? connection.nodes.slice(0, MAX_THREAD_COMMENTS) : [];
    const comments = nodes.map((c): PrThreadComment => {
      const comment = (c ?? {}) as Record<string, unknown>;
      const author = ((comment.author ?? null) as { login?: unknown } | null)?.login;
      return {
        author: clean(author, 100, redact) || null,
        ...cleanBody(comment.body, redact),
        createdAt: isoTime(comment.createdAt),
        url: httpsUrl(comment.url, redact),
      };
    });
    const total = typeof connection.totalCount === 'number' && Number.isInteger(connection.totalCount) ? connection.totalCount : comments.length;
    const side = String(node.diffSide ?? '').toUpperCase();
    return {
      // A thread whose resolution gh did not state is shown, not hidden: the
      // unresolved list is the one a reader acts on.
      isResolved: node.isResolved === true,
      isOutdated: node.isOutdated === true,
      path: clean(node.path, MAX_PATH, redact),
      line: positiveInt(node.line),
      startLine: positiveInt(node.startLine),
      originalLine: positiveInt(node.originalLine),
      originalStartLine: positiveInt(node.originalStartLine),
      side: side === 'LEFT' || side === 'RIGHT' ? side : null,
      subject: String(node.subjectType ?? '').toUpperCase() === 'FILE' ? 'file' : 'line',
      comments,
      commentsOmitted: Math.max(0, total - comments.length),
    };
  });
  const reported = typeof threads.totalCount === 'number' && Number.isInteger(threads.totalCount) ? threads.totalCount : 0;
  const total = Math.max(reported, threads.nodes.length, items.length);
  return { read: 'ok', items, total, capped: threads.pageInfo?.hasNextPage === true || total > items.length };
}

/** The sentence a capped thread read carries; null when every thread was read. */
export function threadCapNote(threads: ThreadsRead): string | null {
  if (threads.read !== 'ok' || !threads.capped) return null;
  return `GitHub holds ${threads.total.toLocaleString('en-US')} review threads on this pull request and the first ${threads.items.length} were read, so an unresolved thread after those is not listed here.`;
}

/* ── failed-step logs ─────────────────────────────────────────────────── */

/**
 * `gh run view --log-failed` prefixes every line with the job, the step and a
 * timestamp, tab-separated, and the first line of a step carries a byte-order
 * mark before the timestamp. The job is already the check's name, the step is
 * usually "UNKNOWN STEP", and the timestamps are noise in a message.
 */
const LOG_PREFIX = /^[^\t\n]*\t[^\t\n]*\t\uFEFF?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;

/**
 * The excerpt of a failed-step log a person or an agent can act on.
 *
 * "The last 80 lines" of a real one is mostly the job's post-run cleanup: in
 * the log this was written against, GitHub's `##[error]Process completed with
 * exit code 1.` sat 33 lines from the end, below the failing test's output and
 * above a page of credential-helper teardown. So the excerpt ends at the last
 * `##[error]` line when there is one, and at the end of the log when there is
 * not, and says which along with how many lines it left out either side.
 *
 * The whole kept tail is redacted before the window is chosen, so a private
 * key block that straddles the window's edge is recognised as one block.
 * Counts are of lines as a reader would see them after that redaction.
 */
export function failedLogExcerpt(tail: string, droppedLines: number, redact: Redact): FailedLog {
  const raw = tail.split('\n');
  if (raw.length && raw[raw.length - 1] === '') raw.pop();
  const lines = redact(raw.map((line) => plainText(line.replace(LOG_PREFIX, '').replace(/^\uFEFF/, '')).replace(/\s+$/, '')).join('\n'))
    .split('\n');
  if (lines.every((line) => !line.trim())) return { lines: [], anchored: false, before: droppedLines + lines.length, after: 0 };
  let marker = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].startsWith('##[error]')) { marker = i; break; }
  const stop = marker >= 0 ? marker + 1 : lines.length;
  const start = Math.max(0, stop - MAX_LOG_LINES);
  return {
    lines: lines.slice(start, stop).map((line) => (line.length > MAX_LOG_LINE_CHARS ? `${prefix(line, MAX_LOG_LINE_CHARS)} …` : line)),
    anchored: marker >= 0,
    before: Math.max(0, droppedLines) + start,
    after: lines.length - stop,
  };
}

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/** What an excerpt is, in one sentence: how much, where it stops, and what it left out. */
export function excerptCaption(log: FailedLog): string {
  const what = `The last ${plural(log.lines.length, 'line')} of its failed-step log${log.anchored ? ', up to GitHub’s last error marker' : ''}`;
  const left = [log.before > 0 ? `${log.before.toLocaleString('en-US')} earlier` : '', log.after > 0 ? `${log.after.toLocaleString('en-US')} later` : '']
    .filter(Boolean);
  return left.length ? `${what} (${left.join(' and ')} line${log.before + log.after === 1 ? '' : 's'} not shown)` : what;
}

/* ── remotes ──────────────────────────────────────────────────────────── */

/**
 * The host a remote URL points at: https and ssh URLs, and git's scp-like
 * `user@host:owner/repo` form. A local path has no host. The host of an SSH
 * alias (`git@work:owner/repo`) is the alias, which only ssh's own
 * configuration can translate.
 */
export function hostOfRemote(url: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      return u.protocol !== 'file:' && HOSTNAME.test(host) ? host : null;
    } catch { return null; }
  }
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)/.exec(url);
  // A single letter before the colon is a Windows drive, not a host.
  if (!scp || /^[A-Za-z]$/.test(scp[1])) return null;
  const host = scp[1].toLowerCase();
  return HOSTNAME.test(host) ? host : null;
}

/** Remote names and distinct hosts, from `git remote -v`. */
export function remoteHosts(remoteVerbose: string): { remotes: number; hosts: string[] } {
  const names = new Set<string>();
  const hosts = new Set<string>();
  for (const line of remoteVerbose.split('\n')) {
    const m = /^(\S+)\t(\S+)(?: \((?:fetch|push)\))?\s*$/.exec(line);
    if (!m) continue;
    names.add(m[1]);
    const host = hostOfRemote(m[2]);
    if (host) hosts.add(host);
  }
  return { remotes: names.size, hosts: [...hosts] };
}

/** github.com and GitHub Enterprise Cloud's data-residency hosts; other Enterprise hosts are known only to gh's own sign-in. */
export function isGitHubHost(host: string): boolean {
  return host === 'github.com' || host.endsWith('.ghe.com');
}

/* ── mergeability, in words ───────────────────────────────────────────── */

export type MergeOutcome =
  | 'merged' | 'closed' | 'conflicts' | 'unknown' | 'unread'
  | 'draft' | 'blocked' | 'behind' | 'unstable' | 'clean' | 'no-conflicts';

/**
 * What GitHub's two mergeability fields amount to, as one outcome and one
 * sentence. The raw words stay beside it on screen; this is the reading, not a
 * replacement for the evidence.
 */
export function mergeability(r: Pick<PrReadiness, 'pr' | 'mergeable' | 'mergeStateStatus'>): { outcome: MergeOutcome; sentence: string } {
  const { pr, mergeable, mergeStateStatus: status } = r;
  if (pr.state === 'merged') return { outcome: 'merged', sentence: `Pull request #${pr.number} is already merged.` };
  if (pr.state === 'closed') return { outcome: 'closed', sentence: `Pull request #${pr.number} is closed without being merged.` };
  if (mergeable === 'CONFLICTING' || status === 'DIRTY') {
    return { outcome: 'conflicts', sentence: `GitHub cannot merge ${pr.headRef || 'this branch'} into ${pr.baseRef || 'its base'}: they conflict.` };
  }
  if (mergeable === 'UNKNOWN' || (mergeable === null && status === 'UNKNOWN')) {
    return { outcome: 'unknown', sentence: 'GitHub has not finished working out whether this merges. It recomputes after the branch or its base moves; check again in a moment.' };
  }
  if (mergeable === null) return { outcome: 'unread', sentence: 'gh’s answer did not say whether this merges.' };
  if (status === 'DRAFT' || pr.isDraft) return { outcome: 'draft', sentence: 'No conflicts, but it is a draft, so GitHub will not merge it until it is marked ready for review.' };
  if (status === 'BLOCKED') return { outcome: 'blocked', sentence: 'No conflicts, but GitHub reports it blocked: a required review or required check has not been satisfied.' };
  if (status === 'BEHIND') return { outcome: 'behind', sentence: `No conflicts, but GitHub reports ${pr.headRef || 'the branch'} out of date with ${pr.baseRef || 'its base'}, and this repository requires it to be current before merging.` };
  if (status === 'UNSTABLE') return { outcome: 'unstable', sentence: 'No conflicts, but not every check is passing.' };
  if (status === 'CLEAN' || status === 'HAS_HOOKS') return { outcome: 'clean', sentence: 'No conflicts, and GitHub reports nothing standing in the way of a merge.' };
  return { outcome: 'no-conflicts', sentence: 'No conflicts. GitHub did not say whether anything else stands in the way of a merge.' };
}
