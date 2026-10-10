// The page's own DevTools, from the window: where it is (closed, in the dock,
// in a window of its own), its tab in the dock, its key as the shortcut table
// says it on this platform (⌥⌘I on a Mac, Ctrl+Shift+I on Windows and Linux),
// and Show in DevTools. The tab itself is components/live/DevTools.tsx; the
// model is shared/live-devtools.ts; the views are src/main/live-devtools.ts.
import { useSyncExternalStore } from 'react';
import type { LiveBridge } from '@shared/bridge';
import { centreOf, type LiveDevtoolsMode } from '@shared/live-devtools';
import { ariaKeys, keysOn, shortcutFor, shortcutText } from '@shared/shortcuts';
import { dockShows, editorState, showDock, toggleDock, wantDock } from '../editor/store';
import { parse } from './router';
import { liveBridge } from './live';

/** The DevTools tab's id in the dock beneath the page. */
export const DEVTOOLS_TAB = 'devtools';

let mode: LiveDevtoolsMode = 'closed';
let heard = false;
const listeners = new Set<() => void>();

/** Where DevTools is now, as the main process last said. */
export function setDevtoolsMode(next: LiveDevtoolsMode): void {
  if (mode === next) return;
  mode = next;
  for (const l of listeners) l();
}

function hear(): void {
  if (heard) return;
  const live = liveBridge();
  if (!live) return;
  heard = true;
  live.onDevtools(setDevtoolsMode);
}

export function devtoolsMode(): LiveDevtoolsMode {
  hear();
  return mode;
}

export function useDevtoolsMode(): LiveDevtoolsMode {
  hear();
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => mode);
}

/** The owner opened the tab with its key or its control just now: the keyboard goes into DevTools as it shows. */
let focusWanted = false;

/** ⌥⌘I (Ctrl+Shift+I elsewhere), or the live bar's DevTools: open the dock on DevTools, or hide the dock from it. */
export function toggleDevtoolsTab(): void {
  const s = editorState();
  focusWanted = !(s.open && dockShows(s) === DEVTOOLS_TAB);
  toggleDock(DEVTOOLS_TAB);
}

/** The chord pressed away from the live view: the dock opens on DevTools once the window has gone there. */
export function wantDevtoolsTab(): void {
  focusWanted = true;
  wantDock(DEVTOOLS_TAB);
}

/** Whether the tab was just opened by the owner, once: the tab asks as it shows DevTools. */
export function takeFocusWish(): boolean {
  const f = focusWanted;
  focusWanted = false;
  return f;
}

/** The DevTools chord on this platform: as words (⌥⌘I, Ctrl+Shift+I) and as aria-keyshortcuts (Alt+Meta+I, Control+Shift+I). */
export function devtoolsChord(mac: boolean): { text: string; aria: string } {
  const s = shortcutFor('live-devtools');
  return s ? { text: shortcutText(s, mac), aria: ariaKeys(keysOn(s, mac), mac) } : { text: '', aria: '' };
}

/** Whether the window still shows this project (a view of it, or one of its sessions): leaving it closes DevTools. */
export function inProject(projectKey: string, hash = location.hash): boolean {
  const route = parse(hash).route;
  return (route.name === 'project' || route.name === 'session') && route.projectKey === projectKey;
}

/**
 * Show a part in DevTools: the page scrolled to it when none of it is on screen, the DevTools tab opened (unless
 * DevTools is in its own window, where it stays), and DevTools' inspector pointed at the centre of what of it is on
 * screen, so the Elements panel selects it. `target` is a region from the last scan, or the picked element (null);
 * `view` is the page's size. Null when it was shown, else why not.
 */
export async function showInDevtools(live: LiveBridge, target: number | null, view: { width: number; height: number } | null): Promise<string | null> {
  const box = await live.reveal(target);
  if (!box) return 'It is not on the page now: reload, or choose it again.';
  const at = view ? centreOf(box, view) : null;
  if (!at) return 'None of it is on screen, so DevTools has nothing to point at.';
  if (devtoolsMode() !== 'detached') showDock(DEVTOOLS_TAB);
  return (await live.devtoolsInspect(at.x, at.y)) ? null : 'DevTools could not open for this page.';
}
