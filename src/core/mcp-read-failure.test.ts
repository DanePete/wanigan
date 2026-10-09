// Owned files and an explicit CLI stand-in exercise owner MCP read/verification.
// No installed provider, account, MCP server or network service is used.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { shellQuote } from './hooks.ts';
import { testCore } from './test-support.ts';

const CONFIG = '# owned config sentinel\n[mcp_servers.owned]\ncommand = "owned-never-started-server"\n';
const observed = (value: unknown) => JSON.stringify(value);
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wg-mcp-read-'));
  const home = join(root, 'home'), accountHome = join(home, '.codex_probe');
  mkdirSync(accountHome, { recursive: true });
  const config = join(accountHome, 'config.toml'), log = join(root, 'calls.jsonl'), mode = join(root, 'mode');
  writeFileSync(config, CONFIG, { mode: 0o600 }); writeFileSync(mode, 'noop');
  const script = join(root, 'stand-in.mjs'), binary = join(root, 'owned-codex');
  writeFileSync(script, `import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';import {appendFileSync,chmodSync,readFileSync,writeFileSync} from 'node:fs';
assert.equal(process.env.CODEX_HOME,${JSON.stringify(accountHome)});
const argv=process.argv.slice(2);
const mode=readFileSync(${JSON.stringify(mode)},'utf8');appendFileSync(${JSON.stringify(log)},JSON.stringify({argv,account:process.env.CODEX_HOME,mode})+'\\n');
if(argv[1]==='add')process.exit(0);assert.deepEqual(argv,['mcp','remove','owned']);
if(mode==='malformed-zero')writeFileSync(${JSON.stringify(config)},${JSON.stringify(CONFIG + 'invalid = invented_bare_value\n')});
if(mode==='remove'||mode==='remove-signal')writeFileSync(${JSON.stringify(config)},'# actual owned empty config\\n');
if(mode==='unreadable-zero'||mode==='unreadable-signal')chmodSync(${JSON.stringify(config)},0);
if(mode==='unreadable-signal'||mode==='remove-signal')process.kill(process.pid,'SIGTERM');else process.exit(0);
`);
  writeFileSync(binary, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`, { mode: 0o755 });
  const t = await testCore({ accounts: { home }, mcpBinaries: { codex: binary } });
  await t.core.accounts.refresh();
  const account = (await t.owner.call('accounts.list', {})).find(a => a.configDir === accountHome);
  assert.ok(account); assert.equal(account.provider, 'codex');
  const listing = await t.owner.call('mcp.list', {});
  const group = listing.groups.find(g => g.servers.some(s => s.accountId === account.id && s.name === 'owned'));
  assert.ok(group, 'the configured named account and actual server are listed before action');
  const server = group.servers.find(s => s.accountId === account.id && s.name === 'owned')!;
  const snapshot = () => ({ sessions: t.core.db.prepare('SELECT * FROM sessions ORDER BY id').all(), cards: t.core.db.prepare('SELECT * FROM cards ORDER BY id').all(), projects: t.core.db.prepare('SELECT * FROM projects ORDER BY id').all(), activity: t.core.db.prepare('SELECT * FROM activity ORDER BY id').all() });
  const before = snapshot();
  return { ...t, root, config, mode, log, account, group, server, snapshot, before,
    async finish() { chmodSync(config, 0o600); await t.close(); rmSync(root, { recursive: true, force: true }); } };
}

function report(name: string, value: unknown): void {
  if (process.env.WG_MCP_READ_EVIDENCE) writeFileSync(join(process.env.WG_MCP_READ_EVIDENCE, name + '.json'), JSON.stringify(value, null, 2) + '\n');
}

test('owner MCP listing reports an existing unreadable Codex config instead of a known-empty account', async context => {
  const t = await fixture();
  try {
    chmodSync(t.config, 0);
    assert.throws(() => readFileSync(t.config), (e: NodeJS.ErrnoException) => e.code === 'EACCES', 'fixture proves an actual OS read denial');
    const failed = await t.owner.call('mcp.list', {});
    const listed = failed.groups.find(g => g.id === t.group.id);
    const empty = failed.empty.some(e => e.agent === 'codex' && e.where === t.group.where);
    chmodSync(t.config, 0o600);
    assert.equal(readFileSync(t.config, 'utf8'), CONFIG); assert.deepEqual(t.snapshot(), t.before);
    const repaired = await t.owner.call('mcp.list', {});
    assert.ok(repaired.groups.some(g => g.servers.some(s => s.id === t.server.id)), 'readability repair restores actual server listing');
    assert.equal(existsSync(t.log), false, 'listing starts no CLI');
    const observation = { accountRegistered: true, initiallyListed: true, actualEacces: true, empty, note: listed?.note ?? null, repaired: true, sourceBytesAndRowsPreserved: true };
    context.diagnostic(observed(observation)); report('listing-unreadable', observation);
    assert.equal(empty, false); assert.match(listed?.note ?? '', /could not read/i);
  } finally { await t.finish(); }
});

for (const mode of ['unreadable-zero', 'unreadable-signal']) test(`owner MCP removal refuses an unverifiable postcondition after ${mode}`, async context => {
  const t = await fixture();
  try {
    writeFileSync(t.mode, mode);
    const result = await t.owner.call('mcp.remove', { id: t.server.id }).then(value => ({ ok: true as const, value }), (e: Error & { code?: string }) => ({ ok: false as const, error: e.message, code: e.code }));
    assert.throws(() => readFileSync(t.config), (e: NodeJS.ErrnoException) => e.code === 'EACCES');
    const calls = readFileSync(t.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.length, 1); assert.deepEqual(calls[0].argv, ['mcp', 'remove', 'owned']); assert.equal(calls[0].account, t.account.configDir);
    chmodSync(t.config, 0o600); assert.equal(readFileSync(t.config, 'utf8'), CONFIG); assert.deepEqual(t.snapshot(), t.before);
    const listed = await t.owner.call('mcp.list', {}); assert.ok(listed.groups.some(g => g.servers.some(s => s.id === t.server.id)));
    const observation = { mode, result, calls, sourceStillConfigured: true, sourceBytesAndRowsPreserved: true, realEaccesAfterCommand: true };
    context.diagnostic(observed(observation)); report(mode, observation);
    assert.equal(result.ok, false, 'unknown postcondition must not be reported as done');
  } finally { await t.finish(); }
});

test('owner MCP removal refuses a readable no-op and confirms an actual empty-file removal', async () => {
  const t = await fixture();
  try {
    await assert.rejects(t.owner.call('mcp.remove', { id: t.server.id }), /did not make the change/);
    assert.equal(readFileSync(t.config, 'utf8'), CONFIG); assert.deepEqual(t.snapshot(), t.before);
    writeFileSync(t.mode, 'remove');
    const result = await t.owner.call('mcp.remove', { id: t.server.id }); assert.equal(result.done, true);
    assert.equal(readFileSync(t.config, 'utf8'), '# actual owned empty config\n'); assert.deepEqual(t.snapshot(), t.before);
    const listed = await t.owner.call('mcp.list', {}); assert.ok(listed.empty.some(e => e.agent === 'codex' && e.where === t.group.where));
    report('readable-neighbors', { noopRefused: true, actualRemovalConfirmed: true, emptyListed: true, rowsPreserved: true });
  } finally { await t.finish(); }
});

for (const size of [32, 10_000]) test(`malformed Codex TOML never quotes an invented bare credential of ${size} characters`, async context => {
  const t = await fixture();
  try {
    const value = 'INVENTED_CREDENTIAL_' + 'x'.repeat(size - 'INVENTED_CREDENTIAL_'.length);
    const bytes = CONFIG + `credential = ${value}\n`;
    writeFileSync(t.config, bytes);
    const listing = await t.owner.call('mcp.list', {});
    const group = listing.groups.find(g => g.id === t.group.id); assert.ok(group);
    const note = group.note ?? '';
    assert.equal(readFileSync(t.config, 'utf8'), bytes); assert.deepEqual(t.snapshot(), t.before); assert.equal(existsSync(t.log), false);
    const observation = { valueBytes: value.length, noteBytes: Buffer.byteLength(note), leaksPrefix: note.includes(value.slice(0, 32)), containsCompleteValue: note.includes(value), hasLine: /line 4/.test(note), bytesAndRowsPreserved: true };
    context.diagnostic(observed(observation)); report(`parse-${size}`, observation);
    assert.equal(observation.leaksPrefix, false, 'a parse diagnostic cannot disclose config values');
    assert.ok(note.length < 160); assert.match(note, /line 4/);
  } finally { await t.finish(); }
});

test('an unreadable Codex configuration refuses add before any CLI starts', async context => {
  const t = await fixture();
  try {
    chmodSync(t.config, 0); assert.throws(() => readFileSync(t.config), (e: NodeJS.ErrnoException) => e.code === 'EACCES');
    const result = await t.owner.call('mcp.add', { catalogId: 'playwright', accountId: t.account.id, scope: 'user' }).then(v => ({ ok: true, done: v.done }), (e: Error) => ({ ok: false, error: e.message }));
    const started = existsSync(t.log);
    chmodSync(t.config, 0o600); assert.equal(readFileSync(t.config, 'utf8'), CONFIG); assert.deepEqual(t.snapshot(), t.before);
    context.diagnostic(observed({ result, started, sourcePreserved: true })); report('add-preflight', { result, started, sourcePreserved: true });
    assert.equal(result.ok, false); assert.equal(started, false, 'unknown existing configuration is not permission to run add');
  } finally { await t.finish(); }
});

test('malformed post-remove TOML is unknown even when the CLI exits zero', async context => {
  const t = await fixture();
  try {
    writeFileSync(t.mode, 'malformed-zero');
    const result = await t.owner.call('mcp.remove', { id: t.server.id }).then(v => ({ ok: true, done: v.done }), (e: Error) => ({ ok: false, error: e.message }));
    assert.equal(readFileSync(t.config, 'utf8'), CONFIG + 'invalid = invented_bare_value\n'); assert.deepEqual(t.snapshot(), t.before);
    writeFileSync(t.config, CONFIG); const repaired = await t.owner.call('mcp.list', {}); assert.ok(repaired.groups.some(g => g.servers.some(s => s.id === t.server.id)));
    context.diagnostic(observed({ result, sourceStillConfigured: true })); report('malformed-postcondition', { result, sourceStillConfigured: true });
    assert.equal(result.ok, false);
  } finally { await t.finish(); }
});

for (const shape of ['missing', 'empty', 'symlink', 'exact-limit', 'oversized', 'directory', 'fifo']) test(`Codex config ${shape} distinguishes known absence/content from an unreadable source`, async context => {
  const t = await fixture();
  try {
    const limit = 4 * 1024 * 1024;
    if (shape === 'missing' || shape === 'symlink' || shape === 'directory' || shape === 'fifo') rmSync(t.config);
    if (shape === 'empty') writeFileSync(t.config, '');
    if (shape === 'symlink') { const target = join(t.root, 'owned-config-target'); writeFileSync(target, CONFIG); symlinkSync(target, t.config); }
    if (shape === 'exact-limit' || shape === 'oversized') writeFileSync(t.config, CONFIG + '#' + 'x'.repeat(limit - Buffer.byteLength(CONFIG) - 1 + (shape === 'oversized' ? 1 : 0)));
    if (shape === 'directory') mkdirSync(t.config);
    if (shape === 'fifo') execFileSync('/usr/bin/mkfifo', [t.config]);
    const listing = await t.owner.call('mcp.list', {}), group = listing.groups.find(g => g.id === t.group.id);
    const empty = listing.empty.some(e => e.agent === 'codex' && e.where === t.group.where);
    const found = group?.servers.some(s => s.id === t.server.id) ?? false;
    const note = group?.note ?? null;
    assert.deepEqual(t.snapshot(), t.before); assert.equal(existsSync(t.log), false);
    report(`shape-${shape}`, { shape, empty, found, note }); context.diagnostic(observed({ shape, empty, found, note }));
    if (shape === 'missing' || shape === 'empty') { assert.equal(empty, true); assert.equal(note, null); }
    else if (shape === 'symlink' || shape === 'exact-limit') { assert.equal(found, true); assert.equal(note, null); }
    else { assert.equal(empty, false); assert.match(note ?? '', /could not read/); }
  } finally {
    rmSync(t.config, { recursive: true, force: true }); writeFileSync(t.config, CONFIG, { mode: 0o600 }); await t.finish();
  }
});

test('a null CLI exit retains the existing policy only when actual absence is verified', async () => {
  const t = await fixture();
  try {
    writeFileSync(t.mode, 'remove-signal');
    const result = await t.owner.call('mcp.remove', { id: t.server.id }); assert.equal(result.done, true);
    assert.equal(readFileSync(t.config, 'utf8'), '# actual owned empty config\n'); assert.deepEqual(t.snapshot(), t.before);
    const listing = await t.owner.call('mcp.list', {}); assert.ok(listing.empty.some(e => e.agent === 'codex' && e.where === t.group.where));
  } finally { await t.finish(); }
});
