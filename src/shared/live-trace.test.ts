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
