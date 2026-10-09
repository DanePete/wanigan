import type { Need } from '@shared/model';

/** The most urgent thing across every project, as the orb shows it. */
export type OrbSignal = 'quiet' | 'working' | 'attention' | 'failed' | 'finished' | 'unavailable';

/** Coloured light inside the vessel per signal: linear RGB and strength. It
 * fills the water and mist and glows at the rim; quiet water is untinted.
 * Values are Wanigan 1's (`Orb.tsx` there), so the two read the same. */
export const TINT: Record<OrbSignal, readonly [number, number, number, number]> = {
  quiet: [0, 0, 0, 0],
  working: [0.08, 0.42, 1, 0.35],
  attention: [1, 0.48, 0.025, 0.85],
  failed: [1, 0.075, 0.04, 0.85],
  finished: [0.035, 1, 0.42, 0.8],
  unavailable: [0.23, 0.27, 0.34, 0.25],
};

/** The held alarm after a failure: a low red light, scaled down while a fire
 * whirl or a recovery flame is the thing on show. */
export function alarmTint(performance: number): readonly [number, number, number, number] {
  return [1, 0.09, 0.025, 0.3 * (1 - Math.max(0, Math.min(1, performance)))];
}

/** One signal for everything Needs you holds. Failure first, then anything
 * waiting on a decision, then a finished turn waiting to be looked at, then
 * agents at work. Unread needs are `unavailable`, not quiet: an unknown is not
 * an all-clear. */
export function signalFor(needs: readonly Pick<Need, 'kind'>[] | undefined, running: number): OrbSignal {
  if (!needs) return 'unavailable';
  if (needs.some((n) => n.kind === 'failed' || n.kind === 'interrupted')) return 'failed';
  if (needs.some((n) => n.kind === 'permission' || n.kind === 'overlap' || n.kind === 'review' || n.kind === 'question' || n.kind === 'limit')) return 'attention';
  if (needs.some((n) => n.kind === 'waiting')) return 'finished';
  if (running > 0) return 'working';
  return 'quiet';
}
