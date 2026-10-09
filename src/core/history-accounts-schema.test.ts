// Account identity and unsupported-index outcomes through the real core. Only
// explicitly configured temporary roots and stand-in account probes are used.
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import type { AccountProvider, HistoryItem } from '../shared/model.ts';
import { CoreError } from '../shared/protocol.ts';
import { claudeSlug } from './history.ts';
import { testCore } from './test-support.ts';

const ID = '11111111-1111-4111-8111-111111111111';
const columns = ['id', 'cwd', 'thread_source', 'rollout_path', 'first_user_message'] as const;

function jsonl(file: string, value: object): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(value) + '\n');
}

/** Include source names/modes/mtime and exact bytes, so creating SQLite sidecars
 * or editing either account is observable as well as changing a transcript. */
function sourceSnapshot(root: string): Record<string, { mode: number; mtime: number; bytes: Buffer | null }> {
  const out: Record<string, { mode: number; mtime: number; bytes: Buffer | null }> = {};
  const visit = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(folder, entry.name);
      const stat = statSync(file);
      out[relative(root, file)] = { mode: stat.mode, mtime: stat.mtimeMs, bytes: entry.isFile() ? readFileSync(file) : null };
      if (entry.isDirectory()) visit(file);
    }
  };
  visit(root);
  return out;
}

function codexRow(file: string, cwd: string, rollout: string, marker: string): void {
  const db = new Database(file);
  try {
    db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, thread_source TEXT, rollout_path TEXT, first_user_message TEXT)');
    db.prepare('INSERT INTO threads VALUES (?,?,?,?,?)').run(ID, cwd, 'user', rollout, marker);
  } finally { db.close(); }
}

async function duplicateFixture(provider: AccountProvider) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wg-history-accounts-')));
  const home = join(root, 'home');
  const roots = [join(home, `.${provider}`), join(home, `.${provider}_work`)];
  const projects = [join(root, 'site-a'), join(root, 'site-b')];
  const markers = [`${provider}-default-source`, `${provider}-work-source`];
  for (let i = 0; i < roots.length; i++) {
    mkdirSync(roots[i]!, { recursive: true });
    mkdirSync(projects[i]!, { recursive: true });
    // These are the actual discovery markers used by Accounts.discover.
    writeFileSync(join(roots[i]!, provider === 'claude' ? 'settings.json' : 'config.toml'), provider === 'claude' ? '{}' : '');
    if (provider === 'claude') {
      jsonl(join(roots[i]!, 'projects', claudeSlug(projects[i]!), `${ID}.jsonl`), {
        type: 'user', uuid: `lineage-${i}`, sessionId: ID, cwd: projects[i], timestamp: `2026-10-0${i + 1}T00:00:00Z`,
        message: { content: markers[i] },
      });
    } else {
      const rollout = join(roots[i]!, 'sessions', `rollout-${ID}.jsonl`);
      jsonl(rollout, { type: 'event_msg', payload: { type: 'item_completed', item: {
        type: 'UserMessage', content: [{ type: 'text', text: markers[i] }],
      } } });
      codexRow(join(roots[i]!, 'state_5.sqlite'), projects[i]!, rollout, markers[i]!);
    }
  }
  const before = sourceSnapshot(home);
  const t = await testCore({ accounts: { home } });
  try {
    const projectIds: string[] = [];
    for (let i = 0; i < projects.length; i++) projectIds.push((await t.owner.call('projects.add', { path: projects[i]!, key: i ? 'BB' : 'AA' })).id);
    const accounts = (await t.owner.call('accounts.list', {})).filter((account) => account.provider === provider);
    assert.equal(accounts.length, 2, 'both fixture accounts must actually be registered');
    assert.deepEqual(accounts.map((account) => t.core.accounts.folderOf(account)).sort(), [...roots].sort());
    assert.notEqual(accounts[0]!.id, accounts[1]!.id);
    const selected: HistoryItem[] = [];
    for (let i = 0; i < projects.length; i++) {
      const account = accounts.find((candidate) => t.core.accounts.folderOf(candidate) === roots[i]);
      assert.ok(account);
      const listed: HistoryItem[] = await t.owner.call('history.list', { projectId: projectIds[i]! });
      assert.equal(listed.length, 1, 'each account copy must be independently selected by its own project listing');
      assert.equal(listed[0]!.id, `${provider}:${ID}`);
      assert.equal(listed[0]!.accountId, account.id);
      assert.equal(listed[0]!.cwd, projects[i]);
      assert.equal(listed[0]!.firstPrompt, markers[i]);
      selected.push(listed[0]!);
    }
    assert.deepEqual(sourceSnapshot(home), before, 'registration and listing do not alter either source');
    return { ...t, home, before, selected, async close() { await t.close(); rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { await t.close(); rmSync(root, { recursive: true, force: true }); throw error; }
}

for (const provider of ['claude', 'codex'] as const) {
  for (const operation of ['history.read', 'history.resume'] as const) {
    test(`${operation} refuses a duplicate UUID across registered ${provider} accounts without touching sources or launching`, async (context) => {
      const t = await duplicateFixture(provider);
      try {
        assert.deepEqual(await t.owner.call('sessions.list', {}), []);
        const result = await t.owner.call(operation, { id: t.selected[0]!.id }).then(
          (value) => ({ kind: 'answered' as const, value }),
          (error: unknown) => ({ kind: 'refused' as const, error }),
        );
        const sessions = await t.owner.call('sessions.list', {});
        context.diagnostic(`${provider} ${operation}: ${result.kind}; recorded sessions ${sessions.length}`);
        assert.equal(result.kind, 'refused', 'account identity must never be guessed from the duplicate UUID');
        assert.ok(result.kind === 'refused' && result.error instanceof CoreError);
        assert.equal(result.error.code, 'refused');
        assert.match(result.error.message, /more than one account|ambiguous/i);
        assert.deepEqual(sessions, [], 'neither project gets a session');
        assert.deepEqual(sourceSnapshot(t.home), t.before, 'all source JSONL, DB and marker bytes remain exact with no new sidecars');
      } finally { await t.close(); }
    });
  }
}

for (const missing of ['id', 'cwd', 'thread_source', 'threads table'] as const) {
  test(`a valid SQLite index without ${missing} reports its schema error and recovers after fixture repair`, async (context) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wg-history-schema-')));
    const home = join(root, 'home');
    const accountRoot = join(home, '.codex');
    const site = join(root, 'site');
    mkdirSync(accountRoot, { recursive: true }); mkdirSync(site);
    writeFileSync(join(accountRoot, 'config.toml'), '');
    const rollout = join(accountRoot, 'sessions', `rollout-${ID}.jsonl`);
    jsonl(rollout, { type: 'event_msg', payload: { type: 'item_completed', item: {
      type: 'UserMessage', content: [{ type: 'text', text: 'schema-repair-source' }],
    } } });
    const file = join(accountRoot, 'state_5.sqlite');
    const fields = columns.filter((column) => column !== missing);
    const writer = new Database(file);
    try {
      const table = missing === 'threads table' ? 'other_threads' : 'threads';
      writer.exec(`CREATE TABLE ${table} (${fields.map((column) => `${column} TEXT`).join(',')});
        CREATE TABLE fixture_metadata (marker TEXT); INSERT INTO fixture_metadata VALUES ('valid-sqlite-not-corruption');`);
      const values = { id: ID, cwd: site, thread_source: 'user', rollout_path: rollout, first_user_message: 'schema-repair-source' };
      writer.prepare(`INSERT INTO ${table} VALUES (${fields.map(() => '?').join(',')})`).run(...fields.map((field) => values[field]));
      assert.equal(writer.pragma('integrity_check', { simple: true }), 'ok');
    } finally { writer.close(); }
    let revision = 0;
    const restamp = (): void => { const at = new Date(Date.UTC(2026, 9, 1, 0, 0, ++revision)); utimesSync(file, at, at); };
    restamp();
    const t = await testCore({ accounts: { home } });
    try {
      const project = await t.owner.call('projects.add', { path: site });
      const accounts = (await t.owner.call('accounts.list', {})).filter((account) => account.provider === 'codex');
      assert.equal(accounts.length, 1);
      assert.equal(t.core.accounts.folderOf(accounts[0]!), accountRoot);
      const original = sourceSnapshot(home);
      const refused = (error: unknown): boolean => {
        assert.ok(error instanceof CoreError);
        assert.equal(error.code, 'refused');
        assert.match(error.message, /history index.*(read|unsupported)/i);
        return true;
      };
      // Repetition also proves the first failure is not cached as an empty list.
      for (let i = 0; i < 2; i++) await assert.rejects(t.owner.call('history.list', { projectId: project.id }), refused);
      await assert.rejects(t.owner.call('history.read', { id: `codex:${ID}` }), refused);
      await assert.rejects(t.owner.call('history.resume', { id: `codex:${ID}` }), refused);
      assert.deepEqual(await t.owner.call('sessions.list', {}), []);
      assert.deepEqual(sourceSnapshot(home), original, 'schema errors preserve all foreign bytes and create no sidecars');

      // Simulate the fixture provider repairing its own index. A new mtime makes
      // cache invalidation explicit without relying on filesystem clock precision.
      const repair = new Database(file);
      try {
        repair.exec('DROP TABLE IF EXISTS threads; CREATE TABLE threads (id TEXT, cwd TEXT, thread_source TEXT, rollout_path TEXT, first_user_message TEXT)');
        assert.equal(repair.prepare('SELECT marker FROM fixture_metadata').pluck().get(), 'valid-sqlite-not-corruption');
      } finally { repair.close(); }
      restamp();
      const empty = sourceSnapshot(home);
      assert.deepEqual(await t.owner.call('history.list', { projectId: project.id }), [], 'a supported empty index is honestly empty');
      await assert.rejects(t.owner.call('history.read', { id: `codex:${ID}` }), (error: unknown) => error instanceof CoreError && error.code === 'not_found');
      assert.deepEqual(sourceSnapshot(home), empty);

      const populate = new Database(file);
      try { populate.prepare('INSERT INTO threads VALUES (?,?,?,?,?)').run(ID, site, 'user', rollout, 'schema-repair-source'); }
      finally { populate.close(); }
      restamp();
      const populated = sourceSnapshot(home);
      const listed = await t.owner.call('history.list', { projectId: project.id });
      assert.equal(listed.length, 1);
      assert.equal(listed[0]!.id, `codex:${ID}`);
      assert.equal(listed[0]!.accountId, accounts[0]!.id);
      const read = await t.owner.call('history.read', { id: listed[0]!.id });
      assert.deepEqual(read.turns.map((turn) => turn.text), ['schema-repair-source']);
      assert.deepEqual(await t.owner.call('sessions.list', {}), []);
      assert.deepEqual(sourceSnapshot(home), populated, 'successful recovery is read-only too');
      context.diagnostic(`missing ${missing}: explicit refusal, then supported empty, then populated read on the same core`);
    } finally { await t.close(); rmSync(root, { recursive: true, force: true }); }
  });
}
