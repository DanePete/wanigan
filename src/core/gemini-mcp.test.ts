// Gemini CLI's MCP servers against a pretend home, with a stand-in `gemini`
// shaped like Gemini CLI 0.46's own `gemini mcp add|remove` (run against a
// throwaway home with no network): the same argv, files, messages and exit
// codes, including what it does in a folder it does not trust (it writes the
// project's settings back with only its MCP servers, and finds nothing to
// remove). Nothing here reads or writes the real home, or reaches a network.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { McpListing, McpServer } from '../shared/mcp.ts';
import { shellQuote } from './hooks.ts';
import { testCore, type TestCore } from './test-support.ts';

const SECRETS = ['ghp_gem0123456789abcdefABCDEF', 'sk-gemini-abcdef123456', 'acme-gem-token-7f6e5d4c3b2a'];

/** Gemini CLI 0.46's `gemini mcp add|remove`, as seen run: argv in, settings.json out, every call logged. */
const FAKE = `
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const argv = process.argv.slice(2);
appendFileSync(process.env.WG_FAKE_LOG, JSON.stringify({ argv, cwd: process.cwd(), geminiHome: process.env.GEMINI_CLI_HOME ?? null, trust: process.env.GEMINI_CLI_TRUST_WORKSPACE ?? null }) + '\\n');
const home = process.env.WG_FAKE_HOME;
const strip = (t) => t.replace(/^\\s*\\/\\/.*$/gm, '');
const read = (f) => (existsSync(f) ? JSON.parse(strip(readFileSync(f, 'utf8'))) : {});
const [, verb, ...rest] = argv;
const opts = { scope: 'project', transport: 'stdio', header: [], env: [] }; const pos = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '--') { pos.push(...rest.slice(i + 1)); break; }
  if (a === '--scope' || a === '-s') { opts.scope = rest[++i]; continue; }
  if (a === '--transport' || a === '-t') { opts.transport = rest[++i]; continue; }
  if (a === '--header' || a === '-H') { opts.header.push(rest[++i]); continue; }
  if (a === '--env' || a === '-e') { opts.env.push(rest[++i]); continue; }
  pos.push(a);
}
const user = join(home, '.gemini', 'settings.json');
const file = opts.scope === 'user' ? user : join(process.cwd(), '.gemini', 'settings.json');
const trusted = Object.keys(read(join(home, '.gemini', 'trustedFolders.json'))).includes(process.cwd());
// In a folder Gemini does not trust, its workspace settings load as empty.
const untrusted = opts.scope !== 'user' && process.env.GEMINI_CLI_TRUST_WORKSPACE !== 'true' && !trusted;
const settings = untrusted ? {} : read(file);
const servers = (settings.mcpServers ??= {});
const name = pos[0];
if (verb === 'add') {
  const headers = Object.fromEntries(opts.header.map((h) => [h.split(':')[0].trim(), h.split(':').slice(1).join(':').trim()]));
  const server = opts.transport === 'stdio'
    ? { command: pos[1], args: pos.slice(2) }
    : { url: pos[1], type: opts.transport, ...(opts.header.length ? { headers } : {}) };
  const existed = !!servers[name];
  if (existed) console.log('MCP server "' + name + '" is already configured within ' + opts.scope + ' settings.');
  servers[name] = server;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2));
  console.log(existed ? 'MCP server "' + name + '" updated in ' + opts.scope + ' settings.' : 'MCP server "' + name + '" added to ' + opts.scope + ' settings. (' + opts.transport + ')');
} else if (verb === 'remove') {
  if (process.env.WG_FAKE_NOOP || !servers[name]) { console.log('Server "' + name + '" not found in ' + opts.scope + ' settings.'); process.exit(0); }
  delete servers[name];
  writeFileSync(file, JSON.stringify(settings, null, 2));
  console.log('Server "' + name + '" removed from ' + opts.scope + ' settings.');
}
`;

describe('gemini mcp', () => {
  let t: TestCore;
  let fixture: string;
  let home: string;
  let site: string;
  let log: string;
  let projectId: string;
  let listing: McpListing;
  const servers = (): McpServer[] => listing.groups.flatMap((g) => g.servers);
  const server = (name: string): McpServer => {
    const s = servers().find((x) => x.name === name && x.agent === 'gemini');
    assert.ok(s, `Gemini server ${name} listed`);
    return s;
  };
  const calls = (): { argv: string[]; cwd: string; geminiHome: string | null; trust: string | null }[] =>
    (existsSync(log) ? readFileSync(log, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const refresh = async (): Promise<void> => { listing = await t.owner.call('mcp.list', {}); };
  const userFile = (): Record<string, any> => JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  const projectFile = (): Record<string, any> => JSON.parse(readFileSync(join(site, '.gemini', 'settings.json'), 'utf8'));

  before(async () => {
    fixture = realpathSync(mkdtempSync(join(tmpdir(), 'wg-gemini-mcp-')));
    home = join(fixture, 'home');
    site = join(fixture, 'acme-site');
    log = join(fixture, 'calls.jsonl');
    mkdirSync(join(home, '.gemini'), { recursive: true });
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(site, '.gemini'), { recursive: true });
    // The owner's own settings, with a comment, as Gemini allows.
    writeFileSync(join(home, '.gemini', 'settings.json'), `{
  // mine
  "ui": { "theme": "Dracula" },
  "security": { "auth": { "selectedType": "oauth-personal" } },
  "mcp": { "excluded": ["Old-Tools"] },
  "mcpServers": {
    "acme-tools": { "command": "node", "args": ["tools.js", "--token", "${SECRETS[2]}"], "env": { "ACME_API_KEY": "${SECRETS[1]}", "LOG": "info" }, "trust": true },
    "github": { "url": "https://api.githubcopilot.com/mcp/", "type": "http", "headers": { "Authorization": "Bearer ${SECRETS[0]}" } },
    "legacy": { "url": "https://legacy.example.test/sse", "type": "sse" },
    "older-http": { "httpUrl": "https://mcp.notion.com/mcp" },
    "old-tools": { "command": "npx", "args": ["@acme/old-tools"] },
    "quiet": { "command": "npx", "args": ["@playwright/mcp@latest"] }
  }
}
`);
    writeFileSync(join(home, '.gemini', 'mcp-server-enablement.json'), JSON.stringify({ quiet: { enabled: false } }));
    writeFileSync(join(site, '.gemini', 'settings.json'), JSON.stringify({ ui: { theme: 'GitHub' }, mcpServers: { 'site-db': { command: 'npx', args: ['-y', '@acme/db-mcp'] } } }, null, 2));

    const fakeJs = join(fixture, 'fake-gemini.mjs');
    writeFileSync(fakeJs, FAKE);
    const bin = join(fixture, 'fake-gemini');
    writeFileSync(bin, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} ${shellQuote(fakeJs)} "$@"\n`, { mode: 0o755 });
    process.env.WG_FAKE_LOG = log;
    process.env.WG_FAKE_HOME = home;
    // A GEMINI_CLI_HOME the core inherited never decides which settings a change goes to.
    process.env.GEMINI_CLI_HOME = join(fixture, 'somewhere-else');
    t = await testCore({
      dataDir: join(fixture, 'data'),
      accounts: { home, prober: async () => ({ signedIn: 'unknown', identity: null, plan: null }), usageReader: async () => ({ state: 'unreadable', windows: [], checkedAt: 0, note: 'test' }) },
      mcpBinaries: { gemini: bin },
    });
    projectId = (await t.owner.call('projects.add', { path: site })).id;
    await refresh();
  });

  after(async () => {
    await t?.close();
    rmSync(fixture, { recursive: true, force: true });
    delete process.env.WG_FAKE_LOG;
    delete process.env.WG_FAKE_HOME;
    delete process.env.GEMINI_CLI_HOME;
  });

  test('the owner’s and each project’s Gemini servers are listed as Gemini loads them, with nothing secret', () => {
    const user = listing.groups.find((g) => g.agent === 'gemini' && g.projectId === null)!;
    assert.deepEqual([user.title, user.account, user.where, user.check], ['Gemini CLI', null, '~/.gemini/settings.json', null]);
    assert.match(user.note ?? '', /Wanigan’s Gemini sessions get these too/);
    assert.deepEqual(['acme-tools', 'github', 'legacy', 'older-http'].map((n) => server(n).transport), ['stdio', 'http', 'sse', 'http']);
    assert.equal(server('older-http').catalogId, 'notion');
    assert.match(server('acme-tools').note ?? '', /Trusted: Gemini runs its tools without asking/);
    assert.deepEqual([server('old-tools').enabled, server('old-tools').note], [false, 'Left out by mcp.excluded in Gemini’s settings.'], 'compared as Gemini compares names');
    assert.deepEqual([server('quiet').enabled, server('quiet').note], [false, 'Switched off in Gemini CLI (/mcp disable).']);
    assert.ok(servers().filter((s) => s.agent === 'gemini').every((s) => s.removable && s.accountId === null));
    const project = listing.groups.find((g) => g.agent === 'gemini' && g.projectId === projectId)!;
    assert.deepEqual([project.title, project.where, project.note], ['acme-site', '.gemini/settings.json', 'Gemini CLI loads these only once it trusts the folder.']);
    assert.equal(server('site-db').scope, 'project');
    const text = JSON.stringify(listing);
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `${secret.slice(0, 6)}… is hidden`);
    assert.deepEqual(server('acme-tools').env.map((e) => `${e.key}=${e.value}`), ['ACME_API_KEY=•••', 'LOG=info']);
    assert.ok(listing.notes.some((n) => /Gemini CLI has no connection check/.test(n)));
  });

  test('a preview shows Gemini’s own command for the scope, and runs nothing', async () => {
    const before = calls().length;
    const { plan } = await t.owner.call('mcp.add', { catalogId: 'figma', agent: 'gemini', scope: 'user', preview: true });
    assert.deepEqual(plan.argv, ['gemini', 'mcp', 'add', '--scope', 'user', '--transport', 'http', 'figma', 'https://mcp.figma.com/mcp']);
    assert.equal(plan.env, null);
    assert.equal(plan.command, 'env -u GEMINI_CLI_HOME gemini mcp add --scope user --transport http figma https://mcp.figma.com/mcp');
    assert.equal(plan.file, '~/.gemini/settings.json');
    assert.equal(plan.mode, 'run');
    assert.match(plan.after ?? '', /\/mcp auth figma/);
    const repo = (await t.owner.call('mcp.add', { catalogId: 'context7', agent: 'gemini', scope: 'project', projectId, preview: true })).plan;
    assert.deepEqual(repo.env, { name: 'GEMINI_CLI_TRUST_WORKSPACE', value: 'true' });
    assert.equal(repo.command, 'env -u GEMINI_CLI_HOME GEMINI_CLI_TRUST_WORKSPACE=true gemini mcp add --scope project --transport http context7 https://mcp.context7.com/mcp');
    assert.match(repo.effect, /nothing is added to your trusted folders/);
    await assert.rejects(t.owner.call('mcp.add', { catalogId: 'figma', agent: 'gemini', scope: 'local', projectId, preview: true }), /every project, or to one repository/);
    await assert.rejects(t.owner.call('mcp.add', { catalogId: 'figma', agent: 'grok', scope: 'user', preview: true } as never), /Which agent/);
    assert.equal(calls().length, before, 'nothing ran');
  });

  test('adding to the owner’s settings runs gemini as the owner, with no shell and no inherited home, and keeps the rest of the file', async () => {
    const result = await t.owner.call('mcp.add', { catalogId: 'figma', agent: 'gemini', scope: 'user' });
    assert.equal(result.done, true);
    const call = calls().at(-1)!;
    assert.deepEqual(call.argv, ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'figma', 'https://mcp.figma.com/mcp']);
    assert.equal(call.geminiHome, null, 'the inherited GEMINI_CLI_HOME is unset');
    assert.equal(call.cwd, realpathSync(join(fixture, 'data', 'probe')), 'user scope runs in no project');
    assert.deepEqual(userFile().mcpServers.figma, { url: 'https://mcp.figma.com/mcp', type: 'http' });
    assert.deepEqual(userFile().ui, { theme: 'Dracula' });
    await refresh();
    assert.equal(server('figma').catalogId, 'figma');
    // Gemini would overwrite it and exit 0; Wanigan refuses first.
    await assert.rejects(t.owner.call('mcp.add', { catalogId: 'figma', agent: 'gemini', scope: 'user' }), /already there/);
  });

  test('adding to a project runs inside it, trusted for that one command, so Gemini keeps the file’s other settings', async () => {
    const result = await t.owner.call('mcp.add', { catalogId: 'context7', agent: 'gemini', scope: 'project', projectId });
    assert.equal(result.done, true);
    const call = calls().at(-1)!;
    assert.equal(call.cwd, site);
    assert.equal(call.trust, 'true');
    assert.deepEqual(Object.keys(projectFile().mcpServers).sort(), ['context7', 'site-db'], 'untrusted, Gemini would have kept only the new one');
    assert.deepEqual(projectFile().ui, { theme: 'GitHub' });
    assert.equal(existsSync(join(home, '.gemini', 'trustedFolders.json')), false, 'nothing was trusted');
    const activity = await t.owner.call('activity.list', { projectId });
    assert.ok(activity.some((a) => a.verb === 'added an MCP server' && /context7 \(Gemini CLI, project\)/.test(a.detail ?? '')));
  });

  test('a server that needs a key is finished by the owner in a terminal', async () => {
    const { plan } = await t.owner.call('mcp.add', { catalogId: 'github', agent: 'gemini', scope: 'project', projectId, preview: true });
    assert.equal(plan.mode, 'terminal');
    assert.match(plan.command, /--header 'Authorization: Bearer YOUR_GITHUB_PAT'/);
    await assert.rejects(t.owner.call('mcp.add', { catalogId: 'github', agent: 'gemini', scope: 'project', projectId }), /finishes in a terminal/);
  });

  test('remove goes through gemini for the right scope, and only the file says it worked', async () => {
    await refresh();
    const preview = await t.owner.call('mcp.remove', { id: server('site-db').id, preview: true });
    assert.deepEqual(preview.plan.argv, ['gemini', 'mcp', 'remove', '--scope', 'project', 'site-db']);
    assert.equal(preview.plan.env?.name, 'GEMINI_CLI_TRUST_WORKSPACE');
    assert.equal((await t.owner.call('mcp.remove', { id: server('site-db').id })).done, true);
    assert.equal(calls().at(-1)!.cwd, site);
    assert.deepEqual(Object.keys(projectFile().mcpServers), ['context7']);
    await refresh();
    // Gemini exits 0 when it removed nothing: the file decides.
    process.env.WG_FAKE_NOOP = '1';
    try {
      await assert.rejects(t.owner.call('mcp.remove', { id: server('legacy').id }), /did not make the change/);
    } finally { delete process.env.WG_FAKE_NOOP; }
    assert.ok(userFile().mcpServers.legacy);
    assert.equal((await t.owner.call('mcp.remove', { id: server('legacy').id })).done, true);
    assert.deepEqual(calls().at(-1)!.argv, ['mcp', 'remove', '--scope', 'user', 'legacy']);
    assert.equal(userFile().mcpServers.legacy, undefined);
    assert.deepEqual(userFile().ui, { theme: 'Dracula' });
  });

  test('a Gemini session gets the owner’s servers, allow and leave-out lists and switched-off servers, copied in; the owner’s files are untouched', async () => {
    const owned = readFileSync(join(home, '.gemini', 'settings.json'), 'utf8');
    // What a Gemini session's launch does first (gemini.test.ts launches one).
    const { writeGeminiHome } = await import('./hooks.ts');
    const geminiHome = writeGeminiHome(join(fixture, 'data'), join(fixture, 'data', 'hooks', 'relay.sh'), home);
    const written = JSON.parse(readFileSync(join(geminiHome, '.gemini', 'settings.json'), 'utf8'));
    assert.deepEqual(Object.keys(written.mcpServers), Object.keys(userFile().mcpServers));
    assert.deepEqual(written.mcp, { excluded: ['Old-Tools'] });
    assert.deepEqual(written.security.auth, { selectedType: 'oauth-personal' }, 'read through its comment');
    assert.ok(written.hooks.SessionStart, 'Wanigan’s hooks are still its own');
    assert.equal(written.ui.theme, undefined, 'only what Wanigan needs, and the servers');
    assert.deepEqual(JSON.parse(readFileSync(join(geminiHome, '.gemini', 'mcp-server-enablement.json'), 'utf8')), { quiet: { enabled: false } });
    assert.equal(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8'), owned);
    // None switched off any more: none switched off in Wanigan's Gemini home either.
    rmSync(join(home, '.gemini', 'mcp-server-enablement.json'));
    writeGeminiHome(join(fixture, 'data'), join(fixture, 'data', 'hooks', 'relay.sh'), home);
    assert.equal(existsSync(join(geminiHome, '.gemini', 'mcp-server-enablement.json')), false);
  });
});
