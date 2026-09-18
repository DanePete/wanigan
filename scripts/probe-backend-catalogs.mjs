#!/usr/bin/env node
// Actual renderer in an isolated Electron window. Every service is a fixture;
// this probe never touches credentials, starts an agent or writes a preference.
//
// Screenshots the three provider-key sections in Settings — GLM Coding Plan,
// DeepSeek and Grok · xAI — in both themes, before and after each backend's
// model catalog moves from its own source file to a `catalog` block on its
// built-in pack. The sections sit on the Agents category (SETTINGS_INDEX files
// them there), so that is the tab this probe opens.
//
//   node scripts/probe-backend-catalogs.mjs --before   # the current build
//   node scripts/probe-backend-catalogs.mjs            # after the change
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), { _electron } = require('playwright-core');
const root = path.resolve(import.meta.dirname, '..'), before = process.argv.includes('--before');
const out = path.join(root, 'docs/visuals/backend-catalogs', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-backend-catalogs-'));
writeFileSync(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(dir, 'main.cjs'), `--user-data-dir=${dir}/profile`], env });
const errors = [], checks = [], calls = [];
const record = message => { checks.push(message); console.log(message); };
// The section title as Settings renders it, and the file name it is saved under.
const SECTIONS = [['GLM Coding Plan', 'glm'], ['DeepSeek', 'deepseek'], ['Grok · xAI', 'xai']];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(STUB);
  await page.addInitScript(() => {
    const original = window.wanigan;
    window.__keyCalls = [];
    // "No key stored" for every provider, so each section renders its paste
    // field and its verification sentence — the part of the panel this change
    // is about. Every key method that would write is recorded, never run.
    const overrides = {
      key: {
        status: async () => ({ present: false, fingerprint: null, encryptionAvailable: true, fromEnv: false, workspaceId: null }),
        provider: async id => { window.__keyCalls.push(['provider', id]); return { present: false, fingerprint: null, fromEnv: false, stored: false }; },
        setProvider: async (id) => { window.__keyCalls.push(['setProvider', id]); throw new Error('fixture: no credential is written'); },
        clearProvider: async (id) => { window.__keyCalls.push(['clearProvider', id]); return true; },
      },
      providerPacks: { list: async () => [], profiles: async () => [] },
      accounts: { list: async () => [] },
      settings: { get: async () => ({ spendCapUsd: 25 }) },
      demo: { state: async () => ({ on: false, source: 'live' }) },
      // The ledger card parses a real chain status; a proxy that answers
      // anything is not one. A refusal renders its "not checked" line instead.
      policy: { chain: async () => { throw new Error('fixture: the ledger is not checked in this probe'); } },
    };
    window.wanigan = new Proxy(original, { get(target, service) {
      if (!(service in overrides)) return target[service];
      return new Proxy(target[service], { get(api, method) { return overrides[service][method] ?? api[method]; } });
    } });
  });
  await page.goto(rendererURL);
  await page.waitForSelector('.mission-room');
  // The Settings area button, by its route rather than its chord: a keymap the
  // stubbed prefs cannot answer for must not decide whether this probe runs.
  await page.locator('button.workbench-area-button[data-nav-tab="settings"]').click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await page.locator('#settings-tab-agents').click();
  await page.locator('#settings-agents').waitFor({ state: 'visible' });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    for (const [title, slug] of SECTIONS) {
      const section = page.locator(`[data-section-title="${title}"]`);
      await section.scrollIntoViewIfNeeded();
      await section.getByRole('textbox').waitFor();
      await page.waitForTimeout(100);
      await section.screenshot({ path: path.join(out, `${slug}-${theme}.png`), scale: 'css' });
    }
    // One frame of the three together, so the after shot can show the panel
    // still reads as one family once its three branches are one path.
    await page.locator('[data-section-title="GLM Coding Plan"]').scrollIntoViewIfNeeded();
    await page.locator('#settings-agents').evaluate(el => { el.scrollTop = el.scrollTop - 24; });
    await page.waitForTimeout(100);
    await page.screenshot({ path: path.join(out, `agents-keys-${theme}.png`), scale: 'css' });
  }
  calls.push(...await page.evaluate(() => window.__keyCalls));
  assert.deepEqual(calls.filter(c => c[0] !== 'provider'), [], 'the probe wrote no credential');
  assert.deepEqual(errors, []);
  record(`three provider-key sections captured in both themes; key.provider asked for ${calls.map(c => c[1]).join(', ')}; nothing written`);
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ at: new Date().toISOString(), provenance: 'Actual Electron renderer; synthetic services; no production operations', checks, calls, errors }, null, 2) + '\n');
  console.log(JSON.stringify({ before, checks, errors }));
} finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
