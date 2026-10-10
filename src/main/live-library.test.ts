// The component library's main-process side against a stand-in site helper
// on this machine's loopback: what is asked, with which token, what each
// failure is called, and how pictures are kept in the data folder by the
// library's hash. The capture is a stand-in here (it needs Electron's
// windows); what it is given is checked. Made-up site (acme); nothing real.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LiveSite } from '../shared/live.ts';
import type { LibraryPicturesAnswer, LiveLibraryAnswer, LiveUsageAnswer } from '../shared/live-library.ts';
import { askLibrary, askUsage, libraryWhy, pictureFile, RENDERS_AT_ONCE, wireLiveLibrary, type PieceCapture } from './live-library.ts';

// Plainly not a key: the helper's real token is random hex the core keeps.
const TOKEN = ['stand', 'in', 'token'].join('-');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const library = (hash: string) => ({
  version: 1, platform: 'drupal', hash, at: 1, theme: 'acme', counts: { component: 2, block: 1 },
  entries: [
    { id: 'sdc:acme:card', kind: 'component', label: 'Card', picture: { from: 'example', piece: '/_wanigan/piece/component/acme%3Acard?picture=1' } },
    { id: 'sdc:acme:hero', kind: 'component', label: 'Hero', picture: { from: 'placeholders', piece: '/_wanigan/piece/component/acme%3Ahero?picture=1' } },
    { id: 'block:field_block:node:article:body', kind: 'block', label: 'Body', needs: ['entity:node'], picture: { from: 'none', why: 'It shows the node of the page it is placed on, so it has nothing to show alone.' } },
  ],
});

async function helperSite(answer: (req: IncomingMessage, res: ServerResponse) => void) {
  const seen: { path: string; token: string | undefined }[] = [];
  const server = createServer((req, res) => { seen.push({ path: req.url ?? '', token: req.headers['x-wanigan-live'] as string | undefined }); answer(req, res); });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return { url, seen, close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }) };
}

const json = (res: ServerResponse, body: unknown, status = 200): void => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

test('the library is asked of the helper’s own route with its token, never following a redirect, and each failure is named', async () => {
  let reply: (res: ServerResponse) => void = (res) => json(res, library('0123456789abcdef'));
  const site = await helperSite((req, res) => { if (req.url === '/_wanigan/components') reply(res); else json(res, {}, 404); });
  try {
    const origin = new URL(site.url).origin;
    const ok = await askLibrary((url, init) => fetch(url, init), origin, TOKEN);
    assert.equal(ok.state, 'ok');
    assert.deepEqual(site.seen, [{ path: '/_wanigan/components', token: TOKEN }]);
    assert.equal(ok.state === 'ok' && ok.library.entries.length, 3);
    reply = (res) => json(res, {}, 404);
    assert.deepEqual(await askLibrary((url, init) => fetch(url, init), origin, TOKEN), { state: 'outdated' }, 'an older helper has no such route');
    reply = (res) => json(res, {}, 403);
    assert.deepEqual(await askLibrary((url, init) => fetch(url, init), origin, TOKEN), { state: 'refused', status: 403 });
    reply = (res) => json(res, { version: 1, platform: 'drupal', hash: 'nope', entries: [] });
    assert.deepEqual(await askLibrary((url, init) => fetch(url, init), origin, TOKEN), { state: 'unreadable' });
    reply = (res) => { res.writeHead(302, { Location: 'https://elsewhere.example/' }); res.end(); };
    const moved = await askLibrary((url, init) => fetch(url, init), origin, TOKEN);
    assert.equal(moved.state, 'down', 'a redirect is not followed: the token would go with it');
    assert.match(libraryWhy({ state: 'outdated' }), /Update it from the project’s Live tab/);
  } finally { await site.close(); }
});

function wire(site: { url: string }, over: { version?: number; enabled?: boolean; trusted?: boolean; capture?: PieceCapture } = {}) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const dataDir = mkdtempSync(join(tmpdir(), 'wanigan-library-'));
  const captured: { partition: string; url: string; width: number; base: string }[] = [];
  const partitions: [string, string, string | null][] = [];
  const full: LiveSite = {
    projectId: 'p1', url: site.url, platform: 'drupal', servedPath: null, servedCard: null, candidates: [], ddev: null,
    helper: { kind: 'drupal', version: over.version ?? 4, outdated: false }, helperPlan: null, token: TOKEN,
  };
  wireLiveLibrary({
    ipc: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); } } as never,
    trusted: (event) => (event as unknown as { ok: boolean }).ok,
    enabled: () => over.enabled ?? true,
    client: async () => ({ callRaw: async (method: string) => { assert.equal(method, 'live.site'); return full; } }),
    sessionFor: () => ({ fetch: (input: string | Request, init?: RequestInit) => fetch(input, init) }) as never,
    partition: (id, url, token) => { partitions.push([id, url, token]); return 'persist:wanigan-live-p1'; },
    dataDir,
    capture: over.capture ?? (async (o) => { captured.push(o); return { png: PNG, height: o.width === 390 ? 640 : 410, cut: false }; }),
  });
  const event = { ok: over.trusted ?? true };
  return {
    dataDir, captured, partitions,
    library: (refresh = false) => (handlers.get('live:library') as (...a: unknown[]) => Promise<LiveLibraryAnswer>)(event, 'p1', refresh ? { refresh: true } : null),
    pictures: (entries: unknown, options: unknown = null) => (handlers.get('live:libraryPictures') as (...a: unknown[]) => Promise<LibraryPicturesAnswer>)(event, 'p1', entries, options),
    picture: (entry: string, width: number) => (handlers.get('live:libraryPicture') as (...a: unknown[]) => Promise<string | null>)(event, 'p1', entry, width),
    usage: (entry: unknown, refresh = false) => (handlers.get('live:libraryUsage') as (...a: unknown[]) => Promise<LiveUsageAnswer>)(event, 'p1', entry, refresh ? { refresh: true } : null),
    done: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

test('pictures are rendered on the helper’s piece route at a phone’s and a desktop’s width, and kept by the library’s hash', async () => {
  let hash = 'aaaaaaaaaaaaaaaa';
  const site = await helperSite((req, res) => (req.url === '/_wanigan/components' ? json(res, library(hash)) : json(res, {}, 404)));
  const w = wire(site);
  try {
    const first = await w.pictures(['sdc:acme:card', 'block:field_block:node:article:body', 'sdc:acme:gone']);
    assert.ok(first.ok);
    const origin = new URL(site.url).origin;
    assert.deepEqual(w.captured.map((c) => [c.url, c.width, c.partition, c.base]), [
      [`${origin}/_wanigan/piece/component/acme%3Acard?picture=1`, 390, 'persist:wanigan-live-p1', site.url],
      [`${origin}/_wanigan/piece/component/acme%3Acard?picture=1`, 1440, 'persist:wanigan-live-p1', site.url],
    ], 'only the entry that can be pictured is rendered, in the view’s own session');
    assert.deepEqual(w.partitions[0], ['p1', site.url, TOKEN], 'the session is prepared with the helper’s token for the site');
    const [phone, desk, body390, , gone] = first.shots;
    assert.deepEqual([phone?.width, phone?.height, phone?.cached, phone?.error], [390, 640, false, null]);
    assert.ok(phone?.path?.startsWith(join(w.dataDir, 'live-library')) && phone.path.includes(`/${hash}/`), 'in Wanigan’s data folder, under the hash');
    assert.ok(phone?.path?.endsWith(pictureFile('sdc:acme:card', 390)));
    assert.deepEqual(readFileSync(phone!.path!), PNG);
    assert.equal(desk?.width, 1440);
    assert.equal(body390?.error, 'It shows the node of the page it is placed on, so it has nothing to show alone.');
    assert.equal(gone?.error, 'There is no such entry in the site’s library now.');
    assert.equal(first.shots.length, 6);

    const again = await w.pictures(['sdc:acme:card'], { widths: [1440] });
    assert.ok(again.ok);
    assert.deepEqual(again.shots.map((s) => [s.width, s.cached, s.height]), [[1440, true, 410]], 'kept for this hash: not rendered again');
    assert.equal(w.captured.length, 2);
    assert.equal(await w.picture('sdc:acme:card', 390), PNG.toString('base64'));

    // The definitions or their files changed: a new hash, new pictures, and the old hash's folder goes.
    hash = 'bbbbbbbbbbbbbbbb';
    assert.equal((await w.library(true)).state, 'ok');
    const after = await w.pictures(['sdc:acme:card'], { widths: [390] });
    assert.ok(after.ok && after.hash === hash && after.shots[0]?.cached === false);
    const folders = readdirSync(join(w.dataDir, 'live-library', readdirSync(join(w.dataDir, 'live-library'))[0]!));
    assert.deepEqual(folders, [hash]);
    assert.equal(existsSync(phone!.path!), false);
  } finally { w.done(); await site.close(); }
});

test('pictures render a few at a time, never more, come back in the order asked, and a failed render frees its window', async () => {
  const site = await helperSite((req, res) => (req.url === '/_wanigan/components' ? json(res, library('dddddddddddddddd')) : json(res, {}, 404)));
  let now = 0, most = 0, fail = false;
  const w = wire(site, { capture: async (o) => {
    now++; most = Math.max(most, now);
    // The first asked finishes last: an answer in finishing order would show it.
    await new Promise((done) => setTimeout(done, o.url.includes('card') && o.width === 390 ? 60 : 10));
    now--;
    if (fail) throw new Error('The piece could not be pictured: the stand-in said no.');
    return { png: PNG, height: o.width, cut: false };
  } });
  try {
    assert.ok(RENDERS_AT_ONCE > 1 && RENDERS_AT_ONCE < 4, 'the test asks for four renders: more than one window and fewer than four');
    const out = await w.pictures(['sdc:acme:card', 'sdc:acme:hero']);
    assert.ok(out.ok);
    assert.equal(most, RENDERS_AT_ONCE, 'as many at once as allowed, and no more');
    assert.deepEqual(out.shots.map((s) => [s.entry, s.width, s.height, s.error]), [
      ['sdc:acme:card', 390, 390, null], ['sdc:acme:card', 1440, 1440, null], ['sdc:acme:hero', 390, 390, null], ['sdc:acme:hero', 1440, 1440, null],
    ]);
    fail = true; most = 0;
    const failed = await w.pictures(['sdc:acme:card', 'sdc:acme:hero'], { refresh: true });
    assert.ok(failed.ok);
    assert.deepEqual(failed.shots.map((s) => s.error), Array(4).fill('The piece could not be pictured: the stand-in said no.'));
    assert.equal(most, RENDERS_AT_ONCE, 'a render that throws still hands its window on');
    fail = false;
    const again = await w.pictures(['sdc:acme:hero'], { refresh: true, widths: [390] });
    assert.ok(again.ok && again.shots[0]?.error === null, 'nothing is left waiting after failures');
  } finally { w.done(); await site.close(); }
});

test('a piece that does not render is said, and nothing is kept for it', async () => {
  const site = await helperSite((_req, res) => json(res, library('cccccccccccccccc')));
  const w = wire(site, { capture: async () => ({ error: 'It rendered nothing on its own: it takes what it shows from the page it is placed on.' }) });
  try {
    const out = await w.pictures(['sdc:acme:hero'], { widths: [390] });
    assert.ok(out.ok);
    assert.deepEqual([out.shots[0]?.path, out.shots[0]?.error], [null, 'It rendered nothing on its own: it takes what it shows from the page it is placed on.']);
    assert.equal(existsSync(join(w.dataDir, 'live-library')), false);
  } finally { w.done(); await site.close(); }
});

test('without the live view, the window’s trust, a current helper or a sound request, nothing is asked', async () => {
  const site = await helperSite((_req, res) => json(res, library('dddddddddddddddd')));
  const off = wire(site, { enabled: false });
  const untrusted = wire(site, { trusted: false });
  const old = wire(site, { version: 3 });
  const fine = wire(site);
  try {
    assert.deepEqual(await off.library(), { state: 'off' });
    assert.deepEqual(await off.pictures(['sdc:acme:card']), { ok: false, error: 'The live view is off.' });
    assert.deepEqual(await untrusted.library(), { state: 'off' });
    assert.deepEqual(await old.library(), { state: 'outdated' }, 'a helper older than version 4 has no library');
    const refused = await old.pictures(['sdc:acme:card']);
    assert.match(refused.ok ? '' : refused.error, /older than this Wanigan/);
    assert.deepEqual(await fine.pictures(['sdc:acme:card'], { widths: [800] }), { ok: false, error: 'Pictures are taken at 390 and 1440 pixels wide.' });
    assert.deepEqual(site.seen.length, 0, 'nothing reached the site');
    assert.equal(fine.captured.length + old.captured.length, 0);
  } finally { for (const w of [off, untrusted, old, fine]) w.done(); await site.close(); }
});

/* ── where an entry is used ─────────────────────────────────────────────── */

const used = (entry: string, places: unknown[] = [{ kind: 'placement', label: 'Main navigation', where: 'Header region, Acme theme', url: '/', edit: '/admin/structure/block/manage/acme_main_menu' }]) => ({
  version: 1, platform: 'drupal', entry, places, found: places.length, complete: true, gaps: [], searched: ['Block placements in every theme, by the block’s plugin.'],
  unseen: ['Pages a placement shows on.'], ms: 40,
});

test('where an entry is used is asked of the helper’s own route with its token and the entry, checked, and each failure named', async () => {
  let reply: (res: ServerResponse) => void = (res) => json(res, used('block:system_menu_block:main'));
  const site = await helperSite((req, res) => { if (req.url?.startsWith('/_wanigan/usage?')) reply(res); else json(res, {}, 404); });
  const ask = (entry = 'block:system_menu_block:main') => askUsage((url, init) => fetch(url, init), new URL(site.url).origin, TOKEN, entry);
  try {
    const ok = await ask();
    assert.equal(ok.state, 'ok');
    assert.deepEqual(site.seen, [{ path: '/_wanigan/usage?entry=block%3Asystem_menu_block%3Amain', token: TOKEN }], 'the entry goes as one encoded query value');
    assert.deepEqual(ok.state === 'ok' && ok.usage.places, [{ kind: 'placement', label: 'Main navigation', where: 'Header region, Acme theme', url: '/', edit: '/admin/structure/block/manage/acme_main_menu' }]);
    reply = (res) => json(res, used('block:system_branding_block'));
    assert.deepEqual(await ask(), { state: 'unreadable' }, 'an answer about another entry is not this one’s');
    reply = (res) => json(res, used('block:system_menu_block:main', [{ kind: 'placement', label: 'Elsewhere', url: 'https://elsewhere.example/' }]));
    const away = await ask();
    assert.deepEqual(away.state === 'ok' && away.usage.places, [{ kind: 'placement', label: 'Elsewhere' }], 'a page on another origin is never kept to be opened');
    reply = (res) => json(res, {}, 404);
    assert.deepEqual(await ask(), { state: 'outdated' }, 'a helper without the route');
    reply = (res) => json(res, { ok: false, error: 'This site’s library has no entry block:system_menu_block:main now: ask the library again.' }, 422);
    assert.deepEqual(await ask(), { state: 'unknown', error: 'This site’s library has no entry block:system_menu_block:main now: ask the library again.' }, 'the helper’s own words');
    reply = (res) => json(res, {}, 403);
    assert.deepEqual(await ask(), { state: 'refused', status: 403 });
    reply = (res) => { res.writeHead(302, { Location: 'https://elsewhere.example/' }); res.end(); };
    assert.equal((await ask()).state, 'down', 'a redirect is not followed: the token would go with it');
    reply = (res) => json(res, used('block:system_menu_block:main', Array.from({ length: 30_000 }, (_, i) => ({ kind: 'content', label: `Post ${i} ${'x'.repeat(60)}` }))));
    assert.deepEqual(await ask(), { state: 'too-large' });
    const before = site.seen.length;
    assert.deepEqual(await ask('block:has space'), { state: 'unknown', error: 'That is not an entry of the library.' });
    assert.equal(site.seen.length, before, 'an id that is not one is not sent');
  } finally { await site.close(); }
});

test('the window asks where an entry is used through the view’s session; the answer is kept half a minute unless asked afresh', async () => {
  let asked = 0;
  const site = await helperSite((req, res) => {
    if (!req.url?.startsWith('/_wanigan/usage?')) { json(res, {}, 404); return; }
    asked++;
    json(res, used(new URL(req.url, 'http://x').searchParams.get('entry') ?? ''));
  });
  const w = wire(site);
  const off = wire(site, { enabled: false });
  const untrusted = wire(site, { trusted: false });
  const old = wire(site, { version: 3 });
  try {
    const first = await w.usage('block:system_menu_block:main');
    assert.equal(first.state, 'ok');
    assert.equal((await w.usage('block:system_menu_block:main')).state, 'ok');
    assert.equal(asked, 1, 'asked again within half a minute, the answer is the one kept');
    assert.equal((await w.usage('block:system_menu_block:main', true)).state, 'ok');
    assert.equal(asked, 2, 'refresh asks the site again');
    assert.equal((await w.usage('sdc:acme:card')).state, 'ok');
    assert.equal(asked, 3, 'another entry is asked about on its own');
    assert.deepEqual(await w.usage('acme:card'), { state: 'unknown', error: 'That is not an entry of the library.' });
    assert.deepEqual(await w.usage(42), { state: 'unknown', error: 'That is not an entry of the library.' });
    assert.deepEqual(await off.usage('block:system_menu_block:main'), { state: 'off' });
    assert.deepEqual(await untrusted.usage('block:system_menu_block:main'), { state: 'off' });
    assert.deepEqual(await old.usage('block:system_menu_block:main'), { state: 'outdated' }, 'a helper older than version 4 is not asked');
    assert.equal(asked, 3, 'none of those reached the site');
    assert.ok(site.seen.every((s) => s.token === TOKEN));
  } finally { for (const x of [w, off, untrusted, old]) x.done(); await site.close(); }
});
