#!/usr/bin/env node
// Screenshot the built renderer in plain Chromium, with the preload bridge
// stubbed out.
//
// scripts/shots.mjs is the real one: it drives the packaged Electron app over
// its own IPC, so what it captures is the product. Use that first. This exists
// because on some machines Playwright's _electron never sees a window — the
// process starts, the renderer never loads, and firstWindow() times out — and a
// shell change nobody can look at is a shell change nobody can review.
//
// What it proves: layout, type scale, palette, both themes, responsive
// behaviour, and that a view mounts without throwing.
// What it does NOT prove: anything about the main process, IPC, validation,
// PTYs or persistence. Every window.wanigan call here is answered by a stub, so
// a green run says nothing about whether the app works — only about how it
// looks. Never treat it as a substitute for `npm test`.
//
// Usage:
//   npm run build && node scripts/shots-browser.mjs [outDir] [--light] [--measure]
//
// --light   render in the light palette
// --measure print computed type sizes and page-head geometry instead of shots
//
// Requires playwright-core and its Chromium download (`npx playwright install
// chromium`). Serves over http rather than file://: the renderer ships a real
// Content-Security-Policy, and on a file:// origin `script-src 'self'` is
// opaque, so the bundle never runs and the page paints an empty #root.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openRenderer } from './renderer-harness.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const OUT = path.resolve(REPO, positional[0] ?? 'docs/shots-browser');
fs.mkdirSync(OUT, { recursive: true });

const MEASURE = process.argv.includes('--measure');

const { page, close } = await openRenderer({
  theme: process.argv.includes('--light') ? 'light' : 'dark',
  onError: (m) => console.log('[error]', m),
});

await page.screenshot({ path: path.join(OUT, 'shell.png') });
console.log('sidebar rows:', await page.locator('.sidebar .nav-tab').count());
console.log('groups:', await page.locator('.sidebar-group-label').allTextContents());
console.log('header height:', await page.locator('.app-header').evaluate((el) => el.getBoundingClientRect().height).catch(() => 'n/a'));
console.log('sidebar width:', await page.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().width).catch(() => 'n/a'));

if (MEASURE) {
  await page.locator('[data-nav-tab="control"]').click().catch(()=>{});
  await page.waitForTimeout(600);
  const info = await page.evaluate(() => {
    const px = (el) => el ? getComputedStyle(el).fontSize + ' / ' + getComputedStyle(el).fontWeight : 'missing';
    const head = document.querySelector('.pane > .pane-head');
    return {
      pageH1: px(document.querySelector('.pane-head h1')),
      eyebrow: px(document.querySelector('.pane-head .label-stencil')),
      headSticky: head ? getComputedStyle(head).position : 'none',
      headBorder: head ? getComputedStyle(head).borderBottomWidth + ' ' + getComputedStyle(head).borderBottomColor : 'none',
      cardTitles: [...document.querySelectorAll('.pane h2, .pane h3')].slice(0, 8).map((el) => el.textContent.trim().slice(0, 30) + '  →  ' + px(el)),
      body: px(document.body),
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close(); server.close(); process.exit(0);
}
// Every destination, in sidebar order, so a sweep is a sweep.
const ROUTES = ['sessions', 'fleet', 'control', 'batches', 'insights', 'usage', 'learning',
                'scout', 'skills', 'context', 'plugins', 'git', 'runs', 'schedules', 'settings'];
for (const t of ROUTES) {
  const row = page.locator(`[data-nav-tab="${t}"]`);
  if (await row.count() === 0) continue;
  await row.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, t + '.png') });
  const broke = await page.locator('text=stopped rendering').count();
  if (broke > 0) {
    const why = await page.locator('.empty p, [role="alert"] p, .pane p').first().textContent().catch(() => '');
    console.log(`  ${t}: ERROR BOUNDARY — ${(why ?? '').trim().slice(0, 120)}`);
  }
}
// The states this change actually has: the list hidden, the two narrower
// widths where it shrinks and then floats, and the light palette.
await page.locator('[data-nav-tab="learning"]').click().catch(() => {});
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(OUT, 'learning.png') });
await page.locator('[data-nav-tab="schedules"]').click().catch(() => {});
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(OUT, 'schedules.png') });

await page.locator('.hdr-toggle').click();
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, 'state-hidden.png') });
await page.locator('.hdr-toggle').click();
await page.waitForTimeout(400);

await page.setViewportSize({ width: 1100, height: 820 });
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, 'state-1100.png') });
await page.setViewportSize({ width: 860, height: 760 });
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, 'state-860.png') });
await page.setViewportSize({ width: 1440, height: 900 });
await page.emulateMedia({ colorScheme: 'light' });
await page.locator('[data-nav-tab="control"]').click().catch(() => {});
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, 'state-light.png') });

await close();
