// What a guided tour is: a few stops, each pointing at one thing on the screen
// (by its `data-tour` name) and saying what it is for and what you can do there.
// Every sentence is something the app really does; a step whose target is not on
// the screen (no project open, a panel closed) is passed over, never pointed at
// nothing. The engine is components/Tour.tsx; which tour a view has is index.ts.
import type { Route } from '../lib/router';
import type { Side } from '../lib/tour-model';

export interface TourContext {
  /** ⌘ or Ctrl: write keys through `keys()` so each platform reads its own. */
  mac: boolean;
  /** The project shown now, if any. */
  projectKey: string | null;
  /** A project for a tour that goes to one: the first in the rail that is not paused, else the first. */
  firstProjectKey: string | null;
}

export interface TourStep {
  /** The `data-tour` name of what it points at (an element may carry several, space-separated). None centres the card. */
  target?: string;
  title: string;
  body: string | ((c: TourContext) => string);
  /** Which side of the target the card prefers; it flips when there is no room. */
  side?: Side;
  /** Where to go before this step: a route, undefined to stay, or null to pass over the step (nowhere to go). */
  go?: (c: TourContext) => Route | null | undefined;
}

export interface Tour {
  /** The place it belongs to (tours/index.ts `placeOf`), or `welcome`. */
  id: string;
  /** The view's name as the owner sees it: "Board", "Live". */
  name: string;
  /** One sentence for the first-visit offer: what the view is for. */
  intro: string;
  steps: TourStep[];
}

/** A chord's keys in words for this platform: keys(c, 'Mod', 'K') is "⌘K" on a Mac and "Ctrl+K" elsewhere. */
export function keys(c: TourContext, ...k: string[]): string {
  const label = (x: string): string => (x === 'Mod' ? (c.mac ? '⌘' : 'Ctrl') : x === 'Shift' ? (c.mac ? '⇧' : 'Shift') : x === 'Alt' ? (c.mac ? '⌥' : 'Alt') : x);
  return k.map(label).join(c.mac ? '' : '+');
}
