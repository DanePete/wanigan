// The app's own settings, kept by the main process. Null outside the app (the
// browser harness may not provide them) or before the first answer.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings, AppState } from '@shared/settings';
import { bridge } from './api';

export function useAppState(): {
  state: AppState | null;
  update: (patch: Partial<AppSettings>) => Promise<void>;
  /** Ask GitHub now whether a newer version is out. */
  check: () => Promise<void>;
} {
  const [state, setState] = useState<AppState | null>(null);
  const revision = useRef(0);
  useEffect(() => {
    const initial = revision.current;
    const off = bridge().onAppState((s) => { revision.current++; setState(s); });
    void bridge().appState().then((s) => { if (initial === revision.current && s) setState(s); }).catch(() => {});
    return () => { revision.current++; off(); };
  }, []);
  const read = useCallback(async (request: () => Promise<AppState | null>) => {
    const mine = ++revision.current;
    const next = await request();
    if (next && mine === revision.current) setState(next);
  }, []);
  const update = useCallback((patch: Partial<AppSettings>) => read(() => bridge().setSettings(patch)), [read]);
  const check = useCallback(() => read(() => bridge().checkForUpdates()), [read]);
  return { state, update, check };
}
