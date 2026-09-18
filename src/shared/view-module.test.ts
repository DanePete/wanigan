/**
 * The seam's contract. Most of these assert a failure that today's hand
 * registration cannot produce at all — a missing project scope, a phone
 * disposition nobody decided, a tenth claimant on a nine-chord row. Those are
 * the rows the registration audit found nothing enforcing, so they are the ones
 * worth holding.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIGIT_SLOTS, areaTabs, demoViews, iconMap, phoneAbsences, projectScopeOf,
  routeRows, shortcutMap, shortcutOrder, validateViewModules,
  type ViewArea, type ViewModule,
} from './view-module.ts';

const AREAS: ViewArea[] = [
  { id: 'work', label: 'Projects', icon: 'terminal', tabs: ['sessions'] },
  { id: 'fleet', label: 'Fleet', icon: 'grid', tabs: ['fleet'] },
];

const view = (over: Partial<ViewModule> = {}): ViewModule => ({
  id: 'sessions', label: 'Sessions', hint: 'Start and drive live agent terminals',
  keywords: 'agent terminal', icon: 'terminal', area: 'work',
  projectScope: 'optional', shortcut: { label: '⌘1', aria: 'Meta+1 Control+1' },
  phone: { narrowedBy: 'agent' }, demo: true, digit: true, ...over,
});

/** Most cases declare one destination, so they validate against one area —
 *  otherwise the (correct) empty-area rule fires on the unused one. */
const ONE_AREA: ViewArea[] = [{ id: 'work', label: 'Projects', icon: 'terminal', tabs: ['sessions'] }];
const ok = (modules: ViewModule[], areas: ViewArea[] = ONE_AREA) =>
  validateViewModules(modules, areas);

test('the group a destination prints comes from its area, so the two cannot disagree', () => {
  const rows = routeRows([view({ area: 'fleet' })], AREAS);
  assert.equal(rows[0].group, 'Fleet');
  // The palette prints `group · hint`; nothing paired those strings before.
  assert.equal(rows[0].hint, 'Start and drive live agent terminals');
});

test('a destination missing from the registry has no scope rather than a silent workspace', () => {
  const modules = [view({ id: 'git', projectScope: 'required' })];
  assert.equal(projectScopeOf(modules, 'git'), 'required');
  // The current helper returns 'workspace' for an unlisted tab, which is how a
  // view silently claims the remembered project does not filter its data.
  assert.equal(projectScopeOf(modules, 'never-registered'), null);
});

test('the shortcut order is digit holders first, then the rest, with no hand-listed tail', () => {
  const modules = [
    view({ id: 'a', digit: true, shortcut: { label: '⌘1', aria: 'a' } }),
    view({ id: 'b', digit: false, shortcut: { label: '⌘⇧B', aria: 'b' } }),
    view({ id: 'c', digit: true, shortcut: { label: '⌘2', aria: 'c' } }),
  ];
  assert.deepEqual(shortcutOrder(modules), ['a', 'c', 'b']);
  // Every destination appears exactly once: the count identity the keymap test
  // checks today can no longer be satisfied by a tail somebody edited by hand.
  assert.equal(new Set(shortcutOrder(modules)).size, modules.length);
});

test('a tenth claimant on the digit row is an error naming every holder', () => {
  const modules = Array.from({ length: DIGIT_SLOTS + 1 }, (_, i) =>
    view({ id: 'v' + i, digit: true, shortcut: { label: '⌘' + i, aria: 'k' + i } }));
  const errors = ok(modules);
  const found = errors.find((e) => e.includes('claim a digit-row chord'));
  assert.ok(found, 'overflowing the digit row must be an error');
  assert.match(found, /v0/);
  assert.match(found, /v9/);
});

test('two destinations printing the same chord is an error, because one never fires', () => {
  const errors = ok([
    view({ id: 'a', shortcut: { label: '⌘⇧K', aria: 'x' } }),
    view({ id: 'b', shortcut: { label: '⌘⇧K', aria: 'y' } }),
  ]);
  assert.ok(errors.some((e) => e.includes('already held by a')));
});

test('a phone disposition is required, and a reason has to be a sentence', () => {
  assert.deepEqual(ok([view({ phone: { narrowedBy: 'agent' } })]), []);

  const short = ok([view({ phone: { absent: 'No room.' } })]);
  assert.ok(short.some((e) => e.includes('too short to be a decision')));

  const unpunctuated = ok([view({
    phone: { absent: 'This surface needs a keyboard and a wide diff to be any use' },
  })]);
  assert.ok(unpunctuated.some((e) => e.includes('not a sentence')));

  const good = ok([view({
    phone: { absent: 'This surface needs a keyboard and a wide diff to be any use.' },
  })]);
  assert.deepEqual(good, []);
});

test('a hint that restates its label is refused, because it matches only its own name', () => {
  const errors = ok([view({ label: 'Scout', hint: 'scout' })]);
  assert.ok(errors.some((e) => e.includes('restates the label')));
});

test('an unknown area is an error rather than an empty group string', () => {
  const errors = validateViewModules([view({ area: 'nowhere' })], ONE_AREA);
  assert.ok(errors.some((e) => e.includes('is not a known area')));
  // And the derivation would otherwise have printed an empty group in the palette.
  assert.equal(routeRows([view({ area: 'nowhere' })], AREAS)[0].group, '');
});

test('an area with no destinations is an error, because its sidebar row opens nothing', () => {
  const errors = validateViewModules([view({ area: 'work' })], AREAS);
  assert.ok(errors.some((e) => e.includes('"fleet" has no destinations')));
});

test('an area and its destinations must agree on membership, but not on order', () => {
  const areas: ViewArea[] = [{ id: 'work', label: 'Projects', icon: 'terminal', tabs: ['b', 'a'] }];
  const modules = [
    view({ id: 'a', area: 'work' }),
    view({ id: 'b', area: 'work', shortcut: { label: '⌘2', aria: 'b' } }),
  ];
  // Order differs from registry order on purpose — the sidebar owns its own
  // sequence and that is not an error.
  assert.deepEqual(validateViewModules(modules, areas), []);

  const orphan = validateViewModules(modules, [{ id: 'work', label: 'Projects', icon: 'terminal', tabs: ['a'] }]);
  assert.ok(orphan.some((e) => e.includes('b: claims area "work"')));

  const dead = validateViewModules(
    [view({ id: 'a', area: 'work' })],
    [{ id: 'work', label: 'Projects', icon: 'terminal', tabs: ['a', 'ghost'] }],
  );
  assert.ok(dead.some((e) => e.includes('lists "ghost"')));
});

test('a destination declared twice is caught by id', () => {
  const errors = ok([view({ id: 'twice' }), view({ id: 'twice', shortcut: { label: '⌘4', aria: 'z' } })]);
  assert.ok(errors.some((e) => e.includes('twice: declared twice')));
});

test('the icon, shortcut, area and demo tables all derive from the same list', () => {
  const modules = [
    view({ id: 'a', icon: 'grid', area: 'fleet', demo: true }),
    view({ id: 'b', icon: 'brain', area: 'work', demo: false, shortcut: { label: '⌘5', aria: 'b' } }),
  ];
  assert.deepEqual(iconMap(modules), { a: 'grid', b: 'brain' });
  assert.deepEqual(shortcutMap(modules).a, { label: '⌘1', aria: 'Meta+1 Control+1' });
  assert.deepEqual(areaTabs(modules, 'fleet'), ['a']);
  assert.deepEqual(demoViews(modules), ['a']);
});

test('phone absences come back with their sentences for the Device screen', () => {
  const reason = 'Reading a diff on a phone is worse than not reading one.';
  const modules = [view({ id: 'git', phone: { absent: reason } }), view({ id: 'fleet' })];
  assert.deepEqual(phoneAbsences(modules), [{ id: 'git', reason }]);
});

test('a well-formed registry validates clean', () => {
  assert.deepEqual(validateViewModules([
    view({ id: 'sessions', area: 'work' }),
    view({ id: 'fleet', label: 'Fleet', hint: 'Every session at once, and which ones need you',
      area: 'fleet', digit: true, shortcut: { label: '⌘2', aria: 'Meta+2 Control+2' },
      phone: { narrowedBy: 'fleet' } }),
  ], AREAS), []);
});
