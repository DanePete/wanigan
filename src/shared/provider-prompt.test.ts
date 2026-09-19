import assert from 'node:assert/strict';
import test from 'node:test';
import { compileInitialPromptArgv } from './provider-prompt.ts';

test('positional initial prompt stays one argument after the option terminator', () => {
  const prompt = '--config host=evil\nKeep $` and {prompt} literal; "quotes" too.';
  assert.deepEqual(compileInitialPromptArgv(['--', '{prompt}'], prompt), ['--', prompt]);
  assert.deepEqual(compileInitialPromptArgv(['--prompt={prompt}'], '  Task\nline 2  '), ['--prompt=Task\nline 2']);
});

test('absent prompt emits no delimiter; malformed or oversized input fails before spawn', () => {
  assert.deepEqual(compileInitialPromptArgv(['--', '{prompt}'], ' \n '), []);
  assert.throws(() => compileInitialPromptArgv(['--', '{prompt}'], 'task\0suffix'));
  assert.throws(() => compileInitialPromptArgv(['--', '{prompt}'], 'x'.repeat(32_769)));
});
