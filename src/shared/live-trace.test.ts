import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRACE_LIMITS, parseTrace } from './live-trace.ts';

const base = {
  version: 1, platform: 'drupal', id: '0123456789abcdef', url: '/node/12', at: 1760000000000,
  total: { ms: 182, queries: 64, queryMs: 21 },
  parts: [
    {
      id: 'p1', kind: 'entity', label: 'Article 12',
      source: { file: 'web/themes/custom/acme/templates/node--article.html.twig', line: 1, owner: 'yours', package: 'acme' },
      chain: [{ hook: 'preprocess_node', by: 'acme', callback: 'acme_preprocess_node', ms: 0.4, changed: ['title_suffix'] }],
      variables: [{ name: 'label', type: 'array', preview: 'Spring open house', edit: 'e1' }, { name: 'secret', type: 'string', preview: 'x'.repeat(900) }],
      cache: { tags: ['node:12'], contexts: ['user.permissions'], maxAge: 'permanent', status: 'miss' },
      cost: { ms: 12, queries: 3 },
      edits: ['e1', 'missing'],
      alternatives: [{ name: 'node--article--full', exists: false }, { name: 'node--article', exists: true, chosen: true, file: 'web/themes/custom/acme/templates/node--article.html.twig' }],
    },
  ],
  edits: [{ id: 'e1', kind: 'field', label: 'Title (node 12)', via: 'native-form', revisions: true }],
};

test('a well-formed trace is kept as given', () => {
  const t = parseTrace(base);
  assert.ok(t);
  assert.equal(t.parts[0]?.source?.owner, 'yours');
  assert.deepEqual(t.parts[0]?.edits, ['e1'], 'an edit id with no target is dropped');
  assert.equal(t.parts[0]?.variables?.[0]?.edit, 'e1');
  assert.equal(t.parts[0]?.variables?.[1]?.preview.length, TRACE_LIMITS.preview, 'previews are bounded');
  assert.equal(t.parts[0]?.alternatives?.find((a) => a.chosen)?.name, 'node--article');
  assert.equal(t.edits[0]?.via, 'native-form');
  assert.equal(t.truncated, undefined);
});

test('what is not a trace is refused, not repaired', () => {
  assert.equal(parseTrace(null), null);
  assert.equal(parseTrace({ ...base, version: 2 }), null);
  assert.equal(parseTrace({ ...base, platform: 'joomla' }), null);
  assert.equal(parseTrace({ ...base, id: 'not-hex' }), null);
  assert.equal(parseTrace({ ...base, url: 'https://elsewhere.example/node/12' }), null, 'a trace is for a path on the site itself');
  assert.equal(parseTrace({ ...base, url: '//elsewhere.example/' }), null);
});

test('absolute or climbing source paths are dropped', () => {
  const t = parseTrace({ ...base, parts: [{ id: 'p1', kind: 'template', label: 'x', source: { file: '/var/www/html/web/index.php', owner: 'core' } }, { id: 'p2', kind: 'template', label: 'y', source: { file: 'web/../../etc/passwd', owner: 'core' } }] });
  assert.equal(t?.parts[0]?.source, undefined);
  assert.equal(t?.parts[1]?.source, undefined);
});

test('unknown kinds are dropped and long lists are cut and said to be', () => {
  const parts = Array.from({ length: TRACE_LIMITS.parts + 5 }, (_, i) => ({ id: `p${i}`, kind: i === 0 ? 'mystery' : 'block', label: `Block ${i}` }));
  const t = parseTrace({ ...base, parts });
  assert.equal(t?.parts.length, TRACE_LIMITS.parts - 1);
  assert.deepEqual(t?.truncated, ['parts']);
});

test('collections keep only their own parts, known palette entries and known move targets', () => {
  const t = parseTrace({
    ...base,
    parts: [...base.parts, { id: 'b1', kind: 'block', label: 'Search' }, { id: 'b2', kind: 'block', label: 'Menu' }],
    palette: [{ id: 'pal-hero', kind: 'component', label: 'Hero', by: 'acme' }, { id: 'pal-bad', kind: 'gadget', label: 'x' }],
    collections: [
      { id: 'c-sidebar', kind: 'region-blocks', label: 'Sidebar blocks', items: ['b1', 'b2', 'ghost'], movesTo: ['c-footer', 'c-nowhere', 'c-sidebar'], inserts: ['pal-hero', 'pal-bad'], changes: 'configuration', reach: 41 },
      { id: 'c-footer', kind: 'region-blocks', label: 'Footer blocks', items: [], changes: 'configuration' },
      { id: 'c-odd', kind: 'region-blocks', label: 'No changes field', items: [] },
    ],
  });
  assert.deepEqual(t?.palette?.map((p) => p.id), ['pal-hero']);
  assert.equal(t?.collections?.length, 2, 'a collection that does not say what it changes is dropped');
  const side = t?.collections?.[0];
  assert.deepEqual(side?.items, ['b1', 'b2'], 'an item that is not a part of the trace is dropped');
  assert.deepEqual(side?.movesTo, ['c-footer'], 'unknown and self move targets are dropped');
  assert.deepEqual(side?.inserts, ['pal-hero']);
  assert.equal(side?.changes, 'configuration');
  assert.equal(side?.reach, 41);
});

test('a part keeps the libraries it attached, bounded, and nothing that is not a name', () => {
  const t = parseTrace({ ...base, parts: [{ id: 'p1', kind: 'component', label: 'Hero', libraries: ['core/components.acme--hero', '', 7, 'x'.repeat(300), ...Array.from({ length: 120 }, (_, i) => `acme/l${i}`)] }, { id: 'p2', kind: 'block', label: 'Search', libraries: 'core/drupal' }] });
  assert.equal(t?.parts[0]?.libraries?.[0], 'core/components.acme--hero');
  assert.equal(t?.parts[0]?.libraries?.[1]?.length, 200, 'a name is bounded');
  assert.equal(t?.parts[0]?.libraries?.length, 100, 'the list is bounded');
  assert.equal(t?.parts[1]?.libraries, undefined, 'not a list: dropped');
});
