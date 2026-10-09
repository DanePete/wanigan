import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFind, samePath } from './live-find.ts';

test('a helper\'s index is kept, with its actions and words', () => {
  const r = parseFind({
    cacheId: 'abc', total: 3,
    items: [
      { id: 'node:12', kind: 'content', label: 'Spring open house', url: '/events/spring-open-house', type: 'Article', status: 'published', changed: 1760000000000, edit: '/node/12/edit', tags: ['article', 'events'], actions: [{ label: 'Layout', url: '/node/12/layout' }] },
      { id: 'route:system.admin_content', kind: 'admin', label: 'Content', url: '/admin/content', trail: ['Content'] },
    ],
  });
  assert.equal(r?.items.length, 2);
  assert.equal(r?.items[0]?.edit, '/node/12/edit');
  assert.deepEqual(r?.items[0]?.actions, [{ label: 'Layout', url: '/node/12/layout' }]);
  assert.equal(r?.total, 3);
});

test('only same-origin paths are kept: another site, a protocol-relative url or a scheme is dropped', () => {
  for (const bad of ['https://elsewhere.example/', '//elsewhere.example/x', 'javascript:alert(1)', '/\\elsewhere.example', 'admin/content', '']) {
    assert.equal(samePath(bad), null, bad);
  }
  const r = parseFind({ cacheId: 'abc', items: [
    { id: 'a', kind: 'admin', label: 'Away', url: 'https://elsewhere.example/' },
    { id: 'b', kind: 'content', label: 'Kept', url: '/kept', edit: 'https://elsewhere.example/edit', actions: [{ label: 'Bad', url: '//x.example' }] },
  ] });
  assert.deepEqual(r?.items.map((i) => i.id), ['b']);
  assert.equal(r?.items[0]?.edit, undefined);
  assert.equal(r?.items[0]?.actions, undefined);
});

test('unknown kinds and answers without a cache id are refused', () => {
  assert.equal(parseFind({ items: [] }), null);
  assert.equal(parseFind(null), null);
  assert.deepEqual(parseFind({ cacheId: 'x', items: [{ id: 'q', kind: 'spaceship', label: 'Nope', url: '/x' }] })?.items, []);
});
