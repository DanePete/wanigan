/**
 * Batch pricing, USD per million tokens.
 *
 * These are the *batch* rates (already 50% of the synchronous list price).
 * Source: platform.claude.com/docs/en/build-with-claude/batch-processing
 */
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

export function modelFor(id: string): ModelPricing {
  return MODELS.find((m) => m.id === id) ?? MODELS.find((m) => m.id === DEFAULT_MODEL)!;
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
};

export function costOf(modelId: string, u: Usage): number {
  const m = modelFor(modelId);
  const writeMult = u.cacheTtl === '1h' ? CACHE_MULTIPLIER.write1h : CACHE_MULTIPLIER.write5m;
  const perM = (tokens: number, rate: number) => (tokens / 1_000_000) * rate;
  return (
    perM(u.input_tokens ?? 0, m.batchInput) +
    perM(u.output_tokens ?? 0, m.batchOutput) +
    perM(u.cache_read_input_tokens ?? 0, m.batchInput * CACHE_MULTIPLIER.read) +
    perM(u.cache_creation_input_tokens ?? 0, m.batchInput * writeMult)
  );
}

export function usd(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  if (n < 100) return '$' + n.toFixed(2);
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}
