/**
 * Cost by cause, the pure half. Each cause is held to its own definition and
 * to the edge that would overstate it: a rewrite larger than what was cached,
 * a read run that a write should have reset, a server whose calls arrive under
 * a normalised name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheMissReasonOf, idleGapRewrites, mcpServerOf, repeatedReads, unusedMcpServers } from './cost-causes.ts';

const min = 60_000;

test('a cache write after a five-minute gap is attributed, capped at the previous cached footprint', () => {
  const rows = idleGapRewrites([
    { conversation: 'c', at: 0, cacheRead: 10_000, cacheWrite: 2_000, sidechain: false },
    { conversation: 'c', at: 2 * min, cacheRead: 12_000, cacheWrite: 500, sidechain: false },
    { conversation: 'c', at: 9 * min, cacheRead: 0, cacheWrite: 40_000, sidechain: false },
  ]);
  assert.deepEqual(rows, [{ conversation: 'c', gaps: 1, cappedTokens: 12_500, uncappedTokens: 40_000, longestGapMs: 7 * min }]);
});

test('a gap with no cache write, a short gap, and a subagent request are not causes', () => {
  assert.deepEqual(idleGapRewrites([
    { conversation: 'c', at: 0, cacheRead: 1, cacheWrite: 1, sidechain: false },
    { conversation: 'c', at: 20 * min, cacheRead: 100, cacheWrite: 0, sidechain: false },
    { conversation: 'c', at: 21 * min, cacheRead: 100, cacheWrite: 50, sidechain: false },
    { conversation: 'c', at: 40 * min, cacheRead: 0, cacheWrite: 900, sidechain: true },
  ]), []);
});

test('a read run is reset by a write to the same file, and only runs past two count', () => {
  const e = (at: number, tool: string, p = '/r/a.ts', sessionId = 's') => ({ sessionId, at, tool, paths: [p] });
  assert.deepEqual(repeatedReads([e(1, 'Read'), e(2, 'Read'), e(3, 'Edit'), e(4, 'Read'), e(5, 'Read')]), []);
  assert.deepEqual(repeatedReads([e(1, 'Read'), e(2, 'Read'), e(3, 'Bash'), e(4, 'Read'), e(5, 'Read', '/r/b.ts')]),
    [{ sessionId: 's', path: '/r/a.ts', reads: 3 }]);
  assert.deepEqual(repeatedReads([e(1, 'Read', '/r/a.ts', 's1'), e(2, 'Read', '/r/a.ts', 's2'), e(3, 'Read', '/r/a.ts', 's1')]), []);
});

test('MCP servers with no calls in the window are listed, matched on a normalised name', () => {
  const now = 100 * 24 * 60 * min;
  const since = now - 14 * 24 * 60 * min;
  const servers = [
    { id: '1', name: 'github', enabled: true, createdAt: 0 },
    { id: '2', name: 'my-docs', enabled: true, createdAt: 0 },
    { id: '3', name: 'off', enabled: false, createdAt: 0 },
    { id: '4', name: 'stale', enabled: true, createdAt: 0 },
  ];
  const calls = [
    { tool: 'mcp__github__create_issue', at: now - min },
    { tool: 'mcp__my_docs__search', at: now - 2 * min },
    { tool: 'mcp__stale__x', at: since - min },
  ];
  assert.deepEqual(unusedMcpServers(servers, calls, since).map((s) => [s.name, s.lastCalledAt]), [['stale', since - min]]);
  assert.equal(mcpServerOf('mcp__plugin_x__tool'), 'plugin_x');
  assert.equal(mcpServerOf('Read'), null);
});

test('cache-miss reasons are read from message.diagnostics, the path a real 2.1.271 transcript carries', () => {
  assert.deepEqual(cacheMissReasonOf('{"type":"assistant","message":{"diagnostics":{"cache_miss_reason":{"type":"unavailable"}}}}'), { type: 'unavailable', missedTokens: null });
  assert.deepEqual(cacheMissReasonOf('{"message":{"diagnostics":{"cache_miss_reason":{"type":"tools_changed","cache_missed_input_tokens":4100}}}}'), { type: 'tools_changed', missedTokens: 4100 });
  assert.equal(cacheMissReasonOf('{"message":{"content":"cache_miss_reason in prose"}}'), null);
  assert.equal(cacheMissReasonOf('not json cache_miss_reason'), null);
});
