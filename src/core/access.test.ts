// Who may do what, checked against the one table that says so (ACCESS in
// shared/protocol.ts): every method, as a session and as the owner, on the real
// socket. Plus what identity rests on: a token stored only as its hash, and
// files only their owner can read.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { CoreClient } from '../client/client.ts';
import { ACCESS, type Method } from '../shared/protocol.ts';
import { testCore, tokenOf, waitFor } from './test-support.ts';

const methods = Object.keys(ACCESS) as Method[];
const forbidden = (role: string) => (e: Error & { code?: string }) => e.code === 'forbidden' && new RegExp(`not available to ${role}`).test(e.message);

test('a session can call only what ACCESS gives it, and the owner nothing that is only an agent’s', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
    const agent = await CoreClient.connect(t.core.paths.socket, await tokenOf(t.core, session.id));
    assert.equal(agent.role, 'session');

    const ownerOnly = methods.filter((m) => !ACCESS[m].includes('session'));
    const sessionOnly = methods.filter((m) => !ACCESS[m].includes('owner'));
    assert.ok(ownerOnly.length > 80 && sessionOnly.length >= 5, 'the table is the whole protocol');
    for (const m of ownerOnly) await assert.rejects(agent.call(m, {} as never), forbidden('a session'), m);
    for (const m of sessionOnly) await assert.rejects(t.owner.call(m, {} as never), forbidden('an owner'), m);
    // Nothing outside the table exists, for anyone.
    await assert.rejects(t.owner.call('cards.delete' as Method, {} as never), (e: Error & { code?: string }) => e.code === 'not_found');
    agent.close();
    await t.owner.call('sessions.stop', { id: session.id });
  } finally {
    await t.close();
  }
});

test('everything a session may touch is in its own project', async () => {
  const t = await testCore();
  try {
    const mine = await t.owner.call('projects.add', { path: t.projectDir });
    const theirs = await t.owner.call('projects.add', { path: t.dir, name: 'Other' });
    const foreign = await t.owner.call('cards.create', { projectId: theirs.id, type: 'task', title: 'Not yours' });
    await t.owner.call('decisions.add', { projectId: theirs.id, title: 'Their rule' });
    const session = await t.owner.call('sessions.start', { projectId: mine.id, provider: 'claude' });
    const agent = await CoreClient.connect(t.core.paths.socket, await tokenOf(t.core, session.id));

    const onForeign: [Method, object][] = [
      ['cards.get', { id: foreign.id }], ['cards.comment', { id: foreign.id, body: 'x' }], ['cards.claim', { id: foreign.id }],
      ['cards.heartbeat', { id: foreign.id }], ['cards.release', { id: foreign.id }], ['cards.ask', { id: foreign.id, question: 'x' }],
      ['cards.submit', { id: foreign.id, evidence: [{ kind: 'note', value: 'x' }] }], ['cards.evidence', { id: foreign.id, evidence: { kind: 'note', value: 'x' } }],
      ['criteria.add', { cardId: foreign.id, text: 'x' }],
    ];
    const allowed = methods.filter((m) => ACCESS[m].includes('session'));
    for (const [m, params] of onForeign) {
      assert.ok(allowed.includes(m));
      await assert.rejects(agent.call(m, params as never), /another project/, m);
    }
    assert.equal((await t.owner.call('cards.get', { id: foreign.id })).comments.length, 0, 'nothing reached the other card');

    // Asking for another project is answered with its own.
    assert.ok((await agent.call('cards.list', { projectId: theirs.id })).every((c) => c.projectId === mine.id));
    assert.deepEqual(await agent.call('decisions.list', { projectId: theirs.id }), []);
    const filed = await agent.call('cards.create', { projectId: theirs.id, type: 'bug', title: 'Filed from here' });
    assert.equal(filed.projectId, mine.id);
    agent.close();
    await t.owner.call('sessions.stop', { id: session.id });
  } finally {
    await t.close();
  }
});

test('a session that has ended keeps its token but can only read the board', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Read me' });
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
    const agent = await CoreClient.connect(t.core.paths.socket, await tokenOf(t.core, session.id));
    await t.owner.call('sessions.stop', { id: session.id });
    await waitFor('ended', async () => (await t.owner.call('sessions.get', { id: session.id })).session.endedAt);

    assert.equal((await agent.call('cards.get', { id: card.id })).key, card.key);
    assert.ok((await agent.call('cards.list', { projectId: project.id })).length > 0);
    assert.equal((await agent.call('agent.status', {})).session.state, 'ended');
    for (const [m, params] of [
      ['cards.create', { type: 'bug', title: 'After the end' }], ['cards.claim', { id: card.id }],
      ['cards.comment', { id: card.id, body: 'late' }], ['criteria.add', { cardId: card.id, text: 'late' }],
    ] as [Method, object][]) {
      await assert.rejects(agent.call(m, params as never), /has ended; it can read the board but not change it/, m);
    }
    assert.equal((await t.owner.call('cards.list', { projectId: project.id })).length, 1, 'nothing was filed');
    agent.close();
  } finally {
    await t.close();
  }
});

test('a session token is kept only as its hash, and the owner’s files are the owner’s alone', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
    const token = await tokenOf(t.core, session.id);
    const rows = JSON.stringify(t.core.db.prepare('SELECT * FROM sessions').all()) + JSON.stringify(t.core.db.prepare('SELECT * FROM activity').all());
    assert.ok(!rows.includes(token), 'the token itself is nowhere in the database');
    const { token_hash: hash } = t.core.db.prepare('SELECT token_hash FROM sessions WHERE id = ?').get(session.id) as { token_hash: string };
    assert.equal(hash, createHash('sha256').update(token).digest('hex'));
    await assert.rejects(CoreClient.connect(t.core.paths.socket, `${token}x`), /Unknown token/);

    const mode = (path: string): number => statSync(path).mode & 0o777;
    assert.equal(mode(t.core.paths.dataDir), 0o700);
    assert.equal(mode(dirname(t.core.paths.socket)), 0o700);
    for (const file of [t.core.paths.ownerToken, t.core.paths.info, t.core.paths.socket, t.core.paths.hookSocket]) assert.equal(mode(file), 0o600, file);
    assert.ok(readFileSync(t.core.paths.ownerToken, 'utf8').length >= 40);
    await t.owner.call('sessions.stop', { id: session.id });
  } finally {
    await t.close();
  }
});
