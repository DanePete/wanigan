#!/usr/bin/env node
// Settings › Agents: the Codex hook events line, in its three states, and the
// wait and the failed read around them. Actual renderer, isolated Electron,
// synthetic services: no Codex runs, and the answers are the shapes
// src/main/codex-hooks.ts returns.
//
//   npm run build && node scripts/probe-codex-hooks.mjs [--before] [--out dir]
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), { _electron } = require('playwright-core');
const root = path.resolve(import.meta.dirname, '..'), before = process.argv.includes('--before');
const outArg = process.argv.indexOf('--out');
const out = outArg >= 0 ? path.resolve(process.argv[outArg + 1]) : path.join(root, 'docs/visuals/codex-hooks', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-codex-hooks-probe-'));
writeFileSync(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({
  executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [path.join(dir, 'main.cjs'), `--user-data-dir=${dir}/profile`], env,
});

// 14 Sep 2026, 21:04 local: the first event's time, fixed so the sentence is too.
const FIRST_EVENT_AT = new Date(2026, 8, 14, 21, 4).getTime();
const STATES = {
  trusted: { state: 'trusted', version: '0.154.0' },
  observed: { state: 'observed', version: '0.154.0', firstEventAt: FIRST_EVENT_AT },
  unavailable: { state: 'unavailable', version: '0.154.0', reason: 'trust-not-granted', detail: 'Given its own hashes, Codex read Wanigan\'s hooks as: Stop modified.' },
};
const checks = [], errors = [];
const record = (text) => { checks.push(text); console.log('✓', text); };
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(STUB);
  // Which answer this load gets is carried across reloads in sessionStorage:
  // "known" puts it on the capability record detection returns; "check" leaves
  // that empty and answers the explicit check a moment later; "fail" rejects it.
  await page.addInitScript(({ states }) => {
    const original = window.wanigan;
    const mode = sessionStorage.getItem('codexHooksMode') ?? 'known:trusted';
    const [how, name] = mode.split(':');
    window.__checks = [];
    window.wanigan = new Proxy(original, { get(target, service) {
      if (service !== 'providers') return target[service];
      return new Proxy(target.providers, { get(api, method) {
        if (method === 'list') return async () => (await original.providers.list()).map((provider) => provider.harnessId !== 'codex' ? provider : {
          ...provider, path: '/opt/homebrew/bin/codex', version: 'codex-cli 0.154.0',
          capabilities: { ...provider.capabilities, hooks: false, ...(how === 'known' ? { observeOnlyHooks: states[name] } : {}) },
        });
        if (method === 'checkObserveOnlyHooks') return (providerId) => {
          window.__checks.push(providerId);
          return new Promise((resolve, reject) => setTimeout(() => (how === 'fail'
            ? reject(new Error('Codex\'s app-server could not be started: spawn /opt/homebrew/bin/codex EACCES'))
            : resolve(states[name])), 400));
        };
        return api[method];
      } });
    } });
  }, { states: STATES });

  const openAgents = async (mode) => {
    await page.goto(rendererURL);
    await page.evaluate((value) => sessionStorage.setItem('codexHooksMode', value), mode);
    await page.goto(rendererURL);
    await page.locator('.mission-room').waitFor();
    await page.locator('.space-dock button').first().focus();
    await page.keyboard.press('Meta+,');
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
    await page.locator('#settings-tab-agents').click();
    await page.locator('#settings-agents').waitFor({ state: 'visible' });
    const section = page.locator('[data-section-title="Installed agent runtimes"]');
    await section.waitFor();
    return section;
  };
  const shoot = async (locator, name) => {
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; document.documentElement.style.colorScheme = t; }, theme);
      await page.waitForTimeout(150);
      await locator.scrollIntoViewIfNeeded();
      // CSS pixels, so a before and an after taken on screens of different
      // density are the same size and can be compared side by side.
      await locator.screenshot({ path: path.join(out, `${name}-${theme}.png`), scale: 'css' });
    }
  };
  const flat = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();
  /** Text a reader must read is not clipped: every line of it fits its box. */
  const unclipped = (locator) => locator.evaluateAll((nodes) => nodes.every((node) => node.scrollWidth <= node.clientWidth));

  if (before) {
    const section = await openAgents('known:trusted');
    assert.match(await flat(section), /Codex/);
    assert.equal(await section.locator('.set-runtime-hooks').count(), 0);
    await shoot(section, 'runtimes');
    record('before: the Codex runtime row names its version and path, and nothing says whether Codex hook events reach Wanigan');
  } else {
    for (const [name, sentence, mark] of [
      ['trusted', 'injected and trusted on 0.154.0; no event has arrived yet from a real session', '◐'],
      ['observed', `observed on 0.154.0 — first event ${new Date(FIRST_EVENT_AT).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`, '✓'],
      ['unavailable', 'not available: Codex did not trust Wanigan\'s hooks by the hashes it reported', '✕'],
    ]) {
      const section = await openAgents(`known:${name}`);
      const line = section.locator('.set-runtime-hooks');
      assert.equal(await line.count(), 1, `${name}: exactly one hook line, under the one Codex runtime`);
      const row = line.locator('xpath=preceding-sibling::div[1]');
      assert.match(await flat(row), /^Codex codex-cli 0\.154\.0 \/opt\/homebrew\/bin\/codex$/);
      assert.equal(await line.getAttribute('data-codex-hooks'), name);
      const text = await flat(line);
      assert.ok(text.includes(sentence), `${name}: "${text}" should include "${sentence}"`);
      // The glyph, then the sentence, which opens with the state's own word.
      assert.ok(text.startsWith(`Hook events ${mark} ${sentence}`), `${name}: "${text}" should open with the glyph and the sentence`);
      assert.match(text, /They print nothing and decide nothing, so the trust gate does not cover Codex\./);
      if (name === 'unavailable') assert.match(text, /Given its own hashes, Codex read Wanigan's hooks as: Stop modified\./);
      else assert.doesNotMatch(text, /not available/);
      if (name === 'trusted') assert.doesNotMatch(text, /observed|first event/);
      assert.equal(await page.evaluate(() => window.__checks.length), 0, `${name}: a known answer is not asked for again`);
      assert.ok(await unclipped(line.locator('.set-runtime-hooks-text, .set-runtime-hooks-note, .set-runtime-hooks-detail')), `${name}: no clipped text`);
      await page.setViewportSize({ width: 560, height: 1000 });
      assert.ok(await unclipped(line.locator('.set-runtime-hooks-text, .set-runtime-hooks-note, .set-runtime-hooks-detail')), `${name}: no clipped text at a narrow width`);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await shoot(section, name);
      record(`${name}: under the Codex runtime row, "${mark}" and then "${sentence}", then the sentence that the trust gate does not cover Codex; nothing clipped at 1440 or 560 px`);
    }

    const checking = await openAgents('check:trusted');
    const waiting = checking.locator('.set-runtime-hooks');
    assert.match(await flat(waiting), /^Hook events … checking asking Codex's app-server whether it trusts Wanigan's hooks, with a throwaway home and no model call/);
    await waiting.locator('[data-codex-hooks="trusted"]').or(checking.locator('.set-runtime-hooks[data-codex-hooks="trusted"]')).waitFor();
    assert.match(await flat(checking.locator('.set-runtime-hooks')), /injected and trusted on 0\.154\.0; no event has arrived yet from a real session/);
    assert.deepEqual(await page.evaluate(() => window.__checks), ['codex']);
    record('not yet asked: the line says it is checking, asks main once with the Codex profile id (never a path), and then shows the answer');

    const failed = await openAgents('fail:trusted');
    await failed.locator('.set-runtime-hooks[data-codex-hooks="err"]').waitFor();
    const failure = await flat(failed.locator('.set-runtime-hooks'));
    assert.match(failure, /^Hook events \? could not read Codex's app-server could not be started/);
    assert.doesNotMatch(failure, /trusted|observed|not available/);
    await shoot(failed.locator('.set-runtime-hooks'), 'could-not-read');
    record('a failed check reads "could not read" with the error, and is never drawn as trusted, observed or not available');
  }
  assert.deepEqual(errors, []);
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({
    at: new Date().toISOString(),
    provenance: 'Actual Electron renderer from out/renderer of the checkout this script ran in; synthetic services; no Codex or agent run',
    mode: before ? 'before' : 'after', checks, errors,
  }, null, 2) + '\n');
} finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
