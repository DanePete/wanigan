/**
 * Claude Code's beta per-prompt traces, as a waterfall a person can read.
 *
 * With CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1 and a traces exporter, the CLI
 * exports one trace per prompt: a `claude_code.interaction` root, and under it
 * `claude_code.llm_request` for each model call and `claude_code.tool` for each
 * tool call, which in turn holds `claude_code.tool.blocked_on_user` — the time
 * the call sat waiting on the operator's permission — and
 * `claude_code.tool.execution`. src/main/otel.ts receives the OTLP export and
 * src/main/traces.ts stores it; this file decides what may be stored and how a
 * stored trace is laid out.
 *
 * Why it matters: the hook timeline times a tool call end to end and cannot
 * tell the model's time from the tool's from the human's. These spans carry all
 * three separately, each measured by the CLI itself.
 *
 * Span and attribute names were read out of the 2.1.270 binary's tracing
 * module (checked 2026-09-14), including every attribute it sets only when a
 * content-logging switch is on, so the filter below is written against the
 * real names rather than against a guess at them.
 */

export type SpanAttrValue = string | number | boolean;

export type StoredSpan = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startAt: number;
  /** Null when the export carried no usable end time. */
  endAt: number | null;
  status: 'ok' | 'error' | 'unset';
  attrs: Record<string, SpanAttrValue>;
};

/* ── what may be stored ──────────────────────────────────────────────── */

/**
 * Words that mark an attribute as carrying what was said rather than a fact
 * about the call. Every content attribute the 2.1.270 tracing module can set
 * matches one: `user_prompt`, `new_context` (the prompt or a tool result, under
 * detailed tracing), `system_prompt_preview`, `user_system_prompt`, `tools`
 * (the tool list with hashes), `tool_input`, `response.model_output`,
 * `hook_definitions`, and `error`, whose value is the error's message text.
 * `bash_argv0` is dropped with them: it is the first word of a command line,
 * which is exactly the kind of text this table promises never to hold.
 */
const CONTENT_WORD = /(?:^|[._])(?:prompt|prompts|response|body|bodies|content|context|command|input|output|text|message|messages|preview|definitions?|tools|argv\d*|args|arguments|stdout|stderr|diff|patch|payload|error|query|result)(?:[._]|$)/;

/**
 * Keys that name, count, time or classify, and are kept even though a content
 * word appears in them: `input_tokens`, `result_tokens`, `bash_command_class`,
 * `prompt.id`, `gen_ai.response.id`, `error_class`. The suffix decides, because
 * the suffix is what the value is.
 */
const MEASURE_SUFFIX = /(?:^|[._])(?:tokens|ms|id|class|count|sequence|attempt|reason|decision|speed|effort|code|success|type|system|source|safe|name)$/;

/**
 * Keys kept whole. `llm_request.context` is the class tool/interaction/
 * standalone, `query_source` the main/subagent/auxiliary split, and
 * `response.has_tool_call` a boolean — all three would otherwise match a
 * content word.
 */
const KEEP = new Set(['llm_request.context', 'query_source', 'query_source_safe', 'response.has_tool_call',
  'parent.source', 'queued_sends', 'interaction.sequence', 'interaction.duration_ms']);

/**
 * Identity the SDK stamps on every span: the account's email and uuid, the
 * organisation, the terminal, and whatever resource attributes the operator's
 * shell exported. None of it is about the call, and all of it would be repeated
 * on every row of an unbounded table.
 */
const IDENTITY_PREFIX = /^(?:user|organization|identity|host|os|process|terminal|app|vcs|service|telemetry)\./;

/** Longer than any name, id, class or reason the CLI sets. A longer string is not one of those. */
const MAX_VALUE_LENGTH = 160;
const MAX_ATTRIBUTES = 48;

export function isContentAttribute(key: string): boolean {
  if (KEEP.has(key)) return false;
  if (MEASURE_SUFFIX.test(key)) return false;
  return CONTENT_WORD.test(key);
}

/**
 * The attributes of one span that may reach SQLite. Content is dropped by key
 * before its value is looked at, identity by prefix, and any string too long to
 * be a name or a class is dropped whatever its key says. What survives is what
 * a waterfall reads: ids, names, durations, token counts, stop reasons, error
 * classes and permission decisions.
 */
export function sanitizeSpanAttributes(attrs: Record<string, unknown>): Record<string, SpanAttrValue> {
  const out: Record<string, SpanAttrValue> = {};
  let kept = 0;
  for (const [key, value] of Object.entries(attrs)) {
    if (kept >= MAX_ATTRIBUTES) break;
    if (!key || key.length > 64 || IDENTITY_PREFIX.test(key) || isContentAttribute(key)) continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue;
      out[key] = value;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    } else if (typeof value === 'string') {
      const v = value.trim();
      if (!v || v.length > MAX_VALUE_LENGTH || /[\u0000-\u001f]/.test(v)) continue;
      out[key] = v;
    } else {
      continue;
    }
    kept++;
  }
  return out;
}

/**
 * A trace or span id as lowercase hex, or null. OTLP/JSON specifies hex for
 * these, but protobuf's own JSON mapping spells bytes as base64, and an exporter
 * that followed the latter must not have every span silently discarded.
 */
export function normalizeSpanId(value: unknown, bytes: 8 | 16): string | null {
  if (typeof value !== 'string' || !value) return null;
  const hex = new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`);
  if (hex.test(value)) return /^0+$/.test(value) ? null : value.toLowerCase();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const raw = atob(value);
    if (raw.length !== bytes) return null;
    const out = [...raw].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    return /^0+$/.test(out) ? null : out;
  } catch {
    return null;
  }
}

/* ── reading an OTLP/JSON export ─────────────────────────────────────── */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * One OTLP AnyValue as a scalar, or undefined. OTLP/JSON spells int64 as a
 * decimal string, so a token count arrives as "1200" and is read as the number
 * it is; arrays, key-value lists and bytes are not facts a waterfall reads, and
 * they are exactly where a tool's input would be packed.
 */
function anyValue(v: unknown): SpanAttrValue | undefined {
  if (!isRecord(v)) return undefined;
  if (typeof v.stringValue === 'string') return v.stringValue;
  if (typeof v.boolValue === 'boolean') return v.boolValue;
  if (typeof v.doubleValue === 'number') return Number.isFinite(v.doubleValue) ? v.doubleValue : undefined;
  if (typeof v.intValue === 'number') return Number.isFinite(v.intValue) ? v.intValue : undefined;
  if (typeof v.intValue === 'string' && /^-?\d{1,19}$/.test(v.intValue)) return Number(v.intValue);
  return undefined;
}

function attributesOf(list: unknown): Record<string, SpanAttrValue> {
  const out: Record<string, SpanAttrValue> = {};
  for (const item of asArray(list).slice(0, 256)) {
    if (!isRecord(item) || typeof item.key !== 'string' || !item.key) continue;
    const value = anyValue(item.value);
    if (value !== undefined) out[item.key] = value;
  }
  return out;
}

/** Unix nanoseconds → milliseconds; the rounding is exact to the millisecond (see otel.ts millisOf). */
function nanosToMs(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n / 1e6);
}

/**
 * The CLI's batch processor sends at most 512 spans an export by default. A
 * payload far past that is not a turn's trace, and the collector stores what
 * fits rather than holding a transaction open over an unbounded list.
 */
export const MAX_SPANS_PER_EXPORT = 2048;

export type ExportedSpan = {
  /** The `wanigan.session.id` resource attribute exactly as sent, or null when the resource carried none. */
  resourceSessionId: string | null;
  span: StoredSpan;
};

/**
 * Every usable span in one OTLP/JSON traces export, already sanitised.
 *
 * What is never read: span events, links, the status message (an error's own
 * text) and every attribute sanitizeSpanAttributes refuses. A span missing an
 * id, a name or a start time is dropped whole; one whose end precedes its start
 * keeps its start and is drawn as incomplete rather than as a negative bar.
 */
export function spansFromOtlp(payload: unknown, max: number = MAX_SPANS_PER_EXPORT): ExportedSpan[] {
  const out: ExportedSpan[] = [];
  if (!isRecord(payload)) return out;
  for (const rs of asArray(payload.resourceSpans)) {
    if (!isRecord(rs)) continue;
    const resource = attributesOf(isRecord(rs.resource) ? rs.resource.attributes : null);
    const raw = resource['wanigan.session.id'];
    const resourceSessionId = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    for (const ss of asArray(rs.scopeSpans)) {
      if (!isRecord(ss)) continue;
      for (const sp of asArray(ss.spans)) {
        if (out.length >= max) return out;
        if (!isRecord(sp)) continue;
        const traceId = normalizeSpanId(sp.traceId, 16);
        const spanId = normalizeSpanId(sp.spanId, 8);
        const name = typeof sp.name === 'string' ? sp.name.trim() : '';
        const startAt = nanosToMs(sp.startTimeUnixNano);
        if (!traceId || !spanId || !name || name.length > 96 || startAt === null) continue;
        const endAt = nanosToMs(sp.endTimeUnixNano);
        const code = isRecord(sp.status) ? sp.status.code : undefined;
        // The enum is 1/2 in OTLP/JSON and its name in protobuf's own JSON mapping.
        const status: StoredSpan['status'] = code === 2 || code === 'STATUS_CODE_ERROR' ? 'error'
          : code === 1 || code === 'STATUS_CODE_OK' ? 'ok' : 'unset';
        out.push({
          resourceSessionId,
          span: {
            traceId, spanId, parentSpanId: normalizeSpanId(sp.parentSpanId, 8), name, startAt,
            endAt: endAt !== null && endAt >= startAt ? endAt : null,
            status,
            attrs: sanitizeSpanAttributes(attributesOf(sp.attributes)),
          },
        });
      }
    }
  }
  return out;
}

/* ── the waterfall ───────────────────────────────────────────────────── */

export type WaterfallKind = 'llm_request' | 'tool' | 'blocked' | 'execution' | 'hook' | 'other';

export type WaterfallRow = {
  spanId: string;
  kind: WaterfallKind;
  label: string;
  depth: number;
  /** Milliseconds from the interaction's start to this span's start. */
  offsetMs: number;
  durationMs: number | null;
  /** Why this span cannot be drawn whole, or null when it can. */
  incomplete: string | null;
  error: boolean;
  /** Short facts off the span itself: time to first token, attempt, stop reason, tokens, decision. */
  facts: string[];
  /** Set on a subagent's model calls, so the rail can say whose they were. */
  agentId: string | null;
};

export type TraceInteraction = {
  traceId: string;
  startAt: number;
  endAt: number | null;
  durationMs: number | null;
  /** The interaction span itself never arrived; offsets are from the earliest span that did. */
  rootMissing: boolean;
  incomplete: boolean;
  sequence: number | null;
  rows: WaterfallRow[];
  /** Time inside model calls, tool calls, and waiting on the operator, each summed across the turn. */
  totals: { llmMs: number; toolMs: number; blockedMs: number };
};

const INTERACTION = 'claude_code.interaction';

function kindOf(name: string): WaterfallKind {
  switch (name) {
    case 'claude_code.llm_request': return 'llm_request';
    case 'claude_code.tool': return 'tool';
    case 'claude_code.tool.blocked_on_user': return 'blocked';
    case 'claude_code.tool.execution': return 'execution';
    case 'claude_code.hook': return 'hook';
    default: return 'other';
  }
}

function str(v: SpanAttrValue | undefined): string | null {
  return typeof v === 'string' && v ? v : null;
}

function num(v: SpanAttrValue | undefined): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function labelOf(span: StoredSpan, kind: WaterfallKind): string {
  const a = span.attrs;
  switch (kind) {
    case 'llm_request': return str(a.model) ?? str(a['gen_ai.request.model']) ?? 'model request';
    case 'tool': return str(a.tool_name) ?? str(a.tool_name_safe) ?? 'tool';
    case 'blocked': return 'waiting on you';
    case 'execution': return 'running';
    case 'hook': return str(a.hook_event) ?? str(a.hook_name) ?? 'hook';
    default: return span.name.replace(/^claude_code\./, '');
  }
}

const tokens = (n: number) => n.toLocaleString('en-US');

function factsOf(span: StoredSpan, kind: WaterfallKind): string[] {
  const a = span.attrs;
  const out: string[] = [];
  const ttft = num(a.ttft_ms);
  if (ttft !== null) out.push(`first token ${Math.round(ttft)}ms`);
  const attempt = num(a.attempt);
  if (attempt !== null && attempt > 1) out.push(`attempt ${attempt}`);
  const stop = str(a.stop_reason);
  if (stop) out.push(`stop ${stop}`);
  const errorClass = str(a.error_class);
  if (errorClass) out.push(`error ${errorClass}`);
  const input = num(a.input_tokens);
  const output = num(a.output_tokens);
  if (input !== null || output !== null) out.push(`${tokens(input ?? 0)} in · ${tokens(output ?? 0)} out`);
  const cacheRead = num(a.cache_read_tokens);
  if (cacheRead !== null && cacheRead > 0) out.push(`${tokens(cacheRead)} cached`);
  const result = num(a.result_tokens);
  if (kind === 'tool' && result !== null) out.push(`${tokens(result)} result tokens`);
  const decision = str(a.decision);
  if (decision) out.push(`you chose ${decision}${str(a.source) ? ` (${str(a.source)})` : ''}`);
  const querySource = str(a.query_source) ?? str(a.query_source_safe);
  if (kind === 'llm_request' && querySource && querySource !== 'repl_main_thread') out.push(querySource);
  return out;
}

/**
 * Every interaction in a set of stored spans, oldest first, each laid out as
 * rows offset from its start.
 *
 * "Incomplete" is said out loud rather than drawn around. The exporter only
 * sends a span once it has ended, so a turn killed mid-flight leaves children
 * whose parent never arrived and an interaction that was never exported; a
 * span without an end time is drawn from its start with no bar. Each such row
 * names what is missing, and a trace with no root is still a trace.
 */
export function buildInteractions(spans: readonly StoredSpan[]): TraceInteraction[] {
  const byTrace = new Map<string, StoredSpan[]>();
  for (const s of spans) {
    const list = byTrace.get(s.traceId);
    if (list) list.push(s); else byTrace.set(s.traceId, [s]);
  }

  const out: TraceInteraction[] = [];
  for (const [traceId, list] of byTrace) {
    const ids = new Map(list.map((s) => [s.spanId, s]));
    const root = list.filter((s) => s.name === INTERACTION).sort((a, b) => a.startAt - b.startAt)[0] ?? null;
    const startAt = root?.startAt ?? Math.min(...list.map((s) => s.startAt));

    const depthOf = (s: StoredSpan): number => {
      let depth = 0;
      let cur: StoredSpan | undefined = s;
      const seen = new Set<string>();
      while (cur && cur.parentSpanId && ids.has(cur.parentSpanId) && !seen.has(cur.spanId)) {
        seen.add(cur.spanId);
        cur = ids.get(cur.parentSpanId);
        if (cur && cur !== root) depth++;
      }
      return depth;
    };

    const rows: WaterfallRow[] = [];
    const totals = { llmMs: 0, toolMs: 0, blockedMs: 0 };
    let incompleteRows = 0;
    for (const s of [...list].sort((a, b) => a.startAt - b.startAt || a.spanId.localeCompare(b.spanId))) {
      if (s === root) continue;
      const kind = kindOf(s.name);
      const durationMs = s.endAt !== null && s.endAt >= s.startAt ? s.endAt - s.startAt : null;
      const orphan = s.parentSpanId !== null && !ids.has(s.parentSpanId);
      const incomplete = durationMs === null ? 'no end time was exported'
        : orphan ? (root ? 'its parent span was not recorded' : 'the prompt’s interaction span was not recorded')
          : null;
      if (incomplete) incompleteRows++;
      if (durationMs !== null) {
        if (kind === 'llm_request') totals.llmMs += durationMs;
        else if (kind === 'tool') totals.toolMs += durationMs;
        else if (kind === 'blocked') totals.blockedMs += durationMs;
      }
      rows.push({
        spanId: s.spanId,
        kind,
        label: labelOf(s, kind),
        depth: depthOf(s),
        offsetMs: Math.max(0, s.startAt - startAt),
        durationMs,
        incomplete,
        error: s.status === 'error' || str(s.attrs.error_class) !== null || s.attrs.success === false,
        facts: factsOf(s, kind),
        agentId: str(s.attrs.agent_id),
      });
    }

    const endAt = root ? root.endAt : null;
    out.push({
      traceId,
      startAt,
      endAt,
      durationMs: root && root.endAt !== null && root.endAt >= root.startAt ? root.endAt - root.startAt : null,
      rootMissing: root === null,
      incomplete: root === null || root.endAt === null || incompleteRows > 0,
      sequence: root ? num(root.attrs['interaction.sequence']) : null,
      rows,
      totals,
    });
  }
  return out.sort((a, b) => a.startAt - b.startAt);
}

/**
 * How far before a turn's UserPromptSubmit hook an interaction may start and
 * still be that turn's. The CLI opens the span as it takes the prompt and posts
 * the hook as it does the same thing, from one process, so seconds is generous;
 * it only has to absorb the hook's own round trip.
 */
export const TURN_TRACE_TOLERANCE_MS = 5_000;

/**
 * Which interactions belong to which turn. `turnStarts` are the turns' prompt
 * times in any order; the answer is keyed by that time. An interaction goes to
 * the latest turn that started no later than it did (with the tolerance above),
 * so a trace is never shown under a turn it could not have come from, and one
 * that predates every turn on screen is left out rather than attached to the
 * oldest.
 */
export function tracesByTurn(turnStarts: readonly number[], interactions: readonly TraceInteraction[]): Map<number, TraceInteraction[]> {
  const starts = [...new Set(turnStarts)].filter(Number.isFinite).sort((a, b) => a - b);
  const out = new Map<number, TraceInteraction[]>();
  for (const trace of interactions) {
    let owner: number | null = null;
    for (const start of starts) {
      if (start <= trace.startAt + TURN_TRACE_TOLERANCE_MS) owner = start;
      else break;
    }
    if (owner === null) continue;
    const list = out.get(owner);
    if (list) list.push(trace); else out.set(owner, [trace]);
  }
  return out;
}

/**
 * Prompts read per session. A prompt is one trace, so capping by trace rather
 * than by span never cuts the oldest turn on screen in half and draws it as
 * incomplete when it was not.
 */
export const TRACE_TURN_CAP = 200;

/** What a session's traces look like to the Timeline. */
export type SessionTraces = {
  sessionId: string;
  /**
   * Whether this session was launched with the trace exporter switched on.
   * Decides between "no trace recorded for this turn" and saying nothing per
   * turn at all: a session launched with traces off has no missing traces.
   */
  requested: boolean;
  /** Whether new launches record traces now. */
  enabledNow: boolean;
  /** Spans on record for the session. */
  spans: number;
  /** True when more spans exist than were read; the oldest turns are the ones left out. */
  capped: boolean;
  interactions: TraceInteraction[];
};
