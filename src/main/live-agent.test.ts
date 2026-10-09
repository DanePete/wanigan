// The app's side of an agent's look at the live view, with no Electron: the
// core, the settings and the live view are stand-ins that record what was
// asked of them. What it proves: the owner's own view is only ever read, never
// moved; the page is the one the owner sees unless another was asked for; the
// settings' refusals are said in true words; another site is never loaded.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LiveAsk, LiveViewNow, TimedProblem } from '../shared/live-agent.ts';
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/settings.ts';
import { wireLiveAgent } from './live-agent.ts';
import type { RenderOptions, RenderedPage } from './live-view.ts';

const SITE = 'https://acme.ddev.site/';

function app(opts: { settings?: Partial<AppSettings>; now?: LiveViewNow | null; logged?: TimedProblem[] | null; window?: boolean } = {}) {
  const calls: [string, Record<string, unknown>][] = [];
  const renders: { projectId: string; url: string; token: string | null; options: RenderOptions }[] = [];
  const reads: string[] = [];
  const page: RenderedPage = {
    url: `${SITE}about`, title: 'About', width: 375, height: 1200, regions: [], texts: {}, partFound: null, style: null,
    problems: [{ level: 'error', text: '404 GET /x.png', source: 'network' }], image: null, imageRect: null, cut: false,
  };
  const wiring = wireLiveAgent({
    client: async () => ({
      callRaw: async (method, params) => {
        calls.push([method, params as Record<string, unknown>]);
        return method === 'live.site' ? { token: 'f'.repeat(32) } : { ok: true };
      },
    }),
    settings: () => ({ ...DEFAULT_SETTINGS, liveView: true, ...opts.settings }),
    view: {
      render: async (projectId, url, token, options) => { renders.push({ projectId, url, token, options }); return { ...page, url }; },
      now: (id) => { reads.push(`now ${id}`); return opts.now === undefined ? null : opts.now; },
      logged: (id) => { reads.push(`logged ${id}`); return opts.logged ?? null; },
    },
    windowOpen: () => opts.window ?? true,
  });
  const ask = (more: Partial<LiveAsk>): LiveAsk => ({
    id: `a${calls.length}-${renders.length}`, kind: 'render', projectId: 'p1', sessionId: 's1', site: { url: SITE, platform: 'drupal' }, url: null,
    cardPage: null, width: null, capture: 'none', part: null, since: null, shot: null, deadline: Date.now() + 10_000, ...more,
  });
  const answered = async (id: string): Promise<Record<string, unknown>> => {
    for (let i = 0; i < 200; i++) {
      const a = calls.find(([m, p]) => m === 'live.answer' && p.id === id);
      if (a) return a[1];
      await new Promise((ok) => setTimeout(ok, 5));
    }
    throw new Error(`no answer to ${id}`);
  };
  return { wiring, calls, renders, reads, ask, answered };
}

const view = (url: string, more: Partial<LiveViewNow> = {}): LiveViewNow => ({ showing: true, visible: true, url, title: 'X', width: 1280, height: 760, loading: false, ...more });

test('it says it answers, once connected, and ignores what is not a question for it', async () => {
  const a = app();
  a.wiring.onConnected();
  a.wiring.onEvent('board', { projectId: 'p1' });
  a.wiring.onEvent('liveAsk', { id: 7 });
  await new Promise((ok) => setTimeout(ok, 20));
  assert.deepEqual(a.calls.map(([m]) => m), ['live.host']);
});

test('the page the owner is looking at, at their width, rendered in the hidden window; their view is only read', async () => {
  const a = app({ now: view(`${SITE}about?tab=team`) });
  const q = a.ask({});
  a.wiring.onEvent('liveAsk', q);
  const answer = await a.answered(q.id);
  assert.deepEqual(a.renders.map((r) => [r.projectId, r.url, r.token, r.options.width, r.options.screenHeight, r.options.capture, r.options.scan]),
    [['p1', `${SITE}about?tab=team`, 'f'.repeat(32), 1280, 760, 'none', true]]);
  assert.equal((answer.result as { source: string }).source, 'view');
  assert.ok(a.reads.every((r) => r.startsWith('now ') || r.startsWith('logged ')), 'the view is read, never told to go anywhere');
});

test('elsewhere: the page asked for; else the card’s page; else the site; at 1440 unless asked', async () => {
  const other = app({ now: view('https://northwind.example.test/') });
  const card = other.ask({ cardPage: `${SITE}stores` });
  other.wiring.onEvent('liveAsk', card);
  assert.equal(((await other.answered(card.id)).result as { source: string }).source, 'card');
  const asked = other.ask({ url: `${SITE}contact`, width: 375, capture: 'screen' });
  other.wiring.onEvent('liveAsk', asked);
  assert.equal(((await other.answered(asked.id)).result as { source: string }).source, 'asked');
  const none = app();
  const site = none.ask({});
  none.wiring.onEvent('liveAsk', site);
  assert.equal(((await none.answered(site.id)).result as { source: string }).source, 'site');
  assert.deepEqual([...other.renders, ...none.renders].map((r) => [r.url, r.options.width, r.options.capture]),
    [[`${SITE}stores`, 1440, 'none'], [`${SITE}contact`, 375, 'screen'], [SITE, 1440, 'none']]);
});

test('switched off, or off for this kind of site, it says so and loads nothing; another site is never loaded', async () => {
  const off = app({ settings: { liveView: false } });
  const q = off.ask({});
  off.wiring.onEvent('liveAsk', q);
  assert.equal((await off.answered(q.id)).error, 'The live view is off: the owner switches it on in Settings › Live view.');
  const wp = app({ settings: { liveWordpress: false } });
  const w = wp.ask({ site: { url: SITE, platform: 'wordpress' } });
  wp.wiring.onEvent('liveAsk', w);
  assert.equal((await wp.answered(w.id)).error, 'The live view is off for WordPress sites in Settings › Live view.');
  const away = app();
  const x = away.ask({ url: 'https://northwind.example.test/admin' });
  away.wiring.onEvent('liveAsk', x);
  assert.equal((await away.answered(x.id)).error, 'Only pages of this project’s own site are opened.');
  assert.deepEqual([...off.renders, ...wp.renders, ...away.renders], [], 'nothing was loaded');
});

test('status reads the settings and the view; problems add the owner’s console only for the same page; a late question is dropped', async () => {
  const a = app({ settings: { liveShots: true }, now: view(`${SITE}about`), logged: [{ level: 'error', text: 'boom', source: 'console', at: 5 }], window: false });
  const s = a.ask({ kind: 'status' });
  a.wiring.onEvent('liveAsk', s);
  assert.deepEqual((await a.answered(s.id)).result, { on: true, onForSite: true, shots: true, window: false, view: view(`${SITE}about`) });
  const p = a.ask({ kind: 'problems', url: `${SITE}about` });
  a.wiring.onEvent('liveAsk', p);
  const problems = (await a.answered(p.id)).result as { page: unknown[]; view: unknown[] | null };
  assert.equal(problems.page.length, 1);
  assert.deepEqual(problems.view, [{ level: 'error', text: 'boom', source: 'console', at: 5 }]);
  const elsewhere = a.ask({ kind: 'problems', url: `${SITE}contact` });
  a.wiring.onEvent('liveAsk', elsewhere);
  assert.equal(((await a.answered(elsewhere.id)).result as { view: unknown }).view, null, 'the view shows another page');
  const late = a.ask({ deadline: Date.now() - 1 });
  a.wiring.onEvent('liveAsk', late);
  await new Promise((ok) => setTimeout(ok, 30));
  assert.ok(!a.calls.some(([m, prm]) => m === 'live.answer' && prm.id === late.id), 'the core stopped waiting: nothing is rendered or sent');
});
