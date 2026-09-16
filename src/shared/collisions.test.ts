/**
 * The collision forecast's pure half. Every fixture string below is the exact
 * byte shape git 2.50.1 printed for `merge-tree --write-tree --name-only
 * --no-messages -z` on a scratch repository, captured before this was written:
 * a conflicting pair, a clean pair, and a ref git could not resolve.
 *
 * The subject is "can it lie". A forecast that calls an unanswered question
 * clean, or a git failure a conflict, is worse than no forecast at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPair, gitVersionSupportsMergeTree, nulList, orderPairs, parseMergeTree, peerPairs, sharedPaths,
  type CollisionPair,
} from './collisions.ts';

const TREE = '007c12f57f6ddd2dd22d9a70ff51390ffb5ef638';

test('a conflicting merge names its paths', () => {
  assert.deepEqual(parseMergeTree(`${TREE}\0f.txt\0`, 1), { outcome: 'conflicts', conflicted: ['f.txt'] });
});

test('a clean merge is clean only with a tree id and exit 0', () => {
  assert.deepEqual(parseMergeTree(`${TREE}\0`, 0), { outcome: 'clean', conflicted: [] });
});

test('exit 1 with nothing on stdout is git failing, never a conflict', () => {
  // "merge-tree: deadbeef - not something we can merge" goes to stderr.
  assert.equal(parseMergeTree('', 1).outcome, 'unreadable');
});

test('a timeout or a killed git is unreadable, whatever stdout held', () => {
  assert.equal(parseMergeTree(`${TREE}\0`, null).outcome, 'unreadable');
  assert.equal(parseMergeTree(`${TREE}\0f.txt\0`, 128).outcome, 'unreadable');
});

test('a conflict exit that names no path is not presented as an actionable conflict', () => {
  assert.equal(parseMergeTree(`${TREE}\0`, 1).outcome, 'unreadable');
});

test('paths with spaces and newlines survive the NUL list, and repeats collapse', () => {
  assert.deepEqual(parseMergeTree(`${TREE}\0sp ace.txt\0line\nbreak.md\0sp ace.txt\0`, 1).conflicted,
    ['sp ace.txt', 'line\nbreak.md']);
  assert.deepEqual(nulList('a\0\0b\0'), ['a', 'b']);
});

test('a sha-256 repository tree id is accepted', () => {
  const sha256 = 'a'.repeat(64);
  assert.equal(parseMergeTree(`${sha256}\0`, 0).outcome, 'clean');
});

test('merge-tree --write-tree needs git 2.38 or later', () => {
  assert.equal(gitVersionSupportsMergeTree('git version 2.50.1 (Apple Git-155)'), true);
  assert.equal(gitVersionSupportsMergeTree('git version 2.38.0'), true);
  assert.equal(gitVersionSupportsMergeTree('git version 2.37.9'), false);
  assert.equal(gitVersionSupportsMergeTree('git version 3.0.0'), true);
  assert.equal(gitVersionSupportsMergeTree(''), false);
  assert.equal(gitVersionSupportsMergeTree(null), false);
});

test('overlap is its own outcome: both changed a path and git still merged it', () => {
  const merged = parseMergeTree(`${TREE}\0`, 0);
  assert.deepEqual(classifyPair(merged, ['src/api.ts', 'a.md'], ['src/api.ts', 'b.md']),
    { outcome: 'overlap', conflicted: [], shared: ['src/api.ts'] });
  assert.equal(classifyPair(merged, ['a.md'], ['b.md']).outcome, 'clean');
});

test('shared paths exclude the ones already reported as conflicts', () => {
  const conflict = parseMergeTree(`${TREE}\0f.txt\0`, 1);
  assert.deepEqual(classifyPair(conflict, ['f.txt', 'g.txt'], ['f.txt', 'g.txt']),
    { outcome: 'conflicts', conflicted: ['f.txt'], shared: ['g.txt'] });
  assert.deepEqual(sharedPaths(['b', 'a', 'a'], ['a', 'b'], ['b']), ['a']);
});

test('an unreadable merge stays unreadable even when both change lists were read', () => {
  assert.deepEqual(classifyPair({ outcome: 'unreadable', conflicted: [] }, ['a'], ['a']),
    { outcome: 'unreadable', conflicted: [], shared: [] });
});

test('unknown change lists never manufacture an overlap', () => {
  assert.equal(classifyPair(parseMergeTree(`${TREE}\0`, 0), null, ['a']).outcome, 'clean');
});

test('peer pairs are every unordered pair exactly once', () => {
  assert.deepEqual(peerPairs(3), [[0, 1], [0, 2], [1, 2]]);
  assert.deepEqual(peerPairs(1), []);
  assert.equal(peerPairs(12).length, 66);
});

test('conflicts lead, then what could not be read, then overlaps, then clean pairs', () => {
  const side = { worktree: null, branch: null, sessionId: null };
  const pair = (outcome: CollisionPair['outcome'], kind: CollisionPair['kind']): CollisionPair =>
    ({ kind, a: side, b: side, outcome, conflicted: [], shared: [], detail: null });
  const ordered = orderPairs([pair('clean', 'peer'), pair('overlap', 'base'), pair('conflicts', 'peer'),
    pair('unreadable', 'base'), pair('conflicts', 'base')]);
  assert.deepEqual(ordered.map((p) => `${p.outcome}:${p.kind}`),
    ['conflicts:base', 'conflicts:peer', 'unreadable:base', 'overlap:base', 'clean:peer']);
});
