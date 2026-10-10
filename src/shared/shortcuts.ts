// Every keyboard shortcut, as data. The window's key handler matches keys with
// `matchKey`, the app menu takes its accelerators from `menuAccelerator`, and
// the shortcut sheet lists `SHORTCUTS`: one list, so what the sheet says is what
// the keys do.
//
// App chords use ⌘ on a Mac and work everywhere, a focused terminal included:
// ⌘ never reaches a terminal program. Control is left alone on a Mac, so
// Ctrl-K and Ctrl-T keep their meaning in a shell, an agent's prompt and a text
// field. Single keys work only when nothing is being typed into.
//
// `Mod` is ⌘ on a Mac and Ctrl on Windows and Linux. A chord that is another
// program's own on each platform (Chrome's DevTools: ⌥⌘I on a Mac, Ctrl+Shift+I
// elsewhere) names its keys for Windows and Linux in `elsewhere`; `keysOn()` is
// the one place that chooses, and the sheet, the menu and the key handler all
// read it.
import { PROJECT_VIEWS, type ProjectView } from './views.ts';

export type CommandId =
  | 'palette' | 'new-session' | 'new-card' | 'shortcuts' | 'settings' | 'close-card' | 'history'
  | 'quick-open' | 'toggle-editor' | 'live-goto' | 'live-devtools'
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

export type ShortcutGroup = 'Anywhere' | 'Voice input' | 'Go to' | 'Git' | 'In the code editor' | 'On the board' | 'In Changes' | 'In Commits' | 'In the live view' | 'Comparing pages' | 'In dialogs and lists';

export interface Shortcut {
  /** The command it runs; null when a view handles the key itself (the board, a dialog). */
  id: CommandId | null;
  label: string;
  group: ShortcutGroup;
  /** Keys as written, `Mod` for ⌘ (Ctrl elsewhere). Several keys pressed together form one chord. */
  keys: string[];
  /** Its keys on Windows and Linux, when they are not `keys` with Ctrl for ⌘ (Chrome's DevTools chord differs by platform). */
  elsewhere?: string[];
  /** Pressed one after the other, not together (G then N). */
  sequence?: boolean;
  /** Other keys that do the same. */
  alt?: string[][];
}

const viewShortcuts: Shortcut[] = PROJECT_VIEWS.map((v) => ({
  id: `go-${v.view}` as CommandId, label: `${v.label} of the open project`, group: 'Go to', keys: ['G', v.key.toUpperCase()], sequence: true,
}));

/**
 * Voice input's chords (components/VoiceInput.tsx, lib/voice.ts): they reach the mic of the box being typed in, or
 * with nothing typed into, the one shown that was used last (narration, while a recording runs). Free on every
 * platform: no other chord here, no Electron menu role, and no common system chord is ⌘⇧M or ⌘⇧H (Ctrl+Shift
 * elsewhere). A Mac sends no key-up for a letter while ⌘ is down, so a hold ends when the keys are let go.
 */
export const VOICE_TOGGLE: Shortcut = { id: null, label: 'Speak into the box you are typing in: start or stop listening', group: 'Voice input', keys: ['Mod', 'Shift', 'M'] };
export const VOICE_HOLD: Shortcut = { id: null, label: 'Hold to speak, and let go to stop', group: 'Voice input', keys: ['Mod', 'Shift', 'H'] };

export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'palette', label: 'Search and commands', group: 'Anywhere', keys: ['Mod', 'K'] },
  { id: 'new-session', label: 'New session', group: 'Anywhere', keys: ['Mod', 'T'] },
  { id: 'new-card', label: 'New card', group: 'Anywhere', keys: ['C'] },
  { id: 'history', label: 'History of the open project', group: 'Anywhere', keys: ['Mod', 'Shift', 'T'] },
  { id: 'shortcuts', label: 'Keyboard shortcuts', group: 'Anywhere', keys: ['Mod', '/'], alt: [['?']] },
  { id: 'settings', label: 'Settings', group: 'Anywhere', keys: ['Mod', ','] },
  { id: 'close-card', label: 'Close the open card', group: 'Anywhere', keys: ['Esc'] },
  VOICE_TOGGLE,
  VOICE_HOLD,
  { id: 'quick-open', label: 'Open a file of the open project', group: 'Anywhere', keys: ['Mod', 'P'] },
  { id: 'toggle-editor', label: 'Show or hide the code editor', group: 'Anywhere', keys: ['Mod', 'J'] },
  { id: 'go-needs', label: 'Needs you', group: 'Go to', keys: ['G', 'N'], sequence: true },
  { id: 'go-running', label: 'Running', group: 'Go to', keys: ['G', 'R'], sequence: true },
  ...viewShortcuts,
  { id: 'project-1', label: 'Your first nine projects, in order', group: 'Go to', keys: ['Mod', '1–9'] },
  // Go to (components/live/GoTo.tsx): a page of the open project's site. ⌘⇧Space anywhere, even while typing;
  // Shift+Space in the live view and its page when nothing is typed into (lib/live-goto.ts, live-page-goto.ts).
  { id: 'live-goto', label: 'A page of the project’s site', group: 'Go to', keys: ['Mod', 'Shift', 'Space'] },
  { id: null, label: 'A page of the site, from the live view (not while typing)', group: 'Go to', keys: ['Shift', 'Space'] },
  // In the open project: each opens the git workbench where it happens.
  { id: 'git-push', label: 'Push the branch (shows what goes first)', group: 'Git', keys: ['Mod', 'Alt', 'P'] },
  { id: 'git-pull', label: 'Pull, fast-forward only', group: 'Git', keys: ['Mod', 'Shift', 'P'] },
  { id: 'git-fetch', label: 'Fetch', group: 'Git', keys: ['Mod', 'Shift', 'F'] },
  { id: 'git-switch', label: 'Switch branch', group: 'Git', keys: ['Mod', 'B'] },
  { id: 'git-branch', label: 'New branch', group: 'Git', keys: ['Mod', 'Shift', 'B'] },
  // The code editor handles these itself (src/renderer/src/editor/), while it has focus.
  { id: null, label: 'Save the file', group: 'In the code editor', keys: ['Mod', 'S'] },
  { id: null, label: 'Find and replace', group: 'In the code editor', keys: ['Mod', 'F'] },
  { id: null, label: 'Go to a line', group: 'In the code editor', keys: ['Ctrl', 'G'] },
  { id: null, label: 'Back to where you were', group: 'In the code editor', keys: ['Ctrl', '-'] },
  { id: null, label: 'Forward again', group: 'In the code editor', keys: ['Ctrl', 'Shift', '-'] },
  { id: null, label: 'Move to the breadcrumbs', group: 'In the code editor', keys: ['Mod', 'Shift', '.'] },
  { id: null, label: 'Wrap long lines, or not', group: 'In the code editor', keys: ['Alt', 'Z'] },
  { id: null, label: 'Leave the editor', group: 'In the code editor', keys: ['Esc', 'Tab'], sequence: true },
  // The Code tab's files (editor/FileTree.tsx): arrows walk them, Enter opens a file as ⌘P does, typing jumps to a name.
  { id: null, label: 'Open a file from the Code tab’s files, keeping the keys there', group: 'In the code editor', keys: ['Space'] },
  // The board handles these itself (views/Board.tsx); they are listed so the sheet is whole.
  { id: null, label: 'Next card down', group: 'On the board', keys: ['J'], alt: [['↓']] },
  { id: null, label: 'Next card up', group: 'On the board', keys: ['K'], alt: [['↑']] },
  { id: null, label: 'Next column right', group: 'On the board', keys: ['L'], alt: [['→']] },
  { id: null, label: 'Next column left', group: 'On the board', keys: ['H'], alt: [['←']] },
  { id: null, label: 'Open the card', group: 'On the board', keys: ['Enter'] },
  { id: null, label: 'Accept into Ready (Inbox)', group: 'On the board', keys: ['A'] },
  { id: null, label: 'Archive (Inbox)', group: 'On the board', keys: ['X'] },
  { id: null, label: 'Apply a saved view, by its number', group: 'On the board', keys: ['1–9'] },
  // Moving a card by keyboard follows the same rules as a drag (views/Board.tsx).
  { id: null, label: 'Move the card up or down its column', group: 'On the board', keys: ['Mod', '↑'], alt: [['Mod', '↓']] },
  { id: null, label: 'Move the card to the next column', group: 'On the board', keys: ['Mod', '→'], alt: [['Mod', '←']] },
  // The List, the board's other mode (views/ListView.tsx).
  { id: null, label: 'First or last card in the List', group: 'On the board', keys: ['Home'], alt: [['End']] },
  { id: null, label: 'A page down or up the List', group: 'On the board', keys: ['PageDown'], alt: [['PageUp']] },
  // So does the Changes view (views/git/WorkingTree.tsx, and its commit box).
  { id: null, label: 'Next file', group: 'In Changes', keys: ['J'] },
  { id: null, label: 'Previous file', group: 'In Changes', keys: ['K'] },
  { id: null, label: 'Mark the file viewed, or not', group: 'In Changes', keys: ['V'] },
  { id: null, label: 'Stage the file, or unstage it', group: 'In Changes', keys: ['S'] },
  { id: null, label: 'Commit (in the message box)', group: 'In Changes', keys: ['Mod', 'Enter'] },
  // And the Commits tab (views/git/Commits.tsx).
  { id: null, label: 'Next commit', group: 'In Commits', keys: ['J'], alt: [['↓']] },
  { id: null, label: 'Previous commit', group: 'In Commits', keys: ['K'], alt: [['↑']] },
  // And the live view itself (components/Live.tsx, keys from shared/live-keys.ts liveKey), in the window or in the
  // site's page while nothing is typed into; the five verbs act on the part chosen.
  { id: null, label: 'Select a part on the page, or stop selecting', group: 'In the live view', keys: ['P'] },
  { id: null, label: 'Colour the page by a lens', group: 'In the live view', keys: ['Shift', 'L'] },
  { id: null, label: 'Phone, tablet or full width', group: 'In the live view', keys: ['1'], alt: [['2'], ['3']] },
  { id: null, label: 'Previous or next tab of the side panel', group: 'In the live view', keys: ['['], alt: [[']']] },
  { id: null, label: 'Previous or next tab of the dock beneath the page (code, notes, problems, request, DevTools)', group: 'In the live view', keys: ['Shift', '['], alt: [['Shift', ']']] },
  { id: null, label: 'Compare Local with a hosted environment', group: 'In the live view', keys: ['Shift', 'C'] },
  { id: null, label: 'The site’s component library', group: 'In the live view', keys: ['Shift', 'B'] },
  { id: null, label: 'Your edits to the page, in the design layer', group: 'In the live view', keys: ['Shift', 'E'] },
  { id: null, label: 'Snap a picture of the page to mark up and send to an agent', group: 'In the live view', keys: ['Shift', 'S'] },
  { id: null, label: 'Start or stop recording the page (Escape stops it too)', group: 'In the live view', keys: ['Shift', 'R'] },
  // On words alone E types on them in the page (Enter keeps, Esc puts back); on anything else it opens Edit ▾.
  { id: null, label: 'Type on the chosen part’s words on the page, or every way to edit it', group: 'In the live view', keys: ['E'] },
  { id: null, label: 'Move the chosen part', group: 'In the live view', keys: ['M'] },
  { id: null, label: 'The chosen part’s code, in the code editor', group: 'In the live view', keys: ['.'] },
  { id: null, label: 'Show the chosen part alone', group: 'In the live view', keys: ['Shift', 'A'] },
  { id: null, label: 'Take the chosen part out of the page', group: 'In the live view', keys: ['Shift', 'X'] },
  { id: null, label: 'Add the note to the notes (in the note box)', group: 'In the live view', keys: ['Mod', 'Enter'] },
  { id: null, label: 'Send the note now, or the notes waiting', group: 'In the live view', keys: ['Mod', 'Shift', 'Enter'] },
  // The page's own Chromium DevTools, in the dock (components/live/DevTools.tsx): Chrome's chord on each platform, from
  // anywhere in a project (elsewhere it goes to the project's live view first), from the page and from DevTools itself.
  { id: 'live-devtools', label: 'The page’s DevTools, in the dock beneath it: open or close', group: 'In the live view', keys: ['Alt', 'Mod', 'I'], elsewhere: ['Mod', 'Shift', 'I'] },
  { id: null, label: 'Show the chosen part, or the row of the tree, in DevTools', group: 'In the live view', keys: ['Shift', 'D'] },
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

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ['Anywhere', 'Voice input', 'Go to', 'Git', 'In the code editor', 'On the board', 'In Changes', 'In Commits', 'In the live view', 'Comparing pages', 'In dialogs and lists'];

/** How a key is written on this platform. */
export function keyLabel(key: string, mac: boolean): string {
  if (key === 'Mod') return mac ? '⌘' : 'Ctrl';
  if (key === 'Shift') return mac ? '⇧' : 'Shift';
  if (key === 'Alt') return mac ? '⌥' : 'Alt';
  if (key === 'Ctrl') return mac ? '⌃' : 'Ctrl';
  if (key === 'Enter') return mac ? '↩' : 'Enter';
  return key;
}

/** A shortcut's keys on this platform: its own for Windows and Linux when it has them. */
export function keysOn(s: Shortcut, mac: boolean): string[] {
  return !mac && s.elsewhere ? s.elsewhere : s.keys;
}

/** Every set of keys that does it on this platform: its keys, then the other keys that do the same. */
export const keySets = (s: Shortcut, mac: boolean): string[][] => [keysOn(s, mac), ...(s.alt ?? [])];

/** One line of text for a shortcut, for search and for a menu's sublabel. */
export function shortcutText(s: Shortcut, mac: boolean): string {
  const one = (keys: string[]): string => keys.map((k) => keyLabel(k, mac)).join(s.sequence ? ' then ' : mac ? '' : '+');
  return keySets(s, mac).map(one).join(' or ');
}

/** Keys as `aria-keyshortcuts` writes them (`Alt+Meta+I`, `Control+Shift+I`). */
export function ariaKeys(keys: readonly string[], mac: boolean): string {
  return keys.map((k) => (k === 'Mod' ? (mac ? 'Meta' : 'Control') : k === 'Ctrl' ? 'Control' : k)).join('+');
}

export interface KeyInput {
  key: string;
  /** The physical key (`KeyP`): what a letter is when Option changes the character it types. */
  code?: string;
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

/**
 * Chrome's DevTools chord, on this platform: ⌥⌘I on a Mac, Ctrl+Shift+I on Windows and Linux. By the key's code:
 * ⌥ turns I into a dead key on a Mac keyboard.
 */
export function isDevtoolsKey(e: KeyInput, mac: boolean): boolean {
  const i = e.code ? e.code === 'KeyI' : e.key.toLowerCase() === 'i';
  return i && (mac ? e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey : e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey);
}

/** What a key press means, given where focus is. Null is "not ours": let it through. */
export function matchKey(e: KeyInput, state: KeyState): KeyMatch {
  const mod = state.mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  // ⌥ turns P into π on a Mac keyboard: the key itself says which letter it was.
  const letter = e.code && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
  if (mod && e.altKey && !e.shiftKey && letter === 'p') return { id: 'git-push' };
  if (isDevtoolsKey(e, state.mac)) return { id: 'live-devtools' };
  if (mod && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'k' && !e.shiftKey) return { id: 'palette' };
    if (k === 't' && e.shiftKey) return { id: 'history' };
    if (k === 't' && !e.shiftKey) return { id: 'new-session' };
    if ((k === '/' || k === '?') && !e.shiftKey) return { id: 'shortcuts' };
    if (k === ',' && !e.shiftKey) return { id: 'settings' };
    if (/^[1-9]$/.test(k) && !e.shiftKey) return { id: `project-${Number(k)}` as CommandId };
    if (k === 'p') return { id: e.shiftKey ? 'git-pull' : 'quick-open' };
    if (k === 'j' && !e.shiftKey) return { id: 'toggle-editor' };
    if (k === 'f' && e.shiftKey) return { id: 'git-fetch' };
    if (k === 'b') return { id: e.shiftKey ? 'git-branch' : 'git-switch' };
    if (k === ' ' && e.shiftKey) return { id: 'live-goto' };
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

/** Whether a process runs on a Mac, where there is a process to ask (the main process, the tests); the window asks its bridge. */
const onMac = (): boolean => (globalThis as { process?: { platform?: string } }).process?.platform === 'darwin';

/** The Electron accelerator for a command on a platform, when it has a chord. */
export function menuAccelerator(id: CommandId, mac = onMac()): string | undefined {
  const s = SHORTCUTS.find((x) => x.id === id);
  if (id.startsWith('project-')) return `CmdOrCtrl+${id.slice('project-'.length)}`;
  const keys = s ? keysOn(s, mac) : [];
  if (!s || s.sequence || !keys.includes('Mod')) return undefined;
  return keys.map((k) => (k === 'Mod' ? 'CmdOrCtrl' : k)).join('+');
}

/** The sequence a command is reached by, for a menu item's sublabel ("G then N"). */
export function menuSequence(id: CommandId, mac: boolean): string | undefined {
  const s = SHORTCUTS.find((x) => x.id === id);
  return s && (s.sequence || !keysOn(s, mac).includes('Mod')) ? shortcutText(s, mac) : undefined;
}

/** Commands the menu may send to the window. Anything else from IPC is ignored. */
export const COMMAND_IDS: ReadonlySet<string> = new Set<string>([
  ...SHORTCUTS.flatMap((s) => (s.id ? [s.id] : [])),
  ...GIT_COMMANDS.map((c) => c.id),
  'go-accounts', 'go-settings',
  ...Array.from({ length: 9 }, (_, i) => `project-${i + 1}`),
]);
