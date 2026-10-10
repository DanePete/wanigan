// The design layer's main-process side with stand-ins: a fake ipc, a fake core client, a page script played by a
// small model of a page, a site answering the helper's schema save, and a render seam for the verification
// (Electron's windows cannot open under this runner). What is checked is what reaches the page, the core, the site and
// the data folder. Made-up site (acme); nothing real.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compileLayer, layerTextHash, type LayerApplied, type LayerEdit, type LayerImplemented, type LayerPickTarget, type LayerVerdict } from '../shared/design-layer.ts';
import { parseVerdict, type Bitmap, type ElementSnap, type PageSnap } from '../shared/layer-verify.ts';
import type { LiveEditSaved } from '../shared/live-lens.ts';
import type { EditTarget, LiveTrace, PartIdentity, TracePart } from '../shared/live-trace.ts';
import { folderOf } from './live-capture.ts';
import { saveSchemaEdit } from './live-edit-save.ts';
import {
  areasOf, beforeCheck, beforeKept, madeOn, masksOf, pathOf, steadyOf, traceProblem, wireLiveLayer,
  type BeforeKept, type LayerBeforeRender, type LayerRender, type LayerRenderRequest,
} from './live-layer.ts';
import type { HelperSaved, SaveAt } from './live-view.ts';

// Plainly not a key: the helper's real token is random hex the core keeps.
const TOKEN = ['stand', 'in', 'token'].join('-');
const BASE = 'https://acme.example.test/';

const card = (nth: number): PartIdentity => ({ kind: 'component', name: 'acme:card', within: null, nth });
/** A made-up article's title field in French, as the Drupal helper names it (its UUID, not its id). */
const UUID = 'c0ffee00-0000-4000-8000-000000000012';
const title = (over: Partial<Extract<PartIdentity, { kind: 'entity' }>> = {}): PartIdentity => ({ kind: 'entity', type: 'node', id: UUID, bundle: 'article', langcode: 'fr', field: 'title', ...over });
const trace = (): LiveTrace => ({
  version: 1, platform: 'drupal', id: '0123456789abcdef', url: '/paddling', at: 1, total: { ms: 1 }, edits: [],
  parts: [
    { id: 'p1', kind: 'component', label: 'Card', identity: card(0) },
    { id: 'p2', kind: 'component', label: 'Card', identity: card(1) },
    { id: 'p3', kind: 'component', label: 'Hero', identity: { kind: 'component', name: 'acme:hero', within: null, nth: 0 } },
    { id: 'p4', kind: 'block', label: 'Footer note' },
    { id: 'p6', kind: 'field', label: 'Title', identity: title() },
    { id: 'p7', kind: 'field', label: 'Tags #2', identity: title({ field: 'field_tags', item: 'delta:1' }) },
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
      const wordsOf = (e: El): string | null => (e.plain ? e.text : null);
      return (el ? {
        count: els.length, field: el.field ?? null, words: wordsOf(el), plain: el.plain,
        same: wordsOf(el) !== null && els.every((e) => e.plain && wordsOf(e) === wordsOf(el) && (e.field ?? null) === (el.field ?? null)),
      } : { count: 0, field: null, words: null, plain: false, same: false }) as T;
    }
    return fallback;
  };
  return { page, run };
}

/** What the stand-in site answers a schema save (`POST /_wanigan/edit/<id>`): a status and its JSON. */
interface SiteAnswer { status: number; body: unknown }

function wire(over: {
  edits?: LayerEdit[]; url?: string; trace?: LiveTrace | null; trusted?: boolean; enabled?: boolean; render?: LayerRender; renderBefore?: LayerBeforeRender; renderMs?: number;
  saved?: { ok: boolean; error: string | null }; refuseMark?: string; site?: SiteAnswer; decode?: (png: Buffer) => Promise<Bitmap>;
  helper?: (at: SaveAt | undefined) => HelperSaved; now?: () => number;
} = {}) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const dataDir = mkdtempSync(join(tmpdir(), 'wanigan-layer-'));
  const { page, run } = modelPage();
  let edits = over.edits ?? [];
  const marks: { id: string; state: string; verdict?: LayerVerdict }[] = [];
  const saves: unknown[][] = [];
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
        if (over.refuseMark) throw new Error(over.refuseMark);
        marks.push({ id: params.id as string, state: params.state as string, ...(params.verdict ? { verdict: params.verdict as LayerVerdict } : {}) });
        edits = edits.map((e) => (e.id === params.id ? { ...e, state: params.state as LayerEdit['state'] } : e));
        return { projectId: 'p1', edits, undo: null, redo: null };
      }
      if (method === 'live.site') return { projectId: 'p1', url: BASE, token: TOKEN, helper: { kind: 'drupal', version: 4, outdated: false } };
      throw new Error(`unexpected ${method}`);
    },
  };
  const renders: LayerRenderRequest[] = [];
  const befores: LayerRenderRequest[] = [];
  /** What reached the site and the hidden windows, in order: a page from before is kept before the save. */
  const order: string[] = [];
  const traced = over.trace === undefined ? trace() : over.trace;
  const wired = wireLiveLayer({
    ipc: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); } } as never,
    trusted: () => over.trusted ?? true,
    enabled: () => over.enabled ?? true,
    client: async () => client as never,
    current: () => ({ projectId: 'p1', base: BASE, token: TOKEN, env: null, webContents: webContents as never }),
    run,
    trace: async () => (traced ? { state: 'ok', trace: traced } : { state: 'missing' }),
    helperSave: async (field, before, after, at) => {
      order.push('save');
      saves.push([field, before, after, at]);
      if (over.helper) return over.helper(at);
      return over.saved ? { ...over.saved, label: 'Paddling 101' } : { ok: true, error: null, label: 'Paddling 101', revision: '42' };
    },
    // live-inspect.ts schemaSave, played here: the target found in the trace the view holds (Electron's ipcMain cannot
    // load under this runner), then the real save in live-edit-save.ts against a stand-in site.
    schemaSave: async (id, value, tracedId): Promise<LiveEditSaved> => {
      const t = traced?.edits.find((e) => e.id === id);
      if (!traced || !t) return { ok: false, error: 'This page’s trace offers no such edit. Reload it, then try again.', revision: null };
      if (tracedId !== traced.id) return { ok: false, error: 'This page changed since Wanigan read its trace. Reload it, then try again.', revision: null };
      return saveSchemaEdit({
        trace: traced.id, target: t, reload: () => webContents.reloadIgnoringCache(),
        post: async (path, body) => {
          order.push('save');
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
    renderBefore: async (r) => { order.push(`before ${r.width}`); befores.push(r); return over.renderBefore ? over.renderBefore(r) : { error: 'no render in this test' }; },
    ...(over.decode ? { decode: over.decode } : {}),
    encode: async () => Buffer.from('diff-png'),
    now: over.now ?? (() => 1_700_000_000_000),
    seed: () => 4242,
    ...(over.renderMs ? { renderMs: over.renderMs } : {}),
  });
  const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => (handlers.get(channel) as (...a: unknown[]) => Promise<T>)({}, ...args);
  return {
    page, marks, saves, posts, sheets, renders, befores, order, dataDir, wired,
    /** What was kept of the page as it was for an edit, as verifyNow reads it. */
    kept: (id: string): BeforeKept | null => { try { return beforeKept(JSON.parse(readFileSync(join(dataDir, 'live-layer', folderOf('p1'), id, 'before', 'meta.json'), 'utf8'))); } catch { return null; } },
    setEdits: (next: LayerEdit[]) => { edits = next; },
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
    assert.deepEqual(w.page.set, { tags: { [e.id]: [0] }, texts: [], on: true, gate: 'g1' });
    assert.deepEqual(w.sheets.inserted, [compileLayer([e], [], 'g1')], 'its rules hold only while the page’s root names its generation');
    assert.deepEqual(w.sheets.origins, ['user'], 'the user origin: its !important outranks the page’s, layered or not');
    assert.match(w.sheets.inserted[0]!, new RegExp(`\\[data-wl-edit~="${e.id}"\\]\\[data-wl-edit~="${e.id}"\\] \\{ color: #123456 !important; \\}`));
    assert.deepEqual(applied, { page: '/paddling', shown: [{ id: e.id, elements: 1 }], orphaned: [], elsewhere: [], off: false });
    assert.deepEqual(w.marks, [], 'nothing changed state');
    // Applied again: a new generation, and the page is switched to it in the same call that tags. The old sheet is let
    // go of only after, and holds nothing either way (Electron cannot take a user-origin sheet out).
    await w.apply();
    assert.deepEqual([w.sheets.inserted.length, w.sheets.removed, w.page.set?.gate], [2, ['key-1'], 'g2']);
    assert.ok(w.sheets.inserted[1]!.includes(':root[data-wl-layer="g2"]') && !w.sheets.inserted[1]!.includes('"g1"'));
    const order = w.page.calls.filter((c) => c.name === 'layerSet').length;
    assert.equal(order, 2);
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

test('words the layer’s own text edit saved are not other words: a style on that element, or a card around it, still resolves', async () => {
  // A heading was retyped through the layer and saved: the site renders the new words. A style on the heading and one on
  // the card around it were keyed to the old words.
  const saved = edit({ label: 'Heading', state: 'implemented', change: { type: 'text', value: 'Paddling 102' }, before: { text: 'Paddling 101' } });
  const style = edit();
  const cardStyle = edit({ label: 'Card', target: { part: card(0), inner: null, selector: null, textHash: layerTextHash('Paddling 101 Learn the strokes') } });
  const w = wire({ edits: [saved, style, cardStyle] });
  try {
    w.page.parts = { p1: { 'h2:nth-of-type(1)': [words('Paddling 102')], '': [holding('Paddling 102 Learn the strokes')] } };
    const applied = await w.apply();
    assert.deepEqual(applied.orphaned, [], 'none orphaned by words the layer itself saved');
    assert.deepEqual(applied.shown.map((s) => s.id), [saved.id, style.id, cardStyle.id]);
    // A card that moved into the place, with other words, is still told apart.
    w.page.parts = { p1: { 'h2:nth-of-type(1)': [words('Canoeing 201')], '': [holding('Canoeing 201 Longer trips')] } };
    assert.deepEqual((await w.apply()).orphaned.map((o) => o.id).sort(), [style.id, cardStyle.id, saved.id].sort());
  } finally { w.done(); }
  // A draft that was never saved does not vouch for anything: its words are not the site's.
  const draft = edit({ label: 'Heading', change: { type: 'text', value: 'Paddling 102' }, before: { text: 'Paddling 101' } });
  const keyed = edit();
  const d = wire({ edits: [draft, keyed] });
  try {
    d.page.parts = { p1: { 'h2:nth-of-type(1)': [words('Paddling 102')] } };
    assert.deepEqual((await d.apply()).orphaned.map((o) => o.id), [keyed.id], 'the site shows other words, and no saved edit of the layer explains them');
  } finally { d.done(); }
});

test('an implemented edit stays implemented: a load where it is not found says so, and never makes it a draft or orphaned', async () => {
  const saved = edit({ label: 'Heading', state: 'implemented', change: { type: 'text', value: 'Paddling 102' }, before: { text: 'Paddling 101' } });
  const draft = edit();
  const w = wire({ edits: [saved, draft] });
  try {
    // A template filter changed the saved words, or the element streamed in after the load: neither resolves.
    w.page.parts = { p1: { 'h2:nth-of-type(1)': [words('Something else')] } };
    const lost = await w.apply();
    assert.deepEqual(lost.orphaned.map((o) => o.id), [saved.id, draft.id], 'both said to the window');
    assert.match(lost.orphaned[0]!.why, /in the site, so it stays implemented/);
    assert.deepEqual(w.marks, [{ id: draft.id, state: 'orphaned' }], 'only the draft is orphaned; the implemented edit is not touched');
    // Found again: the implemented edit is still implemented, not a draft.
    w.page.parts = { p1: { 'h2:nth-of-type(1)': [words('Paddling 102')] } };
    const back = await w.apply();
    assert.ok(back.shown.some((x) => x.id === saved.id));
    assert.deepEqual(w.marks.filter((m) => m.id === saved.id), []);
    assert.equal(w.edits().find((e) => e.id === saved.id)?.state, 'implemented');
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
    assert.deepEqual(w.page.set, { tags: { [e.id]: [0] }, texts: [{ id: e.id, value: 'Paddling 102' }], on: true, gate: 'g1' });
    w.page.parts = { p1: { 'h2:nth-of-type(1)': [words('Paddling 102')] } };
    assert.deepEqual((await w.apply()).orphaned, [], 'its own new words are not other words');
    const sheetsBefore = w.sheets.inserted.length;
    const off = await w.show(false);
    assert.equal(off.off, true);
    assert.deepEqual(off.shown, []);
    assert.deepEqual(w.page.set, { tags: { [e.id]: [0] }, texts: [], on: false, gate: null }, 'tags may stay; words go back; the root names no generation, so no sheet holds');
    assert.equal(w.sheets.inserted.length, sheetsBefore, 'nothing new is injected to switch it off');
    const onAgain = await w.show(true);
    assert.equal(onAgain.off, false);
  } finally { w.done(); }
});

test('an edit for a named breakpoint is left out whole: its words are not patched at every width, its styles not shown', async () => {
  const words102 = edit({ breakpoint: 'wide', change: { type: 'text', value: 'Paddling 102' } });
  const styled = edit({ breakpoint: 'wide' });
  const w = wire({ edits: [words102, styled] });
  try {
    w.page.parts = { p1: { 'h2:nth-of-type(1)': [words('Paddling 101')] } };
    const applied = await w.apply();
    assert.deepEqual(w.page.set, { tags: {}, texts: [], on: true, gate: 'g1' });
    assert.deepEqual([applied.shown, applied.orphaned], [[], []]);
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

test('a WordPress block keyed only by its place is fragile when it shows no words to check, and not when it does', async () => {
  const group: PartIdentity = { kind: 'block', store: 'tpl:acme//single', path: [2], name: 'core/group' };
  const wp: LiveTrace = { ...trace(), platform: 'wordpress', parts: [{ id: 'w1', kind: 'block', label: 'Group', identity: group }] };
  const w = wire({ trace: wp });
  try {
    w.page.pick = { parts: [{ part: 'w1', inner: null }], selector: 'html > body:nth-of-type(1) > div:nth-of-type(1)', text: null, tag: 'div', values: {} };
    const empty = await w.target();
    assert.deepEqual([empty?.target.part, empty?.target.textHash, empty?.fragile], [group, null, true], 'named by its place, nothing to guard it');
    w.page.pick = { ...(w.page.pick as object), text: 'Spring paddling' };
    assert.equal((await w.target())?.fragile, false, 'its words guard it: a reorder orphans the edit');
  } finally { w.done(); }
});

test('a Layout Builder component’s kind is every component of its plugin in a layout, apart from the same block placed in a region, and each says which', async () => {
  const promo = 'block_content:0a1b2c3d-0000-4000-8000-0000000000e5';
  const inLayout = (uuid: string, plugin: string): PartIdentity => ({ kind: 'config', type: 'layout_builder_component', id: `node:0a1b2c3d-0000-4000-8000-000000000014/${uuid}`, plugin });
  const spring = inLayout('7e57ab1e-0000-4000-8000-000000000001', 'inline_block:card');
  const promoInLayout = inLayout('7e57ab1e-0000-4000-8000-000000000003', promo);
  const lbTrace: LiveTrace = {
    ...trace(),
    parts: [
      { id: 'p1', kind: 'block', label: 'Spring sale', identity: spring },
      { id: 'p2', kind: 'block', label: 'Summer sale', identity: inLayout('7e57ab1e-0000-4000-8000-000000000002', 'inline_block:card') },
      { id: 'p3', kind: 'block', label: 'Promo in a layout', identity: promoInLayout },
      { id: 'p4', kind: 'block', label: 'Promo in a region', identity: { kind: 'config', type: 'block', id: 'acme_promo', plugin: promo } },
      { id: 'p5', kind: 'menu', label: 'Main navigation', identity: { kind: 'config', type: 'menu', id: 'main' } },
      { id: 'p6', kind: 'block', label: 'Body', identity: inLayout('7e57ab1e-0000-4000-8000-000000000004', 'field_block:node:landing_page:body') },
    ],
  };
  const cards = edit({ scope: 'kind', target: { part: spring, inner: 'p:nth-of-type(1)', selector: null, textHash: layerTextHash('Spring') } });
  const promos = edit({ scope: 'kind', target: { part: promoInLayout, inner: null, selector: null, textHash: null } });
  const w = wire({ edits: [cards, promos], trace: lbTrace });
  try {
    w.page.parts = {
      p1: { 'p:nth-of-type(1)': [words('Spring')], '': [holding('Spring')] }, p2: { 'p:nth-of-type(1)': [words('Summer')], '': [holding('Summer')] },
      p3: { '': [holding('Promo')] }, p4: { '': [holding('Promo')] }, p5: { '': [holding('Home About')] }, p6: { '': [holding('Body')] },
    };
    await w.apply();
    const asked = w.page.calls.find((c) => c.name === 'layerFind')?.args[0] as { id: string; parts: string[] }[];
    assert.deepEqual(asked.map((s) => [s.id, s.parts]), [[cards.id, ['p1', 'p2']], [promos.id, ['p3']]], 'every card in a layout; the promo in a layout, not where it is placed in a region');

    const pick = async (part: string, inner: string | null, tag: string): Promise<LayerPickTarget | null> => {
      w.page.pick = { parts: [{ part, inner }], selector: 'html > body:nth-of-type(1) > div:nth-of-type(1)', text: null, tag, values: {} };
      return w.target();
    };
    const card = await pick('p1', 'p:nth-of-type(1)', 'p');
    assert.deepEqual([card?.target.part, card?.label, card?.kindLabel, card?.kindCount, card?.fragile], [spring, 'Paragraph in Spring sale (block)', 'the paragraph in every card inline block placed in a layout', 2, false]);
    assert.equal((await pick('p3', null, 'div'))?.kindLabel, 'this reusable block wherever it is placed in a layout');
    assert.equal((await pick('p4', null, 'div'))?.kindLabel, 'this reusable block wherever it is placed in a region');
    assert.equal((await pick('p6', null, 'div'))?.kindLabel, 'every landing_page body field block placed in a layout');
    const menu = await pick('p5', null, 'nav');
    assert.deepEqual([menu?.target.part, menu?.kindLabel, menu?.kindCount, menu?.fragile], [{ kind: 'config', type: 'menu', id: 'main' }, null, 0, false], 'a menu is named, and has no kind beyond itself');
  } finally { w.done(); }
});

test('making an edit real: words go through the helper’s save, a style goes to an agent, and the core is told', async () => {
  const retyped = edit({ label: 'Title', change: { type: 'text', value: 'Pagayer 102' }, target: { part: title(), inner: null, selector: null, textHash: layerTextHash('Pagayer 101') } });
  const style = edit();
  const every = edit({ scope: 'kind', change: { type: 'text', value: 'Same everywhere' } });
  // The card's props hold the same words as a schema target: a field the helper marked is saved through its own save all the same.
  const props: EditTarget = { id: 'props.0a1b2c3d4e5f', kind: 'props', label: 'Card props', via: 'schema', schema: { type: 'object', properties: { title: { type: 'string' } } }, value: { title: 'Paddling 101' } };
  const drupal: LiveTrace = { ...trace(), parts: trace().parts.map((p) => (p.id === 'p1' ? { ...p, edits: [props.id] } : p)), edits: [props] };
  const w = wire({ edits: [retyped, style, every], trace: drupal });
  try {
    w.page.parts = { p1: { 'h2:nth-of-type(1)': [words('Paddling 101')] }, p6: { '': [words('Pagayer 101', 'node:12:title:string:fr')] } };
    await w.apply();
    assert.deepEqual(await w.implement(style.id), { ok: false, id: style.id, route: 'agent', why: 'A style goes into the theme’s CSS: in phase 1 an agent makes it from a brief, on your click.' });
    const kind = await w.implement(every.id);
    assert.ok(!kind.ok && kind.route === 'none' && /one element at a time/.test(kind.why));
    assert.deepEqual(w.saves, [], 'nothing was saved for either');
    const done = await w.implement(retyped.id);
    assert.deepEqual(done, { ok: true, id: retyped.id, state: 'implemented', revision: '42' });
    assert.deepEqual(w.saves, [['node:12:title:string:fr', 'Pagayer 101', 'Pagayer 102', { uuid: UUID, langcode: 'fr', item: null }]],
      'the field the helper marked, the words the site has, the new words, and the content, translation and item the target names');
    assert.deepEqual(w.posts, [], 'no schema target is asked when the helper marked the field');
    assert.deepEqual(w.marks.at(-1), { id: retyped.id, state: 'implemented' });
    assert.equal(w.sheets.reloads, 1, 'the page shows what the site now has');
    const again = await w.implement(retyped.id);
    assert.ok(!again.ok && /in the site already/.test(again.why));
  } finally { w.done(); }
});

test('the same stored thing shown twice is saved once; elements that differ, or that a document path matched, are refused', async () => {
  // The article's title in the page and again in a sidebar teaser: one identity, two elements, the same field mark.
  const twice: LiveTrace = { ...trace(), parts: [...trace().parts, { id: 'p8', kind: 'field', label: 'Title', identity: title() }] };
  const retyped = edit({ label: 'Title', change: { type: 'text', value: 'Pagayer 102' }, target: { part: title(), inner: null, selector: null, textHash: layerTextHash('Pagayer 101') } });
  const w = wire({ edits: [retyped], trace: twice });
  try {
    const mark = 'node:12:title:string:fr';
    w.page.parts = { p6: { '': [words('Pagayer 101', mark)] }, p8: { '': [words('Pagayer 101', mark)] } };
    assert.deepEqual((await w.apply()).shown, [{ id: retyped.id, elements: 2 }]);
    assert.deepEqual(await w.implement(retyped.id), { ok: true, id: retyped.id, state: 'implemented', revision: '42' });
    assert.deepEqual(w.saves, [[mark, 'Pagayer 101', 'Pagayer 102', { uuid: UUID, langcode: 'fr', item: null }]], 'saved once, to the content, translation and item it names');
  } finally { w.done(); }
  // The teaser shortens the title: two elements showing different words are not saved from here.
  const short = wire({ edits: [{ ...retyped, state: 'draft' }], trace: twice });
  try {
    short.page.parts = { p6: { '': [words('Pagayer 101', 'node:12:title:string:fr')] }, p8: { '': [words('Pagayer…', 'node:12:title:string:fr')] } };
    await short.apply();
    const refused = await short.implement(retyped.id);
    assert.ok(!refused.ok && /reaches 2 elements here/.test(refused.why));
    assert.deepEqual(short.saves, []);
  } finally { short.done(); }
  // A document path that matched two elements is not one stored thing, whatever they show.
  const loose = edit({ label: 'Heading', change: { type: 'text', value: 'New' }, target: { part: null, inner: null, selector: 'html > body > h2', textHash: layerTextHash('Old') } });
  const path = wire({ edits: [loose] });
  try {
    path.page.selectors = { 'html > body > h2': [words('Old', 'node:12:title:string:fr'), words('Old', 'node:12:title:string:fr')] };
    await path.apply();
    const refused = await path.implement(loose.id);
    assert.ok(!refused.ok && /reaches 2 elements here/.test(refused.why));
    assert.deepEqual(path.saves, []);
  } finally { path.done(); }
});

/** On a Drupal page, words nothing holds and no template around them writes. */
const DRUPAL_NOTHING_HOLDS = 'Nothing this page offers to edit holds exactly these words, and Wanigan finds them written in no template around them: code makes them (a formatter, a module or the theme) from something Wanigan does not save from here yet.';

test('words with no field the helper marks, or a refusal from the site, are said and nothing is marked', async () => {
  const loose = edit({ label: 'Title', change: { type: 'text', value: 'New words' }, target: { part: title(), inner: null, selector: null, textHash: layerTextHash('Paddling 101') } });
  const w = wire({ edits: [loose], saved: { ok: false, error: 'The user you are logged in as in the live view may not change this.' } });
  try {
    w.page.parts = { p6: { '': [words('Paddling 101')] } };
    await w.apply();
    const unmarked = await w.implement(loose.id);
    assert.deepEqual(unmarked, { ok: false, id: loose.id, route: 'none', why: DRUPAL_NOTHING_HOLDS }, 'no field marked, and nothing in the trace holds these words or writes them');
    assert.deepEqual([w.saves, w.posts], [[], []]);
    w.page.parts = { p6: { '': [words('Paddling 101', 'node:12:title:string:fr')] } };
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

/* ── WordPress: a block's rich text, the HTML its schema says it is ── */

/** A paragraph block in post 12's content, with its target as the helper builds it: `content` is HTML (live-helper-wordpress.ts block_edit()). */
const paragraph: PartIdentity = { kind: 'block', store: 'post:12', path: [3], name: 'core/paragraph' };
const paragraphTarget = (content: string, over: Partial<EditTarget> = {}): EditTarget => ({
  id: 'block-post-12-3', kind: 'block-attributes', label: 'Paragraph block in post “Paddling 101”', via: 'schema', revisions: true,
  schema: {
    type: 'object', additionalProperties: false,
    properties: {
      content: { type: 'string', source: 'rich-text', contentMediaType: 'text/html', description: 'Its words as HTML, with inline formatting.' },
      dropCap: { type: 'boolean', default: false },
    },
  },
  value: { content, dropCap: false },
  ...over,
});
const withParagraph = (t: EditTarget): LiveTrace => wpTrace({
  parts: [{ id: 'w2', kind: 'entity', label: 'Post 12: Paddling 101', identity: postContent, edits: postEdits().map((e) => e.id) }, { id: 'b3', kind: 'block', label: 'Paragraph', parent: 'w2', identity: paragraph, edits: [t.id] }],
  edits: [...postEdits(), t],
});

test('WordPress: a paragraph’s words alone are saved as its rich text, escaped as the helper writes text, its other settings as they were', async () => {
  const target = paragraphTarget('Fish &amp; chips by the lake');
  const retyped = retype(paragraph, 'Fish & "chips" <3 by the lake', 'Fish & chips by the lake');
  const w = wire({ edits: [retyped], trace: withParagraph(target) });
  try {
    w.page.parts = { b3: { '': [words('Fish & chips by the lake')] } };
    await w.apply();
    assert.deepEqual(await w.implement(retyped.id), { ok: true, id: retyped.id, state: 'implemented', revision: '43' });
    assert.deepEqual(w.posts, [{ path: '/_wanigan/edit/block-post-12-3', body: { trace: '0123456789abcdef', value: { content: 'Fish &amp; &quot;chips&quot; &lt;3 by the lake', dropCap: false } } }],
      'the typed < and quotes are words, never markup: & < > " \' escaped as WordPress’s HTML processor writes text');
    assert.deepEqual(w.marks, [{ id: retyped.id, state: 'implemented' }]);
    assert.deepEqual(w.order, ['before 390', 'before 1440', 'save'], 'the page as it was is kept before the words are saved');
  } finally { w.done(); }

  // A block attribute read as text (`source: text`, said text/plain): the helper escapes it itself, so the words go as they are.
  const plain: EditTarget = { ...paragraphTarget('x'), id: 'block-post-12-4', label: 'Code block in post “Paddling 101”', schema: { type: 'object', properties: { content: { type: 'string', source: 'text', contentMediaType: 'text/plain' } } }, value: { content: 'a < b && c' } };
  const code = retype({ ...paragraph, path: [4], name: 'core/code' }, 'a <= b && c', 'a < b && c');
  const c = wire({ edits: [code], trace: wpTrace({ parts: [{ id: 'b4', kind: 'block', label: 'Code', identity: { ...paragraph, path: [4], name: 'core/code' }, edits: [plain.id] }], edits: [plain] }) });
  try {
    c.page.parts = { b4: { '': [words('a < b && c')] } };
    await c.apply();
    assert.equal((await c.implement(code.id)).ok, true);
    assert.deepEqual(c.posts.map((x) => x.body), [{ trace: '0123456789abcdef', value: { content: 'a <= b && c' } }]);
  } finally { c.done(); }
});

test('WordPress: words between a paragraph’s tags are saved in their run with every tag kept; a change across them goes to an agent, saying so', async () => {
  const html = 'Read <a href="/trails/" class="acme-link">the trail guide</a> before you go.';
  const shown = 'Read the trail guide before you go.';
  const target = paragraphTarget(html);
  const inRun = retype(paragraph, 'Read the trail guide before you set out.', shown);
  const a = wire({ edits: [inRun], trace: withParagraph(target) });
  try {
    a.page.parts = { b3: { '': [words(shown)] } };
    await a.apply();
    assert.equal((await a.implement(inRun.id)).ok, true);
    assert.deepEqual(a.posts.map((x) => x.body), [{ trace: '0123456789abcdef', value: { content: 'Read <a href="/trails/" class="acme-link">the trail guide</a> before you set out.', dropCap: false } }],
      'the link, its address and class byte for byte; only the words after it changed');
  } finally { a.done(); }

  const across = retype(paragraph, 'Read our trail notes & go.', shown);
  const b = wire({ edits: [across], trace: withParagraph(target) });
  try {
    b.page.parts = { b3: { '': [words(shown)] } };
    await b.apply();
    assert.deepEqual(await b.implement(across.id), {
      ok: false, id: across.id, route: 'agent',
      why: 'These words are formatted text (Paragraph block in post “Paddling 101”) and the change it crosses its formatting (a link, bold or another inline tag): Wanigan saves new words between tags only where the change falls within one run of words. An agent can make the change from a brief.',
    });
    assert.deepEqual([b.posts, b.marks], [[], []], 'nothing sent, nothing marked');
    assert.deepEqual(b.order, ['before 390', 'before 1440'], 'handed to an agent, the page as it is is kept for step 3 first');
  } finally { b.done(); }
});

test('WordPress: words kept in something shown beyond this page are said with where, and saved only when made real again', async () => {
  // A paragraph in the single template: its words show on every page that uses the template.
  const inTemplate: PartIdentity = { kind: 'block', store: 'tpl:acme//single', path: [2], name: 'core/paragraph' };
  const shared = paragraphTarget('Open daily', {
    id: 'block-tpl-2', label: 'Paragraph block in the template “Single” (shows on every page that uses this template)', shows: 'every page that uses the template “Single”',
  });
  const traced = wpTrace({ parts: [...wpTrace().parts, { id: 'b5', kind: 'block', label: 'Paragraph', parent: 'w0', identity: inTemplate, edits: [shared.id] }], edits: [...postEdits(), titleAttributes, shared] });
  const retyped = retype(inTemplate, 'Open every day', 'Open daily');
  let now = 1_000;
  const w = wire({ edits: [retyped], trace: traced, now: () => now });
  try {
    w.page.parts = { b5: { '': [words('Open daily')] } };
    await w.apply();
    const asked = 'These words are kept in Paragraph block in the template “Single” (shows on every page that uses this template): saving them changes it wherever it shows (every page that uses the template “Single”), not only on this page. Make it real again to save them there.';
    assert.deepEqual(await w.implement(retyped.id), { ok: false, id: retyped.id, route: 'none', why: asked });
    assert.deepEqual([w.posts, w.marks, w.order], [[], [], []], 'nothing rendered or saved until asked again');
    // Asked again after five minutes: said again, not saved.
    now += 5 * 60_000 + 1;
    assert.deepEqual(await w.implement(retyped.id), { ok: false, id: retyped.id, route: 'none', why: asked });
    assert.equal(w.posts.length, 0, 'said again, not saved');
    now += 1_000;
    assert.deepEqual(await w.implement(retyped.id), { ok: true, id: retyped.id, state: 'implemented', revision: '43' });
    assert.deepEqual(w.posts.map((x) => x.body), [{ trace: '0123456789abcdef', value: { content: 'Open every day', dropCap: false } }]);
  } finally { w.done(); }

  // Refused as formatted, it says where the words show too: the brief an agent gets carries it.
  const across = retype(inTemplate, 'See a trail guide', 'Read the trail guide');
  const linked = { ...shared, value: { content: 'Read <a href="/trails/">the trail guide</a>', dropCap: false } };
  const b = wire({ edits: [across], trace: { ...traced, edits: [...postEdits(), titleAttributes, linked] } });
  try {
    b.page.parts = { b5: { '': [words('Read the trail guide')] } };
    await b.apply();
    const refused = await b.implement(across.id);
    assert.ok(!refused.ok && refused.route === 'agent' && refused.why.endsWith('Saved there, they would change it wherever it shows (every page that uses the template “Single”).'), JSON.stringify(refused));
  } finally { b.done(); }
});

test('WordPress: formatted text goes to an agent as a brief, and nothing is saved', async () => {
  // A dynamic block's setting its schema does not call HTML or text: how the site prints it is not known, so its
  // words are not written from here.
  const block: PartIdentity = { kind: 'block', store: 'post:12', path: [2], name: 'acme/notice' };
  const rich: EditTarget = {
    id: 'block-post-12-2', kind: 'block-attributes', label: 'Notice block in post “Paddling 101”', via: 'schema', revisions: true,
    schema: { type: 'object', properties: { content: { type: 'string' }, level: { type: 'integer' } }, additionalProperties: false },
    value: { content: 'Before the lake', level: 2 },
  };
  const headed = retype(block, 'Before the river', 'Before the lake');
  const a = wire({ edits: [headed], trace: wpTrace({ parts: [{ id: 'w2', kind: 'entity', label: 'Post 12: Paddling 101', identity: postContent, edits: postEdits().map((e) => e.id) }, { id: 'b1', kind: 'block', label: 'Heading', parent: 'w2', identity: block, edits: [rich.id] }], edits: [...postEdits(), rich] }) });
  try {
    a.page.parts = { b1: { '': [words('Before the lake')] } };
    await a.apply();
    assert.deepEqual(await a.implement(headed.id), {
      ok: false, id: headed.id, route: 'agent',
      why: 'These words are formatted text (Notice block in post “Paddling 101”): the site keeps them with their markup, which Wanigan does not save from here. An agent can make the change from a brief.',
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

test('words are saved only to the field, translation and item the edit’s target names', async () => {
  // The second of two tags that hold the same words, in French: the save names that item and that translation.
  const tag = edit({ label: 'Tag', change: { type: 'text', value: 'Kayak' }, target: { part: title({ field: 'field_tags', item: 'delta:1' }), inner: null, selector: null, textHash: layerTextHash('Canoe') } });
  // A heading in a card component whose words a field marked around it holds: the target names no field.
  const inCard = edit({ change: { type: 'text', value: 'Paddling 102' } });
  // The target names the body, but the field marked around its element is the title.
  const otherField = edit({ label: 'Body', change: { type: 'text', value: 'Pagayer 102' }, target: { part: title({ field: 'body' }), inner: null, selector: null, textHash: layerTextHash('Pagayer 101') } });
  // A target from a helper that named no language.
  const noLanguage = edit({ label: 'Title', change: { type: 'text', value: 'Pagayer 102' }, target: { part: title({ langcode: undefined }), inner: null, selector: null, textHash: layerTextHash('Pagayer 101') } });
  const traced: LiveTrace = { ...trace(), parts: [...trace().parts, { id: 'p8', kind: 'field', label: 'Body', identity: title({ field: 'body' }) }, { id: 'p9', kind: 'field', label: 'Title', identity: title({ langcode: undefined }) }] };
  const w = wire({ edits: [tag, inCard, otherField, noLanguage], trace: traced });
  try {
    w.page.parts = {
      p7: { '': [words('Canoe', 'node:12:field_tags:string:fr')] },
      p1: { 'h2:nth-of-type(1)': [words('Paddling 101', 'node:12:title:string:fr')] },
      p8: { '': [words('Pagayer 101', 'node:12:title:string:fr')] },
      p9: { '': [words('Pagayer 101', 'node:12:title:string:fr')] },
    };
    await w.apply();
    assert.equal((await w.implement(tag.id)).ok, true);
    assert.deepEqual(w.saves, [['node:12:field_tags:string:fr', 'Canoe', 'Kayak', { uuid: UUID, langcode: 'fr', item: 'delta:1' }]], 'that item, in that translation, of that content');
    const refusals = [await w.implement(inCard.id), await w.implement(otherField.id), await w.implement(noLanguage.id)];
    assert.deepEqual(refusals.map((r) => (r.ok ? 'saved' : r.route)), ['none', 'none', 'none']);
    assert.match(refusals[0]!.ok ? '' : refusals[0]!.why, /not a field of content the helper names/);
    assert.match(refusals[1]!.ok ? '' : refusals[1]!.why, /not the one its target names/);
    assert.match(refusals[2]!.ok ? '' : refusals[2]!.why, /which translation/);
    assert.equal(w.saves.length, 1, 'nothing else was saved');
    assert.deepEqual(w.marks.map((m) => [m.id, m.state]), [[tag.id, 'implemented']]);
  } finally { w.done(); }
});

test('the layer refusing to record what happened is said: words saved stay said, the page still reloads, and a verdict is not passed off as kept', async () => {
  const retyped = edit({ label: 'Title', change: { type: 'text', value: 'Pagayer 102' }, target: { part: title(), inner: null, selector: null, textHash: layerTextHash('Pagayer 101') } });
  const w = wire({ edits: [retyped], refuseMark: 'That edit is not in the layer now: it was undone or discarded.' });
  try {
    w.page.parts = { p6: { '': [words('Pagayer 101', 'node:12:title:string:fr')] } };
    await w.apply();
    const done = await w.implement(retyped.id);
    assert.equal(w.saves.length, 1);
    assert.deepEqual(done, { ok: false, id: retyped.id, route: 'none', why: 'The words are saved in the site (revision 42), but the layer could not mark this edit implemented: That edit is not in the layer now: it was undone or discarded. Do not save it again; it is in the site.' });
    assert.equal(w.sheets.reloads, 1, 'the page shows what the site now has');
  } finally { w.done(); }
  const e = edit({ state: 'implemented' });
  const v = wire({ edits: [e], refuseMark: 'An edit is verified only by a verification that passed.', render: renders(e, { design: (b) => b, result: (b) => b }) });
  try {
    await assert.rejects(v.verify(e.id, { widths: [390] }), /The verification ran \(its pictures are kept\), but the layer did not record it: “Heading in Card \(component\)”: An edit is verified only by a verification that passed\./);
  } finally { v.done(); }
});

test('the pictures of edits the layer no longer lists are taken away, and nothing else', async () => {
  const kept = edit({ state: 'implemented' });
  const w = wire({ edits: [kept] });
  try {
    const dir = join(w.dataDir, 'live-layer', folderOf('p1'));
    for (const id of [kept.id, 'discarded-1', 'retired-2']) { mkdirSync(join(dir, id), { recursive: true }); writeFileSync(join(dir, id, '390-design.png'), 'x'); }
    mkdirSync(join(dir, 'Not An Edit'), { recursive: true });
    await w.apply();
    assert.deepEqual([kept.id, 'discarded-1', 'retired-2', 'Not An Edit'].map((d) => existsSync(join(dir, d))), [true, false, false, true]);
  } finally { w.done(); }
});

test('a render that cannot read its trace says so, rather than calling its edits not found', () => {
  const keyed = edit({ state: 'implemented' });
  const loose = edit({ state: 'implemented', target: { part: null, inner: null, selector: 'html > body:nth-of-type(1) > h2:nth-of-type(1)', textHash: null } });
  assert.equal(traceProblem([keyed], '0123456789abcdef', { state: 'ok', trace: trace() }), null);
  assert.equal(traceProblem([loose], null, null), null, 'an edit keyed by a document path needs no trace');
  assert.match(traceProblem([keyed], null, null) ?? '', /^This render could not read the page’s trace: the page came without the helper’s trace .* nothing was compared/);
  assert.match(traceProblem([keyed], '0123456789abcdef', { state: 'down', error: 'connection refused' }) ?? '', /the site did not answer for it \(connection refused\)/);
  assert.match(traceProblem([keyed], '0123456789abcdef', { state: 'expired' }) ?? '', /no longer kept it/);
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
function renders(e: LayerEdit, draw: { design: (b: Bitmap, n: number, width: number) => Bitmap; result: (b: Bitmap, n: number, width: number) => Bitmap; designColor?: string }): LayerRender {
  let results = 0, designs = 0;
  return async (r) => {
    const base = blank(64, 200);
    if (r.design) return { png: Buffer.from(`design-${r.width}`), bitmap: draw.design(base, designs++, r.width), elements: [heading(e.id, draw.designColor ?? 'rgb(18, 52, 86)')], found: [e.id] };
    return { png: Buffer.from(`result-${r.width}`), bitmap: draw.result(base, results++, r.width), elements: [heading(e.id, 'rgb(18, 52, 86)')], found: [e.id] };
  };
}

test('a verification renders the result and the design twice each at each width, and passes when they match', async () => {
  const e = edit({ state: 'implemented' });
  const w = wire({ edits: [e], render: renders(e, { design: (b) => painted(b, { x: 20, y: 40, width: 40, height: 24 }, 18), result: (b) => painted(b, { x: 20, y: 40, width: 40, height: 24 }, 18) }) });
  try {
    const verdict = await w.verify(e.id);
    assert.deepEqual([verdict.ok, verdict.failed, verdict.widths, verdict.noise, verdict.differences], [true, null, [390, 1440], { maxDiff: 0, pixels: 0 }, []]);
    assert.deepEqual(w.renders.map((r) => [r.width, r.design, r.url, r.path, r.token, r.partition]), [
      [390, false, `${BASE}paddling`, '/paddling', TOKEN, 'persist:wanigan-live-p1'], [390, false, `${BASE}paddling`, '/paddling', TOKEN, 'persist:wanigan-live-p1'], [390, true, `${BASE}paddling`, '/paddling', TOKEN, 'persist:wanigan-live-p1'], [390, true, `${BASE}paddling`, '/paddling', TOKEN, 'persist:wanigan-live-p1'],
      [1440, false, `${BASE}paddling`, '/paddling', TOKEN, 'persist:wanigan-live-p1'], [1440, false, `${BASE}paddling`, '/paddling', TOKEN, 'persist:wanigan-live-p1'], [1440, true, `${BASE}paddling`, '/paddling', TOKEN, 'persist:wanigan-live-p1'], [1440, true, `${BASE}paddling`, '/paddling', TOKEN, 'persist:wanigan-live-p1'],
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
    assert.deepEqual(a.marks.map((m) => [m.state, m.verdict?.failed]), [['implemented', 'styles']], 'still in the site, with the verdict saying what differs');
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
    assert.deepEqual(d.marks.map((m) => m.state), ['implemented']);
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

test('the design is rendered twice too: what it does not repeat exactly is noise, as the result’s is', async () => {
  const e = edit({ state: 'implemented' });
  // The result repeats itself exactly; the design does not, by one level at a few pixels away from the edit.
  const jitter = (b: Bitmap) => painted(b, { x: 2, y: 2, width: 3, height: 1 }, 254);
  const w = wire({ edits: [e], render: renders(e, { design: (b, n) => (n % 2 ? jitter(b) : b), result: (b) => b }) });
  try {
    const v = await w.verify(e.id, { widths: [390] });
    assert.deepEqual([v.ok, v.failed, v.noise], [true, null, { maxDiff: 1, pixels: 3 }], 'a leak no bigger than the design’s own jitter is not a leak');
  } finally { w.done(); }
});

test('every width is judged against the one floor the verdict states, the largest over both versions and every width', async () => {
  const e = edit({ state: 'implemented' });
  // At 390 the two results happen to match exactly; at 1440 they differ by four levels at many pixels. The design
  // differs from the result at 390 by one level at a few pixels away from the edit: well inside the stated floor.
  const at1440 = (b: Bitmap, n: number) => (n % 2 ? painted(b, { x: 0, y: 100, width: 64, height: 20 }, 251) : b);
  const w = wire({ edits: [e], render: renders(e, {
    design: (b, _n, width) => (width === 390 ? painted(b, { x: 2, y: 2, width: 5, height: 1 }, 254) : b),
    result: (b, n, width) => (width === 1440 ? at1440(b, n) : b),
  }) });
  try {
    const v = await w.verify(e.id);
    assert.deepEqual([v.ok, v.failed, v.noise], [true, null, { maxDiff: 4, pixels: 1280 }], 'one floor, stated and used');
  } finally { w.done(); }
  // Past the stated floor, the same leak still fails.
  const f = edit({ state: 'implemented' });
  const x = wire({ edits: [f], render: renders(f, { design: (b) => painted(b, { x: 2, y: 2, width: 5, height: 1 }, 200), result: (b) => b }) });
  try {
    const v = await x.verify(f.id, { widths: [390] });
    assert.deepEqual([v.ok, v.failed], [false, 'rest']);
  } finally { x.done(); }
});

test('an edit found on the page but gone when it was measured fails that width: nothing is verified for want of a comparison', async () => {
  const e = edit({ state: 'implemented' });
  // The page re-rendered the element while its clock ran: the tags went with it, so the layer's rules matched nothing
  // and the design draws the same as the result.
  const w = wire({ edits: [e], render: async (r) => ({ png: Buffer.from(`x-${r.width}`), bitmap: blank(64, 200), elements: [], found: [e.id] }) });
  try {
    const v = await w.verify(e.id, { widths: [390] });
    assert.deepEqual([v.ok, v.failed], [false, 'styles']);
    assert.deepEqual(v.differences, [{ kind: 'style', edit: e.id, width: 390, element: e.label, property: 'element', design: 'its element was not there when the page was measured', result: 'its element was not there when the page was measured' }]);
    assert.deepEqual(w.marks.map((m) => m.state), ['implemented']);
  } finally { w.done(); }
});

test('a token is checked by its custom property on the root in both renders, and never passed for want of one', async () => {
  const token = edit({ label: 'Accent', scope: 'site', state: 'implemented', target: { part: null, inner: null, selector: null, textHash: null }, change: { type: 'token', name: '--color-accent', value: '#c0ffee' } });
  const on = (design: Record<string, string> | null, result: Record<string, string> | null): LayerRender => async (r) => {
    const tokens = r.design ? design : result;
    return { png: Buffer.from('x'), bitmap: blank(64, 200), elements: [], found: [], ...(tokens ? { tokens } : {}) };
  };
  const cases: [Record<string, string> | null, Record<string, string> | null, boolean, string | null][] = [
    [{ '--color-accent': '#c0ffee' }, { '--color-accent': '#c0ffee' }, true, null],
    [{ '--color-accent': '#c0ffee' }, { '--color-accent': '#0a7' }, false, '#0a7'],
    [{ '--color-accent': '#c0ffee' }, { '--color-accent': '' }, false, 'not set'],
    [null, null, false, 'not read'],
  ];
  for (const [design, result, ok, said] of cases) {
    const w = wire({ edits: [token], render: on(design, result) });
    try {
      const v = await w.verify(token.id, { widths: [390] });
      assert.equal(v.ok, ok, JSON.stringify([design, result]));
      if (!ok) {
        assert.equal(v.failed, 'styles');
        assert.deepEqual(v.differences, [{ kind: 'style', edit: token.id, width: 390, element: ':root', property: '--color-accent', design: design ? '#c0ffee' : 'not read', result: said }]);
      }
    } finally { w.done(); }
  }
});

test('a style for a named breakpoint fails as not verifiable yet: the design cannot show it', async () => {
  const e = edit({ state: 'implemented', breakpoint: 'wide' });
  const w = wire({ edits: [e], render: renders(e, { design: (b) => b, result: (b) => b }) });
  try {
    const v = await w.verify(e.id, { widths: [390] });
    assert.deepEqual([v.ok, v.failed], [false, 'styles']);
    assert.equal(v.differences.length, 1);
    assert.match(v.differences[0]!.kind === 'style' ? `${v.differences[0]!.property}: ${v.differences[0]!.result}` : '', /^breakpoint: not verifiable yet/);
  } finally { w.done(); }
});

test('a token verified with other edits does not switch off step 3 for them: a leak away from every element is still a leak', async () => {
  const style = edit({ state: 'implemented' });
  const token = edit({ label: 'Accent', scope: 'site', state: 'implemented', target: { part: null, inner: null, selector: null, textHash: null }, change: { type: 'token', name: '--color-accent', value: '#c0ffee' } });
  const w = wire({ edits: [style, token], render: async (r) => ({
    png: Buffer.from('x'), bitmap: r.design ? blank(64, 200) : painted(blank(64, 200), { x: 0, y: 150, width: 64, height: 20 }, 0),
    elements: [heading(style.id, 'rgb(18, 52, 86)')], found: [style.id], tokens: { '--color-accent': '#c0ffee' },
  }) });
  try {
    const v = await w.verify(null, { widths: [390] });
    assert.equal(v.failed, 'rest', 'the footer changed, away from the heading: a leak, not a difference near the token');
    assert.ok(v.differences.length > 0 && v.differences.every((d) => d.kind === 'leak'));
  } finally { w.done(); }
});

test('a page that went on below the capture limit: the verdict says how far down it was compared, passing or not, and never as a difference', async () => {
  const e = edit({ state: 'implemented' });
  const long = (r: LayerRenderRequest, bitmap: Bitmap) => ({
    png: Buffer.from('x'), bitmap, elements: [heading(e.id, 'rgb(18, 52, 86)')], found: [e.id], ...(r.width === 1440 ? { cut: { full: 9_412 } } : {}),
  });
  const w = wire({ edits: [e], render: async (r) => long(r, blank(64, 200)) });
  try {
    const v = await w.verify(e.id);
    assert.equal(v.ok, true);
    assert.deepEqual(v.differences, [], 'a verdict that passed lists no difference');
    assert.deepEqual(v.cut, [{ width: 1440, to: 6_000, full: 9_412 }], 'only the width that was cut, said as how far down it was compared');
    assert.deepEqual(w.marks.map((m) => [m.state, m.verdict?.cut?.length]), [['verified', 1]]);
  } finally { w.done(); }
  // Failing, what differs is said, and how far down it was compared beside it.
  const f = edit({ state: 'implemented' });
  const x = wire({ edits: [f], render: async (r) => ({ ...long(r, r.design ? blank(64, 200) : painted(blank(64, 200), { x: 0, y: 150, width: 64, height: 20 }, 0)), elements: [heading(f.id, 'rgb(18, 52, 86)')], found: [f.id] }) });
  try {
    const v = await x.verify(f.id);
    assert.equal(v.failed, 'rest');
    assert.ok(v.differences.length > 0 && v.differences.every((d) => d.kind === 'leak'));
    assert.deepEqual(v.cut, [{ width: 1440, to: 6_000, full: 9_412 }]);
  } finally { x.done(); }
});

/* ── the page as it was, kept just before an edit is made real ── */

/** Pictures as PNG stand-ins: each render's bitmap kept by its PNG's bytes, for the verification to read back. */
function pictures() {
  const by = new Map<string, Bitmap>();
  let n = 0;
  return {
    png: (b: Bitmap): Buffer => { const key = `png-${++n}`; by.set(key, b); return Buffer.from(key); },
    decode: async (png: Buffer): Promise<Bitmap> => { const b = by.get(png.toString()); if (!b) throw new Error('not a picture of this test'); return b; },
  };
}

/** A made-up page: the edited heading at 20, 40, and a paragraph near the foot of the page. */
const HEADING = { x: 20, y: 40, width: 40, height: 24 };
const PARAGRAPH = { x: 0, y: 150, width: 64, height: 20 };

/** One element of a made-up page read whole: its path, name, box, own words, colour, and whether it is edited. */
interface Whole { path: string; name: string; box: [number, number, number, number]; text?: string | null; color?: string; touched?: boolean }
/** A made-up page read whole, as the page script's layerPage answers it once checked. */
function whole(els: readonly Whole[]): PageSnap {
  const table: string[] = [];
  const at = (v: string): number => { let i = table.indexOf(v); if (i < 0) { i = table.length; table.push(v); } return i; };
  return {
    keys: ['color'], table, cut: false,
    elements: els.map((e) => ({ path: e.path, name: e.name, box: { x: e.box[0], y: e.box[1], width: e.box[2], height: e.box[3] }, text: e.text ?? null, values: [at(e.color ?? 'rgb(0, 0, 0)')], touched: !!e.touched })),
  };
}
/** The retitled page read whole: the heading (edited) and the paragraph, where they are in every render. */
const retitledPage = (e: LayerEdit): PageSnap => whole([
  { path: 'body > h2:nth-of-type(1)', name: 'h2.card__title', box: [20, 40, 100, 24], text: e.change.type === 'text' ? e.change.value : null, touched: true },
  { path: 'body > p:nth-of-type(1)', name: 'p.lead', box: [PARAGRAPH.x, PARAGRAPH.y, PARAGRAPH.width, PARAGRAPH.height], text: 'Learn the strokes' },
]);

/**
 * A title made real through the helper: the page from before shows the heading as the layer designed it and nothing
 * else changed; today's design and result show the native change, which `leak` says also reached the paragraph.
 */
function retitled(leak: boolean) {
  const pics = pictures();
  const e = edit({ label: 'Title', change: { type: 'text', value: 'Pagayer 102' }, target: { part: title(), inner: null, selector: null, textHash: layerTextHash('Pagayer 101') } });
  const designed = (b: Bitmap): Bitmap => painted(b, HEADING, 18);
  const now = (b: Bitmap): Bitmap => (leak ? painted(designed(b), PARAGRAPH, 90) : designed(b));
  const w = wire({
    edits: [e], decode: pics.decode,
    renderBefore: async () => ({
      page: { png: pics.png(blank(64, 200)), bitmap: blank(64, 200), elements: [heading(e.id, 'rgb(0, 0, 0)')], found: [e.id] },
      design: { png: pics.png(designed(blank(64, 200))), bitmap: designed(blank(64, 200)), elements: [heading(e.id, 'rgb(18, 52, 86)')], found: [e.id], page: retitledPage(e) },
    }),
    render: async (r) => ({ png: pics.png(now(blank(64, 200))), bitmap: now(blank(64, 200)), elements: [heading(e.id, 'rgb(18, 52, 86)')], found: [e.id], steady: { t: r.hold!.t, s: r.hold!.s, views: [] }, ...(r.whole ? { page: retitledPage(e) } : {}) }),
  });
  w.page.parts = { p6: { '': [words('Pagayer 101', 'node:12:title:string:fr')] } };
  return { w, e };
}

test('making words real keeps the page as it was first: without the layer and with the edit designed on it, at the verification widths, under the edit’s folder', async () => {
  const { w, e } = retitled(false);
  try {
    await w.apply();
    const done = await w.implement(e.id);
    assert.equal(done.ok, true);
    assert.deepEqual(w.order, ['before 390', 'before 1440', 'save'], 'rendered at each width before anything was saved');
    assert.deepEqual(w.befores.map((r) => [r.width, r.url, r.path, r.edits.map((x) => [x.id, x.state])]), [
      [390, `${BASE}paddling`, '/paddling', [[e.id, 'draft']]], [1440, `${BASE}paddling`, '/paddling', [[e.id, 'draft']]],
    ], 'the page it is on, with that one edit');
    const hold = w.befores[0]!.hold;
    assert.deepEqual(hold, { t: 1_700_000_000, s: 4242 }, 'held at the time it was kept, with one seed');
    assert.ok(w.befores.every((r) => r.hold?.t === hold?.t && r.hold?.s === hold?.s), 'every width with the same hold');
    const dir = join(w.dataDir, 'live-layer', folderOf('p1'), e.id, 'before');
    for (const f of ['390-page.png', '390-design.png', '1440-page.png', '1440-design.png', 'meta.json']) assert.ok(existsSync(join(dir, f)), f);
    const kept = w.kept(e.id);
    assert.deepEqual([kept?.page, kept?.hold, kept?.inSite, Object.keys(kept?.widths ?? {}), kept?.widths['390']?.found], ['/paddling', hold, [], ['390', '1440'], true]);
    assert.deepEqual(kept?.widths['390']?.elements.map((x) => x.values.color), ['rgb(18, 52, 86)'], 'the touched element as designed, where step 3 leaves it out');
  } finally { w.done(); }
});

test('a style handed to an agent keeps the page as it is then, once: asked again, the page that may have its change is not kept over it', async () => {
  const e = edit();
  const pics = pictures();
  let n = 0;
  const w = wire({ edits: [e], renderBefore: async () => { n++; return { page: { png: pics.png(blank(64, 200)), bitmap: blank(64, 200), elements: [], found: [e.id] }, design: { png: pics.png(blank(64, 200)), bitmap: blank(64, 200), elements: [heading(e.id, 'rgb(18, 52, 86)')], found: [e.id] } }; } });
  try {
    const a = await w.implement(e.id);
    assert.ok(!a.ok && a.route === 'agent');
    assert.equal(n, 2, 'both widths, when it was handed over');
    const first = w.kept(e.id)?.at;
    await w.implement(e.id);
    assert.equal(n, 2, 'not again');
    assert.equal(w.kept(e.id)?.at, first);
  } finally { w.done(); }
  // A render that fails is kept as why; the edit is made real all the same.
  const t = edit({ label: 'Title', change: { type: 'text', value: 'Pagayer 102' }, target: { part: title(), inner: null, selector: null, textHash: layerTextHash('Pagayer 101') } });
  const x = wire({ edits: [t] });
  try {
    x.page.parts = { p6: { '': [words('Pagayer 101', 'node:12:title:string:fr')] } };
    await x.apply();
    assert.equal((await x.implement(t.id)).ok, true);
    assert.deepEqual(x.kept(t.id)?.failed, { 390: 'no render in this test', 1440: 'no render in this test' });
  } finally { x.done(); }
});

test('step 3 compares the result with the page as it was: a native change that reached beyond the touched elements fails, though the design shows it too', async () => {
  const { w, e } = retitled(true);
  try {
    await w.apply();
    assert.equal((await w.implement(e.id)).ok, true);
    const hold = w.befores[0]!.hold;
    const v = await w.verify(e.id, { widths: [390] });
    assert.ok(w.renders.every((r) => r.hold?.t === hold?.t && r.hold?.s === hold?.s), 'every render held as the page from before was');
    assert.deepEqual([v.ok, v.failed], [false, 'rest'], 'the paragraph changed, and the design (today’s page with the layer) has it too');
    assert.ok(v.differences.length > 0 && v.differences.every((d) => d.kind === 'leak' && d.against?.edit === e.id && d.against.at === 1_700_000_000_000));
    assert.ok(v.differences.some((d) => d.kind === 'leak' && d.rect.y <= PARAGRAPH.y && d.rect.y + d.rect.height >= PARAGRAPH.y + PARAGRAPH.height), 'boxed where it is');
    assert.deepEqual(v.before, { ran: true, at: 1_700_000_000_000, widths: [390] });
    assert.equal(v.pictures[0]?.before, join(w.dataDir, 'live-layer', folderOf('p1'), e.id, 'before', '390-page.png'), 'the page as it was, pictured for the tray');
    assert.ok(v.pictures[0]?.diff, 'the difference against it is pictured');
    assert.deepEqual(w.marks.map((m) => m.state), ['implemented', 'implemented'], 'still in the site, with the verdict');
  } finally { w.done(); }
  // The same change without the leak passes, compared with the page before too.
  const ok = retitled(false);
  try {
    await ok.w.apply();
    await ok.w.implement(ok.e.id);
    const v = await ok.w.verify(ok.e.id, { widths: [390] });
    assert.deepEqual([v.ok, v.before, v.held], [true, { ran: true, at: 1_700_000_000_000, widths: [390] }, { at: 1_700_000_000 }]);
    assert.equal(existsSync(join(ok.w.dataDir, 'live-layer', folderOf('p1'), ok.e.id, 'before', 'meta.json')), true, 'verifying keeps the page from before');
  } finally { ok.w.done(); }
});

/**
 * A made-up page whose title was retyped and saved: the breadcrumb shows the same stored title, so the save changed it
 * there too, and at a phone's width the longer breadcrumb wraps onto a second line, moving everything below it down.
 * `leak` adds what a native change beyond the touched elements would do: the lead paragraph turned blue, and the
 * footer's words changed.
 */
function wrapped(leak: boolean) {
  const pics = pictures();
  const OLD = 'Paddling 101', NEW = 'Paddling 101, revised from the dock';
  const e = edit({ label: 'Title', change: { type: 'text', value: NEW }, before: { text: OLD }, target: { part: title(), inner: null, selector: null, textHash: layerTextHash(OLD) } });
  /** The page, its breadcrumb holding `crumb` and, when it wraps, everything from the title down `shift` pixels lower. */
  const page = (crumb: string, shift: number, after: { lead?: string; footer?: string } = {}): Whole[] => [
    { path: 'body > nav:nth-of-type(1)', name: 'nav.breadcrumb', box: [0, 0, 64, 12 + shift] },
    { path: 'body > nav:nth-of-type(1) > a:nth-of-type(1)', name: 'a.crumb', box: [0, 0, 20, 12], text: 'Home' },
    { path: 'body > nav:nth-of-type(1) > span:nth-of-type(1)', name: 'span.crumb', box: shift ? [0, 12, 64, 12] : [24, 0, 40, 12], text: crumb },
    { path: 'body > h1:nth-of-type(1)', name: 'h1.title', box: [0, 16 + shift, 64, 24], text: NEW, touched: true },
    { path: 'body > p:nth-of-type(1)', name: 'p.lead', box: [0, 44 + shift, 64, 40], text: 'Learn the strokes before the lake.', color: after.lead ?? 'rgb(0, 0, 0)' },
    { path: 'body > img:nth-of-type(1)', name: 'img.hero', box: [0, 90 + shift, 64, 60] },
    { path: 'body > footer:nth-of-type(1)', name: 'footer.site', box: [0, 170 + shift, 64, 20], text: after.footer ?? '© Acme Outfitters' },
  ];
  /** The page pictured: each element a shade of its own, where it sits. */
  const drawn = (els: readonly Whole[], height: number): Bitmap => els.reduce((b, x, i) => painted(b, { x: x.box[0], y: x.box[1], width: x.box[2], height: x.box[3] }, 20 + i * 30 + (x.color === 'rgb(0, 0, 255)' ? 7 : 0)), blank(64, height));
  const then = page(OLD, 0);
  const now = page(NEW, 12, leak ? { lead: 'rgb(0, 0, 255)', footer: '© Northwind Outfitters' } : {});
  const titleAt = (y: number): ElementSnap => ({ edit: e.id, n: 0, element: 'h1.title', values: { color: 'rgb(18, 52, 86)', text: NEW }, box: { x: 0, y, width: 64, height: 24 } });
  const w = wire({
    edits: [e], decode: pics.decode,
    renderBefore: async () => ({
      page: { png: pics.png(drawn(then, 200)), bitmap: drawn(then, 200), elements: [], found: [e.id] },
      design: { png: pics.png(drawn(then, 200)), bitmap: drawn(then, 200), elements: [titleAt(16)], found: [e.id], page: whole(then) },
    }),
    render: async (r) => ({
      png: pics.png(drawn(now, 212)), bitmap: drawn(now, 212), elements: [titleAt(28)], found: [e.id], steady: { t: r.hold!.t, s: r.hold!.s, views: [] },
      ...(r.whole ? { page: whole(now) } : {}),
    }),
  });
  w.page.parts = { p6: { '': [words(OLD, 'node:12:title:string:fr')] } };
  return { w, e };
}

test('step 3 against the page before: the same words saved in a second place are the save’s reach, and a wrap that moves the rest is no leak', async () => {
  const { w, e } = wrapped(false);
  try {
    await w.apply();
    assert.equal((await w.implement(e.id)).ok, true);
    const v = await w.verify(e.id, { widths: [390] });
    assert.deepEqual([v.ok, v.failed, v.differences], [true, null, []], 'the breadcrumb’s words and the page moved 12 px down are what the save does');
    assert.deepEqual(v.before, { ran: true, at: 1_700_000_000_000, widths: [390] });
    assert.deepEqual(v.reach, [{ edit: e.id, count: 1, places: ['span.crumb'] }], 'said: the same words changed in one other place');
  } finally { w.done(); }
});

test('step 3 against the page before still fails what changed beyond the edit, named by element, wherever the layout moved it', async () => {
  const { w, e } = wrapped(true);
  try {
    await w.apply();
    await w.implement(e.id);
    const v = await w.verify(e.id, { widths: [390] });
    assert.deepEqual([v.ok, v.failed], [false, 'rest']);
    const against = { edit: e.id, at: 1_700_000_000_000 };
    assert.deepEqual(v.differences, [
      { kind: 'outside', width: 390, element: 'p.lead', property: 'color', before: 'rgb(0, 0, 0)', result: 'rgb(0, 0, 255)', against },
      { kind: 'outside', width: 390, element: 'footer.site', property: 'text', before: '© Acme Outfitters', result: '© Northwind Outfitters', against },
    ], 'the paragraph that turned blue and the footer’s other words, nothing for the wrap');
    assert.deepEqual(v.reach, [{ edit: e.id, count: 1, places: ['span.crumb'] }]);
  } finally { w.done(); }
});

test('with no page from before, step 3 says it could not run and why, and the verdict does not claim it', async () => {
  const e = edit({ state: 'implemented' });
  const w = wire({ edits: [e], render: renders(e, { design: (b) => b, result: (b) => b }) });
  try {
    const v = await w.verify(e.id, { widths: [390] });
    assert.equal(v.ok, true, 'steps 1 to 3 against the design passed');
    assert.ok(v.before && !v.before.ran && /^No page from before was kept for it/.test(v.before.why), JSON.stringify(v.before));
    assert.equal(v.pictures[0]?.before, null);
    assert.ok(w.renders.every((r) => r.hold?.t === 1_700_000_000 && r.hold.s === 4242), 'held all the same, at the time it was verified');
  } finally { w.done(); }
});

test('an edit made real on the page after the page from before was kept: step 3 cannot compare with it, and says which', async () => {
  const { w, e } = retitled(false);
  try {
    await w.apply();
    await w.implement(e.id);
    const other = edit({ label: 'Lead paragraph', state: 'implemented' });
    w.setEdits([...w.edits(), other]);
    const v = await w.verify(e.id, { widths: [390] });
    assert.ok(v.before && !v.before.ran && v.before.why.startsWith('“Lead paragraph” was made real on its page after its page from before was kept'), JSON.stringify(v.before));
    assert.equal(v.ok, true);
    // An edit already in the site when it was kept is in that page: it does not stop the comparison.
    const earlier = retitled(false);
    try {
      const before = edit({ label: 'Older', state: 'verified' });
      earlier.w.setEdits([...earlier.w.edits(), before]);
      await earlier.w.apply();
      await earlier.w.implement(earlier.e.id);
      assert.deepEqual(earlier.w.kept(earlier.e.id)?.inSite, [before.id]);
      assert.equal((await earlier.w.verify(earlier.e.id, { widths: [390] })).before?.ran, true);
    } finally { earlier.w.done(); }
  } finally { w.done(); }
  // An edit of another page, for that page only, does not count.
  const elsewhere = edit({ page: '/about', state: 'implemented' });
  const kept: BeforeKept = { at: 1, page: '/paddling', hold: { t: 1, s: 1 }, inSite: [], widths: { 390: { found: true, elements: [], masks: [], steady: null, cut: null, whole: true } }, failed: {} };
  const self = edit({ state: 'implemented' });
  assert.equal(beforeCheck(self, kept, [390, 1440], [self, elsewhere]).ran, true);
  assert.deepEqual(beforeCheck(self, kept, [1440], [self]), { ran: false, why: 'Its page from before was kept at 390 px, not at the widths verified.' });
  assert.match((beforeCheck(self, { ...kept, widths: {}, failed: { 390: 'The page did not load within 30 seconds.' } }, [390], [self]) as { why: string }).why, /could not be rendered when it was made real: The page did not load/);
  assert.match((beforeCheck(self, { ...kept, widths: { 390: { ...kept.widths['390']!, found: false } } }, [390], [self]) as { why: string }).why, /not on its page from before/);
  assert.equal(beforeKept({ ...kept, inSite: ['Not An Id'] }), null, 'what is read back is checked');
  const long = [1, 2, 3].map((i) => edit({ label: `${'A very long heading '.repeat(10)}${i}`.slice(0, 200), state: 'implemented' }));
  const said = beforeCheck(self, kept, [390], [self, ...long]);
  assert.ok(!said.ran && said.why.length <= 600 && parseVerdict({ at: 1, ok: true, failed: null, widths: [390], noise: { maxDiff: 0, pixels: 0 }, differences: [], pictures: [], before: said }), 'however long the labels it names, a verdict can say it');
});

/* ── what the site says changes between renders ── */

test('a part the site says changes between renders is left out of the pixel steps and named; the floor is measured over the rest, so a leak elsewhere is no longer forgiven', async () => {
  const e = edit({ state: 'implemented' });
  // A random-order view at the foot of the page draws differently each render; the result also changed a band in the
  // middle of the page by a little, which the view's noise would forgive page-wide.
  const VIEW = { x: 0, y: 170, width: 64, height: 30 };
  const views = (n: number) => (b: Bitmap): Bitmap => painted(b, VIEW, n % 2 ? 40 : 220);
  const leak = (b: Bitmap): Bitmap => painted(b, { x: 0, y: 100, width: 8, height: 2 }, 250);
  const masked = (mask: boolean): LayerRender => {
    let n = 0;
    return async (r) => ({
      png: Buffer.from('x'), bitmap: r.design ? views(n++)(blank(64, 200)) : leak(views(n++)(blank(64, 200))), elements: [heading(e.id, 'rgb(18, 52, 86)')], found: [e.id],
      ...(mask ? { masks: [{ label: 'Picks (view)', why: 'built afresh for every request (never cached)', rects: [VIEW], held: false }] } : {}),
    });
  };
  const without = wire({ edits: [e], render: masked(false) });
  try {
    const v = await without.verify(e.id, { widths: [390] });
    assert.deepEqual([v.ok, v.noise.maxDiff, v.masked], [true, 180, []], 'unmasked, the view’s noise forgives the leak (as before masks)');
  } finally { without.done(); }
  const w = wire({ edits: [e], render: masked(true) });
  try {
    const v = await w.verify(e.id, { widths: [390] });
    assert.deepEqual([v.ok, v.failed, v.noise], [false, 'rest', { maxDiff: 0, pixels: 0 }], 'masked, the floor is what is left, and the leak shows');
    assert.ok(v.differences.every((d) => d.kind === 'leak' && d.rect.y >= 96 && d.rect.y < 110), 'only the leak, never the view');
    assert.deepEqual(v.masked, [{ label: 'Picks (view)', why: 'built afresh for every request (never cached)', widths: [390], nearEdit: false }]);
  } finally { w.done(); }
});

test('an edited element inside a part that changes between renders is compared all the same, and the verdict says the part was near it', async () => {
  const e = edit({ state: 'implemented' });
  const BLOCK = { x: 0, y: 0, width: 64, height: 120 };
  // The design's heading is another colour than the result's: inside the masked block, it must still fail.
  const w = wire({ edits: [e], render: async (r) => ({
    png: Buffer.from('x'), bitmap: r.design ? painted(blank(64, 200), { x: 20, y: 40, width: 40, height: 24 }, 18) : blank(64, 200),
    elements: [heading(e.id, 'rgb(18, 52, 86)')], found: [e.id], masks: [{ label: 'Account menu (block)', why: 'made for each user', rects: [BLOCK], held: false }],
  }) });
  try {
    const v = await w.verify(e.id, { widths: [390] });
    assert.deepEqual([v.ok, v.failed], [false, 'pixels'], 'the edited element is never left out');
    assert.deepEqual(v.masked, [{ label: 'Account menu (block)', why: 'made for each user', widths: [390], nearEdit: true }]);
  } finally { w.done(); }
});

test('a render’s masks: the trace’s parts by their boxes on the page, and the blocks a helper marked, checked as they come back', () => {
  const traced: LiveTrace = { ...trace(), parts: [
    { id: 'p1', kind: 'block', label: 'Who’s online', cache: { tags: [], contexts: ['user'], maxAge: 'permanent' } },
    { id: 'p2', kind: 'block', label: 'Gone', cache: { tags: [], contexts: ['user'], maxAge: 'permanent' } },
  ] };
  const areas = areasOf({
    parts: { p1: [{ x: 0, y: 10, width: 300, height: 40 }, { x: 0, y: 0, width: 0, height: 10 }], 'bad id!': [{ x: 0, y: 0, width: 1, height: 1 }] },
    vary: [
      { reason: 'random-order', held: null, name: 'core/gallery', box: { x: 0, y: 100, width: 200, height: 80 } },
      { reason: 'relative-date', held: 'time', name: 'core/post-date', box: { x: 0, y: 200, width: 80, height: 20 } },
      { reason: '<script>', held: null, name: 'core/x', box: { x: 0, y: 0, width: 1, height: 1 } },
      { reason: 'today', held: null, name: 'not a block name', box: { x: 0, y: 0, width: 10, height: 10 } },
    ],
  });
  assert.deepEqual(Object.keys(areas.parts), ['p1'], 'a box with no area, and an id the trace could not have, are dropped');
  assert.deepEqual(masksOf(traced, null, areas), [
    { label: 'Who’s online (block)', why: 'made for each user', rects: [{ x: 0, y: 10, width: 300, height: 40 }], held: false },
    { label: 'The core/gallery block', why: 'shows its items in a random order', rects: [{ x: 0, y: 100, width: 200, height: 80 }], held: false },
    { label: 'The core/post-date block', why: 'shows a date relative to now', rects: [{ x: 0, y: 200, width: 80, height: 20 }], held: false },
    { label: 'A block', why: 'shows today’s date', rects: [{ x: 0, y: 0, width: 10, height: 10 }], held: false },
  ], 'a part not on the page has no box; a reason the page made up is dropped; a held mark counts only when the helper confirmed the hold');
  assert.equal(masksOf(null, { t: 1, s: 1, views: [] }, areas)[1]?.held, true, 'confirmed: the relative date was held still');
  assert.deepEqual(areasOf('nothing'), { parts: {}, vary: [] });
});

/* ── what the site's helper held still ── */

test('the helper’s answer to a hold is read only for the hold that was sent, with the views it seeded', () => {
  const hold = { t: 1_700_000_000, s: 42 };
  assert.deepEqual(steadyOf('t=1700000000;s=42', hold), { t: 1_700_000_000, s: 42, views: [] });
  assert.deepEqual(steadyOf('t=1700000000;s=42;views=picks:block_1,news:page_1', hold), { t: 1_700_000_000, s: 42, views: ['picks:block_1', 'news:page_1'] });
  assert.equal(steadyOf('t=1700000000;s=43', hold), null, 'another seed');
  assert.equal(steadyOf('t=1699999999;s=42', hold), null, 'another time');
  assert.equal(steadyOf('t=1700000000;s=42', null), null, 'nothing was sent');
  assert.equal(steadyOf(undefined, hold), null, 'the helper said nothing: an older helper, or one that refused');
  assert.deepEqual(steadyOf('t=1700000000;s=42;views=Bad View!', hold), null);
});

test('a change the helper held still is compared when every render was held alike, and left out when one was not', async () => {
  const e = edit({ state: 'implemented' });
  // A relative date at the foot of the page, which the helper held still: the same in every render held alike. The
  // result also changed it (a leak), which is caught only because the date is compared.
  const DATE = { x: 0, y: 180, width: 64, height: 20 };
  const held = (confirm: (r: LayerRenderRequest, n: number) => boolean): LayerRender => {
    let n = 0;
    return async (r) => {
      const me = n++;
      return {
        png: Buffer.from('x'), bitmap: r.design ? blank(64, 200) : painted(blank(64, 200), DATE, 100), elements: [heading(e.id, 'rgb(18, 52, 86)')], found: [e.id],
        masks: [{ label: 'The core/post-date block', why: 'shows a date relative to now', rects: [DATE], held: confirm(r, me) }],
        ...(confirm(r, me) ? { steady: { t: r.hold!.t, s: r.hold!.s, views: [] } } : {}),
      };
    };
  };
  const alike = wire({ edits: [e], render: held(() => true) });
  try {
    const v = await alike.verify(e.id, { widths: [390] });
    assert.deepEqual([v.ok, v.failed, v.masked, v.held], [false, 'rest', [], { at: 1_700_000_000 }], 'held alike: compared, and the leak in it shows');
  } finally { alike.done(); }
  const once = wire({ edits: [e], render: held((_r, n) => n !== 2) });
  try {
    const v = await once.verify(e.id, { widths: [390] });
    assert.deepEqual([v.ok, v.held, v.masked], [true, null, [{ label: 'The core/post-date block', why: 'shows a date relative to now', widths: [390], nearEdit: false }]],
      'one render the helper did not hold: what it would change is left out and named, and the verdict does not say it was held');
  } finally { once.done(); }
});

test('against a page from before held at another time, what the hold keeps still is left out of that comparison', async () => {
  const { w, e } = retitled(false);
  try {
    await w.apply();
    await w.implement(e.id);
    // The page from before was kept with a relative date the helper held still at its own time.
    const kept = w.kept(e.id)!;
    const meta = join(w.dataDir, 'live-layer', folderOf('p1'), e.id, 'before', 'meta.json');
    const at = { t: kept.hold.t, s: kept.hold.s, views: [] };
    const DATE = { label: 'The core/post-date block', why: 'shows a date relative to now', rects: [PARAGRAPH], held: true };
    writeFileSync(meta, JSON.stringify({ ...kept, widths: { 390: { ...kept.widths['390'], masks: [DATE], steady: at } } }));
    assert.equal((await w.verify(e.id, { widths: [390] })).before?.ran, true);
    assert.deepEqual(w.renders.map((r) => r.hold), w.renders.map(() => kept.hold), 'today’s renders are held at its time, so the date is the same');
    // Held at another time (a hold the helper refused then): the date is left out of that comparison, and said.
    w.setEdits(w.edits().map((x) => ({ ...x, state: 'implemented' })));
    writeFileSync(meta, JSON.stringify({ ...kept, widths: { 390: { ...kept.widths['390'], masks: [DATE], steady: null } } }));
    const v = await w.verify(e.id, { widths: [390] });
    assert.deepEqual(v.masked, [{ label: 'The core/post-date block', why: 'shows a date relative to now', widths: [390], nearEdit: false }]);
  } finally { w.done(); }
});

test('a render that never answers fails its verification, saying so, and the next verification still runs', { timeout: 10_000 }, async () => {
  const e = edit({ state: 'implemented' });
  const draft = edit();
  const w = wire({ edits: [e, draft], renderMs: 50, render: () => new Promise(() => {}) });
  try {
    const first = w.verify(e.id, { widths: [390] });
    // Queued behind the stuck one: it runs only once that one has ended.
    const second = w.verify(draft.id);
    await assert.rejects(first, /The page did not render at 390 px within 50 ms, so the verification stopped there/);
    await assert.rejects(second, /Only an implemented edit is verified/);
    assert.deepEqual(w.marks, [], 'nothing was recorded for a verification that did not finish');
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

test('Drupal: words a block’s title, a view’s header or a menu link keeps are saved through that configuration’s target, one run of a view’s words at a time', async () => {
  // As the Drupal helper offers them (ConfigWords): a block placement's title, a view's header run by run (its markup
  // is never in the value), and a menu link a module writes in code, offered with why.
  const blockPart: PartIdentity = { kind: 'config', type: 'block', id: 'acme_tagline', plugin: 'block_content:x' };
  const viewPart: PartIdentity = { kind: 'config', type: 'view', id: 'trips:page_1' };
  const codeLink: PartIdentity = { kind: 'config', type: 'menu_link', id: 'acme_tours.about' };
  const note = 'This is configuration: the next configuration import puts back what is exported, so export the site’s configuration to keep this change.';
  const blockTitle: EditTarget = { id: 'words.block.acme_tagline', kind: 'config', label: 'Block title: Plan your trip', via: 'schema', revisions: false, schema: { type: 'string', title: 'Block title', description: note, minLength: 1, maxLength: 255 }, value: 'Plan your trip' };
  const header: EditTarget = {
    id: 'words.view.trips.default.header.area', kind: 'config', label: 'View header: Trips', via: 'schema', revisions: false,
    schema: { type: 'object', title: 'Words of its header', description: note, properties: { w1: { type: 'string', title: 'Words 1', minLength: 1 }, w2: { type: 'string', title: 'Words 2', minLength: 1 } }, required: ['w1', 'w2'] },
    value: { w1: 'Our trips this season', w2: 'Book early' },
  };
  const about: EditTarget = {
    id: 'words.link.acme_tours.about', kind: 'menu-link', label: 'Link text: About us', via: 'schema', revisions: false, schema: { type: 'string', title: 'Link text', minLength: 1, maxLength: 255 }, value: 'About us',
    why: 'Its text is written in code (the links.menu.yml file of the module that defines it), so Drupal keeps no such thing to change here.',
  };
  const drupal: LiveTrace = {
    ...trace(),
    parts: [
      { id: 'b1', kind: 'block', label: 'Plan your trip', identity: blockPart, edits: ['config.block.acme_tagline', blockTitle.id] },
      { id: 'v1', kind: 'view', label: 'Trips · Page', identity: viewPart, edits: ['config.view.trips', header.id] },
      { id: 'm1', kind: 'menu', label: 'About us', identity: codeLink, edits: ['link.acme_tours.about', about.id] },
    ],
    edits: [{ id: 'config.block.acme_tagline', kind: 'config', label: 'Block placement: Plan your trip', via: 'native-form' }, blockTitle, { id: 'config.view.trips', kind: 'config', label: 'View: Trips', via: 'native-form' }, header, about],
  };
  const titled = retype(blockPart, 'Plan your paddle', 'Plan your trip', 'h2:nth-of-type(1)');
  const booked = retype(viewPart, 'Book by May', 'Book early', 'p:nth-of-type(2)');
  const renamed = retype(codeLink, 'About Acme', 'About us', 'a:nth-of-type(1)');
  const w = wire({ edits: [titled, booked, renamed], trace: drupal });
  try {
    w.page.parts = { b1: { 'h2:nth-of-type(1)': [words('Plan your trip')] }, v1: { 'p:nth-of-type(2)': [words('Book early')] }, m1: { 'a:nth-of-type(1)': [words('About us')] } };
    await w.apply();
    assert.deepEqual(await w.implement(titled.id), { ok: true, id: titled.id, state: 'implemented', revision: '43' });
    assert.deepEqual(await w.implement(booked.id), { ok: true, id: booked.id, state: 'implemented', revision: '43' });
    assert.deepEqual(w.posts, [
      { path: '/_wanigan/edit/words.block.acme_tagline', body: { trace: '0123456789abcdef', value: 'Plan your paddle' } },
      { path: '/_wanigan/edit/words.view.trips.default.header.area', body: { trace: '0123456789abcdef', value: { w1: 'Our trips this season', w2: 'Book by May' } } },
    ], 'the title as typed; the view’s other run as the trace gave it');
    assert.deepEqual(await w.implement(renamed.id), { ok: false, id: renamed.id, route: 'none', why: about.why });
    assert.equal(w.posts.length, 2, 'nothing is sent for words kept in code');
    assert.deepEqual(w.saves, [], 'none of them is a field’s save');
  } finally { w.done(); }
});

test('Drupal: words in a default layout are saved when made real again, with the token the site’s first answer gave', async () => {
  // An inline block's field in a layout every trip without its own shares: the helper says how far it reaches first.
  const block: PartIdentity = { kind: 'entity', type: 'block_content', id: 'c0ffee00-0000-4000-8000-000000000009', bundle: 'card', langcode: 'en', field: 'title', item: 'delta:0' };
  const traced: LiveTrace = { ...trace(), parts: [{ id: 'k1', kind: 'field', label: 'Title #1', identity: block }] };
  const retitled = edit({ label: 'Title', target: { part: block, inner: null, selector: null, textHash: layerTextHash('Plan your trip') }, change: { type: 'text', value: 'Plan your paddle' } });
  const token = 'a'.repeat(32);
  const reach = 'These words are in the default layout for Trip content, which every one without a layout of its own shows (12 now), so saving them changes them on all of those pages.';
  const w = wire({
    edits: [retitled], trace: traced,
    helper: (at) => (at?.confirm === token ? { ok: true, error: null, label: 'The default layout for Trip content', revision: null } : { ok: false, error: reach, label: null, confirm: token }),
  });
  try {
    w.page.parts = { k1: { '': [words('Plan your trip', 'block_content:9:title:string:en:41:1760000000:string')] } };
    await w.apply();
    assert.deepEqual(await w.implement(retitled.id), { ok: false, id: retitled.id, route: 'none', why: `${reach} Make it real again to save it there.` }, 'said first');
    assert.equal(w.marks.length, 0, 'nothing marked');
    assert.deepEqual(await w.implement(retitled.id), { ok: true, id: retitled.id, state: 'implemented', revision: null });
    assert.deepEqual(w.saves.map((s) => (s[3] as SaveAt).confirm ?? null), [null, token], 'the token only on the save asked again');
    assert.deepEqual(w.marks.map((m) => m.state), ['implemented']);
  } finally { w.done(); }
});

test('Drupal: words a template writes are refused as code, and words it prints through t() as an interface translation', async () => {
  // As the Drupal helper lists them for a node's template (TemplateWords): the words typed into it, and those it
  // prints through t(). The node part is the one around the element, its page the part above it.
  const node: PartIdentity = { kind: 'entity', type: 'node', id: UUID, bundle: 'article', langcode: 'en' };
  const codeWhy = 'These words are written in themes/custom/acme/templates/node.html.twig, a template: a template is code, so Drupal keeps no such thing to change in the site. An agent can change the template from a brief (a copy of it in your theme, when the template is not yours).';
  const tWhy = 'These words are printed by themes/custom/acme/templates/node.html.twig through Drupal’s interface translation (t()): Wanigan does not change an interface translation yet, and a change there reaches every page that prints the same words. Change them under Interface translation, or in the template.';
  const written: EditTarget = { id: 'words.tpl.0a1b2c3d4e5f', kind: 'template-override', label: 'Words written in node.html.twig', via: 'schema', revisions: false, schema: { type: 'object', properties: { w1: { type: 'string', readOnly: true } } }, value: { w1: 'Trip notes' }, why: codeWhy };
  const translated: EditTarget = { id: 'words.t.0a1b2c3d4e5f', kind: 'template-override', label: 'Words node.html.twig translates', via: 'schema', revisions: false, schema: { type: 'object', properties: { w1: { type: 'string', readOnly: true } } }, value: { w1: 'Read more' }, why: tWhy };
  const drupal: LiveTrace = {
    ...trace(),
    parts: [{ id: 'page', kind: 'template', label: 'Page' }, { id: 'n1', kind: 'entity', label: 'Article: Paddling 101', parent: 'page', identity: node, edits: [written.id, translated.id] }],
    edits: [written, translated],
  };
  const heading = retype(node, 'Paddling notes', 'Trip notes', 'h3:nth-of-type(1)');
  const more = retype(node, 'Keep reading', 'Read more', 'a:nth-of-type(1)');
  const other = retype(node, '2 June', '1 June', 'time:nth-of-type(1)');
  const w = wire({ edits: [heading, more, other], trace: drupal });
  try {
    w.page.parts = { n1: { 'h3:nth-of-type(1)': [words('Trip notes')], 'a:nth-of-type(1)': [words('Read more')], 'time:nth-of-type(1)': [words('1 June')] } };
    await w.apply();
    assert.deepEqual(await w.implement(heading.id), { ok: false, id: heading.id, route: 'agent', why: codeWhy }, 'Drupal keeps no such thing: an agent changes the template');
    assert.deepEqual(await w.implement(more.id), { ok: false, id: more.id, route: 'none', why: tWhy }, 'Wanigan does not change an interface translation yet');
    assert.deepEqual(await w.implement(other.id), { ok: false, id: other.id, route: 'none', why: DRUPAL_NOTHING_HOLDS });
    assert.deepEqual([w.posts, w.saves, w.marks], [[], [], []], 'nothing is sent for any of them');
  } finally { w.done(); }
});

test('Drupal: a webform a content field shows saves its words to the webform, not to the field around it', async () => {
  // The Webform adapter names the element (config webform_element); the field that shows the form marks its wrapper.
  const element: PartIdentity = { kind: 'config', type: 'webform_element', id: 'contact/email', plugin: 'email' };
  const label: EditTarget = {
    id: 'words.webform.contact.email.title', kind: 'config', label: 'Contact Acme · Email address: title', via: 'schema', revisions: false,
    schema: { type: 'string', title: 'Title', minLength: 1 }, value: 'Email address',
  };
  const traced: LiveTrace = { ...trace(), edits: [label], parts: [...trace().parts, { id: 'p9', kind: 'form', label: 'Webform element: Email address', identity: element, edits: [label.id] }] };
  const retyped = edit({ label: 'Label', change: { type: 'text', value: 'Your email' }, target: { part: element, inner: 'label:nth-of-type(1)', selector: null, textHash: layerTextHash('Email address') } });
  const w = wire({ edits: [retyped], trace: traced });
  try {
    w.page.parts = { p9: { 'label:nth-of-type(1)': [words('Email address', 'node:12:field_form:webform:en:42::webform_entity_reference_entity_view')] } };
    await w.apply();
    assert.deepEqual(await w.implement(retyped.id), { ok: true, id: retyped.id, state: 'implemented', revision: '43' });
    assert.deepEqual(w.saves, [], 'not through the field save the mark around it would take');
    assert.deepEqual(w.posts.map((p) => [p.path, p.body]), [['/_wanigan/edit/words.webform.contact.email.title', { trace: '0123456789abcdef', value: 'Your email' }]]);
    assert.deepEqual(w.marks.map((m) => [m.id, m.state]), [[retyped.id, 'implemented']]);
  } finally { w.done(); }
});
