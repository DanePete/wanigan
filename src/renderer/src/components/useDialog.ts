import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/**
 * One dialog contract for the whole renderer.
 *
 * Every dialog used to hand-roll some of this and none of it all: a backdrop
 * inside the view painted under the header, because .body's view-transition
 * name makes it a stacking context; Escape worked in some, a Tab trap in
 * fewer, and focus fell to the document body on close. This hook portals into
 * the overlay root App renders as a sibling of .shell — so the dialog escapes
 * .body without touching the transition rule that decision asks us to keep —
 * and owns focus, the keyboard and the modal flag the shell's shortcut
 * handlers read.
 *
 * Nothing here animates. A live terminal can be on screen under any dialog.
 */

export const OVERLAY_ROOT_ID = 'wanigan-overlay';

export type DialogOptions = {
  onClose: () => void;
  /**
   * 'first' puts focus on the first focusable control. 'least-destructive'
   * finds the button that undoes nothing — Cancel, Close — so Enter on an
   * unread dialog cannot rewrite every name on screen. A control marked
   * `data-initial-focus` wins over either.
   */
  initialFocus: 'first' | 'least-destructive';
};

export type DialogHandle<E extends HTMLElement> = {
  /** Render the whole dialog, backdrop included, into the overlay root. */
  portal: (children: ReactNode) => ReactNode;
  /** Spread onto the backdrop. Closes on mousedown, not click, so a drag that
   *  starts inside the dialog and ends outside it does not dismiss it. */
  backdropProps: {
    className: string;
    role: 'presentation';
    onMouseDown: (event: ReactMouseEvent<HTMLElement>) => void;
  };
  /** Spread onto the dialog element. Add aria-label or aria-labelledby. */
  dialogProps: {
    ref: RefObject<E | null>;
    role: 'dialog';
    'aria-modal': true;
    tabIndex: -1;
  };
};

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/** Open dialogs, innermost last. Only the innermost answers Escape and Tab. */
const stack: RefObject<HTMLElement | null>[] = [];

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((el) => el.getClientRects().length > 0);
}

function visible(el: HTMLElement | null): el is HTMLElement {
  return !!el && el.isConnected && el.getClientRects().length > 0;
}

/**
 * Where focus goes when the dialog closes: the control that opened it, or —
 * when that control unmounted with the view — the sidebar's single roving tab
 * stop, and failing that the header's sidebar toggle, so a keyboard user is
 * never dropped on the document body.
 *
 * Two fallbacks, not one, because App renders the nav list only while the
 * sidebar is open: with it collapsed there is no [data-nav-tab] in the
 * document at all, while .hdr-toggle is rendered outside that condition.
 */
function restoreFocus(opener: HTMLElement | null): void {
  const target = visible(opener)
    ? opener
    : document.querySelector<HTMLElement>('[data-nav-tab][tabindex="0"]')
      ?? document.querySelector<HTMLElement>('.hdr-toggle');
  target?.focus();
}

export function useDialog<E extends HTMLElement = HTMLElement>({ onClose, initialFocus }: DialogOptions): DialogHandle<E> {
  const dialog = useRef<E | null>(null);
  // The latest close handler without re-binding listeners on every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Captured during the first render, before any effect can move focus.
  const [opener] = useState<HTMLElement | null>(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null);

  // The modal flag and the focus hand-back. A counter, not a boolean: a dialog
  // that opens a dialog must not clear the flag when the inner one closes.
  useEffect(() => {
    const entry = dialog as RefObject<HTMLElement | null>;
    stack.push(entry);
    document.documentElement.dataset.modalOpen = 'true';
    return () => {
      const at = stack.indexOf(entry);
      if (at >= 0) stack.splice(at, 1);
      if (stack.length === 0) delete document.documentElement.dataset.modalOpen;
      restoreFocus(opener);
    };
  }, [opener]);

  // Initial focus, once, after the dialog's own children have mounted.
  useEffect(() => {
    const root = dialog.current;
    if (!root) return;
    const explicit = root.querySelector<HTMLElement>('[data-initial-focus]');
    const all = focusableIn(root);
    let target: HTMLElement | null = explicit;
    if (!target) {
      target = initialFocus === 'least-destructive'
        ? all.find((el) => el.matches('button') && !el.matches('.btn-primary, .btn-danger, [data-destructive]')) ?? null
        : all[0] ?? null;
    }
    (target ?? root).focus();
    // Once: the choice is about the first paint, not about re-renders.
  }, []);

  // Escape in the capture phase, so a view's own handler underneath cannot
  // swallow it; Tab wrapped inside the dialog, so focus never reaches the
  // page behind while aria-modal says it cannot.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = dialog.current;
      if (!root || stack[stack.length - 1]?.current !== root) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const all = focusableIn(root);
      if (all.length === 0) { e.preventDefault(); root.focus(); return; }
      const active = document.activeElement;
      const index = active instanceof HTMLElement ? all.indexOf(active) : -1;
      if (!root.contains(active)) { e.preventDefault(); (e.shiftKey ? all[all.length - 1] : all[0]).focus(); return; }
      if (e.shiftKey && index <= 0) { e.preventDefault(); all[all.length - 1].focus(); return; }
      if (!e.shiftKey && (index < 0 || index === all.length - 1)) { e.preventDefault(); all[0].focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return {
    portal: (children) =>
      createPortal(children, document.getElementById(OVERLAY_ROOT_ID) ?? document.body),
    backdropProps: {
      className: 'overlay-backdrop',
      role: 'presentation',
      onMouseDown: (event) => {
        // Only the backdrop itself: a mousedown that started on the dialog
        // bubbles here too and must not close it.
        if (event.target === event.currentTarget) {
          // The browser's default mousedown focus runs after dismissal and
          // would undo restoreFocus(), dropping focus onto the document body.
          event.preventDefault();
          onCloseRef.current();
        }
      },
    },
    dialogProps: {
      ref: dialog,
      role: 'dialog',
      'aria-modal': true,
      tabIndex: -1,
    },
  };
}
