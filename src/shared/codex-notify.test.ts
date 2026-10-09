// Codex 0.155.1's turn-complete notification carries the agent's last message,
// not "Agent turn complete". Found in the real-app scenario run: after Codex
// finished CS-2, its summary arrived as an OSC 9 notification and was read as
// a permission request, so Needs you said "Asking permission" with the agent's
// summary as the question, and the session held its queued messages.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanCodex } from './codex.ts';

const osc9 = (text: string) => `\x1b]9;${text}\x07`;

test('a turn that ends with the agent’s own words is a finished turn', () => {
  const said = 'Committed `e7fc134` on `wanigan/cs-2` and submitted CS-2 for review. Added the helper and threshold tests.';
  assert.deepEqual(scanCodex('', osc9(said)).signals.map((s) => s.kind), ['finished']);
  assert.deepEqual(scanCodex('', osc9('Agent turn complete')).signals.map((s) => s.kind), ['finished']);
});

test('the approval wordings in the Codex 0.155.1 binary are approvals', () => {
  for (const text of ['Approval requested: /bin/zsh -lc \'wanigan claim CS-2\'', 'Approval requested by the MCP server', 'Codex wants to edit src/cart.js']) {
    assert.deepEqual(scanCodex('', osc9(text)).signals, [{ kind: 'permission', text }], text);
  }
});
