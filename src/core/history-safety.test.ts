// History refuses ambiguous, escaping and unreadable records from fixture accounts.
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { chmodSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { testCore } from './test-support.ts';
import { claudeSlug } from './history.ts';

const ID = '11111111-1111-4111-8111-111111111111';

function claude(home: string, cwd: string, id: string, when: string, prompt: string, extra: object[] = []): void {
  const folder = join(home, '.claude', 'projects', claudeSlug(cwd));
  mkdirSync(folder, { recursive: true });
  const lines = [{ type: 'user', uuid: prompt, cwd, timestamp: when, message: { content: prompt } }, ...extra];
  writeFileSync(join(folder, `${id}.jsonl`), lines.map(line => JSON.stringify(line)).join('\n') + '\n');
}

function state(home: string): Database.Database {
  const dir = join(home, '.codex');
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, 'state_5.sqlite'));
  db.exec(`CREATE TABLE threads (id TEXT, cwd TEXT, thread_source TEXT, rollout_path TEXT,
    first_user_message TEXT, created_at_ms INTEGER, updated_at_ms INTEGER)`);
  return db;
}

test('ambiguous conversation copies cannot redirect a History read or resume', async () => {
  const t = await testCore();
  try {
    const home = join(t.dir, 'home');
    const project = await t.owner.call('projects.add', { path: t.projectDir, key: 'AA' });
    const elsewhere = join(t.dir, 'other');
    mkdirSync(elsewhere);
    await t.owner.call('projects.add', { path: elsewhere, key: 'BB' });
    claude(home, t.projectDir, ID, '2026-10-06T00:00:00Z', 'Selected project');
    claude(home, elsewhere, ID, '2026-10-07T00:00:00Z', 'Other project');
    const listed = await t.owner.call('history.list', { projectId: project.id });
    assert.equal(listed[0]?.cwd, t.projectDir);
    await assert.rejects(t.owner.call('history.read', { id: listed[0]!.id }), /more than one|ambiguous/i);
    await assert.rejects(t.owner.call('history.resume', { id: listed[0]!.id }), /more than one|ambiguous/i);
    assert.deepEqual(await t.owner.call('sessions.list', {}), [], 'no session starts in either project');
  } finally { await t.close(); }
});

test('an existing corrupt Codex index reports failure instead of an empty History', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const dir = join(t.dir, 'home', '.codex');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state_5.sqlite'), 'not a database');
    await assert.rejects(t.owner.call('history.list', { projectId: project.id }), /index|database/i);
  } finally { await t.close(); }
});

test('an inaccessible Codex index reports failure instead of hiding its conversations', async () => {
  const t = await testCore();
  const dir = join(t.dir, 'home', '.codex');
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    state(join(t.dir, 'home')).close();
    chmodSync(dir, 0);
    await assert.rejects(t.owner.call('history.list', { projectId: project.id }), /index|database/i);
    chmodSync(dir, 0o700);
    assert.deepEqual(await t.owner.call('history.list', { projectId: project.id }), [], 'a readable empty index really is empty');
  } finally { chmodSync(dir, 0o700); await t.close(); }
});

test('History refuses Codex rollouts outside the account through traversal or links', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const home = join(t.dir, 'home');
    const dir = join(home, '.codex');
    const db = state(home);
    const outside = join(home, 'outside.jsonl');
    writeFileSync(outside, JSON.stringify({ type: 'event_msg', payload: {
      type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'text', text: 'outside-account-marker' }] },
    } }) + '\n');
    const link = join(dir, 'linked.jsonl');
    symlinkSync(outside, link);
    const paths = [`${dir}/../outside.jsonl`, link];
    const ids = [ID, '22222222-2222-4222-8222-222222222222'];
    try {
      for (let i = 0; i < paths.length; i++) {
        db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?)').run(ids[i], t.projectDir, 'user', paths[i], 'Read me', 1, 1);
      }
    } finally { db.close(); }
    const items = await t.owner.call('history.list', { projectId: project.id });
    assert.equal(items.length, 2);
    for (const id of ids) await assert.rejects(t.owner.call('history.read', { id: `codex:${id}` }), /gone|outside|record/i);
  } finally { await t.close(); }
});

test('a multi-block transcript line stays within the preview character budget', async () => {
  const t = await testCore();
  try {
    await t.owner.call('projects.add', { path: t.projectDir });
    const content = Array.from({ length: 2000 }, () => ({ type: 'text', text: 'x'.repeat(500) }));
    claude(join(t.dir, 'home'), t.projectDir, ID, '2026-10-06T00:00:00Z', 'Read this', [
      { type: 'assistant', message: { model: 'fake', content } },
    ]);
    const got = await t.owner.call('history.read', { id: `claude:${ID}` });
    const chars = got.turns.reduce((sum, turn) => sum + turn.text.length, 0);
    assert.ok(chars <= 300_000);
    assert.ok(chars > 0);
    assert.equal(got.truncated, true);
  } finally { await t.close(); }
});

test('many short transcript blocks keep only the newest 2000 turns', async () => {
  const t = await testCore();
  try {
    await t.owner.call('projects.add', { path: t.projectDir });
    const content = Array.from({ length: 8000 }, (_, i) => ({ type: 'text', text: `turn ${i}` }));
    claude(join(t.dir, 'home'), t.projectDir, ID, '2026-10-06T00:00:00Z', 'Read this', [
      { type: 'assistant', message: { model: 'fake', content } },
    ]);
    const got = await t.owner.call('history.read', { id: `claude:${ID}` });
    assert.equal(got.turns.length, 2000);
    assert.equal(got.turns[0]?.text, 'turn 6000');
    assert.equal(got.turns.at(-1)?.text, 'turn 7999');
    assert.equal(got.truncated, true);
  } finally { await t.close(); }
});

for (const link of ['file', 'folder']) {
  test(`Claude history does not follow an outside-account ${link} link`, async () => {
    const t = await testCore();
    try {
      const project = await t.owner.call('projects.add', { path: t.projectDir });
      const outside = join(t.dir, 'other-records');
      mkdirSync(outside);
      writeFileSync(join(outside, `${ID}.jsonl`), JSON.stringify({ type: 'user', uuid: ID, cwd: t.projectDir,
        message: { content: 'outside-account-marker' } }) + '\n');
      const projects = join(t.dir, 'home', '.claude', 'projects');
      mkdirSync(projects, { recursive: true });
      const folder = join(projects, claudeSlug(t.projectDir));
      if (link === 'folder') symlinkSync(outside, folder);
      else {
        mkdirSync(folder);
        symlinkSync(join(outside, `${ID}.jsonl`), join(folder, `${ID}.jsonl`));
      }
      const items = await t.owner.call('history.list', { projectId: project.id });
      assert.deepEqual(items, [], 'outside-account content is not listed');
      await assert.rejects(t.owner.call('history.read', { id: `claude:${ID}` }), /find|gone|outside|record/i);
    } finally { await t.close(); }
  });
}
