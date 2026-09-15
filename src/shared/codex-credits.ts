/**
 * Codex plan usage priced in credits, the unit a ChatGPT plan actually spends.
 *
 * spend.ts counts Codex plan sessions as unpriced rather than as $0, and that
 * stays true: a plan is not billed per token in dollars. OpenAI does publish a
 * credits-per-million-tokens rate card, so a session whose token counts are
 * recorded can be given an ESTIMATE in credits — shown beside the dollar
 * figures, never added to them, and always saying where the rates came from.
 *
 * The one table below is the whole of Wanigan's knowledge of those rates. It is
 * dated because rate cards change; a model not in it has no estimate rather
 * than a borrowed one.
 */

export const CODEX_CREDIT_RATE_CARD = {
  source: 'OpenAI Codex pricing, credits per 1M tokens (learn.chatgpt.com/docs/pricing)',
  readOn: '14 Sep 2026',
  /** Fast mode multiplies credits for GPT-5.6 and GPT-6 Astra (OpenAI speed docs). */
  fastMultiplier: 2.5,
  models: {
    'gpt-6-astra': { input: 250, cached: 25, output: 1250 },
    'gpt-5.6-sol': { input: 100, cached: 10, output: 500 },
    'gpt-5.6-terra': { input: 50, cached: 5, output: 300 },
    'gpt-5.6-luna': { input: 5, cached: 0.5, output: 30 },
  } as Record<string, { input: number; cached: number; output: number }>,
} as const;

/**
 * Service tiers that are Fast. Codex records the tier id, and its models cache
 * names the `priority` tier "Fast" (read from ~/.codex/models_cache.json on
 * 14 Sep 2026); `fast` is the config spelling.
 */
const FAST_TIERS = new Set(['priority', 'fast']);

export type TierRecord =
  | { kind: 'not-recorded' }
  | { kind: 'single'; tier: string }
  | { kind: 'mixed'; tiers: string[] };

export function tierRecord(tiers: Iterable<string>): TierRecord {
  const set = [...new Set([...tiers].map((t) => t.trim()).filter(Boolean))].sort();
  if (set.length === 0) return { kind: 'not-recorded' };
  if (set.length === 1) return { kind: 'single', tier: set[0] };
  return { kind: 'mixed', tiers: set };
}

export type CreditEstimate =
  | {
    status: 'estimated';
    model: string;
    /** Credits at the recorded tier, or at the standard rate when the tier is not recorded. */
    credits: number;
    /** When the tier varied within the thread: the standard and all-Fast bounds. */
    range: [number, number] | null;
    fast: boolean | null;
    tierNote: 'fast' | 'standard' | 'tier not recorded' | 'tier changed during the session';
  }
  | { status: 'no-rate'; model: string | null; reason: string };

export function estimateCredits(input: {
  model: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  tiers: TierRecord;
}): CreditEstimate {
  const model = input.model?.trim().toLowerCase() || null;
  if (!model) return { status: 'no-rate', model: null, reason: 'The session’s model is not recorded.' };
  const rate = CODEX_CREDIT_RATE_CARD.models[model];
  if (!rate) return { status: 'no-rate', model, reason: `${model} is not on the ${CODEX_CREDIT_RATE_CARD.readOn} rate card.` };
  const cached = Math.max(0, Math.min(input.cachedInputTokens, input.inputTokens));
  const uncached = Math.max(0, input.inputTokens - cached);
  const base = (uncached * rate.input + cached * rate.cached + Math.max(0, input.outputTokens) * rate.output) / 1_000_000;
  const fast = base * CODEX_CREDIT_RATE_CARD.fastMultiplier;
  switch (input.tiers.kind) {
    case 'not-recorded': return { status: 'estimated', model, credits: base, range: null, fast: null, tierNote: 'tier not recorded' };
    case 'single': {
      const isFast = FAST_TIERS.has(input.tiers.tier.toLowerCase());
      return { status: 'estimated', model, credits: isFast ? fast : base, range: null, fast: isFast, tierNote: isFast ? 'fast' : 'standard' };
    }
    case 'mixed': {
      const anyFast = input.tiers.tiers.some((t) => FAST_TIERS.has(t.toLowerCase()));
      return anyFast
        ? { status: 'estimated', model, credits: base, range: [base, fast], fast: null, tierNote: 'tier changed during the session' }
        : { status: 'estimated', model, credits: base, range: null, fast: false, tierNote: 'standard' };
    }
  }
}

/** Service tiers and models named in a slice of rollout text, without parsing every line. */
export function scanRolloutSettings(text: string): { tiers: string[]; models: string[] } {
  const tiers = new Set<string>();
  const models = new Set<string>();
  for (const m of text.matchAll(/"service_tier":"([A-Za-z0-9_-]{1,40})"/g)) tiers.add(m[1]);
  for (const m of text.matchAll(/"type":"(?:turn_context|thread_settings_applied)"[^\n]*?"model":"([A-Za-z0-9._-]{1,80})"/g)) models.add(m[1]);
  return { tiers: [...tiers].sort(), models: [...models].sort() };
}
