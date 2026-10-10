// The page's parts as layers, in the Structure panel: what holds what, named
// the way the site names them. Pointing at a row outlines the part on the page;
// choosing it opens its details in the Inspector, and the tree marks it
// (however it was chosen) and brings it into view. Folded (`fold`), the tree
// shows only the way down to the chosen part; unfolded again it is as it was. Arrow keys walk the tree as in any tree
// (WAI-ARIA tree pattern). Show in DevTools stands beside the row pointed at
// or walked to (one button, after the tree, so the tree holds only its rows):
// ⇧D on a row does the same.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { LiveComponent, LiveRegion } from '@shared/live';
import { liveKey } from '@shared/live-keys';
import { nameOf, type LiveKind } from '@shared/live-names';
import { layersOf, pathTo, type Layer } from '@shared/live-tree';
import { Icon, type IconName } from '../icons';
import { IconButton, Toggle } from '../ui';
import { LIVE_TIP } from './keys';

export const KIND_ICON: Record<LiveKind, IconName> = {
  component: 'pieces', content: 'content', field: 'field', block: 'block', region: 'region', view: 'list', menu: 'menu',
  form: 'form', media: 'image', page: 'live', template: 'file', element: 'pieces',
};

const ALL_KEY = 'wanigan.live.allPieces';

function readAll(): boolean {
  try { return localStorage.getItem(ALL_KEY) === '1'; } catch { return false; }
}

/** The rows as shown, top to bottom: what the arrow keys walk. */
function visibleRows(layers: readonly Layer[], open: ReadonlySet<string>, depth = 0, parent: string | null = null): { layer: Layer; depth: number; parent: string | null }[] {
  const out: { layer: Layer; depth: number; parent: string | null }[] = [];
  for (const layer of layers) {
    out.push({ layer, depth, parent });
    if (layer.children.length && open.has(layer.key)) out.push(...visibleRows(layer.children, open, depth + 1, layer.key));
  }
  return out;
}

/** Bring a row into view in the box that scrolls it, and only there: the panel around the tree stays where it is. */
function reveal(row: HTMLElement): void {
  let box = row.parentElement;
  while (box && !(box.scrollHeight > box.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
  if (!box) return;
  const r = row.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  // With room around it: flush with the edge, the row sat half under the box's own scrollbar, with nothing past it.
  const m = Math.max(0, Math.min(48, (b.height - r.height) / 2));
  if (r.top < b.top + m) box.scrollTop -= b.top + m - r.top;
  else if (r.bottom > b.bottom - m) box.scrollTop += r.bottom - (b.bottom - m);
}

export function Layers({ regions, components, selected, fold = false, changed, onHover, onSelect, partName, onDevtools }: {
  regions: LiveRegion[];
  components: Map<string, LiveComponent>;
  /** The chosen part, by index: marked, opened to and scrolled to. */
  selected: number | null;
  /** Show only the chosen part's branch (the tree above its details), keeping what was open for when it is not. */
  fold?: boolean;
  /** Parts the last edit made, by index: marked, and opened to. */
  changed: ReadonlySet<number>;
  /** Point at parts on the page, with what to call them; null to stop. */
  onHover: (regions: LiveRegion[] | null, label: string | null) => void;
  onSelect: (region: LiveRegion) => void;
  /** The site helper's label and kind for a part id, from the page's trace. */
  partName?: (id: string) => { label: string; kind: string } | null;
  /** Show a row's part in the page's DevTools (its Elements panel on it). */
  onDevtools?: (region: LiveRegion) => void;
}) {
  const [all, setAll] = useState(readAll);
  const layers = useMemo(() => layersOf(regions, { all, componentName: (id) => components.get(id)?.name ?? null, partName }), [regions, all, components, partName]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const tree = useRef<HTMLUListElement>(null);
  // Where the pointer last really was: a fold moving rows under a still pointer is not the owner pointing at another part.
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const pointed = (e: { clientX: number; clientY: number }): boolean => {
    const was = pointer.current;
    pointer.current = { x: e.clientX, y: e.clientY };
    return !was || was.x !== e.clientX || was.y !== e.clientY;
  };

  // The top level starts open, and so does the way down to every component and piece of content (what the
  // owner came to find), and to what is chosen or changed.
  useEffect(() => {
    setOpen((was) => {
      const next = new Set(was);
      for (const l of layers) next.add(l.key);
      const wanted = regions.filter((r) => r.component || r.entity).map((r) => r.index);
      for (const index of [...wanted, ...changed, ...(selected === null ? [] : [selected])]) {
        for (const l of pathTo(layers, index).slice(0, -1)) if (l.regions.length === 1) next.add(l.key);
      }
      return next;
    });
  }, [layers, regions, changed, selected]);

  // Folded to the chosen part's branch: the top level, and the way down to it. Derived in the same render as the
  // choice, so the tree never shows a frame of the old one; what is opened or closed while folded lasts until the
  // choice changes. `open` itself is left alone, so the tree comes back unfolded exactly as it was.
  const folded = useMemo(() => {
    const path = fold && selected !== null ? pathTo(layers, selected) : [];
    return path.length ? new Set(path.slice(0, -1).map((l) => l.key)) : null;
  }, [fold, selected, layers]);
  const [foldFlips, setFoldFlips] = useState<{ base: ReadonlySet<string>; open: ReadonlySet<string> } | null>(null);
  const shown: ReadonlySet<string> = folded ? (foldFlips?.base === folded ? foldFlips.open : folded) : open;

  const rows = useMemo(() => visibleRows(layers, shown), [layers, shown]);
  // The chosen row is where the keys start, and is brought into view, however it was chosen (the page, the library).
  const chosenKey = useMemo(() => (selected === null ? null : pathTo(layers, selected).at(-1)?.key ?? null), [layers, selected]);
  useEffect(() => { if (chosenKey) setFocus(chosenKey); }, [chosenKey]);
  const scrolledTo = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!chosenKey) { scrolledTo.current = null; return; }
    if (scrolledTo.current === chosenKey) return;
    // Once its row is drawn (folding to it may draw it a moment later), and once: the owner may scroll away.
    const row = tree.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(chosenKey)}"]`);
    if (!row) return;
    reveal(row);
    scrolledTo.current = chosenKey;
  }, [chosenKey, rows]);
  const changedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const index of changed) for (const l of pathTo(layers, index)) keys.add(l.key);
    return keys;
  }, [changed, layers]);
  const current = focus && rows.some((r) => r.layer.key === focus) ? focus : rows[0]?.layer.key ?? null;
  // The row Show in DevTools stands beside: the one pointed at last, else the one the keyboard is on.
  const [pointedKey, setPointedKey] = useState<string | null>(null);
  const actKey = pointedKey && rows.some((r) => r.layer.key === pointedKey) ? pointedKey : current;
  const actRow = rows.find((r) => r.layer.key === actKey) ?? null;
  const [actAt, setActAt] = useState<{ top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const row = actKey ? tree.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(actKey)}"]`) : null;
    setActAt(row ? { top: row.offsetTop, height: row.offsetHeight } : null);
  }, [actKey, rows]);

  const toggleAll = (): void => {
    setAll((v) => {
      try { localStorage.setItem(ALL_KEY, v ? '0' : '1'); } catch { /* the choice lasts this window only */ }
      return !v;
    });
  };
  const move = (key: string | null): void => {
    if (!key) return;
    setFocus(key);
    requestAnimationFrame(() => tree.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus());
  };
  const flip = (key: string, to?: boolean): void => {
    const toggled = (was: ReadonlySet<string>): Set<string> => {
      const next = new Set(was);
      if (to ?? !next.has(key)) next.add(key); else next.delete(key);
      return next;
    };
    if (folded) setFoldFlips({ base: folded, open: toggled(shown) });
    else setOpen(toggled);
  };

  const keys = (e: KeyboardEvent<HTMLUListElement>): void => {
    // ⌘ and the like make a key something else (⇧⌘↩ sends the notes waiting): the tree's are the plain ones.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const at = rows.findIndex((r) => r.layer.key === current);
    const row = rows[at];
    if (!row) return;
    const { layer } = row;
    // ⇧D: this row's part in DevTools (the live view's ⇧D shows the chosen part; here the row with the keyboard is it).
    if (onDevtools && liveKey(e) === 'devtools-show') { e.preventDefault(); onDevtools(layer.region); return; }
    switch (e.key) {
      case 'ArrowDown': move(rows[Math.min(rows.length - 1, at + 1)]?.layer.key ?? null); break;
      case 'ArrowUp': move(rows[Math.max(0, at - 1)]?.layer.key ?? null); break;
      case 'Home': move(rows[0]?.layer.key ?? null); break;
      case 'End': move(rows.at(-1)?.layer.key ?? null); break;
      case 'ArrowRight':
        if (layer.children.length && !shown.has(layer.key)) flip(layer.key, true);
        else if (layer.children.length) move(layer.children[0]?.key ?? null);
        break;
      case 'ArrowLeft':
        if (layer.children.length && shown.has(layer.key)) flip(layer.key, false);
        else move(row.parent);
        break;
      case 'Enter':
      case ' ':
        onSelect(layer.region);
        break;
      default: return;
    }
    e.preventDefault();
  };

  if (!layers.length) return null;
  return (
    <div className={`live-layers${onDevtools ? ' with-act' : ''}`}>
      <ul className="live-tree" role="tree" aria-label="Parts of this page" ref={tree} onKeyDown={keys}
        onMouseMove={(e) => { pointer.current = { x: e.clientX, y: e.clientY }; }} onMouseLeave={() => { pointer.current = null; onHover(null, null); }}>
        {rows.map(({ layer, depth }) => {
          const isOpen = shown.has(layer.key);
          const chosen = layer.regions.some((r) => r.index === selected) || layer.merged.some((r) => r.index === selected);
          const theirs = layer.name.origin === 'contrib' || layer.name.origin === 'core';
          const label = layer.regions.length > 1 ? `${layer.name.title} ×${layer.regions.length}` : layer.name.title;
          return (
            <li key={layer.key} role="treeitem" aria-level={depth + 1} aria-selected={chosen}
              aria-expanded={layer.children.length ? isOpen : undefined} tabIndex={layer.key === current ? 0 : -1} data-key={layer.key}
              className={`live-layer${chosen ? ' on' : ''}${theirs ? ' theirs' : ''}`} style={{ '--depth': depth } as CSSProperties}
              data-tip={layer.merged.length ? layer.merged.map((m) => nameOf(m).title).join(' › ') : undefined} data-tip-side="right"
              onFocus={() => { setFocus(layer.key); setPointedKey(null); }}
              onMouseEnter={(e) => { if (pointed(e)) { onHover(layer.regions, label); setPointedKey(layer.key); } }}
              onClick={() => { setFocus(layer.key); onSelect(layer.region); }}>
              {layer.children.length ? (
                <span className={`live-layer-twist${isOpen ? ' open' : ''}`} aria-hidden="true"
                  onClick={(e) => { e.stopPropagation(); flip(layer.key); }}>
                  <Icon name="chevron" size={12} />
                </span>
              ) : <span className="live-layer-twist" aria-hidden="true" />}
              <Icon name={KIND_ICON[layer.name.icon]} size={14} className="live-layer-icon" />
              <span className="live-layer-title">{layer.name.title}</span>
              {layer.regions.length > 1 ? <span className="live-layer-count">×{layer.regions.length}</span> : null}
              {changedKeys.has(layer.key) ? <span className="live-layer-changed" role="img" aria-label="The last edit changed this" /> : null}
            </li>
          );
        })}
      </ul>
      {onDevtools && actRow && actAt ? (
        <span className="live-layer-act" style={{ top: actAt.top, height: actAt.height }}>
          <IconButton icon="devtools" size="s" label={`Show ${actRow.layer.name.title} in DevTools`} keys={LIVE_TIP.devtools} tipSide="right"
            onClick={() => onDevtools(actRow.layer.region)} />
        </span>
      ) : null}
      <Toggle className="live-layers-all" checked={all} onChange={toggleAll} label="Icons, images and form fields too" />
    </div>
  );
}
