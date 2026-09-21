#!/usr/bin/env node
/*
 * The account a session is pinned to is the account it actually runs under.
 *
 * Wanigan chooses a session's configuration directory by setting the harness's
 * own variable — CLAUDE_CONFIG_DIR, CODEX_HOME — from the pinned account. For
 * the account that *is* the platform default it sets nothing, deliberately:
 * pointing CLAUDE_CONFIG_DIR at ~/.claude makes the CLI read .claude.json from
 * inside the directory rather than beside it and report a signed-in operator as
 * logged out. Setting nothing was then taken to mean the child would have
 * nothing, and it did not: a Wanigan started from a shell that exports the
 * variable — which is every Wanigan started from inside a Claude Code session —
 * handed that shell's directory to every session pinned to the default account.
 * They resumed into "No conversation found with session ID", and new ones ran
 * against another login's credentials while the UI named the pinned account.
 *
 * Unit coverage asserts what the environment builders return. Only a real
 * launch proves what the spawned process received, which is what this reads —
 * out of the process table, not out of Wanigan.
 *
 * Two cases, and the second is why the first means anything:
 *
 *   1. DEFAULT ACCOUNT, poisoned shell. The spawned CLI must carry no config
 *      directory at all, which is what running the CLI by hand is.
 *   2. NAMED ACCOUNT (control). The spawned CLI must carry exactly that
 *      account's directory. Without this, "no variable found" could equally
 *      mean the probe cannot see one, and would prove nothing.
 *
 * It runs against an isolated user-data directory, so a Wanigan already open on
 * this machine — and any agent it is running — is untouched. No prompt is ever
 * submitted: both sessions sit at their composer and are killed, so nothing is
 * spent and no transcript is written.
 *
 * Usage:  npm run build && node scripts/probe-account-env.mjs
 * Exit 0 when both cases pass, 1 otherwise.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchWanigan } from './electron-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { _electron: electron } = createRequire(import.meta.url)('playwright-core');
const POISON = path.join(os.tmpdir(), 'wanigan-probe-poison-config');
const tag = randomUUID();
const say = (...a) => console.log(...a);
const unwrap = (v) => (v && typeof v === 'object' && 'data' in v ? v.data : v);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-probe-ud-'));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-probe-repo-'));
execFileSync('git', ['init', '-q'], { cwd: repo });
fs.writeFileSync(path.join(repo, 'README.md'), '# probe\n');
execFileSync('git', ['add', '.'], { cwd: repo });
execFileSync('git', ['-c', 'user.email=p@p', '-c', 'user.name=p', 'commit', '-qm', 'init'], { cwd: repo });
fs.mkdirSync(POISON, { recursive: true });

// Adoption reads the ambient variable, so Wanigan boots without it: the default
// account has to settle on ~/.claude before the shell is poisoned, or there is
// no mismatch left to test.
const env = { ...process.env, WANIGAN_PROBE_TAG: tag };
delete env.CLAUDE_CONFIG_DIR;

/** The config directory the CLI this session spawned actually received. */
function spawnedConfigDir() {
  const ps = execFileSync('/bin/ps', ['ewwx'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const lines = ps.split('\n').filter((l) => l.includes(`WANIGAN_PROBE_TAG=${tag}`) && l.includes('claude'));
  const withDir = lines.find((l) => l.includes('CLAUDE_CONFIG_DIR='));
  return withDir ? withDir.match(/CLAUDE_CONFIG_DIR=(\S+)/)[1] : null;
}

let app, page, failures = 0;
const check = (ok, what, detail) => {
  say(`${ok ? '  ok ' : ' FAIL'}  ${what}`);
  if (detail !== undefined) say(`        ${detail}`);
  if (!ok) failures += 1;
};

try {
  ({ app, page } = await launchWanigan(electron, { root: ROOT, userData, env }));

  const accounts = unwrap(await page.evaluate(() => window.wanigan.accounts.list('claude-code')));
  const def = accounts.find((a) => a.isDefault);
  if (!def) throw new Error('no default claude-code account was adopted');
  say(`default account: ${def.label} -> ${def.configDir}`);

  await app.evaluate((_electronApi, poison) => { process.env.CLAUDE_CONFIG_DIR = poison; }, POISON);
  say(`ambient shell  : CLAUDE_CONFIG_DIR=${POISON}\n`);

  const projectId = unwrap(await page.evaluate((dir) => window.wanigan.projects.add(dir), repo)).id;

  const pinned = unwrap(await page.evaluate((o) => window.wanigan.sessions.create(o),
    { providerId: 'claude', projectId, accountId: def.id }));
  await new Promise((r) => setTimeout(r, 4000));
  const got = spawnedConfigDir();
  check(got === null,
    'a session on the default account carries no config directory, so the shell’s cannot reach it',
    got === null ? '(none, as running the CLI by hand)' : `got ${got}`);
  await page.evaluate((id) => window.wanigan.sessions.kill(id), pinned.id);

  // The control. An account directory must live under home or Wanigan's own
  // data root, and --user-data-dir sets Chromium's appData one level above it.
  const waniganData = await app.evaluate(({ app: a }) => a.getPath('userData'));
  const namedDir = fs.mkdtempSync(path.join(waniganData, 'probe-acct-'));
  const named = unwrap(await page.evaluate((d) => window.wanigan.accounts.create(
    { harness: 'claude-code', label: 'ProbeNamed', configDir: d }), namedDir));
  const control = unwrap(await page.evaluate((o) => window.wanigan.sessions.create(o),
    { providerId: 'claude', projectId, accountId: named.id }));
  await new Promise((r) => setTimeout(r, 4000));
  const controlGot = spawnedConfigDir();
  check(controlGot === namedDir,
    'a session on a named account carries that account’s directory, so the absence above is a reading and not a blind spot',
    controlGot ?? '(none)');
  await page.evaluate((id) => window.wanigan.sessions.kill(id), control.id);
} catch (error) {
  say(` FAIL  the probe could not complete: ${error?.message ?? error}`);
  failures += 1;
} finally {
  try { await app?.close(); } catch { /* already gone */ }
  try { execFileSync('/usr/bin/pkill', ['-f', `WANIGAN_PROBE_TAG=${tag}`]); } catch { /* none left */ }
  for (const dir of [userData, repo, POISON]) fs.rmSync(dir, { recursive: true, force: true });
}

say(failures ? `\n${failures} failed` : '\nboth cases passed');
process.exit(failures ? 1 : 0);
