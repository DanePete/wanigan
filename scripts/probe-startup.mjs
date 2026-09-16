import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openRenderer } from './renderer-harness.mjs';

const before = process.argv.includes('--before');
const directory = path.resolve('docs/shots-startup', before ? 'before' : 'after');
fs.mkdirSync(directory, { recursive: true });
for (const theme of ['dark', 'light']) {
  const errors = [];
  const { page, close } = await openRenderer({ theme, onError: message => errors.push(message), instrument: `
    const original = window.wanigan;
    let listener;
    window.__finishStartup = () => listener?.({ phase: 'ready', stage: null, message: null });
    window.wanigan = new Proxy(original, { get(target, name) {
      if (name === 'policy') return new Proxy(target.policy, { get(policy, action) {
        if (action === 'chain') return async () => ({ total: 0, unchainedBefore: 0, chained: 0, verifiedThrough: 0, lastVerifiedId: null, firstBreak: null, head: null, watched: null, checkedAt: Date.now(), signature: { state: 'unsigned', reason: 'No records in this fixture.' }, keyFingerprint: null });
        return policy[action];
      }});
      if (name === 'startup') return { status: async () => ({ phase: 'starting', stage: 'encrypted credentials', message: 'Opening encrypted credentials. Background services will start when this finishes.' }) };
      if (name === 'on') return new Proxy(target.on, { get(events, event) {
        if (event === 'startupChanged') return callback => { listener = callback; return () => { listener = null; }; };
        return events[event];
      }});
      return target[name];
    }});
  ` });
  try {
    await page.locator('.pane').first().waitFor();
    if (!before) await page.getByText('Opening encrypted credentials.', { exact: false }).waitFor();
    await page.screenshot({ path: path.join(directory, `${theme}.png`), fullPage: true });
    if (!before) {
      await page.locator('[data-nav-tab="sessions"]').click();
      await page.locator('[data-nav-tab="settings"]').click();
      await page.evaluate(() => window.__finishStartup());
      await page.locator('.startup-recovery[role="status"]').waitFor({ state: 'detached' });
      assert.deepEqual(errors.filter(message => !message.includes('WebGPU adapter is unavailable')), [], `${theme} startup must not cause renderer errors`);
    }
  } finally { await close(); }
}
console.log(before ? 'Startup before screenshots captured.' : 'Startup remains navigable while credentials are pending (both themes).');
