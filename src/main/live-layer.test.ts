// The design layer's main-process side with stand-ins: a fake ipc, a fake core client, a page script played by a
// small model of a page, and a render seam for the verification (Electron's windows cannot open under this runner).
// What is checked is what reaches the page, the core and the data folder. Made-up site (acme); nothing real.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compileLayer, layerTextHash, type LayerApplied, type LayerEdit, type LayerImplemented, type LayerPickTarget, type LayerVerdict } from '../shared/design-layer.ts';
import type { Bitmap, ElementSnap } from '../shared/layer-verify.ts';
import type { LiveTrace, PartIdentity } from '../shared/live-trace.ts';
import { madeOn, pathOf, wireLiveLayer, type LayerRender, type LayerRenderRequest } from './live-layer.ts';

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
      return (el ? { count: els.length, field: el.field ?? null, words: el.plain ? el.text : null, plain: el.plain } : { count: 0, field: null, words: null, plain: false }) as T;
    }
    return fallback;
  };
  return { page, run };
}

function wire(over: { edits?: LayerEdit[]; url?: string; trace?: LiveTrace | null; trusted?: boolean; enabled?: boolean; render?: LayerRender; saved?: { ok: boolean; error: string | null } } = {}) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const dataDir = mkdtempSync(join(tmpdir(), 'wanigan-layer-'));
  const { page, run } = modelPage();
  let edits = over.edits ?? [];
  const marks: { id: string; state: string; verdict?: LayerVerdict }[] = [];
  const saves: unknown[][] = [];
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
    helperSave: async (field, before, after, at) => { saves.push([field, before, after, at]); return over.saved ? { ...over.saved, label: 'Paddling 101' } : { ok: true, error: null, label: 'Paddling 101', revision: '42' }; },
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
    page, marks, saves, sheets, renders, dataDir, wired,
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
  const retyped = edit({ label: 'Title', change: { type: 'text', value: 'Pagayer 102' }, target: { part: title(), inner: null, selector: null, textHash: layerTextHash('Pagayer 101') } });
  const style = edit();
  const every = edit({ scope: 'kind', change: { type: 'text', value: 'Same everywhere' } });
  const w = wire({ edits: [retyped, style, every] });
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
    assert.deepEqual(w.marks.at(-1), { id: retyped.id, state: 'implemented' });
    assert.equal(w.sheets.reloads, 1, 'the page shows what the site now has');
    const again = await w.implement(retyped.id);
    assert.ok(!again.ok && /in the site already/.test(again.why));
  } finally { w.done(); }
});

test('words with no field the helper marks, or a refusal from the site, are said and nothing is marked', async () => {
  const loose = edit({ label: 'Title', change: { type: 'text', value: 'New words' }, target: { part: title(), inner: null, selector: null, textHash: layerTextHash('Paddling 101') } });
  const w = wire({ edits: [loose], saved: { ok: false, error: 'The user you are logged in as in the live view may not change this.' } });
  try {
    w.page.parts = { p6: { '': [words('Paddling 101')] } };
    await w.apply();
    const unmarked = await w.implement(loose.id);
    assert.ok(!unmarked.ok && unmarked.route === 'none' && /not in a plain text field/.test(unmarked.why));
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
