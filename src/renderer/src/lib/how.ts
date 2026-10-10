// Which views have a "How this works" (components/How.tsx), and which one is
// open: a view registers its own while it is shown, so the palette can offer
// "How this view works" exactly where there is one, and open it from there.
import { useEffect, useSyncExternalStore } from 'react';

const shown = new Map<string, number>();
let open: string | null = null;
const listeners = new Set<() => void>();
let version = 0;

function tell(): void { version++; for (const l of listeners) l(); }
function subscribe(l: () => void): () => void { listeners.add(l); return () => { listeners.delete(l); }; }

/** A view's How this works: whether it is open, and opening and closing it. Registers the view while it is mounted. */
export function useHow(place: string): { open: boolean; show: () => void; hide: () => void } {
  useEffect(() => {
    shown.set(place, (shown.get(place) ?? 0) + 1);
    tell();
    return () => {
      const n = (shown.get(place) ?? 1) - 1;
      if (n > 0) shown.set(place, n); else shown.delete(place);
      if (open === place) open = null;
      tell();
    };
  }, [place]);
  const isOpen = useSyncExternalStore(subscribe, () => open === place);
  return { open: isOpen, show: () => openHow(place), hide: () => { if (open === place) { open = null; tell(); } } };
}

/** Whether the place shown now has a How this works. */
export function useHowAvailable(place: string): boolean {
  useSyncExternalStore(subscribe, () => version);
  return shown.has(place);
}

export function openHow(place: string): void {
  open = place;
  tell();
}
