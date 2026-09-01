import { db } from './db';
import { cancelQueued, enqueue } from './queue';
import { projectById } from './store';

/**
 * Durable schedules.
 *
 * Claude Code has three tiers of this already, and Wanigan is only worth
 * building the middle one. `/loop` fires while a session is open and expires
 * after seven days; cloud routines run without your machine but get a fresh
 * clone and no local files. The gap is a schedule that touches your real
 * working tree, survives a quit, and does not quietly delete itself after a
 * week — which is exactly the shape of a desktop app holding a SQLite file.
 *
 * So: no seven-day expiry here, on purpose. A forgotten schedule is bounded by
 * being visible and disableable rather than by dying on a timer.
 */

export type ScheduleKind = 'headless' | 'session' | 'batch' | 'scout';

/** The Scout owns this schedule through its dedicated privacy controls. It is
 * intentionally not a second editable row in the generic Schedules surface. */
export const IMPROVEMENT_SCOUT_SCHEDULE_ID = 'sch_improvement_scout_weekly';

export type Schedule = {
  id: string;
  name: string;
  cron: string;
  kind: ScheduleKind;
  payload: unknown;
  projectId: string | null;
  enabled: boolean;
  createdAt: number;
  nextAt: number | null;
  lastAt: number | null;
  lastStatus: string | null;
  lastDetail: string | null;
  runs: number;
  /** Human rendering of the cron. A bare expression is a schedule nobody audits. */
  describe: string;
};

/* ── cron ────────────────────────────────────────────────────────────────
   Five fields, local time, the same dialect Claude Code accepts: wildcards,
   values, steps, ranges and lists. Deliberately no `L`, `W`, `?` or name
   aliases — matching what the CLI supports means a schedule reads the same in
   both places, and a silently-different dialect is worse than a missing one.
   ──────────────────────────────────────────────────────────────────────── */

const BOUNDS: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

function parseField(raw: string, i: number): Set<number> {
  const [lo, hi] = BOUNDS[i];
  // Day-of-week accepts 7 for Sunday, as vixie-cron does, so 7 is a legal input
  // even though the values this returns are 0-6. The fold to 0 happens after
  // the range is expanded: doing it first inverts "5-7" into 5-0 and collapses
  // "0-7" to Sunday alone — both silently wrong rather than rejected.
  const inputHi = i === 4 ? 7 : hi;
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad step in "${part}".`);
    let a = lo, b = inputHi;
    if (range !== '*') {
      const m = /^(\d+)(?:-(\d+))?$/.exec(range);
      if (!m) throw new Error(`Cannot read "${part}" as a cron field.`);
      a = Number(m[1]);
      b = m[2] !== undefined ? Number(m[2]) : (stepRaw ? inputHi : a);
    }
    if (a < lo || b > inputHi || a > b) {
      throw new Error(`"${part}" is outside ${lo}-${hi}${i === 4 ? ' (7 also means Sunday)' : ''}.`);
    }
    for (let v = a; v <= b; v += step) out.add(i === 4 ? v % 7 : v);
  }
  return out;
}

export function parseCron(expr: string): Set<number>[] {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error('A cron expression needs five fields: minute hour day-of-month month day-of-week.');
  }
  return fields.map(parseField);
}

/** Next fire strictly after `from`, in local time. Null if it never matches. */
export function nextFire(expr: string, from: number = Date.now()): number | null {
  const [min, hr, dom, mon, dow] = parseCron(expr);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);

  /**
   * Move the cursor to a wall-clock hour, reporting whether the local clock
   * jumped over an hour this schedule matches.
   *
   * On a spring-forward day the named hour does not exist and setHours()
   * normalises silently past it, so a 02:xx schedule matched nothing and lost
   * the whole day instead of running late. `true` means the gap swallowed a
   * matching hour and the cursor now sits on the first instant that does exist.
   * Autumn's duplicated hour is untouched: that hour is real both times,
   * setHours() lands on it exactly, no gap is reported, and the forward-only
   * walk still yields exactly one fire.
   */
  const toHour = (hour: number): boolean => {
    const wanted = ((hour % 24) + 24) % 24;
    d.setHours(hour, 0, 0, 0);
    for (let h = wanted; h !== d.getHours(); h = (h + 1) % 24) if (hr.has(h)) return true;
    return false;
  };

  // Four years covers every 29 February a schedule can name.
  const limit = new Date(from).getFullYear() + 4;
  let gap = false;
  while (d.getFullYear() <= limit) {
    if (!mon.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1); gap = toHour(0); continue;
    }
    // vixie-cron: when both day fields are constrained, either matching counts.
    const domAll = dom.size === 31, dowAll = dow.size === 7;
    const dayOk = domAll && dowAll ? true
      : domAll ? dow.has(d.getDay())
      : dowAll ? dom.has(d.getDate())
      : dom.has(d.getDate()) || dow.has(d.getDay());
    if (!dayOk) { d.setDate(d.getDate() + 1); gap = toHour(0); continue; }
    // The matching hour exists nowhere on this day's clock. The instant the
    // clock jumped to is the earliest moment the operator could have meant, and
    // firing an hour late beats vanishing for the day with nothing recorded.
    if (gap) return d.getTime();
    if (!hr.has(d.getHours())) { gap = toHour(d.getHours() + 1); continue; }
    if (!min.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
    return d.getTime();
  }
  return null;
}

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A cron expression nobody can read is a schedule nobody can audit. */
export function describeCron(expr: string): string {
  try {
    const f = expr.trim().split(/\s+/);
    const [mi, hh, dm, mo, dw] = f;
    const every = (v: string) => v.startsWith('*/');
    if (every(mi) && hh === '*' && dm === '*' && mo === '*' && dw === '*') {
      return `every ${mi.slice(2)} minutes`;
    }
    if (mi === '0' && every(hh) && dm === '*' && mo === '*' && dw === '*') {
      return `every ${hh.slice(2)} hours, on the hour`;
    }
    const at = /^\d+$/.test(mi) && /^\d+$/.test(hh)
      ? `${String(hh).padStart(2, '0')}:${String(mi).padStart(2, '0')}` : null;
    if (at && dm === '*' && mo === '*' && dw === '*') return `every day at ${at}`;
    if (at && dm === '*' && mo === '*' && dw === '1-5') return `weekdays at ${at}`;
    if (at && dm === '*' && mo === '*' && /^\d$/.test(dw)) return `every ${DOW[Number(dw) % 7]} at ${at}`;
    if (mi === '0' && hh === '*' && dm === '*' && mo === '*' && dw === '*') return 'every hour, on the hour';
    return expr;
  } catch { return expr; }
}

/* ── storage ─────────────────────────────────────────────────────────── */

type Row = {
  id: string; name: string; cron: string; kind: string; payload_json: string;
  project_id: string | null; enabled: number; created_at: number;
  next_at: number | null; last_at: number | null;
  last_status: string | null; last_detail: string | null; runs: number;
};

function toSchedule(r: Row): Schedule {
  let payload: unknown = null;
  try { payload = JSON.parse(r.payload_json); } catch { /* keep null */ }
  return {
    id: r.id, name: r.name, cron: r.cron, kind: r.kind as ScheduleKind, payload,
    projectId: r.project_id, enabled: r.enabled === 1, createdAt: r.created_at,
    nextAt: r.next_at, lastAt: r.last_at, lastStatus: r.last_status,
    lastDetail: r.last_detail, runs: r.runs, describe: describeCron(r.cron),
  };
}

export function listSchedules(): Schedule[] {
  // Scout scheduling has separate source/network consent and evidence history;
  // showing its internal queue source here would offer controls that cannot
  // safely preserve those invariants. Its dashboard is the single owner.
  return (db().prepare("SELECT * FROM schedules WHERE kind != 'scout' ORDER BY enabled DESC, next_at").all() as Row[]).map(toSchedule);
}

export function createSchedule(input: {
  name: string; cron: string; kind: ScheduleKind; payload: unknown; projectId?: string | null;
}): Schedule {
  // Validate before storing: a schedule that cannot fire is worse than a
  // rejected one, because it sits in the list looking healthy.
  const next = nextFire(input.cron);
  if (next === null) {
    throw new Error(`"${input.cron}" never matches a real date — check the day-of-month and month fields.`);
  }
  if (!input.name.trim()) throw new Error('Give the schedule a name you will recognise in a week.');
  // 'session' stays in the stored shape because older builds wrote those rows
  // and the list has to read them back, but nothing may create another: no
  // runner is registered for the kind, so every fire enqueues an item that
  // waits on 'no runner registered' for ever while the schedule looks healthy.
  if (input.kind !== 'headless' && input.kind !== 'batch') {
    throw new Error(input.kind === 'session'
      ? 'Session schedules are not supported: nothing starts an unattended terminal, so each fire would wait in the queue for ever. A schedule may run headless work or a batch re-submission.'
      : 'AI Improvement Scout scheduling is controlled from the Scout dashboard; generic schedules may only run headless work or batches.');
  }

  const id = `sch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  db().prepare(`
    INSERT INTO schedules (id, name, cron, kind, payload_json, project_id, enabled, created_at, next_at)
    VALUES (?,?,?,?,?,?,1,?,?)
  `).run(id, input.name.trim(), input.cron.trim(), input.kind,
         JSON.stringify(input.payload ?? {}), input.projectId ?? null, Date.now(), next);
  return listSchedules().find((s) => s.id === id)!;
}

/** Fires this schedule has already spent that have not finished: waiting to
 *  start, or running right now. The queue stores the owning schedule in the
 *  payload, so this reads it back rather than keeping a second index of it. */
function pendingFireCount(scheduleId: string, kind: ScheduleKind): number {
  const rows = db().prepare("SELECT payload_json FROM queue WHERE kind=? AND state IN ('waiting','running')")
    .all(kind) as { payload_json: string }[];
  let n = 0;
  for (const row of rows) {
    let payload: unknown;
    try { payload = JSON.parse(row.payload_json); } catch { continue; }
    if (!payload || typeof payload !== 'object') continue;
    if ((payload as Record<string, unknown>).scheduleId === scheduleId) n++;
  }
  return n;
}

/**
 * Queue items this schedule has already spent, still waiting to start.
 *
 * `next_at` only governs the *next* fire, so disarming or deleting a schedule
 * leaves last night's fire sitting in the queue to launch an agent later — a
 * pause the operator did not get. Only waiting rows are touched: cancelQueued
 * refuses a running one, which belongs to whatever started it.
 */
function cancelPendingFires(scheduleId: string): number {
  const rows = db().prepare("SELECT id, payload_json FROM queue WHERE state='waiting'")
    .all() as { id: string; payload_json: string }[];
  let canceled = 0;
  for (const row of rows) {
    let payload: unknown;
    try { payload = JSON.parse(row.payload_json); } catch { continue; }
    if (!payload || typeof payload !== 'object') continue;
    if ((payload as Record<string, unknown>).scheduleId !== scheduleId) continue;
    if (cancelQueued(row.id)) canceled++;
  }
  return canceled;
}

export function setScheduleEnabled(id: string, on: boolean): Schedule | null {
  const row = db().prepare('SELECT * FROM schedules WHERE id=?').get(id) as Row | undefined;
  if (!row) return null;
  if (row.id === IMPROVEMENT_SCOUT_SCHEDULE_ID || row.kind === 'scout') {
    throw new Error('AI Improvement Scout scheduling is controlled from the Scout dashboard so its source and network permissions stay paired.');
  }
  // Re-arm from now rather than firing immediately for every tick missed
  // while it was off.
  const next = on ? nextFire(row.cron) : null;
  db().prepare('UPDATE schedules SET enabled=?, next_at=? WHERE id=?').run(on ? 1 : 0, next, id);
  if (!on) {
    const canceled = cancelPendingFires(id);
    // A cancellation the operator did not see is as opaque as the fire it
    // stopped, so it goes in the same history they read to audit the schedule.
    if (canceled) {
      db().prepare('INSERT INTO schedule_runs (schedule_id, at, status, detail) VALUES (?,?,?,?)')
        .run(id, Date.now(), 'canceled',
             `Paused — ${canceled} queued fire${canceled === 1 ? '' : 's'} cancelled before starting.`);
    }
  }
  return listSchedules().find((s) => s.id === id) ?? null;
}

export function deleteSchedule(id: string): boolean {
  const row = db().prepare('SELECT id,kind FROM schedules WHERE id=?').get(id) as { id: string; kind: string } | undefined;
  if (row && (row.id === IMPROVEMENT_SCOUT_SCHEDULE_ID || row.kind === 'scout')) {
    throw new Error('AI Improvement Scout scheduling is controlled from the Scout dashboard so its source and network permissions stay paired.');
  }
  // Before the row goes: a deleted schedule whose last fire is still queued
  // would launch an agent nothing in the app can any longer explain.
  cancelPendingFires(id);
  const info = db().prepare('DELETE FROM schedules WHERE id=?').run(id);
  db().prepare('DELETE FROM schedule_runs WHERE schedule_id=?').run(id);
  return info.changes > 0;
}

export function scheduleHistory(id: string, limit = 30): { at: number; status: string; detail: string | null }[] {
  // Clamped like every other renderer-supplied limit: a negative value is
  // "no limit" to SQLite, which is not what a caller asking for fewer means.
  const n = Math.min(Math.max(Math.trunc(limit) || 1, 1), 200);
  return db().prepare('SELECT at, status, detail FROM schedule_runs WHERE schedule_id=? ORDER BY at DESC LIMIT ?')
    .all(id, n) as { at: number; status: string; detail: string | null }[];
}

/* ── fires ───────────────────────────────────────────────────────────── */

/**
 * One spent fire, addressed by the rowid of its own history row.
 *
 * A `schedule_runs` row used to be written at dispatch and never touched
 * again, so a schedule whose work failed every night for a month still read
 * 'queued' — which the Schedules summary renders as "all clear". The history
 * row is the only audit an operator has of unattended work, so whatever
 * actually ran has to be able to write its outcome back onto it.
 *
 * The rowid is the link because there is nowhere better: `schedule_runs` has
 * no `run_id` column, and the run's name is a display string that a rename
 * breaks. It travels out in the queue payload and comes back in the run's own
 * config; see `claimFireForRun`.
 */
export type ScheduleFire = { scheduleId: string; fireId: number };

/** Statuses a fire can still move on from. Everything else is its last word. */
const OPEN_FIRE_STATUSES = "('queued','running')";

/**
 * Kinds something is actually registered to run.
 *
 * 'session' is the one that is not: no runner has ever been registered for it,
 * so a fire spent on one enqueues an item that waits on 'no runner registered'
 * for ever while the schedule reports a fresh dispatch and looks healthy.
 * createSchedule refuses the kind outright, but rows written by older builds
 * are still in people's databases and still come due.
 */
const DISPATCHABLE: ReadonlySet<ScheduleKind> = new Set<ScheduleKind>(['headless', 'batch', 'scout']);

/**
 * How long an unresolved fire waits before it is called unobserved.
 *
 * Matched to the queue's own retention for finished rows: past that the queue
 * item that could have explained this fire has been pruned, so nothing left in
 * the database can ever answer for it.
 */
const FIRE_UNOBSERVED_MS = 7 * 24 * 60 * 60_000;

/**
 * Carry a fire's status onto the schedule row the list reads.
 *
 * Only when this is still the schedule's most recent fire. A slow fan-out that
 * finishes after the next one was already dispatched must not overwrite the
 * newer fire's status with its own late answer.
 */
function touchSchedule(fire: ScheduleFire, status: string, detail: string | null): void {
  db().prepare(`
    UPDATE schedules SET last_status=?, last_detail=?
     WHERE id=? AND NOT EXISTS (SELECT 1 FROM schedule_runs WHERE schedule_id=? AND id>?)
  `).run(status, detail, fire.scheduleId, fire.scheduleId, fire.fireId);
}

/**
 * The fire a headless run being created right now was spent on, claimed so
 * that exactly one run can answer for it.
 *
 * The queue row that is dispatching a fire is 'running' for as long as the
 * runner it called has not returned, which is precisely the window in which
 * the run is being created — so the fire id it carries is readable from here
 * without a second index of in-flight work.
 *
 * Deliberately refuses an ambiguous match rather than guessing. Two schedules
 * dispatching the same prompt over the same repositories in the same instant
 * cannot be told apart from here, and filing one schedule's result under
 * another's name is a worse answer than filing none: reconcileFires() closes
 * an unclaimed fire out as unobserved, which is true.
 */
export function claimFireForRun(match: { prompt: string; projectIds: readonly string[] }): ScheduleFire | null {
  const prompt = match.prompt.trim();
  if (!prompt) return null;

  let rows: { payload_json: string }[];
  try {
    rows = db().prepare("SELECT payload_json FROM queue WHERE state='running' AND kind='headless'")
      .all() as { payload_json: string }[];
  } catch {
    // Reading the queue is how the link is found, never how the run is
    // launched. A busy or closed database costs the history row, not the work.
    return null;
  }

  const candidates: ScheduleFire[] = [];
  for (const row of rows) {
    let parsed: unknown;
    try { parsed = JSON.parse(row.payload_json); } catch { continue; }
    if (!parsed || typeof parsed !== 'object') continue;
    const payload = parsed as Record<string, unknown>;
    // A per-repo row already names the run it belongs to; only the fire itself
    // is still looking for one.
    if (typeof payload.runId === 'string' && payload.runId) continue;
    const scheduleId = typeof payload.scheduleId === 'string' ? payload.scheduleId : '';
    const fireId = typeof payload.scheduleFireId === 'number' ? payload.scheduleFireId : 0;
    if (!scheduleId || !Number.isInteger(fireId) || fireId <= 0) continue;
    if (typeof payload.prompt !== 'string' || payload.prompt.trim() !== prompt) continue;
    // A fire pinned to one repository can only have produced a run over that
    // one repository. An unpinned fire is matched on the prompt alone, because
    // what it expands to is decided outside this module.
    const pinned = typeof payload.projectId === 'string' && payload.projectId ? payload.projectId : null;
    if (pinned && (match.projectIds.length !== 1 || match.projectIds[0] !== pinned)) continue;
    candidates.push({ scheduleId, fireId });
  }
  if (candidates.length !== 1) return null;

  const fire = candidates[0];
  const claimed = db().prepare(
    "UPDATE schedule_runs SET status='running' WHERE id=? AND schedule_id=? AND status='queued'"
  ).run(fire.fireId, fire.scheduleId);
  if (!claimed.changes) return null;
  touchSchedule(fire, 'running', null);
  return fire;
}

/**
 * What the fire actually came to. First answer wins: a fire already closed out
 * as unobserved or cancelled is not reopened by a straggler.
 */
export function recordFireOutcome(
  fire: ScheduleFire,
  status: 'ok' | 'failed' | 'canceled' | 'unknown',
  detail: string,
): boolean {
  const changed = db().prepare(
    `UPDATE schedule_runs SET status=?, detail=? WHERE id=? AND schedule_id=? AND status IN ${OPEN_FIRE_STATUSES}`
  ).run(status, detail, fire.fireId, fire.scheduleId);
  if (!changed.changes) return false;
  touchSchedule(fire, status, detail);
  return true;
}

/**
 * Close out fires nothing is going to report on.
 *
 * The write-back from a finished fan-out covers the case where the work ran.
 * It cannot cover the cases where it never did: an enqueued item that failed
 * its retries, one cancelled before it started, and — the quiet one — a fire
 * whose dispatcher returned without any run claiming it, which is what a
 * refused or crashed start looks like from here.
 *
 * 'unknown' is used rather than 'ok' or 'failed' on purpose. Wanigan did not
 * see how these ended, and the whole point of this pass is to stop the absence
 * of an answer reading as a good one.
 */
function reconcileFires(now: number): number {
  const d = db();
  const open = d.prepare(`
    SELECT sr.id, sr.schedule_id, sr.at, sr.status, s.kind
      FROM schedule_runs sr LEFT JOIN schedules s ON s.id = sr.schedule_id
     WHERE sr.status IN ${OPEN_FIRE_STATUSES}
  `).all() as { id: number; schedule_id: string; at: number; status: string; kind: string | null }[];
  if (!open.length) return 0;

  // The LIKE is a cheap text filter that keeps this off every queue row ever
  // written; the payload is still parsed properly before anything is believed.
  const items = d.prepare(
    `SELECT state, error, payload_json FROM queue WHERE payload_json LIKE '%"scheduleFireId"%'`
  ).all() as { state: string; error: string | null; payload_json: string }[];
  const byFire = new Map<number, { state: string; error: string | null }>();
  for (const item of items) {
    let parsed: unknown;
    try { parsed = JSON.parse(item.payload_json); } catch { continue; }
    if (!parsed || typeof parsed !== 'object') continue;
    const fireId = (parsed as Record<string, unknown>).scheduleFireId;
    if (typeof fireId !== 'number' || !Number.isInteger(fireId)) continue;
    byFire.set(fireId, { state: item.state, error: item.error });
  }

  let closed = 0;
  for (const row of open) {
    const fire: ScheduleFire = { scheduleId: row.schedule_id, fireId: row.id };
    const item = byFire.get(row.id);
    if (!item) {
      // No queue row carries this fire id: it was written before fires were
      // linked, or its row has been pruned. Either way nothing is coming.
      if (now - row.at > FIRE_UNOBSERVED_MS && recordFireOutcome(fire, 'unknown',
        'Dispatched, but no outcome was ever recorded and the queue item is gone. Wanigan did not see how this fire ended.')) closed++;
      continue;
    }
    if (item.state === 'waiting' || item.state === 'running') continue;
    if (item.state === 'failed') {
      if (recordFireOutcome(fire, 'failed',
        item.error?.slice(0, 400) ?? 'The queued work failed and will not be retried.')) closed++;
      continue;
    }
    if (item.state === 'canceled') {
      if (recordFireOutcome(fire, 'canceled', 'Cancelled before it started.')) closed++;
      continue;
    }
    // 'done' — the dispatcher finished handing this fire on.
    if (row.status === 'running') continue; // a run holds it; its end writes the outcome
    if (row.kind === 'headless') {
      // A headless fire's real outcome is its fan-out's, and no run claimed
      // this one. Saying "dispatched" would be the same silence in nicer words.
      if (recordFireOutcome(fire, 'unknown',
        'Dispatched, but no fan-out reported back against this fire. Open the run list for what actually ran.')) closed++;
      continue;
    }
    // A batch or scout fire's own job is the hand-off, and it completed. The
    // work it started is tracked on the run it created, not here.
    if (recordFireOutcome(fire, 'ok',
      'Handed off without error — the work it started is tracked on its own run.')) closed++;
  }
  return closed;
}

/* ── the tick ────────────────────────────────────────────────────────── */

let timer: NodeJS.Timeout | null = null;
let ticking = false;

/**
 * One fire per due schedule, never one per interval missed.
 *
 * A laptop that was asleep for six hours has a schedule six hundred ticks
 * behind. Firing all of them would launch six hundred agents at once, which is
 * the failure mode that turns a convenience into an incident. Catching up once
 * is what a person means by "run it when I open the lid".
 */
export async function tickSchedules(onChange?: () => void): Promise<number> {
  if (ticking) return 0;
  ticking = true;
  let fired = 0;
  try {
    const now = Date.now();
    const due = db().prepare('SELECT * FROM schedules WHERE enabled=1 AND next_at IS NOT NULL AND next_at <= ?')
      .all(now) as Row[];

    for (const r of due) {
      if (claimAndQueue(r, now)) fired++;
    }

    // After the fires, never instead of them: a reconcile that threw would
    // otherwise be able to stop every schedule in the app from running.
    let resolved = 0;
    try {
      resolved = reconcileFires(now);
    } catch (error) {
      // Closing out a stale history row is bookkeeping about work that has
      // already happened. It must not take the tick down with it, and the next
      // tick tries again.
      console.warn('[wanigan] could not reconcile schedule fires:', error);
    }
    if ((fired || resolved) && onChange) onChange();
  } finally { ticking = false; }
  return fired;
}

/**
 * Advance a due schedule and insert its queue item in one SQLite transaction.
 *
 * The attended app and the launchd service intentionally tick the same table.
 * A read followed by an unconditional enqueue lets both see one due row and
 * both spend it. The conditional `next_at` update is the cross-process claim;
 * the transaction means a crash either leaves the fire entirely pending or
 * commits both the schedule history and exactly one queue row.
 */
function claimAndQueue(row: Row, now: number): boolean {
  const d = db();
  const s = toSchedule(row);
  const label = s.projectId
    ? `${projectById(s.projectId)?.name ?? s.projectId} · ${s.name}`
    : s.name;

  // Before the fire is spent, because spending it is the whole problem: an
  // item of this kind waits on 'no runner registered' for ever while the
  // schedule records a fresh dispatch and reads as healthy. Disabling it is
  // what turns a schedule that silently does nothing into one that says so.
  if (!DISPATCHABLE.has(s.kind)) {
    const detail = `Schedule disabled: nothing is registered to run a "${s.kind}" schedule, so every fire would wait in the queue for ever. Delete it, or create it again as a headless run or a batch.`;
    const disabled = d.prepare(`
      UPDATE schedules
         SET enabled=0, next_at=NULL, last_at=?, last_status='failed', last_detail=?
       WHERE id=? AND enabled=1 AND next_at=?
    `).run(now, detail, s.id, row.next_at);
    if (disabled.changes) {
      d.prepare('INSERT INTO schedule_runs (schedule_id, at, status, detail) VALUES (?,?,?,?)')
        .run(s.id, now, 'failed', detail);
    }
    return false;
  }

  let next: number | null;
  try {
    next = nextFire(s.cron, now);
  } catch (error) {
    // A manually-corrupted schedule must not spin and repeatedly attempt to
    // spend. Disable it with a durable history row so the operator can repair
    // the expression rather than discover it as a silent frozen queue.
    const detail = error instanceof Error ? error.message : String(error);
    const disabled = d.prepare(`
      UPDATE schedules
         SET enabled=0, next_at=NULL, last_at=?, last_status='failed', last_detail=?
       WHERE id=? AND enabled=1 AND next_at=?
    `).run(now, `Schedule disabled: ${detail}`, s.id, row.next_at);
    if (disabled.changes) {
      d.prepare('INSERT INTO schedule_runs (schedule_id, at, status, detail) VALUES (?,?,?,?)')
        .run(s.id, now, 'failed', `Schedule disabled: ${detail}`);
    }
    return false;
  }

  const fire = d.transaction(() => {
    // A schedule whose period is shorter than its own run duration would
    // otherwise enqueue on every tick and stack pending fires behind the one
    // still working. Skipping is honest and recorded; piling up is neither.
    // Inside the transaction, so a concurrent claim cannot slip past the check.
    const outstanding = pendingFireCount(s.id, s.kind);
    if (outstanding > 0) {
      const detail = `Skipped: the previous fire is still ${outstanding === 1 ? 'in the queue' : `in the queue (${outstanding} outstanding)`}. Runs are not stacked behind each other.`;
      const skipped = d.prepare(`
        UPDATE schedules
           SET last_at=?, last_status='skipped', last_detail=?, next_at=?
         WHERE id=? AND enabled=1 AND next_at=?
      `).run(now, detail, next, s.id, row.next_at);
      if (skipped.changes) {
        d.prepare('INSERT INTO schedule_runs (schedule_id, at, status, detail) VALUES (?,?,?,?)')
          .run(s.id, now, 'skipped', detail);
      }
      return false;
    }

    // `next_at` is the durable compare-and-swap token. A second process that
    // read this same due row before the first transaction commits updates zero
    // rows and must not enqueue a duplicate.
    const claimed = d.prepare(`
      UPDATE schedules
         SET last_at=?, last_status='dispatching', last_detail=NULL, runs=runs+1, next_at=?
       WHERE id=? AND enabled=1 AND next_at=?
    `).run(now, next, s.id, row.next_at);
    if (claimed.changes !== 1) return false;

    // The history row goes in before the queue item, not after, so the item can
    // carry the fire's rowid out with it. That id is what lets whatever runs
    // come back and say how this fire ended; without it a dispatched fire has
    // no name anything else can address, and 'queued' is the last word it ever
    // gets. Both writes are in this transaction, so a crash between them
    // cannot leave an item nobody can attribute or a fire nobody dispatched.
    const fireId = Number(
      d.prepare('INSERT INTO schedule_runs (schedule_id, at, status, detail) VALUES (?,?,?,?)')
        .run(s.id, now, 'queued', null).lastInsertRowid
    );

    let status = 'queued';
    let detail: string | null = null;
    try {
      enqueue(s.kind, label, {
        ...(s.payload as Record<string, unknown>),
        scheduleId: s.id,
        scheduleFireId: fireId,
        projectId: s.projectId,
      });
    } catch (error) {
      status = 'failed';
      detail = error instanceof Error ? error.message : String(error);
    }

    d.prepare('UPDATE schedules SET last_status=?, last_detail=? WHERE id=?')
      .run(status, detail, s.id);
    d.prepare('UPDATE schedule_runs SET status=?, detail=? WHERE id=?')
      .run(status, detail, fireId);
    return status === 'queued';
  });

  return fire();
}

/**
 * Test-only access to the cross-process race boundary. Two scheduler processes
 * can each retain the same Row returned by their initial due query; exercising
 * that stale snapshot twice verifies the durable `next_at` compare-and-swap,
 * which the single-process `ticking` guard cannot cover.
 */
export const __test = { claimDueSnapshot: claimAndQueue };

export function startScheduler(onChange?: () => void) {
  if (timer) return;
  // Re-arm anything left with no next fire — a quit mid-tick, or a schedule
  // created by a build that crashed before it computed one.
  for (const s of listSchedules()) {
    if (s.enabled && s.nextAt === null) {
      const n = nextFire(s.cron);
      if (n) db().prepare('UPDATE schedules SET next_at=? WHERE id=?').run(n, s.id);
    }
  }
  timer = setInterval(() => { void tickSchedules(onChange).catch(() => {}); }, 20_000);
  void tickSchedules(onChange).catch(() => {});
}

export function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
