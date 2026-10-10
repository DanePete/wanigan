// What just happened, and where it is said. One store for every outcome a view
// reports (`useToast()` in components/ui.tsx pushes to it):
//
// - the status line at the bottom of the window says the latest one;
// - the notification tray (the bell in the rail) keeps them all, with their
//   time, until dismissed;
// - a toast appears only for what the owner must act on now (a failure with
//   Retry), and in the status line's place, never over a control.
//
// A view that still draws its own status line (the live view, until its pass)
// says so with `useOwnStatusLine`: the frame's line steps aside there, and
// outcomes float as toasts, as they did before Studio, so nothing goes unsaid.
import { createContext, useContext, useEffect } from 'react';

export type NoticeTone = 'info' | 'done' | 'error';

export interface NoticeAction { label: string; run: () => void }

export interface Notice {
  id: number;
  text: string;
  tone: NoticeTone;
  /** When it last happened (the same failure again is counted, not repeated). */
  at: number;
  /** What can be done about it, while it still can (an Undo lapses; a Retry does not). */
  action: NoticeAction | null;
  /** When the action lapses; null when it does not. */
  actionUntil: number | null;
  count: number;
  /** Seen in the tray. */
  read: boolean;
  /** A failure with an action: said as a toast, above the status line, until dismissed or done. */
  urgent: boolean;
}

export interface NoticesValue {
  /** Newest first. */
  list: readonly Notice[];
  /** What the status line says: the latest outcome, until another replaces it or it is dismissed. */
  latest: Notice | null;
  /** Failures waiting to be acted on, oldest first. */
  urgent: readonly Notice[];
  unread: number;
  unreadErrors: number;
  dismiss: (id: number) => void;
  /** A toast put away: it stays in the tray, with its action. */
  settle: (id: number) => void;
  /** Run a notice's action once, and take it away. */
  act: (id: number) => void;
  clear: () => void;
  markRead: () => void;
  /** Put the status line's message away (it stays in the tray). */
  quiet: () => void;
  /** How many status lines are on screen, and how many views draw their own. */
  lines: number;
  ownLines: number;
  showLine: () => () => void;
  ownLine: () => () => void;
  /** Where a view's own content goes in the status line (StatusSlot). */
  slot: HTMLElement | null;
  setSlot: (el: HTMLElement | null) => void;
}

const nothing = (): (() => void) => () => {};

export const NoticesContext = createContext<NoticesValue>({
  list: [], latest: null, urgent: [], unread: 0, unreadErrors: 0,
  dismiss: () => {}, settle: () => {}, act: () => {}, clear: () => {}, markRead: () => {}, quiet: () => {},
  lines: 0, ownLines: 0, showLine: nothing, ownLine: nothing, slot: null, setSlot: () => {},
});

export const useNotices = (): NoticesValue => useContext(NoticesContext);

/**
 * This view draws its own status line (the live view's, until the live pass
 * moves it into StatusLine): the frame's line steps aside while it is shown.
 */
export function useOwnStatusLine(active = true): void {
  const { ownLine } = useNotices();
  useEffect(() => (active ? ownLine() : undefined), [active, ownLine]);
}

/** Whether a notice's action can still be taken. */
export const actionable = (n: Notice, now = Date.now()): boolean => !!n.action && (n.actionUntil === null || now < n.actionUntil);
