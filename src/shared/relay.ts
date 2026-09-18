import type { DocketNodeKind } from './types.ts';

/**
 * The arithmetic behind the Relay sluice: how fast a live basin breathes, how
 * much silt has settled in it, which of the stylesheet's scatters that silt
 * lands in, and which basins are allowed to show a level at all.
 *
 * Every function here answers one question — what has actually been recorded?
 * — and refuses to answer any other. There is no guess at how far along a
 * stage is, no percentage for work nobody has counted the steps of, and no
 * breathing period invented from a single event. A basin with nothing measured
 * yet is told to hold still, because stillness is true and a drift is a claim.
 *
 * It is deliberately not the renderer's animation code and not the router. It
 * touches no DOM, starts no timer, reads no clock of its own and imports
 * nothing from `src/main`, so the whole sluice can be checked in milliseconds
 * under `node --test` and the same relay silts up the same way in every
 * screenshot of it.
 */

/**
 * The five phases a relay runs — plan → estimate → implement → verify →
 * review — which are exactly the docket kinds, so this is an alias and not a
 * second list. `DOCKET_NODE_KINDS` in `types.ts` carries the order.
 */
export type RelayPhase = DocketNodeKind;

/** Whether a basin breathes, and why it does not. */
export type Cadence =
  | { kind: 'swelling'; periodMs: number }
  | { kind: 'still'; reason: 'too-few-samples' | 'quiet' };

export type Sediment = { grains: number; overflow: number | null };

export type Gauge = { value: number; max: number } | null;

/**
 * Grains a basin floor holds before the pile stops growing and a count takes
 * over. An unbounded pile is a memory leak wearing a metaphor.
 *
 * **This number is pinned to `src/renderer/src/styles/relay.css`, which spells
 * out exactly this many hand-placed slots, `.rl-grain[data-rl-i='0']` through
 * `[data-rl-i='23']`. The two change together or not at all.** Raising it here
 * alone gives every extra grain no position rule to match, so they stack in one
 * corner at the default offset — a bug that looks like a design choice and
 * reports nothing. The positions are hand-placed rather than computed because
 * a computed one would need the inline-style channel the style gate forbids.
 *
 * Twenty-four is also the right number and not merely the available one: at a
 * hundred-odd grains a basin floor fills to a solid mass and reads as exactly
 * the progress bar this surface refuses. Two dozen reads as a pile that grew.
 */
export const SEDIMENT_CAP = 24;

/**
 * Distinct silt scatters `relay.css` provides, selected per node by
 * `data-rl-seed`. Eight is enough that two basins side by side are visibly
 * different piles, and few enough that the sheet can spell every slot of every
 * scatter by hand in tokens — which it must, because a free-form coordinate
 * has no legal channel into CSS here: `style={{` is a ratcheting debt an
 * unlisted file is allowed zero of, and hoisting the object to dodge that text
 * match is routing around the ratchet rather than honouring it.
 */
export const SEDIMENT_SEEDS = 8;

/**
 * Completed tool calls a basin needs before it may breathe at all. Three
 * recordings give two intervals, which is the fewest that can disagree with
 * each other; a period derived from one event is a number invented to look
 * like progress, which is the thing this surface exists to refuse.
 */
export const CADENCE_MIN_SAMPLES = 3;

/**
 * The fastest breath Wanigan will animate. `.mo-breathe` runs one whole rise
 * and fall per period, so 600ms is a little under two cycles a second, clear
 * of the three-a-second line WCAG 2.3.1 draws for flashing. An agent hammering
 * tool calls faster than this pins the basin at "choppy" instead of strobing;
 * past a certain rate the texture stops being readable anyway.
 */
export const CADENCE_MIN_MS = 600;

/**
 * The slowest breath. Past about six seconds a rise and fall is no longer
 * distinguishable across a room from flat water, and flat water is reserved:
 * it means the agent stopped, or the operator is the one being waited on.
 * Clamping here keeps "slow but alive" visibly different from "still".
 * (`motion.css` ships `--mo-period: 2400ms`, which sits inside this range, so
 * the token's own default is a plausible middle rather than an edge.)
 */
export const CADENCE_MAX_MS = 6_000;

/**
 * How long after the last completed tool call the water goes flat.
 *
 * Twenty times `CADENCE_MAX_MS`, so a basin breathing at the slowest rate
 * Wanigan animates is never mistaken for a quiet one; and a fifth of the
 * ten-minute default stall `attention.ts` measures against hook events, so the
 * rail stops breathing well before Wanigan tells anybody the session stalled.
 * Those are two different statements — "nothing has completed lately" and
 * "this session is stuck" — and the softer one is allowed to be wrong sooner.
 */
export const CADENCE_QUIET_MS = 120_000;

/**
 * How fast the live basin breathes, or why it does not.
 *
 * `completionsAt` is the recorded finish time of that session's completed tool
 * calls. It is a snapshot of rows, so it arrives in whatever order a query
 * returned it and may carry the same instant twice when one event is read
 * twice; sorting and de-duplicating here costs nothing at these sizes, and a
 * module that quietly returns nonsense for unsorted input is a module whose
 * bug surfaces as a basin breathing at the wrong speed with nothing to blame.
 */
export function cadence(completionsAt: readonly number[], now: number): Cadence {
  // De-duplicated before it is counted, on purpose: three recordings of one
  // instant are one observation, not three, so they do not buy a basin its way
  // past CADENCE_MIN_SAMPLES, and a run of them cannot drag the median to zero
  // and pin the basin at its fastest.
  const stamps = [...new Set(completionsAt.filter((at) => Number.isFinite(at)))].sort((a, b) => a - b);
  if (stamps.length < CADENCE_MIN_SAMPLES) return { kind: 'still', reason: 'too-few-samples' };

  // A clock we cannot read is not evidence that the session went quiet, so an
  // unusable `now` leaves the measured rate standing rather than flattening a
  // basin that may well be working.
  const last = stamps[stamps.length - 1];
  if (Number.isFinite(now) && now - last > CADENCE_QUIET_MS) return { kind: 'still', reason: 'quiet' };

  const gaps: number[] = [];
  for (let index = 1; index < stamps.length; index++) gaps.push(stamps[index] - stamps[index - 1]);
  gaps.sort((a, b) => a - b);

  // The median, and with an even number of gaps the lower of the two middles
  // rather than their average. Two reasons, both the same reason: averaging
  // lets one slow tool call pull the rate, which is exactly the distortion a
  // median is here to prevent — at three samples there are two gaps, and half
  // of a four-minute build would be the whole number. And the lower middle is
  // an interval that actually happened, where an average is a value that never
  // occurred. This surface does not show numbers that never occurred.
  const middle = gaps[Math.floor((gaps.length - 1) / 2)];

  // Rounded because the value leaves here as a CSS duration in whole
  // milliseconds, and clamped because the ends of the range are not rates any
  // more — see the two constants for what each end is protecting.
  const periodMs = Math.round(Math.min(CADENCE_MAX_MS, Math.max(CADENCE_MIN_MS, middle)));
  return { kind: 'swelling', periodMs };
}

/**
 * The pile on a basin floor: one grain per completed tool call, and a count
 * once the floor is full.
 *
 * Deliberately not a progress bar. Nobody knows how many tool calls a task
 * needs, so a percentage would be a fabrication; a pile that grew is a fact
 * about work that happened. `overflow` is null until the cap is passed so the
 * caller has nothing to render in the ordinary case, and the full count — not
 * the excess — once there is, because "247" is the number an operator wants.
 */
export function sediment(completed: number): Sediment {
  // The count comes from a query that can hand back nothing, something
  // fractional, or something negative when a row is missing. None of those is
  // worth throwing at an operator mid-run: nothing recorded is zero grains.
  const count = Number.isFinite(completed) && completed > 0 ? Math.floor(completed) : 0;
  return { grains: Math.min(count, SEDIMENT_CAP), overflow: count > SEDIMENT_CAP ? count : null };
}

// FNV-1a, 32-bit, written out here rather than depended on: it is nine lines,
// and a dependency added for nine lines is one more thing `test:dead-code` has
// to reason about and one more line in the hand-enumerated egress table.
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a(text: string): number {
  let hash = FNV_OFFSET;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    // Both bytes of the code unit are mixed in, so an id with non-ASCII
    // characters cannot collide with the ASCII id that shares its low bytes.
    hash = Math.imul(hash ^ (code & 0xff), FNV_PRIME);
    hash = Math.imul(hash ^ (code >>> 8), FNV_PRIME);
  }
  return hash >>> 0;
}

/**
 * Murmur3's finalizer, and the reason this function exists at all.
 *
 * FNV-1a does not avalanche its last byte: its final step is a multiply, so
 * two ids differing only in their last character land a fixed distance apart,
 * and taking that result modulo eight would walk `node_a1`, `node_a2`,
 * `node_a3` through the scatters in lockstep — a pattern, which is worse than
 * a repeat because it looks deliberate. Mixing first spreads a one-bit
 * difference across the whole word, so neighbouring ids land independently.
 */
function avalanche(hash: number): number {
  let mixed = hash >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x85ebca6b);
  mixed ^= mixed >>> 13;
  mixed = Math.imul(mixed, 0xc2b2ae35);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

/**
 * Which of the stylesheet's fixed scatters this node's sediment uses.
 *
 * Seeded from the node id and nothing else — not sampled, not counted from,
 * not `Math.random` — so the same relay silts up the same way twice and a
 * screenshot of it is reproducible and a visual regression in it means
 * something. That is the discipline `Pet.tsx` already keeps for the orb.
 * Always an integer in [0, SEDIMENT_SEEDS), whatever the id is.
 */
export function seedOf(nodeId: string): number {
  // SEDIMENT_SEEDS is a power of two, so this is the low bits of the mixed
  // word — which is safe precisely because `avalanche` made the low bits as
  // good as the rest. Modulo on a non-power-of-two would still be correct,
  // just very slightly biased; the bound is what matters and it holds either
  // way, including for the empty string, which hashes to the offset basis.
  return avalanche(fnv1a(nodeId)) % SEDIMENT_SEEDS;
}

/**
 * The phases that are counted out in advance, and so may show a level.
 *
 * Verify counts gate steps passed over gate steps total. Estimate counts tasks
 * priced over tasks in the plan, which is known the moment the planner stops,
 * and it prices them from Wanigan's own recorded history — local, free, and
 * bounded by a list that already exists. Both totals are real before their
 * stage starts, which is the whole qualification.
 */
const GAUGED: readonly RelayPhase[] = ['estimate', 'verify'];

/**
 * The level in a basin, where a level is honest — which is two of the five
 * basins and neither of the ones an operator would most like it on.
 *
 * A fill claims a denominator. Plan, implement and review have none: a plan is
 * done when it is done, nobody knows how many tool calls a task needs, and a
 * judgment has no step count. Those three get swell and sediment and no gauge
 * at all, and the asymmetry is the point — a basin with a rising level is a
 * stage whose end is known, and an operator learns that distinction in one run.
 * This function is mostly here to keep saying no: the next caller who wants a
 * progress bar on the implement basin has to change this line to get one.
 *
 * Null rather than `{ value: 0, max: 0 }` because there is no bar to draw
 * empty: an empty gauge on a plan basin would still be promising an end.
 */
export function gauge(phase: RelayPhase, passed: number, total: number): Gauge {
  if (!GAUGED.includes(phase)) return null;
  // No total, no denominator, no fill. A gate with no steps recorded and a
  // plan with no tasks in it have not told us anything yet, and 0/0 is not a
  // beginning, it is an absence.
  if (!Number.isFinite(total) || total <= 0) return null;
  const value = Number.isFinite(passed) ? Math.min(total, Math.max(0, passed)) : 0;
  return { value, max: total };
}
