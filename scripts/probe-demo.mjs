#!/usr/bin/env node
// Real main/preload/renderer privacy checks in a disposable profile.
// No screenshots, recordings, real agents or model requests.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright-core';
import { launchWanigan } from './electron-harness.mjs';

const root = path.resolve(import.meta.dirname, '..');
const userData = mkdtempSync(path.join(tmpdir(), 'wanigan-demo-check-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const { app, page } = await launchWanigan(_electron, { root, userData, env, args: ['--wanigan-demo'] });
const errors = [];
try {
  page.on('pageerror', error => errors.push(error.message));
  // Intercept only the final OS write. Exercise the real renderer/preload/main
  // path without reading or replacing the operator's clipboard.
  await app.evaluate(({ clipboard }) => {
    global.demoOriginalClipboardWrite = clipboard.writeText;
    global.demoClipboardWrites = [];
    clipboard.writeText = text => {
      if (global.demoClipboardFails) throw new Error('Deliberate clipboard refusal');
      global.demoClipboardWrites.push(text);
    };
  });
  await page.waitForSelector('.demo-banner');
  assert.deepEqual(await page.evaluate(() => window.wanigan.demo.state()), { on: true, source: 'fictional' });
  await page.waitForFunction(() => document.querySelector('.wanigan-orb')?.dataset.physics === 'ready');
  const window = await app.browserWindow(page);
  assert.equal(await window.evaluate(w => w.webContents.session.isPersistent()), false, 'demo storage must be ephemeral');
  await app.evaluate(async ({ session }) => {
    // A real-profile draft planted independently of the demo origin.
    await session.defaultSession.cookies.set({ url: 'https://private.example', name: 'private-canary', value: 'PRIVATE_CLIENT_CANARY' });
  });
  assert.deepEqual(await window.evaluate(w => w.webContents.session.cookies.get({ name: 'private-canary' })), [], 'live browser storage is isolated');
  const data = await page.evaluate(async () => ({
    projects: await window.wanigan.projects.list(), sessions: await window.wanigan.sessions.list(),
    usage: await window.wanigan.usage.snapshot({ days: 14 }), key: await window.wanigan.key.status(),
  }));
  assert(data.projects.every(p => p.path.startsWith('/example/')));
  assert(data.sessions.every(s => s.id.startsWith('demo-')));
  assert.equal(data.key.present, false);
  // Exercise the shipped main handler, with arbitrary real-looking ids/paths.
  const refused = await page.evaluate(async () => {
    const calls = [
      () => window.wanigan.companion.ask({ question: 'PRIVATE_CLIENT_CANARY', projectId: null, model: 'example' }),
      () => window.wanigan.projects.add('/private/PRIVATE_CLIENT_CANARY'),
      () => window.wanigan.sessions.kill('PRIVATE_CLIENT_CANARY'),
      () => window.wanigan.prefs.set('notifications', '1'),
      () => window.wanigan.shell.openExternal('https://private.example/PRIVATE_CLIENT_CANARY'),
      () => window.wanigan.demo.copyPrompt('PRIVATE_CLIENT_CANARY'),
      () => window.wanigan.demo.copyPrompt({ id: 'cart-fix', text: 'PRIVATE_CLIENT_CANARY' }),
      () => window.wanigan.demo.copyPrompt(null),
    ];
    return Promise.all(calls.map(async call => { try { await call(); return 'ALLOWED'; } catch (e) { return e.message; } }));
  });
  assert(refused.every(message => message.includes('read-only demo') && !message.includes('CANARY')));
  assert.deepEqual(await app.evaluate(() => global.demoClipboardWrites), [], 'invalid prompt ids must never write to the clipboard');
  await page.evaluate(() => {
    window.demoEvents = [];
    for (const key of ['data', 'sessions', 'sessionEvent', 'notificationRaised', 'batchChanged', 'startupChanged']) {
      window.wanigan.on[key](event => window.demoEvents.push(event));
    }
  });
  await window.evaluate(w => {
    for (const channel of ['session:data', 'session:list', 'session:event', 'notify:alert', 'batch:changed', 'startup:changed']) {
      w.webContents.send(channel, { secret: 'PRIVATE_CLIENT_CANARY' });
    }
  });
  await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(() => window.demoEvents), [], 'preload suppresses operational streams');
  const go = async key => {
    await page.getByRole('button', { name: 'All destinations', exact: true }).focus();
    await page.keyboard.press(key.replace('Meta', process.platform === 'darwin' ? 'Meta' : 'Control'));
  };
  for (const theme of ['dark', 'light']) {
    await page.evaluate(async theme => {
      await window.wanigan.prefs.setTheme(theme);
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const [key, selector] of [['Meta+1', '.sessions-view'], ['Meta+2', '.fleet-workspace'], ['Meta+Shift+U', '.u-chart'], ['Meta+,', '.pane']]) {
      await go(key); await page.waitForSelector(selector);
      if (key === 'Meta+1') {
        await page.locator('.session-item').filter({ hasText: 'Improve checkout accessibility' }).click();
        await page.waitForSelector('.terminal-host:visible');
      }
      if (key === 'Meta+,') {
        const picker = page.getByRole('combobox', { name: 'Demo prompts', exact: true });
        const preview = page.getByRole('textbox', { name: 'Selected demo prompt', exact: true });
        await picker.waitFor();
        assert.equal(await picker.locator('option').count(), 5);
        assert.equal(await preview.getAttribute('readonly'), '');
        const before = await app.evaluate(() => global.demoClipboardWrites.length);
        for (const id of ['cart-fix', 'checkout-accessibility', 'checkout-guide', 'session-attention', 'account-headroom']) {
          await picker.selectOption(id);
          assert.equal(await page.getByText('Prompt copied.', { exact: true }).count(), 0);
          await page.getByRole('button', { name: 'Copy prompt', exact: true }).click();
          await page.getByText('Prompt copied.', { exact: true }).waitFor();
          assert.equal(await app.evaluate(() => global.demoClipboardWrites.at(-1)), await preview.inputValue());
        }
        assert.equal(await app.evaluate(() => global.demoClipboardWrites.length), before + 5);
        await app.evaluate(() => global.demoClipboardFails = true);
        await page.getByRole('button', { name: 'Copy prompt', exact: true }).click();
        await page.getByText('Could not copy the prompt. Select the prompt text and copy it manually.', { exact: true }).waitFor();
        assert.equal(await page.getByText('Prompt copied.', { exact: true }).count(), 0);
        assert.equal(await picker.isEnabled(), true);
        await picker.selectOption('cart-fix');
        assert.equal(await page.getByText('Could not copy the prompt. Select the prompt text and copy it manually.', { exact: true }).count(), 0);
        await app.evaluate(() => global.demoClipboardFails = false);
      }
      const content = await page.locator('body').innerText();
      assert(!content.includes('PRIVATE_CLIENT_CANARY'));
      assert(!content.includes('This view hit an error'));
      assert(!/\b(?:NaN|undefined|Invalid Date)\b/.test(content), 'sample views must render complete values');
    }
    await go('Meta+6');
    await page.getByRole('heading', { name: 'This demo surface is still being prepared.' }).waitFor();
    await go('Meta+Shift+H'); await page.waitForSelector('.mission-room');
  }
  await page.getByRole('button', { name: 'Wanigan appearance and play', exact: true }).click();
  await page.getByRole('button', { name: 'Make a splash', exact: true }).click();
  const frames = await page.locator('.wanigan-orb canvas').getAttribute('data-frames');
  await page.waitForFunction(before => document.querySelector('.wanigan-orb canvas')?.dataset.frames !== before, frames);
  assert.deepEqual(errors, []);
  // Turn the actual window over twice. Keep transition-test windows invisible:
  // the live counterpart still uses a disposable database but may discover
  // locally installed providers. No discovered value is printed or captured.
  await app.evaluate(({ app }) => app.on('browser-window-created', (_event, w) => w.setOpacity(0)));
  const openedLive = app.waitForEvent('window');
  await page.evaluate(() => { void window.wanigan.demo.set(false); });
  const livePage = await openedLive;
  await livePage.waitForFunction(() => !!window.wanigan);
  assert.equal((await livePage.evaluate(() => window.wanigan.demo.state())).source, 'live');
  await livePage.evaluate(() => window.wanigan.demo.copyPrompt('cart-fix'));
  assert.match(await app.evaluate(() => global.demoClipboardWrites.at(-1)), /removing the last item/);
  await livePage.evaluate(() => localStorage.setItem('demo-check-private-draft', 'PRIVATE_DRAFT_CANARY'));
  const liveWindow = await app.browserWindow(livePage);
  assert.equal(await liveWindow.evaluate(w => w.webContents.session.isPersistent()), true);
  const openedDemo = app.waitForEvent('window');
  await livePage.evaluate(() => { void window.wanigan.demo.set(true); });
  const nextDemo = await openedDemo;
  await nextDemo.waitForSelector('.demo-banner');
  assert.equal(await nextDemo.evaluate(() => localStorage.getItem('demo-check-private-draft')), null, 'live drafts must not enter demo storage');
  assert.equal(await nextDemo.evaluate(() => document.body.innerText.includes('PRIVATE_DRAFT_CANARY')), false);
  const restoredLive = app.waitForEvent('window');
  await nextDemo.evaluate(() => { void window.wanigan.demo.set(false); });
  const restored = await restoredLive;
  await restored.waitForFunction(() => !!window.wanigan);
  assert.equal(await restored.evaluate(() => localStorage.getItem('demo-check-private-draft')), 'PRIVATE_DRAFT_CANARY', 'leaving demo preserves the real draft');
  console.log('Demo integration passed: isolated storage, fictional IPC, refused actions, suppressed streams, all five prompt previews and validated copies in both themes, clipboard failure, actual GPU water, mode switches and draft preservation. No media captured; OS clipboard untouched.');
} finally {
  await app.evaluate(({ clipboard }) => { if (global.demoOriginalClipboardWrite) clipboard.writeText = global.demoOriginalClipboardWrite; });
  await app.close();
  rmSync(userData, { recursive: true, force: true });
}
