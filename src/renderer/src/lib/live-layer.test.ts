// The design layer as the window reads it: the tray's groups, an edit's reach and its before → after, what undo and
// redo would do, and a verification in words. Made-up site (acme); nothing real.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { kindWords } from '../../../main/live-layer.ts';
import type { LayerApplied, LayerEdit, LayerSnapshot, LayerVerdict } from '../../../shared/design-layer.ts';
import { kindKey, type LiveTrace, type PartIdentity, type TracePart } from '../../../shared/live-trace.ts';
import {
  alsoChangedWords, beforeWords, byPage, changeLines, cutWords, differenceWords, draftsOf, failedWords, heldWords, isFragile, kindName, madeOn, maskWords, noiseWords, orphanWhy,
  pagePath, reachWords, redoLabel, undoLabel, verdictHeadline,
} from './live-layer.ts';

const card = (nth: number): PartIdentity => ({ kind: 'component', name: 'acme:card', within: null, nth });
const trace: LiveTrace = {
  version: 1, platform: 'drupal', id: '0123456789abcdef', url: '/', at: 1, total: { ms: 1 }, edits: [],
  parts: [
    { id: 'p1', kind: 'component', label: 'Card', identity: card(0) },
    { id: 'p2', kind: 'field', label: 'Body', identity: { kind: 'entity', type: 'node', id: 'u-1', bundle: 'article', field: 'body' } },
  ],
};

let made = 0;
const edit = (over: Partial<LayerEdit> = {}): LayerEdit => ({
  id: over.id ?? `e${++made}`, label: 'Heading in Card (component)', page: '/events', scope: 'this', breakpoint: 'all',
  target: { part: card(0), inner: 'h3:nth-of-type(1)', selector: null, textHash: '0123456789abcdef' },
  change: { type: 'style', values: { color: '#c0392b' } }, before: { color: 'rgb(20, 20, 20)' }, state: 'draft', by: 'owner', at: 1, verdict: null, ...over,
});
const applied = (over: Partial<LayerApplied> = {}): LayerApplied => ({ page: '/events', shown: [], orphaned: [], elsewhere: [], off: false, ...over });

test('an edit belongs to the page it was made on, and the tray lists the page shown first', () => {
  assert.equal(pagePath('https://acme.example.test/events?page=2'), '/events?page=2');
  assert.equal(pagePath('not an address'), '');
  assert.ok(madeOn({ page: '/events' }, '/events?page=2'), 'a path alone matches any query, as the main process reads it');
  assert.ok(!madeOn({ page: '/events?page=1' }, '/events?page=2'));
  const a = edit({ id: 'a', page: '/about' }), b = edit({ id: 'b', page: '/events' }), c = edit({ id: 'c', page: '/about' });
  const groups = byPage([a, b, c], '/events');
  assert.deepEqual(groups.map((g) => [g.page, g.here, g.edits.map((e) => e.id).join()]), [['/events', true, 'b'], ['/about', false, 'a,c']]);
  assert.equal(draftsOf({ projectId: 'p', edits: [a, edit({ state: 'implemented' }), c], undo: null, redo: null }), 2);
});

test('what an edit reaches is said in words, a kind as the main process names it when it keys a pick', () => {
  for (const part of trace.parts as (TracePart & { identity: PartIdentity })[]) {
    const key = kindKey(part.identity) as string;
    assert.equal(kindName(part, key, null), kindWords(part, key, null));
    assert.equal(kindName(part, key, 'Heading'), kindWords(part, key, 'Heading'));
  }
  assert.equal(reachWords(edit(), trace, null), 'this element');
  const kind = edit({ id: 'k', scope: 'kind' });
  assert.equal(reachWords(kind, trace, null), 'every Card component');
  assert.equal(reachWords(kind, trace, applied({ shown: [{ id: 'k', elements: 4 }] })), 'every Card component (4 elements on this page)');
  assert.equal(reachWords(kind, trace, applied({ shown: [{ id: 'k', elements: 4 }], off: true })), 'every Card component', 'switched off, nothing is shown');
  // Without the trace, the identity's own names.
  assert.equal(reachWords(kind, null, null), 'every acme:card component');
  assert.equal(reachWords(edit({ scope: 'site', change: { type: 'token', name: '--accent', value: '#c0392b' } }), trace, null), 'the whole site');
});

test('before → after is a line per value, and what was not read says so', () => {
  assert.deepEqual(changeLines(edit({ change: { type: 'style', values: { color: '#c0392b', 'font-size': '20px' } } })), [
    { what: 'color', before: 'rgb(20, 20, 20)', after: '#c0392b' },
    { what: 'font-size', before: 'not read', after: '20px' },
  ]);
  assert.deepEqual(changeLines(edit({ change: { type: 'text', value: 'Spring open day' }, before: { text: 'Spring open house' } })), [
    { what: 'Words', before: 'Spring open house', after: 'Spring open day' },
  ]);
  assert.deepEqual(changeLines(edit({ change: { type: 'token', name: '--accent', value: '#c0392b' }, before: {} })), [{ what: '--accent', before: 'not read', after: '#c0392b' }]);
});

test('a target no part names is fragile, and an orphaned edit says why', () => {
  assert.ok(isFragile(edit({ target: { part: null, inner: null, selector: 'html > body > div:nth-of-type(2)', textHash: null } })));
  assert.ok(!isFragile(edit()));
  assert.ok(!isFragile(edit({ target: { part: null, inner: null, selector: null, textHash: null }, change: { type: 'token', name: '--accent', value: 'red' } })), 'a token has no element');
  const lost = edit({ id: 'lost', state: 'orphaned' });
  assert.equal(orphanWhy(lost, applied({ orphaned: [{ id: 'lost', why: 'Its element shows other words now.' }] })), 'Its element shows other words now.');
  assert.equal(orphanWhy(lost, applied()), 'Its element was not found on this page.');
  assert.match(orphanWhy(lost, applied({ page: '/about' })), /not found on \/events the last time that page was shown/);
});

test('undo and redo say what they would do', () => {
  const snap = (undo: LayerSnapshot['undo'], redo: LayerSnapshot['redo']): LayerSnapshot => ({ projectId: 'p', edits: [], undo, redo });
  assert.equal(undoLabel(snap(null, null)), 'Nothing to undo');
  assert.equal(undoLabel(snap({ id: 'a', label: 'Heading in Card', action: 'add' }, null)), 'Undo: take “Heading in Card” out of the layer');
  assert.equal(undoLabel(snap({ id: 'a', label: 'Heading in Card', action: 'discard' }, null)), 'Undo: bring back “Heading in Card”');
  assert.equal(redoLabel(snap(null, { id: 'a', label: 'Heading in Card', action: 'add' })), 'Redo: put “Heading in Card” back in the layer');
  assert.equal(redoLabel(snap(null, { id: 'a', label: 'Heading in Card', action: 'discard' })), 'Redo: discard “Heading in Card” again');
  assert.equal(redoLabel(null), 'Nothing to redo');
});

test('a verification is said in words: the step that failed, each difference, and the noise floor as two numbers', () => {
  const failed: LayerVerdict = {
    at: 1, ok: false, failed: 'styles', widths: [390, 1440], noise: { maxDiff: 3, pixels: 12 }, pictures: [],
    differences: [
      { kind: 'style', edit: 'a', width: 1440, element: 'h3.card__title', property: 'color', design: 'rgb(192, 57, 43)', result: 'rgb(20, 20, 20)' },
      { kind: 'box', edit: 'a', width: 390, element: 'h3.card__title', design: { x: 24, y: 910, width: 300, height: 48 }, result: { x: 24, y: 910, width: 300, height: 40 } },
    ],
  };
  assert.equal(verdictHeadline(failed), 'Not verified at 390 and 1440 px: the site does not render it as designed yet.');
  assert.equal(failedWords(failed), 'Step 1 of 3, the styles and boxes of the edited elements failed; the steps after it did not run.');
  assert.deepEqual(failed.differences.map(differenceWords), [
    'At 1440 px, h3.card__title: color is rgb(20, 20, 20) in the site, rgb(192, 57, 43) in the design.',
    'At 390 px, h3.card__title’s box is 300 × 40 at 24, 910 in the site, 300 × 48 at 24, 910 in the design.',
  ]);
  assert.equal(noiseWords(failed), 'Noise floor: up to 3 of 255 in 12 pixels, from rendering the site twice.');
  assert.equal(differenceWords({ kind: 'pixels', edit: 'a', width: 390, rect: { x: 24, y: 900, width: 320, height: 60 }, pixels: 1840, maxDiff: 172 }),
    'At 390 px, 1,840 pixels differ around it, by up to 172 of 255, in a 320 × 60 box at 24, 900.');
  assert.match(differenceWords({ kind: 'leak', width: 1440, rect: { x: 0, y: 1200, width: 1440, height: 80 }, pixels: 2, maxDiff: 40 }), /2 pixels differ away from every edited element/);
  const passed: LayerVerdict = { ...failed, ok: true, failed: null, differences: [], widths: [1440] };
  assert.equal(verdictHeadline(passed), 'Verified at 1440 px: the site renders it as designed.');
  assert.equal(failedWords(passed), null);
  assert.equal(failedWords({ ...failed, failed: 'rest' }), 'Step 3 of 3, the rest of the page failed.');
});

test('what a verification says whatever it decided: the page before compared or why not, how far down, what was held, and what was left out', () => {
  const v: LayerVerdict = {
    at: 1, ok: true, failed: null, widths: [390, 1440], noise: { maxDiff: 0, pixels: 0 }, differences: [], pictures: [],
    before: { ran: true, at: 1, widths: [390, 1440] }, held: { at: 1_700_000_000 }, cut: [{ width: 1440, to: 6_000, full: 9_412 }],
    masked: [{ label: 'Who’s online (block)', why: 'made for each user', widths: [390], nearEdit: false }, { label: 'The core/gallery block', why: 'shows its items in a random order', widths: [390, 1440], nearEdit: true }],
  };
  assert.equal(verdictHeadline(v), 'Verified at 390 and 1440 px: the site renders it as designed.');
  assert.equal(beforeWords(v), 'The rest of the page was also compared with the page as it was just before this was made real, at 390 and 1440 px.');
  assert.equal(cutWords(v.cut![0]!), 'At 1440 px the page is 9,412 px tall: compared down to 6,000 px, and nothing below that.');
  assert.equal(heldWords(v), 'The site’s helper held relative dates and random orders still for every render, so they were compared rather than left out.');
  assert.deepEqual(v.masked!.map(maskWords), [
    'Who’s online (block): made for each user, at 390 px.',
    'The core/gallery block: shows its items in a random order, at 390 and 1440 px. It is around an edited element, which was compared in full all the same.',
  ]);
  assert.equal(noiseWords(v), 'Noise floor: up to 0 of 255 in 0 pixels, from rendering the site twice, over what was not left out.');
  // A pass whose step 3 could not compare with the page before does not claim it.
  const unchecked: LayerVerdict = { ...v, before: { ran: false, why: 'No page from before was kept for it.' }, held: null };
  assert.equal(verdictHeadline(unchecked), 'Verified at 390 and 1440 px against the design: the site renders it as designed. It was not compared with the page as it was before.');
  assert.equal(beforeWords(unchecked), 'Not compared with the page as it was before it was made real: No page from before was kept for it.');
  assert.equal(heldWords(unchecked), null);
  // A verdict kept before any of these says none of them.
  const old: LayerVerdict = { at: 1, ok: true, failed: null, widths: [390], noise: { maxDiff: 0, pixels: 0 }, differences: [], pictures: [] };
  assert.deepEqual([beforeWords(old), heldWords(old), noiseWords(old), verdictHeadline(old)], [null, null, 'Noise floor: up to 0 of 255 in 0 pixels, from rendering the site twice.', 'Verified at 390 px: the site renders it as designed.']);
  assert.equal(differenceWords({ kind: 'leak', width: 390, rect: { x: 0, y: 150, width: 64, height: 20 }, pixels: 1280, maxDiff: 90, against: { edit: 'a', at: 1 } }),
    'At 390 px, 1,280 pixels away from every edited element differ from the page as it was before it was made real (with it as designed on it), by up to 90 of 255, in a 64 × 20 box at 0, 150: the change reached further than it should.');
});

test('step 3 element by element, in words: what changed outside the edited elements, and where else the saved words show', () => {
  const against = { edit: 'a', at: 1 };
  assert.deepEqual([
    differenceWords({ kind: 'outside', width: 390, element: 'p.lead', property: 'color', before: 'rgb(0, 0, 0)', result: 'rgb(0, 0, 255)', against }),
    differenceWords({ kind: 'outside', width: 390, element: 'footer.site', property: 'text', before: '© Acme', result: '© Northwind', against }),
    differenceWords({ kind: 'outside', width: 1440, element: 'div.promo', property: 'element', before: 'not on the page', result: 'on the page', against }),
    differenceWords({ kind: 'outside', width: 1440, element: 'ul.tags', property: 'element', before: 'on the page', result: 'not on the page', against }),
  ], [
    'At 390 px, p.lead, away from the edited elements: color is rgb(0, 0, 255) in the site, rgb(0, 0, 0) on the page as it was before it was made real.',
    'At 390 px, footer.site, away from the edited elements, says “© Northwind” in the site, “© Acme” on the page as it was before it was made real.',
    'At 1440 px, div.promo, away from the edited elements, is in the site but was not on the page as it was before it was made real.',
    'At 1440 px, ul.tags, away from the edited elements, is not in the site but was on the page as it was before it was made real.',
  ]);
  assert.equal(alsoChangedWords({ edit: 'a', count: 1, places: ['span.crumb'] }), 'The same words also changed in one other place on the page, where the site shows the same stored value: span.crumb.');
  assert.equal(alsoChangedWords({ edit: 'a', count: 12, places: ['span.crumb', 'a.teaser', 'a.menu-link'] }),
    'The same words also changed in 12 other places on the page, where the site shows the same stored value: span.crumb, a.teaser and a.menu-link and 9 more.');
});
