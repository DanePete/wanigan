// Every `wanigan` command an agent is told about, run the way an agent runs it:
// the real shim on the session's PATH, the session's own token, its exit code
// and output, and what each one did read back from the board.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { LEASE_MS } from '../shared/board.ts';
import { testCore, tokenOf, type TestCore } from './test-support.ts';

interface Run { code: number; out: string; err: string }

describe('the wanigan command', () => {
  let clock = Date.now();
  let t: TestCore;
  let projectId = '';
  let sessionId = '';
  let token = '';

  /** `wanigan …` as the agent: its token, its project folder, nothing else from this process. */
  const wanigan = (...args: string[]): Promise<Run> => run(t, args, { WANIGAN_SOCKET: t.core.paths.socket, WANIGAN_TOKEN: token });

  before(async () => {
    t = await testCore({ now: () => clock });
    projectId = (await t.owner.call('projects.add', { path: t.projectDir })).id;
    const session = await t.owner.call('sessions.start', { projectId, provider: 'claude', title: 'Checkout agent' });
    sessionId = session.id;
    token = await tokenOf(t.core, sessionId);
  });

  after(async () => {
    await t?.close();
  });

  test('help lists every command; an unknown one fails with exit code 2', async () => {
    const help = await wanigan();
    assert.equal(help.code, 0);
    for (const command of ['status', 'list', 'show', 'claim', 'note', 'review', 'release', 'file', 'ask', 'criteria', 'decisions']) {
      assert.match(help.out, new RegExp(`^  wanigan ${command}\\b`, 'm'), command);
    }
    const wrong = await wanigan('finish', 'NS-1');
    assert.equal(wrong.code, 2);
    assert.match(wrong.err, /Unknown command "finish"/);
  });

  test('file: what an agent files lands in the Inbox, as its own, at the priority it gives', async () => {
    const filed = await wanigan('file', 'bug', 'Coupon field accepts expired codes', '--body', 'Seen on staging', '--priority', '1');
    assert.equal(filed.code, 0, filed.err);
    const key = filed.out.match(/^Filed (\S+) in the Inbox\.$/m)?.[1];
    assert.ok(key, filed.out);
    const card = await t.owner.call('cards.get', { id: key });
    assert.deepEqual([card.status, card.type, card.priority, card.body, card.createdBy], ['inbox', 'bug', 1, 'Seen on staging', `session:${sessionId}`]);

    const bad = await wanigan('file', 'epic', 'Not a type');
    assert.equal(bad.code, 1);
    assert.match(bad.err, /TYPE is one of task, bug, feature, idea/);

    const claimed = await wanigan('claim', key);
    assert.equal(claimed.code, 1, 'nobody works an Inbox card the owner has not accepted');
    assert.match(claimed.err, /in the Inbox/);
    assert.equal((await t.owner.call('cards.get', { id: key })).status, 'inbox');
  });

  test('list and show read the board, as text or as JSON', async () => {
    const card = await t.owner.call('cards.create', { projectId, type: 'task', title: 'Label the pay button', body: 'Screen readers say "button".' });
    await t.owner.call('criteria.add', { cardId: card.id, text: 'The button has an accessible name' });

    const all = await wanigan('list');
    assert.equal(all.code, 0, all.err);
    assert.match(all.out, new RegExp(`^${card.key}\\s+P2 task\\s+ready\\s+Label the pay button$`, 'm'));
    const inbox = await wanigan('list', '--status', 'inbox');
    assert.ok(!inbox.out.includes(card.key), 'filtered by column');
    assert.ok(/Coupon field accepts expired codes/.test(inbox.out));

    const shown = await wanigan('show', card.key);
    assert.match(shown.out, /Screen readers say "button"\./);
    assert.match(shown.out, /^ {2}\[ \] The button has an accessible name$/m);
    const json = JSON.parse((await wanigan('show', card.key, '--json')).out) as { key: string; criteria: { text: string }[] };
    assert.equal(json.key, card.key);
    assert.deepEqual(json.criteria.map((c) => c.text), ['The button has an accessible name']);
  });

  test('claim, note and release: a claim is taken, kept and given back, and each step is on the card', async () => {
    const card = await t.owner.call('cards.create', { projectId, type: 'task', title: 'Fix the cart total' });
    const claimed = await wanigan('claim', card.key, '--note', 'starting with the totals');
    assert.equal(claimed.code, 0, claimed.err);
    assert.match(claimed.out, new RegExp(`Claimed ${card.key}\\.`));
    let now = await t.owner.call('cards.get', { id: card.id });
    assert.deepEqual([now.status, now.claim?.sessionId], ['working', sessionId]);

    clock += 20 * 60_000;
    const noted = await wanigan('note', card.key, 'found the cause: rounding');
    assert.equal(noted.code, 0, noted.err);
    now = await t.owner.call('cards.get', { id: card.id });
    assert.equal(now.comments.at(-1)?.body, 'found the cause: rounding');
    assert.equal(now.comments.at(-1)?.author, `session:${sessionId}`);
    assert.equal(now.claim?.expiresAt, clock + LEASE_MS, 'a note renews the claim');

    const released = await wanigan('release', card.key, '--note', 'blocked on the tax rules');
    assert.equal(released.code, 0, released.err);
    now = await t.owner.call('cards.get', { id: card.id });
    assert.deepEqual([now.status, now.claim], ['ready', null]);
    assert.equal(now.comments.at(-1)?.body, 'blocked on the tax rules');
    assert.ok(now.activity.some((a) => a.verb === 'released' && a.actor === `session:${sessionId}`), 'the release is recorded as the agent’s');

    const late = await wanigan('note', card.key, 'one more thing');
    assert.equal(late.code, 1);
    assert.match(late.err, /do not hold this card/);
  });

  test('review: evidence is a file, a link or a sentence, and none is no review', async () => {
    const card = await t.owner.call('cards.create', { projectId, type: 'task', title: 'Round the tax' });
    assert.equal((await wanigan('claim', card.key)).code, 0);
    const none = await wanigan('review', card.key, '--note', 'done');
    assert.equal(none.code, 1);
    assert.match(none.err, /Review needs evidence/);
    assert.equal((await t.owner.call('cards.get', { id: card.id })).status, 'working');

    const sent = await wanigan('review', card.key, '--evidence', 'missing-file.txt', '--evidence', 'https://ci.example.com/run/7', '--note', 'tests pass');
    assert.equal(sent.code, 0, sent.err);
    const now = await t.owner.call('cards.get', { id: card.id });
    assert.deepEqual([now.status, now.claim], ['review', null]);
    assert.deepEqual(now.evidence.map((e) => [e.kind, e.value]), [['note', 'missing-file.txt'], ['link', 'https://ci.example.com/run/7']],
      'a path that is not there is offered as words, not as a file');
  });

  test('ask: a question reaches Needs you; the owner’s answer on the card settles it and the agent reads it', async () => {
    const card = await t.owner.call('cards.create', { projectId, type: 'feature', title: 'Free shipping banner' });
    const asked = await wanigan('ask', card.key, 'Cart drawer too, or only the cart page?');
    assert.equal(asked.code, 0, asked.err);
    const question = (await t.owner.call('needs.list', {})).find((n) => n.kind === 'question' && n.cardId === card.id);
    assert.equal(question?.detail, 'Cart drawer too, or only the cart page?');
    assert.equal(question?.sessionId, sessionId, 'the need knows which agent asked');
    assert.equal((await t.owner.call('cards.get', { id: card.id })).openQuestions, 1);

    await t.owner.call('cards.comment', { id: card.id, body: 'Both, please.' });
    assert.ok(!(await t.owner.call('needs.list', {})).some((n) => n.kind === 'question' && n.cardId === card.id), 'answered is settled');
    assert.equal((await t.owner.call('cards.get', { id: card.id })).openQuestions, 0);
    assert.match((await wanigan('show', card.key)).out, /^ {2}owner: Both, please\.$/m);

    // A criterion goes on a card the agent holds (or one it filed, still in the Inbox).
    const early = await wanigan('criteria', card.key, 'The banner shows in the cart drawer');
    assert.match(early.err, /You do not hold this card/);
    await t.owner.call('cards.move', { id: card.id, status: 'ready' });
    assert.equal((await wanigan('claim', card.key)).code, 0);
    const criterion = await wanigan('criteria', card.key, 'The banner shows in the cart drawer');
    assert.equal(criterion.code, 0, criterion.err);
    assert.deepEqual((await t.owner.call('cards.get', { id: card.id })).criteria.map((c) => c.text), ['The banner shows in the cart drawer']);
  });

  test('status: the agent’s card, what was sent back, what else it holds, Ready by priority, decisions, and a pause', async () => {
    await t.owner.call('decisions.add', { projectId, title: 'Use pnpm, never npm' });
    const keys: Record<string, string> = {};
    for (const [name, priority] of [['low', 3], ['urgent', 0], ['normal', 2], ['urgent too', 0]] as const) {
      keys[name] = (await t.owner.call('cards.create', { projectId, type: 'task', title: `Ready ${name}`, priority })).key;
    }
    const held = await t.owner.call('cards.create', { projectId, type: 'task', title: 'Second card held' });
    assert.equal((await wanigan('claim', held.key)).code, 0);

    const status = await wanigan('status');
    assert.equal(status.code, 0, status.err);
    const ready = status.out.split('Top of Ready:\n')[1]?.split('\n\n')[0] ?? '';
    const order = ['urgent too', 'urgent', 'normal', 'low'].map((name) => ready.indexOf(keys[name] as string));
    assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > (order[i - 1] as number))), `P0 first, then the owner’s order:\n${ready}`);
    assert.match(status.out, /Your card:\n {2}\S+-\d+ .*Fix the cart total/, 'the first card it claimed is its own, held or not');
    assert.match(status.out, new RegExp(`You also hold:\\n {2}${held.key} `), 'a card it holds is never left out');
    assert.match(status.out, /Decisions in force:\n {2}- Use pnpm, never npm/);
    assert.doesNotMatch(status.out, /PAUSED/);

    const json = JSON.parse((await wanigan('status', '--json')).out) as { session: { id: string }; paused: boolean };
    assert.equal(json.session.id, sessionId);

    await t.owner.call('projects.pause', { id: projectId, wrapUp: false });
    const paused = await wanigan('status');
    assert.match(paused.out, /THE OWNER HAS PAUSED THIS PROJECT/);
    const blocked = await wanigan('claim', keys.low as string);
    assert.equal(blocked.code, 1);
    assert.match(blocked.err, /paused this project/);
    await t.owner.call('projects.resume', { id: projectId });
  });

  test('decisions lists what is in force, and nothing withdrawn', async () => {
    const gone = await t.owner.call('decisions.add', { projectId, title: 'No new dependencies without asking' });
    await t.owner.call('decisions.remove', { id: gone.id });
    const out = (await wanigan('decisions')).out;
    assert.match(out, /^- Use pnpm, never npm$/m);
    assert.doesNotMatch(out, /No new dependencies/);
  });

  test('outside a session it is the owner: it reads a card, and an agent’s command is refused by name', async () => {
    const [card] = await t.owner.call('cards.list', { projectId });
    const owner = (...args: string[]) => run(t, [...args, '--data-dir', t.core.paths.dataDir], {});
    const shown = await owner('show', card!.key);
    assert.equal(shown.code, 0, shown.err);
    assert.match(shown.out, new RegExp(`^${card!.key}\\b`));
    const claim = await owner('claim', card!.key);
    assert.equal(claim.code, 1);
    assert.match(claim.err, /cards\.claim is not available to an owner/);
  });

  test('outside a session it says which project and which Wanigan, and says plainly when Wanigan is not running', async () => {
    const key = (await t.owner.call('projects.list', {})).find((p) => p.id === projectId)!.key;
    const owner = (...args: string[]) => run(t, args, { WANIGAN_DATA_DIR: t.core.paths.dataDir });
    const unsaid = await owner('list');
    assert.equal(unsaid.code, 1);
    assert.match(unsaid.err, /Outside a session, say which project: --project KEY/);
    const listed = await owner('list', '--project', key.toLowerCase());
    assert.equal(listed.code, 0, listed.err);
    const filed = await owner('file', 'idea', 'Filed from a terminal', '--project', key);
    assert.equal(filed.code, 0, filed.err);
    assert.match(filed.out, /^Filed [A-Z0-9]+-\d+ in Ready\.$/m, 'the owner’s card goes to Ready, and it says so');
    assert.ok((await t.owner.call('cards.list', { projectId })).some((c) => c.title === 'Filed from a terminal' && c.status === 'ready'));
    assert.match((await owner('list', '--project', 'NOPE')).err, /No open project has the key NOPE/);
    const nowhere = await run(t, ['list', '--project', key], { WANIGAN_DATA_DIR: join(t.dir, 'not-wanigan') });
    assert.match(nowhere.err, /Wanigan is not running for .*not-wanigan\. Open the app, then try again\./);
  });
});

function run(t: TestCore, args: string[], env: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    execFile(join(t.core.paths.bin, 'wanigan'), args, { cwd: t.projectDir, timeout: 30_000, env: { PATH: '/usr/bin:/bin', ...env } },
      (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out: String(stdout), err: String(stderr) }));
  });
}
