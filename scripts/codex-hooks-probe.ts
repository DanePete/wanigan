// Re-verify, against the installed Codex and without spending anything, what
// Wanigan relies on to see into a Codex session (src/core/codex-hooks.ts). Run it
// after a Codex update:
//   node scripts/run-electron-node.mjs scripts/codex-hooks-probe.ts [--tui] [--turns]
//
// 1. Asks `hooks/list`, in a throwaway CODEX_HOME, exactly as a launch does, and
//    prints each hook's trust and the verdict a launch would get.
// 2. With --tui, also opens the Codex TUI in a throwaway CODEX_HOME and HOME,
//    whose model provider is a closed local port (no login, nothing reaches
//    OpenAI, no prompt is typed), quits it with Ctrl-C twice, and reports
//    whether the trusted SessionEnd hook ran with the session's environment
//    (WANIGAN_TOKEN) and what Codex sent it.
// 3. With --turns, runs three real turns in the TUI against a stand-in model
//    provider on a local port (sandbox-exec denies every other connection, so
//    nothing reaches OpenAI and no login is used): one that completes, one the
//    provider refuses with the 429 `usage_limit_reached` ChatGPT sends, and one
//    interrupted with Esc. It checks what Wanigan relies on (sessions.ts,
//    shared/codex-turns.ts, shared/limits.ts): a message pasted as the composer
//    types it fires UserPromptSubmit; only a completed turn fires Stop and its
//    OSC 9 notification; the rollout records the limit and the interrupt, in
//    words the parsers read. Then that `codex resume` finds no thread outside
//    its own CODEX_HOME, nor by a rollout's path.
// Never reads or writes the real ~/.codex. Exits non-zero when a check fails.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexHooks, installedCodexProbe, type CodexHookProbe } from '../src/core/codex-hooks.ts';
import { loginPath, which } from '../src/core/environment.ts';
import { CODEX_LIFECYCLE_ARGS } from '../src/shared/codex.ts';
import { codexRolloutLine, type CodexTurnEnd } from '../src/shared/codex-turns.ts';
import { codexLimitResetsAt, usageLimitMessage } from '../src/shared/limits.ts';

const require = createRequire(import.meta.url);
const tui = process.argv.includes('--tui');
const turns = process.argv.includes('--turns');
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'wanigan-codex-probe-')));
let failed = false;
const check = (ok: boolean, line: string): void => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${line}`); if (!ok) failed = true; };

try {
  const path = await loginPath();
  const bin = which('codex', path);
  if (!bin) throw new Error('codex is not on the login shell’s PATH');
  console.log(`codex: ${bin}`);

  // The hook command is a stand-in relay that writes down what it was given, so
  // the TUI check can read it; its path has a space, like Wanigan's data folder.
  const out = join(scratch, 'out');
  const relay = join(scratch, 'Wanigan data', 'hooks', 'relay.sh');
  mkdirSync(out);
  mkdirSync(join(scratch, 'Wanigan data', 'hooks'), { recursive: true });
  writeFileSync(relay, `#!/bin/sh\nf="${out}/$1-$$"\nenv > "$f.env"\ncat > "$f.json"\nexit 0\n`, { mode: 0o700 });

  // 1. The app-server probe, through the same code a launch runs.
  const probe: CodexHookProbe = {
    version: installedCodexProbe.version,
    async list(b, p, args) {
      const hooks = await installedCodexProbe.list(b, p, args);
      const trusting = args.some((a) => a.startsWith('hooks.state='));
      console.log(`\nhooks/list ${trusting ? 'with' : 'without'} hooks.state:`);
      for (const h of hooks) console.log(`  ${h.key}  ${h.source}  ${h.trustStatus}  ${h.currentHash}`);
      return hooks;
    },
  };
  const version = await installedCodexProbe.version(bin, path);
  console.log(`version: ${version ?? 'unreadable'}`);
  const launch = await new CodexHooks(relay, probe).prepare(bin, path);
  console.log('');
  check(launch.args !== null, launch.args ? 'every hook lists as trusted: a launch would inject them' : `a launch would go without hooks: ${launch.why}`);

  // 2. The TUI, spend-free: do trusted hooks run, with the session's environment?
  if (tui && launch.args) {
    const pty = require('node-pty') as typeof import('node-pty');
    const home = join(scratch, 'codex-home');
    const userHome = join(scratch, 'home');
    const cwd = join(scratch, 'work dir');
    for (const d of [home, userHome, cwd]) mkdirSync(d, { recursive: true });
    writeFileSync(join(home, 'config.toml'), [
      'model = "probe-model"', 'model_provider = "probe"', 'check_for_update_on_startup = false',
      '[analytics]', 'enabled = false',
      '[model_providers.probe]', 'name = "probe"', 'base_url = "http://127.0.0.1:9/v1"', 'wire_api = "responses"', 'requires_openai_auth = false',
      `[projects.${JSON.stringify(cwd)}]`, 'trust_level = "trusted"', '',
    ].join('\n'));
    const token = `probe-${randomBytes(6).toString('hex')}`;
    let screen = '';
    let exited = false;
    const term = pty.spawn(bin, launch.args, {
      name: 'xterm-256color', cols: 120, rows: 32, cwd,
      env: { PATH: path, HOME: userHome, TERM: 'xterm-256color', CODEX_HOME: home, WANIGAN_TOKEN: token, WANIGAN_HOOK_SOCKET: join(scratch, 'none.sock') },
    });
    term.onData((d) => { screen += d; });
    term.onExit(() => { exited = true; });
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 100 && !/Ask Codex|›/.test(screen); i++) await sleep(100);
    await sleep(1500);
    console.log(`\nTUI up; hooks run so far: ${readdirSync(out).length ? readdirSync(out).join(', ') : 'none (SessionStart waits for a first turn)'}`);
    term.write('\x03');
    await sleep(800);
    term.write('\x03');
    for (let i = 0; i < 80 && !exited; i++) await sleep(100);
    if (!exited) term.kill('SIGKILL');
    const end = readdirSync(out).find((f) => f.startsWith('SessionEnd-') && f.endsWith('.json'));
    check(!!end, 'the trusted SessionEnd hook ran when Codex quit');
    if (end) {
      const env = readFileSync(join(out, end.replace(/\.json$/, '.env')), 'utf8');
      const payload = JSON.parse(readFileSync(join(out, end), 'utf8')) as Record<string, unknown>;
      check(env.split('\n').includes(`WANIGAN_TOKEN=${token}`), 'the hook inherited the session’s WANIGAN_TOKEN');
      console.log(`     payload keys: ${Object.keys(payload).join(', ')}`);
      check(typeof payload.session_id === 'string', `session_id: ${String(payload.session_id)}`);
      check(typeof payload.transcript_path === 'string' && payload.transcript_path.startsWith(`${home}/`), `transcript_path inside CODEX_HOME: ${String(payload.transcript_path)}`);
    }
  } else if (tui) {
    console.log('\n--tui skipped: the hooks are not trusted, so there is nothing to run.');
  }

  // 3. Real turns against a stand-in provider: what ends a turn, and what says so.
  if (turns && launch.args) {
    const pty = require('node-pty') as typeof import('node-pty');
    const resetsAt = Math.floor(Date.now() / 1000) + 2 * 3600 + 17 * 60;
    // Each turn's request carries its prompt: turn one is answered, turn two refused on the limit, turn three never answered.
    const provider = createServer((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => { body += d.toString('utf8'); });
      req.on('end', () => {
        if (req.method !== 'POST' || !req.url?.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
        if (body.includes('Take your time')) {
          setTimeout(() => { try { res.writeHead(500); res.end(); } catch { /* gone */ } }, 20_000);
        } else if (body.includes('Say hello again')) {
          res.writeHead(429, {
            'content-type': 'application/json',
            'x-codex-primary-used-percent': '100.0', 'x-codex-primary-window-minutes': '300', 'x-codex-primary-reset-at': String(resetsAt),
            'x-codex-secondary-used-percent': '41.0', 'x-codex-secondary-window-minutes': '10080', 'x-codex-secondary-reset-at': String(resetsAt + 432000),
          });
          res.end(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'plus', resets_at: resetsAt } }));
        } else {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const e of [
            { type: 'response.created', response: { id: 'resp_1' } },
            { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'msg_1', content: [{ type: 'output_text', text: 'Stand-in reply.' }] } },
            { type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 13 } } },
          ]) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', () => resolve()));
    const port = (provider.address() as { port: number }).port;
    const homeFor = (name: string): { home: string; userHome: string; cwd: string } => {
      const dirs = { home: join(scratch, `${name}-codex-home`), userHome: join(scratch, `${name}-home`), cwd: join(scratch, 'turns work dir') };
      for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
      writeFileSync(join(dirs.home, 'config.toml'), [
        'model = "probe-model"', 'model_provider = "probe"', 'check_for_update_on_startup = false',
        '[analytics]', 'enabled = false',
        '[model_providers.probe]', 'name = "probe"', `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false',
        `[projects.${JSON.stringify(dirs.cwd)}]`, 'trust_level = "trusted"', '',
      ].join('\n'));
      return dirs;
    };
    const SANDBOX = '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(allow network-outbound (remote unix-socket))';
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const plain = (t: string): string => t.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/[ \t]+/g, ' ');
    const spawnCodex = (dirs: ReturnType<typeof homeFor>, args: string[]) => {
      const term = pty.spawn('/usr/bin/sandbox-exec', ['-p', SANDBOX, bin, ...args], {
        name: 'xterm-256color', cols: 120, rows: 32, cwd: dirs.cwd,
        env: { PATH: path, HOME: dirs.userHome, TERM: 'xterm-256color', CODEX_HOME: dirs.home, LANG: 'en_US.UTF-8', WANIGAN_HOOK_SOCKET: join(scratch, 'none.sock') },
      });
      const state = { screen: '', exited: false };
      term.onData((d) => { state.screen += d; if (d.includes('\x1b[6n')) term.write('\x1b[1;1R'); });
      term.onExit(() => { state.exited = true; });
      return { term, state };
    };
    const fired = (event: string): number => readdirSync(out).filter((f) => f.startsWith(`${event}-`) && f.endsWith('.json')).length;
    const notified = (screen: string): string[] => [...screen.matchAll(/\x1b\]9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g)].map((m) => m[1] ?? '');
    const dirs = homeFor('turns');
    const { term, state } = spawnCodex(dirs, [...CODEX_LIFECYCLE_ARGS, ...launch.args]);
    // Exactly as Wanigan's composer types a message: one bracketed paste, then Enter.
    const typeIn = async (text: string): Promise<void> => { term.write(`\x1b[200~${text}\x1b[201~`); await sleep(60); term.write('\r'); };
    const promptsHad = (): string[] => readdirSync(out).filter((f) => f.startsWith('UserPromptSubmit-') && f.endsWith('.json'))
      .map((f) => (JSON.parse(readFileSync(join(out, f), 'utf8')) as { prompt?: string }).prompt ?? '');
    for (let i = 0; i < 150 && !/›/.test(plain(state.screen)); i++) await sleep(100);
    await sleep(1500);
    console.log('\nturns: the TUI is up against a stand-in provider (nothing else is reachable)');

    const stops0 = fired('Stop');
    await typeIn('Say hello');
    for (let i = 0; i < 150 && notified(state.screen).length < 1; i++) await sleep(100);
    await sleep(2000);
    check(promptsHad().includes('Say hello'), 'a pasted message fired UserPromptSubmit, with the prompt');
    check(fired('Stop') === stops0 + 1, 'the completed turn fired Stop');
    check(notified(state.screen).length === 1, `the completed turn sent its OSC 9 notification (${JSON.stringify(notified(state.screen))})`);

    const stops1 = fired('Stop');
    const mark = state.screen.length;
    await typeIn('Say hello again');
    for (let i = 0; i < 100 && !/usage limit/i.test(plain(state.screen.slice(mark))); i++) await sleep(100);
    await sleep(2500);
    check(promptsHad().includes('Say hello again'), 'the limited turn fired UserPromptSubmit');
    check(fired('Stop') === stops1, 'the limited turn fired no Stop');
    check(notified(state.screen).length === 1, 'the limited turn sent no OSC 9 notification');
    const drawn = plain(state.screen.slice(mark)).split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('■ '));
    console.log(`     its screen: ${drawn ?? '(no ■ line)'}`);

    term.write('\x1b'); // the "switch model" question Codex shows after a limit
    await sleep(800);
    const stops2 = fired('Stop');
    const notes2 = notified(state.screen).length;
    await typeIn('Take your time');
    await sleep(2500);
    term.write('\x1b');
    await sleep(3000);
    check(fired('Stop') === stops2 && notified(state.screen).length === notes2, 'the interrupted turn fired no Stop and sent no notification');
    term.write('\x03'); await sleep(800); term.write('\x03');
    for (let i = 0; i < 80 && !state.exited; i++) await sleep(100);
    if (!state.exited) term.kill('SIGKILL');

    // What the rollout says about each turn, read the way the core reads it.
    const turnIds = readdirSync(out).filter((f) => f.startsWith('UserPromptSubmit-') && f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(out, f), 'utf8')) as { prompt?: string; turn_id?: string; transcript_path?: string });
    const rollout = turnIds.find((t) => t.transcript_path)?.transcript_path ?? '';
    const lines = rollout ? readFileSync(rollout, 'utf8').split('\n') : [];
    const endOf = (prompt: string): { end: CodexTurnEnd | null; fullUntil: number | null } => {
      const id = turnIds.find((t) => t.prompt === prompt)?.turn_id ?? '';
      let fullUntil: number | null = null;
      for (const line of lines) {
        const fact = id ? codexRolloutLine(line, id) : null;
        if (fact && 'fullUntil' in fact) fullUntil = fact.fullUntil ?? fullUntil;
        else if (fact) return { end: fact.end, fullUntil };
      }
      return { end: null, fullUntil };
    };
    check(rollout.startsWith(`${dirs.home}/`), `the hooks named the rollout inside CODEX_HOME: ${rollout}`);
    check(endOf('Say hello').end?.kind === 'completed', 'the rollout records turn one completing');
    const limited = endOf('Say hello again');
    const failure = limited.end?.kind === 'failed' ? limited.end : null;
    const words = failure ? usageLimitMessage('StopFailure', { error: failure.info ?? '', last_assistant_message: failure.message }) : null;
    check(failure?.info === 'usage_limit_exceeded' && words !== null, `the rollout records turn two failing on the usage limit: ${failure?.info} "${failure?.message}"`);
    const said = words && failure ? codexLimitResetsAt(words, failure.at ?? Date.now()) : null;
    check(said !== null && Math.abs(said - resetsAt * 1000) < 60_000, `its reset reads as ${said ? new Date(said).toString() : 'unknown'}`);
    check(limited.fullUntil === resetsAt * 1000, 'its token count reports the full window and when it resets');
    check(endOf('Take your time').end?.kind === 'aborted', 'the rollout records turn three interrupted');

    // A thread lives in its own CODEX_HOME: another account's Codex finds it neither by id nor by its rollout's path.
    const thread = turnIds.find((t) => t.transcript_path)?.transcript_path?.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/)?.[1] ?? '';
    for (const [label, target] of [['its id', thread], ['its rollout path', rollout]] as const) {
      const other = spawnCodex(homeFor(`other-${label.length}`), ['resume', target]);
      for (let i = 0; i < 100 && !other.state.exited; i++) await sleep(100);
      if (!other.state.exited) other.term.kill('SIGKILL');
      check(/No saved session found/.test(plain(other.state.screen)), `another CODEX_HOME's \`codex resume\` by ${label} finds nothing`);
    }
    provider.close();
  } else if (turns) {
    console.log('\n--turns skipped: the hooks are not trusted, so there is nothing to run.');
  }
} catch (error) {
  check(false, (error as Error).message);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
