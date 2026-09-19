import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexPromptOutput } from './codex-prompt.ts';

test('Codex fallback accepts a current prompt, never a prior prompt behind an update menu', () => {
  const ready = codexPromptOutput({ ready: false, partial: '' }, '\x1b[2K› Ask Codex to do anything\x1b[0m');
  assert.equal(ready.ready, true);
  assert.equal(codexPromptOutput(ready, '\x1b[2JUpdate available\r\n1. Update now\r\n2. Skip').ready, false);
  assert.equal(codexPromptOutput(ready, '\x1b[2K').ready, false);
  assert.equal(codexPromptOutput(ready, 'Allow access to this folder?').ready, false);
  assert.equal(codexPromptOutput(ready, 'Ask Codex to do anything\r\nPress Enter to update').ready, false);
});

test('a prompt split across output chunks is recognized; arbitrary suffixes and quotations are refused', () => {
  const half = codexPromptOutput({ ready: false, partial: '' }, '› Ask Codex to do ');
  assert.equal(half.ready, false);
  assert.equal(codexPromptOutput(half, 'anything').ready, true);
  assert.equal(codexPromptOutput({ ready: false, partial: '' }, 'The old line said Ask Codex to do anything').ready, false);
  assert.equal(codexPromptOutput({ ready: false, partial: '' }, 'Ask Codex to do anything else').ready, false);
});
