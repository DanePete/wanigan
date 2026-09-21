#!/usr/bin/env node
// Isolated production renderer with fictional records; no live providers or agent processes.
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'package.json'));
const { _electron } = require('playwright-core');
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-dock-'));
const outAt = process.argv.indexOf('--out');
if (outAt >= 0 && (!process.argv[outAt + 1] || process.argv[outAt + 1].startsWith('--'))) throw new Error('--out requires a directory.');
const out = outAt >= 0 ? path.resolve(process.argv[outAt + 1]) : path.join(root, 'docs/visuals/dock-ui-audit-2026-09-19/navigation');
mkdirSync(out, { recursive: true });
writeFileSync(path.join(dir, 'main.cjs'), "const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(dir, 'main.cjs'), `--user-data-dir=${dir}/profile`], env });
const checks = [], screenshots = [], errors = [];
const report = { provenance: 'Production renderer in an isolated Electron profile with the explicitly fictional renderer-harness STUB. No provider requests, real records, PTYs, or model calls.', checks, screenshots, errors };
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(STUB + `
    (() => {
      localStorage.setItem('wanigan.navigation.visible', 'closed');
      window.__dockNavPref = 'closed';
      const base = window.wanigan;
      window.__dockHaltPulls = 0;
      const prefs = new Proxy(base.prefs, { get(target, key) {
        if (key === 'all') return async () => ({ ...(await base.prefs.all()), motion: 'off', navSidebar: window.__dockNavPref });
        if (key === 'set') return async (name, value) => { if (name === 'nav_sidebar') window.__dockNavPref = value; return base.prefs.set(name, value); };
        return target[key];
      } });
      const halt = new Proxy(base.halt, { get(target, key) {
        if (key === 'pull') return async () => { window.__dockHaltPulls += 1; throw new Error('Probe refuses to execute halt'); };
        return target[key];
      } });
      window.wanigan = new Proxy(base, { get(target, key) { return key === 'prefs' ? prefs : key === 'halt' ? halt : target[key]; } });
    })();
  `);
  await page.goto(rendererURL);
  const dock = page.getByRole('navigation', { name: 'Workspace dock', exact: true });
  await dock.waitFor();
  assert.equal(await page.locator('.workbench-navigation').count(), 0);
  await dock.getByRole('button', { name: 'Monitor', exact: true }).click();
  await page.locator('.space-routes button[data-nav-tab="usage"]').click();
  await page.locator('.space-routes button[data-nav-tab="usage"][aria-current="page"]').waitFor();
  await dock.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await dock.getByRole('button', { name: 'Monitor', exact: true }).click();
  await page.locator('.space-routes button[data-nav-tab="usage"][aria-current="page"]').waitFor();
  checks.push('Dock is present with navigation hidden and returning to Monitor restores Usage.');

  const buttons = dock.getByRole('button');
  await buttons.first().focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Work');
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'All destinations');
  await page.keyboard.press('Home');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Home');
  checks.push('Left/right, Home and End move keyboard focus through the dock.');

  await dock.getByRole('button', { name: 'All destinations', exact: true }).click();
  await page.locator('.workbench-navigation').waitFor();
  const nav = page.getByRole('navigation', { name: 'Workspace navigation', exact: true });
  await nav.getByRole('button', { name: 'Expand Manage', exact: true }).click();
  await nav.getByRole('button', { name: 'Extensions', exact: true }).click();
  await page.locator('.space-routes button[data-nav-tab="extensions"][aria-current="page"]').waitFor();
  await dock.getByRole('button', { name: 'All destinations', exact: true }).click();
  await page.locator('.workbench-navigation').waitFor({ state: 'detached' });
  await page.locator('.space-settings').click();
  await page.locator('.space-routes button[data-nav-tab="settings"][aria-current="page"]').waitFor();
  await dock.getByRole('button', { name: 'Monitor', exact: true }).click();
  checks.push('All destinations reaches Extensions and the footer Settings control opens Settings.');

  await dock.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: /^Switch project space:/ }).click();
  await page.getByRole('combobox', { name: 'Search project spaces', exact: true }).fill('platform');
  await page.keyboard.press('Enter');
  assert.match(await page.locator('.space-switch-trigger').innerText(), /platform/);
  await dock.getByRole('button', { name: 'Monitor', exact: true }).click();
  assert.equal(await page.locator('.space-switch-trigger').count(), 0);
  assert.match(await page.locator('.workbench-scope').innerText(), /Across all projects/);
  checks.push('Project picker filters by keyboard; global Monitor scope is explicit and has no misleading project filter.');

  await dock.getByRole('button', { name: 'Work', exact: true }).click();
  await page.locator('.space-routes button[data-nav-tab="git"]').click();
  await page.getByRole('button', { name: /^Switch project space:/ }).click();
  const allSpaces = page.getByRole('option').filter({ hasText: 'All spaces' });
  assert.match(await allSpaces.innerText(), /Open Sessions across all projects/);
  await page.getByRole('combobox', { name: 'Search project spaces', exact: true }).fill('All spaces');
  await page.keyboard.press('Enter');
  await page.locator('.space-routes button[data-nav-tab="sessions"][aria-current="page"]').waitFor();
  assert.match(await page.locator('.space-switch-trigger').innerText(), /All spaces/);
  await dock.getByRole('button', { name: 'Monitor', exact: true }).click();
  checks.push('Project-required Changes explains that All spaces opens Sessions; keyboard activation follows that route.');

  await page.locator('.nav-views-button').click();
  await page.getByRole('combobox', { name: 'Search views, projects, live sessions, settings and archived transcripts', exact: true }).fill('Extensions');
  await page.locator('.command-item').filter({ hasText: 'Extensions' }).first().waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.nav-views-button').evaluate(element => element === document.activeElement), true);
  checks.push('Adminbar Search opens the shared palette and Escape restores focus.');

  for (const [width, height] of [[1440, 1000], [1180, 800], [960, 560], [900, 700], [900, 560], [720, 560], [600, 640], [460, 640]]) {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(width => innerWidth === width, width);
    const geometry = await page.evaluate(() => {
      const rect = selector => { const { x, y, right, bottom, width, height } = document.querySelector(selector).getBoundingClientRect(); return { x, y, right, bottom, width, height }; };
      const controls = [...document.querySelectorAll('.app-header button')].filter(element => element.getClientRects().length).map(element => ({ label: element.getAttribute('aria-label'), left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right }));
      return { viewport: { width: innerWidth, height: innerHeight }, doc: { client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }, dock: rect('.space-dock'), body: rect('.body'), footer: rect('.space-foot'), controls };
    });
    assert.ok(geometry.doc.scroll <= geometry.doc.client, JSON.stringify(geometry));
    assert.ok(geometry.dock.x >= 0 && geometry.dock.right <= width, JSON.stringify(geometry));
    assert.ok(geometry.body.bottom <= geometry.footer.y + 1, JSON.stringify(geometry));
    assert.ok(geometry.footer.bottom <= height + 1, JSON.stringify(geometry));
    assert.ok(geometry.footer.height <= (height <= 650 ? 56 : 64), JSON.stringify(geometry));
    assert.ok(geometry.controls.every(control => control.left >= 0 && control.right <= width + 1), JSON.stringify(geometry));
    checks.push({ width, height, geometry });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      const file = `usage-dock-${width}x${height}-${theme}.png`;
      await page.screenshot({ path: path.join(out, file), scale: 'css', animations: 'disabled' });
      screenshots.push(file);
    }
  }
  await page.setViewportSize({ width: 720, height: 560 });
  await dock.getByRole('button', { name: 'All destinations', exact: true }).click();
  await page.getByRole('dialog', { name: 'Workspace navigation', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Workspace navigation', exact: true }).waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'All destinations');
  checks.push('At 720px the temporary navigation dialog closes with Escape and returns focus to the dock trigger.');
  await page.locator('.hdr-halt').click();
  await page.getByRole('button', { name: 'Confirm: stop every agent, schedule and queue', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__dockHaltPulls), 0);
  await page.getByRole('button', { name: 'Halt: stop every agent, schedule and queue', exact: true }).waitFor({ timeout: 7000 });
  assert.equal(await page.evaluate(() => window.__dockHaltPulls), 0);
  checks.push('Halt first click only arms confirmation, expires after six seconds, and never calls halt.pull.');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(report, null, 2));
} finally {
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify(report, null, 2));
  await app.close();
}
