#!/usr/bin/env node
// Synthetic renderer fixtures. This verifies presentation and interaction only;
// test-usage-accounts.cjs exercises the real account/probe boundary offline.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openRenderer } from './renderer-harness.mjs';

const before = process.argv.includes('--before');
const out = path.resolve('docs/visuals/usage-accounts-2026-09-19', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const errors = [];
const checks = [];
const instrument = `(() => {
  const original = window.wanigan;
  const now = Date.now();
  window.__usageCalls = [];
  const windowOf = (kind, usedPercent, hours) => ({ kind, scope: null, usedPercent,
    resetsAtText: null, resetsAt: now + hours * 3600000 });
  const account = (id, label, harness, email, plan, windows, age = 60000) => ({
    accountId: id, accountLabel: label, harness, identity: email ? { email, orgName: null, plan, authMethod: harness === 'codex' ? 'chatgpt' : 'claude.ai' } : null,
    identityEvidence: { sharedWith: [] }, plan, windows, state: 'ok', detail: null,
    fetchedAt: now - age, factors: [],
  });
  const limits = [
    account('claude-personal', 'Personal', 'claude-code', 'alex@example.com', 'max', [windowOf('session', 53, 2.5), windowOf('week', 96, 35)]),
    account('claude-work', 'Work', 'claude-code', 'alex@studio.example', 'max', [windowOf('session', 24, 1.8), windowOf('week', 100, 10)]),
    account('claude-max5', 'max5', 'claude-code', 'alex@example.com', 'max', [windowOf('session', 53, 2.5), windowOf('week', 96, 35)]),
    account('codex-personal', 'Personal', 'codex', 'alex@example.com', 'pro', [windowOf('5h window', 31, 1.5), windowOf('week', 74, 89)]),
    account('codex-games', 'Game studio', 'codex', 'games@example.com', 'pro', [windowOf('5h window', 31, 1.5), windowOf('week', 74, 89)]),
    account('codex-temp', 'Temporary', 'codex', 'temporary@example.com', 'prolite', [windowOf('week', 7, 167)], 20 * 60000),
    { ...account('codex-out', 'Second account', 'codex', null, null, []), state: 'signed-out', detail: 'Sign in to this account to read its limits.' },
  ];
  limits[0].identityEvidence.sharedWith = [{ accountId: 'claude-max5', accountLabel: 'max5', basis: 'saved-login' }];
  limits[2].identityEvidence.sharedWith = [{ accountId: 'claude-personal', accountLabel: 'Personal', basis: 'saved-login' }];
  const consumption = limits.slice(0, 5).map((account, index) => ({ accountId: account.accountId,
    accountLabel: account.accountLabel, harness: account.harness, source: 'session',
    model: account.harness === 'codex' ? 'gpt-5.4' : 'claude-sonnet-4-6', requests: index + 11,
    inTokens: (index + 1) * 15000, outTokens: (index + 1) * 2400, cacheRead: (index + 1) * 32000,
    costUsd: account.harness === 'codex' ? 0 : (index + 1) * 0.73,
    costStatus: account.harness === 'codex' ? 'unreported' : 'reported' }));
  const daily = consumption.flatMap((row, index) => Array.from({ length: 14 }, (_, day) => ({
    accountId: row.accountId, accountLabel: row.accountLabel, harness: row.harness,
    model: row.model, day: new Date(now - (13 - day) * 86400000).toISOString().slice(0, 10),
    tokens: (day % 5 + 2) * (index + 1) * 850, costUsd: 0,
  })));
  window.wanigan = new Proxy(original, { get(api, key) {
    if (key !== 'usage') return api[key];
    return new Proxy(api.usage, { get(usage, method) {
      if (method === 'snapshot') return async ({ days, force }) => {
        window.__usageCalls.push({ days, force });
        if (window.__usageFail) throw new Error('Account refresh could not complete.');
        return { limits: window.__usageEmpty ? [] : limits, consumption: window.__usageEmpty ? [] : consumption,
          daily: window.__usageEmpty ? [] : daily, days };
      };
      if (method === 'observed') return async () => ({ accounts: [], hooksEnabled: true, relayEnabled: true, unsupported: null });
      return usage[method];
    } });
  } });
})();`;

const { page, close } = await openRenderer({ width: 1440, height: 1050, instrument,
  onError: message => { if (!/WebGPU/.test(message)) errors.push(message); } });
const record = message => { checks.push(message); console.log(message); };
async function capture(name) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
      document.documentElement.dataset.motion = 'off';
    }, theme);
    await page.screenshot({ path: path.join(out, name + '-' + theme + '.png'), scale: 'css', animations: 'disabled' });
  }
}

try {
  await page.locator('.app-header').waitFor();
  await page.keyboard.press('Meta+Shift+U');
  await page.getByRole('heading', { name: 'Usage', exact: true }).waitFor();
  const accountPicker = page.getByRole('combobox', { name: 'Account for recorded consumption' });
  if (before) {
    await page.getByRole('navigation', { name: 'Usage accounts' })
      .getByRole('button', { name: 'All accounts Combined local records', exact: true }).click();
  } else {
    await accountPicker.selectOption('all');
  }
  await page.getByRole('button', { name: 'Refresh limits', exact: true }).waitFor();
  await capture('usage-comparison');
  if (!before) {
    // The evidence is account identity, never matching percentages: these two
    // Codex accounts intentionally have identical windows but different logins.
    assert.match(await page.locator('.usage-view').innerText(), /saved login/i);
    const calls = await page.evaluate(() => window.__usageCalls.length);
    assert.equal(await page.locator('.u-comparison tbody tr').count(), 7);
    for (const label of ['Personal', 'Game studio']) {
      const row = page.locator('.u-comparison tbody tr').filter({ has: page.getByRole('button', { name: `Show local records for ${label}, Codex`, exact: true }) });
      assert.doesNotMatch(await row.innerText(), /same saved login|shared with|same configuration/i);
    }
    await page.getByRole('button', { name: 'Show local records for max5, Claude Code', exact: true }).click();
    assert.equal(await page.evaluate(() => window.scrollY), 0, 'selection scrolls the Usage pane, not the shell');
    const table = page.getByRole('table', { name: 'Consumption by model', exact: true });
    await table.waitFor();
    assert.equal(await table.locator('tbody tr').count(), 1);
    assert.match(await table.innerText(), /max5/);
    assert.equal(await page.evaluate(() => window.__usageCalls.length), calls, 'selection must not probe accounts');
    record('Shared saved login is disclosed while per-account local records remain separate.');
    record('Matching Codex percentages do not label distinct logins as duplicates.');
    await capture('usage-selected');
    await page.getByRole('combobox', { name: 'Consumption window' }).selectOption('30');
    await page.waitForFunction(() => window.__usageCalls.at(-1)?.days === 30);
    assert.equal(await page.evaluate(() => window.__usageCalls.at(-1).force), false);
    await page.evaluate(() => { window.__usageFail = true; });
    await page.getByRole('button', { name: 'Refresh limits', exact: true }).click();
    await page.getByText('Account refresh could not complete.', { exact: true }).waitFor();
    assert.equal(await table.locator('tbody tr').count(), 1, 'failed refresh retains last records');
    record('Date changes use cached limits; a failed refresh preserves the last reading.');
    await page.evaluate(() => { window.__usageFail = false; });
    await page.getByRole('button', { name: 'Refresh limits', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh limits', exact: true }).waitFor();
    await accountPicker.selectOption('all');
    for (const width of [960, 600]) {
      await page.setViewportSize({ width, height: 1050 });
      await page.locator('.usage-view').evaluate(pane => { pane.scrollTop = 0; });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      if (overflow) {
        await capture('usage-overflow-' + width);
        console.log(await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
          outside: [...document.querySelectorAll('body *')].map(el => ({ el, rect: el.getBoundingClientRect() }))
            .filter(({ rect }) => rect.width && rect.right > innerWidth + 1)
            .slice(0, 18).map(({ el, rect }) => ({ tag: el.tagName, class: el.className, right: rect.right, width: rect.width })) })));
      }
      assert.equal(overflow, false, 'page must fit at ' + width + 'px');
      await capture('usage-' + width);
    }
    record('Account comparison stays inside the viewport at 960px and 600px.');
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.evaluate(() => { window.__usageEmpty = true; });
    await page.getByRole('button', { name: 'Refresh limits', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh limits', exact: true }).waitFor();
    await page.locator('.usage-view').evaluate(pane => { pane.scrollTop = 0; });
    assert.doesNotMatch(await page.locator('.usage-view').innerText(), /NaN|undefined|Invalid Date/);
    await capture('usage-empty');
    record('Empty configuration renders without invented values.');
  }
  assert.deepEqual(errors, []);
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ fixture: true, before, checks, errors }, null, 2) + '\n');
} finally { await close(); }
