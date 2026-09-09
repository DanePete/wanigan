/**
 * Batch pricing, USD per million tokens.
 *
 * These are the *batch* rates (already 50% of the synchronous list price).
 * Source: platform.claude.com/docs/en/build-with-claude/batch-processing
 */
/**
 * A rate that has since been superseded, and the instant it stopped applying.
 *
 * The table below is a snapshot of *today's* published rates, and until this
 * existed every function here priced the whole of history at them. That is a
 * silent rewrite: edit a row because Anthropic changed a price and every batch
 * run, every reconciliation and every accuracy ratio already on record moves,
 * with nothing on screen to say why. The Insights page carries two cards whose
 * only job is explaining the gap between Wanigan's arithmetic and an invoice,
 * so a table edit was an invisible source of exactly the drift they exist to
 * account for.
 *
 * `until` is exclusive: a period applies to every event stamped before it.
 * Periods are searched oldest-first, so they must be ordered that way.
 *
 * These arrays are empty, and that is deliberate. No rate change is recorded
 * here because none has been verified against a published schedule, and
 * inventing one would put a wrong number on a receipt rather than a missing
 * one. When a rate does change, the edit is: push the OLD rate onto `history`
 * with the changeover instant, then update the top-level fields.
 */
export type RatePeriod = {
  /** Epoch ms. These rates applied to anything stamped strictly before it. */
  until: number;
  batchInput: number;   // $/MTok
  batchOutput: number;  // $/MTok
};

export type ModelPricing = {
  id: string;
  label: string;
  batchInput: number;   // $/MTok
  batchOutput: number;  // $/MTok
  /** Max output tokens without the extended-output beta. */
  maxTokens: number;
  /** Eligible for the output-300k-2026-03-24 beta (batch only). */
  extendedOutput: boolean;
  retired?: boolean;
  /** Superseded rates, oldest first. Empty means this model has never moved. */
  history?: RatePeriod[];
};

export const MODELS: ModelPricing[] = [
  { id: 'claude-opus-5',    label: 'Opus 5',    batchInput: 2.5,  batchOutput: 12.5, maxTokens: 128_000, extendedOutput: true },
  { id: 'claude-sonnet-5',  label: 'Sonnet 5',  batchInput: 1.0,  batchOutput: 5.0,  maxTokens: 128_000, extendedOutput: true },
  { id: 'claude-fable-5',   label: 'Fable 5',   batchInput: 5.0,  batchOutput: 25.0, maxTokens: 128_000, extendedOutput: false },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', batchInput: 0.5, batchOutput: 2.5, maxTokens: 64_000, extendedOutput: false },
  { id: 'claude-opus-4-8',  label: 'Opus 4.8',  batchInput: 2.5,  batchOutput: 12.5, maxTokens: 128_000, extendedOutput: true },
  { id: 'claude-opus-4-7',  label: 'Opus 4.7',  batchInput: 2.5,  batchOutput: 12.5, maxTokens: 128_000, extendedOutput: true },
  { id: 'claude-opus-4-6',  label: 'Opus 4.6',  batchInput: 2.5,  batchOutput: 12.5, maxTokens: 128_000, extendedOutput: true },
  { id: 'claude-opus-4-5',  label: 'Opus 4.5',  batchInput: 2.5,  batchOutput: 12.5, maxTokens: 64_000,  extendedOutput: false },
  { id: 'claude-sonnet-4-6',label: 'Sonnet 4.6',batchInput: 1.5,  batchOutput: 7.5,  maxTokens: 64_000,  extendedOutput: true },
  { id: 'claude-sonnet-4-5',label: 'Sonnet 4.5',batchInput: 1.5,  batchOutput: 7.5,  maxTokens: 64_000,  extendedOutput: false },
];

export const DEFAULT_MODEL = 'claude-sonnet-5';

/** A dated snapshot suffix. `claude-haiku-4-5-20251001` is the same rate card as `claude-haiku-4-5`. */
const DATED_SNAPSHOT = /-\d{8}$/;

/**
 * The published rate for an id, or `undefined` when there is none.
 *
 * Undefined is the whole point. "Wanigan has no rate for this model" and "this
 * model costs X" are different claims, and only a lookup that can answer
 * neither-of-the-above lets a caller tell them apart before it prints a dollar
 * sign. modelFor() answers for every id and therefore cannot.
 */
export function findModel(id: string): ModelPricing | undefined {
  const wanted = id.trim();
  const exact = MODELS.find((m) => m.id === wanted);
  if (exact) return exact;
  // Both spellings of the same model reach here — the undated id from a human
  // or from /v1/models, the dated snapshot from a stored config or an alias —
  // and they bill identically. Matching only the spelling this table happens to
  // use would price the other one at DEFAULT_MODEL's rates without saying so.
  const family = wanted.replace(DATED_SNAPSHOT, '');
  return MODELS.find((m) => m.id.replace(DATED_SNAPSHOT, '') === family);
}

/**
 * The rates in force for `id` at `atMs`, or undefined when there is none.
 *
 * Undefined for the same reason findModel() returns it: "no published rate"
 * and "costs X" are different claims and a caller about to print a dollar sign
 * has to be able to tell them apart.
 *
 * `atMs` defaults to now rather than to the current rate directly, so a caller
 * that forgets to pass a timestamp gets today's price for today's work — the
 * same answer it got before this existed — instead of silently pricing a
 * two-year-old run at a rate that had not been set yet.
 */
export function rateAt(id: string, atMs?: number): { batchInput: number; batchOutput: number } | undefined {
  const m = findModel(id);
  return m ? pickRate(m, atMs) : undefined;
}

/**
 * The schedule walk, kept separate from the table lookup so it can be tested
 * against a history the shipped table does not have. Every `history` array in
 * MODELS is empty today, so a test that could only go through `rateAt` would
 * exercise the fallback and nothing else — and the branch that matters is the
 * one that only runs once a rate has actually moved.
 */
export function pickRate(m: ModelPricing, atMs?: number): { batchInput: number; batchOutput: number } {
  const at = Number.isFinite(atMs) ? Number(atMs) : Date.now();
  for (const period of m.history ?? []) {
    if (at < period.until) return { batchInput: period.batchInput, batchOutput: period.batchOutput };
  }
  return { batchInput: m.batchInput, batchOutput: m.batchOutput };
}

/** True when MODELS carries a published rate for this id at `atMs`. Ask before quoting money. */
export function isPricedModel(id: string, atMs?: number): boolean {
  return rateAt(id, atMs) !== undefined;
}

/**
 * Ceilings and capability flags for an id, substituting DEFAULT_MODEL's row for
 * an id this table has never heard of.
 *
 * That substitution is a guess, and it is silent by construction: the row that
 * comes back cannot say it is not this model's row. It is the right answer for
 * an output ceiling — build.ts and refusal.ts want a conservative stand-in
 * rather than no answer — and the wrong one for a price. Anything that turns it
 * into money must gate on isPricedModel() first.
 */
export function modelFor(id: string): ModelPricing {
  return findModel(id) ?? MODELS.find((m) => m.id === DEFAULT_MODEL)!;
}

/**
 * Cache multipliers are applied to the *base input* rate.
 *   5-minute write : 1.25x   1-hour write : 2.0x   read : 0.1x
 * Inside a batch every line item is already at the 50% batch rate, so the
 * multipliers ride on top of `batchInput` directly.
 */
export const CACHE_MULTIPLIER = { write5m: 1.25, write1h: 2.0, read: 0.1 } as const;

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cacheTtl?: '5m' | '1h';
  /**
   * The two cache-write halves, when the source reports them apart.
   *
   * The Batches API hands back one `cache_creation_input_tokens` total and the
   * run's own configured `cacheTtl` says which multiplier it earned. Claude
   * Code's transcripts instead carry `cache_creation.ephemeral_5m_input_tokens`
   * and `…_1h_input_tokens` on every turn, and a single turn can hold both. A
   * total plus one ttl cannot express that, so when either of these is present
   * they are used and `cache_creation_input_tokens`/`cacheTtl` are ignored.
   */
  cache_creation_5m?: number;
  cache_creation_1h?: number;
};

/**
 * What this usage costs at `modelId`'s batch rates.
 *
 * An id with no published rate is priced at DEFAULT_MODEL's rates through
 * modelFor(), because the alternative — throwing — would take out results
 * ingestion and the eval diff for a model that is merely newer than this table.
 * The number is therefore only a price when isPricedModel(modelId) is true;
 * every caller that shows it to somebody has to say which of the two it has.
 */
export function costOf(modelId: string, u: Usage, atMs?: number): number {
  // modelFor() substitutes DEFAULT_MODEL for an unknown id; rateAt() answers
  // for that same substitute so the two cannot disagree about which row is
  // being priced. Callers that must not guess gate on isPricedModel() first.
  const rate = rateAt(modelId, atMs) ?? rateAt(DEFAULT_MODEL, atMs)!;
  const perM = (tokens: number, perMillion: number) => (tokens / 1_000_000) * perMillion;

  const split = (u.cache_creation_5m ?? 0) + (u.cache_creation_1h ?? 0) > 0;
  const write5m = split ? u.cache_creation_5m ?? 0 : u.cacheTtl === '1h' ? 0 : u.cache_creation_input_tokens ?? 0;
  const write1h = split ? u.cache_creation_1h ?? 0 : u.cacheTtl === '1h' ? u.cache_creation_input_tokens ?? 0 : 0;

  return (
    perM(u.input_tokens ?? 0, rate.batchInput) +
    perM(u.output_tokens ?? 0, rate.batchOutput) +
    perM(u.cache_read_input_tokens ?? 0, rate.batchInput * CACHE_MULTIPLIER.read) +
    perM(write5m, rate.batchInput * CACHE_MULTIPLIER.write5m) +
    perM(write1h, rate.batchInput * CACHE_MULTIPLIER.write1h)
  );
}

/**
 * The same usage at synchronous rates.
 *
 * The table above is batch pricing, which the header states is already 50% of
 * the synchronous list price — so anything that calls the Messages API directly
 * and priced it with costOf() would report half of what it actually cost. That
 * is a small error in the one place it is least acceptable: a screen whose
 * whole job is telling somebody what Wanigan spent on their behalf.
 */
export function syncCostOf(modelId: string, u: Usage, atMs?: number): number {
  return costOf(modelId, u, atMs) * 2;
}

export function usd(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  if (n < 100) return '$' + n.toFixed(2);
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}
