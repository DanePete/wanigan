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
// The steps run in that order and the first that fails decides the verdict.
//
// The noise floor is measured by rendering the result twice: the largest channel difference between the two, and
// how many pixels differ at all. Those two numbers are the tolerance, in the manner of the web-platform-tests
// "fuzzy" annotation (never a percentage, no anti-aliasing forgiveness): an area passes when its largest difference
// and its count of differing pixels are each within them.
import { VERIFY_STEPS, type LayerDifference, type LayerRect, type LayerVerdict, type VerifyStep } from './design-layer.ts';
import { changeBoxes } from './live-compare.ts';

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

/** Per pixel, the largest difference of any channel (0–255), over the larger of the two sizes: where only one has pixels, 255. */
export interface PixelDiff { width: number; height: number; diff: Uint8Array; maxDiff: number; pixels: number }

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

export function noiseFloor(first: Bitmap, second: Bitmap): Noise {
  const d = diffBitmaps(first, second);
  return { maxDiff: d.maxDiff, pixels: d.pixels };
}

/** Whether an area's differences are within the noise floor: both numbers. */
export const withinNoise = (area: Noise, noise: Noise): boolean => area.maxDiff <= noise.maxDiff && area.pixels <= noise.pixels;

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

/** What one width found: step 1's differences, its noise floor, and steps 2 and 3. */
export interface WidthFindings {
  width: number;
  noise: Noise;
  elements: LayerDifference[];
  pixels: PixelComparison;
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

/** The edits a failed verdict is about: those its differences name; every edit when one is not tied to any (a leak). */
export function editsAt(verdict: Pick<LayerVerdict, 'ok' | 'differences'>, ids: readonly string[]): string[] {
  if (verdict.ok) return [];
  const named = new Set<string>();
  for (const d of verdict.differences) {
    if (d.kind === 'leak' || d.edit === null) return [...ids];
    named.add(d.edit);
  }
  return named.size ? ids.filter((id) => named.has(id)) : [...ids];
}

/**
 * The picture of a difference: the result, faded to grey, with every differing pixel past the noise floor in
 * magenta. Grey is the average of the colour channels and magenta has its red and blue equal, so the picture is the
 * same whichever order the capture keeps its channels in.
 */
export function diffPicture(result: Bitmap, d: PixelDiff, noise: Noise): Bitmap {
  const out = new Uint8Array(d.width * d.height * 4);
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      const p = y * d.width + x;
      const o = p * 4;
      if (d.diff[p]! > noise.maxDiff) { out[o] = 255; out[o + 1] = 0; out[o + 2] = 255; out[o + 3] = 255; continue; }
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

/* ── a verdict from outside, checked ────────────────────────────────────── */

const EDIT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const bounded = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const count = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max;

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
      return r && count(d.pixels) && count(d.maxDiff, 255) ? { kind: 'leak', width, rect: r, pixels: d.pixels, maxDiff: d.maxDiff } : null;
    }
    default: return null;
  }
}

/** A verdict as the main process sent it, checked and bounded; null when it is not one. A verdict that passed failed no step, and one that failed names the step. */
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
    pictures.push({ width: q.width, design: q.design, result: q.result, diff: q.diff as string | null });
  }
  return {
    at: v.at, ok: v.ok, failed, widths: [...v.widths as number[]],
    noise: { maxDiff: noise.maxDiff, pixels: noise.pixels },
    differences: differences as LayerDifference[], pictures,
  };
}
