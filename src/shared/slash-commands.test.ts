/**
 * The headless slash-command refusal. The Claude names are those the Claude
 * Code 2.1.271 binary defines with no print-mode twin; the allowed Claude
 * built-ins below are ones that binary defines with `supportsNonInteractive:!0`
 * (or as `prompt` commands), checked against the same strings.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyHeadlessPrompt, leadingCommand } from './slash-commands.ts';

test('only a leading slash word is a command', () => {
  assert.equal(leadingCommand('/login'), 'login');
  assert.equal(leadingCommand('  /Resume abc'), 'resume');
  assert.equal(leadingCommand('please /login'), null);
  assert.equal(leadingCommand('/'), null);
  assert.equal(leadingCommand('/usr/bin/env is broken, fix it'), null, 'a path is not a command');
  assert.equal(leadingCommand('/my-plugin:do-thing now'), 'my-plugin:do-thing');
  assert.equal(leadingCommand(''), null);
});

test('interactive-only Claude commands are refused with the reason and the version the list came from', () => {
  for (const prompt of ['/login', '/logout', '/resume', '/rewind', '/btw what is this', '/permissions', '/theme']) {
    const verdict = classifyHeadlessPrompt('claude-code', prompt);
    assert.equal(verdict.kind, 'interactive-only', prompt);
    if (verdict.kind === 'interactive-only') {
      assert.match(verdict.reason, /2\.1\.271/);
      assert.match(verdict.reason, /Nothing was started and nothing was spent/);
    }
  }
});

test('aliases are refused as the command they stand for', () => {
  const verdict = classifyHeadlessPrompt('claude-code', '/continue');
  assert.equal(verdict.kind, 'interactive-only');
  assert.match(verdict.kind === 'interactive-only' ? verdict.reason : '', /alias of \/resume/);
  assert.equal(classifyHeadlessPrompt('claude-code', '/undo').kind, 'interactive-only');
});

test('Claude built-ins with a print-mode twin, skills and custom commands are allowed', () => {
  for (const prompt of ['/clear', '/config key=value', '/exit', '/compact', '/model opus', '/usage', '/init', '/review-pr 12', '/my-skill do it', '/plugin-name:command']) {
    assert.equal(classifyHeadlessPrompt('claude-code', prompt).kind, 'allowed', prompt);
  }
  assert.equal(classifyHeadlessPrompt('claude-code', 'Fix the failing test').kind, 'not-a-command');
});

test('Codex TUI commands are refused; anything else goes through', () => {
  assert.equal(classifyHeadlessPrompt('codex', '/model').kind, 'interactive-only');
  assert.equal(classifyHeadlessPrompt('codex', '/review').kind, 'interactive-only');
  assert.equal(classifyHeadlessPrompt('codex', '/something-custom').kind, 'allowed');
});

test('a harness with no verified table refuses nothing', () => {
  assert.equal(classifyHeadlessPrompt('generic-cli', '/login').kind, 'allowed');
  assert.equal(classifyHeadlessPrompt(null, '/login').kind, 'allowed');
});
