import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { db } from './db';
import { EMPTY_USAGE, type ApiEvent, type SessionUsage } from '../shared/types';
import { mergeCodexUsage } from './codex-usage';

/**
 * Claude Code exports OpenTelemetry natively. Wanigan spawns the CLI, so it
 * owns the environment and can aim the exporter at itself — which turns cost
 * from a number we would have to estimate from a pricing table into a number
 * the agent reports about itself.
 *
 * The receiver is hand-rolled against the OTLP/JSON wire format rather than
 * built on the otel SDK: this understands seven metrics and three log events,
 * and a dependency that ships a full pipeline to do that is not a trade worth
 * making inside an Electron main process.
 */

/** Datapoints arriving from a process that never got Wanigan's resource attribute. */
const UNATTRIBUTED = 'unattributed';

/**
 * An OTLP export is a handful of counters, not a payload. Anything approaching
 * this is either a runaway exporter or something that is not an exporter at
 * all, and buffering it would be the leak rather than the defence.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const JSON_HEADERS = { 'content-type': 'application/json' } as const;
const OTLP_PATHS = new Set(['/v1/metrics', '/v1/logs', '/v1/traces']);

/**
 * The metrics worth banking, and the attributes that make a datapoint distinct
 * for each. Keys not listed here are deliberately collapsed: `token.usage`
 * split by every attribute Claude Code happens to attach would be one row per
 * turn, and the running total this table exists to keep would stop being cheap.
 */
const TRACKED_METRICS: Record<string, string[]> = {
  'claude_code.cost.usage': ['model', 'effort'],
  'claude_code.token.usage': ['type', 'model'],
  'claude_code.lines_of_code.count': ['type'],
  'claude_code.commit.count': [],
  'claude_code.pull_request.count': [],
  'claude_code.active_time.total': [],
  // Contributes nothing to usage, but it is the first metric a healthy session
  // emits — a row here is the proof that the env wiring took.
  'claude_code.session.count': [],
};

const LOG_KINDS: Record<string, ApiEvent['kind']> = {
  'claude_code.api_request': 'request',
  'claude_code.api_error': 'error',
  'claude_code.api_refusal': 'refusal',
};

/* ── server ──────────────────────────────────────────────────────────── */

let server: http.Server | null = null;
let port: number | null = null;
let starting: Promise<number> | null = null;
/**
 * Per-start credential the exporter has to present. Regenerated on every start
 * so a token that leaked into a log from a previous run is already dead.
 */
let token: string | null = null;
/** One warning per start; a refused exporter retries every 10s forever. */
let warnedUnauthorized = false;

/**
 * Binds the collector on an ephemeral loopback port. Safe to call twice; the
 * second call gets the port the first one bound rather than a second server.
 */
export async function startCollector(): Promise<number> {
  if (port !== null) return port;
  if (starting) return starting;

  starting = new Promise<number>((resolve, reject) => {
    const srv = http.createServer(handle);
    let bound = false;

    srv.on('error', (e: Error) => {
      if (bound) return; // post-bind socket noise; the collector keeps serving
      starting = null;
      reject(new Error(
        `Wanigan could not open its telemetry receiver on 127.0.0.1 (${e.message}). ` +
        'Sessions still run, but their cost and token counts will read as zero until Wanigan is restarted.'
      ));
    });

    // Port 0 lets the OS pick, and 127.0.0.1 (not 0.0.0.0) keeps the listener
    // off every other interface on the machine.
    srv.listen(0, '127.0.0.1', () => {
      bound = true;
      const addr = srv.address() as AddressInfo | null;
      if (!addr || typeof addr.port !== 'number') {
        starting = null;
        reject(new Error('Wanigan bound its telemetry receiver but the OS reported no port. Restart Wanigan.'));
        return;
      }
      server = srv;
      port = addr.port;
      token = randomBytes(24).toString('hex');
      warnedUnauthorized = false;
      starting = null;
      resolve(addr.port);
    });
  });

  return starting;
}

export function stopCollector(): void {
  const srv = server;
  server = null;
  port = null;
  token = null;
  starting = null;
  if (!srv) return;
  // A running agent holds its exporter connection open with keep-alive, so
  // close() on its own waits for a socket that will never go idle and the app
  // hangs on quit.
  srv.closeAllConnections();
  srv.close();
}

export function collectorPort(): number | null {
  return port;
}

/** The header value a client must send to be allowed to write. Null when down. */
export function collectorToken(): string | null {
  return token;
}

/**
 * Constant time, and length-checked first: a local attacker can retry a guess as
 * fast as the loop will spin, and a short-circuiting compare leaks the token one
 * byte at a time.
 */
function authOk(given: string | string[] | undefined, want: string | null): boolean {
  if (!want) return false;
  const v = Array.isArray(given) ? given[0] : given;
  if (!v) return false;
  const a = Buffer.from(v);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * ::ffff:127.0.0.1 is what a dual-stack listener reports for an IPv4 client, so
 * the mapped form has to be unwrapped before the comparison — otherwise every
 * legitimate export from the agent is refused as remote.
 */
function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return a === '::1' || /^127\.\d+\.\d+\.\d+$/.test(a);
}

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!isLoopback(req.socket.remoteAddress)) {
    // Dropped without a reply on purpose: an answer of any status confirms to
    // whatever is scanning the port that something is listening here.
    req.socket.destroy();
    return;
  }

  // The collector writes the numbers the cost panel, sessionSpendTotal() and the
  // spend cap all read, and loopback is not a credential: without this check any
  // process on the machine — a stray npm postinstall, or a web page POSTing
  // text/plain, which is a CORS simple request and so needs no preflight — could
  // add $9999 into session_metrics under 'unattributed', permanently and
  // indistinguishably from a real export. Demanding a custom header also costs a
  // browser its simple-request exemption: the preflight gets a bare 404.
  if (!authOk(req.headers['x-wanigan-token'], token)) {
    if (!warnedUnauthorized) {
      warnedUnauthorized = true;
      // Named rather than silent: if the agent's exporter ever stops sending the
      // header, the only other symptom is a cost that reads zero forever.
      console.warn('[wanigan] telemetry export refused: missing or wrong x-wanigan-token');
    }
    res.writeHead(401, { ...JSON_HEADERS, connection: 'close' }).end('{}');
    return;
  }

  const path = (req.url ?? '').split('?')[0];
  if (req.method !== 'POST' || !OTLP_PATHS.has(path)) {
    res.writeHead(404, JSON_HEADERS).end('{}');
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let answered = false;

  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size <= MAX_BODY_BYTES) { chunks.push(c); return; }
    if (answered) return;
    answered = true;
    // Refused, then drained rather than reset. Tearing the socket down
    // mid-upload means the exporter never reads the 413 and re-sends the same
    // oversized payload on its next tick, forever. Nothing more is retained
    // and what was buffered is released, so draining costs no memory.
    chunks.length = 0;
    res.writeHead(413, { ...JSON_HEADERS, connection: 'close' }).end('{}');
  });

  req.on('error', () => { answered = true; }); // exporter went away mid-body

  req.on('end', () => {
    if (answered) return;
    try {
      ingest(path, Buffer.concat(chunks), req.headers['content-encoding']);
    } catch (e) {
      // Telemetry is never worth taking a session down for, and it is never
      // worth a retry storm either: an OTLP exporter re-sends anything it did
      // not get a 2xx for, so answering 5xx on a payload we cannot parse turns
      // one malformed export into a queue that never drains.
      //
      // Logged, though, rather than swallowed whole: a refused zip bomb and an
      // unparseable body are both answered 200, so without this line the only
      // symptom of either is usage that reads zero with nothing saying why.
      console.warn('[wanigan] telemetry export dropped:', e);
    }
    res.writeHead(200, JSON_HEADERS).end('{}');
  });
}

function ingest(path: string, raw: Buffer, encoding: string | string[] | undefined): void {
  if (!raw.length) return;
  let body = raw;
  const enc = Array.isArray(encoding) ? encoding[0] : encoding;
  // Wanigan never asks for compression, but the agent inherits Wanigan's
  // environment: an OTEL_EXPORTER_OTLP_COMPRESSION=gzip left in the user's
  // shell arrives here anyway, and without this every export is silently junk.
  // maxOutputLength, or MAX_BODY_BYTES only ever caps the compressed bytes:
  // Node's default ceiling here is ~4GB, so 8MB of gzipped zeros (ratio ~1000:1)
  // would have the main process try to materialise ~8GB and either throw
  // ERR_BUFFER_TOO_LARGE or get killed by the OS. A decompressed export is the
  // same handful of counters as a compressed one.
  if (enc && enc.includes('gzip')) body = gunzipSync(raw, { maxOutputLength: MAX_BODY_BYTES });

  const payload: unknown = JSON.parse(body.toString('utf8'));
  if (path === '/v1/metrics') recordMetrics(parseMetrics(payload));
  else if (path === '/v1/logs') recordEvents(parseLogs(payload));
  // /v1/traces is answered but not read. Traces are switched off in otelEnv;
  // an inherited OTEL_TRACES_EXPORTER would otherwise retry against a 404.
}

/* ── environment ─────────────────────────────────────────────────────── */

/**
 * The exporter configuration handed to a spawned agent.
 *
 * Content logging stays off, deliberately. OTEL_LOG_USER_PROMPTS,
 * OTEL_LOG_ASSISTANT_RESPONSES, OTEL_LOG_TOOL_CONTENT and
 * OTEL_LOG_RAW_API_BODIES would put prompt and response text into this
 * process and into SQLite. Wanigan measures what a session costs, not what it
 * said. They are pinned to false rather than merely left unset because the
 * agent inherits Wanigan's own environment, so one of these switched on in the
 * user's shell would otherwise flow straight through into the database.
 */
export function otelEnv(waniganSessionId: string): Record<string, string> {
  const p = collectorPort();
  const t = collectorToken();
  // No receiver, no telemetry. A session must never fail to launch because the
  // measurement side of the app did not come up.
  if (p === null || !t) return {};

  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_TRACES_EXPORTER: 'none',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${p}`,
    OTEL_METRIC_EXPORT_INTERVAL: '10000',
    OTEL_LOGS_EXPORT_INTERVAL: '5000',
    // Deltas, not cumulative totals: the collector adds each datapoint into a
    // running row, and a cumulative counter added that way squares itself.
    OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'delta',
    OTEL_RESOURCE_ATTRIBUTES: `wanigan.session.id=${attrSafe(waniganSessionId)}`,
    // The receiver refuses anything without this header. A bare hex value in a
    // custom header, not `Authorization: Bearer …`: OTEL_EXPORTER_OTLP_HEADERS
    // is parsed as a baggage-style list, and SDK versions disagree about
    // percent-decoding, so a value containing a space is a coin flip. The
    // signal-specific names are pinned alongside the generic one because they
    // win over it — an OTEL_EXPORTER_OTLP_METRICS_HEADERS left in the user's
    // shell would otherwise strip the token and every export would 401.
    OTEL_EXPORTER_OTLP_HEADERS: `x-wanigan-token=${t}`,
    OTEL_EXPORTER_OTLP_METRICS_HEADERS: `x-wanigan-token=${t}`,
    OTEL_EXPORTER_OTLP_LOGS_HEADERS: `x-wanigan-token=${t}`,
    OTEL_LOG_USER_PROMPTS: 'false',
    OTEL_LOG_ASSISTANT_RESPONSES: 'false',
    OTEL_LOG_TOOL_CONTENT: 'false',
    OTEL_LOG_RAW_API_BODIES: 'false',
  };
}

/**
 * OTEL_RESOURCE_ATTRIBUTES is a comma-separated key=value list. A comma or an
 * equals sign inside the id would split the attribute in transit and every
 * datapoint for that session would land in 'unattributed' — a silent zero with
 * nothing logged anywhere. Wanigan's own ids are already safe, so this is a
 * no-op today and a guard if the id format ever changes.
 */
function attrSafe(id: string): string {
  return id.replace(/[^A-Za-z0-9._:-]/g, '_');
}

/* ── OTLP/JSON parsing ───────────────────────────────────────────────── */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** One `{stringValue|intValue|doubleValue|boolValue}` union, flattened to text. */
function scalarOf(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.stringValue === 'string') return value.stringValue;
  if (typeof value.intValue === 'string' || typeof value.intValue === 'number') return String(value.intValue);
  if (typeof value.doubleValue === 'number') return String(value.doubleValue);
  if (typeof value.boolValue === 'boolean') return String(value.boolValue);
  return null;
}

/** `[{key, value:{...}}]` → `{key: text}`. Entries it cannot read are skipped. */
function attrsToObject(list: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of asArray(list)) {
    if (!isRecord(item)) continue;
    if (typeof item.key !== 'string' || !item.key) continue;
    const v = scalarOf(item.value);
    if (v !== null) out[item.key] = v;
  }
  return out;
}

/**
 * The numeric payload of a datapoint. OTLP/JSON encodes int64 as a decimal
 * *string*, so a plain `typeof v === 'number'` check reads every integer
 * counter — which is most of them — as absent.
 */
function numberOf(dataPoint: unknown): number | null {
  if (!isRecord(dataPoint)) return null;
  for (const k of ['asInt', 'asDouble', 'sum'] as const) {
    const v = dataPoint[k];
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/**
 * Unix nanoseconds → milliseconds. The nanosecond value is far past
 * Number.MAX_SAFE_INTEGER, but only by two orders of magnitude: the spacing
 * between representable values up there is ~256ns, so the millisecond this
 * rounds to is still exact.
 */
function millisOf(nano: unknown): number | null {
  const n = typeof nano === 'string' ? Number(nano) : typeof nano === 'number' ? nano : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n / 1e6);
}

/**
 * Claude Code sets its own `session.id` on every export. That is a different
 * identifier for a different thing, and keying on it would attribute spend to a
 * row Wanigan has never heard of. A payload with no `wanigan.session.id` is
 * still real money, so it is banked under 'unattributed' rather than dropped.
 */
function sessionIdOf(resource: unknown): string {
  const attrs = attrsToObject(isRecord(resource) ? resource.attributes : null);
  const id = (attrs['wanigan.session.id'] ?? '').trim();
  return id ? attrSafe(id) : UNATTRIBUTED;
}

/**
 * The attrs half of a session_metrics primary key. Keys are sorted before the
 * object is built: JSON.stringify follows insertion order, so an unsorted
 * object would spell the same attribute set two ways and split one running
 * total across two rows that nothing ever adds back together.
 */
function attrsKey(attrs: Record<string, string>, keys: string[]): string {
  const picked: Record<string, string> = {};
  for (const k of [...keys].sort()) {
    const v = attrs[k];
    if (v !== undefined && v !== '') picked[k] = v;
  }
  return Object.keys(picked).length ? JSON.stringify(picked) : '';
}

type MetricDelta = { sessionId: string; metric: string; attrs: string; value: number; at: number };

function parseMetrics(payload: unknown): MetricDelta[] {
  const out: MetricDelta[] = [];
  if (!isRecord(payload)) return out;

  for (const rm of asArray(payload.resourceMetrics)) {
    if (!isRecord(rm)) continue;
    const sessionId = sessionIdOf(rm.resource);

    for (const sm of asArray(rm.scopeMetrics)) {
      if (!isRecord(sm)) continue;

      for (const m of asArray(sm.metrics)) {
        if (!isRecord(m)) continue;
        const name = typeof m.name === 'string' ? m.name : '';
        const keys = TRACKED_METRICS[name];
        if (!keys) continue;

        // Sums only. Every metric Wanigan tracks is a delta counter; a gauge
        // reports a level, and adding a level into the running total on each
        // 10s export would multiply it by the number of exports.
        if (!isRecord(m.sum)) continue;

        for (const dp of asArray(m.sum.dataPoints)) {
          const value = numberOf(dp);
          if (value === null || value === 0) continue;
          const attrs = attrsToObject(isRecord(dp) ? dp.attributes : null);
          const at = (isRecord(dp) ? millisOf(dp.timeUnixNano) : null) ?? Date.now();
          out.push({ sessionId, metric: name, attrs: attrsKey(attrs, keys), value, at });
        }
      }
    }
  }
  return out;
}

type EventDelta = {
  sessionId: string; at: number; kind: ApiEvent['kind']; model: string | null;
  costUsd: number; durationMs: number | null; inTokens: number; outTokens: number;
  cacheRead: number; cacheWrite: number; effort: string | null; detail: string | null;
};

function parseLogs(payload: unknown): EventDelta[] {
  const out: EventDelta[] = [];
  if (!isRecord(payload)) return out;

  for (const rl of asArray(payload.resourceLogs)) {
    if (!isRecord(rl)) continue;
    const sessionId = sessionIdOf(rl.resource);

    for (const sl of asArray(rl.scopeLogs)) {
      if (!isRecord(sl)) continue;

      for (const rec of asArray(sl.logRecords)) {
        if (!isRecord(rec)) continue;
        const a = attrsToObject(rec.attributes);
        // The event name lives in the body for Claude Code and in an
        // `event.name` attribute for the OTel events convention. Both are read
        // so a change of convention does not empty the timeline.
        const name = a['event.name'] ?? scalarOf(rec.body) ?? '';
        const kind = LOG_KINDS[name];
        if (!kind) continue;

        const at = millisOf(rec.timeUnixNano) ?? millisOf(rec.observedTimeUnixNano) ?? Date.now();
        out.push({
          sessionId,
          at,
          kind,
          model: a.model ?? null,
          // Older builds report whole micro-dollars instead of a float.
          costUsd: pickNum(a, ['cost_usd']) ?? (pickNum(a, ['cost_usd_micros']) ?? 0) / 1e6,
          durationMs: pickNum(a, ['duration_ms']),
          inTokens: Math.round(pickNum(a, ['input_tokens']) ?? 0),
          outTokens: Math.round(pickNum(a, ['output_tokens']) ?? 0),
          cacheRead: Math.round(pickNum(a, ['cache_read_tokens', 'cache_read_input_tokens']) ?? 0),
          cacheWrite: Math.round(pickNum(a, ['cache_creation_tokens', 'cache_creation_input_tokens']) ?? 0),
          effort: a.effort ?? null,
          detail: detailFor(kind, a),
        });
      }
    }
  }
  return out;
}

function pickNum(attrs: Record<string, string>, keys: string[]): number | null {
  for (const k of keys) {
    const raw = attrs[k];
    if (raw === undefined || raw.trim() === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function detailFor(kind: ApiEvent['kind'], a: Record<string, string>): string | null {
  if (kind === 'error') {
    const parts: string[] = [];
    if (a.error) parts.push(a.error);
    if (a.status_code) parts.push(`status ${a.status_code}`);
    return parts.join(' · ') || 'API error';
  }
  if (kind === 'refusal') return a.category || 'unspecified';
  return null;
}

/* ── writes ──────────────────────────────────────────────────────────── */

function recordMetrics(deltas: MetricDelta[]): void {
  if (!deltas.length) return;
  const d = db();
  const up = d.prepare(`
    INSERT INTO session_metrics (session_id, metric, attrs, value, last_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(session_id, metric, attrs) DO UPDATE SET
      value   = value + excluded.value,
      last_at = MAX(session_metrics.last_at, excluded.last_at)
  `);
  d.transaction((rows: MetricDelta[]) => {
    for (const r of rows) up.run(r.sessionId, r.metric, r.attrs, r.value, r.at);
  })(deltas);
}

function recordEvents(events: EventDelta[]): void {
  if (!events.length) return;
  const d = db();
  const ins = d.prepare(`
    INSERT INTO session_api_events
      (session_id, at, kind, model, cost_usd, duration_ms, in_tokens, out_tokens,
       cache_read, cache_write, effort, detail)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  d.transaction((rows: EventDelta[]) => {
    for (const e of rows) {
      ins.run(e.sessionId, e.at, e.kind, e.model, e.costUsd, e.durationMs,
              e.inTokens, e.outTokens, e.cacheRead, e.cacheWrite, e.effort, e.detail);
    }
  })(events);
}

/* ── reads ───────────────────────────────────────────────────────────── */

type MetricRow = { session_id: string; metric: string; attrs: string; value: number; last_at: number };

function blankUsage(sessionId: string): SessionUsage {
  // Spreading EMPTY_USAGE alone would alias its `models` array into every row
  // it produces, so one caller sorting in place would rewrite the constant.
  return { sessionId, ...EMPTY_USAGE, models: [] };
}

/** Reads one attribute back out of a stored attrs key. */
function attrOf(json: string, key: string): string {
  if (!json) return '';
  try {
    const o: unknown = JSON.parse(json);
    if (isRecord(o) && typeof o[key] === 'string') return o[key];
  } catch { /* written by a build that keyed it differently; treat as unkeyed */ }
  return '';
}

/**
 * Attribute values are matched on a case- and separator-free form. `cacheRead`
 * and `cache_read` are the same bucket, and a build that changes the spelling
 * should not silently start reporting zero cached tokens.
 */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function usageForMany(ids: string[]): Record<string, SessionUsage> {
  const out: Record<string, SessionUsage> = {};
  if (!ids.length) return out;

  // Keyed by the caller's id, looked up by the sanitised one the exporter used.
  const byKey = new Map<string, SessionUsage>();
  for (const id of ids) {
    const u = blankUsage(id);
    out[id] = u;
    byKey.set(attrSafe(id), u);
  }

  const d = db();
  const marks = [...byKey.keys()].map(() => '?').join(',');
  const keys = [...byKey.keys()];

  const metrics = d.prepare(
    `SELECT session_id, metric, attrs, value, last_at FROM session_metrics WHERE session_id IN (${marks})`
  ).all(...keys) as MetricRow[];

  for (const r of metrics) {
    const u = byKey.get(r.session_id);
    if (!u) continue;
    switch (r.metric) {
      case 'claude_code.cost.usage':
        u.costUsd += r.value;
        break;
      case 'claude_code.token.usage':
        switch (norm(attrOf(r.attrs, 'type'))) {
          case 'input': u.inTokens += r.value; break;
          case 'output': u.outTokens += r.value; break;
          case 'cacheread': u.cacheRead += r.value; break;
          case 'cachecreation': case 'cachewrite': u.cacheWrite += r.value; break;
        }
        break;
      case 'claude_code.lines_of_code.count':
        if (norm(attrOf(r.attrs, 'type')) === 'added') u.linesAdded += r.value;
        else if (norm(attrOf(r.attrs, 'type')) === 'removed') u.linesRemoved += r.value;
        break;
      case 'claude_code.commit.count': u.commits += r.value; break;
      case 'claude_code.pull_request.count': u.pullRequests += r.value; break;
      case 'claude_code.active_time.total': u.activeSeconds += r.value; break;
      // claude_code.session.count is stored but contributes nothing to usage.
    }
    if (r.last_at > (u.lastAt ?? 0)) u.lastAt = r.last_at;
  }

  const counts = d.prepare(`
    SELECT session_id, kind, COUNT(*) AS n, MAX(at) AS last
    FROM session_api_events WHERE session_id IN (${marks}) GROUP BY session_id, kind
  `).all(...keys) as { session_id: string; kind: string; n: number; last: number }[];

  for (const c of counts) {
    const u = byKey.get(c.session_id);
    if (!u) continue;
    if (c.kind === 'request') u.requests += c.n;
    else if (c.kind === 'error') u.errors += c.n;
    else if (c.kind === 'refusal') u.refusals += c.n;
    if (c.last > (u.lastAt ?? 0)) u.lastAt = c.last;
  }

  const models = d.prepare(`
    SELECT session_id, model, COUNT(*) AS n
    FROM session_api_events
    WHERE session_id IN (${marks}) AND kind = 'request' AND model IS NOT NULL AND model != ''
    GROUP BY session_id, model ORDER BY n DESC
  `).all(...keys) as { session_id: string; model: string; n: number }[];

  for (const m of models) byKey.get(m.session_id)?.models.push(m.model);

  // Counters are stored as REAL because cost is; the ones that count things
  // are handed back as the integers they are.
  for (const u of byKey.values()) {
    u.inTokens = Math.round(u.inTokens);
    u.outTokens = Math.round(u.outTokens);
    u.cacheRead = Math.round(u.cacheRead);
    u.cacheWrite = Math.round(u.cacheWrite);
    u.linesAdded = Math.round(u.linesAdded);
    u.linesRemoved = Math.round(u.linesRemoved);
    u.commits = Math.round(u.commits);
    u.pullRequests = Math.round(u.pullRequests);
    u.activeSeconds = Math.round(u.activeSeconds);
  }

  // Codex does not emit Wanigan's OTLP stream, but its local rollout contains
  // authoritative cumulative token counters.  Keep the two sources merged at
  // the boundary so Fleet, phone Fleet, and the session panel agree.
  mergeCodexUsage(out);

  return out;
}

export function usageFor(sessionId: string): SessionUsage {
  return usageForMany([sessionId])[sessionId] ?? blankUsage(sessionId);
}

type EventRow = {
  session_id: string; at: number; kind: string; model: string | null; cost_usd: number;
  duration_ms: number | null; in_tokens: number; out_tokens: number; cache_read: number;
  cache_write: number; effort: string | null; detail: string | null;
};

/** Newest first — the panel that shows these is reading the last thing that happened. */
export function apiEvents(sessionId: string, limit = 50): ApiEvent[] {
  const n = Math.max(1, Math.min(1000, Math.floor(limit)));
  const rows = db().prepare(`
    SELECT session_id, at, kind, model, cost_usd, duration_ms, in_tokens, out_tokens,
           cache_read, cache_write, effort, detail
    FROM session_api_events WHERE session_id = ? ORDER BY at DESC, id DESC LIMIT ?
  `).all(attrSafe(sessionId), n) as EventRow[];

  return rows.map((r) => ({
    sessionId: r.session_id,
    at: r.at,
    model: r.model,
    costUsd: r.cost_usd,
    durationMs: r.duration_ms,
    inTokens: r.in_tokens,
    outTokens: r.out_tokens,
    cacheRead: r.cache_read,
    cacheWrite: r.cache_write,
    effort: r.effort,
    kind: r.kind as ApiEvent['kind'],
    detail: r.detail,
  }));
}

/**
 * Output tokens per second across the session's life, oldest bucket first.
 * A rate rather than a sum: a sparkline for a six-hour session and one for a
 * six-minute session have to be legible against the same axis, and summing
 * makes the long session's buckets look busy purely because they are wider.
 */
export function throughput(sessionId: string, buckets = 24): number[] {
  const n = Math.max(1, Math.min(240, Math.floor(buckets)));
  const out = new Array<number>(n).fill(0);

  const rows = db().prepare(
    'SELECT at, out_tokens FROM session_api_events WHERE session_id = ? AND out_tokens > 0 ORDER BY at'
  ).all(attrSafe(sessionId)) as { at: number; out_tokens: number }[];
  if (!rows.length) return out;

  const first = rows[0].at;
  const last = rows[rows.length - 1].at;
  // A session whose turns land milliseconds apart would divide by a near-zero
  // window and produce one spike that flattens every other bucket to nothing.
  // One second per bucket is the floor.
  const span = Math.max(last - first, n * 1000);
  const width = span / n;

  for (const r of rows) {
    const i = Math.min(n - 1, Math.floor((r.at - first) / width));
    out[i] += r.out_tokens;
  }
  return out.map((v) => Math.round((v / (width / 1000)) * 10) / 10);
}

function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Daily session spend, oldest first, with empty days present as zero so a chart
 * gets a continuous axis instead of a compressed one.
 *
 * Bucketed in local time. Grouping on UTC would file an evening's work under
 * tomorrow for anyone west of Greenwich, and the chart would disagree with the
 * clock on the same wall.
 */
export function spendByDay(days: number): { day: string; sessionUsd: number }[] {
  const n = Math.max(1, Math.min(365, Math.floor(days)));
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (n - 1));

  const rows = db().prepare(`
    SELECT date(at / 1000, 'unixepoch', 'localtime') AS day, COALESCE(SUM(cost_usd), 0) AS usd
    FROM session_api_events WHERE at >= ? GROUP BY day
  `).all(start.getTime()) as { day: string; usd: number }[];

  const byDay = new Map(rows.map((r) => [r.day, r.usd]));
  const out: { day: string; sessionUsd: number }[] = [];
  const cur = new Date(start);
  for (let i = 0; i < n; i++) {
    const key = dayKey(cur);
    out.push({ day: key, sessionUsd: byDay.get(key) ?? 0 });
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

/**
 * Total spent on interactive sessions, in USD.
 *
 * Two sources on purpose. The cost metric is the exporter's own running total
 * and is the number to trust for "everything ever", but a metric row carries
 * only its last update time, so it cannot answer a window. Anything with a
 * `sinceMs` is therefore summed from the timestamped api events instead.
 */
export function sessionSpendTotal(sinceMs?: number): number {
  const d = db();
  if (sinceMs === undefined) {
    const r = d.prepare(
      "SELECT COALESCE(SUM(value), 0) AS usd FROM session_metrics WHERE metric = 'claude_code.cost.usage'"
    ).get() as { usd: number };
    return r.usd;
  }
  const r = d.prepare(
    'SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM session_api_events WHERE at >= ?'
  ).get(sinceMs) as { usd: number };
  return r.usd;
}

/**
 * What each effort level actually costs, dearest first. Both numbers come from
 * the same api_request event, so the $/request a caller derives from them is
 * never a ratio of two different accountings.
 */
export function effortBreakdown(): { effort: string; requests: number; costUsd: number }[] {
  const rows = db().prepare(`
    SELECT COALESCE(NULLIF(effort, ''), 'default') AS effort,
           COUNT(*) AS requests, COALESCE(SUM(cost_usd), 0) AS cost
    FROM session_api_events WHERE kind = 'request'
    GROUP BY effort ORDER BY cost DESC
  `).all() as { effort: string; requests: number; cost: number }[];

  return rows.map((r) => ({ effort: r.effort, requests: r.requests, costUsd: r.cost }));
}
