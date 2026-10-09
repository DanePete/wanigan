// The parts of a live page as a tree of layers: each region under the smallest
// region it lies inside, in the order they appear on the page. The page's own
// wrappers (the document, the page template) are dissolved into what they
// hold, small pieces (icons, images, form fields) are folded away unless asked
// for, and a run of the same kind of part (five location teasers) is one row
// that opens onto each of them. Pure: the window draws it, the tests read it.
import type { LiveRegion } from './live.ts';
import { entityOf, fieldOf, nameOf, type PartName } from './live-names.ts';

export interface Layer {
  /** A stable key for the row: the first region's index, or the group's. */
  key: string;
  region: LiveRegion;
  name: PartName;
  /** Every region the row stands for: one, or each of a run of the same kind. */
  regions: LiveRegion[];
  children: Layer[];
  /**
   * Parts that cover exactly the same place, one inside the other (a block and
   * the menu it holds), shown as one row: outermost first. The row is named by
   * the outermost and chooses the innermost (`region`).
   */
  merged: LiveRegion[];
}

/** What makes two parts the same kind of thing: the same component, the same content type in the same view, the same template. */
export function kindKey(r: LiveRegion): string {
  if (r.component) return `component ${r.component}`;
  const e = entityOf(r);
  if (e) return `entity ${e.type}:${e.bundle ?? ''}:${e.viewMode ?? ''}:${r.file ?? ''}`;
  if (r.element) return `element ${r.element.split('#')[0]}`;
  return `file ${r.file ?? ''} ${r.hook ?? ''} ${r.block ?? ''} ${r.view ?? ''} ${r.field ?? ''}`;
}

/**
 * Which thing a part is, when two parts can be the same thing found twice: a
 * piece of content, a block or a field, read once from its template's comments
 * and once from the helper's mark on its element.
 */
function identity(r: LiveRegion): string | null {
  const e = entityOf(r);
  // By type and id alone: Drupal may name the view mode asked for (full) where the display used says default.
  if (e?.id) return `entity ${e.type}:${e.id}`;
  const block = r.block?.split('@')[1] ?? (r.hook?.split('__')[0] === 'block' ? r.suggestions.find((s) => s.startsWith('block--'))?.slice(7).split('--')[0]?.replace(/-/g, '_') : undefined);
  if (block) return `block ${block}`;
  const f = fieldOf(r);
  if (f) return `field ${f.entityType}:${f.field}`;
  return null;
}

/** The order the page is written in; where the page script gave none, top to bottom on the page. */
const byPlace = (a: LiveRegion, b: LiveRegion): number =>
  (a.order ?? 0) - (b.order ?? 0) || a.rect.y - b.rect.y || a.rect.x - b.rect.x || b.rect.width * b.rect.height - a.rect.width * a.rect.height || a.index - b.index;

export function layersOf(regions: readonly LiveRegion[], options: { all?: boolean; componentName?: (id: string) => string | null } = {}): Layer[] {
  const named = new Map(regions.map((r) => [r.index, nameOf(r, r.component ? options.componentName?.(r.component) ?? null : null)]));
  const kids = new Map<number | null, LiveRegion[]>();
  const known = new Set(regions.map((r) => r.index));
  for (const r of regions) {
    const parent = r.parent !== null && known.has(r.parent) ? r.parent : null;
    const list = kids.get(parent) ?? [];
    list.push(r);
    kids.set(parent, list);
  }
  const hidden = (r: LiveRegion): boolean => { const n = named.get(r.index) as PartName; return n.wrapper || (!options.all && n.small); };
  const byIndex = new Map(regions.map((r) => [r.index, r]));
  /** Parts that are their parent found a second time, by the parent they fold into. */
  const absorbed = new Map<number, LiveRegion[]>();

  /** The regions shown at a level: a hidden one, or the same thing as its parent, gives way to what it holds. */
  const visible = (parent: number | null, depth = 0, owner: number | null = parent): LiveRegion[] => {
    const out: LiveRegion[] = [];
    const of = owner === null ? null : byIndex.get(owner) ?? null;
    const same = of ? identity(of) : null;
    for (const r of kids.get(parent) ?? []) {
      if (depth < 64 && same && identity(r) === same) {
        absorbed.set(owner as number, [...(absorbed.get(owner as number) ?? []), r]);
        out.push(...visible(r.index, depth + 1, owner));
      } else if (hidden(r) && depth < 64) {
        out.push(...visible(r.index, depth + 1, owner));
      } else {
        out.push(r);
      }
    }
    return out.sort(byPlace);
  };

  const build = (parent: number | null, depth: number): Layer[] => {
    if (depth > 64) return [];
    const level = visible(parent);
    const groups = new Map<string, LiveRegion[]>();
    const order: string[] = [];
    for (const r of level) {
      const key = kindKey(r);
      const g = groups.get(key);
      if (g) g.push(r); else { groups.set(key, [r]); order.push(key); }
    }
    return order.map((key) => {
      const group = groups.get(key) as LiveRegion[];
      const first = group[0] as LiveRegion;
      const one = (r: LiveRegion): Layer => {
        const children = build(r.index, depth + 1);
        const twice = absorbed.get(r.index) ?? [];
        return collapse({ key: String(r.index), region: r, name: named.get(r.index) as PartName, regions: [r], children, merged: twice.length ? [r, ...twice] : [] });
      };
      if (group.length === 1) return one(first);
      return { key: `group ${first.index}`, region: first, name: named.get(first.index) as PartName, regions: group, children: group.map(one), merged: [] };
    });
  };
  return build(null, 0);
}

const sameRect = (a: LiveRegion['rect'], b: LiveRegion['rect']): boolean =>
  Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2;

/** A part holding only one part that covers the same place is one row: named by the outer, choosing the inner. */
function collapse(layer: Layer): Layer {
  const chain = [layer];
  let at = layer;
  for (let guard = 0; guard < 16; guard++) {
    const only = at.regions.length === 1 && at.children.length === 1 ? at.children[0] as Layer : null;
    if (!only || only.regions.length !== 1 || !sameRect(at.region.rect, only.region.rect)) break;
    chain.push(only);
    at = only;
  }
  if (chain.length === 1) return layer;
  return { ...at, key: layer.key, name: layer.name, merged: chain.flatMap((l) => (l.merged.length ? l.merged : [l.region])) };
}

/** The rows from the top down to a region: what to open so it shows. */
export function pathTo(layers: readonly Layer[], index: number): Layer[] {
  for (const layer of layers) {
    if (layer.regions.length === 1 && (layer.region.index === index || layer.merged.some((m) => m.index === index))) return [layer];
    const below = pathTo(layer.children, index);
    if (below.length) return [layer, ...below];
  }
  return [];
}

/** A region's ancestors, nearest first, by the page script's parents. */
export function ancestors(regions: readonly LiveRegion[], index: number): LiveRegion[] {
  const at = new Map(regions.map((r) => [r.index, r]));
  const out: LiveRegion[] = [];
  for (let r = at.get(index), guard = 0; r && r.parent !== null && guard < 64; guard++) {
    const p = at.get(r.parent);
    if (!p) break;
    out.push(p);
    r = p;
  }
  return out;
}
