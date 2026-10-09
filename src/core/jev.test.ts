// Jev end to end against a stand-in System One: a real HTTP server speaking
// TypeSafe's documented request and answer shapes (docs.typesafe.ai/api).
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { testCore, waitFor, type TestCore } from './test-support.ts';

interface Seen { auth: string | undefined; body: { model: string; state: { project: string; card: { title: string; criteria?: string[] }; candidates?: { key: string }[] }; questions: Record<string, { type: string }> } }

describe('jev', () => {
  let server: Server;
  let url = '';
  const seen: Seen[] = [];
  /** What the stand-in does next: answer, or fail with a status a few times first. */
  let failWith: number[] = [];
  let t: TestCore;

  before(async () => {
    server = createServer((req: IncomingMessage, res) => {
      let raw = '';
      req.on('data', (d: Buffer) => { raw += d.toString('utf8'); });
      req.on('end', () => {
        const body = JSON.parse(raw) as Seen['body'];
        seen.push({ auth: req.headers.authorization, body });
        const status = failWith.shift();
        if (status) { res.writeHead(status, { 'content-type': 'application/json' }).end('{"detail":"nope"}'); return; }
        const title = body.state?.card?.title ?? '';
        const answers: Record<string, unknown> = {};
        for (const [id, q] of Object.entries(body.questions)) {
          if (id === 'severity') answers[id] = { type: 'score', score: /checkout/i.test(title) ? 2.7 : 0.4, confidence: 0.8 };
          else if (id === 'action') {
            const choice = /maybe someday/i.test(title) ? 'later' : 'ready';
            answers[id] = { type: 'choice', choice, confidence: 0.91, probabilities: { ready: choice === 'ready' ? 0.91 : 0.05, later: choice === 'later' ? 0.91 : 0.04 } };
          } else if (q.type === 'noul') answers[id] = { type: 'noul', noul: /again/i.test(title) ? 0.96 : 0.1 };
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model: 'jev-1.13', answers, usage: { input_tokens: 1000, output_tokens: 0 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`;
    t = await testCore({ jev: { url, envKey: null, backoffMs: 1 } });
  });

  after(async () => {
    await t?.close();
    server?.close();
  });

  test('with no key, nothing is sent and the status says so', async () => {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    await t.owner.call('cards.create', { projectId: project.id, type: 'bug', title: 'Nothing should be sent', status: 'inbox' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(seen.length, 0);
    const status = await t.owner.call('jev.status', {});
    assert.equal(status.configured, null);
    assert.equal(status.online, false);
    await assert.rejects(t.owner.call('jev.readAll', { projectId: project.id }), /no key/);
  });

  test('a saved key is the core’s alone, and is never sent back', async () => {
    const status = await t.owner.call('jev.setKey', { key: 'ts-test-key-123' });
    assert.equal(status.configured, 'saved');
    assert.doesNotMatch(JSON.stringify(status), /ts-test-key-123/);
    const file = join(t.core.paths.dataDir, 'jev.key');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    await assert.rejects(t.owner.call('jev.setKey', { key: 'has a space' }), /does not look like/);
    const tested = await t.owner.call('jev.test', {});
    assert.equal(tested.online, true);
    assert.equal(tested.model, 'jev-1.13');
    assert.equal(seen.at(-1)?.auth, 'Bearer ts-test-key-123');
    assert.equal(seen.at(-1)?.body.model, 'jev-latest');
  });

  test('a new Inbox card is read: action and severity, without sending project files', async () => {
    const [project] = await t.owner.call('projects.list', {});
    const card = await t.owner.call('cards.create', { projectId: project!.id, type: 'bug', title: 'Checkout total ignores the coupon', status: 'inbox' });
    const read = await waitFor('read', async () => (await t.owner.call('cards.get', { id: card.id })).jev);
    assert.equal(read.outcome, 'read', 'Read mode never moves a card');
    assert.equal(read.action, 'ready');
    assert.equal(read.confidence, 0.91);
    assert.ok(read.severity !== null && read.severity > 2.5);
    const sent = seen.at(-1)!.body;
    assert.equal(sent.state.card.title, 'Checkout total ignores the coupon');
    assert.equal(sent.state.project, project!.name);
    assert.deepEqual(Object.keys(sent.state).sort(), ['card', 'project']);
    assert.doesNotMatch(JSON.stringify(sent), new RegExp(t.projectDir.replace(/[/.]/g, '\\$&')), 'the folder path is not sent');
    assert.deepEqual(Object.keys(sent.questions).sort(), ['action', 'severity']);
    assert.equal((await t.owner.call('cards.get', { id: card.id })).status, 'inbox');
  });

  test('a likely duplicate is named, with the candidates Jev was asked about', async () => {
    const [project] = await t.owner.call('projects.list', {});
    const card = await t.owner.call('cards.create', { projectId: project!.id, type: 'bug', title: 'Checkout total ignores the coupon again', status: 'inbox' });
    const read = await waitFor('read', async () => (await t.owner.call('cards.get', { id: card.id })).jev);
    assert.equal(read.duplicateOf, `${project!.key}-2`);
    assert.ok((read.duplicateP ?? 0) > 0.9);
    assert.ok(seen.at(-1)!.body.state.candidates?.some((c) => c.key === `${project!.key}-2`));
  });

  test('Accept mode moves a confident card that says what done means, and logs it as Jev', async () => {
    const [project] = await t.owner.call('projects.list', {});
    await t.owner.call('projects.update', { id: project!.id, jev: 'accept' });
    const bare = await t.owner.call('cards.create', { projectId: project!.id, type: 'task', title: 'Add alt text to the hero image', status: 'inbox' });
    const bareRead = await waitFor('read', async () => (await t.owner.call('cards.get', { id: bare.id })).jev);
    assert.equal(bareRead.outcome, 'read', 'no criteria, so it waits for the owner');

    await t.owner.call('criteria.add', { cardId: bare.id, text: 'The hero image has descriptive alt text' });
    await t.owner.call('jev.read', { cardId: bare.id });
    await waitFor('accepted', async () => (await t.owner.call('cards.get', { id: bare.id })).status === 'ready');
    const detail = await t.owner.call('cards.get', { id: bare.id });
    assert.equal(detail.jev?.outcome, 'accepted');
    assert.ok(detail.activity.some((a) => a.actor === 'jev' && a.verb === 'accepted it to Ready'));

    const later = await t.owner.call('cards.create', { projectId: project!.id, type: 'idea', title: 'Maybe someday a dark mode', status: 'inbox' });
    const laterRead = await waitFor('read', async () => (await t.owner.call('cards.get', { id: later.id })).jev);
    assert.equal(laterRead.action, 'later');
    assert.equal((await t.owner.call('cards.get', { id: later.id })).status, 'inbox', 'anything but a confident ready is advice');
    await t.owner.call('projects.update', { id: project!.id, jev: 'read' });
  });

  test('a card past triage is only scored; Off sends nothing', async () => {
    const [project] = await t.owner.call('projects.list', {});
    const ready = await t.owner.call('cards.create', { projectId: project!.id, type: 'task', title: 'Write the release notes' });
    await waitFor('score', async () => (await t.owner.call('cards.get', { id: ready.id })).jev);
    assert.deepEqual(Object.keys(seen.at(-1)!.body.questions), ['severity']);

    await t.owner.call('projects.update', { id: project!.id, jev: 'off' });
    const before = seen.length;
    await t.owner.call('cards.create', { projectId: project!.id, type: 'task', title: 'Quietly filed', status: 'inbox' });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(seen.length, before);
    await assert.rejects(t.owner.call('jev.readAll', { projectId: project!.id }), /off for this project/);
    await t.owner.call('projects.update', { id: project!.id, jev: 'read' });
  });

  test('busy answers are retried; a refused key is shown on the card and stops the queue', async () => {
    const [project] = await t.owner.call('projects.list', {});
    failWith = [429, 529];
    const retried = await t.owner.call('cards.create', { projectId: project!.id, type: 'bug', title: 'Retried until it answers', status: 'inbox' });
    const read = await waitFor('read', async () => (await t.owner.call('cards.get', { id: retried.id })).jev);
    assert.equal(read.outcome, 'read');

    failWith = [401];
    const refused = await t.owner.call('cards.create', { projectId: project!.id, type: 'bug', title: 'Refused key', status: 'inbox' });
    const failed = await waitFor('failed read', async () => (await t.owner.call('cards.get', { id: refused.id })).jev);
    assert.equal(failed.outcome, 'failed');
    assert.match(failed.error ?? '', /refused the key/);
    const status = await t.owner.call('jev.status', {});
    assert.equal(status.online, false);
    assert.match(status.lastError ?? '', /401/);
    assert.ok(status.calls > 0 && status.costUsd !== null && status.costUsd > 0, 'calls and their cost are counted from the answers');

    // Reading all again retries what failed.
    const { queued } = await t.owner.call('jev.readAll', { projectId: project!.id });
    assert.ok(queued >= 1);
    await waitFor('recovered', async () => (await t.owner.call('cards.get', { id: refused.id })).jev?.outcome === 'read');
    assert.equal((await t.owner.call('jev.status', {})).online, true);
  });

  test('forgetting the key removes it', async () => {
    const status = await t.owner.call('jev.forgetKey', {});
    assert.equal(status.configured, null);
    assert.ok(!existsSync(join(t.core.paths.dataDir, 'jev.key')));
  });
});
