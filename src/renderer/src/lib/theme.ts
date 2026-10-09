import { useSyncExternalStore } from 'react';

export type ThemeChoice = 'system' | 'dark' | 'light';
const KEY = 'wanigan.theme';

const media = window.matchMedia('(prefers-color-scheme: light)');
let choice: ThemeChoice = read();
const listeners = new Set<() => void>();

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'light' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function resolved(): 'dark' | 'light' {
  return choice === 'system' ? (media.matches ? 'light' : 'dark') : choice;
}

function apply(): void {
  document.documentElement.dataset.theme = resolved();
  for (const l of listeners) l();
}

export function setTheme(next: ThemeChoice): void {
  choice = next;
  try { localStorage.setItem(KEY, next); } catch { /* per-viewer convenience only */ }
  apply();
}

media.addEventListener('change', apply);
apply();

export function useTheme(): { choice: ThemeChoice; resolved: 'dark' | 'light' } {
  const c = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => choice);
  return { choice: c, resolved: resolved() };
}
