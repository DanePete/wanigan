#!/usr/bin/env node
// Broad presentation audit using fictional renderer fixtures, not live agents.
// Functional account and navigation regressions run in their focused probes.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openRenderer } from './renderer-harness.mjs';
import { TABS, TAB_SHORTCUTS } from '../src/shared/routes.ts';

const before = process.argv.includes('--before');
const out = path.resolve('docs/visuals/dock-ui-audit-2026-09-19', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const errors = [];
const measurements = [];
const { page, close } = await openRenderer({ width: 1440, height: 960,
  onError: message => { if (!/WebGPU/.test(message)) errors.push(message); },
  instrument: `(() => {
    const original = window.wanigan;
    window.wanigan = new Proxy(original, { get(api, key) {
      if (key === 'schedule') return new Proxy(api.schedule, { get(service, method) {
        if (method === 'list' || method === 'history') return async () => [];
        if (method === 'daemon') return async () => ({ supported: false, installed: false, detail: 'Background scheduling is unavailable in this presentation fixture.', caveat: '' });
        if (method === 'preview') return async () => ({ fires: [Date.now() + 3600000, Date.now() + 90000000], describe: 'Every day at 9:00' });
        return service[method];
      } });
      if (key === 'worktrees') return new Proxy(api.worktrees, { get(service, method) {
        if (method === 'setup') return async projectId => ({ projectId, depsMode: 'skip', setup: [], teardown: [], updatedAt: null, include: { state: 'absent' } });
        return service[method];
      } });
      if (key === 'providers') return new Proxy(api.providers, { get(service, method) {
        if (method === 'checkObserveOnlyHooks') return async () => ({ state: 'unavailable', version: '1.0.0', reason: 'no-answer', detail: 'No hook evidence in this presentation fixture.' });
        return service[method];
      } });
      if (key === 'relay') return new Proxy(api.relay, { get(service, method) {
        if (method === 'list') return async () => [];
        return service[method];
      } });
      if (key === 'recovery') return new Proxy(api.recovery, { get(service, method) {
        if (method === 'inspect') return async () => ({ generation: 'presentation-fixture', storageMode: 'active', storageReason: 'Fixture storage is available.', observations: [], resolutions: [] });
        return service[method];
      } });
      if (key !== 'usage') return api[key];
      return new Proxy(api.usage, { get(usage, method) {
        if (method === 'observed') return async () => ({ accounts: [], hooksEnabled: true, relayEnabled: true, unsupported: null });
        return usage[method];
      } });
    } });
  })();` });

async function visit(tab, width, height) {
  await page.setViewportSize({ width, height });
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press(TAB_SHORTCUTS[tab].aria.split(' ')[0]);
  await page.waitForTimeout(250);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
      document.documentElement.dataset.motion = 'off';
    }, theme);
    await page.screenshot({ path: path.join(out, `${tab}-${width}${height < 700 ? '-short' : ''}-${theme}.png`), scale: 'css', animations: 'disabled' });
  }
  const geometry = await page.evaluate(() => {
    const box = selector => {
      const r = document.querySelector(selector)?.getBoundingClientRect();
      return r ? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } : null;
    };
    const outside = [...document.querySelectorAll('.app-header button, .space-dock button, .space-settings')]
      .filter(el => { const r = el.getBoundingClientRect(); return r.width && (r.left < 0 || r.right > window.innerWidth || r.bottom > window.innerHeight); })
      .map(el => el.getAttribute('aria-label') || el.textContent.trim());
    return { heading: document.querySelector('.pane h1')?.textContent ?? null,
      documentOverflow: document.documentElement.scrollWidth > innerWidth,
      header: box('.app-header'), routes: box('.space-routes'), body: box('.body'), dock: box('.space-foot'),
      outside, errorBoundary: !!document.querySelector('.view-recovery') };
  });
  measurements.push({ tab, width, height, ...geometry });
  console.log(JSON.stringify(measurements.at(-1)));
}

try {
  await page.locator('.app-header').waitFor();
  for (const { id } of TABS) {
    if (before && id === 'recovery') continue; // Added by a concurrent task after the frozen baseline.
    await visit(id, 1440, 960);
  }
  for (const id of ['mission', 'sessions', 'control', 'fleet', 'usage', 'settings']) await visit(id, 960, 800);
  for (const id of ['sessions', 'control', 'board', 'settings', 'context', 'schedules']) await visit(id, 960, 560);
  assert.deepEqual(errors, [], 'every route must render without an uncaught error');
  assert.deepEqual(measurements.filter(item => item.documentOverflow || item.outside.length || item.errorBoundary), [],
    'views must keep the document and shell controls inside the viewport');
} finally {
  writeFileSync(path.join(out, 'audit.json'), JSON.stringify({ fixture: true, before, measurements, errors }, null, 2) + '\n');
  await close();
}
