#!/usr/bin/env node
// Real renderer with fictional bridge data. No live sessions or provider calls.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openRenderer } from './renderer-harness.mjs';

const before = process.argv.includes('--before');
const out = path.resolve('docs/visuals/admin-sidebar-2026-09-19', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const checks = [], errors = [], sizes = [];
let failure;
const { page, close } = await openRenderer({ width: 1440, height: 960,
  onError: message => { if (!/WebGPU/.test(message)) errors.push(message); },
  instrument: `(() => {
    const base = window.wanigan;
    window.__sidebarPref = localStorage.getItem('__sidebarPref') || 'closed';
    window.__sidebarWrites = 0;
    window.wanigan = new Proxy(base, { get(api, key) {
      if (key !== 'prefs') return api[key];
      return new Proxy(api.prefs, { get(prefs, method) {
        if (method === 'all') return async () => ({ ...await prefs.all(), navSidebar: window.__sidebarPref, motion: 'off' });
        if (method === 'set') return async (key, value) => {
          if (key === 'nav_sidebar') {
            window.__sidebarPref = value; window.__sidebarWrites++;
            localStorage.setItem('__sidebarPref', value);
          }
          return { ...await prefs.all(), navSidebar: window.__sidebarPref, motion: 'off' };
        };
        return prefs[method];
      } });
    } });
  })();` });
async function capture(name) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.screenshot({ path: path.join(out, `${name}-${theme}.png`), scale: 'css', animations: 'disabled' });
  }
}
try {
  await page.locator('.app-header').waitFor();
  for (const [width, height] of [[1440, 960], [900, 560]]) {
    await page.setViewportSize({ width, height });
    await capture(`closed-${width}x${height}`);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  const toggle = page.locator('.app-header .hdr-toggle');
  assert.equal(await toggle.count(), 1, 'The admin bar must keep its own sidebar opener when navigation is closed');
  assert.equal(await toggle.isVisible(), true);
  assert.equal((await toggle.innerText()).trim(), 'Sidebar');
  await toggle.click();
  await page.locator('#wanigan-sidebar').waitFor();
  await page.waitForFunction(() => window.__sidebarPref === 'open');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  await capture('open-desktop');
  await page.reload();
  await page.locator('#wanigan-sidebar').waitFor();
  await toggle.click();
  await page.locator('#wanigan-sidebar').waitFor({ state: 'detached' });
  await page.waitForFunction(() => window.__sidebarPref === 'closed');
  await page.reload();
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  checks.push('Labeled admin-bar opener survives closed navigation, toggles it, and persists both desktop choices.');

  const tools = page.getByRole('button', { name: 'All destinations', exact: true });
  await tools.click();
  await page.getByRole('button', { name: 'Hide navigation', exact: true }).click();
  assert.equal(await toggle.evaluate(element => document.activeElement === element), true);
  await page.waitForFunction(() => window.__sidebarPref === 'closed');
  checks.push('Dock Tools still opens the same sidebar; its close control returns focus to the admin bar.');

  for (const [width, height] of [[1440, 960], [1180, 800], [960, 800], [900, 560], [720, 560], [600, 640], [460, 640]]) {
    await page.setViewportSize({ width, height });
    const geometry = await page.evaluate(() => {
      const groups = ['.workbench-start', '.workbench-context', '.nav-actions'].map(selector => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return { left: r.left, right: r.right };
      });
      const r = document.querySelector('.app-header .hdr-toggle').getBoundingClientRect();
      return { width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth,
        groups, button: { left: r.left, right: r.right, height: r.height } };
    });
    assert.equal(geometry.overflow, false, JSON.stringify(geometry));
    assert(geometry.button.height > 0 && geometry.button.left >= 0 && geometry.button.right <= width, JSON.stringify(geometry));
    assert(geometry.groups.every((group, index) => !index || geometry.groups[index - 1].right <= group.left + 1), JSON.stringify(geometry));
    if (width >= 900) assert.equal((await toggle.innerText()).trim(), 'Sidebar');
    sizes.push(geometry);
    await capture(`closed-${width}x${height}`);
  }
  await page.setViewportSize({ width: 900, height: 560 });
  const writes = await page.evaluate(() => window.__sidebarWrites);
  const drawer = page.getByRole('dialog', { name: 'Workspace navigation', exact: true });
  for (const opener of [toggle, tools]) {
    await opener.click(); await drawer.waitFor();
    await page.keyboard.press('Escape'); await drawer.waitFor({ state: 'detached' });
    assert.equal(await opener.evaluate(element => document.activeElement === element), true);
  }
  await toggle.focus(); await page.keyboard.press('Alt+Meta+s'); await drawer.waitFor();
  await page.keyboard.press('Escape'); await drawer.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.__sidebarWrites), writes);
  checks.push('Both openers and the shortcut work in compact windows; Escape restores focus without changing the desktop preference.');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, sizes, errors }, null, 2));
} catch (error) { failure = String(error); throw error; }
finally {
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ fixture: true, before, checks, sizes, errors, failure }, null, 2) + '\n');
  await close();
}
