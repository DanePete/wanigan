// Actual owner listing from temporary Claude/Codex files. Invented credentials
// only; listing must not run a configured server, provider or connection check.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HIDDEN } from '../shared/mcp.ts';
import { testCore } from './test-support.ts';

test('owner MCP listing hides literal credential defaults in both agents without running or changing their configs', async context => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-mcp-fallback-')), home = join(dir, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true }); mkdirSync(join(home, '.codex'));
  const ran = join(dir, 'cli-ran'), bin = join(dir, 'owned-cli');
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  writeFileSync(bin, '#!/bin/sh\nprintf ran >> ' + quote(ran) + '\nexit 19\n', { mode: 0o755 });
  const secret = 'owned-fallback-credential', shaped = ['ghp_', 'OWNED1234567890ABCDEFGHIJ'].join('');
  const ref = '${TOKEN:-' + secret + '}';
  const args = ['--token', ref, '--api-key=' + ref, 'PASSWORD=' + ref, 'Authorization: Bearer ' + ref,
    '${UPSTREAM:-' + shaped + '}', '--plain-reference', '${VISIBLE_REF}'];
  const env = { API_KEY: ref, PLAIN_REF: '${VISIBLE_REF}', NODE_ENV: 'production', LITERAL_TOKEN: 'owned-literal-token' };
  const headers = { Authorization: 'Bearer ' + ref, 'X-Api-Key': '${VISIBLE_REF}' };
  const claude = join(home, '.claude.json'), codex = join(home, '.codex', 'config.toml');
  writeFileSync(claude, JSON.stringify({ mcpServers: { 'claude-fallback': { command: bin, args, env, headers } } }));
  const table = (name: string, values: Record<string, string>) => '[' + name + ']\n' + Object.entries(values).map(([k, v]) => JSON.stringify(k) + ' = ' + JSON.stringify(v)).join('\n');
  writeFileSync(codex, '[mcp_servers.codex-fallback]\ncommand = ' + JSON.stringify(bin) + '\nargs = ' + JSON.stringify(args) + '\n' +
    table('mcp_servers.codex-fallback.env', env) + '\n' + table('mcp_servers.codex-fallback.http_headers', headers) + '\n');
  const originals = [claude, codex].map(file => readFileSync(file));
  const t = await testCore({ accounts: { home }, mcpBinaries: { claude: bin, codex: bin },
    launcher: () => { throw new Error('This read-only fixture must not launch a session'); } });
  try {
    const listing = await t.owner.call('mcp.list', {});
    const servers = listing.groups.flatMap(group => group.servers).filter(server => server.name.endsWith('-fallback'));
    assert.equal(servers.length, 2);
    for (const server of servers) {
      assert.ok(server.target.includes('${VISIBLE_REF}'));
      assert.deepEqual(server.env.find(pair => pair.key === 'PLAIN_REF'), { key: 'PLAIN_REF', value: '${VISIBLE_REF}', redacted: false });
      assert.equal(server.env.find(pair => pair.key === 'LITERAL_TOKEN')?.value, HIDDEN);
      assert.equal(server.env.find(pair => pair.key === 'NODE_ENV')?.value, 'production');
    }
    assert.deepEqual([claude, codex].map(file => readFileSync(file)), originals);
    assert.equal(existsSync(ran), false, 'no configured server or provider CLI was invoked');
    assert.deepEqual(await t.owner.call('sessions.list', {}), []);
    const observations = servers.map(server => ({ agent: server.agent, targetHasFallback: server.target.includes(secret),
      targetHasShapedFallback: server.target.includes(shaped), envHasFallback: JSON.stringify(server.env).includes(secret),
      headerHasFallback: JSON.stringify(server.headers).includes(secret) }));
    context.diagnostic(JSON.stringify({ observations, configBytesUnchanged: true, noCli: true, sessions: 0 }));
    assert.deepEqual(observations, ['claude', 'codex'].map(agent => ({ agent, targetHasFallback: false,
      targetHasShapedFallback: false, envHasFallback: false, headerHasFallback: false })));
  } finally { await t.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('actual HTTP targets and owned CLI diagnostics hide raw or encoded fallback literals', async context => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-mcp-url-fallback-')), home = join(dir, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  const calls = join(dir, 'calls'), bin = join(dir, 'owned-cli');
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  const secret = 'owned-url-fallback', expression = '${TOKEN:-' + secret + '}';
  const diagnostic = 'owned CLI refusal ${TOKEN:-owned diagnostic with spaces}';
  writeFileSync(bin, '#!/bin/sh\nprintf called >> ' + quote(calls) + '\nprintf "%s\\n" ' + quote(diagnostic) + '\nexit 17\n', { mode: 0o755 });
  const config = join(home, '.claude.json');
  writeFileSync(config, JSON.stringify({ mcpServers: {
    'raw-http-fallback': { type: 'http', url: 'https://example.invalid/' + expression },
    'encoded-http-fallback': { type: 'http', url: 'https://example.invalid/' + encodeURIComponent(expression) },
    healthy: { type: 'http', url: 'https://example.invalid/health' },
  } }));
  const before = readFileSync(config);
  const t = await testCore({ accounts: { home }, mcpBinaries: { claude: bin, codex: bin },
    launcher: () => { throw new Error('This fixture must not launch a session'); } });
  try {
    const listing = await t.owner.call('mcp.list', {});
    assert.equal(existsSync(calls), false, 'listing HTTP targets makes no CLI or network request');
    const servers = listing.groups.flatMap(group => group.servers);
    assert.equal(servers.find(server => server.name === 'healthy')?.target, 'https://example.invalid/health');
    const account = (await t.owner.call('accounts.list', {})).find(account => account.provider === 'claude' && !account.configDir)!;
    const checked = await t.owner.call('mcp.check', { accountId: account.id, projectId: null });
    assert.equal(readFileSync(calls, 'utf8'), 'called', 'the explicit check runs only the owned stand-in once');
    assert.deepEqual(readFileSync(config), before);
    assert.deepEqual(await t.owner.call('sessions.list', {}), []);
    const outcomes = { rawTarget: servers.find(server => server.name === 'raw-http-fallback')?.target,
      encodedTarget: servers.find(server => server.name === 'encoded-http-fallback')?.target,
      diagnostic: checked.error };
    context.diagnostic(JSON.stringify({ outcomes, configsUnchanged: true, ownedCliCalls: 1, sessions: 0 }));
    assert.deepEqual(outcomes, { rawTarget: HIDDEN, encodedTarget: HIDDEN, diagnostic: 'Claude Code could not check: ' + HIDDEN });
  } finally { await t.close(); rmSync(dir, { recursive: true, force: true }); }
});
