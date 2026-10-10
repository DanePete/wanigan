// Every control's tooltip, drawn by one element for the whole window: its name
// and its keys, from the `data-tip` and `data-tip-keys` a control carries
// (`tipProps` in ui.tsx, which IconButton, the rail and the tabs use). Shown
// under a resting pointer after a moment, and at once on keyboard focus, so
// the keys are found without a mouse. The control's own accessible name
// already says it, so the tooltip is hidden from screen readers.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface Shown { label: string; keys: string | null; box: DOMRect; side: 'top' | 'right' | 'bottom' }

const GAP = 6;

export function TooltipHost() {
  const [shown, setShown] = useState<Shown | null>(null);
  useEffect(() => {
    let timer = 0;
    let current: HTMLElement | null = null;
    const delay = (): number => {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--dur-tip').trim();
      const ms = v.endsWith('ms') ? Number(v.slice(0, -2)) : v.endsWith('s') ? Number(v.slice(0, -1)) * 1000 : 450;
      return Number.isFinite(ms) ? ms : 450;
    };
    const show = (el: HTMLElement): void => {
      const label = el.dataset.tip;
      if (!label || !el.isConnected) return;
      const side = el.dataset.tipSide === 'right' || el.dataset.tipSide === 'bottom' ? el.dataset.tipSide : 'top';
      setShown({ label, keys: el.dataset.tipKeys ?? null, box: el.getBoundingClientRect(), side });
    };
    const hide = (): void => { window.clearTimeout(timer); current = null; setShown(null); };
    const target = (e: Event): HTMLElement | null => (e.target as Element | null)?.closest?.<HTMLElement>('[data-tip]') ?? null;
    const over = (e: PointerEvent): void => {
      if (e.pointerType === 'touch') return;
      const el = target(e);
      if (el === current) return;
      window.clearTimeout(timer);
      current = el;
      if (!el) { setShown(null); return; }
      setShown(null);
      timer = window.setTimeout(() => { if (current === el) show(el); }, delay());
    };
    const focus = (e: FocusEvent): void => {
      const el = target(e);
      if (!el || !(e.target as Element).matches(':focus-visible')) return;
      window.clearTimeout(timer);
      current = el;
      show(el);
    };
    const blur = (e: FocusEvent): void => { if (target(e) === current) hide(); };
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') hide(); };
    document.addEventListener('pointerover', over, true);
    document.addEventListener('focusin', focus, true);
    document.addEventListener('focusout', blur, true);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerover', over, true);
      document.removeEventListener('focusin', focus, true);
      document.removeEventListener('focusout', blur, true);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);
  if (!shown) return null;
  const { box, side } = shown;
  const style = side === 'right'
    ? { left: box.right + GAP, top: box.top + box.height / 2 }
    : side === 'bottom'
      ? { left: box.left + box.width / 2, top: box.bottom + GAP }
      : { left: box.left + box.width / 2, top: box.top - GAP };
  return createPortal(
    <div className={`tooltip tooltip-${side}`} aria-hidden="true" style={style} ref={(el) => {
      // Kept inside the window: a tooltip at an edge slides along it rather than off it.
      if (!el) return;
      el.style.translate = '';
      const r = el.getBoundingClientRect();
      const dx = r.left < GAP ? GAP - r.left : r.right > innerWidth - GAP ? innerWidth - GAP - r.right : 0;
      const dy = r.top < GAP ? (side === 'top' ? box.height + 2 * GAP + r.height : GAP - r.top) : 0;
      if (dx || dy) el.style.translate = `${dx}px ${dy}px`;
    }}>
      <span>{shown.label}</span>
      {shown.keys ? <span className="tooltip-keys">{shown.keys}</span> : null}
    </div>,
    document.body,
  );
}
