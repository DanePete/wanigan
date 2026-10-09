// Codex sessions Wanigan can see into: hooks trusted by hash at launch, the
// thread learned from the first relayed hook, tokens from its rollout, History
// and resume. The probe is a stand-in for `hooks/list`; the agent is a stand-in
// Codex. Nothing here runs the real CLI or reads the real home
// (scripts/codex-hooks-probe.ts asks the installed Codex, spend-free).
import assert from 'node:assert/strict';
import { mkdirSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { CodexHooks, codexTrustArgs } from './codex-hooks.ts';
import { CODEX_EVENTS, codexHookArgs, relayCommand } from './hooks.ts';
import { CODEX_UNCOUNTED } from './tokens.ts';
import { codexWithToken, hashOf, relay, snake, stubProbe, testCore, tokenOf, waitFor } from './test-support.ts';

const RELAY = '/data dir/hooks/relay.sh';
test('Codex hook flags define each event once, through the relay, and trust exactly the listed hashes', () => {
  const args = codexHookArgs(RELAY);
  assert.equal(args.length, CODEX_EVENTS.length * 2);
  assert.ok(args.filter((_, i) => i % 2 === 0).every((a) => a === '--config'));
  assert.equal(args[1], `hooks.SessionStart=[{hooks=[{type="command",command="'/data dir/hooks/relay.sh' SessionStart",timeout=10}]}]`);
  assert.match(args.at(-1)!, /^hooks\.SessionEnd=.*timeout=3\}\]\}\]$/, 'Codex clamps SessionEnd to 3 seconds');
  assert.equal(relayCommand(RELAY, 'Stop'), `'/data dir/hooks/relay.sh' Stop`);
  assert.deepEqual(codexTrustArgs([{ key: '/<session-flags>/config.toml:stop:0:0', currentHash: 'sha256:ab' }]),
    ['--config', 'hooks.state={"/<session-flags>/config.toml:stop:0:0"={enabled=true,trusted_hash="sha256:ab"}}']);
});

test('Codex hooks: trusted by the hashes Codex lists, asked once per version', async () => {
  const probe = stubProbe();
  const hooks = new CodexHooks(RELAY, probe);
  const launch = await hooks.prepare('codex', '/usr/bin');
  assert.equal(launch.why, null);
  const args = launch.args ?? [];
  assert.deepEqual(args.slice(0, CODEX_EVENTS.length * 2), codexHookArgs(RELAY));
  const state = args.at(-1) ?? '';
  for (const event of CODEX_EVENTS) assert.ok(state.includes(`config.toml:${snake(event)}:0:0"={enabled=true,trusted_hash="${hashOf(event)}"}`), event);
  assert.equal(probe.lists, 2, 'listed once to learn the hashes, once to see them trusted');
  await hooks.prepare('codex', '/usr/bin');
  assert.equal(probe.lists, 2, 'the same version and hooks are not asked again');
});

test('Codex hooks: anything short of every hook trusted launches without them, and says why', async () => {
  const missing = await new CodexHooks(RELAY, stubProbe({ drop: 'PermissionRequest' })).prepare('codex', '/usr/bin');
  assert.equal(missing.args, null);
  assert.match(missing.why ?? '', /codex-cli 0\.155\.1 did not list Wanigan’s PermissionRequest hook/);

  const modified = await new CodexHooks(RELAY, stubProbe({ trusted: 'modified' })).prepare('codex', '/usr/bin');
  assert.equal(modified.args, null);
  assert.match(modified.why ?? '', /listed Wanigan’s hooks as modified, not trusted/);

  const unknown = await new CodexHooks(RELAY, stubProbe({ version: null })).prepare('codex', '/usr/bin');
  assert.match(unknown.why ?? '', /could not read which version of Codex/);

  const failing = stubProbe({ fail: true });
  const hooks = new CodexHooks(RELAY, failing);
  assert.match((await hooks.prepare('codex', '/usr/bin')).why ?? '', /could not be asked about its hooks \(Codex did not answer/);
  await hooks.prepare('codex', '/usr/bin');
  assert.equal(failing.lists, 2, 'a probe that failed outright is asked again next launch');
});

const launchLine = async (core: Awaited<ReturnType<typeof testCore>>['core'], id: string): Promise<string> =>
  waitFor('launch line', () => core.sessions.replay(id).replay.match(/codex ready .*/)?.[0].trim());

test('a Codex session launches with trusted hooks only when the probe says so', async () => {
  const declined = await testCore({ codexHookProbe: stubProbe({ trusted: 'untrusted' }) });
  try {
    const project = await declined.owner.call('projects.add', { path: declined.projectDir });
    const s = await declined.owner.call('sessions.start', { projectId: project.id, provider: 'codex' });
    const line = await launchLine(declined.core, s.id);
    assert.doesNotMatch(line, /hooks\./, 'launched exactly as before: no hooks, no trust');
    assert.match(line, /tui\.notification_method="osc9"/, 'its notifications still report');
    const { events } = await declined.owner.call('sessions.get', { id: s.id });
    assert.equal(events[0]?.event, 'Wanigan');
    assert.match(events[0]?.summary ?? '', /^Hooks not used: codex-cli 0\.155\.1 listed Wanigan’s hooks as untrusted, not trusted\. Its state comes from Codex’s notifications instead\.$/);
    await declined.owner.call('sessions.stop', { id: s.id });
  } finally {
    await declined.close();
  }

  const t = await testCore({ codexHookProbe: stubProbe() });
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const s = await t.owner.call('sessions.start', { projectId: project.id, provider: 'codex' });
    const line = await launchLine(t.core, s.id);
    const relayPath = join(t.core.paths.dataDir, 'hooks', 'relay.sh');
    for (const event of CODEX_EVENTS) assert.ok(line.includes(`hooks.${event}=[{hooks=[{type="command",command="'${relayPath}' ${event}"`), event);
    assert.match(line, /hooks\.state=\{"\/<session-flags>\/config\.toml:session_start:0:0"=\{enabled=true,trusted_hash="sha256:/);
    assert.match(line, /developer_instructions=/, 'still briefed at launch');
    assert.deepEqual((await t.owner.call('sessions.get', { id: s.id })).events, [], 'nothing to explain');
    await t.owner.call('sessions.stop', { id: s.id });
  } finally {
    await t.close();
  }
});

test('a relayed Codex hook names its thread; tokens, History and resume follow', async () => {
  const t = await testCore({ codexHookProbe: stubProbe(), launcher: codexWithToken });
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Rate limit headers' });
    const s = await t.owner.call('sessions.start', { projectId: project.id, provider: 'codex', cardId: card.id, model: 'gpt-5.5', effort: 'high' });
    const token = await tokenOf(t.core, s.id);
    const get = async () => (await t.owner.call('sessions.get', { id: s.id })).session;
    await waitFor('waiting', async () => (await get()).state === 'waiting');
    assert.deepEqual(await t.owner.call('sessions.tokens', { id: s.id }), { usage: null, note: CODEX_UNCOUNTED }, 'no thread known yet');

    // The first prompt: Codex starts its session, then reports the prompt (payloads as 0.155.1 sends them).
    const T = '01a114d3-47f0-7272-8e4b-a8c6b201a02c';
    const home = join(t.dir, 'home', '.codex');
    const rollout = join(home, 'sessions', '2026', '10', '07', `rollout-2026-10-07T00-25-53-${T}.jsonl`);
    const base = { session_id: T, transcript_path: rollout, cwd: t.projectDir, model: 'gpt-5.5', permission_mode: 'default' };
    assert.equal(await relay(t.core, token, 'SessionStart', { ...base, hook_event_name: 'SessionStart', source: 'startup' }), '', 'Codex was briefed at launch; the hook says nothing back');
    let session = await get();
    assert.equal(session.conversationId, T);
    assert.equal(session.transcriptPath, rollout);
    assert.equal(session.state, 'waiting', 'SessionStart alone is not a turn, nor the end of one');
    await relay(t.core, token, 'UserPromptSubmit', { ...base, hook_event_name: 'UserPromptSubmit', turn_id: '01a114d4-0000-7000-8000-000000000001', prompt: 'go' });
    assert.equal((await get()).state, 'working');
    await relay(t.core, token, 'PermissionRequest', { ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    assert.equal((await get()).state, 'permission');
    await relay(t.core, token, 'PostToolUse', { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    assert.equal((await get()).state, 'working', 'answered: the tool ran');
    await relay(t.core, token, 'Stop', { ...base, hook_event_name: 'Stop' });
    assert.equal((await get()).state, 'waiting');

    // Once hooks report, the turn-complete notification does not end a turn a second time.
    await t.owner.call('sessions.input', { id: s.id, data: 'done\r' });
    await waitFor('the notification', () => t.core.sessions.replay(s.id).replay.includes('\x1b]9;Agent turn complete'));
    await new Promise((r) => setTimeout(r, 200));
    const events = (await t.owner.call('sessions.get', { id: s.id })).events.map((e) => e.event);
    assert.deepEqual(events, ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Stop']);

    // Tokens, from the rollout.
    mkdirSync(join(home, 'sessions', '2026', '10', '07'), { recursive: true });
    const used = { input_tokens: 24_000, cached_input_tokens: 20_000, cache_write_input_tokens: 0, output_tokens: 600, reasoning_output_tokens: 200, total_tokens: 24_600 };
    writeFileSync(rollout, [
      { type: 'session_meta', payload: { id: T, cwd: t.projectDir, source: 'cli', thread_source: 'user' } },
      { type: 'turn_context', payload: { model: 'gpt-5.5' } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: used, last_token_usage: used, model_context_window: 272_000 } } },
    ].map((l) => `${JSON.stringify(l)}\n`).join(''));
    const tokens = await t.owner.call('sessions.tokens', { id: s.id });
    assert.equal(tokens.note, null, 'the thread is known, so nothing is said about not counting it');
    assert.deepEqual([tokens.usage?.source, tokens.usage?.requests, tokens.usage?.cacheRead, tokens.usage?.context, tokens.usage?.contextWindow, tokens.usage?.model],
      ['codex', 1, 20_000, 24_000, 272_000, 'gpt-5.5']);
    assert.equal((await t.owner.call('cards.tokens', { id: card.id })).usage?.source, 'codex');

    // History: Codex's own index of the thread, linked to the session that ran it.
    const state = new Database(join(home, 'state_5.sqlite'));
    state.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, source TEXT, cwd TEXT, title TEXT, first_user_message TEXT,
      git_branch TEXT, model TEXT, thread_source TEXT, name TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, originator TEXT)`);
    state.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(T, rollout, 'cli', t.projectDir, 'Rate limit headers', 'go', 'main', 'gpt-5.5', 'user', null, Date.now() - 60_000, Date.now(), 'codex-tui');
    state.close();
    const item = (await t.owner.call('history.list', { projectId: project.id })).find((i) => i.conversationId === T);
    assert.equal(item?.sessionId, s.id);
    assert.equal(item?.live, true);

    // /new moves the session to another thread; SessionEnd for the old one does not move it back.
    const T2 = '01a114d4-93e8-7dc3-a322-8a5a8a2f3fdb';
    await relay(t.core, token, 'UserPromptSubmit', { ...base, session_id: T2, transcript_path: '/etc/rollout-elsewhere.jsonl', hook_event_name: 'UserPromptSubmit' });
    session = await get();
    assert.deepEqual([session.conversationId, session.transcriptPath], [T2, null], 'a rollout outside the account’s CODEX_HOME is not followed');
    await relay(t.core, token, 'SessionEnd', { ...base, hook_event_name: 'SessionEnd', reason: 'other' });
    assert.equal((await get()).conversationId, T2);
    await relay(t.core, token, 'UserPromptSubmit', { ...base, hook_event_name: 'UserPromptSubmit' });
    assert.equal((await get()).conversationId, T);

    // Resume: the same thread, folder, account, card, model and effort.
    await t.owner.call('sessions.stop', { id: s.id });
    await waitFor('ended', async () => (await get()).endedAt);
    const resumed = await t.owner.call('sessions.resume', { id: s.id });
    const line = await launchLine(t.core, resumed.id);
    assert.match(line, /ARGS=resume --config tui\.notifications=/);
    // The briefing's escaped newlines become real ones in the stand-in's echo, so the rest is looked for in the whole
    // replay, once the stand-in has finished echoing a launch line that is long (hooks, MCP server, briefing).
    await waitFor('the whole launch line', () => / 01a114d3-47f0-7272-8e4b-a8c6b201a02c -m gpt-5\.5 --config model_reasoning_effort="high"\r?\n/.test(t.core.sessions.replay(resumed.id).replay));
    assert.deepEqual([resumed.conversationId, resumed.transcriptPath, resumed.cwd, resumed.cardId, resumed.model, resumed.effort],
      [T, rollout, t.projectDir, card.id, 'gpt-5.5', 'high']);
    assert.equal((await t.owner.call('sessions.tokens', { id: resumed.id })).usage?.requests, 1, 'counted from the start, before its first hook');
    await assert.rejects(t.owner.call('sessions.resume', { id: s.id }), /already running/);
    await t.owner.call('sessions.stop', { id: resumed.id });
  } finally {
    await t.close();
  }
});

test('a Codex session whose thread is not known cannot be resumed, and says why', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const s = await t.owner.call('sessions.start', { projectId: project.id, provider: 'codex' });
    await t.owner.call('sessions.stop', { id: s.id });
    await waitFor('ended', async () => (await t.owner.call('sessions.get', { id: s.id })).session.endedAt);
    await assert.rejects(t.owner.call('sessions.resume', { id: s.id }), /Codex didn’t say which conversation this session was/);
  } finally {
    await t.close();
  }
});


for (const change of ['atomic replacement', 'in-place rewrite'] as const) {
  test(`owner token RPC freshness: ${change} updates session and card totals`, async () => {
    const t = await testCore({ codexHookProbe: stubProbe(), launcher: codexWithToken });
    try {
      const project = await t.owner.call('projects.add', { path: t.projectDir });
      const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Owned token freshness' });
      const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'codex', cardId: card.id });
      const token = await tokenOf(t.core, session.id);
      const thread = '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
      const folder = join(t.dir, 'home', '.codex', 'sessions', '2026', '10', '07');
      const path = join(folder, `rollout-2026-10-07T00-00-00-${thread}.jsonl`);
      const record = (input: number): string => [
        { type: 'session_meta', payload: { id: thread } },
        { type: 'event_msg', payload: { type: 'token_count', info: {
          total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 10, total_tokens: input + 10 },
          last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 10, total_tokens: input + 10 },
          model_context_window: 1000,
        } } },
      ].map((value) => JSON.stringify(value) + '\n').join('');
      mkdirSync(folder, { recursive: true });
      writeFileSync(path, record(100), { flag: 'wx', mode: 0o600 });
      assert.deepEqual(await t.owner.call('sessions.tokens', { id: session.id }), { usage: null, note: CODEX_UNCOUNTED });
      assert.equal(await relay(t.core, token, 'SessionStart', {
        session_id: thread, transcript_path: path, cwd: t.projectDir, hook_event_name: 'SessionStart', source: 'startup',
      }), '');
      const linked = (await t.owner.call('sessions.get', { id: session.id })).session;
      assert.equal(linked.conversationId, thread); assert.equal(linked.transcriptPath, path);
      const sessionTotal = async (): Promise<number | undefined> => (await t.owner.call('sessions.tokens', { id: session.id })).usage?.input;
      const cardTotal = async (): Promise<number | undefined> => (await t.owner.call('cards.tokens', { id: card.id })).usage?.input;
      const readers = change === 'atomic replacement' ? [sessionTotal, cardTotal] : [cardTotal, sessionTotal];
      for (const read of readers) assert.equal(await read(), 100, 'both owner endpoints warm the shared cache');
      const before = statSync(path);
      if (change === 'atomic replacement') {
        writeFileSync(path + '.replacement', record(250), { flag: 'wx', mode: 0o600 });
        renameSync(path + '.replacement', path);
      } else {
        writeFileSync(path, record(250));
        utimesSync(path, new Date(before.atimeMs), new Date(before.mtimeMs + 2000));
      }
      const after = statSync(path);
      assert.equal(after.size, before.size, 'the mutation has no size signal');
      if (change === 'atomic replacement') assert.notEqual(after.ino, before.ino);
      else { assert.equal(after.ino, before.ino); assert.notEqual(after.mtimeMs, before.mtimeMs); }
      for (const read of readers) assert.equal(await read(), 250, 'the real owner RPC returns current bytes');
      for (const read of [...readers].reverse()) assert.equal(await read(), 250, 'the old cached value does not return');
      await t.owner.call('sessions.stop', { id: session.id });
      await waitFor('owned session ended', async () => (await t.owner.call('sessions.get', { id: session.id })).session.endedAt);
      const resumed = await t.owner.call('sessions.resume', { id: session.id });
      assert.equal(resumed.conversationId, thread);
      assert.equal((await t.owner.call('sessions.tokens', { id: resumed.id })).usage?.input, 250);
      const cardTokens = await t.owner.call('cards.tokens', { id: card.id });
      assert.equal(cardTokens.sessions, 2); assert.equal(cardTokens.uncounted, 0);
      assert.equal(cardTokens.usage?.input, 250); assert.equal(cardTokens.usage?.requests, 1, 'resumed same-thread sessions count the rollout once');
      await t.owner.call('sessions.stop', { id: resumed.id });
      await waitFor('owned resumed session ended', async () => (await t.owner.call('sessions.get', { id: resumed.id })).session.endedAt);
    } finally { await t.close(); }
  });
}
