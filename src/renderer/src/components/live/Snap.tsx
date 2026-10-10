// Snap: a picture of the live view, marked up and sent to an agent with the
// owner's explanation. Drawn in the stage where the page is, as Compare is: the
// site's view steps aside under it (showing its last frame), and comes back
// exactly as it was.
//
// 1. The picture: what the view shows (Wanigan's own outlines left out). The
//    owner drags a rectangle over it, or takes the whole view, or the whole
//    page (taken again at the view's width in a hidden window).
// 2. Markup: a box, an arrow, a highlight, a short label, and a blur for
//    anything private, each undone with Undo. The blur replaces the pixels
//    under it in the picture itself (snap-draw.ts): what is kept and sent is
//    the drawing the owner sees.
// 3. Ask an agent: the note composer (Notes.tsx), with the picture attached
//    and the context filled in as words the owner sees and can change: the
//    page's address and the view's width, the parts the area covers and what
//    made them (the site's trace), and the console's errors. Choosing the
//    session and sending are the composer's; Save to Notes keeps it unsent.
// Nothing is kept or sent before the owner sends it or saves it to Notes.
// Design: docs/design/2026-10-08-live-view.md, "Snap and Record".
import { useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { LiveSnapShot } from '@shared/bridge';
import type { LiveComponent, LiveRegion } from '@shared/live';
import { clampRect, partLine, partsInArea, rectFrom, snapContext, type Rect, type SnapMark, type SnapTool } from '@shared/live-snap';
import type { TracePart } from '@shared/live-trace';
import type { ProjectSummary } from '@shared/model';
import { keyLabel } from '@shared/shortcuts';
import { bridge } from '../../lib/api';
import { liveBridge, useCoversLive } from '../../lib/live';
import { isTyping } from '../../lib/live-goto';
import { Button, IconButton } from '../ui';
import { Icon, type IconName } from '../icons';
import { NoteComposer, draftFor } from './Notes';
import { drawSnap, flatten, snapColors } from './snap-draw';
import '../../styles/live-snap.css';

export type SnapShot = Extract<LiveSnapShot, { data: string }>;
type Shot = SnapShot;
type Phase = 'area' | 'mark' | 'compose';

export const SNAP_TOOLS: readonly { id: SnapTool; label: string; key: string; icon: IconName; hint: string }[] = [
  { id: 'box', label: 'Box', key: 'B', icon: 'box', hint: 'Drag to draw a box around something' },
  { id: 'arrow', label: 'Arrow', key: 'A', icon: 'arrow', hint: 'Drag from where the arrow starts to what it points at' },
  { id: 'highlight', label: 'Highlight', key: 'H', icon: 'highlight', hint: 'Drag over what to highlight' },
  { id: 'text', label: 'Label', key: 'T', icon: 'text', hint: 'Click where a short label goes, type it, and press Enter' },
  { id: 'blur', label: 'Blur', key: 'U', icon: 'blur', hint: 'Drag over anything private: the pixels under it are replaced before anything is kept or sent' },
];

const loadImage = (src: string): Promise<HTMLImageElement> => new Promise((done, fail) => {
  const img = new Image();
  img.onload = () => done(img);
  img.onerror = () => fail(new Error('The picture could not be read.'));
  img.src = src;
});

export function SnapPanel({ first, project, regions, traceParts, traced, componentName, components, errors, prefer, onClose }: {
  /** The view's picture, taken before the panel covered the view (a covered view draws nothing to take). */
  first: Shot;
  project: ProjectSummary;
  /** The page's regions from the window's last scan (CSS pixels of the document). */
  regions: readonly LiveRegion[];
  /** The page's trace parts by id (empty without a trace). */
  traceParts: ReadonlyMap<string, TracePart>;
  traced: boolean;
  componentName: (id: string) => string | null;
  components: Map<string, LiveComponent>;
  /** The console's errors on this page, as the Problems tab reads them. */
  errors: readonly string[];
  /** The session the composer sends to first. */
  prefer: string | null;
  onClose: () => void;
}) {
  const live = liveBridge();
  const titleId = useId();
  const mac = bridge().platform === 'darwin';
  // The site's view steps aside while the snap is drawn where it was.
  useCoversLive(true);
  const [shot, setShot] = useState<Shot>(first);
  const [failed, setFailed] = useState<string | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [phase, setPhase] = useState<Phase>('area');
  const [crop, setCrop] = useState<Rect | null>(null);
  const [scope, setScope] = useState<'area' | 'view' | 'page'>('area');
  const [taking, setTaking] = useState<'view' | 'page' | null>(null);
  const [marks, setMarks] = useState<SnapMark[]>([]);
  const [undone, setUndone] = useState<SnapMark[]>([]);
  const [tool, setTool] = useState<SnapTool>('box');
  const [picture, setPicture] = useState<string | null>(null);
  const [said, setSaid] = useState('');

  /** Show a picture taken: the view's (to choose an area of), or the whole page's (to mark up as it is). */
  const show = useCallback(async (got: Shot): Promise<void> => {
    const img = await loadImage(`data:image/png;base64,${got.data}`).catch(() => null);
    if (!img) { setFailed('The picture could not be read.'); return; }
    setShot(got);
    setImage(img);
    setMarks([]);
    setUndone([]);
    if (got.scope === 'page') {
      setCrop({ x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight });
      setScope('page');
      setPhase('mark');
      setSaid(`The whole page is in the picture, loaded again at ${got.cssWidth} px in a hidden window${got.cut ? ', down to where a picture stops' : ''}: anything opened on the page by hand is not in it.`);
    } else {
      setPhase('area');
      setSaid('The picture is taken. Drag over the part to send, or take the whole view.');
    }
  }, []);
  useEffect(() => { void show(first); }, [first, show]);
  /** The whole page, taken again in a hidden window (the view itself stays covered). */
  const takePage = async (): Promise<void> => {
    if (!live) return;
    setTaking('page');
    setFailed(null);
    const got = await live.snap('page').catch((e: Error) => ({ error: e.message }));
    setTaking(null);
    if (!got || 'error' in got) { setFailed(got ? got.error : 'The view shows nothing to picture.'); return; }
    await show(got);
  };

  const scale = shot ? shot.width / Math.max(1, shot.cssWidth) : 1;
  /** The chosen area in CSS pixels of the page. */
  const area = useMemo<Rect | null>(() => (shot && crop
    ? { x: shot.scrollX + crop.x / scale, y: shot.scrollY + crop.y / scale, width: crop.width / scale, height: crop.height / scale } : null), [shot, crop, scale]);

  const whole = (): void => {
    if (!image) return;
    setCrop({ x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight });
    setScope('view');
    setPhase('mark');
  };
  const chose = (r: Rect): void => { setCrop(r); setScope('area'); setPhase('mark'); setSaid('Mark it up, then Ask an agent.'); };

  const undo = (): void => setMarks((m) => { if (!m.length) return m; setUndone((u) => [...u, m[m.length - 1] as SnapMark]); return m.slice(0, -1); });
  const redo = (): void => setUndone((u) => { if (!u.length) return u; setMarks((m) => [...m, u[u.length - 1] as SnapMark]); return u.slice(0, -1); });
  const add = (m: SnapMark): void => { setMarks((all) => [...all, m]); setUndone([]); };

  const ask = (): void => {
    if (!image || !crop) return;
    setPicture(flatten(image, crop, marks, scale, snapColors()));
    setPhase('compose');
    setSaid('The picture is ready, blurs and all. Say what is wrong, then send it or save it to Notes.');
  };
  const back = (): void => {
    if (phase === 'compose') { setPhase('mark'); setPicture(null); return; }
    if (phase === 'mark' && scope !== 'page') { setPhase('area'); setCrop(null); setMarks([]); setUndone([]); return; }
    onClose();
  };

  // The panel's keys: while it is open they are its, before the live view's or the window's. Escape goes back a step.
  const keysRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keysRef.current = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.isComposing || document.querySelector('[aria-modal="true"], .sel-list')) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t && t !== document.body && !t.closest('.live-stage-snap, .live')) return;
    const typing = !!t && isTyping(t);
    const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    const handled = (): void => { e.preventDefault(); e.stopPropagation(); };
    // Escape in the label being typed drops the label; in the composer's boxes it is theirs.
    if (e.key === 'Escape') { if (t?.closest('.live-snap-label') || (typing && phase === 'compose')) return; handled(); back(); return; }
    if (phase === 'compose' || typing) return;
    if (mod && !e.altKey && e.key.toLowerCase() === 'z') { handled(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && !e.altKey && !e.shiftKey && e.key === 'Enter' && phase === 'mark') { handled(); ask(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const k = e.key.toUpperCase();
    if (phase === 'area' && k === 'W') { handled(); whole(); return; }
    if (phase === 'area' && k === 'F') { handled(); void takePage(); return; }
    const next = phase === 'mark' ? SNAP_TOOLS.find((x) => x.key === k) : undefined;
    if (next) { handled(); setTool(next.id); }
  };
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const on = (e: KeyboardEvent): void => keysRef.current(e);
    document.addEventListener('keydown', on, true);
    return () => {
      document.removeEventListener('keydown', on, true);
      if (before?.isConnected && (!document.activeElement || document.activeElement === document.body)) before.focus({ preventScroll: true });
    };
  }, []);

  // What the area covers and what made it, for the composer.
  const context = useMemo(() => {
    if (!area) return '';
    const from = shot.regions ?? regions;
    const covered = scope === 'page' ? { inside: from.filter((r) => r.parent === null).slice(0, 12), around: null, more: Math.max(0, from.filter((r) => r.parent === null).length - 12) }
      : partsInArea(from, area);
    const line = (r: LiveRegion): string => partLine(r, r.part ? traceParts.get(r.part) ?? null : null, r.component ? componentName(r.component) : null);
    return snapContext({
      url: shot.url, viewWidth: shot.cssWidth, scope, area: scope === 'page' ? null : area,
      parts: covered.inside.map(line), more: covered.more, around: covered.around ? line(covered.around) : null, traced, errors, cut: shot.cut,
    });
  }, [shot, area, scope, regions, traceParts, traced, componentName, errors]);

  const chord = (...k: string[]): string => k.map((x) => keyLabel(x, mac)).join(mac ? '' : '+');
  return (
    <section className="live-stage-snap" aria-labelledby={titleId} data-phase={phase}>
      <div className="live-snap-head">
        <h2 className="live-snap-title" id={titleId}><Icon name="camera" size={16} /> Snap</h2>
        <ol className="live-snap-steps small" aria-label="Steps">
          {(['area', 'mark', 'compose'] as const).map((p, i) => (
            <li key={p} aria-current={phase === p ? 'step' : undefined}>{i + 1}. {p === 'area' ? 'Choose what' : p === 'mark' ? 'Mark it up' : 'Ask an agent'}</li>
          ))}
        </ol>
        <span className="live-snap-spacer" />
        {phase !== 'area' ? <Button size="s" tone="quiet" icon="back" onClick={back} aria-keyshortcuts="Escape">Back</Button> : null}
        <IconButton icon="close" label="Close the snap (Escape)" onClick={onClose} />
      </div>
      <div className="visually-hidden" role="status" aria-live="polite">{said}</div>
      {failed ? (
        <div className="live-snap-wait" role="alert">
          <p>{failed}</p>
          <Button size="s" icon="refresh" onClick={() => (shot.scope === 'page' || phase === 'area' ? void takePage() : setFailed(null))}>Try again</Button>
        </div>
      ) : taking ? (
        <div className="live-snap-wait" role="status">
          <p>{taking === 'page' ? 'Taking the whole page, loaded again at this width in a hidden window…' : 'Taking the picture…'}</p>
        </div>
      ) : !image ? null : phase === 'area' ? (
        <>
          <div className="live-snap-bar">
            <p className="small">Drag over the part to send, or:</p>
            <Button size="s" icon="desktop" onClick={whole} aria-keyshortcuts="W" title="Everything the view shows (W)">Whole view <kbd className="live-key">W</kbd></Button>
            <Button size="s" icon="layers" onClick={() => void takePage()} aria-keyshortcuts="F"
              title="The whole page, top to bottom, loaded again at this width in a hidden window (F)">Full page <kbd className="live-key">F</kbd></Button>
          </div>
          <AreaPicker image={image} onChoose={chose} />
        </>
      ) : phase === 'mark' && crop ? (
        <>
          <div className="live-snap-bar" role="toolbar" aria-label="Markup">
            <div className="live-snap-tools" role="radiogroup" aria-label="Tool">
              {SNAP_TOOLS.map((x) => (
                <button key={x.id} type="button" role="radio" aria-checked={tool === x.id} className={`btn btn-quiet btn-s${tool === x.id ? ' on' : ''}`}
                  aria-keyshortcuts={x.key} aria-label={`${x.label} (${x.key})`} title={`${x.hint} (${x.key})`} onClick={() => setTool(x.id)}>
                  <Icon name={x.icon} size={14} /><span className="live-tool-name">{x.label}</span><kbd className="live-key" aria-hidden="true">{x.key}</kbd>
                </button>
              ))}
            </div>
            <IconButton icon="undo" label={`Undo (${chord('Mod', 'Z')})`} disabled={!marks.length} onClick={undo} aria-keyshortcuts={mac ? 'Meta+Z' : 'Control+Z'} />
            <IconButton icon="redo" label={`Redo (${chord('Shift', 'Mod', 'Z')})`} disabled={!undone.length} onClick={redo} aria-keyshortcuts={mac ? 'Shift+Meta+Z' : 'Shift+Control+Z'} />
            <span className="live-snap-spacer" />
            <Button size="s" tone="primary" icon="send" onClick={ask} aria-keyshortcuts={mac ? 'Meta+Enter' : 'Control+Enter'} title={`Write what is wrong and send it, or save it to Notes (${chord('Mod', 'Enter')})`}>
              Ask an agent <kbd className="live-key" aria-hidden="true">{chord('Mod', 'Enter')}</kbd>
            </Button>
          </div>
          <MarkCanvas image={image} crop={crop} marks={marks} tool={tool} scale={scale} onMark={add} />
          <p className="small faint live-snap-foot">
            {marks.length ? `${marks.length} ${marks.length === 1 ? 'mark' : 'marks'}${marks.some((m) => m.tool === 'blur') ? '; blurred areas are replaced in the picture before it is kept or sent' : ''}.` : SNAP_TOOLS.find((x) => x.id === tool)?.hint}
          </p>
        </>
      ) : phase === 'compose' && picture ? (
        <div className="live-snap-compose">
          <figure className="live-snap-picture">
            <img src={`data:image/${picture.startsWith('/9j/') ? 'jpeg' : 'png'};base64,${picture}`} alt="The marked-up picture, as it will be attached" />
            <figcaption className="small faint">Attached as it is shown here: blurs, marks and all.</figcaption>
          </figure>
          <NoteComposer project={project} components={components} prefer={prefer} draft={draftFor(shot.url, { regions: [], pick: null })}
            with={{ kind: 'snap', shot: picture, context, notice: 'The agent gets this picture and these words. Nothing is sent until you send it.' }}
            onDone={onClose} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * The size a picture `w` × `h` is shown at in its frame: whole (contained), or as wide as the frame when it is much
 * taller than the frame (a whole page), which then scrolls.
 */
function useFit(frame: { current: HTMLElement | null }, w: number, h: number): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const el = frame.current;
    if (!el) return undefined;
    const measure = (): void => {
      const fw = Math.max(1, el.clientWidth - 2);
      const fh = Math.max(1, el.clientHeight - 2);
      const contain = Math.min(fw / w, fh / h, 1);
      const tall = h / w > 2 * (fh / fw);
      const k = tall ? Math.min(fw / w, 1) : contain;
      setSize({ width: Math.max(1, Math.floor(w * k)), height: Math.max(1, Math.floor(h * k)) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [frame, w, h]);
  return size;
}

/** Pointer position in an element's image pixels. */
function at(e: ReactPointerEvent<HTMLElement>, el: HTMLElement, w: number, h: number): { x: number; y: number } {
  const b = el.getBoundingClientRect();
  return { x: Math.max(0, Math.min(w, ((e.clientX - b.left) / Math.max(1, b.width)) * w)), y: Math.max(0, Math.min(h, ((e.clientY - b.top) / Math.max(1, b.height)) * h)) };
}

/** The view's picture, to drag a rectangle over. */
function AreaPicker({ image, onChoose }: { image: HTMLImageElement; onChoose: (r: Rect) => void }) {
  const w = image.naturalWidth;
  const h = image.naturalHeight;
  const [from, setFrom] = useState<{ x: number; y: number } | null>(null);
  const [to, setTo] = useState<{ x: number; y: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const size = useFit(frame, w, h);
  const r = from && to ? rectFrom(from, to) : null;
  return (
    <div className="live-snap-frame" ref={frame}>
      <div className="live-snap-area" ref={box} style={size ?? { visibility: 'hidden' }} role="img"
        aria-label="The page as the view showed it: drag over the part to send, or press W for the whole view"
        onPointerDown={(e) => { if (e.button !== 0 || !box.current) return; e.currentTarget.setPointerCapture(e.pointerId); const p = at(e, box.current, w, h); setFrom(p); setTo(p); }}
        onPointerMove={(e) => { if (from && box.current) setTo(at(e, box.current, w, h)); }}
        onPointerUp={() => {
          const chosen = r ? clampRect(r, w, h) : null;
          setFrom(null); setTo(null);
          // A click, or a sliver, is not an area.
          if (chosen && chosen.width >= 12 && chosen.height >= 12) onChoose(chosen);
        }}>
        <img src={image.src} alt="" draggable={false} />
        {r ? <span className="live-snap-drag" style={{ left: `${(r.x / w) * 100}%`, top: `${(r.y / h) * 100}%`, width: `${(r.width / w) * 100}%`, height: `${(r.height / h) * 100}%` }} /> : null}
      </div>
    </div>
  );
}

/** The chosen picture with its marks, drawn as it will be kept; dragging (or clicking, for a label) adds one. */
function MarkCanvas({ image, crop, marks, tool, scale, onMark }: {
  image: HTMLImageElement; crop: Rect; marks: readonly SnapMark[]; tool: SnapTool; scale: number; onMark: (m: SnapMark) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [from, setFrom] = useState<{ x: number; y: number } | null>(null);
  const [to, setTo] = useState<{ x: number; y: number } | null>(null);
  const [label, setLabel] = useState<{ x: number; y: number; text: string } | null>(null);
  const colors = useMemo(snapColors, []);
  const w = Math.round(crop.width);
  const h = Math.round(crop.height);
  const frame = useRef<HTMLDivElement>(null);
  const size = useFit(frame, w, h);
  const drawing: SnapMark | null = !from || !to ? null : tool === 'arrow' ? { tool, x1: from.x, y1: from.y, x2: to.x, y2: to.y }
    : tool === 'text' ? null : { tool, ...rectFrom(from, to) };

  useEffect(() => {
    const c = canvas.current;
    const g = c?.getContext('2d', { willReadFrequently: true });
    if (!c || !g) return;
    drawSnap(g, image, crop, drawing ? [...marks, drawing] : marks, scale, colors);
  }, [image, crop, marks, drawing?.tool, from?.x, from?.y, to?.x, to?.y, scale, colors]); // eslint-disable-line react-hooks/exhaustive-deps

  const commitLabel = (): void => {
    if (label?.text.trim()) onMark({ tool: 'text', x: label.x, y: label.y, text: label.text.trim().slice(0, 80) });
    setLabel(null);
  };
  return (
    <div className="live-snap-frame" ref={frame}>
      <div className="live-snap-mark" style={size ?? { visibility: 'hidden' }}>
        <canvas ref={canvas} width={w} height={h} aria-label={`The picture, ${marks.length} ${marks.length === 1 ? 'mark' : 'marks'} on it: drag to add a ${tool === 'text' ? 'label (click)' : tool}`}
          role="img" data-tool={tool}
          onPointerDown={(e) => {
            if (e.button !== 0 || !canvas.current) return;
            // A label opens on the click itself (below), once the press has moved the keyboard where it goes.
            if (tool === 'text') return;
            const p = at(e, canvas.current, w, h);
            e.currentTarget.setPointerCapture(e.pointerId);
            setFrom(p); setTo(p);
          }}
          onClick={(e) => {
            if (tool !== 'text' || !canvas.current) return;
            commitLabel();
            setLabel({ ...at(e as unknown as ReactPointerEvent<HTMLElement>, canvas.current, w, h), text: '' });
          }}
          onPointerMove={(e) => { if (from && canvas.current) setTo(at(e, canvas.current, w, h)); }}
          onPointerUp={() => {
            const m = drawing;
            setFrom(null); setTo(null);
            if (!m) return;
            const big = m.tool === 'arrow' ? Math.hypot(m.x2 - m.x1, m.y2 - m.y1) >= 8 : m.width >= 4 && m.height >= 4;
            if (big) onMark(m);
          }} />
        {label ? (
          <input className="live-snap-label" aria-label="The label’s words: Enter adds it, Escape drops it" autoFocus maxLength={80} value={label.text}
            style={{ left: `${(label.x / w) * 100}%`, top: `${(label.y / h) * 100}%` }}
            onChange={(e) => setLabel({ ...label, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitLabel(); }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setLabel(null); }
            }}
            onBlur={commitLabel} />
        ) : null}
      </div>
    </div>
  );
}
