#!/usr/bin/env node
// Sessions · code rail · review notes: comments on diff lines, put into the
// session's message box for the operator to send. Actual renderer, isolated
// Electron, synthetic code and sessions, no real agent calls.
//
//   npm run build && node scripts/probe-review-notes.mjs [--before] [--out dir]
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), { _electron } = require('playwright-core');
const root = path.resolve(import.meta.dirname, '..'), before = process.argv.includes('--before');
const outArg = process.argv.indexOf('--out');
const out = outArg >= 0 ? path.resolve(process.argv[outArg + 1])
  : path.join(root, 'docs/visuals/review-notes', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-review-notes-'));
writeFileSync(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({
  executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [path.join(dir, 'main.cjs'), `--user-data-dir=${dir}/profile`], env,
});
const checks = [], errors = [];
const record = (text) => { checks.push(text); console.log('✓', text); };
const PATCH = 'diff --git a/src/checkout.ts b/src/checkout.ts\n--- a/src/checkout.ts\n+++ b/src/checkout.ts\n@@ -1,3 +1,5 @@\n-export function checkout() {\n+export function checkout(key: string) {\n+  const existing = payments.get(key);\n+  if (existing) return existing;\n   return payments.create();\n }\n';
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(STUB);
  await page.addInitScript((patch) => {
    localStorage.setItem('wanigan.code', '1'); localStorage.setItem('wanigan.composer', '1');
    const api = window.wanigan; window.__writes = [];
    window.wanigan = new Proxy(api, { get(target, service) {
      if (service === 'code') return new Proxy(target.code, { get(obj, key) {
        if (key === 'changes') return async () => ({ isRepo: true, branch: 'feature/checkout', headMoved: false, commits: 0,
          files: [{ path: 'src/checkout.ts', index: ' ', work: 'M', staged: false, untracked: false, preexisting: false }] });
        if (key === 'diff') return async () => patch;
        if (key === 'editors') return async () => [];
        return obj[key];
      } });
      if (service === 'sessions') return new Proxy(target.sessions, { get(obj, key) {
        if (key === 'baseline') return async () => ({ head: '1a2b3c4d5e6f7a8b', files: [] });
        if (key === 'scrollback') return async () => 'Wanigan renderer fixture — no live provider\r\n\r\n> Make checkout retries safe.\r\n';
        if (key === 'write') return async (...args) => { window.__writes.push(args); };
        return obj[key];
      } });
      return target[service];
    } });
  }, PATCH);

  const shoot = async (name) => {
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(out, `${name}-${theme}.png`), scale: 'css' });
    }
  };
  await page.goto(rendererURL); await page.locator('.mission-room').waitFor();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Meta+1');
  await page.locator('.sessions-view').waitFor();
  await page.locator('.terminal-host:visible').waitFor();
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  await page.locator('.code-file').filter({ hasText: 'src/checkout.ts' }).click();
  await page.locator('pre.diff').waitFor();

  if (before) {
    assert.equal(await page.locator('.review-diff').count(), 0);
    await shoot('diff');
    record('before: the code rail shows the diff as read-only lines, with no way to comment on one');
  } else {
    const draft = page.getByRole('textbox', { name: 'Message the agent', exact: true });
    await draft.fill('Before you merge:');
    const line = (text) => page.locator('.review-diff .dl').filter({ hasText: text }).first();
    await line('export function checkout(key: string)').click();
    await line('if (existing) return existing;').click({ modifiers: ['Shift'] });
    const compose = page.locator('.review-compose');
    await compose.waitFor();
    assert.equal(await compose.locator('.review-compose-where').innerText(), 'src/checkout.ts · 3 lines selected');
    assert.equal(await page.locator('.review-diff .dl.review-sel').count(), 3);
    await compose.getByRole('textbox', { name: 'Review note for the selected lines' }).fill('Return the stored payment only when the amount matches.');
    await shoot('selection');
    await compose.getByRole('button', { name: 'Add note', exact: true }).click();
    const tray = page.getByRole('region', { name: 'Review notes' });
    await tray.waitFor();
    const trayText = (await tray.innerText()).replace(/\s+/g, ' ');
    assert.match(trayText, /1 review note on your uncommitted changes against 1a2b3c4d, the commit this session started from/);
    assert.match(trayText, /src\/checkout\.ts, lines 1–3: Return the stored payment only when the amount matches\./);
    assert.equal(await page.locator('.review-diff .dl.review-noted').count(), 3);
    record('click and shift-click select three added lines; the note is anchored to new lines 1–3 against the session’s base commit, and the noted lines stay marked');

    await page.getByRole('button', { name: 'Comment on this hunk', exact: true }).focus();
    await page.keyboard.press('Enter');
    await compose.waitFor();
    assert.equal(await compose.locator('.review-compose-where').innerText(), 'src/checkout.ts · 6 lines selected');
    const box = compose.getByRole('textbox', { name: 'Review note for the selected lines' });
    await box.fill('Add a regression test for a retried checkout.');
    await box.press('Meta+Enter');
    await compose.waitFor({ state: 'detached' });
    assert.match((await tray.innerText()).replace(/\s+/g, ' '), /2 review notes/);
    assert.match((await tray.innerText()).replace(/\s+/g, ' '), /src\/checkout\.ts, lines 1–5 \(was lines 1–3\): Add a regression test/);
    record('the keyboard route selects the whole hunk from its header button and adds with ⌘↩, and the removed line counts on the old side');
    await shoot('tray');

    await tray.getByRole('button', { name: 'Add to message', exact: true }).click();
    await tray.waitFor({ state: 'detached' });
    const value = await draft.inputValue();
    assert.equal(value, [
      'Before you merge:',
      '',
      'Review notes on your uncommitted changes against 1a2b3c4d, the commit this session started from.',
      'Address each one, or reply saying why you are leaving it as it is.',
      '',
      '1. `src/checkout.ts`, lines 1–3:',
      '   ```diff',
      '   +export function checkout(key: string) {',
      '   +  const existing = payments.get(key);',
      '   +  if (existing) return existing;',
      '   ```',
      '   Return the stored payment only when the amount matches.',
      '',
      '2. `src/checkout.ts`, lines 1–5 (was lines 1–3):',
      '   ```diff',
      '   -export function checkout() {',
      '   +export function checkout(key: string) {',
      '   +  const existing = payments.get(key);',
      '   +  if (existing) return existing;',
      '      return payments.create();',
      '    }',
      '   ```',
      '   Add a regression test for a retried checkout.',
    ].join('\n'));
    assert.deepEqual(await page.evaluate(() => window.__writes), [], 'nothing was typed into the terminal');
    await page.getByText(/Added 2 notes to the message box\. Read them there, then send or queue\./).first().waitFor();
    assert.equal(await page.locator('.review-diff .dl.review-noted').count(), 0);
    record('Add to message puts both notes under the existing draft, in the anchored format, and sends nothing to the terminal');
    await shoot('message');
  }
  assert.deepEqual(errors, []);
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({
    at: new Date().toISOString(),
    provenance: 'Actual Electron renderer from out/renderer of the checkout this script ran in; synthetic code, sessions and services; no real agent calls',
    mode: before ? 'before' : 'after', checks, errors,
  }, null, 2) + '\n');
} finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
