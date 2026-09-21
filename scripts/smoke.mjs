/**
 * Full batch lifecycle against the mock runner, inside the real Electron main
 * process. No network, no spend. Run after any change to the batch pipeline.
 *
 * This replaces scripts/smoke.sh, which was bash and therefore the step where
 * `npm test` stopped on Windows — before the last and only gate that starts a
 * real main process. See scripts/runner.mjs for why nothing here shells out.
 */

import fs from 'node:fs';
import { assertNodeVersion, REPO, build, childEnv, electronBinary, run, scratch } from './runner.mjs';

assertNodeVersion();

const log = scratch('wanigan-smoke-log-');
const userData = scratch('wanigan-smoke-udd-');
const logFile = `${log.dir}/smoke.log`;

if (await build() !== 0) process.exit(1);

const env = childEnv({
  WANIGAN_SMOKE: '1',
  WANIGAN_MOCK: '1',
  WANIGAN_MOCK_DELAY_MS: '1000',
  WANIGAN_SMOKE_LOG: logFile,
});

const electron = electronBinary();
const args = [REPO, `--user-data-dir=${userData.dir}`];
// Test profiles must never ask the operator to create/unlock a real Keychain.
if (process.platform === 'darwin') args.push('--use-mock-keychain');

/**
 * Electron 44 on macOS can defer app.ready indefinitely when a nested test
 * runner gives it only pipes, so the suite needs a controlling terminal there.
 * `script` supplies a small local pseudo-terminal, preserves the child's exit
 * status, and keeps this deterministic both in CI and from an interactive
 * shell.
 *
 * Only macOS needs it, and only macOS has this spelling of `script` — the
 * util-linux one takes its arguments in a different order, and Windows has no
 * equivalent and no symptom. Everywhere else starts Electron directly, which is
 * what smoke.sh did too.
 */
const code = process.platform === 'darwin' && fs.existsSync('/usr/bin/script')
  ? await run('/usr/bin/script', ['-q', '/dev/null', electron, ...args], { env })
  : await run(electron, args, { env });

// Electron prints its results while attached. On an early failure the log can
// still hold the only useful diagnostic.
if (code !== 0) {
  try {
    const text = fs.readFileSync(logFile, 'utf8');
    if (text.trim()) process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  } catch { /* the run failed before it opened the log */ }
}

log.remove();
userData.remove();
process.exit(code);
