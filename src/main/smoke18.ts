import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import * as hooks from './hooks';
import * as otel from './otel';
import * as statusline from './statusline';
import { db } from './db';
import { getSetting, setSetting } from './settings';
import { shellQuote, statusLineCommand } from '../shared/status-line';
import { SPEND_DIMENSIONS } from '../shared/spend-sources';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/**
 * Observed over estimated: the status line relay, beta trace spans, and spend
 * by source, each against the real listener, the real collector and a real
 * /bin/sh.
 *
 * The relay is run exactly as Claude Code runs a status line command — the
 * injected command string handed to `/bin/sh -c` with the payload on stdin —
 * with one substitution: curl is a wrapper that records its own argument
 * vector and then execs the real curl, which is how "the token is in no argv"
 * is checked rather than asserted. No agent CLI is started and nothing calls a
 * model. The operator's own settings are never read: CLAUDE_CONFIG_DIR points
 * at a scratch directory for the length of this phase, so a real status line
 * on this machine is neither run nor mistaken for the fixture's.
 */

const MIN = 60_000;

type Run = { stdout: Buffer; stderr: string; code: number | null; ms: number };

/** The CLI's own invocation shape: sh -c COMMAND, payload on stdin. Hard-killed at 15s so a relay bug cannot hang the suite. */
function runRelay(command: string, cwd: string, payload: string): Promise<Run> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('/bin/sh', ['-c', command], {
      cwd, env: { PATH: '/usr/bin:/bin', HOME: os.homedir(), TMPDIR: os.tmpdir() }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let err = '';
    const killer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ stdout: Buffer.concat(out), stderr: err, code, ms: Date.now() - started });
    });
    child.stdin.end(payload);
  });
}

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

/** The four quoted paths and the bound out of an injected command. */
function wordsOf(command: string): { relay: string; curl: string; config: string; chain: string; bound: number } | null {
  const words = [...command.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  const bound = /\s(\d+)$/.exec(command);
  if (words.length !== 4 || !bound) return null;
  return { relay: words[0], curl: words[1], config: words[2], chain: words[3], bound: Number(bound[1]) };
}

type Injected = { file: string; command: string; capability: string; keys: string[] };

function inject(sessionId: string, project: string): Injected | null {
  const file = hooks.writeHookSettings(sessionId, project, undefined, { cliVersion: '2.1.270 (Claude Code)' });
  if (!file) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    hooks: { PreToolUse?: { hooks?: { headers?: { Authorization?: string } }[] }[] };
    statusLine?: Record<string, unknown>;
  };
  const auth = parsed.hooks.PreToolUse?.[0]?.hooks?.[0]?.headers?.Authorization ?? '';
  return {
    file,
    command: typeof parsed.statusLine?.command === 'string' ? parsed.statusLine.command : '',
    capability: auth.replace(/^Bearer\s+/, ''),
    keys: Object.keys(parsed.statusLine ?? {}),
  };
}

function project(root: string, name: string, statusLine: Record<string, unknown> | null): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  if (statusLine) fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ statusLine }));
  return dir;
}

export async function runObservedTelemetrySmoke(check: Check, say: Say): Promise<void> {
  say('── observed telemetry · the status line relay');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-observed-'));
  const restore = {
    hooks: getSetting('hooks', '1'), statusLine: getSetting('status_line', '1'),
    traces: getSetting('traces_beta', '0'), telemetry: getSetting('telemetry', '1'),
    configDir: process.env.CLAUDE_CONFIG_DIR,
  };
  const claudeHome = path.join(tmp, 'claude-home');
  fs.mkdirSync(claudeHome, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  setSetting('hooks', '1');
  setSetting('status_line', '1');

  try {
    const hs = await hooks.startHookServer();
    const collectorPort = await otel.startCollector();
    const now = Date.now();

    if (statusline.relayUnsupported()) {
      check(false, 'this machine can run the status line relay', statusline.relayUnsupported());
      return;
    }

    // The end-to-end relay exercise below is built from POSIX fixtures — a
    // `#!/bin/sh` status line of the operator's own, and one that hangs. On
    // Windows the relay is a .ps1 and those fixtures are not runnable, so this
    // asserts the thing that machine can uniquely answer instead: whether the
    // script Wanigan emits actually parses. That question has no answer on a
    // Mac, which has no PowerShell, and it is the one this port could not check
    // when the script was written.
    if (process.platform === 'win32') {
      const relay = path.join(tmp, 'relay.ps1');
      fs.writeFileSync(relay, statusline.RELAY_SCRIPT_PS1);
      const checker = path.join(tmp, 'parse-check.ps1');
      fs.writeFileSync(checker, [
        'param([string]$Target)',
        '$errors = $null',
        '[void][System.Management.Automation.Language.Parser]::ParseFile($Target, [ref]$null, [ref]$errors)',
        'if ($errors -and $errors.Count -gt 0) { $errors | ForEach-Object { $_.Message }; exit 1 }',
        'exit 0',
      ].join('\n'));
      const parsed = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', checker, relay,
      ], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
      check(parsed.status === 0,
        'the PowerShell status line relay Wanigan writes is a script PowerShell can parse',
        `${parsed.stdout ?? ''}${parsed.stderr ?? ''}`.trim() || `exit ${String(parsed.status)}`);
      return;
    }

    // The operator's own status line: colour codes, a field read from stdin, a
    // trailing blank line, and an exit status the relay must hand back.
    const own = path.join(tmp, 'own-status.sh');
    fs.writeFileSync(own, '#!/bin/sh\nread -r line\nprintf \'\\033[1mmine\\033[0m %s\\n\\n\' "$line"\nexit 0\n', { mode: 0o700 });
    const hang = path.join(tmp, 'hang-status.sh');
    fs.writeFileSync(hang, '#!/bin/sh\ntrap \'\' TERM\nwhile :; do /bin/sleep 1; done\n', { mode: 0o700 });
    const chained = project(tmp, 'repo-own', { type: 'command', command: shellQuote(own), padding: 1 });
    const SID = 's_smoke18_relay';
    const one = inject(SID, chained);
    const words = one ? wordsOf(one.command) : null;
    check(one !== null && words !== null && one.capability.length === 43,
      'a hook-enabled Claude session’s injected settings name the relay with its curl, config and chain paths quoted', one?.command);
    if (!one || !words) return;
    const wrapper = path.join(tmp, 'curl-wrapper');
    // Its own output file per invocation, and absolute paths only: the relay
    // runs with a PATH this suite chose.
    fs.writeFileSync(wrapper,
      `#!/bin/sh\nprintf '%s\\n' "$0" "$@" > ${shellQuote(path.join(tmp, 'argv'))}.$$\nexec ${shellQuote(words.curl)} "$@"\n`, { mode: 0o700 });
    check(JSON.stringify(one.keys) === JSON.stringify(['type', 'command']),
      'the injected statusLine sets only type and command, so a person’s own padding and refresh interval still apply', one.keys);
    check(!one.command.includes(one.capability) && !fs.readFileSync(words.relay, 'utf8').includes(one.capability),
      'the bearer appears in neither the injected command nor the relay script');
    check(fs.readFileSync(words.config, 'utf8').includes(`Bearer ${one.capability}`),
      'the bearer lives in the curl config file instead');
    check(mode(path.dirname(words.relay)) === 0o700 && mode(words.relay) === 0o700 && mode(words.config) === 0o600,
      'the relay directory and script are owner-only 0700 and the curl config holding the bearer is 0600',
      [mode(path.dirname(words.relay)), mode(words.relay), mode(words.config)].map((m) => m.toString(8)));
    check(!path.resolve(words.relay).startsWith(path.resolve(chained)) && !fs.existsSync(path.join(chained, '.claude', 'settings.json')),
      'nothing is written into the project: the relay and its files live in Wanigan’s own data directory');

    // ── authentication
    const post = (auth: string | null, body: string) => fetch(`http://127.0.0.1:${hs.port}/statusline`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body,
    });
    const wrong = await post(`Bearer ${'A'.repeat(43)}`, '{}');
    const none = await post(null, '{}');
    check(wrong.status === 401 && none.status === 401,
      'the status line endpoint refuses a wrong bearer and a missing one', [wrong.status, none.status]);
    check((db().prepare('SELECT COUNT(*) AS n FROM status_observations WHERE session_id = ?').get(SID) as { n: number }).n === 0,
      'and a refused post stores nothing');

    // ── a render, as the CLI does it
    const resetsAt = Math.round((now + 3 * 3_600_000) / 1000);
    const payload = (pct: number, extra: Record<string, unknown> = {}) => JSON.stringify({
      session_id: 'cli-own-session-id', cwd: chained, version: '2.1.270', model: { id: 'claude-opus-5' },
      rate_limits: { five_hour: { used_percentage: pct, resets_at: resetsAt } },
      prompt_cache: { warm: true, ttl: '1h', expires_at: Math.round((now + 50 * MIN) / 1000), requests: 12, misses: 1,
        hit_ratio: 0.91, last_miss_cause: { causes: ['tools_changed'] }, miss_causes: { tools_changed: 1 } },
      effort: { level: 'high' }, ...extra,
    });
    const asCli = statusLineCommand({ ...words, curl: wrapper, boundSeconds: words.bound });
    const first = await runRelay(asCli, chained, `${payload(40)}\n`);
    const expected = Buffer.from(`\u001b[1mmine\u001b[0m ${payload(40)}\n\n`);
    check(first.code === 0 && first.stdout.equals(expected),
      'chaining to the operator’s own status line prints its output byte for byte — colour codes and trailing blank line included — and keeps its exit status',
      JSON.stringify({ code: first.code, out: first.stdout.toString('utf8').slice(0, 80), err: first.stderr.slice(0, 120) }));
    check(fs.existsSync(words.chain) && mode(words.chain) === 0o600 && fs.readFileSync(words.chain, 'utf8') === shellQuote(own),
      'the chained command was resolved from the project’s own settings layer into a 0600 chain file');
    const argvFiles = fs.readdirSync(tmp).filter((n) => n.startsWith('argv.'));
    const argvText = argvFiles.map((n) => fs.readFileSync(path.join(tmp, n), 'utf8')).join('\n');
    check(argvFiles.length === 1 && argvText.includes('-K') && argvText.includes(words.config) && !argvText.includes(one.capability),
      'curl was handed the config file by path and the bearer never appeared in its argument vector', argvText.slice(0, 300));
    check(/^-q$/m.test(argvText.split('\n').slice(1, 2).join('')),
      'curl is told -q first, so no ~/.curlrc can add a proxy or a destination for the bearer');
    check(!fs.readdirSync(path.dirname(words.relay)).some((n) => n.startsWith('run.')),
      'the relay’s private scratch directory is gone once the render returns');

    const reading = statusline.sessionStatusLine(SID);
    check(reading !== null && reading.cache?.hitRatio === 0.91 && reading.effort === 'high' && reading.cliVersion === '2.1.270'
      && JSON.stringify(reading.cache?.missCauses) === JSON.stringify([{ cause: 'tools_changed', count: 1 }]),
      'the reading reached SQLite with the cache hit ratio, the CLI’s own miss cause, the effort and the CLI version', reading);
    const row = db().prepare('SELECT five_hour_pct, seven_day_pct, seven_day_resets_at, cache_json FROM status_observations WHERE session_id = ?')
      .get(SID) as { five_hour_pct: number; seven_day_pct: number | null; seven_day_resets_at: number | null; cache_json: string };
    check(row.five_hour_pct === 40 && row.seven_day_pct === null && row.seven_day_resets_at === null,
      'a window the CLI did not send is stored as absent, never as zero', row);
    check(!JSON.stringify(row).includes(chained) && !JSON.stringify(row).includes('claude-opus-5'),
      'the row keeps no working directory and no model name from the payload');

    await runRelay(asCli, chained, `${payload(40)}\n`);
    const rows = db().prepare('SELECT COUNT(*) AS n, MAX(last_seen_at) AS seen, MAX(observed_at) AS obs FROM status_observations WHERE session_id = ?')
      .get(SID) as { n: number; seen: number; obs: number };
    check(rows.n === 1 && rows.seen >= rows.obs, 'a redraw that says the same thing moves last_seen_at instead of writing a row', rows);

    // This suite's user-data directory has no space in it; the real one on
    // macOS is under "Application Support". The same relay, run from there.
    const spaced = path.join(tmp, 'Application Support', 'wanigan');
    fs.mkdirSync(spaced, { recursive: true, mode: 0o700 });
    const spacedRelay = path.join(spaced, 'relay.sh');
    fs.copyFileSync(words.relay, spacedRelay);
    fs.chmodSync(spacedRelay, 0o700);
    const viaSpace = await runRelay(statusLineCommand({ ...words, relay: spacedRelay, boundSeconds: words.bound }), chained, `${payload(40)}\n`);
    check(viaSpace.code === 0 && viaSpace.stdout.equals(expected),
      'the injected command still runs the relay, and its chain, from a directory whose path contains a space',
      { code: viaSpace.code, err: viaSpace.stderr.slice(0, 160) });

    // ── what the Usage view is handed
    const noAccount = (at: number) => statusline.observedLimits(at).accounts.find((a) => a.accountId === null);
    const once = noAccount(Date.now());
    const five = once?.windows.find((w) => w.kind === 'five_hour');
    check(once !== undefined && once.windows.length === 1 && five !== undefined && !once.windows.some((w) => w.kind === 'seven_day'),
      'observed limits list only the window the status line carried; the absent seven-day window is not drawn', once?.windows.map((w) => w.kind));
    check(five?.forecast.state === 'insufficient' && five.forecast.state === 'insufficient' && five.forecast.samples === 1,
      'the forecast refuses with a single reading rather than extrapolating one point', five?.forecast);
    statusline.acceptStatusLine(SID, payload(48), Date.now() + 12 * MIN);
    const later = noAccount(Date.now() + 12 * MIN)?.windows.find((w) => w.kind === 'five_hour');
    check(later?.forecast.state === 'reaches' && later.usedPercent === 48 && later.jumps.length === 0,
      'two readings twelve minutes apart are enough to forecast a crossing of 100%, and an eight-point rise is not a jump', later);
    statusline.acceptStatusLine(SID, payload(70), Date.now() + 14 * MIN);
    const jumped = noAccount(Date.now() + 14 * MIN)?.windows.find((w) => w.kind === 'five_hour');
    check(jumped?.jumps.length === 1 && jumped.jumps[0].fromPercent === 48 && jumped.jumps[0].toPercent === 70,
      'a rise of twenty-two points between consecutive readings is flagged as a jump', jumped?.jumps);
    const apiKey = 's_smoke18_apikey';
    hooks.writeHookSettings(apiKey, chained);
    statusline.acceptStatusLine(apiKey, JSON.stringify({ version: '2.1.270', prompt_cache: { hit_ratio: 0.5 } }));
    const apiRow = db().prepare('SELECT five_hour_pct, seven_day_pct, spend_limit_pct FROM status_observations WHERE session_id = ?').get(apiKey);
    check(JSON.stringify(apiRow) === JSON.stringify({ five_hour_pct: null, seven_day_pct: null, spend_limit_pct: null }),
      'an API-key session’s reading, which carries no rate_limits at all, stores every window as absent', apiRow);
    hooks.cleanupHookSettings(apiKey);

    // ── bounded
    const hanging = project(tmp, 'repo-hang', { type: 'command', command: shellQuote(hang) });
    const two = inject('s_smoke18_hang', hanging);
    const hangWords = two ? wordsOf(two.command) : null;
    if (hangWords) {
      const bounded = await runRelay(statusLineCommand({ ...hangWords, boundSeconds: 1 }), hanging, `${payload(41)}\n`);
      check(bounded.code === 124 && bounded.stdout.length === 0 && bounded.ms < 5_000,
        'a status line command that hangs and ignores TERM is killed at the bound: the relay returns in seconds, prints nothing and exits 124',
        { code: bounded.code, ms: bounded.ms, out: bounded.stdout.toString('utf8').slice(0, 60), err: bounded.stderr.slice(0, 120) });
      check(bounded.stderr === '', 'and the shell’s own "Killed" notice does not reach the CLI’s stderr log', bounded.stderr);
    } else {
      check(false, 'a second session receives its own relay entry', two?.command);
    }
    hooks.cleanupHookSettings('s_smoke18_hang');

    // ── nothing to chain, and a chain that would call itself
    const plain = project(tmp, 'repo-plain', null);
    const three = inject('s_smoke18_plain', plain);
    const plainWords = three ? wordsOf(three.command) : null;
    if (plainWords) {
      const quiet = await runRelay(statusLineCommand({ ...plainWords, boundSeconds: 1 }), plain, `${payload(42)}\n`);
      check(quiet.code === 0 && quiet.stdout.length === 0 && !fs.existsSync(plainWords.chain),
        'with no status line of the operator’s own, the relay records the reading and prints nothing', { code: quiet.code, out: quiet.stdout.toString('utf8') });
      check(statusline.sessionStatusLine('s_smoke18_plain') !== null, 'and the reading from that silent render was still stored');
    }
    hooks.cleanupHookSettings('s_smoke18_plain');
    const loop = project(tmp, 'repo-loop', { type: 'command', command: one.command });
    const four = inject('s_smoke18_loop', loop);
    if (four) {
      await post(`Bearer ${four.capability}`, payload(43));
      const loopWords = wordsOf(four.command);
      check(loopWords !== null && !fs.existsSync(loopWords.chain),
        'a settings file that names Wanigan’s own relay is never chained, so the relay cannot call itself');
    }
    hooks.cleanupHookSettings('s_smoke18_loop');

    setSetting('status_line', '0');
    const off = inject('s_smoke18_off', plain);
    check(off !== null && off.command === '' && off.keys.length === 0,
      'with status line readings off, the injected settings carry hooks and no statusLine entry');
    hooks.cleanupHookSettings('s_smoke18_off');
    setSetting('status_line', '1');

    hooks.cleanupHookSettings(SID);
    check(!fs.existsSync(words.config) && !fs.existsSync(words.chain),
      'ending the session deletes its curl config and chain file along with the hook settings');

    /* ── traces ──────────────────────────────────────────────────────── */
    say('── observed telemetry · beta per-prompt traces');
    const TSID = 's_smoke18_traces';
    setSetting('traces_beta', '0');
    const quietEnv = otel.otelEnv(TSID);
    check(quietEnv.OTEL_TRACES_EXPORTER === 'none' && quietEnv.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA === undefined,
      'with the traces setting off, launches keep the trace exporter at none and never set the beta flag');
    setSetting('traces_beta', '1');
    const traceEnv = otel.otelEnv(TSID);
    const token = otel.collectorToken() ?? '';
    check(traceEnv.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA === '1' && traceEnv.OTEL_TRACES_EXPORTER === 'otlp'
      && traceEnv.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT === `http://127.0.0.1:${collectorPort}/v1/traces`
      && traceEnv.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL === 'http/json'
      && traceEnv.OTEL_EXPORTER_OTLP_TRACES_HEADERS === `x-wanigan-token=${token}`
      && traceEnv.OTEL_LOG_USER_PROMPTS === 'false' && traceEnv.OTEL_LOG_TOOL_CONTENT === 'false',
      'with it on, launches get the beta flag and a trace exporter pinned to the loopback collector, with content logging still off', traceEnv);
    setSetting('traces_beta', restore.traces);

    const secret = 'please paste the production API key sk-live-4242 into config.ts';
    const kv = (key: string, value: Record<string, unknown>) => ({ key, value });
    const ns = (ms: number) => String(ms * 1_000_000);
    const trace = 'f'.repeat(31) + '1';
    const spanFixture = (base: number, traceId = trace) => ({
      resourceSpans: [{
        resource: { attributes: [kv('wanigan.session.id', { stringValue: TSID }), kv('user.email', { stringValue: 'someone@example.com' })] },
        scopeSpans: [{ spans: [
          { traceId, spanId: '1000000000000001', name: 'claude_code.interaction', startTimeUnixNano: ns(base), endTimeUnixNano: ns(base + 30_000),
            attributes: [kv('user_prompt', { stringValue: secret }), kv('interaction.sequence', { intValue: '1' })] },
          { traceId, spanId: '1000000000000002', parentSpanId: '1000000000000001', name: 'claude_code.llm_request',
            startTimeUnixNano: ns(base + 100), endTimeUnixNano: ns(base + 4_100),
            attributes: [kv('model', { stringValue: 'claude-opus-5' }), kv('ttft_ms', { intValue: '820' }), kv('response.model_output', { stringValue: secret }),
              kv('input_tokens', { intValue: '1200' }), kv('stop_reason', { stringValue: 'tool_use' })] },
          { traceId, spanId: '1000000000000003', parentSpanId: '1000000000000001', name: 'claude_code.tool',
            startTimeUnixNano: ns(base + 4_200), endTimeUnixNano: ns(base + 20_200), status: { code: 2, message: secret },
            attributes: [kv('tool_name', { stringValue: 'Bash' }), kv('tool_input', { stringValue: secret }), kv('bash_argv0', { stringValue: 'curl' })] },
          { traceId, spanId: '1000000000000004', parentSpanId: '1000000000000003', name: 'claude_code.tool.blocked_on_user',
            startTimeUnixNano: ns(base + 4_300), endTimeUnixNano: ns(base + 16_300), attributes: [kv('decision', { stringValue: 'allow' })] },
        ] }],
      }],
    });
    const postTraces = (body: unknown, tok: string) => fetch(`http://127.0.0.1:${collectorPort}/v1/traces`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-wanigan-token': tok }, body: JSON.stringify(body),
    });
    const refused = await postTraces(spanFixture(now), 'not-the-token');
    check(refused.status === 401, 'a traces export without the collector token is refused', refused.status);
    const accepted = await postTraces(spanFixture(now), token);
    await postTraces(spanFixture(now), token);
    const stored = db().prepare('SELECT name, attrs_json FROM session_spans WHERE session_id = ?').all(TSID) as { name: string; attrs_json: string | null }[];
    check(accepted.ok && stored.length === 4, 'an OTLP/JSON traces export is stored once per span, and the exporter’s retry is ignored rather than doubled', stored.length);
    const storedText = JSON.stringify(stored);
    check(!storedText.includes('sk-live') && !storedText.includes('someone@example.com') && !storedText.includes('"curl"'),
      'no prompt, response, tool input, command word, error text or account identity from the fixture reached SQLite');
    const traces = otel.sessionTraces(TSID);
    const turn = traces.interactions[0];
    check(traces.requested && traces.interactions.length === 1 && turn?.rootMissing === false
      && JSON.stringify(turn.rows.map((r) => [r.kind, r.offsetMs, r.durationMs])) === JSON.stringify([
        ['llm_request', 100, 4000], ['tool', 4200, 16000], ['blocked', 4300, 12000]])
      && turn.rows[1].error && turn.totals.blockedMs === 12_000,
      'the stored spans lay out as one turn: model call, tool call and the wait on the operator, offset from the prompt', turn?.rows);

    const old = now - 45 * 86_400_000;
    await postTraces(spanFixture(old, 'e'.repeat(31) + '2'), token);
    const before = (db().prepare('SELECT COUNT(*) AS n FROM session_spans WHERE session_id = ?').get(TSID) as { n: number }).n;
    const pruned = otel.pruneSpans(30 * 86_400_000);
    const after = otel.sessionTraces(TSID);
    check(before === 8 && pruned === 4 && after.spans === 4 && after.interactions.length === 1,
      'retention prunes the spans older than the event retention window and keeps the recent turn whole', { before, pruned, after: after.spans });

    /* ── spend by source ─────────────────────────────────────────────── */
    say('── observed telemetry · spend by source');
    const SSID = 's_smoke18_spend';
    const point = (value: number, attrs: Record<string, string>) => ({
      asDouble: value, timeUnixNano: ns(Date.now()), attributes: Object.entries(attrs).map(([k, v]) => kv(k, { stringValue: v })),
    });
    const tokens = (value: number, attrs: Record<string, string>) => ({ ...point(0, attrs), asDouble: undefined, asInt: String(value) });
    const metrics = {
      resourceMetrics: [{
        resource: { attributes: [kv('wanigan.session.id', { stringValue: SSID })] },
        scopeMetrics: [{ metrics: [
          { name: 'claude_code.cost.usage', sum: { aggregationTemporality: 1, dataPoints: [
            point(1.5, { model: 'claude-opus-5', query_source: 'main', effort: 'high' }),
            point(0.75, { model: 'claude-opus-5', query_source: 'subagent', 'agent.name': 'custom' }),
            point(0.25, { model: 'claude-opus-5', query_source: 'main', 'skill.name': 'third-party', 'plugin.name': 'third-party' }),
            point(0.1, { model: 'claude-haiku-4', query_source: 'auxiliary', speed: 'fast' }),
            point(0.4, { model: 'claude-opus-5', query_source: 'main', 'mcp_server.name': 'custom' }),
          ] } },
          { name: 'claude_code.token.usage', sum: { aggregationTemporality: 1, dataPoints: [
            tokens(1200, { type: 'input', model: 'claude-opus-5', query_source: 'main' }),
            tokens(300, { type: 'output', model: 'claude-opus-5', query_source: 'subagent', 'agent.name': 'custom' }),
          ] } },
        ] }],
      }],
    };
    // Earlier phases exported cost for their own sessions today, so every
    // figure below is read as the change this export made.
    const base = otel.spendBySource(1);
    const sent = await fetch(`http://127.0.0.1:${collectorPort}/v1/metrics`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-wanigan-token': token }, body: JSON.stringify(metrics),
    });
    const report = otel.spendBySource(1);
    type Dim = 'source' | 'skill' | 'mcp' | 'agent';
    type Field = 'costUsd' | 'inTokens' | 'outTokens';
    const grew = (dimension: Dim, key: string, field: Field = 'costUsd') => {
      const pick = (r: typeof report) => r.groups[dimension].find((g) => g.key === key)?.[field] ?? 0;
      return Math.round((pick(report) - pick(base)) * 100) / 100;
    };
    check(sent.ok && grew('source', 'main') === 2.15 && grew('source', 'subagent') === 0.75 && grew('source', 'auxiliary') === 0.1,
      'cost metrics aggregate by the CLI’s query source: main, subagent and auxiliary', report.groups.source);
    check(grew('skill', 'third-party') === 0.25 && grew('agent', 'custom') === 0.75 && grew('mcp', 'custom') === 0.4 && grew('skill', '') === 2.75,
      'and by skill, subagent and MCP server, with the withheld names kept as their own groups and unattributed spend kept as a row', report.groups.skill);
    check(grew('agent', 'custom', 'outTokens') === 300 && grew('source', 'main', 'inTokens') === 1200,
      'token counts ride beside the dollars in the same groups');
    const usage = otel.usageFor(SSID);
    const added = Math.round((report.totals.costUsd - base.totals.costUsd) * 100) / 100;
    check(Math.abs(usage.costUsd - 3) < 1e-9 && added === 3
      && SPEND_DIMENSIONS.every((d) => Math.round(report.groups[d].reduce((a, g) => a + g.costUsd, 0) * 100) === Math.round(report.totals.costUsd * 100)),
      'every dimension adds back to the same total, and that total grew by exactly the session’s own recorded cost', { usage: usage.costUsd, added });
  } finally {
    setSetting('hooks', restore.hooks);
    setSetting('status_line', restore.statusLine);
    setSetting('traces_beta', restore.traces);
    setSetting('telemetry', restore.telemetry);
    if (restore.configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = restore.configDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
