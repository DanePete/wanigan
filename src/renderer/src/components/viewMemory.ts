import {
  createContext, createElement, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
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
  const claimed = useRef<string | null>(null);
  // The scope is claimed while it renders, not from its effect, because the
  // clearing a claim performs has to beat the view below to the store. React
  // renders a parent before its children but runs every effect after the whole
  // subtree has rendered, and a view reads its remembered keys in a useState
  // initializer — during render. Claiming from the effect therefore cleared a
  // broken view's keys one beat too late: Reload mounted a fresh instance that
  // had already read back the exact state that broke it, and the clear only
  // took effect for the mount after that. Rendering here is the earliest point
  // that is still inside the new scope.
  //
  // The ref keeps it to one claim per view. A re-render for any other reason
  // must not re-clear, while a changed `view` prop — App keeps this instance
  // across a tab swap and only swaps the prop — genuinely is a new scope.
  if (claimed.current !== view) {
    claimed.current = view;
    store?.scopeMounted(view);
  }
  useEffect(() => {
    pendingUnmount.current = false;
    // Re-asserted after the commit. A render pass React discards can claim a
    // scope that never reaches the screen, and `current` has to name the scope
    // that did for the unmount below to tell a crash apart from a swap.
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
  // The store write cannot live inside the setState updater. React drops a
  // queued update when the component unmounts before the next render, so a
  // setter called in the same tick as a tab swap — a click that both changes a
  // filter and navigates — never ran the updater, never reached the store, and
  // the view came back holding the value the operator had just replaced. An
  // updater is also invoked twice under StrictMode, which is the wrong place
  // for a side effect on principle. Resolving against the ref instead keeps
  // the write synchronous with the call, and keeps consecutive setter calls in
  // one tick building on each other the way the updater form promises.
  const latest = useRef(value);
  const set = useCallback((next: T | ((previous: T) => T)) => {
    const resolved = typeof next === 'function' ? (next as (previous: T) => T)(latest.current) : next;
    latest.current = resolved;
    store?.set(full, resolved);
    setValue(resolved);
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
    // The cleanup deliberately does not save the offset. StrictMode runs every
    // mount as effect, simulated cleanup, effect; on the first pass the restore
    // has usually not settled, so a cleanup write stored the element's current
    // scrollTop — 0 — over the saved offset, and the second pass faithfully
    // restored 0. An `el.isConnected` guard does not help, because the node is
    // still connected during a simulated unmount. Nor is the write needed: the
    // offset has exactly one writer, onScroll, and it fires for every scroll
    // including the assignment in apply(). A second writer that can only run
    // when the value it holds is wrong is a liability, not a safety net.
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', onScroll);
      want = null;
    };
  }, [ref, store, full]);
}

/**
 * The same memory for a scroller that is not in the tree at first paint — a
 * list rendered only once its rows arrive, or a panel behind a disclosure.
 * A ref object filling in from null to the node is invisible to the effect
 * above: no dependency changed, nothing re-runs, and the offset is never
 * restored. A callback ref that puts the node in state re-renders when the
 * node attaches and hands useRememberedScroll a fresh ref object, so the
 * restore runs against an element that exists.
 *
 * Pass the returned function straight to `ref=`. React 19 reads a ref
 * callback's return value as a cleanup, and a state setter returns undefined,
 * which it takes as "no cleanup" — it then detaches by calling the callback
 * with null, which is exactly the update this hook wants on unmount.
 */
export function useRememberedScrollRef(key: string): (element: HTMLElement | null) => void {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const ref = useMemo<RefObject<HTMLElement | null>>(() => ({ current: element }), [element]);
  useRememberedScroll(ref, key);
  return setElement;
}
