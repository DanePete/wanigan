// A panel beside the work (Structure on the left, the Inspector on the right,
// the dock beneath): a titled surface with optional underline tabs, its own
// scroll, a hairline where it meets the work, and nothing when it is closed.
// Where it borders the work it can be resized: a splitter (WAI-ARIA window
// splitter) the pointer drags and the arrow keys move, its width kept on this
// computer when given a key. A Section is a small label over its content,
// never a box.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { CommandId, Shortcut } from '@shared/shortcuts';
import { IconButton } from './ui';

type Side = 'left' | 'right' | 'bottom';

const STEP = 16;

function stored(key: string | undefined): number | null {
  if (!key) return null;
  try { const v = Number(localStorage.getItem(`wanigan.panel.${key}`)); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; }
}
function store(key: string | undefined, size: number): void {
  if (!key) return;
  try { localStorage.setItem(`wanigan.panel.${key}`, String(Math.round(size))); } catch { /* a convenience only */ }
}

export function Panel({ title, side = 'left', open = true, onClose, closeKeys, tabs, actions, size, minSize = 200, maxSize = 560, resizable = false, sizeKey, label, className, children }: {
  /** Shown at its head, and its accessible name unless `label` is given. */
  title?: ReactNode;
  side?: Side;
  /** Closed, a panel is nothing: the work takes its room. */
  open?: boolean;
  /** Offered as the head's close button, with the key that toggles the panel. */
  onClose?: () => void;
  closeKeys?: Shortcut | CommandId;
  /** Underline Tabs under the title. */
  tabs?: ReactNode;
  /** Small controls at the head's end. */
  actions?: ReactNode;
  /** Width (left, right) or height (bottom) in px, before any resize; the side's token by default. */
  size?: number;
  minSize?: number;
  maxSize?: number;
  resizable?: boolean;
  /** Keeps a resized panel's size on this computer, by this name. */
  sizeKey?: string;
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  const headId = useId();
  const [own, setOwn] = useState<number | null>(() => stored(sizeKey));
  const box = useRef<HTMLElement>(null);
  const clamp = useCallback((n: number) => Math.max(minSize, Math.min(maxSize, n)), [minSize, maxSize]);
  const current = own ?? size ?? null;
  useEffect(() => { if (own !== null) store(sizeKey, own); }, [own, sizeKey]);
  if (!open) return null;

  const horizontal = side !== 'bottom';
  const measure = (): number => {
    const r = box.current?.getBoundingClientRect();
    return r ? (horizontal ? r.width : r.height) : (current ?? minSize);
  };
  // The edge that borders the work: a left panel's right edge, a right panel's left, a bottom panel's top.
  const grows = side === 'left' ? 1 : -1;
  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const start = horizontal ? e.clientX : e.clientY;
    const from = measure();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const move = (ev: globalThis.PointerEvent): void => setOwn(clamp(from + ((horizontal ? ev.clientX : ev.clientY) - start) * grows));
    const up = (): void => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up); };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const from = measure();
    const towardWork = horizontal ? (side === 'left' ? 'ArrowRight' : 'ArrowLeft') : 'ArrowUp';
    const awayFromWork = horizontal ? (side === 'left' ? 'ArrowLeft' : 'ArrowRight') : 'ArrowDown';
    const step = e.shiftKey ? STEP * 4 : STEP;
    let next: number | null = null;
    if (e.key === towardWork) next = from + step;
    else if (e.key === awayFromWork) next = from - step;
    else if (e.key === 'Home') next = minSize;
    else if (e.key === 'End') next = maxSize;
    if (next === null) return;
    e.preventDefault();
    setOwn(clamp(next));
  };
  const dimension = current === null ? undefined : horizontal ? { width: current } : { height: current };
  const name = label ?? (typeof title === 'string' ? title : undefined);

  return (
    <aside ref={box} className={`panel panel-${side}${className ? ` ${className}` : ''}`} style={dimension}
      {...(name ? { 'aria-label': name } : title ? { 'aria-labelledby': headId } : {})}>
      {title || actions || onClose ? (
        <div className="panel-head">
          {title ? <h2 className="panel-title" id={headId}>{title}</h2> : null}
          {actions ? <div className="panel-actions">{actions}</div> : null}
          {onClose ? <IconButton icon="close" size="s" label={`Close ${name ?? 'the panel'}`} keys={closeKeys} onClick={onClose} /> : null}
        </div>
      ) : null}
      {tabs ? <div className="panel-tabs">{tabs}</div> : null}
      <div className="panel-body">{children}</div>
      {resizable ? (
        <div className="panel-edge" role="separator" tabIndex={0} aria-orientation={horizontal ? 'vertical' : 'horizontal'}
          aria-label={`Resize ${name ?? 'the panel'}`} aria-valuemin={minSize} aria-valuemax={maxSize} aria-valuenow={Math.round(current ?? minSize)}
          data-tip={`Drag, or use the arrow keys, to resize ${name ?? 'the panel'}`}
          onPointerDown={onPointerDown} onKeyDown={onKey} onDoubleClick={() => setOwn(null)} />
      ) : null}
    </aside>
  );
}

/** A small label and its content: how a panel or a dialog is divided. Never a bordered box. */
export function Section({ title, actions, children, className }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section className={`section${className ? ` ${className}` : ''}`} aria-labelledby={id}>
      <div className="section-head">
        <h3 className="section-label" id={id}>{title}</h3>
        {actions ? <div className="section-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
