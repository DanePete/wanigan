import {
  createContext, createElement, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState,
  type ReactNode, type RefObject,
} from 'react';

/**
 * Per-view memory that survives a tab swap.
 *
 * App mounts exactly one view at a time, so every swap unmounts the outgoing
 * view: its filters, its selection and its scroll position restart on return.
 * xterm survives because TerminalPane pools terminals outside React; nothing
 * else does. This is a shell-level map that views read on mount and write on
 * change. It is per window and in memory — nothing is written to disk — and
 * it is deliberately not "keep the view mounted but hidden": a hidden Sessions
 * throwing while Fleet is on screen would replace Fleet with a fallback named
 * for the wrong view.
 *
 * A view that broke is a view whose remembered state may be the reason. When
 * the error boundary shows its fallback, the view's keys are cleared before
 * the next view mounts — Reload or a tab swap — so the fresh instance starts
 * clean, matching the boundary's own "a new key remounts the subtree" intent.
 */

type Store = {
  has: (key: string) => boolean;
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  clear: (view: string) => void;
  scopeMounted: (view: string) => void;
  scopeUnmounted: (view: string) => void;
};

function createStore(): Store {
  const map = new Map<string, unknown>();
  // The view whose scope mounted most recently, and a view whose scope left
  // the screen without another arriving — which only the boundary's fallback
  // does. A normal swap always mounts the next view in the same commit.
  let current: string | null = null;
  let broken: string | null = null;
  const clear = (view: string) => {
    for (const key of Array.from(map.keys())) if (key.startsWith(`${view}/`)) map.delete(key);
  };
  return {
    has: (key) => map.has(key),
    get: (key) => map.get(key),
    set: (key, value) => { map.set(key, value); },
    clear,
    scopeMounted: (view) => {
      if (broken !== null) { clear(broken); broken = null; }
      current = view;
    },
    scopeUnmounted: (view) => {
      if (current === view) broken = view;
    },
  };
}

const StoreContext = createContext<Store | null>(null);
const ScopeContext = createContext<string>('shell');

export function ViewMemoryProvider({ children }: { children: ReactNode }) {
  const store = useRef<Store | null>(null);
  if (store.current === null) store.current = createStore();
  return createElement(StoreContext.Provider, { value: store.current }, children);
}

/**
 * Names the view the hooks below belong to. App renders it inside the error
 * boundary so that a fallback — which unmounts this scope without mounting
 * another — is what marks the view's memory for clearing.
 */
export function ViewMemoryScope({ view, children }: { view: string; children: ReactNode }) {
  const store = useContext(StoreContext);
  const pendingUnmount = useRef(false);
  useEffect(() => {
    pendingUnmount.current = false;
    store?.scopeMounted(view);
    return () => {
      pendingUnmount.current = true;
      // Deferred a microtask: React StrictMode re-runs an effect synchronously
      // after a simulated cleanup, and a prop change runs cleanup then effect
      // in the same pass. Only a real unmount is still pending afterwards.
      queueMicrotask(() => { if (pendingUnmount.current) store?.scopeUnmounted(view); });
    };
  }, [store, view]);
  return createElement(ScopeContext.Provider, { value: view }, children);
}

/**
 * `const [sort, setSort] = useViewMemory('sort', 'attention')` — state that
 * comes back when the view does. Keys are namespaced by the enclosing scope,
 * so two views may both call it 'sort'.
 */
export function useViewMemory<T>(key: string, initial: T): [T, (next: T | ((previous: T) => T)) => void] {
  const store = useContext(StoreContext);
  const scope = useContext(ScopeContext);
  const full = `${scope}/${key}`;
  const [value, setValue] = useState<T>(() => (store?.has(full) ? store.get(full) as T : initial));
  const set = useCallback((next: T | ((previous: T) => T)) => {
    setValue((previous) => {
      const resolved = typeof next === 'function' ? (next as (previous: T) => T)(previous) : next;
      store?.set(full, resolved);
      return resolved;
    });
  }, [store, full]);
  return [value, set];
}

/**
 * Remembers a scroller's position: saved as it scrolls, restored on mount.
 * Views load their rows after mounting, so the restore is retried while the
 * element grows until it lands or the operator scrolls.
 */
export function useRememberedScroll(ref: RefObject<HTMLElement | null>, key: string): void {
  const store = useContext(StoreContext);
  const scope = useContext(ScopeContext);
  const full = `${scope}/scroll:${key}`;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !store) return;
    const saved = store.get(full);
    let want = typeof saved === 'number' ? saved : null;
    let settled = want === null;
    const apply = () => {
      if (want === null || settled) return;
      if (el.scrollHeight - el.clientHeight >= want) { el.scrollTop = want; settled = true; ro.disconnect(); }
    };
    const ro = new ResizeObserver(apply);
    const onScroll = () => {
      // The operator scrolled: their position wins over the remembered one.
      settled = true;
      store.set(full, el.scrollTop);
    };
    apply();
    if (!settled) { ro.observe(el); for (const child of Array.from(el.children)) ro.observe(child); }
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', onScroll);
      store.set(full, el.scrollTop);
      want = null;
    };
  }, [ref, store, full]);
}
