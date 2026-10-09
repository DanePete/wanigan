import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileLayer, layerBreakpoints, layerEdit, layerSelector, layerValue, type LayerEdit } from './design-layer.ts';

const edit = (over: Partial<LayerEdit> & { id: string }): LayerEdit => ({
  target: { kind: 'component', name: 'acme:hero', path: [0] }, scope: 'this', breakpoint: 'all',
  change: { type: 'style', values: { color: '#123456' } }, before: {}, state: 'draft', by: 'owner', at: 1, ...over,
});

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

test('an edit from outside is checked field by field, and says why it is refused', () => {
  const good = layerEdit({ id: 'e1', target: { kind: 'entity', entityType: 'node', uuid: 'aaaa-bbbb', field: 'title', delta: 0, langcode: 'en' }, scope: 'this', breakpoint: 'all', change: { type: 'style', values: { 'font-size': '2rem' } } });
  assert.equal(good.refused, null);
  assert.deepEqual(good.edit?.change, { type: 'style', values: { 'font-size': '2rem' } });
  assert.equal(good.edit?.state, 'draft');
  assert.equal(good.edit?.by, 'owner');
  const why = (raw: unknown): string => layerEdit(raw).refused ?? '';
  assert.match(why({ id: 'E 1' }), /id/);
  assert.match(why({ id: 'e1', target: { kind: 'xpath', path: '/html' } }), /target/);
  assert.match(why({ id: 'e1', target: { kind: 'config', type: 'block', id: 'acme_branding' }, scope: 'everywhere' }), /scope/);
  assert.match(why({ id: 'e1', target: { kind: 'config', type: 'block', id: 'b' }, scope: 'this', breakpoint: 'all', change: { type: 'style', values: { position: 'fixed' } } }), /does not set position/);
  assert.match(why({ id: 'e1', target: { kind: 'config', type: 'block', id: 'b' }, scope: 'this', breakpoint: 'all', change: { type: 'style', values: { color: 'red; x: y' } } }), /not a value/);
  assert.match(why({ id: 'e1', target: { kind: 'config', type: 'block', id: 'b' }, scope: 'this', breakpoint: 'all', change: { type: 'token', name: '--accent', value: 'red' } }), /whole site/);
  assert.match(why({ id: 'e1', target: { kind: 'config', type: 'block', id: 'b' }, scope: 'site', breakpoint: 'all', change: { type: 'style', values: { color: 'red' } } }), /whole site/);
  assert.match(why({ id: 'e1', target: { kind: 'config', type: 'block', id: 'b' }, scope: 'site', breakpoint: 'all', change: { type: 'token', name: 'accent', value: 'red' } }), /--name/);
  assert.match(why({ id: 'e1', target: { kind: 'entity', entityType: 'media', uuid: 'u', field: 'field_media_image', delta: 0, langcode: null }, scope: 'this', breakpoint: 'all', change: { type: 'image', asset: '../../etc/passwd', alt: null } }), /asset/);
  assert.equal(layerEdit({ id: 'e1', target: { kind: 'entity', entityType: 'media', uuid: 'u', field: 'field_media_image', delta: 0, langcode: null }, scope: 'this', breakpoint: 'all', change: { type: 'image', asset: '0123456789abcdef.webp', alt: 'A canoe at dawn' } }).refused, null);
  assert.equal(layerEdit({ id: 'e2', target: { kind: 'config', type: 'block', id: 'b' }, scope: 'this', breakpoint: 'all', change: { type: 'style', values: { color: 'red' } }, by: 'agent', state: 'verified' }).edit?.by, 'agent');
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

test('a value that slipped past the edit check still cannot break out of the sheet', () => {
  const css = compileLayer([edit({ id: 'e1', change: { type: 'style', values: { color: 'red; } body { display: none' } } })], []);
  assert.equal(css, '');
});

test('adding and removing a component are edits too, checked like the rest', () => {
  const at = { kind: 'component', name: 'acme:card', path: [2] };
  const insert = layerEdit({ id: 'e1', target: at, scope: 'this', breakpoint: 'all', change: { type: 'insert', entry: 'sdc:acme:card', collection: 'c.lb.node-12.0.first', index: 1, props: { heading: 'Paddles', featured: true, columns: 3 } } });
  assert.equal(insert.refused, null);
  assert.deepEqual(insert.edit?.change, { type: 'insert', entry: 'sdc:acme:card', collection: 'c.lb.node-12.0.first', index: 1, props: { heading: 'Paddles', featured: true, columns: 3 } });
  const why = (change: unknown): string => layerEdit({ id: 'e1', target: at, scope: 'this', breakpoint: 'all', change }).refused ?? '';
  assert.match(why({ type: 'insert', entry: 'sdc:acme:card', collection: 'c1', index: -1 }), /place/);
  assert.match(why({ type: 'insert', entry: 'sdc:acme:card', collection: 'c1', index: 0, props: { 'bad name': 'x' } }), /not a prop name/);
  assert.match(why({ type: 'insert', entry: 'sdc:acme:card', collection: 'c1', index: 0, props: { items: ['a'] } }), /not a string, number or yes\/no/);
  assert.equal(layerEdit({ id: 'e2', target: at, scope: 'this', breakpoint: 'all', change: { type: 'remove', collection: 'c.r.sidebar' } }).refused, null);
  assert.match(why({ type: 'remove' }), /collection/);
  // Neither is CSS: the preview sheet leaves them to the page script.
  assert.equal(compileLayer([layerEdit({ id: 'e2', target: at, scope: 'this', breakpoint: 'all', change: { type: 'remove', collection: 'c.r.sidebar' } }).edit as LayerEdit], []), '');
});
