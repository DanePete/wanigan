#!/usr/bin/env node
// Context · "Reported by a session": the loader prediction laid beside what a
// session's InstructionsLoaded hooks named. Actual renderer, isolated Electron,
// synthetic files and services, no real agent calls.
//
//   npm run build && node scripts/probe-context-observed.mjs [--before]
//
// --before captures the Instructions area of a build that predates the section,
// with the same fixtures, so the two directories compare like for like.
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
  : path.join(root, 'docs/visuals/context-observed', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-observed-'));
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
    window.__observedCalls = []; window.__observed = 'report';
    const rootOf = (id) => (id === 'p2' ? '/example/platform' : '/example/storefront');
    const chainFor = (root) => {
      const file = (name, scope, order, extra = {}) => ({ path: root + '/' + name, scope, exists: true, bytes: 720, lines: 18, order, depth: 0,
        importedBy: null, external: false, conditional: null, duplicate: false, warnings: [], excludedBy: null, ...extra });
      const files = [
        file('CLAUDE.md', 'project', 1),
        file('AGENTS.md', 'import', 2, { depth: 1, importedBy: root + '/CLAUDE.md', bytes: 3400, lines: 74 }),
        file('.claude/rules/testing.md', 'rule', 3, { conditional: { kind: 'paths', globs: ['src/**/*.test.ts'], matchingFiles: 12 } }),
        file('.claude/rules/legacy.md', 'rule', 4, { conditional: { kind: 'paths', globs: ['legacy/**'], matchingFiles: 0 } }),
      ];
      return { files, totalBytes: 4120, totalLines: 92, atLaunch: files.slice(0, 2), onDemand: [files[2], files[3]],
        notes: [], root, isGitRepo: true };
    };
    // One row of every kind the section distinguishes, so each count is checkable.
    const reportFor = (root) => ({
      sessionId: 's_mt3k9x_a1b2', at: now - 3 * 3600_000,
      rows: [
        { path: root + '/CLAUDE.md', predicted: 'launch', observed: 'launch', loadReason: 'session_start', memoryType: 'Project' },
        { path: root + '/AGENTS.md', predicted: 'launch', observed: null, loadReason: null, memoryType: null },
        { path: root + '/.claude/rules/testing.md', predicted: 'on-demand', observed: 'lazy', loadReason: 'path_glob_match', memoryType: 'Project' },
        { path: root + '/.claude/rules/legacy.md', predicted: 'on-demand', observed: null, loadReason: null, memoryType: null },
        { path: '/example/home/.claude/CLAUDE.md', predicted: null, observed: 'launch', loadReason: 'session_start', memoryType: 'User' },
      ],
      predictedOnly: 2, observedOnly: 1,
    });
    window.wanigan = new Proxy(original, { get(api, service) {
      if (service !== 'context') return api[service];
      return new Proxy(api.context, { get(_context, method) {
        if (method === 'observed') return async (...args) => {
          window.__observedCalls.push(args);
          if (window.__observed === 'fail') throw new Error('Fixture observed read unavailable');
          return window.__observed === 'none' ? null : reportFor(rootOf(args[0]));
        };
        if (method === 'refresh') return async () => {};
        return async (...args) => {
          const root = method === 'codexAgents' ? args[1] : args[0];
          return ({
            instructions: chainFor(root),
            memory: { dir: root + '/.memory', exists: false, enabled: true, derivedFrom: 'git-repo', index: null, indexBudget: null, files: [],
              counts: { user: 0, feedback: 0, project: 0, reference: 0, unknown: 0 }, danglingLinks: [], orphans: [], notes: [] },
            config: { settings: [], layers: [], hooks: [], mcp: [], agents: [], commands: [], permissions: [], notes: [] },
            agentsMd: { present: true, imported: true, symlinked: false, note: 'AGENTS.md is imported by CLAUDE.md.' },
            codexAgents: { files: [], note: 'These are compiler targets, not a prediction of Codex load order.' },
            budget: { files: [], totalBytes: 0, skippedBytes: 0, estTokens: 0, usdPerSession: 0, model: 'claude-sonnet-5', note: 'Estimate.' },
            read: { text: '# fixture', bytes: 9, truncated: false }, memoryBody: { text: '', bytes: 0, truncated: false },
          })[method];
        };
      } });
    } });
  });
  await page.goto(rendererURL); await page.waitForSelector('.mission-room');
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'Context', exact: true }).click();
  await page.getByRole('heading', { name: 'Context', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Re-scan', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.ctx .stat-grid'));

  const region = page.locator('.ctx-area:visible');
  const heading = region.getByText('Reported by a session', { exact: true });
  const shoot = async (name) => {
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      await page.screenshot({ path: path.join(out, `${name}-${theme}.png`), scale: 'css' });
    }
  };
  const rescan = async () => {
    await page.getByRole('button', { name: 'Re-scan', exact: true }).click();
    await page.getByRole('button', { name: 'Re-scan', exact: true }).waitFor();
    await page.waitForTimeout(250);
  };

  if (before) {
    await region.locator('.ctx-file-list').last().evaluate((el) => el.scrollIntoView({ block: 'end' }));
    await shoot('instructions-bottom');
    assert.equal(await heading.count(), 0, 'the pre-change build has no report section');
    record('before: the Instructions area ends at its load order, with no report of what a session loaded');
  } else {
    await heading.waitFor();
    await heading.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    const calls = await page.evaluate(() => window.__observedCalls);
    const shown = await page.getByRole('combobox', { name: 'Context project' }).inputValue();
    assert(calls.length >= 1 && calls.every((args) => args.length === 1 && args[0] === shown),
      `the channel is asked with the selected project's id alone (${shown}): ` + JSON.stringify(calls));
    record('the report is requested with the project id alone; main resolves the path');

    const stat = async (label) => (await region.locator('.stat-tile').filter({ hasText: label }).first().innerText()).replace(/\s+/g, ' ');
    assert.match(await stat('Predicted and reported'), /Predicted and reported 2\b/);
    assert.match(await stat('Expected at launch, not reported'), /Expected at launch, not reported 1\b/);
    assert.match(await stat('Reported, not predicted'), /Reported, not predicted 1\b/);
    assert.match(await stat('On demand, not reported'), /On demand, not reported 1\b/);
    record('each count matches the fixture: 2 agree, 1 expected at launch and unreported, 1 unforeseen, 1 on-demand and untouched');

    await region.getByText('1 file predicted at launch never reported loading.', { exact: true }).waitFor();
    const list = region.locator('.ctx-file-list').last();
    const names = await list.locator('li strong').allInnerTexts();
    assert.deepEqual(names, ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.md', 'testing.md', 'legacy.md'],
      'the unreported launch file leads, then the unforeseen one, then agreement, then the quiet rule: ' + JSON.stringify(names));
    record('the one difference worth attention leads the list and carries its own callout');
    const text = await region.innerText();
    assert(!/\bundefined\b|\bNaN\b|\[object /.test(text), 'no raw value reaches the screen');
    assert.match(text, /From session s_mt3k9x_a1b2, last report 3h ago\./);
    record('the report names its session and its age, and no undefined, NaN or object text reaches the screen');
    await shoot('report');

    await page.evaluate(() => { window.__observed = 'none'; });
    await rescan();
    await heading.waitFor();
    await region.getByText(/No session in this project has reported what it loaded\./).waitFor();
    assert.equal(await region.getByText('Predicted and reported', { exact: true }).count(), 0);
    await heading.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    record('no report reads as "no session has reported", never as an empty report with zero counts');
    await shoot('none');

    await page.evaluate(() => { window.__observed = 'fail'; });
    await rescan();
    await region.locator('.ctx-file-list').first().waitFor();
    assert.equal(await heading.count(), 0, 'a failed read hides the section');
    assert.equal(await region.getByText(/No session in this project has reported/).count(), 0);
    record('a failed read hides the section rather than claiming nothing loaded');
  }
  assert.deepEqual(errors, []);
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({
    at: new Date().toISOString(),
    provenance: 'Actual Electron renderer from out/renderer of the checkout this script ran in; synthetic files and services; no real agent calls',
    mode: before ? 'before' : 'after', checks, errors,
  }, null, 2) + '\n');
} finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
