import { useCallback, useEffect, useState } from 'react';

/** The navigation module owns its visibility and responsive lifecycle. */
export function useWorkspaceNavigation() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [compactNavigation, setCompactNavigation] = useState(() => window.matchMedia('(max-width: 980px)').matches);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 980px)');
    const changed = () => { setCompactNavigation(media.matches); setSidebarOpen(false); };
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);

  const toggleSidebar = useCallback(() => {
    if (!window.matchMedia('(max-width: 980px)').matches) {
      document.querySelector<HTMLElement>('.workbench-area-button[aria-current]')?.focus();
      return;
    }
    setSidebarOpen(open => !open);
  }, []);

  return { sidebarOpen, setSidebarOpen, compactNavigation, toggleSidebar };
}
