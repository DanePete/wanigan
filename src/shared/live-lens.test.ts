import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LiveRegion } from './live.ts';
import { nameOf } from './live-names.ts';
import { layersOf } from './live-tree.ts';
import { lensView, paintItems, partFor, partIndex, partQueries, placeSheet, queriesByCaller, slowest, traceNote, truncatedNote } from './live-lens.ts';
import { parseTrace, type LiveTrace } from './live-trace.ts';

const region = (index: number, over: Partial<LiveRegion> = {}): LiveRegion => ({
  index, file: null, entity: null, block: null, view: null, element: null, component: null, piece: null, hook: null, field: null,
  suggestions: [], parent: null, order: index, rect: { x: 0, y: index * 100, width: 400, height: 80 }, part: null, ...over,
});

const trace = parseTrace({
  version: 1, platform: 'drupal', id: 'aaaaaaaaaaaaaaaa', url: '/node/12', at: 1, total: { ms: 240, queries: 60 },
  parts: [
    { id: 'p-page', kind: 'template', label: 'Page', source: { file: 'core/modules/system/templates/page.html.twig', owner: 'core' } },
    { id: 'p-hero', kind: 'component', label: 'Hero', source: { file: 'web/themes/custom/acme/components/hero/hero.twig', owner: 'yours', package: 'acme' },
      cache: { tags: ['node:12'], contexts: [], maxAge: 'permanent' }, cost: { ms: 62, queries: 4 }, edits: ['e-title', 'e-props'] },
    { id: 'p-menu', kind: 'menu', label: 'Main menu', source: { file: 'web/modules/contrib/menu_block/templates/menu.html.twig', owner: 'contrib' },
      cache: { tags: [], contexts: ['url'], maxAge: 300 }, cost: { ms: 12, queries: 1 }, edits: ['e-link'] },
    { id: 'p-cart', kind: 'block', label: 'Cart', source: { file: 'web/modules/custom/acme_cart/templates/cart.html.twig', owner: 'yours' },
      cache: { tags: [], contexts: ['session'], maxAge: 0, status: 'placeholder' }, cost: { ms: 3 }, edits: ['e-cart'] },
    { id: 'p-stock', kind: 'field', label: 'Stock', cache: { tags: [], contexts: [], maxAge: 0 }, cost: { ms: 1, queries: 22 } },
    { id: 'p-orphan', kind: 'widget', label: 'Opening hours' },
  ],
  edits: [
    { id: 'e-title', kind: 'field', label: 'Title (node 12)', via: 'native-form' },
    { id: 'e-props', kind: 'props', label: 'Hero props', via: 'schema', schema: { type: 'object', properties: { heading: { type: 'string' } } }, value: { heading: 'Hi' } },
    { id: 'e-link', kind: 'menu-link', label: 'Main menu links', via: 'native-form', why: 'Menu links are edited in the menu, not here.' },
    { id: 'e-cart', kind: 'template-override', label: 'Override cart.html.twig', via: 'native-form' },
  ],
  queries: [
    { sql: 'SELECT 1', ms: 2, part: 'p-hero', caller: { file: 'web/modules/custom/acme_cart/src/Cart.php', line: 10, owner: 'yours' } },
    { sql: 'SELECT 2', ms: 9, part: 'p-hero', caller: { file: 'web/modules/custom/acme_cart/src/Cart.php', line: 10, owner: 'yours' } },
    { sql: 'SELECT 3', ms: 4, part: 'p-menu' },
  ],
}) as LiveTrace;

const regions: LiveRegion[] = [
  region(0, { hook: 'page', file: 'core/modules/system/templates/page.html.twig', part: 'p-page', rect: { x: 0, y: 0, width: 1200, height: 2000 } }),
  region(1, { component: 'acme:hero', part: 'p-hero', parent: 0 }),
  region(2, { hook: 'menu__main', file: 'modules/contrib/menu_block/templates/menu.html.twig', part: 'p-menu', parent: 0 }),
  region(3, { hook: 'block', file: 'modules/custom/acme_cart/templates/cart.html.twig', part: 'p-cart', parent: 0 }),
  region(4, { hook: 'field', file: 'themes/custom/acme/templates/field.html.twig', part: 'p-stock', parent: 0 }),
  region(5, { part: 'p-orphan', parent: 0 }),
  region(6, { hook: 'block', file: 'core/modules/block/templates/block.html.twig', parent: 0 }),
];

test('regions are tied to the trace’s parts by the id the page script read', () => {
  const index = partIndex(regions, trace);
  assert.equal(index.byRegion.get(1)?.label, 'Hero');
  assert.deepEqual(index.regionsOf.get('p-menu'), [2]);
  assert.equal(index.byRegion.has(6), false, 'a region with no part has none');
  assert.equal(partIndex(regions, null).byRegion.size, 0, 'without a trace, nothing is tied');
  // A picked element inside a region with no part of its own gets the nearest part around it, said to be inherited.
  const inner = region(9, { hook: 'image', parent: 1 });
  const found = partFor([inner, regions[1] as LiveRegion, regions[0] as LiveRegion], index);
  assert.equal(found?.part.id, 'p-hero');
  assert.equal(found?.inherited, true);
});

test('a part only the helper names is called by its label, and is never grouped with another', () => {
  const name = nameOf(regions[5] as LiveRegion, null, { label: 'Opening hours', kind: 'widget' });
  assert.equal(name.title, 'Opening hours');
  assert.equal(name.kind, 'Widget · from the trace');
  const two = [region(0, { part: 'x1' }), region(1, { part: 'x2' })];
  const layers = layersOf(two, { partName: (id) => ({ label: id === 'x1' ? 'Hours' : 'Map', kind: 'widget' }) });
  assert.deepEqual(layers.map((l) => l.name.title), ['Hours', 'Map']);
});

test('the Owner lens: yours, contributed, core, from the trace or else the template’s path', () => {
  const owner = lensView('owner', { regions, trace });
  const count = Object.fromEntries(owner.classes.map((c) => [c.id, c.count]));
  // The page itself is a wrapper and is not painted; the stock field has no source in the trace, so its path says yours.
  assert.deepEqual(count, { yours: 3, theme: 0, contrib: 1, core: 1 });
  assert.equal(owner.unknown, 1, 'the part with neither a source nor a template');
  assert.equal(owner.needsTrace, false);
  const plain = lensView('owner', { regions, trace: null });
  assert.deepEqual(plain.classes.find((c) => c.id === 'contrib')?.indexes, [2], 'paths alone still place a template');
});

test('the Cache lens: kept, expiring, never, filled in late', () => {
  const cache = lensView('cache', { regions, trace });
  assert.deepEqual(Object.fromEntries(cache.classes.map((c) => [c.id, c.indexes])), { permanent: [1], 'max-age': [2], uncacheable: [4], placeholder: [3] });
  assert.equal(lensView('cache', { regions, trace: null }).needsTrace, true);
});

test('the Cost lens: heavy and notable are painted with their numbers; light is only counted', () => {
  const cost = lensView('cost', { regions, trace });
  assert.deepEqual(Object.fromEntries(cost.classes.map((c) => [c.id, c.indexes])), { heavy: [1, 4], notable: [2], light: [3] });
  assert.deepEqual(cost.paint.map((p) => [p.index, p.label]), [[1, '62 ms · 4 queries'], [2, '12 ms · 1 query'], [4, '1 ms · 22 queries']]);
});

test('the Editable lens: content, settings, a template override, and what is refused here', () => {
  const editable = lensView('editable', { regions, trace });
  assert.deepEqual(Object.fromEntries(editable.classes.map((c) => [c.id, c.indexes])), { content: [1], settings: [], template: [3], refused: [2] });
  assert.equal(editable.paint.find((p) => p.index === 2)?.cls, 'refused');
});

test('the Changed lens: an agent’s edit by region, a hand save by target id or label', () => {
  const changed = lensView('changed', { regions, trace, changed: new Set([6]), saved: { ids: new Set(['e-cart']), labels: new Set() } });
  assert.deepEqual(Object.fromEntries(changed.classes.map((c) => [c.id, c.indexes])), { edited: [6], saved: [3] });
  const byLabel = lensView('changed', { regions, trace, saved: { ids: new Set(), labels: new Set(['Title (node 12)']) } });
  assert.deepEqual(byLabel.classes.find((c) => c.id === 'saved')?.indexes, [1], 'a new render may give the target a new id');
  const moved = lensView('changed', { regions, trace, saved: { ids: new Set(), labels: new Set(), parts: new Set(['Main menu']) } });
  assert.deepEqual(moved.classes.find((c) => c.id === 'saved')?.indexes, [2], 'a part moved by hand');
  assert.deepEqual(lensView('structure', { regions, trace }).paint, []);
});

test('a part’s queries come slowest first, and the request’s group by caller', () => {
  assert.deepEqual(partQueries(trace, 'p-hero').map((q) => q.sql), ['SELECT 2', 'SELECT 1']);
  const groups = queriesByCaller(trace.queries ?? []);
  assert.deepEqual(groups.map((g) => [g.caller, g.ms]), [['web/modules/custom/acme_cart/src/Cart.php:10', 11], ['Caller not reported', 4]]);
  assert.deepEqual([...slowest([{ ms: 1 }, { ms: 9 }, {}, { ms: 4 }], 2)].sort(), [1, 3]);
});

test('painting accepts only what it can draw', () => {
  const items = paintItems([
    { index: 1, color: '#86cfc3', fill: 0.9, label: 'x'.repeat(200) },
    { index: -1, color: '#000000' },
    { index: 2, color: 'red' },
    { index: 3, color: '#123456', dashed: true },
    'nonsense',
  ]);
  assert.deepEqual(items.map((p) => [p.index, p.fill, p.label?.length ?? null, p.dashed]), [[1, 0.4, 120, false], [3, 0, null, true]]);
  assert.deepEqual(paintItems('not a list'), []);
});

test('what the owner is told when there is no trace, and the one next step', () => {
  const helper = { outdated: false };
  assert.equal(traceNote({ state: 'ok', trace }, helper, 'drupal'), null);
  assert.equal(traceNote(null, null, 'drupal')?.next, 'install-helper');
  assert.equal(traceNote({ state: 'missing' }, { outdated: true }, 'drupal')?.title, 'Update the helper to see this');
  assert.equal(traceNote({ state: 'missing' }, helper, 'wordpress')?.next, 'reload');
  assert.equal(traceNote({ state: 'expired' }, helper, 'drupal')?.next, 'reload');
  assert.equal(traceNote({ state: 'down', error: 'connection refused' }, helper, 'drupal')?.next, 'start-site');
  assert.equal(traceNote({ state: 'refused', status: 403 }, helper, 'drupal')?.next, 'log-in');
  assert.equal(traceNote({ state: 'unreadable', version: 2 }, helper, 'drupal')?.next, 'update-wanigan');
  assert.equal(traceNote({ state: 'unreadable', version: null }, helper, 'drupal')?.next, 'update-helper');
  assert.equal(traceNote(null, null, 'site')?.next, null, 'a plain site has no helper to offer');
  const cut = parseTrace({ ...trace, truncated: ['hooks', 'chain:p-hero'] }) as LiveTrace;
  assert.match(truncatedNote(cut) ?? '', /hooks, a part’s hooks/);
});

test('an edit sheet sits beside its part, inside the stage', () => {
  const area = { x: 0, y: 0, width: 1000, height: 700 };
  const size = { width: 400, height: 300 };
  assert.deepEqual(placeSheet({ x: 100, y: 100, width: 200, height: 50 }, area, size), { x: 312, y: 100, width: 400, height: 300 }, 'to the right');
  assert.deepEqual(placeSheet({ x: 600, y: 100, width: 300, height: 50 }, area, size), { x: 188, y: 100, width: 400, height: 300 }, 'to the left');
  assert.deepEqual(placeSheet({ x: 50, y: 50, width: 900, height: 100 }, area, size), { x: 50, y: 162, width: 400, height: 300 }, 'below');
  assert.deepEqual(placeSheet({ x: 0, y: 600, width: 1000, height: 50 }, area, size), { x: 0 + 12, y: 288, width: 400, height: 300 }, 'above');
  assert.deepEqual(placeSheet(null, area, size), { x: 588, y: 12, width: 400, height: 300 }, 'no part on screen: the corner');
  assert.deepEqual(placeSheet({ x: 0, y: 650, width: 100, height: 20 }, area, size).y, 388, 'kept inside the stage');
  assert.deepEqual(placeSheet(null, { x: 0, y: 0, width: 300, height: 200 }, size), { x: 12, y: 12, width: 276, height: 176 }, 'a small stage shrinks the sheet');
});
