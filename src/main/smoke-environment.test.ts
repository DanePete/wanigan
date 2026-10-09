import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { smokeEnvironment } from './smoke-environment.ts';

test('the app smoke uses a fake home and never inherits accounts, keys or shell startup settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-smoke-env-'));
  try {
    const home = join(dir, 'home');
    mkdirSync(home);
    const env = smokeEnvironment(dir, {
      PATH: '/untrusted/bin', HOME: '/untrusted/home', SHELL: '/untrusted/shell',
      CLAUDE_CONFIG_DIR: '/untrusted/claude', CODEX_HOME: '/untrusted/codex',
      TYPESAFE_API_KEY: 'test-only', WANIGAN_DEMO: '1', WANIGAN_DATA_DIR: '/untrusted/data',
      NODE_OPTIONS: '--require=/untrusted/module', ELECTRON_RUN_AS_NODE: '1',
      ZDOTDIR: '/untrusted/zsh', ENV: '/untrusted/sh', BASH_ENV: '/untrusted/bash',
      GIT_CONFIG_GLOBAL: '/untrusted/git', GIT_CONFIG_SYSTEM: '/untrusted/git',
    });
    assert.equal(env.WANIGAN_TEST_ACCOUNTS_HOME, home);
    assert.equal(env.WANIGAN_DATA_DIR, dir);
    assert.equal(env.HOME, home);
    assert.equal(env.SHELL, '/bin/sh');
    assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
    assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(env.GIT_CONFIG_SYSTEM, '/dev/null');
    for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'TYPESAFE_API_KEY', 'WANIGAN_DEMO', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ENV', 'BASH_ENV']) {
      assert.equal(env[key], undefined, key);
    }
    // Check the runtime's interpretation, not just the returned strings.
    assert.equal(execFileSync(process.execPath, ['-e', "process.stdout.write(require('node:os').homedir())"], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8',
    }), home);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
