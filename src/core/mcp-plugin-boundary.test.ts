// Owner RPCs over owned files. No real provider, account, server or network call.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { testCore, type TestCore } from './test-support.ts';
import { shellQuote } from './hooks.ts';

const spec = (name: string) => ({ [name]: { command: 'owned-never-run', args: [name] } });
function snapshot(root: string): object[] {
  const rows: object[] = [];
  const walk = (path: string): void => {
    const st = lstatSync(path), record = { path: relative(root, path), mode: st.mode & 0o777 };
    if (st.isSymbolicLink()) rows.push({ ...record, type: 'link', target: readlinkSync(path) });
    else if (st.isDirectory()) { rows.push({ ...record, type: 'directory' }); for (const name of readdirSync(path).sort()) walk(join(path, name)); }
    else if (st.isFIFO()) rows.push({ ...record, type: 'fifo' });
    else { assert.ok(st.isFile()); rows.push({ ...record, type: 'file', sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }); }
  };
  walk(root); return rows;
}
async function fixture(context: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wg-plugin-boundary-'))), home = join(root, 'home');
  const claudeHome = join(home, '.claude'), plugin = join(claudeHome, 'plugins/cache/owned/v1'), outside = join(root, 'owned-outside');
  const sibling = join(claudeHome, 'plugins/cache/sibling/v1');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true }); mkdirSync(sibling, { recursive: true }); mkdirSync(outside); mkdirSync(join(home, '.codex'));
  const userFile = join(home, '.claude.json'), pluginFile = join(plugin, '.mcp.json'), manifestFile = join(plugin, '.claude-plugin/plugin.json');
  writeFileSync(join(claudeHome, 'settings.json'), '{}'); writeFileSync(userFile, JSON.stringify({ mcpServers: spec('owned-user-healthy') }));
  writeFileSync(pluginFile, JSON.stringify(spec('owned-plugin-healthy'))); writeFileSync(manifestFile, '{}');
  writeFileSync(join(sibling, '.mcp.json'), JSON.stringify(spec('owned-sibling-healthy')));
  writeFileSync(join(claudeHome, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'owned@fixture': [{ installPath: plugin }], 'sibling@fixture': [{ installPath: sibling }] } }));
  writeFileSync(join(home, '.codex/config.toml'), '[mcp_servers.healthy]\ncommand="owned-never-run"\n');
  const callLog = join(root, 'unexpected-cli-calls'), binary = join(root, 'never-cli');
  writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(callLog)}\nexit 95\n`, { mode: 0o755 });
  const claudeMode = lstatSync(claudeHome).mode & 0o777;
  let t: TestCore | undefined;
  context.after(async () => { chmodSync(claudeHome, claudeMode); await t?.close(); rmSync(root, { recursive: true, force: true }); });
  t = await testCore({ accounts: { home }, mcpBinaries: { claude: binary, codex: binary }, launcher: () => { throw new Error('This fixture must not launch a session'); } });
  await t.core.accounts.refresh();
  const account = (await t.owner.call('accounts.list', {})).find(a => a.provider === 'claude' && a.configDir === null); assert.ok(account);
  const listing = await t.owner.call('mcp.list', {}), group = listing.groups.find(g => g.servers.some(s => s.accountId === account.id && s.name === 'owned-user-healthy')); assert.ok(group);
  const publicState = async () => ({ projects: await t!.owner.call('projects.list', {}), sessions: await t!.owner.call('sessions.list', {}) });
  return { ...t, root, home, claudeHome, claudeMode, plugin, outside, userFile, pluginFile, manifestFile, account, group, callLog, publicState };
}

for (const route of ['root-mcp', 'declared-mcp', 'manifest'] as const) test(`plugin ${route}: an outside file link is unknown without hiding healthy sources`, async context => {
  const f = await fixture(context), external = join(f.outside, route + '.json'), marker = 'OWNED_OUTSIDE_' + route;
  writeFileSync(external, JSON.stringify(route === 'manifest' ? { mcpServers: spec(marker) } : spec(marker)));
  let link = f.pluginFile;
  if (route === 'declared-mcp') { link = join(f.plugin, 'declared.json'); writeFileSync(f.manifestFile, JSON.stringify({ mcpServers: 'declared.json' })); }
  else if (route === 'manifest') link = f.manifestFile;
  if (existsSync(link)) rmSync(link); symlinkSync(external, link);
  assert.equal(realpathSync(link), external);
  const before = snapshot(f.root), state = await f.publicState(), listed = await f.owner.call('mcp.list', {});
  const group = listed.groups.find(g => g.id === f.group.id); assert.ok(group);
  assert.ok(group.servers.some(s => s.name === 'owned-user-healthy'));
  assert.ok(group.servers.some(s => s.name === 'plugin:sibling:owned-sibling-healthy'));
  assert.ok(listed.groups.some(g => g.agent === 'codex' && g.servers.some(s => s.name === 'healthy')));
  assert.deepEqual(snapshot(f.root), before); assert.deepEqual(await f.publicState(), state); assert.equal(existsSync(f.callLog), false);
  assert.equal(JSON.stringify(listed).includes(marker), false, 'outside plugin bytes must never supply displayed rows');
  assert.equal(group.servers.some(s => s.name.startsWith('plugin:owned:')), false, 'an unknown selection cannot invent a root fallback');
  assert.match(group.note ?? '', /could not read.*plugin/i);
  rmSync(link); writeFileSync(link, JSON.stringify(route === 'manifest' ? { mcpServers: spec('repaired') } : spec('repaired')));
  const repaired = await f.owner.call('mcp.list', {});
  assert.ok(repaired.groups.flatMap(g => g.servers).some(s => s.name === 'plugin:owned:repaired'));
  assert.equal(repaired.groups.find(g => g.id === f.group.id)?.note, null); await f.owner.call('core.hello', {});
});

const outcome = async <T>(promise: Promise<T>) => promise.then(value => ({ ok: true as const, value }), (error: Error & { code?: string }) => ({ ok: false as const, message: error.message, code: error.code }));
for (const action of ['list', 'preview', 'apply', 'remove'] as const) test(`legacy selector denial: ${action} cannot use the readable fallback`, async context => {
  const f = await fixture(context), legacy = join(f.claudeHome, '.config.json');
  writeFileSync(legacy, JSON.stringify({ mcpServers: spec('owned-legacy-selected') }));
  writeFileSync(f.userFile, JSON.stringify({ mcpServers: spec('owned-fallback-not-selected') }));
  const prior = (await f.owner.call('mcp.list', {})).groups.flatMap(g => g.servers).find(s => s.name === 'owned-legacy-selected'); assert.ok(prior);
  const preview = await f.owner.call('mcp.add', { catalogId: 'playwright', accountId: f.account.id, scope: 'user', preview: true });
  assert.equal(preview.done, false); assert.ok(preview.plan.file.endsWith('/.config.json'));
  const before = snapshot(f.root), state = await f.publicState();
  let listing, result;
  try {
    chmodSync(f.claudeHome, 0);
    assert.throws(() => statSync(legacy), (e: NodeJS.ErrnoException) => e.code === 'EACCES');
    assert.ok(readFileSync(f.userFile, 'utf8').includes('owned-fallback-not-selected'));
    if (action === 'list') listing = await f.owner.call('mcp.list', {});
    else if (action === 'remove') result = await outcome(f.owner.call('mcp.remove', { id: prior.id }));
    else result = await outcome(f.owner.call('mcp.add', { catalogId: 'playwright', accountId: f.account.id, scope: 'user', preview: action === 'preview' }));
  } finally { chmodSync(f.claudeHome, f.claudeMode); }
  assert.deepEqual(await f.publicState(), state);
  assert.equal(existsSync(f.callLog), false, 'unknown configuration must refuse before CLI dispatch');
  assert.deepEqual(snapshot(f.root), before);
  const repaired = await f.owner.call('mcp.list', {}); assert.ok(repaired.groups.flatMap(g => g.servers).some(s => s.id === prior.id));
  if (listing) {
    assert.equal(listing.groups.flatMap(g => g.servers).some(s => s.name === 'owned-fallback-not-selected'), false);
    assert.match(listing.groups.find(g => g.id === f.group.id)?.note ?? '', /could not read/i);
    assert.ok(listing.groups.some(g => g.agent === 'codex' && g.servers.some(s => s.name === 'healthy')));
  } else { assert.ok(result); assert.equal(result.ok, false); if (!result.ok && action !== 'remove') assert.match(result.message, /could not verify/i); }
  await f.owner.call('core.hello', {});
});

for (const shape of ['dangling', 'directory'] as const) test(`a present ${shape} legacy entry remains unknown instead of selecting fallback`, async context => {
  const f = await fixture(context), legacy = join(f.claudeHome, '.config.json');
  if (shape === 'dangling') symlinkSync(join(f.outside, 'missing-target'), legacy); else mkdirSync(legacy);
  const before = snapshot(f.root), listing = await f.owner.call('mcp.list', {});
  const previews = await Promise.all([true, false].map(preview => outcome(f.owner.call('mcp.add', { catalogId: 'playwright', accountId: f.account.id, scope: 'user', preview }))));
  assert.equal(existsSync(f.callLog), false); assert.deepEqual(snapshot(f.root), before);
  assert.equal(listing.groups.flatMap(g => g.servers).some(s => s.name === 'owned-user-healthy'), false);
  assert.match(listing.groups.find(g => g.id === f.group.id)?.note ?? '', /could not read/i);
  assert.ok(previews.every(result => !result.ok));
});

test('absent legacy selects fallback while valid personal config links stay supported', async context => {
  const f = await fixture(context), legacy = join(f.claudeHome, '.config.json'), target = join(f.outside, 'personal.json');
  const initial = await f.owner.call('mcp.list', {}); assert.ok(initial.groups.flatMap(g => g.servers).some(s => s.name === 'owned-user-healthy'));
  writeFileSync(target, JSON.stringify({ mcpServers: spec('owned-linked-personal') })); symlinkSync(target, legacy);
  const linked = await f.owner.call('mcp.list', {}); assert.ok(linked.groups.flatMap(g => g.servers).some(s => s.name === 'owned-linked-personal'));
  assert.equal(linked.groups.flatMap(g => g.servers).some(s => s.name === 'owned-user-healthy'), false);
  assert.equal(linked.groups.find(g => g.id === f.group.id)?.note, null);
  const preview = await f.owner.call('mcp.add', { catalogId: 'playwright', accountId: f.account.id, scope: 'user', preview: true });
  assert.equal(preview.done, false); assert.ok(preview.plan.file.endsWith('/.config.json'));
  rmSync(legacy); rmSync(f.userFile); symlinkSync(target, f.userFile);
  const fallbackLink = await f.owner.call('mcp.list', {}); assert.ok(fallbackLink.groups.flatMap(g => g.servers).some(s => s.name === 'owned-linked-personal'));
  assert.equal(existsSync(f.callLog), false);
});

for (const shape of ['missing-declared', 'escaping-declared', 'null-declared', 'array-declared', 'scalar-declared', 'null-wrapper', 'array-wrapper', 'malformed-manifest', 'malformed-root', 'oversized-root', 'directory-root', 'dangling-root', 'fifo-root', 'unreadable-root'] as const) test(`plugin ${shape}: selected unreadable or invalid data is scoped unknown`, async context => {
  const f = await fixture(context);
  if (shape === 'missing-declared') writeFileSync(f.manifestFile, JSON.stringify({ mcpServers: 'missing.json' }));
  if (shape === 'escaping-declared') { const outside = join(f.outside, 'outside.json'); writeFileSync(outside, JSON.stringify(spec('OUTSIDE_SHOULD_NOT_APPEAR'))); writeFileSync(f.manifestFile, JSON.stringify({ mcpServers: relative(f.plugin, outside) })); }
  if (shape === 'null-declared' || shape === 'array-declared' || shape === 'scalar-declared') writeFileSync(f.manifestFile, JSON.stringify({ mcpServers: shape === 'null-declared' ? null : shape === 'array-declared' ? [] : false }));
  if (shape === 'null-wrapper' || shape === 'array-wrapper') writeFileSync(f.pluginFile, JSON.stringify({ mcpServers: shape === 'null-wrapper' ? null : [] }));
  if (shape === 'malformed-manifest' || shape === 'malformed-root') writeFileSync(shape === 'malformed-manifest' ? f.manifestFile : f.pluginFile, '{INVALID_OWNED_CONTENT');
  if (shape === 'oversized-root') writeFileSync(f.pluginFile, JSON.stringify(spec('owned-plugin-healthy')) + ' '.repeat(4 * 1024 * 1024));
  if (shape === 'directory-root' || shape === 'dangling-root') { rmSync(f.pluginFile); if (shape === 'directory-root') mkdirSync(f.pluginFile); else symlinkSync(join(f.outside, 'missing-target'), f.pluginFile); }
  if (shape === 'fifo-root') { rmSync(f.pluginFile); execFileSync('/usr/bin/mkfifo', [f.pluginFile]); }
  const originalMode = lstatSync(f.pluginFile).mode & 0o777;
  const before = snapshot(f.root), state = await f.publicState(); let listing;
  try {
    if (shape === 'unreadable-root') { chmodSync(f.pluginFile, 0); assert.throws(() => readFileSync(f.pluginFile), (e: NodeJS.ErrnoException) => e.code === 'EACCES'); }
    listing = await f.owner.call('mcp.list', {});
  } finally { if (shape === 'unreadable-root') chmodSync(f.pluginFile, originalMode); }
  const group = listing.groups.find(g => g.id === f.group.id); assert.ok(group);
  assert.ok(group.servers.some(s => s.name === 'owned-user-healthy')); assert.ok(group.servers.some(s => s.name === 'plugin:sibling:owned-sibling-healthy'));
  assert.deepEqual(snapshot(f.root), before); assert.deepEqual(await f.publicState(), state); assert.equal(existsSync(f.callLog), false);
  assert.equal(group.servers.some(s => s.name.startsWith('plugin:owned:')), false);
  assert.match(group.note ?? '', /could not read.*plugin/i);
  assert.equal(JSON.stringify(listing).includes('INVALID_OWNED_CONTENT'), false); assert.equal(JSON.stringify(listing).includes('OUTSIDE_SHOULD_NOT_APPEAR'), false);
});

test('plugin contained links and explicit source precedence preserve healthy selected rows', async context => {
  const f = await fixture(context), inside = join(f.plugin, 'inside.json'); writeFileSync(inside, JSON.stringify(spec('inside-linked')));
  rmSync(f.pluginFile); symlinkSync(inside, f.pluginFile);
  let listing = await f.owner.call('mcp.list', {}); assert.ok(listing.groups.flatMap(g => g.servers).some(s => s.name === 'plugin:owned:inside-linked'));
  const manifestTarget = join(f.plugin, 'manifest.json'); writeFileSync(manifestTarget, JSON.stringify({ mcpServers: 'declared.json' }));
  rmSync(f.manifestFile); symlinkSync(manifestTarget, f.manifestFile); symlinkSync(inside, join(f.plugin, 'declared.json'));
  listing = await f.owner.call('mcp.list', {}); assert.ok(listing.groups.flatMap(g => g.servers).some(s => s.name === 'plugin:owned:inside-linked')); assert.equal(listing.groups.find(g => g.id === f.group.id)?.note, null);
  rmSync(f.pluginFile); const outside = join(f.outside, 'unused.json'); writeFileSync(outside, JSON.stringify(spec('unused-outside'))); symlinkSync(outside, f.pluginFile);
  const before = snapshot(f.root); listing = await f.owner.call('mcp.list', {});
  assert.ok(listing.groups.flatMap(g => g.servers).some(s => s.name === 'plugin:owned:inside-linked')); assert.equal(listing.groups.find(g => g.id === f.group.id)?.note, null);
  assert.equal(JSON.stringify(listing).includes('unused-outside'), false); assert.deepEqual(snapshot(f.root), before);
  writeFileSync(manifestTarget, JSON.stringify({ mcpServers: spec('inline-selected') })); listing = await f.owner.call('mcp.list', {});
  assert.ok(listing.groups.flatMap(g => g.servers).some(s => s.name === 'plugin:owned:inline-selected')); assert.equal(listing.groups.find(g => g.id === f.group.id)?.note, null); assert.equal(existsSync(f.callLog), false);
});

test('absent optional plugin files and canonical installed-root escape retain their existing boundary', async context => {
  const f = await fixture(context); rmSync(f.manifestFile); rmSync(f.pluginFile);
  const absent = await f.owner.call('mcp.list', {}); assert.equal(absent.groups.find(g => g.id === f.group.id)?.note, null);
  const alias = join(f.claudeHome, 'plugins/cache/alias'); symlinkSync(f.outside, alias); writeFileSync(join(f.outside, '.mcp.json'), JSON.stringify(spec('outside-install')));
  writeFileSync(join(f.claudeHome, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'escaped@fixture': [{ installPath: alias }] } }));
  const before = snapshot(f.root), listing = await f.owner.call('mcp.list', {});
  assert.equal(JSON.stringify(listing).includes('outside-install'), false); assert.deepEqual(snapshot(f.root), before); assert.equal(existsSync(f.callLog), false);
});


test('a regular plugin configuration at the four MiB boundary remains readable', async context => {
  const f = await fixture(context), text = JSON.stringify(spec('exact-limit')).padEnd(4 * 1024 * 1024, ' ');
  writeFileSync(f.pluginFile, text); assert.equal(statSync(f.pluginFile).size, 4 * 1024 * 1024);
  const before = snapshot(f.root), listing = await f.owner.call('mcp.list', {});
  const group = listing.groups.find(g => g.id === f.group.id); assert.ok(group); assert.ok(group.servers.some(s => s.name === 'plugin:owned:exact-limit'));
  assert.equal(group.note, null); assert.deepEqual(snapshot(f.root), before); assert.equal(existsSync(f.callLog), false);
});

for (const shape of ['dangling-parent', 'outside-parent'] as const) test(`plugin manifest ${shape} remains unknown instead of inventing root fallback`, async context => {
  const f = await fixture(context), parent = join(f.plugin, '.claude-plugin');
  rmSync(parent, { recursive: true }); symlinkSync(shape === 'dangling-parent' ? join(f.plugin, 'missing-parent') : f.outside, parent);
  assert.throws(() => realpathSync(f.manifestFile), (e: NodeJS.ErrnoException) => e.code === 'ENOENT');
  const before = snapshot(f.root), listing = await f.owner.call('mcp.list', {}), group = listing.groups.find(g => g.id === f.group.id); assert.ok(group);
  assert.ok(group.servers.some(s => s.name === 'owned-user-healthy')); assert.ok(group.servers.some(s => s.name === 'plugin:sibling:owned-sibling-healthy'));
  assert.deepEqual(snapshot(f.root), before); assert.equal(existsSync(f.callLog), false);
  assert.equal(group.servers.some(s => s.name.startsWith('plugin:owned:')), false); assert.match(group.note ?? '', /could not read.*plugin/i);
});

test('a dangling preferred legacy parent cannot select or mutate the readable fallback', async context => {
  const f = await fixture(context), moved = join(f.root, 'owned-moved-claude'), before = snapshot(f.root), state = await f.publicState();
  renameSync(f.claudeHome, moved); symlinkSync(join(f.root, 'missing-parent'), f.claudeHome);
  let listing, results;
  try {
    assert.throws(() => lstatSync(join(f.claudeHome, '.config.json')), (e: NodeJS.ErrnoException) => e.code === 'ENOENT');
    assert.ok(readFileSync(f.userFile, 'utf8').includes('owned-user-healthy'));
    listing = await f.owner.call('mcp.list', {});
    results = await Promise.all([true, false].map(preview => outcome(f.owner.call('mcp.add', { catalogId: 'playwright', accountId: f.account.id, scope: 'user', preview }))));
  } finally { rmSync(f.claudeHome); renameSync(moved, f.claudeHome); }
  assert.equal(existsSync(f.callLog), false); assert.deepEqual(snapshot(f.root), before); assert.deepEqual(await f.publicState(), state);
  assert.equal(listing.groups.flatMap(g => g.servers).some(s => s.name === 'owned-user-healthy'), false);
  assert.match(listing.groups.find(g => g.id === f.group.id)?.note ?? '', /could not read/i); assert.ok(results.every(result => !result.ok));
});

for (const shape of ['missing-directory', 'contained-directory-link'] as const) test(`plugin manifest genuine absence below ${shape} preserves root selection`, async context => {
  const f = await fixture(context), parent = join(f.plugin, '.claude-plugin'); rmSync(parent, { recursive: true });
  if (shape === 'contained-directory-link') { const target = join(f.plugin, 'empty-metadata'); mkdirSync(target); symlinkSync(target, parent); }
  const before = snapshot(f.root), listing = await f.owner.call('mcp.list', {}), group = listing.groups.find(g => g.id === f.group.id); assert.ok(group);
  assert.ok(group.servers.some(s => s.name === 'plugin:owned:owned-plugin-healthy')); assert.equal(group.note, null);
  assert.deepEqual(snapshot(f.root), before); assert.equal(existsSync(f.callLog), false);
});
