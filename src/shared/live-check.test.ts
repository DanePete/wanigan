import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acmePage } from './live-agent-fixture.ts';
import { judge, regionsAfter, verdictText, type WriteCheck } from './live-check.ts';
import { parseTrace } from './live-trace.ts';

const page = acmePage();
const trace = (value: unknown) => parseTrace({
  version: 1, platform: 'wordpress', id: 'aaaaaaaaaaaaaaaa', url: '/', total: { ms: 1 }, parts: [{ id: 'p1', kind: 'field', label: 'Title', edits: ['post-12-title'] }],
  edits: [{ id: 'post-12-title', kind: 'field', label: 'Title of “Home”', via: 'schema', schema: { type: 'string' }, value }],
});

test('a schema edit is read back by the value the reloaded trace holds for it', () => {
  const check: WriteCheck = { kind: 'edit', what: 'Title of “Home”', traceId: 'bbbbbbbbbbbbbbbb', target: { id: 'post-12-title', sent: 'Hello', old: 'Home' }, watched: [], scan: page };
  assert.deepEqual(judge(check, trace('Hello'), []), { kind: 'landed', by: 'value' });
  assert.deepEqual(judge(check, trace('Home'), []), { kind: 'unchanged', by: 'value' });
  assert.deepEqual(judge(check, trace('hello'), []), { kind: 'stored-as', value: 'hello' });
  assert.equal(verdictText(check, { kind: 'unchanged', by: 'value' }).tone, 'warn');
  assert.match(verdictText(check, { kind: 'unchanged', by: 'value' }).text, /^The site said it saved Title of “Home”, but after reloading it holds the old value/);
});

test('anything else is read back by what the watched parts show after the reload, found again on the new page', () => {
  const hero = page[4]!;
  const teaser = page[6]!;
  const check: WriteCheck = { kind: 'move', what: 'Search', traceId: null, watched: [{ region: hero, print: 'h1' }, { region: teaser, print: 't1' }], scan: page };
  // The reloaded page lists its regions again, in another order: the same parts are found by what they are.
  const reloaded = [...page].reverse().map((r, i) => ({ ...r, index: 100 + i }));
  assert.deepEqual(regionsAfter(check, reloaded).map((r) => r?.entity ?? r?.component), ['acme:hero', 'node:store:12:teaser']);
  assert.deepEqual(judge(check, null, ['h1', 't2']), { kind: 'landed', by: 'page' });
  assert.deepEqual(judge(check, null, ['h1', 't1']), { kind: 'unchanged', by: 'page' });
  assert.match(verdictText(check, { kind: 'unchanged', by: 'page' }).text, /^The site said it moved Search, but after reloading that part of the page shows exactly what it did before\./);
  assert.deepEqual(judge(check, null, [null, null]), { kind: 'unseen' }, 'gone from the page: not called a success or a failure');
  assert.deepEqual(judge({ ...check, watched: [] }, null, []), { kind: 'unseen' });
});
