// The design layer, the main process's side (docs/design/2026-10-09-design-layer.md, "Phase 1, as contracted"; the
// contract is src/shared/design-layer.ts, the log is the core's: src/core/live-layer.ts). It shows the project's
// edits on the live page, keys a new one to the picked element, makes text real through the site helper, and
// verifies an implemented edit pixel for pixel.
//
// - Applying: after every load of the view, and when the window asks, the edits are read from the core and each is
//   resolved on the page shown: the trace's parts by identityKey (for scope `kind`, every part with the same
//   kindKey), then `inner` inside each part's roots, and for scope `this` the element's whole text (all its words,
//   descendants' too, as the site rendered them) checked against `textHash` (layerTextHash, here: the page script
//   answers the text, so there is one hash). A WordPress block's identity is its place in the stored markup, so after
//   a reorder it names whatever block is there now: the text is what tells them apart. What resolves is tagged with
//   `data-wl-edit`; compileLayer() is injected as one stylesheet, gated on a generation the page's root names, so a new
//   one replaces it whole and switching off names none (Electron cannot take a user-origin sheet out); text edits
//   patch their words in place. Words one of the layer's own text edits saved are not other words: put back, they
//   still name the element an edit was made on. The same stored thing rendered twice on a page (an entity, a post) is two parts with one identity: an edit
//   for `this` reaches every one of them, as the native change will, once one of them shows the words it was made on.
//   A draft of this page that no longer resolves, or resolves to other words, is orphaned and the core is
//   told; it is a draft again once it resolves. An implemented edit is in the site: the window is told it was not
//   found on this load, and it stays implemented (never a draft again, never discardable). Without a trace nothing
//   is resolved by identity, and nothing is called orphaned for it. Edits for a named breakpoint are left out: phase 1 does not read the theme's breakpoints.
// - Implementing: only words in a plain text field the helper can save (`POST /_wanigan/save`, the window's own
//   helperSave path, as the logged-in user), to exactly the content, translation and item the edit's target names
//   (saveTarget): never the default language, never the first item that holds the same words. Styles and tokens go
//   to an agent as a brief; anything else says why.
// - Verifying ("Stage 3: verify", steps 1–3): the design (the page with the layer) and the result (the page without
//   it) rendered in hidden windows in the view's session at each width (live-capture.ts), each twice for the noise
//   floor, and every width judged against the one floor the verdict states (the largest over both and every width); the comparisons are src/shared/layer-verify.ts's. Pictures are kept in the data folder under
//   live-layer/<project>/<edit>/, and the core is told: verified, or still implemented with the failed verdict (its
//   words are in the site; the verdict says what differs).
//   What step 3 can see, as contracted: the design is the native page with the layer, so a change the native
//   implementation made beyond the touched elements is in both renders and does not show. Seen in Electron on a
//   made-up page: a rule that also turned every paragraph blue passed. Catching that needs the page as it was before
//   the implementation, kept when it is made real and compared row by row (text reflows); that is still to build.
// - Nothing here writes to the site except the helper save, and nothing reaches any origin but the site's own.
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import {
  LAYER_PROPERTIES, compileLayer, layerEdit, layerTextHash,
  type LayerApplied, type LayerEdit, type LayerImplemented, type LayerPickTarget, type LayerSnapshot, type LayerTarget, type LayerVerdict,
} from '../shared/design-layer.ts';
import {
  MAX_DIFFERENCES, compareElements, comparePixels, diffBitmaps, diffPicture, judge, noiseFloor, verdictNoise, verifyWidths, widestNoise, zonesOf,
  type Bitmap, type ElementSnap, type WidthFindings, type Zone,
} from '../shared/layer-verify.ts';
import type { LiveTraceAnswer } from '../shared/live-lens.ts';
import { TRACE_ID, identityKey, kindKey, type LiveTrace, type PartIdentity, type TracePart } from '../shared/live-trace.ts';
import { sameSite, type LiveSite } from '../shared/live.ts';
import type { Method } from '../shared/protocol.ts';
import { folderOf, inHiddenWindow } from './live-capture.ts';
import type { HelperSaved, LiveCurrent, LiveViewHooks, SaveAt } from './live-view.ts';

interface Client { callRaw(method: Method, params: unknown): Promise<unknown> }

/** Runs code in the page script's world: the view's, or a hidden window's. */
export type Run = <T>(code: string, fallback: T) => Promise<T>;
/** What can fetch on a view's session: Electron's session.fetch, or a stand-in in tests. */
export type SiteFetch = (url: string, init: RequestInit) => Promise<Response>;
export type AskTrace = (fetch: SiteFetch, origin: string, token: string, id: string) => Promise<LiveTraceAnswer>;

/** The isolated world the page script runs in, in the view and in hidden windows alike (live-view.ts). */
const PAGE_WORLD = 4242;
/** A verification compares a page down to here; below it is cut, and the pictures say so by their height. */
export const VERIFY_MAX_HEIGHT = 6_000;
/** Words the helper's save takes, before and after (live-view.ts cuts them there). */
const SAVE_MAX = 2_000;
const EDIT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A call into the page script, its arguments as JSON. */
const call = (name: string, ...args: unknown[]): string =>
  `window.__wl && window.__wl.${name} ? window.__wl.${name}(${args.map((a) => JSON.stringify(a)).join(', ')}) : null`;

/** A page as edits name it: its path and query. */
export function pathOf(url: string): string {
  try { const u = new URL(url); return `${u.pathname}${u.search}`; } catch { return '/'; }
}

/** Whether an edit was made on the page at `path`: the same path and query, or the same path when the edit names no query. */
export const madeOn = (edit: Pick<LayerEdit, 'page'>, path: string): boolean =>
  edit.page === path || (!edit.page.includes('?') && edit.page === path.split('?')[0]);

/** What resolving a project's edits on one page found. */
export interface Resolution {
  /** Accepted elements per edit, by their place in the page script's find. */
  tags: Record<string, number[]>;
  /** Text edits' words for their elements, in the order the edits were made. */
  texts: { id: string; value: string }[];
  shown: { id: string; elements: number }[];
  /** Edits of this page that no longer resolve, or resolve to other words. */
  orphaned: { id: string; why: string }[];
  /** Edits of other pages (scope `this`). */
  elsewhere: string[];
  /** Edits whose elements were found here. */
  resolved: string[];
}

type Found = Record<string, { count?: unknown; texts?: unknown; plain?: unknown }>;

/** Whether an edit's element is checked by its text: one element (`this`) whose text was there to hash. */
const guarded = (e: LayerEdit): boolean => e.scope === 'this' && !!e.target.textHash;

/**
 * Resolve each edit in effect (draft, implemented, or orphaned and maybe back) on the page at `path`, through the page
 * script's layerFind, and decide which elements each may touch. Kept by the page script for layerSet.
 */
export async function resolveLayer(run: Run, trace: LiveTrace | null, edits: readonly LayerEdit[], path: string): Promise<Resolution> {
  const out: Resolution = { tags: {}, texts: [], shown: [], orphaned: [], elsewhere: [], resolved: [] };
  const specs: { id: string; parts: string[] | null; inner: string | null; selector: string | null; text: boolean }[] = [];
  const asked: LayerEdit[] = [];
  for (const e of edits) {
    if (e.state !== 'draft' && e.state !== 'implemented' && e.state !== 'orphaned') continue;
    if (e.change.type === 'token') { if (e.state !== 'orphaned') out.shown.push({ id: e.id, elements: 0 }); continue; }
    // Phase 1 shows words and styles; pictures, inserts and removals are not layer edits yet.
    if (e.change.type !== 'style' && e.change.type !== 'text') continue;
    if (e.scope === 'this' && !madeOn(e, path)) { out.elsewhere.push(e.id); continue; }
    const part = e.target.part;
    if (part) {
      // Without the page's trace no identity can be found, and that is not the edit's doing.
      if (!trace) continue;
      const key = e.scope === 'kind' ? kindKey(part) : identityKey(part);
      const same = (i: PartIdentity): boolean => (e.scope === 'kind' ? kindKey(i) === key : identityKey(i) === key);
      specs.push({ id: e.id, parts: trace.parts.filter((p) => p.identity && same(p.identity)).map((p) => p.id), inner: e.target.inner, selector: null, text: guarded(e) });
    } else if (e.target.selector) {
      specs.push({ id: e.id, parts: null, inner: null, selector: e.target.selector, text: guarded(e) });
    } else continue;
    asked.push(e);
  }
  if (!asked.length) return out;
  // Words the site renders now because one of the layer's own text edits was made real (implemented, verified or
  // retired, or a draft with a verdict: one a failed verification sent back before implemented edits stayed so):
  // put back as they were, an element showing them is still the one an edit was made on (a style on a heading whose
  // words were then saved, a card around that heading). A draft never saved is left out: its words are not the
  // site's, so they cannot vouch for an element.
  const fold = (t: string): string => t.replace(/\s+/g, ' ').trim();
  const saved = edits.flatMap((x) => (x.change.type === 'text' && typeof x.before.text === 'string'
    && (x.state === 'implemented' || x.state === 'verified' || x.state === 'retired' || (x.state === 'draft' && x.verdict !== null))
    ? [{ now: fold(x.change.value), was: fold(x.before.text) }] : [])).filter((w) => w.now && w.now !== w.was);
  const asItWas = (t: string): string => saved.reduce((acc, w) => acc.split(w.now).join(w.was), fold(t));
  const found = await run<Found | null>(call('layerFind', specs, true), null);
  // No page script answered: nothing is said of any edit.
  if (!found || typeof found !== 'object') return out;
  for (const e of asked) {
    const f = found[e.id];
    const count = f && Number.isInteger(f.count) ? Math.min(f.count as number, 500) : 0;
    const texts = f && Array.isArray(f.texts) ? f.texts as unknown[] : [];
    const plain = f && Array.isArray(f.plain) ? f.plain as unknown[] : [];
    const accept: number[] = [];
    let why = count ? '' : 'Its element is not on this page any more.';
    // An implemented text edit's element shows its new words: that is the edit resolving, not other words.
    const theirs = e.change.type === 'text' ? layerTextHash(e.change.value) : null;
    // The words check: one element showing the text the edit was made on (or, for a text edit, its new words) says
    // the identity still names that thing; every element of that identity is then the same stored thing.
    const named = !guarded(e) || Array.from({ length: count }, (_, i) => {
      const t = typeof texts[i] === 'string' ? texts[i] as string : null;
      const h = t === null ? null : layerTextHash(t);
      return h === e.target.textHash || h === theirs || (t !== null && saved.length > 0 && layerTextHash(asItWas(t)) === e.target.textHash);
    }).some(Boolean);
    if (count && !named) why = 'Its element shows other words now.';
    for (let i = 0; i < count && named; i++) {
      if (e.change.type === 'text' && plain[i] !== true) { why ||= 'Its element holds more than words now.'; continue; }
      accept.push(i);
    }
    if (accept.length) {
      out.tags[e.id] = accept;
      out.resolved.push(e.id);
      out.shown.push({ id: e.id, elements: accept.length });
      if (e.change.type === 'text') out.texts.push({ id: e.id, value: e.change.value });
    } else if (madeOn(e, path)) {
      out.orphaned.push({ id: e.id, why });
    }
  }
  return out;
}

/** The edits as they are once this page's findings count: orphaned where they no longer resolve, drafts again where they do. */
export function effective(edits: readonly LayerEdit[], res: Pick<Resolution, 'orphaned' | 'resolved'>): LayerEdit[] {
  const lost = new Set(res.orphaned.map((o) => o.id));
  const back = new Set(res.resolved);
  return edits.map((e) => (lost.has(e.id) ? { ...e, state: 'orphaned' } : e.state === 'orphaned' && back.has(e.id) ? { ...e, state: 'draft' } : e));
}

/**
 * Where a text edit's words are saved: the content, translation and item its target names (a Drupal field part's
 * identity: the content's UUID, its langcode, and the item when the part is one), once the field the helper marked
 * around its element (`type:id:field:fieldtype[:langcode]`) is checked to be that field. Anything else is why not:
 * the words are never saved to a field, a translation or an item the target does not name.
 */
export function saveTarget(part: PartIdentity | null, field: string): SaveAt | string {
  const [type, , name] = field.split(':');
  if (!part || part.kind !== 'entity' || !part.field) {
    return 'Its target is not a field of content the helper names, so Wanigan cannot say which content, translation and item the words would be saved to. An agent can make the change from a brief.';
  }
  if (part.type !== type || part.field !== name) return 'The field marked around its element is not the one its target names. Reload the page, then try again.';
  if (!part.langcode) return 'Its target does not say which translation it was made on, so the words are saved to none. Reload the page, then try again.';
  return { uuid: part.id, langcode: part.langcode, item: part.item ?? null };
}

/** What the tray calls an element, by its name. */
const NAMES: Record<string, string> = {
  h1: 'Heading', h2: 'Heading', h3: 'Heading', h4: 'Heading', h5: 'Heading', h6: 'Heading', p: 'Paragraph', a: 'Link', button: 'Button',
  img: 'Image', picture: 'Image', figure: 'Figure', figcaption: 'Caption', ul: 'List', ol: 'List', li: 'List item', blockquote: 'Quote',
  span: 'Text', strong: 'Text', em: 'Text', small: 'Text', label: 'Label', nav: 'Navigation', header: 'Header', footer: 'Footer',
  section: 'Section', article: 'Article', aside: 'Aside', main: 'Main content', div: 'Box', table: 'Table', form: 'Form', input: 'Field',
};
const humanName = (tag: unknown): string => (typeof tag === 'string' && NAMES[tag.toLowerCase()]) || (typeof tag === 'string' && /^[a-z][a-z0-9-]{0,40}$/i.test(tag) ? `<${tag.toLowerCase()}>` : 'Element');

/** What `kind` reaches, in words: "every Card component", "the Body field of every article", "the heading in every Card component". */
export function kindWords(part: TracePart, key: string, inner: string | null): string {
  const [kind, a, b] = key.split('|');
  const base = kind === 'field' ? `the ${part.label} field of every ${b}`
    : kind === 'entity' ? `every ${b} ${a}`
      : kind === 'plugin' ? `every ${b} ${a}`
        : `every ${part.label} ${part.identity?.kind === 'block' ? 'block' : 'component'}`;
  return inner ? `the ${inner.toLowerCase()} in ${base}` : base;
}

/* ── rendering for a verification ───────────────────────────────────────── */

export interface LayerRenderRequest {
  projectId: string;
  partition: string;
  url: string;
  base: string;
  token: string;
  width: number;
  /** The page's path, as edits name it. */
  path: string;
  /** The edits verified: tagged in both renders, shown (their stylesheet and words) only in the design. */
  edits: LayerEdit[];
  design: boolean;
}

export interface LayerRendered {
  png: Buffer;
  bitmap: Bitmap;
  /** Every tagged element of the edits, as layerSnap read it. */
  elements: ElementSnap[];
  /** The edits that found their elements in this render. */
  found: string[];
}

export type LayerRender = (r: LayerRenderRequest) => Promise<LayerRendered | { error: string }>;

/** What the page script's layerSnap answered, checked. */
export function snapsOf(raw: unknown): ElementSnap[] {
  if (!Array.isArray(raw)) return [];
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);
  return raw.slice(0, 5_000).flatMap((s): ElementSnap[] => {
    if (!s || typeof s !== 'object') return [];
    const r = s as Record<string, unknown>;
    if (typeof r.edit !== 'string' || !EDIT_ID.test(r.edit) || !Number.isInteger(r.n)) return [];
    const values: Record<string, string> = {};
    if (r.values && typeof r.values === 'object') for (const [k, v] of Object.entries(r.values as Record<string, unknown>).slice(0, 80)) if (typeof v === 'string') values[k.slice(0, 60)] = v.slice(0, 2_000);
    const box = r.box && typeof r.box === 'object' ? r.box as Record<string, unknown> : {};
    return [{ edit: r.edit, n: r.n as number, element: typeof r.element === 'string' ? r.element.slice(0, 200) : 'element', values, box: { x: n(box.x), y: n(box.y), width: n(box.width), height: n(box.height) } }];
  });
}

/** A render in a hidden window (live-capture.ts): the page with its own trace, the edits found and tagged, the design's layer shown. */
function renderInWindow(deps: {
  pageScript: () => string | null;
  sessionFor: (projectId: string, url: string) => { fetch: SiteFetch } | null;
  askTrace: AskTrace;
  decode: (png: Buffer) => Promise<Bitmap>;
}): LayerRender {
  return (r) => inHiddenWindow<LayerRendered>(
    { partition: r.partition, url: r.url, base: r.base, width: r.width, network: true, freeze: true, what: 'The page', failed: 'The page could not be rendered' },
    async (page) => {
      const script = deps.pageScript();
      if (!script) return { error: 'This build of Wanigan has no page script, so it cannot find the edits on a page.' };
      if (!sameSite(r.base, page.wc.getURL())) return { error: 'The page left the site; Wanigan does not follow it.' };
      // This render's own trace: identities are resolved against what the site rendered this time.
      const id = page.headers()?.['x-wanigan-trace'] ?? null;
      const ses = deps.sessionFor(r.projectId, r.base);
      const answer = id && TRACE_ID.test(id) && ses ? await deps.askTrace((u, init) => ses.fetch(u, init), new URL(page.wc.getURL()).origin, r.token, id) : null;
      const trace = answer?.state === 'ok' ? answer.trace : null;
      await page.read(script, null, PAGE_WORLD);
      const run: Run = (code, fallback) => page.read(code, fallback, PAGE_WORLD);
      const res = await resolveLayer(run, trace, r.edits, r.path);
      if (r.design) {
        const css = compileLayer(r.edits, [], 'g1');
        if (css) await page.wc.insertCSS(css, { cssOrigin: 'user' });
      }
      await run(call('layerSet', { tags: res.tags, texts: r.design ? res.texts : [], on: r.design, gate: r.design ? 'g1' : null }), 0);
      await page.freeze();
      const { height } = await page.grow(VERIFY_MAX_HEIGHT);
      const elements = snapsOf(await run<unknown>(call('layerSnap', r.edits.map((e) => e.id), LAYER_PROPERTIES), []));
      const png = await page.shoot(height, true);
      if (!png) return { error: 'The page could not be pictured.' };
      return { png, bitmap: await deps.decode(png), elements, found: res.resolved };
    },
  );
}

/** PNGs to pixels and back, through Electron's nativeImage (loaded only when used). */
async function decodePng(png: Buffer): Promise<Bitmap> {
  const { nativeImage } = await import('electron');
  const image = nativeImage.createFromBuffer(png);
  const { width, height } = image.getSize();
  return { data: image.toBitmap(), width, height };
}
async function encodePng(b: Bitmap): Promise<Buffer> {
  const { nativeImage } = await import('electron');
  return nativeImage.createFromBitmap(Buffer.from(b.data.buffer, b.data.byteOffset, b.data.byteLength), { width: b.width, height: b.height }).toPNG();
}

/* ── the wiring ─────────────────────────────────────────────────────────── */

export interface LiveLayerOptions {
  /** Electron's ipcMain (a stand-in in tests: everything here is reached through it). */
  ipc: Pick<IpcMain, 'handle'>;
  trusted: (event: IpcMainInvokeEvent) => boolean;
  /** Whether the owner has the live view switched on. */
  enabled: () => boolean;
  client: () => Promise<Client>;
  /** The live view as it is now (live-view.ts). */
  current: () => LiveCurrent | null;
  /** Run code in the view's page script (live-view.ts). */
  run: Run;
  /** The shown page's trace (live-inspect.ts). */
  trace: () => Promise<LiveTraceAnswer>;
  /** The helper's save of words to a plain text field, as the view's user, at the content, translation and item named (live-view.ts). */
  helperSave: (field: string, before: string, after: string, at?: SaveAt) => Promise<HelperSaved | null>;
  /** The partition a render of a project's page runs in, prepared with its trust and the helper's token (live-view.ts). */
  partition: (projectId: string, url: string, token: string | null) => string;
  /** A project's view session, for asking a hidden render's trace (live-view.ts). */
  sessionFor: (projectId: string, url: string) => { fetch: SiteFetch } | null;
  /** One render's trace from the helper (live-inspect.ts askTrace). */
  askTrace: AskTrace;
  pageScript: () => string | null;
  /** Wanigan's data folder: verification pictures go under live-layer/ in it. */
  dataDir: string;
  /** Test seams: what renders a page for a verification, and how a difference picture becomes a PNG. */
  render?: LayerRender;
  encode?: (b: Bitmap) => Promise<Buffer>;
  now?: () => number;
}

export function wireLiveLayer(options: LiveLayerOptions): { hooks: LiveViewHooks; apply(): Promise<LayerApplied> } {
  const { ipc } = options;
  const clock = options.now ?? Date.now;
  const render = options.render ?? renderInWindow({ pageScript: options.pageScript, sessionFor: options.sessionFor, askTrace: options.askTrace, decode: decodePng });
  const encode = options.encode ?? encodePng;
  const root = join(options.dataDir, 'live-layer');
  /** The layer is shown (layerShow); a load keeps the choice. */
  let on = true;
  /** The stylesheet the layer injected into the view's page last, by the page's webContents. */
  let sheet: { wc: number; key: string } | null = null;
  /** Each sheet's generation: the page's root names the one that holds (compileLayer's gate). */
  let generation = 0;
  /** Applying, one at a time; and verifying, one at a time (each loads whole pages in hidden windows). */
  let applying: Promise<unknown> = Promise.resolve();
  let verifying: Promise<unknown> = Promise.resolve();

  const ok = (event: IpcMainInvokeEvent): boolean => options.trusted(event) && options.enabled();
  const core = async <T>(method: Method, params: unknown): Promise<T> => (await options.client()).callRaw(method, params) as Promise<T>;
  const snapshotOf = (projectId: string): Promise<LayerSnapshot> => core<LayerSnapshot>('live.layer', { projectId });
  const mark = (projectId: string, id: string, state: LayerEdit['state'], verdict?: LayerVerdict): Promise<unknown> =>
    core('live.layerMark', { projectId, id, state, ...(verdict ? { verdict } : {}) }).catch(() => null);

  /** The local site's page the view shows, when it shows one. */
  const shown = (): { cur: LiveCurrent; url: string; path: string } | null => {
    const cur = options.current();
    if (!cur || cur.env || cur.webContents.isDestroyed()) return null;
    const url = cur.webContents.getURL();
    return url && sameSite(cur.base, url) ? { cur, url, path: pathOf(url) } : null;
  };

  /**
   * Put the layer's new stylesheet on a page, gated on a generation the page does not name yet, so it holds nothing
   * until layerSet switches the root to it. The user origin: its !important outranks every page declaration, a
   * layered !important included (an author sheet from insertCSS comes before the page's and loses ties:
   * docs/research/2026-10-09-design-layer-probes.md). Returns the old sheet's key, to let go of once the page has
   * moved on. Electron cannot take a user-origin sheet out (removeInsertedCSS removes author sheets only), so the
   * old one stays inert under a generation the root no longer names; asking costs nothing.
   */
  const putSheet = async (wc: WebContents, css: string): Promise<string | null> => {
    const old = sheet && sheet.wc === wc.id ? sheet.key : null;
    sheet = null;
    if (css) sheet = { wc: wc.id, key: await wc.insertCSS(css, { cssOrigin: 'user' }) };
    return old;
  };

  const applyNow = async (): Promise<LayerApplied> => {
    const here = shown();
    if (!here) return { page: '', shown: [], orphaned: [], elsewhere: [], off: !on };
    const { cur, url, path } = here;
    const snap = await snapshotOf(cur.projectId);
    const answer = await options.trace();
    const res = await resolveLayer(options.run, answer.state === 'ok' ? answer.trace : null, snap.edits, path);
    const now = effective(snap.edits, res);
    // A page that went away meanwhile has its own load, and is applied then.
    if (cur.webContents.isDestroyed() || cur.webContents.getURL() !== url) return { page: path, shown: [], orphaned: [], elsewhere: [], off: !on };
    // Phase 1 passes no breakpoints: an edit for a named one is left out, not guessed. The new sheet goes in inert,
    // then one call tags, patches the words and names its generation on the root: nothing flickers, and switched
    // off, the root names none.
    const gate = on ? `g${++generation}` : null;
    const old = await putSheet(cur.webContents, gate ? compileLayer(now, [], gate) : '');
    await options.run(call('layerSet', { tags: res.tags, texts: on ? res.texts : [], on, gate }), 0);
    if (old && !cur.webContents.isDestroyed()) await cur.webContents.removeInsertedCSS(old).catch(() => {});
    // The core is told what this page found: lost drafts are orphaned, found ones are drafts again. An implemented
    // edit is in the site whatever this load showed: it is said to the window, and stays implemented.
    const was = new Map(snap.edits.map((e) => [e.id, e.state]));
    for (const o of res.orphaned) if (was.get(o.id) === 'draft') await mark(cur.projectId, o.id, 'orphaned');
    for (const id of res.resolved) if (was.get(id) === 'orphaned') await mark(cur.projectId, id, 'draft');
    const orphaned = res.orphaned.map((o) => (was.get(o.id) === 'implemented' ? { ...o, why: `${o.why} It is in the site, so it stays implemented.` } : o));
    return { page: path, shown: on ? res.shown : [], orphaned, elsewhere: res.elsewhere, off: !on };
  };
  const apply = (): Promise<LayerApplied> => {
    const next = applying.then(applyNow, applyNow);
    applying = next.catch(() => {});
    return next;
  };

  const hooks: LiveViewHooks = {
    view(wc) {
      sheet = null;
      if (!wc) return;
      // A new document has none of the old one's stylesheet.
      wc.on('did-start-navigation', (details) => { if (details.isMainFrame && !details.isSameDocument && sheet?.wc === wc.id) sheet = null; });
      wc.on('did-finish-load', () => { if (options.enabled()) void apply().catch(() => {}); });
    },
  };

  /* ── the picked element, keyed ── */

  const target = async (): Promise<LayerPickTarget | null> => {
    const here = shown();
    if (!here) return null;
    const answer = await options.trace();
    const trace = answer.state === 'ok' ? answer.trace : null;
    type Pick = { parts?: unknown; selector?: unknown; text?: unknown; tag?: unknown; values?: unknown };
    const pick = await options.run<Pick | null>(call('layerPick', LAYER_PROPERTIES), null);
    if (!pick || typeof pick !== 'object') return null;
    const byId = new Map((trace?.parts ?? []).map((p) => [p.id, p]));
    let keyed: { part: TracePart & { identity: PartIdentity }; inner: string | null } | null = null;
    for (const k of Array.isArray(pick.parts) ? pick.parts as { part?: unknown; inner?: unknown }[] : []) {
      const p = typeof k?.part === 'string' ? byId.get(k.part) : undefined;
      if (p?.identity && (k.inner === null || typeof k.inner === 'string')) { keyed = { part: p as TracePart & { identity: PartIdentity }, inner: k.inner as string | null }; break; }
    }
    // Its whole text, as the site rendered it: what the edit is checked against on every load. None, no check.
    const words = typeof pick.text === 'string' && pick.text ? pick.text : null;
    const textHash = words ? layerTextHash(words) : null;
    const values = pick.values && typeof pick.values === 'object' ? pick.values as Record<string, unknown> : {};
    const before: Record<string, string> = {};
    for (const k of LAYER_PROPERTIES) if (typeof values[k] === 'string') before[k] = (values[k] as string).slice(0, 2_000);
    if (words) before.text = words.slice(0, 2_000);
    const human = humanName(pick.tag);
    // Checked as the core will check it: a target it would refuse is not offered.
    const sound = (t: LayerTarget): boolean => !layerEdit({ id: 'check', target: t, scope: 'this', breakpoint: 'all', change: { type: 'style', values: { color: 'red' } } }).refused;
    if (keyed) {
      const t: LayerTarget = { part: keyed.part.identity, inner: keyed.inner, selector: null, textHash };
      if (sound(t)) {
        const partName = `${keyed.part.label} (${keyed.part.kind})`;
        const key = kindKey(keyed.part.identity);
        let kindCount = 0;
        if (key && trace) {
          const parts = trace.parts.filter((p) => p.identity && kindKey(p.identity) === key).map((p) => p.id);
          const counted = await options.run<Found | null>(call('layerFind', [{ id: 'kind', parts, inner: keyed.inner, selector: null }], false), null);
          const n = counted?.kind?.count;
          kindCount = Number.isInteger(n) ? n as number : 0;
        }
        return {
          target: t, label: keyed.inner ? `${human} in ${partName}` : partName,
          kindLabel: key ? kindWords(keyed.part, key, keyed.inner ? human : null) : null, kindCount, before, fragile: false,
        };
      }
    }
    if (typeof pick.selector !== 'string') return null;
    const t: LayerTarget = { part: null, inner: null, selector: pick.selector, textHash };
    return sound(t) ? { target: t, label: `${human} (no part names it)`, kindLabel: null, kindCount: 0, before, fragile: true } : null;
  };

  /* ── making an edit real ── */

  const implement = async (raw: unknown): Promise<LayerImplemented> => {
    const id = typeof raw === 'string' && EDIT_ID.test(raw) ? raw : '';
    const none = (why: string): LayerImplemented => ({ ok: false, id, route: 'none', why });
    if (!id) return none('Which edit?');
    const cur = options.current();
    if (!cur) return none('The live view shows no site.');
    const edit = (await snapshotOf(cur.projectId)).edits.find((e) => e.id === id);
    if (!edit) return none('That edit is not in the layer.');
    if (edit.change.type === 'style' || edit.change.type === 'token') {
      return { ok: false, id, route: 'agent', why: edit.change.type === 'token'
        ? 'A token is the theme’s: changing it natively is a code change, which an agent makes from a brief, on your click.'
        : 'A style goes into the theme’s CSS: in phase 1 an agent makes it from a brief, on your click.' };
    }
    if (edit.change.type !== 'text') return none('Only words and styles are made real from the layer so far.');
    if (edit.state === 'implemented' || edit.state === 'verified') return none('It is in the site already.');
    if (edit.state === 'orphaned') return none('Its element is not on its page any more, so there is nothing to save it to.');
    if (edit.state !== 'draft') return none(`It is ${edit.state}.`);
    if (edit.scope !== 'this') return none('Words are saved one element at a time: make this edit for one element, not every instance.');
    const value = edit.change.value;
    const here = shown();
    if (!here || here.cur.projectId !== cur.projectId || !madeOn(edit, here.path)) return none(`Open ${edit.page} in the live view first: words are saved from the page they are on.`);
    const at = await options.run<{ count?: unknown; field?: unknown; words?: unknown; plain?: unknown } | null>(call('layerOf', id), null);
    if (!at || at.count === 0) return none('Its element is not tagged on this page. Reload the page, then try again.');
    if (at.count !== 1) return none(`It reaches ${String(at.count)} elements here; words are saved one element at a time.`);
    if (at.plain !== true || typeof at.words !== 'string') return none('Its element holds more than plain words, so they are not saved from here.');
    if (typeof at.field !== 'string') return none('These words are not in a plain text field the site helper marks: they come from a template, a setting or formatted text. An agent can make the change from a brief.');
    if (at.words.length > SAVE_MAX || value.length > SAVE_MAX) return none(`Words longer than ${SAVE_MAX.toLocaleString('en')} characters are saved in the site’s own form.`);
    // Exactly the field, translation and item the edit's target names: never the first item that happens to hold the
    // same words, never the content's default language.
    const where = saveTarget(edit.target.part, at.field);
    if (typeof where === 'string') return none(where);
    const saved = await options.helperSave(at.field, at.words, value, where);
    if (!saved) return none('The live view has no helper for this site.');
    if (!saved.ok) return none(saved.error ?? 'The site did not save it.');
    await core('live.layerMark', { projectId: cur.projectId, id, state: 'implemented' });
    // The site now has the words: the page shows them as it renders them, and the layer applies again after the load.
    if (!here.cur.webContents.isDestroyed()) here.cur.webContents.reloadIgnoringCache();
    return { ok: true, id, state: 'implemented', revision: saved.revision ?? null };
  };

  /* ── verifying ── */

  const verifyNow = async (raw: unknown, rawOptions: unknown): Promise<LayerVerdict> => {
    const cur = options.current();
    if (!cur) throw new Error('The live view shows no site.');
    const projectId = cur.projectId;
    const widths = verifyWidths(rawOptions && typeof rawOptions === 'object' ? (rawOptions as { widths?: unknown }).widths : undefined);
    if (typeof widths === 'string') throw new Error(widths);
    const snap = await snapshotOf(projectId);
    let edits: LayerEdit[];
    let page: string;
    if (raw === null || raw === undefined) {
      const here = shown();
      if (!here) throw new Error('The live view shows no page of the local site.');
      page = here.path;
      edits = snap.edits.filter((e) => e.state === 'implemented' && madeOn(e, page));
      if (!edits.length) throw new Error('No edit made on this page is implemented: there is nothing to verify here yet.');
    } else {
      const edit = typeof raw === 'string' && EDIT_ID.test(raw) ? snap.edits.find((e) => e.id === raw) : undefined;
      if (!edit) throw new Error('That edit is not in the layer.');
      if (edit.state !== 'implemented') throw new Error(`Only an implemented edit is verified; this one is ${edit.state}. Make it real first.`);
      edits = [edit];
      page = edit.page;
    }
    const site = await core<LiveSite>('live.site', { projectId });
    if (!site.url || !site.token) throw new Error('The site helper is not installed, and a verification finds the edits through it.');
    const origin = new URL(site.url).origin;
    const url = new URL(page, origin).toString();
    if (!sameSite(site.url, url)) throw new Error('That page is not on this site.');
    const partition = options.partition(projectId, site.url, site.token);
    const ask = (width: number, design: boolean) => render({ projectId, partition, url, base: site.url as string, token: site.token as string, width, path: page, edits, design });

    const found: WidthFindings[] = [];
    const shots: { width: number; design: Buffer; result: Buffer; resultBitmap: Bitmap; d: ReturnType<typeof diffBitmaps> }[] = [];
    for (const width of widths) {
      const first = await ask(width, false);
      if ('error' in first) throw new Error(first.error);
      const second = await ask(width, false);
      if ('error' in second) throw new Error(second.error);
      const design = await ask(width, true);
      if ('error' in design) throw new Error(design.error);
      const again = await ask(width, true);
      if ('error' in again) throw new Error(again.error);
      // Each version against itself: what this page does not repeat exactly, whichever of the two it is.
      const noise = widestNoise([noiseFloor(first.bitmap, second.bitmap), noiseFloor(design.bitmap, again.bitmap)]);
      const elements = compareElements(design.elements, first.elements, width);
      // An edit the design cannot find is not verified by finding nothing different.
      for (const e of edits) {
        if (e.change.type === 'token' || design.found.includes(e.id)) continue;
        elements.push({ kind: 'style', edit: e.id, width, element: e.label, property: 'element', design: 'not found on the page', result: first.found.includes(e.id) ? 'on the page' : 'not found on the page' });
      }
      const zones: Zone[] = zonesOf(design.elements, first.elements);
      // A token reaches the whole page: what differs anywhere is its.
      for (const e of edits) if (e.change.type === 'token') zones.push({ edit: e.id, rect: { x: 0, y: 0, width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER } });
      const d = diffBitmaps(design.bitmap, first.bitmap);
      found.push({ width, noise, elements, pixels: comparePixels(d, zones, width) });
      shots.push({ width, design: design.png, result: first.png, resultBitmap: first.bitmap, d });
    }
    // One floor for the whole verdict, the one it states: the largest over both versions and every width. Two renders
    // of a width that happened to match exactly do not make that width stricter than the page is.
    const floor = verdictNoise(found);
    const outcome = judge(found.map((w) => ({ ...w, noise: floor })));
    const images: { width: number; design: Buffer; result: Buffer; diff: Buffer }[] = [];
    for (const i of shots) images.push({ width: i.width, design: i.design, result: i.result, diff: i.d.pixels ? await encode(diffPicture(i.resultBitmap, i.d, floor)) : Buffer.alloc(0) });
    const base: Omit<LayerVerdict, 'pictures'> = {
      at: clock(), ok: outcome.ok, failed: outcome.failed, widths, noise: floor, differences: outcome.differences.slice(0, MAX_DIFFERENCES),
    };
    // The pictures, for each edit's tray row: its own folder, written afresh.
    const verdicts = new Map<string, LayerVerdict>();
    for (const e of edits) {
      const dir = join(root, folderOf(projectId), e.id);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const pictures = images.map((i) => {
        const file = (kind: string): string => join(dir, `${i.width}-${kind}.png`);
        writeFileSync(file('design'), i.design, { mode: 0o600 });
        writeFileSync(file('result'), i.result, { mode: 0o600 });
        if (i.diff.length) writeFileSync(file('diff'), i.diff, { mode: 0o600 });
        return { width: i.width, design: file('design'), result: file('result'), diff: i.diff.length ? file('diff') : null };
      });
      verdicts.set(e.id, { ...base, pictures });
    }
    // The core is told: verified, or still implemented with the verdict. The words are in the site either way; a
    // failed verdict says what differs, and never makes an edit a draft again (from where it could be discarded).
    for (const e of edits) {
      const v = verdicts.get(e.id) as LayerVerdict;
      await mark(projectId, e.id, base.ok ? 'verified' : 'implemented', v);
    }
    return verdicts.get(edits[0]!.id) as LayerVerdict;
  };
  const verify = (raw: unknown, rawOptions: unknown): Promise<LayerVerdict> => {
    const next = verifying.then(() => verifyNow(raw, rawOptions), () => verifyNow(raw, rawOptions));
    verifying = next.catch(() => {});
    return next;
  };

  /** A kept picture as base64, only from under live-layer/ in the data folder, and only a PNG. */
  const picture = (raw: unknown): string | null => {
    if (typeof raw !== 'string' || !raw.endsWith('.png') || raw.length > 2_000) return null;
    try {
      const file = realpathSync(resolve(raw));
      const inside = `${realpathSync(root)}${sep}`;
      return file.startsWith(inside) ? readFileSync(file).toString('base64') : null;
    } catch {
      return null;
    }
  };

  const off = (): LayerApplied => ({ page: '', shown: [], orphaned: [], elsewhere: [], off: true });
  ipc.handle('live:layerApply', async (event) => (ok(event) ? apply() : off()));
  ipc.handle('live:layerShow', async (event, raw: unknown) => {
    if (!ok(event)) return off();
    if (typeof raw === 'boolean') on = raw;
    return apply();
  });
  ipc.handle('live:layerTarget', async (event) => (ok(event) ? target() : null));
  ipc.handle('live:layerImplement', async (event, raw: unknown): Promise<LayerImplemented> => (ok(event)
    ? implement(raw) : { ok: false, id: typeof raw === 'string' ? raw.slice(0, 64) : '', route: 'none', why: 'The live view is off.' }));
  ipc.handle('live:layerVerify', async (event, raw: unknown, rawOptions: unknown): Promise<LayerVerdict> => {
    if (!ok(event)) throw new Error('The live view is off.');
    return verify(raw, rawOptions);
  });
  ipc.handle('live:layerPicture', async (event, raw: unknown) => (options.trusted(event) ? picture(raw) : null));

  return { hooks, apply };
}
