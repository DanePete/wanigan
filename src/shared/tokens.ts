// Tokens a conversation used, read from the agent's own record of it. Pure, so
// the counting rules are tested.
//
// Claude Code: the `message.usage` it records on each assistant line (2.1.292).
// - Claude Code writes one line per content block of a reply, each repeating
//   that reply's usage, so a reply is counted once, by its message id.
// - A forked or resumed conversation copies earlier replies with their ids, so
//   merging transcripts by id never counts a reply twice.
// - "In context now" is what the latest main-thread request sent: its input
//   plus cache reads and writes. Subagents spend tokens but have their own
//   context, so they count toward the total and never toward context.

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ConversationUsage extends TokenCounts {
  /** Requests counted (one per reply). */
  requests: number;
  /** Tokens the latest main-thread request sent, or null before the first reply. */
  context: number | null;
  /** The model's context window, when the agent says it (Codex does; Claude Code's transcript does not). */
  contextWindow: number | null;
  /** The model of the latest main-thread reply. */
  model: string | null;
  /** Subagent transcripts whose replies are included. */
  subagents: number;
  /** Whose record the counts came from. */
  source: 'claude' | 'codex' | 'mixed';
}

type Json = Record<string, unknown>;

interface Reply extends TokenCounts { at: number; main: boolean; model: string | null }

/** Replies by message id, gathered line by line from any number of transcripts. */
export class UsageTally {
  private readonly replies = new Map<string, Reply>();
  private order = 0;
  subagents = 0;

  /** One transcript line, raw. Lines that carry no usage are skipped before parsing. */
  addLine(line: string, main = true): void {
    if (!line.includes('"usage"')) return;
    let l: Json;
    try { l = JSON.parse(line) as Json; } catch { return; }
    this.add(l, main);
  }

  add(l: Json, main = true): void {
    if (l.type !== 'assistant') return;
    const message = l.message as Json | undefined;
    const usage = message?.usage as Json | undefined;
    if (!usage || message?.model === '<synthetic>') return;
    const id = str(message?.id) ?? str(l.requestId) ?? str(l.uuid);
    if (!id) return;
    const earlier = this.replies.get(id);
    this.replies.set(id, {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
      // A repeated line keeps the reply's place; only a new reply moves "latest".
      at: earlier?.at ?? ++this.order,
      main: (earlier?.main ?? false) || (main && l.isSidechain !== true),
      model: str(message?.model) ?? earlier?.model ?? null,
    });
  }

  total(): ConversationUsage {
    const sum: ConversationUsage = {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, context: null, contextWindow: null, model: null, subagents: this.subagents, source: 'claude',
    };
    let latest: Reply | null = null;
    for (const r of this.replies.values()) {
      sum.input += r.input;
      sum.output += r.output;
      sum.cacheRead += r.cacheRead;
      sum.cacheWrite += r.cacheWrite;
      sum.requests += 1;
      if (r.main && (!latest || r.at > latest.at)) latest = r;
    }
    if (latest) {
      sum.context = latest.input + latest.cacheRead + latest.cacheWrite;
      sum.model = latest.model;
    }
    return sum;
  }
}

/**
 * Codex (codex-cli 0.155.1) keeps a thread in a rollout of `{timestamp, type,
 * payload}` lines. After each model response it writes an `event_msg` whose
 * payload is `{type: "token_count", info}`, `info` being `{total_token_usage,
 * last_token_usage, model_context_window}` and each usage `{input_tokens,
 * cached_input_tokens, cache_write_input_tokens, output_tokens,
 * reasoning_output_tokens, total_tokens}` — names read from the binary and its
 * app-server schema, counted the way OpenAI's own bundled codex-security
 * plugin counts them:
 * - `input_tokens` includes the cached and cache-written input, and
 *   `output_tokens` includes reasoning, so input + output is everything.
 * - `total_token_usage` is the thread's running total. Its usage is the sum of
 *   how much each total grew; a total that went down was restarted, and counts
 *   from zero.
 * - A fork starts with its parent's lines copied in, totals included. Those are
 *   the parent's until the fork's own first turn starts.
 * - Codex says the model's context window, so context can be read against it.
 */
export class CodexTally {
  private thread: string | null = null;
  private inherited = false;
  private before: CodexUsage = NO_USAGE;
  private readonly sum: CodexUsage = { ...NO_USAGE };
  private requests = 0;
  private context: number | null = null;
  private window: number | null = null;
  private model: string | null = null;

  /** One rollout line, raw. Lines that cannot matter are skipped before parsing. */
  addLine(line: string): void {
    if (!/"(token_count|session_meta|turn_context|task_started)"/.test(line)) return;
    let l: Json;
    try { l = JSON.parse(line) as Json; } catch { return; }
    this.add(l);
  }

  add(l: Json): void {
    const p = l.payload && typeof l.payload === 'object' ? l.payload as Json : null;
    if (!p) return;
    if (l.type === 'session_meta') {
      this.thread = str(p.id) ?? str(p.session_id);
      this.inherited = str(p.forked_from_id) !== null;
      return;
    }
    if (l.type === 'turn_context') { this.model = str(p.model) ?? this.model; return; }
    if (l.type !== 'event_msg') return;
    if (p.type === 'task_started') {
      if (this.inherited && ownTurn(this.thread, str(p.turn_id))) this.inherited = false;
      return;
    }
    const info = p.type === 'token_count' && p.info && typeof p.info === 'object' ? p.info as Json : null;
    const total = codexUsage(info?.total_token_usage);
    if (!info || !total) return;
    if (!this.inherited) {
      const grew = growth(total, this.before);
      if (grew.input + grew.output > 0) {
        for (const k of USAGE_KEYS) this.sum[k] += grew[k];
        this.requests += 1;
        this.context = codexUsage(info.last_token_usage)?.input ?? this.context;
      }
    }
    this.before = total;
    if (typeof info.model_context_window === 'number' && Number.isFinite(info.model_context_window) && info.model_context_window > 0) {
      this.window = info.model_context_window;
    }
  }

  total(): ConversationUsage {
    const s = this.sum;
    return {
      input: Math.max(0, s.input - s.cached - s.cacheWrite), output: s.output, cacheRead: s.cached, cacheWrite: s.cacheWrite,
      requests: this.requests, context: this.context, contextWindow: this.window, model: this.model, subagents: 0, source: 'codex',
    };
  }
}

interface CodexUsage { input: number; cached: number; cacheWrite: number; output: number }

const NO_USAGE: CodexUsage = { input: 0, cached: 0, cacheWrite: 0, output: 0 };
const USAGE_KEYS = ['input', 'cached', 'cacheWrite', 'output'] as const;
const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7/i;

function codexUsage(value: unknown): CodexUsage | null {
  const u = value && typeof value === 'object' ? value as Json : null;
  if (!u || !isCount(u.input_tokens) || !isCount(u.output_tokens)) return null;
  const cached = isCount(u.cached_input_tokens) ? u.cached_input_tokens : 0;
  const write = u.cache_write_input_tokens ?? u.cache_write_tokens;
  const cacheWrite = isCount(write) ? write : 0;
  return cached + cacheWrite > u.input_tokens ? null : { input: u.input_tokens, cached, cacheWrite, output: u.output_tokens };
}

/** How much each running total grew; one that went down was restarted, and all of it is new. */
function growth(now: CodexUsage, before: CodexUsage): CodexUsage {
  const d = (a: number, b: number): number => (a >= b ? a - b : a);
  return { input: d(now.input, before.input), cached: d(now.cached, before.cached), cacheWrite: d(now.cacheWrite, before.cacheWrite), output: d(now.output, before.output) };
}

/** A fork's own turn: Codex's ids are time-ordered (UUIDv7), so its turns sort after the fork. */
function ownTurn(thread: string | null, turn: string | null): boolean {
  if (!turn) return false;
  if (!thread || !V7.test(thread) || !V7.test(turn)) return true;
  return turn.toLowerCase() >= thread.toLowerCase();
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Several conversations as one count, for a card whose sessions ran different agents. */
export function mergeUsage(a: ConversationUsage | null, b: ConversationUsage | null): ConversationUsage | null {
  if (!a || !b) return a ?? b;
  return {
    input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite,
    requests: a.requests + b.requests, context: a.context ?? b.context, contextWindow: a.context !== null ? a.contextWindow : b.contextWindow,
    model: a.model ?? b.model, subagents: a.subagents + b.subagents, source: a.source === b.source ? a.source : 'mixed',
  };
}

/** Every token the conversation sent or received. */
export function tokensUsed(u: TokenCounts): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite;
}

/** 1234 → "1.2k", 1234567 → "1.2M": a count for a glance, not for accounting. */
export function shortTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}

function trim(x: number): string {
  return x >= 100 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, '');
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}
