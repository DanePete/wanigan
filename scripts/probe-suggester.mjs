#!/usr/bin/env node
/**
 * Settings › Connections › Routing suggester, in the real app.
 *
 * Real main process, real preload, real module, a fresh profile — so the state
 * photographed here is not a fixture's idea of "no credential", it is the
 * genuine one every install has. No agent is launched and no credential is
 * stored, so nothing here can reach TypeSafe: the panel is being checked for
 * saying that truthfully.
 *
 *   node scripts/probe-suggester.mjs           → docs/visuals/suggester/after
 *   node scripts/probe-suggester.mjs --before  → …/before (run with the
 *                                                <RoutingSuggester /> mount
 *                                                commented out and rebuilt)
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchWanigan } from './electron-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { _electron } = require('playwright-core');
const BEFORE = process.argv.includes('--before');
const out = path.join(root, 'docs/visuals/suggester', BEFORE ? 'before' : 'after');
mkdirSync(out, { recursive: true });

const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-suggester-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];

const errors = [];
const checks = [];
const check = (ok, label) => { checks.push([ok, label]); console.log(`  ${ok ? '✓' : '✗'} ${label}`); };

const { app, page } = await launchWanigan(_electron, { root, userData: dir, env });
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text().slice(0, 200)); });

try {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1440, 1000);
    window.show();
  });
  await page.waitForSelector('.mission-room');
  await page.keyboard.press('Meta+,');
  await page.locator('#settings-tab-connections').waitFor();
  await page.locator('#settings-tab-connections').click();
  await page.locator('#settings-connections').waitFor({ state: 'visible' });

  const suggester = page.locator('[data-section-title="Routing suggester"]');

  if (BEFORE) {
    check(await suggester.count() === 0, 'the Connections tab has no suggester section yet');
  } else {
    check(await suggester.count() === 1, 'the suggester section is on the Connections tab');
    await suggester.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);

    // The shipped state, read from the real module: no key, nothing switched
    // on, and drawn as an offer rather than as something broken.
    check(await suggester.getByText('Nothing is switched on and no key is stored').count() === 1,
      'the shipped state reads as an offer, not a fault');
    check(await suggester.locator('#suggest-api-key').count() === 1,
      'the key field is present and its label points at it');
    check(await suggester.getByRole('switch').count() === 2,
      'both declared capabilities are drawn as switches');
  }

  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.dataset.themePreference = t;
      document.documentElement.style.colorScheme = t;
      window.dispatchEvent(new CustomEvent('wanigan:theme-changed', { detail: { preference: t, resolved: t } }));
    }, theme);
    await page.waitForTimeout(450);

    if (!BEFORE) {
      await suggester.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(out, `connections-${theme}.png`) });
      await suggester.screenshot({ path: path.join(out, `suggester-idle-${theme}.png`) });
    } else {
      await page.screenshot({ path: path.join(out, `connections-${theme}.png`) });
    }
  }

  if (!BEFORE) {
    // Turning a switch on with no key stored: the setting really is written
    // through real IPC, and the panel has to say it is not in force rather
    // than redraw it as off. This is the state the stored/enabled split exists
    // for, so it is the one worth a picture.
    await suggester.getByRole('switch', { name: 'Suggest a model for each stage' }).click();
    await page.waitForTimeout(400);
    await suggester.getByRole('switch', { name: 'Suggest which stages to run' }).click();
    await page.waitForTimeout(500);
    check(await suggester.getByText('These switches are saved, but nothing is asked').count() === 1,
      'a switch turned on with no key says it is stored and not in force');

    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
        document.documentElement.style.colorScheme = t;
        window.dispatchEvent(new CustomEvent('wanigan:theme-changed', { detail: { preference: t, resolved: t } }));
      }, theme);
      await page.waitForTimeout(400);
      await suggester.scrollIntoViewIfNeeded();
      await suggester.screenshot({ path: path.join(out, `suggester-switched-no-key-${theme}.png`) });
    }

    // An empty key is refused by the main process, and the field is the only
    // way in: there is no channel that reads a key back out.
    check(await suggester.getByRole('button', { name: 'Save & verify' }).isDisabled(),
      'Save is unavailable until something is typed, so an empty key cannot be sent');
  }
} finally {
  await app.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}

for (const message of errors) console.log(`  [error] ${message}`);
const failed = checks.filter(([ok]) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks · ${errors.length} renderer errors · ${out}`);
process.exit(failed || errors.length ? 1 : 0);
