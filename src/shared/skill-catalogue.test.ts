import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillTypingUnavailable, type SkillInfo } from './skill-catalogue.ts';
import type { Session } from './types.ts';

const command: Pick<SkillInfo, 'harness' | 'invoke' | 'invocable'> = {
  harness: 'claude-code', invoke: '/review',
  invocable: { user: true, model: true, override: null, decidedBy: null, ambiguous: false },
};
const session: Pick<Session, 'harnessId' | 'status' | 'projectId'> = {
  harnessId: 'claude-code', status: 'running', projectId: 'store',
};

test('typing is offered only for a fresh supported command in the selected session project', () => {
  assert.equal(skillTypingUnavailable(command, session, 'store', false), null);
  assert.match(skillTypingUnavailable(command, session, 'store', true)!, /Rescan/);
  assert.match(skillTypingUnavailable(command, session, 'another-project', false)!, /another project/);
  assert.match(skillTypingUnavailable(command, session, undefined, false)!, /another project/);
});

test('Codex file names are readable but never presented as verified commands', () => {
  const file = { ...command, harness: 'codex' as const, invoke: '' };
  assert.match(skillTypingUnavailable(file, session, 'store', false)!, /not verified/);
  assert.match(skillTypingUnavailable(command, { ...session, harnessId: 'codex' }, 'store', false)!, /Select a Claude Code/);
  assert.match(skillTypingUnavailable(command, { ...session, harnessId: undefined }, 'store', false)!, /Select a Claude Code/);
});

test('missing, exited, and manually disabled targets have an explanation instead of a dead action', () => {
  assert.match(skillTypingUnavailable(command, null, 'store', false)!, /live Claude Code/);
  assert.match(skillTypingUnavailable(command, { ...session, status: 'exited' }, 'store', false)!, /live Claude Code/);
  assert.match(skillTypingUnavailable({ ...command, invocable: { ...command.invocable, user: false } }, session, 'store', false)!, /prevent manual invocation/);
});
