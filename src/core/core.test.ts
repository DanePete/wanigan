// The core end to end: a real database, real sockets, real PTYs, the real CLI
// through the shim on the session's PATH, and the real hook relay script.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { CoreClient } from '../client/client.ts';
import { Core } from './core.ts';
import { openDatabase } from './db.ts';
import { parseUsage } from '../shared/usage.ts';
import { MAX_LABEL, MAX_TO, decodeChatter } from '../shared/chatter.ts';
import type { Events } from '../shared/protocol.ts';
import { CLI, launcher, relay, savedConversation, waitFor } from './test-support.ts';

/** A stand-in for `claude -p`: records its arguments, answers like the real CLI (or fails on request). */
function fakeReviewer(dir: string): string {
  const file = join(dir, 'fake-claude-review.sh');
  const answer = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.42,
    structured_output: {
      verdict: 'pass', summary: 'Both criteria hold.',
      criteria: [
        { criterion: 'Tests pass', met: true, proof: 'The test output says so.', file: 'after.txt', quote: 'tests pass' },
        { criterion: 'Docs updated', met: true, proof: 'The README mentions it.', file: 'after.txt', quote: 'this line is not in the file' },
      ],
    },
  });
  const draft = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.05,
    structured_output: {
      type: 'bug', title: 'Reject expired coupon codes at checkout', body: 'The coupon field accepts codes past their end date.',
      criteria: ['An expired code is refused with a message', 'A valid code still applies'], priority: 1, why: 'Customers get discounts they should not.',
    },
  });
  writeFileSync(file, [
    '#!/bin/sh',
    'printf "%s\\n" "$@" > "$WG_REVIEW_ARGS"',
    'echo "CFG=${CLAUDE_CONFIG_DIR-unset} CWD=$(pwd)" >> "$WG_REVIEW_ARGS"',
    'if [ -n "$WG_REVIEW_FAIL" ]; then echo "auth expired" >&2; exit 1; fi',
    'case "$2" in *"Turn this note into a card"*)',
    `cat <<'JSON'\n${draft}\nJSON`,
    'exit 0 ;; esac',
    `cat <<'JSON'\n${answer}\nJSON`,
  ].join('\n'), { mode: 0o755 });
  return file;
}

describe('core', () => {
  let dir: string;
  let projectDir: string;
  let otherDir: string;
  let core: Core;
  let owner: CoreClient;
  let clock = Date.now();

  before(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'wg-')));
    projectDir = join(dir, 'northstar-storefront');
    otherDir = join(dir, 'orbit-api');
    mkdirSync(projectDir);
    mkdirSync(otherDir);
    writeFileSync(join(projectDir, 'after.txt'), 'tests pass\n');
    const home = join(dir, 'home');
    for (const d of ['.claude', '.claude_work', '.codex']) mkdirSync(join(home, d), { recursive: true });
    writeFileSync(join(home, '.claude_work', 'settings.json'), '{}');
    mkdirSync(join(home, '.claude_notes'), { recursive: true }); // not an account: nothing Claude-shaped inside
    core = new Core({
      dataDir: join(dir, 'data'),
      now: () => clock,
      launcher,
      cli: { runtime: process.execPath, entry: CLI },
      claudeBinary: fakeReviewer(dir),
      codexHookProbe: null,
      jev: { envKey: null },
      accounts: {
        home,
        prober: async (_provider, configDir) => configDir?.endsWith('.claude_work')
          ? { signedIn: 'yes', identity: 'work@example.com', plan: 'team' }
          : { signedIn: 'unknown', identity: null, plan: null },
        usageReader: async (provider, configDir) => provider === 'codex'
          ? { state: 'ok', windows: [{ kind: 'week', scope: null, usedPercent: 100, resetsAtText: null, resetsAt: null }], checkedAt: 0, note: 'Codex says this account cannot be used for ordinary work until a limit resets.' }
          : parseUsage(configDir?.endsWith('.claude_work')
            ? 'Current session: 40% used · resets Oct 6 at 11:50pm (America/Chicago)\nCurrent week (all models): 12% used'
            : 'Not logged in · Please run /login'),
      },
    });
    await core.start();
    owner = await CoreClient.connect(core.paths.socket, readFileSync(core.paths.ownerToken, 'utf8'));
  });

  after(async () => {
    owner?.close();
    await core?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a wrong token is refused', async () => {
    await assert.rejects(CoreClient.connect(core.paths.socket, 'nope'), /Unknown token/);
  });

  test('projects get keys, and cards get project-scoped keys', async () => {
    const p = await owner.call('projects.add', { path: projectDir });
    assert.equal(p.key, 'NS');
    assert.equal(p.name, 'northstar-storefront');
    const again = await owner.call('projects.add', { path: projectDir });
    assert.equal(again.id, p.id, 'opening the same folder twice is the same project');
    const card = await owner.call('cards.create', { projectId: p.id, type: 'bug', title: 'Checkout button has no label' });
    assert.equal(card.key, 'NS-1');
    assert.equal(card.status, 'ready');
    await assert.rejects(owner.call('projects.add', { path: join(dir, 'missing') }), /no folder/);
  });

  test('the removed legacy project-discovery method is refused', async () => {
    await assert.rejects(owner.callRaw('projects.suggestions' as never, {}), /Unknown method|No method/);
  });

  test('cards can be found across every project', async () => {
    const hits = await owner.call('cards.search', { query: 'checkout' });
    assert.ok(hits.some((h) => h.key === 'NS-1' && h.projectKey === 'NS'), 'by title');
    assert.deepEqual((await owner.call('cards.search', { query: 'NS-1' })).map((h) => h.key)[0], 'NS-1', 'by key first');
    assert.deepEqual(await owner.call('cards.search', { query: '%' }), [], 'wildcards are literal');
  });

  test('the owner cannot drag a card into Working', async () => {
    const [card] = await owner.call('cards.list', { projectId: (await owner.call('projects.list', {}))[0]!.id });
    await assert.rejects(owner.call('cards.move', { id: card!.id, status: 'working' }), /Start a session/);
  });

  test('evidence is something real, and an agent only adds to the card it works', async () => {
    const [project] = await owner.call('projects.list', {});
    const mine = await owner.call('cards.create', { projectId: project!.id, type: 'task', title: 'Evidence rules' });
    const theirs = await owner.call('cards.create', { projectId: project!.id, type: 'task', title: 'Someone else’s card' });
    await owner.call('cards.move', { id: mine.id, status: 'ready' });
    const session = await owner.call('sessions.start', { projectId: project!.id, provider: 'shell' });
    const type = (line: string) => owner.call('sessions.input', { id: session.id, data: `${line}\n` });
    const screen = () => core.sessions.replay(session.id).replay;
    await type(`wanigan claim ${mine.key}`);
    await waitFor('claimed', async () => (await owner.call('cards.get', { id: mine.id })).status === 'working');

    // A flag without its value used to file "" (the working folder) or the next flag as evidence.
    await type(`wanigan review ${mine.key} --evidence`);
    await waitFor('bare flag refused', () => screen().includes('--evidence needs a value'));
    await type(`wanigan review ${mine.key} --evidence --note done`);
    await waitFor('flag as value refused', () => screen().split('--evidence needs a value').length > 2);
    await type(`wanigan review ${mine.key} --evidence . --note "the folder"`);
    await waitFor('folder refused', () => screen().includes('is a folder. Evidence is a file, a link or a note.'));
    assert.equal((await owner.call('cards.get', { id: mine.id })).status, 'working', 'nothing reached review');

    await type(`wanigan criteria ${theirs.key} "Also mine now"`);
    await waitFor('criteria on an unheld card refused', () => screen().includes('You do not hold this card'));
    await type(`wanigan file idea "Cache the totals"`);
    const filed = await waitFor('filed', async () => (await owner.call('cards.list', { projectId: project!.id })).find((c) => c.title === 'Cache the totals'));
    await type(`wanigan criteria ${filed.key} "Totals agree with the cart"`);
    await waitFor('criterion on its own Inbox card', async () => (await owner.call('cards.get', { id: filed.id })).criteria.length === 1);
    assert.equal((await owner.call('cards.get', { id: theirs.id })).criteria.length, 0);

    await type('echo TOKEN=$WANIGAN_TOKEN');
    const token = await waitFor('token', () => screen().match(/TOKEN=([A-Za-z0-9_-]{20,})/)?.[1]);
    const sessionClient = await CoreClient.connect(core.paths.socket, token);
    await assert.rejects(sessionClient.call('cards.evidence', { id: theirs.id, evidence: { kind: 'note', value: 'proof' } }), /You do not hold this card/);
    sessionClient.close();
    await owner.call('sessions.stop', { id: session.id });
  });

  test('an agent claims, notes and submits through the CLI in its own terminal', async () => {
    const [project] = await owner.call('projects.list', {});
    const card = await owner.call('cards.create', { projectId: project!.id, type: 'task', title: 'Write the evidence migration' });
    await owner.call('criteria.add', { cardId: card.id, text: 'Migration is additive' });
    const session = await owner.call('sessions.start', { projectId: project!.id, provider: 'shell' });
    const type = (line: string) => owner.call('sessions.input', { id: session.id, data: `${line}\n` });
    const screen = () => core.sessions.replay(session.id).replay;

    await type(`wanigan claim ${card.key} --note "starting with the schema"`);
    await waitFor('claim output', () => screen().includes(`Claimed ${card.key}`));
    let now = await owner.call('cards.get', { id: card.id });
    assert.equal(now.status, 'working');
    assert.equal(now.claim?.sessionId, session.id);
    assert.equal(now.comments.at(-1)?.body, 'starting with the schema');

    await type(`wanigan review ${card.key} --note "done"`);
    await waitFor('refusal without evidence', () => screen().includes('Review needs evidence'));

    await type(`wanigan review ${card.key} --evidence after.txt --evidence https://example.com/run/1 --note "migration added"`);
    await waitFor('review output', () => screen().includes(`${card.key} is in review`));
    now = await owner.call('cards.get', { id: card.id });
    assert.equal(now.status, 'review');
    assert.equal(now.claim, null);
    assert.deepEqual(now.evidence.map((e) => [e.kind, e.existed]), [['file', true], ['link', null]]);
    assert.equal(now.evidence[0]?.value, join(projectDir, 'after.txt'));

    const needs = await owner.call('needs.list', {});
    assert.ok(needs.some((n) => n.kind === 'review' && n.cardId === card.id), 'review raises Needs you');

    await owner.call('cards.sendBack', { id: card.id, note: 'Add a down migration note' });
    await type('wanigan status');
    await waitFor('sent back in status', () => screen().includes('Sent back to you'));

    await type(`wanigan claim ${card.key}`);
    await waitFor('second claim', async () => (await owner.call('cards.get', { id: card.id })).status === 'working');
    await type(`wanigan review ${card.key} --evidence "Down migration documented in the PR body"`);
    await waitFor('second review', async () => (await owner.call('cards.get', { id: card.id })).status === 'review');
    const approved = await owner.call('cards.approve', { id: card.id });
    assert.equal(approved.status, 'done');
    assert.equal(approved.sentBack, false);

    const byKey = await owner.call('cards.get', { id: card.key });
    assert.equal(byKey.criteria.length, now.criteria.length, 'a card fetched by key has its criteria');
    assert.equal(byKey.evidence.length, 3, 'and its evidence');
    assert.ok(byKey.activity.length > 0, 'and its history');
    const reopened = await owner.call('cards.reopen', { id: card.id, stillWrong: 'Rollback still drops the column' });
    assert.equal(reopened.status, 'ready');
    assert.equal(reopened.reopened, true);
    const detail = await owner.call('cards.get', { id: card.id });
    assert.equal(detail.criteria.at(-1)?.text, 'Rollback still drops the column');

    await owner.call('sessions.stop', { id: session.id });
    await waitFor('session end', async () => (await owner.call('sessions.list', {})).find((s) => s.id === session.id)?.state === 'ended');
  });

  test('a session is confined to its project and cannot approve', async () => {
    const other = await owner.call('projects.add', { path: otherDir });
    const foreign = await owner.call('cards.create', { projectId: other.id, type: 'task', title: 'Not yours' });
    const [project] = (await owner.call('projects.list', {})).filter((p) => p.key === 'NS');
    const session = await owner.call('sessions.start', { projectId: project!.id, provider: 'shell' });
    await owner.call('sessions.input', { id: session.id, data: 'echo "TOKEN=$WANIGAN_TOKEN"\n' });
    const token = await waitFor('token', () => core.sessions.replay(session.id).replay.match(/TOKEN=([A-Za-z0-9_-]{20,})/)?.[1]);
    const agent = await CoreClient.connect(core.paths.socket, token);
    assert.equal(agent.role, 'session');

    await assert.rejects(agent.call('cards.claim', { id: foreign.id }), /another project/);
    await assert.rejects(agent.call('cards.get', { id: foreign.id }), /another project/);
    await assert.rejects(agent.call('projects.list', {}), /not available to a session/);
    const mine = await agent.call('cards.create', { type: 'bug', title: 'Found while working', status: 'ready' });
    assert.equal(mine.status, 'inbox', 'what an agent files lands in the Inbox');
    assert.equal(mine.projectId, project!.id);
    await assert.rejects(agent.call('cards.approve', { id: mine.id }), /not available to a session/);
    await assert.rejects(agent.call('cards.claim', { id: mine.id }), /Inbox/, 'nobody works an Inbox card the owner has not accepted');
    await owner.call('cards.move', { id: mine.id, status: 'ready' });

    await agent.call('cards.claim', { id: mine.id });
    await owner.call('sessions.stop', { id: session.id });
    await waitFor('released on exit', async () => (await owner.call('cards.get', { id: mine.id })).status === 'ready');
    const card = await owner.call('cards.get', { id: mine.id });
    assert.equal(card.claim, null);
    assert.ok(card.activity.some((a) => a.verb === 'released the claim'), 'the release is recorded');
    await assert.rejects(agent.call('cards.comment', { id: mine.id, body: 'late' }), /has ended/);
    agent.close();
  });

  test('hook events drive state, Needs you and the session briefing', async () => {
    const [project] = (await owner.call('projects.list', {})).filter((p) => p.key === 'NS');
    await owner.call('decisions.add', { projectId: project!.id, title: 'Use pnpm, never npm' });
    const card = await owner.call('cards.create', { projectId: project!.id, type: 'feature', title: 'Search endpoint' });
    const session = await owner.call('sessions.start', { projectId: project!.id, provider: 'claude', cardId: card.id });
    assert.equal(session.state, 'starting');
    assert.ok(session.conversationId, 'Claude sessions get a known conversation ID');
    const token = await waitFor('token', () => core.sessions.replay(session.id).replay.match(/TOKEN=([A-Za-z0-9_-]{20,})/)?.[1]);
    assert.equal((await owner.call('cards.get', { id: card.id })).claim?.sessionId, session.id, 'a session started on a card claims it');

    const briefing = JSON.parse(await relay(core, token, 'SessionStart', { hook_event_name: 'SessionStart', source: 'startup' }));
    const context: string = briefing.hookSpecificOutput.additionalContext;
    assert.match(context, /northstar-storefront/);
    assert.match(context, /Your card is NS-\d+: Search endpoint/);
    assert.match(context, /Use pnpm, never npm/);
    const state = async () => (await owner.call('sessions.get', { id: session.id })).session;
    assert.equal((await state()).state, 'waiting');

    assert.equal(await relay(core, token, 'UserPromptSubmit', { prompt: 'go' }), '');
    assert.equal((await state()).state, 'working');
    await relay(core, token, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: '/x/src/search.ts' } });
    assert.equal((await state()).activity, 'Edit search.ts');

    await relay(core, token, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } });
    assert.equal((await state()).state, 'permission');
    let needs = await owner.call('needs.list', {});
    assert.equal(needs[0]?.kind, 'permission', 'permission is the most urgent need');
    assert.equal(needs[0]?.detail, 'Asking: Bash rm -rf dist');

    await relay(core, token, 'Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
    assert.equal((await state()).state, 'permission', 'idle does not clear an open permission request');
    await relay(core, token, 'PostToolUse', { tool_name: 'Bash' });
    assert.equal((await state()).state, 'working');
    await relay(core, token, 'Stop', {});
    assert.equal((await state()).state, 'waiting');
    needs = await owner.call('needs.list', {});
    assert.ok(needs.some((n) => n.kind === 'waiting' && n.sessionId === session.id), 'a finished turn waits for the owner');
    await owner.call('sessions.seen', { id: session.id });
    needs = await owner.call('needs.list', {});
    assert.ok(!needs.some((n) => n.kind === 'waiting' && n.sessionId === session.id), 'seeing it settles it');

    const events = (await owner.call('sessions.get', { id: session.id })).events.map((e) => e.event);
    assert.deepEqual(events.slice(0, 3), ['SessionStart', 'UserPromptSubmit', 'PreToolUse']);

    // A malformed or anonymous hook changes nothing and never fails the agent.
    assert.equal(await relay(core, 'not-a-token', 'Stop', {}), '');
    await owner.call('sessions.stop', { id: session.id });
  });

  test('agents messaging each other are recorded as who and label, never the message', async () => {
    const [project] = (await owner.call('projects.list', {})).filter((p) => p.key === 'NS');
    const session = await owner.call('sessions.start', { projectId: project!.id, provider: 'claude', title: 'Checkout lead' });
    const token = await waitFor('token', () => core.sessions.replay(session.id).replay.match(/TOKEN=([A-Za-z0-9_-]{20,})/)?.[1]);
    await relay(core, token, 'SessionStart', {});
    const heard: Events['chatter'][] = [];
    const off = owner.on((event, data) => { if (event === 'chatter') heard.push(data as Events['chatter']); });

    await relay(core, token, 'PreToolUse', {
      tool_name: 'SendMessage',
      tool_input: { to: 'researcher', summary: 'Found the flaky test · in checkout', message: 'SECRET-BODY the whole message' },
    });
    await waitFor('the chatter event', () => heard.length === 1);
    const [first] = heard;
    assert.equal(first?.projectId, project!.id);
    assert.equal(first?.sessionId, session.id);
    assert.equal(first?.from, 'Checkout lead');
    assert.equal(first?.to, 'researcher');
    assert.equal(first?.label, 'Found the flaky test · in checkout', 'a label may contain the separator');
    assert.ok(typeof first?.at === 'number');
    // PostToolUse is the same message finishing, not a second one.
    await relay(core, token, 'PostToolUse', { tool_name: 'SendMessage', tool_input: { to: 'researcher', message: 'SECRET-BODY' } });

    const { session: after, events } = await owner.call('sessions.get', { id: session.id });
    assert.equal(after.activity, 'Messaging researcher: Found the flaky test · in checkout');
    const sent = events.find((e) => e.event === 'PreToolUse' && e.tool === 'SendMessage');
    assert.equal(sent?.summary, 'researcher · Found the flaky test · in checkout');
    assert.deepEqual(decodeChatter(sent?.summary ?? null), { to: 'researcher', label: 'Found the flaky test · in checkout' });
    const stored = JSON.stringify(core.db.prepare('SELECT * FROM session_events WHERE session_id = ?').all(session.id))
      + JSON.stringify(core.db.prepare('SELECT * FROM sessions WHERE id = ?').all(session.id));
    assert.ok(!stored.includes('SECRET-BODY'), 'the message itself is never stored');

    // Long names and labels are clipped; a missing label is said as missing.
    await relay(core, token, 'PreToolUse', { tool_name: 'SendMessage', tool_input: { to: 'r'.repeat(80), summary: 'x'.repeat(400), message: 'm' } });
    await relay(core, token, 'PreToolUse', { tool_name: 'SendMessage', tool_input: { to: 'main', message: 'no label here' } });
    await waitFor('two more', () => heard.length === 3);
    assert.equal(heard[1]?.to?.length, MAX_TO);
    assert.equal(heard[1]?.label?.length, MAX_LABEL);
    assert.deepEqual([heard[2]?.to, heard[2]?.label], ['main', null]);
    assert.equal((await owner.call('sessions.get', { id: session.id })).session.activity, 'Messaging main');
    assert.equal(heard[0]?.agent, null, 'the main thread sent the first');

    // A helper inside the session answering is named as itself, not as the session.
    await relay(core, token, 'PreToolUse', { tool_name: 'SendMessage', agent_id: 'a7f3', agent_type: 'researcher', tool_input: { to: 'main', summary: 'Drawer uses the same check' } });
    await waitFor('the helper’s reply', () => heard.length === 4);
    assert.deepEqual([heard[3]?.agent, heard[3]?.to, heard[3]?.from], ['researcher', 'main', 'Checkout lead']);

    // Another tool is not chatter, and a hook after the session ended is history, not news.
    await relay(core, token, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'pnpm test' } });
    await owner.call('sessions.stop', { id: session.id });
    await waitFor('ended', async () => (await owner.call('sessions.get', { id: session.id })).session.state === 'ended');
    core.sessions.hook(session.id, 'PreToolUse', { tool_name: 'SendMessage', tool_input: { to: 'late', summary: 'after the end' } });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(heard.length, 4);
    off();
  });

  test('queued messages wait for a Claude session to be idle', async () => {
    const [project] = (await owner.call('projects.list', {})).filter((p) => p.key === 'NS');
    const session = await owner.call('sessions.start', { projectId: project!.id, provider: 'claude' });
    const token = await waitFor('token', () => core.sessions.replay(session.id).replay.match(/TOKEN=([A-Za-z0-9_-]{20,})/)?.[1]);
    await relay(core, token, 'SessionStart', {});
    await relay(core, token, 'UserPromptSubmit', {});
    const { queued } = await owner.call('sessions.queue', { id: session.id, text: 'Also update the README' });
    assert.equal(queued, 1, 'held while the agent is working');
    await relay(core, token, 'Stop', {});
    await waitFor('delivery', () => core.sessions.replay(session.id).replay.includes('Also update the README'));
    assert.equal(core.sessions.pendingCount(session.id), 0);
    await owner.call('sessions.stop', { id: session.id });
  });

  test('a claim from a dead session expires; a live session keeps its claim', async () => {
    const [project] = (await owner.call('projects.list', {})).filter((p) => p.key === 'NS');
    const card = await owner.call('cards.create', { projectId: project!.id, type: 'task', title: 'Lease test' });
    const session = await owner.call('sessions.start', { projectId: project!.id, provider: 'shell', cardId: card.id });
    clock += 31 * 60_000;
    core.board.sweepLeases(core.sessions.liveIds());
    let now = await owner.call('cards.get', { id: card.id });
    assert.equal(now.claim?.sessionId, session.id, 'renewed because the session is alive');
    assert.ok((now.claim?.expiresAt ?? 0) > clock);
    clock += 31 * 60_000;
    core.board.sweepLeases(new Set());
    now = await owner.call('cards.get', { id: card.id });
    assert.equal(now.claim, null);
    assert.equal(now.status, 'ready');
    await owner.call('sessions.stop', { id: session.id });
  });

  test('existing account folders are found, and the default account sets no variable', async () => {
    const accounts = await owner.call('accounts.list', {});
    const claude = accounts.filter((a) => a.provider === 'claude');
    assert.deepEqual(claude.map((a) => [a.label, a.configDir === null, a.isDefault]), [['Default', true, true], ['work', false, false]]);
    assert.ok(!accounts.some((a) => a.configDir?.endsWith('.claude_notes')), 'a folder with nothing Claude-shaped inside is not an account');
    assert.deepEqual(accounts.filter((a) => a.provider === 'codex').map((a) => a.label), ['Default']);
    await owner.call('accounts.refresh', {});
    const work = (await owner.call('accounts.list', {})).find((a) => a.label === 'work');
    assert.deepEqual([work?.signedIn, work?.identity, work?.plan], ['yes', 'work@example.com', 'team']);
    assert.equal((await owner.call('accounts.list', {})).find((a) => a.label === 'Default' && a.provider === 'claude')?.signedIn, 'unknown',
      'no answer is unknown, never "signed out"');

    const [project] = (await owner.call('projects.list', {})).filter((p) => p.key === 'NS');
    const cfg = async (sessionId: string) => waitFor('config line', () => core.sessions.replay(sessionId).replay.match(/CFG=(\S+)/)?.[1]);
    const inherited = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = '/tmp/someone-elses-config';
    try {
      const plain = await owner.call('sessions.start', { projectId: project!.id, provider: 'claude' });
      assert.equal(await cfg(plain.id), 'unset', 'the default account removes an inherited CLAUDE_CONFIG_DIR');
      await owner.call('sessions.stop', { id: plain.id });

      await owner.call('projects.setAccount', { id: project!.id, provider: 'claude', accountId: work!.id });
      const scoped = await owner.call('sessions.start', { projectId: project!.id, provider: 'claude' });
      assert.equal(await cfg(scoped.id), work!.configDir, 'the project’s account is used');
      assert.equal(scoped.accountId, work!.id, 'and recorded on the session');
      assert.deepEqual((await owner.call('projects.list', {})).find((p) => p.id === project!.id)?.accounts, { claude: work!.id });
      await owner.call('sessions.stop', { id: scoped.id });
    } finally {
      if (inherited === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = inherited;
    }

    assert.equal((await owner.call('accounts.list', {})).find((a) => a.label === 'work')?.sameLoginAs, null, 'a login of its own');
    await owner.call('accounts.refreshUsage', { force: true });
    const read = await owner.call('accounts.list', {});
    assert.deepEqual(read.find((a) => a.label === 'work')?.usage?.windows.map((w) => [w.kind, w.usedPercent]), [['session', 40], ['week', 12]]);
    assert.equal(read.find((a) => a.label === 'Default' && a.provider === 'claude')?.usage?.state, 'signed-out', 'a signed-out reply is said, not counted');
    assert.equal(read.find((a) => a.provider === 'codex')?.usage?.windows[0]?.usedPercent, 100, 'Codex limits are read too');

    const added = await owner.call('accounts.add', { provider: 'codex', label: 'Game dev' });
    assert.match(added.configDir ?? '', /\.codex_game_dev$/);
    await assert.rejects(owner.call('accounts.remove', { id: accounts.find((a) => a.provider === 'codex')!.id }), /default/);
    await owner.call('accounts.remove', { id: added.id });
    assert.ok(!(await owner.call('accounts.list', {})).some((a) => a.id === added.id));
    await owner.call('projects.setAccount', { id: project!.id, provider: 'claude', accountId: null });
  });

  test('pausing a project blocks new work and asks live Claude sessions to wrap up', async () => {
    const [project] = (await owner.call('projects.list', {})).filter((p) => p.key === 'NS');
    const card = await owner.call('cards.create', { projectId: project!.id, type: 'task', title: 'Pause test' });
    const claude = await owner.call('sessions.start', { projectId: project!.id, provider: 'claude' });
    const token = await waitFor('token', () => core.sessions.replay(claude.id).replay.match(/TOKEN=([A-Za-z0-9_-]{20,})/)?.[1]);
    await relay(core, token, 'SessionStart', {});
    await relay(core, token, 'UserPromptSubmit', {});
    const shell = await owner.call('sessions.start', { projectId: project!.id, provider: 'shell' });
    await owner.call('sessions.input', { id: shell.id, data: 'echo "TOKEN=$WANIGAN_TOKEN"\n' });
    const shellToken = await waitFor('shell token', () => core.sessions.replay(shell.id).replay.match(/TOKEN=([A-Za-z0-9_-]{20,})/)?.[1]);
    const agent = await CoreClient.connect(core.paths.socket, shellToken);

    const { asked } = await owner.call('projects.pause', { id: project!.id });
    assert.equal(asked, 1, 'only the live Claude session is asked');
    assert.ok((await owner.call('projects.list', {})).find((p) => p.id === project!.id)?.pausedAt);
    await assert.rejects(owner.call('sessions.start', { projectId: project!.id, provider: 'shell' }), /paused/);
    await assert.rejects(agent.call('cards.claim', { id: card.id }), /paused/);
    assert.equal((await agent.call('agent.status', {})).paused, true);

    assert.equal(core.sessions.pendingCount(claude.id), 1, 'the wrap-up waits for the agent to finish its turn');
    await relay(core, token, 'Stop', {});
    await waitFor('wrap-up delivered', () => core.sessions.replay(claude.id).replay.includes('The owner has paused this project'));

    await owner.call('projects.resume', { id: project!.id });
    const after = await owner.call('sessions.start', { projectId: project!.id, provider: 'shell' });
    await agent.call('cards.claim', { id: card.id });
    for (const id of [claude.id, shell.id, after.id]) await owner.call('sessions.stop', { id });
    agent.close();
  });

  test('an ended Claude conversation resumes on the same card and account', async () => {
    const [project] = (await owner.call('projects.list', {})).filter((p) => p.key === 'NS');
    const card = await owner.call('cards.create', { projectId: project!.id, type: 'task', title: 'Resume test' });
    const first = await owner.call('sessions.start', { projectId: project!.id, provider: 'claude', cardId: card.id });
    await waitFor('first args', () => core.sessions.replay(first.id).replay.includes(`--session-id ${first.conversationId}`));
    await owner.call('sessions.stop', { id: first.id });
    await waitFor('first ended', async () => (await owner.call('sessions.get', { id: first.id })).session.state === 'ended');
    assert.equal((await owner.call('cards.get', { id: card.id })).status, 'ready', 'the card went back when the session ended');

    // Claude Code saves a conversation at its first prompt; before that there is nothing to resume.
    await assert.rejects(owner.call('sessions.resume', { id: first.id }), /saved nothing for this conversation, because it never got a prompt/);
    savedConversation(join(dir, 'home'), first);
    const second = await owner.call('sessions.resume', { id: first.id });
    assert.equal(second.conversationId, first.conversationId, 'same conversation');
    assert.equal(second.cardId, card.id, 'same card');
    assert.equal(second.accountId, first.accountId, 'same account');
    await waitFor('resume args', () => core.sessions.replay(second.id).replay.includes(`--resume ${first.conversationId}`));
    assert.equal((await owner.call('cards.get', { id: card.id })).claim?.sessionId, second.id, 'and it holds the card again');
    await assert.rejects(owner.call('sessions.resume', { id: first.id }), /already running/);
    await assert.rejects(owner.call('sessions.resume', { id: second.id }), /still running/);
    await owner.call('sessions.stop', { id: second.id });
  });

  test('a project’s uncommitted changes and their diffs, read-only', async () => {
    const repo = join(dir, 'git-project');
    mkdirSync(join(repo, 'src'), { recursive: true });
    const sh = (cmd: string) => new Promise<void>((ok, fail) => execFile('/bin/sh', ['-c', cmd], { cwd: repo }, (e) => (e ? fail(e) : ok())));
    writeFileSync(join(repo, 'src', 'app.ts'), 'export const a = 1;\nexport const b = 2;\n');
    writeFileSync(join(repo, 'README.md'), '# Repo\n');
    await sh('git init -q && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init');
    writeFileSync(join(repo, 'src', 'app.ts'), 'export const a = 1;\nexport const b = 3;\nexport const c = 4;\n');
    writeFileSync(join(repo, 'src', 'new.ts'), 'export {};\n');
    await sh('git rm -q README.md');
    const p = await owner.call('projects.add', { path: repo });
    const result = await owner.call('projects.changes', { id: p.id });
    assert.equal(result.git, true);
    assert.deepEqual(result.files.map((f) => [f.path, f.status, f.additions, f.deletions]),
      [['README.md', 'D', 0, 1], ['src/app.ts', 'M', 2, 1], ['src/new.ts', '?', 1, 0]]);
    const app = await owner.call('projects.diff', { id: p.id, path: 'src/app.ts' });
    assert.match(app.diff, /^-export const b = 2;$/m);
    assert.match(app.diff, /^\+export const c = 4;$/m);
    assert.match((await owner.call('projects.diff', { id: p.id, path: 'src/new.ts' })).diff, /^\+export \{\};$/m);
    await assert.rejects(owner.call('projects.diff', { id: p.id, path: '../../etc/passwd' }), /outside the project/);
    await assert.rejects(owner.call('projects.diff', { id: p.id, path: 'src/unchanged.ts' }), /no changes/);
    const plain = await owner.call('projects.add', { path: otherDir });
    assert.equal((await owner.call('projects.changes', { id: plain.id })).git, false, 'a folder that is not a repository says so');
  });

  test('a Codex session reports waiting, asking and working from its own notifications', async () => {
    const [project] = (await owner.call('projects.list', {})).filter((p) => p.key === 'NS');
    const card = await owner.call('cards.create', { projectId: project!.id, type: 'feature', title: 'Codex lifecycle', body: 'Brief me' });
    const session = await owner.call('sessions.start', { projectId: project!.id, provider: 'codex', cardId: card.id });
    const state = async () => (await owner.call('sessions.get', { id: session.id })).session;
    await waitFor('ready', () => core.sessions.replay(session.id).replay.includes('codex ready'));
    const args = core.sessions.replay(session.id).replay;
    assert.match(args, /tui\.notification_method="osc9"/, 'asks for lifecycle notifications');
    assert.match(args, /developer_instructions=.*Codex lifecycle/s, 'briefed with its card at launch');
    await waitFor('waiting', async () => (await state()).state === 'waiting');

    await owner.call('sessions.input', { id: session.id, data: 'ask\r' });
    await waitFor('asking', async () => (await state()).state === 'permission');
    assert.equal((await state()).activity, 'Approval requested: run the tests');
    assert.ok((await owner.call('needs.list', {})).some((n) => n.kind === 'permission' && n.sessionId === session.id));

    await owner.call('sessions.input', { id: session.id, data: 'y\r' });
    await waitFor('working after the answer', async () => (await state()).state === 'working');
    const { queued } = await owner.call('sessions.queue', { id: session.id, text: 'then update the docs' });
    assert.equal(queued, 1, 'held while Codex works');
    await owner.call('sessions.input', { id: session.id, data: 'done\r' });
    await waitFor('delivered when idle', () => core.sessions.replay(session.id).replay.includes('got: \x1b[200~then update the docs'));
    assert.equal((await state()).state, 'working', 'and delivering it starts the next turn');
    await owner.call('sessions.stop', { id: session.id });
  });

  test('a card works on its own branch, and is merged back only when it is safe', async () => {
    const repo = join(dir, 'branchy');
    mkdirSync(repo);
    const sh = (cwd: string, cmd: string) => new Promise<string>((ok, fail) => execFile('/bin/sh', ['-c', cmd], { cwd }, (e, out) => (e ? fail(e) : ok(String(out)))));
    const id = '-c user.email=t@t -c user.name=t';
    writeFileSync(join(repo, 'app.txt'), 'one\n');
    await sh(repo, `git init -q -b main && git ${id} add -A && git ${id} commit -qm init`);
    const project = await owner.call('projects.add', { path: repo });
    assert.equal((await owner.call('projects.list', {})).find((p) => p.id === project.id)?.git, true);
    const card = await owner.call('cards.create', { projectId: project.id, type: 'feature', title: 'Branch work' });

    const session = await owner.call('sessions.start', { projectId: project.id, provider: 'shell', cardId: card.id, isolate: true });
    const withBranch = await owner.call('cards.get', { id: card.id });
    assert.equal(withBranch.worktree?.branch, `wanigan/${card.key.toLowerCase()}`);
    assert.equal(withBranch.worktree?.base, 'main');
    assert.equal(session.cwd, withBranch.worktree?.path, 'the session runs in the card’s own checkout');
    const wt = withBranch.worktree!.path;

    writeFileSync(join(wt, 'feature.txt'), 'new\n');
    await sh(wt, `git ${id} add -A && git ${id} commit -qm feature`);
    writeFileSync(join(wt, 'scratch.txt'), 'not committed\n');
    const cardChanges = await owner.call('projects.changes', { id: project.id, cardId: card.id });
    assert.deepEqual(cardChanges.files.map((f) => [f.path, f.status]), [['feature.txt', 'A'], ['scratch.txt', '?']], 'committed and uncommitted work since the fork');
    assert.equal((await owner.call('projects.changes', { id: project.id })).files.length, 0, 'the project folder itself is untouched');
    assert.match((await owner.call('projects.diff', { id: project.id, cardId: card.id, path: 'feature.txt' })).diff, /^\+new$/m);

    await assert.rejects(owner.call('cards.merge', { id: card.id }), /Stop the card/);
    await owner.call('sessions.stop', { id: session.id });
    await waitFor('stopped', async () => !(await owner.call('cards.get', { id: card.id })).live);
    await assert.rejects(owner.call('cards.merge', { id: card.id }), /worktree has uncommitted/);
    await sh(wt, 'rm scratch.txt');
    writeFileSync(join(repo, 'app.txt'), 'one\nlocal edit\n');
    await assert.rejects(owner.call('cards.merge', { id: card.id }), /project folder has uncommitted/);
    await sh(repo, 'git checkout -q -- app.txt');

    const merged = await owner.call('cards.merge', { id: card.id });
    assert.ok(merged.commit);
    assert.equal(readFileSync(join(repo, 'feature.txt'), 'utf8'), 'new\n', 'the work is on main');
    await owner.call('cards.removeWorktree', { id: card.id });
    assert.equal((await owner.call('cards.get', { id: card.id })).worktree, null);
    assert.equal(existsSync(wt), false, 'the worktree is gone');
    assert.equal((await sh(repo, 'git branch --list "wanigan/*"')).trim(), '', 'and so is the merged branch');
  });

  test('an AI review is read-only, checked against the files, and only advice', async () => {
    const [project] = (await owner.call('projects.list', {})).filter((p) => p.key === 'NS');
    const card = await owner.call('cards.create', { projectId: project!.id, type: 'task', title: 'Reviewed work' });
    await owner.call('criteria.add', { cardId: card.id, text: 'Tests pass' });
    await owner.call('criteria.add', { cardId: card.id, text: 'Docs updated' });
    const argsFile = join(dir, 'review-args.txt');
    process.env.WG_REVIEW_ARGS = argsFile;
    try {
      const started = await owner.call('cards.aiReview', { id: card.id });
      assert.equal(started.state, 'running');
      const review = await waitFor('review done', async () => (await owner.call('cards.get', { id: card.id })).reviews.find((r) => r.state !== 'running'));
      assert.equal(review.state, 'done');
      assert.equal(review.costUsd, 0.42, 'the cost the CLI reported is kept');
      assert.deepEqual(review.result?.criteria.map((c) => c.quoteFound), [true, false], 'each quote is checked against the file');
      assert.equal(review.result?.verdict, 'unsure', 'a pass resting on a quote that is not there is not a pass');
      assert.match(review.result?.notes.join(' ') ?? '', /not in the file it named/);
      assert.equal((await owner.call('cards.get', { id: card.id })).status, 'ready', 'the review never moves the card');

      const args = readFileSync(argsFile, 'utf8').split('\n');
      const after = (flag: string) => args.slice(args.indexOf(flag) + 1, args.indexOf(flag) + 4);
      assert.deepEqual(after('--allowedTools'), ['Read', 'Grep', 'Glob'], 'read-only tools only');
      assert.ok(args.includes('--disallowedTools') && args.includes('Edit') && args.includes('Bash'));
      assert.ok(args.includes('--json-schema'));
      assert.ok(args.some((a) => a.endsWith(`CWD=${projectDir}`)), 'it reads the project folder');

      process.env.WG_REVIEW_FAIL = '1';
      await owner.call('cards.aiReview', { id: card.id });
      const failed = await waitFor('review failed', async () => (await owner.call('cards.get', { id: card.id })).reviews.find((r) => r.state === 'failed'));
      assert.match(failed.error ?? '', /auth expired/, 'a failure says why');
    } finally {
      delete process.env.WG_REVIEW_ARGS;
      delete process.env.WG_REVIEW_FAIL;
    }
  });

  test('a card can be drafted from a rough note, and nothing is created by the draft', async () => {
    const [project] = (await owner.call('projects.list', {})).filter((p) => p.key === 'NS');
    const before = (await owner.call('cards.list', { projectId: project!.id })).length;
    process.env.WG_REVIEW_ARGS = join(dir, 'draft-args.txt');
    try {
      const { draft, costUsd } = await owner.call('cards.draft', { projectId: project!.id, note: 'coupon thing lets old codes through??' });
      assert.equal(draft.type, 'bug');
      assert.equal(draft.title, 'Reject expired coupon codes at checkout');
      assert.deepEqual(draft.criteria, ['An expired code is refused with a message', 'A valid code still applies']);
      assert.equal(draft.priority, 1);
      assert.equal(costUsd, 0.05);
      assert.equal((await owner.call('cards.list', { projectId: project!.id })).length, before, 'a draft creates nothing');
      const args = readFileSync(join(dir, 'draft-args.txt'), 'utf8');
      assert.match(args, /coupon thing lets old codes through/);
      assert.match(args, /Use pnpm, never npm/, 'the project’s decisions inform the draft');
      await assert.rejects(owner.call('cards.draft', { projectId: project!.id, note: '   ' }), /Write a note/);
    } finally {
      delete process.env.WG_REVIEW_ARGS;
    }
  });

  test('two live sessions in one folder editing one file is raised, and clears when one stops', async () => {
    const [project] = (await owner.call('projects.list', {})).filter((p) => p.key === 'NS');
    const a = await owner.call('sessions.start', { projectId: project!.id, provider: 'shell', title: 'Session A' });
    const b = await owner.call('sessions.start', { projectId: project!.id, provider: 'shell', title: 'Session B' });
    const edit = (id: string, file: string) => core.sessions.hook(id, 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: join(projectDir, file) } });
    edit(a.id, 'src/app.ts');
    edit(b.id, 'src/other.ts');
    assert.ok(!(await owner.call('needs.list', {})).some((n) => n.kind === 'overlap'), 'different files are fine');
    edit(b.id, 'src/app.ts');
    const overlap = (await owner.call('needs.list', {})).find((n) => n.kind === 'overlap');
    assert.equal(overlap?.title, 'src/app.ts');
    assert.match(overlap?.detail ?? '', /Session A and Session B|Session B and Session A/);
    await owner.call('sessions.stop', { id: b.id });
    await waitFor('overlap cleared', async () => !(await owner.call('needs.list', {})).some((n) => n.kind === 'overlap'));
    await owner.call('sessions.stop', { id: a.id });
  });

  test('a Codex patch counts as an edit to every file it names, for overlaps and the record', async () => {
    const [project] = (await owner.call('projects.list', {})).filter((p) => p.key === 'NS');
    const a = await owner.call('sessions.start', { projectId: project!.id, provider: 'shell', title: 'Patcher' });
    const b = await owner.call('sessions.start', { projectId: project!.id, provider: 'shell', title: 'Editor' });
    // As Codex 0.155.1 sends it: tool_name apply_patch, the patch in tool_input.command, paths relative to the session's folder.
    const patch = ['*** Begin Patch', '*** Update File: src/one.ts', '@@', '-a', '+b', '*** Add File: src/two.ts', '+x', '*** End Patch'].join('\n');
    core.sessions.hook(a.id, 'PostToolUse', { tool_name: 'apply_patch', tool_input: { command: patch } });
    const rows = core.db.prepare('SELECT path FROM session_edits WHERE session_id = ? ORDER BY id').all(a.id) as { path: string }[];
    assert.deepEqual(rows.map((r) => r.path), [join(projectDir, 'src/one.ts'), join(projectDir, 'src/two.ts')]);
    // The second file, not only the first, is what collides.
    core.sessions.hook(b.id, 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: join(projectDir, 'src/two.ts') } });
    const overlap = (await owner.call('needs.list', {})).find((n) => n.kind === 'overlap');
    assert.equal(overlap?.title, 'src/two.ts');
    assert.match(overlap?.detail ?? '', /Patcher and Editor|Editor and Patcher/);
    await owner.call('sessions.stop', { id: a.id });
    await owner.call('sessions.stop', { id: b.id });
    await waitFor('overlap cleared', async () => !(await owner.call('needs.list', {})).some((n) => n.kind === 'overlap'));
  });

  test('a working Claude session that goes quiet is raised; looking at it settles it', async () => {
    const [project] = (await owner.call('projects.list', {})).filter((p) => p.key === 'NS');
    const s = await owner.call('sessions.start', { projectId: project!.id, provider: 'claude' });
    const token = await waitFor('token', () => core.sessions.replay(s.id).replay.match(/TOKEN=([A-Za-z0-9_-]{20,})/)?.[1]);
    await relay(core, token, 'UserPromptSubmit', {});
    const quiet = async () => (await owner.call('needs.list', {})).find((n) => n.kind === 'quiet' && n.sessionId === s.id);
    assert.equal(await quiet(), undefined, 'just started working is not quiet');
    clock += 21 * 60_000;
    assert.match((await quiet())?.detail ?? '', /No activity for 21 minutes/);
    await owner.call('sessions.seen', { id: s.id });
    assert.equal(await quiet(), undefined, 'looking at it settles it');
    await owner.call('sessions.stop', { id: s.id });
  });

  test('an agent that has not reported starting is raised, as Claude Code at a folder-trust question is', async () => {
    const [project] = (await owner.call('projects.list', {})).filter((p) => p.key === 'NS');
    const s = await owner.call('sessions.start', { projectId: project!.id, provider: 'claude' });
    const shell = await owner.call('sessions.start', { projectId: project!.id, provider: 'shell' });
    const token = await waitFor('token', () => core.sessions.replay(s.id).replay.match(/TOKEN=([A-Za-z0-9_-]{20,})/)?.[1]);
    const starting = async () => (await owner.call('needs.list', {})).filter((n) => n.kind === 'starting').map((n) => n.sessionId);
    assert.deepEqual(await starting(), [], 'a few seconds to start is normal');
    clock += 11_000;
    assert.deepEqual(await starting(), [s.id], 'a shell has nothing to report, so only the agent is raised');
    const need = (await owner.call('needs.list', {})).find((n) => n.kind === 'starting');
    assert.match(need?.detail ?? '', /trust this folder/);
    core.db.prepare("UPDATE sessions SET state = 'running', activity = 'No hook events received; live state unknown' WHERE id = ?").run(s.id);
    assert.deepEqual(await starting(), [s.id], 'still raised once the no-hooks fallback calls it running');
    await relay(core, token, 'SessionStart', {});
    assert.deepEqual(await starting(), [], 'its first hook event settles it');

    const other = await owner.call('sessions.start', { projectId: project!.id, provider: 'claude' });
    clock += 11_000;
    assert.ok((await starting()).includes(other.id));
    await owner.call('sessions.seen', { id: other.id });
    assert.ok(!(await starting()).includes(other.id), 'looking at it settles it');
    for (const id of [s.id, shell.id, other.id]) await owner.call('sessions.stop', { id });
  });

  test('events reach the owner as they happen', async () => {
    const [project] = (await owner.call('projects.list', {})).filter((p) => p.key === 'NS');
    const seen: string[] = [];
    const off = owner.on((event) => seen.push(event));
    await owner.call('cards.create', { projectId: project!.id, type: 'idea', title: 'Event test' });
    await waitFor('board event', () => seen.includes('board'));
    off();
  });

  test('terminal output streams to watchers with sequence numbers', async () => {
    const [project] = (await owner.call('projects.list', {})).filter((p) => p.key === 'NS');
    const session = await owner.call('sessions.start', { projectId: project!.id, provider: 'shell' });
    const { seq } = await owner.call('sessions.watch', { id: session.id });
    const chunks: { seq: number; data: string }[] = [];
    const off = owner.on((event, data) => {
      const d = data as { sessionId: string; seq: number; data: string };
      if (event === 'pty.data' && d.sessionId === session.id) chunks.push(d);
    });
    await owner.call('sessions.input', { id: session.id, data: 'echo streamed-$((40+2))\n' });
    await waitFor('streamed output', () => chunks.map((c) => c.data).join('').includes('streamed-42'));
    assert.ok(chunks.every((c, i) => c.seq > seq && (i === 0 || c.seq > (chunks[i - 1] as { seq: number }).seq)));
    off();
    await owner.call('sessions.stop', { id: session.id });
  });
});

describe('storage', () => {
  test('a database Wanigan 2 did not create is refused, not adopted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wg-db-'));
    const file = join(dir, 'foreign.db');
    const foreign = openDatabase(join(dir, 'ok.db'));
    foreign.close();
    // Make a database with someone else's table and no Wanigan marker.
    const raw = openDatabaseRaw(file);
    raw.exec('CREATE TABLE notes (id INTEGER)');
    raw.close();
    assert.throws(() => openDatabase(file), /not created by Wanigan 2/);
    rmSync(dir, { recursive: true, force: true });
  });
});

function openDatabaseRaw(file: string) {
  // better-sqlite3 directly, without migrations.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return new (createRequire()('better-sqlite3'))(file) as { exec(sql: string): void; close(): void };
}

import { createRequire as nodeCreateRequire } from 'node:module';
function createRequire() {
  return nodeCreateRequire(import.meta.url);
}
