// Reading a write back. Every edit, move, insert, removal and undo through the live view
// reloads the page and traces it again; a write the site called a success is
// then checked against the new render, because "saved" is not "shows". A schema
// edit is checked by the value the new trace holds for it (the site's own read
// of what it stored); anything else by what the watched parts of the page show,
// hashed before the write and after the reload (the page script's
// fingerprints()). A part taken out, or put back, is checked first by whether it
// is on the reloaded page (countOf()). Pure, so the window and the tests read it
// the same way.
import { countOf, sameRegion, type LiveRegion } from './live.ts';
import type { LiveTrace } from './live-trace.ts';

/** `remove`: one item taken out of its collection, read back by what holds it. */
export type WriteKind = 'edit' | 'form' | 'move' | 'insert' | 'remove' | 'undo';

/** A write about to be made, or made: what to check once the page reloads with a new trace. */
export interface WriteCheck {
  kind: WriteKind;
  /** "Title of “Home”", "Search": what the owner reads. */
  what: string;
  /** The trace the write was made against: the check waits for a newer one. */
  traceId: string | null;
  /** A schema edit: its target, the value sent and the value it had. */
  target?: { id: string; sent: unknown; old: unknown };
  /** The parts of the page watched, and what each showed before the write. */
  watched: { region: LiveRegion; print: string | null }[];
  /** The page's regions when they were read, to find the same ones after the reload. */
  scan: LiveRegion[];
  /**
   * A part taken out (`present` false) or put back (true): how many of it the page showed when the check was read. The
   * reloaded page shows one fewer, or one more, when the write landed.
   */
  item?: { region: LiveRegion; count: number; present: boolean };
}

export type CheckVerdict =
  | { kind: 'landed'; by: 'value' | 'page' | 'item' }
  /** The site said it saved, and nothing it shows changed (`item`: the part is still there, or still not). */
  | { kind: 'unchanged'; by: 'value' | 'page' | 'item' }
  /** Saved, and the site stored a value of its own (trimmed, made URL-safe, made unique). */
  | { kind: 'stored-as'; value: unknown }
  /** Nothing to check against: the part is not on the reloaded page. */
  | { kind: 'unseen' };

/** JSON-equal, keys in any order. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => same(x, (b as unknown[])[i]));
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined).sort();
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** The regions to read after the reload: each watched one, found again on the new page (null when it is gone). */
export function regionsAfter(check: WriteCheck, scan: readonly LiveRegion[]): (LiveRegion | null)[] {
  return check.watched.map((w) => sameRegion(w.region, check.scan, scan));
}

/** How many of the part taken out or put back the reloaded page shows; null when the check has no part to count. */
export function itemsAfter(check: WriteCheck, scan: readonly LiveRegion[]): number | null {
  return check.item ? countOf(check.item.region, scan) : null;
}

/**
 * What a write came to, once the page reloaded with a newer trace: by the
 * value the site now holds for a schema edit's target, else by whether any
 * watched part shows something else. `prints` are the watched regions' hashes
 * after the reload, in the same order (null where a region is gone). A part
 * taken out or put back is judged by `items`, how many of it the reloaded page
 * shows (itemsAfter()): what held it may be gone with it (a region with nothing
 * left in it is not drawn), and that is the write landing, not a page to guess at.
 */
export function judge(check: WriteCheck, trace: LiveTrace | null, prints: (string | null)[], items: number | null = null): CheckVerdict {
  if (check.target && trace) {
    const now = trace.edits.find((e) => e.id === check.target?.id);
    if (now && now.via === 'schema' && now.value !== undefined) {
      if (same(now.value, check.target.sent)) return { kind: 'landed', by: 'value' };
      if (same(now.value, check.target.old)) return { kind: 'unchanged', by: 'value' };
      return { kind: 'stored-as', value: now.value };
    }
  }
  if (check.item && items !== null) {
    const landed = check.item.present ? items > check.item.count : items < check.item.count;
    return { kind: landed ? 'landed' : 'unchanged', by: 'item' };
  }
  const pairs = check.watched.map((w, i) => [w.print, prints[i] ?? null] as const).filter(([a, b]) => a !== null && b !== null);
  if (!pairs.length) return { kind: 'unseen' };
  return pairs.some(([a, b]) => a !== b) ? { kind: 'landed', by: 'page' } : { kind: 'unchanged', by: 'page' };
}

const shown = (v: unknown): string => {
  const text = typeof v === 'string' ? `“${v}”` : JSON.stringify(v) ?? String(v);
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
};

const VERB: Record<WriteKind, string> = { edit: 'saved', form: 'saved', move: 'moved', insert: 'added', remove: 'taken out', undo: 'put back' };

/** The verdict in the owner's words; `tone` says whether it needs them. */
export function verdictText(check: WriteCheck, verdict: CheckVerdict): { tone: 'ok' | 'warn'; text: string } {
  const verb = VERB[check.kind];
  // "The site said it took out Search": the one verb whose past is not its participle.
  const did = check.kind === 'remove' ? 'took out' : verb;
  switch (verdict.kind) {
    case 'landed':
      if (verdict.by === 'item') return { tone: 'ok', text: check.item?.present ? `${check.what}: ${verb}, and it is on the page again after reloading.` : `${check.what}: ${verb}, and it is gone from the page after reloading.` };
      return { tone: 'ok', text: verdict.by === 'value' ? `${check.what}: ${verb}, and the site holds it after reloading.` : `${check.what}: ${verb}, and the page shows the change after reloading.` };
    case 'stored-as':
      return { tone: 'ok', text: `${check.what}: ${verb}. The site stored it as ${shown(verdict.value)}.` };
    case 'unchanged':
      if (verdict.by === 'item') {
        return {
          tone: 'warn',
          text: check.item?.present
            ? `The site said it ${did} ${check.what}, but after reloading it is not on the page. A cache may be showing the page as it was.`
            : `The site said it ${did} ${check.what}, but after reloading it is still on the page. A cache, or code that runs on the save, may have kept it.`,
        };
      }
      return {
        tone: 'warn',
        text: verdict.by === 'value'
          ? `The site said it ${did} ${check.what}, but after reloading it holds the old value. Code that runs on the save, or a cache, may have put it back.`
          : `The site said it ${did} ${check.what}, but after reloading that part of the page shows exactly what it did before. If what changed shows there, something kept it from showing: a cache, or code that runs on the save.`,
      };
    case 'unseen':
      // Nothing was watched (nothing on the page holds it to compare): that is said, not that it is gone.
      if (!check.watched.length) return { tone: 'ok', text: `${check.what}: ${verb}. Nothing on the page was there to compare before and after, so Wanigan could not check the reloaded page.` };
      // What is taken out is watched by what holds it: gone from the page is what it should be, so it is not what is said.
      return check.kind === 'remove'
        ? { tone: 'ok', text: `${check.what}: ${verb}. What held it is not on the reloaded page, so Wanigan could not check it.` }
        : { tone: 'ok', text: `${check.what}: ${verb}. It is not on the reloaded page, so Wanigan could not check that it shows.` };
  }
}
