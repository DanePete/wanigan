/** What the rest of the app can ask of Wanigan, and the rules that turn it into
 * gestures. Pure, so it is tested without a GPU. */

/** A state he holds while it is true. Entering one may perform once; holding it
 * never repeats the performance.
 * - `thinking`: work in progress. A slow swirl in the water and an engaged gaze, held.
 * - `celebrate`: work completed. A fountain, a burst of bubbles, a nod and warmth, once.
 * - `alarm`: something failed. A fire whirl with red light for about six seconds,
 *   then a low red glow held for as long as the alarm stands.
 * - `recovered`: it works again. A blue flame for about three seconds, once. */
export type OrbMood = 'idle' | 'thinking' | 'celebrate' | 'alarm' | 'recovered';

/** What fills the globe. Water is the default; wax is the lava lamp. */
export type OrbMaterial = 'water' | 'wax';

/** One-off play, each a single gesture:
 * - `spin`: a full turn after a 140 ms wind-up; refused within 1.5 s of the last.
 * - `splash`: a flick of the water.
 * - `burst`: every bubble at once, larger, with a fountain at the centre.
 * - `rain`: a cloud gathers, rain falls and rings the surface, the glass beads; about 10 s.
 * - `bloom`: ink drops in and folds through the water, then clears.
 * - `shake`: a hard shake of the globe. */
export type OrbAction = 'spin' | 'splash' | 'burst' | 'rain' | 'bloom' | 'shake';

export const ORB_MOODS: readonly OrbMood[] = ['idle', 'thinking', 'celebrate', 'alarm', 'recovered'];
export const ORB_ACTIONS: readonly OrbAction[] = ['spin', 'splash', 'burst', 'rain', 'bloom', 'shake'];

/** The one-off performance that entering a mood starts. */
export type MoodCue = 'celebrate' | 'fail' | 'recover';

/** What changing from `previous` to `next` performs, if anything. The mood he
 * first appears in is not a change: a view that opens on an alarm shows the
 * held red glow, not a fire. */
export function cueFor(previous: OrbMood, next: OrbMood): MoodCue | null {
  if (previous === next) return null;
  if (next === 'celebrate') return 'celebrate';
  if (next === 'alarm') return 'fail';
  if (next === 'recovered') return 'recover';
  return null;
}

/** Actions that act on water alone: in the lava lamp there is nothing for them
 * to do, so they are refused rather than performed invisibly. */
export function playable(action: OrbAction, material: OrbMaterial): boolean {
  return material === 'water' || !(action === 'burst' || action === 'rain' || action === 'bloom');
}
