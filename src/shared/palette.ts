import type { TranscriptHit } from './types';

/**
 * The palette's pure half, shared so the main-process smoke suite can hold it
 * to account: what a row is, which rows a query keeps, and how rows group.
 * The renderer owns everything with a closure in it.
 */

export type PaletteEntry = {
  key: string;
  title: string;
  hint: string;
  /** Right-hand column: a shortcut where one exists, otherwise what this is. */
  meta: string;
  haystack: string;
  /** Header the row renders under; first appearance fixes group order. */
  group: string;
  primary?: boolean;
  /** True when running this leaves the view alone, so focus has to go back to
   *  whatever opened the palette rather than falling to the document body. */
  staysPut?: boolean;
  /**
   * Already matched by a real index (transcript FTS). The palette's substring
   * filter must not re-judge it: FTS tokenisation and substring inclusion
   * disagree, and dropping a genuine hit would misreport the archive.
   */
  prefiltered?: boolean;
};

export function filterPalette<T extends PaletteEntry>(items: T[], query: string): T[] {
  const q = query.trim().toLocaleLowerCase();
  // No query, no search results: prefiltered rows exist only as answers.
  if (!q) return items.filter((item) => !item.prefiltered);
  return items.filter((item) =>
    item.prefiltered || `${item.title} ${item.hint} ${item.haystack}`.toLocaleLowerCase().includes(q));
}

export type PaletteGroup<T> = { label: string; items: T[] };

export function groupPalette<T extends PaletteEntry>(items: T[]): PaletteGroup<T>[] {
  const order: PaletteGroup<T>[] = [];
  const byLabel = new Map<string, PaletteGroup<T>>();
  for (const item of items) {
    let group = byLabel.get(item.group);
    if (!group) {
      group = { label: item.group, items: [] };
      byLabel.set(item.group, group);
      order.push(group);
    }
    group.items.push(item);
  }
  return order;
}

/** FTS rows the palette asks for. The count line says "shown", never "all". */
export const TRANSCRIPT_RESULT_CAP = 8;
/** Below this the archive is not asked — one letter matches everything. */
export const TRANSCRIPT_QUERY_MIN = 3;

/**
 * A transcript hit as a palette row. The snippet passes through untouched,
 * «markers» included — it is the archive's own evidence, not copy to polish.
 */
export function transcriptHitRow(hit: TranscriptHit, index: number): Omit<PaletteEntry, 'group'> {
  const when = new Date(hit.at || hit.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return {
    key: `transcript:${hit.sessionId}:${hit.at}:${index}`,
    title: `${hit.projectName} — ${hit.role === 'user' ? 'you' : 'agent'}, ${when}`,
    hint: hit.snippet,
    meta: 'Transcript',
    haystack: '',
    prefiltered: true,
  };
}
