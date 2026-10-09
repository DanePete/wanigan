// Gemini CLI as an agent, against a stand-in that prints what it was launched
// with and echoes what it is sent, and the real hook relay. The events and their
// fields are Gemini CLI's own (0.46 and 0.63, run with fake responses).
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { GEMINI_EVENTS } from './hooks.ts';
import { relay, testCore, waitFor, type TestCore } from './test-support.ts';

const FAKE_GEMINI = 'echo "TOKEN=$WANIGAN_TOKEN HOME=${GEMINI_CLI_HOME-unset} ARGS=$*"; exec cat';

async function gemini(t: TestCore, extra: Record<string, unknown> = {}) {
  const project = await t.owner.call('projects.add', { path: t.projectDir });
  const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'gemini', ...extra });
  const replay = await waitFor('the stand-in', async () => {
    const r = (await t.owner.call('sessions.watch', { id: session.id })).replay;
    return /TOKEN=\S+ HOME=\S+ ARGS=/.test(r) ? r : null;
  });
  const token = /TOKEN=(\S+)/.exec(replay)![1]!;
  return { project, session, replay, token };
}

const launcher = (provider: string) => (provider === 'gemini' ? { file: '/bin/sh', args: ['-c', FAKE_GEMINI, 'fake-gemini'] } : null);

test('Gemini starts in Wanigan’s own Gemini home with its hooks and the owner’s sign-in method, and its conversation id is learnt from its hooks', async () => {
  const t = await testCore({ launcher });
  try {
    // The owner's own Gemini settings: read for the sign-in method and trusted folders, never written.
    const own = join(t.dir, 'home', '.gemini');
    mkdirSync(own, { recursive: true });
    const settings = JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } }, mcpServers: { mine: { command: 'x' } } });
    const trusted = JSON.stringify({ [t.projectDir]: 'TRUST_FOLDER' });
    writeFileSync(join(own, 'settings.json'), settings);
    writeFileSync(join(own, 'trustedFolders.json'), trusted);
    const { session, replay, token } = await gemini(t, { model: 'flash' });
    const home = join(t.core.paths.dataDir, 'gemini-home');
    // No id of Wanigan's: Gemini restarts with the same arguments when a folder is trusted, and would refuse it.
    assert.match(replay, new RegExp(`HOME=${home} ARGS=-m flash`));
    assert.equal(session.conversationId, null);
    const id = '0f9c2a1e-1111-4222-8333-944455556666';
    await relay(t.core, token, 'SessionStart', { session_id: id, transcript_path: '/tmp/x/session-new.jsonl', source: 'startup' });
    await relay(t.core, token, 'BeforeAgent', { session_id: id, transcript_path: '/tmp/x/session-real.jsonl', prompt: 'hi' });
    const learnt = await waitFor('the conversation', async () => {
      const s = (await t.owner.call('sessions.get', { id: session.id })).session;
      return s.conversationId === id && s.transcriptPath === '/tmp/x/session-real.jsonl' ? s : null;
    });
    assert.equal(learnt.conversationId, id, 'learnt from Gemini’s own hook');
    const written = JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8'));
    assert.deepEqual(Object.keys(written.hooks), [...GEMINI_EVENTS]);
    assert.ok(Object.values(written.hooks).every((groups) => (groups as { hooks: { command: string; timeout: number }[] }[])[0]!.hooks[0]!.timeout === 10_000), 'Gemini’s timeouts are milliseconds');
    assert.match(written.hooks.BeforeTool[0].hooks[0].command, /relay\.sh' BeforeTool$/);
    assert.equal(written.hooks.BeforeTool[0].matcher, '*');
    assert.deepEqual(written.security.auth, { selectedType: 'oauth-personal' }, 'signed in the way the owner chose');
    assert.ok(written.security.environmentVariableRedaction.allowed.includes('WANIGAN_TOKEN'), 'the relay’s token survives a redaction setting');
    assert.equal(written.mcpServers, undefined, 'only what Wanigan needs: not the owner’s servers');
    assert.equal(readFileSync(join(home, '.gemini', 'trustedFolders.json'), 'utf8').trim(), JSON.stringify(JSON.parse(trusted), null, 2), 'folders the owner trusted stay trusted');
    assert.equal(readFileSync(join(own, 'settings.json'), 'utf8'), settings, 'the owner’s settings are untouched');
    assert.equal(readFileSync(join(own, 'trustedFolders.json'), 'utf8'), trusted);
  } finally { await t.close(); }
});

test('Gemini’s hooks drive the session: briefed at start, a turn, a tool read as Read, an ask raised, and the composer only after its first turn', async () => {
  const t = await testCore({ launcher });
  try {
    const { project, session, token } = await gemini(t);
    const briefing = await relay(t.core, token, 'SessionStart', { session_id: session.conversationId, source: 'startup', hook_event_name: 'SessionStart' });
    const ctx = JSON.parse(briefing).hookSpecificOutput;
    assert.equal(ctx.hookEventName, 'SessionStart');
    assert.equal(typeof ctx.additionalContext, 'string');
    assert.ok(ctx.additionalContext.startsWith(`You are working in "${project.name}" (${project.path})`),
      'the one hook envelope contains the project briefing text, not another serialized hook envelope');
    assert.ok(ctx.additionalContext.includes('\nThe `wanigan` command is your board:'),
      'the briefing has actual lines inside additionalContext, not escaped newlines from a nested JSON string');
    await waitFor('waiting', async () => (await t.owner.call('sessions.get', { id: session.id })).session.state === 'waiting');
    // Its first screen may be a sign-in or a folder question: the composer waits for a turn.
    await assert.rejects(t.owner.call('sessions.queue', { id: session.id, text: 'hello' }), /first message in the Gemini terminal/);
    assert.equal(await relay(t.core, token, 'BeforeAgent', { prompt: 'look at README', hook_event_name: 'BeforeAgent' }), '', 'nothing printed into Gemini’s window');
    await waitFor('working', async () => (await t.owner.call('sessions.get', { id: session.id })).session.state === 'working');
    await relay(t.core, token, 'BeforeTool', { tool_name: 'read_file', tool_input: { file_path: 'README.md' }, hook_event_name: 'BeforeTool' });
    await relay(t.core, token, 'BeforeModel', { llm_request: { contents: ['the whole conversation'] } });
    const { events } = await t.owner.call('sessions.get', { id: session.id });
    assert.ok(events.some((e) => e.event === 'PreToolUse' && e.tool === 'Read'), JSON.stringify(events.map((e) => [e.event, e.tool])));
    assert.ok(!events.some((e) => e.event === 'BeforeModel'), 'model events are never recorded');
    await relay(t.core, token, 'Notification', { notification_type: 'ToolPermission', message: 'Allow?', details: { type: 'exec', title: 'Shell', command: 'npm test', rootCommand: 'npm' } });
    const asking = await waitFor('asking', async () => (await t.owner.call('needs.list', {})).find((n) => n.sessionId === session.id && n.kind === 'permission'));
    assert.equal(asking.asks?.[0]?.text, 'npm test', 'the ask says exactly what it runs');
    // Now past its first screen, a message waits in the queue for the end of the turn.
    assert.deepEqual(await t.owner.call('sessions.queue', { id: session.id, text: 'then the tests' }), { queued: 1 });
  } finally { await t.close(); }
});

test('Gemini: a refused permission or a cancel fires no hook, and its window title going back to Ready says so', async () => {
  const t = await testCore({ launcher });
  try {
    const { session, token } = await gemini(t);
    await relay(t.core, token, 'SessionStart', { source: 'startup' });
    await relay(t.core, token, 'BeforeAgent', { prompt: 'x' });
    await relay(t.core, token, 'Notification', { notification_type: 'ToolPermission', details: { type: 'exec', command: 'rm -rf build' } });
    await waitFor('asking', async () => (await t.owner.call('sessions.get', { id: session.id })).session.state === 'permission');
    // The owner presses Esc in Gemini: no hook, but the title says Ready.
    await t.owner.call('sessions.input', { id: session.id, data: '\x1b]0;◇  Ready (site)\x07\n' });
    await waitFor('back at its prompt', async () => (await t.owner.call('sessions.get', { id: session.id })).session.state === 'waiting');
  } finally { await t.close(); }
});

test('Gemini resumes its conversation only once it saved one', async () => {
  const t = await testCore({ launcher });
  try {
    const { session, token } = await gemini(t);
    const id = '7d3e9b20-aaaa-4bbb-8ccc-1234567890ab';
    await relay(t.core, token, 'SessionStart', { session_id: id, source: 'startup' });
    await waitFor('its id', async () => (await t.owner.call('sessions.get', { id: session.id })).session.conversationId === id);
    await t.owner.call('sessions.stop', { id: session.id });
    await waitFor('ended', async () => !['starting', 'working', 'waiting', 'permission', 'running'].includes((await t.owner.call('sessions.get', { id: session.id })).session.state));
    await assert.rejects(t.owner.call('sessions.resume', { id: session.id }), /Gemini saved nothing for this conversation/);
    const chats = join(t.core.paths.dataDir, 'gemini-home', '.gemini', 'tmp', 'site', 'chats');
    mkdirSync(chats, { recursive: true });
    writeFileSync(join(chats, `session-2026-10-08T01-00-${id.slice(0, 8)}.jsonl`), '{}\n');
    const again = await t.owner.call('sessions.resume', { id: session.id });
    const replay = await waitFor('the stand-in', async () => {
      const r = (await t.owner.call('sessions.watch', { id: again.id })).replay;
      return /ARGS=/.test(r) ? r : null;
    });
    assert.match(replay, new RegExp(`ARGS=--resume ${id}`));
  } finally { await t.close(); }
});
