// Something that floats beside the control that opened it, and is not a menu
// of commands (Menu.tsx) or a choice of value (Select.tsx): the notification
// tray, a colour picker, a small form. A non-modal dialog with float elevation:
// focus moves into it when it opens, Escape or a click outside closes it, and
// focus goes back to the control. Like every overlay here, it steps the live
// view aside while it is open.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useCoversLive } from '../lib/live';

const GAP = 8;
const EDGE = 8;

interface Place { left: number; top: number; maxHeight: number }

export function Popover({ anchor, open, onClose, label, side = 'bottom', align = 'start', width = 320, className, children }: {
  /** The control that opens it: it is placed beside it, and focus returns to it. */
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  /** Its accessible name. */
  label: string;
  /** Which side of the control it opens on. */
  side?: 'bottom' | 'top' | 'right';
  /** Which edge of the control it lines up with: start (left, or top beside it) or end (right, or bottom). */
  align?: 'start' | 'end';
  width?: number;
  className?: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Place | null>(null);
  useCoversLive(open);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    if (!open || !anchor.current) { setPlace(null); return; }
    const r = anchor.current.getBoundingClientRect();
    const w = Math.min(width, innerWidth - 2 * EDGE);
    let left: number;
    let top: number;
    let maxHeight: number;
    if (side === 'right') {
      left = Math.min(r.right + GAP, innerWidth - w - EDGE);
      maxHeight = innerHeight - 2 * EDGE;
      top = align === 'end' ? Math.max(EDGE, r.bottom) : Math.max(EDGE, r.top);
    } else {
      left = Math.max(EDGE, Math.min(align === 'end' ? r.right - w : r.left, innerWidth - w - EDGE));
      if (side === 'top') { maxHeight = r.top - GAP - EDGE; top = r.top - GAP; } else { maxHeight = innerHeight - r.bottom - GAP - EDGE; top = r.bottom + GAP; }
    }
    setPlace({ left, top, maxHeight });
  }, [open, side, align, width, anchor]);

  // Placed upward (or bottom-aligned beside), it grows from its anchor's edge: measured once drawn.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !place) return;
    const h = el.getBoundingClientRect().height;
    if (side === 'top') el.style.top = `${Math.max(EDGE, place.top - h)}px`;
    else if (side === 'right' && align === 'end') el.style.top = `${Math.max(EDGE, Math.min(place.top - h, innerHeight - h - EDGE))}px`;
    else if (side === 'right') el.style.top = `${Math.max(EDGE, Math.min(place.top, innerHeight - h - EDGE))}px`;
  });

  const placed = place !== null;
  useEffect(() => {
    if (!open || !placed) return undefined;
    const el = box.current;
    const opener = anchor.current;
    (el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>('button:not(:disabled), a[href], input, textarea, select') ?? el)?.focus();
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !el?.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();
      close.current();
      opener?.focus();
    };
    const away = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (!el?.contains(t) && !opener?.contains(t)) close.current();
    };
    const resize = (): void => close.current();
    document.addEventListener('keydown', key, true);
    document.addEventListener('mousedown', away, true);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('mousedown', away, true);
      window.removeEventListener('resize', resize);
    };
  }, [open, placed, anchor]);

  if (!open || !place) return null;
  return createPortal(
    <div ref={box} role="dialog" aria-label={label} tabIndex={-1} className={`popover${className ? ` ${className}` : ''}`}
      style={{ left: place.left, top: place.top, width: Math.min(width, innerWidth - 2 * EDGE), maxHeight: place.maxHeight }}>
      {children}
    </div>,
    document.body,
  );
}
