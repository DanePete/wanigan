/**
 * The invariant suite.
 *
 * `view-registry.ts` used to be checked by a separate equivalence proof: every
 * assertion here imported a *hand-written* table and asserted a derivation
 * reproduced it. Now that `routes.ts`, `spaces.ts`, `demo.ts` and most of
 * `mobile-nav.ts` read those derivations directly, most of that proof turned
 * tautological — `TABS` deepEqual `routeRows(VIEWS, VIEW_AREAS)` is now
 * checking a function against its own call, because that call *is* `TABS`.
 * A tautology that stays green forever is not a test; asserting it would only
 * make removing the tautology someday harder to notice.
 *
 * What survives is what a hand-registered view could previously break with
 * nothing to catch it — the checks `validateViewModules` runs — plus the
 * handful of findings that are true properties of this data rather than
 * artifacts of how it used to be duplicated. Two are cross-file: the sidebar's
 * own order genuinely differs from registry order in four areas, and
 * `MOBILE_VIEWS[].narrows` is hand-written on purpose and has to keep
 * agreeing with `VIEWS`'s `phone.narrowedBy` field by content, not by import.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TABS, VIEW_SHORTCUT_ORDER } from './routes.ts';
import { MOBILE_VIEWS } from './mobile-nav.ts';
import { DIGIT_SLOTS, areaTabs, validateViewModules } from './view-module.ts';
import { VIEWS, VIEW_AREAS } from './view-registry.ts';

const sorted = (ids: readonly string[]) => [...ids].sort();

/* ── the registry holds itself up ─────────────────────────────────────── */

test('the registry passes every rule a hand-registered view could previously break', () => {
  assert.deepEqual(validateViewModules(VIEWS, VIEW_AREAS), []);
});

test('every Tab id is declared exactly once', () => {
  const ids = VIEWS.map((view) => view.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('exactly DIGIT_SLOTS views claim a digit-row chord', () => {
  const digits = VIEWS.filter((view) => view.digit).map((view) => view.id);
  assert.equal(digits.length, DIGIT_SLOTS);
});

test('every view has exactly one phone disposition, and never both', () => {
  for (const view of VIEWS) {
    const phone: { narrowedBy?: string; absent?: string } = view.phone;
    assert.equal(
      'absent' in phone !== 'narrowedBy' in phone, true,
      `${view.id}: exactly one of narrowedBy / absent`,
    );
  }
});

test('every VIEW_AREAS tab id is a registered view, and every view is listed by its own area', () => {
  const ids = new Set(VIEWS.map((view) => view.id));
  for (const area of VIEW_AREAS) {
    for (const id of area.tabs) assert.ok(ids.has(id), `${area.id} lists unregistered "${id}"`);
  }
  for (const view of VIEWS) {
    const area = VIEW_AREAS.find((candidate) => candidate.id === view.area);
    assert.ok(area, `${view.id}: area "${view.area}" exists`);
    assert.ok(
      (area!.tabs as readonly string[]).includes(view.id),
      `${view.id}: not listed by its own area "${view.area}"`,
    );
  }
});

test('the group each route prints in the palette is its area\'s label', () => {
  const label = new Map(VIEW_AREAS.map((area) => [area.id, area.label]));
  for (const row of TABS) {
    const view = VIEWS.find((candidate) => candidate.id === row.id);
    assert.ok(view, `${row.id} is registered`);
    assert.equal(row.group, label.get(view!.area), `${row.id}: group is its area's label`);
  }
});

/* ── findings: true properties of this data, not proofs about a duplicate ── */

test('areaTabs reaches the same destinations per area as VIEW_AREAS, but not in the sidebar order', () => {
  for (const area of VIEW_AREAS) {
    assert.deepEqual(
      sorted(areaTabs(VIEWS, area.id)), sorted(area.tabs),
      `${area.id}: same destinations`,
    );
  }
  // FINDING, pinned rather than sorted away: `areaTabs` derives order from
  // registry declaration order, which is `TABS` order because `routeRows` must
  // reproduce the palette. The sidebar's order within an area is a *different*
  // order — Projects lists Sessions, Board, Changes, Context while `VIEWS`
  // reaches them first, ninth, thirteenth and sixteenth — so four of the seven
  // areas come back correct in membership and wrong in sequence. One array
  // cannot be in two orders, so the sidebar keeps reading `VIEW_AREAS[].tabs`.
  const reordered = VIEW_AREAS
    .filter((area) => JSON.stringify(areaTabs(VIEWS, area.id)) !== JSON.stringify([...area.tabs]))
    .map((area) => area.id);
  assert.deepEqual(reordered, ['work', 'fleet', 'knowledge', 'automation']);
});

test('every phone screen narrows exactly the desktop views that name it, in whatever order MOBILE_VIEWS was written', () => {
  for (const screen of MOBILE_VIEWS) {
    const claimed = VIEWS
      .filter((view) => 'narrowedBy' in view.phone && view.phone.narrowedBy === screen.id)
      .map((view) => view.id);
    assert.deepEqual(sorted(screen.narrows), sorted(claimed), `${screen.id}: same desktop views`);
  }
});

test('VIEW_SHORTCUT_ORDER is the digit row and then every other destination in registry order', () => {
  // Before this conversion the cheat sheet's hand-listed tail read …board,
  // extensions, mission: a drift from TABS that nothing compared, pinned as a
  // finding rather than fixed. Deriving the order from `digit` resolves it by
  // construction. This asserts the RELATION the derivation guarantees rather
  // than a literal tail, because every destination added from now on is
  // appended past the digit row and would otherwise break a test that was
  // never about it.
  const digit = VIEWS.filter((v) => v.digit).map((v) => v.id);
  const rest = VIEWS.filter((v) => !v.digit).map((v) => v.id);
  assert.deepEqual([...VIEW_SHORTCUT_ORDER], [...digit, ...rest]);
  const at = (id: string) => VIEW_SHORTCUT_ORDER.indexOf(id as (typeof VIEW_SHORTCUT_ORDER)[number]);
  assert.ok(at('board') < at('mission') && at('mission') < at('extensions'),
    'the resolved order keeps Home before Extensions, matching the palette');
});
