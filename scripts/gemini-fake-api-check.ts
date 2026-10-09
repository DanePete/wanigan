// The installed Gemini CLI, launched by a real core the way a session is, talking
// to a fake Gemini API on this Mac instead of Google's. It shows what only the
// real CLI can: the usage-limit dialog it draws when the API answers 429 is read
// as a limit (with its reset), stopping keeps it, and a turn the API answers is
// counted from the chat file Gemini itself writes.
//
// No login and no model: Gemini runs with a made-up API key, pointed at
// 127.0.0.1 (GOOGLE_GEMINI_BASE_URL), inside a macOS sandbox that refuses every
// other network connection. A throwaway data folder, home and project; nothing
// of the owner's is read or written. Run under Electron's Node:
//
//   node scripts/run-electron-node.mjs scripts/gemini-fake-api-check.ts
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../src/core/core.ts';
import { dispatch } from '../src/core/handlers.ts';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'wg-gemini-api-')));
const home = join(base, 'home');
const site = join(base, 'acme-site');
mkdirSync(join(home, '.gemini'), { recursive: true });
mkdirSync(site, { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: site });
// The owner's chosen sign-in method, as Wanigan copies it into its own Gemini home.
writeFileSync(join(home, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }));
const profile = join(base, 'localhost-only.sb');
writeFileSync(profile, '(version 1)\n(allow default)\n(deny network-outbound)\n(allow network-outbound (remote ip "localhost:*"))\n(allow network-outbound (remote unix-socket))\n');

// The fake API: a Pro model is out of quota (a RetryInfo of two hours, as Code
// Assist answers QUOTA_EXHAUSTED); a Flash model answers, with its usage.
const requests: string[] = [];
const server = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const url = req.url ?? '';
    requests.push(`${req.method} ${url.replace(/\?.*$/, '')}`);
    const model = /models\/([^:]+):/.exec(url)?.[1] ?? '';
    if (/:streamGenerateContent/.test(url) && /pro/.test(model)) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 429, message: 'You have exhausted your capacity on this model.', status: 'RESOURCE_EXHAUSTED', details: [
        { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'QUOTA_EXHAUSTED', domain: 'cloudcode-pa.googleapis.com', metadata: { model } },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7200s' },
      ] } }));
      return;
    }
    if (/:streamGenerateContent/.test(url)) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (text: string, usage: object, finish?: string) => `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, ...(finish ? { finishReason: finish } : {}) }], usageMetadata: usage, modelVersion: model })}\n\n`;
      res.end(chunk('Hello from ', { promptTokenCount: 4100, candidatesTokenCount: 2, totalTokenCount: 4102 })
        + chunk('Acme.', { promptTokenCount: 4100, candidatesTokenCount: 6, cachedContentTokenCount: 4000, thoughtsTokenCount: 20, totalTokenCount: 4126 }, 'STOP'));
      return;
    }
    if (/:generateContent/.test(url)) {
      // Gemini's own side calls (routing, checks) on a small model: a short answer.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '{}' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1, totalTokenCount: 11 } }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 404, message: 'Not here.', status: 'NOT_FOUND' } }));
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.GOOGLE_GEMINI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.GEMINI_API_KEY = 'acme-not-a-key';
// Trusted for these sessions only, so no folder question stands between Gemini and its hooks.
process.env.GEMINI_CLI_TRUST_WORKSPACE = 'true';

const results: string[] = [];
const owner = { role: 'owner' as const };
const core = new Core({
  dataDir: join(base, 'data'),
  accounts: { home, prober: async () => ({ signedIn: 'unknown', identity: null, plan: null }) },
  launcher: (provider) => (provider === 'gemini' ? { file: '/usr/bin/sandbox-exec', args: ['-f', profile, 'gemini'] } : null),
  codexHookProbe: null,
  jev: { envKey: null },
  local: { lmsBin: null, ollamaUrl: 'http://127.0.0.1:9' },
});
const call = <T>(method: string, params: unknown): Promise<T> => dispatch(core.handlers, method, params, owner) as Promise<T>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Got = { session: { state: string; activity: string | null; limit: { resetsAt: number | null } | null; transcriptPath: string | null }; events: { event: string }[] };
const until = async (what: (g: Got) => boolean, id: string, seconds: number): Promise<Got> => {
  let got = await call<Got>('sessions.get', { id });
  for (let i = 0; i < seconds * 4 && !what(got); i++) { await sleep(250); got = await call<Got>('sessions.get', { id }); }
  return got;
};
try {
  await core.start();
  const version = execFileSync('/bin/zsh', ['-lc', 'GEMINI_CLI_HOME=$(mktemp -d)/none gemini --version'], { encoding: 'utf8' }).trim();
  results.push(`Gemini CLI ${version}, against a fake Gemini API on 127.0.0.1`);
  const project = await call<{ id: string }>('projects.add', { path: site });

  // A Pro model: the API answers 429 and Gemini draws its usage-limit dialog.
  const pro = await call<{ id: string }>('sessions.start', { projectId: project.id, provider: 'gemini', model: 'gemini-2.5-pro', cols: 120, rows: 36 });
  let got = await until((g) => g.events.some((e) => e.event === 'SessionStart'), pro.id, 40);
  if (!got.events.some((e) => e.event === 'SessionStart')) throw new Error('Gemini’s SessionStart never arrived');
  await sleep(1500);
  await call('sessions.input', { id: pro.id, data: 'hello' });
  await sleep(400);
  await call('sessions.input', { id: pro.id, data: '\r' });
  got = await until((g) => g.session.state === 'limited', pro.id, 45);
  const expected = Date.now() + 7200_000;
  const resetsAt = got.session.limit?.resetsAt ?? null;
  results.push(got.session.state === 'limited'
    ? `the dialog Gemini drew made the session limited: “${got.session.activity}”`
    : `FAIL: the session is ${got.session.state}, not limited (${got.session.activity})`);
  results.push(resetsAt !== null && Math.abs(resetsAt - expected) < 3 * 60_000
    ? `its reset is read as ${new Date(resetsAt).toLocaleTimeString()}, two hours from now as the API said`
    : `FAIL: its reset is ${resetsAt === null ? 'not known' : new Date(resetsAt).toLocaleTimeString()}`);
  const need = (await call<{ sessionId: string; kind: string; detail: string | null }[]>('needs.list', {})).find((n) => n.sessionId === pro.id);
  results.push(need?.kind === 'limit' ? `Needs you: “${need.detail}”` : `FAIL: Needs you shows ${need?.kind ?? 'nothing'}`);
  // The owner picks Stop (the dialog's last choice).
  await call('sessions.input', { id: pro.id, data: '2' });
  await sleep(300);
  await call('sessions.input', { id: pro.id, data: '\r' });
  got = await until((g) => g.events.some((e) => e.event === 'Stop'), pro.id, 20);
  await sleep(1000);
  got = await call<Got>('sessions.get', { id: pro.id });
  results.push(got.events.some((e) => e.event === 'Stop') && got.session.state === 'limited'
    ? 'Stop ended the turn (AfterAgent arrived) and the session is still limited'
    : `FAIL: after Stop the session is ${got.session.state} (AfterAgent ${got.events.some((e) => e.event === 'Stop') ? 'arrived' : 'never came'})`);
  await call('sessions.stop', { id: pro.id });

  // A Flash model: the API answers, and the tokens come from Gemini's own chat file.
  const flash = await call<{ id: string }>('sessions.start', { projectId: project.id, provider: 'gemini', model: 'gemini-2.5-flash', cols: 120, rows: 36 });
  got = await until((g) => g.events.some((e) => e.event === 'SessionStart'), flash.id, 40);
  await sleep(1500);
  await call('sessions.input', { id: flash.id, data: 'hello' });
  await sleep(400);
  await call('sessions.input', { id: flash.id, data: '\r' });
  got = await until((g) => g.events.some((e) => e.event === 'Stop'), flash.id, 45);
  const tokens = await call<{ usage: { requests: number; input: number; output: number; cacheRead: number; context: number | null } | null; note: string | null }>('sessions.tokens', { id: flash.id });
  const u = tokens.usage;
  results.push(u && u.requests === 1 && u.input === 100 && u.output === 26 && u.cacheRead === 4000 && u.context === 4100
    ? `tokens from Gemini’s own chat file (${got.session.transcriptPath?.replace(base, '…')}): 100 input, 4,000 cached, 26 output, 4,100 in context`
    : `FAIL: tokens ${JSON.stringify(tokens)}`);
  await call('sessions.stop', { id: flash.id });
  results.push(`the fake API was asked: ${[...new Set(requests)].join(', ')}`);
} catch (error) {
  results.push(`FAIL: ${(error as Error).message}`);
} finally {
  await core.stop();
  server.close();
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
for (const r of results) console.log(`  ${r}`);
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
