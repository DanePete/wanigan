// Comparing two renders of one page: the local site's and a hosted
// environment's (or a card's before and after). Pure maths over RGBA pixels,
// so it is tested without a window: lining the two pages up row by row when
// one is taller, finding the pixels that differ, boxing each area of change,
// naming each box by the local page's part it overlaps, and the viewer's keys.
// Design: docs/design/2026-10-08-live-view.md ("Local and hosted").
import type { LiveRegion } from './live.ts';

/** The widths a page is compared at, in CSS pixels: phone, tablet, desktop (keys 1, 2, 3). */
export const COMPARE_WIDTHS = [390, 768, 1440] as const;
export type CompareWidth = (typeof COMPARE_WIDTHS)[number];
/** A page taller than this is compared down to here, and says so. */
export const COMPARE_MAX_HEIGHT = 8_000;

export interface Rect { x: number; y: number; width: number; height: number }

/** An image's pixels: RGBA, row after row. */
export interface Pixels { data: Uint8ClampedArray | Uint8Array; width: number; height: number }

/**
 * A run of rows in the aligned picture. `same` and `changed` hold rows of both
 * sides, one beside the other; `only-a` holds rows of A with nothing of B
 * beside them, `only-b` the other way round. `a` and `b` are the first row of
 * each side at the band (for a side the band has none of, the row it sits before).
 */
export interface Band {
  kind: 'same' | 'changed' | 'only-a' | 'only-b'; a: number; b: number; rows: number;
  /**
   * A one-sided band could sit this many rows higher or lower and line up just as well: rows repeated around it
   * (a list's items alike at their edges) leave where it was added open. Naming it looks at the whole span.
   */
  slack?: { up: number; down: number };
}

export interface Alignment {
  bands: Band[];
  /** Rows of the aligned picture: the longer page, plus the gaps where the other side has rows of its own. */
  height: number;
  /** Rows that matched exactly. */
  same: number;
}

/* ── lining up two pages ───────────────────────────────────────────────── */

/**
 * A fingerprint of each row, colours rounded so the last bit of a channel
 * does not count. Pixels inside a mask are left out, so an ignored carousel
 * does not stop the rows around it lining up.
 */
export function rowHashes(px: Pixels, masks: readonly Rect[] = []): Uint32Array {
  const { data, width, height } = px;
  const out = new Uint32Array(height);
  for (let y = 0; y < height; y++) {
    const spans = masks.filter((m) => y >= m.y && y < m.y + m.height).map((m) => [Math.max(0, m.x), Math.min(width, m.x + m.width)] as const);
    let h = 0x811c9dc5;
    for (let x = 0; x < width; x++) {
      if (spans.length && spans.some(([x0, x1]) => x >= x0 && x < x1)) continue;
      const i = (y * width + x) * 4;
      h ^= ((data[i]! >> 3) << 10) | ((data[i + 1]! >> 3) << 5) | (data[i + 2]! >> 3);
      h = Math.imul(h, 0x01000193);
    }
    out[y] = h >>> 0;
  }
  return out;
}

/** The longest run of pairs whose second index rises, in order (patience sorting). */
function longestRising(pairs: readonly (readonly [number, number])[]): [number, number][] {
  const tails: number[] = [];
  const prev = new Int32Array(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k++) {
    const j = pairs[k]![1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]!]![1] < j) lo = mid + 1; else hi = mid;
    }
    if (lo > 0) prev[k] = tails[lo - 1]!;
    tails[lo] = k;
  }
  const out: [number, number][] = [];
  for (let k = tails.length ? tails[tails.length - 1]! : -1; k >= 0; k = prev[k]!) out.push([pairs[k]![0], pairs[k]![1]]);
  return out.reverse();
}

/** Rows that occur once in each range, lined up in the longest order both agree on: the anchors of patience diff. */
function anchors(a: ArrayLike<number>, aLo: number, aHi: number, b: ArrayLike<number>, bLo: number, bHi: number): [number, number][] {
  const inA = new Map<number, number>();
  for (let i = aLo; i < aHi; i++) inA.set(a[i]!, inA.has(a[i]!) ? -1 : i);
  const inB = new Map<number, number>();
  for (let j = bLo; j < bHi; j++) {
    const at = inA.get(b[j]!);
    if (at === undefined || at < 0) continue;
    inB.set(b[j]!, inB.has(b[j]!) ? -1 : j);
  }
  const pairs: [number, number][] = [];
  for (const [h, j] of inB) if (j >= 0) pairs.push([inA.get(h)!, j]);
  pairs.sort((x, y) => x[0] - y[0]);
  return longestRising(pairs);
}

/**
 * Which row of A is the same as which row of B, top to bottom (patience diff
 * over row fingerprints): rows equal at the top and bottom, then rows unique
 * to both as anchors, and again between each pair of anchors. A blank row
 * matches many and anchors nothing, so it cannot pull the pages out of line.
 */
export function matchRows(a: ArrayLike<number>, b: ArrayLike<number>): [number, number][] {
  const out: [number, number][] = [];
  const go = (aLo: number, aHi: number, bLo: number, bHi: number, depth: number): void => {
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) out.push([aLo++, bLo++]);
    const tail: [number, number][] = [];
    while (aHi > aLo && bHi > bLo && a[aHi - 1] === b[bHi - 1]) { aHi--; bHi--; tail.push([aHi, bHi]); }
    if (aLo < aHi && bLo < bHi && depth < 48) {
      const found = anchors(a, aLo, aHi, b, bLo, bHi);
      let pa = aLo;
      let pb = bLo;
      for (const [i, j] of found) { go(pa, i, pb, j, depth + 1); out.push([i, j]); pa = i + 1; pb = j + 1; }
      if (found.length) go(pa, aHi, pb, bHi, depth + 1);
    }
    for (let k = tail.length - 1; k >= 0; k--) out.push(tail[k]!);
  };
  go(0, a.length, 0, b.length, 0);
  return out;
}

/** Fewer matching rows than this between two changes are a coincidence (a blank line, a rule), not the pages lining up. */
export const MIN_SAME = 8;

/**
 * Line two pages up. Where they match, rows sit beside each other. Where they
 * differ, rows are paired top-down and compared pixel by pixel; the rows one
 * side has beyond that (a taller block, a section only it has) are a band with
 * nothing beside it on the other side, never compared against unrelated
 * content and never counted as changed pixels.
 */
export function alignRows(a: ArrayLike<number>, b: ArrayLike<number>, minSame = MIN_SAME): Alignment {
  interface Run { same: boolean; a: number; b: number; da: number; db: number }
  const runs: Run[] = [];
  let pa = 0;
  let pb = 0;
  const push = (same: boolean, da: number, db: number): void => {
    if (!da && !db) return;
    const last = runs[runs.length - 1];
    if (last && last.same === same) { last.da += da; last.db += db; } else runs.push({ same, a: pa, b: pb, da, db });
    pa += da;
    pb += db;
  };
  for (const [i, j] of matchRows(a, b)) { push(false, i - pa, j - pb); push(true, 1, 1); }
  push(false, a.length - pa, b.length - pb);

  const merged: Run[] = [];
  for (const r of runs) {
    const same = r.same && !(r.da < minSame && runs.length > 1);
    const last = merged[merged.length - 1];
    if (last && last.same === same) { last.da += r.da; last.db += r.db; } else merged.push({ ...r, same });
  }

  const bands: Band[] = [];
  let same = 0;
  for (const r of merged) {
    if (r.same) { bands.push({ kind: 'same', a: r.a, b: r.b, rows: r.da }); same += r.da; continue; }
    const paired = Math.min(r.da, r.db);
    if (paired) bands.push({ kind: 'changed', a: r.a, b: r.b, rows: paired });
    if (r.da > paired) bands.push({ kind: 'only-a', a: r.a + paired, b: r.b + paired, rows: r.da - paired });
    if (r.db > paired) bands.push({ kind: 'only-b', a: r.a + paired, b: r.b + paired, rows: r.db - paired });
  }
  // How far each one-sided band between two matching runs could slide: while the row above it equals its last row
  // (up), or its first row equals the row below it (down), moving it changes nothing.
  bands.forEach((band, i) => {
    if (band.kind !== 'only-a' && band.kind !== 'only-b') return;
    const rows = band.kind === 'only-a' ? a : b;
    const start = band.kind === 'only-a' ? band.a : band.b;
    const end = start + band.rows;
    const above = bands[i - 1]?.kind === 'same' ? bands[i - 1]!.rows : 0;
    const below = bands[i + 1]?.kind === 'same' ? bands[i + 1]!.rows : 0;
    let up = 0;
    while (up < above && rows[start - up - 1] === rows[end - up - 1]) up++;
    let down = 0;
    while (down < below && rows[start + down] === rows[end + down]) down++;
    if (up || down) band.slack = { up, down };
  });
  return { bands, height: bands.reduce((n, band) => n + band.rows, 0), same };
}

/** Whether a band holds rows of a side. */
const holds = (band: Band, side: 'a' | 'b'): boolean => band.kind !== (side === 'a' ? 'only-b' : 'only-a');

/** The row of one side shown at a row of the aligned picture; null in a gap, where that side has nothing. */
export function sourceRow(al: Alignment, y: number, side: 'a' | 'b'): number | null {
  let start = 0;
  for (const band of al.bands) {
    if (y < start + band.rows) return holds(band, side) ? band[side] + (y - start) : null;
    start += band.rows;
  }
  return null;
}

/** Where a row of one side is in the aligned picture (past the end: the last row). */
export function alignedRow(al: Alignment, row: number, side: 'a' | 'b'): number {
  let start = 0;
  for (const band of al.bands) {
    if (holds(band, side) && row >= band[side] && row < band[side] + band.rows) return start + (row - band[side]);
    start += band.rows;
  }
  return Math.max(0, al.height - 1);
}

/**
 * A rectangle of the aligned picture, in one side's own page: a gap maps to
 * the row it sits before on that side, so it still has a place on the page.
 */
export function pageRect(al: Alignment, r: Rect, side: 'a' | 'b'): Rect {
  const at = (y: number): number => {
    let start = 0;
    for (const band of al.bands) {
      if (y < start + band.rows) return holds(band, side) ? band[side] + (y - start) : band[side];
      start += band.rows;
    }
    const last = al.bands[al.bands.length - 1];
    return last ? last[side] + (holds(last, side) ? last.rows : 0) : 0;
  };
  const top = at(Math.max(0, r.y));
  const bottom = at(Math.max(0, r.y + r.height - 1));
  return { x: r.x, y: top, width: r.width, height: Math.max(1, bottom - top + 1) };
}

/** A rectangle of A's page (an ignored area), where it is in the aligned picture. */
export function alignedRect(al: Alignment, r: Rect): Rect {
  const top = alignedRow(al, r.y, 'a');
  const bottom = alignedRow(al, r.y + r.height - 1, 'a');
  return { x: r.x, y: top, width: r.width, height: Math.max(1, bottom - top + 1) };
}

/* ── which pixels differ ───────────────────────────────────────────────── */

/** What each pixel of the aligned picture is. */
export const ALIKE = 0;
export const DIFFERS = 1;
export const IGNORED = 2;
export const ONE_SIDE = 3;

export interface Difference {
  /** One per pixel of the aligned picture: ALIKE, DIFFERS, IGNORED or ONE_SIDE. */
  marks: Uint8Array;
  width: number;
  height: number;
  /** Pixels that differ. */
  pixels: number;
  /** Pixels compared: neither ignored nor on one side only. */
  compared: number;
}

/**
 * How far apart two colours look, in YIQ (the measure pixelmatch uses):
 * brightness counts most, then the two colour axes.
 */
export function colourDelta(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  const y = (r1 - r2) * 0.29889531 + (g1 - g2) * 0.58662247 + (b1 - b2) * 0.11448223;
  const i = (r1 - r2) * 0.59597799 - (g1 - g2) * 0.2741761 - (b1 - b2) * 0.32180189;
  const q = (r1 - r2) * 0.21147017 - (g1 - g2) * 0.52261711 + (b1 - b2) * 0.31114694;
  return 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
}

/** The largest YIQ distance (pixelmatch's scale) at a threshold from 0 to 1. */
export const maxDelta = (threshold: number): number => 35215 * threshold * threshold;

/**
 * Compare two aligned pages pixel by pixel: only rows that sit beside each
 * other are compared, ignored areas (in aligned coordinates) are skipped, and
 * a lone differing pixel with no differing neighbour is antialiasing noise,
 * not a change.
 */
export function difference(a: Pixels, b: Pixels, al: Alignment, ignored: readonly Rect[] = [], threshold = 0.1): Difference {
  const width = Math.max(a.width, b.width);
  const height = al.height;
  const marks = new Uint8Array(width * height);
  const limit = maxDelta(threshold);
  let y = 0;
  for (const band of al.bands) {
    for (let k = 0; k < band.rows; k++, y++) {
      const row = y * width;
      if (band.kind === 'only-a' || band.kind === 'only-b') { marks.fill(ONE_SIDE, row, row + width); continue; }
      if (band.kind === 'same') continue;
      const ya = band.a + k;
      const yb = band.b + k;
      for (let x = 0; x < width; x++) {
        if (x >= a.width || x >= b.width) { marks[row + x] = DIFFERS; continue; }
        const i = (ya * a.width + x) * 4;
        const j = (yb * b.width + x) * 4;
        if (colourDelta(a.data[i]!, a.data[i + 1]!, a.data[i + 2]!, b.data[j]!, b.data[j + 1]!, b.data[j + 2]!) > limit) marks[row + x] = DIFFERS;
      }
    }
  }
  for (const m of ignored) {
    for (let yy = Math.max(0, m.y); yy < Math.min(height, m.y + m.height); yy++) {
      for (let xx = Math.max(0, m.x); xx < Math.min(width, m.x + m.width); xx++) if (marks[yy * width + xx] !== ONE_SIDE) marks[yy * width + xx] = IGNORED;
    }
  }
  // A differing pixel alone is noise; one with a differing neighbour is part of a change (a 1px border counts).
  const lone: number[] = [];
  for (let p = 0; p < marks.length; p++) {
    if (marks[p] !== DIFFERS) continue;
    const px = p % width;
    const py = (p - px) / width;
    let near = false;
    for (let dy = -1; dy <= 1 && !near; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = px + dx;
        const ny = py + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height && marks[ny * width + nx] === DIFFERS) { near = true; break; }
      }
    }
    if (!near) lone.push(p);
  }
  for (const p of lone) marks[p] = ALIKE;
  let pixels = 0;
  let compared = 0;
  for (let p = 0; p < marks.length; p++) {
    if (marks[p] === DIFFERS) pixels++;
    if (marks[p] === ALIKE || marks[p] === DIFFERS) compared++;
  }
  return { marks, width, height, pixels, compared };
}

/**
 * Areas of change: differing pixels grouped into cells, touching cells (the
 * eight around) into one area, each boxed with a little room and kept inside
 * the picture. Top to bottom, as the page reads. `differs` says which marks
 * count (by default, DIFFERS).
 */
export function changeBoxes(marks: Uint8Array, width: number, height: number, cell = 16, pad = 6, differs = (m: number): boolean => m === DIFFERS): Rect[] {
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const cells = new Uint8Array(cols * rows);
  for (let p = 0; p < marks.length; p++) {
    if (!differs(marks[p]!)) continue;
    const x = p % width;
    cells[Math.floor((p - x) / width / cell) * cols + Math.floor(x / cell)] = 1;
  }
  const seen = new Uint8Array(cells.length);
  const boxes: Rect[] = [];
  for (let start = 0; start < cells.length; start++) {
    if (!cells[start] || seen[start]) continue;
    let [x0, y0, x1, y1] = [cols, rows, 0, 0];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const c = stack.pop() as number;
      const cx = c % cols;
      const cy = (c - cx) / cols;
      x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const n = ny * cols + nx;
          if (cells[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
        }
      }
    }
    const x = Math.max(0, x0 * cell - pad);
    const y = Math.max(0, y0 * cell - pad);
    boxes.push({ x, y, width: Math.min(width, (x1 + 1) * cell + pad) - x, height: Math.min(height, (y1 + 1) * cell + pad) - y });
  }
  return boxes.sort((p, q) => p.y - q.y || p.x - q.x);
}

/** One thing the viewer steps through with J and K: an area that differs, or rows only one side has. */
export interface Change {
  kind: 'changed' | 'only-a' | 'only-b';
  /** In the aligned picture. */
  rect: Rect;
  /** Pixels that differ inside it; for a band, its rows. */
  size: number;
  /** For a band: how far it could slide (see Band). */
  slack?: { up: number; down: number };
}

/** Every area of change and every one-sided band, top to bottom. */
export function changesOf(diff: Difference, al: Alignment): Change[] {
  const out: Change[] = changeBoxes(diff.marks, diff.width, diff.height).map((rect) => {
    let size = 0;
    for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) if (diff.marks[y * diff.width + x] === DIFFERS) size++;
    return { kind: 'changed' as const, rect, size };
  });
  let y = 0;
  for (const band of al.bands) {
    if (band.kind === 'only-a' || band.kind === 'only-b') {
      out.push({ kind: band.kind, rect: { x: 0, y, width: diff.width, height: band.rows }, size: band.rows, ...(band.slack ? { slack: band.slack } : {}) });
    }
    y += band.rows;
  }
  return out.sort((p, q) => p.rect.y - q.rect.y || p.rect.x - q.rect.x);
}

/* ── naming a change by the local page's parts ─────────────────────────── */

const area = (r: Rect): number => Math.max(0, r.width) * Math.max(0, r.height);

function overlap(p: Rect, q: Rect): number {
  const w = Math.min(p.x + p.width, q.x + q.width) - Math.max(p.x, q.x);
  const h = Math.min(p.y + p.height, q.y + q.height) - Math.max(p.y, q.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * The part of the local page a change is in: the region it overlaps most,
 * and of regions that overlap it about as much, the smallest (the hero, not
 * the page around it). A band one side has alone is a span across the page
 * (a line where the other side's rows go, or every row it could slide to): it
 * is named by the smallest region at least half the page wide that holds the
 * whole span, below its top (the list an item was added to, not the item next
 * to it). Rectangles in A's page.
 */
export function partAt(rect: Rect, regions: readonly LiveRegion[], pageWidth: number, line = false): LiveRegion | null {
  const usable = regions.filter((r) => r.rect.width > 0 && r.rect.height > 0);
  if (line) {
    // A band sits where the other side's rows begin: the part that starts at that line is the next item, not the
    // list it was added to, so a part holds the line only when the line is inside it, below its top.
    const bottom = rect.y + Math.max(1, rect.height) - 1;
    const holding = (strict: boolean): LiveRegion[] => usable
      .filter((r) => (strict ? r.rect.y < rect.y : r.rect.y <= rect.y) && bottom < r.rect.y + r.rect.height && r.rect.width >= pageWidth / 2)
      .sort((p, q) => area(p.rect) - area(q.rect));
    const found = holding(true)[0] ?? holding(false)[0];
    if (found) return found;
  }
  let best = 0;
  for (const r of usable) best = Math.max(best, overlap(rect, r.rect));
  if (!best) return null;
  return usable.filter((r) => overlap(rect, r.rect) >= best * 0.9).sort((p, q) => area(p.rect) - area(q.rect))[0] ?? null;
}

/* ── what the viewer says ──────────────────────────────────────────────── */

const px = (n: number): string => `${n.toLocaleString('en-US')} px`;

/** One line for the comparison: how much differs, and how the heights were lined up. */
export function compareSummary(input: { diff: Difference; al: Alignment; changes: readonly Change[]; a: { label: string; height: number }; b: { label: string; height: number } }): string {
  const { diff, al, changes, a, b } = input;
  const areas = changes.filter((c) => c.kind === 'changed').length;
  const onlyA = al.bands.filter((x) => x.kind === 'only-a').reduce((n, x) => n + x.rows, 0);
  const onlyB = al.bands.filter((x) => x.kind === 'only-b').reduce((n, x) => n + x.rows, 0);
  const parts: string[] = [];
  if (!diff.pixels && !onlyA && !onlyB) parts.push('No pixels differ: the two pages look the same.');
  else if (diff.pixels) {
    const share = diff.compared ? diff.pixels / diff.compared : 0;
    const pct = share < 0.001 ? 'under 0.1%' : `${(share * 100).toFixed(share < 0.01 ? 2 : 1)}%`;
    parts.push(`${areas === 1 ? 'One area differs' : `${areas} areas differ`} (${pct} of the pixels compared).`);
  } else parts.push('Where both pages have rows side by side, no pixels differ.');
  if (a.height !== b.height) {
    const taller = a.height > b.height ? a : b;
    const shorter = taller === a ? b : a;
    parts.push(`${taller.label} is ${px(taller.height - shorter.height)} taller (${px(taller.height)} against ${px(shorter.height)}).`);
  }
  if (onlyA || onlyB) {
    const said = [onlyA ? `${px(onlyA)} only on ${a.label}` : '', onlyB ? `${px(onlyB)} only on ${b.label}` : ''].filter(Boolean).join(' and ');
    parts.push(`The pages were lined up row by row: ${said}, striped, with nothing beside ${onlyA && onlyB ? 'them' : 'it'}.`);
  }
  return parts.join(' ');
}

/* ── the viewer's keys ─────────────────────────────────────────────────── */

export type CompareMode = 'slider' | 'onion' | 'difference' | 'flip' | 'side';

export type CompareAction =
  | { mode: CompareMode }
  | { flip: 'a' | 'b' | 'other' }
  | { step: 1 | -1 }
  | { width: CompareWidth }
  | { ignore: 'page' | 'site' };

/**
 * What a key does in the viewer: ← and → show one side, Space the other (a
 * flip, by hand); S slider, O onion skin, D difference, T two up (side by
 * side); J and K the next and previous change; 1, 2, 3 the widths; I ignores
 * the change shown, on this page (Shift: on every page). Null: not the
 * viewer's (with ⌘, Ctrl or Option held, never).
 */
export function compareKey(e: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): CompareAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  switch (e.key) {
    case 'ArrowLeft': return { flip: 'a' };
    case 'ArrowRight': return { flip: 'b' };
    case ' ': return { flip: 'other' };
  }
  const k = e.key.length === 1 ? e.key.toLowerCase() : '';
  switch (k) {
    case 's': return { mode: 'slider' };
    case 'o': return { mode: 'onion' };
    case 'd': return { mode: 'difference' };
    case 't': return { mode: 'side' };
    case 'j': return { step: 1 };
    case 'k': return { step: -1 };
    case 'i': return { ignore: e.shiftKey ? 'site' : 'page' };
    case '1': case '2': case '3': return e.shiftKey ? null : { width: COMPARE_WIDTHS[Number(k) - 1] as CompareWidth };
  }
  return null;
}

/** The next or previous change, wrapping; from none, the first (or the last, going back). */
export function stepChange(current: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return dir === 1 ? 0 : count - 1;
  return (current + dir + count) % count;
}

/** Where to scroll so a change sits a quarter of the way down the frame, at the scale the picture is shown. */
export function scrollFor(rect: Rect, scale: number, frameHeight: number): number {
  return Math.max(0, Math.round(rect.y * scale - frameHeight / 4));
}
