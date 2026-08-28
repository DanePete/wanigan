import { db } from './db';
import type { BudgetState, Reconciliation } from '../shared/types';

/**
 * One spend model over three surfaces — and two meters.
 *
 * Interactive sessions and headless runs report their own cost: the Claude Code
 * CLI computes it and Wanigan banks the number it is handed. Batch runs are
 * priced here in Wanigan, by multiplying the token counts the Batches API
 * returned against the local table in batch/pricing.ts. Those are different
 * instruments measuring different things and they will not agree to the cent —
 * a model newer than the pricing table falls back to a default rate, and the
 * CLI's own figure covers turns Wanigan never sees a token count for.
 *
 * So every function here that mixes them keeps the split visible in its return
 * shape rather than handing back a single total and calling it the bill. A
 * chart that implies one authority over two meters is a chart that lies
 * quietly, and the lie is only found months later, against an invoice.
 *
 * Two different splits appear below, on purpose:
 *   - by SURFACE (sessions / batches / headless) — unifiedSpend, spendBySurface,
 *     effortDistribution, unifiedCacheRate. This is "where the work happened".
 *   - by METER (CLI-reported / Wanigan-priced) — spendByProject, BudgetState.
 *     Headless sits with sessions there, because both of those numbers come
 *     from the CLI's own accounting and only the batch column is arithmetic
 *     Wanigan did itself.
 *
 * Nothing here imports otel.ts. The telemetry collector may never have started
 * — it is a setting the user can switch off — but the tables it writes are
 * still on disk and still readable. Reporting on money already spent must not
 * depend on a receiver being up.
 */

const DEFAULT_DAYS = 30;

/** Guards against a ten-year scan built out of one bad renderer input. */
function windowDays(days?: number): number {
  const n = Math.floor(Number(days ?? DEFAULT_DAYS));
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return Math.max(1, Math.min(365, n));
}

function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Local midnight, n-1 days back. Everything below buckets in local time: an
 * evening's work grouped on UTC files under tomorrow for anyone west of
 * Greenwich, and the chart then disagrees with the clock on the same wall.
 */
function windowStart(n: number): Date {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (n - 1));
  return start;
}

/** Every day in the window, so a chart gets a continuous axis, not a compressed one. */
function daySeries(n: number): string[] {
  const cur = windowStart(n);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(dayKey(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

const localDay = (expr: string) => `date(${expr} / 1000, 'unixepoch', 'localtime')`;

/**
 * When a run's money is booked. A batch submitted on Monday and collected on
 * Tuesday cost nothing until its results came back, so filing it under
 * created_at would put the charge on a day the account was never billed for.
 */
const runAt = (t: string) => `COALESCE(${t}.ended_at, ${t}.submitted_at, ${t}.created_at)`;
/** A headless row's own clock — a fan-out's runs row only ends when its last repo does. */
const hlAt = (t: string) => `COALESCE(${t}.ended_at, ${t}.started_at)`;

const UNATTRIBUTED_NAME = 'Unattributed';

type DayUsd = { day: string; usd: number };

function sessionUsdByDay(sinceMs: number): Map<string, number> {
  const rows = db().prepare(`
    SELECT ${localDay('at')} AS day, COALESCE(SUM(cost_usd), 0) AS usd
    FROM session_api_events WHERE at >= ? GROUP BY day
  `).all(sinceMs) as DayUsd[];
  return new Map(rows.map((r) => [r.day, r.usd]));
}

function batchUsdByDay(sinceMs: number): Map<string, number> {
  const rows = db().prepare(`
    SELECT ${localDay(runAt('r'))} AS day, COALESCE(SUM(r.cost_usd), 0) AS usd
    FROM runs r WHERE r.kind = 'batch' AND ${runAt('r')} >= ? GROUP BY day
  `).all(sinceMs) as DayUsd[];
  return new Map(rows.map((r) => [r.day, r.usd]));
}

/**
 * Headless spend is read off headless_rows rather than the parent run: the
 * run's cost_usd is only ever the sum of its rows, and the rows carry both the
 * project and the finishing time that per-project and per-day attribution need.
 */
function headlessUsdByDay(sinceMs: number): Map<string, number> {
  const rows = db().prepare(`
    SELECT ${localDay(hlAt('h'))} AS day, COALESCE(SUM(h.cost_usd), 0) AS usd
    FROM headless_rows h
    WHERE ${hlAt('h')} IS NOT NULL AND ${hlAt('h')} >= ? GROUP BY day
  `).all(sinceMs) as DayUsd[];
  return new Map(rows.map((r) => [r.day, r.usd]));
}

/**
 * The whole bill on one axis, oldest day first: interactive sessions, bulk
 * batch runs and headless fan-outs as three separate series.
 *
 * They stay three series and are never pre-summed here. sessionUsd and
 * headlessUsd are the CLI's own numbers; batchUsd is Wanigan's arithmetic over
 * the local pricing table. A caller is free to stack them into one total, but
 * it does so knowing it has added two meters together.
 */
export function unifiedSpend(
  days?: number
): { day: string; sessionUsd: number; batchUsd: number; headlessUsd: number }[] {
  const n = windowDays(days);
  const since = windowStart(n).getTime();
  const s = sessionUsdByDay(since);
  const b = batchUsdByDay(since);
  const h = headlessUsdByDay(since);

  return daySeries(n).map((day) => ({
    day,
    sessionUsd: s.get(day) ?? 0,
    batchUsd: b.get(day) ?? 0,
    headlessUsd: h.get(day) ?? 0,
  }));
}

/* ── per project ──────────────────────────────────────────────────────── */

export type ProjectSpend = {
  projectId: string | null;
  projectName: string;
  sessionUsd: number;
  batchUsd: number;
  total: number;
};

/**
 * Spend per repo, dearest first.
 *
 * Split by meter, not by surface: `sessionUsd` is everything the CLI billed for
 * itself in this project — interactive sessions AND headless runs — and
 * `batchUsd` is what Wanigan priced from token counts. `total` is exactly their
 * sum, so the column Wanigan computed stays separable from the column it was
 * handed.
 *
 * Spend that cannot be attributed to a project lands under a null id rather
 * than being dropped. A session started before its repo was added to the
 * project list, or telemetry that arrived without Wanigan's resource
 * attribute, is still money.
 */
export function spendByProject(days?: number): ProjectSpend[] {
  const n = windowDays(days);
  const since = windowStart(n).getTime();
  const d = db();

  const acc = new Map<string, ProjectSpend>();
  /** Project ids are always `prj_…`, so this cannot collide with a real one. */
  const NO_PROJECT = '(no project)';

  const bucket = (id: string | null, name: string): ProjectSpend => {
    const key = id ?? NO_PROJECT;
    let row = acc.get(key);
    if (!row) {
      row = { projectId: id, projectName: name, sessionUsd: 0, batchUsd: 0, total: 0 };
      acc.set(key, row);
    }
    // Batch runs know only a project id. If a session in the same repo supplied
    // a real name, keep it rather than leaving the row labelled with the id.
    if (row.projectName !== name && (row.projectName === UNATTRIBUTED_NAME || row.projectName === id)) {
      row.projectName = name;
    }
    return row;
  };

  // session_log is the durable record of which repo a session ran in, and it
  // keeps project_name so a since-removed project still reads as a name.
  const sessions = d.prepare(`
    SELECT s.project_id AS pid,
           COALESCE(p.name, s.project_name) AS pname,
           COALESCE(SUM(e.cost_usd), 0) AS usd
    FROM session_api_events e
    LEFT JOIN session_log s ON s.id = e.session_id
    LEFT JOIN projects    p ON p.id = s.project_id
    WHERE e.at >= ?
    GROUP BY s.project_id, pname
  `).all(since) as { pid: string | null; pname: string | null; usd: number }[];

  for (const r of sessions) bucket(r.pid, r.pname || UNATTRIBUTED_NAME).sessionUsd += r.usd;

  const headless = d.prepare(`
    SELECT h.project_id AS pid,
           COALESCE(p.name, h.project_name) AS pname,
           COALESCE(SUM(h.cost_usd), 0) AS usd
    FROM headless_rows h
    LEFT JOIN projects p ON p.id = h.project_id
    WHERE ${hlAt('h')} IS NOT NULL AND ${hlAt('h')} >= ?
    GROUP BY h.project_id, pname
  `).all(since) as { pid: string | null; pname: string | null; usd: number }[];

  for (const r of headless) bucket(r.pid, r.pname || UNATTRIBUTED_NAME).sessionUsd += r.usd;

  const batches = d.prepare(`
    SELECT r.project_id AS pid, p.name AS pname, COALESCE(SUM(r.cost_usd), 0) AS usd
    FROM runs r
    LEFT JOIN projects p ON p.id = r.project_id
    WHERE r.kind = 'batch' AND ${runAt('r')} >= ?
    GROUP BY r.project_id, pname
  `).all(since) as { pid: string | null; pname: string | null; usd: number }[];

  for (const r of batches) {
    bucket(r.pid, r.pname || r.pid || UNATTRIBUTED_NAME).batchUsd += r.usd;
  }

  const out = [...acc.values()];
  for (const r of out) r.total = r.sessionUsd + r.batchUsd;
  return out.sort((a, b) => b.total - a.total);
}

/* ── per surface ──────────────────────────────────────────────────────── */

/**
 * The two-speeds premise as a number: what interactive work cost against what
 * bulk work cost, and how many units of each bought it.
 *
 * `requests` does not mean the same thing on all three rows and cannot be made
 * to. A session request is one API turn. A batch request is one row of the
 * dataset. A headless request is one agent run over one repo — the CLI reports
 * a total cost for a run and never a turn count, so there is no honest per-turn
 * number to give. Compare the costs across rows; do not derive a cross-surface
 * cost-per-request from this.
 */
export function spendBySurface(
  days?: number
): { surface: 'sessions' | 'batches' | 'headless'; costUsd: number; requests: number }[] {
  const n = windowDays(days);
  const since = windowStart(n).getTime();
  const d = db();

  const s = d.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS usd,
           COALESCE(SUM(CASE WHEN kind = 'request' THEN 1 ELSE 0 END), 0) AS n
    FROM session_api_events WHERE at >= ?
  `).get(since) as { usd: number; n: number };

  const b = d.prepare(`
    SELECT COALESCE(SUM(r.cost_usd), 0) AS usd, COALESCE(SUM(r.total_requests), 0) AS n
    FROM runs r WHERE r.kind = 'batch' AND ${runAt('r')} >= ?
  `).get(since) as { usd: number; n: number };

  const h = d.prepare(`
    SELECT COALESCE(SUM(h.cost_usd), 0) AS usd, COUNT(*) AS n
    FROM headless_rows h WHERE ${hlAt('h')} IS NOT NULL AND ${hlAt('h')} >= ?
  `).get(since) as { usd: number; n: number };

  return [
    { surface: 'sessions', costUsd: s.usd, requests: s.n },
    { surface: 'batches', costUsd: b.usd, requests: b.n },
    { surface: 'headless', costUsd: h.usd, requests: h.n },
  ];
}

/* ── effort ───────────────────────────────────────────────────────────── */

/**
 * The effort level a run was configured with. config_json is the run's own
 * definition, so one that will not parse or names no effort is not a corrupt
 * row — it is a run from before the field existed, which is what 'default'
 * says.
 */
function effortOf(configJson: string): string {
  try {
    const cfg = JSON.parse(configJson) as { effort?: unknown };
    const e = typeof cfg.effort === 'string' ? cfg.effort.trim() : '';
    return e || 'default';
  } catch {
    return 'default';
  }
}

/**
 * What each effort level costs, on each surface, dearest first.
 *
 * `surface` rides on every row rather than being aggregated away because the
 * two halves are measured differently. The session rows read effort off the
 * same api_request event that carried the cost, so the pair comes from one
 * record. The batch and headless rows read it out of the run's stored config,
 * which is what the run was *asked* for — the API is free to have done
 * something else. Summing across surfaces would blend those two claims.
 */
export function effortDistribution(
  days?: number
): { effort: string; requests: number; costUsd: number; surface: string }[] {
  const n = windowDays(days);
  const since = windowStart(n).getTime();
  const d = db();

  const out: { effort: string; requests: number; costUsd: number; surface: string }[] = [];

  const sessions = d.prepare(`
    SELECT COALESCE(NULLIF(effort, ''), 'default') AS effort,
           COUNT(*) AS requests, COALESCE(SUM(cost_usd), 0) AS cost
    FROM session_api_events WHERE kind = 'request' AND at >= ?
    GROUP BY effort
  `).all(since) as { effort: string; requests: number; cost: number }[];

  for (const r of sessions) {
    out.push({ effort: r.effort, requests: r.requests, costUsd: r.cost, surface: 'sessions' });
  }

  const runs = d.prepare(`
    SELECT r.kind AS kind, r.config_json AS config_json,
           r.total_requests AS total_requests, r.cost_usd AS cost_usd
    FROM runs r
    WHERE r.kind IN ('batch', 'headless') AND ${runAt('r')} >= ?
  `).all(since) as { kind: string; config_json: string; total_requests: number; cost_usd: number }[];

  const byKey = new Map<string, { effort: string; requests: number; costUsd: number; surface: string }>();
  for (const r of runs) {
    const surface = r.kind === 'headless' ? 'headless' : 'batches';
    const effort = effortOf(r.config_json);
    const key = `${surface}|${effort}`;
    const row = byKey.get(key) ?? { effort, requests: 0, costUsd: 0, surface };
    row.requests += r.total_requests || 0;
    row.costUsd += r.cost_usd || 0;
    byKey.set(key, row);
  }
  out.push(...byKey.values());

  return out.sort((a, b) => b.costUsd - a.costUsd);
}

/* ── caching ──────────────────────────────────────────────────────────── */

const CACHE_NOTE_CLI =
  'Counted by the Claude Code CLI itself and reported over OTLP — the agent’s own token ' +
  'counters, not Wanigan’s arithmetic.';

/**
 * Named in the returned data, not buried in a source comment, because it is the
 * difference between a rate you can plan against and one you cannot. The
 * Batches API makes no cache guarantee: line items are scheduled across the
 * fleet, and whether a cached prefix is still warm when a given one runs is not
 * something the caller controls. The same request set has been observed
 * anywhere from 30% to 98%, which is why estimates carry a band and why this
 * figure is history rather than a forecast.
 */
const CACHE_NOTE_BATCH =
  'Best-effort: batch cache hits are not guaranteed by the API, so this is what happened on ' +
  'runs already finished, not a rate a future run can be planned against.';

/**
 * Cache economics per surface, over everything on record.
 *
 * `rate` is cached-read tokens as a share of ALL input-side tokens
 * (read + write + uncached input) — the share of the input bill that arrived
 * cheap. Deliberately not read / (read + write): that ratio ignores uncached
 * input entirely and so reads high on a run that barely cached anything.
 */
export function unifiedCacheRate(): {
  surface: string; read: number; write: number; input: number; rate: number; note: string;
}[] {
  const d = db();

  // The exporter's running totals are the right source for "everything ever" —
  // a metric row carries only its last update time, so it can answer a total
  // but never a window. If the collector was down for the whole history there
  // is nothing here, and the timestamped api events are the fallback.
  const metrics = d.prepare(`
    SELECT attrs, COALESCE(SUM(value), 0) AS v
    FROM session_metrics WHERE metric = 'claude_code.token.usage' GROUP BY attrs
  `).all() as { attrs: string; v: number }[];

  let sRead = 0;
  let sWrite = 0;
  let sInput = 0;
  for (const m of metrics) {
    switch (tokenTypeOf(m.attrs)) {
      case 'cacheread': sRead += m.v; break;
      case 'cachecreation': case 'cachewrite': sWrite += m.v; break;
      case 'input': sInput += m.v; break;
    }
  }
  if (sRead === 0 && sWrite === 0 && sInput === 0) {
    const e = d.prepare(`
      SELECT COALESCE(SUM(cache_read), 0) AS r, COALESCE(SUM(cache_write), 0) AS w,
             COALESCE(SUM(in_tokens), 0) AS i
      FROM session_api_events
    `).get() as { r: number; w: number; i: number };
    sRead = e.r;
    sWrite = e.w;
    sInput = e.i;
  }

  const runTotals = (kind: string) => d.prepare(`
    SELECT COALESCE(SUM(cache_read), 0) AS r, COALESCE(SUM(cache_write), 0) AS w,
           COALESCE(SUM(in_tokens), 0) AS i
    FROM runs WHERE kind = ?
  `).get(kind) as { r: number; w: number; i: number };

  const b = runTotals('batch');
  const h = runTotals('headless');

  const row = (surface: string, read: number, write: number, input: number, note: string) => {
    const total = read + write + input;
    return {
      surface,
      read: Math.round(read),
      write: Math.round(write),
      input: Math.round(input),
      rate: total > 0 ? read / total : 0,
      note,
    };
  };

  return [
    row('sessions', sRead, sWrite, sInput, CACHE_NOTE_CLI),
    row('batches', b.r, b.w, b.i, CACHE_NOTE_BATCH),
    row('headless', h.r, h.w, h.i, CACHE_NOTE_CLI),
  ];
}

/** Reads the `type` attribute out of a session_metrics attrs key, normalised. */
function tokenTypeOf(attrs: string): string {
  if (!attrs) return '';
  try {
    const o = JSON.parse(attrs) as Record<string, unknown>;
    return typeof o.type === 'string' ? o.type.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  } catch {
    return '';
  }
}

/* ── synchronous comparison ───────────────────────────────────────────── */

/**
 * What the same work would have cost run synchronously, day by day.
 *
 * Batch rates are exactly 50% of list, so a batch run's synchronous figure is
 * 2x what it actually cost. Session and headless spend is ALREADY at list price
 * — the CLI calls the Messages API — so it crosses over at 1x.
 *
 * Doubling the session line too would be the flattering mistake: it would
 * invent a saving Wanigan never made, and it would grow with exactly the
 * surface a user spends most of their day in, so the invented number would end
 * up the largest one on the chart.
 */
export function syncComparison(days?: number): { day: string; actualUsd: number; syncUsd: number }[] {
  const n = windowDays(days);
  const since = windowStart(n).getTime();
  const s = sessionUsdByDay(since);
  const b = batchUsdByDay(since);
  const h = headlessUsdByDay(since);

  return daySeries(n).map((day) => {
    const session = s.get(day) ?? 0;
    const batch = b.get(day) ?? 0;
    const headless = h.get(day) ?? 0;
    return {
      day,
      actualUsd: session + batch + headless,
      syncUsd: session + headless + batch * 2,
    };
  });
}

/* ── budgets ──────────────────────────────────────────────────────────── */

/**
 * SQLite lets NULL into a PRIMARY KEY column on a rowid table, and lets it in
 * more than once. Storing the global budget as a literal NULL scope_id would
 * therefore accept two global budgets that no ON CONFLICT clause ever
 * reconciles, and the app would show whichever one the query reached first.
 * The sentinel is what goes to disk; null stays the public spelling.
 */
const GLOBAL_SCOPE = '*';
const GLOBAL_NAME = 'All projects';
const DEFAULT_WARN_AT = 0.8;

type BudgetRow = { scope_id: string; monthly_usd: number; warn_at: number };

function scopeKey(scopeId: string | null): string {
  return scopeId === null || scopeId === '' ? GLOBAL_SCOPE : scopeId;
}

function scopeName(scopeId: string | null): string {
  if (scopeId === null) return GLOBAL_NAME;
  const p = db().prepare('SELECT name FROM projects WHERE id = ?').get(scopeId) as
    { name: string } | undefined;
  if (p?.name) return p.name;
  // A project can be dropped from the list while its budget and its spend stay
  // on record. Sessions kept a copy of the name; the id is a worse label than
  // that and a much better one than an empty string.
  const s = db().prepare(
    'SELECT project_name AS name FROM session_log WHERE project_id = ? ORDER BY started_at DESC LIMIT 1'
  ).get(scopeId) as { name: string } | undefined;
  return s?.name || scopeId;
}

/** Every budget on record, most-pressed first. */
export function budgets(): BudgetState[] {
  const rows = db().prepare('SELECT scope_id, monthly_usd, warn_at FROM budgets')
    .all() as BudgetRow[];
  return rows
    .map((r) => budgetState(r.scope_id === GLOBAL_SCOPE ? null : r.scope_id))
    .sort((a, b) => pressure(b) - pressure(a));
}

/** Share of the budget already spent. Uncapped scopes sort last, not first. */
function pressure(s: BudgetState): number {
  return s.monthlyUsd > 0 ? s.spentUsd / s.monthlyUsd : -1;
}

/**
 * `monthlyUsd` of 0 means "no ceiling": the row stays so the scope keeps its
 * place in the list and its spend stays visible, but nothing can breach it.
 */
export function setBudget(scopeId: string | null, monthlyUsd: number, warnAt?: number): void {
  const amount = Number(monthlyUsd);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(
      `A monthly budget must be a number of dollars, zero or more — got ${String(monthlyUsd)}. ` +
      'Use 0 to keep tracking this scope without capping it.'
    );
  }

  const warn = warnAt === undefined ? DEFAULT_WARN_AT : Number(warnAt);
  if (!Number.isFinite(warn) || warn <= 0 || warn > 1) {
    throw new Error(
      `The warning threshold is a fraction of the budget, above 0 and at most 1 — got ${String(warnAt)}. ` +
      'Pass 0.8 to be warned at 80% of the month, or leave it out for that default.'
    );
  }

  db().prepare(`
    INSERT INTO budgets (scope_id, monthly_usd, warn_at) VALUES (?,?,?)
    ON CONFLICT(scope_id) DO UPDATE SET monthly_usd = excluded.monthly_usd, warn_at = excluded.warn_at
  `).run(scopeKey(scopeId), amount, warn);
}

/**
 * Month-to-date spend for one scope, and where it lands if the rest of the
 * month looks like the part already spent.
 *
 * The projection is spent / daysElapsed * daysInMonth, with today counted as a
 * whole elapsed day. Dividing by a fraction of a day would have the projection
 * on the 1st at 00:05 read in the thousands off a single session — a number
 * nobody can act on. It is still noisy for the first days of a month: this is a
 * run rate, not a forecast.
 *
 * A scope with no budget row is not an error. It comes back with monthlyUsd 0
 * and real spend, which is what a caller offering to *set* a budget needs.
 */
export function budgetState(scopeId: string | null): BudgetState {
  const d = db();
  const row = d.prepare('SELECT scope_id, monthly_usd, warn_at FROM budgets WHERE scope_id = ?')
    .get(scopeKey(scopeId)) as BudgetRow | undefined;

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysElapsed = now.getDate();
  const scoped = scopeId !== null;

  // session_log is what ties an api event to a repo. A session with no log row
  // cannot belong to a project scope, so it counts only against the global one.
  const sessions = scoped
    ? d.prepare(`
        SELECT COALESCE(SUM(e.cost_usd), 0) AS usd
        FROM session_api_events e
        JOIN session_log s ON s.id = e.session_id
        WHERE e.at >= ? AND s.project_id = ?
      `).get(monthStart, scopeId) as { usd: number }
    : d.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM session_api_events WHERE at >= ?')
        .get(monthStart) as { usd: number };

  const headless = scoped
    ? d.prepare(`
        SELECT COALESCE(SUM(h.cost_usd), 0) AS usd FROM headless_rows h
        WHERE ${hlAt('h')} IS NOT NULL AND ${hlAt('h')} >= ? AND h.project_id = ?
      `).get(monthStart, scopeId) as { usd: number }
    : d.prepare(`
        SELECT COALESCE(SUM(h.cost_usd), 0) AS usd FROM headless_rows h
        WHERE ${hlAt('h')} IS NOT NULL AND ${hlAt('h')} >= ?
      `).get(monthStart) as { usd: number };

  const batches = scoped
    ? d.prepare(`
        SELECT COALESCE(SUM(r.cost_usd), 0) AS usd FROM runs r
        WHERE r.kind = 'batch' AND ${runAt('r')} >= ? AND r.project_id = ?
      `).get(monthStart, scopeId) as { usd: number }
    : d.prepare(`
        SELECT COALESCE(SUM(r.cost_usd), 0) AS usd FROM runs r
        WHERE r.kind = 'batch' AND ${runAt('r')} >= ?
      `).get(monthStart) as { usd: number };

  // sessionUsd carries headless with it: both are the CLI's own accounting, and
  // a budget that folded a metered number into a computed one without saying so
  // would be exactly the chart this module refuses to draw. spentUsd is their
  // sum, and the two halves stay readable beside it.
  const sessionUsd = sessions.usd + headless.usd;
  const batchUsd = batches.usd;
  const spentUsd = sessionUsd + batchUsd;

  return {
    scopeId,
    scopeName: scopeName(scopeId),
    monthlyUsd: row?.monthly_usd ?? 0,
    spentUsd,
    sessionUsd,
    batchUsd,
    warnAt: row?.warn_at ?? DEFAULT_WARN_AT,
    projectedUsd: (spentUsd / Math.max(1, daysElapsed)) * daysInMonth,
    daysElapsed,
    daysInMonth,
  };
}

/**
 * Budgets worth saying something about, most-pressed first: already past their
 * warning threshold, or on a run rate that ends the month over.
 *
 * The projection is in the test deliberately. A cap that only speaks once it
 * has been exceeded is a receipt, not a budget — by the time it fires the money
 * is gone and there is nothing left to decide.
 */
export function budgetBreached(): BudgetState[] {
  return budgets().filter(
    (s) => s.monthlyUsd > 0 && (s.spentUsd >= s.monthlyUsd * s.warnAt || s.projectedUsd >= s.monthlyUsd)
  );
}

/* ── reconciliation ───────────────────────────────────────────────────── */

/**
 * The Admin API's cost report is raw HTTP — it is not in the SDK — and it needs
 * a different credential from everything else Wanigan does.
 *
 * That credential is read from ANTHROPIC_ADMIN_KEY and from nowhere else. It is
 * deliberately not the run key, and this module does not import getKey() at all
 * so that it cannot quietly become the run key in a later edit. An admin key
 * reaches organisation membership, workspaces and API keys — a different blast
 * radius from a key that can only send messages — so handing one to a desktop
 * app has to be a separate, deliberate act. Its absence therefore degrades to a
 * note on the result rather than an error.
 */
const COST_REPORT_URL = 'https://api.anthropic.com/v1/organizations/cost_report';
/** The endpoint caps a page at 31 daily buckets; the page cap stops a bad has_more looping forever. */
const REPORT_PAGE_LIMIT = 31;
const REPORT_MAX_PAGES = 16;
const REPORT_TIMEOUT_MS = 30_000;

function adminKey(): string | null {
  return process.env.ANTHROPIC_ADMIN_KEY?.trim() || null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

type ReportItem = { model: string; tier: string | null; usd: number };

/**
 * Cost amounts come back as decimal strings in the currency's lowest unit —
 * "123.45" USD is $1.23. Reading that as dollars would overstate the bill 100x,
 * consistently enough to look like a plausible pricing-table error rather than
 * the units bug it is.
 */
function amountUsd(v: unknown): number {
  const n = Number(typeof v === 'string' ? v : NaN);
  return Number.isFinite(n) ? n / 100 : 0;
}

/** Null means the payload was not a cost report at all — the caller degrades to a note. */
function parseReport(payload: unknown): ReportItem[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return null;

  const items: ReportItem[] = [];
  for (const bucket of payload.data) {
    if (!isRecord(bucket)) continue;
    for (const result of asArray(bucket.results)) {
      if (!isRecord(result)) continue;
      items.push({
        model: str(result.model) ?? UNATTRIBUTED_NAME,
        tier: str(result.service_tier),
        usd: amountUsd(result.amount),
      });
    }
  }
  return items;
}

function isoOrThrow(value: string, edge: string): string {
  const t = Date.parse(value);
  if (!Number.isFinite(t)) {
    throw new Error(
      `Could not read "${value}" as the ${edge} of the reconciliation window. ` +
      'Pass a date (2026-08-01) or a full RFC 3339 timestamp.'
    );
  }
  return new Date(t).toISOString();
}

/**
 * Wanigan's own batch arithmetic against what the organisation was actually
 * billed, for one window.
 *
 * Only batch runs are compared, because they are the only spend Wanigan prices
 * itself. Session and headless costs come from the CLI and are already the
 * biller's own number, so reconciling those against the bill would be comparing
 * a figure to itself and calling the agreement a result.
 *
 * The window is handled in UTC. The Admin API snaps its buckets to UTC days,
 * and filtering locally-bucketed spend against a UTC report would misfile
 * whatever landed either side of midnight — producing a delta made of
 * timezones and reading as a pricing error.
 */
export async function reconcile(from: string, to: string): Promise<Reconciliation> {
  const startIso = isoOrThrow(from, 'start');
  const endIso = isoOrThrow(to, 'end');
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (endMs <= startMs) {
    throw new Error(
      `The reconciliation window ends (${endIso}) at or before it starts (${startIso}). Swap the two dates.`
    );
  }

  const local = db().prepare(`
    SELECT r.model AS model, COALESCE(SUM(r.cost_usd), 0) AS usd
    FROM runs r
    WHERE r.kind = 'batch' AND ${runAt('r')} >= ? AND ${runAt('r')} < ?
    GROUP BY r.model
  `).all(startMs, endMs) as { model: string; usd: number }[];

  const localByModel = new Map(local.map((r) => [r.model, r.usd]));
  const localUsd = local.reduce((a, r) => a + r.usd, 0);

  /** Wanigan's side only. Reported stays 0 so nothing reads as agreement. */
  const unreconciled = (note: string): Reconciliation => ({
    localUsd,
    reportedUsd: 0,
    deltaUsd: 0,
    accuracy: 0,
    byModel: [...localByModel].map(([model, usd]) => ({ model, localUsd: usd, reportedUsd: 0 })),
    from: startIso,
    to: endIso,
    note,
  });

  const key = adminKey();
  if (!key) {
    return unreconciled(
      'No Admin API key is set, so there is nothing to reconcile against — the figures below are ' +
      'Wanigan’s own arithmetic only. Set ANTHROPIC_ADMIN_KEY in the environment before launching ' +
      'Wanigan to enable this. Wanigan will not reuse the key it sends batches with: an admin key ' +
      'can read organisation membership, workspaces and API keys, so granting one is a separate ' +
      'decision from letting Wanigan run batches.'
    );
  }

  const items: ReportItem[] = [];
  let page: string | null = null;
  let unknownShape = false;

  for (let i = 0; i < REPORT_MAX_PAGES; i++) {
    const params = new URLSearchParams({
      starting_at: startIso,
      ending_at: endIso,
      bucket_width: '1d',
      limit: String(REPORT_PAGE_LIMIT),
    });
    // Without this grouping the report answers one lump per day and the
    // per-model comparison below has nothing to join on.
    params.append('group_by[]', 'description');
    if (page) params.set('page', page);

    let payload: unknown;
    try {
      const r = await fetch(`${COST_REPORT_URL}?${params.toString()}`, {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      });
      if (!r.ok) {
        const detail = await errorType(r);
        if (r.status === 401 || r.status === 403) {
          return unreconciled(
            `The Admin API rejected the key (${r.status}${detail}). ANTHROPIC_ADMIN_KEY has to be an ` +
            'Admin API key — created in the Console by an organisation admin, and starting sk-ant-admin. ' +
            'A standard key cannot read the cost report.'
          );
        }
        return unreconciled(
          `The Admin API returned ${r.status}${detail}, so this window could not be reconciled. The ` +
          'figures below are Wanigan’s own arithmetic only. Cost data can lag a request by a few ' +
          'minutes; try again shortly.'
        );
      }
      payload = await r.json();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return unreconciled(
        `Could not reach the Admin API (${msg}). The figures below are Wanigan’s own arithmetic ` +
        'only — nothing has been compared against the bill.'
      );
    }

    const parsed = parseReport(payload);
    if (!parsed) {
      unknownShape = true;
      break;
    }
    items.push(...parsed);

    const next = isRecord(payload) && payload.has_more === true ? str(payload.next_page) : null;
    page = next;
    if (!page) break;
  }

  if (unknownShape) {
    return unreconciled(
      'The cost report came back in a shape Wanigan does not recognise, so nothing was compared. ' +
      'That usually means the endpoint has changed; the figures below are Wanigan’s own arithmetic only.'
    );
  }
  if (page) {
    // Left the loop still holding a cursor. A partial reported total against a
    // full local total would read as a pricing win Wanigan did not make.
    return unreconciled(
      `The cost report did not finish paginating within ${REPORT_MAX_PAGES} pages, so the comparison ` +
      'would have been against a partial bill. Reconcile a shorter window; the figures below are ' +
      'Wanigan’s own arithmetic only.'
    );
  }

  // Wanigan prices batch traffic, so batch is what it can be held to. When the
  // report carries a service tier, compare like with like. When it carries
  // none, fall back to the whole bill and say so — that total includes every
  // other thing the organisation did with the API.
  const tiered = items.some((i) => i.tier !== null);
  const relevant = tiered ? items.filter((i) => i.tier === 'batch') : items;

  // No counterparty is not a comparison. Cost data lags by minutes to hours,
  // and a window whose batch charges have not landed yet — or landed on the
  // neighbouring UTC day — leaves this filter empty. Falling through would
  // report reportedUsd 0, a delta equal to the entire local total and 0%
  // accuracy, which reads exactly like Wanigan overcharging by 100%.
  if (relevant.length === 0) {
    return unreconciled(
      tiered
        ? 'The cost report carried no batch-tier charges for this window, so there was nothing to ' +
          'compare against — the figures below are Wanigan’s own arithmetic only. Cost data can lag ' +
          'a request by minutes to hours, and a batch that finished near midnight UTC may be billed ' +
          'on the next day; try a wider window, or again shortly.'
        : 'The cost report carried no charges at all for this window, so there was nothing to ' +
          'compare against — the figures below are Wanigan’s own arithmetic only. Cost data can lag ' +
          'a request by minutes to hours; try a wider window, or again shortly.'
    );
  }

  const reportedByModel = new Map<string, number>();
  for (const i of relevant) {
    reportedByModel.set(i.model, (reportedByModel.get(i.model) ?? 0) + i.usd);
  }
  const reportedUsd = relevant.reduce((a, i) => a + i.usd, 0);

  const models = new Set([...localByModel.keys(), ...reportedByModel.keys()]);
  const byModel = [...models]
    .map((model) => ({
      model,
      localUsd: localByModel.get(model) ?? 0,
      reportedUsd: reportedByModel.get(model) ?? 0,
    }))
    .sort((a, b) => b.reportedUsd - a.reportedUsd);

  const deltaUsd = localUsd - reportedUsd;
  const accuracy = reportedUsd > 0
    ? Math.max(0, Math.min(1, 1 - Math.abs(deltaUsd) / reportedUsd))
    : 0;

  const scope = tiered
    ? 'Compared against batch-tier charges only.'
    : 'The report carried no service tier, so this is compared against the organisation’s entire bill for the window.';

  return {
    localUsd,
    reportedUsd,
    deltaUsd,
    accuracy,
    byModel,
    from: startIso,
    to: endIso,
    note:
      `${scope} The local figures are Wanigan’s own, computed from the batch pricing table. The ` +
      'reported figures are the organisation’s actual charges and cover everything billed to this ' +
      'account, including work Wanigan never ran — so a delta is not by itself an error in Wanigan.',
  };
}

/**
 * The API's own error type, when it gives one. Never the body: an error
 * response can echo the request that caused it, and the request carried a key.
 */
async function errorType(r: Response): Promise<string> {
  try {
    const body = (await r.json()) as unknown;
    if (isRecord(body) && isRecord(body.error)) {
      const t = str(body.error.type);
      if (t) return `, ${t}`;
    }
  } catch {
    /* not JSON, or the body was already consumed */
  }
  return '';
}

/* ── estimator accuracy ───────────────────────────────────────────────── */

/**
 * How close the pre-flight estimate came to the finished run, per model.
 *
 * Both numbers here come out of the same local pricing table, so this measures
 * the *token* guess — the sampled input lengths and the assumption about output
 * length — and says nothing about whether the rates themselves are right. Rates
 * are what reconcile() tests, against the bill. A ratio of 1.00 on this list is
 * not evidence that Wanigan's dollar figures are correct.
 *
 * ratio is actual / estimated, so above 1 means the run cost more than it
 * promised. That is the direction that matters, and it sorts by money at stake
 * rather than by the ratio, because a 3x overshoot on four cents is not news.
 */
export function estimateAccuracy(): {
  model: string; runs: number; estUsd: number; actualUsd: number; ratio: number;
}[] {
  const rows = db().prepare(`
    SELECT model, COUNT(*) AS runs,
           COALESCE(SUM(est_cost_usd), 0) AS est, COALESCE(SUM(cost_usd), 0) AS actual
    FROM runs
    WHERE kind = 'batch' AND est_cost_usd > 0 AND cost_usd > 0
    GROUP BY model
  `).all() as { model: string; runs: number; est: number; actual: number }[];

  return rows
    .map((r) => ({
      model: r.model,
      runs: r.runs,
      estUsd: r.est,
      actualUsd: r.actual,
      ratio: r.est > 0 ? r.actual / r.est : 0,
    }))
    .sort((a, b) => b.actualUsd - a.actualUsd);
}
