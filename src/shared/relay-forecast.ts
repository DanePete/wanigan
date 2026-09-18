import type { RelayForecast, RelayForecastBasis, RelayPhaseForecast } from './types.ts';

/**
 * The arithmetic of the estimate phase: which recorded phases count as
 * comparable to the one being priced, and what number — if any — they earn it.
 *
 * Everything that reads a database stays in `src/main/relay.ts`. This module
 * takes rows that have already been read and answers two questions about them
 * — how much history is there at each rung of the ladder, and what is its
 * median — so the whole rule can be checked under `node --test` with no
 * process behind it, and so the main process cannot quietly widen it.
 *
 * It never invents a number. A phase with less history than `MIN_HISTORY` at
 * every rung gets `basis: 'none'` and nulls, not a median of one, and a total
 * over phases where one has no number is null rather than a sum that leaves
 * that phase out and reads as the whole.
 */

/**
 * Comparable recorded phases a rung needs before it may answer with a number.
 *
 * Three, for the same reason `CADENCE_MIN_SAMPLES` in `relay.ts` is three: it
 * is the smallest sample whose median is an actual middle rather than one of
 * the two ends, and the fewest recordings that can disagree with each other. A
 * median of one is that one run wearing a currency symbol, and a median of two
 * is whichever of them happened to be lower. Higher would be more honest still
 * and would leave a new project with no forecast for months; three is where
 * "a number drawn from history" starts to be true of the number.
 */
export const MIN_HISTORY = 3;

/** The three fields of a routing decision, as they were recorded on a phase. */
export type ForecastRoute = { providerId: string | null; model: string | null; effort: string | null };

/**
 * One completed phase from this project's history. `costUsd` is null when its
 * provider reported no cost, or reported it for only some of its sessions —
 * an unpriced run is recorded as unpriced and never totalled as spend.
 */
export type ForecastSample = ForecastRoute & { durationMs: number; costUsd: number | null };

/**
 * The median of a list, taking the lower of the two middles when the count is
 * even. The same convention `cadence()` in `relay.ts` keeps, for the same two
 * reasons: an average lets one long build pull the number, and the lower
 * middle is a value that actually occurred where an average is one that never
 * did. Null for an empty list — there is no middle of nothing.
 */
export function median(values: readonly number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/**
 * The rungs, strongest first, and what each requires of the route being priced.
 *
 * A route naming no model cannot match on model, and one naming no provider
 * cannot match on anything, so those rungs are skipped rather than matched
 * loosely — "the same model as nothing" is every model, and a forecast drawn
 * from every model on the provider would be labelled `exact` about a decision
 * that was never made.
 */
const RUNGS: readonly { basis: Exclude<RelayForecastBasis, 'none'>; applies: (route: ForecastRoute) => boolean; matches: (route: ForecastRoute, sample: ForecastSample) => boolean }[] = [
  {
    basis: 'exact',
    applies: (route) => route.providerId !== null && route.model !== null,
    matches: (route, sample) => sample.providerId === route.providerId && sample.model === route.model && sample.effort === route.effort,
  },
  {
    basis: 'model',
    applies: (route) => route.providerId !== null && route.model !== null,
    matches: (route, sample) => sample.providerId === route.providerId && sample.model === route.model,
  },
  {
    basis: 'provider',
    applies: (route) => route.providerId !== null,
    matches: (route, sample) => sample.providerId === route.providerId,
  },
];

export type PhaseNumbers = Pick<RelayPhaseForecast, 'n' | 'nPriced' | 'basis' | 'medianMs' | 'medianUsd'>;

/**
 * What one phase's history earns it: the first rung with enough comparable
 * runs, and the medians drawn from exactly that rung.
 *
 * Both numbers come from the same rung on purpose. Letting the cost fall to a
 * lower rung than the duration would give a phase two bases under one label,
 * and the label is the whole point. So a rung with three runs of which one was
 * priced answers the duration and leaves the cost null with `nPriced: 1` —
 * which is the truth, and which the surface can say.
 */
export function forecastPhase(route: ForecastRoute, history: readonly ForecastSample[]): PhaseNumbers {
  for (const rung of RUNGS) {
    if (!rung.applies(route)) continue;
    const rows = history.filter((sample) => Number.isFinite(sample.durationMs) && sample.durationMs >= 0 && rung.matches(route, sample));
    if (rows.length < MIN_HISTORY) continue;
    const priced = rows.flatMap((sample) => sample.costUsd !== null && Number.isFinite(sample.costUsd) && sample.costUsd >= 0 ? [sample.costUsd] : []);
    return {
      n: rows.length,
      nPriced: priced.length,
      basis: rung.basis,
      medianMs: median(rows.map((sample) => sample.durationMs)),
      medianUsd: priced.length >= MIN_HISTORY ? median(priced) : null,
    };
  }
  return { n: 0, nPriced: 0, basis: 'none', medianMs: null, medianUsd: null };
}

export type ForecastTotals = Pick<RelayForecast, 'totalMs' | 'totalUsd' | 'n' | 'priced' | 'phases'>;

/**
 * The totals over a docket's phases, and the N and count that qualify them.
 *
 * A total exists only when every phase contributes to it. Three of four
 * phases summed is not the total of four, and a surface that printed it as
 * one would be doing the thing this module exists to refuse. `n` is the
 * smallest N any included number was drawn from — the weakest link, the way a
 * mixed evidence label inherits its weakest member — and `priced` over
 * `phases` is the estimate basin's gauge: tasks priced over tasks in the plan.
 */
export function forecastTotals(perPhase: readonly Pick<RelayPhaseForecast, 'n' | 'basis' | 'medianMs' | 'medianUsd'>[]): ForecastTotals {
  const phases = perPhase.length;
  const timed = perPhase.filter((phase) => phase.medianMs !== null);
  const costed = perPhase.filter((phase) => phase.medianUsd !== null);
  const drawn = perPhase.filter((phase) => phase.basis !== 'none');
  return {
    totalMs: phases > 0 && timed.length === phases ? timed.reduce((sum, phase) => sum + (phase.medianMs ?? 0), 0) : null,
    totalUsd: phases > 0 && costed.length === phases ? costed.reduce((sum, phase) => sum + (phase.medianUsd ?? 0), 0) : null,
    n: drawn.length ? Math.min(...drawn.map((phase) => phase.n)) : 0,
    priced: drawn.length,
    phases,
  };
}
