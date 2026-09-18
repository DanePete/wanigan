/**
 * A model backend's catalog, declared rather than written out a fourth time.
 *
 * `glm.ts`, `deepseek.ts` and `xai.ts` are the same module three times: the
 * same six-hour cache, the same twelve-second abort, the same bearer header,
 * the same "never throw — return the local list with a note saying so"
 * contract. After normalising the provider name, two of them differ by 44
 * lines. Each also cost an IPC channel, a preload method and a Settings
 * branch, so a fourth backend was a week of plumbing rather than a JSON edit.
 * A pack now declares a `catalog` block and gets all of it.
 *
 * This is the half with no process in it: what a pack may declare, what a
 * catalog response means, and the sentence Wanigan says when it is serving a
 * list it did not fetch. `src/main/backend-catalog.ts` holds the socket, and
 * `src/shared` stays closure-free so this contract answers in under a second.
 *
 * The honesty rule the three originals carried is the reason the file is split
 * here at all: a fallback list is never reported as live. `fallbackNote` exists
 * so "which list am I looking at?" always has an answer on screen, and the main
 * half derives `source` from whether that note is null rather than setting the
 * two independently, because two fields that must agree eventually will not.
 */

export type BackendCatalogShape = 'openai-models' | 'anthropic-models';
export type BackendCatalogUrl = string | { source: 'process'; name: string; fallback: string };
export type BackendCatalogAuth = { source: 'credential'; id: string } | { source: 'none' };

export type BackendCatalogManifest = {
  url: BackendCatalogUrl;
  auth?: BackendCatalogAuth;
  shape: BackendCatalogShape;
  /** Regex SOURCE, never a compiled expression — a manifest is JSON. */
  exclude?: string;
  fallback: { id: string; label: string }[];
};

export type BackendCatalogModel = { id: string; label: string; source: 'api' | 'fallback' };

/**
 * A manifest is untrusted data, so every bound here is a refusal and not a
 * clamp: a pack that declares nonsense is told which field, rather than having
 * Wanigan quietly pick something on its behalf.
 */
const MAX_URL_CHARS = 2_000;
const MAX_ENV_NAME_CHARS = 128;
const MAX_ID_CHARS = 200;
const MAX_LABEL_CHARS = 200;
const MAX_MODELS = 500;

/**
 * An `exclude` is compiled and then run against every id a catalog returns, in
 * the main process, while a launch dialog waits on it. A nested-quantifier
 * pattern — `(a+)+b` and its relatives — backtracks for longer than the app
 * will be alive, and there is no timeout to interrupt a regex engine. A short
 * source is not a proof of safety, but it is the bound that keeps an accident
 * from being fatal, and a filter that needs more than this is doing something
 * other than dropping image and voice models.
 */
const MAX_EXCLUDE_CHARS = 200;

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** One place the manifest's pattern is turned into a regex, so both callers agree on the flags. */
function compileExclude(source: string): RegExp {
  return new RegExp(source, 'i');
}

const SHAPES: BackendCatalogShape[] = ['openai-models', 'anthropic-models'];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Loopback is the one exception to https.
 *
 * Not a convenience: `WANIGAN_GLM_MODELS_URL` and its two siblings already
 * exist so an operator can point a catalog at a gateway on their own machine,
 * and the egress panel lists that override by name. Cleartext to 127.0.0.1
 * never leaves the machine the app is running on; cleartext to anywhere else
 * puts a bearer token on the wire.
 */
function loopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname);
}

/** The reason this url cannot be a catalog, or null. Shared by the manifest and the override. */
function urlProblem(value: unknown, where: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return `${where} must be a non-empty string.`;
  const text = value.trim();
  if (text.length > MAX_URL_CHARS) return `${where} is longer than ${MAX_URL_CHARS} characters.`;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return `${where} is not a valid URL.`;
  }
  if (parsed.protocol === 'https:') return null;
  if (parsed.protocol === 'http:' && loopback(parsed.hostname)) return null;
  return `${where} must use https, or http on a loopback host — a catalog read carries this backend's key.`;
}

function parseUrl(raw: unknown, errors: string[]): BackendCatalogUrl | null {
  if (typeof raw === 'string' || raw === undefined || raw === null) {
    const problem = urlProblem(raw, 'catalog.url');
    if (problem) {
      errors.push(problem);
      return null;
    }
    return (raw as string).trim();
  }
  if (!isObject(raw)) {
    errors.push('catalog.url must be a string or a { source: "process" } object.');
    return null;
  }
  if (raw.source !== 'process') {
    errors.push('catalog.url.source must be "process".');
    return null;
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > MAX_ENV_NAME_CHARS || !ENV_NAME_RE.test(name)) {
    errors.push('catalog.url.name must be a valid environment variable name.');
  }
  const problem = urlProblem(raw.fallback, 'catalog.url.fallback');
  if (problem) errors.push(problem);
  if (!name || problem) return null;
  return { source: 'process', name, fallback: (raw.fallback as string).trim() };
}

function parseAuth(raw: unknown, errors: string[]): BackendCatalogAuth | null {
  // Absent means public. A catalog that in fact wants a key and declares none
  // gets a 401, which surfaces as a fallback list with the status in the note —
  // wrong, but visibly wrong, which is the failure mode this module prefers.
  if (raw === undefined) return { source: 'none' };
  if (!isObject(raw)) {
    errors.push('catalog.auth must be an object.');
    return null;
  }
  if (raw.source === 'none') return { source: 'none' };
  if (raw.source !== 'credential') {
    errors.push('catalog.auth.source must be "credential" or "none".');
    return null;
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  // Credential ids stay opaque strings, per the provider-pack rule; bounded and
  // free of whitespace is the whole of what Wanigan asks of one.
  if (!id || id.length > 64 || /\s/.test(id)) {
    errors.push('catalog.auth.id must be a short credential id with no whitespace.');
    return null;
  }
  return { source: 'credential', id };
}

function parseFallback(raw: unknown, errors: string[]): { id: string; label: string }[] | null {
  if (!Array.isArray(raw) || !raw.length) {
    // A backend with no fallback has nothing to offer when the network is down,
    // and an empty picker reads as "this backend has no models" rather than
    // "Wanigan could not ask". Declaring the list is how a pack avoids saying
    // the first thing when it means the second.
    errors.push('catalog.fallback must list at least one model — a backend with no fallback has nothing to offer when the catalog is unreachable.');
    return null;
  }
  if (raw.length > MAX_MODELS) {
    errors.push(`catalog.fallback lists more than ${MAX_MODELS} models.`);
    return null;
  }
  const out: { id: string; label: string }[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const where = `catalog.fallback[${index}]`;
    if (!isObject(entry)) {
      errors.push(`${where} must be an object.`);
      return;
    }
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const label = typeof entry.label === 'string' ? entry.label.trim() : '';
    if (!id) errors.push(`${where}.id must be a non-empty string.`);
    else if (id.length > MAX_ID_CHARS) errors.push(`${where}.id is longer than ${MAX_ID_CHARS} characters.`);
    if (!label) errors.push(`${where}.label must be a non-empty string.`);
    else if (label.length > MAX_LABEL_CHARS) errors.push(`${where}.label is longer than ${MAX_LABEL_CHARS} characters.`);
    // Two rows for one id read as two choices in the picker; launch-choices
    // drops case-insensitive duplicates for the same reason.
    if (id && seen.has(id.toLowerCase())) errors.push(`${where}.id repeats "${id}".`);
    if (id) seen.add(id.toLowerCase());
    if (id && label && id.length <= MAX_ID_CHARS && label.length <= MAX_LABEL_CHARS) out.push({ id, label });
  });
  return out.length === raw.length ? out : null;
}

/**
 * Validate a pack's `catalog` block before anything is fetched with it.
 *
 * Returns the normalised manifest rather than the input: an absent `auth`
 * becomes `{ source: 'none' }` here, so the fetching half has one code path
 * instead of a nullish check at every use.
 */
export function validateBackendCatalog(value: unknown): {
  ok: boolean;
  catalog: BackendCatalogManifest | null;
  errors: string[];
} {
  const errors: string[] = [];
  if (!isObject(value)) return { ok: false, catalog: null, errors: ['catalog must be an object.'] };

  const url = parseUrl(value.url, errors);
  const auth = parseAuth(value.auth, errors);
  const fallback = parseFallback(value.fallback, errors);

  const shape = SHAPES.find((candidate) => candidate === value.shape) ?? null;
  if (!shape) errors.push(`catalog.shape must be one of ${SHAPES.join(', ')}.`);

  let exclude: string | undefined;
  if (value.exclude !== undefined) {
    if (typeof value.exclude !== 'string' || !value.exclude.trim()) {
      errors.push('catalog.exclude must be a non-empty regular expression source.');
    } else if (value.exclude.length > MAX_EXCLUDE_CHARS) {
      errors.push(`catalog.exclude is longer than ${MAX_EXCLUDE_CHARS} characters. A pattern from a manifest runs in the main process against every id a catalog returns, and a backtracking one would hang the app with no way to interrupt it.`);
    } else {
      try {
        // Compiled here and thrown away, so the failure is a refused install
        // rather than an exception the first time somebody opens the picker.
        compileExclude(value.exclude);
        exclude = value.exclude;
      } catch (error) {
        errors.push(`catalog.exclude is not a valid regular expression (${error instanceof Error ? error.message : String(error)}).`);
      }
    }
  }

  if (errors.length || !url || !auth || !fallback || !shape) return { ok: false, catalog: null, errors };
  return { ok: true, catalog: { url, auth, shape, ...(exclude ? { exclude } : {}), fallback }, errors: [] };
}

/**
 * The url this catalog resolves to, given an environment. Never throws.
 *
 * An override is somebody's shell, not a validated manifest, so it is held to
 * the same rule and ignored when it fails it. Silently — a bad `WANIGAN_*_URL`
 * falling back to the declared host is a working app; the alternative is a
 * catalog read that never succeeds and a note nobody can act on.
 */
export function catalogUrl(catalog: BackendCatalogManifest, env: Record<string, string | undefined>): string {
  const declared = catalog.url;
  if (typeof declared === 'string') return declared;
  const override = env[declared.name];
  const trimmed = typeof override === 'string' ? override.trim() : '';
  if (trimmed && urlProblem(trimmed, 'override') === null) return trimmed;
  return declared.fallback;
}

/** "Grok 4 Fast" from "grok-4-fast". Separators and case only; the id itself is never touched. */
export function prettyModelLabel(id: string): string {
  return id.replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()).trim();
}

/**
 * Parse a catalog response body. Throws an Error whose message is fit to show a person.
 *
 * Both shapes are `{ data: [{ id }] }` today and the parse is shared; `shape`
 * is still declared and still validated, because it is the field a third shape
 * diverges on and a manifest must not be able to name one Wanigan cannot read.
 *
 * Empty after filtering is an error, not an empty list. xAI's catalog lists
 * image, video and voice models beside the text ones, and a session launched
 * against those fails at the first turn; if the filter removes everything, what
 * is left is not "this backend has no models" but "Wanigan cannot tell which of
 * these would start", and the caller's fallback list is the better answer.
 */
export function modelsFromCatalogBody(catalog: BackendCatalogManifest, body: unknown): BackendCatalogModel[] {
  const rows = isObject(body) && Array.isArray(body.data) ? body.data : null;
  if (!rows) throw new Error('the catalog answered in a shape Wanigan does not recognise');

  let filter: RegExp | null = null;
  if (catalog.exclude) {
    try {
      filter = compileExclude(catalog.exclude);
    } catch {
      // Validation refuses an uncompilable filter, so reaching here means one
      // got in another way. Serving the unfiltered list would offer the image
      // and voice models the filter exists to hide, so this fails to the
      // caller's fallback instead.
      throw new Error('this backend’s catalog filter is not a valid pattern');
    }
  }

  const models: BackendCatalogModel[] = [];
  const seen = new Set<string>();
  let sawAnyId = false;

  for (const row of rows) {
    if (!isObject(row)) continue;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id || id.length > MAX_ID_CHARS || seen.has(id)) continue;
    seen.add(id);
    sawAnyId = true;
    if (filter?.test(id)) continue;
    // A name the provider shipped beats a name Wanigan derived from a slug.
    // The label is cosmetic and the id is not, so the id is carried through
    // exactly as the catalog spelled it and only the label is prettified.
    const given = typeof row.display_name === 'string' ? row.display_name.trim() : '';
    const label = given && given.length <= MAX_LABEL_CHARS ? given : prettyModelLabel(id);
    models.push({ id, label, source: 'api' });
    if (models.length >= MAX_MODELS) break;
  }

  if (!models.length) {
    throw new Error(sawAnyId
      ? 'the catalog returned no models a session could launch against'
      : 'the catalog returned no models');
  }
  return models;
}

/**
 * The sentence shown when a fallback list is being served, and why.
 *
 * One sentence for both cases — no key yet, and a read that failed — because
 * the operator's question is the same either way: is this list the backend's or
 * Wanigan's? Its presence is what the fetching half turns into
 * `source: 'published'`, so this string is load-bearing and not decoration.
 */
export function fallbackNote(backendLabel: string, reason: string): string {
  const who = backendLabel.trim() || 'this backend';
  const why = reason.trim() || 'reason not recorded';
  return `Could not read ${who}’s model catalog (${why}), so this is Wanigan’s local fallback list rather than a live read.`;
}
