// The live view's own keys, as data: what the window's live view and its
// page answer (components/Live.tsx, live-page-goto.ts by way of the main
// process), and what the shortcut sheet lists under "In the live view"
// (shared/shortcuts.ts). One list, so the sheet says what the keys do.
//
// Single keys work only while nothing is being typed into, in the window or
// in the page. None of them is a key the sheet gives to anything else: the
// widths' 1, 2 and 3 mean the same as in Compare, and the rest are keys no
// other part of Wanigan uses (C is a new card everywhere, so Compare is ⇧C; X
// archives on the board, so taking a part out is ⇧X). ⇧E opens the design
// layer's edits: E alone edits the chosen part.

export type LiveKeyId =
  | 'pick' | 'lens' | 'width-phone' | 'width-tablet' | 'width-full' | 'tab-previous' | 'tab-next' | 'compare' | 'library' | 'edits'
  | 'edit' | 'move' | 'code' | 'alone' | 'take-out';

export interface LiveKeySpec {
  id: LiveKeyId;
  /** The key as `KeyboardEvent.key` gives it, lower case for a letter. */
  key: string;
  shift: boolean;
  /** Also taken from the site's page while nothing there is typed into. The verbs need a chosen part, which is chosen in the window. */
  page: boolean;
  /** Pressed in the page, the window takes the keyboard: what it opens is in the window (a list, a dialog). */
  focusWindow: boolean;
}

export const LIVE_KEYS: readonly LiveKeySpec[] = [
  { id: 'pick', key: 'p', shift: false, page: true, focusWindow: false },
  { id: 'lens', key: 'l', shift: true, page: true, focusWindow: true },
  { id: 'width-phone', key: '1', shift: false, page: true, focusWindow: false },
  { id: 'width-tablet', key: '2', shift: false, page: true, focusWindow: false },
  { id: 'width-full', key: '3', shift: false, page: true, focusWindow: false },
  { id: 'tab-previous', key: '[', shift: false, page: true, focusWindow: false },
  { id: 'tab-next', key: ']', shift: false, page: true, focusWindow: false },
  { id: 'compare', key: 'c', shift: true, page: true, focusWindow: true },
  { id: 'library', key: 'b', shift: true, page: true, focusWindow: true },
  { id: 'edits', key: 'e', shift: true, page: true, focusWindow: true },
  { id: 'edit', key: 'e', shift: false, page: false, focusWindow: false },
  { id: 'move', key: 'm', shift: false, page: false, focusWindow: false },
  { id: 'code', key: '.', shift: false, page: false, focusWindow: false },
  { id: 'alone', key: 'a', shift: true, page: false, focusWindow: false },
  { id: 'take-out', key: 'x', shift: true, page: false, focusWindow: false },
];

/** What the page script is given to wait for: the keys it may take from the page. */
export const LIVE_PAGE_KEYS: readonly { id: LiveKeyId; key: string; shift: boolean }[] = LIVE_KEYS
  .filter((k) => k.page).map(({ id, key, shift }) => ({ id, key, shift }));

export const isLiveKeyId = (v: unknown): v is LiveKeyId => typeof v === 'string' && LIVE_KEYS.some((k) => k.id === v);

/** A live view key a press means, or null. Modifiers other than Shift never are one. */
export function liveKey(e: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): LiveKeyId | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return null;
  const key = e.key.toLowerCase();
  return LIVE_KEYS.find((k) => k.key === key && k.shift === e.shiftKey)?.id ?? null;
}

/** ⇧⌘↩ (⇧Ctrl+Enter elsewhere): send the note being written, or the notes waiting. */
export function isSendKey(e: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }, mac: boolean): boolean {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return e.key === 'Enter' && mod && e.shiftKey && !e.altKey;
}

/** ⌘↩ (Ctrl+Enter elsewhere), in the note box: keep the note with the others. */
export function isAddKey(e: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }, mac: boolean): boolean {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return e.key === 'Enter' && mod && !e.shiftKey && !e.altKey;
}
