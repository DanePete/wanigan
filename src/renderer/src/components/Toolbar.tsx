// A row of tools (WAI-ARIA toolbar): one Tab stop for the whole row, the
// arrow keys, Home and End to move along it. A ToolGroup is a sunk track of
// IconButtons inside it (Select, Type, Style, Move | Snap, Record, Voice); a
// tool that is on shows `pressed` (IconButton) in water. A field in the row
// keeps its arrow keys for its caret, and a group that moves by arrows itself
// (a Segmented, Tabs) keeps them too: Tab reaches it, and leaves it.
import { createContext, useContext, useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';

const InToolbar = createContext(false);

/** What the arrows move between: buttons and links, not those inside a group that moves by itself. */
const ITEMS = 'button:not(:disabled), a[href]';
const OWN_KEYS = '[role="radiogroup"], [role="tablist"], [role="menu"], [role="listbox"]';

function items(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(ITEMS)].filter((el) => {
    const own = el.closest(OWN_KEYS);
    return !(own && root.contains(own)) && el.getClientRects().length > 0;
  });
}

/** One Tab stop for the row: the last one focused, or the first. Kept as the row changes. */
function useRoving(root: RefObject<HTMLElement | null>, on: boolean): (e: KeyboardEvent<HTMLElement>) => void {
  const last = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = root.current;
    if (!el || !on) return undefined;
    const apply = (): void => {
      const list = items(el);
      const stop = list.includes(last.current as HTMLElement) ? last.current : list.find((x) => x.getAttribute('aria-pressed') === 'true') ?? list[0];
      for (const x of list) { const want = x === stop ? '0' : '-1'; if (x.getAttribute('tabindex') !== want) x.setAttribute('tabindex', want); }
    };
    const focus = (e: FocusEvent): void => {
      const t = e.target as HTMLElement;
      if (items(el).includes(t)) { last.current = t; apply(); }
    };
    apply();
    const watch = new MutationObserver(apply);
    watch.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden'] });
    el.addEventListener('focusin', focus);
    return () => { watch.disconnect(); el.removeEventListener('focusin', focus); };
  }, [root, on]);
  return (e) => {
    const el = root.current;
    const t = e.target as HTMLElement;
    if (!el || !on || e.altKey || e.metaKey || e.ctrlKey) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    if (t.closest('input, textarea, select, [contenteditable="true"]') || (t.closest(OWN_KEYS) && el.contains(t.closest(OWN_KEYS)))) return;
    const list = items(el);
    const at = list.indexOf(t);
    if (at < 0) return;
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (at + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
    e.preventDefault();
    list[to]?.focus();
  };
}

/** A bar of tools: role="toolbar", named, one Tab stop, the arrows along it. */
export function Toolbar({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = useRoving(ref, true);
  return (
    <div ref={ref} role="toolbar" aria-label={label} className={`toolbar-row${className ? ` ${className}` : ''}`} onKeyDown={onKey}>
      <InToolbar.Provider value>{children}</InToolbar.Provider>
    </div>
  );
}

/** Tools that belong together, in a sunk track. On its own (not in a Toolbar) it is a toolbar itself. */
export function ToolGroup({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const inside = useContext(InToolbar);
  const ref = useRef<HTMLDivElement>(null);
  const onKey = useRoving(ref, !inside);
  return (
    <div ref={ref} role={inside ? 'group' : 'toolbar'} aria-label={label} className={`tool-group${className ? ` ${className}` : ''}`}
      onKeyDown={inside ? undefined : onKey}>
      <InToolbar.Provider value>{children}</InToolbar.Provider>
    </div>
  );
}

/** A thin rule between tools in a group (Move | Snap). */
export function ToolSeparator() {
  return <span className="tool-sep" role="separator" aria-orientation="vertical" />;
}
