// The page's parts as layers: what holds what, named the way the site names
// them. Pointing at a row outlines the part on the page; choosing it opens its
// details. Arrow keys walk the tree as in any tree (WAI-ARIA tree pattern).
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { LiveComponent, LiveRegion } from '@shared/live';
import { nameOf, type LiveKind } from '@shared/live-names';
import { layersOf, pathTo, type Layer } from '@shared/live-tree';
import { Icon, type IconName } from '../icons';

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

export function Layers({ regions, components, selected, changed, onHover, onSelect, partName }: {
  regions: LiveRegion[];
  components: Map<string, LiveComponent>;
  selected: number | null;
  /** Parts the last edit made, by index: marked, and opened to. */
  changed: ReadonlySet<number>;
  /** Point at parts on the page, with what to call them; null to stop. */
  onHover: (regions: LiveRegion[] | null, label: string | null) => void;
  onSelect: (region: LiveRegion) => void;
  /** The site helper's label and kind for a part id, from the page's trace. */
  partName?: (id: string) => { label: string; kind: string } | null;
}) {
  const [all, setAll] = useState(readAll);
  const layers = useMemo(() => layersOf(regions, { all, componentName: (id) => components.get(id)?.name ?? null, partName }), [regions, all, components, partName]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const tree = useRef<HTMLUListElement>(null);

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

  const rows = useMemo(() => visibleRows(layers, open), [layers, open]);
  const changedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const index of changed) for (const l of pathTo(layers, index)) keys.add(l.key);
    return keys;
  }, [changed, layers]);
  const current = focus && rows.some((r) => r.layer.key === focus) ? focus : rows[0]?.layer.key ?? null;

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
  const flip = (key: string, to?: boolean): void => setOpen((was) => {
    const next = new Set(was);
    if (to ?? !next.has(key)) next.add(key); else next.delete(key);
    return next;
  });

  const keys = (e: KeyboardEvent<HTMLUListElement>): void => {
    const at = rows.findIndex((r) => r.layer.key === current);
    const row = rows[at];
    if (!row) return;
    const { layer } = row;
    switch (e.key) {
      case 'ArrowDown': move(rows[Math.min(rows.length - 1, at + 1)]?.layer.key ?? null); break;
      case 'ArrowUp': move(rows[Math.max(0, at - 1)]?.layer.key ?? null); break;
      case 'Home': move(rows[0]?.layer.key ?? null); break;
      case 'End': move(rows.at(-1)?.layer.key ?? null); break;
      case 'ArrowRight':
        if (layer.children.length && !open.has(layer.key)) flip(layer.key, true);
        else if (layer.children.length) move(layer.children[0]?.key ?? null);
        break;
      case 'ArrowLeft':
        if (layer.children.length && open.has(layer.key)) flip(layer.key, false);
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
    <div className="live-layers">
      <ul className="live-tree" role="tree" aria-label="Parts of this page" ref={tree} onKeyDown={keys} onMouseLeave={() => onHover(null, null)}>
        {rows.map(({ layer, depth }) => {
          const isOpen = open.has(layer.key);
          const chosen = layer.regions.some((r) => r.index === selected) || layer.merged.some((r) => r.index === selected);
          const theirs = layer.name.origin === 'contrib' || layer.name.origin === 'core';
          const label = layer.regions.length > 1 ? `${layer.name.title} ×${layer.regions.length}` : layer.name.title;
          return (
            <li key={layer.key} role="treeitem" aria-level={depth + 1} aria-selected={chosen}
              aria-expanded={layer.children.length ? isOpen : undefined} tabIndex={layer.key === current ? 0 : -1} data-key={layer.key}
              className={`live-layer${chosen ? ' on' : ''}${theirs ? ' theirs' : ''}`} style={{ '--depth': depth } as CSSProperties}
              title={layer.merged.length ? layer.merged.map((m) => nameOf(m).title).join(' › ') : undefined}
              onFocus={() => setFocus(layer.key)}
              onMouseEnter={() => onHover(layer.regions, label)}
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
              {changedKeys.has(layer.key) ? <span className="live-layer-changed" title="The last edit changed this" /> : null}
            </li>
          );
        })}
      </ul>
      <label className="live-layers-all small">
        <input type="checkbox" checked={all} onChange={toggleAll} />
        Show icons, images and form fields too
      </label>
    </div>
  );
}
