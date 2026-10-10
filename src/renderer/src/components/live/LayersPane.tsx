// The side panel's Layers tab: the page's parts as a tree, and the chosen
// part's details with it. Choosing a part (in the tree, on the page, from the
// library) shows its Inspector without hiding the tree: above it, folded to
// the chosen part's branch, or beside it once the window is wide enough for
// both (WIDE, the same width as the stylesheet's). The tree keeps the chosen
// part marked as the choice changes from the page. Escape, in either, goes
// back to the tree alone, unfolded as it was.
import { useLayoutEffect, useRef, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';

/** From this window width the tree sits beside the chosen part (live.css says the same). */
const WIDE = '(min-width: 1680px)';

function subscribeWide(change: () => void): () => void {
  const list = window.matchMedia?.(WIDE);
  list?.addEventListener('change', change);
  return () => list?.removeEventListener('change', change);
}
const wideNow = (): boolean => !!window.matchMedia?.(WIDE).matches;

/** Whether the tree sits beside the chosen part: the stylesheet decides the layout, this the folding. */
export function useTreeBeside(): boolean {
  return useSyncExternalStore(subscribeWide, wideNow);
}

/** Put the keyboard back on the tree's current row: after the part it was on went away. */
export function focusTree(): void {
  window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.live-split-tree .live-tree [tabindex="0"]')?.focus());
}

export function LayersPane({ part, before, tree, after, onBack }: {
  /** The chosen part's details (the Inspector), or null for the tree alone. */
  part: ReactNode | null;
  /** Above and below the tree while it is alone: what the helper says, the offer to set it up. */
  before?: ReactNode;
  tree: ReactNode;
  after?: ReactNode;
  /** Back to the tree alone (Escape in the tree while a part is chosen). */
  onBack: () => void;
}) {
  const beside = useTreeBeside();
  const box = useRef<HTMLDivElement>(null);
  // With a part chosen the panel itself no longer scrolls (the tree and the details each do): it starts at its top.
  const chosen = !!part;
  useLayoutEffect(() => {
    const side = box.current?.closest<HTMLElement>('.live-side');
    if (chosen && side) side.scrollTop = 0;
  }, [chosen]);
  const keys = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!part || e.defaultPrevented || e.key !== 'Escape' || (e.target as Element).closest('input, textarea, select, [role="menu"], .sel-list')) return;
    e.preventDefault();
    onBack();
  };
  // One shape whether a part is chosen or not, so the tree is never mounted again: it keeps what is open.
  return (
    <div className={`live-split${part ? ' with-part' : ''}`} data-beside={part && beside ? '' : undefined} ref={box}>
      <div className="live-split-tree" onKeyDown={keys}>
        {part ? null : before}
        {tree}
        {part ? null : after}
      </div>
      {part ? <div className="live-split-part">{part}</div> : null}
    </div>
  );
}
