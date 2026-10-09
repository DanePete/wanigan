import { useSyncExternalStore } from 'react';

/** The orb lab's address. It is deliberately in neither the rail nor the palette. */
export const ORB_LAB_HASH = '#/orb-lab';

const subscribe = (changed: () => void): (() => void) => {
  window.addEventListener('hashchange', changed);
  return () => window.removeEventListener('hashchange', changed);
};

/** Whether the window is showing the orb lab. */
export function useOrbLabRoute(): boolean {
  return useSyncExternalStore(subscribe, () => window.location.hash.startsWith(ORB_LAB_HASH));
}
