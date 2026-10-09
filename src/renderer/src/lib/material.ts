// What fills Wanigan: water, or the lava lamp. The owner's choice, kept in this
// window's storage and shared by every orb on screen.
import { useSyncExternalStore } from 'react';
import type { OrbMaterial } from '../orb/mood';

const KEY = 'wanigan.material';
const listeners = new Set<() => void>();
let material: OrbMaterial = read();

function read(): OrbMaterial {
  try {
    return localStorage.getItem(KEY) === 'wax' ? 'wax' : 'water';
  } catch {
    return 'water';
  }
}

export function setMaterial(next: OrbMaterial): void {
  material = next;
  try { localStorage.setItem(KEY, next); } catch { /* a per-viewer convenience only */ }
  for (const l of listeners) l();
}

export function useMaterial(): OrbMaterial {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => material);
}
