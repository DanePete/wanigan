import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LiveRegion } from './live.ts';
import { editPath, entityOf, fieldOf, nameOf, originOf, overrideDir, overrides, themeOf } from './live-names.ts';

/** A region as the page script reads it from a Drupal page with Twig debug on. */
const region = (hook: string | null, file: string | null, suggestions: string[] = [], extra: Partial<LiveRegion> = {}): LiveRegion => ({
  index: 0, file, hook, suggestions, component: null, entity: null, block: null, view: null, element: null, piece: null, field: null,
  parent: null, order: 0, rect: { x: 0, y: 0, width: 100, height: 40 }, ...extra,
});

test('whose a template is, by where it sits', () => {
  assert.equal(originOf('themes/custom/acme/templates/block/block--branding.html.twig'), 'yours');
  assert.equal(originOf('themes/custom/acme/templates/paragraph--hero.html.twig'), 'yours');
  assert.equal(originOf('themes/contrib/basis/basis_base/templates/field/field.html.twig'), 'contrib');
  assert.equal(originOf('modules/contrib/layout_kit/templates/field--component-tree.html.twig'), 'contrib');
  assert.equal(originOf('core/modules/system/templates/page-title.html.twig'), 'core');
  assert.equal(originOf('wp-includes/blocks/paragraph.php'), 'core');
  assert.equal(originOf('wp-content/plugins/elementor/includes/widgets/heading.php'), 'contrib');
  assert.equal(originOf('wp-content/themes/astra/header.php'), null, 'a parent theme or the owner’s: the path cannot say');
  assert.equal(originOf(null), null);
});

test('content: the node, its id and view mode, from the suggestions core lists', () => {
  const node = region('node', 'themes/contrib/basis/basis_base/templates/node/node.html.twig',
    ['node--1--full', 'node--1', 'node--landing--full', 'node--landing', 'node--full', 'node']);
  assert.deepEqual(entityOf(node), { type: 'node', id: '1', bundle: 'landing', viewMode: 'full' });
  assert.deepEqual(nameOf(node), { title: 'Landing 1', kind: 'Node · full view', icon: 'content', origin: 'contrib', wrapper: false, small: false });
  assert.equal(editPath(node), '/node/1/edit');
  const term = region('taxonomy_term', 'themes/custom/acme/templates/taxonomy/taxonomy-term--stores.html.twig',
    ['taxonomy-term--stores--teaser', 'taxonomy-term--201', 'taxonomy-term--stores', 'taxonomy-term']);
  assert.deepEqual(entityOf(term), { type: 'taxonomy_term', id: '201', bundle: 'stores', viewMode: 'teaser' });
  assert.equal(nameOf(term).title, 'Stores 201');
  assert.equal(editPath(term), '/taxonomy/term/201/edit');
  assert.deepEqual(entityOf(region('paragraph', 'p.html.twig', ['paragraph--hero--default', 'paragraph--hero', 'paragraph--default'])),
    { type: 'paragraph', id: null, bundle: 'hero', viewMode: 'default' });
  assert.equal(editPath(region('paragraph', 'p.html.twig', ['paragraph--hero'])), null, 'a paragraph has no page of its own');
});

test('the helper’s mark wins over the suggestions', () => {
  const marked = region('node', null, ['node--9'], { entity: 'node:article:12:teaser' });
  assert.deepEqual(entityOf(marked), { type: 'node', bundle: 'article', id: '12', viewMode: 'teaser' });
  assert.equal(editPath(marked), '/node/12/edit');
});

test('fields, blocks, regions and menus', () => {
  const field = region('field', 'modules/contrib/layout_kit/templates/field--component-tree.html.twig',
    ['field--node--field-sections--landing', 'field--node--field-sections', 'field--node--landing', 'field--field-sections', 'field--component-tree', 'field']);
  assert.deepEqual(fieldOf(field), { entityType: 'node', field: 'field_sections', bundle: 'landing' });
  assert.equal(nameOf(field).title, 'Sections');
  assert.equal(nameOf(field).kind, 'Field field_sections on node (landing)');
  const address = region('field', 'themes/contrib/basis/basis_base/templates/field/field.html.twig',
    ['field--taxonomy-term--field-address--stores', 'field--taxonomy-term--field-address', 'field--taxonomy-term--stores', 'field--field-address']);
  assert.deepEqual(fieldOf(address), { entityType: 'taxonomy_term', field: 'field_address', bundle: 'stores' });
  const block = region('block', 'themes/custom/acme/templates/block/block--branding.html.twig', ['block--branding', 'block--system-branding-block', 'block--system', 'block']);
  assert.equal(nameOf(block).title, 'Branding');
  assert.equal(editPath(block), '/admin/structure/block/manage/branding');
  const header = region('region', 'themes/custom/acme/templates/region/region--header.html.twig', ['region--header', 'region']);
  assert.deepEqual([nameOf(header).title, nameOf(header).icon, editPath(header)], ['Header region', 'region', '/admin/structure/block']);
  const menu = region('menu__top', 'themes/custom/acme/templates/menu/menu--top.html.twig', ['menu--top', 'menu']);
  assert.deepEqual([nameOf(menu).title, editPath(menu)], ['Top menu', '/admin/structure/menu/manage/top']);
});

test('the page and its wrappers are structure; icons, images and form fields are small', () => {
  const page = region('page', 'themes/custom/acme/templates/layout/page.html.twig', ['page--front', 'page--node--1', 'page--node', 'page']);
  assert.deepEqual([nameOf(page).title, nameOf(page).wrapper], ['Front page', true]);
  assert.equal(nameOf(region('html', 'html.html.twig')).wrapper, true);
  assert.equal(nameOf(region('off_canvas_page_wrapper', 'off-canvas-page-wrapper.html.twig')).wrapper, true);
  assert.equal(nameOf(region('icon_kit__font', 'modules/contrib/icon_kit/templates/icon-kit.html.twig')).small, true);
  assert.equal(nameOf(region('image', 'core/modules/system/templates/image.html.twig')).small, true);
  assert.equal(nameOf(region('input__submit', 'input--submit.html.twig')).small, true);
});

test('a component by its own name; an Elementor widget; a view', () => {
  const c = region(null, null, [], { component: 'acme:text_block' });
  assert.deepEqual([nameOf(c, 'Text | Plain').title, nameOf(c).title, nameOf(c).kind], ['Text · Plain', 'Text block', 'Component · acme']);
  assert.equal(nameOf(region(null, null, [], { element: 'widget:heading#4d2a1f0' })).title, 'Heading');
  const view = region(null, null, [], { view: 'products:block_1' });
  assert.deepEqual([nameOf(view).title, editPath(view)], ['Products', '/admin/structure/views/view/products/edit/block_1']);
});

test('WordPress: a block by its own name, a template part, a post and where to edit it', () => {
  assert.deepEqual([nameOf(region(null, null, [], { block: 'core/paragraph' })).title, nameOf(region(null, null, [], { block: 'core/paragraph' })).kind], ['Paragraph', 'Block · core']);
  assert.equal(nameOf(region(null, null, [], { block: 'acf/hero-banner' })).title, 'Hero banner');
  assert.equal(nameOf(region(null, null, [], { block: 'core/template-part:header' })).title, 'Header part');
  const post = region(null, null, [], { entity: 'post:page:42:full' });
  assert.deepEqual([nameOf(post).title, editPath(post)], ['Page 42', '/wp-admin/post.php?post=42&action=edit']);
  assert.equal(nameOf(region(null, 'wp-content/themes/acme-child/template-parts/hero.php')).title, 'Hero');
  const component = nameOf(region(null, 'wp-content/themes/acme-child/components/hero-split/hero-split.php'));
  assert.deepEqual([component.title, component.icon], ['Hero split', 'component'], 'a theme’s component folder');
});

test('an override: the suggestions Drupal checked before the file it used, in the owner’s theme', () => {
  const field = region('field', 'themes/contrib/basis/basis_base/templates/field/field.html.twig',
    ['field--taxonomy-term--name--stores', 'field--taxonomy-term--name', 'field--taxonomy-term--stores', 'field--name', 'field']);
  assert.deepEqual(overrides(field), [
    'field--taxonomy-term--name--stores.html.twig', 'field--taxonomy-term--name.html.twig',
    'field--taxonomy-term--stores.html.twig', 'field--name.html.twig',
  ]);
  const page = [
    region('block', 'themes/custom/acme/templates/block/block--branding.html.twig'),
    region('region', 'themes/custom/acme/templates/region/region--header.html.twig'),
    region('field', 'themes/contrib/basis/basis_base/templates/field/field.html.twig'),
  ];
  assert.equal(themeOf(page), 'themes/custom/acme/');
  assert.equal(overrideDir(field, 'themes/custom/acme/'), 'themes/custom/acme/templates/field/');
  assert.equal(themeOf([page[2]!]), null, 'no template of the owner’s on the page');
  assert.deepEqual(overrides(region('block', 'b.html.twig')), [], 'no suggestions, nothing to say');
});
