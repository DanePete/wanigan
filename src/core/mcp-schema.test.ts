// Owner RPCs, owned configuration, and an inert CLI stand-in. No configured server runs.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { testCore, type TestCore } from './test-support.ts';
import { shellQuote } from './hooks.ts';

const CLAUDE = JSON.stringify({ mcpServers: { owned: { command: 'owned-never-run', args: ['healthy-literal'] } } });
const CODEX = '[mcp_servers.owned]\ncommand = "owned-never-run"\nargs = ["healthy-literal"]\n';

async function fixture(context: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wg-mcp-schema-')));
  const home = join(root, 'home'), claudeHome = join(home, '.claude_probe'), codexHome = join(home, '.codex_probe');
  mkdirSync(claudeHome, { recursive: true }); mkdirSync(codexHome, { recursive: true });
  const claudeFile = join(claudeHome, '.claude.json'), codexFile = join(codexHome, 'config.toml');
  const log = join(root, 'calls.jsonl'), mode = join(root, 'mode'), script = join(root, 'stand-in.mjs'), binary = join(root, 'owned-cli');
  writeFileSync(join(claudeHome, 'settings.json'), '{}'); writeFileSync(claudeFile, CLAUDE); writeFileSync(codexFile, CODEX); writeFileSync(mode, 'noop');
  writeFileSync(script, `import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const argv=process.argv.slice(2), mode=readFileSync(${JSON.stringify(mode)},'utf8');
const cfg=process.env.CLAUDE_CONFIG_DIR??process.env.CODEX_HOME;
assert.ok([${JSON.stringify(claudeHome)},${JSON.stringify(codexHome)}].includes(cfg));
assert.equal(argv[0],'mcp'); assert.ok(['add','remove'].includes(argv[1]));
appendFileSync(${JSON.stringify(log)},JSON.stringify({argv,cfg,mode,cwd:process.cwd()})+'\\n');
if(mode!=='noop'){
 const codex=cfg===${JSON.stringify(codexHome)};
 const scope=codex?'user':argv[argv.indexOf('--scope')+1];
 const file=codex?${JSON.stringify(codexFile)}:scope==='project'?process.cwd()+'/.mcp.json':${JSON.stringify(claudeFile)};
 const name=argv[1]==='add'?'playwright':argv[2];
 const servers=mode==='invalid'?[]:mode==='invalid-row'?{[name]:{command:'owned-never-run',args:[{toString:null}]}}:{};
 if(codex)writeFileSync(file,mode==='invalid'?'mcp_servers = []\\n':mode==='invalid-row'?'[mcp_servers.'+name+']\\ncommand="owned-never-run"\\nargs=[{toString=0}]\\n':'');
 else {const value=JSON.parse(readFileSync(file,'utf8'));if(scope==='local')value.projects[process.cwd()].mcpServers=servers;else value.mcpServers=servers;writeFileSync(file,JSON.stringify(value));}
}
`);
  writeFileSync(binary, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`, { mode: 0o755 });
  let t: TestCore | undefined;
  context.after(async () => { await t?.close(); rmSync(root, { recursive: true, force: true }); });
  t = await testCore({ accounts: { home }, mcpBinaries: { claude: binary, codex: binary } });
  await t.core.accounts.refresh();
  const accounts = await t.owner.call('accounts.list', {});
  const claude = accounts.find(a => a.configDir === claudeHome), codex = accounts.find(a => a.configDir === codexHome);
  assert.ok(claude && codex);
  const listing = await t.owner.call('mcp.list', {});
  const claudeGroup = listing.groups.find(g => g.servers.some(s => s.accountId === claude.id));
  const codexGroup = listing.groups.find(g => g.servers.some(s => s.accountId === codex.id));
  assert.ok(claudeGroup && codexGroup);
  const calls = () => existsSync(log) ? readFileSync(log,'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { ...t, root, claude, codex, claudeGroup, codexGroup, claudeFile, codexFile, mode, calls };
}

for (const agent of ['claude', 'codex'] as const) test(`${agent}: malformed user server mappings are unknown and refuse add without dispatch`, async context => {
  const f = await fixture(context), file = agent === 'claude' ? f.claudeFile : f.codexFile;
  const group = agent === 'claude' ? f.claudeGroup : f.codexGroup, account = agent === 'claude' ? f.claude : f.codex;
  const values = agent === 'claude' ? ['[]', 'null', 'false', '1', '"INVENTED_INVALID_VALUE"'] : ['[]', 'false', '1', '"INVENTED_INVALID_VALUE"'];
  for (const value of values) {
    const bad = agent === 'claude' ? `{"mcpServers":${value}}` : `mcp_servers = ${value}\n`;
    writeFileSync(file, bad);
    const listing = await f.owner.call('mcp.list', {});
    assert.equal(listing.empty.some(e => e.agent === agent && e.where === group.where), false, value);
    assert.match(listing.groups.find(g => g.id === group.id)?.note ?? '', /invalid|could not read/i);
    assert.ok(listing.groups.some(g => g.agent !== agent && g.servers.some(s => s.name === 'owned')));
    assert.equal(JSON.stringify(listing).includes('INVENTED_INVALID_VALUE'), false);
    for (const preview of [true, false]) await assert.rejects(f.owner.call('mcp.add', { catalogId: 'playwright', accountId: account.id, scope: 'user', preview }), /could not verify/i);
    assert.equal(f.calls().length, 0); assert.equal(readFileSync(file, 'utf8'), bad);
  }
});

async function projectFixture(context: TestContext) {
  const f = await fixture(context);
  const project = await f.owner.call('projects.add', { path: f.projectDir });
  await f.owner.call('projects.setAccount', { id: project.id, provider: 'claude', accountId: f.claude.id });
  const local = { [f.projectDir]: { mcpServers: { localOwned: { command: 'owned-never-run' } } }, '/owned/unopened': { mcpServers: { otherLocal: { command: 'owned-never-run' } } } };
  const config = { ...JSON.parse(CLAUDE), projects: local };
  writeFileSync(f.claudeFile, JSON.stringify(config));
  const projectFile = join(f.projectDir, '.mcp.json'); writeFileSync(projectFile, CLAUDE);
  mkdirSync(join(f.projectDir, '.codex')); const codexProjectFile = join(f.projectDir, '.codex/config.toml'); writeFileSync(codexProjectFile, CODEX);
  return { ...f, project, config, projectFile, codexProjectFile };
}

test('Claude project and local malformed mappings remain scoped unknown while healthy rows survive', async context => {
  const f = await projectFixture(context);
  for (const shape of ['project', 'local', 'local-entry', 'projects'] as const) {
    const config = structuredClone(f.config);
    const bad = shape === 'project' ? '{"mcpServers":[]}' : JSON.stringify({ ...config, projects: shape === 'projects' ? [] : { ...config.projects, [f.projectDir]: shape === 'local-entry' ? null : { mcpServers: [] } } });
    const file = shape === 'project' ? f.projectFile : f.claudeFile; writeFileSync(file, bad);
    const listing = await f.owner.call('mcp.list', {});
    const projectGroup = listing.groups.find(g => g.agent === 'claude' && g.projectId === f.project.id);
    const note = shape === 'projects' ? listing.groups.find(g => g.id === f.claudeGroup.id)?.note : projectGroup?.note;
    assert.match(note ?? '', /invalid|could not read/i, shape);
    assert.ok(listing.groups.find(g => g.id === f.claudeGroup.id)?.servers.some(s => s.scope === 'user' && s.name === 'owned'));
    if (shape === 'project') assert.ok(projectGroup?.servers.some(s => s.name === 'localOwned'));
    else assert.ok(projectGroup?.servers.some(s => s.scope === 'project' && s.name === 'owned'));
    if (shape === 'local' || shape === 'local-entry') assert.ok(listing.groups.find(g => g.id === f.claudeGroup.id)?.servers.some(s => s.name === 'otherLocal'));
    for (const preview of [true, false]) await assert.rejects(f.owner.call('mcp.add', { catalogId: 'playwright', accountId: f.claude.id, scope: shape === 'project' ? 'project' : 'local', projectId: f.project.id, preview }), /could not verify/i);
    assert.equal(f.calls().length, 0); assert.equal(readFileSync(file, 'utf8'), bad);
    writeFileSync(f.claudeFile, JSON.stringify(f.config)); writeFileSync(f.projectFile, CLAUDE);
  }
});

test('Codex malformed project mapping keeps a noted project group beside healthy account rows', async context => {
  const f = await projectFixture(context); writeFileSync(f.codexProjectFile, 'mcp_servers = []\n');
  const listing = await f.owner.call('mcp.list', {});
  const group = listing.groups.find(g => g.agent === 'codex' && g.projectId === f.project.id);
  assert.match(group?.note ?? '', /invalid|could not read/i); assert.equal(group?.servers.length, 0);
  assert.ok(listing.groups.find(g => g.id === f.codexGroup.id)?.servers.some(s => s.name === 'owned'));
  assert.equal(f.calls().length, 0); assert.equal(readFileSync(f.codexProjectFile, 'utf8'), 'mcp_servers = []\n');
});

for (const scope of ['user', 'local', 'project'] as const) test(`Claude ${scope} removal refuses a malformed postcondition and accepts an actual empty mapping`, async context => {
  const f = await projectFixture(context);
  const listing = await f.owner.call('mcp.list', {}), name = scope === 'local' ? 'localOwned' : 'owned';
  const server = listing.groups.flatMap(g => g.servers).find(s => s.agent === 'claude' && s.scope === scope && s.name === name); assert.ok(server);
  writeFileSync(f.mode, 'invalid'); await assert.rejects(f.owner.call('mcp.remove', { id: server.id }), /could not verify/i);
  assert.equal(f.calls().length, 1);
  const changed = JSON.parse(readFileSync(scope === 'project' ? f.projectFile : f.claudeFile, 'utf8'));
  assert.deepEqual(scope === 'local' ? changed.projects[f.projectDir].mcpServers : changed.mcpServers, []);
  writeFileSync(f.claudeFile, JSON.stringify(f.config)); writeFileSync(f.projectFile, CLAUDE); writeFileSync(f.mode, 'empty');
  const result = await f.owner.call('mcp.remove', { id: server.id }); assert.equal(result.done, true);
  const after = await f.owner.call('mcp.list', {}); assert.equal(after.groups.flatMap(g => g.servers).some(s => s.id === server.id), false);
  assert.equal(f.calls().length, 2);
});

for (const agent of ['claude', 'codex'] as const) test(`${agent}: invalid argument rows preserve healthy rows in the same file without stringifying objects`, async context => {
  const f = await fixture(context), file = agent === 'claude' ? f.claudeFile : f.codexFile;
  const group = agent === 'claude' ? f.claudeGroup : f.codexGroup, account = agent === 'claude' ? f.claude : f.codex;
  const bad = agent === 'claude'
    ? JSON.stringify({ ...JSON.parse(CLAUDE), mcpServers: { ...JSON.parse(CLAUDE).mcpServers, playwright: { command: 'owned-never-run', args: [{ toString: null, marker: 'INVENTED_INVALID_ARGUMENT' }] } } })
    : CODEX + '\n[mcp_servers.playwright]\ncommand="owned-never-run"\nargs=[{toString=0, marker="INVENTED_INVALID_ARGUMENT"}]\n';
  writeFileSync(file, bad);
  const listing = await f.owner.call('mcp.list', {}), affected = listing.groups.find(g => g.id === group.id); assert.ok(affected);
  assert.ok(affected.servers.some(s => s.name === 'owned' && s.accountId === account.id && s.target === 'owned-never-run healthy-literal'));
  assert.equal(affected.servers.some(s => s.name === 'playwright'), false); assert.match(affected.note ?? '', /invalid/i);
  assert.equal(JSON.stringify(listing).includes('INVENTED_INVALID_ARGUMENT'), false);
  await assert.rejects(f.owner.call('mcp.add', { catalogId: 'playwright', accountId: account.id, scope: 'user' }), /could not verify/i);
  assert.equal(f.calls().length, 0); assert.equal(readFileSync(file, 'utf8'), bad);
  writeFileSync(file, agent === 'claude' ? CLAUDE : CODEX);
  const repaired = await f.owner.call('mcp.list', {}); assert.equal(repaired.groups.find(g => g.id === group.id)?.note, null);
});

for (const agent of ['claude', 'codex'] as const) test(`${agent}: missing and empty mappings remain known absence`, async context => {
  const f = await fixture(context), file = agent === 'claude' ? f.claudeFile : f.codexFile;
  const group = agent === 'claude' ? f.claudeGroup : f.codexGroup, account = agent === 'claude' ? f.claude : f.codex;
  for (const text of agent === 'claude' ? ['{}', '{"mcpServers":{}}'] : ['', '[mcp_servers]\n']) {
    writeFileSync(file, text); const listing = await f.owner.call('mcp.list', {});
    assert.ok(listing.empty.some(e => e.agent === agent && e.where === group.where));
    const preview = await f.owner.call('mcp.add', { catalogId: 'playwright', accountId: account.id, scope: 'user', preview: true });
    assert.equal(preview.plan.exists, false); assert.equal(preview.done, false); assert.equal(f.calls().length, 0);
    assert.equal(readFileSync(file, 'utf8'), text);
  }
});

for (const agent of ['claude', 'codex'] as const) test(`${agent}: zero exit with an invalid added row cannot certify success`, async context => {
  const f = await fixture(context), account = agent === 'claude' ? f.claude : f.codex, file = agent === 'claude' ? f.claudeFile : f.codexFile;
  writeFileSync(f.mode, 'invalid-row');
  await assert.rejects(f.owner.call('mcp.add', { catalogId: 'playwright', accountId: account.id, scope: 'user' }), /could not verify/i);
  assert.equal(f.calls().length, 1); assert.ok(readFileSync(file, 'utf8').includes('toString'));
  const listing = await f.owner.call('mcp.list', {}), group = agent === 'claude' ? f.claudeGroup : f.codexGroup;
  assert.match(listing.groups.find(g => g.id === group.id)?.note ?? '', /invalid/i);
});

test('Codex removal refuses an invalid collection or retained invalid row and accepts known empty', async context => {
  const f = await fixture(context), id = f.codexGroup.servers[0]!.id;
  for (const mode of ['invalid', 'invalid-row']) {
    writeFileSync(f.mode, mode); await assert.rejects(f.owner.call('mcp.remove', { id }), /could not verify/i);
    assert.notEqual(readFileSync(f.codexFile, 'utf8'), CODEX); writeFileSync(f.codexFile, CODEX);
  }
  writeFileSync(f.mode, 'empty'); const result = await f.owner.call('mcp.remove', { id }); assert.equal(result.done, true);
  assert.equal(readFileSync(f.codexFile, 'utf8'), ''); assert.equal(f.calls().length, 3);
});

for (const agent of ['claude', 'codex'] as const) test(`${agent}: malformed server rows and argument types are noted without hiding a valid neighbor`, async context => {
  const f = await fixture(context), account = agent === 'claude' ? f.claude : f.codex, file = agent === 'claude' ? f.claudeFile : f.codexFile;
  const group = agent === 'claude' ? f.claudeGroup : f.codexGroup;
  const values = ['[]', 'false', '42', '"INVENTED_INVALID_ROW"'];
  for (const value of values) {
    const text = agent === 'claude' ? `{"mcpServers":{"owned":{"command":"owned-never-run"},"bad":${value}}}` : `mcp_servers = {owned={command="owned-never-run"},bad=${value}}\n`;
    writeFileSync(file, text); const listed = (await f.owner.call('mcp.list', {})).groups.find(g => g.id === group.id);
    assert.ok(listed?.servers.some(s => s.name === 'owned' && s.accountId === account.id)); assert.equal(listed?.servers.some(s => s.name === 'bad'), false);
    assert.match(listed?.note ?? '', /invalid/i); assert.equal(JSON.stringify(listed).includes('INVENTED_INVALID_ROW'), false);
  }
  for (const args of ['false', '42', '"INVENTED_INVALID_ARGUMENT"', '["valid",42]']) {
    const text = agent === 'claude' ? `{"mcpServers":{"owned":{"command":"owned-never-run"},"bad":{"command":"owned-never-run","args":${args}}}}` : `mcp_servers = {owned={command="owned-never-run"},bad={command="owned-never-run",args=${args}}}\n`;
    writeFileSync(file, text); const listed = (await f.owner.call('mcp.list', {})).groups.find(g => g.id === group.id);
    assert.ok(listed?.servers.some(s => s.name === 'owned')); assert.equal(listed?.servers.some(s => s.name === 'bad'), false); assert.match(listed?.note ?? '', /invalid/i);
    assert.equal(JSON.stringify(listed).includes('INVENTED_INVALID_ARGUMENT'), false);
  }
  assert.equal(f.calls().length, 0);
});

test('plugin argument validation retains valid selected-source rows and separate installed plugin identities', async context => {
  const f = await fixture(context), pluginHome = join(f.root, 'home/.claude_probe/plugins');
  const one = join(pluginHome, 'cache/one'), two = join(pluginHome, 'cache/two');
  for (const path of [one, two]) mkdirSync(join(path, '.claude-plugin'), { recursive: true });
  writeFileSync(join(one, '.mcp.json'), JSON.stringify({ same: { command: 'unselected-never-run' } }));
  writeFileSync(join(one, 'declared.json'), JSON.stringify({ same: { command: 'selected-one-never-run' }, broken: { command: 'owned-never-run', args: [{ toString: null }] } }));
  writeFileSync(join(one, '.claude-plugin/plugin.json'), JSON.stringify({ mcpServers: 'declared.json' }));
  writeFileSync(join(two, '.claude-plugin/plugin.json'), JSON.stringify({ mcpServers: { same: { command: 'selected-two-never-run' } } }));
  writeFileSync(join(pluginHome, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'owned@one': [{ scope: 'user', installPath: one }], 'owned@two': [{ scope: 'user', installPath: two }] } }));
  const listing = await f.owner.call('mcp.list', {}), group = listing.groups.find(g => g.id === f.claudeGroup.id); assert.ok(group);
  const selected = group.servers.filter(s => s.name === 'plugin:owned:same');
  assert.deepEqual(selected.map(s => s.target), ['selected-one-never-run', 'selected-two-never-run']);
  assert.equal(new Set(selected.map(s => s.id)).size, 2); assert.ok(selected.every(s => !s.removable));
  assert.ok(group.servers.some(s => s.name === 'owned' && s.scope === 'user'));
  assert.equal(group.servers.some(s => s.name === 'plugin:owned:broken'), false); assert.match(group.note ?? '', /invalid server entry or arguments/);
  assert.equal(f.calls().length, 0);
});
