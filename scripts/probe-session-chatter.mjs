#!/usr/bin/env node
// Prove the session-chatter card: it appears when one session messages another,
// says who talked to whom and the sender's own label, never the message itself,
// can be dismissed, and holds still while it is being read.
//
// Plain Chromium with the preload bridge stubbed (scripts/renderer-harness.mjs).
// The hook bus is the real source in the app; here the session-event stream is
// driven directly, because what is under test is the card, not the bus.
//
// Usage:  npm run build && node scripts/probe-session-chatter.mjs [--out docs/visuals/session-chatter]
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openRenderer } from './renderer-harness.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const OUT = path.resolve(REPO, outArg >= 0 ? args[outArg + 1] : 'docs/visuals/session-chatter');
mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`);
  if (!ok) { failures += 1; if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 400)}`); }
};
const errors = [];
const onError = (m) => { if (!/WebGPU/.test(m)) errors.push(m); };

// The session-event stream, taken over so a probe can deliver the exact rows
// hooks.ts writes for a SendMessage call. `summary` is `to · label`, which is
// what the main process stores — the message body is never in the row at all,
// so a card that printed one would have nothing to print it from.
const INSTRUMENT = `
(() => {
  const base = window.wanigan;
  let listeners = [];
  const on = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'sessionEvent') {
        return (cb) => {
          listeners.push(cb);
          return () => { listeners = listeners.filter((x) => x !== cb); };
        };
      }
      return base.on[prop];
    },
  });
  window.__chatter = (row) => { for (const cb of listeners) cb(row); };
  window.wanigan = new Proxy(base, { get: (t, p) => (p === 'on' ? on : t[p]) });
})();
`;

/** The exchange this feature was built after: two sessions sorting out a file clash. */
const EXCHANGE = [
  { sessionId: 's1', summary: 'platform · answer relay coordination' },
  { sessionId: 's2', summary: 'storefront · typecheck green, routes are yours' },
  { sessionId: 's1', summary: 'platform · taking mobile-nav, leaving routes.ts' },
];

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
    document.documentElement.dataset.themePreference = t;
    document.documentElement.style.colorScheme = t;
    window.dispatchEvent(new CustomEvent('wanigan:theme-changed', { detail: { preference: t, resolved: t } }));
  }, theme);
  await page.waitForTimeout(350);
}

async function send(page, row, index) {
  await page.evaluate(({ row, index }) => {
    window.__chatter({
      id: 9000 + index,
      sessionId: row.sessionId,
      at: Date.now(),
      event: 'PreToolUse',
      toolName: 'SendMessage',
      summary: row.summary,
      durationMs: null,
      ok: null,
    });
  }, { row, index });
  await page.waitForTimeout(450);
}

/** Frames through one crossing, so the packet, the squash and the bob are on record. */
async function film(page, row, index, name) {
  await page.evaluate(({ row, index }) => {
    window.__chatter({
      id: 9000 + index, sessionId: row.sessionId, at: Date.now(),
      event: 'PreToolUse', toolName: 'SendMessage', summary: row.summary, durationMs: null, ok: null,
    });
  }, { row, index });
  const offsets = [70, 220, 380, 560];
  let last = 0;
  for (let i = 0; i < offsets.length; i++) {
    await page.waitForTimeout(offsets[i] - last);
    last = offsets[i];
    await shot(page, `${name}-frame-${i + 1}`);
  }
  await page.waitForTimeout(300);
}

async function shot(page, name) {
  const box = await page.locator('.chatter').boundingBox();
  const pad = 24;
  await page.screenshot({
    path: path.join(OUT, `${name}.png`),
    clip: {
      x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad),
      width: box.width + pad * 2, height: box.height + pad * 2,
    },
  });
}

for (const theme of ['dark', 'light']) {
  console.log(`── ${theme}`);
  const { page, close } = await openRenderer({ theme, width: 1440, height: 900, onError, instrument: INSTRUMENT });
  await setTheme(page, theme);
  await page.waitForTimeout(500);

  check(await page.locator('.chatter').count() === 0,
    'nothing is on screen until two sessions actually talk');

  await send(page, EXCHANGE[0], 0);
  check(await page.locator('.chatter').count() === 1, 'the first message brings the card in');

  await send(page, EXCHANGE[1], 1);
  // The third message is filmed: four frames through the crossing.
  await film(page, EXCHANGE[2], 2, `${theme}-crossing`);
  const lines = await page.locator('.chatter-line').count();
  check(lines === EXCHANGE.length, `each message is its own line (${lines})`, lines);

  const text = await page.locator('.chatter').innerText();
  check(/storefront/.test(text) && /platform/.test(text),
    'both ends are named, so "who is talking to whom" reads off the card', text);
  check(/never the message/i.test(text),
    'the card says what Wanigan does not see', text);
  const actors = await page.locator('.chatter-actor-name').allInnerTexts();
  check(actors.length === 2 && actors.includes('storefront') && actors.includes('platform'),
    'two characters stand on the stage, named', actors);
  check(await page.locator('.chatter-typing').count() === 1,
    'after the last message the listener shows waiting dots — a reply is owed', await page.locator('.chatter-typing').count());
  check(await page.locator('.chatter-line.side-left').count() === 2
    && await page.locator('.chatter-line.side-right').count() === 1,
    'bubbles sit under whoever said them', text);
  // The label is the sender's own; the body never reaches the renderer at all.
  check(/answer relay coordination/.test(text), 'the sender’s label is quoted', text);
  await shot(page, `${theme}-exchange`);

  // Reading it must not race a timer. The card holds while the pointer is on it.
  await page.locator('.chatter').hover();
  await page.waitForTimeout(600);
  check(await page.locator('.chatter').count() === 1, 'it stays put while it is being read');

  const dismiss = page.locator('.chatter-x');
  check(await dismiss.getAttribute('aria-label') !== null, 'the dismiss carries an accessible name');
  await dismiss.click();
  // The card plays its exit before it unmounts; the wait covers LEAVE_MS.
  await page.waitForTimeout(550);
  check(await page.locator('.chatter').count() === 0, 'dismissing it takes it away');

  await send(page, EXCHANGE[0], 9);
  check(await page.locator('.chatter').count() === 1,
    'and a later exchange brings it back, because dismissing is not muting');

  await close();
}

check(errors.length === 0, 'no page errors', errors.slice(0, 3));
console.log(failures === 0
  ? `\n✓ session chatter probe passed — shots in ${path.relative(REPO, OUT)}`
  : `\n✗ ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
