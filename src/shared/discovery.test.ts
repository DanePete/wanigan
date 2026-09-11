/**
 * Ranking, default selection and remote naming, without a filesystem.
 *
 * The scan itself lives in main/discovery.ts and stays in the smoke suite: it
 * reads real transcripts and a real database, which is exactly what a process
 * test is for. What is here is the part that decides what a person is *told* —
 * which rows appear, which are ticked before anyone touches them, and what a
 * repository is called.
 *
 * Two of the assertions below are regressions found by running the scan over a
 * real machine rather than by reading it. Neither would have appeared in a
 * fixture written from the code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_WINDOW_MS, MIN_CONVERSATIONS_FOR_DEFAULT,
  defaultSelection, discoveryDetail, rankDiscovered, repoSlug,
  type DiscoveredProject,
} from './discovery.ts';

const DAY = 24 * 60 * 60 * 1000;
const now = 1_800_000_000_000;

const candidate = (over: Partial<DiscoveredProject> = {}): DiscoveredProject => ({
  path: '/Users/x/Projects/app', name: 'x/app', remote: 'git@github.com:x/app.git',
  conversations: 9, lastActiveAt: now - DAY, known: false, sources: ['claude'], ...over,
});

test('a managed host writes a server path, not an identity', () => {
  // Pantheon: ssh://…@….drush.in:2222/~/repository.git. The last two segments
  // are `~/repository`, which is not a name — and is the *same* non-name for
  // every site on the account. Four rows on one machine were called that.
  assert.equal(repoSlug('ssh://cs.dev.abc@cs.dev.abc.drush.in:2222/~/repository.git'), null);
  assert.equal(repoSlug('https://host.example/~/repository.git'), null);
  assert.equal(repoSlug('git@github.com:DanePete/wanigan.git'), 'DanePete/wanigan');
  assert.equal(repoSlug('https://gitlab.com/group/thing.git'), 'group/thing');
  assert.equal(repoSlug(null), null);
  assert.equal(repoSlug('origin'), null, 'a nameless remote yields no slug rather than a guess');
});

test('git repositories rank above the rest, then by newest activity', () => {
  const rows = [
    candidate({ path: '/p/plain', remote: null, lastActiveAt: now }),
    candidate({ path: '/p/old', lastActiveAt: now - 40 * DAY }),
    candidate({ path: '/p/fresh', lastActiveAt: now - DAY }),
  ];
  assert.equal(rankDiscovered(rows).map((r) => r.path).join(','), '/p/fresh,/p/old,/p/plain');
});

test('ranking is stable and does not mutate its input', () => {
  const rows = [candidate({ path: '/b' }), candidate({ path: '/a' })];
  const before = rows.map((r) => r.path).join(',');
  rankDiscovered(rows);
  assert.equal(rows.map((r) => r.path).join(','), before);
  // Same recency, so the tie breaks on path and the order is not arbitrary.
  assert.equal(rankDiscovered(rows).map((r) => r.path).join(','), '/a,/b');
});

test('only a recent git repository with real history is ticked for you', () => {
  const selected = defaultSelection([
    candidate({ path: '/p/good' }),
    candidate({ path: '/p/stale', lastActiveAt: now - 40 * DAY }),
    candidate({ path: '/p/thin', conversations: 2 }),
    candidate({ path: '/p/plain', remote: null }),
    candidate({ path: '/p/known', known: true }),
  ], now);
  assert.equal(selected.join(','), '/p/good');
});

test('the two default-selection thresholds are floors, not guesses', () => {
  assert.equal(defaultSelection([candidate({ conversations: MIN_CONVERSATIONS_FOR_DEFAULT })], now).length, 1);
  assert.equal(defaultSelection([candidate({ conversations: MIN_CONVERSATIONS_FOR_DEFAULT - 1 })], now).length, 0);
  assert.equal(defaultSelection([candidate({ lastActiveAt: now - ACTIVE_WINDOW_MS })], now).length, 1);
  assert.equal(defaultSelection([candidate({ lastActiveAt: now - ACTIVE_WINDOW_MS - 1 })], now).length, 0);
});

test('a row explains itself with two observed facts and no score', () => {
  assert.equal(discoveryDetail(candidate({ conversations: 1, lastActiveAt: now }), now),
    '1 conversation · today');
  assert.equal(discoveryDetail(candidate({ conversations: 4, lastActiveAt: now - DAY }), now),
    '4 conversations · yesterday');
  // "last 2 days ago" is what this read on screen before a probe caught it.
  assert.equal(discoveryDetail(candidate({ conversations: 4, lastActiveAt: now - 2 * DAY }), now),
    '4 conversations · 2 days ago');
});

test('a clock that runs backwards never produces a negative age', () => {
  assert.match(discoveryDetail(candidate({ lastActiveAt: now + 5 * DAY }), now), /today$/);
});
