// The design layer's log in a real core (testCore): what each call leaves in the database, undo and redo replaying
// the action list exactly, the transitions an edit may make and the reasons for the rest, the bounds, and the
// migration upgrading a database that had none of it. Made-up parts and pages (acme, northwind); nothing real.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import type { LayerEditInput, LayerSnapshot, LayerVerdict } from '../shared/design-layer.ts';
import { MIGRATIONS, SCHEMA_VERSION, openDatabase } from './db.ts';
import { MAX_LAYER_EDITS, MAX_LAYER_ROWS } from './live-layer.ts';
import { testCore, type TestCore } from './test-support.ts';

const heading = (n: number, over: Partial<LayerEditInput> = {}): LayerEditInput => ({
  target: { part: { kind: 'component', name: 'acme:card', within: null, nth: n }, inner: 'h2:nth-of-type(1)', selector: null, textHash: '0123456789abcdef' },
  label: `Heading in Card ${n + 1}`, page: '/paddling', scope: 'this', breakpoint: 'all',
  change: { type: 'style', values: { color: '#123456' } }, before: { color: 'rgb(0, 0, 0)' }, ...over,
});

const verdict = (ok: boolean): LayerVerdict => ({
  at: 7, ok, failed: ok ? null : 'styles', widths: [390, 1440], noise: { maxDiff: 0, pixels: 0 },
  differences: ok ? [] : [{ kind: 'style', edit: 'x', width: 390, element: 'h2', property: 'color', design: 'rgb(18, 52, 86)', result: 'rgb(0, 0, 0)' }],
  pictures: [],
});

interface ActionRow { action: string; edit_id: string; ref: number | null; state_from: string | null; state_to: string | null }

describe('the design layer’s log', () => {
  let t: TestCore;
  let projectId: string;
  let events = 0;

  before(async () => {
    t = await testCore();
    projectId = (await t.owner.call('projects.add', { path: t.projectDir })).id;
    t.core.bus.on((event, data) => { if (event === 'liveLayer' && (data as { projectId: string }).projectId === projectId) events++; });
  });
  after(async () => { await t?.close(); });

  const add = (edit: unknown): Promise<LayerSnapshot> => t.owner.call('live.layerAdd', { projectId, edit });
  const rows = () => t.core.db.prepare('SELECT id, seq, label, page, scope, state, made_by, listed, verdict_json FROM live_layer_edits WHERE project_id = ? ORDER BY seq').all(projectId) as
    { id: string; seq: number; label: string; page: string; scope: string; state: string; made_by: string; listed: number; verdict_json: string | null }[];
  const actions = () => t.core.db.prepare('SELECT action, edit_id, ref, state_from, state_to FROM live_layer_actions WHERE project_id = ? ORDER BY id').all(projectId) as ActionRow[];
  const reset = () => { t.core.db.prepare('DELETE FROM live_layer_actions').run(); t.core.db.prepare('DELETE FROM live_layer_edits').run(); };

  test('an add is checked, given its id, maker, time and state by the core, and kept as a row with an add in the log', async () => {
    reset();
    events = 0;
    const snap = await add({ ...heading(0), id: 'mine', by: 'agent', state: 'verified', at: 1, verdict: verdict(true) });
    assert.equal(snap.edits.length, 1);
    const [e] = snap.edits;
    assert.match(e!.id, /^[0-9a-f-]{36}$/, 'the core’s id, never the caller’s');
    assert.deepEqual([e!.by, e!.state, e!.verdict, e!.page, e!.label], ['owner', 'draft', null, '/paddling', 'Heading in Card 1']);
    assert.deepEqual(rows().map((r) => [r.id, r.seq, r.state, r.made_by, r.listed, r.verdict_json]), [[e!.id, 1, 'draft', 'owner', 1, null]]);
    assert.deepEqual(actions(), [{ action: 'add', edit_id: e!.id, ref: null, state_from: null, state_to: null }]);
    assert.deepEqual(snap.undo, { id: e!.id, label: 'Heading in Card 1', action: 'add' });
    assert.equal(snap.redo, null);
    assert.equal(events, 1, 'the window is told');
  });

  test('undo and redo replay the log exactly; a new add ends what redo could bring back', async () => {
    reset();
    const a = (await add(heading(0))).edits.at(-1)!.id;
    const b = (await add(heading(1))).edits.at(-1)!.id;
    let snap = await t.owner.call('live.layerUndo', { projectId });
    assert.deepEqual(snap.edits.map((e) => e.id), [a]);
    assert.deepEqual([snap.undo?.id, snap.redo?.id, snap.redo?.action], [a, b, 'add']);
    snap = await t.owner.call('live.layerUndo', { projectId });
    assert.deepEqual(snap.edits, []);
    assert.equal(snap.undo, null);
    await assert.rejects(t.owner.call('live.layerUndo', { projectId }), /nothing to undo/);
    snap = await t.owner.call('live.layerRedo', { projectId });
    assert.deepEqual(snap.edits.map((e) => e.id), [a], 'redo brings back the newest undone first');
    assert.equal(snap.redo?.id, b);
    const c = (await add(heading(2))).edits.at(-1)!.id;
    snap = await t.owner.call('live.layer', { projectId });
    assert.deepEqual(snap.edits.map((e) => e.id), [a, c]);
    assert.equal(snap.redo, null, 'the add ended what redo could bring back');
    await assert.rejects(t.owner.call('live.layerRedo', { projectId }), /nothing to redo/);
    assert.deepEqual(rows().map((r) => [r.id, r.listed]), [[a, 1], [b, 0], [c, 1]], 'the undone edit is kept in the log, not listed');
    const log = actions();
    assert.deepEqual(log.map((r) => [r.action, r.edit_id]), [['add', a], ['add', b], ['undo', b], ['undo', a], ['redo', a], ['add', c]]);
    const ids = t.core.db.prepare("SELECT id FROM live_layer_actions WHERE action = 'add' ORDER BY id").all() as { id: number }[];
    assert.deepEqual(log.filter((r) => r.action !== 'add').map((r) => r.ref), [ids[1]!.id, ids[0]!.id, ids[0]!.id], 'each undo and redo names the add it acts on');
  });

  test('a discard takes a draft or an orphaned edit out, undo brings it back as it was, redo takes it out again', async () => {
    reset();
    const a = (await add(heading(0))).edits.at(-1)!.id;
    await t.owner.call('live.layerMark', { projectId, id: a, state: 'orphaned' });
    let snap = await t.owner.call('live.layerDiscard', { projectId, id: a });
    assert.deepEqual(snap.edits, []);
    assert.deepEqual(snap.undo, { id: a, label: 'Heading in Card 1', action: 'discard' });
    snap = await t.owner.call('live.layerUndo', { projectId });
    assert.deepEqual(snap.edits.map((e) => [e.id, e.state]), [[a, 'orphaned']], 'back as it was');
    snap = await t.owner.call('live.layerRedo', { projectId });
    assert.deepEqual(snap.edits, []);
    assert.deepEqual(rows().map((r) => [r.state, r.listed]), [['orphaned', 0]]);
    assert.deepEqual(actions().map((r) => r.action), ['add', 'mark', 'discard', 'undo', 'redo']);
  });

  test('an edit in the site is never taken out of the layer by a discard, an undo or a redo', async () => {
    reset();
    const a = (await add(heading(0))).edits.at(-1)!.id;
    let snap = await t.owner.call('live.layerMark', { projectId, id: a, state: 'implemented' });
    assert.equal(snap.undo, null, 'undo would take an implemented edit out of the layer, not out of the site');
    await assert.rejects(t.owner.call('live.layerUndo', { projectId }), /implemented .*would not take it out of the site/);
    await assert.rejects(t.owner.call('live.layerDiscard', { projectId, id: a }), /Only a draft or an orphaned edit is discarded; this one is implemented/);
    // Neither a failed verification nor a page where its element is not found makes it a draft, or orphaned, again:
    // either would make it discardable while its words are in the site.
    await assert.rejects(t.owner.call('live.layerMark', { projectId, id: a, state: 'draft', verdict: verdict(false) }), /in the site: it does not go back to draft/);
    await assert.rejects(t.owner.call('live.layerMark', { projectId, id: a, state: 'orphaned' }), /in the site: a page where its element is not found/);
    snap = await t.owner.call('live.layerMark', { projectId, id: a, state: 'implemented', verdict: verdict(false) });
    assert.deepEqual([snap.edits[0]?.state, snap.edits[0]?.verdict?.failed], ['implemented', 'styles'], 'a failed verification is kept with it');
    assert.equal(snap.undo, null);
    await assert.rejects(t.owner.call('live.layerUndo', { projectId }), /would not take it out of the site/);
    await assert.rejects(t.owner.call('live.layerDiscard', { projectId, id: a }), /this one is implemented/);
    assert.deepEqual(rows().map((r) => [r.state, r.listed]), [['implemented', 1]]);
  });

  test('states move along the design’s transitions, verdicts are kept, and every other move says why', async () => {
    reset();
    const a = (await add(heading(0))).edits.at(-1)!.id;
    const mark = (state: string, v?: unknown) => t.owner.call('live.layerMark', { projectId, id: a, state: state as never, ...(v !== undefined ? { verdict: v as LayerVerdict } : {}) });
    await assert.rejects(mark('verified', verdict(true)), /Only an implemented edit is verified; this one is draft/);
    await assert.rejects(mark('retired'), /Only a verified edit is retired/);
    await assert.rejects(mark('gone'), /draft, implemented, verified, retired or orphaned/);
    await assert.rejects(mark('draft', verdict(true)), /kept only on an edit in the site; this one is draft/, 'a draft is not in the site: no verdict, passing or not, is kept on it');
    await assert.rejects(mark('orphaned', verdict(false)), /kept only on an edit in the site/);
    await mark('implemented');
    await assert.rejects(mark('verified'), /verified only by a verification that passed/);
    await assert.rejects(mark('verified', verdict(false)), /verified only by a verification that passed/);
    await assert.rejects(mark('verified', { ...verdict(true), noise: { maxDiff: 999, pixels: 0 } }), /not a verification’s verdict/);
    await assert.rejects(mark('draft', verdict(true)), /does not go back to draft/);
    await assert.rejects(mark('draft', verdict(false)), /does not go back to draft/);
    await assert.rejects(mark('implemented', verdict(true)), /passed marks the edit verified/);
    let snap = await mark('implemented', verdict(false));
    assert.deepEqual([snap.edits[0]?.state, snap.edits[0]?.verdict?.failed], ['implemented', 'styles'], 'still in the site, keeping the verdict');
    snap = await mark('verified', verdict(true));
    assert.deepEqual([snap.edits[0]?.state, snap.edits[0]?.verdict?.ok], ['verified', true]);
    await assert.rejects(mark('draft'), /A verified edit does not go back to draft/);
    snap = await mark('retired');
    assert.deepEqual(snap.edits, [], 'retired edits are archived: kept, not listed');
    assert.deepEqual(rows().map((r) => r.state), ['retired']);
    await assert.rejects(mark('verified', verdict(true)), /archived/);
    assert.deepEqual(actions().filter((r) => r.action === 'mark').map((r) => [r.state_from, r.state_to]), [
      ['draft', 'implemented'], ['implemented', 'implemented'], ['implemented', 'verified'], ['verified', 'retired'],
    ], 'only moves that happened, and the verdict recorded, are in the log');
  });

  test('orphaned and back: an edit whose element no longer resolves is orphaned, and a draft again when it does', async () => {
    reset();
    const a = (await add(heading(0))).edits.at(-1)!.id;
    events = 0;
    await t.owner.call('live.layerMark', { projectId, id: a, state: 'orphaned' });
    const again = await t.owner.call('live.layerMark', { projectId, id: a, state: 'orphaned' });
    assert.equal(again.edits[0]?.state, 'orphaned');
    assert.equal(events, 1, 'marking an edit the state it is in changes nothing, and says nothing');
    await assert.rejects(t.owner.call('live.layerMark', { projectId, id: a, state: 'implemented' }), /orphaned edit no longer finds its element/);
    const back = await t.owner.call('live.layerMark', { projectId, id: a, state: 'draft' });
    assert.equal(back.edits[0]?.state, 'draft');
    assert.equal(actions().filter((r) => r.action === 'mark').length, 2);
  });

  test('what is not an edit, or not one phase 1 shows, is refused with the reason; nothing is kept', async () => {
    reset();
    const no = (edit: unknown, why: RegExp) => assert.rejects(add(edit), why);
    await no(null, /target, its change and the page/);
    await no({ ...heading(0), target: { part: { kind: 'xpath' }, inner: null, selector: null, textHash: null } }, /target the trace names/);
    await no({ ...heading(0), change: { type: 'style', values: { position: 'fixed' } } }, /does not set position/);
    await no({ ...heading(0), page: undefined }, /the page it was made on/);
    await no({ ...heading(0), page: 'https://acme.example/paddling' }, /the page it was made on/);
    await no({ ...heading(0), change: { type: 'image', asset: '0123456789abcdef.webp', alt: null } }, /Only words, styles and tokens/);
    await no({ ...heading(0), scope: 'site', change: { type: 'style', values: { color: 'red' } } }, /whole site/);
    assert.deepEqual(rows(), []);
    assert.deepEqual(actions(), []);
    await assert.rejects(t.owner.call('live.layerDiscard', { projectId, id: 'nope' }), /No such edit/);
    await assert.rejects(t.owner.call('live.layer', { projectId: 'nope' }), /No such project/);
    const token = await add({ target: { part: null, inner: null, selector: null, textHash: null }, label: 'Accent', page: '/', scope: 'site', breakpoint: 'all', change: { type: 'token', name: '--color-accent', value: '#0a7' }, before: {} });
    assert.equal(token.edits[0]?.change.type, 'token', 'a token for the whole site is a layer edit');
  });

  test('a taken-back edit cannot be marked, and an edit of another project is not found', async () => {
    reset();
    const a = (await add(heading(0))).edits.at(-1)!.id;
    await t.owner.call('live.layerUndo', { projectId });
    await assert.rejects(t.owner.call('live.layerMark', { projectId, id: a, state: 'orphaned' }), /not in the layer now/);
    const other = (await t.owner.call('projects.add', { path: t.dir, name: 'Northwind', key: 'NW' })).id;
    await assert.rejects(t.owner.call('live.layerMark', { projectId: other, id: a, state: 'orphaned' }), /No such edit/);
    assert.deepEqual((await t.owner.call('live.layer', { projectId: other })).edits, []);
  });

  test('bounded: edits listed at once, and every row a project’s layer has had', async () => {
    reset();
    for (let n = 0; n < MAX_LAYER_EDITS; n++) await add(heading(n));
    await assert.rejects(add(heading(MAX_LAYER_EDITS)), new RegExp(`at most ${MAX_LAYER_EDITS} edits at once`));
    assert.equal(rows().length, MAX_LAYER_EDITS);
    // A discard makes room.
    const first = rows()[0]!.id;
    await t.owner.call('live.layerDiscard', { projectId, id: first });
    assert.equal((await add(heading(MAX_LAYER_EDITS))).edits.length, MAX_LAYER_EDITS);
    // The log itself is never pruned, so it has a ceiling of its own.
    const fill = t.core.db.prepare(`INSERT INTO live_layer_edits (id, project_id, seq, target_json, label, page, scope, breakpoint, change_json, before_json, state, made_by, made_at, listed, updated_at)
      VALUES (?, ?, ?, '{}', 'old', '/', 'this', 'all', '{}', '{}', 'draft', 'owner', 1, 0, 1)`);
    t.core.db.transaction(() => { for (let n = rows().length; n < MAX_LAYER_ROWS; n++) fill.run(`old-${n}`, projectId, 100_000 + n); })();
    await t.owner.call('live.layerDiscard', { projectId, id: rows().find((r) => r.listed === 1)!.id });
    await assert.rejects(add(heading(0)), /kept 20,000 edits, its limit/);
  });

  test('bounded: the bytes the listed edits hold together', async () => {
    reset();
    const long = (n: number) => heading(n, { change: { type: 'text', value: 'w'.repeat(100_000) }, before: { text: 'old words' } });
    let kept = 0;
    let refusal: Error | null = null;
    for (let n = 0; n < 100 && !refusal; n++) {
      try { await add(long(n)); kept++; } catch (error) { refusal = error as Error; }
    }
    assert.match(refusal?.message ?? '', /too large together/);
    assert.ok(kept >= 80 && kept < 90, `about 8 MB of words is kept (${kept} edits)`);
    assert.equal(rows().length, kept);
  });
});

test('a database from before the design layer upgrades: its data is kept and the layer’s tables arrive empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-layer-upgrade-'));
  try {
    const file = join(dir, 'wanigan.db');
    const at = MIGRATIONS.findIndex((m) => /CREATE TABLE live_layer_edits/.test(m));
    assert.equal(at, MIGRATIONS.length - 1, 'the layer’s migration is the newest, added at the end');
    const old = new Database(file);
    old.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    for (const m of MIGRATIONS.slice(0, at)) old.exec(m);
    old.prepare("INSERT INTO meta VALUES ('schema', ?), ('store', 'wanigan-2')").run(String(at));
    old.prepare("INSERT INTO projects (id, key, name, path, created_at) VALUES ('p1', 'AC', 'Acme', '/tmp/acme', 1)").run();
    old.prepare("INSERT INTO live_edits (id, project_id, path, offset, line, before_text, after_text, before_hash, after_hash, created_at) VALUES ('le1', 'p1', 'x.twig', 0, 1, 'a', 'b', 'h1', 'h2', 1)").run();
    old.close();

    const db = openDatabase(file);
    assert.equal(Number((db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string }).value), SCHEMA_VERSION);
    assert.equal((db.prepare("SELECT name FROM projects WHERE id = 'p1'").get() as { name: string }).name, 'Acme');
    assert.equal((db.prepare('SELECT count(*) AS n FROM live_edits').get() as { n: number }).n, 1, 'the hand edits made before are kept');
    assert.equal((db.prepare('SELECT count(*) AS n FROM live_layer_edits').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT count(*) AS n FROM live_layer_actions').get() as { n: number }).n, 0);
    assert.throws(() => db.prepare("INSERT INTO live_layer_edits (id, project_id, seq, target_json, label, page, scope, breakpoint, change_json, before_json, state, made_by, made_at, updated_at) VALUES ('e', 'p1', 1, '{}', 'x', '/', 'this', 'all', '{}', '{}', 'lost', 'owner', 1, 1)").run(), /CHECK constraint/);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
