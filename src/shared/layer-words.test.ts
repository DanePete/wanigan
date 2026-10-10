// What the design layer says of an edit's reach, the one wording the main process and the window share. Made-up site
// (acme); nothing real.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fragileWhy, kindWords } from './layer-words.ts';
import { kindKey, type PartIdentity, type TracePart } from './live-trace.ts';

const words = (label: string, identity: PartIdentity, inner: string | null = null): string =>
  kindWords({ label, identity } satisfies Pick<TracePart, 'label' | 'identity'>, kindKey(identity) as string, inner);

test('a kind is said by what every instance shares: a component, a field of a bundle, an entity type', () => {
  assert.equal(words('Card', { kind: 'component', name: 'acme:card', within: null, nth: 0 }), 'every Card component');
  assert.equal(words('Card', { kind: 'component', name: 'acme:card', within: null, nth: 0 }, 'Heading'), 'the heading in every Card component');
  assert.equal(words('Body', { kind: 'entity', type: 'node', id: 'u-1', bundle: 'article', field: 'body' }), 'the Body field of every article');
  assert.equal(words('Event', { kind: 'entity', type: 'node', id: 'u-2', bundle: 'event' }), 'every event node');
  assert.equal(words('Quote', { kind: 'block', store: 'tpl:acme//single', path: [1, 0], name: 'core/quote' }), 'every Quote block');
});

test('a Drupal block is said by its plugin and where its instances are placed, a region or a layout', () => {
  const config = (type: string, plugin: string): PartIdentity => ({ kind: 'config', type, id: 'acme_x', plugin });
  const cases: [string, string, string][] = [
    ['block', 'system_menu_block:main', 'every main menu block placed in a region'],
    ['layout_builder_component', 'inline_block:card', 'every card inline block placed in a layout'],
    ['block', 'block_content:0a1b2c3d-0000-4000-8000-0000000000e5', 'this reusable block wherever it is placed in a region'],
    ['layout_builder_component', 'field_block:node:landing_page:body', 'every landing_page body field block placed in a layout'],
    ['block', 'views_block:news-block_1', 'every news view block (block_1) placed in a region'],
    ['block', 'system_branding_block', 'every system_branding_block block placed in a region'],
    ['menu_link', 'menu_link_content', 'every menu_link_content menu_link'],
  ];
  for (const [type, plugin, said] of cases) assert.equal(words('Placed', config(type, plugin)), said, plugin);
});

test('fragile: a target kept by its place alone; guarded by its words it is orphaned, with none it lands on whatever is there', () => {
  const path = { part: null, inner: null, selector: 'html > body > div:nth-of-type(2)' };
  assert.match(fragileWhy({ ...path, textHash: '0123456789abcdef' }, 'this') ?? '', /orphaned rather than put on something else/);
  assert.match(fragileWhy({ ...path, textHash: null }, 'this') ?? '', /lands on whatever is in that place now/);
  const block: PartIdentity = { kind: 'block', store: 'tpl:acme//single', path: [2], name: 'core/group' };
  assert.match(fragileWhy({ part: block, inner: null, selector: null, textHash: null }, 'this') ?? '', /WordPress keeps no id for a block/);
  assert.equal(fragileWhy({ part: block, inner: null, selector: null, textHash: '0123456789abcdef' }, 'this'), null, 'its words guard it');
  assert.equal(fragileWhy({ part: block, inner: null, selector: null, textHash: null }, 'kind'), null, 'every one of its kind, by name');
  const card: PartIdentity = { kind: 'component', name: 'acme:card', within: null, nth: 0 };
  assert.equal(fragileWhy({ part: card, inner: null, selector: null, textHash: null }, 'this'), null, 'a part the site names');
  assert.equal(fragileWhy({ part: null, inner: null, selector: null, textHash: null }, 'site'), null, 'a token has no element');
});
