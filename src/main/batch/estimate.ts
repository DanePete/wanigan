import { client, isMock, explainApiError } from './anthropic';
import { costOf, modelFor } from './pricing';
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
  notes: string[];
};

const SAMPLE_SIZE = 6;

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
    // ~4 chars/token is close enough for the mock path.
    meanInputTokens = Math.round(sample.reduce((a, r) => a + r.rendered.length / 4, 0) / sample.length);
    cachedPrefixTokens = Math.round(cfg.system.filter((b) => b.cache).reduce((a, b) => a + b.text.length / 4, 0));
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
  const totalInputTokens = uncachedPerRequest * n;
  const worstCaseOutputTokens = cfg.maxTokens * n;

  // Cache economics: written once, read on the remaining n-1 requests.
  // Cache hits in a batch are best-effort (30–98% in practice), so the low/high
  // band assumes a good hit rate and the high band assumes none.
  const cacheWrite = cachedPrefixTokens;
  const cacheRead = cachedPrefixTokens * Math.max(0, n - 1);

  const lowOutput = observedOutputTokens ? observedOutputTokens * n : Math.round(worstCaseOutputTokens * 0.25);
  const usage = (out: number, withCache: boolean) => ({
    input_tokens: withCache ? totalInputTokens : meanInputTokens * n,
    output_tokens: out,
    cache_creation_input_tokens: withCache ? cacheWrite : 0,
    cache_read_input_tokens: withCache ? cacheRead : 0,
    cacheTtl: cfg.cacheTtl,
  });

  const costLowUsd = costOf(cfg.model, usage(lowOutput, true));
  const costHighUsd = costOf(cfg.model, usage(worstCaseOutputTokens, cachedPrefixTokens === 0));
  const syncCostHighUsd = costHighUsd * 2; // batch rates are exactly 50% of list

  if (!observedOutputTokens) {
    notes.push('Low estimate assumes responses average 25% of max_tokens. Run a dry run to replace that guess with a measurement.');
  }
  if (cachedPrefixTokens > 0 && cachedPrefixTokens < 1024) {
    notes.push(`Cached prefix is only ~${cachedPrefixTokens} tokens — below the minimum cacheable prefix, so caching will not engage.`);
  }
  if (n > 1 && cachedPrefixTokens >= 1024) {
    notes.push(`Cached prefix of ~${cachedPrefixTokens.toLocaleString()} tokens is written once and read ${(n - 1).toLocaleString()} times.`);
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
      usage: { input_tokens: Math.round(req.rendered.length / 4), output_tokens: 128 },
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
