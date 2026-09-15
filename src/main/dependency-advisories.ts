import { db } from './db';
import { getSetting, setSetting } from './settings';
import { dependencyReview } from './review-work';
import {
  ADVISORY_CACHE_MS, ECOSYSTEM_OF, MAX_PACKAGES_PER_CHECK, MAX_PUBLISH_LOOKUPS, PUBLISH_TIME_HOSTS,
  assembleAdvisoryReport, exactVersion, packageKeyString, queryBatchBody, readNpmPublishTime, readPypiPublishTime, readQueryBatch,
  type AdvisoryEcosystem, type AdvisoryReport, type AdvisorySource, type LookupRow, type OsvAnswer, type PackageKey, type PublishRead,
} from '../shared/dependency-advisories';

/**
 * Known advisories for the packages a session added or upgraded — asked of OSV
 * only when the operator presses Check advisories, with the switch in Settings
 * on. Nothing here runs on a timer, on a review refresh or on launch.
 *
 * What leaves the machine is exactly what the Settings text says and no more:
 * one POST of `{ecosystem, name, version}` triples to api.osv.dev, and for npm
 * and PyPI one GET per package to read when that version was published —
 * registry.npmjs.org/<name> and pypi.org/pypi/<name>/<version>/json. No
 * credential, no cookie, no referrer, no redirect followed to anywhere else.
 *
 * The URLs are constants. The smoke suite points them at a loopback stub
 * through `__test`, which refuses outside a smoke run, and no channel lets the
 * renderer name a host: it sends a session id and a boolean, and main reads the
 * packages out of that session's own diff.
 */

const SETTING = 'dependency_advisory_lookup';
export const ADVISORY_ENDPOINTS = {
  osv: 'https://api.osv.dev/v1/querybatch',
  npm: 'https://registry.npmjs.org/',
  pypi: 'https://pypi.org/pypi/',
} as const;
let endpoints: { osv: string; npm: string; pypi: string } = { ...ADVISORY_ENDPOINTS };

const TIMEOUT_MS = 15_000;
let timeoutMs = TIMEOUT_MS;
const MAX_OSV_BODY = 8 * 1024 * 1024;
/** typescript's full npm document is 15.7 MB (measured 2026-09-15); a document past this is not read. */
const MAX_NPM_BODY = 32 * 1024 * 1024;
const MAX_PYPI_BODY = 4 * 1024 * 1024;
const PUBLISH_PARALLEL = 4;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const PYPI_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function advisoryLookupEnabled(): boolean {
  try { return getSetting(SETTING, '0') === '1'; } catch { return false; }
}

export function setAdvisoryLookupEnabled(on: unknown): { enabled: boolean } {
  if (typeof on !== 'boolean') throw new Error('Advisory lookups are either on or off.');
  setSetting(SETTING, on ? '1' : '0');
  return { enabled: advisoryLookupEnabled() };
}

/* ── the network ─────────────────────────────────────────────────────── */

type Fetched = { ok: true; status: number; body: unknown } | { ok: false; reason: string };

async function readCapped(res: Response, max: number, what: string): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > max) throw new Error(`${what} answered with more than ${Math.round(max / 1024 / 1024)} MB, so it was not read`);
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`${what} answered with more than ${Math.round(max / 1024 / 1024)} MB, so it was not read`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8');
}

/**
 * One request, every failure turned into a sentence that says which host and
 * why. A redirect is refused rather than followed: a redirect is a request to
 * somewhere the Settings text did not name.
 */
async function request(url: string, init: { method: 'GET' | 'POST'; body?: string }, what: string, max: number, okStatuses: readonly number[] = [200]): Promise<Fetched> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: init.method,
      body: init.body,
      signal: controller.signal,
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: init.body ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
    });
    if (res.status === 429) {
      const wait = res.headers.get('retry-after');
      await res.body?.cancel().catch(() => {});
      return { ok: false, reason: `${what} is limiting requests (HTTP 429)${wait ? `; it asks to wait ${/^\d+$/.test(wait) ? `${wait} s` : wait}` : ''}. Try again later.` };
    }
    if (!okStatuses.includes(res.status)) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, reason: `${what} answered HTTP ${res.status}` };
    }
    const text = await readCapped(res, max, what);
    try { return { ok: true, status: res.status, body: text ? JSON.parse(text) : null }; }
    catch { return { ok: false, reason: `${what} answered with something that is not JSON` }; }
  } catch (e) {
    if (controller.signal.aborted) return { ok: false, reason: `${what} did not answer within ${timeoutMs >= 1000 ? `${timeoutMs / 1000} s` : `${timeoutMs} ms`}` };
    const message = e instanceof Error ? e.message : String(e);
    // undici reports a refused redirect, a DNS failure or a reset as "fetch
    // failed" and puts the reason in `cause`, which is the part worth showing.
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : '';
    return { ok: false, reason: /answered with more than/.test(message) ? message : `${what} could not be reached (${cause || message})` };
  } finally {
    clearTimeout(timer);
  }
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/* ── the cache ───────────────────────────────────────────────────────── */

type CachedOsv = { at: number; answer: OsvAnswer };
type CachedPublish = { at: number; read: PublishRead };

function cacheGet(source: 'osv' | 'registry', k: PackageKey): { at: number; json: string } | null {
  const row = db().prepare('SELECT checked_at, result_json FROM dependency_lookup_cache WHERE source = ? AND ecosystem = ? AND name = ? AND version = ?')
    .get(source, k.ecosystem, k.name, k.version) as { checked_at: number; result_json: string } | undefined;
  return row ? { at: row.checked_at, json: row.result_json } : null;
}

function cachedOsv(k: PackageKey): CachedOsv | null {
  const hit = cacheGet('osv', k);
  if (!hit) return null;
  try {
    const v = JSON.parse(hit.json) as OsvAnswer;
    // Re-read through the same validator an answer from the network passes.
    const again = readQueryBatch({ results: [{ vulns: v.advisories, ...(v.more ? { next_page_token: 'cached' } : {}) }] }, 1);
    return Array.isArray(again) ? { at: hit.at, answer: again[0] } : null;
  } catch { return null; }
}

function cachedPublish(k: PackageKey): CachedPublish | null {
  const hit = cacheGet('registry', k);
  if (!hit) return null;
  try {
    const v = JSON.parse(hit.json) as { at?: unknown; notRead?: unknown };
    if (typeof v.at === 'number' && Number.isFinite(v.at)) return { at: hit.at, read: { at: v.at } };
    if (typeof v.notRead === 'string') return { at: hit.at, read: { notRead: v.notRead.slice(0, 300) } };
    return null;
  } catch { return null; }
}

function cachePut(source: 'osv' | 'registry', k: PackageKey, at: number, value: unknown): void {
  db().prepare(`INSERT INTO dependency_lookup_cache (source, ecosystem, name, version, checked_at, result_json) VALUES (?,?,?,?,?,?)
    ON CONFLICT(source, ecosystem, name, version) DO UPDATE SET checked_at = excluded.checked_at, result_json = excluded.result_json`)
    .run(source, k.ecosystem, k.name, k.version, at, JSON.stringify(value));
}

/* ── what a session's diff asks about ────────────────────────────────── */

type Candidate = { ecosystem: AdvisoryEcosystem; name: string; version: ReturnType<typeof exactVersion>; sources: AdvisorySource[] };

async function candidatesFor(sessionId: unknown): Promise<{ candidates: Candidate[]; notes: string[] }> {
  const review = await dependencyReview(sessionId, { turns: false });
  const byKey = new Map<string, Candidate>();
  const notes: string[] = [];
  const unreadable = review.manifests.filter((m) => m.error);
  if (unreadable.length) notes.push(`${unreadable.length} manifest${unreadable.length === 1 ? '' : 's'} could not be read, so ${unreadable.length === 1 ? 'its' : 'their'} packages are not in this check: ${unreadable.map((m) => m.path).join(', ')}.`);
  for (const m of review.manifests) {
    if (m.error) continue;
    const ecosystem = ECOSYSTEM_OF[m.kind];
    for (const c of m.changes) {
      if (c.change !== 'added' && c.change !== 'upgraded') continue;
      const version = exactVersion(ecosystem, c.name, c.after);
      const key = `${ecosystem}\x00${c.name}\x00${'exact' in version ? `=${version.exact}` : `~${c.after ?? ''}`}`;
      const source: AdvisorySource = { manifest: m.path, section: c.section, change: c.change, spec: c.after };
      const had = byKey.get(key);
      if (had) had.sources.push(source);
      else byKey.set(key, { ecosystem, name: c.name, version, sources: [source] });
    }
  }
  return { candidates: [...byKey.values()], notes };
}

/* ── the check ───────────────────────────────────────────────────────── */

async function publishTime(k: PackageKey): Promise<{ read: PublishRead } | { failed: string }> {
  if (k.ecosystem === 'npm') {
    if (!NPM_NAME.test(k.name) || k.name.length > 214) return { read: { notRead: 'the name is not one npm accepts, so the registry was not asked' } };
    const path = k.name.startsWith('@') ? `@${encodeURIComponent(k.name.slice(1))}` : encodeURIComponent(k.name);
    const r = await request(`${endpoints.npm}${path}`, { method: 'GET' }, hostOf(endpoints.npm), MAX_NPM_BODY, [200, 404]);
    if (!r.ok) return { failed: r.reason };
    return { read: r.status === 404 ? { notRead: 'the npm registry has no package by this name' } : readNpmPublishTime(r.body, k.version) };
  }
  if (!PYPI_NAME.test(k.name)) return { read: { notRead: 'the name is not one PyPI accepts, so the registry was not asked' } };
  const r = await request(`${endpoints.pypi}${encodeURIComponent(k.name)}/${encodeURIComponent(k.version)}/json`, { method: 'GET' }, hostOf(endpoints.pypi), MAX_PYPI_BODY, [200, 404]);
  if (!r.ok) return { failed: r.reason };
  return { read: r.status === 404 ? { notRead: 'PyPI has no release of this name and version' } : readPypiPublishTime(r.body) };
}

/**
 * The advisory report for a session. `mode: 'cache-only'` reads what earlier
 * checks stored and makes no request at all — it is what the section shows on
 * open, whatever the switch says. `mode: 'lookup'` needs the switch on.
 */
export async function dependencyAdvisories(sessionId: unknown, rawOpts?: unknown): Promise<AdvisoryReport> {
  const opts = (rawOpts && typeof rawOpts === 'object' ? rawOpts : {}) as { lookup?: unknown; refresh?: unknown };
  const lookup = opts.lookup === true;
  const refresh = opts.refresh === true;
  const enabled = advisoryLookupEnabled();
  if (lookup && !enabled) throw new Error('Advisory lookups are off. Turn on “Dependency advisory lookups” in Settings to check.');
  const now = Date.now();
  const { candidates, notes } = await candidatesFor(sessionId);
  const counts = new Map<string, number>();
  const count = (url: string) => counts.set(hostOf(url), (counts.get(hostOf(url)) ?? 0) + 1);

  const exact = candidates.filter((c) => 'exact' in c.version);
  const queryable = exact.slice(0, MAX_PACKAGES_PER_CHECK);
  if (exact.length > queryable.length) notes.push(`${exact.length - queryable.length} packages past the first ${MAX_PACKAGES_PER_CHECK} were not looked up.`);
  const keyOf = (c: Candidate): PackageKey => ({ ecosystem: c.ecosystem, name: c.name, version: 'exact' in c.version ? c.version.exact : '' });

  // Advisories: the cache first, then one batch for everything it did not answer.
  const osv = new Map<string, LookupRow['osv']>();
  const toAsk: PackageKey[] = [];
  for (const c of queryable) {
    const k = keyOf(c);
    const hit = cachedOsv(k);
    if (hit && (!lookup || (!refresh && now - hit.at < ADVISORY_CACHE_MS))) osv.set(packageKeyString(k), { state: 'answered', answer: hit.answer, checkedAt: hit.at, fromCache: true });
    else if (!lookup) osv.set(packageKeyString(k), { state: 'not-asked', reason: 'no check has been run for this version' });
    else toAsk.push(k);
  }
  if (toAsk.length) {
    count(endpoints.osv);
    const r = await request(endpoints.osv, { method: 'POST', body: JSON.stringify(queryBatchBody(toAsk)) }, 'OSV', MAX_OSV_BODY);
    const read = r.ok ? readQueryBatch(r.body, toAsk.length) : { error: r.reason };
    const at = Date.now();
    toAsk.forEach((k, i) => {
      if (Array.isArray(read)) {
        cachePut('osv', k, at, read[i]);
        osv.set(packageKeyString(k), { state: 'answered', answer: read[i], checkedAt: at, fromCache: false });
      } else {
        osv.set(packageKeyString(k), { state: 'failed', reason: read.error });
      }
    });
  }

  // Publish times, for the two registries the Settings text names. A publish
  // time never changes, so a stored one is reused however old it is.
  const publish = new Map<string, LookupRow['publish']>();
  const fetchList: PackageKey[] = [];
  for (const c of queryable) {
    const k = keyOf(c);
    if (!PUBLISH_TIME_HOSTS[c.ecosystem]) { publish.set(packageKeyString(k), { state: 'not-covered' }); continue; }
    const hit = cachedPublish(k);
    if (hit && !(refresh && 'notRead' in hit.read)) {
      publish.set(packageKeyString(k), 'at' in hit.read ? { state: 'read', at: hit.read.at } : { state: 'not-read', reason: hit.read.notRead });
    } else if (!lookup) {
      publish.set(packageKeyString(k), { state: 'not-asked', reason: 'no check has been run for this version' });
    } else if (fetchList.length >= MAX_PUBLISH_LOOKUPS) {
      publish.set(packageKeyString(k), { state: 'not-asked', reason: `past the ${MAX_PUBLISH_LOOKUPS} registry reads one check makes` });
    } else {
      fetchList.push(k);
    }
  }
  for (let i = 0; i < fetchList.length; i += PUBLISH_PARALLEL) {
    await Promise.all(fetchList.slice(i, i + PUBLISH_PARALLEL).map(async (k) => {
      count(k.ecosystem === 'npm' ? endpoints.npm : endpoints.pypi);
      const got = await publishTime(k);
      if ('failed' in got) { publish.set(packageKeyString(k), { state: 'failed', reason: got.failed }); return; }
      cachePut('registry', k, Date.now(), got.read);
      publish.set(packageKeyString(k), 'at' in got.read ? { state: 'read', at: got.read.at } : { state: 'not-read', reason: got.read.notRead });
    }));
  }

  const rows: LookupRow[] = candidates.map((c) => {
    if (!('exact' in c.version)) {
      return { ecosystem: c.ecosystem, name: c.name, version: c.version, sources: c.sources,
        osv: { state: 'not-asked', reason: c.version.notExact }, publish: PUBLISH_TIME_HOSTS[c.ecosystem] ? { state: 'not-asked', reason: c.version.notExact } : { state: 'not-covered' } };
    }
    const k = packageKeyString(keyOf(c));
    return {
      ecosystem: c.ecosystem, name: c.name, version: c.version, sources: c.sources,
      osv: osv.get(k) ?? { state: 'not-asked', reason: `past the first ${MAX_PACKAGES_PER_CHECK} packages` },
      publish: publish.get(k) ?? { state: 'not-asked', reason: `past the first ${MAX_PACKAGES_PER_CHECK} packages` },
    };
  });
  return assembleAdvisoryReport({
    mode: lookup ? 'lookup' : 'cache-only', enabled, now: Date.now(), rows, notes,
    requests: [...counts].map(([host, n]) => ({ host, count: n })),
  });
}

/** The hosts and paths the egress report prints, read from the constants above. */
export function advisoryEgressRows(): { host: string; paths: string[]; purpose: string }[] {
  return [
    { host: hostOf(ADVISORY_ENDPOINTS.osv), paths: [new URL(ADVISORY_ENDPOINTS.osv).pathname],
      purpose: 'Asking OSV for known advisories on the packages a session added or upgraded. Each query is the package ecosystem, name and exact version, and nothing else.' },
    { host: hostOf(ADVISORY_ENDPOINTS.npm), paths: ['/<package name>'],
      purpose: 'Reading when an npm package version a session added was published, so one under 72 hours old can be flagged for review. The request names the package and nothing else.' },
    { host: hostOf(ADVISORY_ENDPOINTS.pypi), paths: ['/pypi/<name>/<version>/json'],
      purpose: 'Reading when a PyPI package version a session added was published, so one under 72 hours old can be flagged for review. The request names the package and version and nothing else.' },
  ];
}

type Handle = <T>(channel: string, fn: (...args: never[]) => T | Promise<T>) => void;

/** The three channels. Each validates in this module; the renderer names a session and a boolean, never a host. */
export function registerDependencyAdvisoryIpc(handle: Handle): void {
  handle('deps:advisorySetting', () => ({ enabled: advisoryLookupEnabled() }));
  handle('deps:setAdvisoryLookup', (on: unknown) => setAdvisoryLookupEnabled(on));
  handle('deps:advisories', (sessionId: unknown, opts: unknown) => dependencyAdvisories(sessionId, opts));
}

/** Smoke only: aim the lookups at a loopback stub, and put them back. Refuses outside a smoke run. */
export const __test = {
  setEndpoints(next: { osv: string; npm: string; pypi: string } | null): void {
    if (process.env.WANIGAN_SMOKE !== '1') throw new Error('Advisory endpoints are fixed outside the smoke suite.');
    endpoints = next ? { ...next } : { ...ADVISORY_ENDPOINTS };
  },
  setTimeoutMs(ms: number | null): void {
    if (process.env.WANIGAN_SMOKE !== '1') throw new Error('The advisory timeout is fixed outside the smoke suite.');
    timeoutMs = ms ?? TIMEOUT_MS;
  },
  clearCache(): void { db().prepare('DELETE FROM dependency_lookup_cache').run(); },
  ageCache(ms: number): void { db().prepare('UPDATE dependency_lookup_cache SET checked_at = checked_at - ?').run(ms); },
};
