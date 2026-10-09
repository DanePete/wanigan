// Two renders of one page, laid over each other: the local site's and a
// hosted environment's. Lined up row by row first (shared/live-compare.ts), so
// a section only one side has is a striped band beside nothing rather than
// everything below it marked as changed. Five ways to look: a slider that
// wipes, an onion skin, the difference (only changed pixels light up), a flip
// (one, then the other, in the same place) and side by side, scrolling
// together. Each changed area is boxed, counted and named by the local part it
// overlaps. Keys: ← → Space, S O D T, J K, 1 2 3, I. It takes two pictures as
// data and nothing else, so the UI sweep shows it with pictures it draws.
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { LiveRegion } from '@shared/live';
import {
  ALIKE, DIFFERS, IGNORED, ONE_SIDE, alignRows, alignedRect, changesOf, compareKey, compareSummary, difference, pageRect, partAt, rowHashes, scrollFor, stepChange,
  type Alignment, type Change, type CompareMode, type CompareWidth, type Rect,
} from '@shared/live-compare';
import type { LiveMask } from '@shared/live-envs';
import { nameOf } from '@shared/live-names';
import { Button, Segmented } from '../ui';
import '../../styles/live-compare.css';

export interface CompareSide {
  /** Local, or the environment's name. */
  label: string;
  /** The picture: a data or blob URL of a PNG, any scale. */
  src: string;
}

const MODES: readonly { value: CompareMode; label: string; hint: string }[] = [
  { value: 'slider', label: 'Slider', hint: 'S · one over the other: drag to wipe between them' },
  { value: 'onion', label: 'Onion skin', hint: 'O · one seen through the other' },
  { value: 'difference', label: 'Difference', hint: 'D · only the pixels that differ light up' },
  { value: 'flip', label: 'Flip', hint: '← → or Space · one, then the other, in the same place' },
  { value: 'side', label: 'Side by side', hint: 'T · two up, scrolling together' },
];

/** A change, with where it is on the local page and the part it is in. */
interface Named extends Change { page: Rect; name: string | null }

interface Prepared {
  width: number;
  al: Alignment;
  a: HTMLCanvasElement;
  b: HTMLCanvasElement;
  diff: HTMLCanvasElement;
  changes: Named[];
  summary: string;
  ignored: { mask: LiveMask; rect: Rect }[];
}

export function CompareViewer({ a, b, width, regions, components, masks, onIgnore, onUnmask, onWidth, initialMode = 'slider' }: {
  a: CompareSide;
  b: CompareSide;
  /** The CSS width both pages were taken at. */
  width: CompareWidth;
  /** What made each part of the local page, at this width (its own coordinates). */
  regions: readonly LiveRegion[];
  /** Component names by id, for naming a change by its component. */
  components?: ReadonlyMap<string, string>;
  /** Areas the owner ignores here (this page or every page, this width), in the local page's coordinates. */
  masks: readonly LiveMask[];
  onIgnore?: (rect: Rect, label: string | null, scope: 'page' | 'site') => void;
  onUnmask?: (mask: LiveMask) => void;
  onWidth?: (width: CompareWidth) => void;
  initialMode?: CompareMode;
}) {
  const [ready, setReady] = useState<Prepared | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [mode, setMode] = useState<CompareMode>(initialMode);
  const [shown, setShown] = useState<'a' | 'b'>('a');
  const [wipe, setWipe] = useState(50);
  const [onion, setOnion] = useState(50);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(-1);
  const frame = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const keysId = useId();
  const maskKey = masks.map((m) => `${m.id}:${m.rect.x},${m.rect.y},${m.rect.width},${m.rect.height}`).join('|');

  useEffect(() => {
    let live = true;
    setFailed(null);
    void prepare(a, b, width, regions, components ?? new Map(), masks).then((p) => { if (live) setReady(p); }, (e: Error) => { if (live) setFailed(e.message); });
    return () => { live = false; };
    // Masks are compared by what they cover, not by the array's identity.
  }, [a.src, b.src, width, regions, components, maskKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // New pictures start at their first change; the same pictures with an area ignored keep their place. The keys go to
  // the pictures when they arrive (not to a choice above them, whose arrows are its own).
  const focused = useRef(false);
  const pictures = useRef('');
  useEffect(() => {
    const n = ready?.changes.length ?? 0;
    const same = pictures.current === `${a.src.length}:${b.src.length}:${width}`;
    pictures.current = `${a.src.length}:${b.src.length}:${width}`;
    setCurrent((c) => (!n ? -1 : same ? Math.min(Math.max(c, 0), n - 1) : 0));
    if (ready && !focused.current) { focused.current = true; frame.current?.focus({ preventScroll: true }); }
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // Flip on its own, twice a second, only when asked; never with reduced motion.
  useEffect(() => {
    if (!playing || mode !== 'flip') return undefined;
    const t = window.setInterval(() => setShown((s) => (s === 'a' ? 'b' : 'a')), 600);
    return () => window.clearInterval(t);
  }, [playing, mode]);

  // Bring the current change into view.
  useLayoutEffect(() => {
    const change = ready?.changes[current];
    const f = frame.current;
    const s = stage.current;
    if (!change || !f || !s || !ready) return;
    const scale = s.getBoundingClientRect().width / ready.width;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    f.scrollTo({ top: scrollFor(change.rect, scale, f.clientHeight), behavior: reduce ? 'auto' : 'smooth' });
  }, [current, ready, mode]);

  const change = ready?.changes[current] ?? null;
  const canIgnore = !!change && change.kind === 'changed' && !!onIgnore;
  const ignore = (scope: 'page' | 'site'): void => {
    if (!change || !canIgnore || !ready) return;
    onIgnore?.(change.page, change.name, scope);
  };

  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.isComposing) return;
    const t = e.target as HTMLElement | null;
    const input = t instanceof HTMLInputElement ? t.type : null;
    if (t?.isContentEditable || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (input && input !== 'range' && input !== 'checkbox')) return;
    const action = compareKey(e);
    if (!action) return;
    if ('flip' in action) {
      // Space presses a focused button, and arrows move a focused slider or choice: theirs, not the viewer's.
      if (e.key === ' ' && t?.closest('button, [role="radio"], input')) return;
      if (e.key !== ' ' && t?.closest('[role="radio"], input')) return;
      setPlaying(false);
      setMode('flip');
      setShown((s) => (action.flip === 'other' ? (s === 'a' ? 'b' : 'a') : action.flip));
    } else if ('mode' in action) {
      setMode(action.mode);
    } else if ('step' in action) {
      setCurrent((c) => stepChange(c, ready?.changes.length ?? 0, action.step));
    } else if ('width' in action) {
      if (!onWidth || action.width === width) return;
      onWidth(action.width);
    } else if ('ignore' in action) {
      if (!canIgnore) return;
      ignore(action.ignore);
    }
    e.preventDefault();
  };
  useEffect(() => {
    const on = (e: KeyboardEvent): void => keys.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  const label = (c: Named): string => (c.kind === 'changed' ? `${c.size.toLocaleString('en-US')} px differ`
    : `${c.size.toLocaleString('en-US')} px only on ${c.kind === 'only-a' ? a.label : b.label}`);

  return (
    <div className="cmp">
      <div className="cmp-bar">
        <Segmented<CompareMode> size="s" label="Show the two pages as" value={mode} options={MODES} onChange={(m) => { setMode(m); setPlaying(false); }} />
        {mode === 'slider' ? (
          <span className="cmp-scale">
            <span className="small" aria-hidden="true">{a.label}</span>
            <input type="range" className="cmp-range" min={0} max={100} value={wipe} onChange={(e) => setWipe(Number(e.target.value))}
              aria-label={`${a.label} on the left, ${b.label} on the right: drag to wipe between them`} />
            <span className="small" aria-hidden="true">{b.label}</span>
          </span>
        ) : mode === 'onion' ? (
          <span className="cmp-scale">
            <span className="small" aria-hidden="true">{a.label} {100 - onion}%</span>
            <input type="range" className="cmp-range" min={0} max={100} value={onion} onChange={(e) => setOnion(Number(e.target.value))}
              aria-label={`How much of ${b.label} shows through ${a.label}`} />
            <span className="small" aria-hidden="true">{b.label} {onion}%</span>
          </span>
        ) : mode === 'flip' ? (
          <span className="cmp-flip">
            <Button size="s" onClick={() => { setPlaying(false); setShown((s) => (s === 'a' ? 'b' : 'a')); }} aria-label={`Showing ${shown === 'a' ? a.label : b.label}: show ${shown === 'a' ? b.label : a.label}`}>
              Showing {shown === 'a' ? a.label : b.label}
            </Button>
            <Button size="s" tone="quiet" icon={playing ? 'pause' : 'play'} aria-pressed={playing} disabled={reducedMotion()}
              title={reducedMotion() ? 'Flipping on its own is off while this Mac reduces motion' : 'Flip between them twice a second'} onClick={() => setPlaying((p) => !p)}>
              {playing ? 'Stop' : 'Flip on its own'}
            </Button>
          </span>
        ) : null}
      </div>
      {ready ? <p className="cmp-summary small" role="status">{ready.summary}</p> : null}
      <div className="cmp-main">
        <div className="cmp-frame" ref={frame} tabIndex={0} data-autofocus role="region" aria-describedby={keysId}
          aria-label={`${a.label} and ${b.label}, ${MODES.find((m) => m.value === mode)?.label.toLowerCase()}${change ? `; change ${current + 1} of ${ready?.changes.length}` : ''}`}>
          {!ready ? (
            <div className="cmp-wait faint small">{failed ? `These two could not be compared: ${failed}` : 'Lining the two pages up…'}</div>
          ) : mode === 'side' ? (
            <div className="cmp-two">
              {(['a', 'b'] as const).map((side) => (
                <figure key={side} className="cmp-col">
                  <figcaption className="small">{side === 'a' ? a.label : b.label}</figcaption>
                  <div className="cmp-stage" ref={side === 'a' ? stage : undefined}>
                    <Slot canvas={side === 'a' ? ready.a : ready.b} />
                    <Marks ready={ready} current={current} />
                  </div>
                </figure>
              ))}
            </div>
          ) : (
            <div className="cmp-stage" ref={stage} style={{ maxWidth: ready.width }}>
              {mode === 'slider' ? (
                <>
                  <Slot canvas={ready.b} />
                  <div className="cmp-top" style={{ clipPath: `inset(0 ${100 - wipe}% 0 0)` }}><Slot canvas={ready.a} /></div>
                  <span className="cmp-line" style={{ left: `${wipe}%` }} aria-hidden="true" />
                </>
              ) : mode === 'onion' ? (
                <>
                  <Slot canvas={ready.a} />
                  <div className="cmp-top" style={{ opacity: onion / 100 }}><Slot canvas={ready.b} /></div>
                </>
              ) : mode === 'flip' ? (
                <Slot canvas={shown === 'a' ? ready.a : ready.b} />
              ) : (
                <Slot canvas={ready.diff} />
              )}
              <Marks ready={ready} current={current} />
            </div>
          )}
        </div>
        <aside className="cmp-side" aria-label="What differs">
          <h3 className="live-section-title">{ready ? (ready.changes.length ? `Changes · ${ready.changes.length}` : 'No changes') : 'Changes'}</h3>
          {ready?.changes.length ? (
            <ol className="cmp-changes">
              {ready.changes.map((c, i) => (
                <li key={`${c.rect.x},${c.rect.y}`}>
                  <button type="button" className="cmp-change" aria-current={i === current ? 'true' : undefined} onClick={() => setCurrent(i)}>
                    <span className="cmp-change-n" data-kind={c.kind}>{i + 1}</span>
                    <span className="cmp-change-text">
                      <span className="cmp-change-name">{c.name ?? 'A part nothing on the local page names'}</span>
                      <span className="faint small">{label(c)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          ) : ready ? <p className="faint small">Where both pages have rows side by side, every pixel matches.</p> : null}
          {onIgnore && ready?.changes.length ? (
            <div className="cmp-ignore">
              <p className="faint small">
                {canIgnore ? 'Something that changes on its own (a slideshow, a date) can be left out of comparisons.'
                  : change ? 'Rows only one side has are not counted as changed pixels, so there is nothing to ignore.' : ''}
              </p>
              <div className="live-actions">
                <Button size="s" disabled={!canIgnore} onClick={() => ignore('page')} title="I">Ignore on this page</Button>
                <Button size="s" tone="quiet" disabled={!canIgnore} onClick={() => ignore('site')} title="Shift-I">On every page</Button>
              </div>
            </div>
          ) : null}
          {ready?.ignored.length ? (
            <div className="cmp-ignored">
              <h3 className="live-section-title">Ignored here · {ready.ignored.length}</h3>
              <ul className="live-made">
                {ready.ignored.map(({ mask }) => (
                  <li key={mask.id}>
                    <span className="small">{mask.label ?? 'An area'}</span>
                    <span className="faint small">{mask.path ? 'This page' : 'Every page'}, at {mask.width} px</span>
                    {onUnmask ? <Button size="s" tone="quiet" onClick={() => onUnmask(mask)} aria-label={`Compare ${mask.label ?? 'the area'} again`}>Compare it again</Button> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </aside>
      </div>
      <p id={keysId} className="cmp-keys faint small">
        <kbd>←</kbd> <kbd>→</kbd> or <kbd>Space</kbd> flip · <kbd>S</kbd> slider · <kbd>O</kbd> onion skin · <kbd>D</kbd> difference ·
        {' '}<kbd>T</kbd> side by side · <kbd>J</kbd> <kbd>K</kbd> next and previous change{onWidth ? <> · <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> phone, tablet, desktop</> : null}
        {onIgnore ? <> · <kbd>I</kbd> ignore it</> : null}
      </p>
    </div>
  );
}

const reducedMotion = (): boolean => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Where a prepared canvas is shown: it moves here when the mode changes, never drawn twice. */
function Slot({ canvas }: { canvas: HTMLCanvasElement }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { box.current?.replaceChildren(canvas); }, [canvas]);
  return <div className="cmp-slot" ref={box} />;
}

/** The boxes and ignored areas, over whichever picture is shown, in percentages of it. */
function Marks({ ready, current }: { ready: Prepared; current: number }) {
  const at = (r: Rect): CSSProperties => ({
    left: `${(r.x / ready.width) * 100}%`, top: `${(r.y / ready.al.height) * 100}%`,
    width: `${(r.width / ready.width) * 100}%`, height: `${(r.height / ready.al.height) * 100}%`,
  });
  return (
    <div className="cmp-marks" aria-hidden="true">
      {ready.ignored.map(({ mask, rect }) => <span key={mask.id} className="cmp-mask" style={at(rect)}><span className="cmp-box-tag">Ignored</span></span>)}
      {ready.changes.map((c, i) => (
        <span key={`${c.rect.x},${c.rect.y}`} className="cmp-box" data-kind={c.kind} data-current={i === current ? '' : undefined}
          data-top={c.rect.y < 24 ? '' : undefined} style={at(c.rect)}>
          <span className="cmp-box-tag">{i + 1}{c.name ? ` · ${c.name}` : ''}</span>
        </span>
      ))}
    </div>
  );
}

/* ── the work ──────────────────────────────────────────────────────────── */

const load = (src: string): Promise<HTMLImageElement> => new Promise((done, fail) => {
  const img = new Image();
  img.onload = () => done(img);
  img.onerror = () => fail(new Error('a picture would not load'));
  img.src = src;
});

function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = Math.max(1, height);
  return [c, c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D];
}

/** A colour token as red, green and blue: the comparison draws in Wanigan's own colours, read from the page. */
function token(name: string, fallback: [number, number, number]): [number, number, number] {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v)?.[1];
  if (hex) return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(v);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : fallback;
}

const css = ([r, g, b]: readonly number[]): string => `rgb(${r} ${g} ${b})`;

async function prepare(sa: CompareSide, sb: CompareSide, width: number, regions: readonly LiveRegion[], components: ReadonlyMap<string, string>, masks: readonly LiveMask[]): Promise<Prepared> {
  const [ia, ib] = await Promise.all([load(sa.src), load(sb.src)]);
  // Both at the page's CSS width: a 2x picture is halved, so one pixel is one CSS pixel on both sides.
  const draw = (img: HTMLImageElement): { c: HTMLCanvasElement; px: ImageData } => {
    const h = Math.max(1, Math.round(img.naturalHeight * (width / img.naturalWidth)));
    const [c, g] = canvas(width, h);
    // Where a page draws no background a browser shows white, so both sides are compared on white.
    g.fillStyle = 'white';
    g.fillRect(0, 0, width, h);
    g.drawImage(img, 0, 0, width, h);
    return { c, px: g.getImageData(0, 0, width, h) };
  };
  const A = draw(ia);
  const B = draw(ib);
  const rects = masks.map((m) => m.rect);
  const al = alignRows(rowHashes(A.px, rects), rowHashes(B.px, rects));
  const ignored = masks.map((mask) => ({ mask, rect: alignedRect(al, mask.rect) }));
  const diff = difference(A.px, B.px, al, ignored.map((i) => i.rect));
  const changes = changesOf(diff, al);

  const sunken = token('--sunken', [14, 17, 20]);
  const fg = token('--fg', [232, 230, 225]);
  const water = token('--water', [99, 179, 228]);
  const line = token('--line-strong', [52, 60, 69]);
  const stripes = (g: CanvasRenderingContext2D): CanvasPattern | string => {
    const [p, pg] = canvas(12, 12);
    pg.fillStyle = css(sunken);
    pg.fillRect(0, 0, 12, 12);
    pg.strokeStyle = css(line);
    pg.lineWidth = 2;
    pg.beginPath(); pg.moveTo(-3, 15); pg.lineTo(15, -3); pg.moveTo(-3, 3); pg.lineTo(3, -3); pg.moveTo(9, 15); pg.lineTo(15, 9); pg.stroke();
    return g.createPattern(p, 'repeat') ?? css(line);
  };

  // Each side as tall as the aligned picture: its rows where it has them, stripes where only the other side does.
  const aligned = (src: HTMLCanvasElement, side: 'a' | 'b'): HTMLCanvasElement => {
    const [c, g] = canvas(width, al.height);
    const fill = stripes(g);
    let y = 0;
    for (const band of al.bands) {
      if (band.kind === (side === 'a' ? 'only-b' : 'only-a')) { g.fillStyle = fill; g.fillRect(0, y, width, band.rows); }
      else g.drawImage(src, 0, band[side], width, band.rows, 0, y, width, band.rows);
      y += band.rows;
    }
    return c;
  };

  // The difference: what differs in Wanigan's blue, the rest a faint ghost of the page, ignored and one-sided rows striped.
  const [d, dg] = canvas(diff.width, diff.height);
  const out = dg.createImageData(diff.width, diff.height);
  let y = 0;
  for (const band of al.bands) {
    const side = band.kind === 'only-b' ? 'b' : 'a';
    const src = side === 'a' ? A.px : B.px;
    for (let k = 0; k < band.rows; k++, y++) {
      const sy = band[side] + k;
      for (let x = 0; x < diff.width; x++) {
        const p = y * diff.width + x;
        const o = p * 4;
        const mark = diff.marks[p];
        let rgb: readonly number[];
        if (mark === DIFFERS) rgb = water;
        else if (mark === IGNORED || mark === ONE_SIDE) rgb = ((x + y) >> (mark === IGNORED ? 2 : 3)) & 1 ? line : sunken;
        else {
          const i = (sy * src.width + Math.min(x, src.width - 1)) * 4;
          const ink = 1 - (0.299 * src.data[i]! + 0.587 * src.data[i + 1]! + 0.114 * src.data[i + 2]!) / 255;
          const t = mark === ALIKE ? 0.08 + ink * 0.22 : 0;
          rgb = [sunken[0] + (fg[0] - sunken[0]) * t, sunken[1] + (fg[1] - sunken[1]) * t, sunken[2] + (fg[2] - sunken[2]) * t];
        }
        out.data[o] = rgb[0]!; out.data[o + 1] = rgb[1]!; out.data[o + 2] = rgb[2]!; out.data[o + 3] = 255;
      }
    }
  }
  dg.putImageData(out, 0, 0);

  const named = changes.map((c): Named => {
    const page = pageRect(al, c.rect, 'a');
    // A band is named by every place it could sit (rows repeated around it leave that open), not one of them.
    const span = c.slack ? { ...page, y: Math.max(0, page.y - c.slack.up), height: page.height + c.slack.up + c.slack.down } : page;
    const region = partAt(span, regions, width, c.kind !== 'changed');
    return { ...c, page, name: region ? nameOf(region, region.component ? components.get(region.component) ?? null : null).title : null };
  });
  return {
    width, al, a: aligned(A.c, 'a'), b: aligned(B.c, 'b'), diff: d, changes: named, ignored,
    summary: compareSummary({ diff, al, changes, a: { label: sa.label, height: A.px.height }, b: { label: sb.label, height: B.px.height } }),
  };
}
