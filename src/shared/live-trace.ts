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
//
// Everything past a part's id, kind and label is optional: a helper reports
// what its platform knows, and nothing it would have to guess. Values shown to
// the owner (`preview`) are bounded and have secrets redacted by the helper.

export const TRACE_VERSION = 1;

/** Bounds a helper applies before answering, which parseTrace applies again. */
export const TRACE_LIMITS = { parts: 4000, edits: 4000, hooks: 5000, queries: 2000, assets: 500, logs: 500, chain: 200, variables: 200, preview: 400 } as const;

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
}

export const PART_KINDS = ['template', 'component', 'block', 'entity', 'field', 'view', 'region', 'form', 'shortcode', 'pattern', 'menu', 'widget'] as const;
export type PartKind = (typeof PART_KINDS)[number];

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
  const edits = list(raw.edits, TRACE_LIMITS.edits, (v): EditTarget | null => {
    if (!isObj(v)) return null;
    const eid = str(v.id, 200), label = str(v.label, 300);
    if (!eid || !label || !EDIT_KINDS.includes(v.kind as EditKind)) return null;
    if (v.via !== 'native-form' && v.via !== 'schema') return null;
    const out: EditTarget = { id: eid, kind: v.kind as EditKind, label, via: v.via };
    if (v.via === 'schema') { out.schema = v.schema; out.value = v.value; }
    if (typeof v.revisions === 'boolean') out.revisions = v.revisions;
    const why = str(v.why, 500); if (why) out.why = why;
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
  if (truncated.size) trace.truncated = [...truncated];
  return trace;
}
