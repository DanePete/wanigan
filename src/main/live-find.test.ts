// The Go to launcher's main-process side against a stand-in site helper on
// this machine's loopback: what is asked, with which token, what is kept, and
// what each kind of failure is called. Made-up site (acme); nothing real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LiveFindAnswer } from '../shared/live-goto.ts';
import type { LiveSite } from '../shared/live.ts';
import { DEFAULT_SETTINGS } from '../shared/settings.ts';
import { wireLiveFind } from './live-find.ts';

// Plainly not a key: the helper's real token is random hex the core keeps.
const TOKEN = ['stand', 'in', 'token'].join('-');

const INDEX = {
  cacheId: 'v1',
  items: [
    { id: 'route:system.admin_content', kind: 'admin', label: 'Content', url: '/admin/content', trail: ['Content'] },
    { id: 'node:12', kind: 'content', label: 'Spring open house', url: '/events/spring-open-house', edit: '/node/12/edit' },
    { id: 'away', kind: 'admin', label: 'Elsewhere', url: 'https://elsewhere.example/admin' },
  ],
};

interface Seen { path: string; token: string | undefined }

async function helperSite(answer: (req: IncomingMessage, res: ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? '', token: req.headers['x-wanigan-live'] as string | undefined });
    answer(req, res);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return { url, seen, close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }) };
}

const json = (res: ServerResponse, body: unknown, status = 200): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

function wire(site: Partial<LiveSite> & { url: string | null }, over: { enabled?: boolean; now?: () => number; trusted?: boolean; cookies?: () => { name: string; value: string }[] } = {}) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const opened: string[] = [];
  const full: LiveSite = {
    projectId: 'p1', platform: 'drupal', servedPath: null, servedCard: null, candidates: [], ddev: null,
    helper: { kind: 'drupal', version: 2, outdated: false }, helperPlan: null, token: TOKEN, ...site,
  };
  wireLiveFind({
    ipc: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); } } as never,
    openExternal: async (url) => { opened.push(url); },
    window: () => null,
    trusted: (event) => (event as unknown as { ok: boolean }).ok,
    enabled: () => over.enabled ?? true,
    settings: () => ({ ...DEFAULT_SETTINGS, liveView: over.enabled ?? true }),
    client: async () => ({ callRaw: async (method: string) => { assert.equal(method, 'live.site'); return full; } }),
    current: () => null,
    run: async <T,>(_code: string, fallback: T) => fallback,
    sessionFor: () => ({ fetch: (input: string | Request, init?: RequestInit) => fetch(input, init), cookies: { get: async () => over.cookies?.() ?? [] } }) as never,
    ...(over.now ? { now: over.now } : {}),
  });
  const event = { ok: over.trusted ?? true };
  const find = (q = '', refresh = false) => (handlers.get('live:find') as (...a: unknown[]) => Promise<LiveFindAnswer>)(event, 'p1', q, refresh ? { refresh: true } : null);
  const openInBrowser = (path: unknown) => (handlers.get('live:openInBrowser') as (...a: unknown[]) => Promise<boolean>)(event, 'p1', path);
  return { find, openInBrowser, opened, handlers };
}

test('the index is asked of the site’s own origin with the helper’s token, and checked', async () => {
  const site = await helperSite((req, res) => {
    if (req.url === '/_wanigan/changed') return json(res, { changed: 5 });
    if (req.url === '/_wanigan/find') return json(res, INDEX);
    json(res, {}, 404);
  });
  try {
    const { find } = wire({ url: site.url });
    const a = await find();
    assert.equal(a.state, 'ready');
    assert.equal(a.origin, new URL(site.url).origin);
    assert.deepEqual(a.result?.items.map((i) => i.id), ['route:system.admin_content', 'node:12'], 'another site’s address is dropped');
    assert.ok(site.seen.every((s) => s.token === TOKEN), 'every request carries the token');
    assert.deepEqual(site.seen.map((s) => s.path), ['/_wanigan/changed', '/_wanigan/find']);
  } finally { await site.close(); }
});

test('the index is kept until the helper’s change counter moves, it grows old, or the owner refreshes', async () => {
  let changed = 1;
  let now = 1_000_000;
  const site = await helperSite((req, res) => {
    if (req.url === '/_wanigan/changed') return json(res, { changed });
    if (req.url === '/_wanigan/find') return json(res, INDEX);
    json(res, {}, 404);
  });
  const finds = (): number => site.seen.filter((s) => s.path === '/_wanigan/find').length;
  try {
    const { find } = wire({ url: site.url }, { now: () => now });
    await find();
    assert.equal(finds(), 1);
    await find();
    assert.equal(site.seen.length, 2, 'opened again at once: nothing asked');
    now += 10_000;
    await find();
    assert.equal(finds(), 1, 'the counter has not moved: the index is kept');
    changed = 2;
    now += 10_000;
    await find();
    assert.equal(finds(), 2, 'content changed: asked again');
    now += 10 * 60_000;
    await find();
    assert.equal(finds(), 3, 'old: asked again, whatever the counter says');
    await find('', true);
    assert.equal(finds(), 4, 'Refresh asks again');
  } finally { await site.close(); }
});

test('logging in or out in the view asks for the index again: it lists what that user may open', async () => {
  let jar: { name: string; value: string }[] = [{ name: '_ga', value: 'GA1.1' }];
  const site = await helperSite((req, res) => {
    if (req.url === '/_wanigan/changed') return json(res, { changed: 1 });
    if (req.url === '/_wanigan/find') return json(res, INDEX);
    json(res, {}, 404);
  });
  const finds = (): number => site.seen.filter((s) => s.path === '/_wanigan/find').length;
  try {
    const { find } = wire({ url: site.url }, { now: () => 1_000_000, cookies: () => jar });
    await find();
    jar = [...jar, { name: '_ga', value: 'GA1.2' }];
    await find();
    assert.equal(finds(), 1, 'a cookie that is not a login changes nothing');
    jar = [...jar, { name: 'SSESSabc123', value: 'logged-in' }];
    await find();
    assert.equal(finds(), 2, 'logged in: asked again');
    await find();
    assert.equal(finds(), 2, 'still logged in as the same user: kept');
    jar = jar.filter((c) => !c.name.startsWith('SSESS'));
    await find();
    assert.equal(finds(), 3, 'logged out: asked again');
  } finally { await site.close(); }
});

test('a search asks the helper with the words and the limit, and is not kept', async () => {
  const site = await helperSite((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/_wanigan/find' && u.searchParams.get('q')) {
      return json(res, { cacheId: 'v1', total: 1, items: [{ id: 'node:40', kind: 'content', label: `Spring ${u.searchParams.get('q')}`, url: '/spring' }] });
    }
    json(res, {}, 404);
  });
  try {
    const { find } = wire({ url: site.url });
    const a = await find('open   house');
    assert.equal(a.state, 'ready');
    assert.equal(a.result?.items[0]?.label, 'Spring open house');
    assert.deepEqual(site.seen.map((s) => s.path), ['/_wanigan/find?q=open%20house&limit=50']);
  } finally { await site.close(); }
});

test('each failure is named: an old helper, a refused token, an error, a bad answer, a site that is not there', async () => {
  const cases: [string, (res: ServerResponse) => void, LiveFindAnswer['state']][] = [
    ['an older helper', (res) => json(res, {}, 404), 'outdated'],
    ['a refused token', (res) => json(res, {}, 403), 'refused'],
    ['a PHP error', (res) => { res.writeHead(500); res.end('Fatal error'); }, 'failed'],
    ['not JSON', (res) => { res.writeHead(200); res.end('<html>'); }, 'failed'],
    ['not the contract', (res) => json(res, { items: 'no' }), 'failed'],
  ];
  for (const [name, reply, state] of cases) {
    const site = await helperSite((req, res) => (req.url === '/_wanigan/changed' ? json(res, { changed: 1 }) : reply(res)));
    try {
      const a = await wire({ url: site.url }).find();
      assert.equal(a.state, state, name);
      assert.ok(a.message, `${name} says why`);
      assert.equal(a.result, null);
    } finally { await site.close(); }
  }
  const gone = await helperSite((_req, res) => json(res, {}));
  const url = gone.url;
  await gone.close();
  const a = await wire({ url }).find();
  assert.equal(a.state, 'down');
  assert.match(a.message ?? '', /Nothing answered at 127\.0\.0\.1/);
});

test('a redirect is not followed, so the token never goes anywhere else', async () => {
  const elsewhere = await helperSite((_req, res) => json(res, INDEX));
  const site = await helperSite((_req, res) => { res.writeHead(302, { Location: `${elsewhere.url}_wanigan/find` }); res.end(); });
  try {
    const a = await wire({ url: site.url }).find();
    assert.equal(a.state, 'failed');
    assert.deepEqual(elsewhere.seen, []);
  } finally { await site.close(); await elsewhere.close(); }
});

test('without a helper, a site, the live view or a trusted window, nothing is asked', async () => {
  const site = await helperSite((_req, res) => json(res, INDEX));
  try {
    assert.equal((await wire({ url: site.url, helper: null, token: null }).find()).state, 'no-helper');
    assert.equal((await wire({ url: site.url, platform: 'site' }).find()).state, 'no-helper');
    assert.equal((await wire({ url: null }).find()).state, 'no-site');
    assert.equal((await wire({ url: site.url }, { enabled: false }).find()).state, 'off');
    assert.equal((await wire({ url: site.url }, { trusted: false }).find()).state, 'failed');
    assert.deepEqual(site.seen, []);
  } finally { await site.close(); }
});

test('the default browser opens a path of the project’s own site, and nothing else', async () => {
  const { openInBrowser, opened } = wire({ url: 'https://acme.example.test/' });
  assert.equal(await openInBrowser('/about?x=1'), true);
  for (const bad of ['https://elsewhere.example/', '//elsewhere.example/x', 'javascript:alert(1)', 'about', 42]) assert.equal(await openInBrowser(bad), false, String(bad));
  assert.deepEqual(opened, ['https://acme.example.test/about?x=1']);
});
