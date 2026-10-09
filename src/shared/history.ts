// What History's search matches, shared so the core's `query` and the window's
// filter-as-you-type agree exactly.
import type { HistoryItem } from './model.ts';

/** Every word of the query appears in the title, the first prompt or the branch. */
export function matchesHistory(item: Pick<HistoryItem, 'title' | 'firstPrompt' | 'branch'>, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = `${item.title ?? ''}\n${item.firstPrompt ?? ''}\n${item.branch ?? ''}`.toLowerCase();
  return words.every((w) => text.includes(w));
}
