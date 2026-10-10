// The stored-words contract: what a helper's answer to POST /_wanigan/words may be, what the main process sends, and
// which content an edit's part belongs to. Made-up traces (acme, northwind); nothing real.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LiveTrace } from './live-trace.ts';
import { checkStoredAsk, parseStoredAnswer, parseStoredUndone, storedContentOf } from './live-stored-words.ts';

const HASH = 'a'.repeat(32);
const UUID = 'c0ffee00-0000-4000-8000-000000000031';

test('a helper’s answer is read strictly: a place and its hash, or a refusal with its reason; anything else is the site not answering readably', () => {
  assert.deepEqual(parseStoredAnswer({ ok: true, step: 'find', place: 'meta:101#0123456789abcdef', hash: HASH, where: 'this page’s custom field “acme_hero”', revisions: false, writer: 'core', cache: 'A copy may lag.', ask: null, revision: null, undo: null }, 200), {
    ok: true, step: 'find', place: 'meta:101#0123456789abcdef', hash: HASH, where: 'this page’s custom field “acme_hero”', revisions: false, writer: 'core', cache: 'A copy may lag.', ask: null, revision: null, undo: null,
  });
  const saved = parseStoredAnswer({ ok: true, step: 'save', place: 'post_content#0123456789abcdef', hash: HASH, where: 'this page’s stored content', revisions: true, writer: 'core', revision: 900, undo: '0a'.repeat(12) }, 200);
  assert.deepEqual(saved.ok && [saved.revision, saved.undo], ['900', '0a'.repeat(12)]);
  assert.deepEqual(parseStoredAnswer({ ok: false, error: 'Nowhere.', reason: 'nowhere' }, 404), { ok: false, error: 'Nowhere.', reason: 'nowhere', status: 404 });
  assert.equal((parseStoredAnswer({ ok: false, error: 'Odd.', reason: 'other' }, 409) as { reason: string }).reason, 'refused', 'an unknown reason is a refusal');
  for (const bad of [null, [], { ok: true, place: 'meta:1#x', hash: 'nothex', where: 'x', step: 'find' }, { ok: true, place: 'a b', hash: HASH, where: 'x', step: 'find' }, { ok: true, place: 'meta:1', hash: HASH, step: 'find' }]) {
    assert.equal(parseStoredAnswer(bad, 200).ok, false, JSON.stringify(bad));
  }
  assert.equal((parseStoredAnswer({ ok: true, step: 'save', place: 'p', hash: HASH, where: 'x', undo: 'not-a-token' }, 200) as { undo: string | null }).undo, null, 'an undo token is the helpers’ own shape or none');
  const adapted = parseStoredAnswer({ ok: true, step: 'save', place: 'elementor:12#0123456789abcdef', hash: HASH, where: 'the Elementor page “Northwind trips”', writer: 'Elementor', adapter: { id: 'elementor', name: 'Elementor', version: '4.4.0', status: 'unverified' } }, 200);
  assert.deepEqual(adapted.ok && adapted.adapter, { id: 'elementor', name: 'Elementor', version: '4.4.0', status: 'unverified' }, 'the site adapter that saved it');
  const notSaved = parseStoredAnswer({ ok: true, step: 'save', place: 'elementor:12#0123456789abcdef', hash: HASH, where: 'x', adapter: { id: 'elementor', name: 'Elementor', version: '5.0', status: 'broken' } }, 200);
  assert.equal(notSaved.ok && 'adapter' in notSaved, false, 'a broken adapter never saved, so it is not read as one that did');
  assert.deepEqual(parseStoredUndone({ ok: true, revision: 902 }, 200), { ok: true, revision: '902' });
  assert.deepEqual(parseStoredUndone({ ok: false, error: 'It changed again since.' }, 409), { ok: false, error: 'It changed again since.' });
  assert.deepEqual(parseStoredUndone('?', 500), { ok: false, error: 'The site did not put it back (it answered 500).' });
});

test('what is sent is checked first: a trace, content by type and id, bounded words, a found place for a save, hints of the builder’s shape', () => {
  const ask = { step: 'find' as const, trace: '0123456789abcdef', content: { type: 'post', id: '12' }, before: 'Book now', after: 'Book a canoe' };
  assert.deepEqual(checkStoredAsk(ask), ask);
  assert.match(checkStoredAsk({ ...ask, trace: 'nope' }) as string, /no trace/);
  assert.match(checkStoredAsk({ ...ask, content: { type: 'post', id: '12 OR 1' } }) as string, /not content/);
  assert.match(checkStoredAsk({ ...ask, after: 'x'.repeat(2_001) }) as string, /longer than 2,000/);
  assert.match(checkStoredAsk({ ...ask, step: 'save' }) as string, /Where were the words found/);
  assert.deepEqual(checkStoredAsk({ ...ask, step: 'save', place: 'meta:101#0123456789abcdef', hash: HASH }), { ...ask, step: 'save', place: 'meta:101#0123456789abcdef', hash: HASH });
  assert.equal(typeof checkStoredAsk({ ...ask, hints: { elementor: { documents: ['42'], element: '3f2a1b0' } } }), 'object');
  assert.equal(typeof checkStoredAsk({ ...ask, hints: { elementor: { documents: ['42; drop'], element: null } } }), 'string');
});

const wordpress = (): LiveTrace => ({
  version: 1, platform: 'wordpress', id: '0123456789abcdef', url: '/trips', at: 1, total: { ms: 1 }, edits: [],
  parts: [
    { id: 'p1', kind: 'template', label: 'page.html' },
    { id: 'p2', kind: 'entity', label: 'Page: Northwind trips', parent: 'p1', identity: { kind: 'entity', type: 'post', id: '12', bundle: 'page', field: 'post_content' } },
    { id: 'p3', kind: 'block', label: 'Hero', parent: 'p2', identity: { kind: 'block', store: 'post:12', path: [0], name: 'acme/hero' } },
    { id: 'p4', kind: 'block', label: 'Classic', parent: 'p2', identity: { kind: 'block', store: 'post:12', path: [1], name: 'core/freeform' } },
    { id: 'p5', kind: 'block', label: 'Title', parent: 'p1', identity: { kind: 'component', name: 'core/post-title', within: null, nth: 0 }, variables: [{ name: 'context.postId', type: 'int', preview: '12' }] },
    { id: 'p6', kind: 'block', label: 'Footer', parent: 'p1', identity: { kind: 'config', type: 'wp_template_part', id: 'footer' } },
  ],
});

test('the content an edit belongs to: its own part, else the nearest around it', () => {
  const t = wordpress();
  assert.deepEqual(storedContentOf(t, { kind: 'entity', type: 'post', id: '12', bundle: 'page', field: 'post_content' }), { type: 'post', id: '12' }, 'a post’s content itself');
  assert.deepEqual(storedContentOf(t, { kind: 'block', store: 'post:12', path: [1], name: 'core/freeform' }), { type: 'post', id: '12' }, 'classic content in a block');
  assert.deepEqual(storedContentOf(t, { kind: 'block', store: 'post:12', path: [0], name: 'acme/hero' }), { type: 'post', id: '12' }, 'a block stored in the post');
  assert.deepEqual(storedContentOf(t, { kind: 'component', name: 'core/post-title', within: null, nth: 0 }), { type: 'post', id: '12' }, 'the post a block shows through its context');
  assert.equal(storedContentOf(t, { kind: 'config', type: 'wp_template_part', id: 'footer' }), null, 'a template part names no post');
  const drupal: LiveTrace = {
    version: 1, platform: 'drupal', id: 'fedcba9876543210', url: '/trips', at: 1, total: { ms: 1 }, edits: [],
    parts: [
      { id: 'p1', kind: 'entity', label: 'Trip', identity: { kind: 'entity', type: 'node', id: UUID, bundle: 'trip', langcode: 'fr' } },
      { id: 'p2', kind: 'field', label: 'Acme layout', parent: 'p1', identity: { kind: 'entity', type: 'node', id: UUID, bundle: 'trip', langcode: 'fr', field: 'field_acme_layout' } },
      { id: 'p3', kind: 'component', label: 'Card', parent: 'p2', identity: { kind: 'component', name: 'acme:card', within: null, nth: 0 } },
    ],
  };
  assert.deepEqual(storedContentOf(drupal, { kind: 'entity', type: 'node', id: UUID, bundle: 'trip', langcode: 'fr', field: 'field_acme_layout' }), { type: 'node', id: UUID, langcode: 'fr', field: 'field_acme_layout' }, 'the field the page marked, as a hint');
  assert.deepEqual(storedContentOf(drupal, { kind: 'component', name: 'acme:card', within: null, nth: 0 }), { type: 'node', id: UUID, langcode: 'fr' }, 'a component in a field: its entity, without a parent’s field');
});
