#!/usr/bin/env node
// A goal's captured plan in its evidence: labelled as the planning agent's
// words, accepted or only proposed. Actual renderer, isolated Electron,
// synthetic services, no real agent calls.
//
//   npm run build && node scripts/probe-goal-plan.mjs [--before] [--out dir]
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), { _electron } = require('playwright-core');
const root = path.resolve(import.meta.dirname, '..'), before = process.argv.includes('--before');
const outArg = process.argv.indexOf('--out');
const out = outArg >= 0 ? path.resolve(process.argv[outArg + 1]) : path.join(root, 'docs/visuals/goal-plan', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-plan-'));
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
    window.__planReads = [];
    const node = (id, kind, title, status, dependsOn = []) => ({ id, docketId: 'g1', kind, title, instructions: title, dependsOn, claimPath: null, status,
      providerId: null, model: null, sessionId: null, worktree: null, startedAt: null, endedAt: status === 'completed' ? now - 3600000 : null,
      detail: null, deferUntil: null, reopenedAt: null, queued: false });
    const docket = () => ({
      id: 'g1', projectId: 'p2', projectName: 'platform', title: 'Idempotent retries', objective: 'Stop duplicate charges.',
      acceptance: ['One charge per idempotency key.', 'A regression test covers the timeout path.'], risk: 'low', budgetUsd: 20, baseCommit: null, status: 'active',
      createdAt: now - 7200000, updatedAt: now - 60000,
      autopilot: { enabled: false, providerId: null, model: null, budgetUsd: 20, spendUsd: 0, spendStatus: 'none', haltedReason: null },
      nodes: [node('n1', 'plan', 'Plan and identify risks', 'completed'), node('n2', 'implement', 'Make retries safe', 'ready', ['n1'])],
      claims: [], checkpoints: [],
      proofs: [
        { id: 'pr1', docketId: 'g1', nodeId: 'n1', kind: 'plan', status: 'recorded', summary: 'Plan accepted in Plan and identify risks (6 lines, edited before acceptance), written by the agent.', createdAt: now - 3700000 },
        { id: 'pr0', docketId: 'g1', nodeId: 'n1', kind: 'plan', status: 'recorded', summary: 'Plan proposed in Plan and identify risks (5 lines), written by the agent.', createdAt: now - 3800000 },
      ],
    });
    const plan = {
      docketId: 'g1', nodeId: 'n1', nodeTitle: 'Plan and identify risks', state: 'accepted', edited: true, truncated: false,
      planFilePath: '/example/home/.claude/plans/idempotent-retries.md', capturedAt: now - 3700000,
      text: '## Idempotent retries\n\n1. Add an `idempotency_key` column to payments, unique per merchant.\n2. On a retried callback, look the key up first and return the stored payment.\n3. Only create a charge when no payment holds the key.\n4. Add a regression test for the timeout-then-retry path.\n5. Log each duplicate that was absorbed, with the key and the order id.',
    };
    window.wanigan = new Proxy(api, { get(target, service) {
      if (service !== 'control') return target[service];
      return new Proxy(target.control, { get(obj, key) {
        if (key === 'list') return async () => { const d = docket(); delete d.nodes; delete d.claims; delete d.proofs; delete d.checkpoints; return [d]; };
        if (key === 'get') return async () => docket();
        if (key === 'plan') return async (id) => { window.__planReads.push(id); return structuredClone(plan); };
        if (['board', 'events', 'outcomes', 'mcpTasks', 'resumeReceipts', 'traces'].includes(key)) return async () => [];
        return obj[key];
      } });
    } });
  });
  const shoot = async (name) => {
    for (const t of ['dark', 'light']) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; }, t);
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(out, `${name}-${t}.png`), scale: 'css' });
    }
  };
  await page.goto(rendererURL); await page.locator('.mission-room').waitFor();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Meta+3');
  await page.getByText('Idempotent retries').first().click().catch(() => {});
  const evidence = page.getByRole('complementary', { name: 'Goal evidence' });
  await evidence.waitFor();
  await evidence.scrollIntoViewIfNeeded();
  if (before) {
    assert.equal(await evidence.locator('.control-plan').count(), 0);
    await shoot('evidence');
    record('before: the plan proofs are one-line summaries, and the plan itself is nowhere on screen');
  } else {
    const planCard = evidence.locator('.control-plan');
    await planCard.waitFor();
    assert.deepEqual(await page.evaluate(() => window.__planReads), ['g1']);
    await planCard.locator('summary').click();
    const text = (await planCard.innerText()).replace(/\s+/g, ' ');
    assert.match(text, /The accepted plan Plan and identify risks · 1h ago · edited before acceptance/);
    assert.match(text, /Written by the planning agent, accepted in its session, and handed to the tasks launched after it\./);
    assert.match(text, /On a retried callback, look the key up first and return the stored payment\./);
    await planCard.scrollIntoViewIfNeeded();
    await shoot('evidence');
    record('the goal\'s evidence shows the accepted plan as the planning agent\'s words, where it was accepted, and that later tasks receive it');
  }
  assert.deepEqual(errors, []);
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({
    at: new Date().toISOString(),
    provenance: 'Actual Electron renderer from out/renderer of the checkout this script ran in; synthetic services; no real agent calls',
    mode: before ? 'before' : 'after', checks, errors,
  }, null, 2) + '\n');
} finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
