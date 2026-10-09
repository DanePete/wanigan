// Agents seeing the live view: what a session's tools ask, what the app answers,
// and the pure rules between them. The core has no browser, so it relays each
// question to the app (a `liveAsk` event) and waits for the answer
// (`live.answer`); the app renders the page in a hidden window, never moving
// the owner's own view. Everything here is pure: the core, the app and the
// tests read it the same way. Design: docs/design/2026-10-08-live-view.md.
import { inFolder, regionMadeBy, sameSite, type LivePlatform, type LiveProblem, type LiveRegion } from './live.ts';
import { nameOf, type PartName } from './live-names.ts';
import type { ChangedArea } from './live-diff.ts';

/** What the core asks the app. Each agent tool is one of these underneath. */
export type LiveAskKind = 'status' | 'render' | 'problems' | 'diff';

/** A picture to take of a rendered page: none, the first screen, the whole page, or one part. */
export type LiveCapture = 'none' | 'screen' | 'page' | 'part';

/** A question for the app, carried by the `liveAsk` event to the owner's connections (never to phones). */
export interface LiveAsk {
  id: string;
  kind: LiveAskKind;
  projectId: string;
  sessionId: string;
  /** The project's local site as the owner set it. */
  site: { url: string; platform: LivePlatform | null };
  /** The page to read, on the site; null is the page the owner is looking at (else the card's page, else the site's address). */
  url: string | null;
  /** The card's page, used when the owner's view is not on this project. */
  cardPage: string | null;
  /** CSS pixels wide; null is the owner's view's width, or 1440. */
  width: number | null;
  capture: LiveCapture;
  /** The part to describe and crop to, by its id (partIds). */
  part: string | null;
  /** problems: the owner's view's console entries from this time on; null for all since it loaded. */
  since: number | null;
  /** diff: the screenshot to compare the page now with. */
  shot: { id: string; url: string } | null;
  /** When the core stops waiting (epoch ms): work that cannot finish by then need not start. */
  deadline: number;
}

/** What the owner's own live view shows now, as the app says. */
export interface LiveViewNow {
  /** The view is on this project's site. */
  showing: boolean;
  /** It is in the window now (not hidden behind another tab). */
  visible: boolean;
  url: string | null;
  title: string;
  /** CSS pixels. */
  width: number | null;
  height: number | null;
  loading: boolean;
}

export interface LiveStatusAnswer {
  /** Settings › Live view is on. */
  on: boolean;
  /** …and on for this kind of site. */
  onForSite: boolean;
  /** Before and after screenshots are on. */
  shots: boolean;
  /** Wanigan's window is open. */
  window: boolean;
  view: LiveViewNow | null;
}

/** A picture of a page or part of it, as base64. */
export interface LiveImage {
  data: string;
  mimeType: 'image/jpeg' | 'image/png';
  /** Pixels of the image itself. */
  width: number;
  height: number;
  /** What of the page it shows, in CSS pixels of the document. */
  rect: { x: number; y: number; width: number; height: number };
  /** The page went on below what is shown. */
  cut: boolean;
}

/** Where a rendered page's address came from. */
export type LiveSource = 'view' | 'card' | 'site' | 'asked';

/** A page rendered in the app's hidden window: its parts, their words, and a picture when one was asked for. */
export interface LiveRendered {
  url: string;
  title: string;
  /** CSS pixels: the width it was rendered at, and the document's height. */
  width: number;
  height: number;
  source: LiveSource;
  regions: LiveRegion[];
  /** Each region's words (cut short), by its index. */
  texts: Record<string, string>;
  /** The part asked for: whether it was on the page, and its key computed styles. */
  partFound: boolean | null;
  style: Record<string, string> | null;
  image: LiveImage | null;
  /** What this load of the page reported: its own messages, its console, requests that failed. */
  problems: LiveProblem[];
}

/** A problem the owner's view logged, and when. */
export type TimedProblem = LiveProblem & { at: number };

export interface LiveProblemsAnswer {
  url: string;
  title: string;
  width: number;
  source: LiveSource;
  /** A fresh load of the page: its own messages, its console, failed requests. */
  page: LiveProblem[];
  /** The owner's view, when it shows this page: its console since it loaded (or since `since`). Null when it shows something else. */
  view: TimedProblem[] | null;
}

/** The page now compared with a screenshot: the areas that differ, in CSS pixels, and the parts on the page now. */
export interface LiveDiffAnswer {
  url: string;
  title: string;
  /** CSS pixels the two were compared at. */
  width: number;
  height: number;
  pixels: number;
  total: number;
  areas: ChangedArea[];
  regions: LiveRegion[];
  /** The page grew or shrank: the two heights in CSS pixels. */
  heights: { before: number; after: number };
}

/** What an agent's tool gets back from the core: words for the model, the same as data, and a picture when asked for. */
export interface LiveToolResult {
  text: string;
  structured: Record<string, unknown>;
  image: LiveImage | null;
}

/** The tools an agent sees, by the names its CLI shows them. */
export const LIVE_TOOLS = ['live_status', 'live_look', 'live_find', 'live_part', 'live_problems', 'live_diff'] as const;
export type LiveTool = (typeof LIVE_TOOLS)[number];

/** One call an agent made to the live view, kept as evidence on its card. */
export interface LiveLook {
  id: number;
  sessionId: string;
  cardId: string | null;
  tool: LiveTool;
  /** The page, as a path on the site; null when none was read. */
  page: string | null;
  width: number | null;
  /** What it asked, in a few words (a search, a part's id). */
  asked: string;
  /** What came back, in a few words, or why it was refused. */
  said: string;
  ok: boolean;
  at: number;
  /** Files the session edited after this call: 0 means it looked after its last edit. */
  editsAfter: number;
  /** Files it had edited before it. */
  editsBefore: number;
  provider: string;
  sessionTitle: string;
}

/* ── limits ─────────────────────────────────────────────────────────────── */

export const LIVE_WIDTH = { min: 320, max: 2560 } as const;
/** The width screenshots are taken at, and so the one a diff compares at. */
export const SHOT_WIDTH = 1440;
/** An image sent to an agent is at most this many pixels wide, and this tall. */
export const IMAGE_MAX = { width: 1280, height: 4000 } as const;
const MAX_REGIONS = 2_000;
const MAX_TEXT = 200;
const MAX_FIELD = 300;

/* ── what an agent may ask for ─────────────────────────────────────────── */

/**
 * A page of the project's own site, from what an agent passed: a path
 * ("/about", "about?x=1") or a full address on the same site. Anything that
 * would leave the site (another host, a scheme, credentials, `//host`) is
 * refused. The address returned always has the site's own origin.
 */
export function sitePage(raw: unknown, site: string): { url: string } | { refused: string } {
  const say = `Only pages of this project's local site (${site}) can be looked at. Pass a path such as /about.`;
  if (typeof raw !== 'string') return { refused: say };
  const text = raw.trim();
  if (!text || text.length > 2_000 || /[\u0000-\u001f\u007f\\]/.test(text)) return { refused: say };
  let base: URL;
  try { base = new URL(site); } catch { return { refused: 'The project’s site address cannot be read.' }; }
  let url: URL;
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
      url = new URL(text);
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || !sameSite(url.toString(), base.toString())) return { refused: say };
    } else if (text.startsWith('//')) {
      return { refused: say };
    } else {
      url = new URL(text.startsWith('/') ? text : `/${text}`, base);
    }
  } catch {
    return { refused: say };
  }
  // Rebuilt on the site's own origin: whatever was passed, nothing else is opened.
  const page = new URL(`${url.pathname}${url.search}`, base.origin);
  if (page.origin !== base.origin) return { refused: say };
  return { url: page.toString() };
}

/** A width an agent passed: CSS pixels, within bounds; null when none was passed. */
export function liveWidth(raw: unknown): number | null | { refused: string } {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < LIVE_WIDTH.min || raw > LIVE_WIDTH.max) {
    return { refused: `A width is a whole number of CSS pixels from ${LIVE_WIDTH.min} to ${LIVE_WIDTH.max} (375 is a phone, 768 a tablet, 1440 a desktop).` };
  }
  return raw;
}

/** A part id, as partIds writes them. */
export const PART_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/* ── part ids ──────────────────────────────────────────────────────────── */

/** FNV-1a, as four base-36 characters: short, stable, and the same in every process. */
function hash4(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % 1_679_616).toString(36).padStart(4, '0');
}

/** What a part is, wherever it sits: the same part on a reloaded or narrower page has the same identity. */
function identity(r: LiveRegion): string {
  return [r.component, r.file, r.entity, r.block, r.view, r.element, r.field, r.hook].map((v) => v ?? '').join('|');
}

const slug = (title: string): string => title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '') || 'part';

/**
 * An id for every part of a page that names it the same way on the next load:
 * its name, a hash of what made it, and which one of those it is counting in
 * the order the page is written (the second teaser stays the second at any
 * width). The app and the core compute the same ids from the same scan.
 */
export function partIds(regions: readonly LiveRegion[]): Map<number, string> {
  const ordered = [...regions].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.index - b.index);
  const seen = new Map<string, number>();
  const ids = new Map<number, string>();
  for (const r of ordered) {
    const key = identity(r);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    ids.set(r.index, `${slug(nameOf(r).title)}-${hash4(key)}${n > 1 ? `-${n}` : ''}`);
  }
  return ids;
}

/** The region an id names on this page, or null when the page has no such part now. */
export function regionById(regions: readonly LiveRegion[], id: string): LiveRegion | null {
  for (const [index, pid] of partIds(regions)) if (pid === id) return regions.find((r) => r.index === index) ?? null;
  return null;
}

/* ── finding parts ─────────────────────────────────────────────────────── */

export interface FoundPart {
  id: string;
  region: LiveRegion;
  name: PartName;
  text: string;
  /** What matched: its id, its name, what made it, or its words. */
  by: 'id' | 'name' | 'made' | 'text';
}

/**
 * The parts that match what an agent is looking for: every word of the query
 * in the part's id, name, kind, template, component, content, block, view or
 * field, or its words on the page. Best first: an id, then a name, then what
 * made it, then the words it shows; smaller parts before larger ones.
 */
export function findParts(regions: readonly LiveRegion[], texts: Readonly<Record<string, string>>, query: string,
  componentName: (id: string) => string | null = () => null, limit = 20): FoundPart[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 12);
  if (!words.length) return [];
  const ids = partIds(regions);
  const rank = { id: 0, name: 1, made: 2, text: 3 } as const;
  const out: FoundPart[] = [];
  for (const r of regions) {
    const id = ids.get(r.index) ?? '';
    const name = nameOf(r, r.component ? componentName(r.component) : null);
    const text = texts[String(r.index)] ?? '';
    const made = [r.file, r.component, r.hook, r.entity, r.block, r.view, r.element, r.field, ...r.suggestions].filter(Boolean).join(' ').toLowerCase();
    const titled = `${name.title} ${name.kind}`.toLowerCase();
    const every = (hay: string): boolean => words.every((w) => hay.includes(w));
    const by = id === query.trim().toLowerCase() ? 'id' : every(titled) ? 'name' : every(made) ? 'made'
      : every(`${titled} ${made}`) ? 'made' : every(text.toLowerCase()) || every(`${titled} ${made} ${text.toLowerCase()}`) ? 'text' : null;
    if (by) out.push({ id, region: r, name, text, by });
  }
  const size = (r: LiveRegion): number => r.rect.width * r.rect.height;
  out.sort((a, b) => rank[a.by] - rank[b.by] || Number(a.name.wrapper) - Number(b.name.wrapper) || size(a.region) - size(b.region) || a.region.order - b.region.order);
  return out.slice(0, limit);
}

/* ── what changed, and what explains it ────────────────────────────────── */

export interface ExplainedArea {
  area: ChangedArea;
  /** The smallest parts it falls in or touches, innermost first. */
  parts: { id: string; title: string; kind: string; file: string | null; component: string | null }[];
  /** Files this session edited that made a part the area overlaps, the innermost part's first. */
  explainedBy: string[];
}

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): number => {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

/**
 * Each changed area, with the parts of the page it overlaps and the edited
 * files that made any of them: a template the region names (relative to the
 * site's root, so matched at a folder boundary), or a component whose folder
 * holds an edited file. An area no edited file explains has none: that is what
 * an agent and the owner should look at twice (a stylesheet, content, data).
 */
export function explainAreas(areas: readonly ChangedArea[], regions: readonly LiveRegion[], edited: readonly string[],
  components: readonly { id: string; dir: string; name?: string }[] = []): ExplainedArea[] {
  const ids = partIds(regions);
  const dirs = new Map(components.map((c) => [c.id, c.dir]));
  const names = new Map(components.map((c) => [c.id, c.name ?? null]));
  const madeBy = (r: LiveRegion): string[] => edited.filter((path) => regionMadeBy(r.file, path)
    || (!!r.component && !!dirs.get(r.component) && inFolder(dirs.get(r.component) as string, path)));
  return areas.map((area) => {
    const touched = regions.filter((r) => overlaps(r.rect, area) > 0)
      .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height || b.order - a.order);
    const named = touched.filter((r) => !nameOf(r).wrapper);
    const parts: ExplainedArea['parts'] = [];
    for (const r of named) {
      if (parts.length >= 3) break;
      const n = nameOf(r, r.component ? names.get(r.component) ?? null : null);
      parts.push({ id: ids.get(r.index) ?? '', title: n.title, kind: n.kind, file: r.file, component: r.component });
    }
    const explainedBy: string[] = [];
    for (const r of touched) for (const file of madeBy(r)) if (!explainedBy.includes(file)) explainedBy.push(file);
    return { area, parts, explainedBy };
  });
}

/* ── answers from the app, bounded before anything reads them ──────────── */

const str = (v: unknown, max = MAX_FIELD): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const num = (v: unknown, max = 1_000_000): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-max, Math.min(max, Math.round(v))) : 0);
const rectOf = (v: unknown): { x: number; y: number; width: number; height: number } => {
  const r = v && typeof v === 'object' ? v as Record<string, unknown> : {};
  return { x: num(r.x), y: num(r.y), width: Math.max(0, num(r.width)), height: Math.max(0, num(r.height)) };
};

/** Regions as the page script reported them, every field checked and cut to size. */
export function cleanRegions(raw: unknown): LiveRegion[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_REGIONS).flatMap((v): LiveRegion[] => {
    if (!v || typeof v !== 'object') return [];
    const r = v as Record<string, unknown>;
    if (!Number.isInteger(r.index) || (r.index as number) < 0) return [];
    return [{
      index: r.index as number,
      file: str(r.file), entity: str(r.entity), block: str(r.block), view: str(r.view), element: str(r.element),
      component: str(r.component), piece: str(r.piece), hook: str(r.hook), field: str(r.field),
      suggestions: Array.isArray(r.suggestions) ? r.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 12).map((s) => s.slice(0, 120)) : [],
      parent: Number.isInteger(r.parent) ? r.parent as number : null,
      order: Number.isInteger(r.order) ? r.order as number : r.index as number,
      rect: rectOf(r.rect),
    }];
  });
}

function cleanTexts(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_REGIONS)) {
    if (/^\d{1,5}$/.test(k) && typeof v === 'string') out[k] = v.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  }
  return out;
}

export function cleanProblems(raw: unknown, max = 60): LiveProblem[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, max).flatMap((v): LiveProblem[] => {
    const p = v && typeof v === 'object' ? v as Record<string, unknown> : null;
    if (!p || typeof p.text !== 'string') return [];
    const source = p.source === 'page' || p.source === 'console' || p.source === 'network' ? p.source : 'console';
    return [{ level: p.level === 'warning' ? 'warning' : 'error', text: p.text.slice(0, 400), source }];
  });
}

const SOURCES: readonly LiveSource[] = ['view', 'card', 'site', 'asked'];
const source = (v: unknown): LiveSource => (SOURCES.includes(v as LiveSource) ? v as LiveSource : 'asked');

function cleanImage(raw: unknown): LiveImage | null {
  const i = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  if (!i || typeof i.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(i.data.slice(0, 64)) || i.data.length > 6 * 1024 * 1024) return null;
  return {
    data: i.data, mimeType: i.mimeType === 'image/png' ? 'image/png' : 'image/jpeg',
    width: Math.max(1, num(i.width, 20_000)), height: Math.max(1, num(i.height, 20_000)), rect: rectOf(i.rect), cut: i.cut === true,
  };
}

export function cleanStatus(raw: unknown): LiveStatusAnswer {
  const s = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const v = s.view && typeof s.view === 'object' ? s.view as Record<string, unknown> : null;
  return {
    on: s.on === true, onForSite: s.onForSite === true, shots: s.shots === true, window: s.window === true,
    view: v ? {
      showing: v.showing === true, visible: v.visible === true, url: str(v.url, 2_000), title: str(v.title) ?? '',
      width: v.width === null ? null : num(v.width, 20_000) || null, height: v.height === null ? null : num(v.height, 20_000) || null, loading: v.loading === true,
    } : null,
  };
}

export function cleanRendered(raw: unknown): LiveRendered {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const style = r.style && typeof r.style === 'object' ? Object.fromEntries(Object.entries(r.style as Record<string, unknown>)
    .filter((e): e is [string, string] => /^[a-z-]{1,40}$/.test(e[0]) && typeof e[1] === 'string').slice(0, 40).map(([k, v]) => [k, v.slice(0, 120)])) : null;
  return {
    url: str(r.url, 2_000) ?? '', title: str(r.title) ?? '', width: num(r.width, 20_000), height: num(r.height, 100_000), source: source(r.source),
    regions: cleanRegions(r.regions), texts: cleanTexts(r.texts), partFound: typeof r.partFound === 'boolean' ? r.partFound : null,
    style, image: cleanImage(r.image), problems: cleanProblems(r.problems),
  };
}

export function cleanProblemsAnswer(raw: unknown): LiveProblemsAnswer {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const view = Array.isArray(r.view) ? r.view.slice(0, 60).flatMap((v): TimedProblem[] => {
    const [p] = cleanProblems([v]);
    const at = (v as { at?: unknown })?.at;
    return p ? [{ ...p, at: typeof at === 'number' && Number.isFinite(at) ? at : 0 }] : [];
  }) : null;
  return { url: str(r.url, 2_000) ?? '', title: str(r.title) ?? '', width: num(r.width, 20_000), source: source(r.source), page: cleanProblems(r.page), view };
}

export function cleanDiff(raw: unknown): LiveDiffAnswer {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const areas = Array.isArray(r.areas) ? r.areas.slice(0, 200).map((a) => ({ ...rectOf(a), pixels: Math.max(0, num((a as { pixels?: unknown })?.pixels, 1e9)) })) : [];
  const h = r.heights && typeof r.heights === 'object' ? r.heights as Record<string, unknown> : {};
  return {
    url: str(r.url, 2_000) ?? '', title: str(r.title) ?? '', width: num(r.width, 20_000), height: num(r.height, 100_000),
    pixels: Math.max(0, num(r.pixels, 1e9)), total: Math.max(0, num(r.total, 1e9)), areas, regions: cleanRegions(r.regions),
    heights: { before: Math.max(0, num(h.before, 100_000)), after: Math.max(0, num(h.after, 100_000)) },
  };
}
