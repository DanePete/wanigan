import { useCallback, useEffect, useRef, useState } from 'react';
import type { ThemeSetting } from '@shared/types';
import {
  applyThemePreference,
  isThemeSetting,
  resolveTheme,
  storedThemePreference,
  type ResolvedTheme,
} from './theme-boot';

export type ThemeState = {
  preference: ThemeSetting;
  resolved: ResolvedTheme;
  setTheme: (preference: ThemeSetting) => Promise<ThemeSetting>;
};

/**
 * Keep the user-visible theme in sync with both durable settings and macOS.
 * The localStorage hint makes the initial paint stable; SQLite remains the
 * source of truth and wins after the privileged settings bridge is available.
 */
export function useThemePreference(): ThemeState {
  const [preference, setPreference] = useState<ThemeSetting>(storedThemePreference);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(storedThemePreference()));
  const preferenceRef = useRef(preference);
  const revision = useRef(0);
  const pendingWrites = useRef(0);

  const apply = useCallback((next: ThemeSetting, remember = true) => {
    const nextResolved = applyThemePreference(next, remember);
    setResolved((current) => current === nextResolved ? current : nextResolved);
    return nextResolved;
  }, []);

  useEffect(() => {
    preferenceRef.current = preference;
    apply(preference);

    // macOS can switch after Wanigan is already open. Explicit light/dark
    // choices intentionally do not listen, so they never surprise the user.
    if (preference !== 'system' || typeof window === 'undefined' || !window.matchMedia) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (preferenceRef.current === 'system') apply('system');
    };
    const modernListener = typeof media.addEventListener === 'function';
    if (modernListener) media.addEventListener('change', onChange);
    // Older embedded Chromium versions use the legacy MediaQueryList API.
    else media.addListener?.(onChange);
    return () => {
      if (modernListener) media.removeEventListener('change', onChange);
      else media.removeListener?.(onChange);
    };
  }, [apply, preference]);

  const refresh = useCallback(async () => {
    if (pendingWrites.current > 0) return;
    const startedAt = revision.current;
    const settings = await window.wanigan.prefs.all();
    // A response that began before an optimistic local save may only describe
    // the old value. Never let it visibly roll the control back.
    if (startedAt !== revision.current || pendingWrites.current > 0) return;
    const next = isThemeSetting(settings.theme) ? settings.theme : 'system';
    setPreference((current) => current === next ? current : next);
  }, []);

  useEffect(() => {
    let mounted = true;
    const load = () => {
      void refresh().catch(() => {
        // Recovery mode deliberately leaves presentation usable even when the
        // local database has not opened. The saved local hint remains in use.
        if (!mounted) return;
      });
    };
    load();
    window.addEventListener('focus', load);
    window.addEventListener('wanigan:prefs-changed', load);
    return () => {
      mounted = false;
      window.removeEventListener('focus', load);
      window.removeEventListener('wanigan:prefs-changed', load);
    };
  }, [refresh]);

  const setTheme = useCallback(async (next: ThemeSetting): Promise<ThemeSetting> => {
    if (!isThemeSetting(next)) throw new Error('Theme must be system, light, or dark.');
    const previous = preferenceRef.current;
    if (next === previous) {
      apply(next);
      return next;
    }

    const request = ++revision.current;
    pendingWrites.current += 1;
    preferenceRef.current = next;
    setPreference(next);
    apply(next);

    try {
      const saved = await window.wanigan.prefs.setTheme(next);
      const confirmed = isThemeSetting(saved.theme) ? saved.theme : next;
      if (request === revision.current) {
        preferenceRef.current = confirmed;
        setPreference(confirmed);
        apply(confirmed);
      }
      // Other surfaces already listen for this event to refresh local
      // preferences. Dispatch only after SQLite has confirmed the change.
      window.dispatchEvent(new CustomEvent('wanigan:prefs-changed'));
      return confirmed;
    } catch (error) {
      if (request === revision.current) {
        preferenceRef.current = previous;
        setPreference(previous);
        apply(previous);
      }
      throw error;
    } finally {
      pendingWrites.current -= 1;
    }
  }, [apply]);

  return { preference, resolved, setTheme };
}
