// The installed Gemini CLI, launched by a real core the way a session is:
// Wanigan's Gemini home, its hooks and the relay. Gemini fires SessionStart as
// its window opens, before any sign-in, so this needs no login and calls no
// model. Then Gemini itself, pointed at Wanigan's Gemini home, is asked which
// MCP servers and skills a session there gets: the pretend owner's own, copied
// and linked in. A throwaway data folder, home and project; nothing of the
// owner's is read or written. Run under Electron's Node:
//
//   node scripts/run-electron-node.mjs scripts/gemini-check.ts
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../src/core/core.ts';
import { dispatch } from '../src/core/handlers.ts';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'wg-gemini-')));
const home = join(base, 'home');
const site = join(base, 'site');
mkdirSync(home, { recursive: true });
mkdirSync(site, { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: site });
// The pretend owner's own Gemini: a stdio MCP server that answers the protocol's
// handshake and ping, and a skill in the Agent Skills folder.
const server = join(base, 'acme-tools.mjs');
writeFileSync(server, `import { createInterface } from 'node:readline';
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.id === undefined) continue;
  const result = m.method === 'initialize' ? { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'acme-tools', version: '1.0.0' } }
    : m.method === 'tools/list' ? { tools: [] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
}
`);
mkdirSync(join(home, '.gemini'), { recursive: true });
// A second server with a key written into its settings, which Wanigan must not copy.
const INLINE_KEY = 'acme-not-a-real-key-0123456789abcdef';
writeFileSync(join(home, '.gemini', 'settings.json'), `{\n  // the pretend owner's\n  "mcpServers": {\n    "acme-tools": { "command": "node", "args": [${JSON.stringify(server)}] },\n    "acme-inline": { "command": "node", "args": [${JSON.stringify(server)}], "env": { "ACME_API_KEY": "${INLINE_KEY}" } }\n  }\n}\n`);
mkdirSync(join(home, '.agents', 'skills', 'acme-release'), { recursive: true });
writeFileSync(join(home, '.agents', 'skills', 'acme-release', 'SKILL.md'), '---\nname: acme-release\ndescription: Cut a release of the Acme storefront.\n---\n\nTag it, then write the notes.\n');
const results: string[] = [];
const owner = { role: 'owner' as const };
const core = new Core({
  dataDir: join(base, 'data'),
  accounts: { home, prober: async () => ({ signedIn: 'unknown', identity: null, plan: null }) },
  codexHookProbe: null,
  jev: { envKey: null },
  local: { lmsBin: null, ollamaUrl: 'http://127.0.0.1:9' },
});
const call = <T>(method: string, params: unknown): Promise<T> => dispatch(core.handlers, method, params, owner) as Promise<T>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
try {
  await core.start();
  const version = execFileSync('/bin/zsh', ['-lc', 'GEMINI_CLI_HOME=$(mktemp -d)/none gemini --version'], { encoding: 'utf8' }).trim();
  results.push(`Gemini CLI ${version}`);
  const project = await call<{ id: string }>('projects.add', { path: site });
  const session = await call<{ id: string; conversationId: string }>('sessions.start', { projectId: project.id, provider: 'gemini', cols: 120, rows: 36 });
  const plainScreen = async (): Promise<string> => (await call<{ replay: string }>('sessions.watch', { id: session.id })).replay
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
  // A new folder: Gemini asks whether to trust it, and loads no hooks (Wanigan's included) until it is.
  let need = null as null | { detail: string | null };
  for (let i = 0; i < 40 && !need; i++) {
    await sleep(500);
    need = (await call<{ sessionId: string; kind: string; detail: string | null }[]>('needs.list', {})).find((n) => n.sessionId === session.id && n.kind === 'starting') ?? null;
  }
  const asked = /Do you trust the files in this folder/.test(await plainScreen());
  results.push(asked && need ? 'Gemini asked whether to trust the folder, and Needs you raised it: "Has not reported starting…"' : `FAIL: the folder question (on screen: ${asked}, in Needs you: ${!!need})`);
  // The owner answers as they would: Trust folder is the first choice.
  await call('sessions.input', { id: session.id, data: '\r' });
  let got: { session: { state: string }; events: { event: string }[] } | null = null;
  for (let i = 0; i < 60; i++) {
    got = await call('sessions.get', { id: session.id });
    if (got!.events.some((e) => e.event === 'SessionStart')) break;
    await sleep(500);
  }
  const started = got!.events.some((e) => e.event === 'SessionStart');
  results.push(started ? `after the folder was trusted, its SessionStart hook reached Wanigan through the relay; the session is ${got!.session.state}` : 'FAIL: no hook arrived from Gemini in 30 s after the folder was trusted');
  const screen = await plainScreen();
  if (process.env.SHOW_SCREEN) console.log(screen.replace(/[ \t]+/g, ' ').split('\n').map((l) => l.trim()).filter(Boolean).slice(-30).join('\n'));
  results.push(/Security Warning/.test(screen) ? 'FAIL: Gemini warned about Wanigan’s settings' : 'no security warning about Wanigan’s settings');
  const learnt = (await call<{ session: { conversationId: string | null } }>('sessions.get', { id: session.id })).session.conversationId;
  results.push(learnt ? `Wanigan learnt Gemini’s conversation id from its hook (${learnt.slice(0, 8)}…), so it can be resumed` : 'FAIL: no conversation id was learnt');
  results.push(/hook_context|Hook .*(failed|error)|\[wanigan\]/i.test(screen) ? `FAIL: Gemini showed hook output: ${screen.replace(/\s+/g, ' ').slice(-300)}` : 'nothing from the hooks was printed in Gemini’s window');
  const cleared = !(await call<{ sessionId: string; kind: string }[]>('needs.list', {})).some((n) => n.sessionId === session.id && n.kind === 'starting');
  results.push(cleared ? 'the Needs you row cleared on Gemini’s own report' : 'FAIL: Needs you still says it has not started');
  await call('sessions.stop', { id: session.id });
  // Gemini itself, in Wanigan's Gemini home, in the folder the session trusted, with no network but this Mac.
  const profile = join(base, 'localhost-only.sb');
  writeFileSync(profile, '(version 1)\n(allow default)\n(deny network-outbound)\n(allow network-outbound (remote ip "localhost:*"))\n(allow network-outbound (remote unix-socket))\n');
  // It prints its listings through its debug logger, on stdout and stderr both.
  const asGemini = (...args: string[]): string => {
    const r = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, 'gemini', ...args], {
      cwd: site, encoding: 'utf8', timeout: 60_000,
      env: { HOME: home, GEMINI_CLI_HOME: join(base, 'data', 'gemini-home'), PATH: execFileSync('/bin/zsh', ['-lc', 'printf %s "$PATH"'], { encoding: 'utf8' }), TERM: 'dumb' },
    });
    return `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
  };
  const mcp = asGemini('mcp', 'list');
  results.push(/✓ acme-tools: node .*acme-tools\.mjs \(stdio\) - Connected/.test(mcp)
    ? 'Gemini in Wanigan’s home lists the owner’s MCP server, copied in, and connects to it'
    : `FAIL: gemini mcp list in Wanigan’s home said: ${mcp.trim().split('\n').slice(-12).join(' | ')}`);
  const copied = readFileSync(join(base, 'data', 'gemini-home', '.gemini', 'settings.json'), 'utf8');
  results.push(!/acme-inline/.test(mcp) && !copied.includes(INLINE_KEY)
    ? 'the server with a key written into its settings was not copied: Gemini in Wanigan’s home does not list it, and the key is not in Wanigan’s data folder'
    : 'FAIL: the server with an inline key reached Wanigan’s Gemini home');
  const skills = asGemini('skills', 'list');
  results.push(/acme-release \[Enabled\][\s\S]*Location:\s+\S*gemini-home\/\.agents\/skills\/acme-release\/SKILL\.md/.test(skills)
    ? 'Gemini in Wanigan’s home finds the owner’s skill through the link to ~/.agents/skills'
    : `FAIL: gemini skills list in Wanigan’s home said: ${skills.trim().split('\n').slice(-4).join(' | ')}`);
} catch (error) {
  results.push(`FAIL: ${(error as Error).message}`);
} finally {
  await core.stop();
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
for (const r of results) console.log(`  ${r}`);
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
