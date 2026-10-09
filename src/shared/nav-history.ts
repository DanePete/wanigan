// The code editor's Back and Forward, as an IDE has them: every jump (quick
// open, go to line, a breadcrumb, Edit code from the live view, a search
// result, a long move of the cursor) remembers where the cursor was and where
// it went, across files. Back returns to the place before; Forward undoes
// that. Places a few lines apart in one file are one place. Pure, so tested.

export interface NavSpot {
  /** Which open file: its root and path, as the editor keys a tab. */
  key: string;
  /** For showing: the file's path. */
  path: string;
  line: number;
  col: number;
}

export interface NavHistory {
  spots: NavSpot[];
  /** Where the editor is now in `spots`; -1 before the first jump. */
  index: number;
}

export const EMPTY_NAV: NavHistory = Object.freeze({ spots: [], index: -1 }) as NavHistory;
/** The most places remembered; the oldest go first. */
export const NAV_LIMIT = 60;
/** Two places in one file closer than this many lines are the same place. */
export const NEAR_LINES = 4;

export const near = (a: NavSpot | undefined, b: NavSpot | undefined): boolean =>
  !!a && !!b && a.key === b.key && Math.abs(a.line - b.line) < NEAR_LINES;

function capped(spots: NavSpot[], index: number): NavHistory {
  const drop = Math.max(0, spots.length - NAV_LIMIT);
  return { spots: spots.slice(drop), index: index - drop };
}

/**
 * A jump from `from` (where the cursor was; null with nothing open) to `to`.
 * Anything Forward could have returned to is dropped, as a browser drops it.
 */
export function navJump(nav: NavHistory, from: NavSpot | null, to: NavSpot): NavHistory {
  const spots = nav.spots.slice(0, nav.index + 1);
  if (from) {
    if (near(spots.at(-1), from)) spots[spots.length - 1] = from; else spots.push(from);
  }
  if (near(spots.at(-1), to)) spots[spots.length - 1] = to; else spots.push(to);
  return capped(spots, spots.length - 1);
}

/** Whether Back has somewhere to go from `current`. */
export function canBack(nav: NavHistory, current: NavSpot | null): boolean {
  if (nav.index > 0) return true;
  return nav.index === 0 && !!current && !near(nav.spots[0], current);
}

export function canForward(nav: NavHistory): boolean {
  return nav.index >= 0 && nav.index < nav.spots.length - 1;
}

/**
 * Back from `current`. If the cursor moved on from the place it was last
 * taken to, that is remembered first, so Forward comes back to it.
 */
export function navBack(nav: NavHistory, current: NavSpot | null): { nav: NavHistory; to: NavSpot } | null {
  if (!canBack(nav, current)) return null;
  let spots = [...nav.spots];
  let index = nav.index;
  if (current) {
    if (near(spots[index], current)) spots[index] = current;
    else { spots = [...spots.slice(0, index + 1), current]; index = spots.length - 1; }
  }
  index -= 1;
  const next = capped(spots, index);
  return { nav: next, to: next.spots[next.index] as NavSpot };
}

export function navForward(nav: NavHistory, current: NavSpot | null): { nav: NavHistory; to: NavSpot } | null {
  if (!canForward(nav)) return null;
  const spots = [...nav.spots];
  if (current && near(spots[nav.index], current)) spots[nav.index] = current;
  const index = nav.index + 1;
  return { nav: { spots, index }, to: spots[index] as NavSpot };
}

/** Straight to one remembered place (the recent locations list), keeping the rest as they are. */
export function navGo(nav: NavHistory, index: number, current: NavSpot | null): { nav: NavHistory; to: NavSpot } | null {
  if (index < 0 || index >= nav.spots.length) return null;
  const spots = [...nav.spots];
  if (current && near(spots[nav.index], current)) spots[nav.index] = current;
  return { nav: { spots, index }, to: spots[index] as NavSpot };
}

/** Places for the recent locations list: newest first, each with its index, the current one marked. */
export function recentSpots(nav: NavHistory): { spot: NavSpot; index: number; current: boolean }[] {
  return nav.spots.map((spot, index) => ({ spot, index, current: index === nav.index })).reverse();
}

/** Forget a file's places (its tab closed and it was deleted): Back never lands on nothing. */
export function navForget(nav: NavHistory, key: string): NavHistory {
  const before = nav.spots.slice(0, nav.index + 1).filter((s) => s.key !== key).length;
  const spots = nav.spots.filter((s) => s.key !== key);
  return { spots, index: Math.min(spots.length - 1, Math.max(spots.length ? 0 : -1, before - 1)) };
}
