import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderInfo } from './types.ts';
import { executionForSchedule, requireScheduledExecution, validateScheduledExecution } from './scheduled-execution.ts';

const provider = (patch: Partial<ProviderInfo> = {}): ProviderInfo => ({
  id: 'local.team/agent', label: 'Team agent', bin: 'agent', path: '/fixture/agent', version: '1',
  profileFingerprint: 'profile-one', backendId: 'local.team/backend',
  supports: { model: false, effort: false, permissionMode: false, resume: false },
  capabilities: { probed: true, hooks: false, telemetry: false, mcp: false, policy: true, transcript: false,
    namedResume: false, headlessJson: true, headlessBudget: true, note: null }, ...patch,
});
const pinned = { executionVersion: 1, providerId: 'local.team/agent', providerProfileFingerprint: 'profile-one' };

test('saving unattended work requires an explicit profile identity', () => {
  for (const payload of [null, {}, { providerId: 'local.team/agent' }, { ...pinned, providerId: '' },
    { ...pinned, providerProfileFingerprint: ' ' }, { ...pinned, executionVersion: 2 }]) {
    assert.throws(() => requireScheduledExecution(payload));
  }
  assert.deepEqual(requireScheduledExecution(pinned), { providerId: 'local.team/agent', providerProfileFingerprint: 'profile-one' });
});

test('save validation refuses missing, changed and incapable profiles without picking another', () => {
  for (const profiles of [[], [provider({ id: 'other' })], [provider({ profileFingerprint: 'profile-two' })],
    [provider({ path: null })], [provider({ capabilities: { ...provider().capabilities, headlessJson: false } })],
    [provider({ launchFields: [{ id: 'model', label: 'Model', kind: 'select', required: true }] })]]) {
    assert.throws(() => validateScheduledExecution(pinned, profiles));
  }
  assert.equal(validateScheduledExecution(pinned, [provider({ id: 'other' }), provider()]).id, pinned.providerId);
});

test('untouched legacy schedules disclose runtime selection; malformed pinned records fail closed', () => {
  assert.equal(executionForSchedule({ prompt: 'read' }, [provider()]).state, 'legacy');
  assert.equal(executionForSchedule({ providerId: 'old-id' }, [provider()]).state, 'legacy');
  assert.equal(executionForSchedule({ executionVersion: 1 }, [provider()]).state, 'blocked');
  assert.equal(executionForSchedule({ ...pinned, providerId: null }, [provider()]).state, 'blocked');
  assert.equal(executionForSchedule(pinned, null).state, 'unread');
  assert.equal(executionForSchedule(pinned, []).state, 'blocked');
});

test('readiness and budget describe the selected protocol, never the first provider', () => {
  const uncapped = provider({ capabilities: { ...provider().capabilities, headlessBudget: false } });
  const state = executionForSchedule(pinned, [provider({ id: 'other' }), uncapped]);
  assert.equal(state.state, 'available');
  assert.equal(state.provider?.capabilities.headlessBudget, false);
  assert.equal(executionForSchedule(pinned, [provider({ profileFingerprint: 'changed' })]).state, 'blocked');
});
