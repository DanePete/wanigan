// The board's rules as the owner meets them, on a real core: editing a card,
// how long it has sat in its column, criteria, the gates on approve, send back
// and reopen, archiving, who holds a card, decisions as each session is told
// them, and closing a project.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoreClient } from '../client/client.ts';
import { relay, testCore, tokenOf, waitFor } from './test-support.ts';

test('an edit changes what a card says and records it, never its column or its time there; a move restarts that time', async () => {
  let clock = Date.UTC(2026, 9, 7, 9, 0);
  const t = await testCore({ now: () => clock });
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const first = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Old title' });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Old title too' });
    assert.ok(card.rank < first.rank, 'a new card lands on top of its column');
    assert.equal(card.statusAt, clock);

    clock += 3 * 3600_000;
    const edited = await t.owner.call('cards.update', { id: card.id, title: 'Label the pay button', body: 'Screen readers say "button".', type: 'bug', priority: 0 });
    assert.deepEqual([edited.title, edited.body, edited.type, edited.priority, edited.status], ['Label the pay button', 'Screen readers say "button".', 'bug', 0, 'ready']);
    assert.equal(edited.statusAt, card.statusAt, 'an edit does not restart its time in Ready');
    assert.equal(edited.rank, card.rank, 'nor move it');
    const [log] = await t.owner.call('activity.list', { cardId: card.id, limit: 1 });
    assert.deepEqual([log?.actor, log?.verb, log?.detail], ['owner', 'edited', 'title, description, type → bug, priority → P0']);
    await t.owner.call('cards.comment', { id: card.id, body: 'A comment is not a move either.' });
    assert.equal((await t.owner.call('cards.get', { id: card.id })).statusAt, card.statusAt);

    await assert.rejects(t.owner.call('cards.update', { id: card.id, priority: 4 as never }), /priority must be one of/);
    await assert.rejects(t.owner.call('cards.update', { id: card.id, type: 'epic' as never }), /type must be one of/);
    await assert.rejects(t.owner.call('cards.update', { id: card.id, title: '   ' }), /cannot be empty/);

    clock += 3600_000;
    const moved = await t.owner.call('cards.move', { id: card.id, status: 'inbox' });
    assert.equal(moved.statusAt, clock, 'entering a column starts its clock');
  } finally {
    await t.close();
  }
});

test('criteria: the owner ticks, rewords and removes them; an agent may only add one', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Criteria' });
    await t.owner.call('criteria.add', { cardId: card.id, text: 'Tests pass' });
    await t.owner.call('criteria.add', { cardId: card.id, text: 'Docs updatd' });
    let [tests, docs] = (await t.owner.call('cards.get', { id: card.id })).criteria;

    await t.owner.call('criteria.update', { id: tests!.id, done: true });
    await t.owner.call('criteria.update', { id: docs!.id, text: 'Docs updated' });
    let now = await t.owner.call('cards.get', { id: card.id });
    assert.deepEqual(now.criteria.map((c) => [c.text, c.done]), [['Tests pass', true], ['Docs updated', false]]);
    assert.deepEqual(now.progress, { done: 1, total: 2 });
    assert.ok(now.activity.some((a) => a.verb === 'ticked' && a.detail === 'Tests pass'));

    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
    const agent = await CoreClient.connect(t.core.paths.socket, await tokenOf(t.core, session.id));
    await assert.rejects(agent.call('criteria.add', { cardId: card.id, text: 'Not mine yet' }), /You do not hold this card/, 'only on a card it holds');
    await t.owner.call('cards.move', { id: card.id, status: 'ready' });
    await agent.call('cards.claim', { id: card.id });
    await agent.call('criteria.add', { cardId: card.id, text: 'Works on mobile' });
    [tests, docs] = (await t.owner.call('cards.get', { id: card.id })).criteria;
    await assert.rejects(agent.call('criteria.update', { id: docs!.id, done: true }), /not available to a session/, 'an agent cannot tick its own criteria');
    await assert.rejects(agent.call('criteria.remove', { id: docs!.id }), /not available to a session/);

    await t.owner.call('criteria.remove', { id: docs!.id });
    now = await t.owner.call('cards.get', { id: card.id });
    assert.deepEqual(now.criteria.map((c) => c.text), ['Tests pass', 'Works on mobile']);
    await assert.rejects(t.owner.call('criteria.remove', { id: docs!.id }), /No such criterion/);
    agent.close();
    await t.owner.call('sessions.stop', { id: session.id });
  } finally {
    await t.close();
  }
});

test('approve and send back only from Review, reopen only from Done; approving clears what was flagged', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Gates' });
    await assert.rejects(t.owner.call('cards.approve', { id: card.id }), /Only a card in Review can be approved; this one is ready/);
    await assert.rejects(t.owner.call('cards.sendBack', { id: card.id, note: 'no' }), /Only a card in Review can be sent back/);
    await assert.rejects(t.owner.call('cards.reopen', { id: card.id, stillWrong: 'no' }), /Only a Done card can be reopened/);

    await t.owner.call('cards.evidence', { id: card.id, evidence: { kind: 'note', value: 'Checked by hand' } });
    await t.owner.call('cards.move', { id: card.id, status: 'review' });
    await assert.rejects(t.owner.call('cards.sendBack', { id: card.id, note: '  ' }), /cannot be empty/, 'sending back says why');
    const back = await t.owner.call('cards.sendBack', { id: card.id, note: 'Missing the empty state' });
    assert.deepEqual([back.status, back.sentBack], ['ready', true]);

    await t.owner.call('cards.move', { id: card.id, status: 'review' });
    const done = await t.owner.call('cards.approve', { id: card.id, note: 'Looks right' });
    assert.deepEqual([done.status, done.sentBack, done.reopened], ['done', false, false]);
    await assert.rejects(t.owner.call('cards.move', { id: card.id, status: 'ready' }), /Reopen it and say what is still wrong/);

    const reopened = await t.owner.call('cards.reopen', { id: card.id, stillWrong: 'The empty state still shows a spinner' });
    assert.deepEqual([reopened.status, reopened.reopened], ['ready', true]);
    await t.owner.call('cards.move', { id: card.id, status: 'review' });
    const again = await t.owner.call('cards.approve', { id: card.id });
    assert.equal(again.reopened, false, 'approved again is no longer flagged');
    const detail = await t.owner.call('cards.get', { id: card.id });
    assert.deepEqual(detail.criteria.map((c) => c.text), ['The empty state still shows a spinner']);
    assert.ok(detail.comments.some((c) => c.author === 'owner' && c.body === 'Looks right'), 'an approval note is a comment');
  } finally {
    await t.close();
  }
});

test('only the owner archives: the card leaves the board, its counts and search, nobody can work it, and archiving is final', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'idea', title: 'Archive me someday' });
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
    const agent = await CoreClient.connect(t.core.paths.socket, await tokenOf(t.core, session.id));
    await assert.rejects(agent.call('cards.move' as never, { id: card.id, status: 'archived' } as never), /not available to a session/);

    const archived = await t.owner.call('cards.move', { id: card.id, status: 'archived' });
    assert.equal(archived.status, 'archived');
    assert.ok(!(await t.owner.call('cards.list', { projectId: project.id })).some((c) => c.id === card.id), 'off the board');
    const counts = (await t.owner.call('projects.list', {})).find((p) => p.id === project.id)?.counts;
    assert.deepEqual(counts, { inbox: 0, ready: 0, working: 0, review: 0, done: 0 });
    assert.deepEqual(await t.owner.call('cards.search', { query: 'Archive me' }), []);
    await assert.rejects(agent.call('cards.claim', { id: card.id }), /This card is archived/);
    await assert.rejects(t.owner.call('sessions.start', { projectId: project.id, provider: 'shell', cardId: card.id }), /archived/);
    assert.deepEqual((await t.owner.call('sessions.list', { projectId: project.id })).map((s) => s.id), [session.id], 'refused before anything started');
    const move = await t.owner.call('cards.move', { id: card.id, status: 'ready' }).catch((e: Error) => e);
    assert.ok(move instanceof Error && /This card is archived/.test(move.message) && !/Restore/.test(move.message),
      `refused without offering what does not exist: ${(move as Error).message}`);
    assert.equal((await t.owner.call('cards.get', { id: card.id })).activity[0]?.verb, 'moved to archived', 'and it is on the record');
    agent.close();
    await t.owner.call('sessions.stop', { id: session.id });
  } finally {
    await t.close();
  }
});

test('a card says who holds it and whether they are running, from the session itself', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Held' });
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude', cardId: card.id, title: 'Cart agent' });
    const token = await tokenOf(t.core, session.id);
    await relay(t.core, token, 'SessionStart', {});
    await relay(t.core, token, 'UserPromptSubmit', {});
    const summary = async () => (await t.owner.call('cards.list', { projectId: project.id })).find((c) => c.id === card.id)!;
    let now = await summary();
    assert.deepEqual(now.holder, { sessionId: session.id, title: 'Cart agent', provider: 'claude', state: 'working' });
    assert.deepEqual(now.live, { sessionId: session.id, state: 'working', provider: 'claude' });

    await relay(t.core, token, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'pnpm test' } });
    assert.equal((await summary()).live?.state, 'permission', 'what it is doing now, not when it started');
    await t.owner.call('sessions.stop', { id: session.id });
    now = await waitFor('given back', async () => { const c = await summary(); return c.live === null ? c : null; });
    assert.deepEqual([now.status, now.holder, now.claim], ['ready', null, null]);
  } finally {
    await t.close();
  }
});

test('each session is told the decisions as they stand when it starts: edited, withdrawn, Claude and Codex alike', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const pnpm = await t.owner.call('decisions.add', { projectId: project.id, title: 'Use npm' });
    const deps = await t.owner.call('decisions.add', { projectId: project.id, title: 'No new dependencies without asking', body: 'Ask on the card.' });
    await t.owner.call('decisions.update', { id: pnpm.id, title: 'Use pnpm, never npm' });
    await t.owner.call('decisions.remove', { id: deps.id });
    assert.deepEqual((await t.owner.call('decisions.list', { projectId: project.id })).map((d) => d.title), ['Use pnpm, never npm']);
    await assert.rejects(t.owner.call('decisions.update', { id: deps.id, title: 'Back' }), /No such decision/, 'withdrawn is withdrawn');
    const verbs = (await t.owner.call('activity.list', { projectId: project.id })).map((a) => a.verb);
    for (const v of ['recorded a decision', 'changed a decision', 'withdrew a decision']) assert.ok(verbs.includes(v), v);

    const claude = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
    const told = JSON.parse(await relay(t.core, await tokenOf(t.core, claude.id), 'SessionStart', { source: 'startup' }));
    const context: string = told.hookSpecificOutput.additionalContext;
    assert.match(context, /Decisions in force for this project \(follow them\):\n- Use pnpm, never npm$/);
    assert.doesNotMatch(context, /Use npm\b|No new dependencies/);

    const codex = await t.owner.call('sessions.start', { projectId: project.id, provider: 'codex' });
    const args = await waitFor('codex args', () => t.core.sessions.replay(codex.id).replay.match(/developer_instructions=(.*Decisions in force.*)/s)?.[1]);
    assert.match(args, /Use pnpm, never npm/);
    assert.doesNotMatch(args, /No new dependencies/);
    for (const s of [claude, codex]) await t.owner.call('sessions.stop', { id: s.id });
  } finally {
    await t.close();
  }
});

test('a new key renames every card in the project; a key in use or not a key is refused', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir, key: 'OLD' });
    const other = await t.owner.call('projects.add', { path: t.dir, key: 'OTH' });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Rekeyed' });
    assert.equal(card.key, 'OLD-1');
    await assert.rejects(t.owner.call('projects.update', { id: project.id, key: 'oth' }), /already used by another project/);
    await assert.rejects(t.owner.call('projects.update', { id: project.id, key: '9X' }), /1–6 letters or digits, starting with a letter/);
    const renamed = await t.owner.call('projects.update', { id: project.id, key: 'new' });
    assert.equal(renamed.key, 'NEW');
    assert.equal((await t.owner.call('cards.get', { id: card.id })).key, 'NEW-1');
    assert.equal((await t.owner.call('cards.get', { id: 'NEW-1' })).id, card.id, 'found by its new key');
    assert.equal((await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Next' })).key, 'NEW-2', 'numbering carries on');
    assert.equal(other.key, 'OTH');
  } finally {
    await t.close();
  }
});

test('the owner starting a session on an Inbox card accepts it; an agent cannot take it from there', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'bug', title: 'Triage me', status: 'inbox' });
    const other = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
    const agent = await CoreClient.connect(t.core.paths.socket, await tokenOf(t.core, other.id));
    await assert.rejects(agent.call('cards.claim', { id: card.id }), /in the Inbox/);
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell', cardId: card.id });
    const now = await t.owner.call('cards.get', { id: card.id });
    assert.deepEqual([now.status, now.claim?.sessionId], ['working', session.id]);
    agent.close();
    for (const s of [other, session]) await t.owner.call('sessions.stop', { id: s.id });
  } finally {
    await t.close();
  }
});

test('activity: every change names who made it, newest first, by project and by card', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const other = await t.owner.call('projects.add', { path: t.dir, name: 'Other' });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Watched' });
    await t.owner.call('cards.create', { projectId: other.id, type: 'task', title: 'Elsewhere' });
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude', cardId: card.id });
    const agent = await CoreClient.connect(t.core.paths.socket, await tokenOf(t.core, session.id));
    await agent.call('cards.comment', { id: card.id, body: 'On it' });
    agent.close();
    await t.owner.call('sessions.stop', { id: session.id });
    await waitFor('released', async () => (await t.owner.call('cards.get', { id: card.id })).claim === null);

    const onCard = await t.owner.call('activity.list', { cardId: card.id });
    assert.deepEqual(onCard.map((a) => [a.actor, a.verb]).reverse(), [
      ['owner', 'created'], ['owner', 'started Claude Code'], [`session:${session.id}`, 'claimed'],
      [`session:${session.id}`, 'commented'], ['system', 'released the claim'], [`session:${session.id}`, 'ended'],
    ]);
    assert.ok(onCard.every((a, i) => i === 0 || (onCard[i - 1] as { id: number }).id > a.id), 'newest first');
    const inProject = await t.owner.call('activity.list', { projectId: project.id });
    assert.ok(inProject.every((a) => a.projectId === project.id) && !inProject.some((a) => a.detail === 'Elsewhere'));
    const everywhere = await t.owner.call('activity.list', {});
    assert.ok(everywhere.some((a) => a.detail === 'Elsewhere') && everywhere.some((a) => a.cardId === card.id));
    assert.equal((await t.owner.call('activity.list', { limit: 2 })).length, 2);
  } finally {
    await t.close();
  }
});

test('closing a project waits for its sessions, hides it and what it needs, and opening the folder again brings it back whole', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Kept' });
    await t.owner.call('cards.evidence', { id: card.id, evidence: { kind: 'note', value: 'done' } });
    await t.owner.call('cards.move', { id: card.id, status: 'review' });
    assert.ok((await t.owner.call('needs.list', {})).some((n) => n.cardId === card.id));

    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell' });
    await assert.rejects(t.owner.call('projects.archive', { id: project.id }), /Stop this project’s live sessions/);
    await t.owner.call('sessions.stop', { id: session.id });
    await waitFor('ended', async () => (await t.owner.call('sessions.get', { id: session.id })).session.endedAt);

    await t.owner.call('projects.archive', { id: project.id });
    assert.ok(!(await t.owner.call('projects.list', {})).some((p) => p.id === project.id));
    assert.ok(!(await t.owner.call('needs.list', {})).some((n) => n.projectId === project.id), 'a closed project asks nothing');
    assert.deepEqual(await t.owner.call('cards.search', { query: 'Kept' }), []);

    const again = await t.owner.call('projects.add', { path: t.projectDir });
    assert.deepEqual([again.id, again.key], [project.id, project.key], 'the same project, not a new one');
    assert.equal((await t.owner.call('cards.get', { id: card.id })).status, 'review');
    assert.ok((await t.owner.call('needs.list', {})).some((n) => n.cardId === card.id));
  } finally {
    await t.close();
  }
});

test('a project folder written as ~/… is the folder under the home it names', async () => {
  const t = await testCore();
  const home = process.env.HOME;
  try {
    process.env.HOME = t.dir; // os.homedir() follows HOME, so the real home is never read
    const project = await t.owner.call('projects.add', { path: '~/site' });
    assert.equal(project.path, t.projectDir);
    await assert.rejects(t.owner.call('projects.add', { path: '~/nowhere' }), /There is no folder at ~\/nowhere/);
    await assert.rejects(t.owner.call('projects.add', { path: 'site' }), /or one that starts with ~\//);
  } finally {
    process.env.HOME = home;
    await t.close();
  }
});
