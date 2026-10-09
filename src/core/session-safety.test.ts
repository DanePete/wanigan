import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { launcher, savedConversation, sh, testCore, waitFor } from './test-support.ts';

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('resuming a removed worktree refuses instead of moving its conversation to the main checkout', async () => {
  const t = await testCore();
  try {
    await sh('git init -q -b main && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m init', t.projectDir);
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Own branch' });
    const first = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude', cardId: card.id, isolate: true });
    savedConversation(join(t.dir, 'home'), first);
    await t.owner.call('sessions.stop', { id: first.id });
    await waitFor('ended', () => t.core.sessions.get(first.id).endedAt);
    await t.owner.call('cards.move', { id: card.id, status: 'archived' });
    assert.notEqual(first.cwd, t.projectDir);
    rmSync(first.cwd!, { recursive: true, force: true });
    await assert.rejects(t.owner.call('sessions.resume', { id: first.id }), /folder.*(missing|no longer)|restore.*folder/i);
    const sessions = await t.owner.call('sessions.list', {});
    assert.equal(sessions.length, 1, 'refusal creates no session in another checkout');
    assert.equal(sessions[0]!.cwd, first.cwd);
    assert.equal(t.core.sessions.terminalCount, 0);
  } finally { await t.close(); }
});

test('shutdown refuses a launch awaiting preparation and leaves no late child alive', async () => {
  let release!: () => void;
  let probing = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const t = await testCore({
    launcher: provider => provider === 'shell'
      ? { file: '/bin/sh', args: ['-c', 'trap "" HUP; echo STOP_READY; while IFS= read -r line; do :; done'] }
      : launcher(provider),
    codexHookProbe: { version: async () => { probing = true; await gate; return null; }, list: async () => [] },
  });
  let latePid: number | null = null;
  let stopping: Promise<void> | null = null;
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const first = await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell' });
    await waitFor('initial child ready', () => t.core.sessions.replay(first.id).replay.includes('STOP_READY'));
    const starting = t.owner.call('sessions.start', { projectId: project.id, provider: 'codex' }).then(
      session => { latePid = session.pid; return null; }, (error: Error) => error);
    await waitFor('launch awaiting preparation', () => probing);
    stopping = t.core.stop();
    release();
    const error = await starting;
    assert.ok(error, 'shutdown must refuse the pending start');
    assert.match(error.message, /shutting down/);
    await stopping;
    assert.equal(t.core.db.open, false);
    assert.equal(t.core.sessions.terminalCount, 0);
    assert.equal(alive(first.pid!), false);
    assert.equal(latePid, null, 'no late process was launched');
  } finally {
    release();
    if (latePid && alive(latePid)) process.kill(latePid, 'SIGKILL');
    await stopping;
    await t.close();
  }
});

test('a scrollback initialization failure records a failed start without spawning a child', async () => {
  const t = await testCore();
  let pid: number | null = null;
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const dir = join(t.core.paths.dataDir, 'scrollback');
    rmSync(dir, { recursive: true });
    writeFileSync(dir, 'not a directory');
    await assert.rejects(t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' }), /ENOTDIR/);
    const rows = t.core.db.prepare('SELECT pid, state, ended_at FROM sessions').all() as { pid: number | null; state: string; ended_at: number | null }[];
    assert.equal(rows.length, 1);
    pid = rows[0]!.pid;
    assert.equal(pid, null, 'required storage is opened before any PTY');
    assert.equal(rows[0]!.state, 'failed');
    assert.ok(rows[0]!.ended_at);
    assert.equal(t.core.sessions.terminalCount, 0);
  } finally {
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    await t.close();
  }
});

test('a failed PID write terminates the new child and records the failed start', async (test) => {
  const t = await testCore();
  let pid: number | null = null;
  const prepare = t.core.db.prepare.bind(t.core.db);
  let armed = true;
  test.mock.method(t.core.db, 'prepare', (sql: string) => {
    const statement = prepare(sql);
    if (armed && sql === 'UPDATE sessions SET pid = ? WHERE id = ?') {
      statement.run = ((...params: unknown[]) => {
        armed = false;
        pid = params[0] as number;
        throw new Error('Fixture PID write failed');
      }) as typeof statement.run;
    }
    return statement;
  });
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    await assert.rejects(t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' }), /Fixture PID write failed/);
    assert.ok(pid);
    await waitFor('refused child to exit', () => !alive(pid!), 1_000);
    const row = prepare('SELECT pid, state, ended_at FROM sessions').get() as { pid: number | null; state: string; ended_at: number | null };
    assert.equal(row.pid, null);
    assert.equal(row.state, 'failed');
    assert.ok(row.ended_at);
    assert.equal(t.core.sessions.terminalCount, 0);
  } finally {
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    await t.close();
  }
});
