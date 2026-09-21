#!/usr/bin/env node
// Real built renderer with fictional preload data. No provider or settings writes.
// Captures only navigation: section shortcuts, search jumps, and keyboard tabs.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openRenderer } from './renderer-harness.mjs';

const before = process.argv.includes('--before');
const out = path.resolve('docs/visuals/dock-ui-audit-2026-09-19/settings-scroll', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const evidence = [];
const errors = [];
const { page, close } = await openRenderer({ width: 1440, height: 960,
  onError: message => { if (!/WebGPU/.test(message)) errors.push(message); },
  instrument: `(() => {
    const original = window.wanigan;
    window.wanigan = new Proxy(original, { get(api, key) {
      if (key === 'providers') return new Proxy(api.providers, { get(service, method) {
        if (method === 'checkObserveOnlyHooks') return async () => ({ state: 'unavailable', reason: 'unsupported', detail: 'No hook evidence in this presentation fixture.' });
        return service[method];
      } });
      return api[key];
    } });
  })();` });
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function geometry() {
  return page.evaluate(() => {
    const box = selector => {
      const element = document.querySelector(selector);
      const r = element.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    };
    return { documentX: scrollX, documentY: scrollY, paneScroll: document.querySelector('.set.pane').scrollTop,
      header: box('.app-header'), dock: box('.space-foot'), title: box('.set.pane > .pane-head'),
      panel: document.querySelector('.set-tab-panel:not([hidden])')?.scrollTop ?? 0,
      selectedTab: document.querySelector('.set-tabs [aria-selected="true"]')?.id,
      focus: document.activeElement?.getAttribute('data-section-title') ?? document.activeElement?.id };
  });
}
async function capture(name) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; }, theme);
    await page.screenshot({ path: path.join(out, `${name}-${theme}.png`), scale: 'css', animations: 'disabled' });
  }
}
function compareFrame(initial, final, action) {
  const fixed = ['documentX', 'documentY', 'paneScroll', 'header', 'dock', 'title'];
  const changes = fixed.filter(key => JSON.stringify(initial[key]) !== JSON.stringify(final[key]));
  evidence.push({ action, initial, final, changes });
  console.log(JSON.stringify(evidence.at(-1)));
  if (!before) assert.deepEqual(changes, [], `${action} moved the Settings frame`);
}
async function resetFrame() {
  await page.evaluate(() => {
    scrollTo(0, 0);
    document.querySelector('.set.pane').scrollTop = 0;
    const panel = document.querySelector('.set-tab-panel:not([hidden])');
    if (panel) panel.scrollTop = 0;
  });
  await settle();
}
try {
  await page.locator('.app-header').waitFor();
  await page.keyboard.press('Meta+,');
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await page.evaluate(() => { document.documentElement.dataset.motion = 'off'; });
  for (const [width, height] of [[1440, 960], [960, 800], [900, 600], [1440, 600]]) {
    await page.setViewportSize({ width, height });
    await page.getByRole('tab', { name: /^App\b/ }).click();
    await settle();
    await resetFrame();
    let initial = await geometry();
    await page.getByRole('navigation', { name: 'App settings shortcuts' }).getByRole('button', { name: 'Keyboard', exact: true }).click();
    await settle();
    let final = await geometry();
    await capture(`shortcut-${width}x${height}`);
    compareFrame(initial, final, `section shortcut at ${width}x${height}`);
    assert.equal(final.focus, 'Keyboard');
    assert(final.panel > initial.panel, 'the category panel must scroll to the section');

    await resetFrame();
    await page.getByRole('searchbox', { name: 'Search settings', exact: true }).fill('Storage');
    initial = await geometry();
    await page.locator('.set-search-results').getByRole('button', { name: /^Storage\b/ }).click();
    await settle();
    final = await geometry();
    await capture(`search-${width}x${height}`);
    compareFrame(initial, final, `search result at ${width}x${height}`);
    assert.equal(final.focus, 'Storage');
    assert(final.panel > 0, 'the search result must reveal its section');

    await resetFrame();
    await page.getByRole('tab', { name: /^Agents\b/ }).focus();
    initial = await geometry();
    await page.keyboard.press('End');
    await settle();
    final = await geometry();
    await capture(`keyboard-${width}x${height}`);
    compareFrame(initial, final, `keyboard tab at ${width}x${height}`);
    assert.equal(final.focus, 'settings-tab-app');
    assert.equal(final.selectedTab, 'settings-tab-app');
  }
  assert.deepEqual(errors, []);
} finally {
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ before, fictionalFixtures: true, evidence, errors }, null, 2) + '\n');
  await close();
}
