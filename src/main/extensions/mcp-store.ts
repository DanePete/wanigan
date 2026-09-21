import fs from 'node:fs';
import path from 'node:path';
import { PRIVATE_FILE_MODE, dataDir, ensurePrivateDir } from '../db';
import { EXTENSION_MANIFEST_FILE } from '../../shared/extension-manifest';
import {
  isRegistryName, isRegistryVersion, manifestVersion, parseRegistryPage, translateRegistryEntry,
} from '../../shared/mcp-registry';
import type { StoreEntry, StoreSourceInfo, StoreUpdate } from '../../shared/mcp-registry';
import { normalizeStoreQuery, queryStore, type StoreResults, type StoreSyncResult } from '../../shared/store-query';
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
  return queryStore(index.entries, installed, normalizeStoreQuery(rawQuery), index.syncedAt);
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
