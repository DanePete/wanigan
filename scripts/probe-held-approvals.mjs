#!/usr/bin/env node
// A headless row that stopped on a held call: the opt-in when a run starts, the
// held call with its three answers, and the row after an answer. Actual
// renderer, isolated Electron, synthetic services, no real agent calls.
//
//   npm run build && node scripts/probe-held-approvals.mjs [--before] [--out dir]
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), { _electron } = require('playwright-core');
const root = path.resolve(import.meta.dirname, '..'), before = process.argv.includes('--before');
const outArg = process.argv.indexOf('--out');
const out = outArg >= 0 ? path.resolve(process.argv[outArg + 1]) : path.join(root, 'docs/visuals/held-approvals', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-held-'));
writeFileSync(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({
  executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [path.join(dir, 'main.cjs'), `--user-data-dir=${dir}/profile`], env,
});
const checks = [], errors = [];
const record = (text) => { checks.push(text); console.log('✓', text); };
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(STUB);
  await page.addInitScript(() => {
    const api = window.wanigan, now = Date.now();
    window.__calls = [];
    const run = (over) => ({ id: 'r1', name: 'Publish the release notes', model: 'Claude · release', status: 'in_progress', costUsd: 0.42,
      costStatus: 'reported', totalRequests: 2, createdAt: now - 1800000, submittedAt: now - 1800000, endedAt: null, error: null,
      succeeded: 1, failed: 0, blocked: 0, open: 0, awaiting: 1, filesChanged: 3, ...over });
    window.__run = run({});
    const held = { toolUseId: 'toolu_01AbC', toolName: 'Bash', summary: 'npm publish --access public', cliSessionId: '0b1c9a4e-7d7a-4f7e-9d0e-2f1c4a5b6c7d',
      permissionMode: 'acceptEdits', heldAt: now - 120000, answer: null, resumedAt: null };
    const row = (projectId, over) => ({ runId: 'r1', projectId, projectName: projectId === 'p1' ? 'storefront' : 'platform', projectPath: `/example/${projectId}`,
      status: 'succeeded', costUsd: 0.21, costReported: true, durationMs: 180000, exitCode: 0, output: null, error: null, filesChanged: 2,
      worktree: `/example/worktrees/r1/${projectId}`, startedAt: now - 1800000, endedAt: now - 1500000, held: null, hasOutput: false, hasError: false, ...over });
    window.__rows = [row('p1', {}), row('p2', { status: 'awaiting', filesChanged: 1, endedAt: now - 120000, held })];
    window.wanigan = new Proxy(api, { get(target, service) {
      if (service === 'providers') return new Proxy(target.providers, { get(providers, method) {
        if (method === 'list') return async () => (await target.providers.list()).map((p) => ({ ...p, capabilities: { ...p.capabilities, headlessJson: true, headlessBudget: p.id === 'claude', policy: p.id === 'claude' }, launchFields: [] }));
        return providers[method];
      } });
      if (service !== 'headless') return target[service];
      return {
        runs: async () => [structuredClone(window.__run)],
        rows: async () => structuredClone(window.__rows),
        rowDetail: async (runId, projectId) => ({ runId, projectId, output: null, error: null }),
        start: async (input) => { window.__calls.push(['start', input]); throw new Error('Fixture: no run was started.'); },
        cancel: async () => 0,
        answerHeld: async (runId, projectId, decision, note) => {
          window.__calls.push(['answerHeld', runId, projectId, decision, note ?? null]);
          const target = window.__rows.find((r) => r.projectId === projectId);
          target.status = 'pending';
          target.held = { ...target.held, answer: { decision, note: note ?? null, answeredAt: Date.now() } };
          window.__run = { ...window.__run, awaiting: 0, open: 1 };
          return structuredClone(target);
        },
      };
    } });
  });
  const shoot = async (name) => {
    for (const t of ['dark', 'light']) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; }, t);
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(out, `${name}-${t}.png`), scale: 'css' });
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.style.colorScheme = 'dark'; });
  };
  await page.goto(rendererURL); await page.locator('.mission-room').waitFor();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Meta+0');
  await page.getByRole('heading', { name: 'Runs', exact: true }).waitFor();
  const detail = page.locator('.hr-detail');
  await page.locator('.hr-history [data-run-id="r1"]').click();
  await detail.locator('.hr-row').nth(1).waitFor();
  const platform = detail.locator('.hr-row').filter({ hasText: 'platform' });
  await platform.scrollIntoViewIfNeeded();

  if (before) {
    assert.equal(await detail.locator('.hr-held').count(), 0);
    await shoot('held');
    record('before: a row that stopped for approval reads only as its status word, with nothing to answer');
  } else {
    assert.match(await page.locator('.hr-history [data-run-id="r1"]').innerText(), /1 waiting for you/);
    const card = platform.locator('.hr-held');
    await card.waitFor();
    const cardText = (await card.innerText()).replace(/\s+/g, ' ');
    assert.match(cardText, /waiting for you Stopped on a Bash call that needs your approval, 2m ago\./);
    assert.equal(await card.locator('.hr-held-call').innerText(), 'npm publish --access public');
    for (const name of ['Approve and resume', 'Decline and resume', 'Stop this repository']) {
      assert(await card.getByRole('button', { name, exact: true }).isEnabled(), name);
    }
    await shoot('held');
    record('a held row names the tool, shows the call it stopped on and offers approve, decline or stop; the run list counts it as waiting for you');
    await card.getByLabel('Note to the agent (optional)').fill('Publish from CI instead');
    await card.getByRole('button', { name: 'Decline and resume', exact: true }).click();
    await platform.locator('.hr-held-past').waitFor();
    assert.deepEqual((await page.evaluate(() => window.__calls)).filter((c) => c[0] === 'answerHeld'),
      [['answerHeld', 'r1', 'p2', 'deny', 'Publish from CI instead']]);
    assert.match(await platform.locator('.hr-held-past').innerText(), /You declined a held Bash call .* it resumes when a slot is free\./);
    await shoot('answered');
    record('declining sends that row\'s decision and note once, and the row then says what was answered and that it resumes when a slot is free');
  }

  // The opt-in on a new run.
  await page.getByRole('button', { name: 'New run', exact: true }).click();
  const form = page.locator('.hr-compose');
  await form.waitFor();
  const hold = form.getByLabel('hold approvals for me');
  if (before) {
    assert.equal(await hold.count(), 0);
    await form.locator('.hr-launch-footer').scrollIntoViewIfNeeded();
    await shoot('compose');
    record('before: a new run offers worktree isolation and no way to hold calls for approval');
  } else {
    assert.equal(await hold.isChecked(), false, 'holding is off unless chosen');
    await hold.check();
    const hint = form.locator('.hint', { hasText: 'stops that repository and waits here for your answer' });
    await hint.waitFor();
    assert.match(await hint.innerText(), /when it asks for several tools at once, that call is decided by the CLI’s own permission rules instead/);
    await form.locator('.hr-launch-footer').scrollIntoViewIfNeeded();
    await shoot('compose');
    record('holding is off by default, and choosing it says plainly which calls it cannot hold');
  }

  assert.deepEqual(errors, []);
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({
    at: new Date().toISOString(),
    provenance: 'Actual Electron renderer from out/renderer of the checkout this script ran in; synthetic services; no real agent calls',
    mode: before ? 'before' : 'after', checks, errors,
  }, null, 2) + '\n');
} finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
