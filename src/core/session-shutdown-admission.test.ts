// Actual owned owner RPCs, a native HTTP close callback and shell children.
// No installed agent, real account, Tailscale command or model is used.
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { Server } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { testCore, waitFor } from './test-support.ts';

function gate() {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { pending, release };
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('shutdown refuses prepared and new owner launches while native Phone close is held, then drains the existing child', async () => {
  const prepared = gate(), preparation = gate(), closing = gate(), closeCompletion = gate();
  let markers = '';
  const t = await testCore({
    launcher: provider => ({ file: '/bin/sh', args: ['-c', provider === 'shell'
      ? 'trap "" HUP; echo OWNED_READY; while IFS= read -r line; do :; done'
      : 'printf started > "$1"; echo OWNED_LATE_CHILD; exec /bin/cat', 'owned-session-fixture', join(markers, provider)] }),
    codexHookProbe: { version: async () => { prepared.release(); await preparation.pending; return null; }, list: async () => [] },
  });
  markers = join(t.dir, 'markers'); mkdirSync(markers);
  const nativeClose = Server.prototype.close;
  let armed = false, stopSettled = false;
  let stopping: Promise<void> | undefined;
  const pids = new Set<number>();
  const forced: number[] = [];
  const observe = (pending: ReturnType<typeof t.core.sessions.start>) => pending.then(session => {
    if (session.pid) pids.add(session.pid);
    return { ok: true, code: '', message: '', pid: session.pid };
  }, error => ({ ok: false, code: (error as { code?: string }).code, message: (error as Error).message, pid: null }));
  let pending: ReturnType<typeof observe> | undefined, fresh: ReturnType<typeof observe> | undefined;
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Preserved during shutdown' });
    const first = await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell' });
    assert.ok(first.pid); pids.add(first.pid);
    await waitFor('initial child ready', () => t.core.sessions.replay(first.id).replay.includes('OWNED_READY'));
    await t.owner.call('phone.enable', {});
    const port = t.core.phone.listeningPort!;
    Server.prototype.close = function (this: Server, callback?: (error?: Error) => void): Server {
      const address = this.address();
      if (!armed || !address || typeof address === 'string' || address.port !== port) return nativeClose.call(this, callback);
      armed = false;
      return nativeClose.call(this, error => {
        closing.release(); void closeCompletion.pending.then(() => callback?.(error));
      });
    };
    const snapshot = () => ({
      sessions: t.core.db.prepare('SELECT * FROM sessions ORDER BY id').all(),
      cards: t.core.db.prepare('SELECT * FROM cards ORDER BY id').all(),
      projects: t.core.db.prepare('SELECT * FROM projects ORDER BY id').all(),
      lease: t.core.db.prepare("SELECT value FROM meta WHERE key = 'core-owner'").get(),
    });
    const before = snapshot();
    pending = observe(t.owner.call('sessions.start', { projectId: project.id, provider: 'codex' }));
    await prepared.pending;
    armed = true; stopping = t.core.stop().then(() => { stopSettled = true; });
    await closing.pending;
    assert.equal(t.core.phone.listeningPort, null, 'the owned native HTTP listener actually closed');
    assert.equal(stopSettled, false, 'shutdown awaits its held native close callback');
    assert.equal(t.core.db.open, true, 'drain still owns an open database');
    preparation.release();
    const preparedResult = await pending;
    fresh = observe(t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' }));
    const freshResult = await fresh;
    assert.ok(await t.owner.call('core.hello', {}), 'the live owner transport answers during the held close');
    const outcome = { prepared: preparedResult.ok, fresh: freshResult.ok,
      preparedCode: preparedResult.code, freshCode: freshResult.code,
      sessions: t.core.sessions.list({}).length, terminals: t.core.sessions.terminalCount,
      firstAlive: alive(first.pid), latePids: [...pids].filter(pid => pid !== first.pid) };
    assert.deepEqual(outcome, { prepared: false, fresh: false, preparedCode: 'refused', freshCode: 'refused',
      sessions: 1, terminals: 1, firstAlive: true, latePids: [] });
    assert.match(preparedResult.message, /shutting down/); assert.match(freshResult.message, /shutting down/);
    assert.deepEqual(snapshot(), before, 'refusal preserves exact session/card/project/ownership rows while Phone close is held');
    assert.equal(existsSync(join(markers, 'codex')), false); assert.equal(existsSync(join(markers, 'claude')), false);
    closeCompletion.release(); await stopping;
    assert.equal(t.core.db.open, false); assert.equal(t.core.sessions.terminalCount, 0);
    assert.equal(alive(first.pid), false, 'the original HUP-resistant child really terminates before completion');
    const db = new Database(t.core.paths.database, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare('SELECT id, pid, state, ended_at, activity FROM sessions').all() as { id: string; pid: number | null; state: string; ended_at: number | null; activity: string | null }[];
      assert.equal(rows.length, 1); assert.equal(rows[0]!.id, first.id); assert.equal(rows[0]!.pid, first.pid);
      assert.equal(rows[0]!.state, 'ended'); assert.equal(rows[0]!.activity, 'Stopped'); assert.ok(rows[0]!.ended_at);
      assert.deepEqual(db.prepare('SELECT * FROM cards ORDER BY id').all(), before.cards);
      assert.deepEqual(db.prepare('SELECT * FROM projects ORDER BY id').all(), before.projects);
      assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'core-owner'").get(), undefined, 'lease releases only after child drain');
    } finally { db.close(); }
  } finally {
    preparation.release(); closeCompletion.release(); await pending; await fresh; await stopping;
    Server.prototype.close = nativeClose;
    await t.close();
    for (const pid of pids) if (alive(pid)) { forced.push(pid); process.kill(pid, 'SIGKILL'); }
  }
  assert.deepEqual(forced, [], 'normal cleanup needs no extra child kill');
});
