#!/usr/bin/env node
/**
 * Relay's guess panel, in the real renderer, in both themes.
 *
 * The bridge in the packaged app is frozen and non-configurable — a renderer
 * cannot reach past `contextBridge`, which is the boundary working correctly —
 * so a fixtured preview has to come from the shared renderer harness, where
 * `window.wanigan` is a stub by construction. The main process half is covered
 * against the real thing in `smoke-suggest.ts`.
 *
 * What this checks is the surface: that a suggestion which cleared its gate,
 * one that fell short, and a stage proposed away are all legible at once.
 */
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { openRenderer } from './renderer-harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'docs/visuals/suggester/relay');
mkdirSync(OUT, { recursive: true });

const problems = [];
const checks = [];
const check = (ok, label) => { checks.push([ok, label]); console.log(`  ${ok ? '✓' : '✗'} ${label}`); };

const INSTRUMENT = `
(() => {
  const preview = {
    asked: true,
    phases: ['implement', 'verify', 'review'],
    pipeline: { pipeline: 'direct', confidence: 0.91 },
    estimatedUsd: 0.0000378,
    routes: {
      implement: {
        route: { model: 'claude-sonnet-5', effort: 'high', source: 'suggested', confidence: 0.88,
          reason: 'The implement stage runs on Sonnet at high effort because a suggester proposed it with confidence 0.88, at or above the 0.80 this stage requires.' },
        suggested: { model: 'claude-sonnet-5', effort: 'high', confidence: 0.88 },
        deliberation: { score: 2.4, confidence: 0.86 },
      },
      review: {
        route: { model: 'claude-opus-5', effort: null, source: 'profile-default', confidence: null,
          reason: 'The review stage runs on Opus because a suggestion of Sonnet was discarded: its confidence, 0.61, is below the 0.80 this stage requires.' },
        suggested: { model: 'claude-sonnet-5', effort: null, confidence: 0.61 },
        deliberation: { score: 1.2, confidence: 0.44 },
      },
    },
  };
  // No relay for this project, which is the state a person meets first and the
  // one the generic stub cannot produce: its proxy answers every read truthily,
  // so the view believes a relay is selected and draws the rig.
  const relayApi = {
    preview: async () => preview,
    list: async () => [],
    read: async () => { throw new Error('no relay selected'); },
  };
  const original = window.wanigan;
  window.wanigan = new Proxy(original, {
    get: (target, prop) => prop === 'relay'
      ? new Proxy(target.relay ?? {}, { get: (r, m) => (m in relayApi ? relayApi[m] : r[m]) })
      : target[prop],
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

for (const theme of ['dark', 'light']) {
  console.log(`── ${theme}`);
  const { page, close } = await openRenderer({
    theme, width: 1280, height: 1000,
    onError: (m) => problems.push(m),
    instrument: INSTRUMENT,
  });
  await setTheme(page, theme);

  await page.locator('[data-nav-tab="relay"]').first().click().catch(() => {});
  await page.waitForTimeout(800);

  const intent = page.locator('textarea[aria-label="What should this relay accomplish"]');
  check(await intent.count() === 1, 'the Relay composer is on screen');
  await intent.fill('Add a retry with exponential backoff to the upload client when it gets a 429.');

  const ask = page.getByRole('button', { name: 'Suggest routes' });
  check(await ask.count() === 1, 'the guess is offered where the route is chosen');
  await ask.click();
  await page.waitForSelector('.rl-guess', { timeout: 8000 });
  await page.waitForTimeout(600);

  const guess = page.locator('.rl-guess');
  check(await guess.locator('.rl-guess-row[data-verdict="taken"]').count() >= 1,
    'a suggestion that cleared its gate is marked taken');
  check(await guess.locator('.rl-guess-row[data-verdict="short"]').count() >= 1,
    'one that fell short is shown anyway, with the number it fell short by');
  check(await guess.locator('.rl-guess-row[data-dropped="true"]').count() >= 1,
    'a stage proposed away stays on screen rather than vanishing');
  check(await guess.locator('progress').count() >= 2, 'confidence is a quantity, not only digits');

  await guess.scrollIntoViewIfNeeded();
  await guess.screenshot({ path: path.join(OUT, `guess-${theme}.png`) });
  // The whole composer, which is what a person actually meets.
  await page.locator('.pane').first().evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, `composer-${theme}.png`) });
  await close();
}

for (const message of problems) console.log(`  [error] ${message}`);
const failed = checks.filter(([ok]) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks · ${problems.length} renderer errors · ${OUT}`);
process.exit(failed ? 1 : 0);
