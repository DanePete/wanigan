#!/usr/bin/env node
// Isolated renderer behavior, with fictional records and no real agent processes.
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { _electron } = require('playwright-core');
const out = path.join(root, 'docs/visuals/workbench-2026-09-15/navigation');
mkdirSync(out, { recursive: true });
const baselinePath = path.join(root, 'docs/visuals/ux-audit-2026-09-15/probes/verification.json');
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const beforeScope = baseline.probes.find(probe => probe.id === 'project-return');
const beforeKeyboard = baseline.probes.find(probe => probe.id === 'sidebar-focus-escape');
const beforeSearch = baseline.probes.find(probe => probe.id === 'palette-identity');
const baselineFailures = {
  projectReturn: beforeScope.returnedProjects.route !== beforeScope.beforeFleet.route,
  navigationEscape: beforeKeyboard.sidebarAfterEscape.visible,
  changesSearch: beforeSearch.changesResults.length === 0,
  renamedSessionSearch: beforeSearch.renamedResults.length === 0,
};
assert.ok(Object.values(baselineFailures).every(Boolean), 'the original audit reproduces all four navigation defects');
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-workbench-navigation-'));
writeFileSync(path.join(dir, 'main.cjs'), "const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(dir, 'main.cjs'), `--user-data-dir=${dir}/profile`], env });
const checks = [], screenshots = [], errors = [];
const report = {
  provenance: 'Production renderer, isolated Electron profile, explicitly fictional STUB bridge. No real providers, PTYs, user-data reads, repository writes or model calls.',
  baselinePath, baselineFailures, checks, screenshots, errors,
  buildIndexSha256: crypto.createHash('sha256').update(readFileSync(path.join(root, 'out/renderer/index.html'))).digest('hex'),
};
let page;
try {
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(STUB + `
    (() => {
      localStorage.setItem('wanigan.composer', '1');
      window.__navSessionName = 'AuroraQuantumFox';
      window.__navWrites = [];
      const base = window.wanigan;
      const proxy = (target, changes) => new Proxy(target, { get(t, p) { return p in changes ? changes[p] : t[p]; } });
      window.wanigan = proxy(base, {
        sessions: proxy(base.sessions, {
          list: async () => (await base.sessions.list()).map(session => ({ ...session,
            displayTitle: session.id === 's1' ? window.__navSessionName : null,
            projectPath: session.projectId === 'p1' ? '/example/storefront' : '/example/platform',
            harnessId: session.providerId === 'claude' ? 'claude-code' : 'codex', capabilities: { hooks: false },
          })),
          baseline: async () => ({ head: 'abc123', dirty: [], at: Date.now() }),
          buffer: async () => '', scrollback: async () => 'Fictional navigation fixture. No live terminal.\\r\\n',
          write: async (...args) => window.__navWrites.push(args),
        }),
        policy: proxy(base.policy, { trust: async () => 'project' }),
        transcripts: proxy(base.transcripts, { search: async () => [] }),
        handoff: proxy(base.handoff, { plan: async () => ({ targets: [] }) }),
        prefs: proxy(base.prefs, { all: async () => ({ ...(await base.prefs.all()), motion: 'off', navSidebar: 'closed' }) }),
      });
    })();
  `);
  await page.goto(rendererURL);
  await page.locator('.home-room').waitFor();
  const nav = () => page.getByRole('navigation', { name: 'Workspace navigation', exact: true });
  const route = () => page.locator('.workbench-location').textContent();
  const go = async key => { await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press(key); };
  const capture = async name => {
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      const file = `${name}-${theme}.png`;
      await page.screenshot({ path: path.join(out, file), scale: 'css', animations: 'disabled' });
      screenshots.push(file);
    }
  };
  const size = async (width, height) => {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(width => innerWidth === width, width);
  };
  const noHorizontalOverflow = async () => {
    const geometry = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    assert.equal(geometry.scroll <= geometry.client, true, JSON.stringify(geometry));
  };

  await page.getByRole('button', { name: /^Switch project space:/ }).click();
  await page.getByRole('option').filter({ hasText: 'storefront' }).click();
  await nav().getByRole('button', { name: 'Projects', exact: true }).click();
  await page.locator('.sessions-view').waitFor();
  await page.getByRole('navigation', { name: 'Projects views', exact: true }).getByRole('button', { name: 'Changes', exact: true }).click();
  await page.getByRole('heading', { name: 'Changes', exact: true }).waitFor();
  await nav().getByRole('button', { name: 'Fleet', exact: true }).click();
  assert.equal(await page.locator('.workbench-scope').textContent(), 'Across all projects');
  assert.equal(await page.getByRole('button', { name: /^Switch project space:/ }).count(), 0);
  await nav().getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('heading', { name: 'Changes', exact: true }).waitFor();
  assert.equal(await route(), 'Changes');
  assert.match(await page.locator('.space-switch-trigger').textContent(), /storefront/);
  checks.push('Changes → Fleet → Projects restores Changes and storefront; Fleet labels global scope explicitly');

  await page.getByRole('navigation', { name: 'Projects views', exact: true }).getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.locator('.terminal-host:visible .xterm').waitFor();
  const terminal = await page.locator('.terminal-host:visible .xterm').elementHandle();
  const composer = page.getByRole('textbox', { name: 'Message the agent', exact: true });
  await composer.fill('Navigation fixture draft, never sent.');
  await nav().getByRole('button', { name: 'Fleet', exact: true }).click();
  await nav().getByRole('button', { name: 'Projects', exact: true }).click();
  await composer.waitFor();
  assert.equal(await composer.inputValue(), 'Navigation fixture draft, never sent.');
  assert.equal(await terminal.evaluate(element => element.isConnected), true);
  await page.locator('.terminal-host:visible .xterm-helper-textarea').focus();
  await page.keyboard.press('Meta+2');
  assert.equal(await route(), 'Sessions');
  checks.push('Session draft and pooled xterm survive area round trip; terminal retains digit shortcut ownership');

  await go('Meta+k');
  const search = page.getByRole('combobox', { name: 'Search views, projects, live sessions, settings and archived transcripts', exact: true });
  await search.fill('Changes');
  assert.ok((await page.locator('.command-item').allTextContents()).some(text => text.includes('Changes')));
  await search.fill('AuroraQuantumFox');
  assert.ok((await page.locator('.command-item').allTextContents()).some(text => text.includes('AuroraQuantumFox')));
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.__navSessionName = 'Fresh Session Name'; window.dispatchEvent(new Event('focus')); });
  await go('Meta+k');
  await search.fill('Fresh Session Name');
  await page.locator('.command-item').filter({ hasText: 'Fresh Session Name' }).waitFor();
  await page.keyboard.press('Escape');
  checks.push('Changes and a displayed session title are searchable, including a name changed without a session-state transition');

  await page.getByRole('button', { name: /^Switch project space:/ }).click();
  await page.getByRole('option').filter({ hasText: 'The view across your projects' }).click();
  await nav().getByRole('button', { name: 'Fleet', exact: true }).click();
  await nav().getByRole('button', { name: 'Projects', exact: true }).click();
  assert.match(await page.locator('.space-switch-trigger').textContent(), /All (spaces|projects)/);
  checks.push('Explicit all-projects selection survives a global-area visit separately from remembered project identity');

  for (const [width, height] of [[1440, 1000], [1280, 900], [960, 560]]) {
    await size(width, height);
    await noHorizontalOverflow();
    assert.equal(await page.locator('.workbench-navigation').isVisible(), width > 980);
    await capture(`sessions-${width}x${height}`);
  }
  const opener = page.getByRole('button', { name: 'Open navigation (Option Command S)', exact: true });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Workspace navigation', exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.locator('.workbench-area-button[aria-current]').evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('ArrowDown');
  assert.equal(await route(), 'Sessions');
  await page.keyboard.press('Escape');
  assert.equal(await dialog.count(), 0);
  assert.equal(await opener.evaluate(element => element === document.activeElement), true);
  await opener.click();
  await capture('navigation-960x560');
  await nav().getByRole('button', { name: 'Automation', exact: true }).click();
  assert.equal(await dialog.count(), 0);
  assert.equal(await route(), 'Runs');
  assert.equal(await opener.evaluate(element => element === document.activeElement), true);
  checks.push('Compact navigation focuses current area, arrows focus without navigating, Escape restores opener, selecting Automation closes dialog');
  assert.deepEqual(errors, []);
  report.result = 'pass';
  console.log(JSON.stringify({ result: 'pass', checks, screenshots, baselineFailures, errors }, null, 2));
} catch (error) {
  report.result = 'fail'; report.failure = String(error.stack ?? error);
  if (page) await page.screenshot({ path: path.join(out, 'failure.png'), scale: 'css' }).catch(() => {});
  throw error;
} finally {
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  await app.close();
}
