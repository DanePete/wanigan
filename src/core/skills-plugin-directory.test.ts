// Plugin-only containment through public owner RPCs and invented owned files.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import type { Skill } from '../shared/skills.ts';
import { testCore, type TestCore } from './test-support.ts';

function snapshot(root: string): object[] {
  const rows: object[] = [];
  const walk = (p: string): void => {
    const st = lstatSync(p), record = { path: relative(root, p), mode: st.mode & 0o777 };
    if (st.isSymbolicLink()) rows.push({ ...record, type: 'link', target: readlinkSync(p) });
    else if (st.isDirectory()) { rows.push({ ...record, type: 'directory' }); for (const name of readdirSync(p).sort()) walk(join(p, name)); }
    else { assert.ok(st.isFile()); rows.push({ ...record, type: 'file', sha256: createHash('sha256').update(readFileSync(p)).digest('hex') }); }
  };
  walk(root); return rows;
}
function skill(dir: string, name: string, marker: string): string {
  mkdirSync(dir, { recursive: true });
  const text = `---\nname: ${name}\ndescription: ${marker}\n---\n\n# ${marker}\n`;
  writeFileSync(join(dir, 'SKILL.md'), text, { mode: 0o600 }); return text;
}
async function fixture(context: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wg-plugin-skill-'))), home = join(root, 'home'), claude = join(home, '.claude');
  const plugin = join(claude, 'plugins/cache/owned/v1'), sibling = join(claude, 'plugins/cache/sibling/v1'), outside = join(root, 'owned-outside');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true }); mkdirSync(outside); mkdirSync(join(claude, 'skills'));
  const manifest = join(plugin, '.claude-plugin/plugin.json'); writeFileSync(manifest, '{}');
  skill(join(sibling, 'skills/healthy'), 'healthy-sibling', 'A healthy sibling plugin.');
  skill(join(claude, 'skills/healthy-personal'), 'healthy-personal', 'A healthy personal skill.');
  writeFileSync(join(claude, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'owned@fixture': [{ installPath: plugin }], 'sibling@fixture': [{ installPath: sibling }] } }));
  writeFileSync(join(claude, 'settings.json'), '{}'); writeFileSync(join(home, '.claude.json'), '{}');
  let t: TestCore | undefined;
  context.after(async () => { await t?.close(); rmSync(root, { recursive: true, force: true }); });
  t = await testCore({ accounts: { home }, launcher: () => { throw new Error('This fixture must not launch a session'); } });
  await t.core.accounts.refresh();
  const publicState = async () => ({ projects: await t!.owner.call('projects.list', {}), sessions: await t!.owner.call('sessions.list', {}) });
  const listing = () => t!.owner.call('skills.list', {});
  const all = async () => (await listing()).groups.flatMap(g => g.skills);
  return { ...t, root, home, claude, plugin, sibling, outside, manifest, publicState, listing, all };
}
function healthy(rows: Skill[]): void {
  assert.ok(rows.some(s => s.plugin === 'sibling@fixture' && s.name === 'healthy-sibling'));
  assert.ok(rows.some(s => s.source === 'personal' && s.name === 'healthy-personal'));
}

test('a declared plugin directory cannot expose an outside skill through listing', async context => {
  const f = await fixture(context), marker = 'OWNED_DECLARED_DIRECTORY_OUTSIDE', external = join(f.outside, 'outside-skill');
  skill(external, 'outside-skill', marker); symlinkSync(external, join(f.plugin, 'declared'));
  writeFileSync(f.manifest, JSON.stringify({ skills: ['./declared'] }));
  const before = snapshot(f.root), state = await f.publicState(), listing = await f.listing(), rows = listing.groups.flatMap(g => g.skills);
  healthy(rows); assert.deepEqual(snapshot(f.root), before); assert.deepEqual(await f.publicState(), state);
  assert.equal(JSON.stringify(listing).includes(marker), false); assert.equal(rows.some(s => s.plugin === 'owned@fixture'), false);
  assert.ok(listing.notes.some(note => /plugin skill director.*could not be read safely/i.test(note)));
});


test('a child directory alias under default plugin skills cannot expose outside content', async context => {
  const f = await fixture(context), marker = 'OWNED_CHILD_DIRECTORY_OUTSIDE', external = join(f.outside, 'outside-skill');
  skill(external, 'outside-skill', marker); mkdirSync(join(f.plugin, 'skills')); symlinkSync(external, join(f.plugin, 'skills/linked'));
  const before = snapshot(f.root), state = await f.publicState(), listing = await f.listing(), rows = listing.groups.flatMap(g => g.skills);
  healthy(rows); assert.deepEqual(snapshot(f.root), before); assert.deepEqual(await f.publicState(), state);
  assert.equal(JSON.stringify(listing).includes(marker), false); assert.equal(rows.some(s => s.plugin === 'owned@fixture'), false);
  assert.ok(listing.notes.some(note => /plugin skill director.*could not be read safely/i.test(note)));
});


for (const route of ['declared', 'default'] as const) test(`a ${route} plugin root cannot enumerate an outside skill collection`, async context => {
  const f = await fixture(context), marker = 'OWNED_OUTSIDE_COLLECTION', collection = join(f.outside, 'collection');
  skill(join(collection, 'external'), 'external', marker); symlinkSync(collection, join(f.plugin, route === 'default' ? 'skills' : 'declared'));
  if (route === 'declared') writeFileSync(f.manifest, JSON.stringify({ skills: ['./declared'] }));
  const before = snapshot(f.root), listing = await f.listing(); healthy(listing.groups.flatMap(g => g.skills));
  assert.equal(JSON.stringify(listing).includes(marker), false); assert.ok(listing.notes.some(note => /could not be read safely/i.test(note))); assert.deepEqual(snapshot(f.root), before);
});

for (const route of ['declared', 'default', 'child'] as const) test(`a contained plugin ${route} directory alias stays readable and previewable`, async context => {
  const f = await fixture(context), marker = 'OWNED_CONTAINED_ALIAS', target = join(f.plugin, 'contained'), dir = route === 'default' ? join(target, 'inner') : target;
  const text = skill(dir, 'contained', marker); let link: string;
  if (route === 'child') { mkdirSync(join(f.plugin, 'skills')); link = join(f.plugin, 'skills/linked'); }
  else link = join(f.plugin, route === 'default' ? 'skills' : 'declared');
  symlinkSync(target, link); if (route === 'declared') writeFileSync(f.manifest, JSON.stringify({ skills: ['./declared'] }));
  const before = snapshot(f.root), state = await f.publicState(), listing = await f.listing(), row = listing.groups.flatMap(g => g.skills).find(s => s.plugin === 'owned@fixture'); assert.ok(row);
  assert.equal((await f.owner.call('skills.read', { id: row.id })).text, text);
  const preview = await f.owner.call('skills.copy', { id: row.id, to: { agent: 'codex' }, preview: true }); assert.equal(preview.done, false); assert.deepEqual(preview.plan.files.map(file => file.path), ['SKILL.md']);
  assert.equal(listing.notes.some(note => /could not be read safely/i.test(note)), false); assert.deepEqual(snapshot(f.root), before); assert.deepEqual(await f.publicState(), state);
});

for (const source of ['personal', 'project'] as const) test(`deliberate ${source} directory links retain their existing read and preview behavior`, async context => {
  const f = await fixture(context), target = join(f.outside, 'deliberate'), text = skill(target, 'linked', 'OWNED_DELIBERATE_LINK');
  const dir = source === 'personal' ? join(f.claude, 'skills') : join(f.projectDir, '.claude/skills'); mkdirSync(dir, { recursive: true }); symlinkSync(target, join(dir, 'linked'));
  if (source === 'project') await f.owner.call('projects.add', { path: f.projectDir });
  const before = snapshot(f.root), projectBefore = snapshot(f.projectDir), state = await f.publicState(), row = (await f.all()).find(s => s.source === source && s.name === 'linked'); assert.ok(row);
  assert.equal((await f.owner.call('skills.read', { id: row.id })).text, text); assert.equal((await f.owner.call('skills.copy', { id: row.id, to: { agent: 'codex' }, preview: true })).done, false);
  assert.deepEqual(snapshot(f.root), before); assert.deepEqual(snapshot(f.projectDir), projectBefore); assert.deepEqual(await f.publicState(), state);
});

test('an absent optional default plugin skills folder stays known absence without an unsafe note', async context => {
  const f = await fixture(context), before = snapshot(f.root); assert.equal(existsSync(join(f.plugin, 'skills')), false);
  const listing = await f.listing(); healthy(listing.groups.flatMap(g => g.skills)); assert.equal(listing.notes.some(note => /could not be read safely/i.test(note)), false); assert.deepEqual(snapshot(f.root), before);
});

for (const route of ['root', 'child'] as const) test(`a dangling plugin ${route} directory alias is noted without hiding healthy skills`, async context => {
  const f = await fixture(context), link = route === 'root' ? join(f.plugin, 'skills') : join(f.plugin, 'skills/linked');
  if (route === 'child') mkdirSync(join(f.plugin, 'skills')); symlinkSync(join(f.plugin, 'missing'), link);
  const before = snapshot(f.root), listing = await f.listing(); healthy(listing.groups.flatMap(g => g.skills)); assert.ok(listing.notes.some(note => /could not be read safely/i.test(note))); assert.deepEqual(snapshot(f.root), before);
});

for (const route of ['root', 'child'] as const) test(`an inaccessible plugin ${route} directory is unknown rather than a silent empty result`, async context => {
  const f = await fixture(context), target = join(f.plugin, 'contained'), text = skill(target, 'restricted', 'OWNED_RESTRICTED_SKILL');
  const link = route === 'root' ? join(f.plugin, 'skills') : join(f.plugin, 'skills/linked'); if (route === 'child') mkdirSync(join(f.plugin, 'skills')); symlinkSync(target, link);
  const mode = statSync(target).mode & 0o777, before = snapshot(f.root); let listing;
  chmodSync(target, 0);
  try { assert.throws(() => readdirSync(target), (error: NodeJS.ErrnoException) => error.code === 'EACCES'); listing = await f.listing(); }
  finally { chmodSync(target, mode); }
  healthy(listing.groups.flatMap(g => g.skills)); assert.ok(listing.notes.some(note => /could not be read safely/i.test(note))); assert.deepEqual(snapshot(f.root), before); assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), text);
});

test('a plugin SKILL.md leaf link outside its own folder remains unreadable', async context => {
  const f = await fixture(context), target = join(f.outside, 'leaf'), marker = 'OWNED_BLOCKED_LEAF', folder = join(f.plugin, 'skills/leaf');
  skill(target, 'external', marker); mkdirSync(folder, { recursive: true }); symlinkSync(join(target, 'SKILL.md'), join(folder, 'SKILL.md'));
  const before = snapshot(f.root), listing = await f.listing(), row = listing.groups.flatMap(g => g.skills).find(s => s.plugin === 'owned@fixture'); assert.ok(row);
  assert.equal(JSON.stringify(listing).includes(marker), false); assert.match(row.description, /links outside its folder/); await assert.rejects(f.owner.call('skills.read', { id: row.id }), /links outside its folder/); assert.deepEqual(snapshot(f.root), before);
});

for (const action of ['read', 'preview', 'apply'] as const) test(`a cached plugin skill id cannot ${action} after its directory alias moves outside`, async context => {
  const f = await fixture(context), inside = join(f.plugin, 'inside'), outside = join(f.outside, 'moved'), link = join(f.plugin, 'declared');
  skill(inside, 'cached', 'OWNED_BEFORE_RETARGET'); skill(outside, 'cached', 'OWNED_OUTSIDE_RETARGET'); symlinkSync(inside, link); writeFileSync(f.manifest, JSON.stringify({ skills: ['./declared'] }));
  const row = (await f.all()).find(s => s.plugin === 'owned@fixture'); assert.ok(row); const to = { agent: 'codex' as const };
  const preview = await f.owner.call('skills.copy', { id: row.id, to, preview: true }); rmSync(link); symlinkSync(outside, link);
  const before = snapshot(f.root), state = await f.publicState();
  const call = action === 'read' ? f.owner.call('skills.read', { id: row.id }) : f.owner.call('skills.copy', { id: row.id, to, ...(action === 'preview' ? { preview: true } : { planId: preview.plan.planId }) });
  // Apply already had a source-bound approval; keep that refusal as a control.
  await assert.rejects(call, action === 'apply' ? /no longer there|could not be read safely|changed since you looked/ : /no longer there|could not be read safely/);
  assert.equal(existsSync(preview.plan.dest), false); assert.deepEqual(snapshot(f.root), before); assert.deepEqual(await f.publicState(), state);
});

test('retargeting a plugin alias to equal bytes inside the plugin still invalidates the old approval', async context => {
  const f = await fixture(context), first = join(f.plugin, 'first'), second = join(f.plugin, 'second'), link = join(f.plugin, 'declared');
  const text = skill(first, 'same', 'OWNED_EQUAL_BYTES'); skill(second, 'same', 'OWNED_EQUAL_BYTES'); symlinkSync(first, link); writeFileSync(f.manifest, JSON.stringify({ skills: ['./declared'] }));
  const row = (await f.all()).find(s => s.plugin === 'owned@fixture'); assert.ok(row); const to = { agent: 'codex' as const };
  const old = await f.owner.call('skills.copy', { id: row.id, to, preview: true }); rmSync(link); symlinkSync(second, link); const before = snapshot(f.root);
  await assert.rejects(f.owner.call('skills.copy', { id: row.id, to, planId: old.plan.planId }), /changed since you looked/); assert.deepEqual(snapshot(f.root), before); assert.equal(existsSync(old.plan.dest), false);
  const fresh = await f.owner.call('skills.copy', { id: row.id, to, preview: true }); assert.notEqual(fresh.plan.planId, old.plan.planId);
  assert.equal((await f.owner.call('skills.copy', { id: row.id, to, planId: fresh.plan.planId })).done, true); assert.equal(readFileSync(join(fresh.plan.dest, 'SKILL.md'), 'utf8'), text); assert.equal(statSync(join(fresh.plan.dest, 'SKILL.md')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(first, 'SKILL.md'), 'utf8'), text); assert.equal(readFileSync(join(second, 'SKILL.md'), 'utf8'), text);
});
