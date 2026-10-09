// Small text helpers the editor uses, pure so they are tested under plain Node.

/** The smallest replacement that turns one text into another, so a reload keeps the cursor where the text did not change. */
export function minimalChange(before: string, after: string): { from: number; to: number; insert: string } {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++;
  return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) };
}

/**
 * Where some words (a part's text picked on the live page) are in a file:
 * exactly, else with any spacing between them, in any case. Null when the
 * template does not write them (they come from content or a variable).
 */
export function findWords(text: string, words: string): number | null {
  const exact = text.indexOf(words);
  if (exact >= 0) return exact;
  const parts = words.split(/\s+/).filter(Boolean).slice(0, 12).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!parts.length) return null;
  const m = new RegExp(parts.join('\\s+'), 'i').exec(text);
  return m ? m.index : null;
}
