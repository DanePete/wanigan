#!/usr/bin/env node
// Actual renderer in an isolated Electron window. Every service is a fixture;
// these checks never change credentials, start agents or write user preferences.
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), { _electron } = require('playwright-core');
const root = path.resolve(import.meta.dirname, '..'), before = process.argv.includes('--before');
const out = path.join(root, 'docs/visuals/settings-workspace', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-settings-'));
writeFileSync(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(dir, 'main.cjs'), `--user-data-dir=${dir}/profile`], env });
const errors = [], checks = [], measurements = [];
const record = message => { checks.push(message); console.log(message); };
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(STUB);
  await page.addInitScript(() => {
    const original = window.wanigan;
    window.__settingsCalls = [];
    let prefs;
    const record = (service, method, args) => window.__settingsCalls.push([service, method, ...args]);
    const overrides = {
      prefs: {
        all: async () => prefs ??= await original.prefs.all(),
        set: async (key, value) => {
          record('prefs', 'set', [key, value]);
          if (window.__settingsSaveFails) throw new Error('Fixture disk unavailable');
          prefs ??= await original.prefs.all();
          prefs = { ...prefs, [key]: value }; return prefs;
        },
        setTheme: async value => {
          record('prefs', 'setTheme', [value]);
          if (window.__settingsSaveFails) throw new Error('Fixture disk unavailable');
          if (window.__holdThemeSave) await new Promise(resolve => window.__releaseThemeSave = resolve);
          prefs ??= await original.prefs.all();
          prefs = {...prefs, theme:value}; return prefs;
        },
      },
      key: { status: async () => ({ present: false, fingerprint: null, encryptionAvailable: true, fromEnv: false, workspaceId: null }), provider: async () => ({present:false, fingerprint:null}) },
      glmKey: { status: async () => ({ present: false, fingerprint: null }) },
      deepseekKey: { status: async () => ({ present: false, fingerprint: null }) },
      xaiKey: { status: async () => ({ present: false, fingerprint: null }) },
      providerPacks: { list: async () => [], profiles: async () => [] },
      accounts: { list: async () => [] },
      settings: { get: async () => ({spendCapUsd:25}), setSpendCap: async value => { record('settings', 'setSpendCap', [value]); return value; } },
      demo: { state: async () => ({ on: false, source: 'live' }), set: async on => { record('demo', 'set', [on]); return { on, source: on ? 'fictional' : 'live' }; } },
    };
    window.wanigan = new Proxy(original, { get(target, service) {
      if (!(service in overrides)) return target[service];
      return new Proxy(target[service], { get(api, method) { return overrides[service][method] ?? api[method]; } });
    } });
  });
  await page.goto(rendererURL);
  await page.waitForSelector('.mission-room');
  await page.locator('.space-dock button').first().focus();
  await page.keyboard.press('Meta+,');
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  const choose = async id => {
    await page.locator(`#settings-tab-${id}`).click();
    await page.locator(`#settings-${id}`).waitFor({state:'visible'});
    await page.locator('.pane.set').evaluate(el => el.scrollTop = 0);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const appearance = async theme => {
    if (before) await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
    else {
      await page.evaluate(async t => { await window.wanigan.prefs.setTheme(t); window.dispatchEvent(new CustomEvent('wanigan:prefs-changed')); }, theme);
      await page.waitForFunction(t => document.documentElement.dataset.theme === t, theme);
    }
  };
  for (const theme of ['dark', 'light']) {
    await appearance(theme);
    for (const id of ['agents', 'projects', 'automation', 'connections', 'privacy', 'backup', 'app']) {
      await choose(id);
      assert.equal(await page.locator('.set-tab-panel:visible').count(), 1);
      await page.waitForTimeout(100);
      await page.screenshot({ path: path.join(out, `${id}-${theme}.png`), scale: 'css' });
      measurements.push({ theme, tab: id, ...(await page.locator('.pane.set').evaluate(el => ({width:el.clientWidth, scrollWidth:el.scrollWidth}))) });
    }
  }
  assert.deepEqual(errors, []);
  if (!before) {
    record('all seven categories render exclusively in both themes without renderer errors');
    await page.evaluate(() => window.__settingsCalls = []);
    await choose('agents');
    await page.locator('#anthropic-api-key').fill('fixture-unsaved-key');
    const keyNode = await page.locator('#anthropic-api-key').evaluateHandle(el => el);
    await choose('automation');
    await page.locator('#spend-cap').fill('17.75');
    await choose('agents');
    assert.equal(await page.locator('#anthropic-api-key').inputValue(), 'fixture-unsaved-key');
    assert(await page.locator('#anthropic-api-key').evaluate((el, original) => el === original, keyNode));
    await keyNode.dispose();
    await choose('automation');
    assert.equal(await page.locator('#spend-cap').inputValue(), '17.75');
    assert.deepEqual(await page.evaluate(() => window.__settingsCalls), []);
    await page.locator('[data-section-title="Spending"]').getByRole('button',{name:'Save',exact:true}).click();
    assert.deepEqual(await page.evaluate(() => window.__settingsCalls), [['settings','setSpendCap',17.75]]);
    record('category changes preserve the same mounted credential field and spend-cap draft; only deliberate Save writes the entered cap');

    const search = page.getByRole('searchbox',{name:'Search settings'});
    await search.fill('grok');
    const results = page.locator('.set-search-results');
    assert.equal(await results.getByRole('button',{name:'Grok · xAI Agents',exact:true}).count(), 1);
    await search.press('Enter');
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-section-title') === 'Grok · xAI');
    assert.equal(await page.locator('#settings-agents').isVisible(), true);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-section-title')), 'Grok · xAI');
    assert.equal(await search.inputValue(), '');
    await search.fill('nothing-matches-this-setting');
    assert.match(await results.innerText(), /0 results/);
    await search.press('Escape');
    assert.equal(await results.count(), 0);
    await choose('agents');
    await page.getByRole('navigation',{name:'Agents settings shortcuts'}).getByRole('button',{name:'Accounts',exact:true}).click();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-section-title')), 'Accounts');
    const agentsScroll = await page.locator('#settings-agents').evaluate(el => el.scrollTop);
    assert(agentsScroll > 100);
    const railBefore = await page.locator('.set-directory').boundingBox();
    await choose('app');
    await choose('agents');
    assert.equal(await page.locator('#settings-agents').evaluate(el => el.scrollTop), agentsScroll);
    assert.equal((await page.locator('.set-directory').boundingBox()).y, railBefore.y);
    record('search and section shortcuts reach the exact named control, move keyboard focus, and keep category scroll independent of the fixed directory');

    await page.locator('#settings-tab-agents').focus();
    await page.keyboard.press('End');
    await page.waitForFunction(() => document.activeElement?.id === 'settings-tab-app');
    assert.equal(await page.locator('#settings-tab-app').getAttribute('aria-selected'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'settings-tab-app');
    await page.keyboard.press('Home');
    await page.waitForFunction(() => document.activeElement?.id === 'settings-tab-agents');
    assert.equal(await page.locator('#settings-tab-agents').getAttribute('aria-selected'), 'true');
    record('category tabs retain roving focus and Home/End keyboard navigation');

    await choose('app');
    await page.locator('#settings-app').evaluate(el => el.scrollTop = 0);
    await appearance('dark');
    const themes = page.getByRole('radiogroup',{name:'Colour theme'});
    await page.evaluate(() => window.__holdThemeSave = true);
    await themes.getByRole('radio',{name:'Light',exact:true}).click();
    await page.waitForFunction(() => typeof window.__releaseThemeSave === 'function');
    assert.equal(await themes.getByRole('radio',{name:'Dark',exact:true}).isDisabled(), true);
    assert.match(await page.locator('.theme-gallery-status').innerText(), /Saving/);
    await page.evaluate(() => { window.__holdThemeSave = false; window.__releaseThemeSave(); });
    await page.waitForFunction(() => document.querySelector('.theme-gallery-status')?.textContent.includes('Light appearance is selected'));
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
    await page.evaluate(() => window.__settingsSaveFails = true);
    await themes.getByRole('radio',{name:'Dark',exact:true}).click();
    await page.getByText('Theme was not saved: Fixture disk unavailable',{exact:true}).waitFor();
    assert.equal(await themes.getByRole('radio',{name:'Light',exact:true}).getAttribute('aria-checked'), 'true');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
    await page.evaluate(() => window.__settingsSaveFails = false);
    await themes.getByRole('radio',{name:'Light',exact:true}).focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('.theme-gallery-status')?.textContent.includes('Dark appearance is selected'));
    assert.equal(await themes.getByRole('radio',{name:'Dark',exact:true}).getAttribute('aria-checked'), 'true');
    record('appearance previews use the real preference callback, lock during a pending save, roll back failed saves, and support arrow-key choice');

    const motion = page.getByRole('radiogroup',{name:'Motion',exact:true});
    await motion.getByRole('radio',{name:/Full/}).click();
    await choose('privacy');
    const fullMotion = await page.locator('#settings-privacy').evaluate(el => getComputedStyle(el).animationDuration);
    assert.notEqual(fullMotion, '0s');
    await choose('app');
    await motion.getByRole('radio',{name:/Off/}).click();
    await page.waitForFunction(() => document.documentElement.dataset.motion === 'off');
    await choose('privacy');
    assert.equal(await page.locator('#settings-privacy').evaluate(el => getComputedStyle(el).animationName), 'none');
    await choose('app');
    await motion.getByRole('radio',{name:/Auto/}).click();
    await page.waitForFunction(() => document.documentElement.dataset.motion === 'auto');
    await choose('privacy');
    assert.equal(await page.locator('#settings-privacy').evaluate(el => getComputedStyle(el).animationName), 'none');
    record('full motion gives category transitions a duration; Off and system Reduce Motion suppress them');

    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(820,960));
    await page.waitForFunction(() => window.innerWidth === 820);
    for (const id of ['agents','projects','automation','connections','privacy','backup','app']) {
      await choose(id);
      await page.locator(`#settings-${id}`).evaluate(el => el.scrollTop = 0);
      const size = await page.locator(`#settings-${id}`).evaluate(el => ({width:el.clientWidth,scrollWidth:el.scrollWidth,height:el.clientHeight}));
      assert(size.width > 400 && size.height > 200, `${id} collapsed: ${JSON.stringify(size)}`);
      assert(size.scrollWidth <= size.width+1, `${id} overflows: ${JSON.stringify(size)}`);
      assert.equal(await page.locator('.set-tabs').getAttribute('aria-orientation'), 'horizontal');
      measurements.push({tab:id,width:820,...size});
      for (const theme of ['dark','light']) {
        await appearance(theme);
        await page.screenshot({path:path.join(out,`${id}-narrow-${theme}.png`),scale:'css'});
      }
    }
    assert.equal(await page.locator('.pane.set').evaluate(el => el.scrollWidth <= el.clientWidth+1), true);
    assert.deepEqual(await page.evaluate(() => window.__settingsCalls.filter(call => call[0] === 'demo')), []);
    record('all seven categories fit an 820px desktop window in both themes, with horizontally navigable tabs and no automatic demo switch');
  }
  assert.deepEqual(errors, []);
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ at:new Date().toISOString(), provenance:'Actual Electron renderer; synthetic services; no production operations', checks, measurements, errors }, null, 2)+'\n');
  console.log(JSON.stringify({before,checks,errors}));
} finally { await app.close(); rmSync(dir, {recursive:true, force:true}); }
