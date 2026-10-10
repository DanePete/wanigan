// The design layer's main-process side with stand-ins: a fake ipc, a fake core client, a page script played by a
// small model of a page, a site answering the helper's schema save, and a render seam for the verification
// (Electron's windows cannot open under this runner). What is checked is what reaches the page, the core, the site and
// the data folder. Made-up site (acme); nothing real.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compileLayer, layerTextHash, type LayerApplied, type LayerEdit, type LayerImplemented, type LayerPickTarget, type LayerVerdict } from '../shared/design-layer.ts';
import type { Bitmap, ElementSnap } from '../shared/layer-verify.ts';
import type { LiveEditSaved } from '../shared/live-lens.ts';
import type { EditTarget, LiveTrace, PartIdentity, TracePart } from '../shared/live-trace.ts';
import { saveSchemaEdit } from './live-edit-save.ts';
import { madeOn, pathOf, wireLiveLayer, type LayerRender, type LayerRenderRequest } from './live-layer.ts';

// Plainly not a key: the helper's real token is random hex the core keeps.
const TOKEN = ['stand', 'in', 'token'].join('-');
const BASE = 'https://acme.example.test/';

const card = (nth: number): PartIdentity => ({ kind: 'component', name: 'acme:card', within: null, nth });
const trace = (): LiveTrace => ({
  version: 1, platform: 'drupal', id: '0123456789abcdef', url: '/paddling', at: 1, total: { ms: 1 }, edits: [],
  parts: [
    { id: 'p1', kind: 'component', label: 'Card', identity: card(0) },
    { id: 'p2', kind: 'component', label: 'Card', identity: card(1) },
    { id: 'p3', kind: 'component', label: 'Hero', identity: { kind: 'component', name: 'acme:hero', within: null, nth: 0 } },
    { id: 'p4', kind: 'block', label: 'Footer note' },
  ],
});

let made = 0;
const edit = (over: Partial<LayerEdit> = {}): LayerEdit => ({
  id: over.id ?? `e${++made}`, label: 'Heading in Card (component)', page: '/paddling', scope: 'this', breakpoint: 'all',
  target: { part: card(0), inner: 'h2:nth-of-type(1)', selector: null, textHash: layerTextHash('Paddling 101') },
  change: { type: 'style', values: { color: '#123456' } }, before: {}, state: 'draft', by: 'owner', at: 1, verdict: null, ...over,
});

/** One element on the model page: its whole text (null when it has none), whether it holds only words, the field around it. */
interface El { text: string | null; plain: boolean; field?: string }
/** An element holding only words. */
const words = (text: string, field?: string): El => ({ text, plain: true, ...(field ? { field } : {}) });
/** A container: its text is its children's. */
const holding = (text: string | null): El => ({ text, plain: false });

/**
 * A page script played by a model: what each part holds at each inner path. It answers the calls the main process
 * makes the way live-page.ts does, and records them.
 */
function modelPage() {
  const page = {
    parts: {} as Record<string, Record<string, El[]>>,
    selectors: {} as Record<string, El[]>,
    pick: null as unknown,
    calls: [] as { name: string; args: unknown[] }[],
    found: new Map<string, El[]>(),
    set: null as { tags: Record<string, number[]>; texts: { id: string; value: string }[]; on: boolean } | null,
  };
  const run = async <T>(code: string, fallback: T): Promise<T> => {
    const m = /^window\.__wl && window\.__wl\.(\w+) \? window\.__wl\.\1\((.*)\) : null$/s.exec(code);
    if (!m) return fallback;
    const name = m[1] as string;
    const args = JSON.parse(`[${m[2]}]`) as unknown[];
    page.calls.push({ name, args });
    if (name === 'layerFind') {
      const [specs, keep] = args as [{ id: string; parts: string[] | null; inner: string | null; selector: string | null; text?: boolean }[], boolean];
      const out: Record<string, { count: number; texts: (string | null)[]; plain: boolean[] }> = {};
      const found = new Map<string, El[]>();
      for (const s of specs) {
        const els = s.parts ? s.parts.flatMap((p) => page.parts[p]?.[s.inner ?? ''] ?? []) : page.selectors[s.selector ?? ''] ?? [];
        found.set(s.id, els);
        out[s.id] = { count: els.length, texts: s.text ? els.map((e) => e.text) : [], plain: els.map((e) => e.plain) };
      }
      if (keep) page.found = found;
      return out as T;
    }
    if (name === 'layerSet') { page.set = args[0] as typeof page.set; return Object.values(page.set!.tags).flat().length as T; }
    if (name === 'layerPick') return page.pick as T;
    if (name === 'layerOf') {
      const id = args[0] as string;
      const els = (page.set?.tags[id] ?? []).map((i) => page.found.get(id)?.[i]).filter((e): e is El => !!e);
      const el = els[0];
      return (el ? { count: els.length, field: el.field ?? null, words: el.plain ? el.text : null, plain: el.plain } : { count: 0, field: null, words: null, plain: false }) as T;
    }
    return fallback;
  };
  return { page, run };
}

/** What the stand-in site answers a schema save (`POST /_wanigan/edit/<id>`): a status and its JSON. */
interface SiteAnswer { status: number; body: unknown }

function wire(over: { edits?: LayerEdit[]; url?: string; trace?: LiveTrace | null; trusted?: boolean; enabled?: boolean; render?: LayerRender; saved?: { ok: boolean; error: string | null }; site?: SiteAnswer } = {}) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const dataDir = mkdtempSync(join(tmpdir(), 'wanigan-layer-'));
  const { page, run } = modelPage();
  let edits = over.edits ?? [];
  const marks: { id: string; state: string; verdict?: LayerVerdict }[] = [];
  const saves: [string, string, string][] = [];
  /** What reached the stand-in site's schema save route: the path and the JSON body. */
  const posts: { path: string; body: unknown }[] = [];
  const sheets: { inserted: string[]; origins: unknown[]; removed: string[]; reloads: number } = { inserted: [], origins: [], removed: [], reloads: 0 };
  let url = over.url ?? `${BASE}paddling`;
  const webContents = {
    id: 7, getURL: () => url, isDestroyed: () => false,
    insertCSS: async (css: string, options?: { cssOrigin?: string }) => { sheets.inserted.push(css); sheets.origins.push(options?.cssOrigin); return `key-${sheets.inserted.length}`; },
    removeInsertedCSS: async (key: string) => { sheets.removed.push(key); },
    reloadIgnoringCache: () => { sheets.reloads++; },
    on: () => webContents,
  };
  const client = {
    callRaw: async (method: string, params: Record<string, unknown>) => {
      if (method === 'live.layer') return { projectId: 'p1', edits, undo: null, redo: null };
      if (method === 'live.layerMark') {
        marks.push({ id: params.id as string, state: params.state as string, ...(params.verdict ? { verdict: params.verdict as LayerVerdict } : {}) });
        edits = edits.map((e) => (e.id === params.id ? { ...e, state: params.state as LayerEdit['state'] } : e));
        return { projectId: 'p1', edits, undo: null, redo: null };
      }
      if (method === 'live.site') return { projectId: 'p1', url: BASE, token: TOKEN, helper: { kind: 'drupal', version: 4, outdated: false } };
      throw new Error(`unexpected ${method}`);
    },
  };
  const renders: LayerRenderRequest[] = [];
  const traced = over.trace === undefined ? trace() : over.trace;
  const wired = wireLiveLayer({
    ipc: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); } } as never,
    trusted: () => over.trusted ?? true,
    enabled: () => over.enabled ?? true,
    client: async () => client as never,
    current: () => ({ projectId: 'p1', base: BASE, token: TOKEN, env: null, webContents: webContents as never }),
    run,
    trace: async () => (traced ? { state: 'ok', trace: traced } : { state: 'missing' }),
    helperSave: async (field, before, after) => { saves.push([field, before, after]); return over.saved ? { ...over.saved, label: 'Paddling 101' } : { ok: true, error: null, label: 'Paddling 101', revision: '42' }; },
    // live-inspect.ts schemaSave, played here: the target found in the trace the view holds (Electron's ipcMain cannot
    // load under this runner), then the real save in live-edit-save.ts against a stand-in site.
    schemaSave: async (id, value, tracedId): Promise<LiveEditSaved> => {
      const t = traced?.edits.find((e) => e.id === id);
      if (!traced || !t) return { ok: false, error: 'This page’s trace offers no such edit. Reload it, then try again.', revision: null };
      if (tracedId !== traced.id) return { ok: false, error: 'This page changed since Wanigan read its trace. Reload it, then try again.', revision: null };
      return saveSchemaEdit({
        trace: traced.id, target: t, reload: () => webContents.reloadIgnoringCache(),
        post: async (path, body) => {
          posts.push({ path, body: JSON.parse(body) as unknown });
          const a = over.site ?? { status: 200, body: { ok: true, revision: '43' } };
          return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } });
        },
      }, value);
    },
    partition: () => 'persist:wanigan-live-p1',
    sessionFor: () => null,
    askTrace: async () => ({ state: 'missing' }),
    pageScript: () => '/* the page script */',
    dataDir,
    render: async (r) => { renders.push(r); return over.render ? over.render(r) : { error: 'no render in this test' }; },
    encode: async () => Buffer.from('diff-png'),
    now: () => 1_000,
  });
  const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => (handlers.get(channel) as (...a: unknown[]) => Promise<T>)({}, ...args);
  return {
    page, marks, saves, posts, sheets, renders, dataDir, wired,
    edits: () => edits,
    go: (to: string) => { url = to; },
    apply: () => invoke<LayerApplied>('live:layerApply'),
    show: (on: boolean) => invoke<LayerApplied>('live:layerShow', on),
    target: () => invoke<LayerPickTarget | null>('live:layerTarget'),
    implement: (id: string) => invoke<LayerImplemented>('live:layerImplement', id),
    verify: (id: string | null, options?: unknown) => invoke<LayerVerdict>('live:layerVerify', id, options ?? null),
    picture: (path: unknown) => invoke<string | null>('live:layerPicture', path),
    done: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

test('a page and an edit’s page: path and query, or the path when the edit names none', () => {
  assert.equal(pathOf('https://acme.example.test/news?page=2#top'), '/news?page=2');
  assert.ok(madeOn({ page: '/news' }, '/news?page=2'));
  assert.ok(!madeOn({ page: '/news?page=1' }, '/news?page=2'));
});

test('applying resolves an edit by its part’s identity, tags what it found, and injects the layer as one stylesheet', async () => {
  const e = edit();
  const w = wire({ edits: [e] });
  try {
    w.page.parts = { p1: { 'h2:nth-of-type(1)': [words('Paddling 101')] }, p2: { 'h2:nth-of-type(1)': [words('Canoeing 201')] } };
    const applied = await w.apply();
    const find = w.page.calls.find((c) => c.name === 'layerFind');
    assert.deepEqual(find?.args, [[{ id: e.id, parts: ['p1'], inner: 'h2:nth-of-type(1)', selector: null, text: true }], true], 'the part whose identity it is, and only that one, checked by its text');
    assert.deepEqual(w.page.set, { tags: { [e.id]: [0] }, texts: [], on: true });
    assert.deepEqual(w.sheets.inserted, [compileLayer([e], [])]);
    assert.deepEqual(w.sheets.origins, ['user'], 'the user origin: its !important outranks the page’s, layered or not');
    assert.match(w.sheets.inserted[0]!, new RegExp(`\\[data-wl-edit~="${e.id}"\\]\\[data-wl-edit~="${e.id}"\\] \\{ color: #123456 !important; \\}`));
    assert.deepEqual(applied, { page: '/paddling', shown: [{ id: e.id, elements: 1 }], orphaned: [], elsewhere: [], off: false });
    assert.deepEqual(w.marks, [], 'nothing changed state');
    // Applied again, the old sheet goes once the new one is in: one stylesheet, replaced whole.
    await w.apply();
    assert.deepEqual([w.sheets.inserted.length, w.sheets.removed], [2, ['key-1']]);
  } finally { w.done(); }
});

test('an edit for every instance reaches each part of its kind, and nothing of another kind', async () => {
  const e = edit({ scope: 'kind', page: '/elsewhere', target: { part: card(0), inner: 'h2:nth-of-type(1)', selector: null, textHash: layerTextHash('Paddling 101') } });
  const w = wire({ edits: [e] });
  try {
    w.page.parts = { p1: { 'h2:nth-of-type(1)': [words('Paddling 101')] }, p2: { 'h2:nth-of-type(1)': [words('Canoeing 201')] }, p3: { 'h2:nth-of-type(1)': [words('Welcome')] } };
    const applied = await w.apply();
    assert.deepEqual((w.page.calls.find((c) => c.name === 'layerFind')?.args[0] as { parts: string[] }[])[0]?.parts, ['p1', 'p2']);
    assert.deepEqual(w.page.set?.tags, { [e.id]: [0, 1] }, 'every card, whatever its words');
    assert.deepEqual(applied.shown, [{ id: e.id, elements: 2 }]);
    assert.deepEqual(applied.elsewhere, [], 'an edit for every instance applies on any page');
  } finally { w.done(); }
});

test('an element showing other words orphans its edit and tells the core; it is a draft again when they come back', async () => {
  const e = edit();
  const other = edit({ page: '/about' });
  const w = wire({ edits: [e, other] });
  try {
    w.page.parts = { p1: { 'h2:nth-of-type(1)': [words('Canoeing for beginners')] } };
    const lost = await w.apply();
    assert.deepEqual(lost.orphaned, [{ id: e.id, why: 'Its element shows other words now.' }]);
    assert.deepEqual(lost.elsewhere, [other.id], 'an edit of another page is left alone');
    assert.deepEqual(w.page.set?.tags, {}, 'never applied to what sits in its place');
    assert.equal(w.sheets.inserted.at(-1)?.includes(e.id), false, 'not in the stylesheet either');
    assert.deepEqual(w.marks, [{ id: e.id, state: 'orphaned' }]);
    await w.apply();
    assert.equal(w.marks.length, 1, 'told once');
    w.page.parts = { p1: { 'h2:nth-of-type(1)': [words('Paddling   101 ')] } };
    const back = await w.apply();
    assert.deepEqual(back.shown, [{ id: e.id, elements: 1 }], 'the same words, however spaced');
    assert.deepEqual(w.marks.at(-1), { id: e.id, state: 'draft' });
    assert.ok(w.sheets.inserted.at(-1)?.includes(e.id));
    w.page.parts = {};
    assert.deepEqual((await w.apply()).orphaned, [{ id: e.id, why: 'Its element is not on this page any more.' }]);
  } finally { w.done(); }
});

test('a container whose children’s words changed is orphaned: a block keyed by its place is told apart by its text', async () => {
  // A WordPress block has no id of its own: its identity is where it sits in the post's markup. Two group blocks swap
  // places, and the identity the edit was keyed to now names the other group.
  const group: PartIdentity = { kind: 'block', store: 'post:12', path: [0], name: 'core/group' };
  const e = edit({ label: 'Group', target: { part: group, inner: null, selector: null, textHash: layerTextHash('Paddling 101 Learn the strokes') } });
  const empty = edit({ label: 'Spacer', target: { part: group, inner: 'div:nth-of-type(2)', selector: null, textHash: null } });
  const blocks: LiveTrace = { ...trace(), parts: [{ id: 'b1', kind: 'block', label: 'Group', identity: group }, { id: 'b2', kind: 'block', label: 'Group', identity: { ...group, path: [1] } }] };
  const w = wire({ edits: [e, empty], trace: blocks });
  try {
    w.page.parts = { b1: { '': [holding('Paddling 101 Learn the strokes')], 'div:nth-of-type(2)': [holding(null)] } };
    assert.deepEqual((await w.apply()).shown, [{ id: e.id, elements: 1 }, { id: empty.id, elements: 1 }]);
    // Swapped: the group at path 0 is the other one now, its heading and its paragraph other words.
    w.page.parts = { b1: { '': [holding('Canoeing 201 Longer trips')], 'div:nth-of-type(2)': [holding(null)] } };
    const swapped = await w.apply();
    assert.deepEqual(swapped.orphaned, [{ id: e.id, why: 'Its element shows other words now.' }], 'never applied to the other group');
    assert.deepEqual(w.page.set?.tags, { [empty.id]: [0] }, 'an element with no text has nothing to check it by: it is applied, as its target said when it was made');
    assert.deepEqual(w.marks, [{ id: e.id, state: 'orphaned' }]);
    // One word inside it changed is other words too: the hash is over all of its text.
    w.page.parts = { b1: { '': [holding('Paddling 101 Learn the strokes!')] } };
    assert.deepEqual((await w.apply()).orphaned.map((o) => o.id), [e.id, empty.id]);
  } finally { w.done(); }
});

test('the same stored thing shown twice on a page is one identity: an edit for it reaches both, and is not orphaned', async () => {
  const e = edit();
  // The same card (one entity, one identity) rendered in the page and again in a sidebar teaser.
  const twice: LiveTrace = { ...trace(), parts: [...trace().parts, { id: 'p5', kind: 'component', label: 'Card', identity: card(0) }] };
  const w = wire({ edits: [e], trace: twice });
  try {
    w.page.parts = { p1: { 'h2:nth-of-type(1)': [words('Paddling 101')] }, p5: { 'h2:nth-of-type(1)': [words('Paddling 101')] } };
    const both = await w.apply();
    assert.deepEqual((w.page.calls.find((c) => c.name === 'layerFind')?.args[0] as { parts: string[] }[])[0]?.parts, ['p1', 'p5']);
    assert.deepEqual(both.shown, [{ id: e.id, elements: 2 }], 'both, counted');
    assert.deepEqual(w.page.set?.tags, { [e.id]: [0, 1] });
    // The teaser shortens the title: one of them still shows the words the edit was made on, so both are the thing.
    w.page.parts = { p1: { 'h2:nth-of-type(1)': [words('Paddling 101')] }, p5: { 'h2:nth-of-type(1)': [words('Paddling…')] } };
    assert.deepEqual((await w.apply()).shown, [{ id: e.id, elements: 2 }]);
    assert.deepEqual(w.marks, [], 'never orphaned, and never one picked');
    w.page.parts = { p1: { 'h2:nth-of-type(1)': [words('Canoeing 201')] }, p5: { 'h2:nth-of-type(1)': [words('Canoeing…')] } };
    assert.deepEqual((await w.apply()).orphaned, [{ id: e.id, why: 'Its element shows other words now.' }], 'neither shows its words: it names something else now');
  } finally { w.done(); }
});

test('without the page’s trace nothing is resolved by identity, and nothing is called orphaned for it', async () => {
  const e = edit();
  const w = wire({ edits: [e], trace: null });
  try {
    const applied = await w.apply();
    assert.deepEqual([applied.shown, applied.orphaned], [[], []]);
    assert.deepEqual(w.marks, []);
  } finally { w.done(); }
});

test('a text edit patches its element’s words, and still resolves once the site shows them; switched off, the page is the site’s', async () => {
  const e = edit({ change: { type: 'text', value: 'Paddling 102' } });
  const w = wire({ edits: [e] });
  try {
    w.page.parts = { p1: { 'h2:nth-of-type(1)': [words('Paddling 101')] } };
    await w.apply();
    assert.deepEqual(w.page.set, { tags: { [e.id]: [0] }, texts: [{ id: e.id, value: 'Paddling 102' }], on: true });
    w.page.parts = { p1: { 'h2:nth-of-type(1)': [words('Paddling 102')] } };
    assert.deepEqual((await w.apply()).orphaned, [], 'its own new words are not other words');
    const off = await w.show(false);
    assert.equal(off.off, true);
    assert.deepEqual(off.shown, []);
    assert.deepEqual(w.page.set, { tags: { [e.id]: [0] }, texts: [], on: false }, 'tags may stay; words go back');
    assert.equal(w.sheets.removed.length, w.sheets.inserted.length, 'no stylesheet left');
    const onAgain = await w.show(true);
    assert.equal(onAgain.off, false);
  } finally { w.done(); }
});

test('the picked element is keyed to the innermost part with an identity, with what its kind reaches', async () => {
  const w = wire();
  try {
    w.page.parts = { p1: { 'h2:nth-of-type(1)': [words('Paddling 101')] }, p2: { 'h2:nth-of-type(1)': [words('Canoeing 201')] } };
    w.page.pick = {
      parts: [{ part: 'p4', inner: 'h2:nth-of-type(1)' }, { part: 'p1', inner: 'h2:nth-of-type(1)' }, { part: 'p3', inner: 'div:nth-of-type(1) > h2:nth-of-type(1)' }],
      selector: 'html > body:nth-of-type(1) > h2:nth-of-type(1)', text: 'Paddling 101', tag: 'h2', values: { color: 'rgb(0, 0, 0)', 'font-size': '24px', position: 'static' },
    };
    const t = await w.target();
    assert.deepEqual(t?.target, { part: card(0), inner: 'h2:nth-of-type(1)', selector: null, textHash: layerTextHash('Paddling 101') }, 'p4 has no identity: the next part out that has one');
    assert.equal(t?.label, 'Heading in Card (component)');
    assert.equal(t?.kindLabel, 'the heading in every Card component');
    assert.equal(t?.kindCount, 2);
    assert.deepEqual(t?.before, { color: 'rgb(0, 0, 0)', 'font-size': '24px', text: 'Paddling 101' }, 'the layer’s properties and its words, nothing else');
    assert.equal(t?.fragile, false);
    w.page.pick = { parts: [{ part: 'p4', inner: null }], selector: 'html > body:nth-of-type(1) > p:nth-of-type(2)', text: null, tag: 'p', values: {} };
    const loose = await w.target();
    assert.deepEqual([loose?.fragile, loose?.target.selector, loose?.target.part, loose?.kindLabel], [true, 'html > body:nth-of-type(1) > p:nth-of-type(2)', null, null]);
    w.page.pick = null;
    assert.equal(await w.target(), null, 'nothing picked');
  } finally { w.done(); }
});

test('making an edit real: words go through the helper’s save, a style goes to an agent, and the core is told', async () => {
  const retyped = edit({ change: { type: 'text', value: 'Paddling 102' } });
  const style = edit();
  const every = edit({ scope: 'kind', change: { type: 'text', value: 'Same everywhere' } });
  // The card's props hold the same words as a schema target: a field the helper marked is saved through its own save all the same.
  const props: EditTarget = { id: 'props.0a1b2c3d4e5f', kind: 'props', label: 'Card props', via: 'schema', schema: { type: 'object', properties: { title: { type: 'string' } } }, value: { title: 'Paddling 101' } };
  const drupal: LiveTrace = { ...trace(), parts: trace().parts.map((p) => (p.id === 'p1' ? { ...p, edits: [props.id] } : p)), edits: [props] };
  const w = wire({ edits: [retyped, style, every], trace: drupal });
  try {
    w.page.parts = { p1: { 'h2:nth-of-type(1)': [words('Paddling 101', 'node:12:title:string')] } };
    await w.apply();
    assert.deepEqual(await w.implement(style.id), { ok: false, id: style.id, route: 'agent', why: 'A style goes into the theme’s CSS: in phase 1 an agent makes it from a brief, on your click.' });
    const kind = await w.implement(every.id);
    assert.ok(!kind.ok && kind.route === 'none' && /one element at a time/.test(kind.why));
    assert.deepEqual(w.saves, [], 'nothing was saved for either');
    const done = await w.implement(retyped.id);
    assert.deepEqual(done, { ok: true, id: retyped.id, state: 'implemented', revision: '42' });
    assert.deepEqual(w.saves, [['node:12:title:string', 'Paddling 101', 'Paddling 102']], 'the field the helper marked, the words the site has, the new words');
    assert.deepEqual(w.posts, [], 'no schema target is asked when the helper marked the field');
    assert.deepEqual(w.marks.at(-1), { id: retyped.id, state: 'implemented' });
    assert.equal(w.sheets.reloads, 1, 'the page shows what the site now has');
    const again = await w.implement(retyped.id);
    assert.ok(!again.ok && /in the site already/.test(again.why));
  } finally { w.done(); }
});

test('words with no field the helper marks, or a refusal from the site, are said and nothing is marked', async () => {
  const loose = edit({ change: { type: 'text', value: 'New words' } });
  const w = wire({ edits: [loose], saved: { ok: false, error: 'The user you are logged in as in the live view may not change this.' } });
  try {
    w.page.parts = { p1: { 'h2:nth-of-type(1)': [words('Paddling 101')] } };
    await w.apply();
    const unmarked = await w.implement(loose.id);
    assert.deepEqual(unmarked, { ok: false, id: loose.id, route: 'none', why: NOTHING_HOLDS }, 'no field marked, and nothing in the trace holds these words');
    assert.deepEqual([w.saves, w.posts], [[], []]);
    w.page.parts = { p1: { 'h2:nth-of-type(1)': [words('Paddling 101', 'node:12:title:string')] } };
    await w.apply();
    const refused = await w.implement(loose.id);
    assert.deepEqual(refused, { ok: false, id: loose.id, route: 'none', why: 'The user you are logged in as in the live view may not change this.' });
    assert.deepEqual(w.marks, []);
    w.go(`${BASE}about`);
    const away = await w.implement(loose.id);
    assert.ok(!away.ok && /Open \/paddling in the live view first/.test(away.why));
  } finally { w.done(); }
});

/* ── WordPress: words saved through the edit target that holds them ── */

const NOTHING_HOLDS = 'Nothing this page offers to edit holds exactly these words, so there is nothing here to save them to: they come from a template, from formatted text, or from something the site helper does not offer on this page.';

// A made-up WordPress page as its helper traces it (live-helper-wordpress.ts): the single template, a post-title block
// in it showing post 12's title through its block context, and post 12's content beside it, which carries the post's
// fields as schema targets (post_edits(): title, excerpt, slug, status, and the editor as a native form).
const titleBlock: PartIdentity = { kind: 'block', store: 'tpl:acme//single', path: [1, 0], name: 'core/post-title' };
const postContent: PartIdentity = { kind: 'entity', type: 'post', id: '12', bundle: 'post', field: 'post_content' };
const showsPost12 = [{ name: 'context.postId', type: 'integer', preview: '12' }];
const postField = (key: string, label: string, value: unknown, schema: Record<string, unknown>, more: Partial<EditTarget> = {}): EditTarget =>
  ({ id: `post-12-${key}`, kind: 'field', label: `${label} of “Paddling 101”`, via: 'schema', schema, value, revisions: true, ...more });
function postEdits(over: { title?: string; excerpt?: string; why?: string } = {}): EditTarget[] {
  const why = over.why ? { why: over.why } : {};
  return [
    postField('title', 'Title', over.title ?? 'Paddling 101', { type: 'string', title: 'Title' }, why),
    postField('excerpt', 'Excerpt', over.excerpt ?? 'Learn the strokes before the lake.', { type: 'string', title: 'Excerpt' }, why),
    postField('slug', 'Slug', 'paddling-101', { type: 'string', title: 'Slug' }, { kind: 'property', revisions: false, ...why }),
    postField('status', 'Status', 'publish', { type: 'string', title: 'Status', enum: ['publish', 'draft'] }, { kind: 'property', revisions: false, ...why }),
    { id: 'post-12-editor', kind: 'field', label: 'Open “Paddling 101” in the block editor', via: 'native-form', revisions: true },
  ];
}
/** The title block's own target: its attributes, none of them its words (WordPress renders the title from the post). */
const titleAttributes: EditTarget = {
  id: 'block-tpl-1.0', kind: 'block-attributes', label: 'Title block in the template “Single”', via: 'schema',
  schema: { type: 'object', properties: { level: { type: 'integer' }, isLink: { type: 'boolean' }, textAlign: { type: 'string' } }, additionalProperties: false },
  value: { level: 1, isLink: false, textAlign: 'left' }, revisions: true,
};
function wpTrace(over: { parts?: TracePart[]; edits?: EditTarget[] } = {}): LiveTrace {
  const post = over.edits ?? postEdits();
  return {
    version: 1, platform: 'wordpress', id: '0123456789abcdef', url: '/paddling', at: 1, total: { ms: 1 },
    parts: over.parts ?? [
      { id: 'w0', kind: 'template', label: 'Single', identity: { kind: 'config', type: 'wp_template', id: 'acme//single' } },
      { id: 'w1', kind: 'block', label: 'Title', parent: 'w0', identity: titleBlock, variables: showsPost12, edits: [titleAttributes.id] },
      { id: 'w2', kind: 'entity', label: 'Post 12: Paddling 101', parent: 'w0', identity: postContent, edits: post.map((e) => e.id) },
    ],
    edits: [...post, titleAttributes],
  };
}
/** A text edit made on the element at `inner` in the part `part` names, which showed `before`. */
const retype = (part: PartIdentity, value: string, before = 'Paddling 101', inner: string | null = null): LayerEdit =>
  edit({ label: 'Title', target: { part, inner, selector: null, textHash: layerTextHash(before) }, change: { type: 'text', value } });

test('WordPress: a title’s new words are saved through the title’s schema target, wherever the title is shown, and the edit is marked implemented', async () => {
  // In the template beside the post's content: the block shows its post's title through its block context.
  // Inside the post's content: the same, and the post is also the part around it.
  // A classic theme's the_title(): the title is a part of its own, with its own target (typography as wptexturize prints it).
  const inPost: PartIdentity = { kind: 'block', store: 'post:12', path: [0], name: 'core/post-title' };
  const classic: PartIdentity = { kind: 'entity', type: 'post', id: '12', bundle: 'post', field: 'post_title' };
  const cases: { name: string; part: PartIdentity; trace: LiveTrace; shown: string }[] = [
    { name: 'in the template', part: titleBlock, trace: wpTrace(), shown: 'Paddling 101' },
    {
      name: 'inside the post', part: inPost, shown: 'Paddling 101',
      trace: wpTrace({ parts: [{ id: 'w2', kind: 'entity', label: 'Post 12: Paddling 101', identity: postContent, edits: postEdits().map((e) => e.id) }, { id: 'w1', kind: 'block', label: 'Title', parent: 'w2', identity: inPost, variables: showsPost12 }] }),
    },
    {
      name: 'a classic theme', part: classic, shown: 'Don’t paddle – yet…',
      trace: wpTrace({ edits: postEdits({ title: 'Don\'t paddle -- yet...' }), parts: [{ id: 'c1', kind: 'field', label: 'Title', identity: classic, edits: ['post-12-title'] }] }),
    },
  ];
  for (const c of cases) {
    const retitled = retype(c.part, 'Paddling 102', c.shown);
    const w = wire({ edits: [retitled], trace: c.trace });
    try {
      w.page.parts = { [c.trace.parts.find((p) => p.identity === c.part)!.id]: { '': [words(c.shown)] } };
      await w.apply();
      const done = await w.implement(retitled.id);
      assert.deepEqual(done, { ok: true, id: retitled.id, state: 'implemented', revision: '43' }, c.name);
      assert.deepEqual(w.posts, [{ path: '/_wanigan/edit/post-12-title', body: { trace: '0123456789abcdef', value: 'Paddling 102' } }], `${c.name}: the title, with the trace that offered it and the new words`);
      assert.deepEqual(w.saves, [], `${c.name}: never /_wanigan/save, which WordPress’s helper does not answer`);
      assert.deepEqual(w.marks, [{ id: retitled.id, state: 'implemented' }], c.name);
      assert.equal(w.sheets.reloads, 1, `${c.name}: the page shows what the site now has`);
    } finally { w.done(); }
  }
});

test('WordPress: a menu link’s text is saved with its address as the trace gave it', async () => {
  const item: PartIdentity = { kind: 'config', type: 'menu_item', id: '31' };
  const link: EditTarget = {
    id: 'menu-item-31', kind: 'menu-link', label: 'Menu link “Trails”', via: 'schema', revisions: false,
    schema: { type: 'object', properties: { title: { type: 'string', title: 'Link text' }, url: { type: 'string', title: 'Address', format: 'uri', readOnly: true } } },
    value: { title: 'Trails', url: 'https://acme.example.test/trails/' },
  };
  const renamed = retype(item, 'Our trails', 'Trails', 'a:nth-of-type(1)');
  const w = wire({ edits: [renamed], trace: wpTrace({ parts: [{ id: 'm1', kind: 'menu', label: 'Link: Trails', identity: item, edits: [link.id] }], edits: [link] }) });
  try {
    w.page.parts = { m1: { 'a:nth-of-type(1)': [words('Trails')] } };
    await w.apply();
    assert.equal((await w.implement(renamed.id)).ok, true);
    assert.deepEqual(w.posts, [{ path: '/_wanigan/edit/menu-item-31', body: { trace: '0123456789abcdef', value: { title: 'Our trails', url: 'https://acme.example.test/trails/' } } }]);
  } finally { w.done(); }
});

test('WordPress: words no target holds, or that two hold, are refused with why, and nothing is saved', async () => {
  // A heading from a pattern in the template: its words are the pattern's, and nothing on the page offers them.
  const heading: PartIdentity = { kind: 'component', name: 'core/heading', within: 'config|wp_template|acme//single', nth: 0 };
  const loose = retype(heading, 'Trail notes, revised', 'Trail notes');
  const a = wire({ edits: [loose], trace: wpTrace({ parts: [...wpTrace().parts, { id: 'h1', kind: 'block', label: 'Heading', parent: 'w0', identity: heading }] }) });
  try {
    a.page.parts = { h1: { '': [words('Trail notes')] } };
    await a.apply();
    assert.deepEqual(await a.implement(loose.id), { ok: false, id: loose.id, route: 'none', why: NOTHING_HOLDS });
    assert.deepEqual([a.posts, a.saves, a.marks], [[], [], []]);
  } finally { a.done(); }

  // The post's excerpt is its title, word for word: which one the block shows cannot be told from the words.
  const both = retype(titleBlock, 'Paddling 102');
  const b = wire({ edits: [both], trace: wpTrace({ edits: postEdits({ excerpt: 'Paddling 101' }) }) });
  try {
    b.page.parts = { w1: { '': [words('Paddling 101')] } };
    await b.apply();
    assert.deepEqual(await b.implement(both.id), {
      ok: false, id: both.id, route: 'none',
      why: 'More than one thing here holds exactly these words (Title of “Paddling 101” and Excerpt of “Paddling 101”), so Wanigan cannot tell which to save them to.',
    });
    assert.deepEqual([b.posts, b.marks], [[], []]);
  } finally { b.done(); }
});

test('WordPress: formatted text goes to an agent as a brief, and nothing is saved', async () => {
  // A heading block in the post's content: its words are rich text in the post's saved block markup.
  const block: PartIdentity = { kind: 'block', store: 'post:12', path: [2], name: 'core/heading' };
  const rich: EditTarget = {
    id: 'block-post-12-2', kind: 'block-attributes', label: 'Heading block in post “Paddling 101”', via: 'schema', revisions: true,
    schema: { type: 'object', properties: { content: { type: 'rich-text' }, level: { type: 'integer' } }, additionalProperties: false },
    value: { content: 'Before the lake', level: 2 },
  };
  const headed = retype(block, 'Before the river', 'Before the lake');
  const a = wire({ edits: [headed], trace: wpTrace({ parts: [{ id: 'w2', kind: 'entity', label: 'Post 12: Paddling 101', identity: postContent, edits: postEdits().map((e) => e.id) }, { id: 'b1', kind: 'block', label: 'Heading', parent: 'w2', identity: block, edits: [rich.id] }], edits: [...postEdits(), rich] }) });
  try {
    a.page.parts = { b1: { '': [words('Before the lake')] } };
    await a.apply();
    assert.deepEqual(await a.implement(headed.id), {
      ok: false, id: headed.id, route: 'agent',
      why: 'These words are formatted text (Heading block in post “Paddling 101”): the site keeps them with their markup, which Wanigan does not save from here. An agent can make the change from a brief.',
    });
    assert.deepEqual(a.posts, []);
  } finally { a.done(); }

  // A title kept with markup in it: the words shown are only part of what is kept.
  const marked = retype(titleBlock, 'Paddling 102');
  const b = wire({ edits: [marked], trace: wpTrace({ edits: postEdits({ title: '<em>Paddling</em> 101' }) }) });
  try {
    b.page.parts = { w1: { '': [words('Paddling 101')] } };
    await b.apply();
    const refused = await b.implement(marked.id);
    assert.ok(!refused.ok && refused.route === 'agent' && refused.why.startsWith('These words are formatted text (Title of “Paddling 101”)'), JSON.stringify(refused));
    assert.deepEqual(b.posts, []);
  } finally { b.done(); }

  // A paragraph of a classic post's content that repeats its excerpt word for word: the words are the content's, and
  // the excerpt is never saved in their place.
  const para = retype(postContent, 'Learn the strokes first.', 'Learn the strokes before the lake.', 'p:nth-of-type(1)');
  const c = wire({ edits: [para], trace: wpTrace({ parts: [{ id: 'w2', kind: 'entity', label: 'Post 12: Paddling 101', identity: postContent, edits: postEdits().map((e) => e.id) }] }) });
  try {
    c.page.parts = { w2: { 'p:nth-of-type(1)': [words('Learn the strokes before the lake.')] } };
    await c.apply();
    assert.deepEqual(await c.implement(para.id), {
      ok: false, id: para.id, route: 'agent',
      why: 'These words are in a post’s content (Post 12: Paddling 101), which the site keeps as formatted text: Wanigan does not save it from here. An agent can make the change from a brief.',
    });
    assert.deepEqual([c.posts, c.marks], [[], []]);
  } finally { c.done(); }
});

test('WordPress: what the site refuses (403, 409) is said as the site said it, a target the user may not change is refused before anything is sent, and nothing is marked', async () => {
  const answers: { site: SiteAnswer; why: string }[] = [
    { site: { status: 403, body: { ok: false, error: 'Your WordPress user cannot edit this post (edit_post).' } }, why: 'Your WordPress user cannot edit this post (edit_post).' },
    { site: { status: 403, body: null }, why: 'The site refused: the user logged in in the live view may not edit this.' },
    { site: { status: 409, body: { ok: false, error: 'That page was shown more than ten minutes ago (or to another user): reload it and try again.' } }, why: 'That page was shown more than ten minutes ago (or to another user): reload it and try again.' },
  ];
  for (const a of answers) {
    const retitled = retype(titleBlock, 'Paddling 102');
    const w = wire({ edits: [retitled], trace: wpTrace(), site: a.site });
    try {
      w.page.parts = { w1: { '': [words('Paddling 101')] } };
      await w.apply();
      assert.deepEqual(await w.implement(retitled.id), { ok: false, id: retitled.id, route: 'none', why: a.why }, `${a.site.status}`);
      assert.equal(w.posts.length, 1, 'asked once');
      assert.deepEqual([w.marks, w.sheets.reloads], [[], 0], 'nothing marked, and the page left as it is');
    } finally { w.done(); }
  }

  // The helper said in the trace that this user may not change the post: nothing is sent.
  const locked = retype(titleBlock, 'Paddling 102');
  const w = wire({ edits: [locked], trace: wpTrace({ edits: postEdits({ why: 'Log in to WordPress in the live view to change this.' }) }) });
  try {
    w.page.parts = { w1: { '': [words('Paddling 101')] } };
    await w.apply();
    assert.deepEqual(await w.implement(locked.id), { ok: false, id: locked.id, route: 'none', why: 'Log in to WordPress in the live view to change this.' });
    assert.deepEqual([w.posts, w.marks], [[], []]);
  } finally { w.done(); }
});

/* ── verification ── */

const blank = (width: number, height: number): Bitmap => {
  const data = new Uint8Array(width * height * 4).fill(255);
  return { data, width, height };
};
const painted = (b: Bitmap, r: { x: number; y: number; width: number; height: number }, v: number): Bitmap => {
  const data = new Uint8Array(b.data);
  for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) data.fill(v, (y * b.width + x) * 4, (y * b.width + x) * 4 + 3);
  return { ...b, data };
};
const heading = (id: string, color: string): ElementSnap => ({ edit: id, n: 0, element: 'h2.card__title', values: { color, text: 'Paddling 101' }, box: { x: 20, y: 40, width: 100, height: 24 } });

/** A render seam: the design and the result as each case draws them, small pages at every width. */
function renders(e: LayerEdit, draw: { design: (b: Bitmap) => Bitmap; result: (b: Bitmap, n: number) => Bitmap; designColor?: string }): LayerRender {
  let results = 0;
  return async (r) => {
    const base = blank(64, 200);
    if (r.design) return { png: Buffer.from(`design-${r.width}`), bitmap: draw.design(base), elements: [heading(e.id, draw.designColor ?? 'rgb(18, 52, 86)')], found: [e.id] };
    return { png: Buffer.from(`result-${r.width}`), bitmap: draw.result(base, results++), elements: [heading(e.id, 'rgb(18, 52, 86)')], found: [e.id] };
  };
}

test('a verification renders the result twice and the design once at each width, and passes when they match', async () => {
  const e = edit({ state: 'implemented' });
  const w = wire({ edits: [e], render: renders(e, { design: (b) => painted(b, { x: 20, y: 40, width: 40, height: 24 }, 18), result: (b) => painted(b, { x: 20, y: 40, width: 40, height: 24 }, 18) }) });
  try {
    const verdict = await w.verify(e.id);
    assert.deepEqual([verdict.ok, verdict.failed, verdict.widths, verdict.noise, verdict.differences], [true, null, [390, 1440], { maxDiff: 0, pixels: 0 }, []]);
    assert.deepEqual(w.renders.map((r) => [r.width, r.design, r.url, r.path, r.token, r.partition]), [
      [390, false, `${BASE}paddling`, '/paddling', TOKEN, 'persist:wanigan-live-p1'], [390, false, `${BASE}paddling`, '/paddling', TOKEN, 'persist:wanigan-live-p1'], [390, true, `${BASE}paddling`, '/paddling', TOKEN, 'persist:wanigan-live-p1'],
      [1440, false, `${BASE}paddling`, '/paddling', TOKEN, 'persist:wanigan-live-p1'], [1440, false, `${BASE}paddling`, '/paddling', TOKEN, 'persist:wanigan-live-p1'], [1440, true, `${BASE}paddling`, '/paddling', TOKEN, 'persist:wanigan-live-p1'],
    ]);
    assert.deepEqual(w.marks.map((m) => [m.id, m.state, m.verdict?.ok]), [[e.id, 'verified', true]]);
    const [first] = verdict.pictures;
    assert.ok(first?.design.startsWith(join(w.dataDir, 'live-layer')) && first.design.includes(`/${e.id}/`), 'kept in the data folder, under the edit');
    assert.equal(readFileSync(first!.design, 'utf8'), 'design-390');
    assert.equal(first?.diff, null, 'nothing differed, so there is no difference picture');
    assert.equal(await w.picture(first!.result), Buffer.from('result-390').toString('base64'));
    const outside = join(w.dataDir, 'elsewhere.png');
    writeFileSync(outside, 'not a verification');
    assert.equal(await w.picture(outside), null, 'only a file under live-layer/');
    assert.equal(await w.picture(join(w.dataDir, 'live-layer', '..', 'elsewhere.png')), null);
  } finally { w.done(); }
});

test('a verification stops at the first failing step: styles, then pixels near the edit, then a leak elsewhere', async () => {
  const styled = edit({ state: 'implemented' });
  const a = wire({ edits: [styled], render: renders(styled, { design: (b) => b, result: (b) => painted(b, { x: 0, y: 150, width: 64, height: 20 }, 0), designColor: 'rgb(200, 0, 0)' }) });
  try {
    const v = await a.verify(styled.id, { widths: [390] });
    assert.equal(v.failed, 'styles', 'the computed colour is off, whatever the pixels say');
    assert.deepEqual(v.differences, [{ kind: 'style', edit: styled.id, width: 390, element: 'h2.card__title', property: 'color', design: 'rgb(200, 0, 0)', result: 'rgb(18, 52, 86)' }]);
    assert.deepEqual(a.marks.map((m) => [m.state, m.verdict?.failed]), [['draft', 'styles']], 'back to draft, with the verdict');
    assert.ok(v.pictures[0]?.diff && existsSync(v.pictures[0].diff), 'the difference is pictured');
  } finally { a.done(); }

  const near = edit({ state: 'implemented' });
  const b = wire({ edits: [near], render: renders(near, { design: (x) => painted(x, { x: 20, y: 40, width: 40, height: 24 }, 18), result: (x) => x }) });
  try {
    const v = await b.verify(near.id, { widths: [390] });
    assert.equal(v.failed, 'pixels');
    assert.ok(v.differences.every((d) => d.kind === 'pixels' && d.edit === near.id), 'tied to the edit');
  } finally { b.done(); }

  const elsewhere = edit({ state: 'implemented' });
  const d = wire({ edits: [elsewhere], render: renders(elsewhere, { design: (x) => x, result: (x) => painted(x, { x: 0, y: 150, width: 64, height: 20 }, 0) }) });
  try {
    const v = await d.verify(elsewhere.id, { widths: [390] });
    assert.equal(v.failed, 'rest', 'a difference away from every touched element is a leak');
    assert.ok(v.differences.length > 0 && v.differences.every((x) => x.kind === 'leak'));
    assert.deepEqual(d.marks.map((m) => m.state), ['draft']);
  } finally { d.done(); }
});

test('the noise floor forgives what the result does not repeat exactly, and no more', async () => {
  const e = edit({ state: 'implemented' });
  // The result's two renders differ by one level at a few pixels; the design differs from it by as little.
  const jitter = (b: Bitmap) => painted(b, { x: 2, y: 2, width: 3, height: 1 }, 254);
  const w = wire({ edits: [e], render: renders(e, { design: jitter, result: (b, n) => (n % 2 ? jitter(b) : b) }) });
  try {
    const v = await w.verify(e.id, { widths: [390] });
    assert.deepEqual([v.ok, v.noise], [true, { maxDiff: 1, pixels: 3 }]);
  } finally { w.done(); }
});

test('only an implemented edit is verified, an edit the design cannot find fails, and nothing is asked without the live view or trust', async () => {
  const draft = edit();
  const w = wire({ edits: [draft] });
  try {
    await assert.rejects(w.verify(draft.id), /Only an implemented edit is verified; this one is draft/);
    await assert.rejects(w.verify(null), /nothing to verify here yet/);
    await assert.rejects(w.verify(draft.id, { widths: [100] }), /320 to 2560/);
    assert.equal(w.renders.length, 0);
  } finally { w.done(); }

  const lost = edit({ state: 'implemented' });
  const nowhere = wire({ edits: [lost], render: async (r) => ({ png: Buffer.from('x'), bitmap: blank(64, 100), elements: [], found: [] , ...(r.design ? {} : {}) }) });
  try {
    const v = await nowhere.verify(lost.id, { widths: [390] });
    assert.equal(v.failed, 'styles');
    assert.deepEqual(v.differences, [{ kind: 'style', edit: lost.id, width: 390, element: lost.label, property: 'element', design: 'not found on the page', result: 'not found on the page' }]);
  } finally { nowhere.done(); }

  for (const over of [{ enabled: false }, { trusted: false }]) {
    const e = edit({ state: 'implemented' });
    const x = wire({ edits: [e], ...over });
    try {
      assert.deepEqual(await x.apply(), { page: '', shown: [], orphaned: [], elsewhere: [], off: true });
      assert.equal(await x.target(), null);
      assert.deepEqual(await x.implement(e.id), { ok: false, id: e.id, route: 'none', why: 'The live view is off.' });
      await assert.rejects(x.verify(e.id), /The live view is off/);
      assert.deepEqual([x.page.calls, x.renders, x.marks], [[], [], []]);
    } finally { x.done(); }
  }
});
