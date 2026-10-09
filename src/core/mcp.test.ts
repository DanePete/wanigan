// MCP servers against a pretend home, with stand-in `claude` and `codex` that
// record every argv they are given and edit the same files the real CLIs edit.
// Nothing here reads or writes the real home, or reaches a network.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { CoreClient } from '../client/client.ts';
import type { McpListing, McpServer } from '../shared/mcp.ts';
import { shellQuote } from './hooks.ts';
import { testCore, tokenOf, waitFor, type TestCore } from './test-support.ts';

const SECRETS = ['ghp_live0123456789abcdefABCDEF', 'sk-live-abcdef123456', 'hunter2pass', 'abcd1234efgh5678ijkl', 'codexsecret-9f8e7d6c5b4a', 'xoxb-1234-5678-abcdefgh', 'plugin-secret-0123456789abcdef'];

/** The stand-in CLI. Real argv in, real files out, every call logged. */
const FAKE = `
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [agent, ...argv] = process.argv.slice(2);
appendFileSync(process.env.WG_FAKE_LOG, JSON.stringify({ agent, argv, cwd: process.cwd(), cfg: process.env.CLAUDE_CONFIG_DIR ?? null, codexHome: process.env.CODEX_HOME ?? null }) + '\\n');
const home = process.env.WG_FAKE_HOME;
const readJson = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {});
if (agent === 'claude') {
  const file = join(process.env.CLAUDE_CONFIG_DIR ?? home, '.claude.json');
  const [, verb, ...rest] = argv;
  const opts = {}; const pos = []; let i = 0;
  for (; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') { pos.push(...rest.slice(i + 1)); break; }
    if (['--scope', '-s', '--transport', '-t', '--header', '-H', '--env', '-e'].includes(a)) { (opts[a.replace(/^-+/, '')[0]] ??= []).push(rest[++i]); continue; }
    pos.push(a);
  }
  const scope = opts.s?.[0] ?? 'local';
  const at = (config) => scope === 'user' ? (config.mcpServers ??= {}) : ((config.projects ??= {})[process.cwd()] ??= {}).mcpServers ??= {};
  if (verb === 'list') {
    const config = readJson(file);
    console.log('Checking MCP server health…\\n');
    for (const name of Object.keys(config.mcpServers ?? {})) console.log(name + ': ' + (config.mcpServers[name].url ?? config.mcpServers[name].command) + ' - ✓ Connected');
    console.log('claude.ai Figma: https://mcp.figma.com/mcp - ! Needs authentication');
    console.log('broken: npx broken --token abcd1234efgh5678ijkl - ✘ Failed to connect — 401 from https://x.dev/?key=sk-live-abcdef123456');
    process.exit(0);
  }
  const target = scope === 'project' ? join(process.cwd(), '.mcp.json') : file;
  const config = readJson(target);
  const servers = scope === 'project' ? (config.mcpServers ??= {}) : at(config);
  const name = pos[0];
  if (verb === 'add') {
    if (servers[name]) { console.error('MCP server ' + name + ' already exists'); process.exit(1); }
    servers[name] = opts.t?.[0] === 'http' ? { type: 'http', url: pos[1] } : { type: 'stdio', command: pos[1], args: pos.slice(2), env: {} };
    writeFileSync(target, JSON.stringify(config, null, 2));
    console.log('Added MCP server ' + name + ' to ' + scope + ' config');
  } else if (verb === 'remove') {
    if (!servers[name]) { console.error('No MCP server named "' + name + '"'); process.exit(1); }
    delete servers[name];
    writeFileSync(target, JSON.stringify(config, null, 2));
    console.log('Removed MCP server ' + name);
  }
} else {
  const dir = process.env.CODEX_HOME ?? join(home, '.codex');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'config.toml');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const [, verb, name, ...rest] = argv;
  if (verb === 'add') {
    const url = rest[0] === '--url' ? rest[1] : null;
    const cmd = rest[0] === '--' ? rest.slice(1) : [];
    const body = url ? 'url = ' + JSON.stringify(url) : 'command = ' + JSON.stringify(cmd[0]) + '\\nargs = ' + JSON.stringify(cmd.slice(1));
    writeFileSync(file, text + '\\n[mcp_servers.' + name + ']\\n' + body + '\\n');
    console.log("Added global MCP server '" + name + "'.");
  } else if (verb === 'remove') {
    // Like Codex 0.155.1: nothing to remove still exits 0.
    if (process.env.WG_FAKE_NOOP || !text.includes('[mcp_servers.' + name + ']')) { console.log("No MCP server named '" + name + "' found."); process.exit(0); }
    const out = text.split(/\\n(?=\\[)/).filter((block) => !block.startsWith('[mcp_servers.' + name + ']')).join('\\n');
    writeFileSync(file, out);
    console.log("Removed global MCP server '" + name + "'.");
  }
}
`;

describe('mcp', () => {
  let t: TestCore;
  let fixture: string;
  let home: string;
  let log: string;
  let projectId: string;
  let listing: McpListing;
  let ids: { claudeDefault: string; claudeWork: string; codexDefault: string };
  const servers = (): McpServer[] => listing.groups.flatMap((g) => g.servers);
  const server = (name: string, agent?: string): McpServer => {
    const s = servers().find((x) => x.name === name && (!agent || x.agent === agent));
    assert.ok(s, `server ${name} listed`);
    return s;
  };
  const calls = (): { agent: string; argv: string[]; cwd: string; cfg: string | null; codexHome: string | null }[] =>
    (existsSync(log) ? readFileSync(log, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const refresh = async (): Promise<void> => { listing = await t.owner.call('mcp.list', {}); };

  before(async () => {
    fixture = realpathSync(mkdtempSync(join(tmpdir(), 'wg-mcp-')));
    home = join(fixture, 'home');
    log = join(fixture, 'calls.jsonl');
    const projectDir = join(fixture, 'site');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress: 'me@example.com' },
      mcpServers: {
        github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: `Bearer ${SECRETS[0]}` } },
        tool: {
          type: 'stdio', command: 'node', args: ['server.js', '--token', SECRETS[3], '--port', '3000', `postgres://app:${SECRETS[2]}@db/shop`],
          env: { API_KEY: SECRETS[1], NODE_ENV: 'production', SLACK: SECRETS[5], REF: '${MY_TOKEN}' },
        },
      },
      projects: {
        [projectDir]: { mcpServers: { 'site-local': { type: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'] } } },
        '/somewhere/else': { mcpServers: { elsewhere: { type: 'sse', url: 'https://old.example/sse' } } },
      },
    }));
    mkdirSync(join(home, '.claude_work'), { recursive: true });
    writeFileSync(join(home, '.claude_work', 'settings.json'), '{}');
    writeFileSync(join(home, '.claude_work', '.claude.json'), JSON.stringify({ mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } } }));
    const plugin = join(home, '.claude', 'plugins', 'cache', 'official', 'github', 'abc123');
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(plugin, '.mcp.json'), JSON.stringify({ github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: `Bearer ${SECRETS[6]}` } } }));
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'github@official': [{ scope: 'user', installPath: plugin }] } }));
    writeFileSync(join(projectDir, '.mcp.json'), JSON.stringify({ mcpServers: { sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' } } }));
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'), [
      'model = "gpt-5"',
      '',
      '[mcp_servers.docs]',
      'command = "npx"',
      'args = ["-y", "@upstash/context7-mcp"]',
      `env = { CONTEXT7_API_KEY = "${SECRETS[4]}", LOG = "info" }`,
      '',
      '[mcp_servers.remote]',
      'url = "https://mcp.example.com/mcp"',
      'bearer_token_env_var = "REMOTE_TOKEN"',
      'enabled = false',
      '',
      '[mcp_servers.remote.http_headers]',
      `X-Api-Key = "${SECRETS[4]}"`,
      '',
      `[projects."${projectDir}"]`,
      'trust_level = "trusted"',
    ].join('\n'));
    mkdirSync(join(projectDir, '.codex'), { recursive: true });
    writeFileSync(join(projectDir, '.codex', 'config.toml'), '[mcp_servers.repo-tool]\ncommand = "./tools/mcp"\n');

    const fakeJs = join(fixture, 'fake-cli.mjs');
    writeFileSync(fakeJs, FAKE);
    const bin = (agent: string): string => {
      const file = join(fixture, `fake-${agent}`);
      writeFileSync(file, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} ${shellQuote(fakeJs)} ${agent} "$@"\n`, { mode: 0o755 });
      return file;
    };
    process.env.WG_FAKE_LOG = log;
    process.env.WG_FAKE_HOME = home;
    t = await testCore({
      dataDir: join(fixture, 'data'),
      accounts: {
        home,
        prober: async () => ({ signedIn: 'unknown', identity: null, plan: null }),
        usageReader: async () => ({ state: 'unreadable', windows: [], checkedAt: 0, note: 'test' }),
      },
      mcpBinaries: { claude: bin('claude'), codex: bin('codex') },
    });
    // The test core's own project folder is not this one; open the fixture's.
    projectId = (await t.owner.call('projects.add', { path: projectDir })).id;
    const accounts = await t.owner.call('accounts.list', {});
    ids = {
      claudeDefault: accounts.find((a) => a.provider === 'claude' && !a.configDir)!.id,
      claudeWork: accounts.find((a) => a.provider === 'claude' && a.configDir?.endsWith('.claude_work'))!.id,
      codexDefault: accounts.find((a) => a.provider === 'codex' && !a.configDir)!.id,
    };
    await refresh();
  });

  beforeEach(() => { delete process.env.WG_FAKE_NOOP; });

  after(async () => {
    await t?.close();
    rmSync(fixture, { recursive: true, force: true });
    delete process.env.WG_FAKE_LOG;
    delete process.env.WG_FAKE_HOME;
  });

  test('every configured server is listed where it is defined, for the account that has it', () => {
    const at = (name: string, agent?: string): string => {
      const s = server(name, agent);
      const g = listing.groups.find((x) => x.servers.includes(s))!;
      return `${g.agent}/${g.title}${g.account ? `/${g.account}` : ''}/${s.scope}`;
    };
    assert.equal(at('github'), 'claude/Claude Code/Default/user');
    assert.equal(at('tool'), 'claude/Claude Code/Default/user');
    assert.equal(at('linear'), 'claude/Claude Code/work/user');
    assert.equal(at('plugin:github:github'), 'claude/Claude Code/Default/plugin');
    assert.equal(at('elsewhere'), 'claude/Claude Code/Default/local', 'a folder Wanigan has not opened stays with its account');
    assert.equal(at('site-local'), 'claude/site/local', 'an open project’s local servers sit with the project');
    assert.equal(at('sentry'), 'claude/site/project');
    assert.equal(at('docs'), 'codex/Codex/Default/user');
    assert.equal(at('repo-tool'), 'codex/site/project');
    assert.equal(server('elsewhere').folder, '/somewhere/else');
    assert.equal(server('elsewhere').transport, 'sse');
    assert.equal(server('remote').enabled, false);
    assert.equal(server('plugin:github:github').removable, false);
    assert.equal(server('repo-tool').removable, false);
    assert.equal(server('sentry').removable, true);
    assert.equal(server('linear').catalogId, 'linear');
    assert.equal(server('site-local').catalogId, 'playwright');
    const codexProject = listing.groups.find((g) => g.agent === 'codex' && g.projectId === projectId)!;
    assert.match(codexProject.note ?? '', /Trusted by: Default/);
    assert.equal(listing.groups.find((g) => g.agent === 'codex')!.check, null, 'Codex has no connection check');
  });

  test('no secret value reaches a result, and harmless values stay readable', () => {
    const text = JSON.stringify(listing);
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `${secret.slice(0, 6)}… is hidden`);
    const tool = server('tool');
    assert.deepEqual(tool.env.map((e) => `${e.key}=${e.value}`), ['API_KEY=•••', 'NODE_ENV=production', 'SLACK=•••', 'REF=${MY_TOKEN}']);
    assert.equal(tool.target, 'node server.js --token ••• --port 3000 postgres://app:•••@db/shop');
    assert.deepEqual(server('github').headers, [{ key: 'Authorization', value: '•••', redacted: true }]);
    assert.deepEqual(server('remote').headers.map((h) => `${h.key}: ${h.value}`), ['Authorization: Bearer $REMOTE_TOKEN', 'X-Api-Key: •••']);
    assert.deepEqual(server('docs').env.map((e) => `${e.key}=${e.value}`), ['CONTEXT7_API_KEY=•••', 'LOG=info']);
  });

  test('the store has twelve servers, each with its source', async () => {
    const catalog = await t.owner.call('mcp.catalog', {});
    assert.equal(catalog.length, 12);
    assert.ok(catalog.every((e) => e.source.startsWith('https://')));
  });

  test('a preview shows the exact command and runs nothing', async () => {
    const before = calls().length;
    const homeBefore = readFileSync(join(home, '.claude_work', '.claude.json'), 'utf8');
    const { plan, done } = await t.owner.call('mcp.add', { catalogId: 'figma', accountId: ids.claudeWork, scope: 'user', preview: true });
    assert.equal(done, false);
    assert.deepEqual(plan.argv, ['claude', 'mcp', 'add', '--scope', 'user', '--transport', 'http', 'figma', 'https://mcp.figma.com/mcp']);
    assert.deepEqual(plan.env, { name: 'CLAUDE_CONFIG_DIR', value: join(home, '.claude_work') });
    assert.equal(plan.command, `CLAUDE_CONFIG_DIR=${join(home, '.claude_work')} claude mcp add --scope user --transport http figma https://mcp.figma.com/mcp`);
    assert.equal(plan.mode, 'run');
    assert.equal(plan.file, '~/.claude_work/.claude.json');
    assert.match(plan.after ?? '', /claude mcp login figma/);
    assert.equal(calls().length, before, 'nothing ran');
    assert.equal(readFileSync(join(home, '.claude_work', '.claude.json'), 'utf8'), homeBefore, 'nothing was written');
  });

  test('add runs the CLI as that account, with no shell, then confirms from the file', async () => {
    const result = await t.owner.call('mcp.add', { catalogId: 'figma', accountId: ids.claudeWork, scope: 'user' });
    assert.equal(result.done, true);
    const call = calls().at(-1)!;
    assert.deepEqual(call.argv, ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'figma', 'https://mcp.figma.com/mcp']);
    assert.equal(call.cfg, join(home, '.claude_work'));
    assert.equal(call.cwd, realpathSync(join(fixture, 'data', 'probe')), 'user scope runs in no project');
    await refresh();
    assert.equal(server('figma').accountId, ids.claudeWork);
    await assert.rejects(t.owner.call('mcp.add', { catalogId: 'figma', accountId: ids.claudeWork, scope: 'user' }), /already there/);

    // The default account sets no variable at all.
    await t.owner.call('mcp.add', { catalogId: 'playwright', accountId: ids.claudeDefault, scope: 'user' });
    assert.equal(calls().at(-1)!.cfg, null);
    assert.deepEqual(calls().at(-1)!.argv, ['mcp', 'add', '--scope', 'user', 'playwright', 'npx', '@playwright/mcp@latest']);
  });

  test('project scope writes the repository’s .mcp.json from inside it, and says so', async () => {
    const { plan } = await t.owner.call('mcp.add', { catalogId: 'notion', accountId: ids.claudeDefault, scope: 'project', projectId, preview: true });
    assert.match(plan.effect, /\.mcp\.json.*git will see the change/);
    await t.owner.call('mcp.add', { catalogId: 'notion', accountId: ids.claudeDefault, scope: 'project', projectId });
    assert.equal(calls().at(-1)!.cwd, realpathSync(join(fixture, 'site')));
    const json = JSON.parse(readFileSync(join(fixture, 'site', '.mcp.json'), 'utf8'));
    assert.deepEqual(json.mcpServers.notion, { type: 'http', url: 'https://mcp.notion.com/mcp' });
    const activity = await t.owner.call('activity.list', { projectId });
    assert.ok(activity.some((a) => a.verb === 'added an MCP server' && a.detail?.includes('notion')));
    await assert.rejects(t.owner.call('mcp.add', { catalogId: 'notion', accountId: ids.claudeDefault, scope: 'project' }), /Which project/);
    await assert.rejects(t.owner.call('mcp.add', { catalogId: 'notion', accountId: ids.codexDefault, scope: 'project', projectId }), /whole account/);
  });

  test('a key, or a Codex browser sign-in, is finished by the owner in a terminal', async () => {
    const github = await t.owner.call('mcp.add', { catalogId: 'github', accountId: ids.claudeWork, scope: 'user', preview: true });
    assert.equal(github.plan.mode, 'terminal');
    assert.match(github.plan.why ?? '', /deletes this terminal’s record/);
    assert.match(github.plan.command, /--header 'Authorization: Bearer YOUR_GITHUB_PAT'$/);
    await assert.rejects(t.owner.call('mcp.add', { catalogId: 'github', accountId: ids.claudeWork, scope: 'user' }), /finishes in a terminal/);
    const linear = await t.owner.call('mcp.add', { catalogId: 'linear', accountId: ids.codexDefault, scope: 'user', preview: true });
    assert.equal(linear.plan.mode, 'terminal');
    assert.match(linear.plan.why ?? '', /signs in/);

    const before = calls().length;
    const session = await t.owner.call('mcp.terminal', { catalogId: 'github', accountId: ids.claudeWork, scope: 'user', hostProjectId: projectId });
    assert.equal(session.provider, 'shell');
    assert.equal(session.projectId, projectId);
    // The terminal echoes what was typed, wrapped at its width.
    const typed = (): string => t.core.sessions.replay(session.id).replay.replace(/ \r/g, '');
    await waitFor('the command typed', () => typed().includes("--header 'Authorization: Bearer YOUR_GITHUB_PAT'"));
    assert.ok(typed().includes(`CLAUDE_CONFIG_DIR=${join(home, '.claude_work')} claude mcp add --scope user`));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(calls().length, before, 'typed, never run');
    await t.owner.call('sessions.stop', { id: session.id });
  });

  test('codex: add as the account’s CODEX_HOME, and remove is confirmed from the file, not the exit code', async () => {
    await t.owner.call('mcp.add', { catalogId: 'playwright', accountId: ids.codexDefault, scope: 'user' });
    const add = calls().at(-1)!;
    assert.deepEqual(add.argv, ['mcp', 'add', 'playwright', '--', 'npx', '@playwright/mcp@latest']);
    assert.equal(add.codexHome, null, 'the default Codex account sets no CODEX_HOME');
    await refresh();
    const pw = server('playwright', 'codex');
    const preview = await t.owner.call('mcp.remove', { id: pw.id, preview: true });
    assert.deepEqual(preview.plan.argv, ['codex', 'mcp', 'remove', 'playwright']);
    process.env.WG_FAKE_NOOP = '1';
    await assert.rejects(t.owner.call('mcp.remove', { id: pw.id }), /did not make the change: No MCP server named/);
    delete process.env.WG_FAKE_NOOP;
    await t.owner.call('mcp.remove', { id: pw.id });
    await refresh();
    assert.ok(!servers().some((s) => s.name === 'playwright' && s.agent === 'codex'));
  });

  test('remove goes through the CLI for the right scope; plugin and repository Codex servers are refused', async () => {
    const local = server('site-local');
    const { plan } = await t.owner.call('mcp.remove', { id: local.id, preview: true });
    assert.deepEqual(plan.argv, ['claude', 'mcp', 'remove', 'site-local', '--scope', 'local']);
    await t.owner.call('mcp.remove', { id: local.id });
    assert.equal(calls().at(-1)!.cwd, realpathSync(join(fixture, 'site')), 'a local server is removed from inside its folder');
    await refresh();
    assert.ok(!servers().some((s) => s.name === 'site-local'));
    await assert.rejects(t.owner.call('mcp.remove', { id: server('plugin:github:github').id }), /comes with a plugin/);
    await assert.rejects(t.owner.call('mcp.remove', { id: server('repo-tool').id }), /Edit the file/);
    await assert.rejects(t.owner.call('mcp.remove', { id: 'nope' }), /no longer configured/);
  });

  test('check connections asks Claude Code itself, as the account, and keeps only names and statuses', async () => {
    const check = await t.owner.call('mcp.check', { accountId: ids.claudeDefault });
    const call = calls().at(-1)!;
    assert.deepEqual(call.argv, ['mcp', 'list']);
    assert.equal(call.cfg, null);
    assert.deepEqual(check.results.map((r) => `${r.name}: ${r.status}`).sort(), [
      'broken: Failed to connect', 'claude.ai Figma: Needs authentication', 'github: Connected', 'playwright: Connected', 'tool: Connected',
    ]);
    for (const secret of SECRETS) assert.ok(!JSON.stringify(check).includes(secret));
    await refresh();
    assert.equal(listing.checks.length, 1, 'the last check is kept for the page');
    await assert.rejects(t.owner.call('mcp.check', { accountId: ids.codexDefault }), /Only Claude Code/);
  });

  test('MCP is the owner’s: a session cannot list, add, remove or check', async () => {
    const session = await t.owner.call('sessions.start', { projectId, provider: 'claude' });
    const agent = await CoreClient.connect(t.core.paths.socket, await tokenOf(t.core, session.id));
    try {
      for (const method of ['mcp.list', 'mcp.catalog', 'mcp.add', 'mcp.terminal', 'mcp.remove', 'mcp.check'] as const) {
        await assert.rejects(agent.call(method as 'mcp.list', {} as never), /not available to a session/);
      }
    } finally {
      agent.close();
      await t.owner.call('sessions.stop', { id: session.id });
    }
  });
});
