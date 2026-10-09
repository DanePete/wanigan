import assert from 'node:assert/strict';
import { test } from 'node:test';
import { turnName, undoSummary, whyNotUndo, type UndoFacts } from './checkpoints.ts';

const ok: UndoFacts = {
  action: 'undo', turn: 4, notCaptured: null, gapBefore: false, committed: false, files: 3,
  state: 'waiting', provider: 'claude', worktree: true, folder: true, others: [],
};

test('the last turn can be undone only in a card’s worktree, at rest, alone, and fully captured', () => {
  assert.equal(whyNotUndo(ok), null);
  assert.equal(whyNotUndo({ ...ok, state: 'ended' }), null, 'an ended session is at rest');
  assert.equal(whyNotUndo({ ...ok, state: 'interrupted' }), null);
  assert.match(whyNotUndo({ ...ok, worktree: false }) ?? '', /only in a card’s own worktree/);
  assert.match(whyNotUndo({ ...ok, folder: false }) ?? '', /folder this session worked in is gone/);
  assert.match(whyNotUndo({ ...ok, state: 'working' }) ?? '', /^Claude is working\. Undo waits/);
  assert.match(whyNotUndo({ ...ok, state: 'permission', provider: 'codex' }) ?? '', /^Codex is asking for permission/);
  assert.match(whyNotUndo({ ...ok, state: 'limited' }) ?? '', /stopped at its usage limit/);
  assert.match(whyNotUndo({ ...ok, state: 'running' }) ?? '', /is working/, 'an unknown live state is not at rest');
  assert.match(whyNotUndo({ ...ok, others: ['Setup: pnpm install'] }) ?? '', /^Setup: pnpm install is also running in this folder\.$/);
  assert.match(whyNotUndo({ ...ok, others: ['a', 'b'] }) ?? '', /^2 other sessions/);
  assert.match(whyNotUndo({ ...ok, notCaptured: 'it took longer than 5 seconds' }) ?? '', /^Turn 4 was not captured \(it took longer than 5 seconds\)/);
  assert.match(whyNotUndo({ ...ok, gapBefore: true }) ?? '', /more than one turn/);
  assert.match(whyNotUndo({ ...ok, files: 0 }) ?? '', /^Turn 4 changed no files\.$/);
  assert.match(whyNotUndo({ ...ok, committed: true }) ?? '', /made a commit during turn 4/);
  // The lasting reason comes before the passing one.
  assert.match(whyNotUndo({ ...ok, worktree: false, state: 'working' }) ?? '', /worktree/);
  assert.match(whyNotUndo({ ...ok, action: 'redo', state: 'working' }) ?? '', /Redo waits/);
});

test('turns are named the way the timeline names them', () => {
  assert.equal(turnName(4), 'turn 4');
  assert.equal(turnName(0), 'the first turn');
  assert.equal(undoSummary('undo', 4, 3), 'You undid turn 4: 3 files');
  assert.equal(undoSummary('redo', 1, 1), 'You redid turn 1: 1 file');
});
