import { useEffect, useSyncExternalStore } from 'react';
import { useViewMemory } from './viewMemory';

/** A long-running request may finish while its page is unmounted. Keep its state
 * and request lock in the window's view memory, and notify a remounted page.
 * This is session memory only; durable interviews remain in the main database. */
function createCell<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    read: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set: (next: T | ((previous: T) => T)) => {
      value = typeof next === 'function' ? (next as (previous: T) => T)(value) : next;
      listeners.forEach(listener => listener());
    },
  };
}

export function usePlanningMemory<T>(key: string, initial: T): [T, (next: T | ((previous: T) => T)) => void] {
  const [cell, remember] = useViewMemory(`planning:${key}`, createCell(initial));
  // useViewMemory writes on set, not on initial read. Register the cell before
  // leaving this mount so a pending request and its next page share one cell.
  useEffect(() => { remember(cell); }, [cell, remember]);
  return [useSyncExternalStore(cell.subscribe, cell.read), cell.set];
}

/** Other workspaces share the same navigation-safe request and draft storage. */
export { usePlanningMemory as useLiveViewMemory };
