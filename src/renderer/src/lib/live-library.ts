// The component library in the window: what the site helper's library answer
// says, read for the live view's Library panel (components/live/Library.tsx).
// Pure, so node's test runner reads it as the window does.
//
// - Why there is no library, in the same words as the main process
//   (src/main/live-library.ts libraryWhy: the test keeps them equal), and the
//   one thing to do next.
// - An entry's props as rows, from the JSON Schema the helper gave.
// - Whether it can be added to the page shown, through the trace's palette
//   (shared/live-library.ts paletteEntryFor), or why not.
// - Where the page shown uses it, as the trace names its parts: this page
//   only, because nothing Wanigan reads says which other pages do.
import type { LiveRegion } from '../../../shared/live.ts';
import type { PartIndex } from '../../../shared/live-lens.ts';
import {
  LIBRARY_KINDS, entryMatches, paletteEntryFor,
  type ComponentLibrary, type LibraryEntry, type LibraryKind, type LiveLibraryAnswer,
} from '../../../shared/live-library.ts';
import type { LiveTrace, PaletteEntry, TraceCollection, TraceOwner } from '../../../shared/live-trace.ts';

export type LibraryProblem = Exclude<LiveLibraryAnswer, { state: 'ok' }>;

/** Why there is no library, in the owner's words: the main process's libraryWhy, word for word. */
export function libraryWhyText(answer: LibraryProblem): string {
  switch (answer.state) {
    case 'off': return 'The live view is off: switch it on in Settings › Live view.';
    case 'no-site': return 'This project has no local site set: choose it in the project’s Live tab.';
    case 'no-helper': return 'The site helper is not installed, and the library is read through it. Install it from the project’s Live tab.';
    case 'outdated': return 'The site helper is older than this Wanigan and has no component library. Update it from the project’s Live tab.';
    case 'refused': return `The site refused to list its components (it answered ${answer.status}).`;
    case 'down': return `The site did not answer: ${answer.error}.`;
    case 'too-large': return 'The site’s library is larger than Wanigan reads.';
    case 'unreadable': return 'The site helper’s library could not be read.';
  }
}

/** What the owner can do about it, here: update or install the helper, ask again, or switch the view on. */
export function libraryNext(answer: LibraryProblem): 'update-helper' | 'install-helper' | 'retry' | 'settings' | 'site' {
  switch (answer.state) {
    case 'outdated': return 'update-helper';
    case 'no-helper': return 'install-helper';
    case 'off': return 'settings';
    case 'no-site': return 'site';
    default: return 'retry';
  }
}

export const KIND_TITLE: Record<LibraryKind, { one: string; many: string }> = {
  component: { one: 'Component', many: 'Components' },
  block: { one: 'Block', many: 'Blocks' },
  pattern: { one: 'Pattern', many: 'Patterns' },
  style: { one: 'Block style', many: 'Block styles' },
};

/** Whose code an entry is, in a few words; null when the helper could not tell. */
export function ownerWords(owner: TraceOwner | undefined, platform: 'drupal' | 'wordpress'): string | null {
  switch (owner) {
    case 'yours': return 'your code';
    case 'contrib': return 'contributed';
    case 'core': return platform === 'drupal' ? 'Drupal core' : 'WordPress core';
    case 'plugin': return 'a plugin';
    case 'theme': return 'a theme';
    default: return null;
  }
}

/** The entries of each kind the site has, those matching every word of the query, in the order core listed them. */
export function libraryGroups(lib: ComponentLibrary, query: string): { kind: LibraryKind; title: string; total: number; entries: LibraryEntry[] }[] {
  const q = query.trim();
  return LIBRARY_KINDS.map((kind) => {
    const all = lib.entries.filter((e) => e.kind === kind);
    return { kind, title: KIND_TITLE[kind].many, total: lib.counts[kind] ?? all.length, entries: q ? all.filter((e) => entryMatches(e, q)) : all };
  }).filter((g) => g.entries.length > 0 || (!q && g.total > 0));
}

/* ── props ─────────────────────────────────────────────────────────────── */

export interface PropRow {
  name: string;
  /** "string", "boolean", "array of string", "image": what JSON Schema says it takes. */
  type: string;
  required: boolean;
  title: string | null;
  description: string | null;
  /** Its default, as written: words quoted, anything else as JSON. */
  default: string | null;
  /** The values it may take, when the schema lists them. */
  choices: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

function shown(v: unknown, max = 60): string {
  const s = typeof v === 'string' ? `“${v}”` : JSON.stringify(v) ?? String(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The values a prop's schema lists: `enum`, or the `const` of each `oneOf`/`anyOf`. */
function choicesOf(p: Record<string, unknown>): string[] {
  if (Array.isArray(p.enum)) return p.enum.slice(0, 12).map((v) => shown(v, 40));
  const alts = Array.isArray(p.oneOf) ? p.oneOf : Array.isArray(p.anyOf) ? p.anyOf : [];
  return alts.filter(isObj).filter((a) => 'const' in a).slice(0, 12).map((a) => (text(a.title, 40) ? `${text(a.title, 40)} (${shown(a.const, 30)})` : shown(a.const, 40)));
}

function typeOf(p: Record<string, unknown>, depth = 0): string {
  if (typeof p.$ref === 'string') return (p.$ref.split(/[/#:]/).filter(Boolean).pop() ?? 'reference').replace(/\.json$/, '');
  const t = typeof p.type === 'string' ? p.type : Array.isArray(p.type) ? p.type.filter((x) => typeof x === 'string').join(' or ') : null;
  if (t === 'array' && isObj(p.items) && depth < 2) return `array of ${typeOf(p.items, depth + 1)}`;
  if (t) return t;
  if (Array.isArray(p.enum) || Array.isArray(p.oneOf) || Array.isArray(p.anyOf)) return 'one of';
  return 'any';
}

/** An entry's props (a component's) or attributes (a block type's), from its JSON Schema, in the schema's order. */
export function propRows(entry: LibraryEntry): PropRow[] {
  const schema = entry.props;
  if (!schema || !isObj(schema.properties)) return [];
  const required = new Set([...(entry.required ?? []), ...(Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : [])]);
  return Object.entries(schema.properties).slice(0, 100).map(([name, raw]) => {
    const p = isObj(raw) ? raw : {};
    return {
      name, type: typeOf(p), required: required.has(name), title: text(p.title, 120), description: text(p.description, 300),
      default: 'default' in p ? shown(p.default) : null, choices: choicesOf(p),
    };
  });
}

/* ── adding it to the page ─────────────────────────────────────────────── */

export type Placement =
  /** The trace's palette entry that places it, and the places on this page that take it. */
  | { ok: true; palette: PaletteEntry; into: TraceCollection[] }
  | { ok: false; why: string };

/** Whether an entry can be added to the page shown, through the trace's palette, or why not. */
export function placement(entry: LibraryEntry, platform: 'drupal' | 'wordpress', trace: LiveTrace | null, readOnly: boolean): Placement {
  if (readOnly) return { ok: false, why: 'A hosted environment is read-only here: show Local to add it.' };
  const pal = paletteEntryFor(entry, platform);
  if ('why' in pal) return { ok: false, why: pal.why };
  if (!trace) return { ok: false, why: 'There is no trace for this page yet, so nothing says where it could go. Reload it, then try again.' };
  const palette = trace.palette?.find((p) => p.id === pal.id);
  const into = (trace.collections ?? []).filter((c) => !c.why && c.inserts?.includes(pal.id));
  if (!palette || !into.length) return { ok: false, why: 'Nothing on this page takes it: no place here can have it added.' };
  return { ok: true, palette, into };
}

/* ── where the page uses it ────────────────────────────────────────────── */

export interface PageUse {
  /** The trace's part, when the trace has one for it; null for a part only the page's own marks name. */
  part: string | null;
  label: string;
  /** The regions of the page it shows as. */
  regions: number[];
}

export type PageUses = { known: true; uses: PageUse[] } | { known: false; why: string };

/**
 * Where the page shown uses an entry: the trace's parts that are it (by their identity, helper 4), and, for a
 * Drupal component or block, the parts the page itself marks with it. Named as the trace names them.
 */
export function usesOnPage(entry: LibraryEntry, platform: 'drupal' | 'wordpress', trace: LiveTrace | null, regions: readonly LiveRegion[], parts: PartIndex): PageUses {
  if (entry.kind === 'pattern') return { known: false, why: 'A pattern is copied in as ordinary blocks when it is placed, so the page does not say where one was used.' };
  if (entry.kind === 'style') return { known: false, why: 'A block style shows as a class on a block, and the trace does not say which blocks have it.' };
  const sdc = platform === 'drupal' && entry.kind === 'component' && entry.id.startsWith('sdc:') ? entry.id.slice(4) : null;
  const plugin = platform === 'drupal' && entry.kind === 'block' && entry.id.startsWith('block:') ? entry.id.slice(6) : null;
  const blockName = platform === 'wordpress' && entry.kind === 'block' && entry.id.startsWith('block:') ? entry.id.slice(6) : null;
  if (!sdc && !plugin && !blockName) return { known: false, why: 'The trace names nothing on a page this way.' };
  const out = new Map<string, PageUse>();
  for (const p of trace?.parts ?? []) {
    const i = p.identity;
    const is = !!i && (
      (sdc !== null && i.kind === 'component' && i.name === sdc)
      || (plugin !== null && i.kind === 'config' && i.type === 'block' && i.plugin === plugin)
      || (blockName !== null && (i.kind === 'block' || i.kind === 'component') && i.name === blockName));
    if (is) out.set(`part:${p.id}`, { part: p.id, label: p.label, regions: parts.regionsOf.get(p.id) ?? [] });
  }
  // The page's own marks: a component's id, and a block's plugin (data-wl-block "plugin@id"), each once.
  for (const r of regions) {
    const marked = (sdc !== null && r.component === sdc) || (plugin !== null && r.block?.split('@')[0] === plugin);
    if (!marked) continue;
    const part = parts.byRegion.get(r.index);
    const key = part ? `part:${part.id}` : `region:${r.index}`;
    const known = out.get(key);
    if (known) { if (!known.regions.includes(r.index)) known.regions.push(r.index); continue; }
    out.set(key, { part: part?.id ?? null, label: part?.label ?? sdc ?? plugin ?? entry.label, regions: [r.index] });
  }
  if (!trace && !out.size) return { known: false, why: 'There is no trace for this page yet, so nothing says what on it this is.' };
  return { known: true, uses: [...out.values()] };
}
