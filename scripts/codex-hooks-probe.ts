// Re-verify, against the installed Codex and without spending anything, what
// Wanigan relies on to see into a Codex session (src/core/codex-hooks.ts). Run it
// after a Codex update:
//   node scripts/run-electron-node.mjs scripts/codex-hooks-probe.ts [--tui]
//
// 1. Asks `hooks/list`, in a throwaway CODEX_HOME, exactly as a launch does, and
//    prints each hook's trust and the verdict a launch would get.
// 2. With --tui, also opens the Codex TUI in a throwaway CODEX_HOME and HOME,
//    whose model provider is a closed local port (no login, nothing reaches
//    OpenAI, no prompt is typed), quits it with Ctrl-C twice, and reports
//    whether the trusted SessionEnd hook ran with the session's environment
//    (WANIGAN_TOKEN) and what Codex sent it.
// Never reads or writes the real ~/.codex. Exits non-zero when a check fails.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexHooks, installedCodexProbe, type CodexHookProbe } from '../src/core/codex-hooks.ts';
import { loginPath, which } from '../src/core/environment.ts';

const require = createRequire(import.meta.url);
const tui = process.argv.includes('--tui');
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
} catch (error) {
  check(false, (error as Error).message);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
