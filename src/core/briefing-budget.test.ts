// Owner RPC, real temporary hooks, and inert agents: no provider/model calls.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Provider } from '../shared/model.ts';
import type { CoreOptions } from './core.ts';
import { relay, testCore, tokenOf, waitFor } from './test-support.ts';

const REFUSED = /session briefing is too large/i;
const NOTICE = 'Session briefing refused';
type Limits = { bytes?: number; rows?: number };

async function fixture(limits: Limits = {}, extra: Partial<CoreOptions> = {}) {
  let script = '', launches = 0;
  const options: Partial<CoreOptions> & { briefingLimits: Limits } = {
    ...extra, briefingLimits: limits,
    launcher() { launches++; return { file: '/bin/sh', args: [script] }; },
  };
  const t = await testCore(options);
  try {
    script = join(t.dir, 'agent.sh');
    const argv = join(t.dir, 'argv');
    writeFileSync(script, `printf '%s\\0' "$@" > '${argv}'\nprintf 'TOKEN=%s\\n' "$WANIGAN_TOKEN"\nexec cat\n`);
    const project = await t.owner.call('projects.add', { path: t.projectDir, name: 'Briefing fixture', key: 'BF' });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'feature', title: 'Owned briefing', body: 'A', status: 'ready' });
    const start = (provider: Provider = 'claude') => t.owner.call('sessions.start', { projectId: project.id, cardId: card.id, provider });
    const contents = async () => ({
      card: await t.owner.call('cards.get', { id: card.id }),
      decisions: await t.owner.call('decisions.list', { projectId: project.id }),
      sessions: await t.owner.call('sessions.list', {}),
    });
    return { ...t, project, card, argv, start, contents, get launches() { return launches; } };
  } catch (error) { await t.close(); throw error; }
}

for (const provider of ['claude', 'gemini', 'codex'] as const) {
  test(`${provider}: an oversized initial briefing refuses before launch, hooks, worktree or session creation`, async () => {
    let probes = 0;
    const t = await fixture({ bytes: 1536 }, { codexHookProbe: {
      async version() { probes++; return null; },
      async list() { probes++; return []; },
    } });
    try {
      execFileSync('/usr/bin/git', ['init', '-q'], { cwd: t.projectDir });
      execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'owned fixture'], { cwd: t.projectDir });
      await t.owner.call('projects.update', { id: t.project.id, isolate: true });
      await t.owner.call('cards.update', { id: t.card.id, body: 'owned board text '.repeat(200) });
      const before = await t.contents();
      await assert.rejects(t.start(provider), REFUSED);
      assert.deepEqual(await t.contents(), before, 'the refused launch preserves all stored card data and creates no session or claim');
      assert.equal(t.launches, 0, 'even the launcher lookup is after briefing admission');
      assert.equal(probes, 0, 'the Codex stand-in capability probe was not asked');
      assert.equal(existsSync(t.argv), false);
      assert.equal(existsSync(join(t.core.paths.dataDir, 'worktrees')), false);
      assert.equal(existsSync(join(t.core.paths.dataDir, 'gemini-home')), false);
      assert.equal((await t.owner.call('core.hello', {})).role, 'owner', 'an independent owner call still works');
    } finally { await t.close(); }
  });
}

test('the combined row limit admits criteria plus decisions at the boundary, refuses the next, and recovers without deleting data', async () => {
  const t = await fixture({ rows: 2 });
  try {
    await t.owner.call('criteria.add', { cardId: t.card.id, text: 'first criterion' });
    await t.owner.call('decisions.add', { projectId: t.project.id, title: 'first decision', body: 'keep it all' });
    const extra = await t.owner.call('decisions.add', { projectId: t.project.id, title: 'excess decision' });
    const before = await t.contents();
    await assert.rejects(t.start('codex'), REFUSED);
    assert.deepEqual(await t.contents(), before);
    assert.equal(t.launches, 0);
    await t.owner.call('decisions.remove', { id: extra.id });
    const session = await t.start('codex');
    await tokenOf(t.core, session.id);
    const arg = readFileSync(t.argv, 'utf8').split('\0').find((value) => value.startsWith('developer_instructions='));
    assert.ok(arg);
    const text: unknown = JSON.parse(arg.slice('developer_instructions='.length));
    assert.equal(typeof text, 'string');
    assert.match(text as string, /first criterion/);
    assert.match(text as string, /first decision — keep it all/);
    assert.doesNotMatch(text as string, /excess decision/);
  } finally { await t.close(); }
});

test('criteria alone cannot bypass the aggregate row admission', async () => {
  const t = await fixture({ rows: 2 });
  try {
    for (const text of ['first', 'second', 'third']) await t.owner.call('criteria.add', { cardId: t.card.id, text });
    const before = await t.contents();
    await assert.rejects(t.start(), REFUSED);
    assert.deepEqual(await t.contents(), before);
    assert.equal(existsSync(t.argv), false);
  } finally { await t.close(); }
});

for (const provider of ['claude', 'gemini'] as const) {
  test(`${provider}: exact encoded envelope boundary is admitted; the next byte gives a bounded explicit late refusal`, async () => {
    const cap = 1536;
    const t = await fixture({ bytes: cap });
    try {
      const session = await t.start(provider), token = await tokenOf(t.core, session.id);
      const first = await relay(t.core, token, 'SessionStart', {});
      const initial = Buffer.byteLength(first);
      assert.ok(initial < cap, 'the ordinary briefing must first be genuinely readable');
      const body = 'A' + 'x'.repeat(cap - initial);
      await t.owner.call('cards.update', { id: t.card.id, body });
      const exact = await relay(t.core, token, 'SessionStart', {});
      assert.equal(Buffer.byteLength(exact), cap);
      assert.ok(JSON.parse(exact).hookSpecificOutput.additionalContext.includes(body));
      await t.owner.call('cards.update', { id: t.card.id, body: body + 'x' });
      const refused = await relay(t.core, token, 'SessionStart', {});
      assert.ok(Buffer.byteLength(refused) <= cap);
      const envelope = JSON.parse(refused);
      assert.deepEqual(Object.keys(envelope), ['hookSpecificOutput']);
      assert.equal(envelope.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.match(envelope.hookSpecificOutput.additionalContext, /Session briefing refused/);
      assert.doesNotMatch(envelope.hookSpecificOutput.additionalContext, /Your card|xxx/);
      const observed = await t.owner.call('sessions.get', { id: session.id });
      assert.equal(observed.session.state, 'waiting', 'the real live agent and SessionStart lifecycle are not relabelled failed');
      assert.ok(observed.events.some((event) => event.event === 'Wanigan' && event.summary?.includes(NOTICE)));
      assert.equal(observed.events.filter((event) => event.event === 'SessionStart').length, 3);
      const activity = await t.owner.call('activity.list', { cardId: t.card.id });
      assert.ok(activity.some((event) => event.verb === 'could not provide the session briefing'));
      assert.equal((await t.owner.call('cards.get', { id: t.card.id })).body, body + 'x');
      assert.equal(await relay(t.core, token, provider === 'gemini' ? 'BeforeAgent' : 'UserPromptSubmit', { prompt: 'owned lifecycle fixture' }), '');
      await t.owner.call('cards.update', { id: t.card.id, body: 'Recovered whole briefing' });
      const recovered = JSON.parse(await relay(t.core, token, 'SessionStart', {})).hookSpecificOutput.additionalContext as string;
      assert.match(recovered, /Recovered whole briefing/);
      assert.doesNotMatch(recovered, /Session briefing refused/);
    } finally { await t.close(); }
  });
}

for (const [label, value] of [['multibyte', '雪🙂'], ['JSON escapes', '\n"\\']] as const) {
  test(`${label}: encoded bytes, including JSON expansion, determine briefing admission`, async () => {
    const cap = 1536;
    const t = await fixture({ bytes: cap });
    try {
      const session = await t.start(), token = await tokenOf(t.core, session.id);
      const first = await relay(t.core, token, 'SessionStart', {});
      const spare = cap - Buffer.byteLength(first);
      assert.ok(spare > 0);
      const encodedContribution = Buffer.byteLength(JSON.stringify(value)) - 2;
      const n = Math.floor(spare / encodedContribution);
      const fitting = 'A' + value.repeat(n);
      await t.owner.call('cards.update', { id: t.card.id, body: fitting });
      const fits = await relay(t.core, token, 'SessionStart', {});
      assert.equal(Buffer.byteLength(fits), Buffer.byteLength(first) + n * encodedContribution);
      assert.ok(JSON.parse(fits).hookSpecificOutput.additionalContext.includes(fitting));
      await t.owner.call('cards.update', { id: t.card.id, body: fitting + value });
      const refused = JSON.parse(await relay(t.core, token, 'SessionStart', {})).hookSpecificOutput.additionalContext as string;
      assert.match(refused, /Session briefing refused/);
      assert.equal((await t.owner.call('cards.get', { id: t.card.id })).body, fitting + value);
    } finally { await t.close(); }
  });
}

test('the final Codex admission rechecks data changed while its owned hook probe was awaited', async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const t = await fixture({ rows: 1 }, { codexHookProbe: {
    async version() { enter(); await held; return null; }, async list() { return []; },
  } });
  let completed: Promise<unknown> | undefined;
  try {
    await t.owner.call('decisions.add', { projectId: t.project.id, title: 'initial admitted decision' });
    completed = t.start('codex');
    const outcome = completed.then((session) => ({ session, error: null }), (error: unknown) => ({ session: null, error }));
    await entered;
    await t.owner.call('decisions.add', { projectId: t.project.id, title: 'arrived while awaiting the probe' });
    const before = await t.contents();
    release();
    const result = await outcome;
    assert.ok(result.error instanceof Error);
    assert.match(result.error.message, REFUSED);
    assert.deepEqual(await t.contents(), before);
    assert.equal(existsSync(t.argv), false, 'no stand-in process was spawned after the final refusal');
  } finally { release(); await completed?.catch(() => {}); await t.close(); }
});

test('an admitted briefing reads only its relevant rows: old comments/evidence/sessions do not consume its row budget', async () => {
  const t = await fixture({ rows: 1, bytes: 4096 });
  try {
    await t.owner.call('criteria.add', { cardId: t.card.id, text: 'only this one criterion counts' });
    for (let n = 0; n < 8; n++) {
      await t.owner.call('cards.comment', { id: t.card.id, body: `old comment ${n} ` + 'x'.repeat(1000) });
      await t.owner.call('cards.evidence', { id: t.card.id, evidence: { kind: 'link', value: `https://example.invalid/owned/${n}` } });
    }
    // Historical rows in this owned test store, with no real processes or accounts.
    const insert = t.core.db.prepare(`INSERT INTO sessions (id, project_id, card_id, provider, title, state, token_hash, started_at, ended_at)
      VALUES (?, ?, ?, 'shell', 'owned history', 'ended', ?, 1, 2)`);
    for (let n = 0; n < 8; n++) insert.run(`owned-${n}`, t.project.id, t.card.id, `unused-${n}`);
    const session = await t.start(), token = await tokenOf(t.core, session.id);
    const text = JSON.parse(await relay(t.core, token, 'SessionStart', {})).hookSpecificOutput.additionalContext as string;
    assert.match(text, /only this one criterion counts/);
    assert.doesNotMatch(text, /old comment|example.invalid|owned history/);
    const detail = await t.owner.call('cards.get', { id: t.card.id });
    assert.equal(detail.comments.length, 8); assert.equal(detail.evidence.length, 8); assert.equal(detail.sessions.length, 9);
  } finally { await t.close(); }
});

test('a sent-back card includes only its last comment, preserving same-timestamp insertion order', async () => {
  const t = await fixture({ rows: 1, bytes: 4096 }, { now: () => 1_000 });
  try {
    await t.owner.call('cards.comment', { id: t.card.id, body: 'earlier note ' + 'x'.repeat(8000) });
    await t.owner.call('cards.comment', { id: t.card.id, body: 'last tied note, kept whole' });
    t.core.db.prepare('UPDATE cards SET sent_back = 1 WHERE id = ?').run(t.card.id);
    const session = await t.start(), token = await tokenOf(t.core, session.id);
    const text = JSON.parse(await relay(t.core, token, 'SessionStart', {})).hookSpecificOutput.additionalContext as string;
    assert.match(text, /The owner's note: last tied note, kept whole/);
    assert.doesNotMatch(text, /earlier note/);
    assert.equal((await t.owner.call('cards.get', { id: t.card.id })).comments.length, 2);
  } finally { await t.close(); }
});

test('a shell launch is not refused because the project briefing exceeds the agent budget', async () => {
  const t = await fixture({ rows: 1 });
  try {
    await t.owner.call('decisions.add', { projectId: t.project.id, title: 'one' });
    await t.owner.call('decisions.add', { projectId: t.project.id, title: 'two' });
    const session = await t.start('shell');
    await tokenOf(t.core, session.id);
    assert.equal((await t.owner.call('sessions.get', { id: session.id })).session.state, 'running');
  } finally { await t.close(); }
});

test('Codex admits the exact encoded developer_instructions argument and refuses one more escaped byte before spawning', async () => {
  const cap = 1536;
  const t = await fixture({ bytes: cap });
  const stop = async (id: string) => {
    await t.owner.call('sessions.stop', { id });
    await waitFor('the owned agent exit and claim release', async () => {
      const session = (await t.owner.call('sessions.get', { id })).session;
      const card = await t.owner.call('cards.get', { id: t.card.id });
      return session.endedAt !== null && card.claim === null;
    });
  };
  try {
    const first = await t.start('codex'); await tokenOf(t.core, first.id);
    const firstArg = readFileSync(t.argv, 'utf8').split('\0').find((arg) => arg.startsWith('developer_instructions='));
    assert.ok(firstArg);
    await stop(first.id);
    const spare = cap - Buffer.byteLength(firstArg);
    assert.ok(spare > 10);
    const body = 'A' + '\\'.repeat(Math.floor(spare / 2)) + (spare % 2 ? 'x' : '');
    await t.owner.call('cards.update', { id: t.card.id, body });
    const exact = await t.start('codex'); await tokenOf(t.core, exact.id);
    const arg = readFileSync(t.argv, 'utf8').split('\0').find((value) => value.startsWith('developer_instructions='));
    assert.ok(arg); assert.equal(Buffer.byteLength(arg), cap);
    assert.ok((JSON.parse(arg.slice('developer_instructions='.length)) as string).includes(body));
    await stop(exact.id);
    await t.owner.call('cards.update', { id: t.card.id, body: body + 'x' });
    const before = await t.contents(), oldArgv = readFileSync(t.argv);
    const launches = t.launches;
    await assert.rejects(t.start('codex'), REFUSED);
    assert.deepEqual(await t.contents(), before);
    assert.equal(t.launches, launches);
    assert.deepEqual(readFileSync(t.argv), oldArgv, 'the prior owned argument capture is not overwritten by a new process');
  } finally { await t.close(); }
});

test('tied criterion positions and decision timestamps preserve insertion order in the complete briefing', async () => {
  const t = await fixture({ rows: 4 }, { now: () => 1_000 });
  try {
    for (const text of ['criterion inserted first', 'criterion inserted second']) await t.owner.call('criteria.add', { cardId: t.card.id, text });
    t.core.db.prepare('UPDATE criteria SET position = 1 WHERE card_id = ?').run(t.card.id);
    for (const title of ['decision inserted first', 'decision inserted second']) await t.owner.call('decisions.add', { projectId: t.project.id, title });
    const session = await t.start(), token = await tokenOf(t.core, session.id);
    const text = JSON.parse(await relay(t.core, token, 'SessionStart', {})).hookSpecificOutput.additionalContext as string;
    assert.ok(text.indexOf('criterion inserted first') < text.indexOf('criterion inserted second'));
    assert.ok(text.indexOf('decision inserted first') < text.indexOf('decision inserted second'));
    assert.match(text, /criterion inserted first/); assert.match(text, /decision inserted first/);
  } finally { await t.close(); }
});
