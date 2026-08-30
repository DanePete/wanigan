import type { ThemeSetting } from '@shared/types';

/**
 * This file is both a tiny pre-React boot entry and the DOM-facing half of the
 * theme system. Keeping it dependency-free means the saved appearance is
 * painted before React, IPC, or a terminal has a chance to draw a dark frame.
 */
export const THEME_STORAGE_KEY = 'wanigan.theme';

export type ResolvedTheme = 'light' | 'dark';

export type ThemeChange = {
  preference: ThemeSetting;
  resolved: ResolvedTheme;
};

export function isThemeSetting(value: unknown): value is ThemeSetting {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function storedThemePreference(): ThemeSetting {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeSetting(saved) ? saved : 'system';
  } catch {
    // Storage can be unavailable in a hardened profile. The operating-system
    // preference is still a complete, safe answer in that case.
    return 'system';
  }
}

export function systemTheme(): ResolvedTheme {
  try {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'dark';
  }
}

export function resolveTheme(preference: ThemeSetting): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference;
}

export function rememberThemePreference(preference: ThemeSetting): void {
  try { window.localStorage.setItem(THEME_STORAGE_KEY, preference); } catch { /* best-effort boot hint */ }
}

/** Apply the resolved value to the document and tell long-lived surfaces. */
export function applyThemePreference(preference: ThemeSetting, remember = false): ResolvedTheme {
  const resolved = resolveTheme(preference);
  if (typeof document === 'undefined') return resolved;
  const root = document.documentElement;
  const changed = root.dataset.theme !== resolved || root.dataset.themePreference !== preference;
  root.dataset.theme = resolved;
  root.dataset.themePreference = preference;
  root.style.colorScheme = resolved;
  if (remember) rememberThemePreference(preference);
  if (changed && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<ThemeChange>('wanigan:theme-changed', {
      detail: { preference, resolved },
    }));
  }
  return resolved;
}

// External, CSP-compliant boot script used by index.html. Guarding document
// also makes importing these helpers harmless in a non-renderer test process.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  applyThemePreference(storedThemePreference());
}
