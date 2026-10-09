// Claude Code fires no hook when the owner says No at a permission prompt or
// presses Esc mid-turn (2.1.292: PermissionDenied is the auto-mode classifier's
// alone, and an interrupted turn has no Stop). Found in the real-app scenario
// run: after a No, Needs you kept "Asking permission" and its amber for as long
// as the agent sat there, and a message queued behind it waited. The
// transcript records the interrupt; the screen is no witness, because Claude
// redraws old interrupt lines when a dialog closes (the first fix read the
// screen, and split a turn in two when an approval redrew an old line).
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Session } from '../shared/model.ts';
import { interruptedAt } from './claude-interrupt.ts';
import { savedConversation, testCore, waitFor, type TestCore } from './test-support.ts';

/** Claude's interrupt line, drawn as its terminal draws it, printed on any line containing "redraw". */
const DRAWS_OLD_LINE = "printf '  \\342\\216\\277  Interrupted \\302\\267 What should Claude do instead?\\r\\n'";
const standIn = (provider: string) => provider === 'claude'
  ? { file: '/bin/sh', args: ['-c', `stty -echo; echo ready; while IFS= read -r line; do case "$line" in *redraw*) ${DRAWS_OLD_LINE} ;; esac; done`, 'fake-claude'] }
  : { file: '/bin/sh', args: ['-i'] };

const record = (type: 'user' | 'assistant', text: string, at = Date.now()) =>
  `${JSON.stringify({ type, timestamp: new Date(at).toISOString(), message: { role: type, content: [{ type: 'text', text }] } })}\n`;

function transcript(t: TestCore, s: Session): string {
  return join(t.dir, 'home', '.claude', 'projects', (s.cwd ?? '').replace(/[^a-zA-Z0-9]/g, '-'), `${s.conversationId}.jsonl`);
}

async function asking(t: TestCore): Promise<Session> {
  const project = await t.owner.call('projects.add', { path: t.projectDir });
  const s = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
  await waitFor('ready', () => t.core.sessions.replay(s.id).replay.includes('ready'));
  savedConversation(join(t.dir, 'home'), s);
  t.core.sessions.hook(s.id, 'SessionStart', {});
  t.core.sessions.hook(s.id, 'UserPromptSubmit', {});
  t.core.sessions.hook(s.id, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'wanigan show CS-1' } });
  t.core.sessions.hook(s.id, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'wanigan show CS-1' } });
  return s;
}

const stateOf = async (t: TestCore, id: string) => (await t.owner.call('sessions.get', { id })).session.state;

test('the newest transcript record says whether the owner interrupted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-interrupt-'));
  try {
    const file = join(dir, 't.jsonl');
    writeFileSync(file, record('user', 'fix it') + record('assistant', 'On it.'));
    assert.equal(interruptedAt(file), null);
    appendFileSync(file, record('user', '[Request interrupted by user for tool use]', 1_791_000_000_000));
    assert.equal(interruptedAt(file), 1_791_000_000_000);
    appendFileSync(file, `${JSON.stringify({ type: 'file-history-snapshot', snapshot: {} })}\n`);
    assert.equal(interruptedAt(file), 1_791_000_000_000, 'bookkeeping after it does not hide it');
    appendFileSync(file, record('assistant', 'Running the tests.'));
    assert.equal(interruptedAt(file), null, 'the conversation moved on');
    appendFileSync(file, record('user', '[Request interrupted by user]', 1_791_000_100_000));
    assert.equal(interruptedAt(file), 1_791_000_100_000, 'Esc mid-turn');
    assert.equal(interruptedAt(join(dir, 'missing.jsonl')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a No at a permission prompt, or Esc mid-turn, leaves Claude waiting at its prompt', async () => {
  const t = await testCore({ launcher: standIn });
  try {
    const s = await asking(t);
    assert.equal(await stateOf(t, s.id), 'permission');

    // The owner chooses No in the terminal; Claude records it and sends nothing.
    await t.owner.call('sessions.input', { id: s.id, data: 'no\r' });
    appendFileSync(transcript(t, s), record('user', '[Request interrupted by user for tool use]'));
    await waitFor('waiting after a No', async () => (await stateOf(t, s.id)) === 'waiting');
    assert.ok(!(await t.owner.call('needs.list', {})).some((n) => n.sessionId === s.id && n.kind === 'permission'), 'Needs you no longer says it is asking');
    const { session, events } = await t.owner.call('sessions.get', { id: s.id });
    assert.equal(events.at(-1)?.event, 'Interrupted');
    assert.match(session.activity ?? '', /Interrupted/);

    // Esc during a turn: the same record, the same truth.
    t.core.sessions.hook(s.id, 'UserPromptSubmit', {});
    appendFileSync(transcript(t, s), record('user', 'now do it properly'));
    t.core.sessions.hook(s.id, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'src/cart.js' } });
    assert.equal(await stateOf(t, s.id), 'working');
    await t.owner.call('sessions.input', { id: s.id, data: '\x1b' });
    appendFileSync(transcript(t, s), record('user', '[Request interrupted by user]'));
    await waitFor('waiting after Esc', async () => (await stateOf(t, s.id)) === 'waiting');
  } finally {
    await t.close();
  }
});

test('an approval that redraws an old interrupt line, or an old interrupt in the transcript, changes nothing', async () => {
  const t = await testCore({ launcher: standIn });
  try {
    const s = await asking(t);
    // An earlier turn ended in a No: that is the newest record, from a minute ago.
    appendFileSync(transcript(t, s), record('user', '[Request interrupted by user for tool use]', Date.now() - 60_000));
    // The owner approves; Claude closes the dialog and draws the old line again.
    await t.owner.call('sessions.input', { id: s.id, data: 'yes, redraw\r' });
    await waitFor('the old line drawn again', () => t.core.sessions.replay(s.id).replay.includes('Interrupted'));
    await new Promise((r) => setTimeout(r, 3_000));
    assert.equal(await stateOf(t, s.id), 'permission', 'still asking until a hook says otherwise');
    t.core.sessions.hook(s.id, 'PostToolUse', { tool_name: 'Bash' });
    assert.equal(await stateOf(t, s.id), 'working');
  } finally {
    await t.close();
  }
});
