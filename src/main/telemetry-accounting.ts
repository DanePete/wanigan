import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { SessionUsage } from '../shared/types';

/** Fixed-width uint64 text keeps nanosecond identity and ordering without Number rounding. */
export function telemetryNanos(value: unknown): string | null {
  const text = typeof value === 'string' ? value
    : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
  if (!/^\d{1,20}$/.test(text)) return null;
  const n = BigInt(text);
  return n > 0n && n <= 18_446_744_073_709_551_615n ? String(n).padStart(20, '0') : null;
}

/** OTLP attributes are sets; other arrays (including AnyValue arrays) retain order. */
function canonical(value: unknown, attributeSet = false): unknown {
  if (Array.isArray(value)) {
    const entries: unknown[] = value.map(item => canonical(item));
    return attributeSet ? entries.sort((a, b) => {
      const left = JSON.stringify(a), right = JSON.stringify(b);
      return left < right ? -1 : left > right ? 1 : 0;
    }) : entries;
  }
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map(key => {
    const item = record[key];
    // ProtoJSON accepts int64 as decimal text or a JSON number. Safe numeric
    // values and their string spelling describe the same attribute identity.
    if (key === 'intValue') {
      if (typeof item === 'number' && Number.isSafeInteger(item)) return [key, String(item)];
      if (typeof item === 'string' && /^-?\d{1,20}$/.test(item)) return [key, BigInt(item).toString()];
    }
    return [key, canonical(item, key === 'attributes')];
  }));
}

/** Only the digest is persisted; no resource attributes, log bodies or credentials. */
export function telemetryFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function noteAccountingIssue(d: Database.Database, sessionId: string, reason: string, at: number): void {
  d.prepare(`INSERT INTO session_telemetry_issues(session_id,reason,last_at) VALUES(?,?,?)
    ON CONFLICT(session_id,reason) DO UPDATE SET last_at=MAX(last_at,excluded.last_at)`)
    .run(sessionId, reason, at);
}

/** Called inside the aggregate write transaction, so receipt and value commit together. */
export function acceptTelemetry(d: Database.Database, sessionId: string, fingerprint: string, value: number, at: number): boolean {
  const inserted = d.prepare(`INSERT OR IGNORE INTO session_telemetry_receipts
    (fingerprint,session_id,value,received_at) VALUES(?,?,?,?)`).run(fingerprint, sessionId, value, at);
  if (inserted.changes) return true;
  const prior = d.prepare('SELECT value FROM session_telemetry_receipts WHERE fingerprint=?').get(fingerprint) as { value: number };
  if (prior.value !== value) noteAccountingIssue(d, sessionId, 'conflicting-retry', at);
  return false;
}

type Coverage = { cost: number; costAt: string | null; activityAt: string | null; eventCost: number };
export type AccountingMetric = {
  session_id: string; metric: string; attrs: string; value: number; last_at: number; last_at_ns: string | null;
};
type SourceAttributes = Record<string, string | { sha256: string }>;
type StreamCoverage = {
  session_id: string; attrs_json: string; cost_usd: number;
  cost_at_ns: string | null; activity_at_ns: string | null;
};
const COST_METRIC = 'claude_code.cost.usage';
const TOKEN_METRIC = 'claude_code.token.usage';
const SOURCE_KEYS = ['model', 'query_source', 'effort', 'speed', 'agent.name', 'skill.name',
  'plugin.name', 'marketplace.name', 'mcp_server.name', 'mcp_tool.name'].sort();

/** Persist only bounded operational attribution. Long values keep their full
 * identity as a digest, rather than making equal prefixes the same source. */
export function coverageAttributes(attrs: Record<string, string>): string {
  const picked: SourceAttributes = {};
  for (const key of SOURCE_KEYS) {
    const value = attrs[key]?.trim();
    if (value) picked[key] = value.length <= 128 ? value
      : { sha256: createHash('sha256').update(value).digest('hex') };
  }
  return JSON.stringify(picked);
}

function parseAttributes(attrs: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(attrs);
    if (parsed && typeof parsed === 'object') return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch { /* Legacy unkeyed metric. */ }
  return {};
}

function timestamp(nanos: string | null, millis: number): string {
  return nanos ?? String(BigInt(Math.round(millis)) * 1_000_000n).padStart(20, '0');
}

function writeCoverage(d: Database.Database, sessionId: string, metric: string,
  attrs: string, nanos: string, value: number): void {
  d.prepare(`INSERT INTO session_telemetry_coverage
    (session_id,stream_key,attrs_json,cost_usd,cost_at_ns,activity_at_ns) VALUES(?,?,?,?,?,?)
    ON CONFLICT(session_id,stream_key) DO UPDATE SET
      cost_usd=session_telemetry_coverage.cost_usd+excluded.cost_usd,
      cost_at_ns=CASE WHEN excluded.cost_at_ns > COALESCE(session_telemetry_coverage.cost_at_ns,'')
        THEN excluded.cost_at_ns ELSE session_telemetry_coverage.cost_at_ns END,
      activity_at_ns=CASE WHEN excluded.activity_at_ns > COALESCE(session_telemetry_coverage.activity_at_ns,'')
        THEN excluded.activity_at_ns ELSE session_telemetry_coverage.activity_at_ns END`)
    .run(sessionId, telemetryFingerprint(attrs), attrs, metric === COST_METRIC ? value : 0,
      metric === COST_METRIC ? nanos : null, metric === TOKEN_METRIC && value > 0 ? nanos : null);
}

/** Call after accepting the receipt, before updating session_metrics, in the
 * same transaction. The first new point freezes existing aggregate evidence
 * before a zero token point can overwrite its historical activity timestamp. */
export function recordCostCoverage(d: Database.Database, sessionId: string, metric: string,
  coverageAttrs: string, nanos: string, value: number): void {
  if (metric !== COST_METRIC && metric !== TOKEN_METRIC) return;
  if (!d.prepare('SELECT 1 FROM session_telemetry_coverage WHERE session_id=? LIMIT 1').get(sessionId)) {
    const prior = d.prepare(`SELECT session_id,metric,attrs,value,last_at,last_at_ns FROM session_metrics
      WHERE session_id=? AND metric IN (?,?)`).all(sessionId, COST_METRIC, TOKEN_METRIC) as AccountingMetric[];
    // Legacy totals retain only model (and cost-only effort), so they cannot
    // acquire source provenance from the first new point. Preserve their
    // former model-level comparison separately from newly attributed streams.
    for (const row of prior) writeCoverage(d, sessionId, row.metric,
      coverageAttributes({ model: parseAttributes(row.attrs).model ?? '' }),
      timestamp(row.last_at_ns, row.last_at), row.value);
  }
  writeCoverage(d, sessionId, metric, coverageAttrs, nanos, value);
}

function sourceOf(attrs: string): SourceAttributes {
  return JSON.parse(attrs) as SourceAttributes;
}

/** An omitted dimension on activity cannot choose the newest of several
 * candidate sources. Every matching dollar stream must reach its timestamp.
 * Incomplete attribution can therefore hold work after a source goes idle;
 * without more provenance there is no honest way to pick a more recent one. */
function coveredByStreams(streams: StreamCoverage[], attrs: SourceAttributes, at: string, cost: number): boolean {
  const matches = streams.filter(stream => {
    const candidate = sourceOf(stream.attrs_json);
    return Object.entries(attrs).every(([key, value]) => JSON.stringify(candidate[key]) === JSON.stringify(value));
  });
  return matches.length > 0
    && matches.every(stream => stream.cost_at_ns !== null && stream.cost_at_ns >= at)
    && cost <= matches.reduce((total, stream) => total + stream.cost_usd, 0) + 1e-9;
}

/**
 * Keep each known source's activity behind its own dollar meter. Log amounts
 * are lower bounds on those metrics, never additional charges. Legacy rows
 * retain their model-level comparison until their first new metric preserves
 * that evidence in the source ledger.
 */
export function markIncompleteCost(d: Database.Database, usage: Map<string, SessionUsage>, metrics: AccountingMetric[]): void {
  const coverage = new Map<string, Map<string, Coverage>>();
  const bucket = (sessionId: string, model: string): Coverage => {
    let models = coverage.get(sessionId);
    if (!models) { models = new Map(); coverage.set(sessionId, models); }
    let entry = models.get(model);
    if (!entry) { entry = { cost: 0, costAt: null, activityAt: null, eventCost: 0 }; models.set(model, entry); }
    return entry;
  };
  const unavailable = (id: string) => { const u = usage.get(id); if (u) u.costStatus = 'unavailable'; };
  const ids = [...usage.keys()];
  const sourceCoverage = new Map<string, StreamCoverage[]>();
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500);
    const marks = chunk.map(() => '?').join(',');
    const streams = d.prepare(`SELECT session_id,attrs_json,cost_usd,cost_at_ns,activity_at_ns
      FROM session_telemetry_coverage WHERE session_id IN (${marks})`).all(...chunk) as StreamCoverage[];
    for (const stream of streams) {
      const group = sourceCoverage.get(stream.session_id) ?? [];
      group.push(stream);
      sourceCoverage.set(stream.session_id, group);
    }
  }
  for (const r of metrics) {
    if (r.metric !== COST_METRIC && r.metric !== TOKEN_METRIC) continue;
    const c = bucket(r.session_id, parseAttributes(r.attrs).model ?? '');
    const at = timestamp(r.last_at_ns, r.last_at);
    if (r.metric === COST_METRIC) {
      c.cost += r.value;
      if (c.costAt === null || at > c.costAt) c.costAt = at;
    } else if (!sourceCoverage.has(r.session_id) && r.value > 0
      && (c.activityAt === null || at > c.activityAt)) c.activityAt = at;
  }
  for (const [id, streams] of sourceCoverage) {
    // Cost and token points share attribution dimensions; a different source
    // must never cover this stream's positive activity, including a source
    // with more attributes. Zero tokens do not move activity_at_ns.
    if (streams.some(stream => stream.cost_usd < 0 || (stream.activity_at_ns !== null
      && (stream.cost_at_ns === null || stream.activity_at_ns > stream.cost_at_ns)))) unavailable(id);
  }
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500);
    const marks = chunk.map(() => '?').join(',');
    const events = d.prepare(`SELECT session_id,COALESCE(model,'') AS model,coverage_attrs,
      MAX(COALESCE(at_ns,printf('%020d',at * 1000000))) AS at_ns,
      SUM(CASE WHEN kind='request' THEN cost_usd ELSE 0 END) AS cost
      FROM session_api_events WHERE session_id IN (${marks})
      GROUP BY session_id,model,coverage_attrs`).all(...chunk) as
      { session_id: string; model: string; coverage_attrs: string | null; at_ns: string; cost: number }[];
    for (const event of events) {
      const c = bucket(event.session_id, event.model);
      c.eventCost += event.cost;
      const streams = sourceCoverage.get(event.session_id);
      if (streams) {
        const attrs = event.coverage_attrs ?? coverageAttributes({ model: event.model });
        if (event.cost < 0 || !coveredByStreams(streams.filter(stream => stream.cost_at_ns !== null),
          sourceOf(attrs), event.at_ns, event.cost)) unavailable(event.session_id);
      } else if (c.activityAt === null || event.at_ns > c.activityAt) c.activityAt = event.at_ns;
    }
    const issues = d.prepare(`SELECT DISTINCT session_id FROM session_telemetry_issues
      WHERE session_id IN (${marks})`).all(...chunk) as { session_id: string }[];
    for (const { session_id: id } of issues) unavailable(id);
  }
  for (const [id, models] of coverage) {
    const incomplete = [...models.values()].some(c => c.cost < 0 || c.eventCost < 0
      || (c.activityAt !== null && (c.costAt === null || c.activityAt > c.costAt))
      || c.eventCost > c.cost + 1e-9);
    if (incomplete) unavailable(id);
  }
}
