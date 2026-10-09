import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INSTALL, installHint, notInstalledMessage } from './clis.ts';

test('a missing CLI is named with every official install command', () => {
  assert.equal(notInstalledMessage('claude'),
    'Claude Code is not installed, or not on your login shell’s PATH. Install it with `npm install -g @anthropic-ai/claude-code`, or `curl -fsSL https://claude.ai/install.sh | bash`.');
  assert.equal(installHint('gh'), 'Install it with `brew install gh`.');
  for (const cli of ['claude', 'codex', 'gh', 'git'] as const) {
    for (const command of INSTALL[cli]) assert.ok(notInstalledMessage(cli).includes(`\`${command}\``), `${cli}: ${command}`);
  }
});
