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
//   `data-wl-edit`; compileLayer() is injected as one stylesheet, replaced whole; text edits patch their words in
//   place. The same stored thing rendered twice on a page (an entity, a post) is two parts with one identity: an edit
//   for `this` reaches every one of them, as the native change will, once one of them shows the words it was made on.
//   An edit of this page that no longer resolves, or resolves to other words, is orphaned and the core is
//   told; it is a draft again once it resolves. Without a trace nothing is resolved by identity, and nothing is
//   called orphaned for it. Edits for a named breakpoint are left out: phase 1 does not read the theme's breakpoints.
// - Implementing: only words, saved where they are kept, as the user logged in in the view. Where the helper marks a
//   plain text field around them (Drupal's `data-wl-field`), through `POST /_wanigan/save`, the window's own
//   helperSave path. Otherwise through the one edit target of the page's trace that holds exactly those words
//   (wordsTarget(): a title, an excerpt, a string meta, a setting, a menu link's text), saved by the window's own
//   schema save (`POST /_wanigan/edit/<id>`, live-edit-save.ts): how WordPress's helper saves a field. Formatted text
//   (a block's, a post's content, a value with markup) goes to an agent as a brief, as do styles and tokens; anything
//   else says why.
// - Verifying ("Stage 3: verify", steps 1–3): the design (the page with the layer) and the result (the page without
//   it) rendered in hidden windows in the view's session at each width (live-capture.ts), the result twice first for
//   the noise floor; the comparisons are src/shared/layer-verify.ts's. Pictures are kept in the data folder under
//   live-layer/<project>/<edit>/, and the core is told: verified, or back to draft with the verdict.
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
  MAX_DIFFERENCES, compareElements, comparePixels, diffBitmaps, diffPicture, editsAt, judge, noiseFloor, verdictNoise, verifyWidths, zonesOf,
  type Bitmap, type ElementSnap, type WidthFindings, type Zone,
} from '../shared/layer-verify.ts';
import type { LiveEditSaved, LiveTraceAnswer } from '../shared/live-lens.ts';
import { TRACE_ID, identityKey, kindKey, type EditTarget, type LiveTrace, type PartIdentity, type TracePart } from '../shared/live-trace.ts';
import { sameSite, type LiveSite } from '../shared/live.ts';
import type { Method } from '../shared/protocol.ts';
import { folderOf, inHiddenWindow } from './live-capture.ts';
import type { HelperSaved, LiveCurrent, LiveViewHooks } from './live-view.ts';

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
      return h === e.target.textHash || h === theirs;
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

/* ── which edit target holds an element's words ─────────────────────────── */

/** The edit target to save new words to, and where in its value they go (a property of an object, or the value); or why there is none. */
export type WordsTarget =
  | { ok: true; target: EditTarget; key: string | null }
  | { ok: false; route: 'agent' | 'none'; why: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A schema's one type; a nullable `["string", "null"]` counts as its real one (as live-schema.ts reads it). */
function typeOf(s: Record<string, unknown>): string | null {
  if (typeof s.type === 'string') return s.type;
  const real = Array.isArray(s.type) ? s.type.filter((t) => t !== 'null') : [];
  return real.length === 1 && typeof real[0] === 'string' ? real[0] : null;
}

/** A tag, or a comment: a value holding one is formatted text, and its words are only part of what it keeps. */
const TAG = /<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?\/?>|<!--[\s\S]*?-->/i;
const TAGS = new RegExp(TAG.source, 'gi');
/** The character references a title or a setting is commonly kept with (WordPress keeps `&` in a title as `&amp;`). */
const REFS: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' };
/** A kept value as the page shows it: its tags taken out, its character references read. */
const shownOf = (value: string): string => value.replace(TAGS, '').replace(/&(?:#(\d{1,7})|#x([\da-f]{1,6})|([a-z]{2,8}));/gi, (ref, dec?: string, hex?: string, name?: string) => {
  const code = dec ? Number(dec) : hex ? Number.parseInt(hex, 16) : null;
  if (code !== null) return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ref;
  return REFS[(name ?? '').toLowerCase()] ?? ref;
});
/**
 * Words compared as words: whitespace folded as the page script folds it, and the typography a site prints a value
 * with read as what it was typed as (WordPress's wptexturize curls a title's quotes and turns `--` and `...` into a
 * dash and an ellipsis).
 */
const asWords = (s: string): string => s
  .replace(/[‘’‚‛′]/g, '\'').replace(/[“”„‟″]/g, '"')
  .replace(/…/g, '...').replace(/---|--|[–—]/g, '-')
  .replace(/\s+/g, ' ').trim();

/** Where in one target words are, and whether they are kept as formatted text. */
interface Holding { target: EditTarget; key: string | null; formatted: boolean }

/**
 * Where a schema target holds exactly these words: its value (a string schema), or a string property of its value (an
 * object schema: a menu link's text, a widget's title). Only words count: a slug or a status (`property`), a template's
 * name, a choice, an address or a date (a `format`), a read-only value are never words to save into. A block's text
 * (`block-attributes`) is rich text in its saved markup, and a value holding a tag is formatted text: those are
 * found too, as formatted, so the refusal can say so.
 */
function holdings(t: EditTarget, want: string): Holding[] {
  if (t.via !== 'schema' || t.kind === 'property' || t.kind === 'template-override') return [];
  const rich = t.kind === 'block-attributes';
  const one = (schema: unknown, value: unknown, key: string | null): Holding[] => {
    if (typeof value !== 'string' || !isObj(schema)) return [];
    const type = typeOf(schema);
    if (rich || type === 'rich-text' || TAG.test(value)) return asWords(shownOf(value)) === want ? [{ target: t, key, formatted: true }] : [];
    const words = type === 'string' && schema.readOnly !== true && schema.enum === undefined && schema.oneOf === undefined && schema.const === undefined
      && (schema.format === undefined || schema.format === 'textarea');
    return words && asWords(shownOf(value)) === want ? [{ target: t, key, formatted: false }] : [];
  };
  if (isObj(t.schema) && isObj(t.schema.properties)) {
    const value = t.value;
    return isObj(value) ? Object.entries(t.schema.properties).slice(0, 200).flatMap(([k, s]) => one(s, value[k], k)) : [];
  }
  return one(t.schema, t.value, null);
}

/** A post's content (WordPress): words inside it are kept in its formatted markup, never as a field of their own. */
const isContent = (p: TracePart): boolean => p.identity?.kind === 'entity' && p.identity.type === 'post' && p.identity.field === 'post_content';
/** The post a part shows through WordPress's block context: the `context.postId` the helper lists among a block's variables. */
function contextPost(p: TracePart): string | null {
  const v = p.variables?.find((x) => x.name === 'context.postId');
  return v && /^\d{1,20}$/.test(v.preview) ? v.preview : null;
}

/** Labels said as a list: "A and B", "A, B and C", and how many more past four. */
function listed(labels: string[]): string {
  const shown = labels.slice(0, 4);
  const more = labels.length - shown.length;
  if (more) return `${shown.join(', ')} and ${more} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0] ?? '';
}

/**
 * The one edit target of a trace that holds exactly an element's words, as the site rendered them, for saving new
 * words to: looked for in the parts the edit's identity names (as resolveLayer matches them), then outward a level at a
 * time, and the nearest level with any finding decides. Outward is each part's parent, and the post a block shows
 * through its context: a post-title block shows its post's title, inside the post or wherever the template put it,
 * and that post's parts carry the title's target. A post's content reached only as what the element sits in means
 * the words are content. One plain finding is the answer; none, several, formatted text or a target the site says
 * cannot be changed here is refused with why.
 */
export function wordsTarget(trace: LiveTrace, identity: PartIdentity, words: string): WordsTarget {
  const want = asWords(words);
  if (!want) return { ok: false, route: 'none', why: 'Its element shows no words to find.' };
  const targets = new Map(trace.edits.map((e) => [e.id, e]));
  const byId = new Map(trace.parts.map((p) => [p.id, p]));
  const key = identityKey(identity);
  let level = trace.parts.filter((p) => p.identity && identityKey(p.identity) === key);
  if (!level.length) return { ok: false, route: 'none', why: 'This page’s trace no longer has the part this edit was made on: the page changed since. Reload it, then try again.' };
  const seen = new Set(level.map((p) => p.id));
  /** Parts of the post a block at the level before shows through its context. */
  let shows = new Set<string>();
  for (let depth = 0; level.length && depth < 64; depth++) {
    const content = level.find((p) => isContent(p) && !shows.has(p.id));
    if (content) {
      return { ok: false, route: 'agent', why: `These words are in a post’s content (${content.label}), which the site keeps as formatted text: Wanigan does not save it from here. An agent can make the change from a brief.` };
    }
    const found = new Map<string, Holding>();
    for (const p of level) {
      for (const id of p.edits ?? []) {
        const t = targets.get(id);
        if (t) for (const h of holdings(t, want)) found.set(`${t.id}\n${h.key ?? ''}`, h);
      }
    }
    const all = [...found.values()];
    if (all.length > 1) {
      return { ok: false, route: 'none', why: `More than one thing here holds exactly these words (${listed([...new Set(all.map((h) => h.target.label))])}), so Wanigan cannot tell which to save them to.` };
    }
    const [h] = all;
    if (h?.formatted) {
      return { ok: false, route: 'agent', why: `These words are formatted text (${h.target.label}): the site keeps them with their markup, which Wanigan does not save from here. An agent can make the change from a brief.` };
    }
    if (h) return h.target.why ? { ok: false, route: 'none', why: h.target.why } : { ok: true, target: h.target, key: h.key };
    const next: TracePart[] = [];
    const nextShows = new Set<string>();
    for (const p of level) {
      const post = contextPost(p);
      if (post) {
        for (const q of trace.parts) {
          if (q.identity?.kind !== 'entity' || q.identity.type !== 'post' || q.identity.id !== post) continue;
          nextShows.add(q.id);
          if (!seen.has(q.id)) { seen.add(q.id); next.push(q); }
        }
      }
      const up = p.parent ? byId.get(p.parent) : undefined;
      if (up && !seen.has(up.id)) { seen.add(up.id); next.push(up); }
    }
    level = next;
    shows = nextShows;
  }
  return {
    ok: false, route: 'none',
    why: 'Nothing this page offers to edit holds exactly these words, so there is nothing here to save them to: they come from a template, from formatted text, or from something the site helper does not offer on this page.',
  };
}

/** Why there is no trace to find what holds an element's words in. */
function untraced(answer: Exclude<LiveTraceAnswer, { state: 'ok' }>): string {
  if (answer.state === 'none') return 'The live view shows no page of this site now.';
  if (answer.state === 'no-helper') return 'The live view has no helper for this site.';
  const lead = 'Wanigan finds what holds these words in the page’s trace, and has none for this page';
  if (answer.state === 'other') return `${lead}: the site’s helper answers to another Wanigan. Set the helper up again from this one.`;
  if (answer.state === 'refused') return `${lead}: the helper refused it (it answered ${answer.status}). Log in as a user who may administer the site in the live view, then reload.`;
  const why = answer.state === 'missing' ? 'the page came without one' : answer.state === 'expired' ? 'the helper keeps one for ten minutes'
    : answer.state === 'down' ? 'the site did not answer' : 'the helper’s answer could not be read';
  return `${lead}: ${why}. Reload it, then try again.`;
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
      await run(call('layerSet', { tags: res.tags, texts: r.design ? res.texts : [], on: r.design }), 0);
      if (r.design) {
        const css = compileLayer(r.edits, []);
        if (css) await page.wc.insertCSS(css, { cssOrigin: 'user' });
      }
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
  /** The helper's save of words to a plain text field, as the view's user (live-view.ts). */
  helperSave: (field: string, before: string, after: string) => Promise<HelperSaved | null>;
  /**
   * The window's save of a `via: 'schema'` edit target, as the view's user (live-inspect.ts schemaSave): the target by
   * its id in the trace the view holds, refused unless that is still the trace `trace` names.
   */
  schemaSave: (target: string, value: unknown, trace: string) => Promise<LiveEditSaved>;
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
  /** The one stylesheet the layer injected into the view's page, by the page's webContents. */
  let sheet: { wc: number; key: string } | null = null;
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

  /** Replace the layer's one stylesheet on a page: the new one in before the old one goes, so nothing flickers. */
  const replaceSheet = async (wc: WebContents, css: string): Promise<void> => {
    const old = sheet && sheet.wc === wc.id ? sheet.key : null;
    sheet = null;
    // The user origin: its !important outranks every page declaration, a layered !important included (an author
    // sheet from insertCSS comes before the page's and loses ties: docs/research/2026-10-09-design-layer-probes.md).
    if (css) sheet = { wc: wc.id, key: await wc.insertCSS(css, { cssOrigin: 'user' }) };
    if (old) await wc.removeInsertedCSS(old).catch(() => {});
  };

  const applyNow = async (): Promise<LayerApplied> => {
    const here = shown();
    if (!here) return { page: '', shown: [], orphaned: [], elsewhere: [], off: !on };
    const { cur, url, path } = here;
    const snap = await snapshotOf(cur.projectId);
    const answer = await options.trace();
    const res = await resolveLayer(options.run, answer.state === 'ok' ? answer.trace : null, snap.edits, path);
    const now = effective(snap.edits, res);
    await options.run(call('layerSet', { tags: res.tags, texts: on ? res.texts : [], on }), 0);
    // A page that went away meanwhile has its own load, and is applied then.
    if (cur.webContents.isDestroyed() || cur.webContents.getURL() !== url) return { page: path, shown: [], orphaned: [], elsewhere: [], off: !on };
    // Phase 1 passes no breakpoints: an edit for a named one is left out, not guessed.
    await replaceSheet(cur.webContents, on ? compileLayer(now, []) : '');
    // The core is told what this page found: lost edits are orphaned, found ones are drafts again.
    const was = new Map(snap.edits.map((e) => [e.id, e.state]));
    for (const o of res.orphaned) if (was.get(o.id) !== 'orphaned') await mark(cur.projectId, o.id, 'orphaned');
    for (const id of res.resolved) if (was.get(id) === 'orphaned') await mark(cur.projectId, id, 'draft');
    return { page: path, shown: on ? res.shown : [], orphaned: res.orphaned, elsewhere: res.elsewhere, off: !on };
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
    if (at.words.length > SAVE_MAX || value.length > SAVE_MAX) return none(`Words longer than ${SAVE_MAX.toLocaleString('en')} characters are saved in the site’s own form.`);
    if (typeof at.field === 'string') {
      // A plain text field the helper marked around the words (Drupal): its own save, with the words it had.
      const saved = await options.helperSave(at.field, at.words, value);
      if (!saved) return none('The live view has no helper for this site.');
      if (!saved.ok) return none(saved.error ?? 'The site did not save it.');
      await core('live.layerMark', { projectId: cur.projectId, id, state: 'implemented' });
      // The site now has the words: the page shows them as it renders them, and the layer applies again after the load.
      if (!here.cur.webContents.isDestroyed()) here.cur.webContents.reloadIgnoringCache();
      return { ok: true, id, state: 'implemented', revision: saved.revision ?? null };
    }
    // No field marked around them (WordPress's helper marks none): the edit target in the page's trace that holds
    // exactly these words, saved as the window saves one.
    if (!edit.target.part) return none('Its element is in markup no part of the page’s trace names, so Wanigan cannot tell what holds these words.');
    const answer = await options.trace();
    if (answer.state !== 'ok') return none(untraced(answer));
    const found = wordsTarget(answer.trace, edit.target.part, at.words);
    if (!found.ok) return { ok: false, id, route: found.route, why: found.why };
    // An object's other properties go back as the trace gave them (a menu link's address with its new text).
    const next = found.key === null ? value : { ...(found.target.value as Record<string, unknown>), [found.key]: value };
    // The save reloads the page once the site has the words; the layer applies again after the load.
    const saved = await options.schemaSave(found.target.id, next, answer.trace.id);
    if (!saved.ok) return none(saved.error ?? 'The site did not save it.');
    await core('live.layerMark', { projectId: cur.projectId, id, state: 'implemented' });
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
    const images: { width: number; design: Buffer; result: Buffer; diff: Buffer }[] = [];
    for (const width of widths) {
      const first = await ask(width, false);
      if ('error' in first) throw new Error(first.error);
      const second = await ask(width, false);
      if ('error' in second) throw new Error(second.error);
      const design = await ask(width, true);
      if ('error' in design) throw new Error(design.error);
      const noise = noiseFloor(first.bitmap, second.bitmap);
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
      images.push({ width, design: design.png, result: first.png, diff: d.pixels ? await encode(diffPicture(first.bitmap, d, noise)) : Buffer.alloc(0) });
    }
    const outcome = judge(found);
    const base: Omit<LayerVerdict, 'pictures'> = {
      at: clock(), ok: outcome.ok, failed: outcome.failed, widths, noise: verdictNoise(found), differences: outcome.differences.slice(0, MAX_DIFFERENCES),
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
    // The core is told: verified, or back to draft with the verdict for the edits it is about; the rest keep it.
    const back = new Set(editsAt(base, edits.map((e) => e.id)));
    for (const e of edits) {
      const v = verdicts.get(e.id) as LayerVerdict;
      await mark(projectId, e.id, base.ok ? 'verified' : back.has(e.id) ? 'draft' : 'implemented', v);
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
