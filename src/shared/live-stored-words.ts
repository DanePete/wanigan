// Stored words: words a page shows that no edit target of its trace holds, found where the site keeps them for the
// content the edited part belongs to, and saved there (the design layer's last word saves before an agent:
// docs/design/2026-10-09-design-layer.md, "Phase 1, as contracted", item 3). The site helpers' POST /_wanigan/words
// (helper version 4; WordPress: src/core/live-helper-wordpress-words.ts, Drupal: src/core/live-helper-drupal-stored.ts)
// and what the main process sends and reads (src/main/live-stored-words.ts). Pure, so both sides and the tests read it
// the same way.
//
// - `find` reads only, and answers where the words are kept (a place and the hash of the value holding them), or why
//   not. `save` re-finds them, writes only that place, only over that hash, and answers with the revision the site
//   made (when it keeps one) and an undo token (the helpers' own undo store, ten minutes).
// - A place every page shows (a site-wide option a plugin keeps) is answered with `ask`; the save needs `confirmed`.
import { identityKey, type LiveTrace, type PartIdentity, type TracePart } from './live-trace.ts';

/**
 * The content a part of a page belongs to, as the search takes it. WordPress: a post (`type` 'post', its ID). Drupal:
 * an entity by its type, UUID and the language the page rendered, with the field the page marked around the words
 * when the edit names one (a hint: two places are settled by it only when exactly one is in it).
 */
export interface StoredContent { type: string; id: string; langcode?: string; field?: string }

/** What the page said around the words, for a page builder's adapter: its document ids (innermost first) and the element's own id. */
export interface StoredHint { documents: string[]; element: string | null }

export interface StoredWordsAsk {
  step: 'find' | 'save';
  /** The page's trace: the helper checks the content is on it. */
  trace: string;
  content: StoredContent;
  /** The words as the page shows them, and the new ones. */
  before: string;
  after: string;
  /** `save`: where `find` found them, and the hash of the value then. */
  place?: string;
  hash?: string;
  /** `save` of a place every page shows: the owner was told and made it real again. */
  confirmed?: boolean;
  /** By builder: what the page said around the words. */
  hints?: Record<string, StoredHint>;
}

/** Why there is no place: nowhere, more than once, only in code, made from a template, in the site's settings, changed since, or refused. */
export type StoredRefusal = 'nowhere' | 'twice' | 'hidden' | 'made' | 'settings' | 'changed' | 'refused';
const REFUSALS: readonly StoredRefusal[] = ['nowhere', 'twice', 'hidden', 'made', 'settings', 'changed', 'refused'];

export type StoredWordsAnswer =
  | {
    ok: true; step: 'find' | 'save';
    place: string; hash: string;
    /** Where the words are kept, in the owner's words: "this page’s custom field “acme_hero” (in its saved list)". */
    where: string;
    /** Whether the site keeps a revision of that value. */
    revisions: boolean;
    /** Who saves it: 'core', or a plugin whose own save is used. */
    writer: string;
    /** What a plugin's or module's own copy of the words may do after the save. */
    cache: string | null;
    /** A place every page shows: said before it is saved. */
    ask: string | null;
    /** `save`: the revision the site made, when it made one, and the token that puts the old value back. */
    revision: string | null;
    undo: string | null;
  }
  | { ok: false; error: string; reason: StoredRefusal; status: number };

export type StoredUndone = { ok: true; revision: string | null } | { ok: false; error: string };

const PLACE = /^[A-Za-z0-9_:.#/-]{1,300}$/;
const HASH = /^[0-9a-f]{32}$/;
const TOKEN = /^[0-9a-f]{24}$/;
const WORDS_MAX = 2_000;
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null);

/** A helper's answer to POST /_wanigan/words, checked; anything else is said as the site not answering in a way Wanigan reads. */
export function parseStoredAnswer(raw: unknown, status: number): StoredWordsAnswer {
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (a && a.ok === true) {
    const place = text(a.place, 300);
    const hash = text(a.hash, 32);
    const where = text(a.where, 600);
    const step = a.step === 'find' || a.step === 'save' ? a.step : null;
    if (step && place && PLACE.test(place) && hash && HASH.test(hash) && where) {
      const revision = typeof a.revision === 'string' || typeof a.revision === 'number' ? String(a.revision).slice(0, 100) : null;
      const undo = typeof a.undo === 'string' && TOKEN.test(a.undo) ? a.undo : null;
      return {
        ok: true, step, place, hash, where, revisions: a.revisions === true, writer: text(a.writer, 80) ?? 'core',
        cache: text(a.cache, 600), ask: text(a.ask, 800), revision: revision && revision !== '' ? revision : null, undo,
      };
    }
  }
  if (a && a.ok === false && typeof a.error === 'string') {
    const reason = REFUSALS.includes(a.reason as StoredRefusal) ? a.reason as StoredRefusal : 'refused';
    return { ok: false, error: a.error.slice(0, 1_000), reason, status };
  }
  return { ok: false, error: status ? `The site did not save it (it answered ${status}).` : 'The site did not answer.', reason: 'refused', status };
}

/** A request, checked before it leaves for the site: what the main process built, or why it is not one. */
export function checkStoredAsk(ask: StoredWordsAsk): StoredWordsAsk | string {
  const name = /^[A-Za-z0-9_.:/@+-]{1,200}$/;
  const c = ask.content;
  if (ask.step !== 'find' && ask.step !== 'save') return 'Which step?';
  if (!/^[0-9a-f]{16}$/.test(ask.trace)) return 'Wanigan has no trace for this page to find the words in. Reload it, then try again.';
  if (!c || !/^[a-z0-9_]{1,64}$/.test(c.type) || !name.test(c.id) || (c.langcode !== undefined && !/^[A-Za-z0-9_-]{1,32}$/.test(c.langcode))
    || (c.field !== undefined && !/^[A-Za-z0-9_]{1,64}$/.test(c.field))) return 'That is not content Wanigan can look in.';
  if (!ask.before || ask.before.length > WORDS_MAX || ask.after.length > WORDS_MAX) return `Words longer than ${WORDS_MAX.toLocaleString('en')} characters are saved in the site’s own form.`;
  if (ask.step === 'save' && (!ask.place || !PLACE.test(ask.place) || !ask.hash || !HASH.test(ask.hash))) return 'Where were the words found?';
  for (const [k, h] of Object.entries(ask.hints ?? {})) {
    if (!/^[a-z][a-z0-9_-]{0,30}$/.test(k) || h.documents.length > 8 || !h.documents.every((d) => /^\d{1,20}$/.test(d)) || (h.element !== null && !/^[A-Za-z0-9_-]{1,40}$/.test(h.element))) return 'What the page said around the words is not something Wanigan sends.';
  }
  return ask;
}

/** A helper's answer to POST /_wanigan/undo of a stored-words save, checked. */
export function parseStoredUndone(raw: unknown, status: number): StoredUndone {
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (a && a.ok === true) return { ok: true, revision: typeof a.revision === 'string' || typeof a.revision === 'number' ? String(a.revision).slice(0, 100) : null };
  if (a && typeof a.error === 'string') return { ok: false, error: a.error.slice(0, 1_000) };
  return { ok: false, error: status ? `The site did not put it back (it answered ${status}).` : 'The site did not answer.' };
}

/** The post a WordPress block shows through its context (the `context.postId` the helper lists among its variables). */
function contextPost(p: TracePart): string | null {
  const v = p.variables?.find((x) => x.name === 'context.postId');
  return v && /^\d{1,20}$/.test(v.preview) ? v.preview : null;
}

/** The content one part is, or names: a post (by its ID, or the post a block is stored in), or an entity in a language. */
function contentOfPart(platform: LiveTrace['platform'], p: TracePart): StoredContent | null {
  const i = p.identity;
  if (platform === 'wordpress') {
    if (i?.kind === 'entity' && i.type === 'post' && /^\d{1,20}$/.test(i.id)) return { type: 'post', id: i.id };
    const stored = i?.kind === 'block' ? /^post:(\d{1,20})$/.exec(i.store) : null;
    if (stored) return { type: 'post', id: stored[1] as string };
    const post = contextPost(p);
    return post ? { type: 'post', id: post } : null;
  }
  if (i?.kind === 'entity' && i.langcode) return { type: i.type, id: i.id, langcode: i.langcode, ...(i.field ? { field: i.field } : {}) };
  return null;
}

/**
 * The content an edit's part belongs to, for the stored-words search: the part itself, then outward a level at a
 * time (each part's parent), the nearest level deciding. Null when no part around it names content.
 */
export function storedContentOf(trace: LiveTrace, identity: PartIdentity): StoredContent | null {
  const key = identityKey(identity);
  const byId = new Map(trace.parts.map((p) => [p.id, p]));
  let level = trace.parts.filter((p) => p.identity && identityKey(p.identity) === key);
  const seen = new Set(level.map((p) => p.id));
  for (let depth = 0; level.length && depth < 64; depth++) {
    for (const p of level) {
      const content = contentOfPart(trace.platform, p);
      if (!content) continue;
      // A field hint only from the edit's own part: a parent's field is not where these words are.
      const { field, ...rest } = content;
      return depth === 0 && field ? { ...rest, field } : rest;
    }
    const next: TracePart[] = [];
    for (const p of level) {
      const up = p.parent ? byId.get(p.parent) : undefined;
      if (up && !seen.has(up.id)) { seen.add(up.id); next.push(up); }
    }
    level = next;
  }
  return null;
}
