import { catalogUrl, fallbackNote, modelsFromCatalogBody } from '../../shared/backend-catalog';
import type { BackendCatalogManifest, BackendCatalogModel } from '../../shared/backend-catalog';

/**
 * One model catalog reader for every backend that has one.
 *
 * The half that opens a socket. `glm.ts`, `deepseek.ts` and `xai.ts` each held
 * their own copy of this — same TTL, same abort, same bearer header, same
 * cache-the-failure-too behaviour — and each copy was a place the honesty rule
 * could drift independently. Everything that is a decision lives in
 * `src/shared/backend-catalog.ts`, where it is tested in under a second; what
 * is left here is `fetch`, a clock and a bounded map.
 *
 * THE INVARIANT: `note === null` if and only if `source === 'live'`. `source`
 * is never assigned — `readOf` derives both fields from the one stored note, so
 * there is no code path that can call a fallback list a live read. That is the
 * lie this module exists to make impossible, and `launch-choices.ts` states the
 * same rule from the other side: it reports `live` only when the note is null.
 *
 * Nothing here throws. A missing key and a failed read both return the pack's
 * declared fallback list with a note saying which, because a picker that opens
 * with an explanation beats a rejection crossing IPC into an empty dialog.
 */

/** Six hours: long enough that opening the launch dialog is free, short enough to see a new model the day it ships. */
const TTL_MS = 6 * 3600_000;

/** A launch dialog is waiting on this read. Twelve seconds is the point past which a person has already given up. */
const TIMEOUT_MS = 12_000;

/**
 * A cap, because a long-lived app with many installed packs would otherwise
 * grow this map for the life of the process. Eviction is oldest-write-first and
 * costs a single catalog read on the next open, which is the cheapest thing in
 * this file.
 */
const MAX_CACHED_BACKENDS = 64;

export type BackendCatalogRead = {
  models: BackendCatalogModel[];
  note: string | null;
  fetchedAt: number | null;
  source: 'live' | 'published';
};

type Entry = { at: number; models: BackendCatalogModel[]; note: string | null };

const cache = new Map<string, Entry>();

/**
 * The one place a read is shaped, and so the one place the invariant lives.
 *
 * `fetchedAt` is when this list came off the backend, which means it is null
 * whenever the list is a fallback. The three originals returned the cache
 * timestamp on a cached miss, which dated Wanigan's own list as if the backend
 * had handed it over at that moment.
 */
function readOf(entry: Entry): BackendCatalogRead {
  return {
    models: entry.models,
    note: entry.note,
    fetchedAt: entry.note ? null : entry.at,
    source: entry.note ? 'published' : 'live',
  };
}

function remember(backendId: string, entry: Entry): Entry {
  cache.delete(backendId);
  cache.set(backendId, entry);
  while (cache.size > MAX_CACHED_BACKENDS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return entry;
}

const errText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The pack's declared list, marked as what it is. Never the API's. */
function fallbackModels(catalog: BackendCatalogManifest): BackendCatalogModel[] {
  return catalog.fallback.map((model) => ({ id: model.id, label: model.label, source: 'fallback' as const }));
}

/**
 * One catalog request. Rejects; every caller in this file catches.
 *
 * The timeout is cleared in `finally`, which is where two of the three
 * originals had it; the third cleared it only once `fetch` had resolved, so a
 * rejected request left a timer armed for the full twelve seconds.
 */
async function read(catalog: BackendCatalogManifest, token: string | null): Promise<BackendCatalogModel[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(catalogUrl(catalog, process.env), { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return modelsFromCatalogBody(catalog, await response.json());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * This backend's models, live where that is possible and honest where it is not.
 *
 * A failed read is cached alongside its note, deliberately: without that, every
 * open of the launch dialog re-attempts a catalog that is down, and each attempt
 * costs the operator twelve seconds of a spinner.
 *
 * `credential` is a callback rather than a string so that a cache hit never
 * touches the keychain, and so the key is read at the moment it is needed
 * rather than held by whoever assembled this call.
 */
export async function backendModels(input: {
  backendId: string;
  backendLabel: string;
  catalog: BackendCatalogManifest;
  credential: () => string | null;
  force?: boolean;
}): Promise<BackendCatalogRead> {
  const { backendId, backendLabel, catalog } = input;
  const cached = cache.get(backendId);
  if (!input.force && cached && Date.now() - cached.at < TTL_MS) return readOf(cached);

  let token: string | null = null;
  if (catalog.auth?.source === 'credential') {
    try {
      token = input.credential()?.trim() || null;
    } catch {
      // A keychain that will not open is a missing key as far as this read is
      // concerned, and is reported as one rather than as a crash.
      token = null;
    }
    if (!token) {
      // Not cached, unlike the failed read below. This answer opens no socket,
      // so it costs nothing to give again — and remembering it would hide the
      // key an operator saves next from the launch dialog for six hours, with
      // the "no key is set yet" entry still answering for a key that is set.
      return readOf({
        at: Date.now(),
        models: fallbackModels(catalog),
        note: fallbackNote(backendLabel, 'no key is set yet'),
      });
    }
  }

  try {
    return readOf(remember(backendId, { at: Date.now(), models: await read(catalog, token), note: null }));
  } catch (error) {
    return readOf(remember(backendId, {
      at: Date.now(),
      models: fallbackModels(catalog),
      note: fallbackNote(backendLabel, errText(error)),
    }));
  }
}

/**
 * Validate a key before it is persisted, against the same catalog sessions will use.
 *
 * Not the same call as `backendModels`: this one has to be able to fail, and
 * loudly, because a key that is being saved is the one moment an operator can
 * still fix it. A success seeds the cache, so the picker they open next is
 * already the live list.
 */
export async function verifyBackendCredential(input: {
  backendId: string;
  backendLabel: string;
  catalog: BackendCatalogManifest;
  key: string;
}): Promise<{ ok: boolean; detail: string; models: BackendCatalogModel[] }> {
  const { backendId, backendLabel, catalog } = input;
  const token = input.key.trim();
  if (!token) return { ok: false, detail: `No ${backendLabel} API key is set.`, models: [] };
  try {
    const models = await read(catalog, token);
    remember(backendId, { at: Date.now(), models, note: null });
    return {
      ok: true,
      detail: `${models.length} ${backendLabel} model${models.length === 1 ? '' : 's'} available.`,
      models,
    };
  } catch (error) {
    // Rejected-or-unreachable, said as one thing, because an HTTP status and a
    // DNS failure are indistinguishable from here and guessing between them
    // would send somebody to replace a key that was fine.
    return { ok: false, detail: `${backendLabel} rejected the key or could not be reached (${errText(error)}).`, models: [] };
  }
}

/**
 * Drop a backend's cached catalog — for an uninstalled pack or a changed key.
 *
 * A pack that is disabled must not keep answering for six hours, and a new key
 * has to be given the chance to succeed where the old one's failure is still
 * cached.
 */
export function forgetBackendCatalog(backendId: string): void {
  cache.delete(backendId);
}
