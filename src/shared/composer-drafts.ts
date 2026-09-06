/**
 * Unsent composer text, bounded.
 *
 * Drafts used to live under one localStorage key per session —
 * `wanigan.composerDraft.<id>` — written on a debounce and never swept. The
 * key outlived the session, the project and the app version, so a profile
 * that had launched a thousand sessions carried a thousand keys forever, and
 * the only thing that ever stopped the growth was the browser's quota error,
 * which the composer caught and ignored. That is a bound nobody chose.
 *
 * Every draft now lives in one map under one key, held to a count and a
 * character budget the code enforces on every write. This half is pure so the
 * main-process smoke suite can hold it to account without a DOM, the way
 * shared/palette.ts splits the palette.
 */

/** The single key every draft now lives under. */
export const COMPOSER_DRAFTS_KEY = 'wanigan.composerDrafts';
/**
 * The abandoned per-session prefix. Kept only so the fold can find what the
 * old scheme left behind; nothing writes it any more.
 */
export const COMPOSER_DRAFT_PREFIX = 'wanigan.composerDraft.';
/** How many sessions may hold an unsent draft at once. */
export const COMPOSER_DRAFT_MAX = 25;
/**
 * Total characters across all drafts. This matters more than the count: the
 * whole map is re-stringified on every debounce tick, so the budget is what
 * keeps a pause in typing from serialising megabytes.
 */
export const COMPOSER_DRAFT_TOTAL_CHARS = 200_000;

export type ComposerDraft = {
  text: string;
  /** When the draft was last typed into, epoch ms. Newest survives a prune. */
  at: number;
};

export type ComposerDraftMap = Record<string, ComposerDraft>;

/**
 * Whatever localStorage handed back, read as a draft map. Anything that is not
 * an object of well-formed entries reads as no drafts rather than throwing:
 * a corrupted key must cost the drafts, never the composer.
 */
export function parseDraftMap(raw: string | null): ComposerDraftMap {
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: ComposerDraftMap = {};
  for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const { text, at } = value as { text?: unknown; at?: unknown };
    if (typeof text !== 'string' || typeof at !== 'number' || !Number.isFinite(at)) continue;
    out[sessionId] = { text, at };
  }
  return out;
}

/**
 * The drafts that fit, newest first. Ties on `at` break on session id so the
 * result is the same map every time — two drafts saved in the same
 * millisecond must not make the eviction depend on object key order.
 *
 * The newest entry is always kept, even alone over budget: the draft the
 * operator is typing into right now is the one thing this must never drop.
 */
export function pruneDrafts(
  map: ComposerDraftMap,
  max = COMPOSER_DRAFT_MAX,
  budget = COMPOSER_DRAFT_TOTAL_CHARS,
): ComposerDraftMap {
  const entries = Object.entries(map).sort((a, b) => {
    if (b[1].at !== a[1].at) return b[1].at - a[1].at;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  const kept: ComposerDraftMap = {};
  let count = 0;
  let chars = 0;
  for (const [sessionId, draft] of entries) {
    if (count >= max) break;
    // Truncate rather than skip: once the budget is spent the rest are older
    // still, and hopping over a large draft to keep a small older one would
    // make eviction order depend on length instead of age.
    if (count > 0 && chars + draft.text.length > budget) break;
    kept[sessionId] = draft;
    count += 1;
    chars += draft.text.length;
  }
  return kept;
}

/**
 * One session's draft written into the map, pruned. Empty text — or text that
 * is only whitespace, which the composer refuses to send anyway — removes the
 * entry instead of storing a blank one, so clearing a box actually reclaims
 * its slot rather than holding it against the count.
 */
export function putDraft(
  map: ComposerDraftMap,
  sessionId: string,
  text: string,
  now: number,
): ComposerDraftMap {
  const next: ComposerDraftMap = { ...map };
  if (!text.trim()) delete next[sessionId];
  else next[sessionId] = { text, at: now };
  return pruneDrafts(next);
}
