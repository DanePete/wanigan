// Folders the agents have worked in, read from a fake home's Claude and Codex
// records: ranking, the 30-day window, open projects and missing folders left
// out, and the caps. Nothing here reads the real home.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeFolder, codexFolder } from './agent-folders.ts';
import { claudeSlug } from './history.ts';
import { testCore } from './test-support.ts';

const DAY = 86_400_000;
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

/** A file written as of `ago` milliseconds before now, by its modification time. */
function put(file: string, text: string, ago: number): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
  const at = (Date.now() - ago) / 1000;
  utimesSync(file, at, at);
}

/** A Claude transcript as Claude Code writes it: a snapshot line without a folder, then entries with `cwd`. */
function claude(config: string, cwd: string, ago: number, slugOf = cwd): void {
  const id = uuid();
  put(join(config, 'projects', claudeSlug(slugOf), `${id}.jsonl`), [
    JSON.stringify({ type: 'file-history-snapshot', messageId: 'm1', snapshot: { trackedFileBackups: {} } }),
    JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: 'Fix the build' }, uuid: 'u1', timestamp: new Date().toISOString(), userType: 'external', entrypoint: 'cli', cwd, sessionId: id, version: '2.1.292', gitBranch: 'main' }),
  ].join('\n') + '\n', ago);
}

/** A Codex rollout: the session meta first, then the conversation. */
function codex(home: string, cwd: string, ago: number, source: unknown = 'cli'): void {
  const day = new Date(Date.now() - ago);
  const folder = join(home, 'sessions', String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, '0'), String(day.getUTCDate()).padStart(2, '0'));
  put(join(folder, `rollout-${day.toISOString().slice(0, 19).replace(/:/g, '-')}-${uuid()}.jsonl`), [
    JSON.stringify({ timestamp: day.toISOString(), type: 'session_meta', payload: { id: uuid(), timestamp: day.toISOString(), cwd, originator: 'codex_cli_rs', cli_version: '0.155.1', source, model_provider: 'openai', base_instructions: { text: 'x'.repeat(30_000) } } }),
    JSON.stringify({ timestamp: day.toISOString(), type: 'event_msg', payload: { type: 'user_message', message: 'go' } }),
  ].join('\n') + '\n', ago);
}

test('folders the agents worked in are ranked by conversations in the last 30 days, then by how recent', async () => {
  const world = realpathSync(mkdtempSync(join(tmpdir(), 'wg-folders-')));
  const home = join(world, 'home');
  const work = join(home, '.claude_work');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, 'settings.json'), '{}\n');
  const folder = (name: string): string => { const p = join(world, 'code', name); mkdirSync(p, { recursive: true }); return p; };
  const storefront = folder('storefront');
  const api = folder('api');
  const docs = folder('docs');
  const old = folder('old-prototype');
  const unreadable = folder('long-first-prompt');
  mkdirSync(join(storefront, '.git'));
  symlinkSync(storefront, join(world, 'code', 'storefront-link'));

  // Storefront: three conversations in the default account, one more through a symlink to it.
  claude(join(home, '.claude'), storefront, 1 * DAY);
  claude(join(home, '.claude'), storefront, 5 * DAY);
  claude(join(home, '.claude'), storefront, 10 * DAY);
  claude(join(home, '.claude'), join(world, 'code', 'storefront-link'), 12 * DAY);
  // API: one Claude conversation in another account two hours ago, one Codex yesterday, a Codex subagent that is not the owner's.
  claude(work, api, 2 * 3600_000);
  codex(join(home, '.codex'), api, 1 * DAY);
  codex(join(home, '.codex'), api, 1 * DAY, { subagent: { thread_spawn: { parent_thread_id: 'p', depth: 1 } } });
  // Docs: two conversations, older than the API's.
  claude(join(home, '.claude'), docs, 20 * DAY);
  claude(join(home, '.claude'), docs, 25 * DAY);
  // Outside the window, gone, the home folder itself, and Wanigan's own worktrees: none of them are offered.
  claude(join(home, '.claude'), old, 40 * DAY);
  claude(join(home, '.claude'), join(world, 'code', 'deleted'), 2 * DAY);
  claude(join(home, '.claude'), home, 1 * DAY);

  const t = await testCore({
    accounts: { home, prober: async () => ({ signedIn: 'unknown', identity: null, plan: null }), usageReader: async () => ({ state: 'unreadable', windows: [], checkedAt: 0, note: 'test' }) },
    agentFolders: { freshMs: 0 },
  });
  try {
    const { owner } = t;
    const worktree = join(t.dir, 'data', 'worktrees', 'p1', 'ns-1');
    mkdirSync(worktree, { recursive: true });
    claude(join(home, '.claude'), worktree, 1 * DAY);
    // A transcript whose first entries are too long to name the folder in the first few KB: its siblings do.
    claude(join(home, '.claude'), unreadable, 3 * DAY);
    const id = uuid();
    put(join(home, '.claude', 'projects', claudeSlug(unreadable), `${id}.jsonl`),
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'p'.repeat(40_000) }, cwd: unreadable })}\n`, 4 * DAY);
    // An open project is not offered again.
    const site = await owner.call('projects.add', { path: t.projectDir });
    claude(join(home, '.claude'), site.path, 1 * DAY);
    codex(join(home, '.codex'), site.path, 1 * DAY);

    const result = await owner.call('projects.agentFolders', {});
    assert.equal(result.days, 30);
    assert.equal(result.cut, null, 'everything in the window was read');
    assert.deepEqual(result.folders.map((f) => [f.name, f.conversations]), [
      ['storefront', 4], ['api', 2], ['long-first-prompt', 2], ['docs', 2],
    ], 'most conversations first; equal counts by the newest');
    const [store, apiRow] = result.folders;
    assert.equal(store?.path, storefront, 'one folder however it was spelled');
    assert.equal(store?.git, true);
    assert.equal(apiRow?.git, false);
    assert.deepEqual(apiRow?.agents, ['claude', 'codex']);
    assert.ok(Math.abs((apiRow?.lastAt ?? 0) - (Date.now() - 2 * 3600_000)) < 5_000, 'last is the newest record');

    // Opening one takes it off the list.
    await owner.call('projects.add', { path: docs });
    assert.ok(!(await owner.call('projects.agentFolders', {})).folders.some((f) => f.path === docs));
  } finally {
    await t.close();
    rmSync(world, { recursive: true, force: true });
  }
});

test('the look is capped and says so when it is cut', async () => {
  const world = realpathSync(mkdtempSync(join(tmpdir(), 'wg-folders-')));
  const home = join(world, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  const names = ['one', 'two', 'three', 'four'];
  names.forEach((name, i) => {
    const p = join(world, name);
    mkdirSync(p);
    claude(join(home, '.claude'), p, (i + 1) * 3600_000);
  });
  const accounts = { home, prober: async () => ({ signedIn: 'unknown' as const, identity: null, plan: null }), usageReader: async () => ({ state: 'unreadable' as const, windows: [], checkedAt: 0, note: 'test' }) };
  const reads = await testCore({ accounts, agentFolders: { maxReads: 2, freshMs: 0 } });
  try {
    const result = await reads.owner.call('projects.agentFolders', {});
    assert.deepEqual(result.folders.map((f) => f.name), ['one', 'two'], 'the newest are the ones read');
    assert.match(result.cut ?? '', /Counted the newest 2 conversations of the last 30 days/);
  } finally {
    await reads.close();
  }
  const files = await testCore({ accounts, agentFolders: { maxFiles: 3, freshMs: 0 } });
  try {
    const result = await files.owner.call('projects.agentFolders', {});
    assert.equal(result.folders.length, 3);
    assert.match(result.cut ?? '', /Looked at 3 records and stopped/);
  } finally {
    await files.close();
    rmSync(world, { recursive: true, force: true });
  }
});

test('a record names its folder in its first few KB, or not at all', () => {
  assert.equal(claudeFolder('{"type":"file-history-snapshot"}\n{"type":"user","cwd":"/Users/a/site","sessionId":"x"}'), '/Users/a/site');
  assert.equal(claudeFolder('{"type":"user","message":{"content":"ppp'), null, 'cut before the folder');
  assert.equal(claudeFolder('{"cwd":"relative/path"}'), null);
  assert.equal(claudeFolder('{"cwd":"/a/\\"quoted\\" b"}'), '/a/"quoted" b');
  const meta = (payload: object): string => JSON.stringify({ timestamp: 't', type: 'session_meta', payload });
  assert.equal(codexFolder(`${meta({ id: 'i', cwd: '/w/api', source: 'cli' })}\n`), '/w/api');
  assert.equal(codexFolder(`${meta({ id: 'i', cwd: '/w/api', source: { subagent: 'review' } })}\n`), null);
  assert.equal(codexFolder(`${JSON.stringify({ type: 'event_msg', payload: { cwd: '/w' } })}\n`), null, 'only the session meta says where');
  const long = meta({ id: 'i', timestamp: 't', cwd: '/w/long', base_instructions: 'x'.repeat(20_000) }).slice(0, 16_384);
  assert.equal(codexFolder(long), '/w/long', 'a meta line longer than what was read still names its folder');
});
