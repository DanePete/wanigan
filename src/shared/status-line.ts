/**
 * What Claude Code's status line says about an account and a session, and what
 * can honestly be said from it. src/main/statusline.ts receives the JSON the
 * CLI hands its status line command and stores what this file keeps; the Usage
 * view and the Timeline read the forecast and the cache readout back.
 *
 * Why the status line. It is the one place the CLI reports the provider's own
 * limit windows — `rate_limits.five_hour` and `rate_limits.seven_day`, a used
 * percentage and a reset time each — rather than a token count Wanigan would
 * have to turn into a guess about a plan. Every field name below was read off
 * the status line documentation embedded in the 2.1.270 binary and checked
 * against the builder that produces the object (checked 2026-09-14), not taken
 * from a web page.
 *
 * What it does not say. The windows arrive only for Claude subscriptions, only
 * after a session's first response, and each is dropped once its reset passes;
 * an API-key login never has them. So an absent window is kept absent all the
 * way to the screen. A reading with no window is a reading, not a zero.
 */

/** The three windows the CLI names. `spend_limit` appears only behind a Claude gateway. */
export type LimitWindowKind = 'five_hour' | 'seven_day' | 'spend_limit';

export const LIMIT_WINDOW_KINDS: readonly LimitWindowKind[] = ['five_hour', 'seven_day', 'spend_limit'];

export type RateWindowReading = {
  /** 0–100 for the subscription windows; a gateway spend limit reads above 100 once exceeded. */
  usedPercent: number;
  /** Epoch milliseconds. The CLI sends seconds; converted once, here. */
  resetsAt: number;
};

export type PromptCacheReading = {
  warm: boolean | null;
  /** False means the provider reported no cache tokens at all, which is not the same as cold. */
  cachingObserved: boolean | null;
  ttl: string | null;
  expiresAt: number | null;
  requests: number | null;
  misses: number | null;
  expectedRebuilds: number | null;
  hitRatio: number | null;
  cacheWriteTokens: number | null;
  missRecacheTokens: number | null;
  lastMissAt: number | null;
  /** The CLI's own closed-set cause names for the most recent miss. Empty when none was diagnosed. */
  lastMissCauses: string[];
  missCauses: { cause: string; count: number }[];
  recacheTokensIfCold: number | null;
};

export type StatusLineReading = {
  cliVersion: string | null;
  windows: Partial<Record<LimitWindowKind, RateWindowReading>>;
  effort: string | null;
  pr: { number: number; url: string | null; reviewState: string | null } | null;
  promptId: string | null;
  cache: PromptCacheReading | null;
};

/**
 * The CLI's words for each miss cause, copied from the table the 2.1.270 binary
 * prints on its own `/usage` "Prompt cache (main)" line. The readout shows the
 * CLI's name and these words side by side, so a cause this table has not
 * learned yet still reaches the screen as the CLI spelled it.
 */
export const MISS_CAUSE_LABELS: Readonly<Record<string, string>> = {
  system_prompt_changed: 'system prompt changed',
  tools_changed: 'tool definitions changed',
  model_changed: 'model changed',
  fast_mode_changed: 'fast mode toggled',
  cache_scope_or_ttl_changed: 'cache scope or TTL changed',
  betas_changed: 'beta headers changed',
  effort_changed: 'effort changed',
  auto_mode_changed: 'auto mode toggled',
  overage_changed: 'usage-limit state changed',
  extra_body_changed: 'extra request fields changed',
  defer_loading_changed: 'deferred tool loading changed',
  messages_rewritten: 'earlier messages changed',
  ttl_expired_5m: 'idle past the 5m TTL',
  ttl_expired_1h: 'idle past the 1h TTL',
  likely_server_side: 'prompt unchanged — likely server-side',
  unknown: 'unknown',
};

/* ── parsing ─────────────────────────────────────────────────────────── */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Epoch seconds from the CLI, as milliseconds, or null. The bounds are wide on
 * purpose — they only refuse a value that cannot be a date at all, because a
 * reset time rendered from garbage reads as a real countdown.
 */
function epochSeconds(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v < 1_500_000_000 || v > 4_102_444_800) return null;
  return Math.round(v * 1000);
}

function count(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e13) return null;
  return Math.round(v);
}

function ratio(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return null;
  return v;
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function token(v: unknown, pattern: RegExp): string | null {
  return typeof v === 'string' && pattern.test(v) ? v : null;
}

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:[-+.][0-9A-Za-z.-]{1,32})?$/;
const EFFORT = /^[a-z][a-z0-9_-]{0,15}$/;
const PROMPT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CAUSE = /^[a-z0-9_]{1,48}$/;
const TTL = /^\d{1,4}[smhd]$/;
const REVIEW_STATE = /^[a-z_]{1,24}$/;

function windowOf(v: unknown, max: number): RateWindowReading | null {
  if (!isRecord(v)) return null;
  const used = v.used_percentage;
  const resetsAt = epochSeconds(v.resets_at);
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > max || resetsAt === null) return null;
  return { usedPercent: Math.round(used * 100) / 100, resetsAt };
}

function prOf(v: unknown): StatusLineReading['pr'] {
  if (!isRecord(v)) return null;
  const n = v.number;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 1e9) return null;
  let url: string | null = null;
  if (typeof v.url === 'string' && v.url.length <= 512) {
    try {
      const u = new URL(v.url);
      // Only a link a person could follow. Anything else is dropped rather
      // than stored, because this field is rendered as a destination.
      if (u.protocol === 'https:' || u.protocol === 'http:') url = u.href;
    } catch { /* not a URL; the number still stands */ }
  }
  return { number: n, url, reviewState: token(v.review_state, REVIEW_STATE) };
}

function causesOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const c of v.slice(0, 16)) {
    if (typeof c === 'string' && CAUSE.test(c) && !out.includes(c)) out.push(c);
  }
  return out;
}

function cacheOf(v: unknown): PromptCacheReading | null {
  if (!isRecord(v)) return null;
  const last = isRecord(v.last_miss_cause) ? v.last_miss_cause : null;
  const missCauses: { cause: string; count: number }[] = [];
  if (isRecord(v.miss_causes)) {
    for (const [cause, n] of Object.entries(v.miss_causes).slice(0, 32)) {
      const c = count(n);
      if (CAUSE.test(cause) && c !== null) missCauses.push({ cause, count: c });
    }
  }
  missCauses.sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause));
  return {
    warm: bool(v.warm),
    cachingObserved: bool(v.caching_observed),
    ttl: token(v.ttl, TTL),
    expiresAt: epochSeconds(v.expires_at),
    requests: count(v.requests),
    misses: count(v.misses),
    expectedRebuilds: count(v.expected_rebuilds),
    hitRatio: ratio(v.hit_ratio),
    cacheWriteTokens: count(v.cache_write_tokens),
    missRecacheTokens: count(v.miss_recache_tokens),
    lastMissAt: epochSeconds(v.last_miss_at),
    lastMissCauses: last ? causesOf(last.causes) : [],
    missCauses,
    recacheTokensIfCold: count(v.recache_tokens_if_cold),
  };
}

/**
 * The fields Wanigan keeps out of one status line payload, or null when the
 * payload is not an object at all.
 *
 * Everything else the CLI puts on stdin is deliberately not read: the working
 * directory and transcript path, the session's name, the model, the running
 * cost and the context window. None of it is a limit or a cache fact, and a
 * status line row that carried paths would be a second, unbounded copy of what
 * session_log already records.
 */
export function parseStatusLine(payload: unknown): StatusLineReading | null {
  if (!isRecord(payload)) return null;
  const windows: StatusLineReading['windows'] = {};
  const limits = isRecord(payload.rate_limits) ? payload.rate_limits : null;
  if (limits) {
    const five = windowOf(limits.five_hour, 100);
    const seven = windowOf(limits.seven_day, 100);
    // A gateway spend limit is documented as reading above 100 once exceeded.
    const spend = windowOf(limits.spend_limit, 1000);
    if (five) windows.five_hour = five;
    if (seven) windows.seven_day = seven;
    if (spend) windows.spend_limit = spend;
  }
  return {
    cliVersion: token(payload.version, VERSION),
    windows,
    effort: isRecord(payload.effort) ? token(payload.effort.level, EFFORT) : null,
    pr: prOf(payload.pr),
    promptId: token(payload.prompt_id, PROMPT_ID),
    cache: cacheOf(payload.prompt_cache),
  };
}

/**
 * A stable spelling of everything a reading stores except the prompt id, so two
 * readings that say the same thing fold into one row. The prompt id is left out
 * because it changes on every prompt while nothing it identifies is stored
 * against it here; folding on it would write a row per prompt that differs from
 * the last in nothing a reader can see.
 */
export function readingKey(r: StatusLineReading): string {
  return JSON.stringify([
    r.cliVersion,
    LIMIT_WINDOW_KINDS.map((k) => (r.windows[k] ? [r.windows[k]!.usedPercent, r.windows[k]!.resetsAt] : null)),
    r.effort,
    r.pr ? [r.pr.number, r.pr.url, r.pr.reviewState] : null,
    r.cache,
  ]);
}

/* ── forecasting ─────────────────────────────────────────────────────── */

/** "At the last 30 minutes' observed rate" — the window the rate is read over. */
export const FORECAST_LOOKBACK_MS = 30 * 60_000;
/** Two points make a line; one does not. */
export const FORECAST_MIN_SAMPLES = 2;
/**
 * And the two must be far enough apart to be a rate. Two readings a few seconds
 * apart straddle one request and extrapolate a single turn into an hour.
 */
export const FORECAST_MIN_SPAN_MS = 10 * 60_000;
/** A reading older than this is not the current state of the window. */
export const FORECAST_STALE_MS = 30 * 60_000;
/** A rise between two consecutive readings at least this large is flagged. */
export const JUMP_POINTS = 10;
/**
 * The same window's reset can be restated a second either side between
 * responses. Two readings further apart than this are two different windows —
 * the one before a reset and the one after — and are never fitted together.
 */
export const SAME_WINDOW_TOLERANCE_MS = 60_000;

export type LimitSample = { at: number; usedPercent: number; resetsAt: number };

export type LimitForecast =
  /** Too few readings, or too close together, to say anything about a rate. */
  | { state: 'insufficient'; samples: number; spanMs: number }
  /** The newest reading is older than FORECAST_STALE_MS. */
  | { state: 'stale'; lastAt: number }
  /** The newest reading's reset has passed; the CLI stops sending a window once it does. */
  | { state: 'reset'; resetsAt: number }
  | { state: 'exhausted'; resetsAt: number }
  | { state: 'flat'; perHour: number; resetsAt: number }
  /** At this rate the window resets before it fills. `at` is when it would have filled. */
  | { state: 'resets-first'; at: number; perHour: number; resetsAt: number }
  | { state: 'reaches'; at: number; perHour: number; resetsAt: number };

function sameWindow(a: LimitSample, b: LimitSample): boolean {
  return Math.abs(a.resetsAt - b.resetsAt) <= SAME_WINDOW_TOLERANCE_MS;
}

function ordered(samples: readonly LimitSample[]): LimitSample[] {
  return samples
    .filter((s) => Number.isFinite(s.at) && Number.isFinite(s.usedPercent) && Number.isFinite(s.resetsAt))
    .sort((a, b) => a.at - b.at);
}

/**
 * Where one window lands if the last half hour's observed rate holds.
 *
 * A straight line through the first and last readings of the lookback, and
 * deliberately nothing cleverer: the sentence on screen is "at the last 30
 * minutes' observed rate", and a fit the reader cannot reproduce from the two
 * readings it names would be a claim the sentence does not make. No published
 * accuracy figure exists for any limit forecaster, this one included, which is
 * why it refuses rather than guesses whenever the readings are thin.
 */
export function forecastWindow(samples: readonly LimitSample[], now: number): LimitForecast {
  const all = ordered(samples);
  const latest = all[all.length - 1];
  if (!latest) return { state: 'insufficient', samples: 0, spanMs: 0 };
  if (latest.resetsAt <= now) return { state: 'reset', resetsAt: latest.resetsAt };
  if (latest.usedPercent >= 100) return { state: 'exhausted', resetsAt: latest.resetsAt };
  if (now - latest.at > FORECAST_STALE_MS) return { state: 'stale', lastAt: latest.at };

  const lookback = all.filter((s) => sameWindow(s, latest) && s.at >= latest.at - FORECAST_LOOKBACK_MS);
  const first = lookback[0];
  const spanMs = first ? latest.at - first.at : 0;
  if (lookback.length < FORECAST_MIN_SAMPLES || spanMs < FORECAST_MIN_SPAN_MS) {
    return { state: 'insufficient', samples: lookback.length, spanMs };
  }

  const perMs = (latest.usedPercent - first.usedPercent) / spanMs;
  const perHour = Math.round(perMs * 3_600_000 * 100) / 100;
  if (!(perMs > 0)) return { state: 'flat', perHour: Math.max(0, perHour), resetsAt: latest.resetsAt };
  const at = Math.round(latest.at + (100 - latest.usedPercent) / perMs);
  return at >= latest.resetsAt
    ? { state: 'resets-first', at, perHour, resetsAt: latest.resetsAt }
    : { state: 'reaches', at, perHour, resetsAt: latest.resetsAt };
}

/**
 * The readings of one window that belong to the window its newest reading is
 * in, oldest first, each raised to the highest value seen before it.
 *
 * Why a running maximum. A window's used percentage only rises until its reset,
 * but a reading is only as fresh as the last response its session received:
 * the CLI fills rate_limits from the headers of its own most recent API reply.
 * Two sessions on one account therefore disagree whenever one of them has sat
 * idle, and the idle one is always the lower. Fitting a line through both would
 * zigzag, flag a "jump" every time the busy session spoke, and flatten the rate
 * whenever the idle one did. Every reading is a floor under the truth at the
 * time it was taken, so the highest floor so far is the most the readings
 * actually say.
 */
export function windowEnvelope(samples: readonly LimitSample[]): LimitSample[] {
  const all = ordered(samples);
  const latest = all[all.length - 1];
  if (!latest) return [];
  let high = -Infinity;
  return all.filter((s) => sameWindow(s, latest)).map((s) => {
    high = Math.max(high, s.usedPercent);
    return { at: s.at, usedPercent: high, resetsAt: s.resetsAt };
  });
}

export type LimitJump = { fromPercent: number; toPercent: number; fromAt: number; toAt: number };

/**
 * Rises of JUMP_POINTS or more between two consecutive readings of one window,
 * newest first. A limit that moves that far between two looks was spent by
 * something these readings did not see — another machine, claude.ai, a
 * session Wanigan did not start — or the limit itself changed. Either way the
 * forecast beside it is drawn through a step, and the reader is told so.
 */
export function limitJumps(samples: readonly LimitSample[], points: number = JUMP_POINTS): LimitJump[] {
  const all = ordered(samples);
  const out: LimitJump[] = [];
  for (let i = 1; i < all.length; i++) {
    const a = all[i - 1];
    const b = all[i];
    if (!sameWindow(a, b)) continue;
    if (b.usedPercent - a.usedPercent >= points) {
      out.push({ fromPercent: a.usedPercent, toPercent: b.usedPercent, fromAt: a.at, toAt: b.at });
    }
  }
  return out.reverse();
}

/**
 * One account's window as the Usage view states it, or null when no reading of
 * this window exists at all — which is the absent state, carried as absence.
 *
 * `samples` are the arrival times of distinct readings, never the times an
 * unchanged status line was merely drawn again: a redraw carries no newer
 * header than the response before it, so counting it as an observation would
 * stretch a stale value across the lookback and read as a flat rate.
 *
 * The figure shown is the envelope's newest value, and `observedAt` is the most
 * recent reading that actually carried it — not a later, lower one from a
 * session that had not heard from the provider since.
 */
export function summarizeWindow(kind: LimitWindowKind, samples: readonly LimitSample[], now: number): ObservedWindow | null {
  const envelope = windowEnvelope(samples);
  const latest = envelope[envelope.length - 1];
  if (!latest) return null;
  const inWindow = ordered(samples).filter((s) => sameWindow(s, latest));
  const carried = inWindow.filter((s) => s.usedPercent >= latest.usedPercent);
  return {
    kind,
    usedPercent: latest.usedPercent,
    resetsAt: latest.resetsAt,
    observedAt: carried.length ? carried[carried.length - 1].at : latest.at,
    readings: inWindow.length,
    forecast: forecastWindow(envelope, now),
    jumps: limitJumps(envelope),
  };
}

/* ── words ───────────────────────────────────────────────────────────── */

export const WINDOW_LABELS: Readonly<Record<LimitWindowKind, string>> = {
  five_hour: '5-hour window',
  seven_day: '7-day window',
  spend_limit: 'Spend limit',
};

/**
 * The forecast as the Usage view states it. Every time the sentence names is
 * either a reading's own reset — marked "(observed)" — or a crossing drawn
 * through two readings, marked "≈"; nothing else is offered as a time.
 */
export function forecastSentence(f: LimitForecast, clock: (at: number) => string, ago: (at: number) => string): string {
  switch (f.state) {
    case 'insufficient':
      return f.samples < FORECAST_MIN_SAMPLES
        ? `Not enough observations to forecast: one reading in the last 30 minutes, and a forecast needs ${FORECAST_MIN_SAMPLES}.`
        : `Not enough observations to forecast: ${f.samples} readings spanning ${Math.max(1, Math.round(f.spanMs / 60_000))} min, and a forecast needs at least ${FORECAST_MIN_SPAN_MS / 60_000}.`;
    case 'stale':
      return `Not enough observations to forecast: the newest reading arrived ${ago(f.lastAt)}.`;
    case 'reset':
      return `This window reset at ${clock(f.resetsAt)} (observed); no reading of the new one yet.`;
    case 'exhausted':
      return `Used up; resets ${clock(f.resetsAt)} (observed).`;
    case 'flat':
      return `No rise across the last 30 minutes' readings; resets ${clock(f.resetsAt)} (observed).`;
    case 'resets-first':
      return `At the last 30 minutes' observed rate it resets ${clock(f.resetsAt)} (observed) before reaching 100%.`;
    case 'reaches':
      return `At the last 30 minutes' observed rate, reaches 100% ≈ ${clock(f.at)}; resets ${clock(f.resetsAt)} (observed).`;
  }
}

/* ── the relay ───────────────────────────────────────────────────────── */

/**
 * One POSIX shell word. The status line command is run through `/bin/sh -c`,
 * and Wanigan's user-data directory on macOS is "Application Support" — a path
 * with a space in it, which unquoted would run a binary called
 * ".../Library/Application". Single quotes pass everything literally; the one
 * character they cannot contain is closed, escaped and reopened.
 */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** How long the operator's own status line command may run before the relay gives up on it. */
export const CHAIN_BOUND_SECONDS = 5;

/**
 * The `statusLine.command` Wanigan injects. Every path is quoted, and nothing in
 * it is a secret: the bearer lives in the curl config file, and this string is
 * what every process listing on the machine can read once the CLI runs it.
 */
export function statusLineCommand(input: {
  relay: string; curl: string; config: string; chain: string; boundSeconds?: number;
}): string {
  const bound = Math.max(1, Math.min(60, Math.round(input.boundSeconds ?? CHAIN_BOUND_SECONDS)));
  return [input.relay, input.curl, input.config, input.chain].map(shellQuote).join(' ') + ` ${bound}`;
}

/**
 * One value in curl's config-file syntax, where a double-quoted string takes
 * backslash escapes. A line break cannot be escaped into a header safely at
 * all, so it is refused rather than encoded: a value that could end the line
 * could start a second directive.
 */
function curlValue(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('A curl config value cannot contain a control character.');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The file the relay hands to `curl -K`. The token is a header here and
 * nowhere else, so it never appears in an argument vector.
 *
 * `noproxy = "*"` because curl honours http_proxy and ~/.curlrc, and a proxy a
 * person set for their own browsing would otherwise be handed a loopback
 * bearer; the relay also passes -q so no .curlrc is read at all. The timeouts
 * keep a Wanigan that is busy or gone from delaying the status line by more
 * than a second.
 */
export function curlConfig(input: { port: number; capability: string }): string {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error('The status line port is not a TCP port.');
  return [
    `url = ${curlValue(`http://127.0.0.1:${input.port}/statusline`)}`,
    `header = ${curlValue(`Authorization: Bearer ${input.capability}`)}`,
    `header = ${curlValue('Content-Type: application/json')}`,
    'noproxy = "*"',
    'connect-timeout = 1',
    'max-time = 1',
    'silent',
    '',
  ].join('\n');
}

/* ── what the renderer is handed ─────────────────────────────────────── */

export type ObservedWindow = {
  kind: LimitWindowKind;
  /** The highest reading in the current window (see windowEnvelope). */
  usedPercent: number;
  resetsAt: number;
  /** When the newest reading carrying that figure arrived. */
  observedAt: number;
  /** Distinct readings of this window inside the rows read. */
  readings: number;
  forecast: LimitForecast;
  /** Newest first; only rises inside the current window. */
  jumps: LimitJump[];
};

export type ObservedAccount = {
  /** Null gathers readings from sessions that ran on no account. */
  accountId: string | null;
  accountLabel: string;
  harness: string | null;
  /** Distinct readings on record for the account, windows or not. Zero is "never read", not "no limits". */
  readings: number;
  /** The newest reading of any kind, windows or not. Null when there is none. */
  latestAt: number | null;
  cliVersion: string | null;
  /** Only the windows the CLI actually reported. An absent window is not here. */
  windows: ObservedWindow[];
};

export type ObservedLimitsReport = {
  at: number;
  /** Whether new sessions are launched with the status line relay at all. */
  relayEnabled: boolean;
  hooksEnabled: boolean;
  /** Why this machine cannot run the relay at all, or null when it can. */
  unsupported: string | null;
  accounts: ObservedAccount[];
};

export type SessionStatusLine = {
  sessionId: string;
  readings: number;
  /** When the newest distinct reading arrived. */
  observedAt: number;
  /** When the status line last drew that same reading again. */
  lastSeenAt: number;
  cliVersion: string | null;
  effort: string | null;
  pr: StatusLineReading['pr'];
  cache: PromptCacheReading | null;
};
