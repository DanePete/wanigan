// The live view in the window: the app's view laid over a placeholder (see
// shared/bridge.ts LiveBridge). A native view draws above the page, so
// anything that opens over it (a dialog, the palette, the chat) says so here,
// and the view steps aside while it is open.
import { useCallback, useEffect, useState } from 'react';
import type { LiveBridge } from '@shared/bridge';
import type { LiveEvent } from '@shared/live';
import { bridge } from './api';

/** The live view, or null where nothing can show a site. */
export const liveBridge = (): LiveBridge | null => bridge().live ?? null;

let covers = 0;
const listeners = new Set<(covered: boolean) => void>();
const tell = (): void => { for (const l of listeners) l(covers > 0); };

/** Call in anything that opens over the page: while it is mounted (and `active`), the live view steps aside. */
export function useCoversLive(active = true): void {
  useEffect(() => {
    if (!active) return;
    covers++;
    tell();
    return () => { covers--; tell(); };
  }, [active]);
}

/** How many things cover the live view now: an edit sheet over it knows when something covers the sheet too. */
export function useLiveCovers(): number {
  const [count, setCount] = useState(covers);
  useEffect(() => {
    const l = (): void => setCount(covers);
    listeners.add(l);
    setCount(covers);
    return () => { listeners.delete(l); };
  }, []);
  return count;
}

/**
 * A colour token's value as `#rrggbb`, for what is drawn on the site's page
 * (a lens), where Wanigan's stylesheet does not reach. Null when it is not one.
 */
export function tokenColor(name: string): string | null {
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(value) ? value : null;
}

/** Whether something covers the live view now. */
export function useLiveCovered(): boolean {
  const [covered, setCovered] = useState(covers > 0);
  useEffect(() => {
    listeners.add(setCovered);
    setCovered(covers > 0);
    return () => { listeners.delete(setCovered); };
  }, []);
  return covered;
}

/**
 * The files one session edited last, inside the folder the site serves: what
 * the session's "See it" chip offers until the owner looks (or clears it).
 */
export function useSessionEdits(projectId: string, sessionId: string, root: string | null): { paths: string[] | null; clear: () => void } {
  const [paths, setPaths] = useState<string[] | null>(null);
  useEffect(() => {
    setPaths(null);
    if (!root) return undefined;
    return bridge().on((event, data) => {
      if (event !== 'live') return;
      const e = data as LiveEvent;
      if (e.kind !== 'edit' || e.projectId !== projectId || e.sessionId !== sessionId) return;
      const inside = e.paths.filter((p) => p === root || p.startsWith(`${root}/`));
      if (inside.length) setPaths(inside);
    });
  }, [projectId, sessionId, root]);
  const clear = useCallback(() => setPaths(null), []);
  return { paths, clear };
}

const SPLIT_KEY = 'wanigan.live.split';

/** Whether sessions open with the live view beside the terminal; remembered on this Mac, never required. */
export function useLiveSplit(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(SPLIT_KEY) === '1'; } catch { return false; } });
  const set = useCallback((next: boolean) => {
    setOpen(next);
    try { localStorage.setItem(SPLIT_KEY, next ? '1' : '0'); } catch { /* storage unavailable: the choice lasts this window */ }
  }, []);
  return [open, set];
}
