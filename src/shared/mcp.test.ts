import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HIDDEN, MCP_CATALOG, catalogMatch, looksSecret, pair, parseClaudeMcpList, redactArgs, redactText, redactUrl, shellJoin } from './mcp.ts';
import { parseToml } from './toml.ts';

test('secrets are hidden wherever they hide', () => {
  assert.equal(pair('API_KEY', 'anything').value, HIDDEN, 'a secret name hides its value');
  assert.equal(pair('Authorization', 'Bearer abc').value, HIDDEN);
  assert.equal(pair('UPSTREAM', 'sk-live-0123456789abcdef').value, HIDDEN, 'a token shape hides its value');
  assert.equal(pair('NODE_ENV', 'production').value, 'production');
  assert.equal(pair('GITHUB_TOKEN', '${GITHUB_TOKEN}').value, '${GITHUB_TOKEN}', 'a reference names a secret without holding it');
  assert.equal(pair('Authorization', 'Bearer ${TOKEN}').value, 'Bearer ${TOKEN}');
  assert.deepEqual(redactArgs(['-y', '@upstash/context7-mcp', '--api-key', 'ctx7sk-123', '--port', '3000']),
    ['-y', '@upstash/context7-mcp', '--api-key', HIDDEN, '--port', '3000']);
  assert.deepEqual(redactArgs(['--access-token=abc', '--mode=read', 'TOKEN=xyz', 'LEVEL=debug', 'Authorization: Bearer abc', 'localhost:3000']),
    ['--access-token=•••', '--mode=read', 'TOKEN=•••', 'LEVEL=debug', 'Authorization: •••', 'localhost:3000']);
  assert.equal(redactUrl('postgres://app:hunter2@db.internal:5432/shop'), 'postgres://app:•••@db.internal:5432/shop');
  assert.equal(redactUrl('https://mcp.example.com/mcp?api_key=k123&team=a'), 'https://mcp.example.com/mcp?api_key=•••&team=a');
  assert.equal(redactUrl('https://hooks.example.com/services/T0AAAAAAA/B0BBBBBBB/abcd1234efgh5678ijkl9012'), 'https://hooks.example.com/services/T0AAAAAAA/B0BBBBBBB/•••');
  assert.equal(redactText('failed: 401 for https://x.dev/mcp?token=abc123 using ghp_abcdefghijklmnop1234'), `failed: 401 for https://x.dev/mcp?token=${HIDDEN} using ${HIDDEN}`);
  for (const benign of ['@playwright/mcp@latest', 'mcp-server-fetch', '/usr/local/bin/server', 'https://mcp.linear.app/mcp', 'production']) {
    assert.equal(looksSecret(benign), false, benign);
  }
});

test('a command line is quoted so a terminal reads it as one argument each', () => {
  assert.equal(shellJoin(['claude', 'mcp', 'add', '--header', 'Authorization: Bearer YOUR_GITHUB_PAT']), "claude mcp add --header 'Authorization: Bearer YOUR_GITHUB_PAT'");
  assert.equal(shellJoin(["it's"]), "'it'\\''s'");
});

test('claude mcp list: names and statuses only, as the CLI printed them', () => {
  // Captured from Claude Code 2.1.292 against a throwaway CLAUDE_CONFIG_DIR, plus the other statuses its binary prints.
  const out = [
    'Checking MCP server health…',
    '',
    'fake-one: /usr/bin/true --x - ✘ Failed to connect — CONNECTION_CLOSED: Connection closed',
    'remote: http://127.0.0.1:9/mcp (HTTP) - ✘ Failed to connect — ECONNREFUSED: Unable to connect to https://x.dev/?key=sk-abcdefabcdef1234',
    'linear: https://mcp.linear.app/mcp (HTTP) - ✓ Connected',
    'plugin:github:github: https://api.githubcopilot.com/mcp/ (HTTP) - ! Needs authentication',
    'claude.ai Figma: https://mcp.figma.com/mcp - ✓ Connected',
    'sentry: https://mcp.sentry.dev/mcp (HTTP) - ⏸ Pending approval (run `claude` to approve)',
    'gitlab: https://gitlab.example/mcp (HTTP) - - Not configured',
  ].join('\n');
  const results = parseClaudeMcpList(out, ['fake-one', 'remote', 'linear', 'plugin:github:github', 'sentry']);
  assert.deepEqual(results.map((r) => [r.name, r.status, r.tone]), [
    ['fake-one', 'Failed to connect', 'fail'],
    ['remote', 'Failed to connect', 'fail'],
    ['linear', 'Connected', 'ok'],
    ['plugin:github:github', 'Needs authentication', 'auth'],
    ['claude.ai Figma', 'Connected', 'ok'],
    ['sentry', 'Pending approval', 'pending'],
    ['gitlab', 'Not configured', 'unknown'],
  ]);
  assert.equal(results[0]?.issue, 'CONNECTION_CLOSED: Connection closed');
  assert.ok(!results[1]?.issue?.includes('sk-abcdef'), 'an issue never carries a secret');
  assert.ok(!JSON.stringify(results).includes('--x'), 'arguments are never passed through');
});

test('the store: every entry has a source, a name it is added under, and a key only where it says so', () => {
  assert.equal(MCP_CATALOG.length, 12);
  for (const e of MCP_CATALOG) {
    assert.match(e.source, /^https:\/\//, e.id);
    if (e.claude) assert.ok(e.claude.args.includes(e.server), `${e.id}: claude adds it as ${e.server}`);
    if (e.codex) assert.equal(e.codex.args[0], e.server, `${e.id}: codex adds it as ${e.server}`);
    if (e.codex) assert.ok(e.codex.args.includes('--url') !== e.codex.args.includes('--'), `${e.id}: codex gets a URL or a command, not both`);
    const placeholder = e.key?.placeholder;
    assert.equal(!!placeholder && !!e.claude?.args.some((a) => a.includes(placeholder)), e.auth === 'key', `${e.id}: a key placeholder only where a key is needed`);
    assert.ok(!e.claude?.args.includes('--scope'), `${e.id}: Wanigan chooses the scope`);
  }
  assert.equal(catalogMatch({ url: 'https://mcp.linear.app/mcp' }), 'linear');
  assert.equal(catalogMatch({ command: 'npx', args: ['@playwright/mcp@latest'] }), 'playwright');
  assert.equal(catalogMatch({ url: 'https://example.com/mcp' }), null);
});

test('toml: Codex config as Codex writes it and as people edit it', () => {
  const t = parseToml([
    'model = "gpt-5" # the default',
    'approval_policy = \'on-request\'',
    '',
    '[mcp_servers.fake-one]',
    'command = "/usr/bin/true"',
    'args = ["--x", "two words",',
    '  "three", # trailing',
    ']',
    'startup_timeout_sec = 20',
    '',
    '[mcp_servers.fake-one.env]',
    'API_KEY = "sk-123"',
    '',
    '[mcp_servers."with space"]',
    'url = "http://127.0.0.1:9/mcp"',
    'http_headers = { "X-Api-Key" = "abc", Plain = \'v\' }',
    'enabled = false',
    '',
    '[projects."/Users/me/site"]',
    'trust_level = "trusted"',
    '',
    'notes = """',
    'line one',
    'line "two"',
    '"""',
    'when = 1979-05-27T07:32:00Z',
    'hex = 0xff',
    '[[profiles.list]]',
    'name = "a"',
  ].join('\n'));
  assert.equal(t.model, 'gpt-5');
  assert.equal(t.approval_policy, 'on-request');
  const servers = t.mcp_servers as Record<string, Record<string, unknown>>;
  assert.deepEqual(servers['fake-one']?.args, ['--x', 'two words', 'three']);
  assert.deepEqual(servers['fake-one']?.env, { API_KEY: 'sk-123' });
  assert.equal(servers['fake-one']?.startup_timeout_sec, 20);
  assert.deepEqual(servers['with space']?.http_headers, { 'X-Api-Key': 'abc', Plain: 'v' });
  assert.equal(servers['with space']?.enabled, false);
  const projects = t.projects as Record<string, Record<string, unknown>>;
  assert.equal(projects['/Users/me/site']?.trust_level, 'trusted');
  assert.equal(projects['/Users/me/site']?.notes, 'line one\nline "two"\n');
  assert.equal(projects['/Users/me/site']?.when, '1979-05-27T07:32:00Z');
  assert.equal(projects['/Users/me/site']?.hex, 255);
  assert.throws(() => parseToml('[a]\nx = 1\n[a]\ny = 2'), /line 3: The table “a” is defined twice/);
  assert.throws(() => parseToml('x = "open'), /line 1: A string is not closed/);
  assert.throws(() => parseToml('x = 1\nx = 2'), /line 2: “x” is set twice/);
  assert.throws(() => parseToml('x = trusted'), /Cannot read the value/);
});
