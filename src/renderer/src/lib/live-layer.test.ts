// The design layer as the window reads it: the tray's groups, an edit's reach and its before → after, what undo and
// redo would do, and a verification in words. Made-up site (acme); nothing real.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { kindWords, saveTarget, wordsTarget } from '../../../main/live-layer.ts';
import type { LayerApplied, LayerEdit, LayerImplemented, LayerSnapshot, LayerVerdict } from '../../../shared/design-layer.ts';
import type { LiveEdit } from '../../../shared/live.ts';
import { kindKey, type EditTarget, type LiveTrace, type PartIdentity, type TracePart } from '../../../shared/live-trace.ts';
import {
  NOTHING_HOLDS, byPage, changeLines, differenceWords, draftsOf, failedWords, heldInLayer, isFragile, kindName, madeOn, noiseWords, orphanWhy, ownTemplate,
  pagePath, reachWords, redoLabel, sameTarget, templateOf, templateOffered, templateSaveRefused, undoLabel, verdictHeadline,
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

test('the template that rendered an element is offered only when nothing the site stores holds its words, and only for a draft keyed to a part', () => {
  // The main process's own answer when nothing holds the words: the one the window offers the template after.
  const teaser: LiveTrace = { ...trace, parts: [{ id: 'p1', kind: 'component', label: 'Card', identity: card(0) }], edits: [] };
  const nothing = wordsTarget(teaser, card(0), 'Read more');
  assert.ok(!nothing.ok && nothing.route === 'none' && nothing.why === NOTHING_HOLDS, 'the sentence is the main process’s, word for word');
  const words = edit({ change: { type: 'text', value: 'Read on' }, before: { text: 'Read more' } });
  const none = (why: string): LayerImplemented => ({ ok: false, id: words.id, route: 'none', why });
  assert.ok(templateOffered(words, none(NOTHING_HOLDS)));
  // Every other refusal means the words are stored, or that Wanigan cannot tell: never a template.
  const two: EditTarget = { id: 'title', kind: 'field', label: 'Title', via: 'schema', schema: { type: 'string' }, value: 'Read more' };
  const twice = wordsTarget({ ...teaser, parts: [{ ...teaser.parts[0]!, edits: ['title', 'other'] }], edits: [two, { ...two, id: 'other', label: 'Other title' }] }, card(0), 'Read more');
  const field = saveTarget(card(0), 'node:12:title:string');
  for (const why of [
    !twice.ok ? twice.why : '', typeof field === 'string' ? field : '', 'The field no longer holds those words: it was changed since the page was shown.',
    'It reaches 2 elements here; words are saved one element at a time.', 'It is in the site already.',
    'Its element is in markup no part of the page’s trace names, so Wanigan cannot tell what holds these words.',
  ]) {
    assert.ok(why && !templateOffered(words, none(why)), `not after: ${why}`);
  }
  assert.ok(!templateOffered(words, { ok: false, id: words.id, route: 'agent', why: NOTHING_HOLDS }), 'formatted text goes to an agent');
  assert.ok(!templateOffered(words, { ok: true, id: words.id, state: 'implemented', revision: null }));
  assert.ok(!templateOffered(words, null));
  assert.ok(!templateOffered({ ...words, state: 'orphaned' }, none(NOTHING_HOLDS)), 'only a draft');
  assert.ok(!templateOffered({ ...words, target: { part: null, inner: null, selector: 'html > body > p', textHash: null } }, none(NOTHING_HOLDS)), 'never for markup no part names');
  assert.ok(!templateOffered(edit(), none(NOTHING_HOLDS)), 'never for a style');
});

test('a template is written only for the edit’s own element, and only the template of that element’s innermost region', () => {
  const at = edit().target;
  assert.ok(sameTarget({ ...at, textHash: 'ffffffffffffffff' }, at), 'its words may differ: the layer shows its new ones');
  assert.ok(!sameTarget({ ...at, part: card(1) }, at), 'another card');
  assert.ok(!sameTarget({ ...at, inner: 'p:nth-of-type(1)' }, at), 'another element in the card');
  assert.ok(!sameTarget({ part: null, inner: null, selector: 'html > body > h3', textHash: null }, at));
  // The footer region holds the copyright block: the block's own template, never the footer's around it.
  const footer = { index: 4, parent: null, file: 'themes/custom/acme/templates/region--footer.html.twig' };
  const block = { index: 9, parent: 4, file: 'themes/custom/acme/templates/block--copyright.html.twig' };
  assert.deepEqual(ownTemplate([block, footer]), { file: block.file });
  assert.deepEqual(ownTemplate([footer, block]), { file: block.file }, 'by nesting, not by order');
  const unnamed = ownTemplate([{ ...block, file: null }, footer]);
  assert.ok('why' in unnamed && /never writes to one around it/.test(unnamed.why), 'a nearest template with no file: none, not the footer');
  assert.ok('why' in ownTemplate([]));
  assert.ok('why' in ownTemplate([block, { ...footer, index: 5 }]), 'two innermost: cannot tell');
});

test('just before a template save the edit is read again: still a draft, and still shown on the page', () => {
  const words = edit({ id: 'w', change: { type: 'text', value: 'Read on' }, before: { text: 'Read more' } });
  const shown = applied({ shown: [{ id: 'w', elements: 1 }] });
  assert.equal(templateSaveRefused(words, shown), null);
  assert.match(templateSaveRefused(undefined, shown) ?? '', /not in the layer now/);
  assert.match(templateSaveRefused({ ...words, state: 'orphaned' }, shown) ?? '', /orphaned now/);
  assert.match(templateSaveRefused({ ...words, state: 'implemented' }, shown) ?? '', /in the site already/);
  assert.match(templateSaveRefused(words, applied()) ?? '', /not shown on the page now/);
  assert.match(templateSaveRefused(words, { ...shown, off: true }) ?? '', /without the layer/);
  assert.match(templateSaveRefused(words, null) ?? '', /without the layer/);
});

test('words a template save wrote are the layer’s while it holds their edit as in the site: no Put back, and the edit says its reach', () => {
  const words = edit({ id: 'w', at: 10, change: { type: 'text', value: 'Read on' }, before: { text: 'Read  more ' }, state: 'implemented' });
  const saved: LiveEdit = { id: 's', projectId: 'p', path: '/acme/web/themes/custom/acme/templates/card.html.twig', line: 12, before: 'Read more', after: 'Read on', createdAt: 11, revertedAt: null, revertable: true };
  const snap = (e: LayerEdit): LayerSnapshot => ({ projectId: 'p', edits: [e], undo: null, redo: null });
  assert.equal(heldInLayer(saved, snap(words))?.id, 'w');
  assert.equal(heldInLayer(saved, snap({ ...words, state: 'verified' }))?.id, 'w');
  assert.equal(heldInLayer(saved, snap({ ...words, state: 'draft' })), null, 'a draft: the layer says nothing of the site');
  assert.equal(heldInLayer(saved, snap({ ...words, change: { type: 'text', value: 'Read again' } })), null, 'other words');
  assert.equal(heldInLayer({ ...saved, createdAt: 9 }, snap(words)), null, 'saved before the edit was made');
  assert.equal(heldInLayer({ ...saved, revertedAt: 20 }, snap(words)), null, 'already put back');
  assert.equal(heldInLayer(saved, null), null);
  assert.equal(templateOf(words, [saved])?.line, 12);
  assert.equal(templateOf(words, [{ ...saved, revertable: false }]), null, 'the file changed since: not said to hold them');
  assert.equal(templateOf({ ...words, state: 'draft' }, [saved]), null);
});
