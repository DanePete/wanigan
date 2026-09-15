#!/usr/bin/env node
// Prove the dock under the terminal collapses as one thing, says what it is
// still holding while shut, and hands focus somewhere real.
//
// Plain Chromium with the preload bridge stubbed (scripts/renderer-harness.mjs),
// so this is evidence about layout, focus and wording — never about the PTY,
// IPC or persistence. The stub reports session s1 as waiting on a permission
// prompt, which is what makes Enter queue rather than send.
//
// Usage:  npm run build && node scripts/probe-session-dock.mjs [--out docs/visuals/session-dock/after]
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openRenderer } from './renderer-harness.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const OUT = path.resolve(REPO, outArg >= 0 ? args[outArg + 1] : 'docs/visuals/session-dock/after');
mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`);
  if (!ok) { failures += 1; if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 400)}`); }
};
// The orb wants WebGPU, which headless Chromium does not have; that is not this view.
const errors = [];
const onError = (m) => { if (!/WebGPU/.test(m)) errors.push(m); };

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
    document.documentElement.dataset.themePreference = t;
    document.documentElement.style.colorScheme = t;
    window.dispatchEvent(new CustomEvent('wanigan:theme-changed', { detail: { preference: t, resolved: t } }));
  }, theme);
  await page.waitForTimeout(350);
}

async function toSessions(page) {
  await page.keyboard.press('Meta+1');
  await page.waitForTimeout(700);
  if (await page.locator('.term-col').count() === 0) {
    await page.locator('.hdr-toggle').first().click().catch(() => {});
    await page.waitForTimeout(300);
    await page.locator('[data-nav-tab="sessions"]').first().click().catch(() => {});
    await page.waitForTimeout(700);
  }
}

const heights = (page) => page.evaluate(() => {
  const h = (el) => (el ? Math.round(el.getBoundingClientRect().height * 100) / 100 : null);
  const col = document.querySelector('.term-col');
  return { column: h(col), terminal: h(col?.firstElementChild), dock: h(document.querySelector('.session-dock')) };
});

async function shot(page, name) {
  const box = await page.locator('.term-col').boundingBox();
  const y = Math.max(box.y, box.y + box.height - 320);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), clip: { x: box.x, y, width: box.width, height: box.y + box.height - y } });
}

for (const theme of ['dark', 'light']) {
  console.log(`── ${theme}`);
  const { page, close } = await openRenderer({ theme, width: 1440, height: 900, onError });
  await setTheme(page, theme);
  await toSessions(page);
  check(await page.locator('.session-dock').count() === 1, 'one dock under the terminal');

  const toggle = page.locator('.session-dock-toggle');
  const open = await heights(page);
  check(await toggle.getAttribute('aria-expanded') === 'true', 'toggle starts expanded');
  check(await page.locator('.composer-area').count() === 1, 'composer is inside the open dock');
  await shot(page, `${theme}-open`);

  await toggle.click();
  await page.waitForTimeout(300);
  const shut = await heights(page);
  check(await toggle.getAttribute('aria-expanded') === 'false', 'toggle reports collapsed');
  check(await page.locator('#session-dock-body').count() === 1, 'aria-controls still resolves while shut');
  check(await page.locator('.composer-area').count() === 0, 'composer unmounted while shut');
  check(await page.locator('.session-dock-actions .btn', { hasText: 'Add files' }).isVisible(), 'Add files reachable while shut');
  check(shut.dock < 40, `shut dock is one bar (${shut.dock}px)`, shut);
  check(shut.terminal > open.terminal, `terminal gains ${Math.round((shut.terminal - open.terminal) * 100) / 100}px`, { open, shut });
  check((await page.locator('.session-dock-held').innerText()).trim() === '', 'nothing held → the bar claims nothing');
  await shot(page, `${theme}-collapsed`);

  // Open with the chord from outside the terminal: focus lands in the box.
  await toggle.focus();
  await page.keyboard.press('Meta+e');
  await page.waitForTimeout(300);
  check(await page.evaluate(() => document.activeElement?.classList.contains('composer-area')), '⌘E opens and focuses the composer');

  // A queued message and an unsent draft typed immediately before hiding —
  // inside the save debounce. The view opens on s2, which is idle and would
  // send; s1 is at a permission prompt (its attention chip opens it), so there Enter queues. The composer
  // polls attention every two seconds, so wait for it to say so.
  await page.locator('.atq-chip', { hasText: 'storefront' }).first().click();
  await page.waitForFunction(() => document.querySelector('.composer')?.getAttribute('data-state') === 'queue', null, { timeout: 8000 });
  // Opening a session from its chip hands focus to that terminal two frames
  // later; focusing the box before then loses the race and the typing below
  // lands in the PTY instead.
  await page.waitForTimeout(400);
  await page.locator('.composer-area').focus();
  check(await page.evaluate(() => document.activeElement?.classList.contains('composer-area')), 'typing into the composer, not the terminal');
  await page.keyboard.type('run the checkout tests again');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  await page.keyboard.type('and then look at the refund path');
  await page.keyboard.press('Meta+e');
  await page.waitForTimeout(400);
  check(await page.evaluate(() => document.activeElement?.classList.contains('session-dock-toggle')), '⌘E from inside the dock leaves focus on the toggle, not <body>');
  const held = (await page.locator('.session-dock-held').innerText()).trim();
  check(/1 queued, sends when idle/.test(held), 'shut bar says a message is still queued', held);
  check(/draft kept/.test(held), 'shut bar says the draft typed just before hiding was kept', held);
  await shot(page, `${theme}-collapsed-holding`);

  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check(await page.locator('.composer-area').inputValue() === 'and then look at the refund path', 'reopening restores the draft verbatim');
  check(await page.locator('.composer-queue [role="listitem"]').count() === 1, 'reopening shows the queued message');

  // Narrow: the compact picker. The bar wraps; nothing is clipped sideways.
  await page.setViewportSize({ width: 700, height: 900 });
  await page.waitForTimeout(600);
  const overflow = await page.evaluate(() => { const b = document.querySelector('.session-dock-bar'); return b ? b.scrollWidth - b.clientWidth : null; });
  check(overflow === 0, 'bar does not overflow at 700px', overflow);
  await shot(page, `${theme}-narrow-open`);
  await page.locator('.session-dock-toggle').click();
  await page.waitForTimeout(300);
  await shot(page, `${theme}-narrow-collapsed`);

  console.log(`  heights: open ${JSON.stringify(open)} shut ${JSON.stringify(shut)}`);
  await close();
}

// View › Show/Hide Composer. Main's half (the label follows the report) runs in
// the smoke suite; this is the window's half. The stub never fires menuRoute,
// so the listener App registers is captured and called as main would call it,
// and every composerShown report the window sends is recorded.
{
  console.log('── View menu');
  const instrument = `
    const base = window.wanigan;
    window.__menuRoute = null;
    window.__composerReports = [];
    const on = new Proxy(base.on, { get: (o, p) => p === 'menuRoute' ? (cb) => { window.__menuRoute = cb; return () => {}; } : o[p] });
    const menu = { composerShown: (shown) => { window.__composerReports.push(shown); } };
    window.wanigan = new Proxy(base, { get: (t, p) => p === 'on' ? on : p === 'menu' ? menu : t[p] });
  `;
  const { page, close } = await openRenderer({ theme: 'dark', width: 1440, height: 900, onError, instrument });
  const reports = () => page.evaluate(() => window.__composerReports.slice());
  check((await reports())[0] === true, 'on launch the window tells main what this machine remembers, before anyone opens the menu', await reports());
  check(await page.evaluate(() => typeof window.__menuRoute === 'function'), 'the window listens for menu routes');

  // Hide from another view: nothing to navigate to, the preference is written.
  await page.keyboard.press('Meta+2');
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__menuRoute({ kind: 'composer', show: false }));
  await page.waitForTimeout(200);
  check((await reports()).at(-1) === false, 'Hide Composer from another view reports the dock shut', await reports());

  // Show from another view: it takes you to the composer it just showed.
  await page.evaluate(() => window.__menuRoute({ kind: 'composer', show: true }));
  await page.waitForTimeout(800);
  check(await page.locator('.session-dock-toggle').getAttribute('aria-expanded') === 'true', 'Show Composer from another view lands on Sessions with the dock open');

  // Hide while the terminal has focus — the case ⌘E cannot serve.
  await page.evaluate(() => document.querySelector('.terminal-host .xterm-helper-textarea')?.focus());
  const inTerminal = await page.evaluate(() => !!document.activeElement?.closest('.terminal-host'));
  await page.evaluate(() => window.__menuRoute({ kind: 'composer', show: false }));
  await page.waitForTimeout(300);
  check(await page.locator('.session-dock-toggle').getAttribute('aria-expanded') === 'false', `Hide Composer works with focus in the terminal (focus was ${inTerminal ? 'in' : 'NOT in'} the terminal)`);
  check(await page.evaluate(() => !!document.activeElement?.closest('.terminal-host')) === inTerminal, 'and leaves focus where it was');
  await page.evaluate(() => window.__menuRoute({ kind: 'composer', show: true }));
  await page.waitForTimeout(300);
  check(await page.evaluate(() => document.activeElement?.classList.contains('composer-area')), 'Show Composer on Sessions puts focus in the box');
  check((await reports()).at(-1) === true, 'and reports the dock open', await reports());
  await close();
}

check(errors.length === 0, 'no page errors', errors.slice(0, 3));
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
