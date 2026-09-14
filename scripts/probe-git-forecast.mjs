#!/usr/bin/env node
// Git · Collision forecast: whether agent worktrees would merge with their
// base and with each other. Actual renderer, isolated Electron, synthetic git
// and services, no real agent calls. The main-process forecast itself is
// exercised against real worktrees by the smoke suite (phase 9); this probe
// covers what a reader sees.
//
//   npm run build && node scripts/probe-git-forecast.mjs [--before] [--out dir]
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), { _electron } = require('playwright-core');
const root = path.resolve(import.meta.dirname, '..'), before = process.argv.includes('--before');
const outArg = process.argv.indexOf('--out');
const out = outArg >= 0 ? path.resolve(process.argv[outArg + 1])
  : path.join(root, 'docs/visuals/git-forecast', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-forecast-probe-'));
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
    const original = window.wanigan, now = Date.now();
    window.__forecastCalls = []; window.__forecast = 'full';
    const wt = (name, sessionId) => ({ path: '/example/worktrees/' + name, branch: 'wanigan/' + name, head: 'abc1234',
      repoRoot: '/example/platform', sessionId, dirty: 2, ahead: 1 });
    const trees = [wt('checkout-retry-a1f2', 's1'), wt('rail-width-b7c3', 's2'), wt('copy-pass-c9d4', null), wt('idle-d0e5', null)];
    const side = (t) => ({ worktree: t.path, branch: t.branch, sessionId: t.sessionId });
    const main = { worktree: null, branch: 'feature/rail', sessionId: null };
    const pair = (kind, a, b, outcome, conflicted = [], shared = [], detail = null) => ({ kind, a, b, outcome, conflicted, shared, detail });
    const full = () => ({
      projectId: 'p2', repoRoot: '/example/platform', at: now - 40_000, unsupported: null, omitted: 0,
      worktrees: [
        ...trees.slice(0, 3).map((t) => ({ ...side(t), base: 'feature/rail', baseRecorded: true, changed: 4, snapshot: 'ok', detail: null })),
        { ...side(trees[3]), base: 'feature/rail', baseRecorded: true, changed: 0, snapshot: 'ok', detail: null },
      ],
      pairs: [
        pair('peer', side(trees[0]), side(trees[1]), 'conflicts', ['src/checkout/retry.ts', 'src/checkout/retry.test.ts'], ['package.json']),
        pair('peer', side(trees[1]), side(trees[2]), 'overlap', [], ['src/rail/Rail.tsx']),
        pair('base', side(trees[0]), main, 'clean'),
        pair('base', side(trees[1]), main, 'clean'),
        pair('base', side(trees[2]), main, 'clean'),
        pair('peer', side(trees[0]), side(trees[2]), 'clean'),
      ],
    });
    const baseConflict = () => {
      const f = full();
      f.pairs = [pair('base', side(trees[0]), main, 'conflicts', ['src/checkout/retry.ts']), ...f.pairs.filter((p) => !(p.kind === 'base' && p.a.worktree === trees[0].path))];
      return f;
    };
    window.wanigan = new Proxy(original, { get(api, service) {
      if (service === 'worktrees') return new Proxy(api.worktrees, { get(w, method) {
        if (method === 'list') return async () => trees;
        if (method === 'forecast') return async (...args) => {
          window.__forecastCalls.push(args);
          if (window.__forecast === 'fail') throw new Error('Fixture forecast unavailable');
          if (window.__forecast === 'old-git') return { projectId: 'p2', repoRoot: '/example/platform', at: now, unsupported: 'The installed git (git version 2.30.1) predates 2.38, which added the merge-tree mode this forecast needs.', worktrees: [], pairs: [], omitted: 0 };
          return window.__forecast === 'base-conflict' ? baseConflict() : full();
        };
        return w[method];
      } });
      if (service === 'git') return new Proxy(api.git, { get(g, method) {
        if (method === 'branches') return async () => [
          { name: 'feature/rail', current: true, remote: false, upstream: 'origin/feature/rail', ahead: 0, behind: 0, at: now - 3600_000, subject: 'Rail width follows the window' },
          ...trees.map((t) => ({ name: t.branch, current: false, remote: false, upstream: null, ahead: 1, behind: 0, at: now - 600_000, subject: 'agent work' })),
        ];
        return g[method];
      } });
      return api[service];
    } });
  });
  await page.goto(rendererURL); await page.waitForSelector('.mission-room');
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  const views = page.getByRole('group', { name: 'Repository views' });
  await views.waitFor();
  await views.getByRole('button', { name: 'Branches', exact: true }).click();
  await page.locator('.gt-file').filter({ hasText: 'wanigan/checkout-retry-a1f2' }).first().waitFor();

  const panel = page.getByRole('region', { name: 'Collision forecast' });
  const shoot = async (name) => {
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      await page.screenshot({ path: path.join(out, `${name}-${theme}.png`), scale: 'css' });
    }
  };

  if (before) {
    await page.waitForTimeout(600);
    assert.equal(await panel.count(), 0, 'the pre-change build has no forecast');
    await shoot('branches');
    record('before: the branches pane lists agent worktree branches with no word on whether they would merge');
  } else {
    await panel.getByText(/1 conflicting/).waitFor();
    const calls = await page.evaluate(() => window.__forecastCalls);
    assert(calls.length === 1 && calls[0].length === 1 && typeof calls[0][0] === 'string',
      'opening the pane asked for one forecast, by project id alone: ' + JSON.stringify(calls));
    record('opening the branches pane over agent worktrees runs one forecast, asked by project id alone');

    const text = (await panel.innerText()).replace(/\s+/g, ' ');
    assert.match(text, /✕ 1 conflicting ◑ 1 overlapping ✓ 4 clean/);
    assert.match(text, /2 files would conflict: src\/checkout\/retry\.ts, src\/checkout\/retry\.test\.ts · both also edit package\.json/);
    assert.match(text, /Both edit src\/rail\/Rail\.tsx/);
    assert.match(text, /Checked 4 worktrees .*, 1 with nothing changed\. A clean forecast is not a clean landing/);
    assert(!/\bundefined\b|\bNaN\b|\[object /.test(text), 'no raw value reaches the screen');
    const firstRow = (await panel.locator('.gt-forecast-row').first().innerText()).replace(/\s+/g, ' ');
    assert.match(firstRow, /^✕ conflicts wanigan\/checkout-retry-a1f2 ↔ wanigan\/rail-width-b7c3/);
    assert.equal(await panel.locator('details.gt-forecast-more').getAttribute('open'), null, 'clean pairs start folded');
    record('counts match the fixture, the conflict leads with its files named, overlap names its shared path, and clean pairs are folded');
    await shoot('forecast');

    await panel.locator('details.gt-forecast-more > summary').click();
    assert.equal(await panel.locator('details.gt-forecast-more .gt-forecast-row').count(), 4);
    record('the four clean pairs are one disclosure away');
    await panel.locator('details.gt-forecast-more > summary').click();

    await page.evaluate(() => { window.__forecast = 'base-conflict'; });
    await panel.getByRole('button', { name: 'Check again', exact: true }).click();
    const row = page.locator('.gt-file').filter({ hasText: 'wanigan/checkout-retry-a1f2' }).first();
    const note = page.locator('.gt-branch-note').filter({ hasText: 'conflicts with feature/rail' });
    await note.waitFor();
    assert.equal(await page.locator('.gt-branch-note').count(), 1, 'only the conflicting branch carries a note');
    const fit = await note.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, text: el.innerText.replace(/\s+/g, ' ') }));
    // A mark inside the ellipsised name span passed a visibility wait while being
    // clipped out of sight. Present in the DOM is not the claim; readable is.
    assert(fit.scroll <= fit.client + 1, 'the conflict line is not clipped: ' + JSON.stringify(fit));
    assert.match(fit.text, /✕ ?conflicts with feature\/rail src\/checkout\/retry\.ts/);
    await row.getByRole('button', { name: 'merge', exact: true }).click();
    const confirmText = (await page.locator('.confirm-note, [role="alertdialog"], .note').filter({ hasText: 'Merge wanigan/checkout-retry-a1f2' }).first().innerText()).replace(/\s+/g, ' ');
    assert.match(confirmText, /It is an agent's worktree at \/example\/worktrees\/checkout-retry-a1f2 with 2 uncommitted files that will not be merged\. The forecast .* found it conflicts with feature\/rail in src\/checkout\/retry\.ts; if that still holds, git will stop and the merge will be backed out\./);
    assert(!/checkout-retry-a1f2\$/.test(confirmText), 'the stray dollar sign after the worktree path is gone');
    record('a base conflict marks the branch row and is stated in the merge confirmation before the press, without the stray "$" that followed the path');
    await shoot('merge-confirm');
    await page.keyboard.press('Escape');
    const cancel = page.getByRole('button', { name: /^Cancel$|^Not now$|^Keep/ }).first();
    if (await cancel.count()) await cancel.click();

    await page.evaluate(() => { window.__forecast = 'old-git'; });
    await panel.getByRole('button', { name: 'Check again', exact: true }).click();
    await panel.getByText(/predates 2\.38/).waitFor();
    assert.equal(await panel.getByText(/conflicting/).count(), 0);
    record('an old git says the forecast cannot run, instead of showing zero conflicts');

    await page.evaluate(() => { window.__forecast = 'fail'; });
    await panel.getByRole('button', { name: 'Check again', exact: true }).click();
    await panel.getByText('The forecast did not run: Error invoking remote method', { exact: false }).or(panel.getByText(/The forecast did not run: .*Fixture forecast unavailable/)).first().waitFor();
    record('a failed forecast reads as not run, never as clean');
    await shoot('failed');
  }
  assert.deepEqual(errors, []);
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({
    at: new Date().toISOString(),
    provenance: 'Actual Electron renderer from out/renderer of the checkout this script ran in; synthetic git and services; no real agent calls',
    mode: before ? 'before' : 'after', checks, errors,
  }, null, 2) + '\n');
} finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
