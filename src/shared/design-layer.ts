// The design layer (docs/design/2026-10-09-design-layer.md): edits the owner
// makes on the live page, kept on Wanigan's side until they are implemented in
// the site and verified. This module is the layer's data and its preview
// stylesheet: what an edit is, which values may enter it (edits can come from
// an agent through MCP, so everything here is checked), and the CSS the live
// view injects so each edit shows at once.
//
// The preview stylesheet is never shipped. It targets only elements the page
// script tagged with the edit's id (`data-wl-edit`), and it always wins
// (`!important`, a doubled attribute selector), so the page shows the design
// whatever the theme's own rules say. Whether the native implementation wins
// the cascade is what the verify step proves.

/** Style properties an edit may set. Each is something the owner can see and a theme can implement natively. */
export const LAYER_PROPERTIES = [
  'color', 'background-color',
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-transform', 'text-decoration-line', 'text-align',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'gap', 'row-gap', 'column-gap',
  'border-radius', 'border-width', 'border-style', 'border-color', 'box-shadow',
  'width', 'max-width', 'min-height', 'height',
  'opacity', 'display', 'justify-content', 'align-items',
] as const;
export type LayerProperty = (typeof LAYER_PROPERTIES)[number];

/** Who an edit is for: what the trace says the part is. Never a DOM path alone (`selector` is the marked fallback). */
export type LayerTarget =
  | { kind: 'entity'; entityType: string; uuid: string; field: string | null; delta: number | null; langcode: string | null }
  | { kind: 'block'; post: string; path: number[]; name: string }
  | { kind: 'component'; name: string; path: number[] }
  | { kind: 'config'; type: string; id: string }
  | { kind: 'selector'; selector: string; textHash: string };

/** `this`: one element. `kind`: every instance of its component, block type or field. `site`: a token. */
export type LayerScope = 'this' | 'kind' | 'site';

export type LayerChange =
  | { type: 'style'; values: Partial<Record<LayerProperty, string>> }
  | { type: 'token'; name: string; value: string }
  | { type: 'text'; value: string }
  | { type: 'image'; asset: string; alt: string | null }
  /** A component, block or pattern from the site's palette, at a place in a collection, with the props chosen for it. */
  | { type: 'insert'; entry: string; collection: string; index: number; props: Record<string, string | number | boolean> }
  /** The placed item the target names, taken out of its collection (never deleted). */
  | { type: 'remove'; collection: string };

export type LayerState = 'draft' | 'implemented' | 'verified' | 'retired' | 'orphaned';

export interface LayerEdit {
  id: string;
  target: LayerTarget;
  scope: LayerScope;
  /** `all`, or the id of one of the theme's breakpoints. */
  breakpoint: string;
  change: LayerChange;
  /** What it was, for undo and for the verify step: computed values, or the old text or asset. */
  before: Record<string, string>;
  state: LayerState;
  by: 'owner' | 'agent';
  at: number;
}

/** A breakpoint as the theme defines it (Drupal's breakpoints.yml, WordPress's widths), as a media query. */
export interface LayerBreakpoint { id: string; label: string; media: string }

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOKEN = /^--[a-z0-9][a-z0-9-]{0,99}$/i;
/** A media query the layer will print: `all` or `screen`, width features, numbers, units and `and` only (Drupal's breakpoints.yml writes `all and (min-width: …)`). */
const MEDIA = /^(?:(?:only )?(?:screen|all) and )?\((?:min|max)-width: ?\d{1,5}(?:\.\d+)?(?:px|em|rem)\)(?: and \((?:min|max)-width: ?\d{1,5}(?:\.\d+)?(?:px|em|rem)\))?$/;

/**
 * A style value the layer will print, or null. Values are words, numbers with
 * units, colours, `var(--token)`, `calc()`, quoted font names and commas: no
 * `url()` or `image-set()` (the layer loads nothing), no `expression`, no
 * at-rules, no braces, semicolons, backslashes, comments or angle brackets.
 */
export function layerValue(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().replace(/\s*!important\s*$/i, '');
  if (!v || v.length > 300) return null;
  if (/[;{}<>\\@]|\/\*|\*\//.test(v)) return null;
  if (/\b(?:url|image-set|expression|element|attr|env)\s*\(/i.test(v)) return null;
  if (!/^[a-zA-Z0-9#%.,()\-+/*_ '"]+$/.test(v)) return null;
  // Quotes must pair, so a value cannot close a string the rule opened.
  if ((v.match(/"/g)?.length ?? 0) % 2 || (v.match(/'/g)?.length ?? 0) % 2) return null;
  return v;
}

/** An edit from outside (an agent, a file), checked field by field; null with the reason when it is not one. */
export function layerEdit(raw: unknown): { edit: LayerEdit; refused: null } | { edit: null; refused: string } {
  const no = (refused: string) => ({ edit: null, refused } as const);
  if (!raw || typeof raw !== 'object') return no('An edit is an object.');
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !ID.test(r.id)) return no('An edit needs an id of lower-case letters, digits and dashes.');
  const target = layerTarget(r.target);
  if (!target) return no('An edit needs a target the trace names.');
  if (r.scope !== 'this' && r.scope !== 'kind' && r.scope !== 'site') return no('An edit’s scope is this, kind or site.');
  if (typeof r.breakpoint !== 'string' || (r.breakpoint !== 'all' && !ID.test(r.breakpoint))) return no('An edit’s breakpoint is all, or a breakpoint’s id.');
  const change = layerChange(r.change);
  if (typeof change === 'string') return no(change);
  if ((change.type === 'token') !== (r.scope === 'site')) return no('A token is changed for the whole site, and only a token is.');
  const before: Record<string, string> = {};
  if (r.before && typeof r.before === 'object') {
    for (const [k, v] of Object.entries(r.before as Record<string, unknown>).slice(0, 60)) if (typeof v === 'string' && k.length <= 100) before[k] = v.slice(0, 2000);
  }
  const states: readonly LayerState[] = ['draft', 'implemented', 'verified', 'retired', 'orphaned'];
  const state = states.includes(r.state as LayerState) ? r.state as LayerState : 'draft';
  return {
    edit: { id: r.id, target, scope: r.scope, breakpoint: r.breakpoint, change, before, state, by: r.by === 'agent' ? 'agent' : 'owner', at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0 },
    refused: null,
  };
}

function layerTarget(raw: unknown): LayerTarget | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const name = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v) ? v : null);
  const path = (v: unknown): number[] | null => (Array.isArray(v) && v.length <= 64 && v.every((n) => Number.isInteger(n) && n >= 0 && n < 10_000) ? v as number[] : null);
  switch (t.kind) {
    case 'entity': {
      const entityType = name(t.entityType, 64), uuid = name(t.uuid, 64);
      if (!entityType || !uuid) return null;
      const delta = Number.isInteger(t.delta) && (t.delta as number) >= 0 ? t.delta as number : null;
      return { kind: 'entity', entityType, uuid, field: name(t.field, 64), delta, langcode: name(t.langcode, 16) };
    }
    case 'block': {
      const post = name(t.post, 32), p = path(t.path), n = name(t.name, 100);
      return post && p && n ? { kind: 'block', post, path: p, name: n } : null;
    }
    case 'component': {
      const n = name(t.name, 200), p = path(t.path);
      return n && p ? { kind: 'component', name: n, path: p } : null;
    }
    case 'config': {
      const type = name(t.type, 64), id = name(t.id, 200);
      return type && id ? { kind: 'config', type, id } : null;
    }
    case 'selector': {
      const selector = name(t.selector, 500), textHash = name(t.textHash, 64);
      return selector && textHash ? { kind: 'selector', selector, textHash } : null;
    }
    default: return null;
  }
}

function layerChange(raw: unknown): LayerChange | string {
  if (!raw || typeof raw !== 'object') return 'An edit needs a change.';
  const c = raw as Record<string, unknown>;
  switch (c.type) {
    case 'style': {
      if (!c.values || typeof c.values !== 'object') return 'A style change needs values.';
      const values: Partial<Record<LayerProperty, string>> = {};
      for (const [k, v] of Object.entries(c.values as Record<string, unknown>)) {
        if (!(LAYER_PROPERTIES as readonly string[]).includes(k)) return `The layer does not set ${k.slice(0, 60)}.`;
        const value = layerValue(v);
        if (value === null) return `That is not a value the layer will set for ${k}.`;
        values[k as LayerProperty] = value;
      }
      return Object.keys(values).length ? { type: 'style', values } : 'A style change needs at least one value.';
    }
    case 'token': {
      if (typeof c.name !== 'string' || !TOKEN.test(c.name)) return 'A token is a custom property: --name.';
      const value = layerValue(c.value);
      return value === null ? 'That is not a value the layer will set for a token.' : { type: 'token', name: c.name, value };
    }
    case 'text': return typeof c.value === 'string' && c.value.length <= 100_000 ? { type: 'text', value: c.value } : 'A text change needs its new text.';
    case 'image': {
      if (typeof c.asset !== 'string' || !/^[a-f0-9]{16,64}\.(?:jpe?g|png|webp|gif|avif|svg)$/.test(c.asset)) return 'An image change needs an asset Wanigan keeps.';
      return { type: 'image', asset: c.asset, alt: typeof c.alt === 'string' ? c.alt.slice(0, 1000) : null };
    }
    case 'insert': {
      const ref = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\u0000-\u001f]/.test(v) ? v : null);
      const entry = ref(c.entry), collection = ref(c.collection);
      if (!entry || !collection) return 'An insert needs the palette entry and the collection it goes into.';
      if (!Number.isInteger(c.index) || (c.index as number) < 0 || (c.index as number) > 10_000) return 'An insert needs the place in its collection.';
      const props: Record<string, string | number | boolean> = {};
      if (c.props && typeof c.props === 'object') {
        for (const [k, v] of Object.entries(c.props as Record<string, unknown>).slice(0, 100)) {
          if (!/^[a-z_][a-z0-9_]{0,63}$/i.test(k)) return `${k.slice(0, 60)} is not a prop name.`;
          if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) props[k] = v;
          else if (typeof v === 'string' && v.length <= 10_000) props[k] = v;
          else return `The prop ${k} is not a string, number or yes/no.`;
        }
      }
      return { type: 'insert', entry, collection, index: c.index as number, props };
    }
    case 'remove': {
      const collection = typeof c.collection === 'string' && c.collection.length > 0 && c.collection.length <= 200 ? c.collection : null;
      return collection ? { type: 'remove', collection } : 'A removal needs the collection the item is taken out of.';
    }
    default: return 'A change is style, token, text, image, insert or remove.';
  }
}

/** The breakpoints a theme declares, checked; `all` is implied and never listed. */
export function layerBreakpoints(raw: readonly { id: unknown; label: unknown; media: unknown }[]): LayerBreakpoint[] {
  const out: LayerBreakpoint[] = [];
  for (const b of raw.slice(0, 20)) {
    if (typeof b.id !== 'string' || !ID.test(b.id) || b.id === 'all' || typeof b.media !== 'string') continue;
    const media = b.media.trim().replace(/\s+/g, ' ');
    if (!MEDIA.test(media)) continue;
    out.push({ id: b.id, label: typeof b.label === 'string' ? b.label.slice(0, 60) : b.id, media });
  }
  return out;
}

/** The selector for an edit's elements: tagged by the page script, doubled so the preview wins the cascade. */
export const layerSelector = (id: string): string => `[data-wl-edit~="${id}"][data-wl-edit~="${id}"]`;

/**
 * The preview stylesheet for the edits in effect (drafts and implemented ones
 * not yet verified), in the order they were made, so a later edit to the same
 * property wins. Tokens go on `:root`. Edits for a breakpoint the theme does
 * not declare are left out rather than guessed.
 */
export function compileLayer(edits: readonly LayerEdit[], breakpoints: readonly LayerBreakpoint[]): string {
  const media = new Map(breakpoints.map((b) => [b.id, b.media]));
  const blocks = new Map<string, string[]>();
  const add = (bp: string, rule: string): void => {
    const list = blocks.get(bp) ?? [];
    list.push(rule);
    blocks.set(bp, list);
  };
  for (const e of edits) {
    if (e.state !== 'draft' && e.state !== 'implemented') continue;
    if (e.breakpoint !== 'all' && !media.has(e.breakpoint)) continue;
    if (e.change.type === 'token') {
      const value = layerValue(e.change.value);
      if (value !== null && TOKEN.test(e.change.name)) add(e.breakpoint, `:root { ${e.change.name}: ${value} !important; }`);
      continue;
    }
    if (e.change.type !== 'style' || !ID.test(e.id)) continue;
    const decls = Object.entries(e.change.values)
      .filter(([k, v]) => (LAYER_PROPERTIES as readonly string[]).includes(k) && layerValue(v) !== null)
      .map(([k, v]) => `${k}: ${layerValue(v)} !important;`);
    if (decls.length) add(e.breakpoint, `${layerSelector(e.id)} { ${decls.join(' ')} }`);
  }
  const out: string[] = [];
  const all = blocks.get('all');
  if (all) out.push(...all);
  // Breakpoints in the theme's own order, after the rules for every width.
  for (const b of breakpoints) {
    const rules = blocks.get(b.id);
    if (rules) out.push(`@media ${b.media} {\n${rules.map((r) => `  ${r}`).join('\n')}\n}`);
  }
  return out.join('\n');
}
