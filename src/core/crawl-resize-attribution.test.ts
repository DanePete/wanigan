import assert from 'node:assert/strict';
import { test } from 'node:test';
import { qualifyStoppedResize, type EndedSession, type RpcRefusal, type SuccessfulStop } from '../../scripts/ui-crawl-refusals.ts';
import { testCore, waitFor } from './test-support.ts';

const action = { kind: 'button', label: 'Stop it', firstCall: 4 };
const refusal: RpcRefusal = { method: 'sessions.resize', code: 'refused', message: 'This session has ended.', sessionId: 'owned', callIndex: 6 };
const stops: SuccessfulStop[] = [{ sessionId: 'owned', callIndex: 4 }];
const ended: EndedSession = { id: 'owned', state: 'ended', endedAt: 123 };

test('a real successful owner stop qualifies only its later ended-session resize, keeping the refusal as evidence', async () => {
  const t = await testCore({ launcher: () => ({ file: '/bin/sh', args: ['-c', 'echo OWNED_RESIZE_READY; exec cat'] }) });
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell' });
    await waitFor('owned shell ready', () => t.core.sessions.replay(session.id).replay.includes('OWNED_RESIZE_READY'));
    await t.owner.call('sessions.resize', { id: session.id, cols: 93, rows: 27 });
    assert.equal((await t.owner.call('sessions.watch', { id: session.id })).cols, 93);
    await t.owner.call('sessions.stop', { id: session.id });
    await waitFor('owned shell ended', () => t.core.sessions.get(session.id).state === 'ended');
    let rejected: RpcRefusal | null = null;
    try { await t.owner.call('sessions.resize', { id: session.id, cols: 94, rows: 28 }); }
    catch (error) {
      assert.ok(error instanceof Error);
      rejected = { method: 'sessions.resize', code: (error as Error & { code: string }).code,
        message: error.message, sessionId: session.id, callIndex: 6 };
    }
    assert.ok(rejected, 'the real core still refuses a resize after exit');
    assert.equal(rejected.code, 'refused'); assert.equal(rejected.message, 'This session has ended.');
    const raw = JSON.stringify(rejected);
    let queried: string | null = null;
    const qualified = await qualifyStoppedResize(rejected, action, [{ sessionId: session.id, callIndex: 4 }], async id => {
      queried = id; return (await t.owner.call('sessions.get', { id })).session;
    });
    assert.ok(qualified, 'the confirmed stopped-session background resize is explicitly qualified');
    assert.equal(queried, session.id);
    assert.equal(qualified.session.id, session.id); assert.equal(qualified.session.state, 'ended');
    assert.ok(qualified.session.endedAt);
    assert.match(qualified.reason, /same session.*ended/);
    assert.equal(JSON.stringify(rejected), raw, 'raw refused RPC evidence is not rewritten or removed');
    assert.equal(t.core.sessions.terminalCount, 0);
    assert.equal((await t.owner.call('sessions.list', {})).length, 1);
    await assert.rejects(t.owner.call('sessions.input', { id: session.id, data: 'x' }), /This session has ended/);
    assert.ok((await t.owner.call('core.hello', {})).pid, 'the owner remains responsive');
  } finally { await t.close(); }
});

const invalid: [string, Partial<RpcRefusal>, Partial<typeof action>, SuccessfulStop[]][] = [
  ['input method', { method: 'sessions.input' }, {}, stops],
  ['stop method', { method: 'sessions.stop' }, {}, stops],
  ['unavailable error', { code: 'unavailable' }, {}, stops],
  ['missing error code', { code: undefined }, {}, stops],
  ['different error text', { message: 'This session has ended. Extra failure' }, {}, stops],
  ['unknown session', { sessionId: 'other' }, {}, stops],
  ['missing session id', { sessionId: undefined }, {}, stops],
  ['missing call order', { callIndex: undefined }, {}, stops],
  ['resize before stop', { callIndex: 3 }, {}, stops],
  ['same call index', { callIndex: 4 }, {}, stops],
  ['different action', {}, { label: 'Hide the timeline' }, stops],
  ['different control kind', {}, { kind: 'key' }, stops],
  ['no successful stop', {}, {}, []],
  ['prior-action stop', {}, {}, [{ sessionId: 'owned', callIndex: 3 }]],
  ['another session stopped', {}, {}, [{ sessionId: 'other', callIndex: 4 }]],
];
for (const [name, change, actionChange, successful] of invalid) {
  test(`resize attribution keeps ${name} as a failure without querying`, async () => {
    let calls = 0;
    assert.equal(await qualifyStoppedResize({ ...refusal, ...change }, { ...action, ...actionChange }, successful,
      async () => { calls++; return ended; }), null);
    assert.equal(calls, 0);
  });
}

for (const [name, result] of [
  ['still live', { ...ended, state: 'running' }],
  ['failed, not owner-ended', { ...ended, state: 'failed' }],
  ['wrong session returned', { ...ended, id: 'other' }],
  ['no end timestamp', { ...ended, endedAt: null }],
  ['invalid end timestamp', { ...ended, endedAt: NaN }],
] as const) {
  test(`resize attribution refuses authoritative ${name}`, async () => {
    assert.equal(await qualifyStoppedResize(refusal, action, stops, async () => result), null);
  });
}

test('resize attribution fails closed when the authoritative query fails', async () => {
  assert.equal(await qualifyStoppedResize(refusal, action, stops, async () => { throw new Error('owned query failure'); }), null);
});

test('a valid qualification queries the exact stopped id once without mutating the evidence', async () => {
  const before = JSON.stringify({ refusal, action, stops, ended });
  const queried: string[] = [];
  const result = await qualifyStoppedResize(refusal, action, stops, async id => { queried.push(id); return ended; });
  assert.ok(result); assert.deepEqual(queried, ['owned']);
  assert.equal(JSON.stringify({ refusal, action, stops, ended }), before);
});
