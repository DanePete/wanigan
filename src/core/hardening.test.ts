// Regressions for what the independent review of 6 October 2026 found. Each
// test is the review's reproduction, turned around to assert the fix.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { CoreClient } from '../client/client.ts';
import { Core } from './core.ts';
import { relay, sh, testCore, tokenOf, waitFor } from './test-support.ts';

const lastEvent = (core: Core, sessionId: string): { event: string; tool: string | null } =>
  core.db.prepare('SELECT event, tool FROM session_events WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(sessionId) as { event: string; tool: string | null };

test('a hook body that arrives after its header is still read', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
    const token = await tokenOf(t.core, session.id);

    // A raw client: the header, then the body 30 ms later.
    await new Promise<void>((resolve) => {
      const s = connect(t.core.paths.hookSocket, () => {
        s.write(`${token} PreToolUse\n`);
        setTimeout(() => s.end(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: join(t.projectDir, 'a.ts') } })), 30);
      });
      s.on('close', () => resolve());
      s.on('error', () => resolve());
    });
    assert.equal(lastEvent(t.core, session.id).tool, 'Edit');

    // The real relay, with the agent's stdin arriving late.
    await relay(t.core, token, 'PostToolUse', { tool_name: 'Write', tool_input: { file_path: join(t.projectDir, 'b.ts') } }, 40);
    assert.equal(lastEvent(t.core, session.id).tool, 'Write');

    // And many in a row, none losing its body.
    for (let i = 0; i < 40; i++) {
      await relay(t.core, token, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: `echo ${i}` } });
      assert.equal(lastEvent(t.core, session.id).tool, 'Bash', `hook ${i}`);
    }
    await t.owner.call('sessions.stop', { id: session.id });
  } finally {
    await t.close();
  }
});

test('a refused start leaves nothing running, and a double click starts one session', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const x = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'X' });
    const y = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Y' });
    // Session A works X, and also claims Y through the CLI.
    const a = await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell', cardId: x.id });
    await t.owner.call('sessions.input', { id: a.id, data: `wanigan claim ${y.key}\n` });
    await waitFor('claim', () => t.core.sessions.replay(a.id).replay.includes(`Claimed ${y.key}`));

    const held = await t.owner.call('cards.get', { id: y.id });
    assert.equal(held.live?.sessionId, a.id, 'the card is live through the session holding its claim');

    const before = (await t.owner.call('sessions.list', { live: true })).length;
    await assert.rejects(t.owner.call('sessions.start', { projectId: project.id, provider: 'claude', cardId: y.id }), /live session/);
    assert.equal((await t.owner.call('sessions.list', { live: true })).length, before, 'no agent was left running');

    const z = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Z' });
    const results = await Promise.allSettled([
      t.owner.call('sessions.start', { projectId: project.id, provider: 'claude', cardId: z.id }),
      t.owner.call('sessions.start', { projectId: project.id, provider: 'claude', cardId: z.id }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    const onZ = (await t.owner.call('sessions.list', { live: true })).filter((s) => s.cardId === z.id);
    assert.equal(onZ.length, 1);

    // Attaching a second live session to a card that has one is refused too.
    const loose = await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell' });
    await assert.rejects(t.owner.call('sessions.attach', { id: loose.id, cardId: z.id }), /already has a live session/);
    for (const s of await t.owner.call('sessions.list', { live: true })) await t.owner.call('sessions.stop', { id: s.id });
  } finally {
    await t.close();
  }
});

test('a claim survives the machine sleeping while its session runs', async () => {
  let clock = Date.now();
  const t = await testCore({ now: () => clock });
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Long job' });
    const a = await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell', cardId: card.id });
    const b = await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell' });
    clock += 2 * 60 * 60_000; // two hours asleep: no sweep ran
    await t.owner.call('sessions.input', { id: b.id, data: `wanigan claim ${card.key}\n` });
    await waitFor('refusal', () => t.core.sessions.replay(b.id).replay.includes('Another session holds this card'));
    const now = await t.owner.call('cards.get', { id: card.id });
    assert.equal(now.claim?.sessionId, a.id);
    assert.ok((now.claim?.expiresAt ?? 0) > clock, 'the lease was renewed, not read as expired');
    await t.owner.call('sessions.stop', { id: a.id });
    await t.owner.call('sessions.stop', { id: b.id });
  } finally {
    await t.close();
  }
});

test('removing a branch is all or nothing, and a missing worktree is made again', async () => {
  const t = await testCore();
  try {
    await sh('git init -q -b main && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m init', t.projectDir);
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Branch work' });
    const s = await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell', cardId: card.id, isolate: true });
    const wt = (await t.owner.call('cards.get', { id: card.id })).worktree!;
    await sh('echo hi > f.txt && git add f.txt && git -c user.email=a@b -c user.name=a commit -q -m work', wt.path);
    await t.owner.call('sessions.stop', { id: s.id });
    await waitFor('ended', async () => !(await t.owner.call('cards.get', { id: card.id })).live);

    await assert.rejects(t.owner.call('cards.removeWorktree', { id: card.id }), /not in main, so nothing was removed/);
    assert.ok(existsSync(wt.path), 'the folder is still there');
    assert.deepEqual((await t.owner.call('cards.get', { id: card.id })).worktree, wt, 'and the card still points at it');

    // Someone deletes the folder by hand; the next session makes it again from the branch.
    rmSync(wt.path, { recursive: true, force: true });
    const again = await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell', cardId: card.id });
    assert.equal(again.cwd, wt.path);
    assert.ok(existsSync(join(wt.path, 'f.txt')), 'with the branch’s work in it');
    await t.owner.call('sessions.stop', { id: again.id });
    await waitFor('ended', async () => !(await t.owner.call('cards.get', { id: card.id })).live);

    await t.owner.call('cards.merge', { id: card.id });
    await t.owner.call('cards.removeWorktree', { id: card.id });
    assert.ok(!existsSync(wt.path));
    assert.equal((await t.owner.call('cards.get', { id: card.id })).worktree, null);
    assert.equal((await sh(`git branch --list ${wt.branch}`, t.projectDir)).trim(), '', 'the merged branch is gone');
  } finally {
    await t.close();
  }
});

test('untracked links are shown as links, odd files never block, and a flood is capped', async () => {
  const t = await testCore();
  try {
    await sh('git init -q -b main && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m init', t.projectDir);
    const outside = join(t.dir, 'secret.txt');
    writeFileSync(outside, 'outside-the-project\n');
    symlinkSync(outside, join(t.projectDir, 'link'));
    // Git never lists a FIFO itself, but it lists a link to one; reading through it would block forever.
    await sh('mkfifo ../fifo', t.projectDir);
    symlinkSync(join(t.dir, 'fifo'), join(t.projectDir, 'pipe'));
    const project = await t.owner.call('projects.add', { path: t.projectDir });

    const changes = await t.owner.call('projects.changes', { id: project.id });
    assert.deepEqual(changes.files.map((f) => f.path).sort(), ['link', 'pipe']);
    const link = await t.owner.call('projects.diff', { id: project.id, path: 'link' });
    assert.match(link.diff, /Symbolic link to .*secret\.txt/);
    assert.doesNotMatch(link.diff, /outside-the-project/, 'the target is never read');
    assert.match((await t.owner.call('projects.diff', { id: project.id, path: 'pipe' })).diff, /Symbolic link to .*fifo/);
    await assert.rejects(t.owner.call('projects.diff', { id: project.id, path: '../secret.txt' }), /outside the project/);

    mkdirSync(join(t.projectDir, 'build'));
    await sh('i=0; while [ $i -lt 2100 ]; do echo x > build/f$i; i=$((i+1)); done', t.projectDir);
    const flood = await t.owner.call('projects.changes', { id: project.id });
    assert.equal(flood.files.length, 2_000);
    assert.equal(flood.omitted, 102);
  } finally {
    await t.close();
  }
});

test('an AI review cut short by a stop is recorded as failed, then and after a restart', async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'wg-reviewer-')));
  const reviewer = join(scratch, 'slow-reviewer.sh');
  writeFileSync(reviewer, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });

  const t = await testCore({ claudeBinary: reviewer });
  let card: { id: string };
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Check me' });
    const started = await t.owner.call('cards.aiReview', { id: card.id });
    assert.equal(started.state, 'running');
    await assert.rejects(t.owner.call('cards.aiReview', { id: card.id }), /already running/);
    assert.ok(t.core.reviews.busy, 'a running review keeps an idle core alive');
  } finally {
    t.owner.close();
    await t.core.stop();
    rmSync(scratch, { recursive: true, force: true });
  }

  // A new core on the same data: the row says what happened.
  const again = new Core({
    dataDir: t.core.paths.dataDir, codexHookProbe: null,
    accounts: { home: join(t.dir, 'home'), prober: async () => ({ signedIn: 'unknown', identity: null, plan: null }), usageReader: async () => ({ state: 'unreadable', windows: [], checkedAt: 0, note: 'test' }) },
  });
  try {
    await again.start();
    const [review] = again.reviews.list(card.id);
    assert.equal(review?.state, 'failed');
    assert.match(review?.error ?? '', /core stopped/);
    // A row left "running" by a crash is settled on the next start.
    again.db.prepare("UPDATE ai_reviews SET state = 'running', error = NULL").run();
    again.reviews.recover();
    assert.equal(again.reviews.list(card.id)[0]?.state, 'failed');
  } finally {
    await again.stop();
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test('board rules: review needs evidence, closed cards ask nothing, ranks never collide', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Prove it' });
    await assert.rejects(t.owner.call('cards.move', { id: card.id, status: 'review' }), /Review needs evidence/);
    await t.owner.call('cards.evidence', { id: card.id, evidence: { kind: 'note', value: 'Checked by hand.' } });
    assert.equal((await t.owner.call('cards.move', { id: card.id, status: 'review' })).status, 'review');

    // A question on a card that is then archived stops asking for an answer.
    const asked = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Unclear' });
    const s = await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell', cardId: asked.id });
    await t.owner.call('sessions.input', { id: s.id, data: `wanigan ask ${asked.key} "Which page?"\n` });
    await waitFor('question', async () => (await t.owner.call('needs.list', {})).some((n) => n.kind === 'question' && n.cardId === asked.id));
    await t.owner.call('sessions.stop', { id: s.id });
    await t.owner.call('cards.move', { id: asked.id, status: 'archived' });
    assert.ok(!(await t.owner.call('needs.list', {})).some((n) => n.kind === 'question' && n.cardId === asked.id));

    // Dropping card after card into the same gap.
    const a = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'A' });
    const b = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'B' });
    await t.owner.call('cards.move', { id: b.id, status: 'ready', before: a.id, after: null });
    const inserted: string[] = [];
    let next = b.id;
    for (let i = 0; i < 60; i++) {
      const c = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: `C${i}` });
      await t.owner.call('cards.move', { id: c.id, status: 'ready', before: a.id, after: next });
      inserted.unshift(c.id);
      next = c.id;
    }
    const ready = (await t.owner.call('cards.list', { projectId: project.id })).filter((c) => c.status === 'ready');
    const ranks = ready.map((c) => c.rank);
    assert.equal(new Set(ranks).size, ranks.length, 'every rank is distinct');
    const order = [...ready].sort((p, q) => p.rank - q.rank).map((c) => c.id);
    const from = order.indexOf(a.id);
    assert.deepEqual(order.slice(from, from + 62), [a.id, ...inserted, b.id]);
  } finally {
    await t.close();
  }
});

test('a late hook does not rewrite how a session ended; a session is not told where the data is', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
    const token = await tokenOf(t.core, session.id);
    await relay(t.core, token, 'SessionStart', {});

    const asSession = await CoreClient.connect(t.core.paths.socket, token);
    const hello = await asSession.call('core.hello', {});
    assert.equal(hello.role, 'session');
    assert.equal(hello.dataDir, null);
    asSession.close();
    assert.ok((await t.owner.call('core.hello', {})).dataDir);

    await t.owner.call('sessions.stop', { id: session.id });
    const ended = await waitFor('ended', async () => {
      const s = (await t.owner.call('sessions.get', { id: session.id })).session;
      return s.endedAt ? s : null;
    });
    await relay(t.core, token, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: join(t.projectDir, 'late.ts') } });
    const after = (await t.owner.call('sessions.get', { id: session.id })).session;
    assert.equal(after.activity, ended.activity);
    assert.equal(after.state, ended.state);
  } finally {
    await t.close();
  }
});

test('Codex: Enter on an empty line or a /command is not a turn', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'codex' });
    const state = async (): Promise<string> => (await t.owner.call('sessions.get', { id: session.id })).session.state;
    await waitFor('ready', () => t.core.sessions.replay(session.id).replay.includes('codex ready'));
    await t.owner.call('sessions.input', { id: session.id, data: 'done\r' });
    await waitFor('waiting', async () => (await state()) === 'waiting');

    await t.owner.call('sessions.input', { id: session.id, data: '\r' });
    await t.owner.call('sessions.input', { id: session.id, data: '/status\r' });
    await t.owner.call('sessions.input', { id: session.id, data: 'abc\x7f\x7f\x7f\r' });
    await waitFor('echo', () => t.core.sessions.replay(session.id).replay.includes('got: /status'));
    assert.equal(await state(), 'waiting');

    await t.owner.call('sessions.input', { id: session.id, data: 'fix the header\r' });
    await waitFor('working', async () => (await state()) === 'working');
    await t.owner.call('sessions.stop', { id: session.id });
  } finally {
    await t.close();
  }
});

test('a session starts with the model and effort chosen, keeps them, and refuses anything that is not a name', async () => {
  const t = await testCore({ codexModels: async () => [{ value: 'gpt-5.5', label: 'GPT-5.5', detail: null, efforts: ['low', 'high'], defaultEffort: 'low', isDefault: true }] });
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const claude = await t.owner.call('sessions.models', { provider: 'claude', projectId: project.id });
    assert.ok(claude.models.some((m) => m.value === 'claude-opus-5-5'));
    assert.deepEqual(claude.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
    const codex = await t.owner.call('sessions.models', { provider: 'codex', projectId: project.id });
    assert.equal(codex.source, 'live');
    assert.deepEqual(codex.models.map((m) => [m.value, m.efforts]), [['gpt-5.5', ['low', 'high']]]);

    const s = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' });
    assert.equal(s.model, 'claude-opus-5-5');
    assert.equal(s.effort, 'xhigh');
    const args = await waitFor('args', () => t.core.sessions.replay(s.id).replay.match(/ARGS=(.*)/)?.[1]);
    assert.match(args, /--model claude-opus-5-5 --effort xhigh/);

    const c = await t.owner.call('sessions.start', { projectId: project.id, provider: 'codex', model: 'gpt-5.5', effort: 'high' });
    const codexOut = await waitFor('codex args', () => {
      const out = t.core.sessions.replay(c.id).replay;
      return out.includes('model_reasoning_effort') ? out : null;
    });
    assert.match(codexOut, /-m gpt-5\.5 --config model_reasoning_effort="high"/);

    await assert.rejects(t.owner.call('sessions.start', { projectId: project.id, provider: 'claude', model: '--dangerously-skip-permissions' }), /not a model name/);
    await assert.rejects(t.owner.call('sessions.start', { projectId: project.id, provider: 'claude', effort: 'ultra' }), /effort is one of/);
    for (const x of await t.owner.call('sessions.list', { live: true })) await t.owner.call('sessions.stop', { id: x.id });
  } finally {
    await t.close();
  }
});

test('from the audit: bad stored rows, bad evidence shapes and an unreadable socket line are refused, never thrown', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Rows' });
    // One unreadable stored review must not break the card that shows it.
    t.core.db.prepare("INSERT INTO ai_reviews (id, card_id, project_id, state, started_at, finished_at, result_json) VALUES ('r1', ?, ?, 'done', 1, 2, '{not json')")
      .run(card.id, project.id);
    const shown = await t.owner.call('cards.get', { id: card.id });
    assert.equal(shown.id, card.id);

    // Evidence is a short list of { kind, value } strings.
    await assert.rejects(t.owner.call('cards.evidence', { id: card.id, evidence: 'proof' as never }), /has a kind and a value/);
    await assert.rejects(t.owner.call('cards.evidence', { id: card.id, evidence: { kind: 'note', value: 7 } as never }), /has a kind and a value/);
    await t.owner.call('cards.evidence', { id: card.id, evidence: { kind: 'note', value: 'Checked by hand.' } });

    // A peer that is not the core's protocol fails the connection; nothing throws out of the socket.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wg-sock-')));
    const path = join(dir, 's');
    const { createServer } = await import('node:net');
    const peers: { destroy(): void }[] = [];
    const server = createServer((s) => { peers.push(s); s.write('not json\n'); });
    await new Promise<void>((ok) => server.listen(path, ok));
    await assert.rejects(CoreClient.connect(path, 'token'), /sent something unreadable/);
    for (const s of peers) s.destroy();
    await new Promise<void>((ok) => server.close(() => ok()));
    rmSync(dir, { recursive: true, force: true });
  } finally {
    await t.close();
  }
});

test('stopping the core never waits on a client that stays connected', async () => {
  const t = await testCore();
  const project = await t.owner.call('projects.add', { path: t.projectDir });
  const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
  // An agent's client left open, as a test that throws or a hung CLI would leave it.
  await CoreClient.connect(t.core.paths.socket, await tokenOf(t.core, session.id));
  const stopped = await Promise.race([t.close().then(() => true), new Promise<boolean>((ok) => setTimeout(() => ok(false), 10_000))]);
  assert.ok(stopped, 'the core stopped within 10 seconds');
});
