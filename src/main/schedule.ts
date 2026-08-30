import { db } from './db';
import { enqueue } from './queue';
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

export type ScheduleKind = 'headless' | 'session' | 'batch';

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
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad step in "${part}".`);
    let a = lo, b = hi;
    if (range !== '*') {
      const m = /^(\d+)(?:-(\d+))?$/.exec(range);
      if (!m) throw new Error(`Cannot read "${part}" as a cron field.`);
      a = Number(m[1]);
      b = m[2] !== undefined ? Number(m[2]) : (stepRaw ? hi : a);
    }
    // Day-of-week accepts 7 for Sunday, as vixie-cron does.
    if (i === 4) { if (a === 7) a = 0; if (b === 7) b = 0; }
    if (a < lo || b > hi || a > b) throw new Error(`"${part}" is outside ${lo}-${hi}.`);
    for (let v = a; v <= b; v += step) out.add(v);
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

  // Four years covers every 29 February a schedule can name.
  const limit = new Date(from).getFullYear() + 4;
  while (d.getFullYear() <= limit) {
    if (!mon.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue;
    }
    // vixie-cron: when both day fields are constrained, either matching counts.
    const domAll = dom.size === 31, dowAll = dow.size === 7;
    const dayOk = domAll && dowAll ? true
      : domAll ? dow.has(d.getDay())
      : dowAll ? dom.has(d.getDate())
      : dom.has(d.getDate()) || dow.has(d.getDay());
    if (!dayOk) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!hr.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
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
  return (db().prepare('SELECT * FROM schedules ORDER BY enabled DESC, next_at').all() as Row[]).map(toSchedule);
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

  const id = `sch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  db().prepare(`
    INSERT INTO schedules (id, name, cron, kind, payload_json, project_id, enabled, created_at, next_at)
    VALUES (?,?,?,?,?,?,1,?,?)
  `).run(id, input.name.trim(), input.cron.trim(), input.kind,
         JSON.stringify(input.payload ?? {}), input.projectId ?? null, Date.now(), next);
  return listSchedules().find((s) => s.id === id)!;
}

export function setScheduleEnabled(id: string, on: boolean): Schedule | null {
  const row = db().prepare('SELECT * FROM schedules WHERE id=?').get(id) as Row | undefined;
  if (!row) return null;
  // Re-arm from now rather than firing immediately for every tick missed
  // while it was off.
  const next = on ? nextFire(row.cron) : null;
  db().prepare('UPDATE schedules SET enabled=?, next_at=? WHERE id=?').run(on ? 1 : 0, next, id);
  return listSchedules().find((s) => s.id === id) ?? null;
}

export function deleteSchedule(id: string): boolean {
  const info = db().prepare('DELETE FROM schedules WHERE id=?').run(id);
  db().prepare('DELETE FROM schedule_runs WHERE schedule_id=?').run(id);
  return info.changes > 0;
}

export function scheduleHistory(id: string, limit = 30): { at: number; status: string; detail: string | null }[] {
  return db().prepare('SELECT at, status, detail FROM schedule_runs WHERE schedule_id=? ORDER BY at DESC LIMIT ?')
    .all(id, limit) as { at: number; status: string; detail: string | null }[];
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
    if (fired && onChange) onChange();
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
    // `next_at` is the durable compare-and-swap token. A second process that
    // read this same due row before the first transaction commits updates zero
    // rows and must not enqueue a duplicate.
    const claimed = d.prepare(`
      UPDATE schedules
         SET last_at=?, last_status='dispatching', last_detail=NULL, runs=runs+1, next_at=?
       WHERE id=? AND enabled=1 AND next_at=?
    `).run(now, next, s.id, row.next_at);
    if (claimed.changes !== 1) return false;

    let status = 'queued';
    let detail: string | null = null;
    try {
      enqueue(s.kind, label, {
        ...(s.payload as Record<string, unknown>),
        scheduleId: s.id,
        projectId: s.projectId,
      });
    } catch (error) {
      status = 'failed';
      detail = error instanceof Error ? error.message : String(error);
    }

    d.prepare('UPDATE schedules SET last_status=?, last_detail=? WHERE id=?')
      .run(status, detail, s.id);
    d.prepare('INSERT INTO schedule_runs (schedule_id, at, status, detail) VALUES (?,?,?,?)')
      .run(s.id, now, status, detail);
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
