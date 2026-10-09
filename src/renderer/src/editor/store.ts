// The code editor's state in the window: which files are open in each
// project, which one shows, whether the drawer is open, which are unsaved,
// and each project's Back and Forward. Plain data with a subscription, so the
// drawer, the tabs and any surface that opens a file (the live view, Changes,
// a turn's diff, quick open) share one editor. The editor itself (CodeMirror)
// loads only when a file is first shown: see code/.
import { useSyncExternalStore } from 'react';
import { EMPTY_NAV, canBack, canForward, navBack, navForget, navForward, navGo, navJump, type NavHistory, type NavSpot } from '@shared/nav-history';

/** A file to open: where it is, and optionally where in it. */
export interface EditorTarget {
  projectId: string;
  /** A card's own worktree; null or absent is the project folder. */
  cardId?: string | null;
  /** Relative to that folder, with `/`. */
  path: string;
  line?: number | null;
  col?: number | null;
  /** Words to find in the file when the line is not known (a part's text picked in the live view). */
  find?: string | null;
}

export interface EditorTab {
  key: string;
  projectId: string;
  cardId: string | null;
  path: string;
}

/** Where to put the cursor once a file shows, and whether getting there is a jump Back should remember. */
export interface Reveal {
  key: string;
  line: number | null;
  col: number | null;
  find: string | null;
  /** Where the cursor was before the jump, to remember as the place to come Back to. */
  from: NavSpot | null;
  record: boolean;
  seq: number;
}

/** What the loaded editor does for the drawer: save, put back, say where the cursor is. */
export interface SurfaceHandle {
  save(key: string): Promise<boolean>;
  revert(key: string): void;
  /** Forget a closed file's unsaved changes for good. */
  discard(key: string): void;
  /** Where the cursor is in the file showing in a project, as a place Back can return to. */
  spot(projectId: string): NavSpot | null;
}

interface State {
  tabs: EditorTab[];
  /** The file showing in each project, by key. */
  active: Record<string, string>;
  open: boolean;
  unsaved: ReadonlySet<string>;
  nav: Record<string, NavHistory>;
  reveal: Reveal | null;
  /** Bumped to move focus into the editor, or onto the breadcrumbs. */
  focusEditor: number;
  focusCrumbs: number;
  /** Quick open is showing, over this checkout (a card's key, or null for the project folder). */
  quick: { cardKey: string | null } | null;
}

let state: State = { tabs: [], active: {}, open: false, unsaved: new Set(), nav: {}, reveal: null, focusEditor: 0, focusCrumbs: 0, quick: null };
const listeners = new Set<() => void>();
let seq = 0;
let surface: SurfaceHandle | null = null;

function set(patch: Partial<State>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const tabKey = (projectId: string, cardId: string | null | undefined, path: string): string => `${projectId}|${cardId ?? ''}|${path}`;

/** A tab's parts from its key (a place in Back's history names its file by key). */
export function tabOf(key: string): EditorTab | null {
  const [projectId, cardId, ...rest] = key.split('|');
  const path = rest.join('|');
  return projectId && path ? { key, projectId, cardId: cardId || null, path } : null;
}

export function useEditor(): State {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}

export const editorState = (): State => state;

/** The loaded editor says it is there (or gone). */
export function attachSurface(handle: SurfaceHandle | null): void {
  surface = handle;
}

export const currentSurface = (): SurfaceHandle | null => surface;

/**
 * Open a file in the code editor, at a line or at some words when given, and
 * show the editor. Any part of the app may call this; it is a jump Back will
 * return from.
 */
export function openInEditor(target: EditorTarget, { record = true }: { record?: boolean } = {}): void {
  const key = tabKey(target.projectId, target.cardId ?? null, target.path);
  const tabs = state.tabs.some((t) => t.key === key)
    ? state.tabs
    : [...state.tabs, { key, projectId: target.projectId, cardId: target.cardId ?? null, path: target.path }];
  set({
    tabs,
    active: { ...state.active, [target.projectId]: key },
    open: true,
    reveal: {
      key, line: target.line ?? null, col: target.col ?? null, find: target.find?.trim() || null,
      from: record ? surface?.spot(target.projectId) ?? null : null, record, seq: ++seq,
    },
    focusEditor: state.focusEditor + 1,
  });
}

/** The editor got where a reveal asked: remember the jump. */
export function arrived(projectId: string, from: NavSpot | null, to: NavSpot): void {
  set({ nav: { ...state.nav, [projectId]: navJump(state.nav[projectId] ?? EMPTY_NAV, from, to) } });
}

export const navOf = (projectId: string): NavHistory => state.nav[projectId] ?? EMPTY_NAV;
export const mayGoBack = (projectId: string): boolean => canBack(navOf(projectId), surface?.spot(projectId) ?? null);
export const mayGoForward = (projectId: string): boolean => canForward(navOf(projectId));

/** Go to a remembered place, opening its file again if it was closed; a missing one is forgotten. */
function goTo(projectId: string, moved: { nav: NavHistory; to: NavSpot } | null): boolean {
  if (!moved) return false;
  const tab = tabOf(moved.to.key);
  if (!tab) return false;
  set({ nav: { ...state.nav, [projectId]: moved.nav } });
  openInEditor({ projectId: tab.projectId, cardId: tab.cardId, path: tab.path, line: moved.to.line, col: moved.to.col }, { record: false });
  return true;
}

export const goBack = (projectId: string): boolean => goTo(projectId, navBack(navOf(projectId), surface?.spot(projectId) ?? null));
export const goForward = (projectId: string): boolean => goTo(projectId, navForward(navOf(projectId), surface?.spot(projectId) ?? null));
export const goToRecent = (projectId: string, index: number): boolean => goTo(projectId, navGo(navOf(projectId), index, surface?.spot(projectId) ?? null));

/** A file is gone from disk: Back no longer offers it. */
export function forgetPlaces(projectId: string, key: string): void {
  set({ nav: { ...state.nav, [projectId]: navForget(navOf(projectId), key) } });
}

export function showTab(projectId: string, key: string): void {
  if (state.active[projectId] === key && state.open) return;
  const tab = state.tabs.find((t) => t.key === key);
  if (!tab) return;
  // Switching files is a jump too: Back returns to the file before.
  const from = surface?.spot(projectId) ?? null;
  set({ active: { ...state.active, [projectId]: key }, open: true, reveal: { key, line: null, col: null, find: null, from, record: true, seq: ++seq } });
}

/** Close a file's tab (after the drawer has asked about unsaved changes). The next one along shows. */
export function closeTab(key: string): void {
  const tab = state.tabs.find((t) => t.key === key);
  if (!tab) return;
  const same = state.tabs.filter((t) => t.projectId === tab.projectId);
  const at = same.findIndex((t) => t.key === key);
  const next = same[at + 1] ?? same[at - 1] ?? null;
  const active = { ...state.active };
  if (active[tab.projectId] === key) {
    if (next) active[tab.projectId] = next.key; else delete active[tab.projectId];
  }
  const unsaved = new Set(state.unsaved);
  unsaved.delete(key);
  set({ tabs: state.tabs.filter((t) => t.key !== key), active, unsaved });
}

export function markUnsaved(key: string, unsaved: boolean): void {
  if (state.unsaved.has(key) === unsaved) return;
  const next = new Set(state.unsaved);
  if (unsaved) next.add(key); else next.delete(key);
  set({ unsaved: next });
}

export function setEditorOpen(open: boolean): void {
  if (state.open !== open) set({ open });
}

/** ⌘J: show the editor (and put the cursor in it), or hide it. */
export function toggleEditor(): void {
  if (state.open) { set({ open: false }); return; }
  set({ open: true, focusEditor: state.focusEditor + 1 });
}

/** ⌘P: quick open, over a card's worktree when the Changes view shows one. */
export function openQuickOpen(cardKey: string | null = null): void {
  set({ quick: { cardKey } });
}

export function closeQuickOpen(): void {
  if (state.quick) set({ quick: null });
}

export function focusBreadcrumbs(): void {
  set({ open: true, focusCrumbs: state.focusCrumbs + 1 });
}

export function revealDone(at: number): void {
  if (state.reveal?.seq === at) set({ reveal: null });
}
