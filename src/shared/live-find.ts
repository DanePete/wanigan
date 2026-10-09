// The site's own destinations, for the live view's "Go to" launcher (Shift+Space,
// as in Alfred-style site launchers): content, terms, users, media, admin and
// structure pages, templates and settings, with what each can do. A site helper
// answers it through core only; Wanigan ranks and shows it.
//
// The contract, on the site's own origin, every request carrying the
// X-Wanigan-Live token:
//
// - `GET /_wanigan/find` answers the index: every admin and structure
//   destination the logged-in user may open (menus and their local tasks,
//   settings), recent content, and the front page, with a `cacheId` that
//   changes when any of it does.
// - `GET /_wanigan/find?q=<text>&limit=<n>` (n ≤ 50) also searches content,
//   terms, users and media by title or name on the server, access-checked.
//
// Every url is a same-origin path. Nothing is listed that the user cannot open.

export const FIND_KINDS = ['content', 'term', 'user', 'media', 'admin', 'structure', 'template', 'setting', 'view'] as const;
export type FindKind = (typeof FIND_KINDS)[number];

export interface FindAction {
  /** "Edit", "Layout", "Revisions", "Delete". */
  label: string;
  url: string;
}

export interface FindItem {
  /** Stable: 'node:12', 'post:44', 'route:system.admin_content', 'admin:edit.php'. */
  id: string;
  kind: FindKind;
  label: string;
  /** Where it opens. */
  url: string;
  /** Other words it matches: bundle or post type, path alias, machine name. */
  tags?: string[];
  /** The menu trail of an admin page: ["Structure", "Content types"]. */
  trail?: string[];
  /** A content item's type ("Article", "Page"). */
  type?: string;
  status?: 'published' | 'draft' | 'private' | 'scheduled' | 'trash';
  /** When it last changed, in ms. */
  changed?: number;
  /** Its edit form, when the user may edit it. */
  edit?: string;
  /** Its local tasks and actions. */
  actions?: FindAction[];
}

export interface FindResult {
  cacheId: string;
  items: FindItem[];
  /** How many matched before the limit, when the helper knows. */
  total?: number;
  truncated?: boolean;
}

export const FIND_LIMIT = 50;
const INDEX_MAX = 5000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 500): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);
/** A same-origin path: begins with one slash, not two, no scheme. */
export const samePath = (v: unknown): string | null => {
  const s = str(v, 2000);
  return s && s.startsWith('/') && !s.startsWith('//') && !/^\/\\/.test(s) ? s : null;
};
const STATUSES = ['published', 'draft', 'private', 'scheduled', 'trash'];

/** A helper's answer, checked: kinds, same-origin paths, bounded lists. Malformed items are dropped. */
export function parseFind(raw: unknown): FindResult | null {
  if (!isObj(raw) || !Array.isArray(raw.items)) return null;
  const cacheId = str(raw.cacheId, 200);
  if (!cacheId) return null;
  const items: FindItem[] = [];
  for (const v of raw.items.slice(0, INDEX_MAX)) {
    if (!isObj(v) || !FIND_KINDS.includes(v.kind as FindKind)) continue;
    const id = str(v.id, 300), label = str(v.label, 300), url = samePath(v.url);
    if (!id || !label || !url) continue;
    const item: FindItem = { id, kind: v.kind as FindKind, label, url };
    const words = (a: unknown): string[] => (Array.isArray(a) ? a.map((t) => str(t, 200)).filter((t): t is string => !!t).slice(0, 20) : []);
    const tags = words(v.tags); if (tags.length) item.tags = tags;
    const trail = words(v.trail); if (trail.length) item.trail = trail;
    const type = str(v.type, 100); if (type) item.type = type;
    if (STATUSES.includes(v.status as string)) item.status = v.status as FindItem['status'];
    if (typeof v.changed === 'number' && Number.isFinite(v.changed) && v.changed > 0) item.changed = v.changed;
    const edit = samePath(v.edit); if (edit) item.edit = edit;
    if (Array.isArray(v.actions)) {
      const actions = v.actions.slice(0, 20).map((a): FindAction | null => {
        if (!isObj(a)) return null;
        const al = str(a.label, 100), au = samePath(a.url);
        return al && au ? { label: al, url: au } : null;
      }).filter((a): a is FindAction => a !== null);
      if (actions.length) item.actions = actions;
    }
    items.push(item);
  }
  const out: FindResult = { cacheId, items };
  if (typeof raw.total === 'number' && Number.isFinite(raw.total) && raw.total >= 0) out.total = raw.total;
  if (raw.truncated === true || raw.items.length > INDEX_MAX) out.truncated = true;
  return out;
}
