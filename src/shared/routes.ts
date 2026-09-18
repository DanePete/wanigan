import { DIGIT_SLOTS, iconMap, routeRows, shortcutMap, shortcutOrder, type RouteRow } from './view-module.ts';
import { VIEW_AREAS, VIEWS, type Tab } from './view-registry.ts';
import { SPACE_AREAS } from './spaces.ts';

export type { Tab };

/**
 * The route table, derived rather than hand-kept.
 *
 * Before this conversion, `TABS`, `TAB_ICONS`, `TAB_SHORTCUTS`,
 * `VIEW_SHORTCUT_ORDER` and `Tab` itself were five hand-written tables in this
 * file — part of the seven-places problem `view-registry.ts` describes.
 * `VIEWS` and `VIEW_AREAS` now declare every destination once, and
 * `view-module.ts` holds the derivations that turn that declaration back into
 * the shapes this file's consumers already import. This file is what is left:
 * the wiring that names each derivation under the export a caller already
 * reaches for, so no importer of `routes.ts` had to change for this conversion
 * to be reviewable as a move. The per-destination decisions that used to sit
 * beside a row here — why Scout is ⌘⇧I, why Board is appended past the digit
 * row, why Extensions is a different word from Plugins — live once now, as
 * comments beside the view they explain in `view-registry.ts`, rather than a
 * second time here.
 *
 * `TABS` still prints in ⌘1–9 order, because `VIEWS` is declared in that order
 * for exactly that reason (see `view-registry.ts`). `hint` is still a sentence
 * about what the surface does, not a restatement of its label: the palette
 * matches a query against the title, the hint and the keywords as one string,
 * and surviving rows keep this table's order rather than being ranked — so a
 * stale word left in a hint after the feature it named moved elsewhere still
 * outranks the view that actually owns the thing somebody typed.
 */
export const TABS: readonly RouteRow<Tab>[] = routeRows(VIEWS, VIEW_AREAS);

/**
 * The icon each destination wears in the sidebar. Data, not decoration: it is
 * the second way to find a row at a glance, and it never replaces the word
 * beside it — a sidebar of glyphs alone is a quiz. Names match the small
 * inline set in components/bits.tsx.
 */
export const TAB_ICONS: Record<Tab, string> = iconMap(VIEWS);

/** The order the sidebar lists destinations in, grouped by the job they serve. */
export const SIDEBAR_GROUPS: readonly { group: string; tabs: readonly Tab[] }[] =
  SPACE_AREAS.map(area => ({ group: area.label, tabs: area.tabs }));

/**
 * How many leading `TABS` entries the digit row reaches: ⌘1 through ⌘9. Equal
 * to `view-module.ts`'s `DIGIT_SLOTS`, which is what a `digit: true` view is
 * validated against; kept under this name because it is the one other files
 * already import.
 */
export const DIGIT_ROUTES = DIGIT_SLOTS;

/**
 * The direct routes, written out once so the rail, the palette, the cheat
 * sheet and the key handler cannot drift apart. ⌘1–9 go to the nine views
 * `VIEWS` marks `digit: true`, and every other surface carries the named chord
 * recorded on its own entry in `view-registry.ts`. `aria` is the
 * aria-keyshortcuts string, and it is also what the key handler matches
 * against, so a published chord is a working chord.
 */
export const TAB_SHORTCUTS: Record<Tab, { label: string; aria: string }> = shortcutMap(VIEWS);

/**
 * The view rows of the cheat sheet, in the order a reader expects: the digit
 * row, then everything else. `shortcutOrder` puts every `digit` view first, in
 * `VIEWS` order, and every remaining view after, also in `VIEWS` order — so a
 * route added to `VIEWS` appears here in the same change, and there is no
 * hand-listed tail left to drift out of step with the digit row. There used to
 * be one: this table's old hand-listed tail had Extensions before Home, and
 * `TABS` had already reached Home first. Deriving the order resolves that
 * drift by construction rather than pinning it as a finding — see
 * `view-registry.ts` and this conversion's commit message.
 */
export const VIEW_SHORTCUT_ORDER: readonly Tab[] = shortcutOrder(VIEWS);

export function labelForTab(id: Tab): string {
  return TABS.find((item) => item.id === id)?.label ?? id;
}
