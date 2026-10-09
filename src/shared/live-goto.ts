// The live view's "Go to" launcher, the parts that are rules: how a typed
// query matches a destination, how often and how lately each was chosen, what
// a typed path or id jumps to, which destination the page shown is, and how
// results are grouped. The helpers' index and search are src/shared/live-find.ts;
// the main process fetches them (src/main/live-find.ts) and the launcher shows
// them (src/renderer/src/components/live/GoTo.tsx). Nothing here does I/O.
import { samePath, type FindItem, type FindKind, type FindResult } from './live-find.ts';
import type { LivePlatform } from './live.ts';

/* ── what the main process answers ─────────────────────────────────────── */

/**
 * Where finding stands for a project's site:
 * - ready: the helper answered.
 * - off: the live view (or this kind of site) is switched off in Settings.
 * - no-site: the project has no address for the live view yet.
 * - no-helper: no Wanigan helper in the site (or a kind of site with none).
 * - outdated: the helper predates finding (it has no /_wanigan/find).
 * - down: nothing answered at the site's address.
 * - log-in: the helper lists pages for a logged-in user only (WordPress's), and nobody is logged in in the view.
 * - refused: the site refused the helper's token.
 * - failed: the helper answered with something else (an error page, a bad answer, a redirect).
 */
export type FindState = 'ready' | 'off' | 'no-site' | 'no-helper' | 'outdated' | 'log-in' | 'down' | 'refused' | 'failed';

/** A page the live view knows without the helper: from its own history, or linked from the page shown. */
export interface KnownPage {
  /** A same-origin path. */
  url: string;
  label: string;
  from: 'history' | 'link';
}

export interface LiveFindAnswer {
  state: FindState;
  /** The helper's index, or its search when one was asked; null unless ready. */
  result: FindResult | null;
  /** Pages the view has seen and links on the page it shows (the latter only without a working helper). */
  known: KnownPage[];
  /** The site's origin, "https://acme.example.test": what a path is opened and copied against. */
  origin: string | null;
  platform: LivePlatform | null;
  /** Why it is not ready, in the owner's words; null when it is. */
  message: string | null;
}

/** What the page the view shows says it is (src/renderer/src/live-page-goto.ts), checked in main. */
export interface LiveHere {
  /** Its path and query. */
  path: string;
  title: string;
  /** Its first heading, for asking the helper about it by name. */
  heading: string | null;
  /** The entities it names: 'node:12' from Drupal's shortlink, 'post:44' from WordPress's. */
  ids: string[];
  /** Other paths it goes by: its canonical address and shortlink. */
  paths: string[];
}

/* ── folding text for matching ─────────────────────────────────────────── */

/** Text made comparable: lower case, accents off, with each folded letter's place in the original and where words start. */
interface Folded {
  text: string;
  /** For each letter of `text`, its index in the original; null when they are the same (plain ASCII). */
  map: number[] | null;
  /** Whether a word starts at each letter of `text`. */
  starts: Uint8Array;
}

const MARKS = /[\u0300-\u036f]/g;
const WORD = /[\p{L}\p{N}]/u;
const ASCII = /^[\x20-\x7e]*$/;

const isAlnum = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isUpper = (c: number): boolean => c >= 65 && c <= 90;
const isLower = (c: number): boolean => c >= 97 && c <= 122;

/**
 * A word starts after anything that is not a letter or digit, at a capital
 * after a small letter (camelCase), and where letters turn to digits or back
 * (node12).
 */
function fold(original: string): Folded {
  if (ASCII.test(original)) {
    const starts = new Uint8Array(original.length);
    for (let i = 0; i < original.length; i++) {
      const c = original.charCodeAt(i);
      if (!isAlnum(c)) continue;
      const p = i > 0 ? original.charCodeAt(i - 1) : -1;
      starts[i] = p < 0 || !isAlnum(p) || (isUpper(c) && isLower(p)) || isDigit(c) !== isDigit(p) ? 1 : 0;
    }
    return { text: original.toLowerCase(), map: null, starts };
  }
  let text = '';
  const map: number[] = [];
  const flags: number[] = [];
  let prev = '';
  for (let i = 0; i < original.length; i++) {
    const ch = original[i] as string;
    const low = ch.normalize('NFD').replace(MARKS, '').toLowerCase();
    const word = WORD.test(ch);
    const start = word && (!prev || !WORD.test(prev) || (ch !== ch.toLowerCase() && prev === prev.toLowerCase() && prev !== prev.toUpperCase())
      || (/\d/.test(ch) !== /\d/.test(prev)));
    for (let k = 0; k < low.length; k++) {
      text += low[k];
      map.push(i);
      flags.push(k === 0 && start ? 1 : 0);
    }
    prev = ch;
  }
  return { text, map, starts: Uint8Array.from(flags) };
}

const foldQuery = (q: string): string => q.normalize('NFD').replace(MARKS, '').toLowerCase().replace(/\s+/g, ' ').trim();

/* ── matching one term ─────────────────────────────────────────────────── */

/** How well a term matches, best first. A field's weight multiplies these. */
export const QUALITY = {
  exact: 100,
  prefix: 92,
  wordPrefix: 84,
  acronym: 76,
  inside: 60,
  typo: 44,
  typo2: 34,
  /** Letters in order, scattered: from this up to `scatteredBest`, by how many start words or run together. */
  scattered: 20,
  scatteredBest: 46,
} as const;

interface TermMatch {
  quality: number;
  /** Where the matched letters are in the folded text. */
  at: number[];
}

const range = (from: number, length: number): number[] => Array.from({ length }, (_, i) => from + i);

/** The letters of a match, as indexes into the original text. */
const original = (f: Folded, at: readonly number[]): number[] => (f.map ? [...new Set(at.map((i) => (f.map as number[])[i] as number))] : [...at]);

// Three rows reused for every distance: matching runs on every key over thousands of destinations.
let rowA = new Int32Array(32);
let rowB = new Int32Array(32);
let rowC = new Int32Array(32);

/** Optimal string alignment distance (a swap of two neighbours is one edit), stopping early past `max`. */
export function editDistance(a: string, b: string, max = 2, bFrom = 0, bLength = b.length - bFrom): number {
  if (Math.abs(a.length - bLength) > max) return max + 1;
  if (bLength + 1 > rowA.length) { rowA = new Int32Array(bLength + 1); rowB = new Int32Array(bLength + 1); rowC = new Int32Array(bLength + 1); }
  // two rows back (for a swap), one row back, and this row
  let prev2 = rowA; let prev = rowB; let cur = rowC;
  for (let j = 0; j <= bLength; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let best = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= bLength; j++) {
      const bj = b.charCodeAt(bFrom + j - 1);
      let d = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + (ai === bj ? 0 : 1));
      if (i > 1 && j > 1 && ai === b.charCodeAt(bFrom + j - 2) && a.charCodeAt(i - 2) === bj) d = Math.min(d, (prev2[j - 2] as number) + 1);
      cur[j] = d;
      if (d < best) best = d;
    }
    if (best > max) return max + 1;
    const spare = prev2; prev2 = prev; prev = cur; cur = spare;
  }
  return prev[bLength] as number;
}

/**
 * The quick ways a term matches, in order: the whole text, its start, the
 * start of a later word (earlier words a little better), the first letters of
 * words ("ct" is Content types), or inside a word.
 */
function quickMatch(term: string, f: Folded): TermMatch | null {
  const text = f.text;
  if (!term || !text || term.length > text.length + 2) return null;
  if (text === term) return { quality: QUALITY.exact, at: range(0, term.length) };
  if (text.startsWith(term)) return { quality: QUALITY.prefix, at: range(0, term.length) };
  const inside = text.indexOf(term);
  if (inside > 0) {
    let words = 0;
    for (let i = 1; i < text.length; i++) {
      if (!f.starts[i]) continue;
      words++;
      if (i >= inside && text.startsWith(term, i)) return { quality: Math.max(QUALITY.wordPrefix - 4, QUALITY.wordPrefix - words), at: range(i, term.length) };
    }
  }
  if (term.length >= 2 && !term.includes(' ')) {
    const at: number[] = [];
    let consecutive = true;
    let lastWord = -1;
    for (let i = 0, k = 0, word = -1; i < text.length && k < term.length; i++) {
      if (!f.starts[i]) continue;
      word++;
      if (text.charCodeAt(i) === term.charCodeAt(k)) {
        if (lastWord >= 0 && word !== lastWord + 1) consecutive = false;
        lastWord = word;
        at.push(i);
        k++;
      }
    }
    if (at.length === term.length) return { quality: consecutive ? QUALITY.acronym + 2 : QUALITY.acronym - 4, at };
  }
  return inside >= 0 ? { quality: QUALITY.inside, at: range(inside, term.length) } : null;
}

/** Letters in order: greedily from `first`, scoring word starts and runs. */
function scattered(f: Folded, term: string, first: number): { score: number; at: number[] } | null {
  const at = [first];
  for (let k = 1, i = first + 1; k < term.length; k++) {
    const found = f.text.indexOf(term[k] as string, i);
    if (found < 0) return null;
    at.push(found);
    i = found + 1;
  }
  let score = 0;
  for (let k = 0; k < at.length; k++) {
    const p = at[k] as number;
    score += 1 + (f.starts[p] ? 3 : 0) + (k > 0 && at[k - 1] === p - 1 ? 2 : 0);
  }
  return { score, at };
}

/**
 * The slow ways, tried only when no field matched quickly: the letters in order
 * though scattered (scored by word starts and runs, and refused when strewn
 * across a long text), or a typo or two against the start of a word.
 */
function slowMatch(term: string, f: Folded): TermMatch | null {
  const text = f.text;
  if (term.length < 2 || !text || term.includes(' ')) return null;
  let found: TermMatch | null = null;
  const firstAt = text.indexOf(term[0] as string);
  if (firstAt >= 0) {
    let best: { score: number; at: number[] } | null = null;
    const tries = [firstAt];
    for (let i = firstAt + 1; i < text.length && tries.length < 8; i++) if (f.starts[i] && text.charCodeAt(i) === term.charCodeAt(0)) tries.push(i);
    for (const t of tries) {
      const m = scattered(f, term, t);
      if (!m) break; // a later start has fewer letters after it
      if (!best || m.score > best.score) best = m;
    }
    if (best) {
      const span = (best.at[best.at.length - 1] as number) - (best.at[0] as number) + 1;
      const ratio = best.score / (term.length * 6);
      if (ratio >= 0.25 && span <= Math.max(term.length * 4, term.length + 12)) {
        found = { quality: Math.round(QUALITY.scattered + (QUALITY.scatteredBest - QUALITY.scattered) * Math.min(1, ratio)), at: best.at };
      }
    }
  }
  if (term.length >= 4) {
    const max = term.length >= 7 ? 2 : 1;
    const c0 = term.charCodeAt(0);
    const c1 = term.charCodeAt(1);
    for (let i = 0; i < text.length; i++) {
      // A typo is rarely in the first two letters at once: a word must start with one of them.
      if (!f.starts[i] || (text.charCodeAt(i) !== c0 && text.charCodeAt(i) !== c1)) continue;
      for (const len of [term.length, term.length - 1, term.length + 1]) {
        if (len < 3 || i + len > text.length) continue;
        const d = editDistance(term, text, max, i, len);
        if (d > max) continue;
        const quality = d <= 1 ? QUALITY.typo : QUALITY.typo2;
        if (!found || quality > found.quality) found = { quality, at: range(i, len) };
      }
      if (found?.quality === QUALITY.typo) break;
    }
  }
  return found;
}

/* ── matching a destination ────────────────────────────────────────────── */

export type MatchField = 'label' | 'tags' | 'type' | 'trail' | 'path';

/** A label match comes first, then the words it goes by, then where it sits, then its address. */
export const FIELD_WEIGHT: Record<MatchField, number> = { label: 1, tags: 0.8, type: 0.75, trail: 0.7, path: 0.6 };

export interface Match {
  /** 0 to 100: how well the query matches, before frecency. */
  quality: number;
  /** Letters of the label that matched, for showing them. */
  positions: number[];
  /** The field that matched best when it was not the label, and its words: "tag article". */
  via: { field: Exclude<MatchField, 'label'>; text: string } | null;
}

/** A destination's fields, folded once and reused for every keystroke. */
export interface Prepared {
  label: Folded;
  others: { field: Exclude<MatchField, 'label'>; raw: string; f: Folded }[];
}

const pathWords = (url: string): string => url.replace(/^\/+/, '').replace(/[/?=&_.+-]+/g, ' ').trim();

export function prepare(item: Pick<FindItem, 'label' | 'tags' | 'type' | 'trail' | 'url'>): Prepared {
  const trail = item.trail ?? [];
  return {
    label: fold(item.label),
    others: [
      ...(item.tags ?? []).map((t) => ({ field: 'tags' as const, raw: t, f: fold(t) })),
      ...(item.type ? [{ field: 'type' as const, raw: item.type, f: fold(item.type) }] : []),
      // Each step of the trail, and the trail read as one ("structure content types").
      ...[...trail, ...(trail.length > 1 ? [trail.join(' ')] : [])].map((t) => ({ field: 'trail' as const, raw: t, f: fold(t) })),
      { field: 'path' as const, raw: item.url, f: fold(pathWords(item.url)) },
    ],
  };
}

/** A query read once: its words, and the whole of it as a phrase. */
export interface Query {
  terms: string[];
  phrase: string;
}

export function compileQuery(query: string): Query {
  const phrase = foldQuery(query);
  return { phrase, terms: phrase ? phrase.split(' ') : [] };
}

/** The best match of one word of the query among the fields: quick ways in every field first, then slow ones. */
function bestOf(term: string, p: Prepared, positions: Set<number>): { score: number; via: Match['via'] } | null {
  for (const how of [quickMatch, slowMatch]) {
    let score = 0;
    let via: Match['via'] = null;
    const label = how(term, p.label);
    if (label) {
      score = label.quality * FIELD_WEIGHT.label;
      for (const i of original(p.label, label.at)) positions.add(i);
    }
    // Nothing else can beat a label matched this well: the best of any other field is its weight.
    if (score < 100 * FIELD_WEIGHT.tags) {
      for (const o of p.others) {
        const weight = FIELD_WEIGHT[o.field];
        if (100 * weight <= score) continue;
        const m = how(term, o.f);
        if (m && m.quality * weight > score) { score = m.quality * weight; via = { field: o.field, text: o.field === 'path' || o.field === 'type' ? '' : o.raw }; }
      }
    }
    if (score > 0) return { score, via };
  }
  return null;
}

/**
 * How a query matches a destination: every word of the query must match one of
 * its fields; each word counts by its best field, weighted. The query as a
 * whole phrase against the label counts too ("basic page" is exactly Basic
 * page). Null when any word matches nothing.
 */
export function matchItem(query: string | Query, p: Prepared): Match | null {
  const q = typeof query === 'string' ? compileQuery(query) : query;
  if (!q.terms.length) return null;
  let total = 0;
  const positions = new Set<number>();
  let via: Match['via'] = null;
  for (const term of q.terms) {
    const best = bestOf(term, p, positions);
    if (!best) return null;
    total += best.score;
    if (best.via && !via) via = best.via;
  }
  let quality = total / q.terms.length;
  if (q.terms.length > 1) {
    const phrase = quickMatch(q.phrase, p.label);
    if (phrase && phrase.quality > quality) {
      quality = phrase.quality;
      via = null;
      positions.clear();
      for (const i of original(p.label, phrase.at)) positions.add(i);
    }
  }
  return { quality: Math.round(quality * 10) / 10, positions: [...positions].sort((a, b) => a - b), via };
}

/* ── frecency: how often and how lately each was chosen ───────────────── */

/** A destination the owner chose, as remembered on this Mac for one project. */
export interface Visit {
  /** The item's id, or `path:/about` for a page with none. */
  id: string;
  label: string;
  url: string;
  kind: FindKind;
  /** How many times it was chosen, ever. */
  count: number;
  last: number;
  /** When it was chosen lately, newest last (at most VISIT_TIMES). */
  times: number[];
}

/** A choice counts half as much after a week. */
export const HALF_LIFE_MS = 7 * 86_400_000;
const VISIT_TIMES = 10;
export const MAX_VISITS = 200;

/** How often and how lately: each recent choice decays by half a week; older ones still count a little. */
export function frecency(v: Visit, now: number): number {
  const recent = v.times.reduce((sum, t) => sum + 0.5 ** (Math.max(0, now - t) / HALF_LIFE_MS), 0);
  return recent + Math.max(0, v.count - v.times.length) * 0.05;
}

/** What frecency adds to a match: enough to lift a favourite above a better-spelled stranger, never past a whole class. */
export const frecencyBoost = (f: number): number => Math.min(24, 10 * Math.log2(1 + Math.max(0, f)));

/** The visits after choosing an item now, the least used dropped past the limit. */
export function remember(visits: readonly Visit[], item: Pick<Visit, 'id' | 'label' | 'url' | 'kind'>, now: number): Visit[] {
  const before = visits.find((v) => v.id === item.id);
  const next: Visit = {
    id: item.id, label: item.label, url: item.url, kind: item.kind,
    count: (before?.count ?? 0) + 1, last: now, times: [...(before?.times ?? []), now].slice(-VISIT_TIMES),
  };
  const rest = visits.filter((v) => v.id !== item.id);
  const kept = [next, ...rest];
  if (kept.length <= MAX_VISITS) return kept;
  return kept.sort((a, b) => frecency(b, now) - frecency(a, now) || b.last - a.last).slice(0, MAX_VISITS);
}

/** Visits read back from storage: anything malformed is dropped. */
export function readVisits(raw: unknown): Visit[] {
  if (!Array.isArray(raw)) return [];
  const out: Visit[] = [];
  for (const v of raw.slice(0, MAX_VISITS)) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    const url = samePath(o.url);
    if (typeof o.id !== 'string' || !o.id || typeof o.label !== 'string' || !url || typeof o.count !== 'number' || typeof o.last !== 'number') continue;
    const times = Array.isArray(o.times) ? o.times.filter((t): t is number => typeof t === 'number' && Number.isFinite(t)).slice(-VISIT_TIMES) : [];
    const kind = (typeof o.kind === 'string' ? o.kind : 'content') as FindKind;
    out.push({ id: o.id.slice(0, 300), label: o.label.slice(0, 300), url, kind, count: Math.max(1, Math.floor(o.count)), last: o.last, times });
  }
  return out;
}

/* ── ranking ───────────────────────────────────────────────────────────── */

export interface Ranked<T extends FindItem = FindItem> {
  item: T;
  match: Match;
  /** The match's quality plus what frecency adds. */
  score: number;
}

const KIND_ORDER: readonly FindKind[] = ['content', 'admin', 'structure', 'setting', 'template', 'view', 'term', 'media', 'user'];

/**
 * Destinations that match a query, best first: the match (label above the
 * words it goes by, word starts and acronyms above letters in the middle), then
 * how often and how lately each was chosen. Ties go to what changed last, then
 * to the shorter label.
 */
export function rank<T extends FindItem>(items: readonly T[], query: string, opts: {
  prepared: (item: T) => Prepared;
  visits: ReadonlyMap<string, Visit>;
  now: number;
}): Ranked<T>[] {
  const out: Ranked<T>[] = [];
  const q = compileQuery(query);
  if (!q.terms.length) return out;
  for (const item of items) {
    const match = matchItem(q, opts.prepared(item));
    if (!match) continue;
    const v = opts.visits.get(item.id) ?? opts.visits.get(`path:${item.url}`);
    out.push({ item, match, score: match.quality + (v ? frecencyBoost(frecency(v, opts.now)) : 0) });
  }
  return out.sort((a, b) => b.score - a.score || (b.item.changed ?? 0) - (a.item.changed ?? 0) || a.item.label.length - b.item.label.length
    || KIND_ORDER.indexOf(a.item.kind) - KIND_ORDER.indexOf(b.item.kind) || a.item.label.localeCompare(b.item.label));
}

/**
 * Results worth showing: once something matches well, letters strewn through
 * the trail or the address of others are noise, and are left out.
 */
export function withoutNoise<T extends FindItem>(ranked: readonly Ranked<T>[]): Ranked<T>[] {
  const top = ranked[0]?.score ?? 0;
  return top >= 80 ? ranked.filter((r) => r.score >= 40) : [...ranked];
}

/* ── jumping straight to a path or an id ───────────────────────────────── */

export interface Jump {
  /** The same-origin path to open. */
  url: string;
  /** What the input was read as: "node 12", "post 44", "a path". */
  why: string;
  /** The entities it names, as the helpers id them ('node:12'), to show the title of the one found. */
  ids: string[];
}

const DRUPAL_PATH = /^(node|user|media|comment|taxonomy\/term|block_content|group)\/(\d{1,10})((?:\/[\w-]+)*)$/;
const WP_QUERY = /^\??(p|page_id|cat|author|tag)=([\w-]{1,100})$/;
const BARE_PATH = /^[\w.~%-]+(?:\/[\w.~%-]*)+(?:\?[^\s#]*)?$/;

/**
 * What typing a path or an id means: "/about" and "admin/content" are paths,
 * "12" is node 12 on Drupal and post 44 is "44" or "?p=44" on WordPress,
 * "node/12/edit" is Drupal's own path, and the site's own full address is
 * its path. Null when the input is words to search for.
 */
export function directJump(input: string, platform: LivePlatform | null, origin: string | null): Jump | null {
  const text = input.trim();
  if (!text || text.length > 2000 || /\s/.test(text)) return null;
  if (/^https?:\/\//i.test(text)) {
    if (!origin) return null;
    try {
      const u = new URL(text);
      const o = new URL(origin);
      if (u.hostname.toLowerCase() !== o.hostname.toLowerCase()) return null;
      const path = samePath(`${u.pathname}${u.search}`);
      return path ? { url: path, why: 'this site’s address', ids: idsFromPath(path) } : null;
    } catch { return null; }
  }
  if (text.startsWith('/')) {
    const path = samePath(text);
    return path ? { url: path, why: 'a path', ids: idsFromPath(path) } : null;
  }
  if (/^\d{1,10}$/.test(text)) {
    if (platform === 'drupal') return { url: `/node/${text}`, why: `node ${text}`, ids: [`node:${text}`] };
    if (platform === 'wordpress') return { url: `/?p=${text}`, why: `post ${text}`, ids: [`post:${text}`, `page:${text}`] };
    return null;
  }
  const drupal = DRUPAL_PATH.exec(text);
  if (drupal) {
    const [, type, id] = drupal as unknown as [string, string, string];
    return { url: `/${text}`, why: `${type === 'taxonomy/term' ? 'term' : type.replace('_', ' ')} ${id}`, ids: idsFromPath(`/${text}`) };
  }
  const wp = WP_QUERY.exec(text);
  if (wp) {
    const [, key, value] = wp as unknown as [string, string, string];
    const post = (key === 'p' || key === 'page_id') && /^\d+$/.test(value);
    return { url: `/?${key}=${value}`, why: post ? `post ${value}` : `?${key}=${value}`, ids: post ? [`post:${value}`, `page:${value}`] : [] };
  }
  if (BARE_PATH.test(text)) {
    const path = samePath(`/${text}`);
    return path ? { url: path, why: 'a path', ids: idsFromPath(path) } : null;
  }
  return null;
}

/* ── which destination the page shown is ──────────────────────────────── */

/**
 * The entities a path names, as the helpers id them: Drupal's own paths
 * (`/node/12`, `/node/12/edit`, `/taxonomy/term/5`) and WordPress's
 * (`/?p=44`, `/?page_id=7`, `wp-admin/post.php?post=44`).
 */
export function idsFromPath(path: string): string[] {
  const ids: string[] = [];
  const drupal = /^\/(node|user|media|comment|taxonomy\/term|block_content|group)\/(\d{1,10})(?:\/|$|\?)/.exec(path);
  if (drupal) {
    const [, type, id] = drupal as unknown as [string, string, string];
    if (type === 'taxonomy/term') ids.push(`taxonomy_term:${id}`, `term:${id}`); else ids.push(`${type}:${id}`);
  }
  const query = /[?&](p|page_id|post)=(\d{1,10})(?:&|$)/.exec(path);
  if (query && (path.startsWith('/?') || path.startsWith('/index.php?') || path.startsWith('/wp-admin/post.php?'))) {
    ids.push(`post:${query[2]}`, `page:${query[2]}`);
  }
  return ids;
}

/** The entities WordPress's body classes name: `postid-44`, `page-id-7`. */
export function idsFromClasses(classes: readonly string[]): string[] {
  const ids: string[] = [];
  for (const c of classes) {
    const m = /^(?:postid|page-id)-(\d{1,10})$/.exec(c);
    if (m) ids.push(`post:${m[1]}`, `page:${m[1]}`);
  }
  return ids;
}

const samePlace = (a: string, b: string): boolean => {
  const norm = (p: string): string => {
    const [path = '', query = ''] = p.split('?');
    const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
    return `${decodeSafe(trimmed).toLowerCase()}${query ? `?${query}` : ''}`;
  };
  return norm(a) === norm(b);
};

function decodeSafe(s: string): string {
  try { return decodeURI(s); } catch { return s; }
}

/**
 * The destination the page shown is: the one it names by id, else the one at
 * its address (or its canonical address or shortlink), else the one whose edit
 * form or task it is. Null when none is.
 */
export function hereItem<T extends FindItem>(items: readonly T[], here: LiveHere | null): T | null {
  if (!here) return null;
  const ids = new Set(here.ids);
  const byId = items.find((i) => ids.has(i.id));
  if (byId) return byId;
  const paths = [here.path, ...here.paths];
  return items.find((i) => paths.some((p) => samePlace(i.url, p)))
    ?? items.find((i) => (i.edit && paths.some((p) => samePlace(i.edit as string, p))) || (i.actions ?? []).some((a) => paths.some((p) => samePlace(a.url, p))))
    ?? null;
}

/* ── groups ────────────────────────────────────────────────────────────── */

export type GoToGroup = 'Go to' | 'This page' | 'Recent' | 'Most used' | 'Content' | 'Admin' | 'Structure' | 'Templates' | 'Settings' | 'Pages';

/** The group a kind of destination is listed under. */
export function kindGroup(kind: FindKind): GoToGroup {
  switch (kind) {
    case 'content': case 'term': case 'user': case 'media': return 'Content';
    case 'admin': return 'Admin';
    case 'structure': case 'view': return 'Structure';
    case 'template': return 'Templates';
    case 'setting': return 'Settings';
  }
}

/** How many of each group a typed query shows before "more". */
export const GROUP_LIMIT: Partial<Record<GoToGroup, number>> = { Content: 8, Pages: 8 };
const DEFAULT_LIMIT = 5;

export interface Grouped<T> {
  group: GoToGroup;
  rows: T[];
  /** How many more matched than are shown. */
  more: number;
}

/**
 * Ranked results in groups: each group in the order of its best result (so the
 * best result is first), and within a group by score, each group cut to its
 * limit. `groupOf` places each one.
 */
export function groupRanked<T extends FindItem>(ranked: readonly Ranked<T>[], groupOf: (r: Ranked<T>) => GoToGroup): Grouped<Ranked<T>>[] {
  const groups = new Map<GoToGroup, Ranked<T>[]>();
  for (const r of ranked) {
    const g = groupOf(r);
    const list = groups.get(g);
    if (list) list.push(r); else groups.set(g, [r]);
  }
  return [...groups.entries()]
    .sort((a, b) => (b[1][0] as Ranked<T>).score - (a[1][0] as Ranked<T>).score)
    .map(([group, rows]) => {
      const limit = GROUP_LIMIT[group] ?? DEFAULT_LIMIT;
      return { group, rows: rows.slice(0, limit), more: Math.max(0, rows.length - limit) };
    });
}

/** A path guessed as a kind when the helper did not say: the site's admin is admin, anything else a page. */
export function guessKind(path: string): FindKind {
  return /^\/(admin|wp-admin|user\/\d+\/edit)(\/|$|\?)/.test(path) ? 'admin' : 'content';
}

/**
 * A page's title without the site's name a theme adds after it ("News | Acme"
 * is News): a bar, an en or em dash or a middle dot, then a short name. A
 * hyphen is left alone, being part of too many titles.
 */
export function pageTitle(title: string): string {
  const m = /^(.+?)\s+[|–—·]\s+[^|–—·]{1,40}$/.exec(title.trim());
  return m ? (m[1] as string).trim() : title.trim();
}

/** The full address of a path on a site. Null when it is not a same-origin path. */
export function addressOf(origin: string | null, path: string): string | null {
  if (!origin || !samePath(path)) return null;
  try { return new URL(path, origin).toString(); } catch { return null; }
}
