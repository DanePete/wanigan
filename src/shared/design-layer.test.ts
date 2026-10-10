import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYER_PROPERTIES, compileLayer, layerBreakpoints, layerEdit, layerSelector, layerTextHash, layerValue, trySheet, tryValues, tryVar, type LayerEdit, type LayerTarget,
} from './design-layer.ts';
import { identityKey, kindKey, parseIdentity, type PartIdentity } from './live-trace.ts';

const hero: LayerTarget = { part: { kind: 'component', name: 'acme:hero', within: null, nth: 0 }, inner: null, selector: null, textHash: null };
const edit = (over: Partial<LayerEdit> & { id: string }): LayerEdit => ({
  target: hero, label: 'Hero', page: '/', scope: 'this', breakpoint: 'all',
  change: { type: 'style', values: { color: '#123456' } }, before: {}, state: 'draft', by: 'owner', at: 1, verdict: null, ...over,
});
const at = (part: unknown, more: Partial<LayerTarget> = {}): unknown => ({ part, inner: null, selector: null, textHash: null, ...more });
const title = at({ kind: 'entity', type: 'node', id: 'aaaa-bbbb', bundle: 'article', langcode: 'en', field: 'title' });
const branding = at({ kind: 'config', type: 'block', id: 'acme_branding', plugin: 'system_branding_block' });

test('a value is words, numbers, colours, tokens and calc(); never a way out of its rule', () => {
  for (const ok of ['#1a2b3c', 'rgb(10, 20, 30)', '1.25rem', 'var(--color-accent)', 'calc(1rem + 2px)', '"Fira Sans", sans-serif', '0 1px 2px rgba(0, 0, 0, 0.2)', '600', 'uppercase', '16px/1.5', '50%'])
    assert.equal(layerValue(ok), ok, ok);
  assert.equal(layerValue('red !important'), 'red', 'the layer adds its own !important');
  for (const bad of [
    'red; } body { display: none', 'url(https://example.test/x.png)', 'image-set("a.png" 1x)', 'expression(alert(1))', 'red /* note */',
    '</style><script>', 'attr(title)', '@import "x"', 'a\\62 c', '"unclosed', "'unclosed", '', '   ', 'x'.repeat(301), 'env(safe-area-inset-top)',
  ]) assert.equal(layerValue(bad), null, bad);
  assert.equal(layerValue(12), null);
});

test('a value’s quotes are read as CSS reads them: every quoted string closes, and the other quote inside one is a letter', () => {
  for (const ok of [`"O'Reilly Sans", serif`, `'Say "hi"', sans-serif`, `"a" 'b'`, `""`]) assert.equal(layerValue(ok), ok, ok);
  // Counted, these pair; read, the last single quote opens a string that never closes and takes the sheet with it.
  for (const bad of [`"'"'`, `"a" 'b`, `'"' "`, `"O'Reilly Sans`]) assert.equal(layerValue(bad), null, bad);
  const css = compileLayer([edit({ id: 'e1', change: { type: 'style', values: { 'font-family': `"O'Reilly Sans", serif` } } })], []);
  assert.equal(css, `[data-wl-edit~="e1"][data-wl-edit~="e1"] { font-family: "O'Reilly Sans", serif !important; }`);
});

test('an edit from outside is checked field by field, and says why it is refused', () => {
  const good = layerEdit({ id: 'e1', target: title, label: 'Title of Paddling 101', page: '/paddling', scope: 'this', breakpoint: 'all', change: { type: 'style', values: { 'font-size': '2rem' } } });
  assert.equal(good.refused, null);
  assert.deepEqual(good.edit?.change, { type: 'style', values: { 'font-size': '2rem' } });
  assert.equal(good.edit?.state, 'draft');
  assert.equal(good.edit?.by, 'owner');
  assert.equal(good.edit?.page, '/paddling');
  assert.equal(good.edit?.verdict, null, 'a verdict comes from the verification, never from outside');
  const why = (raw: unknown): string => layerEdit(raw).refused ?? '';
  assert.match(why({ id: 'E 1' }), /id/);
  assert.match(why({ id: 'e1', target: at({ kind: 'xpath', path: '/html' }) }), /target/);
  assert.match(why({ id: 'e1', target: at(null, { inner: 'h2' }), scope: 'this', breakpoint: 'all', change: { type: 'text', value: 'x' } }), /target/, 'neither a part nor a selector');
  assert.match(why({ id: 'e1', target: at(null, { selector: 'main > h1', textHash: 'not hex' }) }), /target/);
  assert.match(why({ id: 'e1', target: at(null, { selector: 'h1 { color: red }' }) }), /target/, 'a path the page script wrote, nothing more');
  assert.match(why({ id: 'e1', target: at(null, { selector: 'main > h1' }), scope: 'kind', breakpoint: 'all', change: { type: 'style', values: { color: 'red' } } }), /every instance/);
  assert.match(why({ id: 'e1', target: at({ kind: 'config', type: 'menu_link', id: 'main.about' }), scope: 'kind', breakpoint: 'all', change: { type: 'style', values: { color: 'red' } } }), /every instance/, 'a menu link has no kind');
  assert.match(why({ id: 'e1', target: at({ kind: 'config', type: 'menu', id: 'main' }), scope: 'kind', breakpoint: 'all', change: { type: 'style', values: { color: 'red' } } }), /every instance/, 'nor has a menu');
  const component = at({ kind: 'config', type: 'layout_builder_component', id: 'node:0a1b-14/7e57-01', plugin: 'inline_block:card' });
  assert.equal(layerEdit({ id: 'e1', target: component, scope: 'kind', breakpoint: 'all', change: { type: 'style', values: { color: 'red' } } }).edit?.scope, 'kind', 'a Layout Builder component has its plugin’s kind');
  assert.equal(layerEdit({ id: 'e1', target: at(null, { selector: 'main > h1:nth-of-type(1)', textHash: 'a1b2c3d4e5f60718' }), scope: 'this', breakpoint: 'all', change: { type: 'text', value: 'Hi' } }).edit?.target.selector, 'main > h1:nth-of-type(1)');
  assert.match(why({ id: 'e1', target: branding, scope: 'everywhere' }), /scope/);
  assert.match(why({ id: 'e1', target: branding, scope: 'this', breakpoint: 'all', change: { type: 'style', values: { position: 'fixed' } } }), /does not set position/);
  assert.match(why({ id: 'e1', target: branding, scope: 'this', breakpoint: 'all', change: { type: 'style', values: { color: 'red; x: y' } } }), /not a value/);
  assert.match(why({ id: 'e1', target: branding, scope: 'this', breakpoint: 'all', change: { type: 'token', name: '--accent', value: 'red' } }), /whole site/);
  assert.match(why({ id: 'e1', target: branding, scope: 'site', breakpoint: 'all', change: { type: 'style', values: { color: 'red' } } }), /whole site/);
  assert.match(why({ id: 'e1', target: branding, scope: 'site', breakpoint: 'all', change: { type: 'token', name: 'accent', value: 'red' } }), /--name/);
  const image = at({ kind: 'entity', type: 'media', id: 'u', field: 'field_media_image', item: 'delta:0' });
  assert.match(why({ id: 'e1', target: image, scope: 'this', breakpoint: 'all', change: { type: 'image', asset: '../../etc/passwd', alt: null } }), /asset/);
  assert.equal(layerEdit({ id: 'e1', target: image, scope: 'this', breakpoint: 'all', change: { type: 'image', asset: '0123456789abcdef.webp', alt: 'A canoe at dawn' } }).refused, null);
  assert.equal(layerEdit({ id: 'e2', target: branding, scope: 'this', breakpoint: 'all', change: { type: 'style', values: { color: 'red' } }, by: 'agent', state: 'verified' }).edit?.by, 'agent');
});

test('a theme’s breakpoints are taken as plain width queries, and nothing else', () => {
  const bps = layerBreakpoints([
    { id: 'tablet', label: 'Tablet', media: 'all and (min-width: 560px)' },
    { id: 'narrow', label: 'Narrow', media: '(max-width: 767px)' },
    { id: 'wide', label: 'Wide', media: 'screen and (min-width: 1200px)' },
    { id: 'range', label: 'Range', media: '(min-width: 600px) and (max-width: 900px)' },
    { id: 'evil', label: 'Evil', media: '(min-width: 1px) { body { display: none } } @media (min-width: 1px)' },
    { id: 'all', label: 'All', media: '(min-width: 1px)' },
    { id: 'Bad Id', label: 'x', media: '(min-width: 1px)' },
  ]);
  assert.deepEqual(bps.map((b) => b.id), ['tablet', 'narrow', 'wide', 'range'], 'only width features (with all or screen, as Drupal and WordPress write them) are printed; `all` as an id is implied');
});

test('the preview sheet targets only tagged elements, always wins, and keeps the order edits were made in', () => {
  const bps = layerBreakpoints([{ id: 'narrow', label: 'Phone', media: '(max-width: 767px)' }]);
  const css = compileLayer([
    edit({ id: 'e1', change: { type: 'style', values: { color: '#123456', 'padding-top': '2rem' } } }),
    edit({ id: 'e2', breakpoint: 'narrow', change: { type: 'style', values: { 'font-size': '1.5rem' } } }),
    edit({ id: 'e3', scope: 'site', change: { type: 'token', name: '--color-accent', value: '#c0ffee' } }),
    edit({ id: 'e4', change: { type: 'style', values: { color: 'red' } }, state: 'verified' }),
    edit({ id: 'e5', change: { type: 'style', values: { color: 'blue' } }, state: 'retired' }),
    edit({ id: 'e6', breakpoint: 'missing', change: { type: 'style', values: { color: 'green' } } }),
    edit({ id: 'e7', change: { type: 'text', value: 'Hello' } }),
    edit({ id: 'e8', change: { type: 'style', values: { color: '#654321' } }, state: 'implemented' }),
  ], bps);
  assert.equal(css, [
    '[data-wl-edit~="e1"][data-wl-edit~="e1"] { color: #123456 !important; padding-top: 2rem !important; }',
    ':root { --color-accent: #c0ffee !important; }',
    '[data-wl-edit~="e8"][data-wl-edit~="e8"] { color: #654321 !important; }',
    '@media (max-width: 767px) {\n  [data-wl-edit~="e2"][data-wl-edit~="e2"] { font-size: 1.5rem !important; }\n}',
  ].join('\n'), 'verified and retired edits live in the site now; an unknown breakpoint is skipped, not guessed; text is not CSS');
  assert.equal(layerSelector('e1'), '[data-wl-edit~="e1"][data-wl-edit~="e1"]');
});

test('a gated sheet holds only while the page’s root names its generation, the root itself included', () => {
  const edits = [
    edit({ id: 'e1', change: { type: 'style', values: { color: '#123456' } } }),
    edit({ id: 'e3', scope: 'site', change: { type: 'token', name: '--color-accent', value: '#c0ffee' } }),
  ];
  const g = ':root[data-wl-layer="g7"]';
  assert.equal(compileLayer(edits, [], 'g7'), [
    `${g} [data-wl-edit~="e1"][data-wl-edit~="e1"], ${g}[data-wl-edit~="e1"][data-wl-edit~="e1"] { color: #123456 !important; }`,
    `${g} { --color-accent: #c0ffee !important; }`,
  ].join('\n'), 'a user-origin sheet cannot be taken out once injected: one the root no longer names holds nothing');
  for (const bad of ['7', 'g', 'g1"] body {', 'G7', 'g1234567890']) assert.equal(compileLayer(edits, [], bad), '', `nothing for a gate of ${JSON.stringify(bad)}`);
  assert.equal(compileLayer(edits, []), compileLayer(edits, [], null), 'no gate, as before');
});

test('a value that slipped past the edit check still cannot break out of the sheet', () => {
  const css = compileLayer([edit({ id: 'e1', change: { type: 'style', values: { color: 'red; } body { display: none' } } })], []);
  assert.equal(css, '');
});

test('adding and removing a component are edits too, checked like the rest', () => {
  const card = at({ kind: 'component', name: 'acme:card', within: 'entity|node|aaaa-bbbb|en||', nth: 2 });
  const insert = layerEdit({ id: 'e1', target: card, scope: 'this', breakpoint: 'all', change: { type: 'insert', entry: 'sdc:acme:card', collection: 'c.lb.node-12.0.first', index: 1, props: { heading: 'Paddles', featured: true, columns: 3 } } });
  assert.equal(insert.refused, null);
  assert.deepEqual(insert.edit?.change, { type: 'insert', entry: 'sdc:acme:card', collection: 'c.lb.node-12.0.first', index: 1, props: { heading: 'Paddles', featured: true, columns: 3 } });
  const why = (change: unknown): string => layerEdit({ id: 'e1', target: card, scope: 'this', breakpoint: 'all', change }).refused ?? '';
  assert.match(why({ type: 'insert', entry: 'sdc:acme:card', collection: 'c1', index: -1 }), /place/);
  assert.match(why({ type: 'insert', entry: 'sdc:acme:card', collection: 'c1', index: 0, props: { 'bad name': 'x' } }), /not a prop name/);
  assert.match(why({ type: 'insert', entry: 'sdc:acme:card', collection: 'c1', index: 0, props: { items: ['a'] } }), /not a string, number or yes\/no/);
  assert.equal(layerEdit({ id: 'e2', target: card, scope: 'this', breakpoint: 'all', change: { type: 'remove', collection: 'c.r.sidebar' } }).refused, null);
  assert.match(why({ type: 'remove' }), /collection/);
  // Neither is CSS: the preview sheet leaves them to the page script.
  assert.equal(compileLayer([layerEdit({ id: 'e2', target: card, scope: 'this', breakpoint: 'all', change: { type: 'remove', collection: 'c.r.sidebar' } }).edit as LayerEdit], []), '');
});

test('a part’s identity is checked, keyed the same on every load, and says what its kind shares', () => {
  const field = parseIdentity({ kind: 'entity', type: 'node', id: '5f1c-77aa', bundle: 'article', langcode: 'en', field: 'field_related', item: 'ref:node:9e2d-0b31' });
  assert.deepEqual(field, { kind: 'entity', type: 'node', id: '5f1c-77aa', bundle: 'article', langcode: 'en', field: 'field_related', item: 'ref:node:9e2d-0b31' });
  assert.equal(identityKey(field!), 'entity|node|5f1c-77aa|en|field_related|ref:node:9e2d-0b31');
  assert.equal(kindKey(field!), 'field|node|article|field_related', 'every Related field of every Article');
  const card = parseIdentity({ kind: 'component', name: 'acme:card', within: identityKey(field!), nth: 1 })!;
  assert.equal(kindKey(card), 'component|acme:card');
  assert.equal(kindKey(parseIdentity({ kind: 'block', store: 'post:12', path: [0, 2], name: 'core/paragraph' })!), 'component|core/paragraph', 'a block type is a component kind');
  assert.equal(kindKey(parseIdentity({ kind: 'config', type: 'menu_link', id: 'main.about' })!), null);
  assert.equal(kindKey(parseIdentity({ kind: 'config', type: 'block', id: 'acme_branding', plugin: 'system_branding_block' })!), 'plugin|block|system_branding_block');
  const inLayout = parseIdentity({ kind: 'config', type: 'layout_builder_component', id: 'node:0a1b-14/7e57-01', plugin: 'system_branding_block' })!;
  assert.equal(identityKey(inLayout), 'config|layout_builder_component|node:0a1b-14/7e57-01');
  assert.equal(kindKey(inLayout), 'plugin|layout_builder_component|system_branding_block', 'the same plugin placed by a layout is a kind of its own');
  assert.equal(kindKey(parseIdentity({ kind: 'config', type: 'menu', id: 'main' })!), null, 'a menu has no kind beyond itself');
  // A WordPress theme's template file: the theme, the file's path in it, and which theme it is.
  const file = parseIdentity({ kind: 'template', theme: 'acme', path: 'template-parts/header/site-branding.php', role: 'parent' });
  assert.deepEqual(file, { kind: 'template', theme: 'acme', path: 'template-parts/header/site-branding.php', role: 'parent' });
  assert.equal(identityKey(file!), 'template|acme|template-parts/header/site-branding.php');
  assert.equal(identityKey({ ...file!, role: 'theme' } as PartIdentity), identityKey(file!), 'which theme is active does not make it another file');
  assert.equal(kindKey(file!), null, 'a template file has no kind beyond itself');
  for (const bad of [
    { kind: 'template', theme: 'acme', path: '../../wp-config.php', role: 'theme' }, { kind: 'template', theme: 'acme', path: '/etc/hosts', role: 'theme' },
    { kind: 'template', theme: 'acme', path: 'parts//header.php', role: 'theme' }, { kind: 'template', theme: 'acme/child', path: 'header.php', role: 'child' },
    { kind: 'template', theme: 'acme', path: 'header.php', role: 'plugin' }, { kind: 'template', theme: 'acme', path: 'header.php' },
  ]) assert.equal(parseIdentity(bad), null, `never out of the theme, nor a role it does not name: ${JSON.stringify(bad)}`);
  for (const bad of [
    { kind: 'entity', type: 'node' }, { kind: 'entity', type: 'node', id: 'has space' }, { kind: 'entity', type: 'node', id: 'x', item: 'delta:-1' },
    { kind: 'component', name: 'acme:card', within: null, nth: -1 }, { kind: 'block', store: 'post:1', path: [], name: 'core/p' },
    { kind: 'config', type: 'block' }, { kind: 'xpath' }, null, 'entity',
  ]) assert.equal(parseIdentity(bad), null, JSON.stringify(bad));
  assert.equal(parseIdentity({ kind: 'entity', type: 'node', id: 'x', field: 'a b' }), null, 'a malformed field would widen the target to all of the content');
  assert.equal(parseIdentity({ kind: 'config', type: 'block', id: 'b', plugin: 7 }), null);
  assert.deepEqual(parseIdentity({ kind: 'entity', type: 'post', id: '12', bundle: 'page', field: null }), { kind: 'entity', type: 'post', id: '12', bundle: 'page' }, 'null is absent');
});

test('a paragraph’s identity carries the revision the page showed, which neither its key nor its kind counts', () => {
  const raw = { kind: 'entity', type: 'paragraph', id: '0a1b-f6', bundle: 'text', langcode: 'en', field: 'field_text', item: 'delta:0' };
  const shown = parseIdentity({ ...raw, revision: '50' });
  assert.deepEqual(shown, { ...raw, revision: '50' });
  const saved = parseIdentity({ ...raw, revision: '1000' })!;
  assert.equal(identityKey(saved), identityKey(shown!), 'a save makes a new revision of the same paragraph: still the same part');
  assert.equal(identityKey(parseIdentity(raw)!), identityKey(shown!), 'an identity from before the revision was named is the same part too');
  assert.equal(kindKey(shown!), 'field|paragraph|text|field_text');
  for (const revision of ['latest', '-1', '', 12]) assert.equal(parseIdentity({ ...raw, revision }), null, `revision ${JSON.stringify(revision)}: refused whole`);
});

test('words are hashed the same however their whitespace falls', () => {
  assert.equal(layerTextHash('  Plan   your\ntrip '), layerTextHash('Plan your trip'));
  assert.notEqual(layerTextHash('Plan your trip'), layerTextHash('Plan your trips'));
  assert.match(layerTextHash(''), /^[0-9a-f]{16}$/);
  assert.equal(layerTextHash('Paddling 101'), layerTextHash('Paddling 101'));
});

/** A selector's specificity, as (ids, classes and attributes and pseudo-classes, types), for the plain selectors the sheets print. */
const specificity = (sel: string): [number, number, number] => {
  const ids = (sel.match(/#[\w-]+/g) ?? []).length;
  const attrs = (sel.match(/\[[^\]]*\]/g) ?? []).length + (sel.replace(/\[[^\]]*\]/g, '').match(/(?<!:):[\w-]+/g) ?? []).length;
  const types = (sel.replace(/\[[^\]]*\]/g, '').match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return [ids, attrs, types];
};
const outranks = (a: [number, number, number], b: [number, number, number]): boolean => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

test('a style being tried shows through one sheet that holds no value of its own, and outranks the layer’s own rule for the same property', () => {
  const sheet = trySheet();
  const rules = sheet.split('\n');
  assert.equal(rules.length, LAYER_PROPERTIES.length, 'one rule for each property the layer sets, and nothing else');
  for (const [i, p] of LAYER_PROPERTIES.entries()) {
    const m = /^((?:\[data-wl-try~="([a-z-]+)"\])+) \{ ([a-z-]+): var\((--wl-try-[a-z-]+)\) !important; \}$/.exec(rules[i] ?? '');
    assert.ok(m, rules[i]);
    assert.deepEqual([m[2], m[3], m[4]], [p, p, tryVar(p)], `${p} is read from its own custom property, on elements marked for it: no value is written into the sheet`);
  }
  // Both sheets are injected at the user origin, where !important beats every page declaration: between them the
  // selector decides, and a value being tried must show over an edit the layer already shows on that element.
  const layer = compileLayer([edit({ id: 'e1', change: { type: 'style', values: { color: '#123456' } } })], [], 'g7');
  const layerSelectors = layer.split(' { ')[0]!.split(', ');
  assert.equal(layerSelectors.length, 2);
  const tried = specificity(rules[0]!.split(' { ')[0]!);
  for (const s of layerSelectors) assert.ok(outranks(tried, specificity(s)), `${rules[0]!.split(' { ')[0]} over ${s}`);
});

test('values to try are the layer’s own properties with values it prints; anything else is left out, and none is nothing', () => {
  assert.deepEqual(tryValues({ color: '#c0392b', 'font-size': '22px', position: 'fixed', 'background-color': 'red; } body { display: none', margin: '0' }), { color: '#c0392b', 'font-size': '22px' });
  assert.deepEqual(tryValues({ 'padding-top': ' 2rem !important ' }), { 'padding-top': '2rem' }, 'the sheet adds its own !important');
  for (const none of [null, undefined, 'color: red', ['color'], {}, { position: 'fixed' }, { color: 'url(https://example.test/x.png)' }]) assert.equal(tryValues(none), null, JSON.stringify(none));
});

test('a value may name a site colour by its custom property, a WordPress preset’s and a page builder’s too: the layer prints the reference, not a copy', () => {
  for (const ref of ['var(--ns-pine)', 'var(--wp--preset--color--accent-1)', 'var(--e-global-color-primary)']) assert.equal(layerValue(ref), ref, ref);
  assert.deepEqual(tryValues({ color: 'var(--wp--preset--color--accent-1)', 'background-color': 'var(--ns-pine)' }), { color: 'var(--wp--preset--color--accent-1)', 'background-color': 'var(--ns-pine)' });
});
