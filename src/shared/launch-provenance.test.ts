import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envNames, resolveLaunchProvenance, type LaunchProvenanceInput } from './launch-provenance.ts';

const base = (over: Partial<LaunchProvenanceInput> = {}): LaunchProvenanceInput => ({
  origin: 'dialog',
  provider: { label: 'Claude Code', packSource: 'builtin' },
  harness: 'claude-code',
  fields: {
    model: { supported: true, value: 'opus', profileDefault: null },
    effort: { supported: true, value: '', profileDefault: null },
    permissionMode: { supported: true, value: 'acceptEdits', profileDefault: 'acceptEdits' },
  },
  account: { label: 'Work', source: 'project' },
  isolation: { isolated: false, reusedWorktree: false },
  extraArgs: null,
  env: { provider: [], account: 'CLAUDE_CONFIG_DIR', wanigan: ['FORCE_COLOR', 'TERM'] },
  ...over,
});

const by = (rows: ReturnType<typeof resolveLaunchProvenance>, field: string) => rows.find((r) => r.field === field)!;

test('a dialog launch: picked values are the dialog’s, declared defaults are the profile’s, empty is the CLI’s', () => {
  const rows = resolveLaunchProvenance(base());
  assert.equal(by(rows, 'provider').source, 'dialog');
  assert.equal(by(rows, 'model').source, 'dialog');
  assert.equal(by(rows, 'effort').source, 'cli-default');
  assert.equal(by(rows, 'effort').value, null);
  assert.equal(by(rows, 'permissionMode').source, 'provider-profile');
  assert.equal(by(rows, 'account').source, 'project-default');
  assert.equal(by(rows, 'isolation').source, 'app-default');
  assert.equal(by(rows, 'extraArgs').source, 'app-default');
});

test('a local pack’s declared default is attributed to the pack manifest', () => {
  const rows = resolveLaunchProvenance(base({
    provider: { label: 'Local GLM', packSource: 'local', packLabel: 'glm-pack' },
    fields: { ...base().fields, model: { supported: true, value: 'glm-5', profileDefault: 'glm-5' } },
    env: { provider: ['ANTHROPIC_BASE_URL'], account: null, wanigan: [] },
  }));
  assert.equal(by(rows, 'model').source, 'pack-manifest');
  assert.equal(by(rows, 'provider').note, 'from the glm-pack pack');
  assert.equal(by(rows, 'env').source, 'pack-manifest');
  assert.match(by(rows, 'env').value ?? '', /ANTHROPIC_BASE_URL \(pack manifest\)/);
});

test('a resumed conversation carries its values, and Codex restores model and effort itself', () => {
  const claude = resolveLaunchProvenance(base({ origin: 'resume', account: { label: 'Work', source: 'resumed' }, isolation: { isolated: true, reusedWorktree: true } }));
  assert.equal(by(claude, 'model').source, 'resumed');
  assert.equal(by(claude, 'account').source, 'resumed');
  assert.equal(by(claude, 'isolation').source, 'resumed');
  const codex = resolveLaunchProvenance(base({ origin: 'resume', harness: 'codex', fields: { ...base().fields, model: { supported: true, value: null, profileDefault: null } } }));
  assert.equal(by(codex, 'model').source, 'resumed');
  assert.match(by(codex, 'model').note ?? '', /saved thread/);
});

test('a live session launched outside the dialog says so, and unrecorded launches never claim the dialog', () => {
  assert.equal(by(resolveLaunchProvenance(base({ origin: 'renderer' })), 'model').source, 'at-launch');
  assert.equal(by(resolveLaunchProvenance(base({ origin: 'unknown' })), 'model').source, 'unrecorded');
  assert.equal(by(resolveLaunchProvenance(base({ origin: 'unknown' })), 'extraArgs').source, 'unrecorded',
    'a snapshot that never kept extra flags does not claim there were none');
  assert.equal(by(resolveLaunchProvenance(base({ origin: 'unknown', account: { label: 'Personal', source: 'default' } })), 'account').source, 'app-default');
});

test('an unsupported field and an account that does not apply are said, not blank', () => {
  const rows = resolveLaunchProvenance(base({
    fields: { ...base().fields, effort: { supported: false, value: null, profileDefault: null } },
    account: { label: null, source: 'none', reason: 'GLM authenticates with its own key' },
  }));
  assert.equal(by(rows, 'effort').source, 'not-applicable');
  assert.equal(by(rows, 'account').note, 'GLM authenticates with its own key');
});

test('environment is names only', () => {
  assert.deepEqual(envNames({ Z_KEY: 'secret', A: '1', 'bad name': 'x' }), ['A', 'Z_KEY']);
  const rows = resolveLaunchProvenance(base({ env: { provider: envNames({ ANTHROPIC_AUTH_TOKEN: 'sk-live-123' }), account: null, wanigan: [] } }));
  assert.equal(JSON.stringify(rows).includes('sk-live-123'), false);
});
