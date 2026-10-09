// Codex animates its composer while it sits idle once the terminal answers its
// colour queries, as xterm does. Found in the real-app scenario run: about
// 2.7 KB a second of redrawn braille cells filled a Codex session's 2 MB replay
// and most of its 8 MB record, so its Watch tile drew almost nothing, a view
// opened later showed nothing until a resize, and search found nothing it
// said. Measured with Codex 0.155.1: idle with its colours answered, 2,036
// bytes in 15 s; with `tui.animations=false`, none. Wanigan's own Codex
// terminal is launched without animations; the owner's config is not edited.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testCore, waitFor } from './test-support.ts';

// Codex asks at startup whether to update, with "Update now (runs `brew upgrade
// --cask codex`)" chosen. Found in the real-app scenario run: Wanigan showed
// Codex as "At its prompt" behind that question, and a message sent from the
// composer, or a pause's wrap-up, is typed in with an Enter that would choose
// it. Wanigan's terminal skips the check; the owner updates Codex themselves.
test('Wanigan’s Codex terminal never offers to update Codex', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const s = await t.owner.call('sessions.start', { projectId: project.id, provider: 'codex' });
    const args = await waitFor('launch line', () => t.core.sessions.replay(s.id).replay.match(/ARGS=(.*)/)?.[1]);
    assert.match(args, /--config check_for_update_on_startup=false/);
    await t.owner.call('sessions.stop', { id: s.id });
  } finally {
    await t.close();
  }
});

test('Wanigan’s Codex terminal is launched without animations', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const s = await t.owner.call('sessions.start', { projectId: project.id, provider: 'codex' });
    const args = await waitFor('launch line', () => t.core.sessions.replay(s.id).replay.match(/ARGS=(.*)/)?.[1]);
    assert.match(args, /--config tui\.animations=false/);
    await t.owner.call('sessions.stop', { id: s.id });
  } finally {
    await t.close();
  }
});
