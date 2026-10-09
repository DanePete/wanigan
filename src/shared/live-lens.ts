// Reading a page through the site helper's trace (live-trace.ts): which part
// of the page each region is, the lenses that colour the page by owner, cache,
// cost, what can be edited and what just changed, what to say when there is no
// trace, and where an edit sheet sits beside a part. Pure, so the window, the
// main process and the tests read it the same way.
import type { LiveRegion } from './live.ts';
import { nameOf, originOf } from './live-names.ts';
import type { EditKind, EditTarget, LiveTrace, PartKind, TracePart, TraceQuery } from './live-trace.ts';

/* ── the trace, as the live view asked for it ──────────────────────────── */

/** What asking for the shown page's trace came to. */
export type LiveTraceAnswer =
  | { state: 'ok'; trace: LiveTrace }
  /** No page is shown, or it is not on the site. */
  | { state: 'none' }
  /** The site has no helper the live view can ask. */
  | { state: 'no-helper' }
  /** The page arrived without an X-Wanigan-Trace header: a cached copy, or a page the platform did not render. */
  | { state: 'missing' }
  /** The helper no longer keeps that render's trace (it keeps them ten minutes). */
  | { state: 'expired' }
  /** The helper refused: the token, or the user logged in in the view may not see traces. */
  | { state: 'refused'; status: number }
  /** An answer that is not a trace this Wanigan reads; `version` is the one it said, when it said one. */
  | { state: 'unreadable'; version: number | null }
  /** The site did not answer. */
  | { state: 'down'; error: string }
  /** The answer was larger than Wanigan reads. */
  | { state: 'too-large' };

/** A sheet's form saved, or the sheet closed without saving. */
export interface LiveEdited {
  target: string;
  label: string;
  saved: boolean;
  /** Why the sheet could not show the form, when it could not. */
  error: string | null;
}

/** What saving a schema edit came to. */
export interface LiveEditSaved {
  ok: boolean;
  error: string | null;
  /** The revision the save made, when the site keeps them. */
  revision: string | null;
}

export type TraceStep = 'reload' | 'update-helper' | 'install-helper' | 'update-wanigan' | 'log-in' | 'start-site' | null;

/** What to tell the owner about a trace they do not have, and the one thing to do next. */
export function traceNote(answer: LiveTraceAnswer | null, helper: { outdated: boolean } | null, platform: string | null): { title: string; body: string; next: TraceStep } | null {
  if (platform !== 'drupal' && platform !== 'wordpress') {
    return { title: 'No trace for this kind of site', body: 'Traces come from the Drupal and WordPress helpers. This site shows what its own markup says, and nothing more.', next: null };
  }
  const cms = platform === 'drupal' ? 'Drupal' : 'WordPress';
  if (!helper || answer?.state === 'no-helper') {
    return { title: 'The site helper is not installed', body: `The ${cms} helper reports what made each part, its cache and cost, the hooks and queries behind the page, and what you can edit here.`, next: 'install-helper' };
  }
  if (answer?.state === 'ok') return null;
  if (helper.outdated) {
    return { title: 'Update the helper to see this', body: `The ${cms} helper in this site is older than this Wanigan and does not report traces yet. Updating it rewrites only its own folder.`, next: 'update-helper' };
  }
  switch (answer?.state ?? 'none') {
    case 'none': return { title: 'No trace yet', body: 'The trace arrives once the page has loaded.', next: null };
    case 'missing': return { title: 'This page came without a trace', body: `${cms} sends one with every page it renders for the live view. A copy from the browser’s cache, a file served directly, or an error page carries none.`, next: 'reload' };
    case 'expired': return { title: 'This render’s trace is gone', body: 'The helper keeps a page’s trace for ten minutes. Reloading renders it again, with a new trace.', next: 'reload' };
    case 'refused': return { title: 'The helper would not give the trace', body: `It answered ${(answer as { status: number }).status}. Traces are for a user who may administer the site: log in as one in the live view, then reload.`, next: 'log-in' };
    case 'unreadable': {
      const v = (answer as { version: number | null }).version;
      return v !== null && v > 1
        ? { title: 'The helper is newer than this Wanigan', body: `It reports trace version ${v}; this Wanigan reads version 1. Update Wanigan to read it.`, next: 'update-wanigan' }
        : { title: 'The trace could not be read', body: 'The helper answered with something that is not a trace this Wanigan reads. Updating the helper puts back the one this Wanigan expects.', next: 'update-helper' };
    }
    case 'down': return { title: 'The site did not answer', body: `Asking for the trace failed: ${(answer as { error: string }).error}. Start the site (for ddev: ddev start in the project folder), then reload.`, next: 'start-site' };
    case 'too-large': return { title: 'The trace is too large to read', body: 'The helper’s answer is over 16 MB, more than Wanigan reads. A page with fewer parts, or an updated helper that bounds its lists, has one Wanigan can show.', next: 'update-helper' };
    default: return null;
  }
}

/** The lists a trace says it cut short, in the owner's words. */
export function truncatedNote(trace: LiveTrace): string | null {
  if (!trace.truncated?.length) return null;
  const names = trace.truncated.map((t) => t.replace(/^chain:.*/, 'a part’s hooks').replace(/^variables:.*/, 'a part’s variables'));
  return `The helper cut some lists short to keep the trace small: ${[...new Set(names)].join(', ')}. What is shown is what it kept.`;
}

/* ── parts and regions ─────────────────────────────────────────────────── */

export interface PartIndex {
  parts: Map<string, TracePart>;
  edits: Map<string, EditTarget>;
  /** The trace part each region of the page is, by the region's index. */
  byRegion: Map<number, TracePart>;
  /** The regions of the page each part is, by part id. */
  regionsOf: Map<string, number[]>;
}

const EMPTY_INDEX: PartIndex = { parts: new Map(), edits: new Map(), byRegion: new Map(), regionsOf: new Map() };

/** Tie the page's regions to the trace's parts, by the part id the page script read from the `wl:part` comments. */
export function partIndex(regions: readonly LiveRegion[], trace: LiveTrace | null): PartIndex {
  if (!trace) return EMPTY_INDEX;
  const parts = new Map(trace.parts.map((p) => [p.id, p]));
  const byRegion = new Map<number, TracePart>();
  const regionsOf = new Map<string, number[]>();
  for (const r of regions) {
    const p = r.part ? parts.get(r.part) : undefined;
    if (!p) continue;
    byRegion.set(r.index, p);
    regionsOf.set(p.id, [...(regionsOf.get(p.id) ?? []), r.index]);
  }
  return { parts, edits: new Map(trace.edits.map((e) => [e.id, e])), byRegion, regionsOf };
}

/**
 * The trace part for a chosen region: its own, or the nearest one around it
 * (the chain is the region and its ancestors, innermost first). `inherited`
 * says it is an ancestor's.
 */
export function partFor(chain: readonly LiveRegion[], index: PartIndex): { part: TracePart; region: LiveRegion; inherited: boolean } | null {
  for (const [i, r] of chain.entries()) {
    const part = index.byRegion.get(r.index);
    if (part) return { part, region: r, inherited: i > 0 };
  }
  return null;
}

/** A part's own queries, slowest first. */
export function partQueries(trace: LiveTrace | null, partId: string): TraceQuery[] {
  return (trace?.queries ?? []).filter((q) => q.part === partId).sort((a, b) => b.ms - a.ms);
}

/** Queries grouped by the file that ran them, the slowest group first, each slowest first. */
export function queriesByCaller(queries: readonly TraceQuery[]): { caller: string; ms: number; queries: TraceQuery[] }[] {
  const groups = new Map<string, TraceQuery[]>();
  for (const q of queries) {
    const key = q.caller ? `${q.caller.file}${q.caller.line !== undefined ? `:${q.caller.line}` : ''}` : 'Caller not reported';
    groups.set(key, [...(groups.get(key) ?? []), q]);
  }
  return [...groups].map(([caller, list]) => ({ caller, ms: list.reduce((s, q) => s + q.ms, 0), queries: [...list].sort((a, b) => b.ms - a.ms) }))
    .sort((a, b) => b.ms - a.ms);
}

/** The `n` slowest of a list that reports times, as a set of their positions: what a timeline highlights. */
export function slowest(items: readonly { ms?: number }[], n: number): Set<number> {
  return new Set(items.map((s, i) => ({ i, ms: s.ms ?? 0 })).filter((s) => s.ms > 0).sort((a, b) => b.ms - a.ms).slice(0, n).map((s) => s.i));
}

/** How a part kind is named in the layers, when the helper's label is all the page has. */
export const PART_KIND_LABEL: Record<PartKind, string> = {
  template: 'Template', component: 'Component', block: 'Block', entity: 'Content', field: 'Field', view: 'View', region: 'Region',
  form: 'Form', shortcode: 'Shortcode', pattern: 'Pattern', menu: 'Menu', widget: 'Widget',
};

/* ── lenses ────────────────────────────────────────────────────────────── */

export const LENSES = [
  { id: 'structure', label: 'Structure', hint: 'What holds what, as layers' },
  { id: 'owner', label: 'Owner', hint: 'Whose code made each part: yours, contributed or core' },
  { id: 'cache', label: 'Cache', hint: 'How each part is cached: kept, expiring, never, or filled in late' },
  { id: 'cost', label: 'Cost', hint: 'Time and queries each part took in this render' },
  { id: 'editable', label: 'Editable', hint: 'What you can change here, and how' },
  { id: 'changed', label: 'Changed', hint: 'What the last edits made' },
] as const;

export type LensId = (typeof LENSES)[number]['id'];

/**
 * The colours a lens paints with: tokens.css's lens hues, mid-tone so they
 * read over any page, and clear of the four meanings. Amber is never one: on a
 * lens it would say "needs you" about a template. Water marks what an edit
 * changed, as the outlines always have.
 */
export type LensTone = 'lens-teal' | 'lens-cobalt' | 'lens-violet' | 'lens-slate' | 'lens-magenta' | 'water';

export interface LensClass {
  id: string;
  label: string;
  /** One line on what it means. */
  hint: string;
  tone: LensTone;
  /** How strongly the part is filled, 0 to 0.4; its outline is always drawn. */
  fill: number;
  /** Dashed: something that is there but is not this (an edit refused here). */
  dashed?: boolean;
}

const CLASSES: Record<Exclude<LensId, 'structure'>, LensClass[]> = {
  owner: [
    { id: 'yours', label: 'Yours', hint: 'Your theme or your own module: yours to change', tone: 'lens-teal', fill: 0.14 },
    { id: 'theme', label: 'A theme', hint: 'A theme the path cannot place: yours, or the parent of yours', tone: 'lens-cobalt', fill: 0.1 },
    { id: 'contrib', label: 'Contributed', hint: 'A contributed module or plugin: change it by overriding, not in place', tone: 'lens-violet', fill: 0.1 },
    { id: 'core', label: 'Core', hint: 'The platform itself: override it in your theme', tone: 'lens-slate', fill: 0.08 },
  ],
  cache: [
    { id: 'permanent', label: 'Kept', hint: 'Cached until something it depends on changes (its cache tags)', tone: 'lens-teal', fill: 0.1 },
    { id: 'max-age', label: 'Expires', hint: 'Cached for a set time (max-age)', tone: 'lens-cobalt', fill: 0.12 },
    { id: 'uncacheable', label: 'Never cached', hint: 'Built again for every request (max-age 0)', tone: 'lens-magenta', fill: 0.16 },
    { id: 'placeholder', label: 'Filled in late', hint: 'A placeholder the platform fills after the cached page (lazy builder, BigPipe)', tone: 'lens-violet', fill: 0.16 },
  ],
  cost: [
    { id: 'heavy', label: 'Heavy', hint: '50 ms or more, or 20 or more queries, in this render', tone: 'lens-violet', fill: 0.26 },
    { id: 'notable', label: 'Notable', hint: '10 ms or more, or 5 or more queries', tone: 'lens-violet', fill: 0.13 },
    { id: 'light', label: 'Light', hint: 'Under 10 ms and under 5 queries: not painted', tone: 'lens-violet', fill: 0 },
  ],
  editable: [
    { id: 'content', label: 'Content', hint: 'Fields, titles, menu links: saved by the site, as you', tone: 'lens-teal', fill: 0.14 },
    { id: 'settings', label: 'Settings', hint: 'Block, component and site settings', tone: 'lens-cobalt', fill: 0.12 },
    { id: 'template', label: 'Template', hint: 'An override of its template, made in your theme', tone: 'lens-violet', fill: 0.12 },
    { id: 'refused', label: 'Not here', hint: 'The helper says why it cannot be edited here', tone: 'lens-slate', fill: 0, dashed: true },
  ],
  changed: [
    { id: 'edited', label: 'An agent’s edit', hint: 'Made by a file the last edit changed', tone: 'water', fill: 0.12 },
    { id: 'saved', label: 'Saved by hand', hint: 'Shows something you saved here', tone: 'lens-teal', fill: 0.14 },
  ],
};

/** The lenses that need the helper's trace to say anything. Owner reads template paths too, and Changed the agents' edits. */
export const NEEDS_TRACE: ReadonlySet<LensId> = new Set(['cache', 'cost', 'editable']);

const CONTENT_EDITS: ReadonlySet<EditKind> = new Set(['field', 'property', 'meta', 'menu-link']);

export interface LensInput {
  regions: readonly LiveRegion[];
  trace: LiveTrace | null;
  /** Regions the last agent edit made, by index. */
  changed?: ReadonlySet<number>;
  /**
   * What was saved by hand since the page was opened: edit targets by id and
   * by label (ids are stable only within a trace), and parts moved or inserted,
   * by label.
   */
  saved?: { ids: ReadonlySet<string>; labels: ReadonlySet<string>; parts?: ReadonlySet<string> };
}

export interface LensView {
  lens: LensId;
  classes: (LensClass & { count: number; indexes: number[] })[];
  /** What to draw on the page: each region's class, and a label where the number is the point. */
  paint: { index: number; cls: string; label: string | null }[];
  /** Parts on the page this lens can say nothing about. */
  unknown: number;
  /** The lens reads the trace, and there is none. */
  needsTrace: boolean;
}

const fmtMs = (ms: number): string => (ms >= 100 ? `${Math.round(ms)} ms` : `${Math.round(ms * 10) / 10} ms`);

/** Which class of a lens one region is, and its label; null when the lens cannot say. */
function classify(lens: Exclude<LensId, 'structure'>, r: LiveRegion, part: TracePart | undefined, input: LensInput, edits: Map<string, EditTarget>): { cls: string; label: string | null } | null {
  switch (lens) {
    case 'owner': {
      const owner = part?.source?.owner ?? originOf(r.file);
      if (owner === 'yours' || owner === 'core' || owner === 'theme') return { cls: owner, label: null };
      if (owner === 'contrib' || owner === 'plugin') return { cls: 'contrib', label: null };
      return null;
    }
    case 'cache': {
      const c = part?.cache;
      if (!c) return null;
      if (c.status === 'placeholder') return { cls: 'placeholder', label: null };
      if (c.status === 'uncacheable' || c.maxAge === 0) return { cls: 'uncacheable', label: null };
      if (c.maxAge === 'permanent') return { cls: 'permanent', label: null };
      return { cls: 'max-age', label: null };
    }
    case 'cost': {
      const c = part?.cost;
      if (!c) return null;
      const q = c.queries ?? 0;
      const label = `${fmtMs(c.ms)}${q ? ` · ${q} ${q === 1 ? 'query' : 'queries'}` : ''}`;
      if (c.ms >= 50 || q >= 20) return { cls: 'heavy', label };
      if (c.ms >= 10 || q >= 5) return { cls: 'notable', label };
      return { cls: 'light', label: null };
    }
    case 'editable': {
      const targets = (part?.edits ?? []).map((id) => edits.get(id)).filter((e): e is EditTarget => !!e);
      if (!targets.length) return null;
      const open = targets.filter((e) => !e.why);
      if (!open.length) return { cls: 'refused', label: null };
      if (open.some((e) => CONTENT_EDITS.has(e.kind))) return { cls: 'content', label: null };
      if (open.some((e) => e.kind !== 'template-override')) return { cls: 'settings', label: null };
      return { cls: 'template', label: null };
    }
    case 'changed': {
      if (input.changed?.has(r.index)) return { cls: 'edited', label: null };
      const saved = input.saved;
      const targets = (part?.edits ?? []).map((id) => edits.get(id)).filter((e): e is EditTarget => !!e);
      if (saved && (targets.some((e) => saved.ids.has(e.id) || saved.labels.has(e.label)) || (part && saved.parts?.has(part.label)))) return { cls: 'saved', label: null };
      return null;
    }
  }
}

/**
 * A lens over the page: each part's class, how many of each, and what to
 * paint. The page's own wrappers and small pieces (icons, form fields) are
 * left unpainted, as the layers leave them folded.
 */
export function lensView(lens: LensId, input: LensInput): LensView {
  if (lens === 'structure') return { lens, classes: [], paint: [], unknown: 0, needsTrace: false };
  const index = partIndex(input.regions, input.trace);
  const classes = CLASSES[lens].map((c) => ({ ...c, count: 0, indexes: [] as number[] }));
  const byId = new Map(classes.map((c) => [c.id, c]));
  const paint: LensView['paint'] = [];
  let unknown = 0;
  for (const r of input.regions) {
    if (r.rect.width * r.rect.height < 4) continue;
    const part = index.byRegion.get(r.index);
    const name = nameOf(r, null, part ? { label: part.label, kind: part.kind } : null);
    if (name.wrapper || name.small) continue;
    const got = classify(lens, r, part, input, index.edits);
    const cls = got ? byId.get(got.cls) : undefined;
    if (!got || !cls) { unknown++; continue; }
    cls.count++;
    cls.indexes.push(r.index);
    if (cls.fill > 0 || cls.dashed) paint.push({ index: r.index, cls: cls.id, label: got.label });
  }
  return { lens, classes, paint, unknown, needsTrace: NEEDS_TRACE.has(lens) && !input.trace };
}

/* ── painting, as the main process accepts it ──────────────────────────── */

export interface LivePaint {
  index: number;
  /** A colour as `#rrggbb`: the renderer reads it from its own tokens. */
  color: string;
  /** 0 to 0.4. */
  fill: number;
  label: string | null;
  dashed: boolean;
}

export const MAX_PAINT = 2_000;

/** What the window asked to paint, checked: anything malformed is left out. */
export function paintItems(raw: unknown): LivePaint[] {
  if (!Array.isArray(raw)) return [];
  const out: LivePaint[] = [];
  for (const v of raw.slice(0, MAX_PAINT)) {
    if (!v || typeof v !== 'object') continue;
    const p = v as Record<string, unknown>;
    if (!Number.isInteger(p.index) || (p.index as number) < 0 || typeof p.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(p.color)) continue;
    const fill = typeof p.fill === 'number' && Number.isFinite(p.fill) ? Math.min(0.4, Math.max(0, p.fill)) : 0;
    out.push({ index: p.index as number, color: p.color, fill, label: typeof p.label === 'string' ? p.label.slice(0, 120) : null, dashed: p.dashed === true });
  }
  return out;
}

/* ── the edit sheet beside a part ──────────────────────────────────────── */

export interface Box { x: number; y: number; width: number; height: number }

/** A rectangle the window sent, checked: whole, non-negative pixels, bounded; null when it is not one. */
export function boxOf(raw: unknown, max = 10_000): Box | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.round(v))) : null);
  const x = n(b.x), y = n(b.y), width = n(b.width), height = n(b.height);
  return x === null || y === null || width === null || height === null ? null : { x, y, width, height };
}

/**
 * Where an edit sheet of `size` goes in `area` (both in the same pixels):
 * beside the part, right then left, else below then above, else in the
 * area's top right corner; always inside the area, a margin from its edges.
 */
export function placeSheet(anchor: Box | null, area: Box, size: { width: number; height: number }, margin = 12): Box {
  const width = Math.max(0, Math.min(size.width, area.width - 2 * margin));
  const height = Math.max(0, Math.min(size.height, area.height - 2 * margin));
  const clampX = (x: number): number => Math.min(Math.max(x, area.x + margin), area.x + area.width - margin - width);
  const clampY = (y: number): number => Math.min(Math.max(y, area.y + margin), area.y + area.height - margin - height);
  const corner = { x: area.x + area.width - margin - width, y: area.y + margin, width, height };
  if (!anchor) return corner;
  const right = anchor.x + anchor.width + margin;
  const left = anchor.x - margin - width;
  if (right + width <= area.x + area.width - margin) return { x: right, y: clampY(anchor.y), width, height };
  if (left >= area.x + margin) return { x: left, y: clampY(anchor.y), width, height };
  const below = anchor.y + anchor.height + margin;
  const above = anchor.y - margin - height;
  if (below + height <= area.y + area.height - margin) return { x: clampX(anchor.x), y: below, width, height };
  if (above >= area.y + margin) return { x: clampX(anchor.x), y: above, width, height };
  return corner;
}
