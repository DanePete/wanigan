#!/usr/bin/env node
// Settings › Projects & safety: the sandbox choice and the Trusted level's one
// exception. Actual renderer, isolated Electron, synthetic services.
//
//   npm run build && node scripts/probe-sandbox.mjs [--before] [--out dir]
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), { _electron } = require('playwright-core');
const root = path.resolve(import.meta.dirname, '..'), before = process.argv.includes('--before');
const outArg = process.argv.indexOf('--out');
const out = outArg >= 0 ? path.resolve(process.argv[outArg + 1]) : path.join(root, 'docs/visuals/sandbox', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-sandbox-'));
writeFileSync(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({
  executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [path.join(dir, 'main.cjs'), `--user-data-dir=${dir}/profile`], env,
});
const checks = [], errors = [];
const record = (text) => { checks.push(text); console.log('✓', text); };
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(STUB);
  await page.addInitScript(() => {
    const original = window.wanigan;
    window.__prefSets = [];
    let prefs = null;
    window.wanigan = new Proxy(original, { get(target, service) {
      if (service === 'prefs') return new Proxy(target.prefs, { get(api, method) {
        if (method === 'all') return async () => (prefs ??= { ...(await original.prefs.all()), sandboxShell: 'off' });
        if (method === 'set') return async (key, value) => { window.__prefSets.push([key, value]); prefs = { ...(prefs ?? await original.prefs.all()), ...(key === 'sandbox_shell' ? { sandboxShell: value } : {}) }; return prefs; };
        return api[method];
      } });
      if (service === 'policy') return new Proxy(target.policy, { get(api, method) {
        if (method === 'defaultTrust') return async () => 'project';
        if (method === 'trust') return async () => 'project';
        if (method === 'ledger') return async () => [];
        if (method === 'summary') return async () => ({ denied: 0, asked: 0, allowed: 0, since: null });
        return api[method];
      } });
      return target[service];
    } });
  });
  const shoot = async (name) => {
    for (const t of ['dark', 'light']) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; }, t);
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(out, `${name}-${t}.png`), scale: 'css' });
    }
  };
  await page.goto(rendererURL); await page.locator('.mission-room').waitFor();
  await page.locator('.space-dock button').first().focus();
  await page.keyboard.press('Meta+,');
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await page.locator('#settings-tab-projects').click();
  await page.locator('#settings-projects').waitFor({ state: 'visible' });
  const trusted = page.getByRole('radio', { name: /Trusted/ }).first();
  await trusted.waitFor();
  const trustedText = (await trusted.innerText()).replace(/\s+/g, ' ');
  const section = page.locator('[data-section-title="Sandbox shell commands"]');
  if (before) {
    assert.equal(await section.count(), 0);
    assert.match(trustedText, /Nothing is denied by Wanigan\. The OS sandbox/);
    await trusted.scrollIntoViewIfNeeded();
    await shoot('trust');
    record('before: Trusted says nothing is denied and names an OS sandbox Wanigan never configured; there is no sandbox choice');
  } else {
    assert.match(trustedText, /Nothing is denied by Wanigan except reading other sessions’ Wanigan credentials/);
    await section.scrollIntoViewIfNeeded();
    const text = (await section.innerText()).replace(/\s+/g, ' ');
    assert.match(text, /does not confine the file tools, MCP servers or hooks, and it has been escaped before/);
    assert.match(text, /exits at launch and says why, rather than running its commands unsandboxed/);
    assert.equal(await section.getByRole('radio', { name: /^Off/ }).getAttribute('aria-checked'), 'true');
    await section.getByRole('radio', { name: /^Below Trusted/ }).click();
    await page.waitForFunction(() => window.__prefSets.some((entry) => entry[0] === 'sandbox_shell' && entry[1] === 'below-trusted'));
    assert.equal(await section.getByRole('radio', { name: /^Below Trusted/ }).getAttribute('aria-checked'), 'true');
    await shoot('sandbox');
    await trusted.scrollIntoViewIfNeeded();
    await shoot('trust');
    record('the sandbox choice is off by default, says what it confines and what it does not before the choice, and stores below-trusted when picked; Trusted names its one exception');
  }
  assert.deepEqual(errors, []);
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({
    at: new Date().toISOString(),
    provenance: 'Actual Electron renderer from out/renderer of the checkout this script ran in; synthetic services; no real agent calls',
    mode: before ? 'before' : 'after', checks, errors,
  }, null, 2) + '\n');
} finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
