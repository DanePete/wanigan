// ⌘K's rules: what matches what is typed, how well, and how results are
// grouped and capped. Pure, so the order a person sees is tested here.

export type PaletteGroup = 'Go to' | 'Projects' | 'Cards' | 'Sessions' | 'Commands' | 'Said in sessions';

/** Groups always appear in this order; a group with nothing in it is left out. */
export const PALETTE_GROUPS: readonly PaletteGroup[] = ['Go to', 'Projects', 'Cards', 'Sessions', 'Commands', 'Said in sessions'];

/** At most this many of a group once something is typed. */
export const PER_GROUP = 8;
/** Before anything is typed, the long groups show only their first few. */
const UNTYPED: Partial<Record<PaletteGroup, number>> = { Cards: 5, Sessions: 5 };

/** Subsequence match with a bonus for word starts and runs. Higher is better; null is no match. */
export function paletteScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let s = 0;
  let at = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, at);
    if (i < 0) return null;
    s += i === at ? 3 : 1;
    if (i === 0 || /[\s\-/:]/.test(t[i - 1] ?? '')) s += 4;
    at = i + 1;
  }
  // The whole query as written beats the same letters scattered.
  if (t.includes(q)) s += q.length * 2;
  return s - t.length / 100;
}

export interface Arrangeable {
  group: PaletteGroup;
  /** What is matched against the query. */
  text: string;
  /** Offered only once something is typed (each view of every project, say). */
  whenTyped?: boolean;
  /** Already found by the core for what is typed: kept in the order given, never re-scored, gone when the query is. */
  found?: boolean;
}

/** The results to show, grouped in the fixed order, best first within each group, and capped. */
export function arrange<T extends Arrangeable>(items: readonly T[], query: string): { group: PaletteGroup; items: T[] }[] {
  const q = query.trim();
  const groups = new Map<PaletteGroup, { item: T; score: number; order: number }[]>();
  items.forEach((item, order) => {
    if (!q && (item.whenTyped || item.found)) return;
    const score = item.found ? Number.POSITIVE_INFINITY : paletteScore(q, item.text);
    if (score === null) return;
    const list = groups.get(item.group) ?? [];
    list.push({ item, score, order });
    groups.set(item.group, list);
  });
  return PALETTE_GROUPS.flatMap((group) => {
    const list = groups.get(group);
    if (!list?.length) return [];
    if (q) list.sort((a, b) => (b.score === a.score ? a.order - b.order : b.score - a.score));
    const cap = q ? PER_GROUP : UNTYPED[group] ?? Number.POSITIVE_INFINITY;
    return [{ group, items: list.slice(0, cap).map((x) => x.item) }];
  });
}

/** The next result with the arrow keys, across groups, wrapping at either end. */
export function step(index: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  if (index < 0) return delta > 0 ? 0 : count - 1;
  return (((index + delta) % count) + count) % count;
}
