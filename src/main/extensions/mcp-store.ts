import fs from 'node:fs';
import path from 'node:path';
import { PRIVATE_FILE_MODE, dataDir, ensurePrivateDir } from '../db';
import { EXTENSION_MANIFEST_FILE } from '../../shared/extension-manifest';
import {
  isRegistryName, isRegistryVersion, manifestVersion, parseRegistryPage, translateRegistryEntry,
} from '../../shared/mcp-registry';
import type { StoreEntry, StoreSourceInfo, StoreUpdate } from '../../shared/mcp-registry';
import {
  STORE_DOWNLOADS_FRESH_MS, STORE_NPM_REQUESTS_PER_SECOND, normalizeStoreQuery, npmPackageOf, queryStore,
  type StoreDownloadsStatus, type StoreResults, type StoreSyncResult,
} from '../../shared/store-query';
import { enabledStoreSources, listExtensions } from './store';

/**
 * The store: browsing the catalogs installed extensions declare, and staging one
 * entry as an extension directory for the ordinary installer to read.
 *
 * This module never installs anything. `stageStoreEntry` writes a manifest into
 * a directory Wanigan owns and returns its path; the caller registers that path
 * as one the installer may read, and from there it is exactly a folder the
 * operator picked — the same `inspectExtension`, the same consent screen, the
 * same digest the operator approves by clicking. A store that installed by its
 * own path would be a second installer, and a second installer is the one that
 * stops being reviewed.
 *
 * Every request here is listed in the egress report (egress.ts), derived from
 * the same `enabledStoreSources()` this reads, so the privacy panel cannot fall
 * behind what the store actually contacts.
 */

const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
/** The registry's own maximum. Fewer, larger pages: a first sync is one request per hundred servers. */
const SYNC_PAGE_SIZE = 100;
/*
 * A runaway guard, not a size target. The official registry held 33,782 current
 * servers on 2026-09-21 and grows by over a hundred a day, so the guard sits far
 * above it: a sync that hits it never records a watermark, which would turn every
 * later open into a full re-read.
 */
const MAX_SYNC_PAGES = 2_000;
/** Re-read a little before the last sync, so an entry published during it is not missed. */
const SYNC_OVERLAP_MS = 5 * 60_000;
const PROVENANCE_FILE = 'registry-entry.json';
const INDEX_SCHEMA = 1;

type Provenance = { sourceKey: string; name: string; version: string; stagedAt: number };

function stagingRoot(): string {
  return ensurePrivateDir(path.join(dataDir(), 'mcp-store', 'staged'));
}

function sourceFor(key: unknown) {
  if (typeof key !== 'string' || !key || key.length > 200) throw new Error('Choose a catalog to browse.');
  const found = enabledStoreSources().find((entry) => entry.key === key);
  // Unknown and disabled read the same on purpose: either way nothing is fetched.
  if (!found) throw new Error('That catalog is not available. Its extension may have been switched off or removed.');
  if (found.source.format !== 'mcp-registry') throw new Error(`Wanigan cannot read a "${found.source.format}" catalog.`);
  return found;
}

export function storeSources(): StoreSourceInfo[] {
  return enabledStoreSources().map(({ key, extensionId, source }) => {
    let host = source.url;
    try { host = new URL(source.url).host; } catch { host = source.url; }
    return { key, extensionId, label: source.label, description: source.description, publisher: source.publisher, host };
  });
}

/* ── the one request shape ───────────────────────────────────────────── */

async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_CATALOG_BYTES) throw new Error('The catalog response was larger than Wanigan will read.');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_CATALOG_BYTES) {
        await reader.cancel();
        throw new Error('The catalog response was larger than Wanigan will read.');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * GET-only, credential-free, https-only, bounded. Redirects are refused, as
 * Scout refuses them, so the catalog a manifest declared cannot hand the request
 * to a host the operator never consented to.
 */
async function getJson(url: URL): Promise<unknown> {
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('A catalog must be an https address with no credentials in it.');
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
      headers: { accept: 'application/json', 'user-agent': 'Wanigan-Store/0.1 (+local; no-credentials)' },
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new Error(timedOut ? `${url.host} did not answer within 12 seconds.` : `${url.host} could not be reached.`);
  }
  if (response.status === 404) throw new Error('The catalog has no such entry. It may have been withdrawn.');
  if (!response.ok) throw new Error(`${url.host} returned HTTP ${response.status}.`);
  if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('json')) {
    throw new Error(`${url.host} did not return JSON.`);
  }
  const text = await boundedText(response);
  try { return JSON.parse(text) as unknown; } catch { throw new Error(`${url.host} returned JSON Wanigan could not read.`); }
}

function pageUrl(base: string, cursor: string | null, since: number | null): URL {
  const url = new URL(base);
  url.searchParams.set('version', 'latest');
  url.searchParams.set('limit', String(SYNC_PAGE_SIZE));
  if (since !== null) url.searchParams.set('updated_since', new Date(since).toISOString());
  if (cursor) url.searchParams.set('cursor', cursor);
  return url;
}

function versionUrl(base: string, name: string, version: string): URL {
  const url = new URL(base);
  url.search = '';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
  return url;
}

/* ── the local index ─────────────────────────────────────────────────── */

/*
 * The registry pages A–Z and has no sort parameter, so every order but that one,
 * and every filter across the whole catalog, needs the entries in hand. The index
 * is the whole catalog's current versions, read once and then kept current with
 * `updated_since` — which is also what makes searching private: the words typed
 * into the store are matched here and never sent anywhere.
 */
type Index = { schema: number; sourceKey: string; url: string; syncedAt: number | null; entries: StoreEntry[] };

const indexes = new Map<string, Index>();
const syncing = new Map<string, Promise<StoreSyncResult>>();

function indexFile(key: string): string {
  return path.join(ensurePrivateDir(path.join(dataDir(), 'mcp-store')), `index-${key.replace(/[^A-Za-z0-9.-]+/g, '_')}.json`);
}

function loadIndex(key: string, url: string): Index {
  const held = indexes.get(key);
  if (held && held.url === url) return held;
  let index: Index = { schema: INDEX_SCHEMA, sourceKey: key, url, syncedAt: null, entries: [] };
  try {
    const read = JSON.parse(fs.readFileSync(indexFile(key), 'utf8')) as Partial<Index>;
    // A different schema, or a catalog that has since moved to another address,
    // starts over rather than mixing two catalogs' entries under one key.
    if (read.schema === INDEX_SCHEMA && read.sourceKey === key && read.url === url && Array.isArray(read.entries)) {
      index = { schema: INDEX_SCHEMA, sourceKey: key, url, syncedAt: typeof read.syncedAt === 'number' ? read.syncedAt : null, entries: read.entries };
    }
  } catch { /* no index yet, or unreadable: a full sync rebuilds it */ }
  indexes.set(key, index);
  return index;
}

function saveIndex(index: Index): void {
  const file = indexFile(index.sourceKey);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(index), { mode: PRIVATE_FILE_MODE });
  fs.renameSync(temp, file);
}

async function runSync(key: string): Promise<StoreSyncResult> {
  const { source } = sourceFor(key);
  const index = loadIndex(key, source.url);
  const started = Date.now();
  const full = index.syncedAt === null;
  const since = full ? null : index.syncedAt! - SYNC_OVERLAP_MS;
  const byName = new Map(index.entries.map((e) => [e.name, e]));
  let changed = 0;
  let removed = 0;
  let cursor: string | null = null;
  for (let pages = 0; pages < MAX_SYNC_PAGES; pages += 1) {
    const page = parseRegistryPage(await getJson(pageUrl(source.url, cursor, since)), key);
    for (const entry of page.entries) { byName.set(entry.name, entry); changed += 1; }
    for (const name of page.withdrawn) if (byName.delete(name)) removed += 1;
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  // Only a sync that reached the end moves the watermark. One that stopped part
  // way leaves `syncedAt` where it was, so the next one re-reads what this missed.
  const next: Index = { ...index, entries: [...byName.values()], syncedAt: cursor ? index.syncedAt : started };
  indexes.set(key, next);
  saveIndex(next);
  return { syncedAt: next.syncedAt ?? started, size: next.entries.length, changed, removed, full };
}

/** Bring the local index up to date. Concurrent calls for one catalog share a single sync. */
export function syncStore(key: unknown): Promise<StoreSyncResult> {
  const { key: sourceKey } = sourceFor(key);
  const running = syncing.get(sourceKey);
  if (running) return running;
  const job = runSync(sourceKey).finally(() => syncing.delete(sourceKey));
  syncing.set(sourceKey, job);
  return job;
}

/** Search, sort and filter the local index. No request leaves this machine. */
export function queryStoreIndex(key: unknown, rawQuery: unknown): StoreResults {
  const { key: sourceKey, source } = sourceFor(key);
  const index = loadIndex(sourceKey, source.url);
  const installed = new Map(listExtensions().map((x) => [x.id, x.version]));
  return queryStore(index.entries, installed, normalizeStoreQuery(rawQuery), index.syncedAt, downloadCounts());
}

/* ── npm download counts ─────────────────────────────────────────────── */

/*
 * The one popularity signal that is actually published: npm's own weekly
 * download counts. The registry publishes none, and this only covers npm
 * packages, so "Most downloaded" ranks the entries it has a count for and lists
 * the rest after them rather than as zero.
 *
 * It is a second host, and a slow one. npm's bulk endpoint refuses scoped names,
 * so a full read is one request per 128 unscoped packages and one per scoped
 * package — over four thousand for the official registry — and npm allows one
 * machine about forty-five a minute. So nothing here runs until the operator
 * asks in the store, having been told that; requests are paced to npm's rate
 * rather than retried into it; and every package records when it was read, so a
 * read interrupted by quitting resumes instead of starting over.
 */
const NPM_DOWNLOADS = 'https://api.npmjs.org/downloads/point/last-week/';
const DOWNLOADS_SCHEMA = 2;
const BULK_NAMES = 128;
const DOWNLOAD_WORKERS = 2;
/** npm's burst allowance, spent before pacing begins. */
const NPM_BURST = 40;
/*
 * Pacing adapts rather than stalls. npm answers a refusal with Retry-After: 0,
 * so the wait is Wanigan's own: each consecutive refusal doubles a short pause
 * and widens the gap between requests, and a run of successes narrows it again.
 * An earlier fixed thirty-second pause on any refusal froze every worker at
 * npm's marginal rate, where an occasional refusal is normal.
 */
const MIN_GAP_MS = 700;
const MAX_GAP_MS = 8_000;
const FIRST_PAUSE_MS = 5_000;
const MAX_PAUSE_MS = 60_000;
const SPEED_UP_AFTER = 20;
const MAX_ATTEMPTS = 12;
const SAVE_EVERY_MS = 5_000;
const RATE_WINDOW_MS = 120_000;

type DownloadsCache = {
  schema: number;
  /** When every package was last read within the freshness window: the read as a whole. */
  fetchedAt: number | null;
  counts: Record<string, number>;
  /** When each package was last read, so an interrupted read resumes. */
  readAt: Record<string, number>;
};

let downloadsCache: DownloadsCache | null = null;
let downloadsMap: Map<string, number> | null = null;
let downloadsRun: StoreDownloadsStatus = { phase: 'idle', done: 0, total: 0, requests: 0, fetchedAt: null, error: null, pausedUntil: null, observedPerSecond: null };

function downloadsFile(): string {
  return path.join(ensurePrivateDir(path.join(dataDir(), 'mcp-store')), 'npm-downloads.json');
}

function numbers(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [name, n] of Object.entries(value as Record<string, unknown>)) {
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) out[name] = n;
  }
  return out;
}

function loadDownloads(): DownloadsCache {
  if (downloadsCache) return downloadsCache;
  let cache: DownloadsCache = { schema: DOWNLOADS_SCHEMA, fetchedAt: null, counts: {}, readAt: {} };
  try {
    const read = JSON.parse(fs.readFileSync(downloadsFile(), 'utf8')) as Partial<DownloadsCache>;
    if (read.schema === DOWNLOADS_SCHEMA) {
      cache = {
        schema: DOWNLOADS_SCHEMA,
        fetchedAt: typeof read.fetchedAt === 'number' ? read.fetchedAt : null,
        counts: numbers(read.counts),
        readAt: numbers(read.readAt),
      };
    }
  } catch { /* none read yet */ }
  downloadsCache = cache;
  return cache;
}

function saveDownloads(cache: DownloadsCache): void {
  downloadsCache = cache;
  downloadsMap = null;
  const file = downloadsFile();
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(cache), { mode: PRIVATE_FILE_MODE });
  fs.renameSync(temp, file);
}

function downloadCounts(): Map<string, number> {
  downloadsMap ??= new Map(Object.entries(loadDownloads().counts));
  return downloadsMap;
}

/** Every npm package any enabled catalog's index installs. Names were checked against npm's own rules on the way in. */
function npmPackages(): string[] {
  const names = new Set<string>();
  for (const { key, source } of enabledStoreSources()) {
    for (const entry of loadIndex(key, source.url).entries) {
      const pkg = npmPackageOf(entry);
      if (pkg) names.add(pkg);
    }
  }
  return [...names].sort();
}

/** What a read still has to ask for: every package not read within the freshness window. */
function readPlan(packages: string[], cache: DownloadsCache, now: number) {
  const stale = packages.filter((p) => !(cache.readAt[p] !== undefined && now - cache.readAt[p]! < STORE_DOWNLOADS_FRESH_MS));
  const scoped = stale.filter((p) => p.startsWith('@'));
  const plain = stale.filter((p) => !p.startsWith('@'));
  const bulk: string[][] = [];
  for (let i = 0; i < plain.length; i += BULK_NAMES) bulk.push(plain.slice(i, i + BULK_NAMES));
  return { stale, scoped, bulk, requests: bulk.length + scoped.length };
}

export function storeDownloadsStatus(): StoreDownloadsStatus {
  if (downloadsRun.phase === 'running') return downloadsRun;
  const packages = npmPackages();
  const cache = loadDownloads();
  const planned = readPlan(packages, cache, Date.now());
  return {
    ...downloadsRun,
    done: packages.length - planned.stale.length,
    total: packages.length,
    requests: planned.requests,
    fetchedAt: cache.fetchedAt,
    pausedUntil: null,
    observedPerSecond: null,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/*
 * One pace for every worker. Slots are claimed synchronously before any await,
 * so two workers can never take the same one; a refusal from npm pushes the next
 * slot out for everyone rather than letting the others keep knocking.
 */
let burstLeft = 0;
let nextSlot = 0;
let gapMs = 1000 / STORE_NPM_REQUESTS_PER_SECOND;
let streak = 0;
let refusals = 0;
async function takeSlot(): Promise<void> {
  if (burstLeft > 0) { burstLeft -= 1; return; }
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + gapMs;
  if (at > now) await sleep(at - now);
}

function paced(ok: boolean): void {
  if (ok) {
    refusals = 0;
    streak += 1;
    if (streak >= SPEED_UP_AFTER) { streak = 0; gapMs = Math.max(MIN_GAP_MS, gapMs * 0.9); }
    if (downloadsRun.pausedUntil !== null && Date.now() >= downloadsRun.pausedUntil) downloadsRun = { ...downloadsRun, pausedUntil: null };
    return;
  }
  streak = 0;
  refusals += 1;
  burstLeft = 0;
  gapMs = Math.min(MAX_GAP_MS, gapMs * 1.5);
  const until = Date.now() + Math.min(MAX_PAUSE_MS, FIRST_PAUSE_MS * 2 ** (refusals - 1));
  nextSlot = Math.max(nextSlot, until);
  downloadsRun = { ...downloadsRun, pausedUntil: nextSlot };
}

/** One npm request, paced. A refusal slows the pace and retries; 404 is "no such package". */
async function npmJson(url: URL): Promise<unknown> {
  for (let attempt = 1; ; attempt += 1) {
    await takeSlot();
    const response = await fetch(url, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: { accept: 'application/json', 'user-agent': 'Wanigan-Store/0.1 (+local; no-credentials)' },
    });
    if (response.status === 429 && attempt < MAX_ATTEMPTS) { paced(false); continue; }
    if (response.status !== 429) paced(true);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`api.npmjs.org returned HTTP ${response.status}.`);
    try { return JSON.parse(await boundedText(response)) as unknown; } catch { throw new Error('api.npmjs.org returned JSON Wanigan could not read.'); }
  }
}

function countFrom(value: unknown): number | null {
  const n = value && typeof value === 'object' ? (value as { downloads?: unknown }).downloads : undefined;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

async function runDownloads(packages: string[]): Promise<void> {
  const cache = loadDownloads();
  const planned = readPlan(packages, cache, Date.now());
  const counts: Record<string, number> = { ...cache.counts };
  const readAt: Record<string, number> = { ...cache.readAt };
  const wanted = new Set(packages);
  downloadsRun = {
    phase: 'running', done: packages.length - planned.stale.length, total: packages.length,
    requests: planned.requests, fetchedAt: cache.fetchedAt, error: null, pausedUntil: null, observedPerSecond: null,
  };
  // The burst covers the bulk requests only. Scoped singles start paced, so the
  // first of them does not land on a limiter the bulk answers just filled.
  burstLeft = Math.min(NPM_BURST, planned.bulk.length);
  nextSlot = 0;
  gapMs = 1000 / STORE_NPM_REQUESTS_PER_SECOND;
  streak = 0;
  refusals = 0;
  type Job = { names: string[]; bulk: boolean };
  // Bulk first: four thousand unscoped counts arrive in a few dozen requests,
  // so the ranking is useful within seconds while the scoped ones trickle in.
  const jobs: Job[] = [...planned.bulk.map((names) => ({ names, bulk: true })), ...planned.scoped.map((name) => ({ names: [name], bulk: false }))];
  let next = 0;
  let failures = 0;
  let savedAt = Date.now();
  const answered: number[] = [];
  const persist = () => saveDownloads({ schema: DOWNLOADS_SCHEMA, fetchedAt: loadDownloads().fetchedAt, counts, readAt });
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      try {
        // Names are npm names Wanigan validated, so none contains a comma or a
        // character that needs escaping; a scoped name keeps its slash.
        const body = await npmJson(new URL(`${NPM_DOWNLOADS}${job.names.join(',')}`));
        const at = Date.now();
        for (const name of job.names) {
          const n = job.bulk ? countFrom(body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : null) : countFrom(body);
          if (n !== null) counts[name] = n; else delete counts[name];
          readAt[name] = at;
        }
        answered.push(Date.now());
        while (answered.length && answered[0]! < Date.now() - RATE_WINDOW_MS) answered.shift();
        const span = answered.length > 1 ? (answered[answered.length - 1]! - answered[0]!) / 1000 : 0;
        downloadsRun = {
          ...downloadsRun,
          done: Math.min(packages.length, downloadsRun.done + job.names.length),
          requests: Math.max(0, downloadsRun.requests - 1),
          // Only once there is a minute of evidence: a rate from a handful of
          // requests would promise a finish time the next refusal breaks.
          observedPerSecond: span >= 60 ? (answered.length - 1) / span : downloadsRun.observedPerSecond,
        };
      } catch {
        failures += 1;
      }
      // Every bulk answer is thousands of counts, so it is saved at once; singles
      // are saved every few seconds. Quitting then loses seconds, not the read.
      if (job.bulk || Date.now() - savedAt >= SAVE_EVERY_MS) { savedAt = Date.now(); persist(); }
    }
  };
  await Promise.all(Array.from({ length: DOWNLOAD_WORKERS }, worker));
  for (const name of Object.keys(counts)) if (!wanted.has(name)) delete counts[name];
  for (const name of Object.keys(readAt)) if (!wanted.has(name)) delete readAt[name];
  // The read as a whole is fresh only when nothing is left unread; otherwise it
  // keeps what it got and the next read picks up the rest.
  const complete = failures === 0;
  saveDownloads({ schema: DOWNLOADS_SCHEMA, fetchedAt: complete ? Date.now() : loadDownloads().fetchedAt, counts, readAt });
  downloadsRun = complete
    ? { ...downloadsRun, phase: 'done', done: packages.length, requests: 0, fetchedAt: loadDownloads().fetchedAt, error: null, pausedUntil: null }
    : { ...downloadsRun, phase: 'error', fetchedAt: loadDownloads().fetchedAt,
      error: `${failures} of ${jobs.length} requests to api.npmjs.org failed. Everything read so far is kept; read again to fill in the rest.` };
}

/** Start reading npm download counts, if one is not already running. Returns at once; poll the status. */
export function startStoreDownloads(): StoreDownloadsStatus {
  if (downloadsRun.phase === 'running') return downloadsRun;
  const packages = npmPackages();
  if (!packages.length) throw new Error('No catalog lists an npm package to count downloads for.');
  void runDownloads(packages).catch((error: unknown) => {
    downloadsRun = { ...downloadsRun, phase: 'error', error: error instanceof Error ? error.message : String(error) };
  });
  return downloadsRun;
}

/* ── stage ───────────────────────────────────────────────────────────── */

/**
 * Fetch one exact version, translate it, and write it out as an extension
 * directory. The renderer supplies a name and a version, never a manifest: the
 * bytes the operator is about to approve are the bytes the catalog returned to
 * this process, translated here.
 */
export async function stageStoreEntry(key: unknown, name: unknown, version: unknown): Promise<string> {
  const { source } = sourceFor(key);
  if (!isRegistryName(name)) throw new Error('That is not a server name the catalog publishes.');
  if (version !== 'latest' && !isRegistryVersion(version)) throw new Error('That is not a version the catalog publishes.');

  const raw = await getJson(versionUrl(source.url, name, version));
  const translated = translateRegistryEntry(raw, String(key));
  if (!translated.ok) throw new Error(translated.reason);
  // What came back must be what was asked for. A catalog answering a request for
  // one server with another is either broken or lying, and either way the
  // consent screen would describe something the operator did not choose.
  if (translated.entry.name !== name || (version !== 'latest' && translated.entry.version !== version)) {
    throw new Error('The catalog answered with a different server than the one requested.');
  }

  const { manifest, entry } = translated;
  // Both segments are safe as directory names by construction: the id and the
  // manifest version match patterns with no slash and no leading dot.
  const dir = ensurePrivateDir(path.join(stagingRoot(), manifest.id, manifest.version));
  fs.writeFileSync(path.join(dir, EXTENSION_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
  const provenance: Provenance = { sourceKey: String(key), name: entry.name, version: entry.version, stagedAt: Date.now() };
  fs.writeFileSync(path.join(dir, PROVENANCE_FILE), `${JSON.stringify(provenance, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
  pruneStaged(manifest.id, dir);
  return dir;
}

/**
 * Drop staged versions of one extension that nothing points at: not the one
 * just written, and not the one an installed extension still reads from.
 */
function pruneStaged(extensionId: string, keep: string): void {
  const parent = path.join(stagingRoot(), extensionId);
  const installed = listExtensions().find((x) => x.id === extensionId)?.sourcePath;
  const held = new Set([path.resolve(keep), installed ? path.resolve(installed) : '']);
  let children: string[] = [];
  try { children = fs.readdirSync(parent); } catch { return; }
  for (const child of children) {
    const full = path.resolve(parent, child);
    if (!held.has(full)) fs.rmSync(full, { recursive: true, force: true });
  }
}

/* ── updates ─────────────────────────────────────────────────────────── */

function readProvenance(sourcePath: string): Provenance | null {
  const root = path.resolve(stagingRoot());
  const dir = path.resolve(sourcePath);
  // Only a directory this module staged. An extension a person installed from
  // their own folder is theirs, whatever its id looks like.
  if (!dir.startsWith(`${root}${path.sep}`)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, PROVENANCE_FILE), 'utf8')) as Record<string, unknown>;
    const { sourceKey, name, version, stagedAt } = value;
    if (typeof sourceKey !== 'string' || !isRegistryName(name) || !isRegistryVersion(version)) return null;
    return { sourceKey, name, version, stagedAt: typeof stagedAt === 'number' ? stagedAt : 0 };
  } catch { return null; }
}

/**
 * Installed store extensions that have a newer version in the local index. This
 * only reports: an update is a new command, so it goes back through the consent
 * screen and a fresh approval like a first install. Applying it here, unseen,
 * would be exactly the change underneath an approval that digest trust exists
 * to prevent. It reads the index the last sync left, so checking costs no
 * request of its own.
 */
export function storeUpdates(): StoreUpdate[] {
  const sources = new Map(enabledStoreSources().map((entry) => [entry.key, entry]));
  const updates: StoreUpdate[] = [];
  for (const x of listExtensions()) {
    if (x.origin !== 'folder' || !x.sourcePath) continue;
    const provenance = readProvenance(x.sourcePath);
    const source = provenance ? sources.get(provenance.sourceKey) : undefined;
    // A catalog that is switched off is not consulted, not even from its index.
    if (!provenance || !source) continue;
    const latest = loadIndex(source.key, source.source.url).entries.find((e) => e.name === provenance.name);
    if (latest && latest.installsAs !== x.version && latest.installsAs !== manifestVersion(provenance.version)) {
      updates.push({
        sourceKey: source.key, extensionId: x.id, name: provenance.name, title: x.label,
        installed: provenance.version, latest: latest.version,
      });
    }
  }
  return updates;
}
