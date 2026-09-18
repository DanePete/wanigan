import { projectScopeOf, type ViewProjectScope } from './view-module.ts';
import { VIEW_AREAS, VIEWS, type Tab } from './view-registry.ts';

/**
 * The presentation areas, derived rather than hand-kept.
 *
 * Before this conversion `SPACE_AREAS` was itself the hand-authored table: the
 * sidebar's grouping and its per-area order, plus an `icon` per row that
 * `view-registry.ts`'s `VIEW_AREAS` did not yet carry. `icon` moved there so
 * nothing is hand-kept twice, and `VIEW_AREAS[].tabs` was always — and still
 * is — the sidebar's own order, not registry order and not derivable from it
 * (see `view-module.ts`'s `areaTabs` and the divergence `view-registry.test.ts`
 * pins). This file is now the one place that reads that order back under the
 * name `SPACE_AREAS`, so the rail, `routes.ts`'s `SIDEBAR_GROUPS` and every
 * test written against this name did not have to change for this conversion to
 * be reviewable as a move.
 */
export const SPACE_AREAS = VIEW_AREAS satisfies readonly { id: string; label: string; icon: string; tabs: readonly Tab[] }[];

export function areaFor(tab: Tab) {
  return SPACE_AREAS.find((area) => (area.tabs as readonly Tab[]).includes(tab)) ?? SPACE_AREAS[0];
}

export type SpaceAreaId = (typeof SPACE_AREAS)[number]['id'];
export type AreaMemory = Partial<Record<SpaceAreaId, Tab>>;

/** Moving between areas must not turn returning to work into starting over. */
export function rememberDestination(memory: AreaMemory, tab: Tab): AreaMemory {
  return { ...memory, [areaFor(tab).id]: tab };
}

export function areaDestination(id: SpaceAreaId, memory: AreaMemory): Tab {
  const area = SPACE_AREAS.find(item => item.id === id) ?? SPACE_AREAS[0];
  const remembered = memory[id];
  return remembered && (area.tabs as readonly Tab[]).includes(remembered) ? remembered : area.tabs[0];
}

/**
 * A workspace view does not pretend the remembered project filters its data.
 *
 * Derived from the registry's own `projectScope` field rather than branching on
 * `tab` by hand. The old branches below fell through to `'workspace'` for any
 * view they did not name — silently, so a new view landed on `'workspace'` by
 * omission rather than by a decision anyone made about it:
 *
 *   if (tab === 'git' || tab === 'context') return 'required';
 *   if (tab === 'mission' || tab === 'sessions' || tab === 'board') return 'optional';
 *   return 'workspace';
 *
 * `Tab` is now derived from `VIEWS` itself, so it is exhaustive over the
 * registry by construction: every value this function's parameter type allows
 * is a row `projectScopeOf` can look up, and `null` — "not a registered
 * destination" — is a case that can no longer occur. Asserting that rather
 * than defaulting through it means a bug here becomes a thrown error to fix,
 * not a silent `'workspace'` nobody sees.
 */
export function projectScopeFor(tab: Tab): ViewProjectScope {
  const scope = projectScopeOf(VIEWS, tab);
  if (scope === null) throw new Error(`${tab}: not a registered view — projectScopeOf can only return null for an id outside VIEWS, and every Tab is one.`);
  return scope;
}
