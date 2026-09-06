import type http from 'node:http';
import { listSchedules, setScheduleEnabled } from '../schedule';
import type { Schedule } from '../schedule';
import { projectById } from '../store';
import { json, registerApiRoute, requestJson } from './dispatch';
import { safeString } from './snapshot';

/**
 * What this Mac starts on a timer, and the one write a paired device may make
 * against it: pause, or resume.
 *
 * A schedule is the only work in Wanigan that runs with nobody at the keyboard,
 * which makes it the thing an operator away from the desk most needs to be able
 * to stop. Everything else the phone can reach is already attended — a session
 * has a terminal, a run has a person who started it — so this is the one screen
 * whose absence meant walking home to switch something off.
 *
 * Two routes on one path, with two different scopes, on purpose. Reading is
 * 'monitor': a schedule exists whether or not remote control is on, and a
 * monitor that could not say what the Mac will do at 03:00 is a monitor with a
 * hole in it. Pausing is 'control' and POST, so the dispatcher's remote-control
 * opt-in refuses it outright when the operator has not enabled that, and the
 * shared twenty-writes-a-minute window applies to it exactly as it applies to
 * starting an agent. There is deliberately no third path: a write that reached
 * the scheduler without passing those two gates would be a write the operator
 * never consented to, arriving from a device they may have left on a train.
 *
 * Editing and deleting are absent, and that is a decision rather than an
 * unfinished build. A cron expression is edited against a working tree and a
 * prompt the phone does not show, and deleting a schedule throws away the run
 * history that is the only audit of unattended work there is. Pausing is
 * reversible from the same button; those two are not.
 */

/** A cap, because the response is built in memory and shipped over a radio. */
const MAX_SCHEDULES = 100;

/**
 * What the phone is told when the schedule records will not open. It names the
 * two facts the page cannot establish on its own — the Mac was reached, and
 * nothing was written — rather than restating the failure the page is already
 * printing above it.
 */
const READ_FAILED = 'The Mac answered, but its record of the schedules would not open. Nothing has been changed.';

/**
 * How the last fire ended, as a closed set the page can render.
 *
 * 'never' is separate from every other value and separate from 'ok' in
 * particular. A schedule that has not fired yet and a schedule whose last fire
 * succeeded are different facts about the Mac, and a wire shape that let them
 * collapse into one — an absent field, an empty string, a zero — would let the
 * phone print "all clear" over a schedule nothing has ever proved works.
 *
 * 'unknown' is the other value that must not be smoothed away. `reconcileFires`
 * in ../schedule writes it when a fire was dispatched and nothing ever reported
 * back, and it means precisely that: Wanigan did not see how this ended. It is
 * neither a success nor a failure and it must not be rendered as either.
 */
export type MobileScheduleOutcome =
  | 'never' | 'pending' | 'ok' | 'failed' | 'skipped' | 'canceled' | 'unknown';

export type MobileScheduleLastFire = {
  outcome: MobileScheduleOutcome;
  /** When the fire was spent, or null when there has not been one. */
  at: number | null;
  /** Wanigan's own stored explanation of the outcome, bounded. */
  detail: string | null;
};

export type MobileSchedule = {
  id: string;
  name: string;
  /** 'session' rows exist only in databases older builds wrote; nothing runs them. */
  kind: 'headless' | 'batch' | 'session' | 'other';
  /** The cron in English, which is ../schedule's own rendering of it. */
  describe: string;
  /** The expression itself, so a schedule nobody can read in English is still auditable. */
  cron: string;
  paused: boolean;
  /** Null while paused — a paused schedule has no armed next fire at all. */
  nextAt: number | null;
  /** Where the work lands. `unstated` is a headless row that pinned nothing and declared nothing. */
  scope: 'project' | 'all-projects' | 'unstated';
  /** The repository's name, never its path. Null when the project row is gone. */
  projectName: string | null;
  /** Fires dispatched over this schedule's life. */
  fires: number;
  last: MobileScheduleLastFire;
};

/**
 * The stored statuses, mapped onto what the phone is allowed to claim.
 *
 * A Map rather than an object literal for the same reason ./control keys its
 * key table that way: a status read out of a row is a string, and `toString` or
 * `constructor` resolving to something inherited from Object.prototype would be
 * a lookup hit that never came from this table. Anything not named here becomes
 * 'unknown', which is the honest answer for a status a later build introduced
 * and this one has never been taught to read — the one thing it must never
 * become is 'ok'.
 */
const FIRE_OUTCOMES = new Map<string, MobileScheduleOutcome>([
  ['queued', 'pending'],
  ['dispatching', 'pending'],
  ['running', 'pending'],
  ['ok', 'ok'],
  ['failed', 'failed'],
  ['skipped', 'skipped'],
  ['canceled', 'canceled'],
  ['unknown', 'unknown'],
]);

/**
 * Narrowed rather than cast. `ScheduleKind` also contains 'scout', which
 * `listSchedules` never returns because the Improvement Scout owns its own
 * schedule alongside its source and network consent — and a widening cast here
 * would have compiled while quietly promising the page a kind it will never be
 * handed and no branch draws.
 */
function wireKind(kind: string): MobileSchedule['kind'] {
  return kind === 'headless' || kind === 'batch' || kind === 'session' ? kind : 'other';
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The last fire, read from the schedule row rather than from the newest history
 * row — which is the trap this function exists to avoid.
 *
 * `schedule_runs` is not a list of fires. ../schedule also writes 'edited' rows
 * when a schedule is changed and 'canceled' rows when pausing cancels queued
 * work, so the most recent history row for a schedule that has never fired can
 * easily be an edit. Reading that row would have the phone announcing an
 * outcome for a schedule nothing has ever run. `last_status` and `last_at` on
 * the schedule row are touched only by a fire and by the two paths that disable
 * a schedule outright, so they are the fire-shaped record, and `touchSchedule`
 * already refuses to let a late answer overwrite a newer fire's.
 */
function lastFire(schedule: Schedule): MobileScheduleLastFire {
  const at = finiteOrNull(schedule.lastAt);
  const status = safeString(schedule.lastStatus, 40);
  if (at === null && !status) return { outcome: 'never', at: null, detail: null };
  return {
    outcome: FIRE_OUTCOMES.get(status) ?? 'unknown',
    at,
    detail: safeString(schedule.lastDetail, 300) || null,
  };
}

/**
 * Which repositories the fire touches, named rather than located.
 *
 * ../mobile/snapshot.ts already lets a project's name cross for a session, and
 * a schedule with no repository on it is unreadable — "every day at 03:00" over
 * which working tree? The path stays behind, as it does everywhere else: a name
 * identifies the work to the person who created it, and a path identifies the
 * machine to anyone who intercepts it.
 */
function scopeOf(schedule: Schedule): Pick<MobileSchedule, 'scope' | 'projectName'> {
  if (schedule.projectId) {
    const project = projectById(schedule.projectId);
    return { scope: 'project', projectName: safeString(project?.name, 160) || null };
  }
  const payload = schedule.payload;
  const declared = !!payload && typeof payload === 'object'
    && (payload as { allProjects?: unknown }).allProjects === true;
  return { scope: declared ? 'all-projects' : 'unstated', projectName: null };
}

/**
 * Rebuilt field by field, like every other response that leaves this process.
 * The prompt a headless schedule carries is deliberately not among the fields:
 * it is the operator's instruction text, the page has no use for it beyond
 * decoration, and the narrow wire is the promise the mobile boundary makes.
 */
function wireSchedule(schedule: Schedule): MobileSchedule {
  const cron = safeString(schedule.cron, 120);
  return {
    id: safeString(schedule.id, 120),
    name: safeString(schedule.name, 160, 'Unnamed schedule'),
    kind: wireKind(schedule.kind),
    describe: safeString(schedule.describe, 160) || cron,
    cron,
    paused: schedule.enabled !== true,
    nextAt: finiteOrNull(schedule.nextAt),
    ...scopeOf(schedule),
    fires: Math.max(0, Math.round(Number(schedule.runs) || 0)),
    last: lastFire(schedule),
  };
}

function serveSchedules(res: http.ServerResponse): void {
  try {
    json(res, 200, {
      generatedAt: Date.now(),
      schedules: listSchedules().slice(0, MAX_SCHEDULES).map(wireSchedule),
    });
  } catch {
    // A database error can carry a local path or a table name, so it does not
    // travel. What does travel is the part the page cannot work out for itself:
    // the Mac was reached and nothing was changed. The page's own failure box
    // already says the read failed, and a message repeating that sentence back
    // was two lines of screen saying one thing.
    json(res, 503, { error: READ_FAILED });
  }
}

/**
 * Pause or resume one schedule.
 *
 * The id arrives from a browser and is untrusted until this process has agreed
 * on it, so it is matched against `listSchedules()` — the same list the device
 * was actually shown — before anything is written. That is not only a guard
 * against a malformed string: `listSchedules` deliberately omits the Improvement
 * Scout's row, whose schedule is owned by the Scout dashboard so its source and
 * network consent stay paired with it, and a membership test against that list
 * is what keeps this route from reaching a schedule the phone was never offered.
 * The refusal says so in those terms rather than claiming the id does not
 * exist, because for the Scout row that would be false.
 *
 * The write itself is ../schedule's `setScheduleEnabled` and never SQL of this
 * module's own. That function re-arms `next_at` from now rather than replaying
 * every tick missed while the schedule was off, cancels the fires this schedule
 * already spent that are still waiting in the queue, and records that
 * cancellation in the same history the operator audits. A second implementation
 * here would be a second set of those rules, and the one that ran unattended
 * would be the one nobody read.
 */
async function servePause(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await requestJson(req, 2_048);
  const action = typeof body?.action === 'string' ? body.action : '';
  if (action !== 'pause' && action !== 'resume') {
    json(res, 400, { error: 'Choose pause or resume.' });
    return;
  }
  const id = safeString(body?.id, 120);
  if (!id) { json(res, 400, { error: 'Choose a schedule.' }); return; }

  let known: Schedule | undefined;
  try {
    known = listSchedules().find((schedule) => schedule.id === id);
  } catch {
    json(res, 503, { error: READ_FAILED });
    return;
  }
  if (!known) {
    json(res, 404, { error: 'That is not a schedule this device can pause.' });
    return;
  }

  try {
    const updated = setScheduleEnabled(id, action === 'resume');
    if (!updated) {
      // The row was there a moment ago and is not now — deleted at the Mac
      // between the read and the write. Nothing was changed, and saying so
      // beats reporting a success against a schedule that no longer exists.
      json(res, 404, { error: 'That schedule is no longer on this Mac.' });
      return;
    }
    json(res, 200, { ok: true, schedule: wireSchedule(updated) });
  } catch (error) {
    json(res, 400, {
      error: safeString(error instanceof Error ? error.message : String(error), 240,
        'Wanigan refused that change.'),
    });
  }
}

registerApiRoute({
  path: '/api/schedules',
  method: 'GET',
  scope: 'monitor',
  handler: (_req, res) => serveSchedules(res),
});

registerApiRoute({
  path: '/api/schedules',
  method: 'POST',
  scope: 'control',
  handler: (req, res) => servePause(req, res),
});
