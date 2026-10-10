// The Library panel's reading of the site's library: why there is none (in the
// main process's own words), an entry's props, whether it can be added to the
// page shown, where that page uses it, and where the rest of the site does.
// Made-up library (acme); nothing real.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { libraryWhy } from '../../../main/live-library.ts';
import type { LiveRegion } from '../../../shared/live.ts';
import { partIndex } from '../../../shared/live-lens.ts';
import type { ComponentLibrary, EntryUsage, LibraryEntry } from '../../../shared/live-library.ts';
import type { LiveTrace } from '../../../shared/live-trace.ts';
import { libraryGroups, libraryNext, libraryWhyText, placeAddress, placeDetail, placement, propRows, usageGroups, usageSummary, usesOnPage, type LibraryProblem } from './live-library.ts';

const entry = (e: Partial<LibraryEntry> & Pick<LibraryEntry, 'id' | 'kind' | 'label'>): LibraryEntry => ({ picture: { from: 'none', why: 'none' }, ...e });

const card = entry({
  id: 'sdc:acme:card', kind: 'component', label: 'Card', required: ['heading'],
  props: {
    type: 'object', required: ['heading'],
    properties: {
      heading: { type: 'string', title: 'Heading' },
      tone: { type: 'string', enum: ['light', 'dark'], default: 'light' },
      align: { oneOf: [{ const: 'left', title: 'Left' }, { const: 'center', title: 'Centre' }] },
      tags: { type: 'array', items: { type: 'string' } },
      image: { $ref: 'json-schema-definitions://acme.module/image' },
      count: { type: ['integer', 'null'], default: 3 },
    },
  },
});
const cta = entry({ id: 'block:acme_cta_block', kind: 'block', label: 'Call to action' });
const branding = entry({ id: 'block:system_branding_block', kind: 'block', label: 'Site branding' });
const hero = entry({ id: 'pattern:acme/hero', kind: 'pattern', label: 'Hero' });
const outline = entry({ id: 'style:core/button:outline', kind: 'style', label: 'Outline (Button)' });

const trace = (): LiveTrace => ({
  version: 1, platform: 'drupal', id: '0123456789abcdef', url: '/', at: 1, total: { ms: 1 }, edits: [],
  parts: [
    { id: 'p1', kind: 'component', label: 'Card', identity: { kind: 'component', name: 'acme:card', within: null, nth: 0 } },
    { id: 'p2', kind: 'component', label: 'Card', identity: { kind: 'component', name: 'acme:card', within: null, nth: 1 } },
    { id: 'p3', kind: 'block', label: 'Acme branding', identity: { kind: 'config', type: 'block', id: 'acme_branding', plugin: 'system_branding_block' } },
    { id: 'p4', kind: 'region', label: 'Sidebar' },
    // The same block placed by a page's layout (Layout Builder), and a menu: neither is a placement in a region.
    { id: 'p5', kind: 'block', label: 'Branding in a layout', identity: { kind: 'config', type: 'layout_builder_component', id: 'node:0a1b2c3d-0000-4000-8000-000000000014/7e57ab1e-0000-4000-8000-000000000001', plugin: 'system_branding_block' } },
    { id: 'p6', kind: 'menu', label: 'Main navigation', identity: { kind: 'config', type: 'menu', id: 'main' } },
  ],
  palette: [{ id: 'pal.b.acme_cta_block', kind: 'block', label: 'Call to action' }],
  collections: [
    { id: 'c-side', kind: 'region-blocks', label: 'Sidebar blocks', part: 'p4', items: [], inserts: ['pal.b.acme_cta_block'], changes: 'configuration' },
    { id: 'c-head', kind: 'region-blocks', label: 'Header blocks', items: ['p3'], inserts: ['pal.b.acme_cta_block'], changes: 'configuration', why: 'The header is fixed by the theme.' },
  ],
});

const region = (index: number, r: Partial<LiveRegion>): LiveRegion => ({
  index, file: null, entity: null, block: null, view: null, element: null, component: null, piece: null, hook: null, field: null,
  suggestions: [], part: null, parent: null, order: index, rect: { x: 0, y: index * 10, width: 10, height: 10 }, ...r,
} as LiveRegion);

test('every way there is no library is said in the main process’s own words, with what to do', () => {
  const states: LibraryProblem[] = [
    { state: 'off' }, { state: 'no-site' }, { state: 'no-helper' }, { state: 'outdated' }, { state: 'unreadable' }, { state: 'too-large' },
    { state: 'refused', status: 403 }, { state: 'down', error: 'connection refused' },
  ];
  for (const s of states) assert.equal(libraryWhyText(s), libraryWhy(s), s.state);
  assert.equal(libraryNext({ state: 'outdated' }), 'update-helper');
  assert.equal(libraryNext({ state: 'no-helper' }), 'install-helper');
  assert.equal(libraryNext({ state: 'down', error: 'x' }), 'retry');
});

test('props are read from the schema in its order: type, required, default and the values it may take', () => {
  const rows = propRows(card);
  assert.deepEqual(rows.map((r) => [r.name, r.type, r.required]), [
    ['heading', 'string', true], ['tone', 'string', false], ['align', 'one of', false], ['tags', 'array of string', false], ['image', 'image', false], ['count', 'integer or null', false],
  ]);
  assert.equal(rows[0]?.title, 'Heading');
  assert.equal(rows[1]?.default, '“light”');
  assert.deepEqual(rows[1]?.choices, ['“light”', '“dark”']);
  assert.deepEqual(rows[2]?.choices, ['Left (“left”)', 'Centre (“center”)']);
  assert.equal(rows[5]?.default, '3');
  assert.deepEqual(propRows(cta), [], 'no schema, no rows');
});

test('an entry is added through the trace’s palette, only where a place takes it; otherwise it says why', () => {
  const t = trace();
  const ok = placement(cta, 'drupal', t, false);
  assert.ok(ok.ok && ok.palette.id === 'pal.b.acme_cta_block');
  assert.deepEqual(ok.ok && ok.into.map((c) => c.id), ['c-side'], 'a place with a why takes nothing');
  const component = placement(card, 'drupal', t, false);
  assert.ok(!component.ok && /Drupal core places a component only inside a template/.test(component.why));
  const nowhere = placement(branding, 'drupal', t, false);
  assert.ok(!nowhere.ok && /Nothing on this page takes it/.test(nowhere.why));
  assert.ok(!placement(cta, 'drupal', null, false).ok);
  const hosted = placement(cta, 'drupal', t, true);
  assert.ok(!hosted.ok && /read-only/.test(hosted.why));
  assert.ok(!placement(outline, 'wordpress', t, false).ok);
});

test('where the page uses an entry is what the trace names as it, and the page’s own marks; nothing more', () => {
  const t = trace();
  const regions = [
    region(0, { part: 'p1', component: 'acme:card' }), region(1, { part: 'p2', component: 'acme:card' }),
    region(2, { part: 'p3', block: 'system_branding_block@acme_branding' }), region(3, { component: 'acme:card' }),
    // A theme's block template that prints no attributes drops the page's mark: the trace's identity still says what it is.
    region(4, { part: 'p5' }), region(5, { part: 'p6' }),
  ];
  const parts = partIndex(regions, t);
  const cards = usesOnPage(card, 'drupal', t, regions, parts);
  assert.ok(cards.known);
  assert.deepEqual(cards.known && cards.uses.map((u) => [u.part, u.label, u.regions]), [['p1', 'Card', [0]], ['p2', 'Card', [1]], [null, 'acme:card', [3]]]);
  const brand = usesOnPage(branding, 'drupal', t, regions, parts);
  assert.deepEqual(brand.known && brand.uses.map((u) => [u.part, u.label, u.regions]), [['p3', 'Acme branding', [2]], ['p5', 'Branding in a layout', [4]]], 'placed in a region, and placed by a layout');
  const none = usesOnPage(cta, 'drupal', t, regions, parts);
  assert.deepEqual(none, { known: true, uses: [] });
  assert.equal(usesOnPage(hero, 'wordpress', t, regions, parts).known, false);
  assert.equal(usesOnPage(outline, 'wordpress', t, regions, parts).known, false);
});

test('the library is grouped by kind with each kind’s count, and narrowed by every word searched', () => {
  const lib: ComponentLibrary = { version: 1, platform: 'drupal', hash: '0123456789abcdef', at: 1, entries: [card, cta, branding], counts: { component: 1, block: 7 } };
  assert.deepEqual(libraryGroups(lib, '').map((g) => [g.title, g.total, g.entries.length]), [['Components', 1, 1], ['Blocks', 7, 2]]);
  assert.deepEqual(libraryGroups(lib, 'call action').map((g) => [g.title, g.entries.map((e) => e.id)]), [['Blocks', ['block:acme_cta_block']]]);
  assert.deepEqual(libraryGroups(lib, 'nothing like it'), []);
});

test('where the rest of the site uses an entry is grouped by kind, counted in one sentence, and opens only on the site', () => {
  const usage: EntryUsage = {
    version: 1, platform: 'drupal', entry: 'block:system_menu_block:main', found: 4, complete: true, gaps: [], searched: [], unseen: [], ms: 40,
    places: [
      { kind: 'layout-override', label: 'About us (Basic page)', url: '/about', where: 'section 2, second region', count: 2 },
      { kind: 'placement', label: 'Main navigation', url: '/', where: 'Header region, Acme theme', note: 'no visibility conditions: any page in this theme' },
      { kind: 'template', label: 'node--article.html.twig', file: 'web/themes/custom/acme/templates/node--article.html.twig', where: 'line 4, include' },
      { kind: 'placement', label: 'Old menu', where: 'Footer region, Acme theme', note: 'switched off' },
    ],
  };
  assert.deepEqual(usageGroups(usage).map((g) => [g.title, g.places.map((p) => p.label)]), [
    ['Block placements', ['Main navigation', 'Old menu']], ['Layouts of single items', ['About us (Basic page)']], ['Templates', ['node--article.html.twig']],
  ], 'in the order the kinds are listed, each kind in the order found');
  assert.equal(usageSummary(usage), 'Used in 4 places across the site.');
  assert.equal(usageSummary({ ...usage, complete: false, found: 9 }), 'Used in 9 places it reached across the site (4 listed).', 'a search that did not finish says so, and a cut list says how many are listed');
  assert.equal(usageSummary({ ...usage, places: [], found: 0 }), 'Nowhere: nothing the site has stored uses it.');
  assert.equal(usageSummary({ ...usage, places: [], found: 0, complete: false }), 'Nowhere the search reached: nothing it read uses it.');
  assert.equal(placeDetail({ kind: 'content', label: 'About', where: 'core/group › acme/card', via: 'the synced pattern “Footer call”', note: 'Page' }), 'core/group › acme/card · through the synced pattern “Footer call” · Page');
  assert.equal(placeDetail(usage.places[2]!), 'line 4, include', 'a file is shown on its own');
  assert.equal(placeAddress('/about?x=1', 'https://acme.example.test/node/1'), 'https://acme.example.test/about?x=1');
  for (const away of ['//elsewhere.example/', 'https://elsewhere.example/', 'about', undefined]) assert.equal(placeAddress(away, 'https://acme.example.test/'), null, String(away));
  assert.equal(placeAddress('/about', null), null, 'no site, nothing to open');
});
