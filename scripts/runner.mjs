/**
 * What `launch.sh`, `cli.sh` and `smoke.sh` all had to do before they could
 * start Electron, in one place and on every platform.
 *
 * Those three were bash, which meant `npm test` could not reach its last step
 * on Windows at all: the suite stopped at `./scripts/smoke.sh` with a spawn
 * error, so nothing about a Windows build was provable, including whether the
 * Windows build worked. They were also three copies of the same preamble, and
 * this repository already has one lesson about copies kept in step by hand —
 * `AGENTS.md` opens with it. So this is the shared half, imported by all three,
 * rather than a fourth copy that happens to be portable.
 *
 * Nothing here shells out. `npm` on Windows is `npm.cmd`, which CreateProcess
 * cannot start, and reaching for `shell: true` to fix that puts every argument
 * through `cmd.exe` — the thing `src/shared/platform.ts` exists to avoid. Both
 * the build and the app are started from this process's own Node instead:
 * electron-vite is a .js file, and the `electron` package exports the path to
 * its binary.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The environment a child Electron may see.
 *
 * `ELECTRON_RUN_AS_NODE` is unset deliberately and not merely left alone: VS
 * Code sets it for its extension host, so a Wanigan started from a VS Code
 * terminal inherits it, gets a path string back from `require('electron')`, and
 * dies before it reaches any of our code with "Cannot read properties of
 * undefined (reading 'whenReady')". The `VSCODE_*` sweep is the same hazard one
 * step out: some editor and Codex hosts export a whole family of them.
 *
 * The directory holding *this* Node goes on the front of PATH. That replaces
 * the `.nvmrc`-reading block the shell scripts each carried, and it is both
 * simpler and more correct: whatever Node is running this script is the Node
 * every child should get, whether it came from nvm, fnm, volta, Homebrew or a
 * Windows installer. The old block only knew about nvm, and only on POSIX.
 */
export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
  const nodeDir = path.dirname(process.execPath);
  env.PATH = [nodeDir, env.PATH ?? ''].filter(Boolean).join(path.delimiter);
  // Windows resolves the variable case-insensitively but `process.env` on
  // Windows is case-insensitive only through its proxy; a spawned child is
  // handed the literal keys, and a stale `Path` beside our new `PATH` is the
  // one that wins. Remove it so there is exactly one.
  if (process.platform === 'win32') for (const key of Object.keys(env)) {
    if (key !== 'PATH' && key.toUpperCase() === 'PATH') delete env[key];
  }
  return env;
}

/**
 * Refuse to run under a Node older than `.nvmrc`, and say so.
 *
 * The three shell scripts each repaired this silently, by reading `.nvmrc` and
 * prepending `~/.nvm/versions/node/v<ver>/bin` to PATH. That only ever worked
 * for nvm, only on POSIX, and only because the child was `npm`; here the build
 * runs from `process.execPath`, so prepending a directory would change nothing
 * about which Node compiles the app.
 *
 * A refusal is the better trade anyway. Node 16 fails the build with
 * `crypto$2.getRandomValues is not a function`, which reads like a Vite bug and
 * costs an afternoon; the silent repair also meant `npm run app` could run a
 * different Node than the one you invoked it with, which is its own confusion.
 * This says the version it wanted, the version it got, and what to type.
 */
export function assertNodeVersion() {
  let want;
  try { want = fs.readFileSync(path.join(REPO, '.nvmrc'), 'utf8').replace(/[v\s]/g, ''); } catch { return; }
  if (!want) return;
  const parts = (text) => text.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [wantMajor, wantMinor, wantPatch] = parts(want);
  const [haveMajor, haveMinor, havePatch] = parts(process.versions.node);
  const behind = haveMajor !== wantMajor
    ? haveMajor < wantMajor
    : haveMinor !== wantMinor ? haveMinor < wantMinor : havePatch < wantPatch;
  if (!behind) return;
  process.stderr.write(
    `Wanigan needs Node ${want} (.nvmrc) and this is ${process.versions.node}.\n`
    + `Run \`nvm use\` — or install ${want} — and try again. An older Node fails the\n`
    + 'build with "crypto$2.getRandomValues is not a function", which reads like a\n'
    + 'Vite bug and is not.\n',
  );
  process.exit(1);
}

/** Run to completion, inheriting stdio, and resolve with the exit code. */
export function run(file, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: REPO, stdio: 'inherit', ...options });
    child.once('error', (error) => {
      process.stderr.write(`could not start ${file}: ${error.message}\n`);
      resolve(1);
    });
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/**
 * `npm run build`, without npm.
 *
 * Quiet on success and loud on failure, which is what the shell scripts did by
 * running the build twice. This captures instead, so a failing build is not
 * compiled a second time before anybody sees why it failed.
 */
export async function build({ quiet = true } = {}) {
  // Resolved by path, not by specifier: electron-vite's package.json exports
  // map publishes only "." and "./node", so require.resolve on the bin file
  // fails ERR_PACKAGE_PATH_NOT_EXPORTED.
  const cli = path.join(REPO, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
  if (!quiet) return run(process.execPath, [cli, 'build'], { env: childEnv() });

  let output = '';
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'build'], {
      cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(),
    });
    const keep = (buffer) => { if (output.length < 64 * 1024) output += buffer.toString(); };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.once('error', (error) => { output += `\n${error.message}`; resolve(1); });
    child.once('exit', (c, signal) => resolve(c ?? (signal ? 1 : 0)));
  });
  if (code !== 0) process.stderr.write(`build failed\n${output}\n`);
  return code;
}

/** The Electron binary this install provides. */
export function electronBinary() {
  const resolved = require('electron');
  if (typeof resolved !== 'string') {
    throw new Error('The electron package did not report a binary path. Run npm ci.');
  }
  return resolved;
}

/**
 * Refuse to run against a build older than the sources.
 *
 * `[ -d out ] || npm run build` looks like a cache and is a trap: after the
 * first build it never rebuilds again, so every later launch silently runs code
 * you already fixed. The guard is the timestamp, not the directory's existence.
 */
export function newestSourceMtime() {
  let newest = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      try { newest = Math.max(newest, fs.statSync(full).mtimeMs); } catch { /* raced a write */ }
    }
  };
  walk(path.join(REPO, 'src'));
  return newest;
}

export function builtMtime() {
  try { return fs.statSync(path.join(REPO, 'out', 'main', 'index.js')).mtimeMs; } catch { return 0; }
}

/** A private temporary directory that is removed however this process ends. */
export function scratch(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const remove = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* going away anyway */ } };
  process.once('exit', remove);
  return { dir, remove };
}
