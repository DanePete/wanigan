import { test } from 'node:test';
import assert from 'node:assert/strict';
import { permissionActionsFor, permissionInputFor } from './session-permissions.ts';

test('Claude sessions expose the native mode cycle and permission rules', () => {
  assert.deepEqual(permissionActionsFor('claude-code').map((item) => item.id), ['cycle', 'manage']);
  assert.equal(permissionInputFor('claude-code', 'running', 'cycle'), '\x1b[Z');
  assert.equal(permissionInputFor('claude-code', 'running', 'manage'), '/permissions\r');
});

test('Codex opens its own permissions picker and never receives Claude’s mode shortcut', () => {
  assert.deepEqual(permissionActionsFor('codex').map((item) => item.id), ['manage']);
  assert.equal(permissionInputFor('codex', 'running', 'manage'), '/permissions\r');
  assert.equal(permissionInputFor('codex', 'running', 'cycle'), null);
});

test('unknown harnesses, exited sessions and arbitrary renderer commands are refused', () => {
  for (const harness of ['claude', 'glm', 'generic-cli', '', null, {}]) {
    assert.deepEqual(permissionActionsFor(harness), []);
    assert.equal(permissionInputFor(harness, 'running', 'manage'), null);
  }
  for (const harness of ['claude-code', 'codex']) {
    for (const status of ['exited', 'starting', undefined]) {
      assert.equal(permissionInputFor(harness, status, 'manage'), null);
    }
    for (const action of ['bypassPermissions', '/permissions\rmalicious\r', null, {}, '__proto__']) {
      assert.equal(permissionInputFor(harness, 'running', action), null);
    }
  }
});

test('opening settings cannot answer a pending approval, while Claude’s mode shortcut remains available', () => {
  for (const harness of ['claude-code', 'codex']) {
    assert.equal(permissionInputFor(harness, 'running', 'manage', 'permission'), null);
    assert.equal(permissionInputFor(harness, 'running', 'manage', 'idle'), '/permissions\r');
  }
  assert.equal(permissionInputFor('claude-code', 'running', 'cycle', 'permission'), '\x1b[Z');
});
