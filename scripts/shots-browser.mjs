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
  await close(); process.exit(0);
}
// Every destination, in sidebar order, in both palettes — a view is only
// reviewed when both of its themes have been looked at, and half of what goes
// wrong in a theme (a hard-coded colour, a border that vanishes) is invisible
// in the other one.
const ROUTES = ['sessions', 'fleet', 'control', 'batches', 'insights', 'usage', 'learning',
                'scout', 'skills', 'context', 'plugins', 'git', 'runs', 'schedules', 'settings'];
for (const theme of ['dark', 'light']) {
  const bg = await setTheme(theme);
  console.log(`── ${theme} (body ${bg})`);
  for (const t of ROUTES) {
    const row = page.locator(`[data-nav-tab="${t}"]`);
    if (await row.count() === 0) continue;
    await row.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, `${theme}-${t}.png`), fullPage: true });
    const broke = await page.locator('text=stopped rendering').count();
    if (broke > 0) {
      const why = await page.locator('.empty p, [role="alert"] p, .pane p').first().textContent().catch(() => '');
      console.log(`  ${t}: ERROR BOUNDARY — ${(why ?? '').trim().slice(0, 120)}`);
    }
    // Anything that reached the screen as a non-value is a defect wherever it
    // came from; naming it here is cheaper than finding it in a screenshot.
    const text = await page.locator('.pane').first().innerText().catch(() => '');
    const bad = ['NaN', 'undefined', 'null', 'Invalid Date', '[object Object]'].filter((n) => text.includes(n));
    if (bad.length) console.log(`  ${t}: LEAKED ${bad.join(', ')}`);
  }
}
await setTheme('dark');
// The session Timeline, which is two clicks in from the sidebar and therefore
// never appeared in the sweep above: Sessions opens on the Code pane, and the
// Timeline is behind its own segment. It is the one pane whose whole job is to
// name events, so a change to the words it uses is invisible without this.
// emulateMedia cannot reach the palette: an explicit data-theme on the root
// beats prefers-color-scheme, so a "light" shot taken that way comes back dark
// and a both-themes pair proves nothing. Stamp the attribute the palette keys
// on, and report the computed body colour so a caller can prove it took.
async function setTheme(theme) {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
    document.documentElement.dataset.themePreference = t;
    document.documentElement.style.colorScheme = t;
    window.dispatchEvent(new CustomEvent('wanigan:theme-changed', { detail: { preference: t, resolved: t } }));
  }, theme);
  await page.waitForTimeout(350);
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

async function timelineShot(name, theme) {
  if (theme) await setTheme(theme);
  const row = page.locator('[data-nav-tab="sessions"]');
  if (await row.count() === 0) return;
  await row.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(400);
  // Selecting a session, then opening the side rail: the segments do not exist
  // until the rail is open, which is why a locator for them alone found nothing.
  await page.locator('button', { hasText: /Claude Code/ }).first().click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(400);
  const opener = page.locator('button', { hasText: /^\s*code \u27e9\s*$/ });
  if (await opener.count()) { await opener.first().click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(500); }
  const seg = page.locator('.code-tab', { hasText: /^\s*Timeline\s*$/ }).first();
  if (await seg.count() === 0) { console.log('  ' + name + ': no Timeline segment'); return; }
  await seg.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(800);
  // Turns fold by default, so the pane opens showing three rows and hiding
  // every event inside them — which is exactly the part worth reviewing.
  const toggles = page.locator('.tl-turntoggle[aria-expanded="false"]');
  for (let i = await toggles.count(); i > 0; i = await toggles.count()) {
    await toggles.first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(200);
    if (await toggles.count() >= i) break;
  }
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
  const words = await page.locator('.tl-word').allTextContents().catch(() => []);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  console.log('  ' + name + ': ' + (await page.locator('.tl-row').count()) + ' rows, body ' + bg);
  if (words.length) console.log('  words: ' + [...new Set(words.map((w) => w.trim()))].join(', '));
}
await timelineShot('timeline', 'dark');

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
await timelineShot('timeline-light', 'light');

await close();
