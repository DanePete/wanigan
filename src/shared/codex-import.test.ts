/**
 * The Claude → Codex import request and reply. The completed notification and
 * ledger fixtures are the exact shapes Codex 0.154.0 wrote when a synthetic
 * transcript was imported into a temporary CODEX_HOME (paths shortened).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importRefusal, isMethodMissing, ledgerThreadFor, parseImportCompleted, sessionImportRequest } from './codex-import.ts';

test('the request carries one SESSIONS item and nothing else a Claude setup could smuggle in', () => {
  const req = sessionImportRequest({ transcriptPath: '/h/.claude/projects/-w/abc.jsonl', cwd: '/w', title: null });
  assert.equal(req.migrationItems.length, 1);
  const [item] = req.migrationItems;
  assert.equal(item.itemType, 'SESSIONS');
  assert.deepEqual(item.details.sessions, [{ path: '/h/.claude/projects/-w/abc.jsonl', cwd: '/w', title: null }]);
  for (const key of ['plugins', 'skills', 'mcpServers', 'hooks', 'subagents', 'commands'] as const) {
    assert.deepEqual(item.details[key], [], key);
  }
  assert.equal('memory' in item.details, false);
  assert.equal(JSON.stringify(req).includes('CONFIG'), false);
});

const COMPLETED = {
  importId: 'ad2913b3-e21a-4069-ac1a-96841ce271a8',
  itemTypeResults: [{
    itemType: 'SESSIONS',
    successes: [{ itemType: 'SESSIONS', cwd: '/w', source: '/h/.claude/projects/-w/abc.jsonl', target: '01a0a306-3969-7dc3-8943-59b0c21bbca1', title: 'Add a README line saying hello.' }],
    failures: [],
  }],
};

test('a completed import names its thread from successes[].target', () => {
  assert.deepEqual(parseImportCompleted(COMPLETED, COMPLETED.importId),
    { ok: true, threadId: '01a0a306-3969-7dc3-8943-59b0c21bbca1', title: 'Add a README line saying hello.' });
  assert.equal(parseImportCompleted(COMPLETED, 'another-import'), null, 'another import’s notification is not ours');
});

test('a failure is reported with Codex’s own words and never becomes a thread', () => {
  const failed = {
    importId: 'x',
    itemTypeResults: [{ itemType: 'SESSIONS', successes: [], failures: [{ itemType: 'SESSIONS', errorType: null, subErrorType: 'session_not_detected', failureStage: 'session_missing', message: 'external agent session was not detected for import: /elsewhere/abc.jsonl' }] }],
  };
  const out = parseImportCompleted(failed, 'x');
  assert.equal(out?.ok, false);
  assert.match(out && !out.ok ? out.failures[0] : '', /session_missing: session_not_detected: external agent session was not detected/);
  assert.deepEqual(parseImportCompleted({ importId: 'x', itemTypeResults: [] }, 'x'), { ok: false, failures: ['Codex reported no imported thread and no reason.'] });
  assert.equal(parseImportCompleted({ importId: 'x', itemTypeResults: [{ itemType: 'SESSIONS', successes: [{ target: 'not-a-uuid' }], failures: [] }] }, 'x')?.ok, false);
});

test('the ledger confirms the thread for the exact source path, newest first', () => {
  const ledger = JSON.stringify({
    records: [
      { source_path: '/h/.claude/projects/-w/abc.jsonl', content_sha256: 'aa', imported_thread_id: '11111111-1111-4111-8111-111111111111', imported_at: 10 },
      { source_path: '/h/.claude/projects/-w/abc.jsonl', content_sha256: 'bb', imported_thread_id: '01a0a306-3969-7dc3-8943-59b0c21bbca1', imported_at: 20 },
      { source_path: '/h/.claude/projects/-w/other.jsonl', imported_thread_id: '22222222-2222-4222-8222-222222222222', imported_at: 30 },
    ],
    detected_connector_records: [],
  });
  assert.equal(ledgerThreadFor(ledger, '/h/.claude/projects/-w/abc.jsonl'), '01a0a306-3969-7dc3-8943-59b0c21bbca1');
  assert.equal(ledgerThreadFor(ledger, '/nope.jsonl'), null);
  assert.equal(ledgerThreadFor('not json', '/h'), null);
  assert.equal(ledgerThreadFor('{}', '/h'), null);
});

test('only a transcript under $HOME/.claude/projects is importable, and the refusal says why', () => {
  assert.equal(importRefusal('/Users/d/.claude/projects/-w/abc.jsonl', '/Users/d/.claude/projects'), null);
  assert.match(importRefusal('/Users/d/claude-work/projects/-w/abc.jsonl', '/Users/d/.claude/projects') ?? '', /does not read CLAUDE_CONFIG_DIR/);
  assert.match(importRefusal('/Users/d/.claude/projects-evil/abc.jsonl', '/Users/d/.claude/projects') ?? '', /Unsupported/);
  assert.equal(importRefusal('/Users/d/.claude/projects/-w/abc.txt', '/Users/d/.claude/projects'), 'That file is not a Claude Code transcript.');
});

test('a missing method is recognised as an older Codex', () => {
  assert.equal(isMethodMissing({ code: -32601, message: 'Method not found' }), true);
  assert.equal(isMethodMissing({ code: -32000 }), false);
  assert.equal(isMethodMissing(null), false);
});
