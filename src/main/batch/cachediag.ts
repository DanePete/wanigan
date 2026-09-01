import { db } from '../db';
import { client, isMock } from './anthropic';
import type { CacheDiagnosis, CacheTtl, RunConfig, SystemBlock } from '../../shared/types';
import { estimateTokens } from '../../shared/tokens';

/**
 * Minimum cacheable prefix, in tokens, per model.
 *
 * This is local knowledge, exactly like the pricing table next door: the API
 * does not report the floor and does not error when a prefix falls under it. It
 * simply declines to create an entry — no write, no read, no warning — so a run
 * below the floor looks correctly configured everywhere except the meters,
 * where it reads 0%. That silence is the single most common reason a hit rate
 * is zero, and the only defence against it is a table someone maintains.
 *
 * The floor is not monotonic across generations — 512 on Opus 5, 4096 on Opus
 * 4.6 — so it cannot be inferred from a model's age or size. Longest matching
 * id prefix wins, which keeps dated ids (claude-haiku-4-5-20251001) resolving
 * to the right family.
 */
const MINIMUM_PREFIX_TOKENS: readonly (readonly [string, number])[] = [
  ['claude-opus-5', 512],
  ['claude-fable-5', 512],
  ['claude-mythos-5', 512],
  ['claude-opus-4-8', 1024],
  ['claude-sonnet-5', 1024],
  ['claude-sonnet-4', 1024],
  ['claude-sonnet-4-5', 1024],
  ['claude-sonnet-4-6', 1024],
  ['claude-opus-4', 1024],
  ['claude-opus-4-1', 1024],
  ['claude-opus-4-7', 2048],
  ['claude-haiku-3-5', 2048],
  ['claude-3-5-haiku', 2048],
  ['claude-opus-4-5', 4096],
  ['claude-opus-4-6', 4096],
  ['claude-haiku-4-5', 4096],
];

/**
 * The highest floor any model in the table carries. An unknown id is a model
 * newer than this file, and guessing low would tell someone their prefix
 * caches when it may not — the failure this whole module exists to catch.
 */
const UNKNOWN_MODEL_MINIMUM = 4096;

export function minimumCacheablePrefix(modelId: string): number {
  const id = modelId.trim().toLowerCase();
  let matched = '';
  let tokens = UNKNOWN_MODEL_MINIMUM;
  for (const [prefix, min] of MINIMUM_PREFIX_TOKENS) {
    if (id.startsWith(prefix) && prefix.length > matched.length) {
      matched = prefix;
      tokens = min;
    }
  }
  return tokens;
}

/**
 * Where a 5-minute TTL becomes a defensible *diagnosis*. Under this many
 * requests a batch is usually all in flight inside one five-minute window, and
 * blaming the TTL for a cold cache would be a guess dressed as a finding.
 * recommendedTtl() is deliberately more eager: recommending 1h costs an extra
 * 0.75× on a single write, while naming the wrong cause costs somebody an
 * afternoon of rewriting a prompt that was never the problem.
 */
const TTL_SUSPECT_REQUESTS = 50;

/**
 * Patterns that read as regenerated-per-run rather than authored. A timestamp
 * sitting in a prompt labelled "stable" is the classic silent invalidator, and
 * it is invisible in a diff of the config because the config is what changed.
 */
const VOLATILE_PATTERNS: readonly { label: string; re: RegExp }[] = [
  { label: 'an ISO timestamp', re: /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g },
  { label: 'a UUID', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  // Ten digits (seconds) or thirteen (milliseconds) starting with 1 — every
  // epoch between 2001 and 2033. Eleven- and twelve-digit numbers are left
  // alone: they are quantities, not clocks.
  { label: 'an epoch-looking number', re: /\b1\d{9}(?:\d{3})?\b/g },
];

const MAX_VOLATILE_REPORTED = 3;

/**
 * The honesty clause, and it ships in the copy rather than only in this
 * comment: cache hits inside a batch are best-effort. The API makes no promise
 * about them, and real runs land anywhere from 30% to 98% depending on how the
 * batch gets scheduled. A diagnostic that reads as a guarantee is worse than no
 * diagnostic, because the next zero is then assumed to be a bug in Wanigan.
 */
const BEST_EFFORT_NOTE =
  'Cache hits inside a batch are best-effort — the API does not guarantee them, and real runs land anywhere between 30% and 98% depending on how the batch is scheduled. The rate Wanigan shows is measured, never promised.';

/**
 * Why a run's cache did or did not engage, in plain language, worst cause
 * first.
 *
 * `observedHitRate` comes back null here on purpose: diagnose() runs against a
 * config, usually before submit, when there is no run to measure. Callers with
 * a run id merge in observedHitRate(runId).
 */
export async function diagnose(
  cfg: RunConfig,
  prefixTokens: number,
  requests: number
): Promise<CacheDiagnosis> {
  const minimumTokens = minimumCacheablePrefix(cfg.model);
  const marked = cfg.system.filter((b) => b.cache);
  // build.ts drops blocks whose text is blank before it renders the request, so
  // a marked-but-empty block never carries its cache_control to the API at all.
  const cached = marked.filter((b) => b.text.trim());
  // A cache_control breakpoint caches everything from the start of the prompt up
  // to and including its own block, so the length that has to clear the floor is
  // the whole prefix, not the flagged blocks alone. Measuring only `cached`
  // under-counts the moment an uncached block sits in front of a cached one — an
  // 8,000-token context block followed by a 300-token cached instruction reads as
  // 300 and gets reported as below the floor, which is precisely the false alarm
  // this module exists to end.
  const blocks = cfg.system.filter((b) => b.text.trim());
  let lastBreakpoint = -1;
  blocks.forEach((b, i) => { if (b.cache) lastBreakpoint = i; });
  const prefix = blocks.slice(0, lastBreakpoint + 1);
  const reasons: string[] = [];

  // estimate() measures only the flagged blocks, so the count it hands over
  // describes the real prefix only when nothing uncached precedes the last
  // breakpoint. When something does, that number is discarded and re-measured
  // here rather than believed — trusting it reintroduces the same undercount.
  const givenCoversPrefix = prefix.length === cached.length;
  const { tokens, measured } = await resolvePrefixTokens(cfg, givenCoversPrefix ? prefixTokens : 0, prefix);

  if (!marked.length) {
    reasons.push(
      'No system block is marked cached, so there is no prefix to cache and nothing can hit. Mark the block that is identical for every row — the instructions, never the per-row text.'
    );
  } else if (!cached.length) {
    reasons.push(
      'The only block marked cached is empty. Empty blocks are dropped while the request is built, so the cache marker never reaches the API.'
    );
  }

  if (cached.length && tokens < minimumTokens) {
    const counted = measured
      ? `${tokens.toLocaleString()} tokens`
      : `roughly ${tokens.toLocaleString()} tokens (counted locally — run an estimate for the API's own count)`;
    reasons.push(
      `The cached prefix is ${counted} and ${cfg.model} creates no cache entry below ${minimumTokens.toLocaleString()}. Under the floor the block is billed as ordinary input with no write, no read and no error — which is why this shows up as a flat 0% rather than a failure. Add to the cached block or move more of the shared instructions into it.`
    );
  }

  if (requests < 2) {
    reasons.push(
      `This run has ${requests.toLocaleString()} request${requests === 1 ? '' : 's'}. The first request writes the entry and later ones read it, so there is nothing here to hit the cache — and on a 1-hour TTL that write costs 2× the base rate for no return.`
    );
  }

  // Scanned over the whole prefix, not just the flagged blocks: an uncached
  // block ahead of a breakpoint is still inside the cached prefix, so a
  // timestamp in it invalidates the entry exactly as one in the flagged block would.
  const volatile = prefix.length ? findVolatile(prefix) : [];
  if (volatile.length) {
    const named = volatile.map((v) => `${v.label} (“${v.text}”)`).join(', ');
    reasons.push(
      `The cached text contains ${named}. Inside this run that is harmless — the block lives in the run config, so every request sends identical bytes. Across runs it is not: if that value is filled in when the run is set up, the next run of this preset writes a fresh entry instead of reading yours, and starts cold every time.`
    );
  }

  if (cfg.cacheTtl === '5m' && cached.length && requests >= TTL_SUSPECT_REQUESTS) {
    reasons.push(
      `The TTL is 5 minutes and this run has ${requests.toLocaleString()} requests. A batch is queued and then worked through over minutes to hours, so the entry the first request writes has usually expired before the tail is reached. A 1-hour entry writes at 2× the base rate instead of 1.25× and repays that on the first miss it prevents.`
    );
  }

  reasons.push(BEST_EFFORT_NOTE);

  return {
    // Written *and* read: an entry nobody reads is a cost, not a cache.
    willCache: cached.length > 0 && tokens >= minimumTokens && requests >= 2,
    prefixTokens: tokens,
    minimumTokens,
    ttl: cfg.cacheTtl,
    reasons,
    observedHitRate: null,
  };
}

/**
 * The caller normally hands over the count estimate() already measured.
 * Diagnosing a config that has never been estimated would otherwise see 0 and
 * confidently blame the floor — a false alarm on the one screen whose job is to
 * end false alarms — so measure it here when the number is missing.
 */
async function resolvePrefixTokens(
  cfg: RunConfig,
  given: number,
  prefix: SystemBlock[]
): Promise<{ tokens: number; measured: boolean }> {
  if (given > 0) return { tokens: Math.round(given), measured: true };
  if (!prefix.length) return { tokens: 0, measured: true };

  if (!isMock()) {
    try {
      // The one-character user turn is the smallest legal request; subtract it
      // back out so the number is the prefix and nothing else.
      const only = await client().messages.countTokens({
        model: cfg.model,
        system: prefix.map((b) => ({ type: 'text' as const, text: b.text })),
        messages: [{ role: 'user', content: '.' }],
      });
      return { tokens: Math.max(0, only.input_tokens - 1), measured: true };
    } catch {
      // A diagnostic that throws is worse than one that approximates. Fall
      // through to the shared local estimate and say so in the copy.
    }
  }
  return {
    tokens: prefix.reduce((a, b) => a + estimateTokens(b.text), 0),
    measured: false,
  };
}

/**
 * Only ever surfaces the matched token itself, capped and deduped — never the
 * surrounding prompt. Naming the offending substring is the whole point of the
 * check; quoting the paragraph around it would put prompt content somewhere it
 * does not belong.
 */
function findVolatile(blocks: SystemBlock[]): { label: string; text: string }[] {
  const found: { label: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    for (const { label, re } of VOLATILE_PATTERNS) {
      // These regexes are module-level and /g/: without resetting, each scan
      // resumes where the previous block ended and misses early matches.
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(block.text)) !== null) {
        const text = m[0].slice(0, 64);
        if (seen.has(text)) continue;
        seen.add(text);
        found.push({ label, text });
        if (found.length >= MAX_VOLATILE_REPORTED) return found;
      }
    }
  }
  return found;
}

/**
 * cache_read / (cache_read + cache_write + input_tokens) across the run's own
 * request rows.
 *
 * Null before any result lands, and null when results landed carrying no usage
 * at all (a run that errored out before a token was billed). Neither of those
 * is a 0% hit rate, and reporting them as one sends someone rewriting a prompt
 * that was never the problem.
 */
export function observedHitRate(runId: string): number | null {
  const row = db()
    .prepare(
      `SELECT COALESCE(SUM(cache_read),0)  AS cr,
              COALESCE(SUM(cache_write),0) AS cw,
              COALESCE(SUM(in_tokens),0)   AS it,
              COALESCE(SUM(CASE WHEN status = 'pending' THEN 0 ELSE 1 END),0) AS landed
       FROM requests WHERE run_id = ?`
    )
    .get(runId) as { cr: number; cw: number; it: number; landed: number } | undefined;

  if (!row || row.landed === 0) return null;
  const total = row.cr + row.cw + row.it;
  if (total <= 0) return null;
  return round4(row.cr / total);
}

/**
 * Observed hit rate per run, newest first — the only way to tell a config
 * problem from a scheduling one, since the same config landing 90% last week
 * and 40% today is the API's traffic shape, not your prompt.
 *
 * Runs that reported no tokens are excluded rather than listed at 0%: a run
 * with nothing to measure is not a run that missed.
 */
export function hitRateAcrossRuns(
  limit = 20
): { runId: string; name: string; model: string; hitRate: number; requests: number }[] {
  const n = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = db()
    .prepare(
      `SELECT id, name, model, cache_read AS cr, cache_write AS cw,
              in_tokens AS it, total_requests AS reqs
       FROM runs
       WHERE kind = 'batch' AND submitted_at IS NOT NULL
         AND (cache_read + cache_write + in_tokens) > 0
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(n) as { id: string; name: string; model: string; cr: number; cw: number; it: number; reqs: number }[];

  return rows.map((r) => ({
    runId: r.id,
    name: r.name,
    model: r.model,
    hitRate: round4(r.cr / (r.cr + r.cw + r.it)),
    requests: r.reqs,
  }));
}

/**
 * Batch runs default to the 1-hour TTL. It is the documented recommendation for
 * work whose requests start more than five minutes apart, and batch processing
 * routinely does: submission is queued, and the whole run is worked through
 * over minutes to hours.
 */
export function recommendedTtl(cfg: RunConfig, requests: number): { ttl: CacheTtl; why: string } {
  const cached = cfg.system.some((b) => b.cache && b.text.trim());

  if (!cached) {
    return {
      ttl: '1h',
      why: 'Nothing is marked cached, so the TTL has no effect yet. 1 hour is the right default once a block is marked: batch work routinely runs past five minutes.',
    };
  }

  if (requests < 2) {
    return {
      ttl: '5m',
      why: `With ${requests.toLocaleString()} request${requests === 1 ? '' : 's'} the entry is written and never read. A 1-hour write costs 2× the base input rate against 1.25× for five minutes, so the short TTL is strictly cheaper on a run this size.`,
    };
  }

  return {
    ttl: '1h',
    why: `A batch is queued and then worked through over minutes to hours, so the ${requests.toLocaleString()} requests sharing this prefix routinely start more than five minutes apart — the documented case for the 1-hour TTL. It writes at 2× the base input rate instead of 1.25× and repays that on the first miss it prevents, because a miss re-sends the entire prefix at full price and writes it again.`,
  };
}

/** Ratios are rendered as percentages; four places is past anything visible. */
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
