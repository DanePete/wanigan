#!/usr/bin/env node
// Showcase screenshots for posts and the README, taken from the real app on the
// real GPU: the calm demo (nothing waiting on the owner), its own throwaway
// data, 1440x900, both themes. Every shot is refused if any orb on screen is in
// his needs-you amber: public pictures of Wanigan show him clear.
//   node scripts/showcase.mjs --app "release/mac-arm64/Wanigan 2.app" [--out .artifacts/showcase]
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { _electron } from 'playwright-core';

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const packaged = resolve(arg('--app', 'release/mac-arm64/Wanigan 2.app'));
const out = resolve(arg('--out', '.artifacts/showcase'));
mkdirSync(out, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'wg-showcase-'));
const env = { ...process.env, WANIGAN_DATA_DIR: dataDir, WANIGAN_DEMO_SHOWCASE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
for (const k of Object.keys(env)) if (k.startsWith('VSCODE_')) delete env[k];

const app = await _electron.launch({ executablePath: join(packaged, 'Contents', 'MacOS', basename(packaged, '.app')), args: ['--demo'], env, timeout: 60_000 });
const failures = [];
try {
  const win = await app.firstWindow({ timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
  await win.waitForSelector('.rail', { timeout: 30_000 });
  // The demo seeds itself on its first start; wait for its projects.
  for (let i = 0; i < 120; i++) {
    const n = await win.evaluate(async () => (await window.wanigan.call('projects.list', {})).length).catch(() => 0);
    if (n >= 3) break;
    await win.waitForTimeout(500);
  }

  const shot = async (name, theme) => {
    await win.waitForTimeout(1200); // let the water settle into a frame
    const amber = await win.$$eval('.orb', (orbs) => orbs.filter((o) => o.classList.contains('orb-attention') && o.getBoundingClientRect().width > 0).length);
    if (amber) { failures.push(`${theme}/${name}: an orb is amber; not saved`); return; }
    // The app says it is the demo; the picture is of the product, and its caption says it is sample data.
    await win.evaluate(() => { const b = document.querySelector('.demo-banner'); if (b) b.style.display = 'none'; });
    await win.waitForTimeout(150);
    await win.screenshot({ path: join(out, `${name}-${theme}.png`) });
    await win.evaluate(() => { const b = document.querySelector('.demo-banner'); if (b) b.style.display = ''; });
  };
  const go = async (hash, ready) => {
    await win.evaluate((h) => { window.location.hash = h; }, hash);
    await win.waitForSelector(ready, { timeout: 15_000 }).catch(() => failures.push(`never showed ${ready} at ${hash}`));
  };

  for (const theme of ['dark', 'light']) {
    await win.evaluate((t) => { localStorage.setItem('wanigan.theme', t); }, theme);
    await win.reload();
    await win.waitForSelector('.rail');
    await win.waitForSelector(`html[data-theme="${theme}"]`, { timeout: 5_000 }).catch(() => {});

    await go('#/p/NS/board', '.card');
    await shot('board', theme);
    await go('#/p/NS/board?card=NS-6', '.drawer .stages');
    await shot('card', theme);
    await go('#/p/NS/board', '.card');
    await win.click('.how-btn');
    await win.waitForSelector('.how-flow .how-box');
    await shot('how-it-works', theme);
    await win.keyboard.press('Escape');
    await go('#/needs', '.needs-headline');
    await shot('needs', theme);
    await go('#/p/NS/history', '.hrow');
    await shot('history', theme);
    const session = await win.evaluate(async () => {
      const list = await window.wanigan.call('sessions.list', { live: true });
      return list.find((s) => s.provider === 'claude' && s.cardKey === 'NS-6')?.id ?? null;
    });
    if (session) {
      await go(`#/p/NS/s/${session}`, '.xterm-rows');
      await shot('session', theme);
    }
    // A card's turns: the last one's diff, laid over its terminal.
    const stock = await win.evaluate(async () => (await window.wanigan.call('sessions.list', { live: true })).find((s) => s.title?.startsWith('Low-stock badge'))?.id ?? null);
    if (stock) {
      await go(`#/p/NS/s/${stock}`, '.turn-change .turn-diff');
      await win.click('.turn-change .turn-diff');
      await win.waitForSelector('.turn-panel .dl-add', { timeout: 10_000 }).catch(() => failures.push('the turn diff never showed'));
      await win.click('.turn-panel .changes-files button:has(.fname:text-is("LowStockBadge.tsx"))').catch(() => {});
      await win.waitForSelector('.turn-panel .dl-del', { timeout: 10_000 }).catch(() => {});
      await shot('turn-diff', theme);
      await win.keyboard.press('Escape');
    } else failures.push('no session with turns in the demo');
    await go('#/p/NS/changes', '.dl-add');
    await shot('changes', theme);
    await win.click('.changes .toolbar [role="radio"]:has-text("Split")');
    await win.waitForSelector('.diff-split', { timeout: 5_000 }).catch(() => failures.push('split never showed'));
    await shot('changes-split', theme);
    await win.click('.changes .toolbar [role="radio"]:has-text("Unified")');

    // Git: lines picked for staging, the commit box stopping a key, the history, branches,
    // the push confirmation and a merge being resolved. Nothing here is committed or pushed.
    const css = '.diff-slot[data-key="changed:web/modules/custom/northstar_checkout/css/pay-button.css"]';
    await win.click('.git-file[data-key$="pay-button.css"] .git-file-main');
    await win.waitForSelector(`${css} .dl-pick-box`, { timeout: 10_000 }).catch(() => failures.push('the CSS diff never offered lines to pick'));
    const boxes = await win.$$(`${css} .dl-add .dl-pick-box`);
    await boxes[1]?.click();
    await boxes[2]?.click({ modifiers: ['Shift'] });
    await shot('git-stage', theme);
    await win.click(`${css} .pick-bar button:has-text("Clear")`).catch(() => {});
    await win.fill('.commit-subject input', 'Give the pay button an accessible name');
    await win.click('.commit-go');
    await win.click('.dialog button:has-text("Commit anyway")').catch(() => {});
    await win.waitForSelector('.secret-findings', { timeout: 10_000 }).catch(() => failures.push('the commit scan never showed its finding'));
    await shot('git-commit-secret', theme);
    await win.click('.remote-actions button:has-text("Push")');
    await win.waitForSelector('.dialog .push-commits li', { timeout: 10_000 }).catch(() => failures.push('the push confirmation listed no commits'));
    await shot('git-push', theme);
    await win.keyboard.press('Escape');
    await go('#/p/NS/changes/commits', '.commit-row .graph');
    await win.click('.commits-toolbar [role="radio"]:has-text("All branches")').catch(() => {});
    await win.waitForSelector('.commit-view .dl-add', { timeout: 10_000 }).catch(() => {});
    await shot('git-history', theme);
    await go('#/p/NS/changes/branches', '.branch-row');
    await shot('git-branches', theme);
    await go('#/p/NS/changes?branch=NS-13', '.resolver-hunk .side-theirs .dl-text');
    const hunks = win.locator('.resolver-hunk');
    await hunks.nth(0).locator('[role="radio"]:text-is("Both, ours first")').click().catch(() => failures.push('no conflict to resolve'));
    await hunks.nth(1).locator('[role="radio"]:text-is("Ours")').click().catch(() => {});
    await win.check('.resolver-toggle:has-text("Show what both sides came from") input').catch(() => {});
    await hunks.nth(0).evaluate((el) => el.closest('.diff-slot')?.scrollIntoView({ block: 'start' })).catch(() => {});
    await shot('git-resolve', theme);

    // Watch: the live sessions side by side.
    await go('#/running', '.srow');
    await win.click('.topbar [role="radio"]:has-text("Watch")');
    await win.waitForSelector('.watch-tile .xterm-rows', { timeout: 10_000 }).catch(() => failures.push('Watch never drew a tile'));
    await win.waitForTimeout(800);
    await shot('watch', theme);
    await win.click('.topbar [role="radio"]:has-text("List")');
    // Search: what the agents said, from ⌘K.
    await go('#/p/NS/board', '.card');
    await win.keyboard.press('Meta+k');
    await win.waitForSelector('.palette-input input');
    await win.fill('.palette-input input', 'pay button');
    await win.waitForSelector('.palette-said mark', { timeout: 8_000 }).catch(() => failures.push('search found nothing said'));
    await shot('search', theme);
    await win.keyboard.press('Escape');
    await go('#/settings', '#set-jev');
    await shot('settings', theme);
    await go('#/skills', '.prose h3');
    await shot('skills', theme);
    await go('#/mcp', '.mcp-row');
    await shot('mcp', theme);
    await go('#/p/NS/board', '.card');
    await win.click('.chat-fab');
    await win.waitForSelector('.chat textarea');
    if (!(await win.$('.chat .chat-a'))) {
      await win.keyboard.type('What is everyone working on?');
      await win.keyboard.press('Enter');
      await win.waitForSelector('.chat .chat-a', { timeout: 15_000 }).catch(() => failures.push('the chat never answered'));
    }
    await shot('chat', theme);
    await win.keyboard.press('Escape');
  }
} finally {
  await app.close().catch(() => {});
  // The demo's core would end on its own a minute after its window; end it now, then remove its data.
  try {
    const { pid } = JSON.parse(readFileSync(join(dataDir, 'core.json'), 'utf8'));
    process.kill(pid, 'SIGTERM');
  } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 2500));
  rmSync(dataDir, { recursive: true, force: true });
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
console.log(`showcase screenshots in ${out}`);
