#!/usr/bin/env node
// Synthetic renderer bridge only. These fixtures exercise presentation, not
// the main-process aggregator, provider metering, or any real TypeSafe call.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openRenderer } from './renderer-harness.mjs';

const before = process.argv.includes('--before');
const outAt = process.argv.indexOf('--out');
const out = outAt < 0
  ? path.resolve(import.meta.dirname, '../docs/visuals/jev-usage', before ? 'before' : 'after')
  : path.resolve(process.argv[outAt + 1]);
mkdirSync(out, { recursive: true });
const errors = [], checks = [];
const instrument = `(() => {
  const base = window.wanigan;
  const before = ${before};
  window.__jevUsageCalls = [];
  window.__jevUsageMode = 'metered';
  window.wanigan = new Proxy(base, { get(api, key) {
    if (key !== 'usage') return api[key];
    return new Proxy(api.usage, { get(old, method) {
      if (method === 'observed') return async () => ({ accounts: [], hooksEnabled: true, relayEnabled: true, unsupported: null });
      if (method !== 'snapshot') return old[method];
      return async ({ days, force }) => {
        window.__jevUsageCalls.push({ days, force });
        const snapshot = await old.snapshot();
        const row = { accountId: null, accountLabel: 'TypeSafe', harness: null,
          model: 'jev-latest', requests: 2, inTokens: 1200, outTokens: 0,
          cacheRead: 0, costUsd: 0, costStatus: 'unreported',
          estimatedCostUsd: 0.0000504, unmeteredRequests: 0, source: 'service' };
        if (window.__jevUsageMode === 'mixed') { row.requests = 3; row.unmeteredRequests = 1; }
        if (window.__jevUsageMode === 'missing') {
          row.requests = 1; row.inTokens = 0; row.unmeteredRequests = 1;
          delete row.estimatedCostUsd;
        }
        if (window.__jevUsageMode === 'tiny') {
          row.requests = 1; row.inTokens = 1; row.estimatedCostUsd = 0.000000042;
        }
        if (window.__jevUsageMode === 'zero') {
          row.requests = 1; row.inTokens = 0; row.estimatedCostUsd = 0;
        }
        // Before the repair, routing previews and credential checks never reached
        // this bridge. Afterward, their recorded counters join the snapshot.
        const result = { ...snapshot, days, consumption: before ? [] : [row],
          daily: before || window.__jevUsageMode === 'missing' ? [] : [{ accountId: row.accountId, accountLabel: row.accountLabel,
            harness: row.harness, model: row.model, source: row.source, day: new Date().toISOString().slice(0, 10),
            tokens: row.inTokens, costUsd: 0 }] };
        if (window.__jevUsageMode === 'collision') {
          const account = { ...snapshot.limits[2], accountId: 'same-label-account', accountLabel: 'TypeSafe' };
          result.limits = [...snapshot.limits, account];
          result.consumption.push({ accountId: account.accountId, accountLabel: account.accountLabel, harness: 'codex',
            source: 'session', model: 'gpt-session-fixture', requests: 7, inTokens: 9000,
            outTokens: 0, cacheRead: 0, costUsd: 0, costStatus: 'unreported' });
          result.daily.push({ accountId: account.accountId, accountLabel: account.accountLabel, harness: 'codex',
            source: 'session', model: 'gpt-session-fixture', day: new Date().toISOString().slice(0, 10),
            tokens: 9000, costUsd: 0 });
        }
        return result;
      };
    } });
  } });
})();`;

const { page, close } = await openRenderer({ width: 1440, height: 1000, instrument,
  onError: message => { if (!/WebGPU/.test(message)) errors.push(message); } });
const record = message => { checks.push(message); console.log(message); };
const capture = async name => {
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
      document.documentElement.dataset.motion = 'off';
    }, theme);
    await page.screenshot({ path: path.join(out, `${name}-${theme}.png`), scale: 'css', animations: 'disabled' });
  }
};

try {
  await page.locator('.app-header').waitFor();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Meta+Shift+U');
  await page.getByRole('heading', { name: 'Usage', exact: true }).waitFor();
  const accounts = page.getByRole('combobox', { name: 'Account for recorded consumption' });
  await accounts.selectOption('all');
  await page.getByRole('button', { name: 'Refresh limits', exact: true }).waitFor();
  if (before) {
    assert.equal(await accounts.locator('option').filter({ hasText: /TypeSafe/ }).count(), 0);
    await page.getByRole('heading', { name: 'No recorded requests in this window', exact: true }).waitFor();
    record('The baseline fixture has no TypeSafe account or Jev consumption record.');
    await capture('usage');
  } else {
    const typeSafe = accounts.locator('option[value="label:TypeSafe"]');
    await typeSafe.waitFor({ state: 'attached' });
    const callsBefore = await page.evaluate(() => window.__jevUsageCalls.length);
    await accounts.selectOption('label:TypeSafe');
    const table = page.getByRole('table', { name: 'Consumption by model', exact: true });
    await table.waitFor();
    const row = table.locator('tbody tr').filter({ hasText: 'jev-latest' });
    // Compare the visible values exactly while checking their accessible cost
    // explanation separately; screen-reader prose is not another table value.
    const values = () => row.locator('td').evaluateAll(cells => cells.map(cell => {
      const copy = cell.cloneNode(true);
      copy.querySelectorAll('.sr-only').forEach(note => note.remove());
      return copy.textContent.trim();
    }));
    assert.equal(await row.count(), 1);
    const cells = await values();
    assert.match(cells[0], /TypeSafe/);
    assert.equal(cells[1], 'jev-latest');
    assert.equal(cells[2], '2');
    assert.equal(cells[3], '1.2k');
    assert.match(cells.at(-1), /~\$/);
    assert.match(cells.at(-1), /estimated/i);
    assert.match(await row.locator('td').last().innerText(), /not a provider bill/i);
    assert.equal(cells[5], '—', 'service records do not report cache counters');
    assert(!/^\$0\.00$/.test(cells.at(-1).trim()), 'estimated cost must not be presented as a reported zero');
    assert.equal(await page.evaluate(() => window.__jevUsageCalls.length), callsBefore);
    assert.equal(await page.locator('.u-comparison tbody tr').filter({ hasText: 'TypeSafe' }).count(), 0);
    await page.getByRole('img', { name: /tokens per day for TypeSafe/i }).waitFor();
    record('TypeSafe appears in account navigation; Jev has two requests, 1.2k input tokens and a visibly estimated cost.');
    record('Selecting TypeSafe performs no new snapshot request and invents no provider limit.');
    await capture('usage');
    await page.locator('.u-days > summary').click();
    assert.match(await page.locator('.u-days').innerText(), /jev-latest/i);
    assert.match(await page.locator('.u-days').innerText(), /1,200/);
    record('The accessible daily table includes Jev and its 1,200 recorded tokens.');

    await page.evaluate(() => { window.__jevUsageMode = 'mixed'; });
    await page.getByRole('button', { name: 'Refresh limits', exact: true }).click();
    await page.getByText('1 request did not report complete token counts. Totals show reported tokens; estimates cover reported input only.', { exact: true }).waitFor();
    const mixed = await values();
    assert.equal(mixed[2], '3');
    assert.equal(mixed[3], '≥1.2k');
    assert.equal(mixed[4], '—');
    assert.match(mixed[6], /^~\$0\.0000504 estimated$/);
    assert.match(await page.locator('.u-totals').innerText(), /≥1\.2k/);
    await page.locator('.u-days > summary').click();
    await capture('usage-mixed');
    record('Mixed metering retains all requests, labels known token counts as a lower bound, and keeps the input estimate explicit.');

    await page.evaluate(() => { window.__jevUsageMode = 'missing'; });
    await page.getByRole('button', { name: 'Refresh limits', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('table[aria-label="Consumption by model"] tbody tr td:nth-child(3)')?.textContent === '1');
    const missing = await values();
    assert.equal(missing[2], '1');
    assert.deepEqual(missing.slice(3), ['—', '—', '—', '—']);
    assert.equal(await page.locator('.u-chart').count(), 0);
    await capture('usage-unmetered');
    record('A request with no usage counters remains visible, with missing tokens, cache and cost shown as dashes and no invented chart.');

    await page.evaluate(() => { window.__jevUsageMode = 'tiny'; });
    await page.getByRole('button', { name: 'Refresh limits', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('table[aria-label="Consumption by model"] tbody tr td:nth-child(4)')?.textContent === '1');
    assert.equal((await values())[6], '~$0.000000042 estimated');
    record('A one-token estimate retains its nonzero value instead of rounding to zero.');

    await page.evaluate(() => { window.__jevUsageMode = 'zero'; });
    await page.getByRole('button', { name: 'Refresh limits', exact: true }).click();
    await page.getByRole('img', { name: /Peak 0 reported tokens/ }).waitFor();
    await page.locator('.u-days > summary').click();
    assert.deepEqual(await page.locator('.u-days tbody tr td').allTextContents(), [new Date().toISOString().slice(0, 10), '0', '0']);
    record('Reported zero counters remain zero in the daily table and chart peak.');

    await page.evaluate(() => { window.__jevUsageMode = 'collision'; });
    await page.getByRole('button', { name: 'Refresh limits', exact: true }).click();
    await accounts.locator('option[value="account:same-label-account"]').waitFor({ state: 'attached' });
    assert.equal(await table.locator('tbody tr').count(), 1);
    assert.match(await row.innerText(), /jev-latest/);
    assert.equal(await page.locator('.u-comparison tbody tr.u-selected').count(), 0);
    assert.doesNotMatch(await page.locator('.u-chart').innerText(), /gpt-session-fixture/);
    await accounts.selectOption('account:same-label-account');
    assert.equal(await table.locator('tbody tr').count(), 1);
    assert.match(await table.innerText(), /gpt-session-fixture/);
    assert.doesNotMatch(await table.innerText(), /jev-latest/);
    assert.equal(await page.locator('.u-comparison tbody tr.u-selected').count(), 1);
    assert.doesNotMatch(await page.locator('.u-chart').innerText(), /jev-latest/);
    await accounts.selectOption('label:TypeSafe');
    assert.equal(await table.locator('tbody tr').count(), 1);
    assert.match(await table.innerText(), /jev-latest/);
    assert.equal(await page.locator('.u-comparison tbody tr.u-selected').count(), 0);
    record('An actual session account named TypeSafe stays separate from the API service in limits, model rows and daily charts.');
  }
  assert.deepEqual(errors, []);
} finally {
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ synthetic: true, before, checks, errors }, null, 2) + '\n');
  await close();
}
