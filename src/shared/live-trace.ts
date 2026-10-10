// What a site helper reports about one render of a page: which code made each
// part, the hooks that shaped it, its cache metadata and cost, the data behind
// it, and what can be edited there. The Drupal module and the WordPress plugin
// produce it for requests carrying the live token; the live view's lenses and
// Inspector read it, and agents will through Wanigan's MCP server.
//
// The contract between a helper and Wanigan, over plain HTTP on the site's own
// origin, every request carrying the X-Wanigan-Live token:
//
// - A page rendered for a token request answers with `X-Wanigan-Trace: <id>`
//   (16 lowercase hex characters) and wraps each traced part of its output in
//   `<!-- wl:part id="<part id>" -->` … `<!-- /wl:part id="<part id>" -->`.
//   Comments, not attributes, so a part with several root elements, or none,
//   is still found. Part ids are unique within the trace.
// - `GET /_wanigan/trace/<id>` answers that render's LiveTrace as JSON. A
//   helper keeps the last 20 traces per user for 10 minutes, then forgets.
// - `GET /_wanigan/edit/<target id>?trace=<id>` answers a page holding the
//   platform's own form for one EditTarget (`via: 'native-form'`), saved by
//   the platform as the logged-in user, with its validation and revisions.
//   When it saves, it redirects to `/_wanigan/edit/done?target=<target id>`.
// - `POST /_wanigan/edit/<target id>` with JSON `{ "trace": "<id>", "value": … }`
//   saves a `via: 'schema'` target after the helper validates the value
//   against the schema it gave; it answers `{ "ok": true, "revision"?: "…" }`
//   or `{ "ok": false, "error": "…" }`, and checks the user may edit it.
// - `POST /_wanigan/move` with JSON `{ "trace", "collection", "item", "to":
//   { "collection", "index" } }` moves one item of a TraceCollection (to
//   another index, or into a collection listed in its `movesTo`) through the
//   platform's own API, as the logged-in user. `POST /_wanigan/insert` with
//   `{ "trace", "collection", "index", "entry" }` inserts a palette entry. Both
//   refuse with HTTP 409 and `{ "ok": false, "error", "items" }` (the current
//   order) when the collection changed since the trace, and otherwise answer
//   `{ "ok": true, "undo": "<token>", "revision"?: "…" }`. `POST /_wanigan/undo`
//   with `{ "undo": "<token>" }` puts it back, only while nothing else has
//   changed it since; a helper keeps undo tokens for 10 minutes.
//
// Everything past a part's id, kind and label is optional: a helper reports
// what its platform knows, and nothing it would have to guess. Values shown to
// the owner (`preview`) are bounded and have secrets redacted by the helper.
//
// Helper version 3 adds what a save runs besides the platform's core
// (`saves`, named by an edit target's or a collection's `saves`), what core
// knows of the site's AI (`ai`, WordPress only), and two routes:
//
// - `GET /_wanigan/ai` answers the site's AI as its core reports it
//   (src/shared/live-ai.ts SiteAi): never a key, only where a key comes from.
// - A save, move, insert or undo answers with `"ai"` (live-ai.ts SaveAi) on
//   WordPress: the prompts core's AI Client sent and the abilities that ran
//   during it, as provider and model ids and ability names; no prompt text,
//   no response text. A body with `"noSiteAi": true` asks the helper to stop
//   core's AI Client for that one save (`wp_ai_client_prevent_prompt`).
//
// Helper version 4 adds taking a placed item out, and the component library:
//
// - `POST /_wanigan/remove` with `{ "trace", "collection", "item" }` takes one
//   item out of a collection whose `removes` is true: the reverse of insert,
//   through the same core save paths and with the same answers (409 with the
//   order now, an undo token, a revision). Only the placement or reference
//   goes, never the content, block content, media or attachment it showed: a
//   field item's reference, a Layout Builder component, a block in post,
//   template or template part markup. A Drupal block placement and menu link
//   are switched off (their own forms' Enabled), so they are kept; a WordPress
//   widget goes to Inactive widgets with its settings; a WordPress menu item
//   is deleted (its page is not), and undo makes it again. A collection that
//   is configuration says where it shows (`reach` in pages when it can count
//   them, otherwise `shows`), so the window asks first. Undo puts it back.
//   An edit target that changes more than this page (a template or template
//   part, a synced pattern's own words, a navigation menu, a widget, a site
//   setting, a media library alt) says where in its own `shows`, so the window
//   says it and asks before saving it (editNotice()).
// - `GET /_wanigan/components` answers the ComponentLibrary of
//   src/shared/live-library.ts: what can be placed, from core's registries
//   only, bounded, keyed by a hash of the definitions and their files' mtimes.
// - `/_wanigan/piece/...` renders one library entry alone, at the path the
//   library names for it, with example props; the rendered piece says it is
//   `data-wanigan-piece="ready"` (or `"failed"`, with why) once it is drawn.
// - Words a template writes, on the template's part, offered with why they are
//   not saved here (`template-override`, read-only strings, a `why`; never
//   saved): `words.tpl.<hash>` for the runs of words typed into it,
//   `words.t.<hash>` for the strings it prints through a translation function
//   (Drupal's t(); WordPress's gettext functions, one target per text
//   domain). WordPress's say the line of each in its property's
//   `description`, and its template parts say whether their file was read
//   (a `template.words` variable: `read …`, or `not read: <why>`).
// - A WordPress term's name where a page shows it (a menu item built from a
//   term, an archive's heading, a list of categories): `term-<id>`, a string
//   saved through wp_update_term(), its `shows` saying where else it shows.

export const TRACE_VERSION = 1;

/** Bounds a helper applies before answering, which parseTrace applies again. */
export const TRACE_LIMITS = { parts: 4000, edits: 4000, hooks: 5000, queries: 2000, assets: 500, logs: 500, chain: 200, variables: 200, preview: 400, collections: 1000, palette: 1000, saves: 200, runs: 100 } as const;

export type TraceOwner = 'yours' | 'contrib' | 'core' | 'plugin' | 'theme' | 'unknown';

export interface TraceSource {
  /** Relative to the project's root. */
  file: string;
  line?: number;
  owner: TraceOwner;
  /** The module, plugin, theme or package it belongs to. */
  package?: string;
}

/** One step that shaped a part: a preprocess function, a hook implementation, an alter, a filter callback. */
export interface TraceStep {
  /** As the platform names it: `preprocess_node`, `entity_view_alter`, `filter:the_content`, `action:wp_head`. */
  hook: string;
  /** The module, plugin or theme it belongs to. */
  by: string;
  /** Function or Class::method. */
  callback?: string;
  source?: TraceSource;
  ms?: number;
  /** WordPress's priority for a filter or action. */
  priority?: number;
  /** Variable names or keys it set or changed, when the helper can tell. */
  changed?: string[];
}

export interface TraceVariable {
  name: string;
  /** PHP type or class. */
  type: string;
  /** A bounded, redacted rendering of the value. */
  preview: string;
  /** The step that last set it, by `by` or `callback`. */
  setBy?: string;
  /** The EditTarget that changes it, when one does. */
  edit?: string;
}

export interface TraceCache {
  tags: string[];
  contexts: string[];
  maxAge: number | 'permanent';
  status?: 'hit' | 'miss' | 'uncacheable' | 'placeholder';
}

export interface TraceCost {
  ms: number;
  queries?: number;
  queryMs?: number;
}

export interface TraceRevision {
  id: string;
  at: number;
  by: string;
  message?: string;
}

export const EDIT_KINDS = ['field', 'property', 'block-attributes', 'config', 'option', 'meta', 'props', 'menu-link', 'template-override'] as const;
export type EditKind = (typeof EDIT_KINDS)[number];

/** Something the owner can change where it shows, and how. */
export interface EditTarget {
  /** Stable within the trace. */
  id: string;
  kind: EditKind;
  /** "Title (node 12)", "Hero props", "Site tagline". */
  label: string;
  /** The platform's own form, rendered and saved by the platform; or a schema Wanigan renders and the helper validates and saves. */
  via: 'native-form' | 'schema';
  /** JSON Schema, for 'schema' targets. */
  schema?: unknown;
  /** The current value, for 'schema' targets. */
  value?: unknown;
  /** Saving makes a revision. */
  revisions?: boolean;
  /** Why it cannot be edited here, when it cannot. */
  why?: string;
  /** The TraceSave its save runs: what else runs when it is saved. */
  saves?: string;
  /**
   * Helper 4: where a save shows when that is more than this page, in the helper's words: "every page that uses the
   * template “Single”", "everywhere the menu “Main” shows". The window says it and asks first (editNotice()).
   */
  shows?: string;
}

/** Where code that runs on a save lives, as the site reports it about itself. */
export const SAVE_RUNNER_KINDS = ['plugin', 'mu-plugin', 'theme', 'drop-in', 'module', 'profile', 'library', 'unknown'] as const;
export type SaveRunnerKind = (typeof SAVE_RUNNER_KINDS)[number];

/**
 * One plugin, theme or module outside the platform's core whose code runs
 * when something is saved, found through the platform's own hook registry
 * (never run to find out) and named by the file its callbacks are written in.
 */
export interface SaveRunner {
  /** Its machine name: a plugin's or theme's folder, a must-use plugin's file, a Drupal module. */
  by: string;
  /** Its human name, from its own plugin header, style.css or .info.yml. */
  name?: string;
  kind: SaveRunnerKind;
  owner: TraceOwner;
  /** The save-time hooks it is on, as the platform names them: save_post, rest_after_insert_page, node_presave. */
  hooks: string[];
  /** Its callbacks (function or Class::method), bounded. */
  callbacks?: string[];
}

/** What saving one kind of thing runs besides the platform's own core. */
export interface TraceSave {
  /** "post:page", "entity:node". */
  id: string;
  /** "Saving a Page", "Saving Content (node)". */
  label: string;
  runs: SaveRunner[];
  /** How many of core's own callbacks are on the same hooks. */
  core?: number;
}

/** What WordPress core knows of the site's AI, for the edit sheet. Never a key. */
export interface TraceAi {
  /** Core's AI Client is there (WordPress 7.0 and later): plugins can prompt models through it. */
  client: boolean;
  /** wp_supports_ai(), when core has it; null when it does not. */
  supports: boolean | null;
  /** AI providers whose connector has a key set up, by name, as core's Connectors report them. */
  connected: string[];
}

export const PART_KINDS = ['template', 'component', 'block', 'entity', 'field', 'view', 'region', 'form', 'shortcode', 'pattern', 'menu', 'widget'] as const;
export type PartKind = (typeof PART_KINDS)[number];

/**
 * Helper 4: what a part is, so it can be found again after a reload, a reorder
 * or an edit elsewhere on the page. A part id (`p237`) is a place in render
 * order and belongs to a position; this names the thing the platform stores.
 *
 * - `entity`: a stored item. Drupal: its entity type, UUID, bundle and
 *   language. WordPress: `post` or `term` and its ID, the post type or
 *   taxonomy as bundle. Narrowed to one `field` (Drupal field name; WordPress
 *   `post_title`, `post_content`, `post_excerpt` or a registered meta key) and
 *   to one `item` of it: a reference item by what it refers to
 *   (`ref:<entity type>:<uuid or ID>`), so a reorder does not move it; a value
 *   item by its delta (`delta:<n>`).
 * - `component`: a single-directory component (`acme:card`) or a block type
 *   (`core/paragraph`) rendered inside another identified part (`within`, that
 *   part's identityKey, or null at the page's top), and which of its kind it
 *   is there (`nth`, from 0, in document order).
 * - `config`: one configuration item, by `type` and `id`: a Drupal block
 *   placement (`block`, with its `plugin`), a Layout Builder component
 *   (`layout_builder_component`, `<entity type>:<entity UUID>/<component
 *   UUID>`, with its block `plugin`), a menu (`menu`, its machine name), a
 *   menu link (`menu_link`, its plugin id), a view display (`view`,
 *   `id:display`); a WordPress widget
 *   (`widget`), menu item (`menu_item`), template (`wp_template`) or template
 *   part (`wp_template_part`, its `theme//slug` id).
 * - `block`: a WordPress block in stored markup: where (`post:12`,
 *   `tpl:<id>`, `tp:<id>`), its path among the blocks there, and its name.
 * - `template`: a WordPress theme's PHP template file (header.php, a template
 *   part, the page template a classic theme's hierarchy chose), by the theme's
 *   folder name (its slug) and the file's path inside that theme, with which
 *   theme it is (`role`): the active theme, which has no parent (`theme`); the
 *   active theme, a child theme (`child`); or the parent of the active child
 *   (`parent`), whose files an update of that theme overwrites. The role says
 *   where a change belongs and is not part of the key: the same file is the
 *   same part whichever theme is active. A file outside the active theme and
 *   its parent (a plugin's, core's fallback) has no identity. Block themes'
 *   templates and template parts are `config`, as before.
 */
export type PartIdentity =
  | { kind: 'entity'; type: string; id: string; bundle?: string; langcode?: string; field?: string; item?: string }
  | { kind: 'component'; name: string; within: string | null; nth: number }
  | { kind: 'config'; type: string; id: string; plugin?: string }
  | { kind: 'block'; store: string; path: number[]; name: string }
  | { kind: 'template'; theme: string; path: string; role: TemplateRole };

/** Which theme a template file is in: the active theme with no parent, the active child theme, or its parent. */
export type TemplateRole = 'theme' | 'child' | 'parent';
const TEMPLATE_ROLES: readonly TemplateRole[] = ['theme', 'child', 'parent'];

/** A machine name, id, UUID or store as a helper reports it: plain, bounded, no spaces or control characters. */
const IDENT = /^[A-Za-z0-9_.:/@+-]{1,200}$/;

/** A part's identity as a helper gave it, checked; null when it is not one. */
export function parseIdentity(raw: unknown): PartIdentity | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const name = (x: unknown): string | null => (typeof x === 'string' && IDENT.test(x) ? x : null);
  // An optional part that is there but malformed refuses the whole identity: dropping a field or an item would
  // widen the target from one item to all of the content.
  let bad = false;
  const opt = <K extends string>(key: K, x: unknown, test = IDENT): Partial<Record<K, string>> => {
    if (x === undefined || x === null) return {};
    if (typeof x !== 'string' || !test.test(x)) { bad = true; return {}; }
    return { [key]: x } as Record<K, string>;
  };
  switch (v.kind) {
    case 'entity': {
      const type = name(v.type), id = name(v.id);
      if (!type || !id) return null;
      const out: PartIdentity = { kind: 'entity', type, id, ...opt('bundle', v.bundle), ...opt('langcode', v.langcode), ...opt('field', v.field), ...opt('item', v.item, /^(?:ref:[A-Za-z0-9_.:/@+-]{1,200}|delta:\d{1,6})$/) };
      return bad ? null : out;
    }
    case 'component': {
      const n = name(v.name);
      const within = v.within === null || v.within === undefined ? null : typeof v.within === 'string' && v.within.length <= 1000 && !/[\u0000-\u001f]/.test(v.within) ? v.within : undefined;
      if (!n || within === undefined || !Number.isInteger(v.nth) || (v.nth as number) < 0 || (v.nth as number) > 10_000) return null;
      return { kind: 'component', name: n, within, nth: v.nth as number };
    }
    case 'config': {
      const type = name(v.type), id = name(v.id);
      const plugin = opt('plugin', v.plugin);
      return type && id && !bad ? { kind: 'config', type, id, ...plugin } : null;
    }
    case 'block': {
      const store = name(v.store), n = name(v.name);
      const path = Array.isArray(v.path) && v.path.length > 0 && v.path.length <= 64 && v.path.every((x) => Number.isInteger(x) && x >= 0 && x < 10_000) ? v.path as number[] : null;
      return store && n && path ? { kind: 'block', store, path, name: n } : null;
    }
    case 'template': {
      // A path inside the theme, never out of it: an agent's brief names the file.
      const theme = name(v.theme), path = name(v.path);
      const role = TEMPLATE_ROLES.find((r) => r === v.role);
      if (!theme || theme.includes('/') || !path || !role || path.startsWith('/') || path.split('/').some((s) => s === '' || s === '.' || s === '..')) return null;
      return { kind: 'template', theme, path, role };
    }
    default: return null;
  }
}

/** One string for an identity: equal for the same part on every load, and what a component's `within` names. */
export function identityKey(i: PartIdentity): string {
  switch (i.kind) {
    case 'entity': return ['entity', i.type, i.id, i.langcode ?? '', i.field ?? '', i.item ?? ''].join('|');
    case 'component': return ['component', i.name, i.within ?? '', String(i.nth)].join('|');
    case 'config': return ['config', i.type, i.id].join('|');
    case 'block': return ['block', i.store, i.path.join('.'), i.name].join('|');
    case 'template': return ['template', i.theme, i.path].join('|');
  }
}

/**
 * What every instance of a part's kind shares, for an edit scoped to `kind`: the same field of the same bundle, the
 * same component or block type, the same block plugin. Null when a part has no kind beyond itself (a menu link, a
 * template, a theme's template file).
 */
export function kindKey(i: PartIdentity): string | null {
  switch (i.kind) {
    case 'entity': return i.bundle ? (i.field ? `field|${i.type}|${i.bundle}|${i.field}` : `entity|${i.type}|${i.bundle}`) : null;
    case 'component': return `component|${i.name}`;
    case 'block': return `component|${i.name}`;
    case 'config': return i.plugin ? `plugin|${i.type}|${i.plugin}` : null;
    case 'template': return null;
  }
}

export interface TracePart {
  /** Matches the `wl:part` comments around it in the page. */
  id: string;
  kind: PartKind;
  label: string;
  /** The part this one sits inside, when the helper knows. */
  parent?: string;
  source?: TraceSource;
  /** What shaped it, in the order it ran. */
  chain?: TraceStep[];
  variables?: TraceVariable[];
  cache?: TraceCache;
  cost?: TraceCost;
  /** EditTarget ids. */
  edits?: string[];
  history?: TraceRevision[];
  /** Template suggestions or hierarchy candidates: which exist, and which was chosen. */
  alternatives?: { name: string; file?: string; exists: boolean; chosen?: boolean }[];
  access?: { result: 'allowed' | 'forbidden' | 'neutral'; reason?: string };
  /** Asset libraries the part attached itself (not those of the parts inside it), as the platform names them: `core/drupal`, `acme/hero`. */
  libraries?: string[];
  /** Helper 4: what it is, kept across reloads and reorders (see PartIdentity). Absent from older helpers, and for markup no helper can name. */
  identity?: PartIdentity;
}

export interface TraceQuery {
  sql: string;
  ms: number;
  rows?: number;
  caller?: TraceSource;
  /** The part being rendered when it ran. */
  part?: string;
}

export interface TraceAsset {
  kind: 'script' | 'style';
  handle: string;
  src: string;
  /** The module, plugin or theme that added it. */
  by: string;
  bytes?: number;
}

export interface TraceLog {
  level: 'error' | 'warning' | 'notice' | 'info';
  message: string;
  source?: TraceSource;
}

export const COLLECTION_KINDS = ['field-items', 'region-blocks', 'post-blocks', 'layout', 'menu', 'widgets', 'display'] as const;
export type CollectionKind = (typeof COLLECTION_KINDS)[number];

/**
 * Parts whose order or place the platform itself can change: a multi-value
 * field's items, the blocks in a region or a post, a layout region's
 * components, a menu's links, a display's fields. What the drag-and-drop in the
 * live view moves; an order written into a template's code is not one.
 */
export interface TraceCollection {
  id: string;
  kind: CollectionKind;
  /** "Paragraphs on Article 12", "Sidebar blocks", "Main menu". */
  label: string;
  /** The part holding the items, when there is one. */
  part?: string;
  /** Part ids of the items, in their current order. */
  items: string[];
  /** Other collections an item may move into: other regions, other layout regions. */
  movesTo?: string[];
  /** Palette entry ids that can be inserted here. */
  inserts?: string[];
  /** What a move saves: content (a new revision when the platform keeps them) or configuration (shared by every page that uses it, and exported to stay in code). */
  changes: 'content' | 'configuration';
  revisions?: boolean;
  /** How many pages a configuration change shows on, when the helper can count them. */
  reach?: number;
  /** Why it cannot be reordered here, when it cannot. */
  why?: string;
  /** The TraceSave a move or an insert here runs: what else runs when it is saved. */
  saves?: string;
  /** Helper 4: an item can be taken out of it (`POST /_wanigan/remove`); only its placement or reference goes. */
  removes?: boolean;
  /** Helper 4: why nothing can be taken out of it here, when nothing can. */
  removeWhy?: string;
  /** Helper 4: where a change here shows when it is shared (configuration, or content shown in many places) and its pages cannot be counted: "every page shown in the Acme theme". */
  shows?: string;
}

/** Something that can be inserted into a collection: a block, a component, a pattern, a field item. */
export interface PaletteEntry {
  id: string;
  kind: 'block' | 'component' | 'pattern' | 'field-item' | 'menu-link';
  label: string;
  description?: string;
  /** The module, plugin or theme that provides it. */
  by?: string;
}

export interface LiveTrace {
  version: typeof TRACE_VERSION;
  platform: 'drupal' | 'wordpress';
  /** The X-Wanigan-Trace id. */
  id: string;
  /** Path and query, on the site's own origin. */
  url: string;
  at: number;
  user?: { name: string; roles: string[] };
  total: TraceCost & { memoryBytes?: number; hooks?: number };
  parts: TracePart[];
  edits: EditTarget[];
  /** Request-wide, in firing order. */
  hooks?: TraceStep[];
  queries?: TraceQuery[];
  assets?: TraceAsset[];
  logs?: TraceLog[];
  collections?: TraceCollection[];
  palette?: PaletteEntry[];
  /** What each kind of save on this page runs besides core, by the id edit targets and collections name. */
  saves?: TraceSave[];
  /** WordPress: what core knows of the site's AI. */
  ai?: TraceAi;
  /** The lists a bound cut short. */
  truncated?: string[];
}

export const TRACE_ID = /^[0-9a-f]{16}$/;

const OWNERS: readonly TraceOwner[] = ['yours', 'contrib', 'core', 'plugin', 'theme', 'unknown'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 2000): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

function source(v: unknown): TraceSource | undefined {
  if (!isObj(v)) return undefined;
  const file = str(v.file, 1000);
  if (!file || file.startsWith('/') || file.split('/').includes('..')) return undefined;
  const owner = OWNERS.includes(v.owner as TraceOwner) ? v.owner as TraceOwner : 'unknown';
  return { file, owner, ...(num(v.line) !== undefined ? { line: num(v.line) } : {}), ...(str(v.package, 200) ? { package: str(v.package, 200) as string } : {}) };
}

function step(v: unknown): TraceStep | null {
  if (!isObj(v)) return null;
  const hook = str(v.hook, 200), by = str(v.by, 200);
  if (!hook || !by) return null;
  const out: TraceStep = { hook, by };
  const callback = str(v.callback, 300); if (callback) out.callback = callback;
  const src = source(v.source); if (src) out.source = src;
  if (num(v.ms) !== undefined) out.ms = num(v.ms);
  if (typeof v.priority === 'number' && Number.isFinite(v.priority)) out.priority = v.priority;
  if (Array.isArray(v.changed)) out.changed = v.changed.map((c) => str(c, 200)).filter((c): c is string => !!c).slice(0, 100);
  return out;
}

/** A list, cut to its bound; the name goes into `truncated` when it was cut. */
function list<T>(v: unknown, max: number, each: (x: unknown) => T | null, name: string, truncated: Set<string>): T[] {
  if (!Array.isArray(v)) return [];
  if (v.length > max) truncated.add(name);
  return v.slice(0, max).map(each).filter((x): x is T => x !== null);
}

/** Strings from a list, each bounded, the list bounded; nothing that is not a string. */
const strings = (v: unknown, max: number, each = 200): string[] => (Array.isArray(v) ? v.map((x) => str(x, each)).filter((x): x is string => !!x).slice(0, max) : []);

/** One plugin, theme or module a save runs, checked; null when it names nothing. */
export function parseRunner(v: unknown): SaveRunner | null {
  if (!isObj(v)) return null;
  const by = str(v.by, 200);
  if (!by) return null;
  const kind = SAVE_RUNNER_KINDS.includes(v.kind as SaveRunnerKind) ? v.kind as SaveRunnerKind : 'unknown';
  const owner = OWNERS.includes(v.owner as TraceOwner) ? v.owner as TraceOwner : 'unknown';
  const out: SaveRunner = { by, kind, owner, hooks: strings(v.hooks, 40) };
  const name = str(v.name, 200); if (name) out.name = name;
  const callbacks = strings(v.callbacks, 20, 300); if (callbacks.length) out.callbacks = callbacks;
  return out;
}

/** What saves on a page run, checked and bounded: each with an id and a label, its runners named. */
export function parseSaves(v: unknown, truncated: Set<string> = new Set()): TraceSave[] {
  return list(v, TRACE_LIMITS.saves, (s): TraceSave | null => {
    if (!isObj(s)) return null;
    const id = str(s.id, 200), label = str(s.label, 300);
    if (!id || !label) return null;
    const out: TraceSave = { id, label, runs: list(s.runs, TRACE_LIMITS.runs, parseRunner, `runs:${id}`, truncated) };
    if (num(s.core) !== undefined) out.core = Math.floor(num(s.core) as number);
    return out;
  }, 'saves', truncated);
}

/** What WordPress core knows of the site's AI, checked; null when the helper said nothing of it. */
export function parseTraceAi(v: unknown): TraceAi | null {
  if (!isObj(v)) return null;
  return {
    client: v.client === true,
    supports: typeof v.supports === 'boolean' ? v.supports : null,
    connected: strings(v.connected, 50),
  };
}

/**
 * A helper's answer, checked: shape, bounds, relative source paths. Anything
 * malformed is dropped, not repaired; null when it is not a trace at all.
 */
export function parseTrace(raw: unknown): LiveTrace | null {
  if (!isObj(raw) || raw.version !== TRACE_VERSION) return null;
  if (raw.platform !== 'drupal' && raw.platform !== 'wordpress') return null;
  const id = typeof raw.id === 'string' && TRACE_ID.test(raw.id) ? raw.id : null;
  const url = str(raw.url, 4000);
  if (!id || !url || !url.startsWith('/') || url.startsWith('//')) return null;
  const truncated = new Set<string>(Array.isArray(raw.truncated) ? raw.truncated.filter((t): t is string => typeof t === 'string').slice(0, 20) : []);
  const total = isObj(raw.total) ? raw.total : {};
  const saves = Array.isArray(raw.saves) ? parseSaves(raw.saves, truncated) : null;
  const saveIds = new Set((saves ?? []).map((s) => s.id));
  /** A save id this trace describes, or nothing. */
  const savesOf = (v: unknown): string | null => (typeof v === 'string' && saveIds.has(v) ? v : null);
  const edits = list(raw.edits, TRACE_LIMITS.edits, (v): EditTarget | null => {
    if (!isObj(v)) return null;
    const eid = str(v.id, 200), label = str(v.label, 300);
    if (!eid || !label || !EDIT_KINDS.includes(v.kind as EditKind)) return null;
    if (v.via !== 'native-form' && v.via !== 'schema') return null;
    const out: EditTarget = { id: eid, kind: v.kind as EditKind, label, via: v.via };
    if (v.via === 'schema') { out.schema = v.schema; out.value = v.value; }
    if (typeof v.revisions === 'boolean') out.revisions = v.revisions;
    const why = str(v.why, 500); if (why) out.why = why;
    const save = savesOf(v.saves); if (save) out.saves = save;
    const shows = str(v.shows, 300); if (shows) out.shows = shows;
    return out;
  }, 'edits', truncated);
  const editIds = new Set(edits.map((e) => e.id));
  const parts = list(raw.parts, TRACE_LIMITS.parts, (v): TracePart | null => {
    if (!isObj(v)) return null;
    const pid = str(v.id, 200), label = str(v.label, 300);
    if (!pid || !label || !PART_KINDS.includes(v.kind as PartKind)) return null;
    const out: TracePart = { id: pid, kind: v.kind as PartKind, label };
    const parent = str(v.parent, 200); if (parent) out.parent = parent;
    const src = source(v.source); if (src) out.source = src;
    if (Array.isArray(v.chain)) out.chain = list(v.chain, TRACE_LIMITS.chain, step, `chain:${pid}`, truncated);
    if (Array.isArray(v.variables)) {
      out.variables = list(v.variables, TRACE_LIMITS.variables, (x): TraceVariable | null => {
        if (!isObj(x)) return null;
        const name = str(x.name, 200), type = str(x.type, 200);
        if (!name || !type) return null;
        const vv: TraceVariable = { name, type, preview: typeof x.preview === 'string' ? x.preview.slice(0, TRACE_LIMITS.preview) : '' };
        const setBy = str(x.setBy, 300); if (setBy) vv.setBy = setBy;
        const edit = str(x.edit, 200); if (edit && editIds.has(edit)) vv.edit = edit;
        return vv;
      }, `variables:${pid}`, truncated);
    }
    if (isObj(v.cache)) {
      const c = v.cache;
      const strs = (a: unknown): string[] => (Array.isArray(a) ? a.map((t) => str(t, 300)).filter((t): t is string => !!t).slice(0, 500) : []);
      const maxAge = c.maxAge === 'permanent' ? 'permanent' : num(c.maxAge);
      if (maxAge !== undefined) {
        out.cache = { tags: strs(c.tags), contexts: strs(c.contexts), maxAge };
        if (c.status === 'hit' || c.status === 'miss' || c.status === 'uncacheable' || c.status === 'placeholder') out.cache.status = c.status;
      }
    }
    if (isObj(v.cost) && num(v.cost.ms) !== undefined) out.cost = { ms: num(v.cost.ms) as number, ...(num(v.cost.queries) !== undefined ? { queries: num(v.cost.queries) } : {}), ...(num(v.cost.queryMs) !== undefined ? { queryMs: num(v.cost.queryMs) } : {}) };
    if (Array.isArray(v.edits)) out.edits = v.edits.filter((e): e is string => typeof e === 'string' && editIds.has(e));
    if (Array.isArray(v.history)) {
      out.history = v.history.slice(0, 50).map((h): TraceRevision | null => {
        if (!isObj(h)) return null;
        const rid = str(h.id, 100), by = str(h.by, 200), at = num(h.at);
        if (!rid || !by || at === undefined) return null;
        const msg = str(h.message, 500);
        return { id: rid, at, by, ...(msg ? { message: msg } : {}) };
      }).filter((h): h is TraceRevision => h !== null);
    }
    if (Array.isArray(v.alternatives)) {
      out.alternatives = v.alternatives.slice(0, 100).map((a) => {
        if (!isObj(a)) return null;
        const name = str(a.name, 300);
        if (!name || typeof a.exists !== 'boolean') return null;
        const file = str(a.file, 1000);
        return { name, exists: a.exists, ...(file && !file.startsWith('/') ? { file } : {}), ...(a.chosen === true ? { chosen: true } : {}) };
      }).filter((a): a is NonNullable<typeof a> => a !== null);
    }
    if (isObj(v.access) && (v.access.result === 'allowed' || v.access.result === 'forbidden' || v.access.result === 'neutral')) {
      const reason = str(v.access.reason, 500);
      out.access = { result: v.access.result, ...(reason ? { reason } : {}) };
    }
    if (Array.isArray(v.libraries)) {
      const libraries = v.libraries.map((l) => str(l, 200)).filter((l): l is string => !!l).slice(0, 100);
      if (libraries.length) out.libraries = libraries;
    }
    const identity = parseIdentity(v.identity); if (identity) out.identity = identity;
    return out;
  }, 'parts', truncated);
  const trace: LiveTrace = {
    version: TRACE_VERSION, platform: raw.platform, id, url,
    at: num(raw.at) ?? 0,
    total: { ms: num(total.ms) ?? 0, ...(num(total.queries) !== undefined ? { queries: num(total.queries) } : {}), ...(num(total.queryMs) !== undefined ? { queryMs: num(total.queryMs) } : {}), ...(num(total.memoryBytes) !== undefined ? { memoryBytes: num(total.memoryBytes) } : {}), ...(num(total.hooks) !== undefined ? { hooks: num(total.hooks) } : {}) },
    parts, edits,
  };
  if (isObj(raw.user) && str(raw.user.name, 200)) trace.user = { name: str(raw.user.name, 200) as string, roles: Array.isArray(raw.user.roles) ? raw.user.roles.filter((r): r is string => typeof r === 'string').slice(0, 50) : [] };
  if (Array.isArray(raw.hooks)) trace.hooks = list(raw.hooks, TRACE_LIMITS.hooks, step, 'hooks', truncated);
  if (Array.isArray(raw.queries)) {
    trace.queries = list(raw.queries, TRACE_LIMITS.queries, (q): TraceQuery | null => {
      if (!isObj(q)) return null;
      const sql = str(q.sql, 4000), ms = num(q.ms);
      if (!sql || ms === undefined) return null;
      const out: TraceQuery = { sql, ms };
      if (num(q.rows) !== undefined) out.rows = num(q.rows);
      const caller = source(q.caller); if (caller) out.caller = caller;
      const part = str(q.part, 200); if (part) out.part = part;
      return out;
    }, 'queries', truncated);
  }
  if (Array.isArray(raw.assets)) {
    trace.assets = list(raw.assets, TRACE_LIMITS.assets, (a): TraceAsset | null => {
      if (!isObj(a) || (a.kind !== 'script' && a.kind !== 'style')) return null;
      const handle = str(a.handle, 200), src = str(a.src, 2000), by = str(a.by, 200);
      if (!handle || !src || !by) return null;
      return { kind: a.kind, handle, src, by, ...(num(a.bytes) !== undefined ? { bytes: num(a.bytes) } : {}) };
    }, 'assets', truncated);
  }
  if (Array.isArray(raw.logs)) {
    trace.logs = list(raw.logs, TRACE_LIMITS.logs, (l): TraceLog | null => {
      if (!isObj(l) || !['error', 'warning', 'notice', 'info'].includes(l.level as string)) return null;
      const message = str(l.message, 2000);
      if (!message) return null;
      const src = source(l.source);
      return { level: l.level as TraceLog['level'], message, ...(src ? { source: src } : {}) };
    }, 'logs', truncated);
  }
  const partIds = new Set(parts.map((p) => p.id));
  if (Array.isArray(raw.palette)) {
    trace.palette = list(raw.palette, TRACE_LIMITS.palette, (e): PaletteEntry | null => {
      if (!isObj(e) || !['block', 'component', 'pattern', 'field-item', 'menu-link'].includes(e.kind as string)) return null;
      const pid = str(e.id, 200), label = str(e.label, 300);
      if (!pid || !label) return null;
      const description = str(e.description, 500), by = str(e.by, 200);
      return { id: pid, kind: e.kind as PaletteEntry['kind'], label, ...(description ? { description } : {}), ...(by ? { by } : {}) };
    }, 'palette', truncated);
  }
  const paletteIds = new Set((trace.palette ?? []).map((e) => e.id));
  if (Array.isArray(raw.collections)) {
    const collections = list(raw.collections, TRACE_LIMITS.collections, (c): TraceCollection | null => {
      if (!isObj(c) || !COLLECTION_KINDS.includes(c.kind as CollectionKind)) return null;
      const cid = str(c.id, 200), label = str(c.label, 300);
      if (!cid || !label || (c.changes !== 'content' && c.changes !== 'configuration') || !Array.isArray(c.items)) return null;
      // Items are parts of this trace; anything else is dropped, never guessed at.
      const items = c.items.filter((i): i is string => typeof i === 'string' && partIds.has(i)).slice(0, TRACE_LIMITS.parts);
      const out: TraceCollection = { id: cid, kind: c.kind as CollectionKind, label, items, changes: c.changes };
      const part = str(c.part, 200); if (part && partIds.has(part)) out.part = part;
      if (Array.isArray(c.movesTo)) out.movesTo = c.movesTo.filter((m): m is string => typeof m === 'string' && m !== cid).slice(0, 200);
      if (Array.isArray(c.inserts)) out.inserts = c.inserts.filter((e): e is string => typeof e === 'string' && paletteIds.has(e)).slice(0, TRACE_LIMITS.palette);
      if (typeof c.revisions === 'boolean') out.revisions = c.revisions;
      if (num(c.reach) !== undefined) out.reach = num(c.reach);
      const why = str(c.why, 500); if (why) out.why = why;
      const save = savesOf(c.saves); if (save) out.saves = save;
      if (typeof c.removes === 'boolean') out.removes = c.removes;
      const removeWhy = str(c.removeWhy, 500); if (removeWhy) { out.removeWhy = removeWhy; out.removes = false; }
      const shows = str(c.shows, 300); if (shows) out.shows = shows;
      return out;
    }, 'collections', truncated);
    // A move target must be a collection this trace knows.
    const collectionIds = new Set(collections.map((c) => c.id));
    for (const c of collections) if (c.movesTo) c.movesTo = c.movesTo.filter((m) => collectionIds.has(m));
    trace.collections = collections;
  }
  if (saves) trace.saves = saves;
  const ai = raw.platform === 'wordpress' ? parseTraceAi(raw.ai) : null;
  if (ai) trace.ai = ai;
  if (truncated.size) trace.truncated = [...truncated];
  return trace;
}

/**
 * What to say before an edit target is saved, when it changes more than this page (its `shows`): asked first, as
 * taking a shared item out is (live-arrange.ts removeNotice()). Null when it changes only what this page shows.
 */
export function editNotice(t: Pick<EditTarget, 'shows'>): string | null {
  return t.shows ? `This changes it wherever it shows (${t.shows}), not only on this page.` : null;
}

/** The save an edit target or a collection runs, from the trace that names it. */
export function saveOf(trace: LiveTrace | null, of: { saves?: string } | null | undefined): TraceSave | null {
  if (!trace?.saves || !of?.saves) return null;
  return trace.saves.find((s) => s.id === of.saves) ?? null;
}
