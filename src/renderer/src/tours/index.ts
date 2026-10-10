// Which tour each place has. A place is a view the owner can be in (a project's
// Board, a session, Settings); its tour, when it has steps, offers itself the
// first time the place is opened and replays from the status line's compass and
// the palette. A place with no tour shows neither, rather than an empty one.
import type { Route } from '../lib/router';
import type { Tour } from './types';
import { BOARD_TOURS } from './board';
import { CHANGES_TOURS } from './changes';
import { LIVE_TOURS } from './live';
import { SESSIONS_TOURS } from './sessions';
import { SETTINGS_TOURS } from './settings';
import { WELCOME } from './welcome';

export type { Tour, TourContext, TourStep } from './types';

const ALL: Tour[] = [WELCOME, ...LIVE_TOURS, ...BOARD_TOURS, ...SESSIONS_TOURS, ...CHANGES_TOURS, ...SETTINGS_TOURS];

/** Every tour with something to show, by id. */
export const TOURS: ReadonlyMap<string, Tour> = new Map(ALL.filter((t) => t.steps.length > 0).map((t) => [t.id, t]));

/** The place a route is: a project's view by its name (board, live, changes…), else the route's own name. */
export function placeOf(route: Route): string {
  return route.name === 'project' ? route.view : route.name;
}

/** The tour of the place a route shows, if it has one. */
export function tourFor(route: Route): Tour | null {
  return TOURS.get(placeOf(route)) ?? null;
}
