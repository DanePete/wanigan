// The design layer's last word saves, with stand-ins: words nothing the page offers to edit holds, looked for where
// the content keeps them through the helper's stored-words search (POST /_wanigan/words, played here by a stand-in
// site), saved there, read back on the reloaded page, and put back with Undo. A fake ipc and core, and a page script
// played by a small model of a page, as in live-layer.test.ts. What is checked is what reached the site and the
// core, in which order, and what the owner is told. Made-up site (acme, northwind); nothing real.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { layerTextHash, type LayerEdit, type LayerImplemented, type LayerUndone } from '../shared/design-layer.ts';
import type { StoredUndone, StoredWordsAnswer, StoredWordsAsk } from '../shared/live-stored-words.ts';
import type { EditTarget, LiveTrace, PartIdentity } from '../shared/live-trace.ts';
import { storedSaid, wireLiveLayer } from './live-layer.ts';
import type { HelperSaved, SaveAt } from './live-view.ts';

const TOKEN = ['stand', 'in', 'token'].join('-');
const BASE = 'https://acme.example.test/';
const HASH = 'b'.repeat(32);
const UNDO = '7e'.repeat(12);
const UUID = 'c0ffee00-0000-4000-8000-000000000031';

const postContent: PartIdentity = { kind: 'entity', type: 'post', id: '12', bundle: 'page', field: 'post_content' };
const hero: PartIdentity = { kind: 'block', store: 'post:12', path: [0], name: 'acme/hero' };
/** A WordPress page whose content an "acme builder" renders: its words are in the post, offered by no edit target. */
const wordpress = (edits: EditTarget[] = []): LiveTrace => ({
  version: 1, platform: 'wordpress', id: '0123456789abcdef', url: '/trips', at: 1, total: { ms: 1 }, edits,
  parts: [
    { id: 'w1', kind: 'entity', label: 'Page 12: Northwind trips', identity: postContent },
    { id: 'w2', kind: 'block', label: 'Hero', parent: 'w1', identity: hero },
  ],
});
const tripField: PartIdentity = { kind: 'entity', type: 'node', id: UUID, bundle: 'trip', langcode: 'en', field: 'field_acme_layout' };
const drupal = (): LiveTrace => ({
  version: 1, platform: 'drupal', id: 'fedcba9876543210', url: '/trips', at: 1, total: { ms: 1 }, edits: [],
  parts: [
    { id: 'd1', kind: 'entity', label: 'Trip: Northwind trips', identity: { kind: 'entity', type: 'node', id: UUID, bundle: 'trip', langcode: 'en' } },
    { id: 'd2', kind: 'field', label: 'Acme layout', parent: 'd1', identity: tripField },
    { id: 'd3', kind: 'component', label: 'Card', parent: 'd2', identity: { kind: 'component', name: 'acme:card', within: null, nth: 0 } },
  ],
});

let made = 0;
/** A text edit retyping an element's words. */
const retype = (part: PartIdentity, value: string, before: string): LayerEdit => ({
  id: `s${++made}`, label: 'Heading in Hero', page: '/trips', scope: 'this', breakpoint: 'all',
  target: { part, inner: null, selector: null, textHash: layerTextHash(before) }, change: { type: 'text', value }, before: { text: before },
  state: 'draft', by: 'owner', at: 1, verdict: null,
});

interface El { text: string; field?: string }

/** The site's stored-words route, played: what each step answers, and what was asked. */
type Site = (ask: StoredWordsAsk) => StoredWordsAnswer;
const found = (over: Partial<Extract<StoredWordsAnswer, { ok: true }>> = {}): StoredWordsAnswer => ({
  ok: true, step: 'find', place: 'meta:101#0123456789abcdef', hash: HASH, where: 'this page’s custom field “_acme_builder_layout” (in its JSON)', revisions: false,
  writer: 'core', cache: 'If a plugin or theme shows these words from a copy of its own (a cache), the page can show the old words until that copy is made again.', ask: null, revision: null, undo: null, ...over,
});
const saved = (over: Partial<Extract<StoredWordsAnswer, { ok: true }>> = {}): StoredWordsAnswer => found({ step: 'save', undo: UNDO, ...over });
const refused = (reason: Extract<StoredWordsAnswer, { ok: false }>['reason'], error: string, status = 409): StoredWordsAnswer => ({ ok: false, error, reason, status });

function wire(o: { edits: LayerEdit[]; trace: LiveTrace; site?: Site; undo?: (token: string) => StoredUndone; helper?: (at: SaveAt | undefined) => HelperSaved; afterReload?: () => void; stored?: boolean }) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const dataDir = mkdtempSync(join(tmpdir(), 'wanigan-layer-stored-'));
  let edits = o.edits;
  const marks: { id: string; state: string }[] = [];
  const asks: StoredWordsAsk[] = [];
  const undos: string[] = [];
  const helperSaves: unknown[] = [];
  const order: string[] = [];
  const page = { parts: {} as Record<string, El[]>, set: null as { tags: Record<string, number[]> } | null, found: new Map<string, El[]>(), ran: [] as string[] };
  const run = async <T>(code: string, fallback: T): Promise<T> => {
    const m = /^window\.__wl && window\.__wl\.(\w+) \? window\.__wl\.\1\((.*)\) : null$/s.exec(code);
    if (!m) { page.ran.push(code); return fallback; }
    const [name, args] = [m[1] as string, JSON.parse(`[${m[2]}]`) as unknown[]];
    if (name === 'layerFind') {
      const [specs, keep] = args as [{ id: string; parts: string[] | null; text?: boolean }[], boolean];
      const out: Record<string, { count: number; texts: string[]; plain: boolean[] }> = {};
      const f = new Map<string, El[]>();
      for (const s of specs) {
        const els = (s.parts ?? []).flatMap((p) => page.parts[p] ?? []);
        f.set(s.id, els);
        out[s.id] = { count: els.length, texts: s.text ? els.map((e) => e.text) : [], plain: els.map(() => true) };
      }
      if (keep) page.found = f;
      return out as T;
    }
    if (name === 'layerSet') { page.set = args[0] as typeof page.set; return 1 as T; }
    if (name === 'layerOf') {
      const id = args[0] as string;
      const el = (page.set?.tags[id] ?? []).map((i) => page.found.get(id)?.[i]).find((e): e is El => !!e);
      return (el ? { count: 1, field: el.field ?? null, words: el.text, plain: true } : { count: 0, field: null, words: null, plain: false }) as T;
    }
    return fallback;
  };
  const webContents = { id: 7, getURL: () => `${BASE}trips`, isDestroyed: () => false, insertCSS: async () => 'key', removeInsertedCSS: async () => {}, reloadIgnoringCache: () => { order.push('reload'); }, on: () => webContents };
  const client = {
    callRaw: async (method: string, params: Record<string, unknown>) => {
      if (method === 'live.layer') return { projectId: 'p1', edits, undo: null, redo: null };
      if (method === 'live.layerMark') {
        order.push(`mark ${String(params.state)}`);
        marks.push({ id: params.id as string, state: params.state as string });
        edits = edits.map((e) => (e.id === params.id ? { ...e, state: params.state as LayerEdit['state'] } : e));
        return { projectId: 'p1', edits, undo: null, redo: null };
      }
      if (method === 'live.site') return { projectId: 'p1', url: BASE, token: TOKEN, helper: { kind: o.trace.platform, version: 4, outdated: false } };
      throw new Error(`unexpected ${method}`);
    },
  };
  wireLiveLayer({
    ipc: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); } } as never,
    trusted: () => true, enabled: () => true, client: async () => client as never,
    current: () => ({ projectId: 'p1', base: BASE, token: TOKEN, env: null, webContents: webContents as never }),
    run, trace: async () => ({ state: 'ok', trace: o.trace }),
    helperSave: async (field, before, after, at) => { order.push('helper save'); helperSaves.push([field, before, after, at]); return o.helper ? o.helper(at) : { ok: true, error: null, label: 'x', revision: '9' }; },
    schemaSave: async () => ({ ok: false, error: 'no schema save in this test', revision: null }),
    ...(o.stored === false ? {} : {
      storedWords: async (ask: StoredWordsAsk) => { order.push(ask.step); asks.push(ask); return (o.site ?? ((a) => (a.step === 'find' ? found() : saved())))(ask); },
      storedUndo: async (token: string) => { order.push('undo'); undos.push(token); return o.undo ? o.undo(token) : { ok: true, revision: null }; },
    }),
    reloaded: async () => { order.push('reloaded'); o.afterReload?.(); return true; },
    partition: () => 'persist:wanigan-live-p1', sessionFor: () => null, askTrace: async () => ({ state: 'missing' }), pageScript: () => '/* page */', dataDir,
    renderBefore: async (r) => { order.push(`before ${r.width}`); return { error: 'no render in this test' }; },
    render: async () => ({ error: 'no render in this test' }),
    now: () => 1_700_000_000_000, seed: () => 4242,
  });
  const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => (handlers.get(channel) as (...a: unknown[]) => Promise<T>)({}, ...args);
  return {
    page, marks, asks, undos, helperSaves, order,
    apply: () => invoke('live:layerApply'),
    implement: (id: string) => invoke<LayerImplemented>('live:layerImplement', id),
    undo: (id: string) => invoke<LayerUndone>('live:layerUndo', id),
    done: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

test('WordPress: words a builder keeps for the post are found, the page kept, saved over the value as found, marked, then read back on the reloaded page', async () => {
  const e = retype(postContent, 'Paddle with a guide', 'Paddle the north — safely');
  const w = wire({ edits: [e], trace: wordpress(), afterReload: () => { w.page.parts.w1 = [{ text: 'Paddle with a guide' }]; } });
  try {
    w.page.parts = { w1: [{ text: 'Paddle the north — safely' }] };
    await w.apply();
    const a = await w.implement(e.id);
    assert.deepEqual(w.order, ['find', 'before 390', 'before 1440', 'save', 'mark implemented', 'reloaded'], 'found, the page kept, saved, marked, then read back');
    assert.deepEqual(w.asks[0], { step: 'find', trace: '0123456789abcdef', content: { type: 'post', id: '12' }, before: 'Paddle the north — safely', after: 'Paddle with a guide' });
    assert.deepEqual(w.asks[1], { ...w.asks[0], step: 'save', place: 'meta:101#0123456789abcdef', hash: HASH }, 'the save names the place and the hash find gave');
    assert.ok(w.page.ran.some((c) => c.includes('data-elementor-id')), 'the page was asked what a builder marks around the words');
    assert.deepEqual(a, {
      ok: true, id: e.id, state: 'implemented', revision: null, undo: true, shows: 'new',
      said: 'Saved in the site, and the reloaded page shows the new words. The words are kept in this page’s custom field “_acme_builder_layout” (in its JSON). The site keeps no revision of it: Undo here puts the old words back, while nothing else has changed them (for ten minutes). If a plugin or theme shows these words from a copy of its own (a cache), the page can show the old words until that copy is made again.',
    });
    assert.deepEqual(w.marks, [{ id: e.id, state: 'implemented' }]);
  } finally { w.done(); }
});

test('the page still showing the old words is said first, and Undo puts the old value back by the site’s token', async () => {
  const e = retype(postContent, 'Book a canoe', 'Book now');
  const w = wire({ edits: [e], trace: wordpress(), site: (a) => (a.step === 'find' ? found({ where: 'this page’s stored content, inside the shortcode [acme_button]', revisions: true }) : saved({ where: 'this page’s stored content, inside the shortcode [acme_button]', revisions: true, revision: '900' })) });
  try {
    w.page.parts = { w1: [{ text: 'Book now' }] };
    await w.apply();
    const a = await w.implement(e.id);
    assert.equal(a.ok && a.shows, 'old');
    assert.equal(a.ok && a.revision, '900');
    assert.equal(a.ok && a.said, 'Saved in the site, but the page still shows the old words: whatever renders it may keep its own copy. The words are kept in this page’s stored content, inside the shortcode [acme_button]. The site keeps a revision of it (revision 900). Undo puts the old words back.');
    const undone = await w.undo(e.id);
    assert.deepEqual(w.undos, [UNDO], 'the token the site gave, never one from the window');
    assert.equal(undone.ok, true);
    assert.match(undone.ok ? undone.said : '', /^Put back: the site holds the old words again\. The edit stays in the layer as implemented/);
    assert.equal(w.order.at(-1), 'reload', 'the page reloads with the old words');
    assert.deepEqual(await w.undo(e.id), { ok: false, id: e.id, why: 'That can no longer be undone here: Undo puts back a save made from the layer in this window, for ten minutes.' }, 'once only');
  } finally { w.done(); }
});

test('found nowhere: an agent’s answer stands with why; a refusal (twice, only in code, made from a template) saves nothing and keeps no page', async () => {
  // Words in the post's content that the post does not keep: code makes them, so an agent can change it.
  const e = retype(postContent, 'Guided tours', 'Tours daily');
  const nowhere = 'The site does not keep these words in this content: code or another content item makes them. (Searched: this page’s stored content, its excerpt and its custom fields.)';
  const a = wire({ edits: [e], trace: wordpress(), site: () => refused('nowhere', nowhere, 404) });
  try {
    a.page.parts = { w1: [{ text: 'Tours daily' }] };
    await a.apply();
    assert.deepEqual(await a.implement(e.id), { ok: false, id: e.id, route: 'agent', why: `${nowhere} An agent can make the change from a brief.` });
    assert.deepEqual(a.order, ['find', 'before 390', 'before 1440'], 'the page is kept for the agent, once; nothing is saved');
  } finally { a.done(); }
  // Words in a block stored in the post that no target offers: the search's refusal is the answer.
  const f = retype(hero, 'Northwind & friends', 'Northwind & co');
  const twice = 'These words are kept more than once in this page (this page’s stored content and this page’s custom field “acme_subtitle”), so Wanigan cannot tell which one the page shows, and saves none of them.';
  const b = wire({ edits: [f], trace: wordpress(), site: () => refused('twice', twice) });
  try {
    b.page.parts = { w2: [{ text: 'Northwind & co' }] };
    await b.apply();
    assert.deepEqual(await b.implement(f.id), { ok: false, id: f.id, route: 'none', why: twice });
    assert.deepEqual([b.order, b.marks], [['find'], []]);
  } finally { b.done(); }
  // Without the search (an older main, a test without it), what was said before stands.
  const c = wire({ edits: [retype(hero, 'Northwind & friends', 'Northwind & co')], trace: wordpress(), stored: false });
  try {
    c.page.parts = { w2: [{ text: 'Northwind & co' }] };
    await c.apply();
    const answer = await c.implement(`s${made}`);
    assert.equal(answer.ok ? null : answer.route, 'agent');
    assert.match(answer.ok ? '' : answer.why, /^These words are in a post’s content/);
  } finally { c.done(); }
});

test('a place every page shows is said first, and saved when the edit is made real again', async () => {
  const e = retype(hero, 'Paddle with Acme', 'Paddle with Acme since 1999');
  const ask = 'These words are kept in the site’s ACF option “Footer text”, which every page that prints it shows, not this page alone.';
  const w = wire({ edits: [e], trace: wordpress(), site: (a) => (a.step === 'find' ? found({ place: 'acf-option:footer_text#0123456789abcdef', ask, writer: 'ACF' }) : saved({ place: 'acf-option:footer_text#0123456789abcdef', ask, writer: 'ACF' })) });
  try {
    w.page.parts = { w2: [{ text: 'Paddle with Acme since 1999' }] };
    await w.apply();
    assert.deepEqual(await w.implement(e.id), { ok: false, id: e.id, route: 'none', why: `${ask} Make it real again to save it there.` });
    assert.deepEqual(w.order, ['find']);
    const again = await w.implement(e.id);
    assert.equal(again.ok, true);
    assert.equal(w.asks.at(-1)?.confirmed, true, 'the save says the owner was told');
    assert.match(again.ok ? again.said ?? '' : '', /kept in this page’s custom field .*, and were saved through ACF’s own save\./);
  } finally { w.done(); }
});

test('Drupal: words no target holds and no template writes, and words in a marked field of a contributed type, are looked for in the content’s stored values', async () => {
  const card = retype({ kind: 'component', name: 'acme:card', within: null, nth: 0 }, 'See every trip', 'See the trips');
  const a = wire({ edits: [card], trace: drupal(), site: (s) => (s.step === 'find' ? found({ place: 'field:field_acme_layout:0:value#0123456789abcdef', where: 'this content’s “Acme layout” field (in its JSON)', revisions: true }) : saved({ place: 'field:field_acme_layout:0:value#0123456789abcdef', where: 'this content’s “Acme layout” field (in its JSON)', revisions: true, revision: '8' })) });
  try {
    a.page.parts = { d3: [{ text: 'See the trips' }] };
    await a.apply();
    const done = await a.implement(card.id);
    assert.equal(done.ok && done.revision, '8');
    assert.deepEqual(a.asks[0]?.content, { type: 'node', id: UUID, langcode: 'en' }, 'the entity in the language the page showed');
    assert.ok(!a.page.ran.some((c) => c.includes('data-elementor-id')), 'no builder hints on Drupal');
  } finally { a.done(); }
  // A field the helper marked, of a type its word saves do not model: the search first, the helper's save not asked.
  const field = retype(tripField, 'See every trip', 'See the trips');
  const mark = `node:31:field_acme_layout:acme_json:en:7:1760000000:acme_json_formatter`;
  const b = wire({ edits: [field], trace: drupal() });
  try {
    b.page.parts = { d2: [{ text: 'See the trips', field: mark }] };
    await b.apply();
    assert.equal((await b.implement(field.id)).ok, true);
    assert.deepEqual(b.asks[0]?.content, { type: 'node', id: UUID, langcode: 'en', field: 'field_acme_layout' }, 'the field the page marked, as a hint');
    assert.deepEqual(b.helperSaves, []);
  } finally { b.done(); }
  // Found nowhere there: the helper's own save answers (a field's label, or why not).
  const c = wire({ edits: [retype(tripField, 'Layout', 'Acme layout')], trace: drupal(), site: () => refused('nowhere', 'Nowhere.', 404), helper: () => ({ ok: false, error: 'Wanigan does not save words to this kind of field yet (acme_json).', label: null }) });
  try {
    c.page.parts = { d2: [{ text: 'Acme layout', field: mark }] };
    await c.apply();
    assert.deepEqual(await c.implement(`s${made}`), { ok: false, id: `s${made}`, route: 'none', why: 'Wanigan does not save words to this kind of field yet (acme_json).' });
    assert.equal(c.helperSaves.length, 1);
  } finally { c.done(); }
});

test('what a save came to is said truly: where, through whose save, the revision or none, a copy of its own, and what the page shows', () => {
  const s = saved({ writer: 'Elementor', where: 'the Elementor page “Northwind trips” (its heading widget)', revision: '41', cache: 'Elementor’s own save cleared its CSS and element caches for it.' });
  assert.equal(storedSaid(s as Extract<StoredWordsAnswer, { ok: true }>, 'new'), 'Saved in the site, and the reloaded page shows the new words. The words are kept in the Elementor page “Northwind trips” (its heading widget), and were saved through Elementor’s own save. The site keeps a revision of it (revision 41). Elementor’s own save cleared its CSS and element caches for it.');
  assert.equal(storedSaid(s as Extract<StoredWordsAnswer, { ok: true }>, 'unknown'), 'Saved in the site. The words are kept in the Elementor page “Northwind trips” (its heading widget), and were saved through Elementor’s own save. The site keeps a revision of it (revision 41). Wanigan could not find its element on the reloaded page to check what it shows. Elementor’s own save cleared its CSS and element caches for it.');
});
