#!/usr/bin/env node
// Actual built renderer with fictional goals and tasks. Checks that the dock
// cannot strand the goal browser, detail, evidence or board at minimum height.
// Run after npm run build; --before captures the same assertions before a fix.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openRenderer } from './renderer-harness.mjs';

const before = process.argv.includes('--before');
const out = path.resolve('docs/visuals/goals-compact-2026-09-19', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const errors = [], failures = [], geometry = [];
const { page, close } = await openRenderer({ width: 960, height: 560,
  onError: message => { if (!/WebGPU/.test(message)) errors.push(message); },
  instrument: `(() => {
    const api = window.wanigan, at = Date.now();
    const goals = Array.from({ length: 16 }, (_, i) => ({
      id: 'compact-' + i, projectId: 'p1', projectName: 'storefront', title: 'Compact fixture goal ' + (i + 1),
      objective: 'Inspect the recorded outcome and its evidence. '.repeat(20), acceptance: ['Evidence remains reachable.'],
      risk: 'low', budgetUsd: null, baseCommit: null, status: 'active', createdAt: at, updatedAt: at,
      gate: { onStop: false, returnFailures: false }, reviewCommands: 0,
      autopilot: { enabled: false, providerId: null, model: null, budgetUsd: null, spendUsd: 0, spendStatus: 'none', haltedReason: null, haltedAt: null },
      nodes: [], claims: [], proofs: [], checkpoints: [],
    }));
    window.__compactBoardPopulated = false;
    const tasks = Array.from({ length: 16 }, (_, i) => ({
      docketId: 'compact-0', docketTitle: 'Compact fixture goal 1', projectId: 'p1', projectName: 'storefront', risk: 'low',
      node: { id: 'compact-task-' + i, docketId: 'compact-0', title: 'Compact fixture task ' + (i + 1),
        status: 'ready', kind: 'implement', instructions: 'Inspect the recorded outcome. '.repeat(30),
        dependsOn: [], claimPath: null, providerId: null, model: null, sessionId: null, worktree: null,
        startedAt: null, endedAt: null, detail: null, deferUntil: null, queued: false },
    }));
    window.wanigan = new Proxy(api, { get(target, key) {
      if (key !== 'control') return target[key];
      return new Proxy(target.control, { get(control, method) {
        if (method === 'list') return async () => structuredClone(goals);
        if (method === 'get') return async id => structuredClone(goals.find(goal => goal.id === id));
        if (method === 'board') return async () => structuredClone(window.__compactBoardPopulated ? tasks : []);
        if (['events', 'outcomes', 'mcpTasks', 'resumeReceipts', 'traces'].includes(method)) return async () => [];
        return control[method];
      } });
    } });
  })();` });
async function shots(name, width) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
      document.documentElement.dataset.motion = 'off';
    }, theme);
    await page.screenshot({ path: path.join(out, `${name}-${width}x560-${theme}.png`), animations: 'disabled', scale: 'css' });
  }
}
async function assertScrollable(view, width) {
  const row = await page.evaluate(view => {
    const pane = document.querySelector(view === 'goals' ? '.control-view' : '.board-view');
    const support = document.querySelector('.control-support');
    const summary = document.querySelector('.control-support > summary');
    return { overflow: getComputedStyle(pane).overflowY, paneHeight: pane.clientHeight, paneScrollHeight: pane.scrollHeight,
      supportHeight: support?.clientHeight, summaryHeight: summary?.getBoundingClientRect().height };
  }, view);
  geometry.push({ view, width, ...row });
  assert(row.paneScrollHeight <= row.paneHeight + 1 || ['auto', 'scroll'].includes(row.overflow),
    `${view} ${width}×560: content exceeds the available pane but cannot scroll past the dock`);
  if (view === 'goals') assert(row.supportHeight >= row.summaryHeight - 1,
    `${view} ${width}×560: evidence disclosure must not collapse to zero height`);
}
async function inspect(view, width, run) {
  try { await run(); }
  catch (error) { failures.push(`${view} ${width}×560: ${error.message}`); }
}
try {
  await page.locator('.app-header').waitFor();
  for (const width of [960, 900]) {
    await page.setViewportSize({ width, height: 560 });
    await page.keyboard.press('Meta+3');
    await page.locator('.control-detail').waitFor();
    await page.locator('.control-view').evaluate(pane => { pane.scrollTop = 0; });
    await shots('goals', width);
    await inspect('Goals', width, async () => {
      await assertScrollable('goals', width);
      const lastGoal = page.locator('[data-goal-id="compact-15"]');
      await lastGoal.scrollIntoViewIfNeeded(); await lastGoal.click();
      await page.getByRole('heading', { name: 'Compact fixture goal 16', exact: true }).waitFor();
      const execution = page.locator('.control-execution > summary');
      await execution.scrollIntoViewIfNeeded(); await execution.click();
      assert.equal(await page.locator('.control-execution').getAttribute('open'), '');
      const support = page.locator('.control-support > summary');
      await support.scrollIntoViewIfNeeded(); await support.click();
      assert.equal(await page.locator('.control-support').getAttribute('open'), '');
      await page.getByRole('heading', { name: 'What the outcomes say.', exact: true }).scrollIntoViewIfNeeded();
      await shots('evidence', width);
    });
    await page.evaluate(() => { window.__compactBoardPopulated = false; });
    await page.keyboard.press('Meta+Shift+B');
    await page.locator('.board-view .brd-foot').waitFor();
    await shots('board-empty', width);
    await inspect('Empty Board', width, async () => {
      await assertScrollable('board', width);
      const guide = page.locator('.brd-guide button');
      await guide.scrollIntoViewIfNeeded();
      if (await guide.getAttribute('aria-expanded') === 'false') await guide.click();
      assert.equal(await page.locator('.brd-guide button').getAttribute('aria-expanded'), 'true');
    });
    await page.evaluate(() => { window.__compactBoardPopulated = true; });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.locator('[data-node-id="compact-task-15"]').waitFor();
    await page.locator('.board-view').evaluate(pane => { pane.scrollTop = 0; });
    await shots('board', width);
    await inspect('Populated Board', width, async () => {
      await assertScrollable('board', width);
      const lastTask = page.locator('[data-node-id="compact-task-15"]');
      await lastTask.scrollIntoViewIfNeeded(); await lastTask.click();
      await page.getByRole('heading', { name: 'Compact fixture task 16', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Open in Goals', exact: true }).scrollIntoViewIfNeeded();
      await shots('task', width);
      await page.getByRole('button', { name: 'Close task details', exact: true }).click();
      await page.locator('.brd-foot').scrollIntoViewIfNeeded();
    });
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, [], 'Compact workspace controls must remain reachable');
  console.log('PASS: Goals list, detail, execution and evidence; empty/populated Board and task details at 960×560 and 900×560');
} finally {
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ fixture: true, before, geometry, errors, failures }, null, 2) + '\n');
  await close();
}
