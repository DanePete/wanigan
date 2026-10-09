// What changed between two screenshots of a page, as areas: the pixels whose
// colour moved past antialiasing noise, grouped into cells, and touching cells
// into one boxed area. One algorithm for the card's Changes view (the window,
// on a canvas) and for an agent asking what its turn changed (the main
// process, on decoded screenshots). Pure: it reads two pixel buffers of the
// same size and returns numbers.

/** Pixels whose colour moved more than this (summed over the three colour channels) differ: past antialiasing noise, short of any real change. */
export const DIFFERS = 24;
/** Differences are grouped into cells this many pixels square, and touching cells into one area. */
export const CELL = 16;
/** Room left around an area's cells when it is boxed. */
const PAD = 6;

export interface ChangedArea {
  /** In pixels of the compared images, padded a little so a changed word is not cut. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** How many pixels in it differ. */
  pixels: number;
}

export interface PixelDiff {
  /** Pixels that differ, of `total`. */
  pixels: number;
  total: number;
  /** Each area of change, top to bottom as the page reads. */
  areas: ChangedArea[];
}

/**
 * Compare two images of one size, four bytes a pixel (RGBA or BGRA: the order
 * does not matter, both must use the same; the fourth byte is ignored). `mark`
 * is told each pixel that differs, by its byte offset, so a caller can draw it.
 */
export function changedAreas(a: Uint8Array | Uint8ClampedArray, b: Uint8Array | Uint8ClampedArray, width: number, height: number,
  mark?: (offset: number, differs: boolean) => void): PixelDiff {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  if (a.length < w * h * 4 || b.length < w * h * 4) throw new Error('Both images must hold width × height pixels.');
  const cols = Math.ceil(w / CELL);
  const rows = Math.ceil(h / CELL);
  const cells = new Uint32Array(cols * rows);
  let pixels = 0;
  for (let i = 0, p = 0; p < w * h; i += 4, p++) {
    const d = Math.abs((a[i] as number) - (b[i] as number)) + Math.abs((a[i + 1] as number) - (b[i + 1] as number)) + Math.abs((a[i + 2] as number) - (b[i + 2] as number));
    const differs = d > DIFFERS;
    if (differs) {
      pixels++;
      const cell = Math.floor(Math.floor(p / w) / CELL) * cols + Math.floor((p % w) / CELL);
      cells[cell] = (cells[cell] as number) + 1;
    }
    mark?.(i, differs);
  }
  // Touching cells (diagonals too) are one area: flood each.
  const seen = new Uint8Array(cells.length);
  const areas: ChangedArea[] = [];
  for (let start = 0; start < cells.length; start++) {
    if (!cells[start] || seen[start]) continue;
    let [x0, y0, x1, y1] = [cols, rows, 0, 0];
    let count = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const c = stack.pop() as number;
      count += cells[c] as number;
      const cx = c % cols;
      const cy = Math.floor(c / cols);
      x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]] as const) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const n = ny * cols + nx;
        if (cells[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
      }
    }
    areas.push({ x: x0 * CELL - PAD, y: y0 * CELL - PAD, width: (x1 - x0 + 1) * CELL + PAD * 2, height: (y1 - y0 + 1) * CELL + PAD * 2, pixels: count });
  }
  areas.sort((p, q) => p.y - q.y || p.x - q.x);
  return { pixels, total: w * h, areas };
}

/** "1,234 pixels differ (0.5% of the page), in 2 areas", or that nothing does. */
export function diffSummary(d: Pick<PixelDiff, 'pixels' | 'total'> & { areas: unknown[] | number }): string {
  const areas = typeof d.areas === 'number' ? d.areas : d.areas.length;
  if (!d.pixels) return 'No pixels differ: the page looks the same.';
  const share = d.pixels / Math.max(1, d.total);
  const pct = share < 0.001 ? '<0.1%' : `${(share * 100).toFixed(share < 0.01 ? 2 : 1)}%`;
  const n = d.pixels === 1 ? '1 pixel differs' : `${d.pixels.toLocaleString('en-US')} pixels differ`;
  return `${n} (${pct} of the page), in ${areas === 1 ? 'one area' : `${areas} areas`}`;
}
