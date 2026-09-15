/**
 * Side questions, the pure half. What is typed into a live agent's terminal is
 * the whole risk here: a newline inside the question would submit early and
 * send the rest to the main thread, and a Codex question typed after `/side`
 * could do the same, since inline arguments were not found in that binary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE_BTW_PROBED, CODEX_SIDE_PROBED, SIDE_QUESTION_MAX_CHARS, sideQuestionLine, sideQuestionSupport, versionAtLeast,
} from './side-question.ts';

test('Claude Code at or past the probed version gets /btw with the question on the line', () => {
  const s = sideQuestionSupport('claude-code', `${CLAUDE_BTW_PROBED} (Claude Code)`);
  assert.equal(s.supported, true);
  assert.equal(s.supported && s.command, '/btw');
  assert.equal(s.supported && s.label, "Claude answers from the session's context without adding it to the conversation (Claude Code /btw).");
  assert.equal(sideQuestionLine(s, '  what does\n  this function return? '), '/btw what does this function return?');
  assert.equal(sideQuestionLine(s, '   '), null);
  assert.equal(sideQuestionLine(s, 'q'.repeat(SIDE_QUESTION_MAX_CHARS + 1)), null);
});

test('an older or unreported Claude Code is refused with the version it would need', () => {
  const old = sideQuestionSupport('claude-code', '2.1.200 (Claude Code)');
  assert.equal(old.supported, false);
  assert.match(!old.supported ? old.reason : '', /2\.1\.271/);
  assert.equal(sideQuestionSupport('claude-code', null).supported, false);
  assert.equal(sideQuestionLine(old, 'anything'), null);
});

test('Codex gets /side typed alone, never with the question after it', () => {
  const s = sideQuestionSupport('codex', `codex-cli ${CODEX_SIDE_PROBED}`);
  assert.equal(s.supported && s.command, '/side');
  assert.equal(s.supported && s.inlineQuestion, false);
  assert.equal(sideQuestionLine(s, 'what is left to do?'), '/side');
  assert.equal(sideQuestionSupport('codex', 'codex-cli 0.153.4').supported, false);
});

test('any other harness has no side question, and says which harnesses do', () => {
  const s = sideQuestionSupport('provider:local-pack', '9.9.9');
  assert.equal(s.supported, false);
  assert.match(!s.supported ? s.reason : '', /Claude Code \(\/btw\) and Codex \(\/side\)/);
});

test('versions compare numerically, not as strings', () => {
  assert.equal(versionAtLeast('2.1.1000', '2.1.271'), true);
  assert.equal(versionAtLeast('2.10.0', '2.9.9'), true);
  assert.equal(versionAtLeast('2.1.270', '2.1.271'), false);
  assert.equal(versionAtLeast('garbage', '2.1.271'), false);
});
