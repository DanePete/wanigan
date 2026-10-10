// Snap: a picture of the live view, an area of it chosen and marked up, and
// the words an agent reads with it. The marks, which parts of the page an area
// covers and what made them, the context text, and the blur, which replaces the
// pixels under it before the picture is kept or sent. Pure, so the window and
// the tests read it alike. Design: docs/design/2026-10-08-live-view.md, "Snap and Record".
import type { LiveRegion } from './live.ts';
import type { TracePart, TraceOwner } from './live-trace.ts';
import { nameOf } from './live-names.ts';

export type SnapTool = 'box' | 'arrow' | 'highlight' | 'text' | 'blur';

/** A mark on the picture, in the picture's own pixels. */
export type SnapMark =
  | { tool: 'box' | 'highlight' | 'blur'; x: number; y: number; width: number; height: number }
  | { tool: 'arrow'; x1: number; y1: number; x2: number; y2: number }
  | { tool: 'text'; x: number; y: number; text: string };

export interface Rect { x: number; y: number; width: number; height: number }

/** The rectangle two corners make, whichever way it was dragged. */
export function rectFrom(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

/** A rectangle kept inside `w` by `h`; null when nothing of it is. */
export function clampRect(r: Rect, w: number, h: number): Rect | null {
  const x = Math.max(0, Math.min(w, r.x));
  const y = Math.max(0, Math.min(h, r.y));
  const right = Math.max(0, Math.min(w, r.x + r.width));
  const bottom = Math.max(0, Math.min(h, r.y + r.height));
  return right - x >= 1 && bottom - y >= 1 ? { x, y, width: right - x, height: bottom - y } : null;
}

const area = (r: Rect): number => Math.max(0, r.width) * Math.max(0, r.height);
function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * The parts of the page an area covers (both in CSS pixels of the document): those at least half inside it, in page
 * order, at most `max` (`more` counts the rest); and `around`, the smallest part holding the whole area, when one does
 * and it is not listed already. A part with no size on the page is left out.
 */
export function partsInArea(regions: readonly LiveRegion[], a: Rect, max = 12): { inside: LiveRegion[]; around: LiveRegion | null; more: number } {
  const sized = regions.filter((r) => area(r.rect) > 0);
  const inside = sized.filter((r) => overlap(r.rect, a) >= area(r.rect) / 2).sort((x, y) => x.order - y.order);
  const holding = sized.filter((r) => overlap(r.rect, a) >= area(a) - 0.5 && !inside.includes(r)).sort((x, y) => area(x.rect) - area(y.rect));
  return { inside: inside.slice(0, max), around: holding[0] ?? null, more: Math.max(0, inside.length - max) };
}

const OWNER: Record<TraceOwner, string> = { yours: 'your code', contrib: 'contributed', core: 'core', plugin: 'a plugin', theme: 'a theme', unknown: 'unknown' };

/**
 * What made one part, as a line: its name and kind, then its template and file, component, block, content, view or
 * element, and the module, plugin or theme it comes from (the trace's, when the page has one).
 */
export function partLine(r: LiveRegion, part: TracePart | null, componentName: string | null = null): string {
  const n = nameOf(r, componentName, part ? { label: part.label, kind: part.kind } : null);
  const file = part?.source?.file ?? r.file;
  const made = [
    file ? `template ${file}${part?.source?.line ? `:${part.source.line}` : ''}` : null,
    r.component ? `component ${r.component}` : null,
    r.block ? `block ${r.block}` : null,
    r.entity ? `content ${r.entity}` : null,
    r.view ? `view ${r.view}` : null,
    r.element ? `Elementor ${r.element}` : null,
    part?.source?.package ? `from ${part.source.package} (${OWNER[part.source.owner] ?? part.source.owner})` : null,
  ].filter(Boolean);
  return `${n.title} (${(part?.kind ?? n.kind) || 'part'})${made.length ? `: ${made.join(', ')}` : ''}`;
}

/** What was pictured: an area dragged on the view, the whole view, or the whole page (taken again at the view's width). */
export type SnapScope = 'area' | 'view' | 'page';

/** The words the composer is filled with for a snap: where, what was pictured, what made it, and the console's errors. */
export function snapContext(s: {
  url: string;
  /** The view's width in CSS pixels. */
  viewWidth: number | null;
  scope: SnapScope;
  /** What was pictured, in CSS pixels of the page. */
  area: Rect | null;
  /** partLine() of each part the area covers, in page order; `around` the part holding it. */
  parts: readonly string[];
  more: number;
  around: string | null;
  /** Whether the page has a trace (what made each part, from the site's helper). */
  traced: boolean;
  errors: readonly string[];
  /** The page was taller than a picture holds and is shown down to there. */
  cut?: boolean;
}): string {
  const where = s.scope === 'page' ? 'The whole page' : s.scope === 'view' ? 'What the view showed' : 'An area of the page';
  const box = s.area ? `${Math.round(s.area.width)} × ${Math.round(s.area.height)} px at ${Math.round(s.area.x)}, ${Math.round(s.area.y)}` : null;
  const lines = [
    `Page: ${s.url}${s.viewWidth ? ` (the view ${s.viewWidth} px wide)` : ''}`,
    `Pictured: ${where}${box ? `, ${box} of the page (CSS pixels)` : ''}${s.cut ? ', down to where a picture stops' : ''}. The picture is attached, marked up.`,
  ];
  if (s.parts.length || s.around) {
    lines.push('', `What made it${s.traced ? ', from the site’s trace' : ', from the page’s own marks'}:`);
    for (const p of s.parts) lines.push(`- ${p}`);
    if (s.more) lines.push(`- and ${s.more} more`);
    if (s.around) lines.push(`${s.parts.length ? 'All of it inside' : 'Inside'}: ${s.around}`);
  } else {
    lines.push('', 'Nothing on this page says what made that area.');
  }
  lines.push('', s.errors.length ? 'Console errors on this page:' : 'The page logged no console errors.');
  for (const e of s.errors.slice(0, 10)) lines.push(`- ${e}`);
  if (s.errors.length > 10) lines.push(`- and ${s.errors.length - 10} more`);
  return lines.join('\n');
}

/**
 * Blur, as Wanigan does it: each block of `block` pixels inside `r` becomes one colour, its average, so nothing under it
 * can be read back. In place, over RGBA pixels `width` wide; `r` in those pixels. Answers how many pixels changed.
 */
export function pixelate(data: Uint8ClampedArray | Uint8Array | number[], width: number, height: number, r: Rect, block: number): number {
  const size = Math.max(2, Math.round(block));
  const x0 = Math.max(0, Math.floor(r.x)); const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(width, Math.ceil(r.x + r.width)); const y1 = Math.min(height, Math.ceil(r.y + r.height));
  let changed = 0;
  for (let by = y0; by < y1; by += size) {
    for (let bx = x0; bx < x1; bx += size) {
      const ex = Math.min(x1, bx + size); const ey = Math.min(y1, by + size);
      const sum = [0, 0, 0, 0];
      let n = 0;
      for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) { const i = (y * width + x) * 4; for (let c = 0; c < 4; c++) sum[c]! += data[i + c] as number; n++; }
      const avg = sum.map((v) => Math.round(v / n));
      for (let y = by; y < ey; y++) {
        for (let x = bx; x < ex; x++) {
          const i = (y * width + x) * 4;
          if (data[i] !== avg[0] || data[i + 1] !== avg[1] || data[i + 2] !== avg[2]) changed++;
          for (let c = 0; c < 4; c++) data[i + c] = avg[c] as number;
        }
      }
    }
  }
  return changed;
}

/** The block size a blur uses for a picture at `scale` image pixels per CSS pixel: about 16 CSS pixels, more for a large area. */
export function blurBlock(r: Rect, scale: number): number {
  return Math.max(Math.round(16 * scale), Math.round(Math.min(r.width, r.height) / 6));
}
