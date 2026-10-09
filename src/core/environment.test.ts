// A session never inherits the markers Claude Code puts on its own children.
// Started from a terminal inside Claude Code (`npm run dev` in its shell, say),
// Wanigan carries them; passed on, CLAUDE_CODE_CHILD_SESSION turns transcript
// saving off in every Claude session it starts, which empties History, Resume
// and tokens, and the rest name a parent session that is not theirs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanEnv } from './environment.ts';
import { testCore, waitFor } from './test-support.ts';

/** What Claude Code 2.1.292 sets on every process it starts (read from the binary). */
const CHILD_MARKERS = {
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_SESSION_ID: '0b7c4c3e-parent',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_SESSION_ATTENDED: '1',
  CLAUDE_PID: '4242',
  CLAUDE_EFFORT: 'xhigh',
  AI_AGENT: 'claude-code',
};

test('cleanEnv drops Claude Code’s child-session markers and keeps the owner’s own settings', () => {
  const out = cleanEnv({ ...CHILD_MARKERS, HOME: '/Users/o', CLAUDE_CONFIG_DIR: '/Users/o/.claude-work', CLAUDE_CODE_USE_BEDROCK: '1', PATH: '/usr/bin' });
  for (const key of Object.keys(CHILD_MARKERS)) assert.equal(out[key], undefined, `${key} reached the session`);
  assert.equal(out.HOME, '/Users/o');
  assert.equal(out.CLAUDE_CONFIG_DIR, '/Users/o/.claude-work', 'an account folder is the owner’s choice');
  assert.equal(out.CLAUDE_CODE_USE_BEDROCK, '1', 'a setting the owner exported is theirs');
});

test('a Claude session started by a Wanigan that runs inside Claude Code saves its transcript', async () => {
  const saved = Object.fromEntries(Object.keys(CHILD_MARKERS).map((k) => [k, process.env[k]]));
  Object.assign(process.env, CHILD_MARKERS);
  const t = await testCore({
    launcher: (provider) => provider === 'claude'
      ? { file: '/bin/sh', args: ['-c', 'echo "CHILD=${CLAUDE_CODE_CHILD_SESSION-unset} PARENT=${CLAUDE_CODE_SESSION_ID-unset} PID=${CLAUDE_PID-unset} EFFORT=${CLAUDE_EFFORT-unset} CC=${CLAUDECODE-unset}"; exec cat', 'fake-claude'] }
      : { file: '/bin/sh', args: ['-i'] },
  });
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const s = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
    const line = await waitFor('the stand-in’s environment', () => t.core.sessions.replay(s.id).replay.match(/CHILD=.*/)?.[0]);
    assert.equal(line.trim(), 'CHILD=unset PARENT=unset PID=unset EFFORT=unset CC=unset');
    await t.owner.call('sessions.stop', { id: s.id });
  } finally {
    await t.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
