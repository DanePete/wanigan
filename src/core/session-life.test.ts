// A session's life beyond starting and stopping: made a card later, renamed,
// attached, dying on its own, and all of it leaving the project folder as it was.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { shellQuote } from './hooks.ts';
import { relay, savedConversation, sh, testCore, tokenOf, waitFor } from './test-support.ts';

test('a one-off session becomes a card with its history, and works it while it runs', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude', title: 'Poking at checkout' });
    const token = await tokenOf(t.core, session.id);
    await relay(t.core, token, 'SessionStart', {});
    await relay(t.core, token, 'UserPromptSubmit', { prompt: 'why is checkout slow?' });
    await relay(t.core, token, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: join(t.projectDir, 'checkout.ts') } });

    const card = await t.owner.call('sessions.promote', { id: session.id, type: 'bug', title: 'Checkout is slow' });
    assert.deepEqual([card.type, card.title, card.status, card.claim?.sessionId], ['bug', 'Checkout is slow', 'working', session.id],
      'a running session takes the card it became');
    const detail = await t.owner.call('cards.get', { id: card.id });
    assert.deepEqual(detail.sessions.map((s) => s.id), [session.id], 'the session is the card’s');
    const { session: now, events } = await t.owner.call('sessions.get', { id: session.id });
    assert.equal(now.cardId, card.id);
    assert.deepEqual(events.map((e) => e.event), ['SessionStart', 'UserPromptSubmit', 'PreToolUse'], 'its history came with it');
    assert.ok(detail.activity.some((a) => a.verb === 'attached a session' && a.detail === 'Poking at checkout'));
    await assert.rejects(t.owner.call('sessions.promote', { id: session.id, type: 'task', title: 'Again' }), /already belongs to a card/);

    // One that has ended becomes a card too, waiting in Ready.
    const shell = await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell' });
    await t.owner.call('sessions.stop', { id: shell.id });
    await waitFor('ended', async () => (await t.owner.call('sessions.get', { id: shell.id })).session.endedAt);
    const later = await t.owner.call('sessions.promote', { id: shell.id, type: 'task', title: 'Write up what the shell found' });
    assert.deepEqual([later.status, later.claim], ['ready', null]);
    assert.deepEqual((await t.owner.call('cards.get', { id: later.id })).sessions.map((s) => s.id), [shell.id]);
    await t.owner.call('sessions.stop', { id: session.id });
  } finally {
    await t.close();
  }
});

test('a renamed session keeps its new name wherever it is shown', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
    const token = await tokenOf(t.core, session.id);
    const renamed = await t.owner.call('sessions.rename', { id: session.id, title: '  Search spike  ' });
    assert.equal(renamed.title, 'Search spike');
    await assert.rejects(t.owner.call('sessions.rename', { id: session.id, title: '   ' }), /1–120 characters/);
    await assert.rejects(t.owner.call('sessions.rename', { id: session.id, title: 'x'.repeat(121) }), /1–120 characters/);

    await relay(t.core, token, 'SessionStart', {});
    await relay(t.core, token, 'UserPromptSubmit', {});
    await relay(t.core, token, 'Stop', {});
    const need = (await t.owner.call('needs.list', {})).find((n) => n.sessionId === session.id);
    assert.equal(need?.title, 'Search spike', 'Needs you calls it by its new name');
    assert.ok((await t.owner.call('sessions.search', { query: 'search spike' })).hits.some((h) => h.sessionId === session.id && h.in === 'title'), 'and search finds it by it');
    await t.owner.call('sessions.stop', { id: session.id });
  } finally {
    await t.close();
  }
});

test('attaching a running one-off to a Ready card makes it the card’s worker; an ended one only joins its history', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const other = await t.owner.call('projects.add', { path: t.dir, name: 'Other' });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Attach here' });
    const foreign = await t.owner.call('cards.create', { projectId: other.id, type: 'task', title: 'Not here' });
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell' });
    await assert.rejects(t.owner.call('sessions.attach', { id: session.id, cardId: foreign.id }), /another project/);

    const attached = await t.owner.call('sessions.attach', { id: session.id, cardId: card.id });
    assert.equal(attached.cardId, card.id);
    const now = await t.owner.call('cards.get', { id: card.id });
    assert.deepEqual([now.status, now.claim?.sessionId, now.live?.sessionId], ['working', session.id, session.id]);

    await t.owner.call('sessions.stop', { id: session.id });
    await waitFor('given back', async () => (await t.owner.call('cards.get', { id: card.id })).status === 'ready');
    const ended = await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell' });
    await t.owner.call('sessions.stop', { id: ended.id });
    await waitFor('ended', async () => (await t.owner.call('sessions.get', { id: ended.id })).session.endedAt);
    await t.owner.call('sessions.attach', { id: ended.id, cardId: card.id });
    const after = await t.owner.call('cards.get', { id: card.id });
    assert.deepEqual([after.status, after.claim], ['ready', null], 'an ended session claims nothing');
    assert.ok(after.sessions.some((s) => s.id === ended.id));
  } finally {
    await t.close();
  }
});

test('an agent that dies on its own is failed, not ended: raised as resumable until seen, its card given back, and it resumes', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Crashes' });
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude', cardId: card.id });
    await tokenOf(t.core, session.id);
    const { pid } = (await t.owner.call('sessions.get', { id: session.id })).session;
    assert.ok(pid);
    process.kill(pid, 'SIGKILL'); // a crash, or the system ending it: nobody asked Wanigan to stop it

    const died = await waitFor('recorded', async () => { const s = (await t.owner.call('sessions.get', { id: session.id })).session; return s.endedAt ? s : null; });
    assert.equal(died.state, 'failed');
    assert.equal(died.activity, 'Ended by signal 9');
    const failedNeed = async () => (await t.owner.call('needs.list', {})).find((n) => n.kind === 'failed' && n.sessionId === session.id);
    const need = await failedNeed();
    assert.equal(need?.resumable, true, 'Wanigan knows its conversation');
    assert.equal(need?.detail, 'Ended by signal 9');
    const now = await t.owner.call('cards.get', { id: card.id });
    assert.deepEqual([now.status, now.claim], ['ready', null]);
    assert.ok(now.activity.some((a) => a.verb === 'released the claim' && a.detail === 'the session failed without submitting'));

    await t.owner.call('sessions.seen', { id: session.id });
    assert.equal(await failedNeed(), undefined, 'seeing it settles it');

    // Claude Code saves a conversation at its first prompt; this stand-in never got one.
    savedConversation(join(t.dir, 'home'), (await t.owner.call('sessions.get', { id: session.id })).session);
    const resumed = await t.owner.call('sessions.resume', { id: session.id });
    assert.deepEqual([resumed.conversationId, resumed.cardId], [session.conversationId, card.id]);
    await waitFor('resume args', () => t.core.sessions.replay(resumed.id).replay.includes(`--resume ${session.conversationId}`));
    assert.equal((await t.owner.call('cards.get', { id: card.id })).claim?.sessionId, resumed.id);
    await t.owner.call('sessions.stop', { id: resumed.id });
    const stopped = await waitFor('stopped', async () => { const s = (await t.owner.call('sessions.get', { id: resumed.id })).session; return s.endedAt ? s : null; });
    assert.deepEqual([stopped.state, stopped.activity], ['ended', 'Stopped'], 'stopped by the owner is not a failure');
  } finally {
    await t.close();
  }
});

test('working a project writes nothing into its folder', async () => {
  const t = await testCore();
  try {
    writeFileSync(join(t.projectDir, 'app.ts'), 'export const a = 1;\n');
    // The setup commit must not leave background maintenance changing .git after the baseline.
    // Disable it only in this fixture's child shell; keep every file in the comparison.
    const setupTrace = join(t.dir, 'git-setup.jsonl');
    await sh(`export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false GIT_TRACE2_EVENT=${shellQuote(setupTrace)}
git init -q -b main && git add -A && git -c user.email=a@b -c user.name=a commit -qm init`, t.projectDir);
    const setupEvents = readFileSync(setupTrace, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { event?: string; argv?: string[] });
    assert.deepEqual(setupEvents.filter((event) => event.event === 'child_start' && event.argv?.includes('maintenance')), [],
      'fixture setup must finish without starting detached git maintenance before the snapshot');
    const before = snapshot(t.projectDir);

    const project = await t.owner.call('projects.add', { path: t.projectDir });
    await t.owner.call('decisions.add', { projectId: project.id, title: 'Use pnpm' });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Leave no trace' });
    const claude = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude', cardId: card.id });
    const token = await tokenOf(t.core, claude.id);
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) await relay(t.core, token, event, {});
    await t.owner.call('attachments.save', { to: { session: claude.id }, name: 'note.txt', data: Buffer.from('hello').toString('base64') });
    const shell = await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell' });
    await t.owner.call('sessions.input', { id: shell.id, data: `wanigan file idea "Seen while working" && wanigan status\n` });
    await waitFor('the CLI ran', () => /Filed \S+ in the Inbox[\s\S]*Ready is empty/.test(t.core.sessions.replay(shell.id).replay));
    await t.owner.call('projects.changes', { id: project.id });
    for (const s of [claude, shell]) await t.owner.call('sessions.stop', { id: s.id });
    await waitFor('ended', async () => (await t.owner.call('sessions.list', { live: true })).length === 0);

    assert.deepEqual(snapshot(t.projectDir), before, 'every file, and git’s own, as they were');
    assert.equal((await sh('git status --porcelain --ignored', t.projectDir)).trim(), '');
  } finally {
    await t.close();
  }
});

/**
 * Every file under a folder, .git included, by its bytes; outside .git, by its
 * modification time too. Inside .git, git itself touches the time of an object
 * it was asked to write and already had (so gc keeps it), and `git status`
 * rewrites the index's stat cache with the same entries.
 */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const s = statSync(path);
      const rel = relative(root, path);
      if (s.isDirectory()) walk(path);
      else if (rel !== '.git/index') out.push(`${rel} ${createHash('sha256').update(readFileSync(path)).digest('hex')}${rel.startsWith('.git/') ? '' : ` ${s.mtimeMs}`}`);
    }
  };
  walk(root);
  return out;
}
