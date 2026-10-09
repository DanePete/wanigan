// Shipping an approved card: push its branch, open a pull request with gh.
// origin is a local bare repository and gh is a stand-in that records what it
// was asked; nothing here reaches GitHub.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sh, testCore, waitFor } from './test-support.ts';

const ID = '-c user.email=t@t -c user.name=t';
const URL = 'https://github.com/example/site/pull/7';

/** A stand-in gh: records each call's arguments (NUL after each, SOH after each call), answers auth and pr create. */
function fakeGh(path: string, log: string, signedIn: boolean): void {
  writeFileSync(path, [
    '#!/bin/sh',
    `for a in "$@"; do printf '%s\\0' "$a" >> '${log}'; done`,
    `printf '\\001' >> '${log}'`,
    'case "$1" in',
    `  auth) ${signedIn ? "echo 'Logged in to github.com account example'; exit 0" : "echo 'You are not logged into any GitHub hosts. To log in, run: gh auth login' >&2; exit 1"} ;;`,
    `  pr) echo 'Creating pull request for the branch'; echo '${URL}' ;;`,
    'esac',
  ].join('\n'), { mode: 0o755 });
}

const calls = (log: string): string[][] => existsSync(log)
  ? readFileSync(log, 'utf8').split('\x01').filter(Boolean).map((call) => call.split('\0').slice(0, -1))
  : [];

test('an approved card’s branch is pushed and its pull request opened, after every refusal that applies', async () => {
  const tools = realpathSync(mkdtempSync(join(tmpdir(), 'wg-gh-')));
  const gh = join(tools, 'gh');
  const log = join(tools, 'gh-calls');
  const t = await testCore({ ghBinary: gh });
  try {
    const { owner, core } = t;
    const repo = t.projectDir;
    writeFileSync(join(repo, 'app.txt'), 'one\n');
    await sh(`git init -q -b main && git ${ID} add -A && git ${ID} commit -qm init`, repo);
    const project = await owner.call('projects.add', { path: repo });
    const card = await owner.call('cards.create', { projectId: project.id, type: 'feature', title: 'Free shipping banner', body: 'Show a banner under $75.' });
    await owner.call('criteria.add', { cardId: card.id, text: 'Banner shows under $75' });

    const session = await owner.call('sessions.start', { projectId: project.id, provider: 'shell', cardId: card.id, isolate: true });
    const wt = (await owner.call('cards.get', { id: card.id })).worktree!;
    writeFileSync(join(wt.path, 'banner.txt'), 'free shipping over $75\n');
    await sh(`git ${ID} add -A && git ${ID} commit -qm banner`, wt.path);
    core.board.submit(session.id, card.id, [{ kind: 'note', value: 'Tested at $74.99\nand $75.00.' }, { kind: 'link', value: 'https://ci.example/run/1' }]);
    await owner.call('sessions.stop', { id: session.id });
    await waitFor('stopped', async () => !(await owner.call('cards.get', { id: card.id })).live);

    await assert.rejects(owner.call('cards.openPullRequest', { id: card.id }), /Approve the card first/);
    await owner.call('cards.approve', { id: card.id });

    let plan = await owner.call('cards.pullRequestPlan', { id: card.id });
    assert.deepEqual({ ...plan, refusal: plan.refusal && /no origin/.test(plan.refusal) }, {
      branch: wt.branch, base: 'main', remote: null, ahead: 1, title: `${card.key} Free shipping banner`, refusal: true,
    });
    await assert.rejects(owner.call('cards.openPullRequest', { id: card.id }), /no origin remote/);

    const origin = join(tools, 'origin.git');
    await sh(`git init -q --bare "${origin}"`, tools);
    await sh(`git remote add origin "${origin}"`, repo);
    await assert.rejects(owner.call('cards.openPullRequest', { id: card.id }), /gh command is not installed.*`brew install gh`.*`gh auth login`/);

    fakeGh(gh, log, false);
    plan = await owner.call('cards.pullRequestPlan', { id: card.id });
    assert.equal(plan.remote, origin);
    assert.equal(plan.refusal, null, 'the plan reads git only; signing in is checked when it runs');
    await assert.rejects(owner.call('cards.openPullRequest', { id: card.id }), /not signed in/);
    const pushed = () => sh(`git --git-dir="${origin}" rev-parse --verify --quiet refs/heads/${wt.branch}`, tools).then((s) => s.trim(), () => null);
    assert.equal(await pushed(), null, 'nothing is pushed before gh is ready');

    writeFileSync(join(wt.path, 'scratch.txt'), 'not committed\n');
    await assert.rejects(owner.call('cards.openPullRequest', { id: card.id }), /uncommitted changes/);
    rmSync(join(wt.path, 'scratch.txt'));

    rmSync(log, { force: true });
    fakeGh(gh, log, true);
    const { url } = await owner.call('cards.openPullRequest', { id: card.id });
    assert.equal(url, URL);
    assert.equal(await pushed(), (await sh('git rev-parse HEAD', wt.path)).trim(), 'origin has the branch as committed');
    const [auth, create] = calls(log);
    assert.deepEqual(auth, ['auth', 'status']);
    assert.deepEqual(create?.slice(0, 8), ['pr', 'create', '--head', wt.branch, '--base', 'main', '--title', `${card.key} Free shipping banner`]);
    assert.equal(create?.[8], '--body');
    assert.equal(create?.[9], [
      'Show a banner under $75.',
      '## Acceptance criteria\n- [ ] Banner shows under $75',
      '## Evidence\n- Note: Tested at $74.99 and $75.00.\n- Link: https://ci.example/run/1',
    ].join('\n\n'));
    const shipped = await owner.call('cards.get', { id: card.id });
    assert.equal(shipped.pullRequest, URL, 'shown on the card');
    assert.ok(shipped.activity.some((a) => a.verb === `pushed ${wt.branch} and opened a pull request` && a.detail === URL), 'and logged');

    // A branch with nothing its base lacks has nothing to propose.
    const empty = await owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Nothing done yet' });
    const idle = await owner.call('sessions.start', { projectId: project.id, provider: 'shell', cardId: empty.id, isolate: true });
    await owner.call('sessions.stop', { id: idle.id });
    await waitFor('stopped', async () => !(await owner.call('cards.get', { id: empty.id })).live);
    await owner.call('cards.move', { id: empty.id, status: 'done' });
    assert.match((await owner.call('cards.pullRequestPlan', { id: empty.id })).refusal ?? '', /has nothing that is not already in main/);
    await assert.rejects(owner.call('cards.openPullRequest', { id: empty.id }), /nothing that is not already in main/);
  } finally {
    await t.close();
    rmSync(tools, { recursive: true, force: true });
  }
});

test('a card pull request refuses secrets before publishing its branch, even when its worktree follows another remote', async () => {
  const tools = realpathSync(mkdtempSync(join(tmpdir(), 'wg-gh-secrets-')));
  const gh = join(tools, 'gh');
  const log = join(tools, 'gh-calls');
  fakeGh(gh, log, true);
  const t = await testCore({ ghBinary: gh });
  try {
    const repo = t.projectDir;
    const origin = join(t.dir, 'origin.git');
    const elsewhere = join(t.dir, 'elsewhere.git');
    writeFileSync(join(repo, 'app.txt'), 'one\n');
    await sh(`git init -q -b main && git ${ID} add -A && git ${ID} commit -qm init && git init -q --bare "${origin}" && git init -q --bare "${elsewhere}" && git remote add origin "${origin}" && git remote add elsewhere "${elsewhere}"`, repo);
    const project = await t.owner.call('projects.add', { path: repo });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Publish safely' });
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell', cardId: card.id, isolate: true });
    const wt = (await t.owner.call('cards.get', { id: card.id })).worktree!;
    const key = ['sk', 'live', 'A1b2C3d4E5f6G7h8J9k0L1m2'].join('_');
    writeFileSync(join(wt.path, 'payment.ts'), `export const key = '${key}';\n`);
    await sh(`git add -A && git ${ID} commit -qm payment && git push -qu elsewhere ${wt.branch}`, wt.path);
    await t.owner.call('sessions.stop', { id: session.id });
    await waitFor('stopped', async () => !(await t.owner.call('cards.get', { id: card.id })).live);
    await t.owner.call('cards.move', { id: card.id, status: 'done' });
    await assert.rejects(t.owner.call('cards.openPullRequest', { id: card.id }), /possible secret/);
    assert.equal(await sh(`git --git-dir="${origin}" show-ref`, repo).catch(() => ''), '', 'origin received no branch');
    assert.equal(calls(log).some((args) => args[0] === 'pr'), false, 'no pull request was attempted');
  } finally {
    await t.close();
    rmSync(tools, { recursive: true, force: true });
  }
});
