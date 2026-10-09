import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LiveRegion } from './live.ts';
import { partIndex } from './live-lens.ts';
import { layersOf } from './live-tree.ts';
import { parseTrace, type LiveTrace } from './live-trace.ts';
import {
  announce, arrangeDrop, arrangeSpec, buildSpec, checkInsert, checkMove, checkRemove, collectionOf, moveNotice, movedOrders, removeNotice, requestText, stepMove, targetsFor, undoToken,
} from './live-arrange.ts';

const trace = parseTrace({
  version: 1, platform: 'drupal', id: 'bbbbbbbbbbbbbbbb', url: '/', at: 1, total: { ms: 10 },
  parts: [
    { id: 'side', kind: 'region', label: 'Sidebar' }, { id: 'foot', kind: 'region', label: 'Footer' },
    { id: 'search', kind: 'block', label: 'Search' }, { id: 'menu', kind: 'block', label: 'Menu' }, { id: 'news', kind: 'block', label: 'News' },
    { id: 'hours', kind: 'block', label: 'Hours' },
    { id: 'pa', kind: 'entity', label: 'Hero paragraph' }, { id: 'pb', kind: 'entity', label: 'Text paragraph' },
    { id: 'logo', kind: 'template', label: 'Logo' }, { id: 'name', kind: 'template', label: 'Site name' },
  ],
  palette: [{ id: 'pal-cta', kind: 'block', label: 'Call to action', by: 'acme' }],
  collections: [
    { id: 'c-side', kind: 'region-blocks', label: 'Sidebar blocks', part: 'side', items: ['search', 'menu', 'news'], movesTo: ['c-foot', 'c-locked'], inserts: ['pal-cta'], changes: 'configuration', reach: 41 },
    { id: 'c-foot', kind: 'region-blocks', label: 'Footer blocks', part: 'foot', items: ['hours'], movesTo: ['c-side'], changes: 'configuration' },
    { id: 'c-locked', kind: 'region-blocks', label: 'Header blocks', items: [], changes: 'configuration', why: 'The header is fixed by the theme.' },
    { id: 'c-paras', kind: 'field-items', label: 'Paragraphs on Article 12', items: ['pa', 'pb'], changes: 'content', revisions: true },
  ],
}) as LiveTrace;

test('where an item may go: its own collection first, then the ones it may move to that take items', () => {
  assert.equal(collectionOf(trace, 'menu')?.id, 'c-side');
  assert.deepEqual(targetsFor(trace, 'c-side').map((c) => c.id), ['c-side', 'c-foot'], 'a refused collection is not a target');
  assert.deepEqual(targetsFor(trace, 'c-locked'), [], 'a refused collection moves nothing');
});

test('a move is checked against the trace before it is posted', () => {
  assert.deepEqual(checkMove(trace, { collection: 'c-side', item: 'news', to: { collection: 'c-side', index: 0 } }), { collection: 'c-side', item: 'news', to: { collection: 'c-side', index: 0 } });
  assert.equal(typeof checkMove(trace, { collection: 'c-side', item: 'news', to: { collection: 'c-side', index: 3 } }), 'string', 'past the end of its own collection');
  assert.equal(typeof checkMove(trace, { collection: 'c-side', item: 'news', to: { collection: 'c-foot', index: 1 } }), 'object', 'after the last of another');
  assert.equal(checkMove(trace, { collection: 'c-side', item: 'news', to: { collection: 'c-side', index: 2 } }), 'That is where it already is.');
  assert.equal(checkMove(trace, { collection: 'c-side', item: 'news', to: { collection: 'c-paras', index: 0 } }), 'Sidebar blocks cannot move items there.');
  assert.equal(checkMove(trace, { collection: 'c-side', item: 'hours', to: { collection: 'c-side', index: 0 } }), 'This page’s trace has no such item to move. Reload it, then try again.');
  assert.equal(checkMove(null, {}), 'There is no trace for this page yet. Reload it, then try again.');
  assert.equal(checkMove(trace, { collection: 'c-side', item: 'news', to: { collection: 'c-side', index: 1.5 } }), 'That is not a move.');
});

test('an insert is checked: a palette entry the place takes, at a place in it', () => {
  assert.deepEqual(checkInsert(trace, { collection: 'c-side', index: 3, entry: 'pal-cta' }), { collection: 'c-side', index: 3, entry: 'pal-cta' });
  assert.equal(checkInsert(trace, { collection: 'c-foot', index: 0, entry: 'pal-cta' }), 'Footer blocks does not take that.');
  assert.equal(checkInsert(trace, { collection: 'c-side', index: 4, entry: 'pal-cta' }), 'That place is not in the collection.');
  assert.equal(checkInsert(trace, { collection: 'c-locked', index: 0, entry: 'pal-cta' }), 'The header is fixed by the theme.');
});

test('the orders a move makes', () => {
  const same = movedOrders(trace, { collection: 'c-side', item: 'news', to: { collection: 'c-side', index: 0 } });
  assert.deepEqual(same.get('c-side'), ['news', 'search', 'menu']);
  const across = movedOrders(trace, { collection: 'c-side', item: 'search', to: { collection: 'c-foot', index: 1 } });
  assert.deepEqual([across.get('c-side'), across.get('c-foot')], [['menu', 'news'], ['hours', 'search']]);
});

test('the keyboard: Alt+arrows step within a collection, Alt+Shift+arrows across, and stop at the ends', () => {
  assert.deepEqual(stepMove(trace, 'menu', { collection: 'c-side', index: 1 }, 'up'), { collection: 'c-side', index: 0 });
  assert.equal(stepMove(trace, 'menu', { collection: 'c-side', index: 0 }, 'up'), null);
  assert.deepEqual(stepMove(trace, 'menu', { collection: 'c-side', index: 1 }, 'down'), { collection: 'c-side', index: 2 });
  assert.equal(stepMove(trace, 'menu', { collection: 'c-side', index: 2 }, 'down'), null);
  assert.deepEqual(stepMove(trace, 'menu', { collection: 'c-side', index: 2 }, 'next'), { collection: 'c-foot', index: 1 }, 'the footer has two places for it');
  assert.deepEqual(stepMove(trace, 'menu', { collection: 'c-foot', index: 1 }, 'down'), null);
  assert.deepEqual(stepMove(trace, 'menu', { collection: 'c-foot', index: 0 }, 'previous'), { collection: 'c-side', index: 0 });
  assert.equal(stepMove(trace, 'menu', { collection: 'c-side', index: 0 }, 'previous'), null);
});

test('what a screen reader hears, and what a move saves', () => {
  assert.equal(announce('Search', 1, 4, 'Sidebar blocks'), 'Search, 2 of 4 in Sidebar blocks');
  const side = trace.collections?.[0];
  assert.equal(moveNotice(side!, 'drupal').confirm, 'This moves the block for every page that shows this region (41 pages). Export configuration (drush config:export) to keep it in code.');
  assert.match(moveNotice({ ...side!, reach: undefined, kind: 'widgets' }, 'wordpress').confirm ?? '', /^This moves the widget on every page that shows this area\. It is saved in the database/);
  assert.deepEqual(moveNotice(trace.collections![3]!, 'drupal'), { confirm: null, saved: 'Saved as a new revision.' });
});

test('the page is given only plain, bounded values, and only well-formed drops come back', () => {
  assert.equal(arrangeSpec({ collections: 'x', groups: [] }), null);
  const spec = arrangeSpec({
    collections: [{ id: 'c', label: 'L', container: 3, items: [{ part: 'a', region: 4, label: 'A' }, { part: '', region: 5 }, { part: 'b', region: -1, label: 'B' }], targets: ['c', 7], inserts: [], why: null }],
    groups: [[{ region: 1, label: 'x' }], [{ region: 1, label: 'x' }, { region: 2, label: 'y' }, { region: 'z' }]],
    placing: { entry: 'pal', label: 'P', extra: () => 1 },
  });
  assert.deepEqual(spec, {
    collections: [{ id: 'c', label: 'L', container: 3, items: [{ part: 'a', region: 4, label: 'A' }, { part: 'b', region: null, label: 'B' }], targets: ['c'], inserts: [], why: null }],
    groups: [[{ region: 1, label: 'x' }, { region: 2, label: 'y' }]],
    placing: { entry: 'pal', label: 'P' },
  });
  assert.deepEqual(arrangeDrop({ kind: 'move', move: { collection: 'c', item: 'a', to: { collection: 'c', index: 2 } } })?.kind, 'move');
  assert.equal(arrangeDrop({ kind: 'move', move: { collection: 'c', item: 'a', to: { collection: 'c', index: -1 } } }), null);
  assert.deepEqual(arrangeDrop({ kind: 'request', region: 3, ref: 4, place: 'after' }), { kind: 'request', region: 3, ref: 4, place: 'after' });
  assert.equal(arrangeDrop({ kind: 'request', region: 3, ref: 4, place: 'inside' }), null);
  assert.equal(undoToken('u-12:ab.c'), 'u-12:ab.c');
  assert.equal(undoToken('../../x'), null);
});

const region = (index: number, over: Partial<LiveRegion>): LiveRegion => ({
  index, file: null, entity: null, block: null, view: null, element: null, component: null, piece: null, hook: null, field: null,
  suggestions: [], parent: null, order: index, rect: { x: 0, y: index * 50, width: 300, height: 40 }, part: null, ...over,
});

test('the spec: collections with the regions that show their items, and template-ordered siblings as requests', () => {
  const regions = [
    region(0, { hook: 'region', suggestions: ['region--sidebar'], part: 'side', rect: { x: 0, y: 0, width: 300, height: 200 } }),
    region(1, { block: 'search_form_block@search', part: 'search', parent: 0 }),
    region(2, { block: 'system_menu_block@main', part: 'menu', parent: 0 }),
    region(3, { hook: 'region', suggestions: ['region--header'], rect: { x: 400, y: 0, width: 300, height: 100 } }),
    region(4, { file: 'themes/custom/acme/templates/logo.html.twig', part: 'logo', parent: 3 }),
    region(5, { file: 'themes/custom/acme/templates/site-name.html.twig', part: 'name', parent: 3 }),
  ];
  const parts = partIndex(regions, trace);
  const spec = buildSpec(trace, parts, layersOf(regions), trace.palette?.[0] ?? null);
  const side = spec.collections.find((c) => c.id === 'c-side');
  assert.deepEqual(side?.items, [{ part: 'search', region: 1, label: 'Search' }, { part: 'menu', region: 2, label: 'Menu' }, { part: 'news', region: null, label: 'News' }]);
  assert.equal(side?.container, 0);
  assert.deepEqual(side?.targets, ['c-side', 'c-foot']);
  assert.deepEqual(spec.groups.map((g) => g.map((m) => m.region)), [[0, 3], [4, 5]], 'items in a collection are never a request');
  assert.deepEqual(spec.placing, { entry: 'pal-cta', label: 'Call to action' });
  assert.equal(requestText('Logo', 'Site name', 'after', false), 'Move Logo after Site name. Its order is written in the template, not in a collection the site can reorder, so change it there. The pictures show the page now and the order wanted.');
});

test('a removal is checked: an item the page shows, of a collection the helper says takes items out', () => {
  const t = parseTrace({
    version: 1, platform: 'drupal', id: 'cccccccccccccccc', url: '/', at: 1, total: { ms: 10 },
    parts: [{ id: 'search', kind: 'block', label: 'Search' }, { id: 'pa', kind: 'entity', label: 'Hero paragraph' }, { id: 'hours', kind: 'block', label: 'Hours' }],
    collections: [
      { id: 'c-side', kind: 'region-blocks', label: 'Sidebar blocks', items: ['search'], changes: 'configuration', removes: true, shows: 'every page shown in the Acme theme that its visibility settings allow' },
      { id: 'c-paras', kind: 'field-items', label: 'Paragraphs on Article 12', items: ['pa'], changes: 'content', revisions: true, removes: true },
      { id: 'c-foot', kind: 'region-blocks', label: 'Footer blocks', items: ['hours'], changes: 'configuration', removes: true, removeWhy: 'The user you are logged in as may not change where blocks are placed.' },
      { id: 'c-old', kind: 'menu', label: 'Main menu', items: [], changes: 'configuration' },
    ],
  }) as LiveTrace;
  assert.deepEqual(checkRemove(t, { collection: 'c-side', item: 'search' }), { collection: 'c-side', item: 'search' });
  assert.equal(checkRemove(t, { collection: 'c-side', item: 'pa' }), 'This page’s trace has no such item to take out. Reload it, then try again.');
  assert.equal(checkRemove(t, { collection: 'c-foot', item: 'hours' }), 'The user you are logged in as may not change where blocks are placed.', 'its own reason, said as it is');
  assert.equal(t.collections?.find((c) => c.id === 'c-foot')?.removes, false, 'a reason means nothing is taken out, whatever else it says');
  assert.match(checkRemove(t, { collection: 'c-old', item: 'x' }) as string, /no such item/);
  assert.equal(checkRemove(t, { collection: 'c-side' }), 'That is not a removal.');
  assert.equal(checkRemove(null, {}), 'There is no trace for this page yet. Reload it, then try again.');
  // A helper older than version 4 says nothing of removing: asked to update, never guessed at.
  const old = parseTrace({ version: 1, platform: 'wordpress', id: 'dddddddddddddddd', url: '/', at: 1, total: { ms: 1 }, parts: [{ id: 'b', kind: 'block', label: 'B' }], collections: [{ id: 'c', kind: 'post-blocks', label: 'Blocks of page “Home”', items: ['b'], changes: 'content' }] }) as LiveTrace;
  assert.match(checkRemove(old, { collection: 'c', item: 'b' }) as string, /does not take items out of Blocks of page “Home”\. Update the helper/);
});

test('what a removal says first and after: configuration asks with where it shows, and both say what stays', () => {
  const drupal = removeNotice({ id: 'c-side', kind: 'region-blocks', label: 'Sidebar blocks', items: [], changes: 'configuration', shows: 'every page shown in the Acme theme that its visibility settings allow' }, 'drupal');
  assert.equal(drupal.confirm, 'This takes the block off every page that shows this region (every page shown in the Acme theme that its visibility settings allow). The placement is switched off, not deleted, and stays in Block layout; a custom block’s content stays in the block library. Export configuration (drush config:export) to keep it in code.');
  assert.match(drupal.saved, /^Taken out of the site’s configuration\. The placement is switched off/);
  const counted = removeNotice({ id: 'c-l', kind: 'layout', label: 'Content', items: [], changes: 'configuration', reach: 12, shows: 'ignored when pages are counted' }, 'drupal');
  assert.match(counted.confirm!, /^This takes the block out of the layout for every page that uses it \(12 pages\)\. Only the component goes/);
  const post = removeNotice({ id: 'c-p', kind: 'post-blocks', label: 'Blocks of page', items: [], changes: 'content', revisions: true }, 'wordpress');
  assert.deepEqual(post, { confirm: null, saved: 'Taken out, as a new revision. Only the block goes from the markup: media, reusable blocks and posts it showed stay.' });
  const menu = removeNotice({ id: 'c-m', kind: 'menu', label: 'Primary', items: [], changes: 'configuration', shows: 'everywhere Primary shows' }, 'wordpress');
  assert.match(menu.confirm!, /\(everywhere Primary shows\)\. The menu item is deleted; the page it linked to stays\. It is saved in the database/);
  assert.match(removeNotice({ id: 'c-w', kind: 'widgets', label: 'Sidebar', items: [], changes: 'configuration' }, 'wordpress').confirm!, /goes to Inactive widgets, with its settings/);
});
