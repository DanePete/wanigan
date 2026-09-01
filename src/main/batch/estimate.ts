import { client, isMock, explainApiError } from './anthropic';
import { minimumCacheablePrefix } from './cachediag';
import { costOf, isPricedModel, modelFor } from './pricing';
import { estimateTokens } from '../../shared/tokens';
import type { RunConfig } from '../../shared/types';
import type { BuiltRequest } from './build';

export type Estimate = {
  requests: number;
  chunks: number;
  /** Tokens in the cached system prefix — paid to write once, read cheaply after. */
  cachedPrefixTokens: number;
  /** Mean uncached input tokens per request, measured on a real sample. */
  meanInputTokens: number;
  sampledRows: number;
  totalInputTokens: number;
  /** Ceiling: every request runs to max_tokens. */
  worstCaseOutputTokens: number;
  /** From a dry run, if one has been done. */
  observedOutputTokens?: number;
  costLowUsd: number;
  costHighUsd: number;
  /** What the same work would cost on the synchronous Messages API. */
  syncCostHighUsd: number;
  /**
   * The model id, when Wanigan has no published rate for it. Set means every
   * cost field above is a stand-in model's rates, not this model's price — a
   * caller that gates spending on those numbers is gating on a guess.
   */
  unpricedModel?: string;
  notes: string[];
};

const SAMPLE_SIZE = 6;

/**
 * What the low band assumes each response comes back at, absent a measurement.
 * Named once so the number in the arithmetic and the number in the note it is
 * declared by cannot drift apart.
 */
const LOW_OUTPUT_FRACTION = 0.25;

export async function estimate(
  cfg: RunConfig,
  requests: BuiltRequest[],
  observedOutputTokens?: number
): Promise<Estimate> {
  const notes: string[] = [];
  const n = requests.length;
  const model = modelFor(cfg.model);

  // Sample evenly across the dataset rather than taking the first N — the first
  // rows of an export are routinely the shortest.
  const idxs = n <= SAMPLE_SIZE
    ? requests.map((_, i) => i)
    : Array.from({ length: SAMPLE_SIZE }, (_, k) => Math.floor((k * n) / SAMPLE_SIZE));
  const sample = idxs.map((i) => requests[i]);

  let cachedPrefixTokens = 0;
  let meanInputTokens = 0;

  if (isMock()) {
    // Mock mode has no countTokens endpoint to call, so the shared local
    // heuristic stands in — the same one the context and learning panels use,
    // rather than a fourth private guess about the same bytes.
    meanInputTokens = Math.round(sample.reduce((a, r) => a + estimateTokens(r.rendered), 0) / sample.length);
    cachedPrefixTokens = cfg.system.filter((b) => b.cache).reduce((a, b) => a + estimateTokens(b.text), 0);
    notes.push('Mock mode — token counts are estimated locally, not measured.');
  } else {
    const c = client();
    const counts = await Promise.all(
      sample.map((r) =>
        c.messages.countTokens({
          model: cfg.model,
          system: r.params.system as never,
          messages: r.params.messages as never,
        }).then((x) => x.input_tokens)
      )
    );
    meanInputTokens = Math.round(counts.reduce((a, b) => a + b, 0) / counts.length);

    const cachedBlocks = cfg.system.filter((b) => b.cache);
    if (cachedBlocks.length) {
      const only = await c.messages.countTokens({
        model: cfg.model,
        system: cachedBlocks.map((b) => ({ type: 'text' as const, text: b.text })),
        messages: [{ role: 'user', content: '.' }],
      });
      cachedPrefixTokens = Math.max(0, only.input_tokens - 1);
    }
  }

  const uncachedPerRequest = Math.max(0, meanInputTokens - cachedPrefixTokens);
  const worstCaseOutputTokens = cfg.maxTokens * n;

  /* ── what the cache can actually do for this config ──────────────────
     A prefix under the model's minimum cacheable size never creates an entry —
     no write, no read, no error — and a single-request batch has nothing to read
     one back. Pricing cache reads at 0.1x in either case invents a 90% discount
     on tokens that bill at the full input rate, and it does it on the *low*
     band, which is the number an operator reads as "at best". A floor built on a
     cache that cannot exist is not a floor.
     ─────────────────────────────────────────────────────────────────── */
  const minimumPrefix = minimumCacheablePrefix(cfg.model);
  const cacheEngages = cachedPrefixTokens >= minimumPrefix && n > 1;
  const cacheWrite = cacheEngages ? cachedPrefixTokens : 0;
  const cacheRead = cacheEngages ? cachedPrefixTokens * (n - 1) : 0;
  // With no cache to carry it, the prefix is not billed once — it is billed on
  // every request, like the rest of the input.
  const totalInputTokens = (cacheEngages ? uncachedPerRequest : meanInputTokens) * n;

  const lowOutput = observedOutputTokens
    ? observedOutputTokens * n
    : Math.round(worstCaseOutputTokens * LOW_OUTPUT_FRACTION);
  const usage = (out: number, withCache: boolean) => ({
    input_tokens: withCache ? totalInputTokens : meanInputTokens * n,
    output_tokens: out,
    cache_creation_input_tokens: withCache ? cacheWrite : 0,
    cache_read_input_tokens: withCache ? cacheRead : 0,
    cacheTtl: cfg.cacheTtl,
  });

  // Cache hits in a batch are best-effort (30–98% in practice): the low band
  // prices a cache that engages and hits, the high band prices none at all.
  const costLowUsd = costOf(cfg.model, usage(lowOutput, cacheEngages));
  const costHighUsd = costOf(cfg.model, usage(worstCaseOutputTokens, false));
  const syncCostHighUsd = costHighUsd * 2; // batch rates are exactly 50% of list

  // First, because it governs how every other number here should be read.
  const priced = isPricedModel(cfg.model);
  if (!priced) {
    notes.unshift(
      `Wanigan has no published rate for "${cfg.model}", so every cost here is ${model.label}'s ` +
      `rates standing in — a placeholder, not this model's price. Treat the dollar figures as unknown until the ` +
      `pricing table lists this model.`
    );
  }
  if (!observedOutputTokens) {
    notes.push(
      `Low estimate assumes responses average ${Math.round(LOW_OUTPUT_FRACTION * 100)}% of max_tokens — an ` +
      `assumption, not a measurement. Run a dry run to replace it with an observed figure.`
    );
  }
  if (cachedPrefixTokens > 0 && cachedPrefixTokens < minimumPrefix) {
    notes.push(
      `Cached prefix is only ~${cachedPrefixTokens.toLocaleString()} tokens, under the ` +
      `${minimumPrefix.toLocaleString()}-token minimum for this model — caching will not engage, and nothing ` +
      `below is priced as cached.`
    );
  }
  if (cachedPrefixTokens >= minimumPrefix && n < 2) {
    notes.push('A one-request batch has nothing to read the cache back, so the prefix is priced uncached.');
  }
  if (cacheEngages) {
    notes.push(
      `Cached prefix of ~${cachedPrefixTokens.toLocaleString()} tokens is written once and read ` +
      `${(n - 1).toLocaleString()} times. The low estimate assumes every one of those reads hits; batch cache ` +
      `hits are best-effort, so it is a floor rather than a forecast.`
    );
  }

  return {
    requests: n,
    chunks: Math.ceil(n / 100_000),
    cachedPrefixTokens,
    meanInputTokens,
    sampledRows: sample.length,
    totalInputTokens,
    worstCaseOutputTokens,
    observedOutputTokens,
    costLowUsd,
    costHighUsd,
    syncCostHighUsd,
    unpricedModel: priced ? undefined : cfg.model,
    notes,
  };
}

/**
 * Pre-flight: send exactly one request synchronously through the Messages API.
 * Batch validation is asynchronous — a malformed params object is not reported
 * until the whole batch finishes, so this is the only cheap way to fail fast.
 */
export async function dryRun(cfg: RunConfig, req: BuiltRequest) {
  if (isMock()) {
    return {
      ok: true as const,
      text: `[mock dry run] would send ${req.rendered.length} chars for custom_id ${req.custom_id}`,
      usage: { input_tokens: estimateTokens(req.rendered), output_tokens: 128 },
      stopReason: 'end_turn',
      customId: req.custom_id,
    };
  }
  try {
    const msg = await client().messages.create(req.params as never);
    const text = msg.content
      .flatMap((b) => (b.type === 'text' ? [b.text] : []))
      .join('\n');
    return {
      ok: true as const,
      text,
      usage: { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens },
      stopReason: msg.stop_reason ?? null,
      customId: req.custom_id,
    };
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string; error?: { error?: { type?: string; message?: string } } };
    return {
      ok: false as const,
      status: err.status ?? 0,
      type: err.error?.error?.type ?? 'unknown_error',
      message: explainApiError(e),
      customId: req.custom_id,
    };
  }
}
