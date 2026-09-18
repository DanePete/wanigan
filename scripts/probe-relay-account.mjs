#!/usr/bin/env node
// Prove the Relay create form can say which account pays, and that what it
// sends matches what the operator picked: a relay-level account, a per-stage
// override, and the one option that means "not the relay's — resolve normally".
//
// Plain Chromium with the preload bridge stubbed (scripts/renderer-harness.mjs).
// The main process's half — validation, the pinned row, startNode honouring it —
// is covered by the offline smoke suite; what is under test here is the form.
//
// Usage:  npm run build && node scripts/probe-relay-account.mjs [--out docs/visuals/relay-account]
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openRenderer } from './renderer-harness.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const OUT = path.resolve(REPO, outArg >= 0 ? args[outArg + 1] : 'docs/visuals/relay-account');
mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`);
  if (!ok) { failures += 1; if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 400)}`); }
};
const errors = [];
const onError = (m) => { if (!/WebGPU/.test(m)) errors.push(m); };

// Two accounts on the profile's harness, and a recorder for what create() sends.
const INSTRUMENT = `
(() => {
  const base = window.wanigan;
  const accountsRows = [
    { id: 'acct_work', harness: 'claude-code', label: 'Work', configDir: '/example/work', adopted: true, isDefault: true, present: true },
    { id: 'acct_personal', harness: 'claude-code', label: 'Personal', configDir: '/example/personal', adopted: false, isDefault: false, present: true },
  ];
  window.__relaySent = null;
  const accounts = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'listForProvider') return async () => accountsRows;
      return base.accounts[prop];
    },
  });
  const relay = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'create') {
        return async (input) => {
          window.__relaySent = JSON.parse(JSON.stringify(input));
          return { docket: { id: 'dk_new', nodes: [] }, nodes: [], forecast: null };
        };
      }
      if (prop === 'list') return async () => [];
      if (prop === 'read') return async () => null;
      return base.relay[prop];
    },
  });
  window.wanigan = new Proxy(base, {
    get: (t, p) => (p === 'accounts' ? accounts : p === 'relay' ? relay : t[p]),
  });
})();
`;

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
    document.documentElement.dataset.themePreference = t;
    document.documentElement.style.colorScheme = t;
    window.dispatchEvent(new CustomEvent('wanigan:theme-changed', { detail: { preference: t, resolved: t } }));
  }, theme);
  await page.waitForTimeout(350);
}

async function toRelay(page) {
  await page.locator('.hdr-toggle').first().click().catch(() => {});
  await page.waitForTimeout(250);
  await page.locator('[data-nav-tab="relay"]').first().click().catch(() => {});
  await page.waitForTimeout(800);
}

async function shot(page, name) {
  const box = await page.locator('.pane').first().boundingBox();
  await page.screenshot({
    path: path.join(OUT, `${name}.png`),
    clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 940) },
  });
}

for (const theme of ['dark', 'light']) {
  console.log(`── ${theme}`);
  const { page, close } = await openRenderer({ theme, width: 1440, height: 1000, onError, instrument: INSTRUMENT });
  await setTheme(page, theme);
  await toRelay(page);

  const account = page.locator('select[aria-label="Account every phase of this relay launches as"]');
  check(await account.count() === 1, 'the relay has one named account picker');
  const optionText = (await account.locator('option').allInnerTexts()).join(' | ');
  check(/This project’s account, then the default/.test(optionText) && /Work/.test(optionText) && /Personal/.test(optionText),
    'it offers the ordinary resolution first, then the accounts this profile can actually use', optionText);

  const perStage = page.locator('select[aria-label="Implement account override"]');
  check(await perStage.count() === 1, 'each agent stage can override the account');
  check(await page.locator('select[aria-label="Estimate account override"]').count() === 0,
    'the estimate phase gets no account control, because it launches no agent');

  await page.locator('textarea[aria-label="What should this relay accomplish"]').fill('Stop duplicate charges on retried checkouts.');
  await account.selectOption('acct_personal');
  await page.waitForTimeout(150);
  const stageOptions = (await perStage.locator('option').allInnerTexts()).join(' | ');
  check(/Same as the relay/.test(stageOptions) && /Not the relay’s/.test(stageOptions),
    'once a relay account is pinned, a stage can say "same as the relay" or step out of it deliberately', stageOptions);
  await shot(page, `${theme}-form`);

  await perStage.selectOption('acct_work');
  await page.locator('select[aria-label="Review account override"]').selectOption({ index: 1 });
  await page.locator('.btn-primary', { hasText: 'Start relay' }).click();
  await page.waitForTimeout(500);

  const sent = await page.evaluate(() => window.__relaySent);
  check(sent?.accountId === 'acct_personal', 'the relay-level account reaches the main process as chosen', sent);
  check(sent?.routes?.implement?.accountId === 'acct_work',
    'a stage override is sent for that stage alone', sent?.routes);
  check(sent?.routes?.review?.accountId === null,
    'and "not the relay’s" is sent as an explicit null — the one value that means "resolve this one normally"', sent?.routes);
  check(sent?.routes?.verify === undefined && sent?.routes?.plan === undefined,
    'a stage left alone sends nothing, so it simply follows the relay', sent?.routes);

  await close();
}

check(errors.length === 0, 'no page errors', errors.slice(0, 3));
console.log(failures === 0
  ? `\n✓ relay account probe passed — shots in ${path.relative(REPO, OUT)}`
  : `\n✗ ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
