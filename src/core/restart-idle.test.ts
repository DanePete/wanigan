// Replacing a build is a core decision: no live process, background answer or
// already-admitted request may be interrupted by a stale check in the window.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { testCore, waitFor } from './test-support.ts';
import { CoreError, type Method } from '../shared/protocol.ts';
import { shellQuote } from './hooks.ts';

const METHOD = 'core.stopIfIdle' as Method;
type Stopped = { stopping: boolean; live: number; busy: boolean };

test('a quiet core stops itself after replying and refuses a racing session start', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const [stop, start] = await Promise.allSettled([
      t.owner.call(METHOD, {}) as Promise<Stopped>,
      t.owner.call('sessions.start', { projectId: project.id, provider: 'shell' }),
    ]);
    assert.equal(stop.status, 'fulfilled');
    if (stop.status === 'fulfilled') assert.deepEqual(stop.value, { stopping: true, live: 0, busy: false });
    assert.equal(start.status, 'rejected', 'no new work enters after an idle stop is accepted');
    await waitFor('the core closed its connection', () => t.owner.isClosed);
  } finally {
    await t.close();
  }
});

test('idle replacement refuses a session start already admitted before its process exists', async () => {
  const t = await testCore();
  let release = (): void => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let admitted = false;
  const start = t.core.handlers['sessions.start'];
  t.core.handlers['sessions.start'] = async () => { admitted = true; await blocked; throw new CoreError('refused', 'Test launch released.'); };
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const launch = t.owner.call('sessions.start', { projectId: project.id, provider: 'shell' }).catch((error: unknown) => error);
    await waitFor('start admitted', () => admitted);
    const stop = await t.owner.call(METHOD, {}) as Stopped;
    assert.deepEqual(stop, { stopping: false, live: 0, busy: true });
    release();
    assert.match(String(await launch), /Test launch released/);
    assert.equal((await t.owner.call('core.hello', {})).role, 'owner', 'the core still serves work');
  } finally {
    release();
    t.core.handlers['sessions.start'] = start;
    await t.close();
  }
});

test('idle replacement includes background review, chat and Jev work even with no sessions', async () => {
  const t = await testCore();
  try {
    for (const service of [t.core.reviews, t.core.chat, t.core.jev]) {
      Object.defineProperty(service, 'busy', { configurable: true, value: true });
      assert.deepEqual(await t.owner.call(METHOD, {}), { stopping: false, live: 0, busy: true });
      Reflect.deleteProperty(service, 'busy');
    }
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell' });
    assert.deepEqual(await t.owner.call(METHOD, {}), { stopping: false, live: 1, busy: false });
    assert.equal(t.core.sessions.get(session.id).state, 'running');
  } finally {
    await t.close();
  }
});


test('a running stand-in AI review survives an idle replacement request with no PTYs', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'wg-idle-review-'));
  const binary = join(fixture, 'claude');
  const begun = join(fixture, 'begun');
  const finish = join(fixture, 'finish');
  writeFileSync(binary, `#!/bin/sh\ntouch ${shellQuote(begun)}\nwhile [ ! -e ${shellQuote(finish)} ]; do sleep 0.05; done\nprintf '%s\\n' '{"structured_output":{"verdict":"unsure","summary":"Read it","check":[],"criteria":[]}}'\n`, { mode: 0o755 });
  const t = await testCore({ claudeBinary: binary });
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Review in flight' });
    const review = await t.owner.call('cards.aiReview', { id: card.id });
    await waitFor('the stand-in is running', () => existsSync(begun));
    assert.deepEqual(await t.owner.call(METHOD, {}), { stopping: false, live: 0, busy: true });
    writeFileSync(finish, 'finish');
    await waitFor('review finished intact', async () => (await t.owner.call('cards.get', { id: card.id })).reviews.some((r) => r.id === review.id && r.state === 'done'));
  } finally {
    writeFileSync(finish, 'finish');
    await t.close();
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('idle replacement keeps a terminal that is not a board session, such as account sign-in', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell' });
    // Utility terminals use the same PTY supervisor but do not appear in liveIds.
    t.core.sessions.liveIds = () => new Set();
    assert.deepEqual(await t.owner.call(METHOD, {}), { stopping: false, live: 0, busy: true });
    assert.equal((await t.owner.call('core.hello', {})).role, 'owner');
  } finally {
    await t.close();
  }
});
