/**
 * Every key the shell binds, as one table: the defaults. The cheat sheet
 * renders it, the handlers in App.tsx match against it, and `aria` is the
 * aria-keyshortcuts string the controls publish — so a chord the sheet prints
 * is a chord that works, and a chord that works is one the sheet prints. View
 * routes are not repeated here: they come from shared/routes.ts and read as
 * `view:<tab>`.
 *
 * It lives in shared/ rather than beside the renderer's matcher because the
 * keymap made it a contract with two readers. shared/keymap.ts lays a person's
 * rebindings over these rows, and the main process validates every write
 * against them before it is stored and prints the result in the menu bar; a
 * renderer-only copy would be a table main could not see, and a second copy in
 * main would be the drift this file exists to prevent.
 *
 * Two rules are load-bearing, and no keymap can change either:
 *
 *  - The PTY owns its keystrokes. Exactly one entry skips the terminal (⌘., the
 *    interrupt); every other chord is dead while a terminal has focus. Which
 *    entry that is comes from this table and nowhere else, so rebinding is a
 *    setting over which chord, never over whether chrome may take a key inside
 *    the PTY.
 *  - A bare printable key (`?`, `$`) is never taken inside a text field: the
 *    field is what the operator is typing into.
 */

export type BindingScope = 'anywhere' | 'not-terminal' | 'not-field' | 'sessions' | 'composer' | 'palette';
export type BindingGroup = 'Anywhere' | 'Destination list' | 'Sessions view' | 'Composer' | 'Command palette';

export type Binding = {
  id: string;
  /** What the sheet prints in its key column. */
  keys: string;
  /** aria-keyshortcuts: space-separated alternatives, `+`-joined modifiers and key. */
  aria: string;
  group: BindingGroup;
  does: string;
  scope: BindingScope;
  /** True only for the chord the terminal forwards to the shell. */
  skipsTerminal: boolean;
};

export const BINDINGS = [
  { id: 'palette',     keys: '⌘K',   aria: 'Meta+K Control+K', group: 'Anywhere',
    does: 'Command palette: views, projects, live sessions, settings, transcripts', scope: 'not-terminal', skipsTerminal: false },
  { id: 'new-session', keys: '⌘T',   aria: 'Meta+T Control+T', group: 'Anywhere',
    does: 'New session', scope: 'not-terminal', skipsTerminal: false },
  // The view routes (⌘1–9, ⌘0, ⌘,, ⌘⇧S …) sit between these two rows in the
  // sheet; shared/keymap.ts derives them from shared/routes.ts.
  { id: 'demo',        keys: '⌘⇧D',  aria: 'Meta+Shift+D Control+Shift+D', group: 'Anywhere',
    does: 'Demo mode (masks names, asks first)', scope: 'not-terminal', skipsTerminal: false },
  { id: 'sheet',       keys: '?  ·  ⌘/', aria: '? Meta+/ Control+/', group: 'Anywhere',
    does: 'This cheat sheet', scope: 'not-field', skipsTerminal: false },
  { id: 'sidebar',     keys: '⌥⌘S', aria: 'Alt+Meta+S', group: 'Anywhere',
    does: 'Show or hide the destination list', scope: 'not-terminal', skipsTerminal: false },

  { id: 'rail-move',   keys: '↑ ↓  Home  End', aria: 'ArrowUp ArrowDown Home End', group: 'Destination list',
    does: 'Move focus in the list — Enter or Space opens the focused view', scope: 'not-terminal', skipsTerminal: false },

  { id: 'side-panel',  keys: '⌘B',   aria: 'Meta+B Control+B', group: 'Sessions view',
    does: 'Toggle the side panel (Code / Timeline / Learning)', scope: 'sessions', skipsTerminal: false },
  { id: 'composer',    keys: '⌘E',   aria: 'Meta+E Control+E', group: 'Sessions view',
    does: 'Toggle and focus the composer', scope: 'sessions', skipsTerminal: false },
  { id: 'close-tab',   keys: '⌘⌫',  aria: 'Meta+Backspace Control+Backspace', group: 'Sessions view',
    does: 'Close the active exited session tab', scope: 'sessions', skipsTerminal: false },
  // Not ⌘1–9. Those are the view routes, taken in the capture phase by the
  // shell before Sessions ever sees them — so the "⌘1 / ⌘2 / ⌘3" printed on the
  // session tabs, and "⌘1–9 switch" in the status bar, were chords that moved
  // nothing. Proven by driving the built renderer, not by reading. ⌥⌘← / ⌥⌘→
  // are free, are the same pair an editor uses for previous/next tab, and are
  // matched on the arrow key rather than a character, so they hold on any
  // keyboard layout.
  { id: 'session-prev', keys: '⌥⌘←', aria: 'Alt+Meta+ArrowLeft', group: 'Sessions view',
    does: 'Previous session', scope: 'sessions', skipsTerminal: false },
  { id: 'session-next', keys: '⌥⌘→', aria: 'Alt+Meta+ArrowRight', group: 'Sessions view',
    does: 'Next session', scope: 'sessions', skipsTerminal: false },
  { id: 'interrupt',   keys: '⌘.',   aria: 'Meta+. Control+.', group: 'Sessions view',
    does: 'Interrupt the running agent — works even while the terminal has focus', scope: 'sessions', skipsTerminal: true },

  { id: 'send',        keys: 'Enter',  aria: 'Enter', group: 'Composer',
    does: 'Send — or queue, when the agent is busy', scope: 'composer', skipsTerminal: false },
  { id: 'newline',     keys: '⇧Enter', aria: 'Shift+Enter', group: 'Composer',
    does: 'New line', scope: 'composer', skipsTerminal: false },
  { id: 'stash',       keys: '⌘S',     aria: 'Meta+S Control+S', group: 'Composer',
    does: 'Stash the draft for later', scope: 'composer', skipsTerminal: false },
  { id: 'skill-menu',  keys: '$',      aria: '$', group: 'Composer',
    does: 'Insert a skill — type to filter, Enter to accept', scope: 'composer', skipsTerminal: false },

  { id: 'palette-move',  keys: '↑ ↓',      aria: 'ArrowUp ArrowDown', group: 'Command palette',
    does: 'Move the highlight', scope: 'palette', skipsTerminal: false },
  { id: 'palette-ends',  keys: 'Home  End', aria: 'Home End', group: 'Command palette',
    does: 'First or last result when search is empty; otherwise move the text caret', scope: 'palette', skipsTerminal: false },
  { id: 'palette-run',   keys: 'Enter',     aria: 'Enter', group: 'Command palette',
    does: 'Run the highlighted item', scope: 'palette', skipsTerminal: false },
  { id: 'palette-close', keys: 'Esc  ·  ⌘K', aria: 'Escape Meta+K Control+K', group: 'Command palette',
    does: 'Close', scope: 'palette', skipsTerminal: false },
] as const satisfies readonly Binding[];

export type BindingId = (typeof BINDINGS)[number]['id'];

/** The sheet lists groups in this order; a binding's group must be one of them. */
export const BINDING_GROUPS: readonly BindingGroup[] =
  ['Anywhere', 'Destination list', 'Sessions view', 'Composer', 'Command palette'];

export function bindingById(id: string): Binding | undefined {
  return BINDINGS.find((b) => b.id === id);
}
