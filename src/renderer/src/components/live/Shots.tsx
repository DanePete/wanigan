// A card's before and after: its page as it was before the card's session
// worked, and after the last turn that edited files, taken by the live view
// (Settings › Live view › screenshots). Side by side, as a slider, or with the
// pixels that differ marked.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LiveShot } from '@shared/live';
import type { CardDetail } from '@shared/model';
import { call, useQuery } from '../../lib/api';
import { ago } from '../../lib/format';
import { Button, Dialog, Segmented } from '../ui';
import '../../styles/live.css';

type Mode = 'side' | 'slide' | 'changes';
const MODES: readonly { value: Mode; label: string; hint: string }[] = [
  { value: 'side', label: 'Side by side', hint: 'Before on the left, after on the right' },
  { value: 'slide', label: 'Slider', hint: 'One over the other: drag to wipe between them' },
  { value: 'changes', label: 'Changes', hint: 'The after, with the pixels that differ from the before marked' },
];

/** Images already fetched, by screenshot id: a card reopened does not fetch them again. */
const images = new Map<string, Promise<string>>();

function imageOf(id: string): Promise<string> {
  let p = images.get(id);
  if (!p) {
    p = call('live.shotImage', { id }).then((r) => `data:image/png;base64,${r.data}`);
    p.catch(() => images.delete(id));
    images.set(id, p);
  }
  return p;
}

function useImage(id: string | null): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setSrc(null);
    if (id) void imageOf(id).then((s) => { if (current) setSrc(s); }, () => {});
    return () => { current = false; };
  }, [id]);
  return src;
}

export function CardShots({ card }: { card: CardDetail }) {
  const shots = useQuery('live.shots', { cardId: card.id }, ['liveShots'], (_e, d) => (d as { cardId?: string }).cardId === card.id);
  const list = shots.data ?? [];
  const before = list.find((s) => s.kind === 'before') ?? null;
  const after = [...list].reverse().find((s) => s.kind === 'after') ?? null;
  const [mode, setMode] = useState<Mode>('side');
  const [big, setBig] = useState(false);
  if (!before && !after) return null;
  return (
    <section className="drawer-section live-shots">
      <h3>Before and after</h3>
      <div className="live-shots-bar">
        {before && after ? <Segmented<Mode> size="s" label="Show" value={mode} options={MODES} onChange={setMode} /> : null}
        <Button size="s" tone="quiet" icon="open" onClick={() => setBig(true)}>Larger</Button>
      </div>
      <Compare before={before} after={after} mode={before && after ? mode : 'side'} />
      <p className="faint small">
        {before ? `Before: ${ago(before.createdAt)}, as the session began.` : 'No before: screenshots were off when the session began.'}
        {' '}{after ? `After: ${ago(after.createdAt)}, after its last turn that changed files.` : 'No after yet: one is taken when a turn that changes files ends.'}
        {' '}<span className="mono">{(after ?? before)?.url}</span>
      </p>
      {big ? (
        <Dialog title={`${card.key}: before and after`} width={1180} onClose={() => setBig(false)}>
          {before && after ? <Segmented<Mode> size="s" label="Show" value={mode} options={MODES} onChange={setMode} /> : null}
          <Compare before={before} after={after} mode={before && after ? mode : 'side'} large />
        </Dialog>
      ) : null}
    </section>
  );
}

function Compare({ before, after, mode, large = false }: { before: LiveShot | null; after: LiveShot | null; mode: Mode; large?: boolean }) {
  const a = useImage(before?.id ?? null);
  const b = useImage(after?.id ?? null);
  const [at, setAt] = useState(50);
  const frame = `live-compare${large ? ' large' : ''}`;
  if (mode === 'side' || !a || !b) {
    return (
      <div className={`${frame} side`}>
        {before ? <Shot label="Before" src={a} /> : null}
        {after ? <Shot label="After" src={b} /> : null}
      </div>
    );
  }
  if (mode === 'slide') {
    return (
      <div className={`${frame} slide`}>
        <div className="live-compare-stack">
          <img src={b} alt="After" />
          <img src={a} alt="Before" className="live-compare-top" style={{ clipPath: `inset(0 ${100 - at}% 0 0)` }} />
          <span className="live-compare-line" style={{ left: `${at}%` }} aria-hidden="true" />
        </div>
        <input type="range" min={0} max={100} value={at} onChange={(e) => setAt(Number(e.target.value))} aria-label="Before (left) and after (right): drag to wipe" />
      </div>
    );
  }
  return <Changes before={a} after={b} frame={frame} />;
}

function Shot({ label, src }: { label: string; src: string | null }) {
  return (
    <figure className="live-shot">
      <figcaption className="small faint">{label}</figcaption>
      {src ? <img src={src} alt={`${label}: the page`} /> : <div className="live-shot-wait faint small">Loading…</div>}
    </figure>
  );
}

/** The after with each area that differs from the before boxed, compared at the page's own width (CSS pixels). */
function Changes({ before, after, frame }: { before: string; after: string; frame: string }) {
  const [out, setOut] = useState<Diff | null>(null);
  const [failed, setFailed] = useState(false);
  const [at, setAt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  /** Bring change n into view: the frame scrolls so it sits near the top. */
  const show = (n: number): void => {
    const area = out?.boxes[n];
    const frameEl = box.current;
    const image = img.current;
    if (!area || !frameEl || !image || !out) return;
    setAt(n);
    frameEl.scrollTo({ top: Math.max(0, (area.y / out.height) * image.clientHeight - 48), behavior: 'smooth' });
  };
  const key = useMemo(() => `${before.length}:${after.length}`, [before, after]);
  useEffect(() => {
    let current = true;
    setOut(null);
    setFailed(false);
    void diff(before, after).then((r) => { if (current) setOut(r); }, () => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [key, before, after]);
  return (
    <div className={`${frame} changes`} ref={box}>
      {out ? <img ref={img} src={out.src} alt="The after, with each area that changed boxed" onLoad={() => show(0)} />
        : <div className="live-shot-wait faint small">{failed ? 'These two could not be compared.' : 'Comparing…'}</div>}
      {out ? (
        <p className="small live-compare-foot">
          <span>{summary(out)}</span>
          {out.boxes.length > 1 ? (
            <Button size="s" tone="quiet" onClick={() => show((at + 1) % out.boxes.length)}>Next change ({at + 1} of {out.boxes.length})</Button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

interface Diff { src: string; pixels: number; total: number; areas: number; height: number; boxes: { x: number; y: number; width: number; height: number }[] }

function summary(d: Diff): string {
  if (!d.pixels) return 'No pixels differ: the page looks the same.';
  const share = d.pixels / d.total;
  const pct = share < 0.001 ? '<0.1%' : `${(share * 100).toFixed(share < 0.01 ? 2 : 1)}%`;
  return `${d.pixels.toLocaleString()} pixels differ (${pct} of the page), in ${d.areas === 1 ? 'one area' : `${d.areas} areas`}, boxed.`;
}

const load = (src: string): Promise<HTMLImageElement> => new Promise((done, fail) => {
  const img = new Image();
  img.onload = () => done(img);
  img.onerror = () => fail(new Error('image'));
  img.src = src;
});

/** Pixels whose colour moved more than this (summed over red, green and blue) differ: past antialiasing noise, short of any real change. */
const DIFFERS = 24;
/** Differences are grouped into cells this many pixels square, and touching cells into one boxed area. */
const CELL = 16;

/**
 * Compare two screenshots at the page's CSS width (half a 2x shot): the after
 * faded, each pixel that differs in the live view's blue, and a box around each area of change
 * so that one changed word on a long page is seen.
 */
async function diff(beforeSrc: string, afterSrc: string): Promise<Diff> {
  const [x, y] = await Promise.all([load(beforeSrc), load(afterSrc)]);
  const widest = Math.max(x.naturalWidth, y.naturalWidth);
  const scale = Math.min(1, 1440 / widest);
  const w = Math.max(1, Math.round(widest * scale));
  const h = Math.max(1, Math.round(Math.max(x.naturalHeight, y.naturalHeight) * scale));
  const draw = (img: HTMLImageElement): ImageData => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    g.drawImage(img, 0, 0, Math.round(img.naturalWidth * scale), Math.round(img.naturalHeight * scale));
    return g.getImageData(0, 0, w, h);
  };
  const a = draw(x);
  const b = draw(y);
  const cols = Math.ceil(w / CELL);
  const rows = Math.ceil(h / CELL);
  const cells = new Uint8Array(cols * rows);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d') as CanvasRenderingContext2D;
  const result = g.createImageData(w, h);
  // Wanigan's water blue, from its own tokens: what changed is the live view's colour, not amber (which means "needs you").
  const water = /^#([0-9a-f]{6})$/i.exec(getComputedStyle(document.documentElement).getPropertyValue('--water').trim())?.[1] ?? '1b6ea6';
  const [wr, wg, wb] = [0, 2, 4].map((i) => Number.parseInt(water.slice(i, i + 2), 16)) as [number, number, number];
  let pixels = 0;
  for (let i = 0, p = 0; i < a.data.length; i += 4, p++) {
    const d = Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!);
    if (d > DIFFERS) {
      pixels++;
      cells[Math.floor((p / w) / CELL) * cols + Math.floor((p % w) / CELL)] = 1;
      result.data[i] = wr; result.data[i + 1] = wg; result.data[i + 2] = wb; result.data[i + 3] = 255;
    } else {
      result.data[i] = 255 - (255 - b.data[i]!) * 0.4;
      result.data[i + 1] = 255 - (255 - b.data[i + 1]!) * 0.4;
      result.data[i + 2] = 255 - (255 - b.data[i + 2]!) * 0.4;
      result.data[i + 3] = 255;
    }
  }
  g.putImageData(result, 0, 0);
  // Touching cells are one area: flood each, and box it with some room.
  const seen = new Uint8Array(cells.length);
  let areas = 0;
  const boxes: Diff['boxes'] = [];
  g.strokeStyle = `rgb(${wr} ${wg} ${wb})`;
  g.lineWidth = 3;
  for (let start = 0; start < cells.length; start++) {
    if (!cells[start] || seen[start]) continue;
    areas++;
    let [x0, y0, x1, y1] = [cols, rows, 0, 0];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const c = stack.pop() as number;
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
    const pad = 6;
    const rect = { x: x0 * CELL - pad, y: y0 * CELL - pad, width: (x1 - x0 + 1) * CELL + pad * 2, height: (y1 - y0 + 1) * CELL + pad * 2 };
    g.strokeRect(rect.x, rect.y, rect.width, rect.height);
    boxes.push(rect);
  }
  // Top to bottom, as the page reads.
  boxes.sort((p, q) => p.y - q.y || p.x - q.x);
  return { src: canvas.toDataURL('image/png'), pixels, total: w * h, areas, height: h, boxes };
}
