// Audit-only owner outcomes against owned Claude JSON and an explicit stand-in.
// No installed provider, real account, configured MCP command or network is used.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { shellQuote } from './hooks.ts';
import { testCore, type TestCore } from './test-support.ts';

const CONFIG = JSON.stringify({ sentinel: 'owned-config', mcpServers: { owned: { command: 'owned-never-started-server', args: [] } } });
const MALFORMED = '{"mcpServers":{"owned":{"command":"owned-never-started-server"}},"invented":';

async function fixture(context: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wg-claude-read-')));
  const home = join(root, 'home'), accountHome = join(home, '.claude_probe');
  mkdirSync(accountHome, { recursive: true });
  const ownedProjectDir = join(root, 'project'); mkdirSync(ownedProjectDir);
  const config = join(accountHome, '.claude.json'), log = join(root, 'calls.jsonl'), mode = join(root, 'mode');
  writeFileSync(join(accountHome, 'settings.json'), '{}');
  writeFileSync(config, CONFIG, { mode: 0o600 });
  writeFileSync(mode, 'noop');
  let t: TestCore | undefined;
  context.after(async () => {
    chmodSync(config, 0o600);
    await t?.close();
    rmSync(root, { recursive: true, force: true });
  });
  const script = join(root, 'stand-in.mjs'), binary = join(root, 'owned-claude');
  writeFileSync(script, `import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
assert.equal(process.env.CLAUDE_CONFIG_DIR, ${JSON.stringify(accountHome)});
const argv = process.argv.slice(2), mode = readFileSync(${JSON.stringify(mode)}, 'utf8');
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, account: process.env.CLAUDE_CONFIG_DIR, cwd: process.cwd(), mode }) + '\\n');
if (argv[1] === 'add') { assert.equal(argv[0], 'mcp'); process.exit(0); }
assert.equal(argv[0], 'mcp'); assert.equal(argv[1], 'remove'); assert.equal(argv[2], 'owned'); assert.equal(argv[3], '--scope');
assert.ok(['user', 'local', 'project'].includes(argv[4]));
const target = argv[4] === 'project' ? ${JSON.stringify(join(ownedProjectDir, '.mcp.json'))} : ${JSON.stringify(config)};
if (mode === 'remove' || mode === 'remove-signal') writeFileSync(target, '{}');
if (mode === 'malformed-zero') writeFileSync(target, ${JSON.stringify(MALFORMED)});
if (mode === 'unreadable-zero' || mode === 'unreadable-signal') chmodSync(target, 0);
if (mode === 'unreadable-signal' || mode === 'remove-signal') process.kill(process.pid, 'SIGTERM'); else process.exit(0);
`);
  writeFileSync(binary, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`, { mode: 0o755 });
  t = await testCore({ accounts: { home }, mcpBinaries: { claude: binary } });
  await t.core.accounts.refresh();
  const account = (await t.owner.call('accounts.list', {})).find(a => a.configDir === accountHome);
  assert.ok(account); assert.equal(account.provider, 'claude');
  const listing = await t.owner.call('mcp.list', {});
  const group = listing.groups.find(g => g.servers.some(s => s.accountId === account.id && s.name === 'owned'));
  assert.ok(group);
  const server = group.servers.find(s => s.accountId === account.id && s.name === 'owned')!;
  assert.equal(server.scope, 'user'); assert.equal(server.removable, true);
  const snapshot = () => ({ sessions: t!.core.db.prepare('SELECT * FROM sessions ORDER BY id').all(), cards: t!.core.db.prepare('SELECT * FROM cards ORDER BY id').all(), projects: t!.core.db.prepare('SELECT * FROM projects ORDER BY id').all(), projectAccounts: t!.core.db.prepare('SELECT * FROM project_accounts ORDER BY project_id, provider').all(), activity: t!.core.db.prepare('SELECT * FROM activity ORDER BY id').all() });
  const before = snapshot();
  const calls = (): { argv: string[]; account: string; cwd: string; mode: string }[] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(x => JSON.parse(x)) : [];
  const restored = async () => {
    chmodSync(config, 0o600); writeFileSync(config, CONFIG);
    const again = await t!.owner.call('mcp.list', {});
    assert.ok(again.groups.some(g => g.servers.some(s => s.id === server.id)), 'repair restores the same actual configured server');
    assert.deepEqual(snapshot(), before); await t!.owner.call('core.hello', {});
  };
  return { ...t, root, home, accountHome, ownedProjectDir, config, log, mode, account, group, server, calls, snapshot, before, restored };
}

function report(context: TestContext, name: string, value: unknown): void {
  context.diagnostic(JSON.stringify(value));
  const destination = process.env.WG_CLAUDE_MCP_EVIDENCE;
  if (destination) writeFileSync(join(destination, name + '.json'), JSON.stringify(value, null, 2) + '\n');
}

test('Claude listing reports an existing unreadable account as unknown rather than empty', async context => {
  const t = await fixture(context);
  chmodSync(t.config, 0);
  assert.throws(() => readFileSync(t.config), (e: NodeJS.ErrnoException) => e.code === 'EACCES');
  const listing = await t.owner.call('mcp.list', {}), group = listing.groups.find(g => g.id === t.group.id);
  const empty = listing.empty.some(e => e.agent === 'claude' && e.where === t.group.where);
  chmodSync(t.config, 0o600); assert.equal(readFileSync(t.config, 'utf8'), CONFIG);
  assert.equal(t.calls().length, 0); await t.restored();
  report(context, 'list-unreadable', { actualEacces: true, empty, note: group?.note ?? null, repairedServer: true, bytesAndRowsPreserved: true, cliCalls: 0 });
  assert.equal(empty, false); assert.match(group?.note ?? '', /could not read/i);
});

test('Claude listing reports malformed JSON as unknown rather than empty', async context => {
  const t = await fixture(context);
  writeFileSync(t.config, MALFORMED);
  const listing = await t.owner.call('mcp.list', {}), group = listing.groups.find(g => g.id === t.group.id);
  const empty = listing.empty.some(e => e.agent === 'claude' && e.where === t.group.where);
  assert.equal(readFileSync(t.config, 'utf8'), MALFORMED); assert.equal(t.calls().length, 0);
  await t.restored();
  report(context, 'list-malformed', { empty, note: group?.note ?? null, malformedBytesUnchangedByRpc: true, repairedServer: true, rowsPreserved: true, cliCalls: 0 });
  assert.equal(empty, false); assert.match(group?.note ?? '', /could not read/i);
});

for (const mode of ['unreadable-zero', 'unreadable-signal']) test(`Claude removal refuses an unknown postcondition after ${mode}`, async context => {
  const t = await fixture(context);
  writeFileSync(t.mode, mode);
  const result = await t.owner.call('mcp.remove', { id: t.server.id }).then(value => ({ ok: true as const, value }), (e: Error & { code?: string }) => ({ ok: false as const, error: e.message, code: e.code }));
  assert.throws(() => readFileSync(t.config), (e: NodeJS.ErrnoException) => e.code === 'EACCES');
  const calls = t.calls(); assert.equal(calls.length, 1); const call = calls[0]; assert.ok(call);
  assert.deepEqual(call.argv, ['mcp', 'remove', 'owned', '--scope', 'user']);
  assert.equal(call.account, t.account.configDir);
  chmodSync(t.config, 0o600); assert.equal(readFileSync(t.config, 'utf8'), CONFIG); await t.restored();
  report(context, mode, { result, calls, actualEacces: true, sourceStillConfigured: true, exactBytesAndRowsPreserved: true, repairedServer: true });
  assert.equal(result.ok, false, 'an unknown read cannot prove successful removal');
});

test('an unreadable Claude configuration refuses add before starting the CLI', async context => {
  const t = await fixture(context);
  chmodSync(t.config, 0); assert.throws(() => readFileSync(t.config), (e: NodeJS.ErrnoException) => e.code === 'EACCES');
  const result = await t.owner.call('mcp.add', { catalogId: 'playwright', accountId: t.account.id, scope: 'user' }).then(value => ({ ok: true, done: value.done }), (e: Error) => ({ ok: false, error: e.message }));
  const calls = t.calls();
  chmodSync(t.config, 0o600); assert.equal(readFileSync(t.config, 'utf8'), CONFIG); await t.restored();
  report(context, 'add-unreadable', { result, calls, actualEacces: true, bytesAndRowsPreserved: true, repairedServer: true });
  assert.equal(result.ok, false); assert.equal(calls.length, 0, 'unknown configuration must refuse before CLI dispatch');
});

test('Claude readable listing, no-op refusal and verified empty removal remain healthy', async context => {
  const t = await fixture(context);
  assert.equal(t.calls().length, 0);
  await assert.rejects(t.owner.call('mcp.remove', { id: t.server.id }), /did not make the change/);
  assert.equal(readFileSync(t.config, 'utf8'), CONFIG); assert.deepEqual(t.snapshot(), t.before);
  writeFileSync(t.mode, 'remove');
  const result = await t.owner.call('mcp.remove', { id: t.server.id }); assert.equal(result.done, true);
  assert.equal(readFileSync(t.config, 'utf8'), '{}'); assert.deepEqual(t.snapshot(), t.before);
  const listing = await t.owner.call('mcp.list', {});
  assert.ok(listing.empty.some(e => e.agent === 'claude' && e.where === t.group.where));
  assert.equal(t.calls().length, 2); await t.restored();
  report(context, 'healthy', { readableListingNoCli: true, noOpRefused: true, actualRemovalConfirmed: true, actualEmptyListed: true, rowsPreserved: true, repairedServer: true });
});

for (const text of ['null', '[]', '"invented-private-root-value"', '{"value":invented-private-bare-value}']) test(`Claude rejects invalid top-level JSON without quoting its contents: ${text[0]}`, async context => {
  const t = await fixture(context); writeFileSync(t.config, text);
  const listing = await t.owner.call('mcp.list', {}), group = listing.groups.find(g => g.id === t.group.id);
  const empty = listing.empty.some(e => e.agent === 'claude' && e.where === t.group.where);
  assert.equal(readFileSync(t.config, 'utf8'), text); assert.equal(t.calls().length, 0); await t.restored();
  assert.equal(empty, false); assert.match(group?.note ?? '', /could not read.*invalid JSON object/i);
  assert.ok(group!.note!.length < 200); assert.doesNotMatch(group!.note!, /invented-private/);
});

test('Claude genuine missing and valid empty files remain known absence without CLI calls', async context => {
  const t = await fixture(context);
  for (const missing of [true, false]) {
    if (missing) rmSync(t.config); else writeFileSync(t.config, '{}');
    const listing = await t.owner.call('mcp.list', {});
    assert.ok(listing.empty.some(e => e.agent === 'claude' && e.where === t.group.where));
    const preview = await t.owner.call('mcp.add', { catalogId: 'playwright', accountId: t.account.id, scope: 'user', preview: true });
    assert.equal(preview.plan.exists, false); assert.equal(preview.done, false);
    assert.equal(existsSync(t.config), !missing); if (!missing) assert.equal(readFileSync(t.config, 'utf8'), '{}');
  }
  assert.equal(t.calls().length, 0); writeFileSync(t.config, CONFIG); await t.restored();
});

test('Claude verifies real removal after a null exit rather than changing the signal policy', async context => {
  const t = await fixture(context); writeFileSync(t.mode, 'remove-signal');
  const result = await t.owner.call('mcp.remove', { id: t.server.id });
  assert.equal(result.done, true); assert.equal(readFileSync(t.config, 'utf8'), '{}'); assert.equal(t.calls().length, 1);
  assert.ok((await t.owner.call('mcp.list', {})).empty.some(e => e.agent === 'claude' && e.where === t.group.where));
  await t.restored();
});

test('Claude refuses malformed post-remove JSON despite a successful CLI exit', async context => {
  const t = await fixture(context); writeFileSync(t.mode, 'malformed-zero');
  const result = await t.owner.call('mcp.remove', { id: t.server.id }).then(() => null, (e: Error) => e.message);
  assert.equal(readFileSync(t.config, 'utf8'), MALFORMED); assert.equal(t.calls().length, 1); await t.restored();
  assert.match(result ?? '', /could not verify.*invalid JSON object/i);
});

test('Claude healthy config symlinks and regular legacy-file preference stay supported', async context => {
  const t = await fixture(context), target = join(t.root, 'linked.json');
  writeFileSync(target, CONFIG); rmSync(t.config); symlinkSync(target, t.config);
  assert.ok((await t.owner.call('mcp.list', {})).groups.some(g => g.servers.some(s => s.id === t.server.id)));
  assert.equal(readFileSync(target, 'utf8'), CONFIG);
  const legacy = join(t.accountHome, '.config.json');
  const legacyBytes = JSON.stringify({ mcpServers: { legacy: { command: 'owned-legacy-never-run' } } });
  writeFileSync(legacy, legacyBytes);
  const listing = await t.owner.call('mcp.list', {}), accountServers = listing.groups.flatMap(g => g.servers).filter(s => s.accountId === t.account.id);
  assert.deepEqual(accountServers.map(s => s.name), ['legacy']); const selected = accountServers[0]; assert.ok(selected); assert.ok(selected.definedIn.endsWith('/.config.json'));
  assert.equal(readFileSync(legacy, 'utf8'), legacyBytes); assert.equal(readFileSync(target, 'utf8'), CONFIG);
  rmSync(legacy); assert.equal(t.calls().length, 0); await t.restored();
});

for (const fault of ['unreadable', 'malformed']) test(`Claude project ${fault} JSON is visible and refuses add before dispatch, preserving healthy account rows`, async context => {
  const t = await fixture(context), file = join(t.ownedProjectDir, '.mcp.json');
  writeFileSync(file, CONFIG);
  const project = await openProject(t);
  const listing = await t.owner.call('mcp.list', {}), group = listing.groups.find(g => g.servers.some(s => s.scope === 'project' && s.projectId === project.id));
  assert.ok(group); const source = readFileSync(file), before = t.snapshot();
  {
    if (fault === 'unreadable') { chmodSync(file, 0); assert.throws(() => readFileSync(file), (e: NodeJS.ErrnoException) => e.code === 'EACCES'); }
    else writeFileSync(file, MALFORMED);
    const bad = await t.owner.call('mcp.list', {}), badGroup = bad.groups.find(g => g.id === group.id);
    const result = await t.owner.call('mcp.add', { catalogId: 'playwright', accountId: t.account.id, scope: 'project', projectId: project.id }).then(() => null, (e: Error) => e.message);
    chmodSync(file, 0o600); assert.deepEqual(readFileSync(file), fault === 'unreadable' ? source : Buffer.from(MALFORMED));
    writeFileSync(file, source); assert.deepEqual(t.snapshot(), before);
    assert.ok(bad.groups.some(g => g.servers.some(s => s.id === t.server.id)), 'independent healthy account row survives');
    assert.equal(t.calls().length, 0); assert.match(badGroup?.note ?? '', /could not read/i); assert.match(result ?? '', /could not verify/i);
  }
  const repaired = await t.owner.call('mcp.list', {}); assert.ok(repaired.groups.some(g => g.id === group.id && g.servers.some(s => s.scope === 'project')));
  assert.deepEqual(readFileSync(file), source); assert.equal(readFileSync(t.config, 'utf8'), CONFIG); assert.deepEqual(t.snapshot(), before);
});

test('an unknown account keeps its note alongside healthy disabled-plugin and project rows and refuses local add', async context => {
  const t = await fixture(context), projectFile = join(t.ownedProjectDir, '.mcp.json');
  writeFileSync(projectFile, CONFIG);
  const project = await openProject(t);
  const config = JSON.stringify({ ...JSON.parse(CONFIG), projects: { [t.ownedProjectDir]: { mcpServers: { local: { command: 'owned-local-never-run' } } } } });
  writeFileSync(t.config, config);
  const plugin = join(t.accountHome, 'plugins/cache/owned'), pluginFile = join(plugin, '.mcp.json'); mkdirSync(plugin, { recursive: true });
  const pluginBytes = JSON.stringify({ kept: { command: 'owned-plugin-never-run' } }); writeFileSync(pluginFile, pluginBytes);
  const installed = join(t.accountHome, 'plugins/installed_plugins.json'), installedBytes = JSON.stringify({ plugins: { 'owned@fixture': [{ installPath: plugin }] } });
  const settings = join(t.accountHome, 'settings.json'), settingsBytes = JSON.stringify({ enabledPlugins: { 'owned@fixture': false } });
  writeFileSync(installed, installedBytes); writeFileSync(settings, settingsBytes);
  const initial = await t.owner.call('mcp.list', {}), servers = initial.groups.flatMap(g => g.servers);
  assert.ok(servers.some(s => s.scope === 'local' && s.name === 'local' && s.projectId === project.id));
  const pluginServer = servers.find(s => s.scope === 'plugin' && s.name === 'plugin:owned:kept'); assert.ok(pluginServer); assert.equal(pluginServer.enabled, false);
  const before = t.snapshot(); writeFileSync(t.config, MALFORMED);
  const bad = await t.owner.call('mcp.list', {}), group = bad.groups.find(g => g.id === t.group.id);
  const result = await t.owner.call('mcp.add', { catalogId: 'playwright', accountId: t.account.id, scope: 'local', projectId: project.id }).then(() => null, (e: Error) => e.message);
  assert.equal(readFileSync(t.config, 'utf8'), MALFORMED); writeFileSync(t.config, config);
  assert.deepEqual(t.snapshot(), before); assert.equal(readFileSync(projectFile, 'utf8'), CONFIG); assert.equal(readFileSync(pluginFile, 'utf8'), pluginBytes);
  assert.equal(readFileSync(installed, 'utf8'), installedBytes); assert.equal(readFileSync(settings, 'utf8'), settingsBytes);
  assert.equal(bad.empty.some(e => e.agent === 'claude' && e.where === t.group.where), false);
  assert.deepEqual(group?.servers.find(s => s.id === pluginServer.id), pluginServer); assert.match(group?.note ?? '', /could not read/i);
  assert.ok(bad.groups.some(g => g.servers.some(s => s.scope === 'project' && s.projectId === project.id)));
  assert.equal(t.calls().length, 0); assert.match(result ?? '', /could not verify/i);
  const restored = await t.owner.call('mcp.list', {}); assert.ok(restored.groups.flatMap(g => g.servers).some(s => s.scope === 'local' && s.name === 'local'));
});

async function openProject(t: Awaited<ReturnType<typeof fixture>>) {
  const project = await t.owner.call('projects.add', { path: t.ownedProjectDir });
  await t.owner.call('projects.setAccount', { id: project.id, provider: 'claude', accountId: t.account.id });
  return project;
}

function fileHash(file: string): string {
  const fd = openSync(file, 'r'), hash = createHash('sha256'), chunk = Buffer.alloc(64 * 1024);
  try { for (;;) { const n = readSync(fd, chunk, 0, chunk.length, null); if (!n) return hash.digest('hex'); hash.update(chunk.subarray(0, n)); } }
  finally { closeSync(fd); }
}

test('Claude preserves the 64 MiB account cap and refuses an oversized sparse file without treating it as empty', async context => {
  const t = await fixture(context); truncateSync(t.config, 64 * 1024 * 1024 + 1); const before = fileHash(t.config);
  const listing = await t.owner.call('mcp.list', {}), group = listing.groups.find(g => g.id === t.group.id);
  assert.equal(statSync(t.config).size, 64 * 1024 * 1024 + 1); assert.equal(fileHash(t.config), before); assert.equal(t.calls().length, 0); await t.restored();
  assert.equal(listing.empty.some(e => e.agent === 'claude' && e.where === t.group.where), false); assert.match(group?.note ?? '', /larger than 64 MB/);
});

test('Claude project exact 4 MiB JSON remains valid while 4 MiB plus one is unknown', async context => {
  const t = await fixture(context), file = join(t.ownedProjectDir, '.mcp.json');
  const bytes = CONFIG + ' '.repeat(4 * 1024 * 1024 - Buffer.byteLength(CONFIG)); writeFileSync(file, bytes);
  const project = await openProject(t), before = t.snapshot();
  const valid = await t.owner.call('mcp.list', {}), group = valid.groups.find(g => g.servers.some(s => s.scope === 'project' && s.projectId === project.id)); assert.ok(group);
  const hash = fileHash(file); assert.equal(statSync(file).size, 4 * 1024 * 1024);
  writeFileSync(file, bytes + ' '); const tooLarge = await t.owner.call('mcp.list', {}), badGroup = tooLarge.groups.find(g => g.id === group.id);
  assert.equal(readFileSync(file, 'utf8'), bytes + ' '); writeFileSync(file, bytes); assert.equal(fileHash(file), hash); assert.deepEqual(t.snapshot(), before); assert.equal(t.calls().length, 0);
  assert.match(badGroup?.note ?? '', /larger than 4 MB/);
});

for (const scope of ['local', 'project'] as const) test(`Claude ${scope} removal refuses an unreadable postcondition and preserves exact source and rows`, async context => {
  const t = await fixture(context), project = await openProject(t);
  const file = scope === 'project' ? join(t.ownedProjectDir, '.mcp.json') : t.config;
  const bytes = scope === 'project' ? CONFIG : JSON.stringify({ projects: { [t.ownedProjectDir]: { mcpServers: { owned: { command: 'owned-local-never-run' } } } } });
  writeFileSync(file, bytes);
  const listing = await t.owner.call('mcp.list', {}), server = listing.groups.flatMap(g => g.servers).find(s => s.scope === scope && s.projectId === project.id && s.name === 'owned');
  assert.ok(server); assert.equal(server.removable, true);
  const preview = await t.owner.call('mcp.remove', { id: server.id, preview: true });
  assert.equal(preview.plan.env?.value, t.account.configDir);
  const before = t.snapshot(); writeFileSync(t.mode, 'unreadable-zero');
  const result = await t.owner.call('mcp.remove', { id: server.id }).then(value => ({ done: value.done, error: '' }), (e: Error) => ({ done: false, error: e.message }));
  assert.throws(() => readFileSync(file), (e: NodeJS.ErrnoException) => e.code === 'EACCES'); chmodSync(file, 0o600); assert.equal(readFileSync(file, 'utf8'), bytes);
  const calls = t.calls(); assert.equal(calls.length, 1); const call = calls[0]; assert.ok(call); assert.deepEqual(call.argv, ['mcp', 'remove', 'owned', '--scope', scope]); assert.equal(call.cwd, t.ownedProjectDir);
  const repaired = await t.owner.call('mcp.list', {}); assert.ok(repaired.groups.some(g => g.servers.some(s => s.id === server.id)));
  assert.equal(result.done, false); assert.match(result.error, /could not verify/i); assert.deepEqual(t.snapshot(), before);
});

test('a non-regular Claude JSON source is unknown and repair restores the same server', async context => {
  const t = await fixture(context); rmSync(t.config); mkdirSync(t.config);
  const listing = await t.owner.call('mcp.list', {}), group = listing.groups.find(g => g.id === t.group.id);
  assert.equal(statSync(t.config).isDirectory(), true); assert.deepEqual(t.snapshot(), t.before); assert.equal(t.calls().length, 0);
  rmSync(t.config, { recursive: true }); writeFileSync(t.config, CONFIG); await t.restored();
  assert.equal(listing.empty.some(e => e.agent === 'claude' && e.where === t.group.where), false); assert.match(group?.note ?? '', /not a regular file/);
});

test('an unknown Claude account refuses the add-terminal plan without creating a session', async context => {
  const t = await fixture(context), project = await openProject(t), before = t.snapshot();
  const sessions = await t.owner.call('sessions.list', {}); writeFileSync(t.config, MALFORMED);
  const result = await t.owner.call('mcp.terminal', { catalogId: 'github', accountId: t.account.id, scope: 'user', hostProjectId: project.id }).then(() => null, (e: Error) => e.message);
  assert.equal(readFileSync(t.config, 'utf8'), MALFORMED); assert.equal(t.calls().length, 0);
  writeFileSync(t.config, CONFIG);
  assert.match(result ?? '', /could not verify/i);
  assert.deepEqual(await t.owner.call('sessions.list', {}), sessions); assert.deepEqual(t.snapshot(), before);
});
