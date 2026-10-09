// Every keyboard shortcut, as data. The window's key handler matches keys with
// `matchKey`, the app menu takes its accelerators from `menuAccelerator`, and
// the shortcut sheet lists `SHORTCUTS`: one list, so what the sheet says is what
// the keys do.
//
// App chords use ⌘ on a Mac and work everywhere, a focused terminal included:
// ⌘ never reaches a terminal program. Control is left alone on a Mac, so
// Ctrl-K and Ctrl-T keep their meaning in a shell, an agent's prompt and a text
// field. Single keys work only when nothing is being typed into.
import { PROJECT_VIEWS, type ProjectView } from './views.ts';

export type CommandId =
  | 'palette' | 'new-session' | 'new-card' | 'shortcuts' | 'settings' | 'close-card' | 'history' | 'toggle-rail'
  | 'go-needs' | 'go-running' | 'go-accounts' | 'go-settings'
  | `go-${ProjectView}`
  | `project-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  | GitCommandId;

/** Git in the open project: each goes to the workbench and does it there (lib/git-intent.ts). */
export type GitCommandId = 'git-commit' | 'git-push' | 'git-pull' | 'git-fetch' | 'git-switch' | 'git-branch' | 'git-stash';

export const GIT_COMMANDS: readonly { id: GitCommandId; label: string }[] = [
  { id: 'git-commit', label: 'Commit…' },
  { id: 'git-push', label: 'Push…' },
  { id: 'git-pull', label: 'Pull' },
  { id: 'git-fetch', label: 'Fetch' },
  { id: 'git-switch', label: 'Switch branch…' },
  { id: 'git-branch', label: 'New branch…' },
  { id: 'git-stash', label: 'Stash changes…' },
];

export type ShortcutGroup = 'Anywhere' | 'Go to' | 'Git' | 'On the board' | 'In Changes' | 'In Commits' | 'Comparing pages' | 'In dialogs and lists';

export interface Shortcut {
  /** The command it runs; null when a view handles the key itself (the board, a dialog). */
  id: CommandId | null;
  label: string;
  group: ShortcutGroup;
  /** Keys as written, `Mod` for ⌘ (Ctrl elsewhere). Several keys pressed together form one chord. */
  keys: string[];
  /** Pressed one after the other, not together (G then N). */
  sequence?: boolean;
  /** Other keys that do the same. */
  alt?: string[][];
}

const viewShortcuts: Shortcut[] = PROJECT_VIEWS.map((v) => ({
  id: `go-${v.view}` as CommandId, label: `${v.label} of the open project`, group: 'Go to', keys: ['G', v.key.toUpperCase()], sequence: true,
}));

export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'palette', label: 'Search and commands', group: 'Anywhere', keys: ['Mod', 'K'] },
  { id: 'new-session', label: 'New session', group: 'Anywhere', keys: ['Mod', 'T'] },
  { id: 'new-card', label: 'New card', group: 'Anywhere', keys: ['C'] },
  { id: 'history', label: 'History of the open project', group: 'Anywhere', keys: ['Mod', 'Shift', 'T'] },
  { id: 'shortcuts', label: 'Keyboard shortcuts', group: 'Anywhere', keys: ['Mod', '/'], alt: [['?']] },
  { id: 'settings', label: 'Settings', group: 'Anywhere', keys: ['Mod', ','] },
  { id: 'toggle-rail', label: 'Collapse or expand the sidebar', group: 'Anywhere', keys: ['Mod', '\\'] },
  { id: 'close-card', label: 'Close the open card', group: 'Anywhere', keys: ['Esc'] },
  { id: 'go-needs', label: 'Needs you', group: 'Go to', keys: ['G', 'N'], sequence: true },
  { id: 'go-running', label: 'Running', group: 'Go to', keys: ['G', 'R'], sequence: true },
  ...viewShortcuts,
  { id: 'project-1', label: 'Your first nine projects, in order', group: 'Go to', keys: ['Mod', '1–9'] },
  // In the open project: each opens the git workbench where it happens.
  { id: 'git-push', label: 'Push the branch (shows what goes first)', group: 'Git', keys: ['Mod', 'P'] },
  { id: 'git-pull', label: 'Pull, fast-forward only', group: 'Git', keys: ['Mod', 'Shift', 'P'] },
  { id: 'git-fetch', label: 'Fetch', group: 'Git', keys: ['Mod', 'Shift', 'F'] },
  { id: 'git-switch', label: 'Switch branch', group: 'Git', keys: ['Mod', 'B'] },
  { id: 'git-branch', label: 'New branch', group: 'Git', keys: ['Mod', 'Shift', 'B'] },
  // The board handles these itself (views/Board.tsx); they are listed so the sheet is whole.
  { id: null, label: 'Next card down', group: 'On the board', keys: ['J'], alt: [['↓']] },
  { id: null, label: 'Next card up', group: 'On the board', keys: ['K'], alt: [['↑']] },
  { id: null, label: 'Next column right', group: 'On the board', keys: ['L'], alt: [['→']] },
  { id: null, label: 'Next column left', group: 'On the board', keys: ['H'], alt: [['←']] },
  { id: null, label: 'Open the card', group: 'On the board', keys: ['Enter'] },
  { id: null, label: 'Accept into Ready (Inbox)', group: 'On the board', keys: ['A'] },
  { id: null, label: 'Archive (Inbox)', group: 'On the board', keys: ['X'] },
  // So does the Changes view (views/git/WorkingTree.tsx, and its commit box).
  { id: null, label: 'Next file', group: 'In Changes', keys: ['J'] },
  { id: null, label: 'Previous file', group: 'In Changes', keys: ['K'] },
  { id: null, label: 'Mark the file viewed, or not', group: 'In Changes', keys: ['V'] },
  { id: null, label: 'Stage the file, or unstage it', group: 'In Changes', keys: ['S'] },
  { id: null, label: 'Commit (in the message box)', group: 'In Changes', keys: ['Mod', 'Enter'] },
  // And the Commits tab (views/git/Commits.tsx).
  { id: null, label: 'Next commit', group: 'In Commits', keys: ['J'], alt: [['↓']] },
  { id: null, label: 'Previous commit', group: 'In Commits', keys: ['K'], alt: [['↑']] },
  // And the live view's Compare (components/live/CompareViewer.tsx, keys from shared/live-compare.ts compareKey).
  { id: null, label: 'Show Local, or the hosted page', group: 'Comparing pages', keys: ['←'], alt: [['→']] },
  { id: null, label: 'Flip to the other', group: 'Comparing pages', keys: ['Space'] },
  { id: null, label: 'Slider', group: 'Comparing pages', keys: ['S'] },
  { id: null, label: 'Onion skin', group: 'Comparing pages', keys: ['O'] },
  { id: null, label: 'Difference', group: 'Comparing pages', keys: ['D'] },
  { id: null, label: 'Side by side', group: 'Comparing pages', keys: ['T'] },
  { id: null, label: 'Next change', group: 'Comparing pages', keys: ['J'] },
  { id: null, label: 'Previous change', group: 'Comparing pages', keys: ['K'] },
  { id: null, label: 'Phone, tablet or desktop width', group: 'Comparing pages', keys: ['1'], alt: [['2'], ['3']] },
  { id: null, label: 'Ignore the change on this page', group: 'Comparing pages', keys: ['I'] },
  { id: null, label: 'Ignore the change on every page', group: 'Comparing pages', keys: ['Shift', 'I'] },
  { id: null, label: 'Choose a result', group: 'In dialogs and lists', keys: ['↑'], alt: [['↓']] },
  { id: null, label: 'Create the card and open it', group: 'In dialogs and lists', keys: ['Mod', 'Enter'] },
  { id: null, label: 'Send a message to the agent', group: 'In dialogs and lists', keys: ['Enter'] },
  { id: null, label: 'New line in a message', group: 'In dialogs and lists', keys: ['Shift', 'Enter'] },
  { id: null, label: 'Close a dialog', group: 'In dialogs and lists', keys: ['Esc'] },
];

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ['Anywhere', 'Go to', 'Git', 'On the board', 'In Changes', 'In Commits', 'Comparing pages', 'In dialogs and lists'];

/** How a key is written on this platform. */
export function keyLabel(key: string, mac: boolean): string {
  if (key === 'Mod') return mac ? '⌘' : 'Ctrl';
  if (key === 'Shift') return mac ? '⇧' : 'Shift';
  if (key === 'Enter') return mac ? '↩' : 'Enter';
  return key;
}

/** One line of text for a shortcut, for search and for a menu's sublabel. */
export function shortcutText(s: Shortcut, mac: boolean): string {
  const one = (keys: string[]): string => keys.map((k) => keyLabel(k, mac)).join(s.sequence ? ' then ' : mac ? '' : '+');
  return [s.keys, ...(s.alt ?? [])].map(one).join(' or ');
}

export interface KeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export interface KeyState {
  mac: boolean;
  /** Focus is in a text field, an editable area or a terminal. */
  typing: boolean;
  /** A dialog is open. */
  dialog: boolean;
  /** G was pressed a moment ago. */
  afterG: boolean;
}

export type KeyMatch = { id: CommandId } | { pending: 'g' } | null;

/** What a key press means, given where focus is. Null is "not ours": let it through. */
export function matchKey(e: KeyInput, state: KeyState): KeyMatch {
  const mod = state.mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (mod && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'k' && !e.shiftKey) return { id: 'palette' };
    if (k === 't' && e.shiftKey) return { id: 'history' };
    if (k === 't' && !e.shiftKey) return { id: 'new-session' };
    if ((k === '/' || k === '?') && !e.shiftKey) return { id: 'shortcuts' };
    if (k === ',' && !e.shiftKey) return { id: 'settings' };
    if (k === '\\' && !e.shiftKey) return { id: 'toggle-rail' };
    if (/^[1-9]$/.test(k) && !e.shiftKey) return { id: `project-${Number(k)}` as CommandId };
    if (k === 'p') return { id: e.shiftKey ? 'git-pull' : 'git-push' };
    if (k === 'f' && e.shiftKey) return { id: 'git-fetch' };
    if (k === 'b') return { id: e.shiftKey ? 'git-branch' : 'git-switch' };
    return null;
  }
  if (state.typing || state.dialog || e.metaKey || e.ctrlKey || e.altKey) return null;
  if (state.afterG) {
    const k = e.key.toLowerCase();
    if (k === 'n') return { id: 'go-needs' };
    if (k === 'r') return { id: 'go-running' };
    const view = PROJECT_VIEWS.find((v) => v.key === k);
    return view ? { id: `go-${view.view}` as CommandId } : null;
  }
  if (e.key === 'g') return { pending: 'g' };
  if (e.key === 'c') return { id: 'new-card' };
  if (e.key === '?') return { id: 'shortcuts' };
  if (e.key === 'Escape') return { id: 'close-card' };
  return null;
}

/**
 * The shortcut that runs a command, as declared above, for showing beside it
 * (the palette's key caps). A project's chord is its own digit. Undefined when
 * the command has no key.
 */
export function shortcutFor(id: CommandId): Shortcut | undefined {
  if (id.startsWith('project-')) {
    const all = SHORTCUTS.find((s) => s.id === 'project-1');
    return all ? { ...all, id, keys: [all.keys[0] as string, id.slice('project-'.length)] } : undefined;
  }
  return SHORTCUTS.find((s) => s.id === id);
}

/** The Electron accelerator for a command, when it has a chord. */
export function menuAccelerator(id: CommandId): string | undefined {
  const s = SHORTCUTS.find((x) => x.id === id);
  if (id.startsWith('project-')) return `CmdOrCtrl+${id.slice('project-'.length)}`;
  if (!s || s.sequence || s.keys[0] !== 'Mod') return undefined;
  return `CmdOrCtrl+${s.keys.slice(1).join('+')}`;
}

/** The sequence a command is reached by, for a menu item's sublabel ("G then N"). */
export function menuSequence(id: CommandId, mac: boolean): string | undefined {
  const s = SHORTCUTS.find((x) => x.id === id);
  return s && (s.sequence || s.keys[0] !== 'Mod') ? shortcutText(s, mac) : undefined;
}

/** Commands the menu may send to the window. Anything else from IPC is ignored. */
export const COMMAND_IDS: ReadonlySet<string> = new Set<string>([
  ...SHORTCUTS.flatMap((s) => (s.id ? [s.id] : [])),
  ...GIT_COMMANDS.map((c) => c.id),
  'go-accounts', 'go-settings',
  ...Array.from({ length: 9 }, (_, i) => `project-${i + 1}`),
]);
