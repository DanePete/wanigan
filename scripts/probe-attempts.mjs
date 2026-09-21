#!/usr/bin/env node
// Attempts in Runs: a best-of-N comparison with a passed, a failed and an
// unreported-cost attempt, keeping one and cleaning up around it, a paired
// bench with an arm that never passed, the start form behind its confirmation,
// and a read that failed. Actual renderer, isolated Electron, synthetic
// services, no real agent calls. The report figures are computed by
// src/shared/attempts.ts itself, so the fixtures cannot disagree with main.
//
//   npm run build && node scripts/probe-attempts.mjs [--before] [--out dir]
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), { _electron } = require('playwright-core');
const root = path.resolve(import.meta.dirname, '..'), before = process.argv.includes('--before');
const outArg = process.argv.indexOf('--out');
const out = outArg >= 0 ? path.resolve(process.argv[outArg + 1]) : path.join(root, 'docs/visuals/attempts', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });

/* ── fixtures, computed by the real pure core ─────────────────────────── */
// The before build has no attempts module, and needs no fixtures.
const shared = before ? null : await import(pathToFileURL(path.join(root, 'src/shared/attempts.ts')).href);
const fixtures = (() => {
  if (!shared) return null;
  const now = Date.now();
  const COMMIT = '9d2c41e7b1a04c55e0f3b6a2d8c9e1f4a7b30c52';
  const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
  const prompts = {
    best: 'Make a retried payment callback charge the customer once.\nRun the checkout suite before you stop.',
    bench: 'Fix the flaky checkout retry test without weakening its assertions.\nRun the checkout suite before you stop.',
  };
  const claude = { providerId: 'claude', model: 'claude-opus-5', effort: 'high', label: 'Claude Code', profileFingerprint: 'fp-claude', budgetFlag: true };
  const codex = { providerId: 'codex', model: null, effort: null, label: 'Codex', profileFingerprint: 'fp-codex', budgetFlag: false };
  let n = 0;
  const attempt = (setId, arm, armIndex, repeatIndex, over) => {
    const promptSha256 = sha(setId.endsWith('b01') ? prompts.best : prompts.bench);
    n += 1;
    const id = `att_${String(n).padStart(16, '0')}`;
    return {
      id, setId, armIndex, repeatIndex, headlessRunId: `run_20260914_1400${String(n).padStart(2, '0')}_ab${n}`,
      status: 'succeeded', liveStatus: null, worktree: `/example/worktrees/storefront-a${n}`, worktreeOnDisk: true, baseHead: COMMIT,
      exitCode: 0, durationMs: 300_000 + n * 41_000, costUsd: 0.4, costReported: true,
      tokens: { input: 18_400 + n * 900, output: 3_100 + n * 70, cacheRead: 212_000, cacheWrite: 9_800 },
      filesChanged: 2, gate: 'passed', gateNote: "2 review commands passed in this attempt's worktree.", reviewRunId: `rev_${n}`,
      tree: `4b825dc642cb6eb9a060e54bf8d69288fbee49${String(n).padStart(2, '0')}`,
      oracle: { reading: { testFiles: 0, codeFiles: 2, flags: [] }, note: null },
      startedAt: now - 3_600_000 + n * 60_000, endedAt: now - 2_400_000 + n * 60_000, error: null,
      launch: { providerId: arm.providerId, profileFingerprint: arm.profileFingerprint, model: arm.model, effort: arm.effort, promptSha256 },
      ...over,
    };
  };
  const detailOf = (summary, prompt, rows, cleanup) => {
    const promptSha256 = sha(prompt);
    const report = shared.attemptReport(
      { baseCommit: COMMIT, promptSha256, arms: summary.arms, repeats: summary.repeats },
      rows.map((row) => ({ armIndex: row.armIndex, status: row.status, gate: row.gate, baseHead: row.baseHead, launch: row.launch, costUsd: row.costUsd, costReported: row.costReported, filesChanged: row.filesChanged })),
    );
    return { ...summary, open: report.open, passes: rows.filter((row) => row.gate === 'passed').length, prompt, promptSha256, holdForApproval: false, rows, report, cleanup };
  };

  const bestId = 'aset_0000000000000b01';
  const best = { id: bestId, projectId: 'p1', projectName: 'storefront', kind: 'best-of-n', title: 'Make a retried payment callback charge the customer once.',
    baseCommit: COMMIT, arms: [claude], repeats: 3, budgetUsd: 2, timeoutMs: 900_000, status: 'finished', attempts: 3, keptAttemptId: null, decidedAt: null, createdAt: now - 3_700_000 };
  const bestRows = [
    attempt(bestId, claude, 0, 0, {
      costUsd: 0.42, filesChanged: 3,
      oracle: { reading: { testFiles: 1, codeFiles: 2, flags: [
        { kind: 'tests-edited-with-code', testFiles: 1, codeFiles: 2 },
        { kind: 'test-without-assertion', path: 'test/payments/retry.test.ts' },
      ] }, note: null },
    }),
    attempt(bestId, claude, 0, 1, { costUsd: 0.31, filesChanged: 1, gate: 'failed', gateNote: 'Failed at `npm test` (exit 1) after 1 of 2.' }),
    attempt(bestId, claude, 0, 2, { costUsd: null, costReported: false, tokens: null, filesChanged: 2 }),
  ];
  const bestDetail = detailOf(best, prompts.best, bestRows, {
    allowed: false, reason: 'Keep an attempt first. Removing worktrees before choosing would remove every candidate.',
    worktrees: bestRows.map((row) => ({ attemptId: row.id, path: row.worktree })),
  });

  const benchId = 'aset_0000000000000b02';
  const bench = { id: benchId, projectId: 'p1', projectName: 'storefront', kind: 'bench', title: 'Fix the flaky checkout retry test without weakening its assertions.',
    baseCommit: COMMIT, arms: [claude, codex], repeats: 3, budgetUsd: 2, timeoutMs: 900_000, status: 'finished', attempts: 6, keptAttemptId: null, decidedAt: null, createdAt: now - 1_800_000 };
  const benchRows = [
    attempt(benchId, claude, 0, 0, { costUsd: 0.55 }),
    attempt(benchId, codex, 1, 0, { costUsd: null, costReported: false, gate: 'failed', gateNote: 'Failed at `npm test` (exit 1) after 1 of 2.' }),
    attempt(benchId, claude, 0, 1, { costUsd: 0.48, gate: 'failed', gateNote: 'Failed at `npm test` (exit 1) after 1 of 2.' }),
    attempt(benchId, codex, 1, 1, { costUsd: null, costReported: false, gate: 'failed', gateNote: 'Failed at `npm run lint` (exit 2) after 2 of 2.' }),
    attempt(benchId, claude, 0, 2, { costUsd: 0.61 }),
    attempt(benchId, codex, 1, 2, { costUsd: null, costReported: false, gate: 'unavailable', tree: null, oracle: null,
      gateNote: "This attempt's worktree is no longer on disk (/example/worktrees/storefront-a9), so there is no tree to gate." }),
  ];
  const benchDetail = detailOf(bench, prompts.bench, benchRows, {
    allowed: true, reason: null, worktrees: benchRows.map((row) => ({ attemptId: row.id, path: row.worktree })),
  });
  const summaryOf = (detail) => {
    const { prompt: _p, promptSha256: _s, holdForApproval: _h, rows: _r, report: _rep, cleanup: _c, ...summary } = detail;
    return summary;
  };
  return { sets: [summaryOf(benchDetail), summaryOf(bestDetail)], details: { [bestId]: bestDetail, [benchId]: benchDetail }, bestId, benchId };
})();

const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-attempts-probe-'));
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
  await page.addInitScript((fx) => {
    const api = window.wanigan, now = Date.now();
    window.__calls = [];
    window.__fx = fx;
    const run = { id: 'r1', name: 'Nightly dependency audit', model: 'Claude Code', status: 'ended', costUsd: 1.26, costStatus: 'reported', totalRequests: 2,
      createdAt: now - 7_200_000, submittedAt: now - 7_200_000, endedAt: now - 6_000_000, error: null, succeeded: 2, failed: 0, blocked: 0, open: 0, awaiting: 0, filesChanged: 4 };
    const row = (projectId, name) => ({ runId: 'r1', projectId, projectName: name, projectPath: `/example/${name}`, status: 'succeeded', costUsd: 0.63, costReported: true,
      durationMs: 600_000, exitCode: 0, output: null, error: null, filesChanged: 2, worktree: null, startedAt: now - 7_200_000, endedAt: now - 6_600_000, held: null, hasOutput: false, hasError: false });
    window.wanigan = new Proxy(api, { get(target, service) {
      if (service === 'providers') return new Proxy(target.providers, { get(providers, method) {
        if (method === 'list') return async () => (await target.providers.list()).map((p) => ({ ...p, capabilities: { ...p.capabilities, headlessJson: true, headlessBudget: p.id === 'claude', policy: true }, launchFields: [] }));
        return providers[method];
      } });
      if (service === 'headless') {
        return {
          runs: async () => [structuredClone(run)], rows: async () => [row('p1', 'storefront'), row('p2', 'platform')],
          rowDetail: async (runId, projectId) => ({ runId, projectId, output: null, error: null }),
          start: async () => { throw new Error('Fixture: no run was started.'); }, cancel: async () => 0, answerHeld: async () => { throw new Error('Fixture.'); },
        };
      }
      if (service !== 'attempts') return target[service];
      return {
        sets: async () => { if (window.__failSets) throw new Error('database is locked'); return structuredClone(window.__fx.sets); },
        set: async (setId) => {
          if (window.__failDetail === setId) throw new Error('database is locked');
          const detail = window.__fx.details[setId];
          if (!detail) throw new Error('That attempt set is no longer recorded.');
          return structuredClone(detail);
        },
        start: async (input) => { window.__calls.push(['start', input]); throw new Error('Fixture: no attempt set was started.'); },
        keep: async (setId, attemptId) => {
          window.__calls.push(['keep', setId, attemptId]);
          const detail = window.__fx.details[setId];
          detail.keptAttemptId = attemptId; detail.decidedAt = Date.now();
          detail.cleanup = { allowed: true, reason: null, worktrees: detail.rows.filter((r) => r.id !== attemptId).map((r) => ({ attemptId: r.id, path: r.worktree })) };
          return structuredClone(detail);
        },
        removeOthers: async (setId) => {
          window.__calls.push(['removeOthers', setId]);
          const detail = window.__fx.details[setId];
          const [kept, removed] = detail.cleanup.worktrees;
          detail.rows.find((r) => r.id === removed.attemptId).worktreeOnDisk = false;
          detail.cleanup = { allowed: true, reason: null, worktrees: [kept] };
          return { setId, results: [
            { attemptId: kept.attemptId, path: kept.path, outcome: 'kept', detail: 'Kept: 1 uncommitted file in it would have been deleted, and they exist nowhere else.' },
            { attemptId: removed.attemptId, path: removed.path, outcome: 'removed', detail: `Removed the worktree at ${removed.path}. Branch wanigan/attempt-3-of-3 is kept — delete it yourself when you are sure.` },
          ] };
        },
      };
    } });
  }, fixtures);

  const shoot = async (name) => {
    for (const t of ['dark', 'light']) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; }, t);
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(out, `${name}-${t}.png`), scale: 'css' });
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.style.colorScheme = 'dark'; });
  };
  /** Text a reader must read is not clipped by its box. */
  const unclipped = async (locator, what) => {
    const clipped = await locator.evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent.slice(0, 80)));
    assert.deepEqual(clipped, [], `${what} is clipped`);
  };
  const openRuns = async () => {
    await page.goto(rendererURL); await page.locator('.mission-room').waitFor();
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Meta+0');
    await page.getByRole('heading', { name: 'Runs', exact: true }).waitFor();
    await page.locator('.hr-history [data-run-id="r1"]').waitFor();
  };

  await openRuns();
  const areaSwitch = page.getByRole('group', { name: 'Runs area' });
  if (before) {
    assert.equal(await areaSwitch.count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Attempts', exact: true }).count(), 0);
    await shoot('runs');
    record('before: Runs lists headless fan-outs only; there is no way to run one task several times from one commit or compare the results');
  } else {
    assert.equal(await areaSwitch.getByRole('button', { name: 'Repository runs', exact: true }).getAttribute('aria-pressed'), 'true');
    await shoot('runs');
    record('Runs opens on headless runs as before, with a switch to Attempts beside New run');

    /* ── best of N ─────────────────────────────────────────────────── */
    await areaSwitch.getByRole('button', { name: 'Compare attempts', exact: true }).click();
    const history = page.locator('.at-history');
    await history.locator(`[data-set-id="${fixtures.bestId}"]`).waitFor();
    assert.equal(await history.locator('.at-set').count(), 2);
    await history.locator(`[data-set-id="${fixtures.bestId}"]`).click();
    const detail = page.locator('.at-detail');
    const compare = detail.locator('.at-compare');
    await compare.locator('tbody tr').nth(2).waitFor();
    const rows = compare.locator('tbody tr');
    const cells = async (i) => (await rows.nth(i).locator('th, td').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    const [r1, r2, r3] = [await cells(0), await cells(1), await cells(2)];
    assert.match(r1[1], /^✓\s*passed 2 review commands passed/); assert.match(r2[1], /^✕\s*failed Failed at `npm test` \(exit 1\) after 1 of 2\./);
    assert.match(r3[1], /^✓\s*passed/);
    assert.equal(r1[2], '3'); assert.equal(r2[2], '1');
    assert.match(r1[3], /^\$0\.42 /); assert.match(r2[3], /^\$0\.31 /);
    assert.match(r3[3], /^not reported no token counts reported$/);
    assert.match(r1[4], /^\d+m \d{2}s$/);
    assert.match(r1[5], /Tests changed in the same change as the code \(1 test file, 2 code files\)/);
    assert.match(r1[5], /test\/payments\/retry\.test\.ts gained test lines with no assertion Wanigan recognises/);
    assert.equal(r2[5], 'none flagged');
    assert.doesNotMatch(await detail.innerText(), /\$0\.00/);
    assert.match(await detail.locator('.at-stats').innerText(), /≥ \$0\.73[\s\S]*2 of 3 reported · a floor/);
    assert.match(await detail.locator('.at-cleanup').innerText(), /Keep an attempt first\./);
    for (let i = 0; i < 3; i++) assert(await rows.nth(i).getByRole('button', { name: 'Keep this attempt' }).isEnabled());
    await unclipped(detail.locator('.at-title h2, .at-attempt, .at-gate-note, .at-flags li'), 'best-of-N text');
    await shoot('best-of-n');
    record('best of N compares each attempt by gate, files, cost, duration and oracle flags; the unreported cost reads "not reported", no $0.00 appears, and removal waits for a kept attempt');

    await rows.nth(0).getByRole('button', { name: 'Keep this attempt' }).click();
    await rows.nth(0).locator('.mark', { hasText: /^✓\s*kept$/ }).waitFor();
    assert.equal(await rows.nth(1).getByRole('button', { name: 'Keep this attempt' }).count(), 1, 'the other attempts can still be chosen instead');
    const cleanupButton = detail.getByRole('button', { name: 'Remove the other attempts’ worktrees…' });
    await cleanupButton.click();
    const confirm = detail.locator('.at-cleanup .confirm-note');
    await confirm.waitFor();
    assert.match(await confirm.innerText(), /Remove 2 worktrees, keeping the attempt you kept\?/);
    assert.deepEqual(await confirm.locator('.at-paths li').allInnerTexts(), ['/example/worktrees/storefront-a2', '/example/worktrees/storefront-a3']);
    assert.match(await confirm.innerText(), /without force, so one holding uncommitted work is kept and reported\. Branches are kept\. Nothing is merged\./);
    await confirm.getByRole('button', { name: 'Remove worktrees', exact: true }).click();
    const results = detail.locator('.at-results li');
    await results.nth(1).waitFor();
    const said = (await results.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    assert.match(said[0], /^■\s*kept \/example\/worktrees\/storefront-a2 Kept: 1 uncommitted file/);
    assert.match(said[1], /^✓\s*removed \/example\/worktrees\/storefront-a3 Removed the worktree/);
    const calls = await page.evaluate(() => window.__calls);
    assert.deepEqual(calls.filter((c) => c[0] !== 'start'), [['keep', fixtures.bestId, fixtures.details[fixtures.bestId].rows[0].id], ['removeOthers', fixtures.bestId]]);
    await detail.locator('.at-cleanup').scrollIntoViewIfNeeded();
    await shoot('keep-and-clean-up');
    record('Keep records one decision; the cleanup lists the other worktrees before removing, and reports the one it kept for uncommitted work beside the one it removed');

    /* ── the paired bench ──────────────────────────────────────────── */
    await history.locator(`[data-set-id="${fixtures.benchId}"]`).click();
    const report = detail.locator('.at-report');
    await report.waitFor();
    const heads = (await report.locator('thead th').allInnerTexts()).map((t) => t.trim());
    assert.deepEqual(heads, ['Arm', 'Trials', 'Passed', 'pass@1', 'pass@3 · estimator', 'pass^3 · estimator', 'Cost per solved task']);
    const arm = async (i) => (await report.locator('tbody tr').nth(i).locator('th, td').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    const [claudeRow, codexRow] = [await arm(0), await arm(1)];
    assert.deepEqual(claudeRow.slice(0, 6), ['Claude Code · claude-opus-5 · high', '3', '2', '66.7%', '100.0%', '0.0%']);
    assert.match(claudeRow[6], /^\$0\.82 3 of 3 reported$/);
    assert.deepEqual(codexRow.slice(0, 6), ['Codex', '3', '0', '0.0%', '0.0%', '0.0%']);
    assert.match(codexRow[6], /^— No trial reported a cost, so there is no figure\. That is not the same as costing nothing\. · 0 of 3 reported$/);
    const verdict = (await report.locator('.at-verdict').innerText()).replace(/\s+/g, ' ');
    assert.match(verdict, /Evidence ~\s*correlation The gate could not run for 1 trial\./);
    assert.match(verdict, /Lead Claude Code · claude-opus-5 · high leads: 2 of 3 passed, against 0 of 3 for Codex\. A lead of 2 over 3 paired trials is more than √3 ≈ 1\.7/);
    assert.match(await report.locator('.at-note').first().innerText(), /unbiased estimator over the trials run, not a known per-trial rate/);
    await unclipped(report.locator('.at-reasons li, .at-lead, .at-note, .at-figure small'), 'bench report text');
    await shoot('bench');
    record('the bench reports n, passes, pass@1, pass@k and pass^k with the form named, cost per solved task with n of K reported, and an arm with no passes as measured zeros with no cost figure');
    record('the evidence label and the lead each carry their reason in words: correlation because one gate could not run, and a lead of 2 over 3 named past √3');

    /* ── the start form ────────────────────────────────────────────── */
    await page.getByRole('button', { name: 'New attempt set', exact: true }).click();
    const form = page.locator('.at-compose');
    await form.waitFor();
    assert.match(await form.locator('.at-ceiling').innerText(), /Choose the project the attempts run in\./);
    assert.equal(await form.getByRole('button', { name: /^Start \d+ attempts?…$/ }).count(), 0);
    await form.getByLabel('Project').selectOption('p1');
    await form.getByLabel('Task for every attempt').fill('Make a retried payment callback charge the customer once.');
    await form.getByRole('button', { name: 'Paired bench', exact: true }).click();
    await form.getByLabel('Arm 1 provider').selectOption('claude');
    await form.getByLabel('Arm 1 model').fill('claude-opus-5');
    await form.getByLabel('Arm 2 provider').selectOption('codex');
    await form.getByLabel('Repeats per arm').selectOption('3');
    assert.equal(await form.locator('.at-ceiling').innerText(),
      'Up to $6.00 across the 3 attempts whose CLI takes a budget flag, $2.00 each. Codex takes no budget flag, so its 3 attempts are bounded by the 15-minute timeout, not by cost.');
    await form.getByLabel('Budget per attempt · USD').fill('0');
    assert.match(await form.locator('.at-ceiling').innerText(), /These 6 attempts run with nobody at the keyboard, so each needs a budget above \$0\. The set's ceiling is 6 × that budget/);
    await form.getByLabel('Budget per attempt · USD').fill('2');
    await form.getByRole('button', { name: 'Start 6 attempts…', exact: true }).click();
    const startConfirm = form.locator('.confirm-note');
    await startConfirm.waitFor();
    assert.match((await startConfirm.innerText()).replace(/\s+/g, ' '), /Starting lets 6 agents spend money with nobody watching\. Each works on this task in its own worktree in storefront, cut from the commit its checkout is on right now/);
    await shoot('start');
    record('the start form states the ceiling in words, names the arm whose CLI takes no budget flag, refuses a zero budget by naming the ceiling, and puts Start behind a confirmation');
    await startConfirm.getByRole('button', { name: 'Start attempts', exact: true }).click();
    await page.locator('.note.tone-error', { hasText: 'Fixture: no attempt set was started.' }).waitFor();
    const started = (await page.evaluate(() => window.__calls)).find((c) => c[0] === 'start')[1];
    assert.deepEqual({ kind: started.kind, projectId: started.projectId, repeats: started.repeats, budgetUsd: started.budgetUsd, timeoutMs: started.timeoutMs, arms: started.arms },
      { kind: 'bench', projectId: 'p1', repeats: 3, budgetUsd: 2, timeoutMs: 900_000, arms: [{ providerId: 'claude', model: 'claude-opus-5', effort: null }, { providerId: 'codex', model: null, effort: null }] });
    record('confirming sends one start with the planned arms, repeats, budget and timeout, and a refusal from main is shown as an error');

    /* ── reads that fail ───────────────────────────────────────────── */
    await page.addInitScript(() => { window.__failSets = true; });
    await openRuns();
    await page.getByRole('group', { name: 'Runs area' }).getByRole('button', { name: 'Compare attempts', exact: true }).click();
    await page.locator('.at-history .empty.could-not-read').waitFor();
    assert.match(await page.locator('.at-history').innerText(), /Could not read attempt sets\s+database is locked/);
    assert.doesNotMatch(await page.locator('.at-history').innerText(), /No attempt sets yet/);
    assert.match(await page.locator('.at-detail').innerText(), /No set to inspect/);
    await shoot('unreadable');
    record('a failed read of the set list renders as a failure with the error and a retry, never as an empty list');
    await page.evaluate((id) => { window.__failSets = false; window.__failDetail = id; }, fixtures.bestId);
    await page.locator('.at-history').getByRole('button', { name: 'Try again', exact: true }).click();
    await page.locator(`.at-history [data-set-id="${fixtures.bestId}"]`).click();
    await page.locator('.at-detail .empty.could-not-read').waitFor();
    assert.match(await page.locator('.at-detail').innerText(), /Could not read this set\s+database is locked · its runs and worktrees are untouched; only this read failed\./);
    record('a failed read of one set renders as a failure naming what is untouched, never as a set with no attempts');
  }

  assert.deepEqual(errors, []);
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({
    at: new Date().toISOString(),
    provenance: 'Actual Electron renderer from out/renderer of the checkout this script ran in; synthetic services; report figures computed by src/shared/attempts.ts; no real agent calls',
    mode: before ? 'before' : 'after', checks, errors,
  }, null, 2) + '\n');
} finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
