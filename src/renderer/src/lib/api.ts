// The renderer's only door to the core, plus the hooks views read data through.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CoreProblem, CoreStatus, WaniganBridge } from '@shared/bridge';
import type { EventName, Method, Params, Result } from '@shared/protocol';

declare global {
  interface Window {
    wanigan: WaniganBridge;
  }
}

export const bridge = (): WaniganBridge => window.wanigan;

export function call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
  return window.wanigan.call(method, params);
}

export interface Query<T> {
  data: T | undefined;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Data from the core, refetched when an event says it may have changed. A view
 * names the events it depends on; `match` narrows them (e.g. to one project).
 * Responses that arrive out of order are dropped.
 */
export function useQuery<M extends Method>(
  method: M,
  params: Params<M> | null,
  events: readonly EventName[],
  match?: (event: EventName, data: unknown) => boolean,
): Query<Result<M>> {
  const key = params === null ? null : JSON.stringify([method, params]);
  const [state, setState] = useState<{ key: string | null; data: Result<M> | undefined; error: Error | null; loading: boolean }>(
    { key, data: undefined, error: null, loading: params !== null },
  );
  const seq = useRef(0);
  const matchRef = useRef(match);
  matchRef.current = match;
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const fetchNow = useCallback(() => {
    const p = paramsRef.current;
    if (p === null) return;
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    call(method, p).then(
      (data) => { if (mine === seq.current) setState({ key, data, error: null, loading: false }); },
      (error: Error) => { if (mine === seq.current) setState((s) => ({ ...s, key, error, loading: false })); },
    );
  }, [method, key]);

  useEffect(() => {
    if (key === null) {
      setState({ key, data: undefined, error: null, loading: false });
      return;
    }
    setState((s) => (s.key === key ? s : { key, data: undefined, error: null, loading: true }));
    fetchNow();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (): void => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; fetchNow(); }, 40);
    };
    const offEvent = window.wanigan.on((event, data) => {
      if (!events.includes(event)) return;
      if (matchRef.current && !matchRef.current(event, data)) return;
      schedule();
    });
    const offStatus = window.wanigan.onStatus((s) => { if (s === 'connected') schedule(); });
    return () => {
      offEvent();
      offStatus();
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, fetchNow, events.join()]);

  const current = state.key === key;
  return { data: current ? state.data : undefined, error: current ? state.error : null, loading: !current || state.loading, reload: fetchNow };
}

/** Matches events for one project. */
export const forProject = (projectId: string | undefined) => (_event: EventName, data: unknown): boolean =>
  !projectId || !data || typeof data !== 'object' || !('projectId' in data) || (data as { projectId: string }).projectId === projectId;

let status: CoreStatus = 'connecting';
const statusListeners = new Set<() => void>();
let statusWired = false;

function wireStatus(): void {
  if (statusWired) return;
  statusWired = true;
  const set = (s: CoreStatus): void => { status = s; for (const l of statusListeners) l(); };
  let heard = false;
  window.wanigan.onStatus((s) => { heard = true; set(s); });
  void window.wanigan.status().then((s) => { if (!heard) set(s); });
}

export function useCoreStatus(): CoreStatus {
  wireStatus();
  return useSyncExternalStore(
    (l) => { statusListeners.add(l); return () => statusListeners.delete(l); },
    () => status,
  );
}

let problem: CoreProblem | null = null;
const problemListeners = new Set<() => void>();
let problemWired = false;

function wireProblem(): void {
  if (problemWired) return;
  problemWired = true;
  const set = (p: CoreProblem | null): void => { problem = p; for (const l of problemListeners) l(); };
  // What the app says next wins over a first answer that arrives after it.
  let heard = false;
  window.wanigan.onCoreProblem((p) => { heard = true; set(p); });
  void window.wanigan.coreProblem().then((p) => { if (!heard) set(p); });
}

/** What is wrong with the core (it could not start, or is from another build), or null. */
export function useCoreProblem(): CoreProblem | null {
  wireProblem();
  return useSyncExternalStore(
    (l) => { problemListeners.add(l); return () => problemListeners.delete(l); },
    () => problem,
  );
}

/** Run an action, surfacing a refusal or failure as a toast instead of an exception. */
export async function attempt<T>(action: () => Promise<T>, onError: (message: string) => void): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    onError((error as Error).message);
    return undefined;
  }
}
