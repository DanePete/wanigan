// Whether the rail is folded to icons (shared/rail.ts decides). The owner's
// own choice is a per-viewer convenience kept in this window's storage; the
// fold is written on the root so everything placed beside the rail
// (--rail-w) moves with it.
import { useCallback, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { railChoice, railCollapsed, toggledRail, type RailChoice } from '@shared/rail';

const KEY = 'wanigan.rail';

function read(): RailChoice | null {
  try { return railChoice(localStorage.getItem(KEY)); } catch { return null; }
}

function write(choice: RailChoice): void {
  try { localStorage.setItem(KEY, choice); } catch { /* convenience only */ }
}

const mark = (collapsed: boolean): void => { document.documentElement.dataset.rail = collapsed ? 'collapsed' : 'expanded'; };

const onResize = (listener: () => void): (() => void) => {
  window.addEventListener('resize', listener);
  return () => window.removeEventListener('resize', listener);
};

export function useRail(): { collapsed: boolean; toggle: () => void } {
  // Marked before the first paint, so a narrow window opens folded rather than folding.
  const [choice, setChoice] = useState(() => {
    const stored = read();
    mark(railCollapsed(stored, window.innerWidth));
    return stored;
  });
  const collapsed = useSyncExternalStore(onResize, () => railCollapsed(choice, window.innerWidth));
  useLayoutEffect(() => { mark(collapsed); }, [collapsed]);
  const toggle = useCallback(() => {
    const next = toggledRail(collapsed);
    write(next);
    setChoice(next);
  }, [collapsed]);
  return { collapsed, toggle };
}
