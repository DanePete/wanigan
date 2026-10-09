// Real owner RPCs over tiny owned sources; no model or configured MCP server runs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { CoreOptions } from './core.ts';
import { Core, corePaths } from './core.ts';
import { shellQuote } from './hooks.ts';
import { testCore, type TestCore } from './test-support.ts';

type Kind = 'skills' | 'mcp';
type Limits = NonNullable<CoreOptions['configReadLimits']>;
const refusal = (error: Error & { code?: string }): boolean => error.code === 'refused' && /too large to read completely/.test(error.message);
const skillText = (name: string) => `---\nname: ${name}\ndescription: Owned aggregate fixture.\n---\nInstruction A.\n`;
function snapshot(root: string): object[] {
  const out: object[] = [];
  function visit(path: string): void {
    const st = lstatSync(path); assert.ok(!st.isSymbolicLink());
    const row = { path: relative(root, path), mode: st.mode & 0o777 };
    if (st.isDirectory()) { out.push(row); for (const name of readdirSync(path).sort()) visit(join(path, name)); }
    else { assert.ok(st.isFile()); out.push({ ...row, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }); }
  }
  visit(root); return out;
}
async function fixture(context: TestContext, limits: Limits | ((bytes: Record<Kind, number>) => Limits) = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wg-config-budget-'))), home = join(root, 'home');
  const config = join(home, '.claude'), registry = join(config, 'plugins/installed_plugins.json'), user = join(home, '.claude.json');
  mkdirSync(join(config, 'plugins'), { recursive: true }); mkdirSync(join(home, '.codex'));
  const plugins: Record<string, { installPath: string }[]> = {};
  const manifests: string[] = [], skills: string[] = [];
  const plugin = (name: string): void => {
    const path = join(config, 'plugins/cache', name), skill = join(path, 'skills', name, 'SKILL.md'), manifest = join(path, '.claude-plugin/plugin.json');
    mkdirSync(join(path, '.claude-plugin'), { recursive: true }); mkdirSync(join(path, 'skills', name), { recursive: true });
    writeFileSync(skill, skillText(name)); writeFileSync(manifest, JSON.stringify({ mcpServers: { [name]: { command: 'owned-never-run' } } }));
    plugins[`${name}@owned`] = [{ installPath: path }]; manifests.push(manifest); skills.push(skill);
  };
  plugin('first'); plugin('second');
  const saveRegistry = (): void => { writeFileSync(registry, JSON.stringify({ plugins })); };
  saveRegistry(); writeFileSync(join(config, 'settings.json'), '{}'); writeFileSync(user, '{}'); writeFileSync(join(home, '.codex/config.toml'), '');
  // Two default UUID accounts: id/provider/label/config_dir only (97 UTF-8 bytes).
  // File costs below are literal fixture inputs, not a call to budget code.
  const raw = 97 + [registry, join(config, 'settings.json'), user, ...manifests].reduce((n, file) => n + statSync(file).size, 0);
  const bytes = { mcp: raw, skills: raw + skills.reduce((n, file) => n + statSync(file).size, 0) };
  const calls = join(root, 'unexpected-cli-calls'), binary = join(root, 'never-cli');
  writeFileSync(binary, `#!/bin/sh\nprintf invoked >> ${shellQuote(calls)}\nexit 91\n`, { mode: 0o755 });
  let t: TestCore | undefined;
  context.after(async () => { for (const file of manifests) if (existsSync(file)) chmodSync(file, 0o644); await t?.close(); rmSync(root, { recursive: true, force: true }); });
  t = await testCore({ accounts: { home }, configReadLimits: typeof limits === 'function' ? limits(bytes) : limits,
    mcpBinaries: { claude: binary, codex: binary }, launcher: () => { throw new Error('No session may launch in this fixture'); } });
  const accounts = await t.owner.call('accounts.list', {}); assert.equal(accounts.length, 2);
  assert.equal(accounts.reduce((n, a) => n + Buffer.byteLength(a.id + a.provider + a.label + (a.configDir ?? '')), 0), 97);
  const account = accounts.find(a => a.provider === 'claude'); assert.ok(account);
  const list = (kind: Kind) => kind === 'skills' ? t!.owner.call('skills.list', {}) : t!.owner.call('mcp.list', {});
  const state = async () => ({ projects: await t!.owner.call('projects.list', {}), sessions: await t!.owner.call('sessions.list', {}) });
  const unchangedRead = async (kind: Kind) => {
    const before = snapshot(home), beforeState = await state(), value = await list(kind);
    assert.deepEqual(snapshot(home), before); assert.deepEqual(await state(), beforeState); assert.equal(existsSync(calls), false);
    return value;
  };
  return { ...t, root, home, config, registry, user, plugins, plugin, saveRegistry, manifests, skills, bytes, calls, binary, account, list, state, unchangedRead };
}

for (const kind of ['skills', 'mcp'] as const) test(`${kind}: complete at the read-attempt cap, extra source refused, same Core recovers`, async context => {
  // Skills: registry/settings, two manifests, state, two SKILL.md reads = 7.
  // MCP: state/registry/settings, two inline manifests, empty Codex file = 6.
  const f = await fixture(context, { files: kind === 'skills' ? 7 : 6 });
  const before = await f.unchangedRead(kind);
  const rows = kind === 'skills' ? (await f.owner.call('skills.list', {})).groups.flatMap(g => g.skills)
    : (await f.owner.call('mcp.list', {})).groups.flatMap(g => g.servers);
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.name.includes('first') || row.name.includes('second')));
  f.plugin('third'); f.saveRegistry(); const state = await f.state(), files = snapshot(f.home);
  await assert.rejects(f.list(kind), refusal); assert.deepEqual(snapshot(f.home), files); assert.deepEqual(await f.state(), state);
  delete f.plugins['third@owned']; f.saveRegistry();
  assert.deepEqual(await f.unchangedRead(kind), before); await f.owner.call('core.hello', {});
});

for (const kind of ['skills', 'mcp'] as const) test(`${kind}: one ignored JSON value crosses the exact structural cap`, async context => {
  // MCP parses 19 values: registry8/settings1/manifests8/state1/Codex1.
  // Skills parses the first 18 plus frontmatter6 and roots5. Both admit accounts2.
  const f = await fixture(context, { items: kind === 'skills' ? 31 : 21 });
  const before = await f.unchangedRead(kind); writeFileSync(f.user, '{"ignored":null}');
  const files = snapshot(f.home); await assert.rejects(f.list(kind), refusal); assert.deepEqual(snapshot(f.home), files);
  writeFileSync(f.user, '{}'); assert.deepEqual(await f.unchangedRead(kind), before);
});

for (const kind of ['skills', 'mcp'] as const) test(`${kind}: exact aggregate bytes succeed and one extra byte refuses without partial output`, async context => {
  const f = await fixture(context, bytes => ({ bytes: bytes[kind] }));
  const before = await f.unchangedRead(kind), original = readFileSync(f.manifests[0]!, 'utf8');
  writeFileSync(f.manifests[0]!, original + ' '); const files = snapshot(f.home);
  await assert.rejects(f.list(kind), refusal); assert.deepEqual(snapshot(f.home), files);
  writeFileSync(f.manifests[0]!, original); assert.deepEqual(await f.unchangedRead(kind), before);
});

for (const kind of ['skills', 'mcp'] as const) test(`${kind}: root metadata is admitted, while unused account identity does not consume read bytes`, async context => {
  const f = await fixture(context, bytes => ({ bytes: bytes[kind] }));
  f.core.db.prepare('UPDATE accounts SET identity = ?').run('owned-unused-identity@' + 'x'.repeat(32_000));
  const before = await f.unchangedRead(kind);
  f.core.db.prepare('UPDATE accounts SET label = label || ? WHERE id = ?').run('x', f.account.id);
  await assert.rejects(f.list(kind), refusal);
  f.core.db.prepare('UPDATE accounts SET label = ? WHERE id = ?').run('Default', f.account.id);
  assert.deepEqual(await f.unchangedRead(kind), before);
  assert.equal((f.core.db.prepare('SELECT identity FROM accounts LIMIT 1').get() as { identity: string }).identity.length, 32_022);
});

test('ignored directory entries count before sorting; cap+1 refuses and removal recovers', async context => {
  const f = await fixture(context, { entries: 5 });
  const dir = join(f.config, 'plugins/cache/first/skills'), one = join(dir, '.ignored-one'), two = join(dir, '.ignored-two');
  writeFileSync(one, ''); const before = await f.unchangedRead('skills'); // two root entries + two SKILL.md entries + ignored one
  writeFileSync(two, ''); const files = snapshot(f.home);
  await assert.rejects(f.list('skills'), refusal); assert.deepEqual(snapshot(f.home), files);
  rmSync(two); assert.deepEqual(await f.unchangedRead('skills'), before);
});

for (const problem of ['malformed', 'permission'] as const) test(`ordinary ${problem} plugin source retains healthy peers under the aggregate guard`, async context => {
  const f = await fixture(context), file = f.manifests[0]!, original = readFileSync(file, 'utf8');
  const before = await f.unchangedRead('mcp');
  try {
    if (problem === 'malformed') writeFileSync(file, '{OWNED_INVALID_JSON');
    else { chmodSync(file, 0); assert.throws(() => readFileSync(file), (e: NodeJS.ErrnoException) => e.code === 'EACCES'); }
    const list = await f.owner.call('mcp.list', {}), rows = list.groups.flatMap(g => g.servers);
    assert.deepEqual(rows.map(row => row.name), ['plugin:second:second']);
    assert.match(list.groups.find(g => g.agent === 'claude')?.note ?? '', /could not read some plugin servers/);
    assert.equal(JSON.stringify(list).includes('OWNED_INVALID_JSON'), false);
    assert.equal((await f.owner.call('skills.list', {})).groups.flatMap(g => g.skills).length, 2, 'default contained skill directories retain their existing contract');
    assert.equal(existsSync(f.calls), false);
  } finally { chmodSync(file, 0o644); writeFileSync(file, original); }
  assert.deepEqual(await f.unchangedRead('mcp'), before);
});

test('late discovery refusal blocks read and copy; recovery retains exact content approval', async context => {
  const f = await fixture(context, { entries: 4 });
  const skill = (await f.owner.call('skills.list', {})).groups.flatMap(g => g.skills).find(s => s.name === 'first'); assert.ok(skill);
  const to = { agent: 'codex' as const }, dest = join(f.home, '.agents/skills/first');
  const preview = await f.owner.call('skills.copy', { id: skill.id, to, preview: true });
  const extra = join(f.config, 'plugins/cache/second/skills/.ignored'); writeFileSync(extra, '');
  await assert.rejects(f.owner.call('skills.read', { id: skill.id }), refusal);
  await assert.rejects(f.owner.call('skills.copy', { id: skill.id, to, planId: preview.plan.planId }), refusal);
  assert.equal(existsSync(dest), false); rmSync(extra);
  assert.equal((await f.owner.call('skills.copy', { id: skill.id, to, preview: true })).plan.planId, preview.plan.planId);
  const file = f.skills[0]!, st = statSync(file), original = readFileSync(file, 'utf8');
  writeFileSync(file, original.replace('Instruction A.', 'Instruction B.')); utimesSync(file, st.atime, st.mtime);
  assert.equal(statSync(file).size, st.size);
  await assert.rejects(f.owner.call('skills.copy', { id: skill.id, to, planId: preview.plan.planId }), /changed since you looked/);
  assert.equal(existsSync(dest), false);
  const fresh = await f.owner.call('skills.copy', { id: skill.id, to, preview: true }); assert.notEqual(fresh.plan.planId, preview.plan.planId);
  assert.equal((await f.owner.call('skills.copy', { id: skill.id, to, planId: fresh.plan.planId })).done, true);
  assert.equal(readFileSync(join(dest, 'SKILL.md'), 'utf8'), original.replace('Instruction A.', 'Instruction B.'));
});

test('late discovery refusal cannot remove an earlier personal skill', async context => {
  const f = await fixture(context, { entries: 6 }), personal = join(f.config, 'skills/owned-personal');
  mkdirSync(personal, { recursive: true }); writeFileSync(join(personal, 'SKILL.md'), skillText('owned-personal'));
  const skill = (await f.owner.call('skills.list', {})).groups.flatMap(g => g.skills).find(s => s.dir === personal); assert.ok(skill);
  const extra = join(f.config, 'plugins/cache/second/skills/.ignored'); writeFileSync(extra, ''); const files = snapshot(f.home);
  await assert.rejects(f.owner.call('skills.remove', { id: skill.id }), refusal); assert.deepEqual(snapshot(f.home), files);
  rmSync(extra); assert.equal((await f.owner.call('skills.remove', { id: skill.id })).removed, skill.displayDir);
  assert.equal(existsSync(personal), false);
});

test('MCP preflight exhaustion refuses before dispatch and a scoped preview can recover', async context => {
  const f = await fixture(context, { items: 1 });
  await assert.rejects(f.owner.call('mcp.add', { catalogId: 'playwright', accountId: f.account.id, scope: 'user' }), refusal);
  assert.equal(existsSync(f.calls), false); assert.equal(readFileSync(f.user, 'utf8'), '{}');
  rmSync(f.user);
  const result = await f.owner.call('mcp.add', { catalogId: 'playwright', accountId: f.account.id, scope: 'user', preview: true });
  assert.equal(result.done, false); assert.equal(result.plan.exists, false); assert.equal(existsSync(f.calls), false);
});

test('MCP post-command exhaustion reports possible change, never successful verification', async context => {
  const f = await fixture(context, { files: 1 });
  const changed = '{"mcpServers":{"playwright":{"command":"owned-never-run"}}}';
  writeFileSync(f.binary, `#!/bin/sh\n[ "$1" = mcp ] && [ "$2" = add ] || exit 92\nprintf invoked >> ${shellQuote(f.calls)}\nprintf '%s' ${shellQuote(changed)} > ${shellQuote(f.user)}\n`, { mode: 0o755 });
  await assert.rejects(f.owner.call('mcp.add', { catalogId: 'playwright', accountId: f.account.id, scope: 'user' }),
    (error: Error & { code?: string }) => error.code === 'refused' && /could not verify.*command may have changed/i.test(error.message));
  assert.equal(readFileSync(f.calls, 'utf8'), 'invoked'); assert.equal(readFileSync(f.user, 'utf8'), changed);
  const recovered = await f.owner.call('mcp.add', { catalogId: 'playwright', accountId: f.account.id, scope: 'user', preview: true });
  assert.equal(recovered.plan.exists, true); assert.equal(recovered.done, false); assert.equal(readFileSync(f.calls, 'utf8'), 'invoked');
});

test('constructor limits are finite positive integers and cannot raise shipped caps', async context => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wg-config-limit-options-'))); context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [key, value] of [['files', 0], ['bytes', 0.5], ['items', NaN], ['entries', Infinity], ['files', 4_097], ['bytes', 128 * 1024 * 1024 + 1], ['items', 32_769], ['entries', 65_537]] as const) {
    let core: Core | undefined;
    const dataDir = join(root, key + String(value)), socketDir = dirname(corePaths(dataDir).socket);
    assert.equal(existsSync(dataDir), false); assert.equal(existsSync(socketDir), false);
    try {
      assert.throws(() => { core = new Core({ dataDir, accounts: { home: root }, configReadLimits: { [key]: value } }); }, /Invalid configuration/);
      assert.equal(existsSync(dataDir), false, 'invalid options must be refused before creating the data directory');
      assert.equal(existsSync(socketDir), false, 'invalid options must be refused before creating a separate socket directory');
    } finally { await core?.stop(); }
  }
});

test('Codex built-in and plugin-cache skills stay excluded beside an ordinary owned skill', async context => {
  const f = await fixture(context);
  for (const folder of ['skills/visible', 'skills/.system/owned-system', 'plugins/cache/owned/skills/owned-plugin']) {
    const dir = join(f.home, '.codex', folder); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'SKILL.md'), skillText(folder.split('/').pop()!));
  }
  const names = (await f.owner.call('skills.list', {})).groups.flatMap(g => g.skills).map(s => s.name).sort();
  assert.deepEqual(names, ['first', 'second', 'visible']); assert.equal(existsSync(f.calls), false);
});
