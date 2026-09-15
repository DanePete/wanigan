import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app } from 'electron';
import type { CodexHookDelivery, ObserveOnlyHooks, ObserveOnlyHooksReason, SessionEvent } from '../shared/types';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

const appSource = (rel: string) => fs.readFileSync(path.join(app.getAppPath(), rel), 'utf8');
/** Check details are printed with String(); an object would read as [object Object]. */
const show = (value: unknown) => (JSON.stringify(value) ?? String(value)).slice(0, 800);

/**
 * What Codex 0.154.0's app-server answered the trust probe on 15 Sep 2026
 * (scripts/probe-codex-hook-trust.mjs, the one run against the real CLI): the
 * hash it reported for each of Wanigan's six hooks, and the order it listed
 * them in. The stub below answers with these, in that entry shape, so every
 * check here is against the answer the real binary gave rather than a guess.
 */
const CODEX_0_154_HASHES = {
  SessionStart: 'sha256:f445beea95977dfcb6a704e202bf969ae6bac2f3054d735aeeba327ae4eb0d75',
  UserPromptSubmit: 'sha256:f882487e7167b483a837f80b2e8a3e22431cbadbff031cf0cae865555338d3a5',
  PreToolUse: 'sha256:a0dc7fe23a0de4b9a6e80e6e82dc95e4c87fedf4b804df82ba74e11c52010a0d',
  PostToolUse: 'sha256:78b17fc577dfba3621be968a08780331504af7fee32255ee94d910b9a35fcb31',
  PermissionRequest: 'sha256:f9bea5ad9fc0cde871e1c3fb288050e8aceb40d5259fccb110477e4f909cdd4f',
  Stop: 'sha256:c4bae6e5e81bca414e4026bca0ac74cfc4aeca6c28692b0cc0fdd775e5d8446f',
};
const CODEX_0_154_ORDER = ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'SessionStart', 'UserPromptSubmit', 'Stop'];
const VERSION = 'codex-cli 0.154.0';

/**
 * A stand-in for `codex app-server --listen stdio://`, speaking the subset the
 * probe uses. It logs every run's argv, environment names and CODEX_HOME, and
 * every method it is sent. Modes, set by the wrapper that starts it:
 *  - real: Codex 0.154.0's answers — untrusted without a trust entry, trusted
 *    with one that matches, modified with one that does not;
 *  - refuse: untrusted whatever it is given;
 *  - modified: a hash that changes between runs, so a trust entry never matches;
 *  - hang: answers initialize and never hooks/list.
 * Every listing also carries the operator's own trusted Stop hook, running the
 * same command, which must never be taken for Wanigan's.
 */
function stubSource(command: string): string {
  return `
const fs = require('node:fs');
const crypto = require('node:crypto');
const MODE = process.env.STUB_MODE;
const LOG = process.env.STUB_LOG;
const COMMAND = ${JSON.stringify(command)};
const REAL = ${JSON.stringify(CODEX_0_154_HASHES)};
const ORDER = ${JSON.stringify(CODEX_0_154_ORDER)};
const log = (entry) => fs.appendFileSync(LOG, JSON.stringify({ pid: process.pid, ...entry }) + '\\n');
const argv = process.argv.slice(2);
const priorRuns = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\\n').filter((line) => line.includes('"argv"')).length : 0;
log({ argv, env: Object.keys(process.env).sort(), home: process.env.CODEX_HOME, cwd: process.cwd() });
const defined = new Map();
const state = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== '--config') continue;
  const value = argv[++i] || '';
  const def = /^hooks\\.([A-Za-z]+)=\\[\\{hooks=\\[\\{type="command",command=(".*")\\}\\]\\}\\]$/.exec(value);
  if (def) defined.set(def[1], JSON.parse(def[2]));
  if (value.startsWith('hooks.state={')) for (const m of value.matchAll(/"([^"]+)"=\\{trusted_hash="([^"]+)"\\}/g)) state[m[1]] = m[2];
}
const snake = (event) => event.replace(/[A-Z]/g, (c, i) => (i ? '_' : '') + c.toLowerCase());
const entry = (event, command, source, key, hash, trust, order) => ({
  key, eventName: event[0].toLowerCase() + event.slice(1), handlerType: 'command', command, async: false, matcher: null,
  timeoutSec: 600, statusMessage: null, additionalContextLimit: null,
  sourcePath: source === 'sessionFlags' ? '/<session-flags>/config.toml' : process.env.CODEX_HOME + '/config.toml',
  source, pluginId: null, displayOrder: order, enabled: true, isManaged: false, currentHash: hash, trustStatus: trust,
});
const digest = (text) => 'sha256:' + crypto.createHash('sha256').update(text).digest('hex');
const scope = (cwd) => {
  const hooks = [];
  for (const event of ORDER) {
    if (!defined.has(event)) continue;
    const command = defined.get(event);
    const key = '/<session-flags>/config.toml:' + snake(event) + ':0:0';
    let hash = command === COMMAND ? REAL[event] : digest(event + command);
    if (MODE === 'modified') hash = digest(event + command + priorRuns);
    let trust = state[key] ? (state[key] === hash ? 'trusted' : 'modified') : 'untrusted';
    if (MODE === 'refuse') trust = 'untrusted';
    hooks.push(entry(event, command, 'sessionFlags', key, hash, trust, hooks.length));
  }
  hooks.push(entry('Stop', COMMAND, 'user', process.env.CODEX_HOME + '/config.toml:stop:0:0', 'sha256:' + '1'.repeat(64), 'trusted', hooks.length));
  return { cwd, hooks, warnings: [], errors: [] };
};
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf('\\n'); at >= 0; at = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    log({ method: message.method === undefined ? null : message.method });
    if (message.method === 'initialize') {
      process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: 'wanigan/0.154.0 (stub)', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'macos' } }) + '\\n');
    }
    if (message.method === 'hooks/list' && MODE !== 'hang') {
      process.stdout.write(JSON.stringify({ id: message.id, result: { data: message.params.cwds.map(scope) } }) + '\\n');
    }
  }
});
`;
}

type StubRun = { pid: number; argv: string[]; env: string[]; home: string; cwd: string; methods: string[] };

function stubRuns(logFile: string): StubRun[] {
  if (!fs.existsSync(logFile)) return [];
  const runs = new Map<number, StubRun>();
  for (const line of fs.readFileSync(logFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as { pid: number; argv?: string[]; env?: string[]; home?: string; cwd?: string; method?: string | null };
    if (entry.argv) runs.set(entry.pid, { pid: entry.pid, argv: entry.argv, env: entry.env ?? [], home: entry.home ?? '', cwd: entry.cwd ?? '', methods: [] });
    else runs.get(entry.pid)?.methods.push(String(entry.method));
  }
  return [...runs.values()];
}

function post(url: string, bearer: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const request = http.request(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }));
    });
    request.on('error', reject);
    request.end(data);
  });
}

/** Runs a program to its exit without blocking this process, whose hook listener has to answer it. */
function run(bin: string, args: string[], env: NodeJS.ProcessEnv, stdin: string): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: String(error), ms: Date.now() - started }));
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(stdin);
  });
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * Codex hook events, observed only: the trust probe against a stub app-server
 * answering as Codex 0.154.0 did, the cache, the launch's arguments and headers
 * file, the real forwarding command through the real listener, observe-only
 * requests that never reach the policy, the hand-over from OSC 9, and the
 * capability line's states. No real Codex runs: the stub stands in for it.
 */
export async function runCodexHookSmoke(check: Check, say: Say): Promise<void> {
  say('── codex · hook events, observed only: trust by hash, the launch, and the hand-over from OSC 9');
  const hooks = await import('./hooks');
  const codexHooks = await import('./codex-hooks');
  const shared = await import('../shared/codex-hooks');
  const policy = await import('./policy');
  const { db } = await import('./db');
  const { setSetting, getSetting } = await import('./settings');
  const { providerProbeEnvironment } = await import('./providers');
  const { recordCodexNotification } = await import('./sessions');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-codex-hook-smoke-'));
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, 'OPENAI_API_KEY');
  const previousKey = process.env.OPENAI_API_KEY;
  const previousHooks = getSetting('hooks', '__wanigan_smoke_missing__');
  const sessionIds: string[] = [];
  const policyIds: string[] = [];
  try {
    const stub = path.join(work, 'app-server-stub.cjs');
    fs.writeFileSync(stub, stubSource(shared.CODEX_HOOK_COMMAND));
    const binFor = (mode: string) => {
      const bin = path.join(work, `codex-${mode}`);
      fs.writeFileSync(bin, `#!/bin/sh\nSTUB_MODE=${mode} STUB_LOG='${path.join(work, `${mode}.log`)}' ELECTRON_RUN_AS_NODE=1 exec '${process.execPath}' '${stub}' "$@"\n`);
      fs.chmodSync(bin, 0o755);
      return { bin, log: path.join(work, `${mode}.log`) };
    };
    const real = binFor('real');
    const refuse = binFor('refuse');
    const modified = binFor('modified');
    const hang = binFor('hang');
    // A credential in Wanigan's own environment, which the probe must not pass on.
    process.env.OPENAI_API_KEY = 'sk-smoke-sentinel-never-a-real-key';
    const probeEnv = providerProbeEnvironment(process.env.PATH ?? '');
    setSetting('hooks', '1');
    const { port } = await hooks.startHookServer();
    const target = (bin: string, version: string | null = VERSION, proven = true) => ({ bin, version, proven });

    /* ── detection never starts Codex ─────────────────────────────────── */
    check(codexHooks.observeOnlyHooksStatus(target(real.bin)) === null && stubRuns(real.log).length === 0,
      'a Codex version that has not been asked reads as not yet known, and reading it starts nothing');

    /* ── the probe ─────────────────────────────────────────────────────── */
    const answer = await codexHooks.codexHookTrust(real.bin, VERSION, probeEnv);
    check(answer.trust.state === 'trusted' && show(answer.trust.state === 'trusted' ? answer.trust.hashes : null) === show(Object.fromEntries(shared.CODEX_HOOK_EVENTS.map((event) => [event, CODEX_0_154_HASHES[event]]))),
      'a probe against a stub answering as Codex 0.154.0 did comes back trusted, with exactly the six hashes it reported', show(answer));
    const realRuns = stubRuns(real.log);
    check(realRuns.length === 2 && realRuns.every((entry) => show(entry.methods) === show(['initialize', 'initialized', 'hooks/list'])),
      'each of its two app-server runs was sent initialize, initialized and hooks/list, in that order, and nothing else', show(realRuns.map((entry) => entry.methods)));
    const tail = ['app-server', '--listen', 'stdio://'];
    check(realRuns.length === 2
      && show(realRuns[0].argv) === show([...shared.codexHookConfigArgs(), ...tail])
      && show(realRuns[1].argv) === show([...shared.codexHookConfigArgs(CODEX_0_154_HASHES), ...tail]),
    'the first run defines the hooks with no trust, and the second trusts exactly the hashes the first reported', show(realRuns.map((entry) => entry.argv.length)));
    const allowed = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'CODEX_HOME',
      // Added by the stub's own /bin/sh wrapper and by macOS, not by the probe.
      'STUB_MODE', 'STUB_LOG', 'ELECTRON_RUN_AS_NODE', 'PWD', 'OLDPWD', 'SHLVL', '_', '__CF_USER_TEXT_ENCODING']);
    const extra = realRuns.flatMap((entry) => entry.env.filter((name) => !allowed.has(name)));
    check(realRuns.length === 2 && extra.length === 0 && realRuns.every((entry) => !entry.env.includes('OPENAI_API_KEY')),
      'app-server runs with the credential-free probe environment: an API key in Wanigan\'s own environment does not reach it', show(extra));
    check(realRuns.length === 2 && realRuns[0].home !== realRuns[1].home
      && realRuns.every((entry) => entry.home.startsWith(fs.realpathSync(os.tmpdir())) || entry.home.startsWith(os.tmpdir()))
      && realRuns.every((entry) => !fs.existsSync(entry.home) && !fs.existsSync(path.dirname(entry.home))),
    'each run gets its own fresh CODEX_HOME in the temp directory, and both are gone once the probe returns', show(realRuns.map((entry) => entry.home)));
    check(answer.trust.state === 'trusted' && answer.trust.hashes.Stop === CODEX_0_154_HASHES.Stop,
      'the operator\'s own trusted Stop hook, running the same command beside Wanigan\'s, is not taken for Wanigan\'s');

    /* ── cache and persistence ─────────────────────────────────────────── */
    await codexHooks.codexHookTrust(real.bin, VERSION, probeEnv);
    check(stubRuns(real.log).length === 2, 'asking again for the same binary and version starts nothing');
    const row = db().prepare('SELECT state, hashes_json, definition_sha256, first_event_at FROM codex_hook_trust WHERE bin = ? AND version = ?')
      .get(real.bin, VERSION) as { state: string; hashes_json: string; definition_sha256: string; first_event_at: number | null } | undefined;
    check(row?.state === 'trusted' && row.definition_sha256 === codexHooks.CODEX_HOOK_DEFINITION_SHA256
      && show(JSON.parse(row.hashes_json)) === show(CODEX_0_154_HASHES) && row.first_event_at === null,
    'the answer is recorded in SQLite against the binary, the version and the digest of the hook definition', show(row));
    codexHooks.dropCodexHookTrustMemory();
    const reread = await codexHooks.codexHookTrust(real.bin, VERSION, probeEnv);
    check(reread.trust.state === 'trusted' && stubRuns(real.log).length === 2,
      'with the in-memory answers dropped, as a restart drops them, the answer is read back from SQLite without starting Codex');
    const [one, two] = await Promise.all([
      codexHooks.codexHookTrust(real.bin, 'codex-cli 0.155.0', probeEnv),
      codexHooks.codexHookTrust(real.bin, 'codex-cli 0.155.0', probeEnv),
    ]);
    check(one.trust.state === 'trusted' && two === one && stubRuns(real.log).length === 4,
      'a new version of the same binary is asked again, and two launches asking at once share that one probe', stubRuns(real.log).length);

    /* ── untrusted, modified and timeout answers ───────────────────────── */
    const refused = await codexHooks.codexHookTrust(refuse.bin, VERSION, probeEnv);
    check(refused.trust.state === 'unavailable' && refused.trust.reason === 'trust-not-granted' && /Stop untrusted/.test(refused.trust.detail),
      'a Codex that still reads the hooks as untrusted after being given their hashes is not trusted, and says which', show(refused.trust));
    const rehashed = await codexHooks.codexHookTrust(modified.bin, VERSION, probeEnv);
    check(rehashed.trust.state === 'unavailable' && rehashed.trust.reason === 'trust-not-granted' && /rehashed/.test(rehashed.trust.detail),
      'a Codex whose hash for the same hook changed between runs reads the trust entry as modified, and nothing is trusted', show(rehashed.trust));
    const refusedRow = db().prepare('SELECT state, reason FROM codex_hook_trust WHERE bin = ?').get(refuse.bin) as { state: string; reason: string } | undefined;
    check(refusedRow?.state === 'unavailable' && refusedRow.reason === 'trust-not-granted',
      'trust not granted is a definite answer about that version, so it is recorded too', show(refusedRow));
    const started = Date.now();
    const timedOut = await codexHooks.codexHookTrust(hang.bin, VERSION, probeEnv, 1500);
    const elapsed = Date.now() - started;
    const hangRuns = stubRuns(hang.log);
    check(timedOut.trust.state === 'unavailable' && timedOut.trust.reason === 'timeout' && elapsed < 5000
      && hangRuns.length === 1 && !alive(hangRuns[0].pid) && !fs.existsSync(hangRuns[0].home),
    'a Codex that never answers hooks/list is killed at the deadline, its home is deleted, and the answer is a timeout', show({ answer: timedOut.trust, elapsed }));
    await codexHooks.codexHookTrust(hang.bin, VERSION, probeEnv, 1500);
    const hangRow = db().prepare('SELECT COUNT(*) AS n FROM codex_hook_trust WHERE bin = ?').get(hang.bin) as { n: number };
    check(stubRuns(hang.log).length === 1 && hangRow.n === 0,
      'a timeout is reused for a minute instead of stalling every launch, and never written to SQLite, so a restart asks again');

    /* ── the capability line before any event ──────────────────────────── */
    const trustedLine = codexHooks.observeOnlyHooksStatus(target(real.bin));
    check(show(trustedLine) === show({ state: 'trusted', version: '0.154.0' }),
      'with trust confirmed and no event yet, the line is "trusted" on 0.154.0, not "observed"', show(trustedLine));
    const refusedLine = codexHooks.observeOnlyHooksStatus(target(refuse.bin));
    check(refusedLine?.state === 'unavailable' && refusedLine.reason === 'trust-not-granted',
      'a binary Codex did not trust reads as not available, with that reason', show(refusedLine));
    const when = (at: number) => `@${at}`;
    const sentences = ([trustedLine, refusedLine].filter(Boolean) as ObserveOnlyHooks[]).map((status) => shared.observeOnlyHooksSentence(status, when));
    check(sentences[0] === 'injected and trusted on 0.154.0; no event has arrived yet from a real session'
      && sentences[1] === 'not available: Codex did not trust Wanigan\'s hooks by the hashes it reported',
    'Settings words those two states exactly as the capability defines them', show(sentences));

    /* ── the launch ────────────────────────────────────────────────────── */
    let switchedAt: number | null = null;
    const sidA = `s_codexhooks_a_${Date.now().toString(36)}`;
    sessionIds.push(sidA);
    const launch = await codexHooks.prepareCodexHookLaunch({
      sessionId: sidA, projectPath: work, target: target(real.bin), probeEnv, extraArgs: [],
      onSwitch: (at) => { switchedAt = at; },
    });
    check(show(launch.delivery) === show({ state: 'injected', version: '0.154.0', switchedAt: null })
      && show(launch.args) === show(shared.codexHookConfigArgs(CODEX_0_154_HASHES)),
    'an attended Codex launch with confirmed trust adds the six hook definitions and one hooks.state entry trusting Codex\'s own hashes', show(launch.delivery));
    const [hooksDir] = policy.waniganCredentialDirs();
    const headersFile = launch.env[shared.CODEX_HOOK_HEADERS_ENV] ?? '';
    check(show(Object.keys(launch.env).sort()) === show([shared.CODEX_HOOK_HEADERS_ENV, shared.CODEX_HOOK_URL_ENV])
      && launch.env[shared.CODEX_HOOK_URL_ENV] === `http://127.0.0.1:${port}/hook`
      && path.dirname(headersFile) === hooksDir,
    'the PTY gets two variables: the loopback hook URL, and the path of a headers file in the hooks credential folder, beside the Claude settings files', show(launch.env));
    const headers = fs.existsSync(headersFile) ? fs.readFileSync(headersFile, 'utf8') : '';
    const bearer = /^Authorization: Bearer ([A-Za-z0-9_-]{43})\nContent-Type: application\/json\n$/.exec(headers)?.[1] ?? '';
    check(!!bearer && (fs.statSync(headersFile).mode & 0o777) === 0o600,
      'the headers file is owner-only and holds exactly an Authorization bearer and a JSON content type', headers.replace(/Bearer \S+/, 'Bearer <redacted>'));
    check(!!bearer && launch.args.every((value) => !value.includes(bearer)) && Object.values(launch.env).every((value) => !value.includes(bearer))
      && !shared.CODEX_HOOK_COMMAND.includes(bearer),
    'the bearer appears in no argument, no environment value and not in the command: only in that file');
    check(launch.args.every((value) => !/bypass|dangerous/i.test(value)),
      'nothing in the launch arguments skips hook trust');

    const none = async (label: string, over: Partial<Parameters<typeof codexHooks.prepareCodexHookLaunch>[0]>, reason: ObserveOnlyHooksReason) => {
      const sid = `s_codexhooks_none_${reason}_${Date.now().toString(36)}`;
      sessionIds.push(sid);
      const result = await codexHooks.prepareCodexHookLaunch({ sessionId: sid, projectPath: work, target: target(real.bin), probeEnv, extraArgs: [], ...over });
      const leftover = fs.existsSync(path.join(hooksDir, `${sid}.headers`));
      check(result.delivery.state === 'not-injected' && result.delivery.reason === reason && result.args.length === 0
        && Object.keys(result.env).length === 0 && !leftover, label, show({ delivery: result.delivery, leftover }));
    };
    await none('a profile whose Codex claim is unproven launches exactly as before, and the reason is recorded', { target: target(real.bin, VERSION, false) }, 'harness-unproven');
    await none('extra arguments that configure hooks themselves turn injection off, with that reason', { extraArgs: ['-c', 'hooks.Stop=[{hooks=[{type="command",command="/usr/bin/true"}]}]'] }, 'extra-args');
    await none('without trust confirmed for the binary, nothing is injected and no headers file is written', { target: target(refuse.bin) }, 'trust-not-granted');
    await none('a binary whose version could not be read gets no hooks, because trust cannot be tied to it', { target: target(real.bin, null) }, 'no-version');
    setSetting('hooks', '0');
    await none('with the hook bus off, a Codex launch injects nothing and says the hook bus is off', {}, 'hook-bus-off');
    setSetting('hooks', '1');

    /* ── the forwarding command, for real ──────────────────────────────── */
    const inner = shared.CODEX_HOOK_COMMAND.slice('/bin/sh -c \''.length, -1);
    const hookEnv = { PATH: '/usr/bin:/bin', ...launch.env, http_proxy: 'http://192.0.2.1:3128', HTTP_PROXY: 'http://192.0.2.1:3128' };
    const viaShell = await run('/bin/sh', ['-c', shared.CODEX_HOOK_COMMAND], hookEnv, JSON.stringify({
      hook_event_name: 'PreToolUse', session_id: 'codex-thread', tool_name: 'shell', call_id: 'call_1',
      tool_input: { command: ['bash', '-lc', 'npm test'] }, model: 'gpt-5.5', turn_id: 'turn-1',
    }));
    check(viaShell.code === 0 && viaShell.stdout === '' && viaShell.stderr === '',
      'the forwarding command, run through a shell with a proxy in its environment, exits 0 and prints nothing', show(viaShell));
    const afterShell = hooks.sessionEvents(sidA);
    check(afterShell.length === 1 && afterShell[0].event === 'PreToolUse' && afterShell[0].toolName === 'shell' && afterShell[0].summary === 'bash -lc npm test',
      'its PreToolUse reached the session\'s event store directly, not through the proxy, read through the Codex mapping', show(afterShell));
    const secret = 'please deploy with sk-live-smoke-prompt';
    const viaArgv = await run('/bin/sh', ['-c', inner], hookEnv, JSON.stringify({ hook_event_name: 'user_prompt_submit', prompt: secret, message: secret }));
    const prompts = hooks.sessionEvents(sidA).filter((event) => event.event === 'UserPromptSubmit');
    const stored = db().prepare('SELECT COUNT(*) AS n FROM session_events WHERE session_id = ? AND (summary LIKE ? OR paths_json LIKE ?)').get(sidA, '%sk-live%', '%sk-live%') as { n: number };
    check(viaArgv.code === 0 && viaArgv.stdout === '' && prompts.length === 1 && prompts[0].summary === null && stored.n === 0,
      'split into argv, as a runner without a shell would split it, the command still delivers, and UserPromptSubmit is stored without its prompt', show({ viaArgv, prompts }));
    const closed = await run('/bin/sh', ['-c', shared.CODEX_HOOK_COMMAND], { ...hookEnv, [shared.CODEX_HOOK_URL_ENV]: 'http://127.0.0.1:1/hook' }, '{"hook_event_name":"Stop"}');
    check(closed.code === 0 && closed.stdout === '' && closed.stderr === '' && closed.ms < 5500,
      'with nothing listening, the command still exits 0 and prints nothing, so a closed Wanigan cannot fail a Codex hook', show(closed));
    const unset = await run('/bin/sh', ['-c', shared.CODEX_HOOK_COMMAND], { PATH: '/usr/bin:/bin' }, '{}');
    check(unset.code === 0 && unset.stdout === '' && unset.stderr === '',
      'and in an environment that never received the two variables, it exits 0 and prints nothing', show(unset));

    /* ── the first event: observed, and the switch ─────────────────────── */
    const firstAt = afterShell[0]?.at ?? -1;
    const observedLine = codexHooks.observeOnlyHooksStatus(target(real.bin));
    check(show(observedLine) === show({ state: 'observed', version: '0.154.0', firstEventAt: firstAt }) && switchedAt === firstAt
      && codexHooks.codexHooksAreSource(sidA),
    'the first event from a real session turns the line to observed at that event\'s time, and makes that session\'s hooks its source', show({ observedLine, switchedAt }));
    codexHooks.dropCodexHookTrustMemory();
    const observedRow = db().prepare('SELECT first_event_at, first_event_session FROM codex_hook_trust WHERE bin = ? AND version = ?').get(real.bin, VERSION) as { first_event_at: number; first_event_session: string } | undefined;
    check(codexHooks.observeOnlyHooksStatus(target(real.bin))?.state === 'observed' && observedRow?.first_event_at === firstAt && observedRow.first_event_session === sidA,
      'the first event is recorded durably: after a restart the line still says observed, and names the session it came from', show(observedRow));
    check(shared.observeOnlyHooksSentence({ state: 'observed', version: '0.154.0', firstEventAt: 7 }, when) === 'observed on 0.154.0 — first event @7',
      'and Settings words it as observed on the version, with the first event\'s time');

    /* ── observe only: never the policy ───────────────────────────────── */
    const policyCalls: unknown[] = [];
    const briefings: string[] = [];
    const switches: string[] = [];
    hooks.setPolicyHook((input) => { policyCalls.push(input); return { decision: 'deny', reason: 'smoke policy', rule: 'smoke.deny' }; });
    hooks.setLearningBriefingHook((sessionId) => { briefings.push(sessionId); return 'a briefing that must not be delivered'; });
    hooks.setModelSwitchHook((sessionId) => { switches.push(sessionId); });
    // Unattended and holding asks: the one context under which a decision
    // would be held for a person, so no row here also means no held approval.
    policy.registerPolicyContext({ sessionId: sidA, projectId: null, projectPath: work, trust: 'readonly', attended: false, holdAsks: true });
    policyIds.push(sidA);
    const url = `http://127.0.0.1:${port}/hook`;
    const ledgerRows = (sid: string) => (db().prepare('SELECT COUNT(*) AS n FROM policy_ledger WHERE session_id = ?').get(sid) as { n: number }).n;
    const writeCall = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(work, 'out.txt'), content: 'x' } };
    const observed = await post(url, bearer, writeCall);
    const writeRow = hooks.sessionEvents(sidA).find((event) => event.event === 'PreToolUse' && event.toolName === 'Write');
    check(observed.status === 200 && observed.body === '{}' && policyCalls.length === 0 && ledgerRows(sidA) === 0 && !!writeRow,
      'a Codex PreToolUse that an unattended Read only run would hold for a person is stored and answered {}, and reaches neither the policy nor the held-approval path: no ledger row', show({ observed, policyCalls: policyCalls.length, ledger: ledgerRows(sidA) }));
    const sidClaude = `s_codexhooks_claude_${Date.now().toString(36)}`;
    sessionIds.push(sidClaude);
    const settingsFile = hooks.writeHookSettings(sidClaude, work);
    const claudeBearer = settingsFile ? /Bearer ([A-Za-z0-9_-]{43})/.exec(fs.readFileSync(settingsFile, 'utf8'))?.[1] ?? '' : '';
    policy.registerPolicyContext({ sessionId: sidClaude, projectId: null, projectPath: work, trust: 'readonly', attended: true });
    policyIds.push(sidClaude);
    const decided = await post(url, claudeBearer, writeCall);
    check(decided.status === 200 && /"permissionDecision":"ask"/.test(decided.body) && ledgerRows(sidClaude) === 1,
      'the same call from a Claude session\'s registration is decided (Read only asks) and written to the ledger, so the check above can fail', show({ decided, ledger: ledgerRows(sidClaude) }));
    const start = await post(url, bearer, { hook_event_name: 'SessionStart', source: 'startup' });
    check(start.status === 200 && start.body === '{}' && briefings.length === 0,
      'a Codex SessionStart gets no briefing and no trust sentence, even with a learning source registered', show({ start, briefings }));
    const forged = await post(url, bearer, { hook_event_name: 'PostModelSwitch', from_model: 'gpt-5.5', to_model: 'gpt-4o' });
    check(forged.status === 200 && forged.body === '{}' && switches.length === 0,
      'a body naming PostModelSwitch from a Codex registration does not rewrite which model the session ran', show({ forged, switches }));
    const unknown = await post(url, bearer, { hook_event_name: 'turn_started', wanted: { nested: true }, prompt: secret });
    const unknownRow = hooks.sessionEvents(sidA).find((event) => event.event === 'TurnStarted');
    check(unknown.status === 200 && !!unknownRow && unknownRow.summary === null,
      'an event with names and fields Wanigan does not know is still stored with what can be read, and none of its text', show(unknownRow));

    /* ── the hand-over from OSC 9 ──────────────────────────────────────── */
    const sidB = `s_codexhooks_b_${Date.now().toString(36)}`;
    sessionIds.push(sidB);
    let switchedB: number | null = null;
    const launchB = await codexHooks.prepareCodexHookLaunch({
      sessionId: sidB, projectPath: work, target: target(real.bin), probeEnv, extraArgs: [], onSwitch: (at) => { switchedB = at; },
    });
    db().prepare('INSERT INTO session_log (id, provider_id, project_path, project_name, started_at, harness_id, codex_hooks_json) VALUES (?,?,?,?,?,?,?)')
      .run(sidB, 'codex', work, 'codex-hook-smoke', Date.now(), 'codex', JSON.stringify(launchB.delivery));
    const bearerB = /Bearer (\S+)/.exec(fs.readFileSync(launchB.env[shared.CODEX_HOOK_HEADERS_ENV], 'utf8'))?.[1] ?? '';
    const beforeStop = recordCodexNotification(sidB, 'finished', Date.now());
    const beforeAsk = recordCodexNotification(sidB, 'permission', Date.now());
    check(beforeStop?.event === 'Stop' && beforeAsk?.event === 'PermissionRequest' && !codexHooks.codexHooksAreSource(sidB),
      'before a Codex session\'s hooks deliver anything, OSC 9 is its source: turn-complete and approval-requested are recorded', show([beforeStop, beforeAsk]));
    const first = await post(url, bearerB, { hook_event_name: 'SessionStart' });
    const recorded = db().prepare('SELECT codex_hooks_json FROM session_log WHERE id = ?').get(sidB) as { codex_hooks_json: string };
    const delivery = JSON.parse(recorded.codex_hooks_json) as CodexHookDelivery;
    check(first.status === 200 && codexHooks.codexHooksAreSource(sidB) && switchedB !== null
      && delivery.state === 'injected' && delivery.switchedAt === switchedB,
    'its first hook event switches the source, and the moment is written onto its session row', show({ delivery, switchedB }));
    const count = (sid: string, event: string) => hooks.sessionEvents(sid).filter((row: SessionEvent) => row.event === event).length;
    const stopsBefore = count(sidB, 'Stop');
    const asksBefore = count(sidB, 'PermissionRequest');
    const afterStop = recordCodexNotification(sidB, 'finished', Date.now());
    const afterAsk = recordCodexNotification(sidB, 'permission', Date.now());
    check(afterStop === null && afterAsk === null && count(sidB, 'Stop') === stopsBefore && count(sidB, 'PermissionRequest') === asksBefore,
      'after the switch, OSC 9\'s Stop and PermissionRequest are no longer recorded for that session');
    await post(url, bearerB, { hook_event_name: 'Stop' });
    check(count(sidB, 'Stop') === stopsBefore + 1,
      'and a Stop from its hook is recorded once, as the one Stop for that turn');
    const sidC = `s_codexhooks_c_${Date.now().toString(36)}`;
    sessionIds.push(sidC);
    check(recordCodexNotification(sidC, 'finished', Date.now())?.event === 'Stop',
      'another Codex session whose hooks never delivered keeps OSC 9 as its source');
    codexHooks.forgetCodexHookSession(sidB);
    check(!codexHooks.codexHooksAreSource(sidB) && JSON.parse((db().prepare('SELECT codex_hooks_json FROM session_log WHERE id = ?').get(sidB) as { codex_hooks_json: string }).codex_hooks_json).switchedAt === switchedB,
      'forgetting a finished session frees its entry, and its row still says when its hooks took over');

    /* ── what the source says ──────────────────────────────────────────── */
    const sessionsSrc = appSource('src/main/sessions.ts');
    check(/recordCodexNotification\(id, signal, now\)/.test(sessionsSrc)
      && /if \(!codexHooksAreSource\(sessionId\)\) recordProviderEvent\(sessionId, 'UserPromptSubmit'\)/.test(sessionsSrc)
      && /\.\.\.lifecycleArgs, \.\.\.\(codexHooks\?\.args \?\? \[\]\)/.test(sessionsSrc)
      && /\.\.\.\(codexHooks\?\.env \?\? \{\}\)/.test(sessionsSrc),
    'the launch spreads the hook arguments beside the OSC 9 arguments and the two variables into that PTY, and the terminal reader and the Enter handler both consult the switch');
    const providersSrc = appSource('src/main/providers.ts');
    check(providersSrc.includes("hooks: declared('hooks', isClaude)") && !/hooks:\s*[^,\n]*observeOnlyHooks/.test(providersSrc),
      'Codex\'s capability record keeps hooks false: the observe-only field sits beside it and nothing derives hooks from it');
    const needles = [['--dangerously-', 'bypass-hook-trust'], ['thread', '/start'], ['turn', '/start']].map((parts) => parts.join(''));
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8');
          for (const needle of needles) if (text.includes(needle)) found.push(`${path.relative(app.getAppPath(), full)}: ${needle}`);
        }
      }
    };
    walk(path.join(app.getAppPath(), 'src', 'main'));
    check(found.length === 0,
      'nothing in src/main names the flag that skips hook trust, or the app-server methods that start a thread or a turn', show(found));
  } catch (error) {
    check(false, 'the Codex hook checks ran without throwing', error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error));
  } finally {
    try {
      hooks.setPolicyHook(null);
      hooks.setLearningBriefingHook(null);
      hooks.setModelSwitchHook(null);
      for (const id of policyIds) policy.releasePolicyContext(id);
      for (const id of sessionIds) { hooks.cleanupHookSettings(id); codexHooks.forgetCodexHookSession(id); }
      if (previousHooks === '__wanigan_smoke_missing__') db().prepare("DELETE FROM settings WHERE k = 'hooks'").run();
      else setSetting('hooks', previousHooks);
    } catch { /* the smoke database is thrown away */ }
    if (hadKey) process.env.OPENAI_API_KEY = previousKey;
    else delete process.env.OPENAI_API_KEY;
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temp */ }
  }
}
