#!/usr/bin/env node
// Prove the first-run checklist on a machine that has never run Wanigan.
//
// Why this exists rather than a screenshot: scripts/shots.mjs seeds a project
// over the IPC surface before it captures, so it has never photographed a true
// first run — the one screen every new operator sees. This launches the built
// app against an empty user-data directory, seeds nothing, and asserts the text
// the checklist actually rendered. A PNG proves a window opened; it does not
// prove a view rendered, so the assertions are on the DOM and the capture is
// evidence for a human afterwards.
//
// Usage:  npm run build && node scripts/probe-preflight.mjs [--out docs/shots/preflight]
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { launchWanigan } from './electron-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const OUT = path.resolve(REPO, outArg >= 0 ? args[outArg + 1] : 'docs/shots/preflight');

let electron;
try { ({ _electron: electron } = require('playwright-core')); }
catch { console.error('playwright-core is not resolvable; run `npm i -D playwright-core`.'); process.exit(2); }

if (!existsSync(path.join(REPO, 'out/main/index.js'))) {
  console.error('No build in out/. Run `npm run build` first.');
  process.exit(2);
}

// The same environment scrub as scripts/launch.sh: a VS Code shell exports
// ELECTRON_RUN_AS_NODE, which makes the binary run as plain Node and die.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];

mkdirSync(OUT, { recursive: true });
const udd = mkdtempSync(path.join(tmpdir(), 'wanigan-preflight-'));

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? '[32m✓[0m' : '[31m✗[0m'} ${label}`);
  if (!ok) { failures += 1; if (detail !== undefined) console.log(`      ${String(detail).slice(0, 400)}`); }
};

const { app, page } = await launchWanigan(electron, { root: REPO, userData: udd, env });
try {
  await page.setViewportSize({ width: 1440, height: 900 });
  // The checklist renders after its own read resolves, which spawns a version
  // probe per profile. Wait for the element rather than a fixed sleep.
  await page.waitForSelector('.mission-setup', { timeout: 45_000 });

  const seen = await page.evaluate(() => {
    const root = document.querySelector('.mission-setup');
    const items = [...root.querySelectorAll('.mission-setup-item')].map((li) => ({
      done: li.classList.contains('is-done'),
      title: li.querySelector('strong')?.textContent?.trim() ?? '',
      detail: li.querySelector('.mission-setup-detail')?.textContent?.trim() ?? '',
    }));
    return {
      text: root.innerText,
      items,
      commands: [...root.querySelectorAll('.mission-setup-install code')].map((c) => c.textContent.trim()),
      unnamed: [...root.querySelectorAll('button')].filter((b) => !b.textContent.trim() && !b.getAttribute('aria-label')).length,
    };
  });

  console.log('── first run, empty user-data directory');
  check(seen.items.length === 3, 'the checklist renders three items', seen.items.length);
  check(seen.items[1] && !seen.items[1].done, 'with no project registered, the project item is unsatisfied', seen.items[1]);
  check(seen.items[2] && !seen.items[2].done, 'with no session ever started, the session item is unsatisfied', seen.items[2]);
  check(!/not signed in|signed out/i.test(seen.text),
    'nothing on a first-run screen claims the operator is signed out', seen.text);
  check(seen.unnamed === 0, 'every control in the checklist has an accessible name', seen.unnamed);

  // The agent item is the one that legitimately differs by machine: this one
  // has Claude Code installed, a bare CI runner does not. Assert the pairing
  // rather than a fixed verdict, so the probe is honest on both.
  const agent = seen.items[0];
  check(agent.done ? /found/.test(agent.detail) : seen.commands.length > 0,
    agent.done
      ? 'a resolved agent reports that it was found'
      : 'an unresolved agent offers at least one install command to copy',
    { done: agent.done, detail: agent.detail, commands: seen.commands });
  check(new Set(seen.commands).size === seen.commands.length,
    'install commands are deduplicated, so the shared claude binary is offered once', seen.commands);

  await page.screenshot({ path: path.join(OUT, 'first-run-dark.png') });
  console.log(`\n  capture: ${path.relative(REPO, path.join(OUT, 'first-run-dark.png'))}`);
  console.log('\n  observed:\n' + seen.text.split('\n').map((l) => '    ' + l).join('\n'));
} catch (error) {
  check(false, 'the first-run probe completed', error?.message ?? error);
} finally {
  await app.close();
  try { rmSync(udd, { recursive: true, force: true }); } catch { /* a temp dir the OS will reap */ }
}

console.log(failures === 0 ? '\n════ first-run probe passed ════' : `\n════ ${failures} failed ════`);
process.exit(failures === 0 ? 0 : 1);
