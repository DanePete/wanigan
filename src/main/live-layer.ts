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
//   is resolved by identity, and nothing is called orphaned for it. Edits for a named breakpoint are left out whole
//   (not tagged, their words not patched): phase 1 does not read the theme's breakpoints, and a verification fails
//   them as not verifiable yet.
// - Implementing: only words, saved where they are kept, as the user logged in in the view. Where the helper marks a
//   text field around them (Drupal's `data-wl-field`: a plain value, or one run of words inside formatted text, which
//   the helper splices and checks through the text's own format), through `POST /_wanigan/save`, the window's own
//   helperSave path, to exactly the content, translation and item the edit's target names (saveTarget): never the
//   default language, never the first item that holds the same words; a save the helper answers with a confirm token
//   (words in a Drupal default layout every entity of a bundle shares, said with how far it reaches) is made when the
//   edit is made real again, with that token. Otherwise through the one edit target of the page's trace that holds
//   exactly those words (wordsTarget(): a title, an excerpt, a string meta, a setting, a menu link's text, a
//   WordPress block's rich text, a Drupal block's title or a run of a view's words), saved by the window's own schema
//   save (`POST /_wanigan/edit/<id>`, live-edit-save.ts): how WordPress's helper saves a field, and both helpers save
//   configuration. A value its schema calls HTML (`contentMediaType: 'text/html'`) is sent as HTML: words alone
//   escaped (`&`, `<`, `>` and quotes as the helper writes text), words between tags written into the one run the
//   change falls in, every tag kept (src/shared/rich-text.ts). Words for something the helper says shows beyond this
//   page (a target's `shows`: a template, a synced pattern, a menu, a widget, a setting) are said with where, and
//   saved only when the edit is made real again. A change across formatting, a post's content and markup nothing says
//   how to write go to an agent as a brief, as do styles and tokens; on Drupal, words nothing holds are said as what
//   they are (writtenIn(): written in a template, which an agent changes, or printed through t()); anything else says
//   why.
// - Keeping the page as it was: just before words are saved, and when a style, a token or formatted words are handed
//   to an agent, the page the edit is on is rendered at the verification widths through the same hidden render,
//   without the layer and then, in the same load, with that one edit as designed on it, and kept under the edit's
//   folder (live-layer/<project>/<edit>/before/: both pictures, the touched elements, the masks, the hold).
// - Verifying ("Stage 3: verify", steps 1–3): the design (the page with the layer) and the result (the page without
//   it) rendered in hidden windows in the view's session at each width (live-capture.ts), each twice for the noise
//   floor, and every width judged against the one floor the verdict states (the largest over both and every width);
//   the comparisons are src/shared/layer-verify.ts's. Every render is sent one hold (X-Wanigan-Steady: a time and a
//   seed, the edit's page from before's when it has one), and the site's helper, for that token request only, renders
//   "3 days ago" against that time and random orders by that seed, and says so. What the site says changes between
//   renders anyway is left out of every pixel comparison (masks: the parts a Drupal trace says are built late, never
//   cached, kept for a while or made per user or session, innermost first; the blocks the WordPress helper marked by
//   type), never an edited element, and named in the verdict; the floor is measured over what is left.
//   Nothing passes for want of a comparison: an edit found but not there when measured, a token whose custom
//   property was not read on the root, or an edit for a named breakpoint fails, saying why. A page is compared down
//   to VERIFY_MAX_HEIGHT, and where it went on the verdict says how far (its `cut`), passing or not.
//   Step 3 compares the result with the design rendered now, and with each edit's page from before, with that edit
//   as designed on it: a change the native implementation made beyond the touched elements is in both of today's
//   renders, and only that page shows it was not there (seen in Electron on a made-up page: a rule that also turned
//   every paragraph blue passed against the design alone). Against that page it is element by element, since the save
//   may rightly change the layout there (the breadcrumb showing the same title wraps and moves the page down, seen on
//   both demos): each element outside the touched ones matched by its path, its words and computed values compared
//   wherever it sits, the edit's old words become its new ones elsewhere said as the save's reach (`reach`), anything
//   else named by its element, and pixels only inside what kept its place. Where there is no page from before (made real elsewhere),
//   or another edit was made real on the page since, the verdict says step 3 could not run against it, and why.
//   Pictures are kept in the data folder under live-layer/<project>/<edit>/, and the core is told: verified, or still
//   implemented with the failed verdict (its words are in the site; the verdict says what differs).
// - Nothing here writes to the site except the helper save, and nothing reaches any origin but the site's own.
import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import {
  LAYER_PROPERTIES, compileLayer, layerEdit, layerTextHash,
  type LayerApplied, type LayerBeforeCheck, type LayerCut, type LayerEdit, type LayerImplemented, type LayerPickTarget, type LayerRect, type LayerSnapshot,
  type LayerTarget, type LayerVerdict,
} from '../shared/design-layer.ts';
import {
  MAX_DIFFERENCES, OUTSIDE_PROPERTIES, VERIFY_WIDTHS, against, applyMask, compareElements, compareOutside, comparePixels, compareTokens, diffBitmaps, diffPicture,
  heldAlike, judge, maskedOf, masksAmong, noiseFloor, onlyWhere, reachOf, traceMasks, unionDiff, varyWhy, verdictNoise, verifyWidths, widestNoise, zonesOf,
  type Bitmap, type ElementSnap, type PageSnap, type PixelArea, type PixelDiff, type RenderMask, type Steady, type WidthFindings, type Zone,
} from '../shared/layer-verify.ts';
import type { LiveEditSaved, LiveTraceAnswer } from '../shared/live-lens.ts';
import { fragileWhy, kindWords } from '../shared/layer-words.ts';
import { TRACE_ID, identityKey, kindKey, type EditTarget, type LiveTrace, type PartIdentity, type TracePart } from '../shared/live-trace.ts';
import { MARKUP, asWords, decodeRefs, retypeRich } from '../shared/rich-text.ts';
import { sameSite, type LiveSite } from '../shared/live.ts';
import type { Method } from '../shared/protocol.ts';
import { RENDER_MS, deadline, folderOf, inHiddenWindow, type HiddenPage } from './live-capture.ts';
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
    // Phase 1 reads no breakpoints: an edit for a named one is left out whole (its styles are not in the sheet, so its
    // words are not patched either), never shown at every width.
    if (e.breakpoint !== 'all') continue;
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
 * around its element (`type:id:field:fieldtype[:langcode:revision:changed:formatter]`) is checked to be that field. Anything else is why not:
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

/* ── which edit target holds an element's words ─────────────────────────── */

/**
 * The edit target to save new words to, where in its value they go (a property of an object, or the value), and what
 * goes there: the new words as they are, or, in formatted text, as HTML (escaped, its tags kept); or why there is none.
 */
export type WordsTarget =
  | { ok: true; target: EditTarget; key: string | null; value: string }
  | { ok: false; route: 'agent' | 'none'; why: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A schema's one type; a nullable `["string", "null"]` counts as its real one (as live-schema.ts reads it). */
function typeOf(s: Record<string, unknown>): string | null {
  if (typeof s.type === 'string') return s.type;
  const real = Array.isArray(s.type) ? s.type.filter((t) => t !== 'null') : [];
  return real.length === 1 && typeof real[0] === 'string' ? real[0] : null;
}

/** A tag, or a comment: a value holding one is formatted text, and its words are only part of what it keeps. */
const TAG = MARKUP;
const TAGS = new RegExp(TAG.source, 'gi');
/**
 * A kept value as the page shows it: its tags taken out, its character references read (WordPress keeps `&` in a
 * title as `&amp;`). Compared as words with asWords() (src/shared/rich-text.ts): whitespace folded, and the typography
 * a site prints a value with (wptexturize's quotes, dashes and ellipsis) read as typed.
 */
const shownOf = (value: string): string => decodeRefs(value.replace(TAGS, ''));

/**
 * Where in one target words are, and how they are kept: as words (`plain`), as HTML the schema says it is
 * (`html`: `contentMediaType: 'text/html'`, saved escaped, or between its tags), or as markup nothing says how to
 * write (`formatted`).
 */
interface Holding { target: EditTarget; key: string | null; kept: 'plain' | 'html' | 'formatted'; value: string }

/**
 * Where a schema target holds exactly these words: its value (a string schema), or a string property of its value (an
 * object schema: a menu link's text, a widget's title). Only words count: a slug or a status (`property`), a template's
 * name, a choice, an address or a date (a `format`), a read-only value are never words to save into. A string the
 * schema calls HTML (`contentMediaType: 'text/html'`, or a block attribute of type `rich-text`) is found as `html`; a
 * block's other text (`block-attributes`, unless its schema says `text/plain`) and a value holding a tag are found as
 * `formatted`, so the refusal can say so.
 */
function holdings(t: EditTarget, want: string): Holding[] {
  if (t.via !== 'schema' || t.kind === 'property' || t.kind === 'template-override') return [];
  const rich = t.kind === 'block-attributes';
  const one = (schema: unknown, value: unknown, key: string | null): Holding[] => {
    if (typeof value !== 'string' || !isObj(schema) || asWords(shownOf(value)) !== want) return [];
    const type = typeOf(schema);
    const writable = schema.readOnly !== true && schema.enum === undefined && schema.oneOf === undefined && schema.const === undefined;
    if ((schema.contentMediaType === 'text/html' || type === 'rich-text') && writable) return [{ target: t, key, kept: 'html', value }];
    const plainText = schema.contentMediaType === 'text/plain' && !TAG.test(value);
    if ((rich && !plainText) || type === 'rich-text' || TAG.test(value)) return [{ target: t, key, kept: 'formatted', value }];
    const words = type === 'string' && writable && (schema.format === undefined || schema.format === 'textarea');
    return words ? [{ target: t, key, kept: 'plain', value }] : [];
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

/** What a refusal adds when what holds the words shows beyond this page: where (the helper's `shows`). */
const beyond = (t: EditTarget): string => (t.shows ? ` Saved there, they would change it wherever it shows (${t.shows}).` : '');

/**
 * The one edit target of a trace that holds exactly an element's words, as the site rendered them, for saving new
 * words to: looked for in the parts the edit's identity names (as resolveLayer matches them), then outward a level at a
 * time, and the nearest level with any finding decides. Outward is each part's parent, and the post a block shows
 * through its context: a post-title block shows its post's title, inside the post or wherever the template put it,
 * and that post's parts carry the title's target. A post's content reached only as what the element sits in means
 * the words are content. One finding is the answer, with what to send for `after` (the new words): words as they are;
 * HTML that is words alone, the new words escaped as the helper writes text; HTML with tags, the new words written
 * into the one run between tags the change falls in (retypeRich(), src/shared/rich-text.ts); with no `after`, the words
 * as they are (only finding what holds them). None, several, markup nothing says how to write, a change across
 * formatting, or a target the site says cannot be changed here is refused with why.
 */
export function wordsTarget(trace: LiveTrace, identity: PartIdentity, words: string, after: string = words): WordsTarget {
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
    if (h?.kept === 'formatted') {
      return { ok: false, route: 'agent', why: `These words are formatted text (${h.target.label}): the site keeps them with their markup, which Wanigan does not save from here. An agent can make the change from a brief.${beyond(h.target)}` };
    }
    if (h?.target.why) return { ok: false, route: 'none', why: h.target.why };
    if (h?.kept === 'html') {
      // Words alone go escaped (& < > and quotes as the helper writes them); between tags, only within one run.
      const written = retypeRich(h.value, words, after);
      if (!written.ok) {
        return { ok: false, route: 'agent', why: `These words are formatted text (${h.target.label}) and the change ${written.why}: Wanigan saves new words between tags only where the change falls within one run of words. An agent can make the change from a brief.${beyond(h.target)}` };
      }
      return { ok: true, target: h.target, key: h.key, value: written.html };
    }
    if (h) return { ok: true, target: h.target, key: h.key, value: after };
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
  return { ok: false, route: 'none', why: NOTHING_HOLDS };
}

/** wordsTarget()'s answer when no target of the trace holds the words. */
const NOTHING_HOLDS = 'Nothing this page offers to edit holds exactly these words, so there is nothing here to save them to: they come from a template, from formatted text, or from something the site helper does not offer on this page.';

/**
 * Drupal: the target that says a template around an element writes exactly its words (the helper's TemplateWords:
 * `words.tpl.<hash>` for words typed into it, `words.t.<hash>` for strings it prints through t()), looked for in the
 * parts the edit's identity names, then each one's parent; null when none does. Such a target is never saved: it says
 * why not.
 */
export function writtenIn(trace: LiveTrace, identity: PartIdentity, words: string): EditTarget | null {
  const want = asWords(words);
  const targets = new Map(trace.edits.map((e) => [e.id, e]));
  const byId = new Map(trace.parts.map((p) => [p.id, p]));
  const key = identityKey(identity);
  let level = trace.parts.filter((p) => p.identity && identityKey(p.identity) === key);
  const seen = new Set(level.map((p) => p.id));
  for (let depth = 0; level.length && depth < 64; depth++) {
    for (const p of level) {
      for (const id of p.edits ?? []) {
        const t = targets.get(id);
        if (t && /^words\.(?:tpl|t)\./.test(t.id) && isObj(t.value) && Object.values(t.value).some((v) => typeof v === 'string' && asWords(v) === want)) return t;
      }
    }
    level = level.flatMap((p) => {
      const up = p.parent ? byId.get(p.parent) : undefined;
      if (!up || seen.has(up.id)) return [];
      seen.add(up.id);
      return [up];
    });
  }
  return null;
}

/** On Drupal, words no target holds and no template around them writes: made by code from what Wanigan does not save yet. */
const DRUPAL_NOTHING_HOLDS = 'Nothing this page offers to edit holds exactly these words, and Wanigan finds them written in no template around them: code makes them (a formatter, a module or the theme) from something Wanigan does not save from here yet.';

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
  /** Read the whole page element by element too (layerPage): what step 3 compares with a page from before. */
  whole?: boolean;
  /**
   * The hold sent with the page's request (X-Wanigan-Steady): the time the site's helper renders it as at, and the seed
   * of its random orders, so every render a verdict compares shows the same "3 days ago" and the same order. Only the
   * helper acts on it, and only for a request with the view's token.
   */
  hold: Hold | null;
}

/** A hold: a time in whole seconds, never later than now (the helpers refuse a later one), and a seed. */
export interface Hold { t: number; s: number }

export interface LayerRendered {
  png: Buffer;
  bitmap: Bitmap;
  /** Every tagged element of the edits, as layerSnap read it. */
  elements: ElementSnap[];
  /** The edits that found their elements in this render. */
  found: string[];
  /** The token edits' custom properties as the page's root computes them, by name; a name missing was not read. */
  tokens?: Record<string, string>;
  /** The page went on below the capture limit (VERIFY_MAX_HEIGHT): how tall it is. Nothing below the limit is compared. */
  cut?: { full: number } | null;
  /** What this render leaves out of the pixel steps: the parts its trace says change between renders, and the blocks its helper marked. */
  masks?: RenderMask[];
  /** The hold, as the site's helper confirmed it held this render; null or absent when it did not. */
  steady?: Steady | null;
  /** The whole page element by element, when asked (`whole`) and the page script answered. */
  page?: PageSnap | null;
}

/** A page read whole for step 3 holds at most this many elements; past it, what was read is compared. */
const PAGE_MAX = 8_000;

/** A page read whole, in the shape the page script answers it: how it is kept with a page from before, and read back through pageOf. */
const pageRaw = (p: PageSnap): unknown => ({
  keys: p.keys, table: p.table, cut: p.cut,
  elements: p.elements.map((e) => ({ p: e.path, n: e.name, b: [e.box.x, e.box.y, e.box.width, e.box.height], t: e.text, v: e.values, e: e.touched })),
});

/** What the page script's layerPage answered, checked; null when it is not one. */
export function pageOf(raw: unknown): PageSnap | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.keys) || !Array.isArray(r.table) || !Array.isArray(r.elements)) return null;
  const keys = (r.keys as unknown[]).slice(0, 60).filter((k): k is string => typeof k === 'string' && /^[a-z-]{1,40}$/.test(k));
  const table = (r.table as unknown[]).slice(0, 200_000).map((v) => (typeof v === 'string' ? v.slice(0, 500) : ''));
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1_000_000 ? v : 0);
  const elements: PageSnap['elements'] = [];
  for (const raw2 of (r.elements as unknown[]).slice(0, 20_000)) {
    const e = raw2 && typeof raw2 === 'object' ? raw2 as Record<string, unknown> : null;
    if (!e || typeof e.p !== 'string' || e.p.length > 4_000 || !e.p.startsWith('body') || !Array.isArray(e.b) || !Array.isArray(e.v)) continue;
    const [x, y, width, height] = (e.b as unknown[]).map(num);
    elements.push({
      path: e.p, name: typeof e.n === 'string' ? e.n.slice(0, 200) : 'element', box: { x: x ?? 0, y: y ?? 0, width: width ?? 0, height: height ?? 0 },
      text: typeof e.t === 'string' ? e.t.slice(0, 2_000) : null, values: (e.v as unknown[]).slice(0, keys.length).map((i) => (Number.isInteger(i) ? i as number : -1)), touched: e.e === true,
    });
  }
  return { keys, table, elements, cut: r.cut === true };
}

export type LayerRender = (r: LayerRenderRequest) => Promise<LayerRendered | { error: string }>;

/**
 * The page as it was, kept just before an edit is made real: one load of the page at a width, pictured without the
 * layer (`page`), then with the one edit as designed on it (`design`), in that same load.
 */
export interface LayerBeforeRendered { page: LayerRendered; design: LayerRendered }
export type LayerBeforeRender = (r: LayerRenderRequest) => Promise<LayerBeforeRendered | { error: string }>;

/** The header a verification's renders carry, and the helpers answer with what they held. */
const STEADY_HEADER = 'X-Wanigan-Steady';

/** The helper's answer to a hold, checked: only the hold that was sent, with the Drupal views it seeded. */
export function steadyOf(header: string | null | undefined, hold: Hold | null): Steady | null {
  if (!hold || typeof header !== 'string') return null;
  const m = /^t=(\d{1,12});s=(\d{1,9})(?:;views=([a-z0-9_:,]{0,2000}))?$/.exec(header.trim());
  if (!m || Number(m[1]) !== hold.t || Number(m[2]) !== hold.s) return null;
  const views = (m[3] ?? '').split(',').filter((v) => /^[a-z0-9_]{1,128}:[a-z0-9_]{1,128}$/.test(v)).slice(0, 100);
  return { t: hold.t, s: hold.s, views };
}

/** What the page script's layerAreas answered, checked: each part's boxes, and the blocks a helper marked as changing between renders. */
export function areasOf(raw: unknown): { parts: Record<string, LayerRect[]>; vary: { reason: string; held: boolean; name: string | null; box: LayerRect }[] } {
  const out: ReturnType<typeof areasOf> = { parts: {}, vary: [] };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1_000_000 ? Math.round(v * 100) / 100 : null);
  const box = (v: unknown): LayerRect | null => {
    if (!v || typeof v !== 'object') return null;
    const b = v as Record<string, unknown>;
    const [x, y, width, height] = [num(b.x), num(b.y), num(b.width), num(b.height)];
    return x !== null && y !== null && width !== null && height !== null && width > 0 && height > 0 ? { x, y, width, height } : null;
  };
  if (r.parts && typeof r.parts === 'object') {
    for (const [id, rects] of Object.entries(r.parts as Record<string, unknown>).slice(0, 5_000)) {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || !Array.isArray(rects)) continue;
      const boxes = rects.slice(0, 50).map(box).filter((b): b is LayerRect => b !== null);
      if (boxes.length) out.parts[id] = boxes;
    }
  }
  if (Array.isArray(r.vary)) {
    for (const v of r.vary.slice(0, 500)) {
      if (!v || typeof v !== 'object') continue;
      const m = v as Record<string, unknown>;
      const b = box(m.box);
      if (!b || typeof m.reason !== 'string' || !/^[a-z][a-z-]{0,39}$/.test(m.reason)) continue;
      const name = typeof m.name === 'string' && /^[a-z0-9-]{1,50}\/[a-z0-9-]{1,50}(?::[A-Za-z0-9_-]{1,80})?$/.test(m.name) ? m.name : null;
      out.vary.push({ reason: m.reason, held: typeof m.held === 'string' && m.held !== '', name, box: b });
    }
  }
  return out;
}

/** A render's masks: the parts its trace says change between renders and the blocks its helper marked, by their boxes in this render. */
export function masksOf(trace: LiveTrace | null, steady: Steady | null, areas: ReturnType<typeof areasOf>): RenderMask[] {
  const masks: RenderMask[] = [];
  for (const m of trace ? traceMasks(trace, steady) : []) {
    const rects = areas.parts[m.part];
    if (rects?.length) masks.push({ label: m.label, why: m.why, rects, held: m.held });
  }
  for (const v of areas.vary) masks.push({ label: v.name ? `The ${v.name} block` : 'A block', why: varyWhy(v.reason), rects: [v.box], held: !!steady && v.held });
  return masks;
}

/** A token's name, as compileLayer prints it. */
const TOKEN_NAME = /^--[a-z0-9][a-z0-9-]{0,99}$/i;

/** The token edits' custom properties, as the page's root computes them: what the page answered, checked, for the names asked. */
export function tokensOf(raw: unknown, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const n of names) {
    const v = (raw as Record<string, unknown>)[n];
    if (typeof v === 'string') out[n] = v.trim().slice(0, 2_000);
  }
  return out;
}

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

/**
 * Why a render could not find its edits by identity, or null when it can: an edit keyed to a part needs this render's
 * own trace, and without one it would be called not found when it was never looked for.
 */
export function traceProblem(edits: readonly LayerEdit[], header: string | null, answer: LiveTraceAnswer | null): string | null {
  if (!edits.some((e) => e.target.part && e.breakpoint === 'all' && e.change.type !== 'token')) return null;
  if (answer?.state === 'ok') return null;
  const why = !header ? 'the page came without the helper’s trace (a cached copy, or a page the site’s platform did not render)'
    : !answer ? 'the trace could not be asked for'
      : answer.state === 'down' ? `the site did not answer for it (${answer.error.slice(0, 200)})`
        : answer.state === 'refused' ? `the helper refused it (${answer.status})`
          : answer.state === 'expired' ? 'the helper no longer kept it'
            : answer.state === 'other' ? 'the site’s helper answers to another Wanigan'
              : `the helper’s answer was not one Wanigan reads (${answer.state})`;
  return `This render could not read the page’s trace: ${why}. Its edits are found by what the trace names, so nothing was compared. Try again.`;
}

interface RenderDeps {
  pageScript: () => string | null;
  sessionFor: (projectId: string, url: string) => { fetch: SiteFetch } | null;
  askTrace: AskTrace;
  decode: (png: Buffer) => Promise<Bitmap>;
}

/**
 * A page in a hidden window (live-capture.ts), loaded with its own trace and the hold, the edits found and tagged, its
 * clock run and stopped, then handed to `take` to picture. Each picture is taken by `shot`.
 */
function onPage<T>(deps: RenderDeps, r: LayerRenderRequest, take: (page: HiddenPage, shot: Shot) => Promise<T | { error: string }>): Promise<T | { error: string }> {
  const headers: Record<string, string> = r.hold ? { [STEADY_HEADER]: `t=${r.hold.t};s=${r.hold.s}` } : {};
  return inHiddenWindow<T>(
    { partition: r.partition, url: r.url, base: r.base, width: r.width, network: true, freeze: true, headers, what: 'The page', failed: 'The page could not be rendered' },
    async (page) => {
      const script = deps.pageScript();
      if (!script) return { error: 'This build of Wanigan has no page script, so it cannot find the edits on a page.' };
      if (!sameSite(r.base, page.wc.getURL())) return { error: 'The page left the site; Wanigan does not follow it.' };
      // This render's own trace: identities are resolved against what the site rendered this time.
      const id = page.headers()?.['x-wanigan-trace'] ?? null;
      const ses = deps.sessionFor(r.projectId, r.base);
      const answer = id && TRACE_ID.test(id) && ses ? await deps.askTrace((u, init) => ses.fetch(u, init), new URL(page.wc.getURL()).origin, r.token, id) : null;
      // Without it no edit keyed to a part can be found, and that is said, never taken as the edit being gone.
      const unread = traceProblem(r.edits, id && TRACE_ID.test(id) ? id : null, answer);
      if (unread) return { error: unread };
      const trace = answer?.state === 'ok' ? answer.trace : null;
      const steady = steadyOf(page.headers()?.['x-wanigan-steady'], r.hold);
      await page.read(script, null, PAGE_WORLD);
      const run: Run = (code, fallback) => page.read(code, fallback, PAGE_WORLD);
      const res = await resolveLayer(run, trace, r.edits, r.path);
      const picture = async (whole: boolean): Promise<LayerRendered | { error: string }> => {
        const { height, cut, full } = await page.grow(VERIFY_MAX_HEIGHT);
        // The whole page element by element, for step 3: read before the picture, on the same layout.
        const snapshot = whole ? pageOf(await run<unknown>(call('layerPage', OUTSIDE_PROPERTIES, PAGE_MAX), null)) : undefined;
        const elements = snapsOf(await run<unknown>(call('layerSnap', r.edits.map((e) => e.id), LAYER_PROPERTIES), []));
        // Each token's custom property as the root computes it, in this render: what step 1 compares for a token.
        const names = [...new Set(r.edits.flatMap((e) => (e.change.type === 'token' && TOKEN_NAME.test(e.change.name) ? [e.change.name] : [])))];
        const tokens = names.length
          ? tokensOf(await run<unknown>(`(() => { const s = getComputedStyle(document.documentElement); const out = {}; for (const n of ${JSON.stringify(names)}) out[n] = s.getPropertyValue(n); return out; })()`, null), names)
          : {};
        // What the site says changes between renders, where it is in this render: left out of the pixel steps.
        const ids = trace ? traceMasks(trace, steady).map((m) => m.part) : [];
        const masks = masksOf(trace, steady, areasOf(await run<unknown>(call('layerAreas', ids), null)));
        const png = await page.shoot(height, true);
        if (!png) return { error: 'The page could not be pictured.' };
        return { png, bitmap: await deps.decode(png), elements, found: res.resolved, tokens, cut: cut ? { full } : null, masks, steady, ...(whole ? { page: snapshot ?? null } : {}) };
      };
      const show = async (on: boolean): Promise<void> => {
        if (on) {
          const css = compileLayer(r.edits, [], 'g1');
          if (css) await page.wc.insertCSS(css, { cssOrigin: 'user' });
        }
        await run(call('layerSet', { tags: res.tags, texts: on ? res.texts : [], on, gate: on ? 'g1' : null }), 0);
      };
      return take(page, async (on, after, whole) => {
        await show(on);
        if (after) await page.still(); else await page.freeze();
        return picture(!!whole && !!r.whole);
      });
    },
  );
}

/** Put the layer on (or not), let the page settle (`after`: a frozen page changed once more), and picture it, the page read whole too when asked (`whole`). */
type Shot = (on: boolean, after?: boolean, whole?: boolean) => Promise<LayerRendered | { error: string }>;

/** A render for a verification: the page with the design's layer on it, or without it. */
function renderInWindow(deps: RenderDeps): LayerRender {
  return (r) => onPage<LayerRendered>(deps, r, async (_page, shot) => shot(r.design, false, true));
}

/**
 * The page as it was, for an edit about to be made real: pictured without the layer, then, in the same load and on
 * the same stopped clock, with the edit as designed on it. The second is what step 3 compares the result with later,
 * outside the touched elements: it has the edit's own reflow and reach, so only what the native change did beyond
 * them differs.
 */
function renderBeforeInWindow(deps: RenderDeps): LayerBeforeRender {
  return (r) => onPage<LayerBeforeRendered>(deps, r, async (_page, shot) => {
    const page = await shot(false);
    if ('error' in page) return page;
    // The page with the edit designed on it is what step 3 compares, element by element: read whole.
    const design = await shot(true, true, true);
    if ('error' in design) return design;
    return { page, design };
  });
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
  /**
   * Test seams: what renders a page for a verification (and how long one may take), what keeps the page as it was
   * before an edit is made real, how a PNG becomes pixels and a difference picture a PNG, the clock, and the seed of a
   * hold.
   */
  render?: LayerRender;
  renderBefore?: LayerBeforeRender;
  renderMs?: number;
  decode?: (png: Buffer) => Promise<Bitmap>;
  encode?: (b: Bitmap) => Promise<Buffer>;
  now?: () => number;
  seed?: () => number;
}

/* ── the page as it was, kept with an edit ──────────────────────────────── */

/** What is kept beside an edit's pictures of the page as it was (before/meta.json under its folder). */
export interface BeforeKept {
  /** When it was rendered (milliseconds). */
  at: number;
  page: string;
  /** The hold its renders were sent with; a verification of the edit renders with the same one. */
  hold: Hold;
  /** The edits already in the site then that reach its page: an edit made real since is not in that page. */
  inSite: string[];
  /** Per width rendered: the touched elements and masks of the page with the edit designed on it, the helper's hold as confirmed, how tall a page that went on was. */
  widths: Record<string, { found: boolean; elements: ElementSnap[]; masks: RenderMask[]; steady: Steady | null; cut: number | null; whole: boolean }>;
  /** Per width that could not be rendered: why. */
  failed: Record<string, string>;
}

const rectOf = (v: unknown): LayerRect | null => {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1_000_000;
  return ok(r.x) && ok(r.y) && ok(r.width) && ok(r.height) ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
};

/** before/meta.json as written, checked: it lives in the data folder, and anything that is not what was written is no page from before. */
export function beforeKept(raw: unknown): BeforeKept | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const hold = m.hold && typeof m.hold === 'object' ? m.hold as Record<string, unknown> : null;
  if (typeof m.at !== 'number' || !Number.isFinite(m.at) || typeof m.page !== 'string' || !m.page.startsWith('/') || m.page.length > 2_000) return null;
  if (!hold || !Number.isInteger(hold.t) || !Number.isInteger(hold.s)) return null;
  if (!Array.isArray(m.inSite) || !m.inSite.every((id) => typeof id === 'string' && EDIT_ID.test(id))) return null;
  const widths: BeforeKept['widths'] = {};
  for (const [w, v] of Object.entries(m.widths && typeof m.widths === 'object' ? m.widths as Record<string, unknown> : {}).slice(0, 8)) {
    if (!/^\d{3,4}$/.test(w) || !v || typeof v !== 'object') return null;
    const x = v as Record<string, unknown>;
    const masks: RenderMask[] = (Array.isArray(x.masks) ? x.masks as unknown[] : []).slice(0, 5_000).flatMap((raw2) => {
      const k = raw2 && typeof raw2 === 'object' ? raw2 as Record<string, unknown> : null;
      if (!k || typeof k.label !== 'string' || typeof k.why !== 'string' || !Array.isArray(k.rects)) return [];
      const rects = (k.rects as unknown[]).slice(0, 50).map(rectOf).filter((r): r is LayerRect => r !== null);
      return [{ label: k.label.slice(0, 200), why: k.why.slice(0, 300), rects, held: k.held === true }];
    });
    const st = x.steady && typeof x.steady === 'object' ? x.steady as Record<string, unknown> : null;
    const steady = st && st.t === hold.t && st.s === hold.s && Array.isArray(st.views)
      ? { t: hold.t as number, s: hold.s as number, views: (st.views as unknown[]).filter((y): y is string => typeof y === 'string').slice(0, 100) } : null;
    widths[w] = { found: x.found === true, elements: snapsOf(x.elements), masks, steady, cut: Number.isInteger(x.cut) ? x.cut as number : null, whole: x.whole === true };
  }
  const failed: Record<string, string> = {};
  for (const [w, why] of Object.entries(m.failed && typeof m.failed === 'object' ? m.failed as Record<string, unknown> : {}).slice(0, 8)) if (/^\d{3,4}$/.test(w) && typeof why === 'string') failed[w] = why.slice(0, 500);
  return { at: m.at, page: m.page, hold: { t: hold.t as number, s: hold.s as number }, inSite: m.inSite as string[], widths, failed };
}

/** Whether an edit reaches the page at `path`: one made on it, or one for every instance or the whole site. */
const reaches = (e: LayerEdit, path: string): boolean => e.scope !== 'this' || madeOn(e, path);
/** In the site: what a page from before shows, or does not, of an edit. */
const inSite = (e: LayerEdit): boolean => e.state === 'implemented' || e.state === 'verified';

/**
 * Whether step 3 can compare an edit's result with its page from before, at which widths, or why not. `later`: edits
 * made real on that page since it was kept, which it does not show; the change one of them made (and the reflow below
 * it) would be called a leak of this edit, so none may have been.
 */
export function beforeCheck(edit: LayerEdit, kept: BeforeKept | null, widths: readonly number[], all: readonly LayerEdit[]): LayerBeforeCheck {
  const check = whyBefore(edit, kept, widths, all);
  // Within what a verdict may say (parseVerdict), however long the labels it names.
  return check.ran ? check : { ran: false, why: check.why.length > 600 ? `${check.why.slice(0, 599)}…` : check.why };
}

function whyBefore(edit: LayerEdit, kept: BeforeKept | null, widths: readonly number[], all: readonly LayerEdit[]): LayerBeforeCheck {
  if (!kept) {
    return { ran: false, why: 'No page from before was kept for it: it was made real some other way than Make it real here (in a template, or marked by an agent), or before Wanigan kept one. The rest of the page was compared with the design only.' };
  }
  const since = all.filter((x) => x.id !== edit.id && inSite(x) && reaches(x, kept.page) && !kept.inSite.includes(x.id));
  if (since.length) {
    const names = since.slice(0, 3).map((x) => `“${x.label}”`).join(', ');
    return { ran: false, why: `${names} ${since.length === 1 ? 'was' : 'were'} made real on its page after its page from before was kept, so that page does not show only this edit’s change. Verify each edit before making the next one on a page real, and step 3 compares it with the page before.` };
  }
  const usable = widths.filter((w) => kept.widths[String(w)]?.found && kept.widths[String(w)]?.whole);
  if (usable.length) return { ran: true, at: kept.at, widths: usable };
  if (widths.some((w) => kept.widths[String(w)]?.found)) {
    return { ran: false, why: 'Its page from before was kept by an earlier Wanigan, without the page element by element, which step 3 now compares. The rest of the page was compared with the design only.' };
  }
  const failed = Object.values(kept.failed)[0];
  if (failed) return { ran: false, why: `Its page from before could not be rendered when it was made real: ${failed}` };
  if (Object.values(kept.widths).some((x) => !x.found)) return { ran: false, why: 'Its element was not on its page from before, so that page could not show it as designed.' };
  return { ran: false, why: `Its page from before was kept at ${Object.keys(kept.widths).join(' and ')} px, not at the widths verified.` };
}

export function wireLiveLayer(options: LiveLayerOptions): { hooks: LiveViewHooks; apply(): Promise<LayerApplied> } {
  const { ipc } = options;
  const clock = options.now ?? Date.now;
  const deps: RenderDeps = { pageScript: options.pageScript, sessionFor: options.sessionFor, askTrace: options.askTrace, decode: options.decode ?? decodePng };
  const render = options.render ?? renderInWindow(deps);
  const renderBefore = options.renderBefore ?? renderBeforeInWindow(deps);
  const decode = options.decode ?? decodePng;
  const encode = options.encode ?? encodePng;
  const seed = options.seed ?? ((): number => randomInt(1, 1_000_000_000));
  const root = join(options.dataDir, 'live-layer');
  /** The layer is shown (layerShow); a load keeps the choice. */
  let on = true;
  /** The stylesheet the layer injected into the view's page last, by the page's webContents. */
  let sheet: { wc: number; key: string } | null = null;
  /** Each sheet's generation: the page's root names the one that holds (compileLayer's gate). */
  let generation = 0;
  /**
   * The helper's confirm tokens, by edit: a save it refused saying how far it reaches (words in a Drupal default layout
   * every entity of a bundle shares) is made when the edit is made real again, with the token that answer gave.
   */
  const confirms = new Map<string, string>();
  /** Applying, one at a time; and rendering for the layer, one at a time (verifying, and keeping a page from before: each loads whole pages in hidden windows). */
  let applying: Promise<unknown> = Promise.resolve();
  let verifying: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const next = verifying.then(work, work);
    verifying = next.catch(() => {});
    return next;
  };

  const ok = (event: IpcMainInvokeEvent): boolean => options.trusted(event) && options.enabled();
  const core = async <T>(method: Method, params: unknown): Promise<T> => (await options.client()).callRaw(method, params) as Promise<T>;
  const snapshotOf = (projectId: string): Promise<LayerSnapshot> => core<LayerSnapshot>('live.layer', { projectId });
  /** Tell the core what became of an edit: null once it is recorded, else why the core refused it. */
  const mark = async (projectId: string, id: string, state: LayerEdit['state'], verdict?: LayerVerdict): Promise<string | null> => {
    try {
      await core('live.layerMark', { projectId, id, state, ...(verdict ? { verdict } : {}) });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  /**
   * Take away the verification pictures of edits the layer no longer lists (discarded, undone, retired): nothing
   * shows them again. Only folders named as an edit is, under this project's own.
   */
  const sweep = (projectId: string, listed: readonly LayerEdit[]): void => {
    const dir = join(root, folderOf(projectId));
    const keep = new Set(listed.map((e) => e.id));
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) if (entry.isDirectory() && EDIT_ID.test(entry.name) && !keep.has(entry.name)) rmSync(join(dir, entry.name), { recursive: true, force: true });
  };

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
    sweep(cur.projectId, snap.edits);
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
    // edit is in the site whatever this load showed: it is said to the window, and stays implemented. A refusal here
    // (an edit undone meanwhile) is left: the next load finds what is listed then.
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
          // A WordPress block is named by its place: with no words to check, it is as fragile as a document path.
          kindLabel: key ? kindWords(keyed.part, key, keyed.inner ? human : null) : null, kindCount, before, fragile: fragileWhy(t, 'this') !== null,
        };
      }
    }
    if (typeof pick.selector !== 'string') return null;
    const t: LayerTarget = { part: null, inner: null, selector: pick.selector, textHash };
    return sound(t) ? { target: t, label: `${human} (no part names it)`, kindLabel: null, kindCount: 0, before, fragile: fragileWhy(t, 'this') !== null } : null;
  };

  /* ── making an edit real ── */

  /**
   * Words for something the helper says shows beyond this page (an edit target's `shows`): the first time, said with
   * where, and nothing saved; made real again within five minutes, for the same target, reach and words, saved. The
   * edit sheet asks the same way before it saves such a target (src/shared/live-trace.ts editNotice()).
   */
  const asked = new Map<string, { target: string; shows: string; value: string; until: number }>();
  const askBeyond = (id: string, found: Extract<WordsTarget, { ok: true }>): string | null => {
    const shows = found.target.shows;
    if (!shows) return null;
    const was = asked.get(id);
    asked.delete(id);
    if (was && was.target === found.target.id && was.shows === shows && was.value === found.value && was.until > clock()) return null;
    asked.set(id, { target: found.target.id, shows, value: found.value, until: clock() + 5 * 60_000 });
    return `These words are kept in ${found.target.label}: saving them changes it wherever it shows (${shows}), not only on this page. Make it real again to save them there.`;
  };

  /* ── the page as it was, kept just before an edit is made real ── */

  const editDir = (projectId: string, id: string): string => join(root, folderOf(projectId), id);
  const readKept = (projectId: string, id: string): BeforeKept | null => {
    try { return beforeKept(JSON.parse(readFileSync(join(editDir(projectId, id), 'before', 'meta.json'), 'utf8'))); } catch { return null; }
  };

  /**
   * Render the page an edit is on without the layer, then with the edit as designed on it, at the verification widths,
   * through the same hidden render a verification uses, held at one time and seed, and keep both pictures with the
   * edit's touched elements and masks under its folder (before/). Step 3 compares the result with it later. Kept
   * fresh each time for words (the save follows at once); once only for an edit handed to an agent, whose change
   * comes later, so asking again never takes a page that already has it. A render that fails is kept as why, and the
   * edit is made real all the same: its step 3 will say it could not run.
   */
  const keepBefore = (projectId: string, edit: LayerEdit, all: readonly LayerEdit[], fresh: boolean): Promise<void> => inTurn(async () => {
    const dir = join(editDir(projectId, edit.id), 'before');
    if (!fresh && readKept(projectId, edit.id)) return;
    let site: LiveSite;
    try { site = await core<LiveSite>('live.site', { projectId }); } catch { return; }
    if (!site.url || !site.token) return;
    const url = new URL(edit.page, new URL(site.url).origin).toString();
    if (!sameSite(site.url, url)) return;
    const partition = options.partition(projectId, site.url, site.token);
    const hold: Hold = { t: Math.floor(clock() / 1_000), s: seed() };
    const limit = options.renderMs ?? RENDER_MS + 60_000;
    const kept: BeforeKept = {
      at: clock(), page: edit.page, hold, widths: {}, failed: {},
      inSite: all.filter((x) => x.id !== edit.id && inSite(x) && reaches(x, edit.page)).map((x) => x.id),
    };
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const width of VERIFY_WIDTHS) {
      const got = await deadline<LayerBeforeRendered | { error: string }>(
        renderBefore({ projectId, partition, url, base: site.url, token: site.token, width, path: edit.page, edits: [{ ...edit, state: 'draft' }], design: true, hold, whole: true }), limit,
        () => ({ error: `The page did not render at ${width} px in time.` }),
      ).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
      if ('error' in got) { kept.failed[String(width)] = got.error.slice(0, 500); continue; }
      writeFileSync(join(dir, `${width}-page.png`), got.page.png, { mode: 0o600 });
      writeFileSync(join(dir, `${width}-design.png`), got.design.png, { mode: 0o600 });
      if (got.design.page) writeFileSync(join(dir, `${width}-elements.json`), JSON.stringify(pageRaw(got.design.page)), { mode: 0o600 });
      kept.widths[String(width)] = {
        whole: !!got.design.page,
        found: got.design.found.includes(edit.id) || edit.change.type === 'token', elements: got.design.elements,
        masks: [...(got.page.masks ?? []), ...(got.design.masks ?? [])], steady: got.design.steady ?? null, cut: got.design.cut?.full ?? null,
      };
    }
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(kept), { mode: 0o600 });
  });

  /** Words the site has, on an edit the core would not mark: said, so they are not saved twice. */
  const inSiteUnmarked = (revision: string | null, refused: string): string =>
    `The words are saved in the site${revision ? ` (revision ${revision})` : ''}, but the layer could not mark this edit implemented: ${refused} Do not save it again; it is in the site.`;

  const implement = async (raw: unknown): Promise<LayerImplemented> => {
    const id = typeof raw === 'string' && EDIT_ID.test(raw) ? raw : '';
    const none = (why: string): LayerImplemented => ({ ok: false, id, route: 'none', why });
    if (!id) return none('Which edit?');
    const cur = options.current();
    if (!cur) return none('The live view shows no site.');
    const all = (await snapshotOf(cur.projectId)).edits;
    const edit = all.find((e) => e.id === id);
    if (!edit) return none('That edit is not in the layer.');
    // Handed to an agent: the page as it is now is kept first (once), for step 3 to compare the agent's change with.
    const toAgent = async (why: string): Promise<LayerImplemented> => {
      if (edit.state === 'draft') await keepBefore(cur.projectId, edit, all, false);
      return { ok: false, id, route: 'agent', why };
    };
    if (edit.change.type === 'style' || edit.change.type === 'token') {
      return toAgent(edit.change.type === 'token'
        ? 'A token is the theme’s: changing it natively is a code change, which an agent makes from a brief, on your click.'
        : 'A style goes into the theme’s CSS: in phase 1 an agent makes it from a brief, on your click.');
    }
    if (edit.change.type !== 'text') return none('Only words and styles are made real from the layer so far.');
    if (edit.state === 'implemented' || edit.state === 'verified') return none('It is in the site already.');
    if (edit.state === 'orphaned') return none('Its element is not on its page any more, so there is nothing to save it to.');
    if (edit.state !== 'draft') return none(`It is ${edit.state}.`);
    if (edit.scope !== 'this') return none('Words are saved one element at a time: make this edit for one element, not every instance.');
    const value = edit.change.value;
    const here = shown();
    if (!here || here.cur.projectId !== cur.projectId || !madeOn(edit, here.path)) return none(`Open ${edit.page} in the live view first: words are saved from the page they are on.`);
    const at = await options.run<{ count?: unknown; field?: unknown; words?: unknown; plain?: unknown; same?: unknown } | null>(call('layerOf', id), null);
    if (!at || at.count === 0) return none('Its element is not tagged on this page. Reload the page, then try again.');
    // One stored thing shown more than once (one identity, every element the same plain words in the same field mark) is
    // saved once; elements a document path matched, or that differ, are refused.
    if (at.count !== 1 && !(edit.target.part && at.same === true)) return none(`It reaches ${String(at.count)} elements here; words are saved one element at a time.`);
    if (at.plain !== true || typeof at.words !== 'string') return none('Its element holds more than plain words, so they are not saved from here.');
    if (at.words.length > SAVE_MAX || value.length > SAVE_MAX) return none(`Words longer than ${SAVE_MAX.toLocaleString('en')} characters are saved in the site’s own form.`);
    if (typeof at.field === 'string') {
      // A text field the helper marked around the words (Drupal): exactly the field, translation and item the edit's
      // target names, never the first item that happens to hold the same words, never the default language.
      const where = saveTarget(edit.target.part, at.field);
      if (typeof where === 'string') return none(where);
      // The page as it is, kept just before the words are saved.
      await keepBefore(cur.projectId, edit, all, true);
      // Asked again after the site said how far it reaches: with the token it gave, so that save is made.
      const confirm = confirms.get(id);
      const saved = await options.helperSave(at.field, at.words, value, confirm ? { ...where, confirm } : where);
      if (!saved) return none('The live view has no helper for this site.');
      if (!saved.ok && saved.confirm) {
        confirms.set(id, saved.confirm);
        return none(`${saved.error ?? 'The site asks first.'} Make it real again to save it there.`);
      }
      confirms.delete(id);
      if (!saved.ok) return none(saved.error ?? 'The site did not save it.');
      const refused = await mark(cur.projectId, id, 'implemented');
      // The site now has the words, whatever the layer recorded: the page shows them as it renders them, and the layer
      // applies again after the load.
      if (!here.cur.webContents.isDestroyed()) here.cur.webContents.reloadIgnoringCache();
      if (refused) return none(inSiteUnmarked(saved.revision ?? null, refused));
      return { ok: true, id, state: 'implemented', revision: saved.revision ?? null };
    }
    // No field marked around them (WordPress's helper marks none): the edit target in the page's trace that holds
    // exactly these words, saved as the window saves one.
    if (!edit.target.part) return none('Its element is in markup no part of the page’s trace names, so Wanigan cannot tell what holds these words.');
    const answer = await options.trace();
    if (answer.state !== 'ok') return none(untraced(answer));
    const found = wordsTarget(answer.trace, edit.target.part, at.words, value);
    if (!found.ok && found.why === NOTHING_HOLDS && answer.trace.platform === 'drupal') {
      // Drupal: say which it is. Words a template writes are code (an agent changes the template), or an interface
      // translation Wanigan does not change yet; anything else is made by code from what is not saved here yet.
      const written = writtenIn(answer.trace, edit.target.part, at.words);
      if (written?.id.startsWith('words.tpl.')) return toAgent(written.why ?? DRUPAL_NOTHING_HOLDS);
      return { ok: false, id, route: 'none', why: written?.why ?? DRUPAL_NOTHING_HOLDS };
    }
    // Formatted words handed to an agent keep the page from before, as a style does.
    if (!found.ok) return found.route === 'agent' ? toAgent(found.why) : { ok: false, id, route: found.route, why: found.why };
    // Something shown beyond this page (a template, a synced pattern, a menu, a widget, a setting) is said first.
    const ask = askBeyond(id, found);
    if (ask) return none(ask);
    // An object's other properties go back as the trace gave them (a menu link's address with its new text).
    const next = found.key === null ? found.value : { ...(found.target.value as Record<string, unknown>), [found.key]: found.value };
    // The page as it is, kept just before the words are saved.
    await keepBefore(cur.projectId, edit, all, true);
    // The save reloads the page once the site has the words; the layer applies again after the load.
    const saved = await options.schemaSave(found.target.id, next, answer.trace.id);
    if (!saved.ok) return none(saved.error ?? 'The site did not save it.');
    const refused = await mark(cur.projectId, id, 'implemented');
    if (refused) return none(inSiteUnmarked(saved.revision ?? null, refused));
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
    sweep(projectId, snap.edits);
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
    // Each edit's page from before, and whether step 3 can compare with it. Every render is held at one time and
    // seed: the newest page from before's, so that page and today's show the same "3 days ago" and the same order.
    const kept = new Map(edits.map((e) => [e.id, readKept(projectId, e.id)]));
    const checks = new Map(edits.map((e) => [e.id, beforeCheck(e, kept.get(e.id) ?? null, widths, snap.edits)]));
    const newest = edits.filter((e) => checks.get(e.id)?.ran).map((e) => kept.get(e.id) as BeforeKept).sort((a, b) => b.at - a.at)[0];
    const hold: Hold = newest?.hold ?? { t: Math.floor(clock() / 1_000), s: seed() };
    // Each render has an end: one that never answers fails this verification, saying so, and the queue moves on (the
    // hidden window has deadlines of its own, and closes itself).
    const limit = options.renderMs ?? RENDER_MS + 60_000;
    const ask = (width: number, design: boolean, whole = false) => deadline<LayerRendered | { error: string }>(
      render({ projectId, partition, url, base: site.url as string, token: site.token as string, width, path: page, edits, design, hold, ...(whole ? { whole } : {}) }), limit,
      () => ({ error: `The page did not render at ${width} px within ${limit >= 1_000 ? `${Math.round(limit / 1_000)} seconds` : `${limit} ms`}, so the verification stopped there.` }),
    );

    const found: WidthFindings[] = [];
    const shots: { width: number; design: Buffer; result: Buffer; resultBitmap: Bitmap; d: PixelDiff }[] = [];
    /** How far down a page that went on was compared: said in the verdict whatever it decides. */
    const cut: LayerCut[] = [];
    /** What was left out at each width, for the verdict. */
    const leftOut: { width: number; masks: RenderMask[]; keep: LayerRect[] }[] = [];
    /** Where the saved words also changed, per edit and width: the save's reach, said in the verdict. */
    const reached: { edit: string; reach: { path: string; name: string }[] }[] = [];
    /** Whether every render compared was held as asked. */
    let allHeld = true;
    for (const width of widths) {
      // The first result is read whole too where step 3 compares it with a page from before.
      const first = await ask(width, false, edits.some((e) => { const c = checks.get(e.id); return !!c?.ran && c.widths.includes(width); }));
      if ('error' in first) throw new Error(first.error);
      const second = await ask(width, false);
      if ('error' in second) throw new Error(second.error);
      const design = await ask(width, true);
      if ('error' in design) throw new Error(design.error);
      const again = await ask(width, true);
      if ('error' in again) throw new Error(again.error);
      allHeld &&= [first, second, design, again].every((x) => heldAlike(x.steady, { ...hold, views: [] }));
      const elements = compareElements(design.elements, first.elements, width);
      // Nothing is verified by finding nothing different: every edit is compared, or fails saying why not.
      const measured = (x: LayerRendered, id: string): boolean => x.elements.some((s) => s.edit === id);
      const tokens: { edit: string; name: string }[] = [];
      for (const e of edits) {
        if (e.breakpoint !== 'all') {
          // The design shows no edit for a named breakpoint (phase 1 reads none of the theme's), so nothing compares it.
          elements.push({ kind: 'style', edit: e.id, width, element: e.label, property: 'breakpoint', design: `only at the theme’s “${e.breakpoint}” breakpoint`, result: 'not verifiable yet: Wanigan does not read the theme’s breakpoints, so the design cannot show it' });
        } else if (e.change.type === 'token') {
          tokens.push({ edit: e.id, name: e.change.name });
        } else if (!design.found.includes(e.id)) {
          elements.push({ kind: 'style', edit: e.id, width, element: e.label, property: 'element', design: 'not found on the page', result: first.found.includes(e.id) ? 'on the page' : 'not found on the page' });
        } else if (!measured(design, e.id) && !measured(first, e.id)) {
          // Found, then gone before it was measured (the page re-rendered it while its clock ran): its tags went with it,
          // so neither render shows anything of the edit, and the two are the same for want of it.
          elements.push({ kind: 'style', edit: e.id, width, element: e.label, property: 'element', design: 'its element was not there when the page was measured', result: 'its element was not there when the page was measured' });
        }
      }
      // A token is its custom property on the root, the same in both. It adds no zone: a whole-page zone would make every
      // difference anywhere near an edit, and step 3 would never run for the edits verified with it.
      elements.push(...compareTokens(tokens, design.tokens, first.tokens, width));
      const zones: Zone[] = zonesOf(design.elements, first.elements);
      const keep = zones.map((z) => z.rect);
      // What the site says changes between renders is left out of every pixel comparison, never a touched element; the
      // noise floor is measured over what is left. A change the helper held still is compared: all four were held alike.
      const masks = masksAmong([first, second, design, again]);
      const out = masks.flatMap((m) => m.rects);
      const noise = widestNoise([noiseFloor(first.bitmap, second.bitmap, out, keep), noiseFloor(design.bitmap, again.bitmap, out, keep)]);
      const d = applyMask(diffBitmaps(design.bitmap, first.bitmap), out, keep);
      // Step 3 against each edit's page from before, with that edit as designed on it, outside every touched element (in
      // it and in today's renders). The two may be laid out differently for good reason (the save changed the same
      // words in a breadcrumb, which wraps and moves everything below it), so it is element by element: each element
      // matched by its place in the structure, its words and computed values compared wherever it sits; the edit's
      // old words become its new ones elsewhere is the save's reach, said; and pixels only inside what kept still.
      const before: PixelArea[] = [];
      const outside: WidthFindings['outside'] = [];
      let picture = d;
      for (const e of edits) {
        const k = kept.get(e.id);
        const check = checks.get(e.id);
        const at = k?.widths[String(width)];
        if (!k || !check?.ran || !check.widths.includes(width) || !at) continue;
        let then: Bitmap;
        let thenPage: PageSnap | null;
        try {
          then = await decode(readFileSync(join(editDir(projectId, e.id), 'before', `${width}-design.png`)));
          thenPage = pageOf(JSON.parse(readFileSync(join(editDir(projectId, e.id), 'before', `${width}-elements.json`), 'utf8')));
        } catch {
          checks.set(e.id, { ran: false, why: 'Its page from before could not be read back from Wanigan’s data folder.' });
          continue;
        }
        if (!thenPage || !first.page) {
          checks.set(e.id, { ran: false, why: `${!thenPage ? 'Its page from before' : 'Today’s page'} could not be read element by element at ${width} px, so step 3 compared the design only.` });
          continue;
        }
        const was = { masks: at.masks, steady: at.steady };
        const alike = [second, design, again, was].every((x) => heldAlike(first.steady, x.steady));
        const left = (masks: readonly RenderMask[] | undefined): LayerRect[] => (masks ?? []).filter((m) => !(alike && m.held)).flatMap((m) => m.rects);
        const zonesThen = zonesOf([...design.elements, ...at.elements], first.elements);
        const keepThen = zonesThen.map((z) => z.rect);
        const masksThen = masksAmong([first, second, design, again, was]);
        const words = e.change.type === 'text' && typeof e.before.text === 'string' ? { was: e.before.text, now: e.change.value } : null;
        const found3 = compareOutside({
          before: thenPage, result: first.page, width, against: { edit: e.id, at: k.at }, words,
          masked: { before: left(was.masks), result: [first, second, design, again].flatMap((x) => left(x.masks)) },
        });
        outside.push(...found3.differences);
        reached.push({ edit: e.id, reach: found3.reach });
        const dThen = onlyWhere(diffBitmaps(then, first.bitmap), found3.include, [...found3.exclude, ...masksThen.flatMap((m) => m.rects)]);
        before.push(against(comparePixels(dThen, zonesThen, width).rest, e.id, k.at));
        picture = unionDiff(picture, dThen);
        leftOut.push({ width, masks: masksThen, keep: keepThen });
      }
      found.push({ width, noise, elements, pixels: comparePixels(d, zones, width), before, outside });
      leftOut.push({ width, masks, keep });
      const full = Math.max(design.cut?.full ?? 0, first.cut?.full ?? 0);
      if (full) cut.push({ width, to: VERIFY_MAX_HEIGHT, full: Math.round(full) });
      shots.push({ width, design: design.png, result: first.png, resultBitmap: first.bitmap, d: picture });
    }
    // One floor for the whole verdict, the one it states: the largest over both versions and every width. Two renders
    // of a width that happened to match exactly do not make that width stricter than the page is.
    const floor = verdictNoise(found);
    const outcome = judge(found.map((w) => ({ ...w, noise: floor })));
    const images: { width: number; design: Buffer; result: Buffer; diff: Buffer }[] = [];
    for (const i of shots) images.push({ width: i.width, design: i.design, result: i.result, diff: i.d.pixels || i.d.masked ? await encode(diffPicture(i.resultBitmap, i.d, floor)) : Buffer.alloc(0) });
    const base: Omit<LayerVerdict, 'pictures'> = {
      at: clock(), ok: outcome.ok, failed: outcome.failed, widths, noise: floor,
      differences: outcome.differences.slice(0, MAX_DIFFERENCES),
      masked: maskedOf(leftOut), held: allHeld ? { at: hold.t } : null, cut, reach: reachOf(reached),
    };
    // The pictures, for each edit's tray row: its own folder, written afresh (its page from before is kept).
    const verdicts = new Map<string, LayerVerdict>();
    for (const e of edits) {
      const dir = editDir(projectId, e.id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const f of readdirSync(dir)) if (/^\d{3,4}-(?:design|result|diff)\.png$/.test(f)) rmSync(join(dir, f), { force: true });
      const pictures = images.map((i) => {
        const file = (kind: string): string => join(dir, `${i.width}-${kind}.png`);
        writeFileSync(file('design'), i.design, { mode: 0o600 });
        writeFileSync(file('result'), i.result, { mode: 0o600 });
        if (i.diff.length) writeFileSync(file('diff'), i.diff, { mode: 0o600 });
        const then = join(dir, 'before', `${i.width}-page.png`);
        return { width: i.width, design: file('design'), result: file('result'), diff: i.diff.length ? file('diff') : null, before: existsSync(then) ? then : null };
      });
      verdicts.set(e.id, { ...base, before: checks.get(e.id) as LayerBeforeCheck, pictures });
    }
    // The core is told: verified, or still implemented with the verdict. The words are in the site either way; a
    // failed verdict says what differs, and never makes an edit a draft again (from where it could be discarded).
    const refusals: string[] = [];
    for (const e of edits) {
      const v = verdicts.get(e.id) as LayerVerdict;
      const why = await mark(projectId, e.id, base.ok ? 'verified' : 'implemented', v);
      if (why) refusals.push(`“${e.label}”: ${why}`);
    }
    // A verdict the layer did not keep is said, never passed off as recorded.
    if (refusals.length) throw new Error(`The verification ran (its pictures are kept), but the layer did not record it: ${refusals.join(' ')}`);
    return verdicts.get(edits[0]!.id) as LayerVerdict;
  };
  const verify = (raw: unknown, rawOptions: unknown): Promise<LayerVerdict> => inTurn(() => verifyNow(raw, rawOptions));

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
