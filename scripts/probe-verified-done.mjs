#!/usr/bin/env node
// Verified done in Control: a task's gate state beside Mark complete, the
// failure and what was handed back, the weak-oracle flags, and the goal's
// choice of what happens when an agent stops. Actual renderer, isolated
// Electron, synthetic services, no real agent calls.
//
//   npm run build && node scripts/probe-verified-done.mjs [--before] [--out dir]
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), { _electron } = require('playwright-core');
const root = path.resolve(import.meta.dirname, '..'), before = process.argv.includes('--before');
const outArg = process.argv.indexOf('--out');
const out = outArg >= 0 ? path.resolve(process.argv[outArg + 1]) : path.join(root, 'docs/visuals/verified-done', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-verified-'));
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
    window.__gateSets = [];
    let gate = { onStop: true, returnFailures: true };
    const node = (id, kind, title, status, dependsOn = [], over = {}) => ({ id, docketId: 'g1', kind, title, instructions: title, dependsOn, claimPath: null, status,
      providerId: null, model: null, sessionId: null, worktree: null, startedAt: null, endedAt: status === 'completed' ? now - 3600000 : null,
      detail: null, deferUntil: null, reopenedAt: null, gateRunningSince: null, gateReturns: 0, queued: false, ...over });
    const failure = [
      'not ok 3 - retries once without a second charge',
      '  expected: 1',
      '  actual: 2',
      '  at test/payments/retry.test.ts:14:5',
      '…',
      '# pass 41',
      '# fail 1',
    ].join('\n');
    const docket = () => ({
      id: 'g1', projectId: 'p2', projectName: 'platform', title: 'Charge once on retry', objective: 'A retried payment callback must not charge the customer twice.',
      acceptance: ['One charge per idempotency key.', 'The checkout suite passes.'], risk: 'elevated', budgetUsd: 20, baseCommit: '9d2c41e7', status: 'executing',
      createdAt: now - 7200000, updatedAt: now - 60000,
      autopilot: { enabled: false, providerId: null, model: null, budgetUsd: 20, spendUsd: 1.84, spendStatus: 'reported', haltedReason: null, haltedAt: null },
      gate: { ...gate }, reviewCommands: 1,
      nodes: [
        node('n1', 'plan', 'Plan and identify risks', 'completed'),
        node('n2', 'implement', 'Make retries idempotent', 'running', ['n1'], { providerId: 'claude', sessionId: 's1', startedAt: now - 1500000, gateReturns: 1 }),
        node('n3', 'verify', 'Verify the checkout suite', 'blocked', ['n2']),
        node('n4', 'review', 'Review and decide', 'blocked', ['n3']),
      ],
      claims: [], checkpoints: [],
      proofs: [
        { id: 'pr2', docketId: 'g1', nodeId: 'n2', kind: 'test', status: 'failed', createdAt: now - 240000,
          summary: "Review gate failed after 1 command(s) in this goal's project checkout, run when its agent stopped.",
          gate: {
            trigger: 'stop', tree: '4f1c9a27be03d56e8a1f0c2b9d4e7a6c5b3f2e10',
            oracle: { testFiles: 1, codeFiles: 2, flags: [
              { kind: 'tests-edited-with-code', testFiles: 1, codeFiles: 2 },
              { kind: 'test-without-assertion', path: 'test/payments/retry-timeout.test.ts' },
            ] },
            oracleNote: null,
            failure: { command: 'npm test', exitCode: 1, excerpt: failure, cut: false },
            handBack: { sent: true, attempt: 1, sentence: 'Typed back into the session as hand-back 1 of 2: the failing command and 6 lines of its output.' },
          } },
        { id: 'pr1', docketId: 'g1', nodeId: 'n1', kind: 'review', status: 'recorded', summary: 'Plan and identify risks completed.', createdAt: now - 3600000 },
      ],
    });
    window.wanigan = new Proxy(api, { get(target, service) {
      if (service !== 'control') return target[service];
      return new Proxy(target.control, { get(obj, key) {
        if (key === 'list') return async () => { const d = docket(); delete d.nodes; delete d.claims; delete d.proofs; delete d.checkpoints; return [d]; };
        if (key === 'get') return async () => docket();
        if (key === 'setGate') return async (id, input) => { window.__gateSets.push([id, input]); gate = { onStop: input.onStop, returnFailures: input.onStop && input.returnFailures }; return docket(); };
        if (key === 'plan') return async () => null;
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
  await page.getByText('Charge once on retry').first().click().catch(() => {});
  await page.locator('[data-node-id="n2"]').click();
  const task = page.locator('#control-task-panel');
  await task.getByRole('heading', { name: 'Make retries idempotent' }).waitFor();
  const complete = task.getByRole('button', { name: 'Mark complete' });
  if (before) {
    assert.equal(await task.locator('.control-task-gate').count(), 0);
    assert.equal(await complete.isDisabled(), false);
    assert.equal(await task.getByRole('button', { name: 'Run review gate' }).count(), 0);
    await task.scrollIntoViewIfNeeded();
    await shoot('task');
    await complete.scrollIntoViewIfNeeded();
    await shoot('task-actions');
    record('before: the implementation task offers Mark complete on the agent\'s word, and the gate result is a one-line summary in the evidence column');
  } else {
    const gateState = task.locator('.control-task-gate');
    await gateState.waitFor();
    const text = (await gateState.innerText()).replace(/\s+/g, ' ');
    assert.match(text, /Not verified · gate failed 4m ago · run when the agent stopped · tree 4f1c9a2/);
    assert.match(text, /Typed back into the session as hand-back 1 of 2/);
    assert.match(text, /Read the tests before trusting this result\./);
    assert.match(text, /Tests changed in the same change as the code \(1 test file, 2 code files\)/);
    assert.match(text, /test\/payments\/retry-timeout\.test\.ts gained test lines with no assertion Wanigan recognises/);
    assert.match(text, /A heuristic read from the diff since this goal’s base commit, not a failure\./);
    await gateState.locator('summary').click();
    assert.match(await gateState.locator('pre').innerText(), /not ok 3 - retries once without a second charge/);
    assert.equal(await complete.isDisabled(), true);
    assert.match((await task.innerText()).replace(/\s+/g, ' '), /This goal completes an implementation task only once a review gate has passed on it\./);
    assert.equal(await task.getByRole('button', { name: 'Run review gate' }).isDisabled(), false);
    const recordLine = page.locator('.control-record-gate').first();
    assert.equal((await recordLine.innerText()).trim(), 'Run when the agent stopped · tree 4f1c9a2 · 2 test flags to read · handed back (1 of 2)');
    await task.scrollIntoViewIfNeeded();
    await shoot('task');
    await complete.scrollIntoViewIfNeeded();
    await shoot('task-actions');
    record('the task says it is not verified because its gate failed, shows the failure and what was typed back, flags the tests, and holds Mark complete with the reason beside it');
  }
  const execution = page.locator('details.control-execution');
  await execution.locator('summary').click();
  if (before) {
    assert.equal(await page.locator('.control-gate').count(), 0);
    await page.locator('.control-autopilot').scrollIntoViewIfNeeded();
    await shoot('execution');
    record('before: Execution & spending has no say over what happens when an agent stops');
  } else {
    const card = page.locator('.control-gate');
    await card.scrollIntoViewIfNeeded();
    const text = (await card.innerText()).replace(/\s+/g, ' ');
    assert.match(text, /Verified done/);
    assert.match(text, /A failure is also typed back into the session that stopped\./);
    assert.match(text, /at most 2 times each time a task starts, and only while that session still waits where it stopped/);
    assert.match(text, /spends tokens; none is sent once this goal’s reported spend reaches its cap/);
    assert.match(text, /If the agent stopped to ask you something, a hand-back answers it with the failure instead\./);
    assert.equal(await card.getByRole('button', { name: 'Run the gate, hand failures back' }).getAttribute('aria-pressed'), 'true');
    await card.getByRole('button', { name: 'Run the gate', exact: true }).click();
    await page.waitForFunction(() => window.__gateSets.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__gateSets), [['g1', { onStop: true, returnFailures: false }]]);
    await card.getByText('A failure waits here for you.').waitFor();
    await page.getByText('Hand-back turned off. The gate still runs when an agent stops, and a failure waits here for you.').waitFor();
    assert.equal(await card.getByRole('button', { name: 'Run the gate', exact: true }).getAttribute('aria-pressed'), 'true');
    await card.scrollIntoViewIfNeeded();
    await shoot('execution');
    record('the goal\'s gate choice states what each option does and what hand-back costs before it is chosen, and choosing Run the gate stores the gate with hand-back off');
  }
  assert.deepEqual(errors, []);
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({
    at: new Date().toISOString(),
    provenance: 'Actual Electron renderer from out/renderer of the checkout this script ran in; synthetic services; no real agent calls',
    mode: before ? 'before' : 'after', checks, errors,
  }, null, 2) + '\n');
} finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
