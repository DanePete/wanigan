// The site's colours for Try a style, from the main process's side: the palette asked of a WordPress helper only, on
// the site's origin with its token and nowhere else; Drupal's none in core said without asking; an older helper, a
// refusal and a site that does not answer each said as what it is; the page's tokens and used colours checked.
// A stand-in view and site: made-up colours only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LiveTraceAnswer } from '../shared/live-lens.ts';
import type { LiveTrace } from '../shared/live-trace.ts';
import { askSitePalette, siteColoursNow, type SiteFetch } from './live-site-colours.ts';
import type { LiveCurrent } from './live-view.ts';

const TOKEN = 'cd'.repeat(24);
const PALETTE = { version: 1, platform: 'wordpress', palette: [{ slug: 'pine', name: 'Pine', color: '#2f5d50', origin: 'theme' }], notYet: [] };
const PAGE = {
  tokens: [{ name: '--wp--preset--color--pine', value: '#2f5d50', on: 'root' }, { name: '--fn-ink', value: '#1d2a3a', on: 'root' }],
  used: [{ value: 'rgb(247, 244, 238)', as: 'background', weight: 1000, elements: 1 }],
};

function view(over: { url?: string; token?: string | null; env?: string | null; platform?: 'wordpress' | 'drupal' | null; answer?: (url: string, init: RequestInit) => Promise<Response> } = {}) {
  const asked: { url: string; init: RequestInit }[] = [];
  const ran: string[] = [];
  const cur = {
    projectId: 'p1', base: 'https://fieldnotes.example.test/', token: over.token === undefined ? TOKEN : over.token, env: over.env ?? null,
    webContents: { getURL: () => over.url ?? 'https://fieldnotes.example.test/trails' },
  } as unknown as LiveCurrent;
  const fetch: SiteFetch = async (url, init) => {
    asked.push({ url, init });
    return over.answer ? over.answer(url, init) : new Response(JSON.stringify(PALETTE), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const platform = over.platform === undefined ? 'wordpress' : over.platform;
  const trace = async (): Promise<LiveTraceAnswer> => (platform ? { state: 'ok', trace: { platform } as LiveTrace } : { state: 'missing' });
  const options = {
    current: () => cur, trace, fetchFor: () => fetch,
    run: async <T>(code: string, fallback: T): Promise<T> => { ran.push(code); return (code.includes('layerColors') ? PAGE : fallback) as T; },
  };
  return { asked, ran, options };
}

test('a WordPress page asks its helper for the palette, on the site’s origin with the helper’s token, never following a redirect', async () => {
  const v = view();
  const got = await siteColoursNow(v.options);
  assert.equal(v.asked.length, 1);
  assert.equal(v.asked[0]?.url, 'https://fieldnotes.example.test/_wanigan/palette');
  assert.equal((v.asked[0]?.init.headers as Record<string, string>)['X-Wanigan-Live'], TOKEN);
  assert.equal(v.asked[0]?.init.redirect, 'error');
  assert.equal(got.palette.state, 'ok');
  assert.deepEqual(got.palette.state === 'ok' ? got.palette.colours.map((c) => c.ref) : [], ['--wp--preset--color--pine']);
  assert.deepEqual(got.tokens.map((t) => t.name), ['--fn-ink'], 'the preset’s own custom property is the palette’s, shown once');
  assert.equal(got.used.length, 1);
  assert.ok(v.ran.some((c) => c.includes('layerColors')), 'the page script read the tokens and the colours used');
});

test('Drupal core has no palette registry: said without asking the helper, the theme’s tokens still read', async () => {
  const v = view({ platform: 'drupal' });
  const got = await siteColoursNow(v.options);
  assert.deepEqual(got.palette, { state: 'none', platform: 'drupal' });
  assert.equal(v.asked.length, 0);
  assert.equal(got.tokens.length, 2);
});

test('no helper, a hosted environment, or no trace yet: the palette is not asked, and what is missing is said', async () => {
  for (const [over, state] of [[{ token: null }, 'no-helper'], [{ env: 'live' }, 'no-helper'], [{ platform: null }, 'no-trace']] as const) {
    const v = view(over);
    const got = await siteColoursNow(v.options);
    assert.equal(got.palette.state, state, JSON.stringify(over));
    assert.equal(v.asked.length, 0, `${JSON.stringify(over)}: nothing asked with the token`);
  }
  const away = view({ url: 'https://elsewhere.example.test/' });
  assert.deepEqual(await siteColoursNow(away.options), { palette: { state: 'no-helper' }, tokens: [], used: [] }, 'a page off the site is not read at all');
  assert.equal(away.ran.length + away.asked.length, 0);
});

test('an older helper, a refusal, a site that does not answer and an answer past the contract are each said as what they are', async () => {
  const ask = (answer: () => Promise<Response>) => askSitePalette(async () => answer(), 'https://fieldnotes.example.test', TOKEN);
  assert.deepEqual(await ask(async () => new Response('<html>Not found</html>', { status: 404 })), { state: 'outdated' });
  assert.deepEqual(await ask(async () => new Response('', { status: 403 })), { state: 'refused', status: 403 });
  assert.deepEqual(await ask(async () => new Response('', { status: 500 })), { state: 'down', error: 'it answered 500' });
  assert.deepEqual(await ask(async () => { throw new Error('connection refused'); }), { state: 'down', error: 'connection refused' });
  assert.deepEqual(await ask(async () => new Response('<html>a theme’s page</html>', { status: 200 })), { state: 'outdated' });
  assert.deepEqual(await ask(async () => new Response(JSON.stringify({ version: 9 }), { status: 200 })), { state: 'unreadable' });
  assert.deepEqual(await ask(async () => new Response('x'.repeat(600 * 1024), { status: 200 })), { state: 'unreadable' });
});
