/**
 * `codex doctor --json` parsing. The fixture is Codex 0.154.0's report for a
 * fresh CODEX_HOME with no login, three of its twenty-three checks kept and
 * their details removed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doctorFlagMissing, parseCodexDoctor } from './codex-doctor.ts';

const UNAUTHENTICATED = JSON.stringify({
  schemaVersion: 1, generatedAt: '1789441426s since unix epoch', overallStatus: 'fail', codexVersion: '0.154.0',
  checks: {
    'auth.credentials': { id: 'auth.credentials', category: 'auth', status: 'fail', summary: 'no Codex credentials were found', details: {}, remediation: 'Run codex login or provide an API key through a supported auth env var.', durationMs: 0 },
    'config.load': { id: 'config.load', category: 'config', status: 'ok', summary: 'config loaded', details: {}, remediation: null, durationMs: 0 },
    'network.websocket_reachability': { id: 'network.websocket_reachability', category: 'websocket', status: 'warning', summary: 'Responses WebSocket failed; HTTPS fallback may still work', details: {}, remediation: 'Check proxy, VPN, firewall, DNS, custom CA, and WebSocket policy support.', durationMs: 296 },
  },
});

test('the unauthenticated report names its failing check and its warning', () => {
  const report = parseCodexDoctor(UNAUTHENTICATED);
  assert.equal(report.state, 'report');
  if (report.state !== 'report') return;
  assert.equal(report.overall, 'fail');
  assert.equal(report.codexVersion, '0.154.0');
  assert.equal(report.checks.length, 3);
  assert.deepEqual(report.failing.map((c) => c.id), ['auth.credentials']);
  assert.match(report.failing[0].remediation ?? '', /codex login/);
  assert.deepEqual(report.warnings.map((c) => c.id), ['network.websocket_reachability']);
});

test('a report with everything ok has no failing checks, and says so only because it was readable', () => {
  const ok = JSON.stringify({ schemaVersion: 1, overallStatus: 'ok', codexVersion: '0.154.0', checks: { 'config.load': { id: 'config.load', status: 'ok', summary: 'config loaded' } } });
  const report = parseCodexDoctor(ok);
  assert.equal(report.state === 'report' && report.failing.length === 0 && report.overall === 'ok', true);
});

test('empty, non-JSON, a new schema version and malformed checks are unreadable with a reason', () => {
  assert.deepEqual(parseCodexDoctor(''), { state: 'unreadable', reason: 'codex doctor printed nothing.' });
  assert.equal(parseCodexDoctor('Codex doctor\n✓ config').state, 'unreadable');
  assert.match((parseCodexDoctor(JSON.stringify({ schemaVersion: 2, checks: {} })) as { reason: string }).reason, /schemaVersion 2/);
  assert.match((parseCodexDoctor(JSON.stringify({ schemaVersion: 1, checks: { x: { status: 'ok' } } })) as { reason: string }).reason, /"x"/);
  assert.match((parseCodexDoctor(JSON.stringify({ schemaVersion: 1, checks: {} })) as { reason: string }).reason, /no checks/);
  assert.equal(parseCodexDoctor('[]').state, 'unreadable');
});

test('an older Codex without --json is recognised from its own error', () => {
  assert.equal(doctorFlagMissing("error: unexpected argument '--json' found\n\nUsage: codex doctor"), true);
  assert.equal(doctorFlagMissing("error: unexpected argument '--bogus' found"), false);
});
