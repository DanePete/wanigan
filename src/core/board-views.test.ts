// Named, saved board views, through the real core: what is written to the
// database, what the core answers, and everything it refuses (with the
// database left as it was). Fixtures are made up; nothing here reads the real
// home folder or Wanigan's own data.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { CoreClient } from '../client/client.ts';
import { DEFAULT_BOARD_VIEW, MAX_VIEWS, type BoardView } from '../shared/board-views.ts';
import type { PhoneDevice } from '../shared/phone.ts';
import type { Method } from '../shared/protocol.ts';
import { MIGRATIONS, openDatabase } from './db.ts';
import { dispatch } from './handlers.ts';
import { testCore, tokenOf, type TestCore } from './test-support.ts';

const view = (over: Partial<BoardView> = {}): BoardView => ({ ...DEFAULT_BOARD_VIEW, ...over });
const rows = (t: TestCore, projectId?: string) => t.core.db.prepare(
  `SELECT id, project_id, name, name_key, filter, types, sort, priority, agent FROM board_views ${projectId ? 'WHERE project_id = ?' : ''} ORDER BY created_at, rowid`,
).all(...(projectId ? [projectId] : [])) as { id: string; project_id: string; name: string; name_key: string; filter: string; types: string; sort: string; priority: number | null; agent: string }[];
const code = (want: string, message?: RegExp) => (e: Error & { code?: string }) => e.code === want && (!message || message.test(e.message));

async function withProject(run: (t: TestCore, projectId: string) => Promise<void>): Promise<void> {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir, name: 'Acme Shop' });
    await run(t, project.id);
  } finally {
    await t.close();
  }
}

test('a view saved by name is a row in the database, listed oldest first, saying exactly what the board showed', () => withProject(async (t, projectId) => {
  const bugs = await t.owner.call('boardViews.save', {
    projectId, name: '  Bugs by priority  ', view: view({ types: ['idea', 'bug'], sort: 'priority', priority: 1, filter: '  Checkout  ' }),
  });
  const mine = await t.owner.call('boardViews.save', { projectId, name: 'Claude’s cards', view: view({ agent: 'claude' }) });
  const gemini = await t.owner.call('boardViews.save', { projectId, name: 'Gemini', view: view({ agent: 'gemini', sort: 'stuck' }) });

  assert.equal(bugs.name, 'Bugs by priority', 'the name is trimmed');
  assert.deepEqual(bugs.view, { filter: 'Checkout', types: ['bug', 'idea'], sort: 'priority', priority: 1, agent: 'any' }, 'the filter is trimmed; types in board order');
  assert.equal(bugs.projectId, projectId);
  assert.ok(bugs.createdAt > 0 && bugs.updatedAt === bugs.createdAt);
  assert.deepEqual(rows(t, projectId), [
    { id: bugs.id, project_id: projectId, name: 'Bugs by priority', name_key: 'bugs by priority', filter: 'Checkout', types: '["bug","idea"]', sort: 'priority', priority: 1, agent: 'any' },
    { id: mine.id, project_id: projectId, name: 'Claude’s cards', name_key: 'claude’s cards', filter: '', types: '[]', sort: 'manual', priority: null, agent: 'claude' },
    { id: gemini.id, project_id: projectId, name: 'Gemini', name_key: 'gemini', filter: '', types: '[]', sort: 'stuck', priority: null, agent: 'gemini' },
  ], 'priority "any" is stored as null');
  assert.deepEqual(await t.owner.call('boardViews.list', { projectId }), [bugs, mine, gemini], 'the list is what was saved, in the order it was saved');
  await assert.rejects(t.owner.call('boardViews.list', { projectId: 'no-such-project' }), code('not_found', /No such project/));
  await assert.rejects(t.owner.call('boardViews.save', { projectId: 'no-such-project', name: 'X', view: view() }), code('not_found', /No such project/));
  assert.equal(rows(t).length, 3, 'nothing written for a project that is not there');
}));

test('a view’s name is one line, at most 60 characters, and unique on its board whatever its case', () => withProject(async (t, projectId) => {
  const other = await t.owner.call('projects.add', { path: t.dir, name: 'Northwind' });
  const first = await t.owner.call('boardViews.save', { projectId, name: 'Été release', view: view() });
  const refusals: [unknown, string, RegExp][] = [
    ['', 'invalid', /needs a name/], ['   ', 'invalid', /needs a name/], [42, 'invalid', /Name the view/], [undefined, 'invalid', /Name the view/],
    ['x'.repeat(61), 'invalid', /at most 60 characters; this one is 61/],
    ['Two\nlines', 'invalid', /one line of plain text/], ['Tab\there', 'invalid', /one line of plain text/],
    ['evil‮weiv', 'invalid', /without control or direction characters/],
    ['été RELEASE', 'conflict', /already has a view called “Été release”/],
    // The same letters composed differently are the same name.
    ['Été release', 'conflict', /already has a view called/],
  ];
  for (const [name, want, message] of refusals) {
    await assert.rejects(t.owner.call('boardViews.save', { projectId, name: name as string, view: view() }), code(want, message), JSON.stringify(name));
  }
  assert.deepEqual(rows(t).map((r) => r.name), ['Été release'], 'nothing refused was written');

  assert.equal((await t.owner.call('boardViews.save', { projectId, name: 'x'.repeat(60), view: view() })).name.length, 60, 'sixty is allowed');
  const elsewhere = await t.owner.call('boardViews.save', { projectId: other.id, name: 'ÉTÉ RELEASE', view: view() });
  assert.equal(elsewhere.projectId, other.id, 'another board may use the same name');

  // Renaming: to its own name in another case is fine; to another view's name is not.
  assert.equal((await t.owner.call('boardViews.update', { id: first.id, name: 'ÉTÉ Release' })).name, 'ÉTÉ Release');
  await assert.rejects(t.owner.call('boardViews.update', { id: first.id, name: 'X'.repeat(60) }), code('conflict', /already has a view called “x{60}”/));
  await assert.rejects(t.owner.call('boardViews.update', { id: first.id, name: '  ' }), code('invalid', /needs a name/));
  assert.equal(rows(t, projectId)[0]?.name, 'ÉTÉ Release', 'a refused rename changed nothing');
}));

test('a view names only what the board knows: unknown types, orders, priorities and agents are refused by name', () => withProject(async (t, projectId) => {
  const bad: [unknown, RegExp][] = [
    [null, /filter, card types, order, priority and agent/], ['bugs', /filter, card types, order, priority and agent/], [[], /filter, card types/],
    [{ ...view(), columns: ['done'] }, /not “columns”/],
    [{ filter: '', types: [], sort: 'manual', priority: 'any' }, /does not say its agent/],
    [view({ types: ['bug', 'epic'] as never }), /“epic” is not a card type: a board has task, bug, feature or idea cards/],
    [view({ types: ['bug', 'bug'] }), /names each card type once/],
    [view({ types: ['task', 'bug', 'feature', 'idea', 'task'] as never }), /at most 4/],
    [view({ types: 'bug' as never }), /card types are a list/],
    [view({ sort: 'swimlanes' as never }), /“swimlanes” is not an order the board knows/],
    [view({ priority: 4 as never }), /priority is any, or one of 0, 1, 2 or 3, not “4”/],
    [view({ priority: '1' as never }), /not “1”/],
    [view({ agent: 'grok' as never }), /“grok” is not an agent the board knows/],
    [view({ filter: 7 as never }), /filter is text/],
    [view({ filter: 'x'.repeat(201) }), /at most 200 characters; this one is 201/],
    [view({ filter: 'one\ntwo' }), /one line of plain text/],
  ];
  for (const [v, message] of bad) {
    await assert.rejects(t.owner.call('boardViews.save', { projectId, name: 'Refused', view: v as BoardView }), code('invalid', message), JSON.stringify(v));
  }
  assert.deepEqual(rows(t), [], 'nothing refused was written');

  const saved = await t.owner.call('boardViews.save', { projectId, name: 'Kept', view: view({ types: ['feature'] }) });
  await assert.rejects(t.owner.call('boardViews.update', { id: saved.id, view: view({ agent: 'grok' as never }) }), code('invalid', /“grok”/));
  await assert.rejects(t.owner.call('boardViews.update', { id: saved.id }), code('invalid', /new name, or what it should show/));
  assert.deepEqual(rows(t).map((r) => [r.types, r.agent]), [['["feature"]', 'any']], 'a refused update changed nothing');
}));

test('a board keeps at most 30 saved views; deleting one makes room', () => withProject(async (t, projectId) => {
  const saved = [];
  for (let i = 1; i <= MAX_VIEWS; i++) saved.push(await t.owner.call('boardViews.save', { projectId, name: `View ${i}`, view: view() }));
  await assert.rejects(t.owner.call('boardViews.save', { projectId, name: 'One too many', view: view() }), code('refused', /at most 30 saved views/));
  assert.equal(rows(t, projectId).length, MAX_VIEWS);
  await t.owner.call('boardViews.remove', { id: saved[0]!.id });
  assert.equal((await t.owner.call('boardViews.save', { projectId, name: 'One too many', view: view() })).name, 'One too many');
  assert.equal(rows(t, projectId).length, MAX_VIEWS);
}));

test('updating a view replaces what it shows, deleting removes it, and each change tells the window', () => withProject(async (t, projectId) => {
  const heard: unknown[] = [];
  const off = t.core.bus.on((event, data) => { if (event === 'boardViews') heard.push(data); });
  try {
    const saved = await t.owner.call('boardViews.save', { projectId, name: 'Review queue', view: view({ types: ['bug'] }) });
    const updated = await t.owner.call('boardViews.update', { id: saved.id, view: view({ types: ['feature', 'task'], sort: 'oldest', priority: 0, agent: 'none' }) });
    assert.deepEqual(updated.view, { filter: '', types: ['task', 'feature'], sort: 'oldest', priority: 0, agent: 'none' });
    assert.equal(updated.name, 'Review queue', 'the name stays');
    assert.ok(updated.updatedAt >= saved.updatedAt);
    assert.deepEqual(rows(t, projectId).map((r) => [r.types, r.sort, r.priority, r.agent]), [['["task","feature"]', 'oldest', 0, 'none']]);

    await t.owner.call('boardViews.remove', { id: saved.id });
    assert.deepEqual(rows(t), [], 'gone from the database');
    assert.deepEqual(await t.owner.call('boardViews.list', { projectId }), []);
    await assert.rejects(t.owner.call('boardViews.update', { id: saved.id, name: 'Back' }), code('not_found', /No such saved view/));
    await assert.rejects(t.owner.call('boardViews.remove', { id: saved.id }), code('not_found'));
    await assert.rejects(t.owner.call('boardViews.remove', { id: 42 as never }), code('invalid', /Which saved view/));
    assert.deepEqual(heard, [{ projectId }, { projectId }, { projectId }], 'saved, updated and deleted: three events for its project, none for a refusal');
  } finally {
    off();
  }
}));

test('saved views are the owner’s: a session and a phone can neither read nor change them', () => withProject(async (t, projectId) => {
  const saved = await t.owner.call('boardViews.save', { projectId, name: 'Mine', view: view() });
  const session = await t.owner.call('sessions.start', { projectId, provider: 'claude' });
  const agent = await CoreClient.connect(t.core.paths.socket, await tokenOf(t.core, session.id));
  const phone: PhoneDevice = { id: 'phone-1', name: 'Test phone', control: true, pairedAt: 1, lastSeenAt: null, push: false };
  const calls: [Method, object][] = [
    ['boardViews.list', { projectId }], ['boardViews.save', { projectId, name: 'Theirs', view: view() }],
    ['boardViews.update', { id: saved.id, name: 'Renamed' }], ['boardViews.remove', { id: saved.id }],
  ];
  try {
    for (const [method, params] of calls) {
      await assert.rejects(agent.call(method, params as never), code('forbidden', /not available to a session/), method);
      await assert.rejects(dispatch(t.core.handlers, method, params, { role: 'phone', device: phone }), code('forbidden', /not available to a phone/), method);
    }
    assert.deepEqual(rows(t).map((r) => r.name), ['Mine'], 'nothing changed');
  } finally {
    agent.close();
    await t.owner.call('sessions.stop', { id: session.id });
  }
}));

test('saved views stay with a closed project and come back with it; a project deleted from the database takes them with it', () => withProject(async (t, projectId) => {
  await t.owner.call('boardViews.save', { projectId, name: 'Kept through closing', view: view({ sort: 'newest' }) });
  await t.owner.call('projects.archive', { id: projectId });
  const again = await t.owner.call('projects.add', { path: t.projectDir });
  assert.equal(again.id, projectId);
  assert.deepEqual((await t.owner.call('boardViews.list', { projectId })).map((v) => [v.name, v.view.sort]), [['Kept through closing', 'newest']]);

  // Nothing in Wanigan deletes a project row today; if one is ever deleted, its views go with it.
  const other = await t.owner.call('projects.add', { path: t.dir, name: 'Northwind' });
  await t.owner.call('boardViews.save', { projectId: other.id, name: 'Elsewhere', view: view() });
  t.core.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  assert.deepEqual(rows(t).map((r) => r.name), ['Elsewhere'], 'the deleted project’s view went; the other board’s stayed');
}));

test('a view a newer Wanigan stored is read without what this build does not know', () => withProject(async (t, projectId) => {
  t.core.db.prepare(`INSERT INTO board_views (id, project_id, name, name_key, filter, types, sort, priority, agent, created_at, updated_at)
                     VALUES ('v1', ?, 'From the future', 'from the future', 'cart', '["epic","bug"]', 'swimlanes', 7, 'grok', 1, 1)`).run(projectId);
  t.core.db.prepare(`INSERT INTO board_views (id, project_id, name, name_key, filter, types, sort, priority, agent, created_at, updated_at)
                     VALUES ('v2', ?, 'Unreadable types', 'unreadable types', '', 'not json', 'jev', 2, 'codex', 2, 2)`).run(projectId);
  assert.deepEqual((await t.owner.call('boardViews.list', { projectId })).map((v) => v.view), [
    { filter: 'cart', types: ['bug'], sort: 'manual', priority: 'any', agent: 'any' },
    { filter: '', types: [], sort: 'jev', priority: 2, agent: 'codex' },
  ]);
}));

test('a database from before saved views opens with its data, and gains them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-views-'));
  try {
    const file = join(dir, 'wanigan.db');
    const before = MIGRATIONS.findIndex((m) => /CREATE TABLE board_views/.test(m));
    assert.ok(before > 0, 'saved views are a migration of their own, appended after what had shipped');
    const old = new Database(file);
    old.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    for (const m of MIGRATIONS.slice(0, before)) old.exec(m);
    old.prepare("INSERT INTO meta VALUES ('schema', ?), ('store', 'wanigan-2')").run(String(before));
    old.prepare("INSERT INTO projects (id, key, name, path, created_at) VALUES ('p1', 'AC', 'Acme', '/tmp/acme', 1)").run();
    old.close();

    const db = openDatabase(file);
    assert.equal((db.prepare("SELECT name FROM projects WHERE id = 'p1'").get() as { name: string }).name, 'Acme', 'its data is kept');
    db.prepare("INSERT INTO board_views (id, project_id, name, name_key, created_at, updated_at) VALUES ('v1', 'p1', 'Everything', 'everything', 1, 1)").run();
    assert.deepEqual(db.prepare('SELECT filter, types, sort, priority, agent FROM board_views').get(), { filter: '', types: '[]', sort: 'manual', priority: null, agent: 'any' });
    assert.throws(() => db.prepare("INSERT INTO board_views (id, project_id, name, name_key, created_at, updated_at) VALUES ('v2', 'p1', 'EVERYTHING', 'everything', 1, 1)").run(),
      /UNIQUE constraint failed/, 'the database itself refuses a second view by the same name on a board');
    assert.throws(() => db.prepare("INSERT INTO board_views (id, project_id, name, name_key, created_at, updated_at) VALUES ('v3', 'nowhere', 'Orphan', 'orphan', 1, 1)").run(),
      /FOREIGN KEY constraint failed/, 'a view belongs to a project that exists');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
