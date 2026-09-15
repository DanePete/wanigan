import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { IBufferLine } from '@xterm/xterm';
import { quoteAsMarkdown } from '@shared/copy-helpers';
import type { LinkCandidate } from '@shared/terminal-links';
import { appendToComposerDraft } from './Composer';
import '../styles/helper-ux.css';

/**
 * The right-click menu the terminal and the transcript reader share, and the
 * two small pieces of text handling both need: reading a terminal row as a
 * string with each character's cell, and turning a selection into a quote in a
 * session's message box.
 *
 * A menu, not a dialog: it does not trap focus or dim the page, Escape and a
 * click anywhere else close it, and the arrow keys move between its items. It
 * opens on the item the pointer was over when it matters (a link) and hands
 * focus back to whatever had it.
 */

export type MenuItem =
  | { kind: 'item'; label: string; kbd?: string; disabled?: boolean; why?: string; run: () => void | Promise<void> }
  | { kind: 'separator' };

export function ContextMenu({ x, y, label, head, items, onClose }: {
  x: number; y: number; label: string; head?: string; items: MenuItem[]; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(null);

  useLayoutEffect(() => {
    returnTo.current = document.activeElement;
    const el = ref.current;
    if (!el) return;
    // Kept on screen: a menu opened near the right or bottom edge flips back
    // inside the window rather than clipping its last item.
    // The pointer's coordinates are the one value no stylesheet can know, so
    // they are written onto the element directly once it has been measured.
    const rect = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [x, y]);

  useEffect(() => {
    const close = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    window.addEventListener('mousedown', close, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('keydown', onKey, true);
      const back = returnTo.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (!buttons.length) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1
      : (at + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return createPortal(
    <div ref={ref} className="ux-menu" role="menu" aria-label={label}
         onKeyDown={onKeyDown} onContextMenu={(e) => e.preventDefault()}>
      {head && <div className="ux-menu-head">{head}</div>}
      {items.map((item, i) => item.kind === 'separator'
        ? <div key={`sep-${i}`} className="ux-menu-sep" role="separator" />
        : (
          <div key={item.label} role="none">
            <button type="button" role="menuitem" className="ux-menu-item" disabled={item.disabled}
                    onClick={() => { onClose(); void item.run(); }}>
              <span>{item.label}</span>
              {item.kbd && <kbd>{item.kbd}</kbd>}
            </button>
            {item.disabled && item.why && <div className="ux-menu-why">{item.why}</div>}
          </div>
        ))}
    </div>,
    document.body,
  );
}

/**
 * One terminal row as text, with the cell each UTF-16 index sits in and how
 * many cells it spans. A wide character is one or two string indices and two
 * cells, and an empty cell is a space — so an offset the link parser returns
 * maps back to exactly the cells it names.
 */
export function terminalRow(line: IBufferLine, cols: number): { text: string; cell: number[]; width: number[] } {
  let text = '';
  const cell: number[] = [];
  const width: number[] = [];
  for (let x = 0; x < cols; x++) {
    const c = line.getCell(x);
    if (!c) break;
    const w = c.getWidth();
    if (w === 0) continue;
    const chars = c.getChars() || ' ';
    for (let i = 0; i < chars.length; i++) { cell.push(x); width.push(w); }
    text += chars;
  }
  return { text, cell, width };
}

/** The string index under a cell column, or -1. */
export function indexAtCell(row: { cell: number[]; width: number[] }, x: number): number {
  for (let i = 0; i < row.cell.length; i++) if (x >= row.cell[i] && x < row.cell[i] + row.width[i]) return i;
  return -1;
}

/** A link candidate's cells as xterm's 1-based inclusive range. */
export function cellRange(row: { cell: number[]; width: number[] }, link: LinkCandidate, y: number) {
  const last = link.end - 1;
  return { start: { x: row.cell[link.start] + 1, y }, end: { x: row.cell[last] + row.width[last], y } };
}

/**
 * Put selected text into a session's message box as a Markdown quote, never
 * sent. Returns the sentence to show, or null when there was nothing to quote.
 */
export function quoteIntoMessage(sessionId: string, selection: string, from: string): string | null {
  const quote = quoteAsMarkdown(selection);
  if (!quote) return null;
  const where = appendToComposerDraft(
    sessionId, quote.text,
    `Quoted ${from} below your draft${quote.truncated ? ' (cut to 20,000 characters)' : ''}. Nothing is sent until you send it.`,
  );
  return where === 'composer'
    ? `Quoted ${from} into the message box, unsent.`
    : `Quoted ${from} into this session’s saved draft, unsent. Open the composer to read it.`;
}
