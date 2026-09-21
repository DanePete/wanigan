#!/usr/bin/env node
// Actual renderer, fictional diff/session: no PTY writes, no provider calls.
// Run after npm run build. --before captures the same keyboard assertion red.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openRenderer } from './renderer-harness.mjs';

const before = process.argv.includes('--before');
const out = path.resolve('docs/visuals/review-keyboard-2026-09-19', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const patch = 'diff --git a/src/checkout.ts b/src/checkout.ts\n--- a/src/checkout.ts\n+++ b/src/checkout.ts\n@@ -1,3 +1,5 @@\n-export function checkout() {\n+export function checkout(key: string) {\n+  const existing = payments.get(key);\n+  if (existing) return existing;\n   return payments.create();\n }\n';
const errors = [], checks = [];
const { page, close } = await openRenderer({ width: 1440, height: 960,
  onError: message => { if (!/WebGPU/.test(message)) errors.push(message); },
  instrument: `(() => {
    localStorage.setItem('wanigan.code', '1'); localStorage.setItem('wanigan.composer', '1');
    const api = window.wanigan; window.__writes = [];
    window.wanigan = new Proxy(api, { get(target, service) {
      if (service === 'code') return new Proxy(target.code, { get(obj, key) {
        if (key === 'changes') return async () => ({ isRepo: true, branch: 'feature/checkout', headMoved: false, commits: 0,
          files: [{ path: 'src/checkout.ts', index: ' ', work: 'M', staged: false, untracked: false, preexisting: false }] });
        if (key === 'diff') return async () => ${JSON.stringify(patch)};
        if (key === 'editors') return async () => [];
        return obj[key];
      } });
      if (service === 'sessions') return new Proxy(target.sessions, { get(obj, key) {
        if (key === 'baseline') return async () => ({ head: '1a2b3c4d5e6f7a8b', files: [] });
        if (key === 'scrollback') return async () => 'Fictional keyboard review fixture. No live provider.\\r\\n';
        if (key === 'write') return async (...args) => { window.__writes.push(args); };
        return obj[key];
      } });
      return target[service];
    } });
  })();` });
let geometry, failure;
async function shots(name) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
      document.documentElement.dataset.motion = 'off';
    }, theme);
    await page.screenshot({ path: path.join(out, `${name}-${theme}.png`), scale: 'css', animations: 'disabled' });
  }
}
try {
  page.setDefaultTimeout(10000);
  await page.keyboard.press('Meta+1');
  await page.locator('.sessions-view').waitFor();
  await page.getByRole('group', { name: 'Session details', exact: true }).getByRole('button', { name: 'Changes', exact: true }).click();
  await page.locator('.code-file').filter({ hasText: 'src/checkout.ts' }).click();
  await page.locator('.review-diff').waitFor();
  geometry = await page.locator('.review-diff .dl.add, .review-diff .dl.del, .review-diff .dl.ctx').evaluateAll(rows => rows.map(row => ({
    tag: row.tagName, height: row.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(row).lineHeight),
  })));
  await shots('diff');
  await page.getByRole('button', { name: 'Comment on this hunk', exact: true }).focus();
  await page.keyboard.press('Tab');
  assert(await page.locator('.review-diff .dl.del').evaluate(row => row === document.activeElement),
    'Tab from the hunk action must reach the first commentable diff line');
  checks.push('Tab reaches individual diff lines.');
  await shots('line-focus');
  await page.keyboard.press('Enter');
  const compose = page.locator('.review-compose');
  await compose.waitFor();
  assert.equal(await compose.locator('.review-compose-where').innerText(), 'src/checkout.ts · 1 line selected');
  assert.equal(await page.locator('.review-diff .dl.del').getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('Escape');
  await compose.waitFor({ state: 'detached' });
  checks.push('Enter selects one removed line; Escape cancels.');
  await page.getByRole('button', { name: 'Comment on this hunk', exact: true }).focus();
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  await page.keyboard.press('Space');
  await compose.waitFor();
  assert.equal(await compose.locator('.review-compose-where').innerText(), 'src/checkout.ts · 1 line selected');
  // The note box follows all diff rows: move backwards to the third added line.
  await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '+  if (existing) return existing;');
  await page.keyboard.press('Shift+Enter');
  assert.equal(await compose.locator('.review-compose-where').innerText(), 'src/checkout.ts · 3 lines selected');
  assert.equal(await page.locator('.review-diff .dl[aria-pressed="true"]').count(), 3);
  checks.push('Space selects an added line; Shift+Enter extends to exactly three added lines.');
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Space');
  assert.equal(await page.locator('.review-diff .dl[aria-pressed="true"]').count(), 5);
  await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Enter');
  assert.equal(await page.locator('.review-diff .dl[aria-pressed="true"]').count(), 3);
  checks.push('Shift+Space extends the same anchor through context lines; Shift+Enter contracts it.');
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Review note for the selected lines');
  await page.keyboard.type('Check the stored payment amount before returning it.');
  await page.keyboard.press('Meta+Enter');
  await compose.waitFor({ state: 'detached' });
  const tray = page.getByRole('region', { name: 'Review notes' });
  assert.match((await tray.innerText()).replace(/\s+/g, ' '), /src\/checkout\.ts, lines 1–3: Check the stored payment amount before returning it\./);
  assert.equal(await page.locator('.review-diff .dl.review-noted').count(), 3);
  assert.deepEqual(await page.evaluate(() => window.__writes), []);
  for (const row of geometry) assert(Math.abs(row.height - row.lineHeight) < 1, 'A selectable diff row keeps one-line height');
  checks.push('Keyboard note is anchored to lines 1–3; row layout unchanged; no terminal writes.');
  await shots('note');
  assert.deepEqual(errors, []);
  console.log('PASS: Tab, Enter, Space, Shift+Enter, Shift+Space, Escape and keyboard note creation preserve exact diff-line anchors');
} catch (error) {
  failure = error.message; throw error;
} finally {
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ fixture: true, before, geometry, checks, errors, failure }, null, 2) + '\n');
  await close();
}
