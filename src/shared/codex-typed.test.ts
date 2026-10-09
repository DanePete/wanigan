// A terminal's answers to Codex's startup queries reach the PTY as input. Found
// in the real-app scenario run: Codex asks for the colours (OSC 10 and 11),
// xterm answers "ESC ] 11;rgb:…ESC \", and the answer counted as typed text,
// so the Enter that dismissed Codex's update question read as a prompt; no
// hook followed it, and Wanigan stopped trusting Codex's hooks for the session.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_LINE, typeInto } from './codex.ts';

test('a terminal’s answers to queries are not typed text', () => {
  const answers = '\x1b]10;rgb:1d1d/2222/2727\x1b\\\x1b]11;rgb:f4f4/f5f5/f7f7\x07\x1b[12;1R\x1b[?1;2c\x1bP>|xterm.js(5.5.0)\x1b\\';
  const after = typeInto(EMPTY_LINE, answers);
  assert.equal(after.line.text, '');
  assert.equal(typeInto(after.line, '\r').submitted, false, 'Enter on a menu is not a prompt');
  assert.equal(typeInto(after.line, '\x1b[B\r').submitted, false, 'nor is an arrow then Enter');
  assert.equal(typeInto(typeInto(after.line, 'add a test').line, '\r').submitted, true, 'typing still is');
});

test('an answer split across two writes is still skipped', () => {
  const half = typeInto(EMPTY_LINE, '\x1b]11;rgb:f4f4/');
  const rest = typeInto(half.line, 'f5f5/f7f7\x07');
  assert.equal(rest.line.text, '');
  assert.equal(typeInto(rest.line, '\r').submitted, false);
});
