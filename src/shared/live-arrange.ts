// Moving parts of the live page by hand: the rules the window, the main process
// and the tests share. A part in one of the trace's collections (live-trace.ts:
// field items, the blocks of a region or a post, a layout region, a menu,
// widgets, a display's fields) moves through the platform itself, saved as the
// logged-in user. A part whose order is written in template code has no
// collection: dragging it makes a note for an agent instead.
//
// An index is always the item's position in the target collection's order
// once the move is made, counting from 0: moving the third of four items to the
// top is index 0; into another collection of two, after both, is index 2.
import type { LiveRegion } from './live.ts';
import type { PartIndex } from './live-lens.ts';
import type { Layer } from './live-tree.ts';
import type { LiveTrace, PaletteEntry, TraceCollection } from './live-trace.ts';

export interface LiveMove { collection: string; item: string; to: { collection: string; index: number } }
export interface LiveInsert { collection: string; index: number; entry: string }

/** What a move or an insert came to: saved (with a token that undoes it), or why not. */
export type LiveMoveSaved =
  | { ok: true; undo: string | null; revision: string | null }
  /** `conflict`: the collection changed since the page was traced; `items` is its order now, when the site said. */
  | { ok: false; error: string; conflict: boolean; items: string[] | null };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const id = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null);

/** The collection an item (a part id) is in. */
export function collectionOf(trace: LiveTrace | null, item: string): TraceCollection | null {
  return trace?.collections?.find((c) => c.items.includes(item)) ?? null;
}

/** Where an item of a collection may go: the collection itself, then each in its movesTo that can take items. None when it cannot be moved. */
export function targetsFor(trace: LiveTrace | null, collection: string): TraceCollection[] {
  const all = trace?.collections ?? [];
  const from = all.find((c) => c.id === collection);
  if (!from || from.why) return [];
  return [from, ...(from.movesTo ?? []).map((m) => all.find((c) => c.id === m)).filter((c): c is TraceCollection => !!c && !c.why)];
}

/** How many places an item has in a target: the items there, plus one unless it is already among them. */
export function placesIn(target: TraceCollection, item: string): number {
  return target.items.filter((i) => i !== item).length + 1;
}

/** The orders a move makes, by collection id: the item out of where it was, into where it goes. */
export function movedOrders(trace: LiveTrace, move: LiveMove): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const from = trace.collections?.find((c) => c.id === move.collection);
  const to = trace.collections?.find((c) => c.id === move.to.collection);
  if (!from || !to) return out;
  const rest = from.items.filter((i) => i !== move.item);
  out.set(from.id, rest);
  const into = (to.id === from.id ? rest : to.items).slice();
  into.splice(Math.min(Math.max(0, move.to.index), into.length), 0, move.item);
  out.set(to.id, into);
  return out;
}

/** A move the window asked for, checked against the trace: what the main process posts, or why it will not. */
export function checkMove(trace: LiveTrace | null, raw: unknown): LiveMove | string {
  if (!trace) return 'There is no trace for this page yet. Reload it, then try again.';
  if (!isObj(raw) || !isObj(raw.to)) return 'That is not a move.';
  const collection = id(raw.collection), item = id(raw.item), toCollection = id(raw.to.collection), index = raw.to.index;
  if (!collection || !item || !toCollection || !Number.isInteger(index)) return 'That is not a move.';
  const from = trace.collections?.find((c) => c.id === collection);
  if (!from || !from.items.includes(item)) return 'This page’s trace has no such item to move. Reload it, then try again.';
  if (from.why) return from.why;
  const to = targetsFor(trace, collection).find((c) => c.id === toCollection);
  if (!to) return `${from.label} cannot move items there.`;
  if ((index as number) < 0 || (index as number) >= placesIn(to, item)) return 'That place is not in the collection.';
  if (to.id === from.id && from.items.indexOf(item) === index) return 'That is where it already is.';
  return { collection, item, to: { collection: toCollection, index: index as number } };
}

/** An insert the window asked for, checked against the trace. */
export function checkInsert(trace: LiveTrace | null, raw: unknown): LiveInsert | string {
  if (!trace) return 'There is no trace for this page yet. Reload it, then try again.';
  if (!isObj(raw)) return 'That is not an insert.';
  const collection = id(raw.collection), entry = id(raw.entry), index = raw.index;
  if (!collection || !entry || !Number.isInteger(index)) return 'That is not an insert.';
  const into = trace.collections?.find((c) => c.id === collection);
  if (!into) return 'This page’s trace has no such place. Reload it, then try again.';
  if (into.why) return into.why;
  if (!into.inserts?.includes(entry) || !trace.palette?.some((p) => p.id === entry)) return `${into.label} does not take that.`;
  if ((index as number) < 0 || (index as number) > into.items.length) return 'That place is not in the collection.';
  return { collection, index: index as number, entry };
}

/** An undo token the site gave: opaque, short, plain. */
export function undoToken(raw: unknown): string | null {
  return typeof raw === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(raw) ? raw : null;
}

/* ── the keyboard ──────────────────────────────────────────────────────── */

export type Step = 'up' | 'down' | 'previous' | 'next';

/**
 * Where a keyboard move goes next from where it is now: up and down within the
 * collection (Alt+↑ and Alt+↓), or the end of the previous or next collection
 * it may go to, kept at the same place where that has one (Alt+Shift+← and →).
 * Null when it can go no further that way.
 */
export function stepMove(trace: LiveTrace, item: string, at: { collection: string; index: number }, step: Step): { collection: string; index: number } | null {
  const home = collectionOf(trace, item);
  const targets = home ? targetsFor(trace, home.id) : [];
  const here = targets.find((c) => c.id === at.collection);
  if (!here) return null;
  if (step === 'up') return at.index > 0 ? { collection: here.id, index: at.index - 1 } : null;
  if (step === 'down') return at.index < placesIn(here, item) - 1 ? { collection: here.id, index: at.index + 1 } : null;
  const i = targets.indexOf(here) + (step === 'next' ? 1 : -1);
  const there = targets[i];
  return there ? { collection: there.id, index: Math.min(at.index, placesIn(there, item) - 1) } : null;
}

/** What a screen reader hears as an item moves: "Search, 2 of 4 in Sidebar blocks". */
export function announce(label: string, index: number, count: number, collection: string): string {
  return `${label}, ${index + 1} of ${count} in ${collection}`;
}

/* ── what a move saves ─────────────────────────────────────────────────── */

const SHARED: Record<TraceCollection['kind'], string> = {
  'field-items': 'This changes the field for this content wherever it shows',
  'region-blocks': 'This moves the block for every page that shows this region',
  'post-blocks': 'This changes the post’s blocks wherever the post shows',
  layout: 'This changes the layout for every page that uses it',
  menu: 'This changes the menu everywhere it shows',
  widgets: 'This moves the widget on every page that shows this area',
  display: 'This changes the display for all content shown with it',
};

/**
 * What to say about a move before it saves, and after. A move of
 * configuration is said first and asked about, since it changes every page
 * that shares it; a move of content is just saved, as a revision where the
 * site keeps them.
 */
export function moveNotice(c: TraceCollection, platform: 'drupal' | 'wordpress'): { confirm: string | null; saved: string } {
  if (c.changes === 'content') {
    return { confirm: null, saved: c.revisions === false ? 'Saved.' : 'Saved as a new revision.' };
  }
  const pages = c.reach !== undefined ? ` (${c.reach === 1 ? '1 page' : `${c.reach} pages`})` : '';
  const keep = platform === 'drupal'
    ? 'Export configuration (drush config:export) to keep it in code.'
    : 'It is saved in the database, not in your theme’s code.';
  return { confirm: `${SHARED[c.kind]}${pages}. ${keep}`, saved: 'Saved to the site’s configuration.' };
}

/* ── what the page is told it may drag ─────────────────────────────────── */

/** What the page script is given: the collections on the page, the parts it may drag as a request, and a palette entry being placed. */
export interface ArrangeSpec {
  collections: {
    id: string;
    label: string;
    /** The region holding the items, when the page has one: where an empty collection takes an item. */
    container: number | null;
    /** Each item in order, and the region that shows it (null when the page does not show it). */
    items: { part: string; region: number | null; label: string }[];
    /** Collections an item of this one may go to, itself first. Empty: it cannot be reordered here. */
    targets: string[];
    /** Palette entries it takes. */
    inserts: string[];
    why: string | null;
  }[];
  /** Runs of parts side by side whose order is written in template code: dragging one is a request to an agent. */
  groups: { region: number; label: string }[][];
  /** A palette entry being placed: only the collections that take it show a place. */
  placing: { entry: string; label: string } | null;
}

/** What the page script answers when something is dropped. */
export type ArrangeDrop =
  | { kind: 'move'; move: LiveMove }
  | { kind: 'insert'; insert: LiveInsert }
  /** A part with no collection, dropped beside `ref`: a note for an agent. */
  | { kind: 'request'; region: number; ref: number; place: 'before' | 'after' };

const BOUND = 2_000;
const index = (v: unknown): number | null => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < 100_000 ? v as number : null);
const label = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 200) : '');

/** A spec the window sent, checked before it goes into the page: bounded, and only plain values. */
export function arrangeSpec(raw: unknown): ArrangeSpec | null {
  if (!isObj(raw) || !Array.isArray(raw.collections) || !Array.isArray(raw.groups)) return null;
  const collections: ArrangeSpec['collections'] = [];
  for (const c of raw.collections.slice(0, 1000)) {
    if (!isObj(c) || !id(c.id) || !Array.isArray(c.items)) continue;
    collections.push({
      id: c.id as string, label: label(c.label), container: index(c.container),
      items: c.items.slice(0, BOUND).filter(isObj).filter((i) => id(i.part)).map((i) => ({ part: i.part as string, region: index(i.region), label: label(i.label) })),
      targets: Array.isArray(c.targets) ? c.targets.map(id).filter((t): t is string => !!t).slice(0, 200) : [],
      inserts: Array.isArray(c.inserts) ? c.inserts.map(id).filter((t): t is string => !!t).slice(0, 1000) : [],
      why: typeof c.why === 'string' ? c.why.slice(0, 500) : null,
    });
  }
  const groups = raw.groups.slice(0, BOUND).filter(Array.isArray)
    .map((g) => (g as unknown[]).slice(0, 500).filter(isObj).map((m) => ({ region: index(m.region), label: label(m.label) }))
      .filter((m): m is { region: number; label: string } => m.region !== null))
    .filter((g) => g.length >= 2);
  const p = isObj(raw.placing) && id(raw.placing.entry) ? { entry: raw.placing.entry as string, label: label(raw.placing.label) } : null;
  return { collections, groups, placing: p };
}

/** A drop the page script answered, checked: anything else is no drop. */
export function arrangeDrop(raw: unknown): ArrangeDrop | null {
  if (!isObj(raw)) return null;
  if (raw.kind === 'move' && isObj(raw.move) && isObj(raw.move.to) && id(raw.move.collection) && id(raw.move.item) && id(raw.move.to.collection) && index(raw.move.to.index) !== null) {
    return { kind: 'move', move: { collection: raw.move.collection as string, item: raw.move.item as string, to: { collection: raw.move.to.collection as string, index: raw.move.to.index as number } } };
  }
  if (raw.kind === 'insert' && isObj(raw.insert) && id(raw.insert.collection) && id(raw.insert.entry) && index(raw.insert.index) !== null) {
    return { kind: 'insert', insert: { collection: raw.insert.collection as string, entry: raw.insert.entry as string, index: raw.insert.index as number } };
  }
  if (raw.kind === 'request' && index(raw.region) !== null && index(raw.ref) !== null && (raw.place === 'before' || raw.place === 'after')) {
    return { kind: 'request', region: raw.region as number, ref: raw.ref as number, place: raw.place };
  }
  return null;
}

/**
 * What the page may drag: the trace's collections with the regions that show
 * their items, and the runs of side-by-side parts the layers show that no
 * collection holds (their order is in a template).
 */
export function buildSpec(trace: LiveTrace | null, parts: PartIndex, layers: readonly Layer[], placing: PaletteEntry | null = null): ArrangeSpec {
  const regionOf = (part: string): number | null => parts.regionsOf.get(part)?.[0] ?? null;
  const inCollection = new Set<number>();
  const collections: ArrangeSpec['collections'] = (trace?.collections ?? []).map((c) => {
    const items = c.items.map((p) => {
      const region = regionOf(p);
      if (region !== null) inCollection.add(region);
      return { part: p, region, label: parts.parts.get(p)?.label ?? p };
    });
    return {
      id: c.id, label: c.label, container: c.part ? regionOf(c.part) : null, items,
      targets: targetsFor(trace, c.id).map((t) => t.id), inserts: c.inserts ?? [], why: c.why ?? null,
    };
  });
  const groups: ArrangeSpec['groups'] = [];
  const walk = (list: readonly Layer[], depth: number): void => {
    if (depth > 64) return;
    const run = list.filter((l) => l.regions.length === 1 && !inCollection.has(l.region.index)).map((l) => ({ region: l.region.index, label: l.name.title }));
    if (run.length >= 2) groups.push(run);
    for (const l of list) walk(l.children, depth + 1);
  };
  walk(layers, 0);
  return { collections, groups, placing: placing ? { entry: placing.id, label: placing.label } : null };
}

/** The note an agent gets for a part dragged where its order is written in code. */
export function requestText(moved: string, ref: string, place: 'before' | 'after', vertical: boolean): string {
  const where = place === 'before' ? (vertical ? 'above' : 'before') : (vertical ? 'below' : 'after');
  return `Move ${moved} ${where} ${ref}. Its order is written in the template, not in a collection the site can reorder, so change it there. The pictures show the page now and the order wanted.`;
}

/** The regions a part shows as, for whoever moves it: the first is the one dragged. */
export function regionsOfItem(parts: PartIndex, item: string, regions: readonly LiveRegion[]): LiveRegion[] {
  const at = new Map(regions.map((r) => [r.index, r]));
  return (parts.regionsOf.get(item) ?? []).map((i) => at.get(i)).filter((r): r is LiveRegion => !!r);
}
