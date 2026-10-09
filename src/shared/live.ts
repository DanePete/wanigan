// The live view: the owner's local site inside Wanigan, following the agents'
// edits. Types the core, the main process and the window share, and the pure
// rules: reading a ddev config, checking an address, matching a region of the
// page to an edited file. Nothing here does I/O. Design:
// docs/design/2026-10-08-live-view.md.

export type LivePlatform = 'drupal' | 'wordpress' | 'site';

export const LIVE_PLATFORMS: readonly LivePlatform[] = ['drupal', 'wordpress', 'site'];

/** An address Wanigan found for a project, and how. */
export interface LiveCandidate {
  url: string;
  platform: LivePlatform;
  /** Where it came from, as the owner would recognise it. */
  source: 'ddev' | 'wordpress' | 'package' | 'lando';
  /** One line on how it was found, e.g. "name and project_tld in .ddev/config.yaml". */
  why: string;
}

/** What ddev says about a project: read from its config files, not from ddev. */
export interface DdevInfo {
  name: string;
  type: string;
  docroot: string;
  url: string;
  hostnames: string[];
}

export interface LiveSite {
  projectId: string;
  /** The address the view opens; null until the owner chooses one. */
  url: string | null;
  platform: LivePlatform | null;
  /** The checkout the local site serves; null is the project's own folder. */
  servedPath: string | null;
  /** The card whose checkout is served, when one is. */
  servedCard: string | null;
  candidates: LiveCandidate[];
  ddev: DdevInfo | null;
  /** The helper Wanigan installed in the site, if any. */
  helper: LiveHelper | null;
  /** What installing the helper would write and run, or why it cannot be installed here; null for a kind of site with no helper. */
  helperPlan: LiveHelperPlan | null;
  /** The token the helper answers to, sent only by the live view's own requests to this site. Null without a helper. */
  token: string | null;
}

/** A single-directory component the project defines, from its `.component.yml`. */
export interface LiveComponent {
  /** `provider:name`, as Drupal's data-component-id says it. */
  id: string;
  /** The human name in its .component.yml, or its machine name. */
  name: string;
  description: string;
  /** Its folder, absolute: an edit to any file in it is an edit to the component. */
  dir: string;
  files: string[];
  /** Its top-level props, from its .component.yml. */
  props: LiveProp[];
}

/** What a project's site is made of, as far as its own files say: its docroot and its components. */
export interface LiveParts {
  /** The site's document root, absolute (Drupal names templates relative to it); null when unknown. */
  docroot: string | null;
  components: LiveComponent[];
}

/** A screenshot of a card's page: before its session worked, or after a turn that edited files. */
export interface LiveShot {
  id: string;
  cardId: string;
  sessionId: string | null;
  kind: 'before' | 'after';
  url: string;
  /** Pixels of the image (a full page at 1440 CSS pixels wide, times the screen's scale). */
  width: number;
  height: number;
  createdAt: number;
}

/** A helper Wanigan installed in a site. */
export interface LiveHelper {
  kind: 'drupal' | 'wordpress';
  version: number;
  /** This Wanigan writes a newer one: installing again updates it. */
  outdated: boolean;
}

/** What installing the helper writes and runs, shown before the owner says yes. */
export interface LiveHelperPlan {
  kind: 'drupal' | 'wordpress';
  /** The folder it writes, absolute. */
  folder: string;
  /** The files it writes there. */
  files: string[];
  /** The line it adds to the repository's .git/info/exclude, so git never sees the folder. */
  exclude: string | null;
  /** The commands it runs, in the project folder, as the owner would type them. */
  runs: string[];
  /** Why it cannot be installed here; null when it can. */
  refused: string | null;
}

/** Words the owner changed by hand and saved to a template, and whether they can still be put back. */
export interface LiveEdit {
  id: string;
  projectId: string;
  /** The template's absolute path. */
  path: string;
  line: number;
  before: string;
  after: string;
  createdAt: number;
  revertedAt: number | null;
  /** The file is as the edit left it: a revert puts back exactly what was there. */
  revertable: boolean;
}

/** Where some words of a page are in a template: how many times, and the line of the first. */
export interface LiveFound {
  path: string;
  count: number;
  line: number | null;
  /** Why the words cannot be saved to this file, in the owner's words; null when they can (exactly one match in their own file). */
  refused: string | null;
}

/** One of a component's props, as its .component.yml declares it (top level only). */
export interface LiveProp {
  name: string;
  /** The declared type: JSON Schema's, or a theme's own (heading, image, scheme). */
  type: string;
  title: string | null;
  required: boolean;
}

/**
 * A component's top-level props from its .component.yml: each key under
 * props › properties, its type and title, and whether props › required names
 * it. Reads only indentation and keys, whatever the indent width; anything it
 * cannot read is left out rather than guessed.
 */
export function componentProps(yml: string): LiveProp[] {
  const lines = yml.split('\n').map((l) => l.replace(/\s+$/, ''));
  const indent = (l: string): number => (/^ */.exec(l)?.[0].length ?? 0);
  const real = (l: string): boolean => l.trim() !== '' && !l.trim().startsWith('#');
  const at = lines.findIndex((l) => /^props:\s*$/.test(l));
  if (at < 0) return [];
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) if (real(lines[i] as string) && indent(lines[i] as string) === 0) { end = i; break; }
  const block = lines.slice(at + 1, end).filter(real);
  if (!block.length) return [];
  const child = Math.min(...block.map(indent));
  const required = new Set<string>();
  const req = block.findIndex((l) => indent(l) === child && /^\s*required:/.test(l));
  if (req >= 0) {
    const inline = /required:\s*\[(.*)\]/.exec(block[req] as string);
    if (inline) for (const n of (inline[1] as string).split(',')) required.add(n.trim().replace(/^['"]|['"]$/g, ''));
    for (let i = req + 1; i < block.length && indent(block[i] as string) > child; i++) {
      const item = /^\s*-\s*['"]?([\w-]+)['"]?\s*$/.exec(block[i] as string);
      if (item) required.add(item[1] as string);
    }
  }
  const p = block.findIndex((l) => indent(l) === child && /^\s*properties:\s*$/.test(l));
  if (p < 0 || !block[p + 1] || indent(block[p + 1] as string) <= child) return [];
  const key = indent(block[p + 1] as string);
  const out: LiveProp[] = [];
  for (let i = p + 1; i < block.length && indent(block[i] as string) > child; i++) {
    const line = block[i] as string;
    if (indent(line) !== key) continue;
    const name = /^\s*['"]?([A-Za-z_][\w-]*)['"]?:\s*$/.exec(line)?.[1];
    if (!name) continue;
    let type = '';
    let title: string | null = null;
    // The prop's own keys sit at its first child's indent; deeper ones are its items' or nested properties'.
    const own = i + 1 < block.length ? indent(block[i + 1] as string) : 0;
    for (let j = i + 1; j < block.length && indent(block[j] as string) > key; j++) {
      if (indent(block[j] as string) !== own) continue;
      const field = /^\s*(type|title):\s*['"]?(.*?)['"]?\s*$/.exec(block[j] as string);
      if (field?.[1] === 'type' && !type) type = field[2] as string;
      if (field?.[1] === 'title' && title === null) title = field[2] as string;
    }
    out.push({ name, type: type || 'any', title, required: required.has(name) });
    if (out.length >= 40) break;
  }
  return out;
}

/** What the live view hears from the core: an agent (or the owner, in the code editor) edited files, or a turn started or ended. */
export interface LiveEvent {
  projectId: string;
  /** The agent session; null for the owner's own edit in Wanigan's code editor. */
  sessionId: string | null;
  cardId: string | null;
  /** The absolute files edited (empty for a turn's start or end). */
  paths: string[];
  kind: 'edit' | 'turn-start' | 'turn-end' | 'session-start';
  at: number;
}

/** A region of the page and what produced it, as the page script reads it. */
export interface LiveRegion {
  /** Its place in the page script's list, to ask for it to be outlined. */
  index: number;
  /** The template file, as the site names it (relative to its root), if known. */
  file: string | null;
  /** Drupal entity `type:bundle:id:view_mode`, or null. */
  entity: string | null;
  /** A block: Drupal plugin id, or a WordPress block name. */
  block: string | null;
  /** A Drupal view `id:display`. */
  view: string | null;
  /** An Elementor element `type:widget` and its id. */
  element: string | null;
  /** A single-directory component's id (`theme:card`), from core's own data-component-id. */
  component: string | null;
  /**
   * How the site's helper renders this region alone (data-wl-piece), e.g.
   * `entity/paragraph/12/default`, `lb/node/5/<uuid>`, `block/41/2.1`; null when it cannot.
   */
  piece: string | null;
  /** The theme hook Drupal said rendered it. */
  hook: string | null;
  /** A field the site's helper marked (data-wl-field): `entity_type:id:field_name`, what a hand edit to its words saves to. */
  field: string | null;
  /** Drupal's template file name suggestions for it, most specific first, without `.html.twig`. */
  suggestions: string[];
  /** The index of the smallest region it lies inside, or null at the top. */
  parent: number | null;
  /** Where it begins in the document, as a rank among the page's regions: the order the page is written in. */
  order: number;
  /** Where it is on the page, in CSS pixels of the document. */
  rect: { x: number; y: number; width: number; height: number };
}

/** What the owner picked in the view: the element, and every region it sits in, innermost first. */
export interface LivePick {
  url: string;
  /** A short CSS path to the element. */
  selector: string;
  tag: string;
  text: string;
  /** Its words, when it holds nothing but words: what a hand edit can change. Null otherwise. */
  own: string | null;
  classes: string[];
  /** Where it is, in CSS pixels of the view as it was picked. */
  rect: { x: number; y: number; width: number; height: number };
  /** The style values a hand edit can try, as computed. */
  style: Record<string, string>;
  regions: LiveRegion[];
}

/** What the site itself says is wrong on the page, or what its scripts logged as an error. */
export interface LiveProblem {
  level: 'error' | 'warning';
  text: string;
  /** Where it came from: the page's own messages, or the browser console. */
  source: 'page' | 'console';
}

/* ── addresses ─────────────────────────────────────────────────────────── */

/** An http(s) address with no credentials and no fragment, or null. */
export function liveUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text.length > 2_000 || /[\s\u0000-\u001f]/.test(text)) return null;
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`); } catch { return null; }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || !url.hostname) return null;
  url.hash = '';
  return url.toString();
}

/** Whether two addresses are the same site: the same host and port, http or https. */
export function sameSite(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const port = (u: URL): string => u.port || (u.protocol === 'https:' ? '443' : '80');
    const sameHost = x.hostname.toLowerCase() === y.hostname.toLowerCase();
    // http and https of one host are one site: ddev answers both, and redirects one to the other.
    return sameHost && (port(x) === port(y) || (x.protocol !== y.protocol && ['80', '443'].includes(port(x)) && ['80', '443'].includes(port(y))));
  } catch {
    return false;
  }
}

/* ── ddev ──────────────────────────────────────────────────────────────── */

type Yaml = Record<string, string | string[]>;

/**
 * The top-level scalars and lists of a ddev config file. Not a YAML parser:
 * ddev's own files keep everything Wanigan reads (name, type, docroot,
 * project_tld, router_https_port, additional_hostnames, additional_fqdns) at
 * the top level, as `key: value`, `key: [a, b]` or a `- item` list.
 */
export function readDdevYaml(text: string): Yaml {
  const out: Yaml = {};
  let list: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && list && /^\s/.test(raw)) {
      (out[list] as string[]).push(scalar(item[1] as string));
      continue;
    }
    const pair = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!pair) { if (!/^\s/.test(raw)) list = null; continue; }
    const [, key, value] = pair as unknown as [string, string, string];
    list = null;
    if (value === '') { out[key] = []; list = key; continue; }
    const flow = /^\[(.*)\]$/.exec(value);
    out[key] = flow ? (flow[1] as string).split(',').map((v) => scalar(v)).filter(Boolean) : scalar(value);
  }
  return out;
}

function scalar(value: string): string {
  const v = value.trim();
  return /^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v;
}

/**
 * What ddev will serve, from `.ddev/config.yaml` and then its `config.*.yaml`
 * overrides in name order, as ddev applies them. Null without a name.
 */
export function ddevInfo(files: { name: string; text: string }[]): DdevInfo | null {
  const merged: Yaml = {};
  const ordered = [...files].sort((a, b) => (a.name === 'config.yaml' ? -1 : b.name === 'config.yaml' ? 1 : a.name.localeCompare(b.name)));
  for (const f of ordered) Object.assign(merged, readDdevYaml(f.text));
  const name = typeof merged.name === 'string' ? merged.name : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(name)) return null;
  const tld = typeof merged.project_tld === 'string' && /^[A-Za-z0-9.-]+$/.test(merged.project_tld) ? merged.project_tld : 'ddev.site';
  const port = typeof merged.router_https_port === 'string' && /^\d{1,5}$/.test(merged.router_https_port) ? merged.router_https_port : '443';
  const extra = [merged.additional_hostnames, merged.additional_fqdns].flatMap((v) => (Array.isArray(v) ? v : []))
    .filter((h) => /^[A-Za-z0-9*.-]+$/.test(h) && !h.includes('*'));
  const hostnames = [`${name}.${tld}`, ...extra.map((h) => (h.includes('.') ? h : `${h}.${tld}`))];
  return {
    name,
    type: typeof merged.type === 'string' ? merged.type : '',
    docroot: typeof merged.docroot === 'string' ? merged.docroot.replace(/^\/+|\/+$/g, '') : '',
    url: `https://${name}.${tld}${port === '443' ? '' : `:${port}`}/`,
    hostnames: [...new Set(hostnames)],
  };
}

/** The platform a ddev project type names. */
export function ddevPlatform(type: string): LivePlatform {
  if (/^drupal/i.test(type) || type === 'backdrop') return 'drupal';
  if (/^wordpress$/i.test(type)) return 'wordpress';
  return 'site';
}

/* ── the page ──────────────────────────────────────────────────────────── */

/**
 * Whether a region's template file is the file an agent edited. The site names
 * a template relative to its own root (`themes/custom/x/templates/a.html.twig`,
 * `wp-content/themes/astra-child/header.php`); the edit is an absolute path on
 * this Mac. They match when the absolute path ends with the site's path, at a
 * folder boundary.
 */
export function regionMadeBy(regionFile: string | null, editedPath: string): boolean {
  if (!regionFile) return false;
  const file = regionFile.replace(/^\.?\/+/, '');
  if (!file || file.includes('..')) return false;
  return editedPath === file || editedPath.endsWith(`/${file}`);
}

/** What a region is, regardless of where it sits: the same part on a reloaded page has the same key. */
function regionKey(r: LiveRegion): string {
  return [r.component, r.file, r.entity, r.block, r.view, r.element].map((v) => v ?? '').join('|');
}

/**
 * The region on a newly scanned page that is the same part as one on the old
 * page: the same key, and the same occurrence of it counting from the top
 * (the second product teaser stays the second). Null when the page no longer
 * has it.
 */
export function sameRegion(region: LiveRegion, before: readonly LiveRegion[], after: readonly LiveRegion[]): LiveRegion | null {
  const key = regionKey(region);
  const order = (list: readonly LiveRegion[]): LiveRegion[] => list.filter((r) => regionKey(r) === key)
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || a.index - b.index);
  const nth = order(before).findIndex((r) => r.index === region.index);
  return nth < 0 ? null : order(after)[nth] ?? null;
}

/** Whether an edited file is inside a folder (a component's): the folder itself, or anything below it. */
export function inFolder(dir: string, editedPath: string): boolean {
  const d = dir.replace(/\/+$/, '');
  return !!d && (editedPath === d || editedPath.startsWith(`${d}/`));
}

/** Stylesheets and their sources: an edit to one of these is swapped in place, without a reload. */
export function isStylesheet(path: string): boolean {
  return /\.(css|scss|sass|less)$/i.test(path);
}
