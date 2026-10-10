// The design layer's verification (docs/design/2026-10-09-design-layer.md, "Stage 3: verify"): pure comparisons of
// two renders of one page, the design (the page with the layer) and the result (the page as the site renders it
// without one), so every rule is tested without a window. The main process renders and captures
// (src/main/live-layer.ts); this decides what differs, where, and which edit it belongs to.
//
// - Step 1, styles and boxes: every element an edit touched, tagged the same way in both renders, must have the same
//   computed values for the layer's properties, the same words and the same box. It says exactly which property.
//   A token is checked the same way, by its custom property's computed value on the page's root in both renders.
// - Step 2, pixels in and around the touched elements, within the noise floor.
// - Step 3, the rest of the page: a difference away from every touched element is a leak.
//   Step 3 also compares the result with the page as it was kept just before each edit was made real, with that edit
//   as designed on it (rendered in the same load): a change the native implementation made beyond the touched
//   elements is in both of today's renders, and only that page shows it was not there before. That page and today's
//   may be laid out differently for good reason (the save changed the same words in a breadcrumb, which then wraps
//   and moves everything below it), so they are compared element by element: each element outside the touched ones
//   matched by its place in the structure, its own words and computed values compared, wherever it now sits; words
//   that changed only from the edit's old words to its new ones are the save's own reach, said and not failed; and
//   pixels only inside elements that kept their place and size, everything in them too.
// The steps run in that order and the first that fails decides the verdict.
//
// The noise floor is measured by rendering each version twice: the largest channel difference between the two, and
// how many pixels differ at all. Those two numbers are the tolerance, in the manner of the web-platform-tests
// "fuzzy" annotation (never a percentage, no anti-aliasing forgiveness): an area passes when its largest difference
// and its count of differing pixels are each within them. Parts the site says change between renders are left out
// of every pixel comparison first (masks: a Drupal part by its trace's cache metadata, a WordPress block the helper
// marked by its type), each named in the verdict, and never an edited element; the floor is measured over what is
// left. What a mask cannot see (a theme calling rand() without saying so) still shows only in the floor.
import {
  LAYER_PROPERTIES, VERIFY_STEPS, type LayerCut, type LayerDifference, type LayerMask, type LayerReach, type LayerRect, type LayerVerdict, type VerifyStep,
} from './design-layer.ts';
import { changeBoxes } from './live-compare.ts';
import type { LiveTrace, TracePart } from './live-trace.ts';

/** The widths a verification renders at when the window names none: a phone's and a desktop's. */
export const VERIFY_WIDTHS = [390, 1440] as const;
/** A verification renders at most this many widths. */
export const MAX_VERIFY_WIDTHS = 4;
/** Around a touched element, this many CSS pixels still belong to it: a shadow, an outline, anti-aliasing at its edge. */
export const ZONE_MARGIN = 8;
/** Differences said per step and width, largest first; the counts are always whole. */
export const MAX_RECTS = 40;
/** A verdict says at most this many differences; the first failing step's, in width order. */
export const MAX_DIFFERENCES = 300;
/** Step 1's differences said per width. */
const MAX_ELEMENT_DIFFERENCES = 100;

/** The widths asked for, checked: whole CSS pixels a phone to a wide desktop can be, each once; the default when none. */
export function verifyWidths(raw: unknown): number[] | string {
  if (raw === undefined || raw === null) return [...VERIFY_WIDTHS];
  if (!Array.isArray(raw) || raw.length === 0) return 'Name the widths to verify at, in CSS pixels.';
  if (raw.length > MAX_VERIFY_WIDTHS) return `A verification renders at most ${MAX_VERIFY_WIDTHS} widths.`;
  const out: number[] = [];
  for (const w of raw) {
    if (!Number.isInteger(w) || (w as number) < 320 || (w as number) > 2560) return 'A width is a whole number of CSS pixels from 320 to 2560.';
    if (!out.includes(w as number)) out.push(w as number);
  }
  return out;
}

/* ── pixels ─────────────────────────────────────────────────────────────── */

/** A capture's pixels: four channels a pixel, row after row. Both sides of a comparison come from the same capture, so the channel order is theirs. */
export interface Bitmap { data: Uint8Array | Uint8ClampedArray; width: number; height: number }

/**
 * Per pixel, the largest difference of any channel (0–255), over the larger of the two sizes: where only one has pixels,
 * 255. `masked`, once a mask is applied (applyMask): 1 where the pixel was left out, and its difference is 0 there.
 */
export interface PixelDiff { width: number; height: number; diff: Uint8Array; maxDiff: number; pixels: number; masked?: Uint8Array }

export function diffBitmaps(a: Bitmap, b: Bitmap): PixelDiff {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const diff = new Uint8Array(width * height);
  let maxDiff = 0;
  let pixels = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let d: number;
      if (x >= a.width || y >= a.height || x >= b.width || y >= b.height) d = 255;
      else {
        const i = (y * a.width + x) * 4;
        const j = (y * b.width + x) * 4;
        d = Math.max(
          Math.abs(a.data[i]! - b.data[j]!), Math.abs(a.data[i + 1]! - b.data[j + 1]!),
          Math.abs(a.data[i + 2]! - b.data[j + 2]!), Math.abs(a.data[i + 3]! - b.data[j + 3]!),
        );
      }
      if (!d) continue;
      diff[y * width + x] = d;
      pixels++;
      if (d > maxDiff) maxDiff = d;
    }
  }
  return { width, height, diff, maxDiff, pixels };
}

/** The noise floor: how far one version of the page differs from itself, rendered twice. */
export interface Noise { maxDiff: number; pixels: number }

/** The noise floor between two renders of one version, over what is left once `out` is left out (and `keep` kept: the touched elements). */
export function noiseFloor(first: Bitmap, second: Bitmap, out: readonly LayerRect[] = [], keep: readonly LayerRect[] = []): Noise {
  const d = applyMask(diffBitmaps(first, second), out, keep);
  return { maxDiff: d.maxDiff, pixels: d.pixels };
}

/** Whether an area's differences are within the noise floor: both numbers. */
export const withinNoise = (area: Noise, noise: Noise): boolean => area.maxDiff <= noise.maxDiff && area.pixels <= noise.pixels;

/**
 * What two loads of the same page differ by, for step 3's comparison with a page from before: the page now and the one
 * kept were rendered minutes or days apart, each in a window of its own, and a GPU decodes a scaled picture a little
 * differently from one load to the next when nothing changed: up to 7 of 255 on a settled demo page, over a whole photo
 * (docs/research/2026-10-09-design-layer-probes.md, 2). The floor measured in one verification cannot see that: its two
 * renders of a version can happen to match (a style verified on the Northstar demo failed step 3 on its mug photo, 7
 * levels over 147,982 pixels, after passing once when they did not). Within this, a difference is the loads'.
 */
export const ACROSS_LOADS = 10;
/** Whether an area compared with a page from another load is within the floor, or within what two loads differ by. */
export const withinLoads = (area: Noise, noise: Noise): boolean => area.maxDiff <= ACROSS_LOADS || withinNoise(area, noise);

/* ── masks: what the site says changes between renders ──────────────────── */

/**
 * What a render leaves out of the pixel steps: a part of the page, why it changes between renders, its boxes in that
 * render (document pixels), and whether the site's helper held that change still for this render (the request time
 * pinned, the random order seeded): a held mask is left out only when compared with a render held otherwise.
 */
export interface RenderMask { label: string; why: string; rects: LayerRect[]; held: boolean }

/** How the helper held a render's request still, as it confirmed: the time (seconds) and seed sent with it, and the Drupal views (`id:display`) whose random order it seeded. */
export interface Steady { t: number; s: number; views: string[] }

/** Whether two renders were held alike: the same time and seed, each confirmed by the helper. */
export const heldAlike = (a: Steady | null | undefined, b: Steady | null | undefined): boolean => !!a && !!b && a.t === b.t && a.s === b.s;

/**
 * The masks to leave out when comparing renders with one another: every one of each, except those the helper held
 * still, when every render was held alike (then what they show is the same in each, and is compared).
 */
export function masksAmong(renders: readonly { masks?: readonly RenderMask[]; steady?: Steady | null }[]): RenderMask[] {
  const first = renders[0]?.steady;
  const alike = renders.every((r) => heldAlike(first, r.steady));
  return renders.flatMap((r) => (r.masks ?? []).filter((m) => !(alike && m.held)));
}

const overlaps = (a: LayerRect, b: LayerRect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Set a rectangle of a page-sized map to `v`, clipped to the page. */
function fillRect(map: Uint8Array, W: number, H: number, r: LayerRect, v: number): void {
  const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(W, Math.ceil(r.x + r.width)), y1 = Math.min(H, Math.ceil(r.y + r.height));
  for (let y = y0; y < y1; y++) map.fill(v, y * W + x0, y * W + Math.max(x0, x1));
}

/**
 * A comparison with `out` left out: every pixel inside one of its rectangles, except inside a `keep` rectangle (a
 * touched element and its margin: an edited element is always compared in full), has its difference taken away and
 * is marked masked; the two numbers are counted again over what is left.
 */
export function applyMask(d: PixelDiff, out: readonly LayerRect[], keep: readonly LayerRect[] = []): PixelDiff {
  if (!out.length) return d;
  const masked = new Uint8Array(d.width * d.height);
  for (const r of out) fillRect(masked, d.width, d.height, r, 1);
  for (const r of keep) fillRect(masked, d.width, d.height, r, 0);
  return withMasked(d, masked);
}

/** A comparison kept only inside `include` and outside `exclude`: every other pixel is left out (masked). */
export function onlyWhere(d: PixelDiff, include: readonly LayerRect[], exclude: readonly LayerRect[]): PixelDiff {
  const masked = new Uint8Array(d.width * d.height).fill(1);
  for (const r of include) fillRect(masked, d.width, d.height, r, 0);
  for (const r of exclude) fillRect(masked, d.width, d.height, r, 1);
  return withMasked(d, masked);
}

/** A comparison's differences where `masked` says 1 taken away, and its two numbers counted again over the rest. */
function withMasked(d: PixelDiff, masked: Uint8Array): PixelDiff {
  const W = d.width, H = d.height;
  const diff = new Uint8Array(d.diff);
  let maxDiff = 0, pixels = 0;
  for (let p = 0; p < diff.length; p++) {
    if (masked[p]) { diff[p] = 0; continue; }
    const v = diff[p]!;
    if (!v) continue;
    pixels++;
    if (v > maxDiff) maxDiff = v;
  }
  return { width: W, height: H, diff, maxDiff, pixels, masked };
}

/**
 * What a verdict says was left out: each mask by what it is and why, at the widths it was left out at, and whether it
 * overlapped an edited element (compared in full all the same). A mask with no area, or wholly inside the touched
 * elements, left nothing out and is not said.
 */
export function maskedOf(widths: readonly { width: number; masks: readonly RenderMask[]; keep: readonly LayerRect[] }[]): LayerMask[] {
  const out = new Map<string, LayerMask>();
  for (const w of widths) {
    for (const m of w.masks) {
      const rects = m.rects.filter((r) => r.width > 0 && r.height > 0);
      const inside = (r: LayerRect): boolean => w.keep.some((k) => k.x <= r.x && k.y <= r.y && k.x + k.width >= r.x + r.width && k.y + k.height >= r.y + r.height);
      if (!rects.length || rects.every(inside)) continue;
      const key = `${m.label}\n${m.why}`;
      const near = rects.some((r) => w.keep.some((k) => overlaps(r, k)));
      const had = out.get(key);
      if (had) {
        if (!had.widths.includes(w.width)) had.widths.push(w.width);
        had.nearEdit ||= near;
      } else if (out.size < MAX_MASKS) {
        out.set(key, { label: m.label.slice(0, 200), why: m.why.slice(0, 300), widths: [w.width], nearEdit: near });
      }
    }
  }
  return [...out.values()];
}

/** A verdict names at most this many masks. */
export const MAX_MASKS = 100;

/**
 * Cache contexts that make a Drupal part differ from one render to another, as core names them: per user and per
 * session (what core itself renders late), the address's query, a cookie, a request header (not the helper's own,
 * which every part it marks carries), the visitor's address. `user.permissions` and the like are the same for every
 * render a verification makes.
 */
function contextWhy(c: string): [string, string] | null {
  if (c === 'user') return ['user', 'made for each user'];
  if (c === 'session') return ['session', 'made for each session'];
  if (c === 'url.query_args' || c.startsWith('url.query_args:')) return ['url.query_args', 'made for the address’s query'];
  if (c.startsWith('cookies:')) return ['cookies', 'made for a cookie'];
  if (c.startsWith('headers:') && c.toLowerCase() !== 'headers:x-wanigan-live') return ['headers', 'made for a request header'];
  if (c === 'ip') return ['ip', 'made for the visitor’s address'];
  return null;
}

/** What makes a part differ between renders, by its own cache metadata (bubbled: a part carries its children's too). */
function varies(p: TracePart): Map<string, string> {
  const out = new Map<string, string>();
  const c = p.cache;
  if (!c) return out;
  if (c.maxAge === 0) out.set('age:0', 'built afresh for every request (never cached)');
  else if (typeof c.maxAge === 'number' && c.maxAge > 0) out.set(`age:${c.maxAge}`, `kept ${c.maxAge.toLocaleString('en')} seconds at most`);
  for (const ctx of c.contexts) {
    const w = contextWhy(ctx);
    if (w) out.set(`ctx:${w[0]}`, w[1]);
  }
  return out;
}

/** A Drupal part that differs between renders: which, what it is, why, and whether the helper's hold removed all of it. */
export interface TraceMask { part: string; label: string; why: string; held: boolean }

/**
 * The parts of a Drupal page to leave out, from its trace (docs/research/2026-10-09-core-limits.md, "Masking can be
 * per part"): a part built late (a placeholder), never cached, kept for a while (a max-age that is not permanent), or
 * made for each user or session (and the other contexts contextWhy names). Core bubbles max-age and contexts up to
 * every part around, so a reason is a part's own only when no part inside it has it: the innermost part it comes
 * from is left out, never the article around a "time ago" field. A placeholder counts only when nothing else says why
 * it was put off.
 *
 * `steady` (the helper confirmed it held this render): a kept-for-a-while part is held (core's "time ago" and the
 * like read the request time, which was pinned), and so is a view's "never cached" when the helper seeded that view's
 * random order; a part whose every reason is held is compared rather than left out, against a render held alike.
 */
export function traceMasks(trace: Pick<LiveTrace, 'parts'>, steady: Steady | null): TraceMask[] {
  const parts = trace.parts.slice(0, 20_000);
  const children = new Map<string, TracePart[]>();
  for (const p of parts) if (p.parent) children.set(p.parent, [...(children.get(p.parent) ?? []), p]);
  const own = new Map(parts.map((p) => [p.id, varies(p)]));
  // Every reason any part inside a part has: what that part's own reasons may have been bubbled up from.
  const below = new Map<string, Set<string>>();
  const inside = (id: string, depth = 0): Set<string> => {
    const had = below.get(id);
    if (had) return had;
    const out = new Set<string>();
    below.set(id, out);
    if (depth > 200) return out;
    for (const c of children.get(id) ?? []) {
      for (const k of own.get(c.id)?.keys() ?? []) out.add(k);
      for (const k of inside(c.id, depth + 1)) out.add(k);
    }
    return out;
  };
  const viewOf = (p: TracePart): string | null => (p.identity?.kind === 'config' && p.identity.type === 'view' ? p.identity.id : null);
  const out: TraceMask[] = [];
  for (const p of parts) {
    const reasons = own.get(p.id) as Map<string, string>;
    const mine = [...reasons].filter(([k]) => !inside(p.id).has(k));
    if (!reasons.size && p.cache?.status === 'placeholder') mine.push(['placeholder', 'built late, apart from the page (a placeholder)']);
    if (!mine.length) continue;
    const view = viewOf(p);
    const removable = (k: string): boolean => !!steady && ((k.startsWith('age:') && k !== 'age:0') || (k === 'age:0' && view !== null && steady.views.includes(view)));
    out.push({ part: p.id, label: `${p.label} (${p.kind})`.slice(0, 200), why: mine.map(([, w]) => w).join('; '), held: mine.every(([k]) => removable(k)) });
  }
  return out;
}

/** Why a block the WordPress helper marked (`data-wanigan-vary`) changes between renders, by the reason it named. */
const VARY: Record<string, string> = {
  'random-order': 'shows its items in a random order',
  today: 'shows today’s date',
  'latest-comments': 'shows the latest comments',
  'remote-feed': 'shows a feed from another site',
  'login-state': 'differs with whether you are logged in',
  'relative-date': 'shows a date relative to now',
};
export const varyWhy = (reason: string): string => VARY[reason] ?? `changes between renders, its site helper says (${reason.slice(0, 40)})`;

/* ── step 3 against the page as it was: element by element ────────────── */

/** One element of a page, as the page script's layerPage read it: its path from <body>, its name, box, own words, computed values (indexes into its page's table), and whether it is an edited element or inside one. */
export interface PageElement { path: string; name: string; box: LayerRect; text: string | null; values: number[]; touched: boolean }

/**
 * A whole page element by element: the properties read, their values' table, the elements in document order, and
 * whether the page went on past what was read. `late`: the elements a script added after the server sent the page
 * (absent from its HTML), each the outermost of what it added, with its box; they and everything in them are not among
 * `elements`, nor counted in the paths of their siblings. Absent when the page script could not tell (no HTML from
 * the server to tell by).
 */
export interface PageSnap { keys: string[]; table: string[]; elements: PageElement[]; cut: boolean; late?: { name: string; box: LayerRect }[] }

/** Why a script-added element is set aside: it is not in the page the server sent, and shows as the script decides. */
export const LATE_WHY = 'added by a script after the page loaded';
/** Why an element is set aside when the page differs from itself: two renders of the same version did not agree on it. */
export const UNSTABLE_WHY = 'differs between two renders of the same page';

/** The elements a script added after the page loaded, as masks: named, with why, left out of every pixel comparison. */
export const lateMasks = (page: Pick<PageSnap, 'late'> | null | undefined): RenderMask[] =>
  (page?.late ?? []).filter((l) => l.box.width > 0 && l.box.height > 0).map((l) => ({ label: l.name, why: LATE_WHY, rects: [l.box], held: false }));

/**
 * What differs between two renders of the same version of the page (the two the noise floor is measured from):
 * elements in one and not the other (the outermost of each), and elements whose own words or computed values differ.
 * The page decides those itself on each visit, so nothing about them is the save's doing: step 3 sets them aside,
 * with everything inside them, and names them.
 */
export function unstableOf(a: PageSnap, b: PageSnap): { paths: string[]; masks: RenderMask[] } {
  const byA = new Map(a.elements.map((e) => [e.path, e]));
  const byB = new Map(b.elements.map((e) => [e.path, e]));
  const value = (snap: PageSnap, el: PageElement, key: string): string | undefined => {
    const i = snap.keys.indexOf(key);
    return i < 0 ? undefined : snap.table[el.values[i] ?? -1];
  };
  const keys = a.keys.filter((k) => b.keys.includes(k));
  const paths: string[] = [];
  const masks: RenderMask[] = [];
  const under = (path: string): boolean => paths.some((p) => path.startsWith(`${p} > `));
  for (const el of [...a.elements, ...b.elements.filter((e) => !byA.has(e.path))]) {
    if (paths.includes(el.path) || under(el.path)) continue;
    const x = byA.get(el.path), y = byB.get(el.path);
    const differs = !x || !y || x.text !== y.text || keys.some((k) => value(a, x, k) !== value(b, y, k));
    if (!differs || x?.touched || y?.touched) continue;
    paths.push(el.path);
    const rects = [x?.box, y?.box].filter((r): r is LayerRect => !!r && r.width > 0 && r.height > 0);
    if (rects.length) masks.push({ label: el.name, why: UNSTABLE_WHY, rects, held: false });
    if (paths.length >= 500) break;
  }
  return { paths, masks };
}

/**
 * The layer's properties step 3 compares outside the touched elements: all but width and height, whose computed
 * values are the layout's (a heading that wraps makes the column around it taller, as designed).
 */
export const OUTSIDE_PROPERTIES: readonly string[] = LAYER_PROPERTIES.filter((p) => p !== 'width' && p !== 'height');

/** Words compared as a site prints them: whitespace folded, and the quotes, dashes and ellipsis WordPress's wptexturize makes read as typed. */
const wordsOf = (s: string): string => s
  .replace(/[‘’‚‛′]/g, '\'').replace(/[“”„‟″]/g, '"')
  .replace(/…/g, '...').replace(/---|--|[–—]/g, '-')
  .replace(/\s+/g, ' ').trim();

/**
 * Whether an element's words changed only by the edit's old words becoming its new ones: the same stored value shown
 * in another place (a breadcrumb, a teaser, a menu link), whole or within other words.
 */
export function sameWordsMoved(was: string | null, now: string | null, words: { was: string; now: string }): boolean {
  if (was === null || now === null) return false;
  const o = wordsOf(words.was), n = wordsOf(words.now);
  if (!o || o === n) return false;
  const a = wordsOf(was);
  return a.includes(o) && a.split(o).join(n) === wordsOf(now);
}

/** What step 3 found comparing the result with a page from before, element by element. */
export interface OutsideFound {
  /** Words and computed values that differ outside the touched elements, each named by its element (`outside`). */
  differences: LayerDifference[];
  /** Elements whose words changed only from the edit's old words to its new ones: the save's own reach. */
  reach: { path: string; name: string }[];
  /** Where pixels can be compared: elements that, with everything in them, kept their place and size and changed nothing. */
  include: LayerRect[];
  /** Left out of those (in either page): the save's reach, and elements that moved or changed size with nothing in them that did not. */
  exclude: LayerRect[];
}

const contains = (outer: LayerRect, inner: LayerRect): boolean =>
  outer.x - 1 <= inner.x && outer.y - 1 <= inner.y && outer.x + outer.width + 1 >= inner.x + inner.width && outer.y + outer.height + 1 >= inner.y + inner.height;
const sameRect = (a: LayerRect, b: LayerRect): boolean =>
  [a.x - b.x, a.y - b.y, a.width - b.width, a.height - b.height].every((d) => Math.abs(d) <= 0.5);
const parentPath = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf(' > ')));

/**
 * Step 3 against a page from before, element by element. Each element outside the touched ones (an edited element and
 * everything in it, in either page) and outside what is masked (in its own page) is matched by its path: on one page
 * and not the other is a difference (only the outermost of a missing subtree is named); its own words and its
 * computed values for OUTSIDE_PROPERTIES are compared wherever it sits now, so a layout that moved is not a
 * difference. Words that changed only from the edit's old words to its new ones are the save's reach. Pixels are then
 * compared only inside elements that kept their place and size, changed nothing, and hold nothing that did.
 */
export function compareOutside(o: {
  before: PageSnap; result: PageSnap; width: number; against: { edit: string; at: number };
  words: { was: string; now: string } | null; masked: { before: readonly LayerRect[]; result: readonly LayerRect[] };
  /** Paths the page did not agree on with itself (unstableOf): set aside with everything inside them. */
  unstable?: readonly string[];
}): OutsideFound {
  const { before: A, result: B } = o;
  const byA = new Map(A.elements.map((e) => [e.path, e]));
  const byB = new Map(B.elements.map((e) => [e.path, e]));
  const value = (snap: PageSnap, el: PageElement, key: string): string | undefined => {
    const i = snap.keys.indexOf(key);
    return i < 0 ? undefined : snap.table[el.values[i] ?? -1];
  };
  const keys = OUTSIDE_PROPERTIES.filter((k) => A.keys.includes(k) && B.keys.includes(k));
  const paths = [...A.elements.map((e) => e.path), ...B.elements.filter((e) => !byA.has(e.path)).map((e) => e.path)];
  const differences: LayerDifference[] = [];
  const reach: OutsideFound['reach'] = [];
  const changed = new Set<string>();
  const say = (el: PageElement, property: string, before: string, result: string): void => {
    changed.add(el.path);
    if (differences.length < MAX_ELEMENT_DIFFERENCES) differences.push({ kind: 'outside', width: o.width, element: el.name, property, before: before.slice(0, 2_000), result: result.slice(0, 2_000), against: o.against });
  };
  const unstable = o.unstable ?? [];
  const aside = (path: string): boolean => unstable.some((u) => path === u || path.startsWith(`${u} > `));
  for (const path of paths) {
    const a = byA.get(path), b = byB.get(path);
    if (a?.touched || b?.touched || aside(path)) continue;
    if ((a && o.masked.before.some((m) => contains(m, a.box))) || (b && o.masked.result.some((m) => contains(m, b.box)))) continue;
    if (!a || !b) {
      // A whole subtree on one page and not the other: its outermost element says it.
      const up = parentPath(path);
      if (b && !a && up && !byA.has(up) && byB.has(up)) continue;
      if (a && !b && up && !byB.has(up) && byA.has(up)) continue;
      say((a ?? b)!, 'element', a ? 'on the page' : 'not on the page', b ? 'on the page' : 'not on the page');
      continue;
    }
    if (a.text !== b.text) {
      if (o.words && sameWordsMoved(a.text, b.text, o.words)) { reach.push({ path, name: b.name }); changed.add(path); }
      else say(b, 'text', a.text ?? '', b.text ?? '');
    }
    for (const k of keys) {
      const va = value(A, a, k) ?? '', vb = value(B, b, k) ?? '';
      if (va !== vb) say(b, k, va, vb);
    }
  }
  // Which elements kept their place and size, changed nothing, and hold nothing that did not: children first.
  const children = new Map<string, string[]>();
  for (const path of paths) {
    const up = parentPath(path);
    if (up) children.set(up, [...(children.get(up) ?? []), path]);
  }
  const stable = new Map<string, boolean>();
  const stableBelow = new Map<string, boolean>();
  for (const path of [...paths].reverse()) {
    const a = byA.get(path), b = byB.get(path);
    const kids = children.get(path) ?? [];
    stable.set(path, !!a && !!b && sameRect(a.box, b.box) && !changed.has(path) && kids.every((k) => stable.get(k)));
    stableBelow.set(path, kids.some((k) => stable.get(k) || stableBelow.get(k)));
  }
  const include: LayerRect[] = [];
  const exclude: LayerRect[] = [];
  for (const path of paths) {
    const a = byA.get(path), b = byB.get(path);
    if (stable.get(path)) {
      if (!stable.get(parentPath(path)) && b && !b.touched) include.push(b.box);
      continue;
    }
    if (reach.some((r) => r.path === path) || !stableBelow.get(path)) {
      if (a) exclude.push(a.box);
      if (b) exclude.push(b.box);
    }
  }
  return { differences, reach, include, exclude };
}

/** Each edit's reach, over every width, as a verdict says it: how many places, and what each is called. */
export function reachOf(found: readonly { edit: string; reach: readonly { path: string; name: string }[] }[]): LayerReach[] {
  const by = new Map<string, Map<string, string>>();
  for (const f of found) {
    const m = by.get(f.edit) ?? new Map<string, string>();
    for (const r of f.reach) if (!m.has(r.path)) m.set(r.path, r.name);
    by.set(f.edit, m);
  }
  return [...by].filter(([, m]) => m.size > 0).slice(0, 20).map(([edit, m]) => ({ edit, count: m.size, places: [...m.values()].slice(0, 10).map((n) => n.slice(0, 200)) }));
}

/* ── step 1: styles and boxes ───────────────────────────────────────────── */

/** One touched element as a render shows it: the edit that tagged it, which of that edit's elements it is, its values and box. */
export interface ElementSnap {
  edit: string;
  /** Its place among the edit's elements, in document order (from 0). */
  n: number;
  /** What the tray calls it: `h2.card__title`. */
  element: string;
  /** Computed values for the layer's properties, and `text` for its own words when it holds only words. */
  values: Record<string, string>;
  /** In CSS pixels of the document. */
  box: LayerRect;
}

const sameBox = (a: LayerRect, b: LayerRect): boolean =>
  [a.x - b.x, a.y - b.y, a.width - b.width, a.height - b.height].every((d) => Math.abs(d) < 0.01);

/** Step 1 at one width: every value and box of a touched element the result does not share with the design. */
export function compareElements(design: readonly ElementSnap[], result: readonly ElementSnap[], width: number): LayerDifference[] {
  const key = (s: ElementSnap): string => `${s.edit}\n${s.n}`;
  const theirs = new Map(result.map((s) => [key(s), s]));
  const out: LayerDifference[] = [];
  const seen = new Set<string>();
  for (const d of design) {
    seen.add(key(d));
    const r = theirs.get(key(d));
    if (!r) { out.push({ kind: 'style', edit: d.edit, width, element: d.element, property: 'element', design: 'on the page', result: 'not on the page' }); continue; }
    for (const property of [...new Set([...Object.keys(d.values), ...Object.keys(r.values)])]) {
      const a = d.values[property] ?? '';
      const b = r.values[property] ?? '';
      if (a !== b) out.push({ kind: 'style', edit: d.edit, width, element: d.element, property, design: a, result: b });
    }
    if (!sameBox(d.box, r.box)) out.push({ kind: 'box', edit: d.edit, width, element: d.element, design: d.box, result: r.box });
  }
  for (const r of result) {
    if (!seen.has(key(r))) out.push({ kind: 'style', edit: r.edit, width, element: r.element, property: 'element', design: 'not on the page', result: 'on the page' });
  }
  return out.slice(0, MAX_ELEMENT_DIFFERENCES);
}

/**
 * Step 1 for tokens at one width: each token's custom property, as the page's root computes it, the same in the result
 * as in the design. A value that could not be read, or one the design does not show, is a difference: a token is never
 * passed for want of a comparison.
 */
export function compareTokens(
  tokens: readonly { edit: string; name: string }[], design: Readonly<Record<string, string>> | undefined, result: Readonly<Record<string, string>> | undefined, width: number,
): LayerDifference[] {
  const out: LayerDifference[] = [];
  for (const t of tokens) {
    const a = design?.[t.name], b = result?.[t.name];
    if (a === undefined || b === undefined || !a || a !== b) {
      out.push({ kind: 'style', edit: t.edit, width, element: ':root', property: t.name, design: a === undefined ? 'not read' : a || 'not set', result: b === undefined ? 'not read' : b || 'not set' });
    }
  }
  return out.slice(0, MAX_ELEMENT_DIFFERENCES);
}

/* ── steps 2 and 3: pixels near the touched elements, and the rest ───────── */

/** Where an edit shows: a touched element's box in either render, with the margin around it. */
export interface Zone { edit: string | null; rect: LayerRect }

/** The zones of the touched elements, from both renders' boxes, each grown by the margin and kept on the page. */
export function zonesOf(design: readonly ElementSnap[], result: readonly ElementSnap[], margin = ZONE_MARGIN): Zone[] {
  return [...design, ...result].map((s) => ({
    edit: s.edit,
    rect: { x: s.box.x - margin, y: s.box.y - margin, width: s.box.width + margin * 2, height: s.box.height + margin * 2 },
  }));
}

export interface PixelArea extends Noise {
  differences: LayerDifference[];
}

export interface PixelComparison {
  /** Inside the zones (step 2). */
  near: PixelArea;
  /** Everywhere else (step 3). */
  rest: PixelArea;
}

/**
 * Steps 2 and 3 at one width: the differing pixels split into those inside a zone and the rest, each area's two
 * numbers, and its differing pixels boxed. A box inside the zones is tied to the edit whose zone holds most of its
 * pixels; a box outside them is a leak. Zones are taken in the order given: where two overlap, the first holds it.
 */
export function comparePixels(d: PixelDiff, zones: readonly Zone[], width: number): PixelComparison {
  const W = d.width, H = d.height;
  const zoneOf = new Int32Array(W * H).fill(-1);
  zones.forEach((z, index) => {
    const x0 = Math.max(0, Math.floor(z.rect.x)), y0 = Math.max(0, Math.floor(z.rect.y));
    const x1 = Math.min(W, Math.ceil(z.rect.x + z.rect.width)), y1 = Math.min(H, Math.ceil(z.rect.y + z.rect.height));
    for (let y = y0; y < y1; y++) for (let p = y * W + x0, end = y * W + x1; p < end; p++) if (zoneOf[p] === -1) zoneOf[p] = index;
  });
  const area = (near: boolean): PixelArea => {
    const marks = new Uint8Array(W * H);
    let maxDiff = 0, pixels = 0;
    for (let p = 0; p < marks.length; p++) {
      const v = d.diff[p]!;
      if (!v || (zoneOf[p]! >= 0) !== near) continue;
      marks[p] = 1;
      pixels++;
      if (v > maxDiff) maxDiff = v;
    }
    if (!pixels) return { maxDiff, pixels, differences: [] };
    const found = changeBoxes(marks, W, H, 16, 0, (m) => m === 1).map((rect) => {
      let count = 0, most = 0;
      const votes = new Map<number, number>();
      for (let y = rect.y; y < rect.y + rect.height; y++) {
        for (let x = rect.x; x < rect.x + rect.width; x++) {
          const p = y * W + x;
          if (!marks[p]) continue;
          count++;
          if (d.diff[p]! > most) most = d.diff[p]!;
          if (near) votes.set(zoneOf[p]!, (votes.get(zoneOf[p]!) ?? 0) + 1);
        }
      }
      let zone = -1, best = 0;
      for (const [z, n] of votes) if (n > best) { zone = z; best = n; }
      return { rect, count, most, edit: zone >= 0 ? zones[zone]!.edit : null };
    }).sort((a, b) => b.count - a.count).slice(0, MAX_RECTS);
    const differences: LayerDifference[] = found.map((f) => (near
      ? { kind: 'pixels', edit: f.edit, width, rect: f.rect, pixels: f.count, maxDiff: f.most }
      : { kind: 'leak', width, rect: f.rect, pixels: f.count, maxDiff: f.most }));
    return { maxDiff, pixels, differences };
  };
  return { near: area(true), rest: area(false) };
}

/* ── the verdict ────────────────────────────────────────────────────────── */

/**
 * What one width found: step 1's differences, its noise floor, steps 2 and 3, and step 3 against each edit's page
 * from before, where it ran: element by element (`outside`) and pixels where the layout kept still (`before`).
 */
export interface WidthFindings {
  width: number;
  noise: Noise;
  elements: LayerDifference[];
  pixels: PixelComparison;
  before?: PixelArea[];
  outside?: LayerDifference[];
}

/** The steps in order across every width: the first that fails at any width decides, and only its differences are said. */
export function judge(found: readonly WidthFindings[]): { ok: boolean; failed: VerifyStep | null; differences: LayerDifference[] } {
  for (const step of VERIFY_STEPS) {
    const differences: LayerDifference[] = [];
    let failed = false;
    for (const w of found) {
      if (step === 'styles' && w.elements.length) { failed = true; differences.push(...w.elements); }
      if (step === 'pixels' && !withinNoise(w.pixels.near, w.noise)) { failed = true; differences.push(...w.pixels.near.differences); }
      if (step === 'rest' && !withinNoise(w.pixels.rest, w.noise)) { failed = true; differences.push(...w.pixels.rest.differences); }
      if (step === 'rest' && w.outside?.length) { failed = true; differences.push(...w.outside); }
      if (step === 'rest') for (const b of w.before ?? []) if (!withinLoads(b, w.noise)) { failed = true; differences.push(...b.differences); }
    }
    if (failed) return { ok: false, failed: step, differences: differences.slice(0, MAX_DIFFERENCES) };
  }
  return { ok: true, failed: null, differences: [] };
}

/** The noise floor a verdict states: the largest of each number over its widths. */
export const verdictNoise = (found: readonly WidthFindings[]): Noise => widestNoise(found.map((w) => w.noise));

/** The widest of several noise floors: the largest of each number. */
export const widestNoise = (floors: readonly Noise[]): Noise => ({
  maxDiff: Math.max(0, ...floors.map((n) => n.maxDiff)),
  pixels: Math.max(0, ...floors.map((n) => n.pixels)),
});

/**
 * Step 3 against an edit's page from before: the leaks of a comparison of the result with that page, said as against
 * it (which edit's, kept when).
 */
export function against(area: PixelArea, edit: string, at: number): PixelArea {
  return { ...area, differences: area.differences.map((d) => (d.kind === 'leak' ? { ...d, against: { edit, at } } : d)) };
}

/**
 * The edits a failed verdict is about: those its differences name (a leak against an edit's page from before names
 * that edit); every edit when one is not tied to any (a leak against the design).
 */
export function editsAt(verdict: Pick<LayerVerdict, 'ok' | 'differences'>, ids: readonly string[]): string[] {
  if (verdict.ok) return [];
  const named = new Set<string>();
  for (const d of verdict.differences) {
    if (d.kind === 'outside' || (d.kind === 'leak' && d.against)) { named.add(d.against!.edit); continue; }
    if (d.kind === 'leak' || d.edit === null) return [...ids];
    named.add(d.edit);
  }
  return named.size ? ids.filter((id) => named.has(id)) : [...ids];
}

/**
 * The picture of a difference: the result, faded to grey, with every differing pixel past the noise floor in
 * magenta, and what was left out (masked) in pale green. Grey is the average of the colour channels, and magenta and
 * the green have their red and blue equal, so the picture is the same whichever order the capture keeps its channels in.
 */
export function diffPicture(result: Bitmap, d: PixelDiff, noise: Noise): Bitmap {
  const out = new Uint8Array(d.width * d.height * 4);
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      const p = y * d.width + x;
      const o = p * 4;
      if (d.diff[p]! > noise.maxDiff) { out[o] = 255; out[o + 1] = 0; out[o + 2] = 255; out[o + 3] = 255; continue; }
      if (d.masked?.[p]) { out[o] = 200; out[o + 1] = 232; out[o + 2] = 200; out[o + 3] = 255; continue; }
      let grey = 255;
      if (x < result.width && y < result.height) {
        const i = (y * result.width + x) * 4;
        grey = Math.round((result.data[i]! + result.data[i + 1]! + result.data[i + 2]!) / 3);
      }
      const faded = Math.round(255 - (255 - grey) * 0.35);
      out[o] = faded; out[o + 1] = faded; out[o + 2] = faded; out[o + 3] = 255;
    }
  }
  return { data: out, width: d.width, height: d.height };
}

/** Two comparisons of one width as one picture: per pixel the larger difference, and masked only where both left it out. */
export function unionDiff(a: PixelDiff, b: PixelDiff): PixelDiff {
  const width = Math.max(a.width, b.width), height = Math.max(a.height, b.height);
  const diff = new Uint8Array(width * height);
  const masked = a.masked || b.masked ? new Uint8Array(width * height) : undefined;
  let maxDiff = 0, pixels = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const at = (d: PixelDiff): number => (x < d.width && y < d.height ? d.diff[y * d.width + x]! : 0);
      const left = (d: PixelDiff): boolean => x < d.width && y < d.height && !!d.masked?.[y * d.width + x];
      const v = Math.max(at(a), at(b));
      if (masked && left(a) && left(b)) masked[p] = 1;
      if (!v) continue;
      diff[p] = v;
      pixels++;
      if (v > maxDiff) maxDiff = v;
    }
  }
  return { width, height, diff, maxDiff, pixels, ...(masked ? { masked } : {}) };
}

/* ── a verdict from outside, checked ────────────────────────────────────── */

const EDIT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const bounded = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const count = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max;
const time = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const widthList = (v: unknown): v is number[] => Array.isArray(v) && v.length >= 1 && v.length <= 8 && v.every((w) => count(w, 10_000));

/** The fields a verdict gained later, each checked when present: absent on a verdict kept before them. Undefined when one is not well formed. */
function later(v: Record<string, unknown>): Pick<LayerVerdict, 'masked' | 'before' | 'held' | 'cut' | 'reach'> | undefined {
  const out: Pick<LayerVerdict, 'masked' | 'before' | 'held' | 'cut' | 'reach'> = {};
  if (v.reach !== undefined) {
    if (!Array.isArray(v.reach) || v.reach.length > 20) return undefined;
    const reach: LayerReach[] = [];
    for (const raw of v.reach as unknown[]) {
      const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
      if (!r || typeof r.edit !== 'string' || !EDIT_ID.test(r.edit) || !count(r.count, 100_000) || !r.count || !Array.isArray(r.places) || !r.places.length || r.places.length > 10
        || r.places.length > r.count || !r.places.every((p) => bounded(p, 200) && p)) return undefined;
      reach.push({ edit: r.edit, count: r.count, places: [...r.places as string[]] });
    }
    out.reach = reach;
  }
  if (v.masked !== undefined) {
    if (!Array.isArray(v.masked) || v.masked.length > MAX_MASKS) return undefined;
    const masked: LayerMask[] = [];
    for (const raw of v.masked as unknown[]) {
      const m = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
      if (!m || !bounded(m.label, 200) || !m.label || !bounded(m.why, 300) || !m.why || !widthList(m.widths) || typeof m.nearEdit !== 'boolean') return undefined;
      masked.push({ label: m.label, why: m.why, widths: [...m.widths], nearEdit: m.nearEdit });
    }
    out.masked = masked;
  }
  if (v.before !== undefined) {
    const b = v.before && typeof v.before === 'object' ? v.before as Record<string, unknown> : null;
    if (b?.ran === true && time(b.at) && widthList(b.widths)) out.before = { ran: true, at: b.at, widths: [...b.widths] };
    else if (b?.ran === false && bounded(b.why, 600) && b.why) out.before = { ran: false, why: b.why };
    else return undefined;
  }
  if (v.held !== undefined) {
    if (v.held === null) out.held = null;
    else if (v.held && typeof v.held === 'object' && count((v.held as Record<string, unknown>).at)) out.held = { at: (v.held as { at: number }).at };
    else return undefined;
  }
  if (v.cut !== undefined) {
    if (!Array.isArray(v.cut) || v.cut.length > 8) return undefined;
    const cut: LayerCut[] = [];
    for (const raw of v.cut as unknown[]) {
      const c = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
      if (!c || !count(c.width, 10_000) || !count(c.to, 1_000_000) || !count(c.full, 1_000_000) || c.full <= c.to) return undefined;
      cut.push({ width: c.width, to: c.to, full: c.full });
    }
    out.cut = cut;
  }
  return out;
}

function rect(raw: unknown): LayerRect | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const n = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1_000_000;
  return n(r.x) && n(r.y) && n(r.width) && n(r.height) && r.width >= 0 && r.height >= 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
}

function difference(raw: unknown): LayerDifference | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (!count(d.width, 10_000)) return null;
  const width = d.width;
  switch (d.kind) {
    case 'style':
      return typeof d.edit === 'string' && EDIT_ID.test(d.edit) && bounded(d.element, 200) && bounded(d.property, 60) && bounded(d.design, 2000) && bounded(d.result, 2000)
        ? { kind: 'style', edit: d.edit, width, element: d.element, property: d.property, design: d.design, result: d.result } : null;
    case 'box': {
      const design = rect(d.design), result = rect(d.result);
      return typeof d.edit === 'string' && EDIT_ID.test(d.edit) && bounded(d.element, 200) && design && result
        ? { kind: 'box', edit: d.edit, width, element: d.element, design, result } : null;
    }
    case 'pixels': {
      const r = rect(d.rect);
      const edit = d.edit === null ? null : typeof d.edit === 'string' && EDIT_ID.test(d.edit) ? d.edit : undefined;
      return r && edit !== undefined && count(d.pixels) && count(d.maxDiff, 255) ? { kind: 'pixels', edit, width, rect: r, pixels: d.pixels, maxDiff: d.maxDiff } : null;
    }
    case 'leak': {
      const r = rect(d.rect);
      if (!r || !count(d.pixels) || !count(d.maxDiff, 255)) return null;
      if (d.against === undefined) return { kind: 'leak', width, rect: r, pixels: d.pixels, maxDiff: d.maxDiff };
      const a = d.against && typeof d.against === 'object' ? d.against as Record<string, unknown> : null;
      return a && typeof a.edit === 'string' && EDIT_ID.test(a.edit) && time(a.at)
        ? { kind: 'leak', width, rect: r, pixels: d.pixels, maxDiff: d.maxDiff, against: { edit: a.edit, at: a.at } } : null;
    }
    case 'outside': {
      const a = d.against && typeof d.against === 'object' ? d.against as Record<string, unknown> : null;
      return bounded(d.element, 200) && bounded(d.property, 60) && bounded(d.before, 2000) && bounded(d.result, 2000) && a && typeof a.edit === 'string' && EDIT_ID.test(a.edit) && time(a.at)
        ? { kind: 'outside', width, element: d.element, property: d.property, before: d.before, result: d.result, against: { edit: a.edit, at: a.at } } : null;
    }
    default: return null;
  }
}

/**
 * A verdict as the main process sent it (or as the core kept it), checked and bounded; null when it is not one. A
 * verdict that passed failed no step, and one that failed names the step. The fields a verdict gained later are
 * checked when present and left absent when not, so a verdict kept before them still reads.
 */
export function parseVerdict(raw: unknown): LayerVerdict | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.at !== 'number' || !Number.isFinite(v.at) || v.at < 0 || typeof v.ok !== 'boolean') return null;
  const failed = v.failed === null ? null : (VERIFY_STEPS as readonly unknown[]).includes(v.failed) ? v.failed as VerifyStep : undefined;
  if (failed === undefined || v.ok !== (failed === null)) return null;
  if (!Array.isArray(v.widths) || v.widths.length < 1 || v.widths.length > 8 || !v.widths.every((w) => count(w, 10_000))) return null;
  const noise = v.noise && typeof v.noise === 'object' ? v.noise as Record<string, unknown> : null;
  if (!noise || !count(noise.maxDiff, 255) || !count(noise.pixels)) return null;
  if (!Array.isArray(v.differences) || v.differences.length > MAX_DIFFERENCES) return null;
  const differences = v.differences.map(difference);
  if (differences.some((d) => d === null)) return null;
  if (!Array.isArray(v.pictures) || v.pictures.length > 8) return null;
  const pictures: LayerVerdict['pictures'] = [];
  for (const p of v.pictures as unknown[]) {
    if (!p || typeof p !== 'object') return null;
    const q = p as Record<string, unknown>;
    if (!count(q.width, 10_000) || !bounded(q.design, 2000) || !bounded(q.result, 2000) || (q.diff !== null && !bounded(q.diff, 2000))) return null;
    if (q.before !== undefined && q.before !== null && !bounded(q.before, 2000)) return null;
    pictures.push({ width: q.width, design: q.design, result: q.result, diff: q.diff as string | null, ...(q.before !== undefined ? { before: q.before as string | null } : {}) });
  }
  const more = later(v);
  if (!more) return null;
  return {
    at: v.at, ok: v.ok, failed, widths: [...v.widths as number[]],
    noise: { maxDiff: noise.maxDiff, pixels: noise.pixels },
    differences: differences as LayerDifference[], pictures, ...more,
  };
}
