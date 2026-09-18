#!/usr/bin/env node
// Prove Home opens on the companion: the orb and a conversation, not a work
// summary with the orb shrunk into the header. The work summary is still one
// click away, and whichever the operator picks is remembered.
//
// Plain Chromium with the preload bridge stubbed (scripts/renderer-harness.mjs).
//
// Usage:  npm run build && node scripts/probe-home-companion.mjs [--out docs/visuals/home-companion]
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openRenderer } from './renderer-harness.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const OUT = path.resolve(REPO, outArg >= 0 ? args[outArg + 1] : 'docs/visuals/home-companion');
mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`);
  if (!ok) { failures += 1; if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 400)}`); }
};
// The orb wants WebGPU, which headless Chromium has none of; that is not what
// is under test here, and the scene's absence must not read as a failure.
const errors = [];
const onError = (m) => { if (!/WebGPU|GPU|WebGL/i.test(m)) errors.push(m); };

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
    document.documentElement.dataset.themePreference = t;
    document.documentElement.style.colorScheme = t;
    window.dispatchEvent(new CustomEvent('wanigan:theme-changed', { detail: { preference: t, resolved: t } }));
  }, theme);
  await page.waitForTimeout(350);
}

async function toHome(page) {
  await page.keyboard.press('Meta+Shift+H');
  await page.waitForTimeout(700);
  if (await page.locator('.home-room').count() === 0) {
    await page.locator('.hdr-toggle').first().click().catch(() => {});
    await page.waitForTimeout(250);
    await page.locator('[data-nav-tab="mission"]').first().click().catch(() => {});
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(400);
}

async function shot(page, name) {
  const box = await page.locator('.home-room').boundingBox();
  await page.screenshot({
    path: path.join(OUT, `${name}.png`),
    clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 900) },
  });
}

for (const theme of ['dark', 'light']) {
  console.log(`── ${theme}`);
  const { page, close } = await openRenderer({ theme, width: 1440, height: 1000, onError });
  await setTheme(page, theme);
  await toHome(page);

  check(await page.locator('#home-companion').count() === 1,
    'Home opens on the companion rather than on the work summary');
  check(await page.locator('.mission-stage').count() === 1, 'the orb has the stage, not a badge in the header');
  const head = await page.locator('.pane-head, .home-intro').first().innerText();
  check(/With Wanigan/.test(head), 'the title says where you are', head.slice(0, 120));
  check(/Back to work/.test(head), 'and the way out is named on the same line', head.slice(0, 120));
  await shot(page, `${theme}-companion`);

  // The summary is one click away, and the choice is remembered.
  await page.locator('button', { hasText: 'Back to work' }).first().click();
  await page.waitForTimeout(500);
  check(await page.locator('#home-companion').count() === 0, '"Back to work" reaches the work summary');
  check(await page.locator('.home-work, .home-add-project').count() > 0,
    'the summary is what it always was — nothing was removed to make room for the orb');
  await shot(page, `${theme}-work`);

  await page.keyboard.press('Meta+2');
  await page.waitForTimeout(400);
  await toHome(page);
  check(await page.locator('#home-companion').count() === 0,
    'leaving and coming back remembers the work summary, so the new default is a starting point and not a preference Wanigan keeps re-imposing');

  await close();
}

check(errors.length === 0, 'no page errors', errors.slice(0, 3));
console.log(failures === 0
  ? `\n✓ home companion probe passed — shots in ${path.relative(REPO, OUT)}`
  : `\n✗ ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
