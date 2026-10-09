// A site's hosted environments (Dev, Test, Live): where the project's own
// files say the site runs besides this Mac, and the rules for an address the
// owner keeps. Pure: the core reads the files and hands their text here.
// Nothing here reaches the network. Design: docs/design/2026-10-08-live-view.md
// ("Local and hosted").

/** An environment Wanigan found in the project's files, not yet kept by the owner. */
export interface LiveEnvCandidate {
  /** The name its host or file gives it: Dev, Test, Live, Staging, Prod. */
  name: string;
  /** Always https, with no credentials and no query. */
  url: string;
  /** The file it was found in, relative to the project folder. */
  file: string;
  /** One line on how it was found, e.g. "uri of @acme.live". */
  why: string;
}

/** An environment the owner kept: a tab in the live view, read-only. */
export interface LiveEnv {
  id: string;
  name: string;
  url: string;
  /** Where Wanigan found it ("drush/sites/acme.site.yml: uri of @acme.live"), or null when the owner typed it. */
  found: string | null;
}

/**
 * A part of the page the owner told the comparison to ignore (a carousel, a
 * timestamp): a rectangle in CSS pixels of the local page, at one width.
 */
export interface LiveMask {
  id: string;
  /** The page's path and query it applies to; null on every page of the site. */
  path: string | null;
  /** The width the pages were compared at, in CSS pixels. */
  width: number;
  rect: { x: number; y: number; width: number; height: number };
  /** What it was called when it was ignored (the part it overlapped). */
  label: string | null;
}

export interface LiveEnvs {
  projectId: string;
  /** The owner's environments, in tab order. */
  envs: LiveEnv[];
  /** What the project's files name that is not kept yet, Dev before Test before Live. */
  candidates: LiveEnvCandidate[];
  masks: LiveMask[];
}

export const MAX_ENVS = 8;
export const MAX_MASKS = 60;

/* ── addresses ─────────────────────────────────────────────────────────── */

/** Hosts that are this Mac or a local development tool's: those are the Local tab, never a hosted one. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0' || /^127\./.test(h)
    || /\.(ddev\.site|lndo\.site|docksal\.site|docksal|local|internal)$/.test(h) || !h.includes('.');
}

/**
 * The address of a hosted environment, or why it cannot be one. https only
 * (its certificate is checked as any browser would), no user name or password,
 * no query (a query can carry a key), and not this Mac. The path is kept, so a
 * site served below a folder works; it always ends with a slash.
 */
export function hostedUrl(raw: unknown): { url: string; refused: null } | { url: null; refused: string } {
  const no = (refused: string) => ({ url: null, refused } as const);
  if (typeof raw !== 'string' || !raw.trim()) return no('Type the environment’s address.');
  const text = raw.trim();
  if (text.length > 500 || /[\s\u0000-\u001f]/.test(text)) return no('That is not an address.');
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`); } catch { return no('That is not an address.'); }
  if (url.protocol !== 'https:') return no('A hosted environment must be https, so its certificate is checked.');
  if (url.username || url.password) return no('Leave the user name and password out of the address: Wanigan never keeps credentials in one.');
  if (url.search) return no('Leave the query (?…) out: an environment is an address, and a query can carry a key.');
  if (!url.hostname || isLocalHost(url.hostname)) return no('That is an address on this Mac: the Local tab is for the site you run here.');
  const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return { url: `${url.origin}${path}`, refused: null };
}

/** A name for a tab: short, plain, and not "Local" (that tab is always there). */
export function envName(raw: unknown): { name: string; refused: null } | { name: null; refused: string } {
  const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!name) return { name: null, refused: 'Give the environment a name, as its host does (Dev, Test, Live).' };
  if (name.length > 24 || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(name)) return { name: null, refused: 'A name is up to 24 letters, digits, spaces, dots, dashes or underscores.' };
  if (name.toLowerCase() === 'local') return { name: null, refused: 'Local is the site on this Mac. Name this one as its host does.' };
  return { name, refused: null };
}

/**
 * The same page on another environment: the path (and query) below one
 * address, put below the other. A page outside the first address (another
 * folder) keeps its whole path.
 */
export function samePage(page: string, from: string, to: string): string {
  try {
    const p = new URL(page);
    const f = new URL(from);
    const t = new URL(to);
    const base = f.pathname.endsWith('/') ? f.pathname : `${f.pathname}/`;
    const rest = p.pathname.startsWith(base) ? p.pathname.slice(base.length) : p.pathname.replace(/^\/+/, '');
    const into = t.pathname.endsWith('/') ? t.pathname : `${t.pathname}/`;
    return `${t.origin}${into}${rest}${p.search}`;
  } catch {
    return to;
  }
}

/** A page's path and query below its environment's address: what a mask is remembered by. */
export function pagePath(page: string, base: string): string {
  try {
    const p = new URL(samePage(page, base, 'https://x.invalid/'));
    return `${p.pathname}${p.search}`.slice(0, 1_000);
  } catch {
    return '/';
  }
}

/* ── names ─────────────────────────────────────────────────────────────── */

const WORDS: Record<string, string> = {
  dev: 'Dev', develop: 'Develop', development: 'Development', test: 'Test', testing: 'Testing', qa: 'QA', uat: 'UAT',
  stage: 'Stage', staging: 'Staging', stg: 'Staging', preprod: 'Preprod', preview: 'Preview',
  live: 'Live', prod: 'Prod', production: 'Production', prd: 'Prod',
};

/** Aliases that are the owner's own machine, whatever address they carry. */
const LOCAL_KEYS = new Set(['local', 'localhost', 'ddev', 'lando', 'docksal', 'docker', 'vagrant', 'self', 'default', 'loc', 'dev-local']);

/** How an alias or key reads as a tab: Live, Staging, QA; a name it does not know, title-cased. */
export function envWord(key: string): string {
  const k = key.toLowerCase();
  return WORDS[k] ?? (k.charAt(0).toUpperCase() + k.slice(1)).replace(/[_-]+/g, ' ').slice(0, 24);
}

/** Dev first, then the test stages, then Live; anything else after. */
export function envRank(name: string): number {
  const k = name.toLowerCase();
  if (/^(dev|develop|development)$/.test(k)) return 0;
  if (/^(test|testing|qa|uat|stage|staging|stg|preprod|preview)$/.test(k)) return 1;
  if (/^(live|prod|production|prd)$/.test(k)) return 2;
  return 3;
}

/** An address as a project file writes it (a bare host, http or https), as a hosted environment: https, or null. */
export function foundUrl(raw: string): string | null {
  let text = raw.trim().replace(/^['"]|['"]$/g, '');
  if (!text || text.includes('$') || text.includes('{')) return null;
  if (/^http:\/\//i.test(text)) text = `https://${text.slice(7)}`;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    u.search = '';
    u.hash = '';
    if (u.username || u.password) return null;
    return hostedUrl(u.toString()).url;
  } catch {
    return null;
  }
}

/** What a reader below finds in one file, before the core adds which file. */
export type Found = Omit<LiveEnvCandidate, 'file'>;

/* ── Drush site aliases ────────────────────────────────────────────────── */

/**
 * Drush 9+ site aliases (`drush/sites/acme.site.yml`): each top-level key is
 * an environment, and its `uri` the address. Not a YAML parser: Drush's own
 * files keep both at those two levels.
 */
export function drushAliases(text: string, file: string): Found[] {
  const group = file.replace(/^.*\//, '').replace(/\.site\.ya?ml$/, '');
  const out: Found[] = [];
  let key: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const top = /^['"]?([A-Za-z0-9_.-]+)['"]?:\s*$/.exec(line);
    if (top) { key = top[1] as string; continue; }
    if (!/^\s/.test(line)) { key = null; continue; }
    const uri = /^\s+uri:\s*(.+)$/.exec(line);
    if (key && uri && !LOCAL_KEYS.has(key.toLowerCase())) {
      const url = foundUrl(uri[1] as string);
      if (url) out.push({ name: envWord(key), url, why: `uri of @${group === 'self' ? '' : `${group}.`}${key}` });
      key = null;
    }
  }
  return out;
}

/** Drush 8 aliases (`acme.aliases.drushrc.php`): `$aliases['live'] = array('uri' => …)`. */
export function drush8Aliases(text: string): Found[] {
  const out: Found[] = [];
  const re = /\$aliases\[\s*['"]([A-Za-z0-9_.-]+)['"]\s*\]\s*=\s*(?:array\s*\(|\[)([\s\S]*?)(?:\)\s*;|\]\s*;)/g;
  const body = stripPhpComments(text);
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const key = m[1] as string;
    const uri = /['"]uri['"]\s*=>\s*['"]([^'"]+)['"]/.exec(m[2] as string)?.[1];
    const url = uri ? foundUrl(uri) : null;
    if (url && !LOCAL_KEYS.has(key.toLowerCase())) out.push({ name: envWord(key), url, why: `uri of the Drush alias @${key}` });
    if (out.length >= 20) break;
  }
  return out;
}

/* ── WP-CLI aliases ────────────────────────────────────────────────────── */

/** WP-CLI's aliases in `wp-cli.yml`: `@staging:` with a nested `url:`. Group aliases (lists) are left out. */
export function wpCliAliases(text: string): Found[] {
  const out: Found[] = [];
  let alias: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const top = /^['"]?@([A-Za-z0-9_.-]+)['"]?:\s*$/.exec(line);
    if (top) { alias = top[1] as string; continue; }
    if (!/^\s/.test(line)) { alias = null; continue; }
    const url = /^\s+url:\s*(.+)$/.exec(line);
    if (alias && url && !LOCAL_KEYS.has(alias.toLowerCase())) {
      const found = foundUrl(url[1] as string);
      if (found) out.push({ name: envWord(alias), url: found, why: `url of the WP-CLI alias @${alias}` });
      alias = null;
    }
  }
  return out;
}

/* ── Stage File Proxy ──────────────────────────────────────────────────── */

function stripPhpComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|#)/.test(l)).join('\n');
}

/**
 * Stage File Proxy's origin: the site the local one borrows its files from,
 * nearly always the live one. In a settings file
 * (`$config['stage_file_proxy.settings']['origin'] = '…'`) or its exported
 * configuration (`origin: '…'`). Commented-out lines are not read.
 */
export function stageFileProxy(text: string, yaml: boolean): Found[] {
  const raw = yaml
    ? /^origin:\s*(.+)$/m.exec(text)?.[1]
    : /\$config\[\s*['"]stage_file_proxy\.settings['"]\s*\]\s*\[\s*['"]origin['"]\s*\]\s*=\s*['"]([^'"]+)['"]/.exec(stripPhpComments(text))?.[1];
  const url = raw ? foundUrl(raw) : null;
  return url ? [{ name: 'Live', url, why: 'Stage File Proxy’s origin (where the local site borrows its files from)' }] : [];
}

/* ── environment variables (ddev web_environment, compose files) ───────── */

const ENV_KEY = /^(DEV|DEVELOP|DEVELOPMENT|TEST|TESTING|QA|UAT|STAGE|STAGING|STG|PREPROD|PREVIEW|LIVE|PROD|PRODUCTION|PRD)_(?:SITE_|BASE_|PUBLIC_)?(URL|URI|HOST|HOSTNAME|DOMAIN|ORIGIN)$/;
const SFP_KEY = /^(STAGE_FILE_PROXY_(URL|ORIGIN)|SFP_ORIGIN)$/;

/** `KEY=value` pairs whose key names an environment's address: `PROD_URL`, `STAGING_HOST`, Stage File Proxy's origin. */
export function envVariables(pairs: readonly string[], where: string): Found[] {
  const out: Found[] = [];
  for (const pair of pairs.slice(0, 200)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(pair);
    if (!m) continue;
    const key = m[1] as string;
    const url = foundUrl(m[2] as string);
    if (!url) continue;
    if (SFP_KEY.test(key)) out.push({ name: 'Live', url, why: `${key} in ${where} (Stage File Proxy’s origin)` });
    else {
      const env = ENV_KEY.exec(key);
      if (env) out.push({ name: envWord(env[1] as string), url, why: `${key} in ${where}` });
    }
  }
  return out;
}

/**
 * The `KEY=value` and `KEY: value` entries of a compose file's environment
 * blocks (any service), upper-case keys only. Structured lines, not prose.
 */
export function composePairs(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    const item = /^\s*-\s*['"]?([A-Z][A-Z0-9_]*)=([^'"\s]+)['"]?\s*$/.exec(line);
    const map = /^\s+([A-Z][A-Z0-9_]*):\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
    const m = item ?? map;
    if (m) out.push(`${m[1]}=${m[2]}`);
    if (out.length >= 200) break;
  }
  return out;
}

/* ── Pantheon ──────────────────────────────────────────────────────────── */

/** Placeholders ddev's own example provider file carries, which name no site. */
const PLACEHOLDER = /^(your|my)?(project|site|sitename|projectname)$/i;

/** A Pantheon site's machine name, as ddev's provider (`project: acme.live`) or a variable names it; null for a placeholder. */
export function pantheonSite(value: string | undefined): string | null {
  const site = value?.trim().replace(/^['"]|['"]$/g, '').split('.')[0] ?? '';
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(site) && !PLACEHOLDER.test(site) ? site : null;
}

/** The `project:` ddev's Pantheon provider file is set to, comments left out. */
export function ddevPantheonProject(text: string): string | null {
  const uncommented = text.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  return pantheonSite(/^\s+project:\s*(\S+)/m.exec(uncommented)?.[1]);
}

/** Lando's Pantheon recipe names its site: `recipe: pantheon` and `config: site: acme`. */
export function landoPantheonSite(text: string): string | null {
  if (!/^recipe:\s*['"]?pantheon['"]?\s*$/m.test(text)) return null;
  return pantheonSite(/^\s+site:\s*(\S+)/m.exec(text)?.[1]);
}

/**
 * Every Pantheon site has three environments at addresses Pantheon makes
 * from the site's machine name: `https://dev-acme.pantheonsite.io/`, test-
 * and live-. (Multidevs and custom domains are not in the project's files.)
 */
export function pantheonEnvs(site: string, how: string): Found[] {
  return (['dev', 'test', 'live'] as const).map((env) => ({
    name: envWord(env),
    url: `https://${env}-${site}.pantheonsite.io/`,
    why: `Pantheon’s ${env} address for the site “${site}” (${how})`,
  }));
}

/* ── a README, only where it is structured ─────────────────────────────── */

/**
 * Environments a README lists in a table row (`| Live | https://… |`) or a
 * list item (`- **Staging:** https://…`) that begins with an environment's
 * name. Prose is not read: a sentence mentioning a URL says nothing reliable.
 */
export function readmeEnvs(text: string): Found[] {
  const out: Found[] = [];
  for (const line of text.split(/\r?\n/).slice(0, 4_000)) {
    const m = /^\s*(?:\||[-*+]\s)\s*(?:\*\*|__|\[)?\s*([A-Za-z]+)\s*(?:\*\*|__|\])?\s*(?:[:|–—(-]|\*\*:)/.exec(line);
    if (!m || envRank(m[1] as string) > 2) continue;
    const href = /https?:\/\/[^\s|)>\]`'"]+/.exec(line.slice(m[0].length))?.[0];
    const url = href ? foundUrl(href) : null;
    if (url) out.push({ name: envWord(m[1] as string), url, why: `listed as ${m[1]} in the README` });
    if (out.length >= 12) break;
  }
  return out;
}

/* ── together ──────────────────────────────────────────────────────────── */

/**
 * Candidates in tab order (Dev, test stages, Live, the rest), one per address
 * (the first file to name it wins), leaving out the local site's own hosts and
 * addresses the owner already keeps.
 */
export function rankCandidates(found: readonly LiveEnvCandidate[], skip: { hosts: readonly string[]; urls: readonly string[] }): LiveEnvCandidate[] {
  const hosts = new Set(skip.hosts.map((h) => h.toLowerCase()));
  const urls = new Set(skip.urls);
  const seen = new Set<string>();
  const out: LiveEnvCandidate[] = [];
  for (const c of found) {
    let host = '';
    try { host = new URL(c.url).hostname.toLowerCase(); } catch { continue; }
    if (hosts.has(host) || urls.has(c.url) || seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c);
  }
  return out.map((c, i) => ({ c, i })).sort((x, y) => envRank(x.c.name) - envRank(y.c.name) || x.i - y.i).map((x) => x.c).slice(0, 24);
}
