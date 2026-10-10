// The design layer (docs/design/2026-10-09-design-layer.md): edits the owner
// makes on the live page, kept on Wanigan's side until they are implemented in
// the site and verified. This module is the layer's data and its preview
// stylesheet: what an edit is, which values may enter it (edits can come from
// an agent through MCP, so everything here is checked), and the CSS the live
// view injects so each edit shows at once.
//
// Phase 1 (layer and content) is the contract below, shared by the core (the
// log: LayerSnapshot through `live.layer*` in protocol.ts), the main process
// (LiveBridge.layer*: resolving targets on the page, tagging, the preview, the
// native implementation of text, the verify capture) and the window (the
// tray, the style panel, scopes).
//
// The preview stylesheet is never shipped. It targets only elements the page
// script tagged with the edit's id (`data-wl-edit`), and it always wins
// (`!important`, a doubled attribute selector), so the page shows the design
// whatever the theme's own rules say. Whether the native implementation wins
// the cascade is what the verify step proves.
import { kindKey, parseIdentity, type PartIdentity } from './live-trace.ts';

/** Style properties an edit may set. Each is something the owner can see and a theme can implement natively. */
export const LAYER_PROPERTIES = [
  'color', 'background-color',
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-transform', 'text-decoration-line', 'text-align',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'gap', 'row-gap', 'column-gap',
  'border-radius', 'border-width', 'border-style', 'border-color', 'box-shadow',
  'width', 'max-width', 'min-height', 'height',
  'opacity', 'display', 'justify-content', 'align-items',
] as const;
export type LayerProperty = (typeof LAYER_PROPERTIES)[number];

/**
 * Who an edit is for. What the trace says the part is (its PartIdentity, helper 4), and the element inside it the
 * owner chose (a CSS path from the part's own root element; null for the part itself). Markup no helper explains has
 * only a `selector` from the document, and its edit is fragile: said so in the tray, and orphaned rather than
 * guessed when it stops matching. `textHash` is all the element's words when the edit was made (layerTextHash of its
 * whole text, children included, so a container is guarded too): a target that now resolves to other words is
 * orphaned, never applied to whatever sits in its place. A text edit also resolves to its own new words, once the
 * site has them. A WordPress block is named by its place in the stored markup (WordPress keeps no id for a block),
 * so after a reorder this hash is what keeps an edit from landing on the block that moved into that place.
 */
export interface LayerTarget {
  part: PartIdentity | null;
  inner: string | null;
  selector: string | null;
  textHash: string | null;
}

/** `this`: one element. `kind`: every instance of its component, block type or field. `site`: a token. */
export type LayerScope = 'this' | 'kind' | 'site';

export type LayerChange =
  | { type: 'style'; values: Partial<Record<LayerProperty, string>> }
  | { type: 'token'; name: string; value: string }
  | { type: 'text'; value: string }
  | { type: 'image'; asset: string; alt: string | null }
  /** A component, block or pattern from the site's palette, at a place in a collection, with the props chosen for it. */
  | { type: 'insert'; entry: string; collection: string; index: number; props: Record<string, string | number | boolean> }
  /** The placed item the target names, taken out of its collection (never deleted). */
  | { type: 'remove'; collection: string };

export type LayerState = 'draft' | 'implemented' | 'verified' | 'retired' | 'orphaned';

export interface LayerEdit {
  id: string;
  target: LayerTarget;
  /** What the tray calls it: the element and the part, as the trace names them ("Heading in Hero (component)"). */
  label: string;
  /** The page it was made on, as a path of the site ("/about"). */
  page: string;
  scope: LayerScope;
  /** `all`, or the id of one of the theme's breakpoints. */
  breakpoint: string;
  change: LayerChange;
  /** What it was, for undo and for the verify step: computed values, or the old text or asset. */
  before: Record<string, string>;
  state: LayerState;
  by: 'owner' | 'agent';
  at: number;
  /** What the last verification said; null until one runs. */
  verdict: LayerVerdict | null;
}

/** A breakpoint as the theme defines it (Drupal's breakpoints.yml, WordPress's widths), as a media query. */
export interface LayerBreakpoint { id: string; label: string; media: string }

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A CSS path the page script wrote: tags, classes, ids, :nth-of-type(n), > and spaces. Nothing that could reach outside a selector. */
const PATH = /^[A-Za-z0-9 >:()._#-]{1,500}$/;
const TEXT_HASH = /^[0-9a-f]{8,16}$/;
const TOKEN = /^--[a-z0-9][a-z0-9-]{0,99}$/i;
/** A media query the layer will print: `all` or `screen`, width features, numbers, units and `and` only (Drupal's breakpoints.yml writes `all and (min-width: …)`). */
const MEDIA = /^(?:(?:only )?(?:screen|all) and )?\((?:min|max)-width: ?\d{1,5}(?:\.\d+)?(?:px|em|rem)\)(?: and \((?:min|max)-width: ?\d{1,5}(?:\.\d+)?(?:px|em|rem)\))?$/;

/**
 * A style value the layer will print, or null. Values are words, numbers with
 * units, colours, `var(--token)`, `calc()`, quoted font names and commas: no
 * `url()` or `image-set()` (the layer loads nothing), no `expression`, no
 * at-rules, no braces, semicolons, backslashes, comments or angle brackets.
 */
export function layerValue(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().replace(/\s*!important\s*$/i, '');
  if (!v || v.length > 300) return null;
  if (/[;{}<>\\@]|\/\*|\*\//.test(v)) return null;
  if (/\b(?:url|image-set|expression|element|attr|env)\s*\(/i.test(v)) return null;
  if (!/^[a-zA-Z0-9#%.,()\-+/*_ '"]+$/.test(v)) return null;
  // Every quoted string closes, read as CSS reads it: inside one, the other quote is a letter ("O'Reilly Sans"). A
  // string left open would swallow the rest of the sheet, every later rule and token with it.
  let open: string | null = null;
  for (const c of v) {
    if (open) { if (c === open) open = null; } else if (c === '"' || c === "'") open = c;
  }
  return open ? null : v;
}

/** An edit from outside (an agent, a file), checked field by field; null with the reason when it is not one. */
export function layerEdit(raw: unknown): { edit: LayerEdit; refused: null } | { edit: null; refused: string } {
  const no = (refused: string) => ({ edit: null, refused } as const);
  if (!raw || typeof raw !== 'object') return no('An edit is an object.');
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !ID.test(r.id)) return no('An edit needs an id of lower-case letters, digits and dashes.');
  const target = layerTarget(r.target);
  if (!target) return no('An edit needs a target the trace names.');
  if (r.scope !== 'this' && r.scope !== 'kind' && r.scope !== 'site') return no('An edit’s scope is this, kind or site.');
  if (typeof r.breakpoint !== 'string' || (r.breakpoint !== 'all' && !ID.test(r.breakpoint))) return no('An edit’s breakpoint is all, or a breakpoint’s id.');
  const change = layerChange(r.change);
  if (typeof change === 'string') return no(change);
  if ((change.type === 'token') !== (r.scope === 'site')) return no('A token is changed for the whole site, and only a token is.');
  const before: Record<string, string> = {};
  if (r.before && typeof r.before === 'object') {
    for (const [k, v] of Object.entries(r.before as Record<string, unknown>).slice(0, 60)) if (typeof v === 'string' && k.length <= 100) before[k] = v.slice(0, 2000);
  }
  if (change.type !== 'token' && !target.part && !target.selector) return no('An edit needs a target the trace names.');
  if (r.scope === 'kind' && (!target.part || !kindKey(target.part))) return no('Only a part with a kind (a component, a block type, a field) can be changed for every instance.');
  const states: readonly LayerState[] = ['draft', 'implemented', 'verified', 'retired', 'orphaned'];
  const state = states.includes(r.state as LayerState) ? r.state as LayerState : 'draft';
  const label = typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 200) : 'An edit';
  const page = typeof r.page === 'string' && r.page.startsWith('/') && !r.page.startsWith('//') && r.page.length <= 2000 && !/[\u0000-\u001f]/.test(r.page) ? r.page : '/';
  return {
    edit: {
      id: r.id, target, label, page, scope: r.scope, breakpoint: r.breakpoint, change, before, state, by: r.by === 'agent' ? 'agent' : 'owner',
      at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0, verdict: null,
    },
    refused: null,
  };
}

function layerTarget(raw: unknown): LayerTarget | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const part = t.part === null || t.part === undefined ? null : parseIdentity(t.part);
  if (t.part !== null && t.part !== undefined && !part) return null;
  const path = (v: unknown): string | null | undefined => (v === null || v === undefined ? null : typeof v === 'string' && PATH.test(v) ? v : undefined);
  const inner = path(t.inner), selector = path(t.selector);
  if (inner === undefined || selector === undefined) return null;
  const textHash = t.textHash === null || t.textHash === undefined ? null : typeof t.textHash === 'string' && TEXT_HASH.test(t.textHash) ? t.textHash : undefined;
  if (textHash === undefined) return null;
  return { part, inner: part ? inner : null, selector: part ? null : selector, textHash };
}

function layerChange(raw: unknown): LayerChange | string {
  if (!raw || typeof raw !== 'object') return 'An edit needs a change.';
  const c = raw as Record<string, unknown>;
  switch (c.type) {
    case 'style': {
      if (!c.values || typeof c.values !== 'object') return 'A style change needs values.';
      const values: Partial<Record<LayerProperty, string>> = {};
      for (const [k, v] of Object.entries(c.values as Record<string, unknown>)) {
        if (!(LAYER_PROPERTIES as readonly string[]).includes(k)) return `The layer does not set ${k.slice(0, 60)}.`;
        const value = layerValue(v);
        if (value === null) return `That is not a value the layer will set for ${k}.`;
        values[k as LayerProperty] = value;
      }
      return Object.keys(values).length ? { type: 'style', values } : 'A style change needs at least one value.';
    }
    case 'token': {
      if (typeof c.name !== 'string' || !TOKEN.test(c.name)) return 'A token is a custom property: --name.';
      const value = layerValue(c.value);
      return value === null ? 'That is not a value the layer will set for a token.' : { type: 'token', name: c.name, value };
    }
    case 'text': return typeof c.value === 'string' && c.value.length <= 100_000 ? { type: 'text', value: c.value } : 'A text change needs its new text.';
    case 'image': {
      if (typeof c.asset !== 'string' || !/^[a-f0-9]{16,64}\.(?:jpe?g|png|webp|gif|avif|svg)$/.test(c.asset)) return 'An image change needs an asset Wanigan keeps.';
      return { type: 'image', asset: c.asset, alt: typeof c.alt === 'string' ? c.alt.slice(0, 1000) : null };
    }
    case 'insert': {
      const ref = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\u0000-\u001f]/.test(v) ? v : null);
      const entry = ref(c.entry), collection = ref(c.collection);
      if (!entry || !collection) return 'An insert needs the palette entry and the collection it goes into.';
      if (!Number.isInteger(c.index) || (c.index as number) < 0 || (c.index as number) > 10_000) return 'An insert needs the place in its collection.';
      const props: Record<string, string | number | boolean> = {};
      if (c.props && typeof c.props === 'object') {
        for (const [k, v] of Object.entries(c.props as Record<string, unknown>).slice(0, 100)) {
          if (!/^[a-z_][a-z0-9_]{0,63}$/i.test(k)) return `${k.slice(0, 60)} is not a prop name.`;
          if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) props[k] = v;
          else if (typeof v === 'string' && v.length <= 10_000) props[k] = v;
          else return `The prop ${k} is not a string, number or yes/no.`;
        }
      }
      return { type: 'insert', entry, collection, index: c.index as number, props };
    }
    case 'remove': {
      const collection = typeof c.collection === 'string' && c.collection.length > 0 && c.collection.length <= 200 ? c.collection : null;
      return collection ? { type: 'remove', collection } : 'A removal needs the collection the item is taken out of.';
    }
    default: return 'A change is style, token, text, image, insert or remove.';
  }
}

/** The breakpoints a theme declares, checked; `all` is implied and never listed. */
export function layerBreakpoints(raw: readonly { id: unknown; label: unknown; media: unknown }[]): LayerBreakpoint[] {
  const out: LayerBreakpoint[] = [];
  for (const b of raw.slice(0, 20)) {
    if (typeof b.id !== 'string' || !ID.test(b.id) || b.id === 'all' || typeof b.media !== 'string') continue;
    const media = b.media.trim().replace(/\s+/g, ' ');
    if (!MEDIA.test(media)) continue;
    out.push({ id: b.id, label: typeof b.label === 'string' ? b.label.slice(0, 60) : b.id, media });
  }
  return out;
}

/** The selector for an edit's elements: tagged by the page script, doubled so the preview wins the cascade. */
export const layerSelector = (id: string): string => `[data-wl-edit~="${id}"][data-wl-edit~="${id}"]`;

/** A stylesheet's generation, as the page's root names it (`data-wl-layer`): `g` and a number. */
export const LAYER_GATE = /^g\d{1,9}$/;

/**
 * The preview stylesheet for the edits in effect (drafts and implemented ones
 * not yet verified), in the order they were made, so a later edit to the same
 * property wins. Tokens go on `:root`. Edits for a breakpoint the theme does
 * not declare are left out rather than guessed.
 *
 * With a `gate`, every rule holds only while the page's root says that
 * generation (`<html data-wl-layer="g7">`). The sheet is injected at the user
 * origin, and Electron cannot take a user-origin sheet out again
 * (removeInsertedCSS removes author sheets only, seen on Electron 44): a sheet
 * the page no longer names matches nothing, so switching the layer off or
 * replacing it is one attribute on the root.
 */
export function compileLayer(edits: readonly LayerEdit[], breakpoints: readonly LayerBreakpoint[], gate: string | null = null): string {
  const root = gate !== null && LAYER_GATE.test(gate) ? `:root[data-wl-layer="${gate}"]` : null;
  if (gate !== null && !root) return '';
  // The root itself and everything under it: an edit may be on <html>.
  const scoped = (sel: string): string => (root ? `${root} ${sel}, ${root}${sel}` : sel);
  const media = new Map(breakpoints.map((b) => [b.id, b.media]));
  const blocks = new Map<string, string[]>();
  const add = (bp: string, rule: string): void => {
    const list = blocks.get(bp) ?? [];
    list.push(rule);
    blocks.set(bp, list);
  };
  for (const e of edits) {
    if (e.state !== 'draft' && e.state !== 'implemented') continue;
    if (e.breakpoint !== 'all' && !media.has(e.breakpoint)) continue;
    if (e.change.type === 'token') {
      const value = layerValue(e.change.value);
      if (value !== null && TOKEN.test(e.change.name)) add(e.breakpoint, `${root ?? ':root'} { ${e.change.name}: ${value} !important; }`);
      continue;
    }
    if (e.change.type !== 'style' || !ID.test(e.id)) continue;
    const decls = Object.entries(e.change.values)
      .filter(([k, v]) => (LAYER_PROPERTIES as readonly string[]).includes(k) && layerValue(v) !== null)
      .map(([k, v]) => `${k}: ${layerValue(v)} !important;`);
    if (decls.length) add(e.breakpoint, `${scoped(layerSelector(e.id))} { ${decls.join(' ')} }`);
  }
  const out: string[] = [];
  const all = blocks.get('all');
  if (all) out.push(...all);
  // Breakpoints in the theme's own order, after the rules for every width.
  for (const b of breakpoints) {
    const rules = blocks.get(b.id);
    if (rules) out.push(`@media ${b.media} {\n${rules.map((r) => `  ${r}`).join('\n')}\n}`);
  }
  return out.join('\n');
}

/** An element's own words as the layer keys them: whitespace folded, then FNV-1a (64-bit) as 16 hex digits. The page script computes the same. */
export function layerTextHash(text: string): string {
  const folded = text.replace(/\s+/g, ' ').trim();
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < folded.length; i++) {
    h ^= BigInt(folded.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/* ── phase 1: what the core keeps, the main process does, and the window shows ── */

/**
 * A project's layer as the core keeps it (`live.layer`): the edits in effect and those already in the site, in the
 * order made, and what undo and redo would do. Undo takes back the newest add or discard; redo puts it back, until
 * the next add. Taken-back edits are kept in the log but are not listed.
 */
export interface LayerSnapshot {
  projectId: string;
  edits: LayerEdit[];
  /** The edit undo would take back (an add) or bring back (a discard), with what it is; null when there is nothing to undo. */
  undo: { id: string; label: string; action: 'add' | 'discard' } | null;
  redo: { id: string; label: string; action: 'add' | 'discard' } | null;
}

/** What the window sends to make an edit: the core gives it its id, `by`, `at` and `state`, and checks it (layerEdit). */
export type LayerEditInput = Pick<LayerEdit, 'target' | 'label' | 'page' | 'scope' | 'breakpoint' | 'change' | 'before'>;

/** The picked element as the layer would key an edit to it (LiveBridge.layerTarget). */
export interface LayerPickTarget {
  target: LayerTarget;
  /** The tray's name for it. */
  label: string;
  /** What `kind` would reach, in words ("every Card component", "the Body field of every Article"); null when it has no kind. */
  kindLabel: string | null;
  /** How many elements on this page `kind` would reach now. */
  kindCount: number;
  /** Its computed values for the layer's properties, and its words: an edit's `before`. */
  before: Record<string, string>;
  /** The helper names no part for it: an edit is fragile. */
  fragile: boolean;
}

/** The layer applied to the page shown (LiveBridge.layerApply): what each edit of this page reached. */
export interface LayerApplied {
  /** The page path the view shows. */
  page: string;
  /** Edits shown on this page, and how many elements each tagged. */
  shown: { id: string; elements: number }[];
  /** Edits made on this page whose target no longer resolves, or resolves to other words: listed, never applied. The core is told of drafts (orphaned); an implemented edit stays implemented. */
  orphaned: { id: string; why: string }[];
  /** Edits of other pages (scope `this`), left alone here. */
  elsewhere: string[];
  /** The layer is switched off in the view (LiveBridge.layerShow(false)): nothing is shown. */
  off: boolean;
}

/**
 * Making an edit real (LiveBridge.layerImplement). Phase 1 implements text in a plain text field through the site
 * helper, as the logged-in user, with a revision where the site keeps them; anything else goes to an agent as a
 * brief (`route: 'agent'`) on the owner's click, or is not yet possible (`route: 'none'`), and says why.
 */
export type LayerImplemented =
  | {
    ok: true; id: string; state: 'implemented'; revision: string | null;
    /**
     * Words saved where the content keeps them, found by the helper's stored-words search (src/shared/live-stored-words.ts):
     * what happened in the owner's words (where they are kept, whether the site keeps a revision, what a plugin's own
     * copy may do, what the reloaded page shows), whether Undo can put the old value back (LiveBridge.layerUndo), and
     * what the reloaded page shows: the new words, still the old ones, or not known.
     */
    said?: string; undo?: boolean; shows?: 'new' | 'old' | 'unknown';
  }
  | { ok: false; id: string; route: 'agent' | 'none'; why: string };

/** Putting a stored-words save back (LiveBridge.layerUndo): done, with the revision the site made and what it means, or why not. */
export type LayerUndone =
  | { ok: true; id: string; revision: string | null; said: string }
  | { ok: false; id: string; why: string };

/** A rectangle of the page, in CSS pixels of the document at the verified width. */
export interface LayerRect { x: number; y: number; width: number; height: number }

/** One thing the verification found different between the page as designed and the page as the site now renders it. */
export type LayerDifference =
  /** A computed value of a touched element (step 1). */
  | { kind: 'style'; edit: string; width: number; element: string; property: string; design: string; result: string }
  /** A touched element's box (step 1). */
  | { kind: 'box'; edit: string; width: number; element: string; design: LayerRect; result: LayerRect }
  /** Pixels inside or around a touched element past the noise floor (step 2). */
  | { kind: 'pixels'; edit: string | null; width: number; rect: LayerRect; pixels: number; maxDiff: number }
  /**
   * Pixels away from every touched element: the change reached further than it should (step 3). Against the design
   * rendered now, or, with `against`, against the page as it was kept just before that edit was made real (with the
   * edit as designed on it), at `at` (milliseconds).
   */
  | { kind: 'leak'; width: number; rect: LayerRect; pixels: number; maxDiff: number; against?: { edit: string; at: number } };

/**
 * A part of the page left out of the pixel steps because the site says it changes between renders: a Drupal part whose
 * trace says it is built late, never cached, kept for a while, or made for each user or session; a WordPress block the
 * helper marked by its type (a random order, today's date, a feed). Named in the verdict, never silent; the noise floor
 * is measured over what is left. An edited element is never left out: where a part overlaps one, the edited element is
 * compared in full all the same (`nearEdit`).
 */
export interface LayerMask {
  /** What it is: the part as the trace names it ("Who’s online (block)"), or the block the helper marked ("core/calendar block"). */
  label: string;
  /** Why it changes between renders, in words. */
  why: string;
  /** The widths it was left out at. */
  widths: number[];
  /** It overlapped an edited element, which was compared in full all the same. */
  nearEdit: boolean;
}

/**
 * Step 3 against the page as it was just before the edit was made real (rendered then without the layer, and with this
 * edit as designed on it, at the verification widths): it ran, at `at` (milliseconds) for these widths; or why it could
 * not (no page from before was kept, another edit was made real on the page since). A verdict whose step 3 could not
 * run against it does not claim it passed: it says so.
 */
export type LayerBeforeCheck =
  | { ran: true; at: number; widths: number[] }
  | { ran: false; why: string };

/** A page that went on below where it was compared: at `width`, compared down to `to` CSS pixels of the page's `full` height. */
export interface LayerCut { width: number; to: number; full: number }

/** The verification steps, in the order they run; the first that fails stops it. Phase 1 runs the first three. */
export const VERIFY_STEPS = ['styles', 'pixels', 'rest'] as const;
export type VerifyStep = (typeof VERIFY_STEPS)[number];

/**
 * What a verification said (LiveBridge.layerVerify), kept on the edit. The design is the page with the layer, the
 * result is the page without it, each rendered in a hidden window at the same width, scale and session. The noise
 * floor is measured first, by rendering each version twice, and stated as two numbers (the largest channel difference
 * and how many pixels differ, each the largest over both versions and every width), never as a percentage; every
 * width is judged against it. The parts the site says change between renders are left out of the pixel steps
 * (`masked`), and the floor is measured over what is left.
 *
 * The fields after `pictures` came later: a verdict kept before them has none of them, and reads as it did.
 */
export interface LayerVerdict {
  at: number;
  ok: boolean;
  /** The first step that failed, or null when every step passed. */
  failed: VerifyStep | null;
  widths: number[];
  noise: { maxDiff: number; pixels: number };
  differences: LayerDifference[];
  /**
   * Pictures kept in Wanigan's data folder for the tray: the design, the result and their difference (against the page
   * from before too, where step 3 compared it), per width; and the page as it was before the edit was made real, where
   * one was kept at that width.
   */
  pictures: { width: number; design: string; result: string; diff: string | null; before?: string | null }[];
  /** Parts left out of the pixel steps, each with why and where (LayerMask). */
  masked?: LayerMask[];
  /** Step 3 against the page as it was before this edit was made real: whether it ran, or why not. */
  before?: LayerBeforeCheck;
  /**
   * The site's helper held the request time still (as at `at`, seconds) and seeded random orders for every render this
   * verdict compares, so what those would change was compared rather than left out; null when it did not.
   */
  held?: { at: number } | null;
  /** Widths at which the page went on below where it was compared: a statement, passing or not, never a difference. */
  cut?: LayerCut[];
}
