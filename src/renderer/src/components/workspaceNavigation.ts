import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'wanigan.navigation.visible';
const COMPACT_QUERY = '(max-width: 980px)';

function storedVisibility(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === 'open'; } catch { return false; }
}

/** Desktop preference and temporary navigation drawer have separate lifetimes. */
export function useWorkspaceNavigation(onError: (message: string) => void) {
  const [desktopOpen, setDesktopOpen] = useState(storedVisibility);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [compactNavigation, setCompactNavigation] = useState(() => window.matchMedia('(max-width: 980px)').matches);
  const desktop = useRef(desktopOpen);
  const revision = useRef(0);
  const pending = useRef(0);
  const unsaved = useRef(false);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const reportError = useRef(onError);
  reportError.current = onError;

  const applyDesktop = useCallback((open: boolean, remember: boolean) => {
    desktop.current = open;
    setDesktopOpen(open);
    if (remember) {
      try { localStorage.setItem(STORAGE_KEY, open ? 'open' : 'closed'); } catch { /* SQLite still remembers. */ }
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    const load = () => {
      if (pending.current > 0 || unsaved.current) return;
      const started = revision.current;
      void window.wanigan.prefs.all().then(settings => {
        if (!mounted || started !== revision.current || pending.current > 0) return;
        if (settings.navSidebar === 'open' || settings.navSidebar === 'closed') applyDesktop(settings.navSidebar === 'open', true);
      }).catch(() => { /* Keep navigation usable during database recovery. */ });
    };
    load();
    window.addEventListener('focus', load);
    window.addEventListener('wanigan:prefs-changed', load);
    return () => {
      mounted = false;
      window.removeEventListener('focus', load);
      window.removeEventListener('wanigan:prefs-changed', load);
    };
  }, [applyDesktop]);

  const saveDesktop = useCallback((open: boolean) => {
    const request = ++revision.current;
    unsaved.current = true;
    applyDesktop(open, false);
    pending.current += 1;
    // Serialize rapid toggles so the last visible choice is also the last write.
    writes.current = writes.current.then(async () => {
      try {
        await window.wanigan.prefs.set('nav_sidebar', open ? 'open' : 'closed');
        if (request === revision.current) {
          unsaved.current = false;
          applyDesktop(open, true);
        }
      } catch (cause) {
        if (request === revision.current) reportError.current(`Navigation changed for this window, but its preference could not be saved: ${cause instanceof Error ? cause.message : String(cause)}`);
      } finally {
        pending.current -= 1;
      }
    });
  }, [applyDesktop]);

  useEffect(() => {
    const media = window.matchMedia(COMPACT_QUERY);
    const changed = () => {
      if (document.activeElement?.closest('#wanigan-sidebar')) document.querySelector<HTMLElement>('.hdr-toggle')?.focus();
      setCompactNavigation(media.matches);
      setDrawerOpen(false);
    };
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const closeSidebar = useCallback(() => {
    document.querySelector<HTMLElement>('.hdr-toggle')?.focus();
    if (window.matchMedia(COMPACT_QUERY).matches) setDrawerOpen(false);
    else saveDesktop(false);
  }, [saveDesktop]);

  const toggleSidebar = useCallback(() => {
    if (window.matchMedia(COMPACT_QUERY).matches) {
      setDrawerOpen(open => !open);
      return;
    }
    if (desktop.current && document.activeElement?.closest('#wanigan-sidebar')) document.querySelector<HTMLElement>('.hdr-toggle')?.focus();
    saveDesktop(!desktop.current);
  }, [saveDesktop]);

  return { sidebarOpen: compactNavigation ? drawerOpen : desktopOpen, compactNavigation, toggleSidebar, closeSidebar, closeDrawer };
}
