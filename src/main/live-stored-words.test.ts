// The stored-words calls from the main process, with a stand-in view: what reaches the site (only its own origin,
// with the helper's token, never following a redirect), what is refused before anything is sent, what the page's
// builder marks are read as, and how a reload is waited for. Made-up site (acme); nothing real.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { askStoredWords, builderHints, elementorHints, reloadAndWait, undoStoredWords } from './live-stored-words.ts';
import type { LiveCurrent } from './live-view.ts';

const TOKEN = ['stand', 'in', 'token'].join('-');
const HASH = 'c'.repeat(32);

function view(answer: { status: number; body: unknown }, over: Partial<LiveCurrent> = {}, url = 'https://acme.example.test/trips') {
  const sent: { url: string; init: RequestInit }[] = [];
  const cur = {
    projectId: 'p1', base: 'https://acme.example.test/', token: TOKEN, env: null,
    webContents: {
      isDestroyed: () => false, getURL: () => url,
      session: { fetch: async (u: string, init: RequestInit) => { sent.push({ url: u, init }); return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } }); } },
    },
    ...over,
  } as unknown as LiveCurrent;
  return { cur, sent };
}

const ask = { step: 'find' as const, trace: '0123456789abcdef', content: { type: 'post', id: '12' }, before: 'Book now', after: 'Book a canoe' };

test('the search is asked of the view’s own site, as its user, with the token, never following a redirect; its answer is read strictly', async () => {
  const v = view({ status: 200, body: { ok: true, step: 'find', place: 'post_content#0123456789abcdef', hash: HASH, where: 'this page’s stored content', revisions: true, writer: 'core', cache: null, ask: null, revision: null, undo: null } });
  const a = await askStoredWords(v.cur, ask);
  assert.equal(a.ok, true);
  assert.equal(v.sent.length, 1);
  const [{ url, init }] = v.sent as [{ url: string; init: RequestInit }];
  assert.equal(url, 'https://acme.example.test/_wanigan/words');
  assert.deepEqual([init.method, init.credentials, init.redirect], ['POST', 'include', 'error']);
  assert.equal((init.headers as Record<string, string>)['X-Wanigan-Live'], TOKEN);
  assert.deepEqual(JSON.parse(String(init.body)), ask);
  const refused = await askStoredWords(view({ status: 404, body: { ok: false, error: 'Nowhere.', reason: 'nowhere' } }).cur, ask);
  assert.deepEqual(refused, { ok: false, error: 'Nowhere.', reason: 'nowhere', status: 404 });
});

test('nothing is sent for a hosted environment, without a token, off the site, or for a request that is not one', async () => {
  for (const [over, url] of [[{ env: 'live' }, undefined], [{ token: null }, undefined], [{}, 'https://elsewhere.example.test/']] as [Partial<LiveCurrent>, string | undefined][]) {
    const v = view({ status: 200, body: {} }, over, url);
    const a = await askStoredWords(v.cur, ask);
    assert.equal(a.ok, false);
    if (!url) assert.equal(v.sent.length, 0, JSON.stringify(over));
  }
  const off = view({ status: 200, body: {} }, {}, 'https://elsewhere.example.test/');
  await askStoredWords(off.cur, ask);
  assert.deepEqual(off.sent.map((s) => new URL(s.url).origin), ['https://acme.example.test'], 'off the site, only the site’s own origin is asked');
  const bad = view({ status: 200, body: {} });
  assert.deepEqual(await askStoredWords(bad.cur, { ...ask, content: { type: 'post', id: '1;2' } }), { ok: false, error: 'That is not content Wanigan can look in.', reason: 'refused', status: 0 });
  assert.equal(bad.sent.length, 0);
  assert.deepEqual(await undoStoredWords(bad.cur, '../../x'), { ok: false, error: 'That can no longer be undone here.' });
  assert.equal(bad.sent.length, 0);
  const undo = view({ status: 200, body: { ok: true, revision: 902 } });
  assert.deepEqual(await undoStoredWords(undo.cur, '7e'.repeat(12)), { ok: true, revision: '902' });
  assert.deepEqual([undo.sent[0]?.url, JSON.parse(String(undo.sent[0]?.init.body))], ['https://acme.example.test/_wanigan/undo', { undo: '7e'.repeat(12) }]);
});

test('a page builder’s marks around the words are read in the page and passed on checked; a reload is waited for', async () => {
  assert.match(elementorHints('s1'), /\[data-wl-edit~="s1"\]/);
  const run = (answer: unknown) => async <T>(_code: string, _fallback: T): Promise<T> => answer as T;
  assert.deepEqual(await builderHints(run({ documents: ['42', '7'], element: '3f2a1b0' }), 's1'), { elementor: { documents: ['42', '7'], element: '3f2a1b0' } });
  assert.deepEqual(await builderHints(run({ documents: ['42 OR 1', 7], element: '<b>' }), 's1'), undefined, 'what is not an id is dropped');
  assert.equal(await builderHints(run(null), 's1'), undefined);
  assert.equal(await builderHints(run({ documents: ['1'] }), 'Not An Edit'), undefined, 'only an edit’s id goes into the page');

  const wc = Object.assign(new EventEmitter(), { isDestroyed: () => false, reloadIgnoringCache: () => { setTimeout(() => wc.emit('did-finish-load'), 5); } });
  assert.equal(await reloadAndWait(wc as never, 1_000), true);
  assert.equal(wc.listenerCount('did-finish-load'), 0, 'no listener left behind');
  const failing = Object.assign(new EventEmitter(), { isDestroyed: () => false, reloadIgnoringCache: () => { setTimeout(() => failing.emit('did-fail-load', {}, -105, 'name not resolved', 'x', true), 5); } });
  assert.equal(await reloadAndWait(failing as never, 1_000), false);
  const slow = Object.assign(new EventEmitter(), { isDestroyed: () => false, reloadIgnoringCache: () => {} });
  assert.equal(await reloadAndWait(slow as never, 20), false, 'a page that never loads is not waited for past the deadline');
});
