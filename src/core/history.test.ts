// History against fixture account folders in a temporary home: Claude
// transcripts (a title, a fork, a worktree, other projects' files), a Codex
// state database with the owner's, imported and subagent threads, and a
// Wanigan 1 database. Nothing here reads the real home, real accounts or
// Wanigan 1's real database.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { HistoryItem } from '../shared/model.ts';
import { claudeSlug } from './history.ts';
import { readForeignDb } from './readonly-db.ts';
import { testCore, waitFor, type TestCore } from './test-support.ts';

type Db = { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): unknown }; pragma(p: string): unknown; close(): void };
const Database = createRequire(import.meta.url)('better-sqlite3') as new (file: string) => Db;

const A = '11111111-1111-4111-8111-111111111111'; // today, default account, renamed in Wanigan 1
const B = '22222222-2222-4222-8222-222222222222'; // the parent of a fork
const C = '33333333-3333-4333-8333-333333333333'; // its fork, in the work account, continued later
const D = '44444444-4444-4444-8444-444444444444'; // another project's
const E = '55555555-5555-4555-8555-555555555555'; // filed under this folder's name, but ran somewhere else
const F = '66666666-6666-4666-8666-666666666666'; // in a card's worktree
const G = '77777777-7777-4777-8777-777777777777'; // nothing typed: not a conversation
const H = '88888888-8888-4888-8888-888888888888'; // too long to read whole
const T1 = '01a0aaaa-0000-7000-8000-000000000001'; // the owner's Codex thread
const T2 = '01a0aaaa-0000-7000-8000-000000000002'; // imported from Claude by Codex Desktop
const T3 = '01a0aaaa-0000-7000-8000-000000000003'; // a subagent
const T4 = '01a0aaaa-0000-7000-8000-000000000004'; // another project's

function jsonl(file: string, lines: object[]): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

/** One Claude Code transcript line, in the CLI's envelope. */
function cl(sessionId: string, cwd: string, branch: string, entrypoint = 'cli') {
  return {
    user: (uuid: string, at: string, content: unknown, extra: object = {}) =>
      ({ type: 'user', uuid, parentUuid: null, isSidechain: false, message: { role: 'user', content }, timestamp: at, cwd, sessionId, gitBranch: branch, entrypoint, ...extra }),
    assistant: (uuid: string, at: string, content: object[]) =>
      ({ type: 'assistant', uuid, isSidechain: false, message: { model: 'claude-opus-5', role: 'assistant', content }, timestamp: at, cwd, sessionId, gitBranch: branch, entrypoint }),
    title: (aiTitle: string) => ({ type: 'ai-title', aiTitle, sessionId }),
  };
}

describe('history', () => {
  let fx: string;
  let home: string;
  let site: string;
  let elsewhere: string;
  let worktree: string;
  let t: TestCore;
  let projectId: string;
  let accounts: { id: string; label: string; provider: string; configDir: string | null }[];
  const list = async (query?: string): Promise<HistoryItem[]> => t.owner.call('history.list', { projectId, ...(query ? { query } : {}) });
  const args = (sessionId: string) => waitFor('launch line', () => t.core.sessions.replay(sessionId).replay.match(/(?:TOKEN|codex ready).*/)?.[0].trim());

  before(async () => {
    fx = realpathSync(mkdtempSync(join(tmpdir(), 'wg-history-')));
    home = join(fx, 'home');
    site = join(fx, 'site');
    elsewhere = join(fx, 'elsewhere');
    for (const d of [site, elsewhere, join(home, '.claude'), join(home, '.codex')]) mkdirSync(d, { recursive: true });
    mkdirSync(join(home, '.claude_work'));
    writeFileSync(join(home, '.claude_work', 'settings.json'), '{}');
    mkdirSync(join(home, '.codex_personal'));
    writeFileSync(join(home, '.codex_personal', 'config.toml'), '');

    // Wanigan 1: a hand rename and a note for A, and an external row that is ignored.
    const w1File = join(fx, 'wanigan1.db');
    const w1 = new Database(w1File);
    w1.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, branch TEXT, added_at INTEGER NOT NULL);
      CREATE TABLE session_log (id TEXT PRIMARY KEY, conversation_id TEXT, provider_id TEXT, project_id TEXT, title TEXT, initial_prompt TEXT,
        description TEXT, origin TEXT, started_at INTEGER);`);
    w1.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)').run('p1', site, 'site', 'main', 1);
    const row = w1.prepare('INSERT INTO session_log VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    row.run('s1', A, 'claude', 'p1', 'The pay button has no label', 'The pay button has no label', null, 'wanigan', 1);
    row.run('s2', A.toUpperCase(), 'claude', 'p1', 'Accessible pay button', 'The pay button has no label', 'Gave the pay button a name', 'wanigan', 2);
    row.run('s3', F, 'claude', 'p1', 'Not the owner’s', null, null, 'external', 3);
    w1.close();

    t = await testCore({
      ...{ wanigan1Db: w1File }, // A retired option from an old caller must have no effect.
      accounts: {
        home,
        prober: async () => ({ signedIn: 'unknown', identity: null, plan: null }),
        usageReader: async () => ({ state: 'unreadable', windows: [], checkedAt: 0, note: 'test' }),
      },
    });
    projectId = (await t.owner.call('projects.add', { path: site, key: 'NS' })).id;
    accounts = await t.owner.call('accounts.list', {});
    worktree = join(t.core.paths.dataDir, 'worktrees', projectId, 'NS-1');
    mkdirSync(worktree, { recursive: true });

    const slug = (p: string) => join(home, '.claude', 'projects', claudeSlug(p));
    const a = cl(A, site, 'main');
    jsonl(join(slug(site), `${A}.jsonl`), [
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-06T15:00:00.000Z', sessionId: A },
      a.user('a0', '2026-10-06T15:00:00.100Z', '<system-reminder>Injected context</system-reminder>', { isMeta: true }),
      a.user('a1', '2026-10-06T15:00:01.000Z', [{ type: 'text', text: 'The pay button has no label' }]),
      a.title('Pay button'),
      a.assistant('a2', '2026-10-06T15:00:05.000Z', [{ type: 'text', text: 'Looking at the checkout form.' }]),
      a.assistant('a3', '2026-10-06T15:00:06.000Z', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }]),
      a.user('a4', '2026-10-06T15:00:09.000Z', [{ type: 'tool_result', tool_use_id: 't1', content: 'SECRET-TOKEN-123 all passed' }], { toolUseResult: { stdout: 'SECRET-TOKEN-123' } }),
      { ...cl(A, site, 'fix/pay-label').assistant('a5', '2026-10-06T15:30:00.000Z', [{ type: 'text', text: 'Added an accessible name.' }]) },
      a.title('Label the pay button'),
    ]);

    const b = cl(B, site, 'main', 'claude-vscode');
    const parent = [
      b.user('b1', '2026-10-03T10:00:00.000Z', 'Speed up the search index'),
      b.assistant('b2', '2026-10-03T10:00:05.000Z', [{ type: 'text', text: 'The index rebuilds on every request.' }]),
    ];
    jsonl(join(slug(site), `${B}.jsonl`), parent);
    // The fork: the same lines under a new id in the work account, then more.
    jsonl(join(home, '.claude_work', 'projects', claudeSlug(site), `${C}.jsonl`), [
      ...parent.map((l) => ({ ...l, sessionId: C })),
      cl(C, site, 'main', 'claude-vscode').assistant('c3', '2026-10-04T10:00:00.000Z', [{ type: 'text', text: 'Cached it.' }]),
    ]);

    jsonl(join(slug(elsewhere), `${D}.jsonl`), [cl(D, elsewhere, 'main').user('d1', '2026-10-06T16:00:00.000Z', 'Not this project')]);
    jsonl(join(slug(site), `${E}.jsonl`), [cl(E, '/somewhere/else', 'main').user('e1', '2026-10-06T16:00:00.000Z', 'Same folder name, other folder')]);
    const f = cl(F, worktree, 'wanigan/ns-1');
    jsonl(join(slug(worktree), `${F}.jsonl`), [
      f.user('f1', '2026-10-06T12:00:00.000Z', 'Build the order history page'),
      f.title('First title'),
      f.title('Order history page'),
    ]);
    jsonl(join(slug(site), `${G}.jsonl`), [{ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-06T17:00:00.000Z', sessionId: G }]);
    const h = cl(H, elsewhere, 'main');
    jsonl(join(slug(elsewhere), `${H}.jsonl`), Array.from({ length: 80 }, (_, i) =>
      h.assistant(`h${i}`, `2026-10-01T10:${String(i % 60).padStart(2, '0')}:00.000Z`, [{ type: 'text', text: `turn ${i} ${'x'.repeat(8000)}` }])));

    // Codex: the owner's thread, an import of a Claude transcript, a subagent, and another project's.
    const rollout = join(home, '.codex', 'sessions', '2026', '10', '05', `rollout-2026-10-05T17-00-00-${T1}.jsonl`);
    jsonl(rollout, [
      { timestamp: '2026-10-05T17:00:00.000Z', type: 'session_meta', payload: { id: T1, cwd: site, thread_source: 'user', source: 'cli' } },
      { timestamp: '2026-10-05T17:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
      { timestamp: '2026-10-05T17:00:02.000Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'Add rate limit headers to the API' }] } } },
      { timestamp: '2026-10-05T17:00:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'rg -n RateLimit src' } },
      { timestamp: '2026-10-05T17:00:04.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'SECRET-TOKEN-123' } },
      { timestamp: '2026-10-05T18:00:00.000Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'text', text: 'Added X-RateLimit-Remaining.' }] } } },
    ]);
    const state = new Database(join(home, '.codex', 'state_5.sqlite'));
    state.pragma('journal_mode = WAL');
    state.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, cwd TEXT, title TEXT,
      first_user_message TEXT, git_branch TEXT, model TEXT, thread_source TEXT, name TEXT, archived INTEGER DEFAULT 0, created_at_ms INTEGER,
      updated_at_ms INTEGER, originator TEXT)`);
    const thread = state.prepare('INSERT INTO threads (id, rollout_path, source, cwd, title, first_user_message, git_branch, model, thread_source, name, created_at_ms, updated_at_ms, originator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const ms = (iso: string) => Date.parse(iso);
    thread.run(T1, rollout, 'cli', site, 'Rate limit headers', 'Add rate limit headers to the API', 'main', 'gpt-6', 'user', 'Rate limit headers', ms('2026-10-05T17:00:00Z'), ms('2026-10-05T18:00:00Z'), 'codex-tui');
    thread.run(T2, null, 'vscode', site, 'Imported session', 'The pay button has no label', 'main', null, null, null, ms('2026-10-06T15:00:00Z'), ms('2026-10-06T15:30:00Z'), 'Codex Desktop');
    thread.run(T3, null, '{"subagent":{}}', site, 'Explore', 'Look around', 'main', 'gpt-6', 'subagent', null, ms('2026-10-05T17:10:00Z'), ms('2026-10-05T17:20:00Z'), 'codex-tui');
    thread.run(T4, null, 'cli', elsewhere, 'Other', 'Other project', 'main', 'gpt-6', 'user', null, ms('2026-10-06T09:00:00Z'), ms('2026-10-06T09:30:00Z'), 'codex-tui');
    state.close();
  });

  after(async () => {
    await t?.close();
    rmSync(fx, { recursive: true, force: true });
  });

  test('lists every conversation in the folder and its worktrees, newest first, once each', async () => {
    const items = await list();
    assert.deepEqual(items.map((i) => i.id), [`claude:${A}`, `claude:${F}`, `codex:${T1}`, `claude:${C}`],
      'not another project’s, not one filed here that ran elsewhere, not an empty one, not imports or subagents, and a fork once');
    const [a, f, t1, c] = items as [HistoryItem, HistoryItem, HistoryItem, HistoryItem];
    assert.equal(a.title, 'Label the pay button', 'only the CLI transcript supplies the title');
    assert.equal(a.description, null, 'legacy notes are not imported');
    assert.equal(a.firstPrompt, 'The pay button has no label', 'injected context is not the first prompt');
    assert.equal(a.branch, 'fix/pay-label', 'the branch it ended on');
    assert.equal(a.model, 'claude-opus-5');
    assert.deepEqual([a.accountLabel, a.sources, a.sessionId, a.live], ['Default', ['claude'], null, false]);
    assert.equal(a.startedAt, Date.parse('2026-10-06T15:00:00.000Z'), 'its first line');
    assert.equal(a.updatedAt, Date.parse('2026-10-06T15:30:00.000Z'));
    assert.equal(f.title, 'Order history page', 'the last ai-title is the title');
    assert.equal(f.cardKey, 'NS-1');
    assert.deepEqual(f.sources, ['claude'], 'an external Wanigan 1 row is not the owner’s');
    assert.deepEqual([t1.provider, t1.title, t1.firstPrompt, t1.branch, t1.accountLabel], ['codex', 'Rate limit headers', 'Add rate limit headers to the API', 'main', 'Default']);
    assert.deepEqual([c.accountLabel, c.via, c.firstPrompt], ['work', 'VS Code', 'Speed up the search index'], 'the newest copy of a fork, where it lives');
    assert.equal(existsSync(join(home, '.codex', 'state_5.sqlite-wal')) || existsSync(join(home, '.codex', 'state_5.sqlite-shm')), false,
      'reading Codex’s database wrote nothing into its home');
  });

  test('search matches the title, the first prompt and the branch', async () => {
    assert.deepEqual((await list('PAY button')).map((i) => i.conversationId), [A]);
    assert.deepEqual((await list('search index')).map((i) => i.conversationId), [C]);
    assert.deepEqual((await list('wanigan/ns')).map((i) => i.conversationId), [F]);
    assert.deepEqual(await list('nothing like this'), []);
  });

  test('reads text turns and one-line tool calls, never tool results', async () => {
    const a = await t.owner.call('history.read', { id: `claude:${A}` });
    assert.deepEqual(a.turns.map((x) => [x.role, x.text]), [
      ['user', 'The pay button has no label'],
      ['assistant', 'Looking at the checkout form.'],
      ['tool', 'Bash npm test'],
      ['assistant', 'Added an accessible name.'],
    ]);
    assert.equal(a.truncated, false);
    const codex = await t.owner.call('history.read', { id: `codex:${T1}` });
    assert.deepEqual(codex.turns.map((x) => [x.role, x.text]), [
      ['user', 'Add rate limit headers to the API'], ['tool', 'exec rg -n RateLimit src'], ['assistant', 'Added X-RateLimit-Remaining.'],
    ]);
    assert.ok(!JSON.stringify([a, codex]).includes('SECRET'), 'what tools returned is never read out');

    const long = await t.owner.call('history.read', { id: `claude:${H}` });
    assert.equal(long.truncated, true);
    assert.equal(long.turns.at(-1)?.text.startsWith('turn 79 '), true, 'the newest turn is kept');
    assert.ok(long.turns.length < 80 && long.turns.reduce((n, x) => n + x.text.length, 0) < 320_000, 'and the transcript is bounded');
    await assert.rejects(t.owner.call('history.read', { id: 'claude:../../etc/passwd' }), /not a conversation/);
    await assert.rejects(t.owner.call('history.read', { id: `claude:${'9'.repeat(8)}-9999-4999-8999-999999999999` }), /can’t find/);
  });

  test('resumes in its own account by id, and as another account by forking the transcript', async () => {
    const work = accounts.find((x) => x.label === 'work')!;
    const same = await t.owner.call('history.resume', { id: `claude:${A}` });
    assert.equal(same.conversationId, A);
    assert.equal(same.cwd, site);
    const sameLine = await args(same.id);
    assert.match(sameLine, new RegExp(`CFG=unset ARGS=.*--resume ${A}$`), 'the default account sets no CLAUDE_CONFIG_DIR');
    const linked = (await list()).find((i) => i.conversationId === A)!;
    assert.deepEqual([linked.sessionId, linked.live, linked.sources.includes('wanigan2')], [same.id, true, true]);
    await assert.rejects(t.owner.call('history.resume', { id: `claude:${A}` }), /already running/);
    await t.owner.call('sessions.stop', { id: same.id });
    await waitFor('stopped', async () => !(await list()).find((i) => i.conversationId === A)?.live);

    const fork = await t.owner.call('history.resume', { id: `claude:${A}`, accountId: work.id });
    const forkLine = await args(fork.id);
    const file = join(home, '.claude', 'projects', claudeSlug(site), `${A}.jsonl`);
    assert.match(forkLine, new RegExp(`CFG=${work.configDir} ARGS=.*--resume ${file} --fork-session --session-id ${fork.conversationId}$`));
    assert.notEqual(fork.conversationId, A, 'a fork has an id of its own');
    await t.owner.call('sessions.stop', { id: fork.id });

    const inWork = await t.owner.call('history.resume', { id: `claude:${C}` });
    assert.match(await args(inWork.id), new RegExp(`CFG=${work.configDir} ARGS=.*--resume ${C}$`), 'a conversation in another account resumes there');
    await t.owner.call('sessions.stop', { id: inWork.id });

    const branch = await t.owner.call('history.resume', { id: `claude:${F}` });
    assert.equal(branch.cwd, worktree, 'in the worktree it ran in');
    await t.owner.call('sessions.stop', { id: branch.id });
  });

  test('a Codex thread resumes only in its own home', async () => {
    const session = await t.owner.call('history.resume', { id: `codex:${T1}` });
    assert.equal(session.conversationId, T1);
    assert.match(await args(session.id), /^codex ready HOME=unset ARGS=resume --config /, 'the default home sets no CODEX_HOME');
    // The briefing's line breaks are echoed as real ones, so the thread id ends a later line.
    await waitFor('thread id last', () => new RegExp(` ${T1}\\r?\\n`).test(t.core.sessions.replay(session.id).replay));
    await t.owner.call('sessions.stop', { id: session.id });
    const personal = accounts.find((x) => x.provider === 'codex' && x.label === 'personal')!;
    await assert.rejects(t.owner.call('history.resume', { id: `codex:${T1}`, accountId: personal.id }), /only in the account it lives in/);
  });

  test('a paused project starts nothing', async () => {
    await t.owner.call('projects.pause', { id: projectId });
    try {
      await assert.rejects(t.owner.call('history.resume', { id: `claude:${A}` }), /paused/);
    } finally {
      await t.owner.call('projects.resume', { id: projectId });
    }
  });
});

describe('reading another program’s database', () => {
  test('writes nothing beside it, and sees rows its writer has not checkpointed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wg-ro-'));
    const file = join(dir, 'state.sqlite');
    const writer = new Database(file);
    writer.pragma('journal_mode = WAL');
    writer.exec('CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1)');
    writer.close();
    const count = () => readForeignDb(file, (db) => (db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n);
    assert.equal(count(), 1);
    assert.deepEqual(readdirSync(dir), ['state.sqlite'], 'no -wal or -shm was made');

    const live = new Database(file);
    live.pragma('wal_autocheckpoint = 0');
    live.exec('INSERT INTO t VALUES (2)');
    const shm = () => { const s = statSync(`${file}-shm`); return `${s.size}:${s.mtimeMs}:${readFileSync(`${file}-shm`).toString('base64')}`; };
    const before = shm();
    assert.equal(count(), 2, 'what the writer has not checkpointed is read too');
    assert.equal(shm(), before, 'and the writer’s -shm is left exactly as it was');
    live.close();
    assert.equal(readForeignDb(join(dir, 'missing.sqlite'), () => 1), null);
    rmSync(dir, { recursive: true, force: true });
  });
});
