// Talk to Wanigan against a stand-in `claude`: it records every call (its
// arguments, account folder, working folder and the message on stdin) and
// answers like the real CLI's JSON result, with a session id to resume. The
// real CLI is never called.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { CoreClient } from '../client/client.ts';
import { ACCESS } from '../shared/protocol.ts';
import type { ChatThread } from '../shared/chat.ts';
import { Core } from './core.ts';
import { openDatabase } from './db.ts';
import { STATE_CAP, deskState } from './chat-context.ts';
import { CLI, launcher, testCore, tokenOf, waitFor, type TestCore } from './test-support.ts';

const ANSWER = 'SIT-1 is waiting on your review. SIT-404 is not a card.';

/** A stand-in for `claude -p`. Each call is recorded as call-<n>.{args,env,stdin}. */
function fakeClaude(dir: string): string {
  const file = join(dir, 'fake-claude-chat.sh');
  writeFileSync(file, [
    '#!/bin/sh',
    'dir="$WG_CHAT_DIR"',
    'mkdir -p "$dir"',
    'n=$(( $(cat "$dir/count" 2>/dev/null || echo 0) + 1 ))',
    'echo $n > "$dir/count"',
    'call="$dir/call-$n"',
    'printf \'%s\\0\' "$@" > "$call.args"',
    'echo "CFG=${CLAUDE_CONFIG_DIR-unset}" > "$call.env"',
    'echo "CWD=$(pwd)" >> "$call.env"',
    'cat > "$call.stdin"',
    'touch "$call.ready"',
    'resume=""; prev=""',
    'for a in "$@"; do [ "$prev" = "--resume" ] && resume="$a"; prev="$a"; done',
    'if [ -n "$WG_CHAT_SLEEP" ]; then sleep "$WG_CHAT_SLEEP"; echo late > "$call.late"; fi',
    'if [ -n "$resume" ] && [ -n "$WG_CHAT_FORGET" ]; then echo "No conversation found with session ID: $resume" >&2; exit 1; fi',
    'if [ -n "$WG_CHAT_FAIL" ]; then echo "auth expired" >&2; exit 1; fi',
    `printf '{"type":"result","subtype":"success","is_error":false,"result":"%s","session_id":"%s","total_cost_usd":0.03}\\n' "${ANSWER}" "\${resume:-sess-$n}"`,
  ].join('\n'), { mode: 0o755 });
  return file;
}

interface Call { args: string[]; cfg: string; cwd: string; stdin: string; late: boolean }

describe('talk to wanigan', () => {
  let t: TestCore;
  let fakes: string;
  let calls: string;
  let projectId: string;
  const call = (n: number): Call => {
    const base = join(calls, `call-${n}`);
    const env = readFileSync(`${base}.env`, 'utf8');
    return {
      args: readFileSync(`${base}.args`, 'utf8').split('\0').slice(0, -1),
      cfg: env.match(/^CFG=(.*)$/m)?.[1] ?? '',
      cwd: env.match(/^CWD=(.*)$/m)?.[1] ?? '',
      stdin: readFileSync(`${base}.stdin`, 'utf8'),
      late: existsSync(`${base}.late`),
    };
  };
  const count = (): number => (existsSync(join(calls, 'count')) ? Number(readFileSync(join(calls, 'count'), 'utf8')) : 0);
  const after_ = (args: string[], flag: string, n = 1): string[] => args.slice(args.indexOf(flag) + 1, args.indexOf(flag) + 1 + n);
  const settled = (scope: { projectId?: string }) => waitFor('answer', async () => {
    const thread = await t.owner.call('chat.list', scope);
    return thread.turns.length && thread.turns.every((x) => x.state !== 'running') ? thread : null;
  });

  before(async () => {
    fakes = realpathSync(mkdtempSync(join(tmpdir(), 'wg-chat-')));
    calls = join(fakes, 'calls');
    process.env.WG_CHAT_DIR = calls;
    t = await testCore({ claudeBinary: fakeClaude(fakes) });
  });

  after(async () => {
    await t?.close();
    delete process.env.WG_CHAT_DIR;
    if (fakes) rmSync(fakes, { recursive: true, force: true });
  });

  test('nothing runs until the owner sends a message', async () => {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    projectId = project.id;
    const here = await t.owner.call('chat.list', { projectId });
    const everywhere = await t.owner.call('chat.list', {});
    assert.deepEqual([here.id, here.turns, everywhere.id, everywhere.turns], [null, [], null, []]);
    const fallback = (await t.owner.call('accounts.list', {})).find((a) => a.provider === 'claude' && a.isDefault);
    assert.equal(here.accountId, fallback?.id, 'the hint names the account a message would use');
    assert.equal(count(), 0, 'opening the chat calls nothing');
    await assert.rejects(t.owner.call('chat.send', { projectId, text: '   ' }), /Write a message/);
    await assert.rejects(t.owner.call('chat.send', { projectId, text: 'x'.repeat(4_001) }), /under 4,000/);
    assert.equal(count(), 0, 'nor does a message that is refused');
  });

  test('in a project: read-only tools, the project folder, and the desk state with needs and cards', async () => {
    const review = await t.owner.call('cards.create', { projectId, type: 'feature', title: 'Free shipping banner over $75' });
    await t.owner.call('criteria.add', { cardId: review.id, text: 'Banner shows under $75' });
    const working = await t.owner.call('cards.create', { projectId, type: 'bug', title: 'Checkout button has no accessible name' });
    await t.owner.call('decisions.add', { projectId, title: 'Use pnpm, never npm' });
    const submitter = await t.owner.call('sessions.start', { projectId, provider: 'shell', cardId: review.id, title: 'Banner work' });
    t.core.board.submit(submitter.id, review.id, [{ kind: 'note', value: 'Tested 74.99 and 75.00' }]);
    t.core.board.comment(`session:${submitter.id}`, review.id, 'Cart drawer too, or only the cart page?', 'question');
    await t.owner.call('sessions.stop', { id: submitter.id });
    await waitFor('ended', async () => (await t.owner.call('sessions.get', { id: submitter.id })).session.state === 'ended');
    await t.owner.call('sessions.start', { projectId, provider: 'shell', cardId: working.id, title: 'Label fix' });
    assert.equal(review.key, 'SIT-1');

    const started = await t.owner.call('chat.send', { projectId, text: 'What needs me?' });
    assert.equal(started.turns.at(-1)?.state, 'running', 'it returns at once, with the answer on its way');
    const thread = await settled({ projectId });
    const turn = thread.turns[0]!;
    assert.equal(turn.state, 'done');
    assert.equal(turn.answer, ANSWER);
    assert.equal(turn.costUsd, 0.03, 'the cost the CLI reported is kept');
    assert.deepEqual(turn.cards, ['SIT-1'], 'only real cards become links');
    assert.equal(turn.continued, false);

    const { args, cwd, cfg, stdin } = call(1);
    assert.equal(cwd, t.projectDir, 'it runs in the project folder');
    assert.equal(cfg, 'unset', 'the default account sets no folder');
    assert.deepEqual(args.slice(0, 3), ['-p', '--output-format', 'json']);
    assert.deepEqual(after_(args, '--tools'), ['Read,Grep,Glob'], 'only read-only tools exist');
    assert.deepEqual(after_(args, '--allowedTools', 3), ['Read', 'Grep', 'Glob']);
    for (const tool of ['Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch']) {
      assert.ok(args.indexOf(tool) > args.indexOf('--disallowedTools'), `${tool} is refused`);
    }
    assert.ok(args.includes('--strict-mcp-config'), 'no MCP server from the owner’s configuration joins in');
    assert.ok(args.includes('--safe-mode'), 'custom hooks and skills cannot run in an advice-only chat');
    assert.deepEqual(after_(args, '--setting-sources'), [''], 'project settings cannot alter an advice-only chat');
    assert.ok(!args.includes('--resume'), 'a first message starts a conversation');
    assert.ok(!args.includes('--no-session-persistence'), 'the conversation is kept, so it can be continued');
    const system = after_(args, '--system-prompt')[0] ?? '';
    assert.match(system, /You are Wanigan/);
    assert.match(system, /advice only/);
    assert.ok(system.includes(t.projectDir), 'it knows which project it is in');
    assert.ok(!args.some((a) => a.includes('What needs me?')), 'the message goes on stdin, never as an argument');

    assert.match(stdin, /^<wanigan-state>\nWanigan's state at /);
    assert.match(stdin, /Ready for review: SIT-1 "Free shipping banner over \$75"/, 'needs are in it');
    assert.match(stdin, /Question from an agent: SIT-1 .*Cart drawer too/);
    assert.match(stdin, /In Review[^\n]*:\n- SIT-1 "Free shipping banner over \$75" \(feature, P2\): submitted [^;]+; criteria 0\/1 ticked; 1 evidence; 1 open question/, 'cards in Review');
    assert.match(stdin, /In Working:\n- SIT-2 "Checkout button has no accessible name" \(bug, P2\): Shell session running/, 'cards in Working, with their session');
    assert.match(stdin, /Shell "Label fix" on SIT-2: running/, 'live sessions');
    assert.match(stdin, /SIT site \(this chat\): 0 inbox, 0 ready, 1 working, 1 review, 0 done; 1 live session; 2 need the owner/, 'projects, with counts');
    assert.match(stdin, /Decisions in force for SIT[^\n]*:\n- Use pnpm, never npm/, 'the project’s decisions');
    assert.match(stdin, /\n<\/wanigan-state>\n\nThe owner asks:\nWhat needs me\?$/);
    assert.ok(stdin.length < STATE_CAP + 200);
  });

  test('a follow-up continues the same Claude conversation, and an unchanged state is not sent again', async () => {
    await t.owner.call('chat.send', { projectId, text: 'Anything else?' });
    const thread = await settled({ projectId });
    assert.equal(thread.turns.length, 2);
    assert.equal(thread.turns[1]?.continued, true);
    const { args, stdin } = call(2);
    assert.deepEqual(after_(args, '--resume'), ['sess-1'], 'it resumes the conversation the first answer started');
    assert.match(stdin, /Unchanged since the owner’s last message\.\n<\/wanigan-state>/);
    assert.doesNotMatch(stdin, /Needs the owner/);
  });

  test('naming a card brings that card in full', async () => {
    await t.owner.call('chat.send', { projectId, text: 'What is SIT-1 waiting on?' });
    await settled({ projectId });
    const { stdin, args } = call(3);
    assert.deepEqual(after_(args, '--resume'), ['sess-1']);
    assert.match(stdin, /Cards the owner named:\n- SIT-1 "Free shipping banner over \$75": feature, P2, in Review/);
    assert.match(stdin, /SIT-1 criteria: \[ \] Banner shows under \$75/);
    assert.match(stdin, /SIT-1 comment, [^,]+, An agent \(question, still open\): Cart drawer too/);
  });

  test('across every project: no tools at all, Wanigan’s own folder, and a conversation of its own', async () => {
    await t.owner.call('chat.send', { text: 'Summarize what the agents did today' });
    const thread = await settled({});
    assert.equal(thread.projectId, null);
    assert.equal(thread.turns.length, 1);
    const { args, cwd, stdin } = call(4);
    assert.deepEqual(after_(args, '--tools'), [''], 'no tools');
    assert.ok(!args.includes('--allowedTools'));
    assert.ok(args.includes('--disallowedTools') && args.includes('--strict-mcp-config'));
    assert.ok(!args.includes('--resume'), 'the project’s conversation is not this one');
    assert.equal(cwd, join(t.core.paths.dataDir, 'chat'), 'an empty folder of Wanigan’s own, never a repository');
    assert.match(after_(args, '--system-prompt')[0] ?? '', /no tools here/);
    assert.match(stdin, /covering every open project/);
    assert.doesNotMatch(stdin, /Decisions in force/);
    assert.equal((await t.owner.call('chat.list', { projectId })).turns.length, 3, 'the project’s conversation is untouched');
  });

  test('a running answer can be stopped, and what it says afterwards is not kept', async () => {
    process.env.WG_CHAT_SLEEP = '1.5';
    let started: ChatThread;
    try {
      started = await t.owner.call('chat.send', { projectId, text: 'A slow question' });
    } finally {
      delete process.env.WG_CHAT_SLEEP;
    }
    assert.equal(started.turns.at(-1)?.state, 'running');
    await assert.rejects(t.owner.call('chat.send', { projectId, text: 'And another' }), /still answering/, 'one answer at a time');
    await assert.rejects(t.owner.call('chat.reset', { projectId }), /still answering/);
    // The env file is written before stdin; cancellation must wait for the complete recorded call.
    await waitFor('the stand-in to have captured stdin', () => existsSync(join(calls, 'call-5.ready')));
    const stopped = await t.owner.call('chat.cancel', { projectId });
    assert.equal(stopped.turns.at(-1)?.state, 'stopped');
    assert.match(stopped.turns.at(-1)?.error ?? '', /Stopped before Wanigan answered/);
    await new Promise((r) => setTimeout(r, 2_000));
    assert.equal(call(5).late, false, 'the stand-in was ended, not left to answer');
    const later = await t.owner.call('chat.list', { projectId });
    assert.equal(later.turns.at(-1)?.state, 'stopped', 'and nothing it might have said was recorded');
    assert.equal(later.turns.at(-1)?.answer, null);

    process.env.WG_CHAT_FAIL = '1';
    try {
      await t.owner.call('chat.send', { projectId, text: 'Will this fail?' });
      const failed = await settled({ projectId });
      assert.equal(failed.turns.at(-1)?.state, 'failed');
      assert.match(failed.turns.at(-1)?.error ?? '', /auth expired/, 'a failure says why');
    } finally {
      delete process.env.WG_CHAT_FAIL;
    }
  });

  test('a conversation Claude no longer has is started again, once', async () => {
    const before = count();
    process.env.WG_CHAT_FORGET = '1';
    try {
      await t.owner.call('chat.send', { projectId, text: 'Still there?' });
      const thread = await settled({ projectId });
      assert.equal(thread.turns.at(-1)?.state, 'done');
      assert.equal(thread.turns.at(-1)?.continued, false, 'it says Claude started afresh');
    } finally {
      delete process.env.WG_CHAT_FORGET;
    }
    assert.equal(count(), before + 2);
    assert.ok(call(before + 1).args.includes('--resume'));
    assert.ok(!call(before + 2).args.includes('--resume'));
    assert.match(call(before + 2).stdin, /Needs the owner/, 'a new conversation is shown the whole state');
    await t.owner.call('chat.send', { projectId, text: 'And now?' });
    await settled({ projectId });
    assert.deepEqual(after_(call(before + 3).args, '--resume'), [`sess-${before + 2}`], 'later messages continue the new one');
  });

  test('a new conversation starts fresh, and the old one is kept', async () => {
    const old = await t.owner.call('chat.list', { projectId });
    const fresh = await t.owner.call('chat.reset', { projectId });
    assert.notEqual(fresh.id, old.id);
    assert.deepEqual(fresh.turns, []);
    assert.equal((await t.owner.call('chat.reset', { projectId })).id, fresh.id, 'an empty conversation is not replaced');
    await t.owner.call('chat.send', { projectId, text: 'Hello again' });
    await settled({ projectId });
    assert.ok(!call(count()).args.includes('--resume'), 'Claude starts a new conversation too');
    const kept = t.core.db.prepare('SELECT count(*) AS n FROM chat_turns WHERE thread_id = ?').get(old.id) as { n: number };
    assert.equal(kept.n, old.turns.length + old.earlier, 'the old conversation is still recorded');
  });

  test('only the owner can talk to Wanigan', async () => {
    for (const m of ['chat.list', 'chat.send', 'chat.cancel', 'chat.reset'] as const) assert.deepEqual(ACCESS[m], ['owner']);
    const s = await t.owner.call('sessions.start', { projectId, provider: 'claude' });
    const agent = await CoreClient.connect(t.core.paths.socket, await tokenOf(t.core, s.id));
    await assert.rejects(agent.call('chat.list', {}), /not available to a session/);
    await assert.rejects(agent.call('chat.send', { text: 'hi' }), /not available to a session/);
    agent.close();
    await t.owner.call('sessions.stop', { id: s.id });
  });

  test('the state sent with a message stays under its cap, and says what it left out', async () => {
    const busy = join(t.dir, 'busy-project');
    mkdirSync(busy);
    const p = await t.owner.call('projects.add', { path: busy });
    for (let i = 0; i < 90; i++) {
      const c = await t.owner.call('cards.create', { projectId: p.id, type: 'task', title: `A long card title that says a great deal about task number ${i}, and then some more` });
      await t.owner.call('cards.comment', { id: c.id, body: `Note ${i}: ${'a remark that goes on for a while, '.repeat(6)}` });
    }
    const ctx = { db: t.core.db, now: Date.now, emit: t.core.bus.emit };
    const state = deskState(ctx, { projectId: p.id, question: 'What is going on?' });
    assert.ok(state.header.length + 1 + state.body.length <= STATE_CAP, `${state.header.length + state.body.length} characters`);
    assert.match(state.body, /more not shown|Left out to fit/);
    assert.equal(deskState(ctx, { projectId: p.id, question: 'Again?' }).hash, state.hash, 'the same desk hashes the same');
  });
});

describe('talk to wanigan across a restart', () => {
  test('turns are kept, and an answer the core never got is said to be lost', async () => {
    const fakes = realpathSync(mkdtempSync(join(tmpdir(), 'wg-chat-')));
    process.env.WG_CHAT_DIR = join(fakes, 'calls');
    const claudeBinary = fakeClaude(fakes);
    const t = await testCore({ claudeBinary });
    const dataDir = join(t.dir, 'data');
    try {
      await t.owner.call('chat.send', { text: 'First question' });
      await waitFor('answer', async () => (await t.owner.call('chat.list', {})).turns[0]?.state === 'done');
      process.env.WG_CHAT_SLEEP = '5';
      try {
        await t.owner.call('chat.send', { text: 'A question the core will not see answered' });
      } finally {
        delete process.env.WG_CHAT_SLEEP;
      }
      t.owner.close();
      await t.core.stop();

      // A crash leaves a turn marked running; the next core says it is lost.
      const db = openDatabase(join(dataDir, 'wanigan.db'));
      db.prepare("UPDATE chat_turns SET state = 'running', error = NULL WHERE question = 'A question the core will not see answered'").run();
      db.close();

      const again = new Core({
        dataDir, launcher, cli: { runtime: process.execPath, entry: CLI }, claudeBinary, codexHookProbe: null,
        accounts: { home: join(t.dir, 'home'), prober: async () => ({ signedIn: 'unknown', identity: null, plan: null }), usageReader: async () => ({ state: 'unreadable', windows: [], checkedAt: 0, note: 'test' }) },
      });
      await again.start();
      try {
        const thread = again.chat.list(null);
        assert.deepEqual(thread.turns.map((x) => [x.question, x.state]), [
          ['First question', 'done'],
          ['A question the core will not see answered', 'failed'],
        ]);
        assert.equal(thread.turns[0]?.answer, ANSWER);
        assert.match(thread.turns[1]?.error ?? '', /core stopped before this answer arrived/);
      } finally {
        await again.stop();
      }
    } finally {
      delete process.env.WG_CHAT_DIR;
      rmSync(t.dir, { recursive: true, force: true });
      rmSync(fakes, { recursive: true, force: true });
    }
  });
});
