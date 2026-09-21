/** Searching, sorting and filtering the store's local index. Pure; no network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STORE_QUERY, normalizeStoreQuery, queryStore, type StoreQuery } from './store-query.ts';
import type { StoreEntry, StoreInstall } from './mcp-registry.ts';

let seq = 0;
const entry = (over: Partial<StoreEntry> & { install?: StoreInstall } = {}): StoreEntry => {
  seq += 1;
  const name = over.name ?? `com.acme/server-${seq}`;
  return {
    sourceId: 'k', name, namespace: name.slice(0, name.indexOf('/')), title: `Server ${seq}`,
    description: '', version: '1.0.0', installsAs: '1.0.0', extensionId: `mcp.${name.replace('/', '.')}`,
    install: { kind: 'npm', runtime: 'npx', package: 'x', version: '1.0.0' }, asks: [], deprecated: false,
    publishedAt: 1_000, updatedAt: 1_000, websiteUrl: null, repositoryUrl: null, ...over,
  };
};
const q = (over: Partial<StoreQuery> = {}): StoreQuery => ({ ...DEFAULT_STORE_QUERY, ...over });
const names = (r: { entries: StoreEntry[] }) => r.entries.map((e) => e.name);
const none = new Map<string, string>();

test('with no search, best match is simply the most recently updated first', () => {
  const old = entry({ name: 'com.a/old', updatedAt: 100 });
  const recent = entry({ name: 'com.a/recent', updatedAt: 900 });
  const middle = entry({ name: 'com.a/middle', updatedAt: 500 });
  assert.deepEqual(names(queryStore([old, recent, middle], none, q(), 5)), ['com.a/recent', 'com.a/middle', 'com.a/old']);
  assert.deepEqual(names(queryStore([old, recent, middle], none, q({ sort: 'updated' }), 5)), ['com.a/recent', 'com.a/middle', 'com.a/old']);
});

test('name sorts by title, case-blind', () => {
  const r = queryStore([entry({ title: 'zeta' }), entry({ title: 'Alpha' }), entry({ title: 'beta' })], none, q({ sort: 'name' }), null);
  assert.deepEqual(r.entries.map((e) => e.title), ['Alpha', 'beta', 'zeta']);
});

test('every word must match, and a title hit outranks a description hit', () => {
  const inTitle = entry({ name: 'com.a/pg', title: 'Postgres tools' });
  const inDescription = entry({ name: 'com.a/db', title: 'Database kit', description: 'Talks to postgres and mysql.', updatedAt: 9_999 });
  const neither = entry({ name: 'com.a/fs', title: 'Files' });
  const r = queryStore([inDescription, neither, inTitle], none, q({ text: 'postgres' }), null);
  // The description hit is newer, and still ranks second: best match means the words, not the date.
  assert.deepEqual(names(r), ['com.a/pg', 'com.a/db']);
  assert.equal(queryStore([inTitle, inDescription], none, q({ text: 'postgres mysql' }), null).total, 1);
  assert.equal(queryStore([inTitle], none, q({ text: 'POSTGRES' }), null).total, 1);
});

test('an exact registry name or title wins outright, however common its words', () => {
  // Hundreds of servers say "mcp"; newer ones would otherwise outrank the one asked for.
  const noise = Array.from({ length: 50 }, (_, i) => entry({ name: `com.n${i}/mcp-${i}`, title: `MCP thing ${i}`, updatedAt: 10_000 + i }));
  const wanted = entry({ name: 'ac.inference.sh/mcp', title: 'inference.sh', updatedAt: 1 });
  assert.equal(queryStore([...noise, wanted], none, q({ text: 'ac.inference.sh/mcp' }), null).entries[0]!.name, 'ac.inference.sh/mcp');
  assert.equal(queryStore([...noise, wanted], none, q({ text: 'Inference.sh' }), null).entries[0]!.name, 'ac.inference.sh/mcp');
});

test('what is not installable, and what is deprecated, is hidden by default and counted', () => {
  const ok = entry();
  const sse = entry({ install: { kind: 'unsupported', reason: 'SSE' } });
  const old = entry({ deprecated: true });
  const shown = queryStore([ok, sse, old], none, q(), null);
  assert.deepEqual(names(shown), [ok.name]);
  assert.equal(shown.facets.unsupported, 1);
  assert.equal(shown.facets.deprecated, 1);
  assert.equal(queryStore([ok, sse, old], none, q({ everything: true, deprecated: true }), null).total, 3);
});

test('filters combine: any value within a group, every group across them', () => {
  const npx = entry({ install: { kind: 'npm', runtime: 'npx', package: 'a', version: '1.0.0' }, name: 'io.github.dane/a' });
  const uvx = entry({ install: { kind: 'pypi', runtime: 'uvx', package: 'b', version: '1.0.0' } });
  const hosted = entry({ install: { kind: 'remote', url: 'https://mcp.acme.example' }, asks: [] });
  const secret = entry({ asks: ['TOKEN'] });
  const all = [npx, uvx, hosted, secret];

  assert.equal(queryStore(all, none, q({ runs: ['hosted'] }), null).total, 1);
  assert.equal(queryStore(all, none, q({ runs: ['local'] }), null).total, 3);
  assert.equal(queryStore(all, none, q({ runtimes: ['npx', 'uvx'] }), null).total, 3);
  assert.equal(queryStore(all, none, q({ runtimes: ['uvx'] }), null).total, 1);
  assert.deepEqual(names(queryStore(all, none, q({ publishers: ['github'] }), null)), [npx.name]);
  // No setup: asks for nothing at install.
  assert.equal(queryStore(all, none, q({ noSetup: true }), null).total, 3);
  // Across groups every group must hold.
  assert.equal(queryStore(all, none, q({ runs: ['local'], runtimes: ['uvx'] }), null).total, 1);
  assert.equal(queryStore(all, none, q({ runs: ['hosted'], runtimes: ['npx'] }), null).total, 0);
});

test('installed and update-available are read against what is installed', () => {
  const current = entry({ installsAs: '2.0.0' });
  const stale = entry({ installsAs: '3.0.0' });
  const fresh = entry();
  const installed = new Map([[current.extensionId, '2.0.0'], [stale.extensionId, '2.9.0']]);
  const r = queryStore([current, stale, fresh], installed, q(), null);
  assert.deepEqual(r.facets.states, { installed: 1, update: 1, 'not-installed': 1 });
  assert.deepEqual(names(queryStore([current, stale, fresh], installed, q({ states: ['update'] }), null)), [stale.name]);
});

test('facet counts describe what choosing that filter would show', () => {
  const hosted = entry({ install: { kind: 'remote', url: 'https://a.example' } });
  const local = entry();
  const r = queryStore([hosted, local], none, q({ runs: ['hosted'] }), null);
  // Counted before the facet filters apply, so choosing "local" next is not a surprise.
  assert.deepEqual(r.facets.runs, { local: 1, hosted: 1 });
  assert.equal(r.total, 1);
});

test('paging slices the sorted result and reports the whole', () => {
  const many = Array.from({ length: 45 }, (_, i) => entry({ updatedAt: i }));
  const first = queryStore(many, none, q({ limit: 30 }), 7);
  assert.equal(first.entries.length, 30);
  assert.equal(first.total, 45);
  assert.equal(first.catalogSize, 45);
  assert.equal(first.syncedAt, 7);
  assert.equal(queryStore(many, none, q({ limit: 30, offset: 30 }), 7).entries.length, 15);
});

test('a query from the renderer is normalised, never trusted', () => {
  const n = normalizeStoreQuery({
    text: `  ${'x'.repeat(500)}  `, sort: 'popularity', runs: ['hosted', 'rootkit', 'hosted'],
    runtimes: 'npx', noSetup: 'yes', offset: -5, limit: 10_000, extra: true,
  });
  assert.equal(n.text.length, 200);
  // A sort that does not exist falls back rather than inventing an order.
  assert.equal(n.sort, 'best');
  assert.deepEqual(n.runs, ['hosted']);
  assert.deepEqual(n.runtimes, []);
  assert.equal(n.noSetup, false);
  assert.equal(n.offset, 0);
  assert.equal(n.limit, 100);
  assert.deepEqual(normalizeStoreQuery(null), DEFAULT_STORE_QUERY);
});

test('most downloaded ranks by npm weekly downloads, and never ranks a missing count as zero', () => {
  const big = entry({ name: 'com.a/big', install: { kind: 'npm', runtime: 'npx', package: 'big', version: '1.0.0' } });
  const small = entry({ name: 'com.a/small', install: { kind: 'npm', runtime: 'npx', package: 'small', version: '1.0.0' } });
  const zero = entry({ name: 'com.a/zero', install: { kind: 'npm', runtime: 'npx', package: 'zero', version: '1.0.0' } });
  const hosted = entry({ name: 'com.a/hosted', install: { kind: 'remote', url: 'https://h.example' }, updatedAt: 9_999 });
  const unread = entry({ name: 'com.a/unread', install: { kind: 'npm', runtime: 'npx', package: 'unread', version: '1.0.0' } });
  const counts = new Map([['big', 500_000], ['small', 1_200], ['zero', 0]]);
  const r = queryStore([hosted, unread, small, zero, big], none, q({ sort: 'downloads' }), null, counts);
  // A real zero is still a count, so it ranks above entries that have none.
  assert.deepEqual(names(r).slice(0, 3), ['com.a/big', 'com.a/small', 'com.a/zero']);
  assert.deepEqual(new Set(names(r).slice(3)), new Set(['com.a/hosted', 'com.a/unread']));
  // The page carries the counts it shows, and nothing for entries without one.
  assert.deepEqual(r.downloads, { 'com.a/big': 500_000, 'com.a/small': 1_200, 'com.a/zero': 0 });
  assert.equal(normalizeStoreQuery({ sort: 'downloads' }).sort, 'downloads');
});
