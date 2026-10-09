import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LiveRegion } from './live.ts';
import { ancestors, layersOf, pathTo } from './live-tree.ts';

let y = 0;
const r = (index: number, parent: number | null, hook: string | null, file: string | null, extra: Partial<LiveRegion> = {}): LiveRegion => ({
  index, parent, hook, file, suggestions: [], component: null, entity: null, block: null, view: null, element: null, piece: null, field: null,
  order: index, rect: { x: 0, y: (y += 10), width: 100, height: 40 }, ...extra,
});

/** A Drupal home page, in small: html › page › header region › branding block (with an icon), content region › node › five store teasers. */
function page(): LiveRegion[] {
  y = 0;
  return [
    r(0, null, 'html', 'themes/contrib/basis/basis_base/templates/layout/html.html.twig', { rect: { x: 0, y: 0, width: 1400, height: 4000 } }),
    r(1, 0, 'page', 'themes/custom/acme/templates/layout/page.html.twig', { suggestions: ['page--front', 'page'], rect: { x: 0, y: 0, width: 1400, height: 3990 } }),
    r(2, 1, 'region', 'themes/custom/acme/templates/region/region--header.html.twig', { suggestions: ['region--header', 'region'] }),
    r(3, 2, 'block', 'themes/custom/acme/templates/block/block--branding.html.twig', { suggestions: ['block--branding', 'block'] }),
    r(4, 3, 'icon_kit__font', 'modules/contrib/icon_kit/templates/icon-kit.html.twig'),
    r(5, 1, 'region', 'themes/custom/acme/templates/region/region--content.html.twig', { suggestions: ['region--content', 'region'] }),
    r(6, 5, 'node', 'node.html.twig', { suggestions: ['node--1--full', 'node--landing--full'] }),
    ...[201, 202, 203, 204, 205].map((id, i) => r(7 + i, 6, 'taxonomy_term', 'themes/custom/acme/templates/taxonomy/taxonomy-term--stores.html.twig',
      { suggestions: [`taxonomy-term--stores--teaser`, `taxonomy-term--${id}`, 'taxonomy-term--stores'] })),
  ];
}

test('wrappers dissolve, small pieces fold away, a run of one kind is one row', () => {
  const layers = layersOf(page());
  assert.deepEqual(layers.map((l) => l.name.title), ['Header region', 'Content region'], 'the document and the page give way to their regions');
  const header = layers[0]!;
  assert.deepEqual(header.children.map((l) => l.name.title), ['Branding']);
  assert.deepEqual(header.children[0]!.children, [], 'the icon is folded away');
  const node = layers[1]!.children[0]!;
  assert.equal(node.name.title, 'Landing 1');
  assert.equal(node.children.length, 1, 'five teasers, one row');
  const run = node.children[0]!;
  assert.equal(run.regions.length, 5);
  assert.deepEqual(run.children.map((l) => l.name.title), ['Stores 201', 'Stores 202', 'Stores 203', 'Stores 204', 'Stores 205']);
});

test('every piece, when asked for', () => {
  const header = layersOf(page(), { all: true })[0]!;
  assert.deepEqual(header.children[0]!.children.map((l) => l.name.title), ['Icon']);
});

test('the way down to a part, and its ancestors', () => {
  const regions = page();
  const layers = layersOf(regions);
  assert.deepEqual(pathTo(layers, 9).map((l) => l.key), ['5', '6', 'group 7', '9']);
  assert.deepEqual(ancestors(regions, 9).map((a) => a.index), [6, 5, 1, 0]);
  assert.deepEqual(pathTo(layers, 4), [], 'a folded-away piece has no row');
});

test('a part holding only one part in the same place is one row, named by the outer, choosing the inner', () => {
  y = 0;
  const rect = { x: 10, y: 900, width: 300, height: 30 };
  const regions = [
    r(0, null, 'region', 'themes/custom/acme/templates/region/region--footer-end.html.twig', { suggestions: ['region--footer-end'], rect: { x: 0, y: 880, width: 1400, height: 80 } }),
    r(1, 0, 'block', 'themes/custom/acme/templates/block/block--copyright.html.twig', { suggestions: ['block--copyright', 'block'], rect }),
    r(2, 1, 'field', 'themes/contrib/basis/basis_base/templates/field/field.html.twig', { suggestions: ['field--site-settings--field-copyright--general'], rect: { ...rect, x: 11 } }),
  ];
  const [footer] = layersOf(regions);
  assert.equal(footer!.children.length, 1);
  const row = footer!.children[0]!;
  assert.deepEqual([row.name.title, row.region.index, row.merged.map((m) => m.index)], ['Copyright', 2, [1, 2]]);
  assert.deepEqual(pathTo(layersOf(regions), 1).map((l) => l.key), ['0', '1'], 'either part finds the row');
});

test('the same content or block found twice (its template, the helper’s mark) is one row', () => {
  y = 0;
  const regions = [
    r(0, null, 'node', 'node.html.twig', { suggestions: ['node--1--full', 'node--landing--full'], rect: { x: 0, y: 0, width: 900, height: 900 } }),
    r(1, 0, null, null, { entity: 'node:landing:1:full', rect: { x: 0, y: 0, width: 900, height: 300 } }),
    r(2, 0, 'field', 'field.html.twig', { suggestions: ['field--node--field-sections--landing'], rect: { x: 0, y: 320, width: 900, height: 500 } }),
    r(3, null, 'block', 'block--storepicker.html.twig', { suggestions: ['block--storepicker', 'block'], rect: { x: 0, y: 1000, width: 200, height: 30 } }),
    r(4, 3, null, null, { block: 'store_picker_block@storepicker', rect: { x: 0, y: 1000, width: 200, height: 20 } }),
  ];
  const layers = layersOf(regions);
  assert.deepEqual(layers.map((l) => [l.name.title, l.children.map((c) => c.name.title)]), [['Landing 1', ['Sections']], ['Storepicker', []]]);
  assert.deepEqual(layers[0]!.merged.map((m) => m.index), [0, 1]);
  assert.deepEqual(pathTo(layers, 1).map((l) => l.key), ['0'], 'the mark’s region finds its row');
});

test('a component by its own name; a parent the scan did not return is the top', () => {
  y = 0;
  const layers = layersOf([r(0, 77, null, null, { component: 'acme:text_block' })], { componentName: () => 'Text | Plain' });
  assert.deepEqual(layers.map((l) => [l.name.title, l.name.icon]), [['Text · Plain', 'component']]);
});
