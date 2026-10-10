// The design layer as the window reads it: the tray's groups, an edit's reach and its before → after, what undo and
// redo would do, and a verification in words. Made-up site (acme); nothing real.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saveTarget, wordsTarget } from '../../../main/live-layer.ts';
import type { LayerApplied, LayerEdit, LayerImplemented, LayerSnapshot, LayerVerdict } from '../../../shared/design-layer.ts';
import type { LiveEdit } from '../../../shared/live.ts';
import type { EditTarget, LiveTrace, PartIdentity } from '../../../shared/live-trace.ts';
import {
  NOTHING_HOLDS, alsoChangedWords, beforeWords, byPage, cardDetail, cardLines, cardState, cardVerdict, cardsOf, changeLines, cutWords, differenceWords, draftsOf, elementWords, failedWords, fragileOf, heldInLayer,
  heldWords, isFragile, layerNoteLines, madeOn, maskWords, noiseWords, orphanWhy, ownTemplate, pagePath, placesOf, reachWords, redoLabel, sameTarget,
  sendsTyped, stateDetail, templateOf, templateOffered, templateSaveRefused, thisReach, undoLabel, verdictHeadline,
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
  assert.equal(draftsOf({ projectId: 'p', edits: [a, edit({ state: 'implemented' }), c], undo: null, redo: null }), 1, 'a and c are one element of one page: one card');
  assert.equal(draftsOf({ projectId: 'p', edits: [a, b, c], undo: null, redo: null }), 2, 'cards, not edits');
});

test('what an edit reaches is said in words, a kind in the main process’s own words', () => {
  assert.equal(reachWords(edit(), trace, null), 'this element');
  const kind = edit({ id: 'k', scope: 'kind' });
  assert.equal(reachWords(kind, trace, null), 'every Card component');
  assert.equal(reachWords(kind, trace, applied({ shown: [{ id: 'k', elements: 4 }] })), 'every Card component (4 elements on this page)');
  assert.equal(reachWords(kind, trace, applied({ shown: [{ id: 'k', elements: 4 }], off: true })), 'every Card component', 'switched off, nothing is shown');
  // Without the trace, the identity's own names.
  assert.equal(reachWords(kind, null, null), 'every acme:card component');
  assert.equal(reachWords(edit({ scope: 'site', change: { type: 'token', name: '--accent', value: '#c0392b' } }), trace, null), 'the whole site');
  // A Drupal block's kind, in the tray as the Inspector said it when the edit was made (the review found three that differed).
  const block = (type: string, plugin: string): PartIdentity => ({ kind: 'config', type, id: 'acme_x', plugin });
  const blocks: [PartIdentity, string][] = [
    [block('block', 'system_menu_block:main'), 'every main menu block placed in a region'],
    [block('layout_builder_component', 'inline_block:card'), 'every card inline block placed in a layout'],
    [block('block', 'block_content:0a1b2c3d-0000-4000-8000-0000000000e5'), 'this reusable block wherever it is placed in a region'],
  ];
  for (const [part, words] of blocks) {
    assert.equal(reachWords(edit({ id: 'b', scope: 'kind', target: { part, inner: null, selector: null, textHash: null } }), null, null), words);
  }
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

test('fragile is decided as the main process decides it and said as it behaves; an orphaned edit says why', () => {
  const loose = (textHash: string | null) => edit({ target: { part: null, inner: null, selector: 'html > body > div:nth-of-type(2)', textHash } });
  assert.match(fragileOf(loose(null)) ?? '', /lands on whatever is in that place now/, 'no words: nothing guards it');
  assert.match(fragileOf(loose('0123456789abcdef')) ?? '', /set aside as orphaned rather than put on something else/, 'its words guard it');
  assert.ok(!isFragile(edit()));
  assert.ok(!isFragile(edit({ scope: 'site', target: { part: null, inner: null, selector: null, textHash: null }, change: { type: 'token', name: '--accent', value: 'red' } })), 'a token has no element');
  // A WordPress block is named by its place in the stored markup: with no words to check, it is fragile for one element.
  const block: PartIdentity = { kind: 'block', store: 'tpl:acme//single', path: [2], name: 'core/group' };
  assert.match(fragileOf(edit({ target: { part: block, inner: null, selector: null, textHash: null } })) ?? '', /named by its place in the stored markup/);
  assert.ok(!isFragile(edit({ target: { part: block, inner: null, selector: null, textHash: '0123456789abcdef' } })), 'its words guard it');
  assert.ok(!isFragile(edit({ scope: 'kind', target: { part: block, inner: null, selector: null, textHash: null } })), 'every one of its kind is reached by name, not place');
  const lost = edit({ id: 'lost', state: 'orphaned' });
  assert.equal(orphanWhy(lost, applied({ orphaned: [{ id: 'lost', why: 'Its element shows other words now.' }] })), 'Its element shows other words now.');
  assert.equal(orphanWhy(lost, applied()), 'Its element was not found on this page.');
  assert.match(orphanWhy(lost, applied({ page: '/about' })), /not found on \/events the last time that page was shown/);
});

test('undo and redo say what they would do', () => {
  const snap = (undo: LayerSnapshot['undo'], redo: LayerSnapshot['redo']): LayerSnapshot => ({ projectId: 'p', edits: [], undo, redo });
  assert.equal(undoLabel(snap(null, null)), 'Nothing to undo');
  // Edits listed and nothing to undo: the core blocked it, because the newest add is an edit in the site.
  assert.equal(undoLabel({ ...snap(null, null), edits: [edit({ state: 'implemented' })] }), 'Nothing to undo: the newest edit is in the site');
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
  assert.equal(failedWords(failed), 'Step 1 of 3, the styles and boxes of the edited elements failed; the steps after it were not judged.');
  assert.deepEqual(failed.differences.map(differenceWords), [
    'At 1440 px, h3.card__title: color is rgb(20, 20, 20) in the site, rgb(192, 57, 43) in the design.',
    'At 390 px, h3.card__title’s box is 300 × 40 at 24, 910 in the site, 300 × 48 at 24, 910 in the design.',
  ]);
  assert.equal(noiseWords(failed), 'Noise floor: up to 3 of 255 in 12 pixels, the most the page with the layer or without it differed from itself when rendered twice, at any width.');
  // What could not be compared is said as that, not as a property with a value.
  const style = { kind: 'style', edit: 'a', width: 1440, element: 'Heading in Card (component)' } as const;
  assert.equal(differenceWords({ ...style, property: 'element', design: 'not found on the page', result: 'on the page' }),
    'At 1440 px, Heading in Card (component): in the design, not found on the page; in the site, on the page.');
  assert.equal(differenceWords({ ...style, property: 'element', design: 'its element was not there when the page was measured', result: 'its element was not there when the page was measured' }),
    'At 1440 px, Heading in Card (component): its element was not there when the page was measured, in the design and in the site.');
  assert.equal(differenceWords({ ...style, element: 'The page', property: 'compared', design: 'down to 6,000 px', result: 'not below that: the page is 9,000 px tall, and nothing under 6,000 px was compared' }),
    'At 1440 px, the page was compared down to 6,000 px, not below that: the page is 9,000 px tall, and nothing under 6,000 px was compared.');
  assert.equal(differenceWords({ ...style, property: 'breakpoint', design: 'only at the theme’s “md” breakpoint', result: 'not verifiable yet' }),
    'At 1440 px, Heading in Card (component) (only at the theme’s “md” breakpoint) is not verifiable yet.');
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
  // On Drupal main says what writes words nothing holds (writtenIn), and none of its answers offers a template: words a
  // template writes go to an agent (a template is code), words printed through t() and words code makes are refused.
  for (const answer of [
    { ok: false, id: words.id, route: 'agent', why: 'These words are written in themes/custom/acme/templates/node.html.twig, a template: a template is code, so Drupal keeps no such thing to change in the site. An agent can change the template from a brief (a copy of it in your theme, when the template is not yours).' },
    none('These words are printed by themes/custom/acme/templates/node.html.twig through Drupal’s interface translation (t()): Wanigan does not change an interface translation yet, and a change there reaches every page that prints the same words. Change them under Interface translation, or in the template.'),
    none('Nothing this page offers to edit holds exactly these words, and Wanigan finds them written in no template around them: code makes them (a formatter, a module or the theme) from something Wanigan does not save from here yet.'),
  ] as LayerImplemented[]) {
    assert.ok(!templateOffered(words, answer), `not on Drupal: ${answer.ok ? '' : answer.why}`);
  }
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

test('Enter sends retyped words once: not again while it is held, not when an input method confirms a word, not with a modifier', () => {
  const key = { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, repeat: false, isComposing: false };
  assert.ok(sendsTyped(key));
  assert.ok(!sendsTyped({ ...key, repeat: true }), 'held: the first press sent it');
  assert.ok(!sendsTyped({ ...key, isComposing: true }), 'an input method’s Enter confirms its word');
  assert.ok(!sendsTyped({ ...key, shiftKey: true }), 'Shift+Enter is a new line');
  assert.ok(!sendsTyped({ ...key, metaKey: true }));
  assert.ok(!sendsTyped({ ...key, key: 'a' }));
});

test('an edit for one element shown in more than one place says so, as the layer reaches and saving saves each', () => {
  const twice: LiveTrace = { ...trace, parts: [...trace.parts, { id: 'p3', kind: 'component', label: 'Card', identity: card(0) }] };
  assert.equal(placesOf(card(0), twice), 2);
  assert.equal(placesOf(card(0), trace), 1);
  assert.equal(placesOf(null, twice), 1, 'markup no part names: one element');
  assert.equal(thisReach(1), 'this element');
  assert.equal(thisReach(2), 'this item, shown twice on this page');
  assert.equal(thisReach(3), 'this item, shown 3 times on this page');
  const one = edit({ id: 'o' });
  assert.equal(reachWords(one, twice, applied({ shown: [{ id: 'o', elements: 2 }] })), 'this item, shown twice on this page');
  assert.equal(reachWords(one, twice, applied({ shown: [{ id: 'o', elements: 1 }] })), 'this element');
  assert.equal(reachWords(one, twice, applied({ shown: [{ id: 'o', elements: 2 }], off: true })), 'this element', 'switched off, nothing is shown');
  assert.equal(reachWords(edit({ id: 's', target: { part: null, inner: null, selector: 'html > body > h3', textHash: null } }), null, applied({ shown: [{ id: 's', elements: 2 }] })),
    'this element (2 matches on this page)');
});

test('one card per element: every edit made on it together, however many, its changes at their last value', () => {
  const title = { part: { kind: 'entity', type: 'node', id: 'u-1', bundle: 'article', langcode: 'en', field: 'title' }, inner: null, selector: null, textHash: 'abc' } as LayerEdit['target'];
  const words = edit({ id: 'w', target: title, change: { type: 'text', value: 'New' }, before: { text: 'Old' }, state: 'implemented' });
  const size = edit({ id: 's1', target: title, change: { type: 'style', values: { 'font-size': '40px' } }, before: { 'font-size': '32px' } });
  const colour = edit({ id: 's2', target: title, change: { type: 'style', values: { color: 'red', 'font-size': '48px' } }, before: { color: 'black', 'font-size': '40px' } });
  const other = edit({ id: 'o' });
  const cards = cardsOf([words, other, size, colour]);
  assert.deepEqual(cards.map((c) => c.map((e) => e.id)), [['w', 's1', 's2'], ['o']], 'the title is one card, in the order it was first edited');
  assert.deepEqual(cardLines(cards[0]!), [
    { what: 'Words', before: 'Old', after: 'New' }, { what: 'font-size', before: '32px', after: '48px' }, { what: 'color', before: 'black', after: 'red' },
  ], 'a value changed twice: as it was first, and as it is last');
  assert.equal(cardState(cards[0]!), 'draft', 'a draft holds the card back');
  assert.equal(cardDetail(cards[0]!), 'The words: in the site, not verified. The style: draft.');
  assert.equal(cardState([{ state: 'verified' }, { state: 'verified' }]), 'verified');
  assert.equal(cardDetail([words]), 'Made in the site. Verify compares the site with the design.', 'one edit says what its state means');
  const older = { at: 1 } as LayerVerdict, newer = { at: 2 } as LayerVerdict;
  assert.equal(cardVerdict([{ verdict: older }, { verdict: null }, { verdict: newer }]), newer);
});

test('a state says what it means, and a style draft says an agent puts it in the theme and Verify finds it there', () => {
  assert.match(stateDetail(edit({ change: { type: 'text', value: 'New' }, before: { text: 'Old' } })), /the site does not have it/);
  assert.match(stateDetail(edit()), /hands it to an agent to put in the theme; once it is there, Verify finds it in the site/, 'a style: an agent may have made it');
  assert.doesNotMatch(stateDetail(edit()), /the site does not have it/);
  assert.match(stateDetail(edit({ scope: 'site', change: { type: 'token', name: '--accent', value: 'red' } })), /Verify finds it in the site/);
  assert.match(stateDetail(edit({ state: 'implemented' })), /Verify compares/);
});

test('a brief to an agent names the edit’s element as the site stores it, and says when no picture of it is attached', () => {
  assert.equal(elementWords(edit()), 'Heading in Card (component): component acme:card, number 1 of its name there, at `h3:nth-of-type(1)` inside it');
  assert.equal(elementWords(edit({ label: 'Title', target: { part: { kind: 'entity', type: 'node', id: 'u-1', bundle: 'article', langcode: 'fr', field: 'title' }, inner: null, selector: null, textHash: null } })),
    'Title: node u-1 (article), field title, in fr');
  assert.equal(elementWords(edit({ label: 'Box (no part names it)', target: { part: null, inner: null, selector: 'html > body > div:nth-of-type(2)', textHash: null } })),
    'Box (no part names it): `html > body > div:nth-of-type(2)` in the page (no part of the site names it)');
  const note = { label: 'Heading in Card (component)', reach: 'this element', element: 'Heading in Card (component): component acme:card', noPicture: 'it was made on /events, and the live view shows /about' };
  assert.deepEqual(layerNoteLines(note, false), [
    '   An edit in Wanigan’s design layer, shown on the page but not in the site yet: Heading in Card (component), for this element.',
    '   Its element: Heading in Card (component): component acme:card.',
    '   No picture of it is attached: it was made on /events, and the live view shows /about.',
  ]);
  assert.equal(layerNoteLines({ ...note, noPicture: null }, true).length, 2, 'pictured: nothing to say');
  // Why making it real handed it to an agent: the template, its line and the child theme the change belongs in.
  const why = 'These words are written in wp-content/themes/acme/header.php, a template of the parent theme “Acme”: code. They are on line 12.';
  assert.equal(layerNoteLines({ ...note, noPicture: null, why }, true)[2], `   Why Wanigan did not make it real itself: ${why}`);
});

test('what a verification says whatever it decided: the page before compared or why not, how far down, what was held, and what was left out', () => {
  const v: LayerVerdict = {
    at: 1, ok: true, failed: null, widths: [390, 1440], noise: { maxDiff: 0, pixels: 0 }, differences: [], pictures: [],
    before: { ran: true, at: 1, widths: [390, 1440] }, held: { at: 1_700_000_000 }, cut: [{ width: 1440, to: 6_000, full: 9_412 }],
    masked: [{ label: 'Who’s online (block)', why: 'made for each user', widths: [390], nearEdit: false }, { label: 'The core/gallery block', why: 'shows its items in a random order', widths: [390, 1440], nearEdit: true }],
  };
  assert.equal(verdictHeadline(v), 'Verified at 390 and 1440 px: the site renders it as designed.');
  assert.equal(beforeWords(v), 'The rest of the page was also compared with the page as it was just before this was made real, at 390 and 1440 px, where up to 10 of 255 is two loads of the same page.');
  assert.equal(cutWords(v.cut![0]!), 'At 1440 px the page is 9,412 px tall: compared down to 6,000 px, and nothing below that.');
  assert.equal(heldWords(v), 'The site’s helper held relative dates and random orders still for every render, so they were compared rather than left out.');
  assert.deepEqual(v.masked!.map(maskWords), [
    'Who’s online (block): made for each user, at 390 px.',
    'The core/gallery block: shows its items in a random order, at 390 and 1440 px. It is around an edited element, which was compared in full all the same.',
  ]);
  assert.equal(noiseWords(v), 'Noise floor: up to 0 of 255 in 0 pixels, the most the page with the layer or without it differed from itself when rendered twice, at any width, over what was not left out.');
  // A pass whose step 3 could not compare with the page before does not claim it.
  const unchecked: LayerVerdict = { ...v, before: { ran: false, why: 'No page from before was kept for it.' }, held: null };
  assert.equal(verdictHeadline(unchecked), 'Verified at 390 and 1440 px against the design: the site renders it as designed. It was not compared with the page as it was before.');
  assert.equal(beforeWords(unchecked), 'Not compared with the page as it was before it was made real: No page from before was kept for it.');
  assert.equal(heldWords(unchecked), null);
  // A verdict kept before any of these says none of them.
  const old: LayerVerdict = { at: 1, ok: true, failed: null, widths: [390], noise: { maxDiff: 0, pixels: 0 }, differences: [], pictures: [] };
  assert.deepEqual([beforeWords(old), heldWords(old), noiseWords(old), verdictHeadline(old)], [null, null, 'Noise floor: up to 0 of 255 in 0 pixels, the most the page with the layer or without it differed from itself when rendered twice, at any width.', 'Verified at 390 px: the site renders it as designed.']);
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
