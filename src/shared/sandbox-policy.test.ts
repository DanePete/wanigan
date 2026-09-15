/**
 * The mapping from a setting and a trust level to a sandbox, and the exact
 * block written for Claude Code. The keys are checked by name because a
 * misspelt one is silently ignored by the CLI, and a sandbox that silently did
 * not start is the one failure this module exists to rule out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SANDBOX_SHELL_MODES, claudeSandboxSettings, sandboxApplies } from './sandbox-policy.ts';

test('off sandboxes nothing, below-trusted spares only trusted projects, always sandboxes everything', () => {
  for (const trust of ['readonly', 'project', 'trusted'] as const) assert.equal(sandboxApplies('off', trust), false);
  assert.equal(sandboxApplies('below-trusted', 'readonly'), true);
  assert.equal(sandboxApplies('below-trusted', 'project'), true);
  assert.equal(sandboxApplies('below-trusted', 'trusted'), false);
  for (const trust of ['readonly', 'project', 'trusted'] as const) assert.equal(sandboxApplies('always', trust), true);
  assert.deepEqual([...SANDBOX_SHELL_MODES], ['off', 'below-trusted', 'always']);
});

test('the block fails closed when the sandbox cannot start and ignores a request to run unsandboxed', () => {
  const block = claudeSandboxSettings(['/data/hooks', '/data/mcp', '/data/hooks', '']);
  assert.deepEqual(block, {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    filesystem: { denyRead: ['/data/hooks', '/data/mcp'] },
  });
});
