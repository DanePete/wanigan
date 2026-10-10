// Try a style's fields, as numbers and words (components/live/StyleFields.tsx draws them, LayerEdits.tsx holds the
// form). Pure, so node's test runner reads it as the window does.
//
// - Each length is a slider and a number box bound together, in px. Its range is a sensible one for the property,
//   widened (never clamped) to take in the site's value and the value now. A value is never below the property's
//   floor (a padding is never negative), and a step is the property's own, ten of them with Shift.
// - A weight steps by a hundred, each with its name (Light, Regular, …, Extra bold).
// - A colour is typed as hex or rgb() (or any colour the browser reads, or the site's own custom property), or chosen
//   from the colours the page's root names.
// - Previews are sent at most once a frame and one at a time, the last always (previewPump): a slider fires many
//   changes a second, and a loop of calls into a live page has held its thread at 100% before.
import type { LayerProperty } from '../../../shared/design-layer.ts';
import { layerValue } from '../../../shared/design-layer.ts';

/** A length's slider and box: its range before widening, its step, the least value it takes (null: negatives too), its unit. */
export interface LengthSpec {
  min: number;
  max: number;
  step: number;
  floor: number | null;
  unit: 'px' | '';
}

const BOX: LengthSpec = { min: 0, max: 160, step: 1, floor: 0, unit: 'px' };

/** The ranges, by property: text size about 8–96, letter spacing with negatives and half steps, padding and margins 0–160, corners 0–48, gap 0–96. */
export const LENGTHS: Partial<Record<LayerProperty, LengthSpec>> = {
  'font-size': { min: 8, max: 96, step: 1, floor: 1, unit: 'px' },
  'font-weight': { min: 300, max: 800, step: 100, floor: 1, unit: '' },
  'line-height': { min: 0, max: 160, step: 1, floor: 0, unit: 'px' },
  'letter-spacing': { min: -5, max: 20, step: 0.5, floor: null, unit: 'px' },
  'padding-top': BOX, 'padding-right': BOX, 'padding-bottom': BOX, 'padding-left': BOX,
  'margin-top': { ...BOX, floor: null }, 'margin-right': { ...BOX, floor: null }, 'margin-bottom': { ...BOX, floor: null }, 'margin-left': { ...BOX, floor: null },
  'border-radius': { min: 0, max: 48, step: 1, floor: 0, unit: 'px' },
  gap: { min: 0, max: 96, step: 1, floor: 0, unit: 'px' },
};

/** The most a weight can be: CSS takes 1 to 1000. */
const WEIGHT_MAX = 1000;

/** A number as the box shows it: at most two decimals, no trailing zeros, never "-0". */
export function fmt(n: number): string {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
}

/** A computed value as a number of the spec's unit: `16px` → 16, `400` → 400 for a weight; null for a keyword (`normal`), a percentage or a list. */
export function numberOf(css: string | undefined, spec: LengthSpec): number | null {
  const v = (css ?? '').trim();
  const m = spec.unit === 'px' ? /^(-?\d*\.?\d+)(px)?$/.exec(v) : /^(-?\d*\.?\d+)$/.exec(v);
  if (!m) return null;
  // A bare number is a length only when it is zero (`0` is `0px`); a weight is always bare.
  if (spec.unit === 'px' && !m[2] && Number(m[1]) !== 0) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** A number as the value the layer sets: `16px`, or `600` for a weight. */
export const cssOf = (n: number, spec: LengthSpec): string => `${fmt(n)}${spec.unit}`;

/** The slider's range: the spec's, widened to take in every value given (the site's, the one now). Never narrowed, never clamping one. */
export function rangeOf(spec: LengthSpec, ...values: (number | null)[]): { min: number; max: number } {
  let { min, max } = spec;
  for (const v of values) {
    if (v === null || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/** Where a value sits along a range, 0 to 1: the slider's fill and the mark for the site's value. */
export function fraction(n: number, range: { min: number; max: number }): number {
  if (range.max <= range.min) return 0;
  return Math.min(1, Math.max(0, (n - range.min) / (range.max - range.min)));
}

/** A dragged value on the property's steps (the slider itself takes any value, so the site's own shows where it is). */
export function snap(n: number, spec: LengthSpec): number {
  const s = Math.round(n / spec.step) * spec.step;
  return Number(s.toFixed(4));
}

/** Whether a number is one the property takes: not below its floor (a negative padding is no padding), a weight 1 to 1000. */
export function allowed(n: number, spec: LengthSpec): boolean {
  if (!Number.isFinite(n)) return false;
  if (spec.floor !== null && n < spec.floor) return false;
  return spec.unit !== '' || n <= WEIGHT_MAX;
}

/**
 * One step from `n` by the keyboard: the property's step, ten of them with Shift (a weight's hundred stays a hundred),
 * from the step's grid, never past the floor or a weight's 1000. `dir` is 1 up, -1 down.
 */
export function stepped(n: number, dir: 1 | -1, shift: boolean, spec: LengthSpec): number {
  const by = spec.unit === '' ? spec.step : spec.step * (shift ? 10 : 1);
  // Off the grid (a site's 15.2px), the first step lands on it: 16 up, 15 down.
  const onGrid = Math.abs(n / spec.step - Math.round(n / spec.step)) < 1e-6;
  let next = onGrid ? n + dir * by : (dir > 0 ? Math.ceil(n / spec.step) : Math.floor(n / spec.step)) * spec.step + (by - spec.step) * dir;
  next = Number(next.toFixed(4));
  if (spec.floor !== null && next < spec.floor) next = spec.floor;
  if (spec.unit === '' && next > WEIGHT_MAX) next = WEIGHT_MAX;
  return next;
}

/** A box's words as a number: what was typed, with a unit or not; null while it is not one yet ("-", "1.", "abc"). */
export function typedNumber(text: string, spec: LengthSpec): number | null {
  const m = (spec.unit === 'px' ? /^\s*(-?\d*\.?\d+)\s*(?:px)?\s*$/i : /^\s*(-?\d*\.?\d+)\s*$/).exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Where a slider stands for a value that is a keyword: letter spacing and gap `normal` are no extra space (0), and line
 * height `normal` stands near the text's own size (1.2 of it, the usual normal): only where the thumb starts, never a
 * value sent until the owner moves it.
 */
export function anchorOf(prop: LayerProperty, css: string, fontPx: number | null): number | null {
  if (css.trim() !== 'normal') return null;
  if (prop === 'letter-spacing' || prop === 'gap' || prop === 'row-gap' || prop === 'column-gap') return 0;
  if (prop === 'line-height' && fontPx !== null) return Math.round(fontPx * 1.2);
  return null;
}

/* ── weight ── */

const WEIGHT_NAMES: Record<number, string> = {
  100: 'Thin', 200: 'Extra light', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra bold', 900: 'Black',
};

/** A weight's name (600: Semibold), or null between the hundreds (a variable font's 450). */
export const weightName = (n: number): string | null => WEIGHT_NAMES[n] ?? null;

/** What a slider says to a screen reader: "16 px", "Semibold, 600", "normal, the site's". */
export function valueText(n: number | null, spec: LengthSpec, keyword: string | null): string {
  if (n === null) return keyword ? `${keyword}, the site’s` : 'not set';
  if (spec.unit === '') { const name = weightName(n); return name ? `${name}, ${fmt(n)}` : fmt(n); }
  return `${fmt(n)} px`;
}

/* ── colour ── */

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*(\d{1,3}(?:\.\d+)?%?)\s*(?:,\s*|\s+)(\d{1,3}(?:\.\d+)?%?)\s*(?:,\s*|\s+)(\d{1,3}(?:\.\d+)?%?)\s*(?:(?:,|\/)\s*(\d*\.?\d+%?)\s*)?\)$/i;
const SITE_VAR = /^var\(\s*(--[a-z0-9][a-z0-9-]{0,99})\s*\)$/i;

/** A custom property a value names (`var(--brand)` → `--brand`), or null. */
export function varName(css: string): string | null {
  return SITE_VAR.exec(css.trim())?.[1] ?? null;
}

/**
 * What a colour box takes, as the value the layer sets, or null: hex (#rgb, #rrggbb, with alpha too), rgb() or rgba()
 * in either syntax, the site's own custom property (`var(--brand)`), or any colour `supports` (the browser's
 * CSS.supports) reads, as long as the layer would print it.
 */
export function colourValue(text: string, supports?: (css: string) => boolean): string | null {
  const v = text.trim();
  if (!v || layerValue(v) === null) return null;
  if (HEX.test(v)) return v.toLowerCase();
  const rgb = RGB.exec(v);
  if (rgb) {
    const channel = (c: string): boolean => (c.endsWith('%') ? Number.parseFloat(c) <= 100 : Number(c) <= 255);
    return [rgb[1], rgb[2], rgb[3]].every((c) => channel(c as string)) ? v : null;
  }
  if (SITE_VAR.test(v)) return v;
  return supports?.(v) ? v : null;
}

/** `rgb(1, 2, 3)` or `rgba(…, 0.5)` as `#010203` (what the system's colour panel takes); null for a transparent colour or one it cannot say. */
export function hexOf(css: string): string | null {
  const v = css.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join('')}`.toLowerCase();
  const m = RGB.exec(v);
  if (!m || [m[1], m[2], m[3]].some((c) => (c as string).endsWith('%'))) return null;
  if (m[4] !== undefined && Number.parseFloat(m[4]) === 0) return null;
  return `#${[m[1], m[2], m[3]].map((n) => Math.round(Number(n)).toString(16).padStart(2, '0')).join('')}`;
}

/** Whether a computed colour shows nothing: `transparent`, or any colour with alpha 0. */
export function isClear(css: string): boolean {
  const v = css.trim().toLowerCase();
  if (v === 'transparent') return true;
  const m = RGB.exec(v);
  return !!m && m[4] !== undefined && Number.parseFloat(m[4]) === 0;
}

/** A colour as its box shows it: hex where it is one, the site's custom property as written, empty for a clear one (its placeholder says none). */
export function colourText(css: string): string {
  if (!css || isClear(css)) return '';
  return hexOf(css) ?? css.trim();
}

/**
 * What a swatch paints for a value: the colour a `var()` names, as the site's palette or tokens give it (`refs`, by
 * custom property), the value itself when it is a colour, or null (nothing to paint).
 */
export function swatchOf(css: string, refs: ReadonlyMap<string, string> | undefined, supports?: (css: string) => boolean): string | null {
  const name = varName(css);
  if (name) return refs?.get(name) ?? null;
  if (!css || isClear(css)) return null;
  return colourValue(css, supports);
}

/* ── previews ── */

export interface PreviewSpec<V> { values: V | null; scope: string }

/**
 * Sends previews to the page at most once a frame and one at a time, the newest winning and the last always sent: a
 * slider dragged fires dozens of changes a second, and each preview is a call into the live page. `set` asks for the
 * values to show; `close` sends a last one at once (none: take the preview away), without waiting for a frame, which a
 * hidden window may never draw. A spec the same as the one sent last is not sent again.
 */
export interface PreviewPump<V> {
  set: (spec: PreviewSpec<V>) => void;
  close: (spec: PreviewSpec<V>) => void;
}

export function previewPump<V>(send: (spec: PreviewSpec<V>) => Promise<unknown>, frame: (run: () => void) => void): PreviewPump<V> {
  let want: PreviewSpec<V> | undefined;
  let last: string | null = null;
  let waiting = false;
  let busy = false;
  let closing = false;
  const keyOf = (s: PreviewSpec<V>): string => (s.values === null ? 'off' : JSON.stringify([s.values, s.scope]));
  const flush = (): void => {
    if (busy || want === undefined) return;
    const spec = want;
    want = undefined;
    const key = keyOf(spec);
    if (key === last) return;
    last = key;
    busy = true;
    void send(spec).catch(() => {}).finally(() => { busy = false; pump(); });
  };
  const pump = (): void => {
    if (busy || want === undefined) return;
    if (closing) { flush(); return; }
    if (waiting) return;
    waiting = true;
    frame(() => { waiting = false; flush(); });
  };
  return {
    set: (spec) => { if (closing) return; want = spec; pump(); },
    close: (spec) => { closing = true; want = spec; pump(); },
  };
}
