import type { StoreEntry } from './mcp-registry.ts';

/**
 * Searching, sorting and filtering the store's local catalog index.
 *
 * Pure, and run in the main process against the index it keeps on disk: the
 * registry's API has no sort parameter and pages alphabetically, so any order
 * other than A–Z — and any filter across the whole catalog rather than one page
 * of it — needs every entry in hand. Holding them here also means a search never
 * leaves this machine.
 *
 * Every sort and filter is built from a fact the catalog actually publishes.
 * There is no popularity or rating here because the registry publishes neither,
 * and a number ranked as if it were observed, when it was not, is the one thing
 * this app refuses to show.
 */

export const STORE_SORTS = ['best', 'updated', 'name'] as const;
export const STORE_RUNS = ['local', 'hosted'] as const;
export const STORE_RUNTIMES = ['npx', 'uvx', 'docker'] as const;
export const STORE_PUBLISHERS = ['github', 'domain'] as const;
export const STORE_STATES = ['installed', 'update', 'not-installed'] as const;

export type StoreSort = typeof STORE_SORTS[number];
export type StoreRuns = typeof STORE_RUNS[number];
export type StoreRuntime = typeof STORE_RUNTIMES[number];
export type StorePublisher = typeof STORE_PUBLISHERS[number];
export type StoreState = typeof STORE_STATES[number];

export type StoreQuery = {
  text: string;
  sort: StoreSort;
  /** Within a group any value matches; across groups every group must. Empty means any. */
  runs: StoreRuns[];
  runtimes: StoreRuntime[];
  publishers: StorePublisher[];
  states: StoreState[];
  /** Only entries that ask the operator for nothing at install. */
  noSetup: boolean;
  /** Include entries Wanigan cannot install yet, each with its reason. */
  everything: boolean;
  /** Include entries their publisher marked deprecated. */
  deprecated: boolean;
  offset: number;
  limit: number;
};

export type StoreFacets = {
  runs: Record<StoreRuns, number>;
  runtimes: Record<StoreRuntime, number>;
  publishers: Record<StorePublisher, number>;
  states: Record<StoreState, number>;
  noSetup: number;
  /** Matching the search but not installable — hidden unless `everything`. */
  unsupported: number;
  /** Matching the search but deprecated — hidden unless `deprecated`. */
  deprecated: number;
};

/** What one sync of the local index did. */
export type StoreSyncResult = {
  syncedAt: number;
  /** Entries in the index afterwards. */
  size: number;
  /** Entries read and written this time: the whole catalog on a first sync, only what changed after. */
  changed: number;
  removed: number;
  full: boolean;
};

export type StoreResults = {
  entries: StoreEntry[];
  /** Matching every filter, before paging. */
  total: number;
  facets: StoreFacets;
  /** Every entry in the local index, whatever the query. */
  catalogSize: number;
  /** When the index last finished syncing; null before the first sync. */
  syncedAt: number | null;
};

const MAX_TEXT = 200;
const MAX_LIMIT = 100;

export const DEFAULT_STORE_QUERY: StoreQuery = {
  text: '', sort: 'best', runs: [], runtimes: [], publishers: [], states: [],
  noSetup: false, everything: false, deprecated: false, offset: 0, limit: 30,
};

function pick<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is T => (allowed as readonly unknown[]).includes(v)))];
}

function whole(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** A query from the renderer, untrusted: anything unrecognised becomes the default rather than an error. */
export function normalizeStoreQuery(raw: unknown): StoreQuery {
  const q = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const sort = (STORE_SORTS as readonly unknown[]).includes(q.sort) ? q.sort as StoreSort : DEFAULT_STORE_QUERY.sort;
  return {
    text: typeof q.text === 'string' ? q.text.trim().slice(0, MAX_TEXT) : '',
    sort,
    runs: pick(q.runs, STORE_RUNS),
    runtimes: pick(q.runtimes, STORE_RUNTIMES),
    publishers: pick(q.publishers, STORE_PUBLISHERS),
    states: pick(q.states, STORE_STATES),
    noSetup: q.noSetup === true,
    everything: q.everything === true,
    deprecated: q.deprecated === true,
    offset: whole(q.offset, 0, 0, 1_000_000),
    limit: whole(q.limit, DEFAULT_STORE_QUERY.limit, 1, MAX_LIMIT),
  };
}

export function runsOf(entry: StoreEntry): StoreRuns | null {
  if (entry.install.kind === 'remote') return 'hosted';
  if (entry.install.kind === 'unsupported') return null;
  return 'local';
}

export function publisherOf(entry: StoreEntry): StorePublisher {
  return /^io\.github\./i.test(entry.namespace) ? 'github' : 'domain';
}

export function stateOf(entry: StoreEntry, installed: ReadonlyMap<string, string>): StoreState {
  const version = installed.get(entry.extensionId);
  if (version === undefined) return 'not-installed';
  return version === entry.installsAs ? 'installed' : 'update';
}

function when(entry: StoreEntry): number {
  return entry.updatedAt ?? entry.publishedAt ?? 0;
}

function byName(a: StoreEntry, b: StoreEntry): number {
  return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name);
}

/**
 * How well an entry answers the words typed. Every word must appear somewhere;
 * a word in the title outranks one in the name, which outranks the publisher,
 * which outranks the description. Zero means no match.
 *
 * An exact registry name or title wins outright. Tens of thousands of servers
 * have "mcp" in their name, so a person who pasted `ac.inference.sh/mcp` must not
 * find it ranked by date among every other server that says "mcp".
 */
function score(entry: StoreEntry, words: string[]): number {
  if (!words.length) return 1;
  const title = entry.title.toLowerCase();
  const name = entry.name.toLowerCase();
  const leaf = name.slice(name.indexOf('/') + 1);
  const namespace = entry.namespace.toLowerCase();
  const description = entry.description.toLowerCase();
  const phrase = words.join(' ');
  if (name === phrase || title === phrase) return 1_000;
  let total = name.includes(phrase) && phrase.length > 2 ? 20 : 0;
  for (const word of words) {
    let best = 0;
    if (title.startsWith(word) || leaf.startsWith(word)) best = 8;
    else if (title.includes(word)) best = 5;
    else if (leaf.includes(word)) best = 4;
    else if (namespace.includes(word)) best = 2;
    else if (description.includes(word)) best = 1;
    if (!best) return 0;
    total += best;
  }
  return total;
}

function zero<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
}

export function queryStore(
  entries: readonly StoreEntry[],
  installed: ReadonlyMap<string, string>,
  query: StoreQuery,
  syncedAt: number | null,
): StoreResults {
  const words = query.text.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = new Map<StoreEntry, number>();
  const matched: StoreEntry[] = [];
  for (const entry of entries) {
    const s = score(entry, words);
    if (s > 0) { scored.set(entry, s); matched.push(entry); }
  }

  const facets: StoreFacets = {
    runs: zero(STORE_RUNS), runtimes: zero(STORE_RUNTIMES), publishers: zero(STORE_PUBLISHERS),
    states: zero(STORE_STATES), noSetup: 0, unsupported: 0, deprecated: 0,
  };
  for (const entry of matched) {
    if (entry.install.kind === 'unsupported') facets.unsupported += 1;
    if (entry.deprecated) facets.deprecated += 1;
  }

  // The two gates that hide by default, applied before the facets are counted:
  // a count beside a filter must describe what choosing that filter would show.
  const base = matched.filter((e) =>
    (query.everything || e.install.kind !== 'unsupported') && (query.deprecated || !e.deprecated));
  for (const entry of base) {
    const runs = runsOf(entry);
    if (runs) facets.runs[runs] += 1;
    if (entry.install.kind === 'npm' || entry.install.kind === 'pypi' || entry.install.kind === 'oci') {
      facets.runtimes[entry.install.runtime] += 1;
    }
    facets.publishers[publisherOf(entry)] += 1;
    facets.states[stateOf(entry, installed)] += 1;
    if (entry.asks.length === 0 && entry.install.kind !== 'unsupported') facets.noSetup += 1;
  }

  const filtered = base.filter((e) => {
    const runs = runsOf(e);
    if (query.runs.length && (!runs || !query.runs.includes(runs))) return false;
    if (query.runtimes.length) {
      const runtime = e.install.kind === 'npm' || e.install.kind === 'pypi' || e.install.kind === 'oci' ? e.install.runtime : null;
      if (!runtime || !query.runtimes.includes(runtime)) return false;
    }
    if (query.publishers.length && !query.publishers.includes(publisherOf(e))) return false;
    if (query.states.length && !query.states.includes(stateOf(e, installed))) return false;
    if (query.noSetup && (e.asks.length > 0 || e.install.kind === 'unsupported')) return false;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (query.sort === 'name') return byName(a, b);
    if (query.sort === 'best' && words.length) {
      const d = (scored.get(b) ?? 0) - (scored.get(a) ?? 0);
      if (d) return d;
    }
    return when(b) - when(a) || byName(a, b);
  });

  return {
    entries: sorted.slice(query.offset, query.offset + query.limit),
    total: sorted.length,
    facets,
    catalogSize: entries.length,
    syncedAt,
  };
}
