/**
 * Issue intake, the part that needs no process: which GitHub repository a
 * project's remotes name, the exact gh argv that reads it, what gh printed
 * about its issues, comments and failed runs, which of those are facts worth an
 * event, and the sentences a poll is described in. src/main/intake.ts runs git
 * and gh and hands their output here.
 *
 * What it is for. Work gets filed where the work is: an issue opened, a label
 * put on one, a comment left, a CI run that failed. GitHub pushes none of that to
 * a laptop with no public port, and Wanigan opens none, so the only local way to
 * hear about it is to ask — on a press, or on a timer the operator turned on.
 * Asking has two honesty problems this module states instead of hiding. A poll
 * that fired, one that ran and one that succeeded are three different facts, and
 * a history that folds them together reads a refused or crashed check as a quiet
 * repository. And a poll sees only what is still there: while the laptop was
 * shut, an issue opened and closed again, or a run that failed and was re-run to
 * green, left nothing behind to read — so how long nothing was watching is said
 * beside what was found.
 *
 * Everything gh prints here is text other people wrote. Every string that leaves
 * this module has had escapes, control characters and bidirectional overrides
 * removed, has been through the caller's credential redactor, and is cut to a
 * stated bound. The redactor is injected for the reason pr-readiness.ts gives:
 * the one Wanigan trusts is src/main/redact.ts, and a copy here would drift.
 */
import { hostOfRemote, httpsUrl, isGitHubHost, plainText, remoteHosts, type Redact } from './pr-readiness.ts';

/* ── what a poll records ───────────────────────────────────────────────── */

/** The four kinds of GitHub fact intake records. */
export type IntakeKind = 'opened' | 'labelled' | 'commented' | 'ci_failed';
export const INTAKE_KINDS: readonly IntakeKind[] = ['opened', 'labelled', 'commented', 'ci_failed'];
/** The word a Control event carries as its kind, which is also what the inbox prints. */
export const INTAKE_KIND_WORD: Record<IntakeKind, string> = {
  opened: 'opened', labelled: 'labelled', commented: 'commented', ci_failed: 'CI failed',
};
/** The source every intake event is recorded under. */
export const INTAKE_SOURCE = 'github';

export type IntakeTrigger = 'manual' | 'timer';
export type IntakeOutcome = 'succeeded' | 'failed' | 'skipped';

/**
 * One poll, as recorded. Fired, ran and finished are separate times because they
 * are separate facts: a press that found no gh fired and never ran, and a read gh
 * refused ran and failed. `outcome` is null only while the poll is still running.
 */
export type IntakePoll = {
  id: string;
  projectId: string;
  trigger: IntakeTrigger;
  firedAt: number;
  /** When gh was first invoked for this poll's reads; null when it never was. */
  ranAt: number | null;
  finishedAt: number | null;
  outcome: IntakeOutcome | null;
  /** Wanigan's own sentence for a failed or skipped poll. */
  reason: string | null;
  /** gh's (or git's) own first line, redacted and bounded, when a program said why. */
  error: string | null;
  /** host/owner/name of the repository read, once one was chosen. */
  repo: string | null;
  /** The window the poll covered: from the last successful poll's end, or a first-check lookback, to when it ran. */
  since: number | null;
  until: number | null;
  /** True when `since` is the first-check lookback rather than the end of an earlier success. */
  lookback: boolean;
  /** The timer interval in force when the poll fired; null when the timer was off. */
  intervalMs: number | null;
  /** How long nothing was watching before this poll, when that was longer than its interval implies. */
  gapMs: number | null;
  /** Facts gh returned that fell in the window, including ones already in the inbox. */
  factsRead: number;
  /** Events this poll added, by kind. A fact already recorded adds nothing. */
  counts: Record<IntakeKind, number>;
  /** Which reads stopped at their limit, in words; null when none did. */
  capped: string | null;
};

/**
 * Whether a project is watched, decided from its remotes alone — no gh runs to
 * answer it. `unwatched` carries the sentence: no git repository, no remote, a
 * remote on another host, or git unable to list them.
 */
export type IntakeWatch =
  | { kind: 'github'; repo: string; remote: string }
  | { kind: 'unwatched'; detail: string };

export type IntakeProject = {
  projectId: string;
  projectName: string;
  watch: IntakeWatch;
  /** The newest poll of any outcome, or null when this project was never checked. */
  last: IntakePoll | null;
  /** The newest poll that succeeded, which is where the next window starts. */
  lastSucceeded: IntakePoll | null;
};

/** Which recorded Control event is a GitHub fact, and where on GitHub it is. */
export type IntakeEventLink = {
  eventId: string;
  kind: IntakeKind;
  url: string | null;
  /** GitHub's own time for the fact, when it gave one that means the fact happened then. */
  happenedAt: number | null;
  pollId: string | null;
};

export type IntakeTimer = { enabled: boolean; intervalMinutes: number };

export type IntakeOverview = {
  timer: IntakeTimer;
  projects: IntakeProject[];
  events: IntakeEventLink[];
  readAt: number;
};

/* ── the timer ─────────────────────────────────────────────────────────── */

/**
 * Ten minutes is the floor. Each poll is three GitHub reads per repository, and
 * issue search is rate limited far below the REST API; a faster loop across a
 * handful of projects is how an operator finds out gh is refusing them.
 */
export const INTAKE_MIN_INTERVAL_MINUTES = 10;
export const INTAKE_MAX_INTERVAL_MINUTES = 24 * 60;
export const INTAKE_DEFAULT_INTERVAL_MINUTES = 15;

/**
 * Renderer input, checked where it is stored. The interval is refused rather than
 * clamped: a nine silently saved as ten is a setting nobody chose.
 */
export function timerInput(raw: unknown): IntakeTimer {
  const input = (raw ?? {}) as Record<string, unknown>;
  if (typeof input.enabled !== 'boolean') throw new Error('The GitHub timer is either on or off.');
  const minutes = input.intervalMinutes;
  if (typeof minutes !== 'number' || !Number.isInteger(minutes)) {
    throw new Error('The interval must be a whole number of minutes.');
  }
  if (minutes < INTAKE_MIN_INTERVAL_MINUTES) {
    throw new Error(`The interval must be at least ${INTAKE_MIN_INTERVAL_MINUTES} minutes; ${minutes} would ask GitHub more often than intake allows.`);
  }
  if (minutes > INTAKE_MAX_INTERVAL_MINUTES) {
    throw new Error(`The interval can be at most ${INTAKE_MAX_INTERVAL_MINUTES} minutes (one day).`);
  }
  return { enabled: input.enabled, intervalMinutes: minutes };
}

/* ── which repository ──────────────────────────────────────────────────── */

export type GitHubRepo = { host: string; owner: string; name: string; remote: string };

// GitHub's own rules, narrowed to what can travel inside an API path and a
// --repo value without escaping: an owner is letters, digits and single inner
// hyphens; a name adds dots and underscores and is never "." or "..".
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

/** host/owner/name from one remote URL, or null when it names no GitHub repository intake can address. */
export function githubRepoOfUrl(url: string): { host: string; owner: string; name: string } | null {
  const host = hostOfRemote(url);
  if (!host || !isGitHubHost(host)) return null;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try { path = new URL(url).pathname; } catch { return null; }
  } else {
    const scp = /^(?:[^@/\s]+@)?[^:/\s]+:(.*)$/.exec(url);
    if (!scp) return null;
    path = scp[1];
  }
  const parts = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  return OWNER.test(owner) && REPO_NAME.test(name) ? { host, owner, name } : null;
}

/** The remote `gh repo set-default` marked, from `git config --get-regexp '^remote\..*\.gh-resolved$'`. */
export function ghResolvedBase(configOut: string): string | null {
  for (const line of configOut.split('\n')) {
    const m = /^remote\.(.+)\.gh-resolved\s+base\s*$/.exec(line.trim());
    if (m) return m[1];
  }
  return null;
}

/**
 * gh's own order when a repository has several remotes and no default was set:
 * upstream, then github, then origin, then the rest. Reading the repository
 * `gh issue list` would read in that checkout keeps intake from watching a fork
 * while the operator's issues are filed upstream.
 */
const REMOTE_RANK: Record<string, number> = { upstream: 3, github: 2, origin: 1 };

export type RemoteChoice =
  | { ok: true; repo: GitHubRepo }
  | { ok: false; detail: string };

export function chooseGitHubRemote(remoteVerbose: string, resolvedBase: string | null): RemoteChoice {
  const urls = new Map<string, string>();
  for (const line of remoteVerbose.split('\n')) {
    const m = /^(\S+)\t(\S+)(?: \((fetch|push)\))?\s*$/.exec(line);
    if (!m) continue;
    // The fetch URL is the one reads go to; a push-only line fills a gap.
    if (m[3] !== 'push' || !urls.has(m[1])) urls.set(m[1], m[2]);
  }
  if (urls.size === 0) {
    return { ok: false, detail: 'This repository has no git remote, so there is no GitHub repository to watch.' };
  }
  const candidates: GitHubRepo[] = [];
  for (const [remote, url] of urls) {
    const repo = githubRepoOfUrl(url);
    if (repo) candidates.push({ ...repo, remote });
  }
  if (!candidates.length) {
    const hosts = remoteHosts(remoteVerbose).hosts;
    if (hosts.some(isGitHubHost)) {
      return { ok: false, detail: 'This repository’s remotes name a GitHub host but no owner and repository intake can read, so nothing is watched.' };
    }
    const named = hosts.length ? hosts.slice(0, 4).join(', ') : 'no host Wanigan could read';
    return {
      ok: false,
      detail: `This repository’s remotes point at ${named}. Intake watches repositories on github.com and GitHub Enterprise Cloud (*.ghe.com) only, so nothing is watched.`,
    };
  }
  const rank = (repo: GitHubRepo) => (repo.remote === resolvedBase ? 10 : REMOTE_RANK[repo.remote] ?? 0);
  candidates.sort((a, b) => rank(b) - rank(a) || a.remote.localeCompare(b.remote));
  return { ok: true, repo: candidates[0] };
}

/** How the repository reads in a sentence: github.com is implied, any other host is named. */
export function repoLabel(repo: string): string {
  return repo.startsWith('github.com/') ? repo.slice('github.com/'.length) : repo;
}

export function repoKey(repo: Pick<GitHubRepo, 'host' | 'owner' | 'name'>): string {
  return `${repo.host}/${repo.owner}/${repo.name}`;
}

/* ── the window ────────────────────────────────────────────────────────── */

/** How far back the first successful check of a repository reads. */
export const FIRST_LOOKBACK_MS = 24 * 60 * 60_000;
/**
 * Every read reaches this far behind where the last one ended. Issue search is
 * indexed a little after the fact and this Mac's clock is not GitHub's, so an
 * issue updated seconds before a poll can be missing from it; overlapping the
 * windows and letting the external key refuse the repeat costs nothing.
 */
export const WINDOW_OVERLAP_MS = 5 * 60_000;
/** Tick granularity and a check's own startup put a little more than one interval between two on-time checks. */
const GAP_SLACK_MS = 2 * 60_000;

export function pollWindow(previousUntil: number | null, until: number): { since: number; lookback: boolean } {
  if (previousUntil === null || !Number.isFinite(previousUntil)) return { since: until - FIRST_LOOKBACK_MS, lookback: true };
  // A clock that moved backwards leaves an empty window, never an inverted one.
  return { since: Math.min(previousUntil, until), lookback: false };
}

/**
 * How long nothing was watching before a poll, or null when the window was no
 * longer than its interval implies. With the timer on, the interval is the
 * latency the operator chose, so only the time beyond it was unwatched. With the
 * timer off, only presses watch, so the whole window was.
 */
export function unwatchedMs(w: { since: number; until: number; lookback: boolean; intervalMs: number | null }): number | null {
  if (w.lookback) return null;
  const span = w.until - w.since;
  if (w.intervalMs === null) return span > INTAKE_MIN_INTERVAL_MINUTES * 60_000 + GAP_SLACK_MS ? span : null;
  return span > w.intervalMs + GAP_SLACK_MS ? span - w.intervalMs : null;
}

/** GitHub's timestamp form, to the second. */
export function githubTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A span in words a sentence can carry: "12 min", "5 h 45 min", "3 days 2 h". */
export function spanWords(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest ? `${hours} h ${rest} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${days} days ${h} h` : `${days} days`;
}

const MISSED = 'An issue opened and closed, a label added and removed, or a run that failed and was re-run, in that time is not in this inbox.';

/** The sentence a poll with a gap carries, or null when nothing went unwatched. */
export function gapSentence(poll: Pick<IntakePoll, 'since' | 'until' | 'intervalMs' | 'gapMs'>): string | null {
  if (poll.gapMs === null || poll.since === null || poll.until === null) return null;
  const span = spanWords(poll.until - poll.since);
  if (poll.intervalMs === null) {
    return `Nothing was watching for ${spanWords(poll.gapMs)}: the timer is off, so GitHub is read only when someone presses, and the last successful check was ${span} before this one. ${MISSED}`;
  }
  const every = Math.round(poll.intervalMs / 60_000);
  return `Nothing was watching for ${spanWords(poll.gapMs)}: the last successful check was ${span} before this one, and the timer asks every ${every} minutes. Wanigan was closed, this Mac was asleep, the timer was off, or checks failed in between. ${MISSED}`;
}

/** The sentence a repository's first successful check carries. */
export function lookbackSentence(poll: Pick<IntakePoll, 'lookback' | 'repo'>): string | null {
  if (!poll.lookback) return null;
  const repo = poll.repo ? repoLabel(poll.repo) : 'this repository';
  return `This was the first successful check of ${repo}, so it read the ${spanWords(FIRST_LOOKBACK_MS)} before it; anything older is not in this inbox.`;
}

/* ── the reads ─────────────────────────────────────────────────────────── */

export const ISSUE_LIMIT = 100;
export const COMMENT_LIMIT = 100;
export const RUN_LIMIT = 50;
export const ISSUE_FIELDS = 'number,title,labels,author,url,createdAt,updatedAt';
export const RUN_FIELDS = 'databaseId,attempt,number,name,displayTitle,workflowName,headBranch,event,conclusion,createdAt,updatedAt,url';

/**
 * Open issues updated since `from`. Every value gh is given travels as one
 * `--flag=value` token, so nothing read from a remote can become a flag.
 */
export function issueArgs(repo: GitHubRepo, from: number): string[] {
  return ['issue', 'list', `--repo=${repoKey(repo)}`, '--state=open', `--search=updated:>=${githubTime(from)}`,
    `--limit=${ISSUE_LIMIT}`, '--json', ISSUE_FIELDS];
}

/**
 * Issue comments updated since `from`, newest first. `--method=GET` is spelled
 * out because gh api switches to POST the moment a parameter flag is added, and
 * a later edit that passed `since` as `-f` would turn this read into a write
 * request; the parameters ride in the path instead.
 */
export function commentArgs(repo: GitHubRepo, from: number): string[] {
  return ['api', '--method=GET', `--hostname=${repo.host}`,
    `repos/${repo.owner}/${repo.name}/issues/comments?since=${githubTime(from)}&sort=updated&direction=desc&per_page=${COMMENT_LIMIT}`];
}

/**
 * The newest failed workflow runs. Not filtered by creation date: a nightly
 * created before the window that failed inside it would be missed. The window
 * is applied to when the run last changed instead.
 */
export function runArgs(repo: GitHubRepo): string[] {
  return ['run', 'list', `--repo=${repoKey(repo)}`, '--status=failure', `--limit=${RUN_LIMIT}`, '--json', RUN_FIELDS];
}

/** One GitHub fact, ready to become an event. */
export type IntakeFact = {
  kind: IntakeKind;
  /** Unique per project: the same fact read twice is one event. */
  key: string;
  summary: string;
  url: string | null;
  at: number | null;
};

export type IntakeRead =
  | { read: 'ok'; facts: IntakeFact[]; capped: string | null }
  | { read: 'failed'; detail: string };

/** control.ts refuses a longer summary, and a refused event would fail the whole poll. */
export const EVENT_SUMMARY_MAX = 2_000;
const MAX_TITLE = 200;
const MAX_LABEL = 80;
const MAX_LOGIN = 60;
const MAX_EXCERPT = 280;
const MAX_NAME = 120;
const MAX_LABELS_PER_ISSUE = 20;
const GONE = 'an account GitHub no longer has';

/** A prefix of at most `max` UTF-16 units that does not end inside a surrogate pair. */
function prefix(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/** Redacted first, bounded second: a cut first can leave half a credential the redactor no longer recognises. */
function clean(raw: unknown, max: number, redact: Redact): string {
  if (typeof raw !== 'string') return '';
  return prefix(redact(plainText(raw)).replace(/\s+/g, ' ').trim(), max);
}

function excerpt(raw: unknown, redact: Redact): string {
  const text = clean(raw, MAX_EXCERPT + 1, redact);
  return text.length > MAX_EXCERPT ? `${prefix(text, MAX_EXCERPT).trimEnd()}…` : text;
}

function loginOf(raw: unknown, redact: Redact): string {
  const login = raw && typeof raw === 'object' ? clean((raw as Record<string, unknown>).login, MAX_LOGIN, redact) : '';
  return login || GONE;
}

function positiveInt(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : null;
}

function isoTime(raw: unknown): number | null {
  const at = typeof raw === 'string' ? Date.parse(raw) : NaN;
  return Number.isFinite(at) && at > 0 ? at : null;
}

/**
 * The link rides at the end of the summary as well as beside the event, because
 * a goal made from the event keeps only the summary: without it, the agent that
 * later works the goal has no way back to the issue.
 */
function withLink(summary: string, url: string | null): string {
  const text = prefix(summary, EVENT_SUMMARY_MAX);
  return url && text.length + 3 + url.length <= EVENT_SUMMARY_MAX ? `${text} — ${url}` : text;
}

function parsed(stdout: string, what: string): { ok: true; rows: unknown[] } | { ok: false; detail: string } {
  let rows: unknown;
  try { rows = JSON.parse(stdout.trim() || '[]'); } catch {
    return { ok: false, detail: `gh answered the read of ${what} with something that was not JSON, so nothing from this check was recorded.` };
  }
  return Array.isArray(rows)
    ? { ok: true, rows }
    : { ok: false, detail: `gh answered the read of ${what} with something that was not a list, so nothing from this check was recorded.` };
}

function unique(facts: IntakeFact[]): IntakeFact[] {
  const seen = new Set<string>();
  return facts.filter((fact) => (seen.has(fact.key) ? false : (seen.add(fact.key), true)));
}

/**
 * Opened: an open issue created inside the window. Labelled: a label Wanigan
 * has not recorded on that issue before. gh's list says which labels an issue
 * carries, not when each was added, so a labelled event claims the label is
 * there — first seen by this poll — and gives no time for it.
 */
export function parseIssues(stdout: string, repo: GitHubRepo, from: number, redact: Redact): IntakeRead {
  const list = parsed(stdout, 'open issues');
  if (!list.ok) return { read: 'failed', detail: list.detail };
  const key = repoKey(repo).toLowerCase();
  const where = repoLabel(repoKey(repo));
  const facts: IntakeFact[] = [];
  for (const raw of list.rows) {
    const row = (raw ?? {}) as Record<string, unknown>;
    const number = positiveInt(row.number);
    if (number === null) continue;
    const title = clean(row.title, MAX_TITLE, redact) || 'an issue with no title';
    const url = httpsUrl(row.url, redact);
    const created = isoTime(row.createdAt);
    if (created !== null && created >= from) {
      facts.push({ kind: 'opened', key: `${key}:issue:${number}:opened`, url, at: created,
        summary: withLink(`Issue #${number} opened by ${loginOf(row.author, redact)} in ${where}: “${title}”`, url) });
    }
    const labels = Array.isArray(row.labels) ? row.labels.slice(0, MAX_LABELS_PER_ISSUE) : [];
    for (const label of labels) {
      const name = label && typeof label === 'object' ? clean((label as Record<string, unknown>).name, MAX_LABEL, redact) : '';
      if (!name) continue;
      facts.push({ kind: 'labelled', key: `${key}:issue:${number}:label:${name.toLowerCase()}`, url, at: null,
        summary: withLink(`Issue #${number} in ${where} carries the label “${name}”: “${title}”`, url) });
    }
  }
  const capped = list.rows.length >= ISSUE_LIMIT
    ? `GitHub had at least ${ISSUE_LIMIT} open issues updated in this window and one check reads ${ISSUE_LIMIT}, so some may not be here.`
    : null;
  return { read: 'ok', facts: unique(facts), capped };
}

const ISSUE_COMMENT_PATH = /^\/[^/]+\/[^/]+\/issues\/(\d{1,12})$/;

/**
 * Commented: a comment on an issue created inside the window. A comment on a
 * pull request comes back from the same endpoint, because GitHub counts pull
 * requests as issues, and is left out: this is issue intake. An old comment
 * edited inside the window is left out too — it was either recorded when it was
 * written, or it predates anything Wanigan watched.
 */
export function parseComments(stdout: string, repo: GitHubRepo, from: number, redact: Redact): IntakeRead {
  const list = parsed(stdout, 'issue comments');
  if (!list.ok) return { read: 'failed', detail: list.detail };
  const key = repoKey(repo).toLowerCase();
  const where = repoLabel(repoKey(repo));
  const facts: IntakeFact[] = [];
  for (const raw of list.rows) {
    const row = (raw ?? {}) as Record<string, unknown>;
    const id = positiveInt(row.id);
    const url = httpsUrl(row.html_url, redact);
    const created = isoTime(row.created_at);
    if (id === null || url === null || created === null || created < from) continue;
    const number = ISSUE_COMMENT_PATH.exec(new URL(url).pathname)?.[1];
    if (!number) continue;
    const body = excerpt(row.body, redact);
    facts.push({ kind: 'commented', key: `${key}:comment:${id}`, url, at: created,
      summary: withLink(`${loginOf(row.user, redact)} commented on issue #${number} in ${where}${body ? `: “${body}”` : ''}`, url) });
  }
  const capped = list.rows.length >= COMMENT_LIMIT
    ? `GitHub had at least ${COMMENT_LIMIT} comments updated in this window and one check reads the newest ${COMMENT_LIMIT}, so an earlier one may not be here.`
    : null;
  return { read: 'ok', facts: unique(facts), capped };
}

/**
 * CI failed: a workflow run whose conclusion is failure and that last changed
 * inside the window. Each attempt is its own fact, so a re-run that fails again
 * is recorded again, and a re-run that passes cannot erase the first failure.
 * Timed-out and startup failures are other statuses gh is not asked for here.
 */
export function parseRuns(stdout: string, repo: GitHubRepo, from: number, redact: Redact): IntakeRead {
  const list = parsed(stdout, 'failed workflow runs');
  if (!list.ok) return { read: 'failed', detail: list.detail };
  const key = repoKey(repo).toLowerCase();
  const where = repoLabel(repoKey(repo));
  const facts: IntakeFact[] = [];
  // gh lists newest-created first, so whether the last row it returned is still
  // inside the window is what says a full list may have cut the window short.
  let lastInWindow = true;
  for (const raw of list.rows) {
    const row = (raw ?? {}) as Record<string, unknown>;
    const id = positiveInt(row.databaseId);
    const updated = isoTime(row.updatedAt);
    lastInWindow = updated !== null && updated >= from;
    if (id === null || updated === null || updated < from) continue;
    if (String(row.conclusion ?? '').toLowerCase() !== 'failure') continue;
    const attempt = positiveInt(row.attempt) ?? 1;
    const url = httpsUrl(row.url, redact);
    const workflow = clean(row.workflowName, MAX_NAME, redact) || clean(row.name, MAX_NAME, redact) || 'a workflow';
    const branch = clean(row.headBranch, MAX_NAME, redact);
    const trigger = clean(row.event, MAX_NAME, redact);
    const runNumber = positiveInt(row.number);
    const title = clean(row.displayTitle, MAX_TITLE, redact);
    const on = [branch ? ` on ${branch}` : '', trigger ? ` (${trigger})` : ''].join('');
    const run = [runNumber ? `, run #${runNumber}` : '', attempt > 1 ? `, attempt ${attempt}` : ''].join('');
    facts.push({ kind: 'ci_failed', key: `${key}:run:${id}:attempt:${attempt}`, url, at: updated,
      summary: withLink(`CI failed in ${where}: ${workflow}${on}${run}${title ? `: “${title}”` : ''}`, url) });
  }
  const capped = list.rows.length >= RUN_LIMIT && lastInWindow
    ? `gh listed ${RUN_LIMIT} failed runs and every one was in this window, so an earlier failure in it may not be here.`
    : null;
  return { read: 'ok', facts: unique(facts), capped };
}
