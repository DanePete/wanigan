import { randomUUID } from 'node:crypto';
import { db } from './db';
import { runGit, scopeOf } from './git';
import { resolveGh, runGh, type GhRun } from './gh';
import { addExternalEvent } from './control';
import { listProjects, projectById } from './store';
import { assertManagedRoot } from './roots';
import { redactCredentials } from './redact';
import { getSetting, setSetting } from './settings';
import { firstLineOf } from '../shared/pr-readiness';
import {
  chooseGitHubRemote, commentArgs, ghResolvedBase, issueArgs, parseComments, parseIssues, parseRuns, pollWindow, repoKey, repoLabel,
  runArgs, timerInput, unwatchedMs,
  INTAKE_DEFAULT_INTERVAL_MINUTES, INTAKE_KINDS, INTAKE_KIND_WORD, INTAKE_MAX_INTERVAL_MINUTES, INTAKE_MIN_INTERVAL_MINUTES, INTAKE_SOURCE,
  WINDOW_OVERLAP_MS,
  type GitHubRepo, type IntakeEventLink, type IntakeKind, type IntakeOutcome, type IntakeOverview, type IntakePoll, type IntakeProject,
  type IntakeRead, type IntakeTimer, type IntakeTrigger, type IntakeWatch,
} from '../shared/intake';

/**
 * Issue intake: GitHub's opened, labelled, commented and CI-failed facts for
 * each project with a GitHub remote, read through the operator's own gh and
 * recorded as Control events a person triages.
 *
 * Polling, because nothing else is local. A webhook needs a public port, and
 * Wanigan opens none. So GitHub is asked: when the operator presses Check GitHub
 * now, and — only if they turned it on in Settings › Connections — on a timer
 * that runs while this app is running and at no other time. A laptop that is shut
 * or asleep is watching nothing, and the first poll after it says for how long.
 *
 * A poll is a row from the moment it fires, and its three facts stay apart.
 * Fired is the press or the tick. Ran is gh being invoked for the reads; a poll
 * that found no gh, or no GitHub remote, fired and never ran. Succeeded is every
 * read parsed and every new fact recorded, in one transaction with the row's end,
 * so a poll that failed recorded nothing and the next one reads its window again.
 * The partial unique index on unfinished rows is the claim: one running poll per
 * project, whoever fired it.
 *
 * Nothing here writes to GitHub. The reads are `gh issue list`, `gh run list` and
 * `gh api --method=GET`, built in src/shared/intake.ts as argv arrays; a failed
 * read is classified by asking `gh auth status`, never by parsing gh's prose; and
 * gh's own first line is kept beside Wanigan's sentence either way. A goal made
 * from one of these events changes nothing on GitHub either. The fleet halt does
 * not stop the timer, because nothing it records can start work: an event becomes
 * a goal only when a person presses Create goal.
 */

const READ_TIMEOUT = 30_000;
const AUTH_TIMEOUT = 10_000;
/** A comment body can run to 65 KB, and a hundred of them is a legitimate answer. */
const READ_MAX_BUFFER = 16 * 1024 * 1024;
const GIT_OPTS = { timeout: 8_000, maxBuffer: 1024 * 1024 };
const TICK_MS = 60_000;
/**
 * Longer than any poll can take — three git reads, three gh reads and a sign-in
 * check, each with its own timeout — so an unfinished row this old was left by a
 * process that stopped, not by one still working.
 */
const STALE_MS = 10 * 60_000;
/** Poll rows past this are pruned, except the newest success, which is where the next window starts. */
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_SENTENCE = 600;

const TIMER_ENABLED_KEY = 'intake_timer_enabled';
const TIMER_INTERVAL_KEY = 'intake_interval_minutes';

const NEVER_RAN = 'Wanigan stopped before this check ran — it quit or crashed — so GitHub was not read.';
const NEVER_FINISHED = 'Wanigan stopped while gh was reading — it quit or crashed — so nothing from this check was recorded.';
const BUSY = 'Another check of this project was still running, so this one did not start.';
const GH_MISSING = 'gh is not installed, or not on your shell PATH, so GitHub was not read. Install GitHub’s gh CLI and run `gh auth login`, then check again.';

const redact = redactCredentials;
let readTimeout = READ_TIMEOUT;
let changed: (() => void) | null = null;

/** Main's window sink, so a timed poll can tell an open Control view to read again. */
export function setIntakeChangedNotifier(fn: (() => void) | null): void {
  changed = fn;
}

function notify(): void {
  try { changed?.(); } catch { /* a closed window is not this poll's failure */ }
}

/* ── the timer's settings ──────────────────────────────────────────────── */

export function intakeTimer(): IntakeTimer {
  const minutes = Number(getSetting(TIMER_INTERVAL_KEY, String(INTAKE_DEFAULT_INTERVAL_MINUTES)));
  return {
    // Off unless the operator turned it on: a timer that reads GitHub with their
    // credentials is not something an upgrade decides for them.
    enabled: getSetting(TIMER_ENABLED_KEY, '0') === '1',
    intervalMinutes: Number.isInteger(minutes) && minutes >= INTAKE_MIN_INTERVAL_MINUTES && minutes <= INTAKE_MAX_INTERVAL_MINUTES
      ? minutes : INTAKE_DEFAULT_INTERVAL_MINUTES,
  };
}

/** Validated before anything is stored, and both keys land together or neither does. */
export function setIntakeTimer(input: unknown): IntakeTimer {
  const next = timerInput(input);
  db().transaction(() => {
    setSetting(TIMER_INTERVAL_KEY, String(next.intervalMinutes));
    setSetting(TIMER_ENABLED_KEY, next.enabled ? '1' : '0');
  })();
  return intakeTimer();
}

/* ── rows ──────────────────────────────────────────────────────────────── */

type PollRow = {
  id: string; project_id: string; fired_by: string; fired_at: number; ran_at: number | null; finished_at: number | null;
  outcome: string | null; reason: string | null; error: string | null; repo: string | null;
  since_at: number | null; until_at: number | null; lookback: number; interval_ms: number | null; gap_ms: number | null;
  facts_read: number; new_opened: number; new_labelled: number; new_commented: number; new_ci_failed: number; capped: string | null;
};

const OUTCOMES = new Set<IntakeOutcome>(['succeeded', 'failed', 'skipped']);

function toPoll(row: PollRow): IntakePoll {
  return {
    id: row.id, projectId: row.project_id, trigger: row.fired_by === 'timer' ? 'timer' : 'manual',
    firedAt: row.fired_at, ranAt: row.ran_at, finishedAt: row.finished_at,
    outcome: OUTCOMES.has(row.outcome as IntakeOutcome) ? row.outcome as IntakeOutcome : null,
    reason: row.reason, error: row.error, repo: row.repo, since: row.since_at, until: row.until_at, lookback: row.lookback === 1,
    intervalMs: row.interval_ms, gapMs: row.gap_ms, factsRead: row.facts_read,
    counts: { opened: row.new_opened, labelled: row.new_labelled, commented: row.new_commented, ci_failed: row.new_ci_failed },
    capped: row.capped,
  };
}

function pollById(id: string): IntakePoll {
  const row = db().prepare('SELECT * FROM intake_polls WHERE id=?').get(id) as PollRow | undefined;
  // The row cascades away with its project, which a removal mid-poll does.
  if (!row) throw new Error('That project was removed while its GitHub check ran, so nothing was recorded.');
  return toPoll(row);
}

function newestPoll(projectId: string, succeededOnly: boolean): IntakePoll | null {
  const row = db().prepare(`SELECT * FROM intake_polls WHERE project_id=? ${succeededOnly ? "AND outcome='succeeded'" : ''}
    ORDER BY fired_at DESC, rowid DESC LIMIT 1`).get(projectId) as PollRow | undefined;
  return row ? toPoll(row) : null;
}

function bounded(text: string | null | undefined): string | null {
  if (!text) return null;
  return text.length > MAX_SENTENCE ? `${text.slice(0, MAX_SENTENCE - 1)}…` : text;
}

const pollId = () => `poll_${randomUUID().slice(0, 12)}`;

/**
 * Close out polls a stopped process left unfinished. Failed rather than left
 * open: an open row blocks every later poll of the project, and a row that says
 * "running" for a week is the one state it certainly is not.
 */
function closeStale(now: number, projectId: string | null): void {
  db().prepare(`UPDATE intake_polls
       SET finished_at=?, outcome='failed', reason=CASE WHEN ran_at IS NULL THEN ? ELSE ? END
     WHERE finished_at IS NULL AND fired_at < ? AND (? IS NULL OR project_id=?)`)
    .run(now, NEVER_RAN, NEVER_FINISHED, now - STALE_MS, projectId, projectId);
}

function prune(projectId: string, now: number): void {
  db().prepare(`DELETE FROM intake_polls
     WHERE project_id=? AND finished_at IS NOT NULL AND fired_at < ?
       AND id <> COALESCE((SELECT id FROM intake_polls WHERE project_id=? AND outcome='succeeded' ORDER BY finished_at DESC LIMIT 1), '')`)
    .run(projectId, now - RETENTION_MS, projectId);
}

/**
 * The fire. One transaction: stale rows are closed first so a crash cannot
 * block the project for ever, then the running row is inserted. When another
 * poll of the project holds the claim, the fire is still recorded — as skipped,
 * finished the moment it fired — because a press that did nothing is a fact.
 */
function claim(projectId: string, firedBy: IntakeTrigger, firedAt: number, intervalMs: number | null): { id: string; busy: boolean } {
  const d = db();
  return d.transaction(() => {
    closeStale(firedAt, projectId);
    prune(projectId, firedAt);
    const id = pollId();
    const inserted = d.prepare('INSERT INTO intake_polls (id,project_id,fired_by,fired_at,interval_ms) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(id, projectId, firedBy, firedAt, intervalMs);
    if (inserted.changes > 0) return { id, busy: false };
    const skipped = pollId();
    d.prepare("INSERT INTO intake_polls (id,project_id,fired_by,fired_at,finished_at,outcome,reason,interval_ms) VALUES (?,?,?,?,?,'skipped',?,?)")
      .run(skipped, projectId, firedBy, firedAt, firedAt, BUSY, intervalMs);
    return { id: skipped, busy: true };
  })();
}

type Ending = { outcome: IntakeOutcome; reason?: string | null; error?: string | null; repo?: string | null };

/** First answer wins: a row already closed as stale is not reopened by a straggler. */
function end(id: string, ending: Ending): IntakePoll {
  db().prepare('UPDATE intake_polls SET finished_at=?, outcome=?, reason=?, error=?, repo=COALESCE(?, repo) WHERE id=? AND finished_at IS NULL')
    .run(Date.now(), ending.outcome, bounded(ending.reason), bounded(ending.error), ending.repo ?? null, id);
  return pollById(id);
}

/* ── which repository ──────────────────────────────────────────────────── */

type Resolution =
  | { kind: 'github'; repo: GitHubRepo; repoRoot: string }
  | { kind: 'unwatched'; detail: string; error: string | null; failed: boolean };

/**
 * What each project's remotes last resolved to, by folder. A poll always
 * resolves afresh and refreshes this; the overview and the timer's pass read it
 * within an age they choose. Without it, a project with no GitHub remote — which
 * never gets a poll row to make it "not due" — cost three git processes on every
 * one-minute tick for as long as the timer was on.
 */
const resolutions = new Map<string, { at: number; resolution: Resolution }>();
/** An overview re-read inside this reuses the answer: Control reads intake again whenever a poll ends. */
const OVERVIEW_RESOLVE_MS = 30_000;
/** Remote listings the overview runs at once, so thirty projects are not ninety git processes in one instant. */
const RESOLVE_CONCURRENCY = 4;

async function resolveCached(dir: string, maxAgeMs: number): Promise<Resolution> {
  const hit = resolutions.get(dir);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.resolution;
  return resolveRepository(dir);
}

/** From the repository's own remotes, read by git. No gh runs to decide whether a project is watched. */
async function resolveRepository(dir: string): Promise<Resolution> {
  const resolution = await readRemotes(dir);
  resolutions.set(dir, { at: Date.now(), resolution });
  return resolution;
}

async function readRemotes(dir: string): Promise<Resolution> {
  const scope = await scopeOf(dir);
  if (!scope) return { kind: 'unwatched', detail: 'This project is not a git repository, so it has no GitHub remote to watch.', error: null, failed: false };
  const remotes = await runGit(scope.repoRoot, ['remote', '-v'], GIT_OPTS);
  if (!remotes.ok) {
    return { kind: 'unwatched', detail: 'git could not list this repository’s remotes, so no GitHub repository was chosen.',
      error: firstLineOf(remotes.err, redact) || null, failed: true };
  }
  // Exit 1 with nothing printed is git saying no remote is marked, which is an answer.
  const marked = await runGit(scope.repoRoot, ['config', '--get-regexp', '^remote\\..*\\.gh-resolved$'], GIT_OPTS);
  const choice = chooseGitHubRemote(remotes.out, marked.ok ? ghResolvedBase(marked.out) : null);
  return choice.ok
    ? { kind: 'github', repo: choice.repo, repoRoot: scope.repoRoot }
    : { kind: 'unwatched', detail: choice.detail, error: null, failed: false };
}

function managedProject(projectId: unknown): { id: string; dir: string } {
  const project = typeof projectId === 'string' ? projectById(projectId) : undefined;
  if (!project) throw new Error('That project is not registered with Wanigan.');
  return { id: project.id, dir: assertManagedRoot(project.path, 'That project folder') };
}

/* ── one poll ──────────────────────────────────────────────────────────── */

/** gh's own first line. A read stopped at its timeout said nothing, and the reason sentence carries that instead. */
function ghSaid(r: GhRun): string | null {
  if (r.killed) return null;
  return firstLineOf(r.err, redact) || (r.code === null ? 'gh could not be run.' : `gh exited ${r.code} without saying why.`);
}

/**
 * Why a read failed, asked rather than read out of gh's prose. A timeout is not
 * a sign-in problem and is not asked about. Otherwise `gh auth status` for the
 * repository's host answers with its exit status; an auth check that itself could
 * not run or answer says nothing about sign-in, and the generic sentence stands.
 */
async function classifyFailure(bin: string, repoRoot: string, repo: GitHubRepo, what: string, r: GhRun): Promise<Ending> {
  const label = repoLabel(repoKey(repo));
  const error = ghSaid(r);
  if (r.killed) {
    const seconds = Math.max(1, Math.round(readTimeout / 1000));
    return { outcome: 'failed', error,
      reason: `gh did not answer about ${what} within ${seconds} second${seconds === 1 ? '' : 's'}, so it was stopped and nothing from this check was recorded.` };
  }
  const auth = await runGh(bin, repoRoot, ['auth', 'status', `--hostname=${repo.host}`], { timeout: AUTH_TIMEOUT });
  if (!auth.ok && !auth.killed && auth.code !== null) {
    return { outcome: 'failed', error,
      reason: `gh is not signed in to ${repo.host}, so ${label} could not be read and nothing from this check was recorded. Run \`gh auth login\` in your terminal, then check again.` };
  }
  return { outcome: 'failed', error, reason: `gh could not read ${what} of ${label}, so nothing from this check was recorded.` };
}

/**
 * Every new fact and the row's success, in one transaction. A fact already
 * recorded — by an earlier poll's overlapping window, or twice in this one — adds
 * nothing; addExternalEvent's unique key decides, not a read made beforehand.
 */
function record(id: string, projectId: string, reads: Array<Extract<IntakeRead, { read: 'ok' }>>): IntakePoll {
  const d = db();
  const counts: Record<IntakeKind, number> = { opened: 0, labelled: 0, commented: 0, ci_failed: 0 };
  let factsRead = 0;
  d.transaction(() => {
    const link = d.prepare('INSERT INTO intake_events (event_id,poll_id,kind,url,happened_at) VALUES (?,?,?,?,?)');
    for (const read of reads) {
      for (const fact of read.facts) {
        factsRead += 1;
        const event = addExternalEvent({ projectId, source: INTAKE_SOURCE, kind: INTAKE_KIND_WORD[fact.kind], summary: fact.summary, externalKey: fact.key });
        if (!event) continue;
        link.run(event.id, id, fact.kind, fact.url, fact.at);
        counts[fact.kind] += 1;
      }
    }
    const capped = reads.map((read) => read.capped).filter((text): text is string => !!text).join(' ') || null;
    d.prepare(`UPDATE intake_polls SET finished_at=?, outcome='succeeded', reason=NULL, error=NULL, facts_read=?,
        new_opened=?, new_labelled=?, new_commented=?, new_ci_failed=?, capped=? WHERE id=? AND finished_at IS NULL`)
      .run(Date.now(), factsRead, counts.opened, counts.labelled, counts.commented, counts.ci_failed, capped, id);
  })();
  return pollById(id);
}

async function work(id: string, project: { id: string; dir: string }, intervalMs: number | null): Promise<IntakePoll> {
  const resolved = await resolveRepository(project.dir);
  if (resolved.kind === 'unwatched') {
    return end(id, { outcome: resolved.failed ? 'failed' : 'skipped', reason: resolved.detail, error: resolved.error });
  }
  const { repo, repoRoot } = resolved;
  const key = repoKey(repo);
  const bin = await resolveGh();
  if (!bin) return end(id, { outcome: 'skipped', reason: GH_MISSING, repo: key });

  // The window starts where the last success for this same repository ended. A
  // project whose remote now names another repository starts over with a lookback.
  const previous = db().prepare(`SELECT until_at FROM intake_polls WHERE project_id=? AND outcome='succeeded' AND lower(repo)=lower(?)
    ORDER BY finished_at DESC LIMIT 1`).get(project.id, key) as { until_at: number | null } | undefined;
  const ranAt = Date.now();
  const { since, lookback } = pollWindow(previous?.until_at ?? null, ranAt);
  const gapMs = unwatchedMs({ since, until: ranAt, lookback, intervalMs });
  db().prepare('UPDATE intake_polls SET ran_at=?, repo=?, since_at=?, until_at=?, lookback=?, gap_ms=? WHERE id=?')
    .run(ranAt, key, since, ranAt, lookback ? 1 : 0, gapMs, id);

  const from = since - WINDOW_OVERLAP_MS;
  const opts = { timeout: readTimeout, maxBuffer: READ_MAX_BUFFER };
  const [issues, comments, runs] = await Promise.all([
    runGh(bin, repoRoot, issueArgs(repo, from), opts),
    runGh(bin, repoRoot, commentArgs(repo, from), opts),
    runGh(bin, repoRoot, runArgs(repo), opts),
  ]);
  const failed = ([['the open issues', issues], ['the issue comments', comments], ['the failed workflow runs', runs]] as const)
    .find(([, r]) => !r.ok);
  if (failed) return end(id, await classifyFailure(bin, repoRoot, repo, failed[0], failed[1]));

  const reads = [parseIssues(issues.out, repo, from, redact), parseComments(comments.out, repo, from, redact), parseRuns(runs.out, repo, from, redact)];
  const ok: Array<Extract<IntakeRead, { read: 'ok' }>> = [];
  for (const read of reads) {
    if (read.read === 'failed') return end(id, { outcome: 'failed', reason: read.detail });
    ok.push(read);
  }
  return record(id, project.id, ok);
}

async function runPoll(project: { id: string; dir: string }, firedBy: IntakeTrigger): Promise<IntakePoll> {
  const firedAt = Date.now();
  const timer = intakeTimer();
  const intervalMs = timer.enabled ? timer.intervalMinutes * 60_000 : null;
  const claimed = claim(project.id, firedBy, firedAt, intervalMs);
  try {
    if (claimed.busy) return pollById(claimed.id);
    try {
      return await work(claimed.id, project, intervalMs);
    } catch (error) {
      // Whatever went wrong, the row ends. A poll left running holds the claim
      // for ten minutes and reads as in progress the whole time.
      const message = error instanceof Error ? error.message : String(error);
      return end(claimed.id, { outcome: 'failed', reason: `Wanigan could not finish this check, so nothing from it was recorded: ${redact(message)}` });
    }
  } finally {
    notify();
  }
}

/** A press of Check GitHub now. Refused before any row is written for a project Wanigan does not manage. */
export async function checkGitHub(projectId: unknown): Promise<IntakePoll> {
  return runPoll(managedProject(projectId), 'manual');
}

/* ── the overview ──────────────────────────────────────────────────────── */

function eventLinks(limit = 200): IntakeEventLink[] {
  const rows = db().prepare(`SELECT i.event_id, i.poll_id, i.kind, i.url, i.happened_at FROM intake_events i
      JOIN control_events c ON c.id = i.event_id ORDER BY c.created_at DESC LIMIT ?`).all(limit) as Array<{
      event_id: string; poll_id: string | null; kind: string; url: string | null; happened_at: number | null;
    }>;
  return rows.filter((row) => (INTAKE_KINDS as readonly string[]).includes(row.kind)).map((row) => ({
    eventId: row.event_id, pollId: row.poll_id, kind: row.kind as IntakeKind, url: row.url, happenedAt: row.happened_at,
  }));
}

export async function intakeOverview(): Promise<IntakeOverview> {
  const readAt = Date.now();
  closeStale(readAt, null);
  const all = listProjects();
  const watches: IntakeWatch[] = new Array(all.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(RESOLVE_CONCURRENCY, all.length) }, async () => {
    while (next < all.length) {
      const index = next++;
      const resolution = await resolveCached(all[index].path, OVERVIEW_RESOLVE_MS);
      watches[index] = resolution.kind === 'github'
        ? { kind: 'github', repo: repoKey(resolution.repo), remote: resolution.repo.remote }
        : { kind: 'unwatched', detail: resolution.error ? `${resolution.detail} git said: ${resolution.error}` : resolution.detail };
    }
  }));
  const projects: IntakeProject[] = all.map((project, index) => ({
    projectId: project.id, projectName: project.name, watch: watches[index],
    last: newestPoll(project.id, false), lastSucceeded: newestPoll(project.id, true),
  }));
  return { timer: intakeTimer(), projects, events: eventLinks(), readAt };
}

/* ── the timer ─────────────────────────────────────────────────────────── */

let timer: NodeJS.Timeout | null = null;
let ticking = false;

/**
 * One pass: every project with a GitHub remote whose last poll, fired by
 * anything, is at least an interval old. Projects go one at a time, so a slow
 * repository delays the rest rather than multiplying GitHub requests; the setting
 * is read again between them, so turning the timer off stops the pass.
 */
export async function tickIntake(): Promise<number> {
  if (ticking || !intakeTimer().enabled) return 0;
  ticking = true;
  let polled = 0;
  try {
    for (const project of listProjects()) {
      const settings = intakeTimer();
      if (!settings.enabled) break;
      const intervalMs = settings.intervalMinutes * 60_000;
      const last = db().prepare('SELECT MAX(fired_at) AS at FROM intake_polls WHERE project_id=?').get(project.id) as { at: number | null };
      if (last.at !== null && Date.now() - last.at < intervalMs) continue;
      // Only projects with a GitHub remote are polled on the timer. A project that
      // has none says so in the Control view on every read, not in a row per tick,
      // and its remotes are asked again once an interval rather than every minute.
      if ((await resolveCached(project.path, intervalMs)).kind !== 'github') continue;
      try {
        await runPoll(managedProject(project.id), 'timer');
        polled += 1;
      } catch (error) {
        console.warn('[wanigan] a timed GitHub check could not be recorded:', error);
      }
    }
  } finally {
    ticking = false;
  }
  return polled;
}

/** Only while Wanigan is running: nothing here survives a quit, and nothing claims to. */
export function startIntakeTimer(): void {
  if (timer) return;
  const tick = () => { void tickIntake().catch((error) => console.warn('[wanigan] the GitHub intake tick failed:', error)); };
  timer = setInterval(tick, TICK_MS);
  tick();
}

export function stopIntakeTimer(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

/** Test seam: a hanging gh is proved in milliseconds rather than half a minute. */
export function setIntakeReadTimeoutForTest(ms: number | null): void {
  readTimeout = ms ?? READ_TIMEOUT;
}
