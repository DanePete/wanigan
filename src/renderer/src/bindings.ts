import { TAB_SHORTCUTS, type Tab } from '@shared/routes';

/**
 * Every key the shell binds, as one table. The cheat sheet renders it, the
 * handlers in App.tsx match against it, and `aria` is the aria-keyshortcuts
 * string the controls publish — so a chord the sheet prints is a chord that
 * works, and a chord that works is one the sheet prints. View routes are not
 * repeated here: they come from shared/routes.ts and `bindingMatches` reads
 * them as `view:<tab>`.
 *
 * Two rules are load-bearing:
 *
 *  - The PTY owns its keystrokes. Exactly one entry skips the terminal (⌘., the
 *    interrupt); every other chord is dead while a terminal has focus.
 *    This table exists for honesty and the sheet, never as a setting that lets
 *    chrome take keys inside the PTY.
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

export const BINDINGS: Binding[] = [
  { id: 'palette',     keys: '⌘K',   aria: 'Meta+K Control+K', group: 'Anywhere',
    does: 'Command palette: views, projects, live sessions, settings, transcripts', scope: 'not-terminal', skipsTerminal: false },
  { id: 'new-session', keys: '⌘T',   aria: 'Meta+T Control+T', group: 'Anywhere',
    does: 'New session', scope: 'not-terminal', skipsTerminal: false },
  // The view routes (⌘1–9, ⌘0, ⌘,, ⌘⇧S …) sit between these two rows in the
  // sheet; ShortcutSheet derives them from shared/routes.ts.
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
    does: 'First or last result', scope: 'palette', skipsTerminal: false },
  { id: 'palette-run',   keys: 'Enter',     aria: 'Enter', group: 'Command palette',
    does: 'Run the highlighted item', scope: 'palette', skipsTerminal: false },
  { id: 'palette-close', keys: 'Esc  ·  ⌘K', aria: 'Escape Meta+K Control+K', group: 'Command palette',
    does: 'Close', scope: 'palette', skipsTerminal: false },
];

/** The sheet lists groups in this order; a binding's group must be one of them. */
export const BINDING_GROUPS: readonly BindingGroup[] =
  ['Anywhere', 'Destination list', 'Sessions view', 'Composer', 'Command palette'];

export function bindingById(id: string): Binding | undefined {
  return BINDINGS.find((b) => b.id === id);
}

/** True while focus is inside a terminal host: the PTY owns the keystroke. */
export function inTerminal(el: Element | null = document.activeElement): boolean {
  return !!el && !!(el as HTMLElement).closest?.('.terminal-host');
}

/** True while focus sits in something that consumes typing. */
export function inField(el: Element | null = document.activeElement): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

/**
 * True while any dialog owns the keyboard. Two signals, either suffices: the
 * flag useDialog sets on the root element, and any aria-modal dialog in the
 * document — which also covers dialogs not yet ported onto the hook.
 */
export function modalOpen(): boolean {
  return document.documentElement.dataset.modalOpen === 'true'
    || document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

const NAMED_KEYS = new Set(['enter', 'escape', 'tab', 'home', 'end', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'backspace', 'delete', 'space']);

/** One `Mod+Mod+Key` alternative against the event. */
function alternativeMatches(alt: string, e: KeyboardEvent): boolean {
  const parts = alt.split('+');
  const key = parts.pop() ?? '';
  const mods = new Set(parts);
  const keyLower = key.toLowerCase();
  const eventKey = e.key === ' ' ? 'space' : e.key.toLowerCase();
  if (!NAMED_KEYS.has(keyLower) && key.length !== 1) return false;
  if (eventKey !== keyLower) return false;
  // A chord published as Meta does not also fire on Control alone, and vice
  // versa: each alias is its own alternative in `aria`.
  if (mods.has('Meta') && !e.metaKey) return false;
  if (mods.has('Control') && !e.ctrlKey) return false;
  if (!mods.has('Meta') && !mods.has('Control') && (e.metaKey || e.ctrlKey)) return false;
  if (mods.has('Alt') !== e.altKey) return false;
  // Shift is part of the chord when it is listed. For a printable key it is
  // otherwise only meaningful for letters and digits (⌘S is not ⌘⇧S); for
  // characters such as `?` the layout already spent Shift producing the key.
  if (mods.has('Shift')) { if (!e.shiftKey) return false; }
  else if (/^[a-z0-9]$/i.test(key) && e.shiftKey) return false;
  return true;
}

/**
 * Does this event fire the binding `id`, given where focus is? `id` is a row
 * of BINDINGS or `view:<tab>` for a route from shared/routes.ts. Owns the two
 * focus guards every handler used to copy: inside a terminal only the
 * `skipsTerminal` chord matches; inside a text field a bare printable key
 * never does. Whether an open dialog blocks the chord is the caller's call —
 * ⌘K closes the palette it opened and `?` closes the sheet — via modalOpen().
 */
export function bindingMatches(e: KeyboardEvent, id: string): boolean {
  let aria: string;
  let skipsTerminal = false;
  let scope: BindingScope = 'not-terminal';
  if (id.startsWith('view:')) {
    const tab = id.slice('view:'.length) as Tab;
    const route = TAB_SHORTCUTS[tab];
    if (!route) return false;
    aria = route.aria;
  } else {
    const binding = bindingById(id);
    if (!binding) return false;
    aria = binding.aria;
    skipsTerminal = binding.skipsTerminal;
    scope = binding.scope;
  }
  const alt = aria.split(/\s+/).find((candidate) => candidate && alternativeMatches(candidate, e));
  if (!alt) return false;
  const el = document.activeElement;
  if (inTerminal(el) && !skipsTerminal) return false;
  const bare = !alt.includes('Meta+') && !alt.includes('Control+');
  const fieldIsTheTarget = scope === 'composer' || scope === 'palette';
  if (bare && !fieldIsTheTarget && inField(el)) return false;
  return true;
}
