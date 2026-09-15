#!/usr/bin/env node
// Worktree bootstrap: what a new agent worktree is given (dependency folders,
// .worktreeinclude copies, a port block, setup and teardown commands) and what
// a reader sees of it — the Worktree setup panel beside the review gate, the
// note under a worktree's branch row, and the dependency choice in the launch
// dialog. Actual renderer, isolated Electron, synthetic services, no real agent
// calls. The main-process half runs against real repositories in the smoke
// suite (src/main/smoke16.ts); this probe covers what a reader sees.
//
//   npm run build && node scripts/probe-worktree-bootstrap.mjs [--before] [--out dir]
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
  : path.join(root, 'docs/visuals/worktree-bootstrap', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-bootstrap-probe-'));
writeFileSync(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({
  executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [path.join(dir, 'main.cjs'), `--user-data-dir=${dir}/profile`], env,
});
const checks = [], errors = [];
const record = (text) => { checks.push(text); console.log('✓', text); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(STUB);
  await page.addInitScript(() => {
    const original = window.wanigan, now = Date.now();
    // Kept across the reload that shows a failed read.
    window.__setupRead = sessionStorage.getItem('probe-setup-read') ?? 'ok';
    window.__save = 'ok';
    window.__calls = [];
    const call = (...entry) => window.__calls.push(entry);
    const tree = '/example/worktrees/';
    const envFor = (name, port) => ({ WANIGAN_WORKTREE: tree + name, WANIGAN_REPO_ROOT: '/example/platform', WANIGAN_PORT: String(port), WANIGAN_PORT_COUNT: '10' });
    const read = (over) => ({ state: 'read', patterns: 3, copied: 0, bytes: 0, present: 0, notIgnored: 0, symlinks: 0, outside: 0, failed: 0, failure: null, stopped: null, cloneable: true, ...over });
    const wt = (name, sessionId, bootstrap) => ({ path: tree + name, branch: 'wanigan/' + name, head: 'abc1234', repoRoot: '/example/platform', sessionId, dirty: 0, ahead: 1, bootstrap });
    const trees = [
      wt('checkout-retry-a1f2', 's1', {
        depsMode: 'clone',
        deps: [{ path: 'node_modules', requested: 'clone', result: 'cloned', detail: null, durationMs: 14_800 }],
        include: read({ copied: 2, bytes: 4_200, present: 1 }),
        ports: { base: 42_310, count: 10 },
        setup: { id: 'wtr_a', phase: 'setup', status: 'failed', startedAt: now - 600_000, endedAt: now - 597_700, planned: 2, ran: 2,
          stoppedAt: { command: 'npm run migrate', exitCode: 3 }, note: null, tailCut: false,
          tail: '$ npm ci\nadded 812 packages in 14s\n$ npm run migrate\n> platform@1.0.0 migrate\n> knex migrate:latest\nError: connect ECONNREFUSED 127.0.0.1:42311' },
      }),
      wt('rail-width-b7c3', 's2', {
        depsMode: 'clone',
        deps: [{ path: 'node_modules', requested: 'clone', result: 'linked', detail: 'it is not on the same APFS volume as the worktree, so cp -c would have made a full copy rather than a clone', durationMs: null }],
        include: { state: 'absent' },
        ports: { base: 42_770, count: 10 },
        setup: { id: 'wtr_b', phase: 'setup', status: 'passed', startedAt: now - 1_200_000, endedAt: now - 1_159_000, planned: 2, ran: 2,
          stoppedAt: null, note: null, tailCut: false, tail: '$ npm ci\nadded 812 packages in 38s\n$ npm run build\nbuilt in 2.9s' },
      }),
      wt('copy-pass-c9d4', null, null),
      wt('idle-d0e5', null, {
        depsMode: 'skip',
        deps: [{ path: 'node_modules', requested: 'skip', result: 'skipped', detail: null, durationMs: null }],
        include: { state: 'unreadable', detail: 'git could not list what it matches (fatal: bad pattern)' },
        ports: { base: 42_880, count: 10 },
        setup: null,
      }),
    ];
    const runs = (projectId) => [
      { id: 'wtr_a', projectId, worktree: tree + 'checkout-retry-a1f2', phase: 'setup', startedAt: now - 600_000, endedAt: now - 597_700, status: 'failed', planned: 2,
        results: [
          { command: 'npm ci', exitCode: 0, output: 'added 812 packages in 14s\n', durationMs: 2_000 },
          { command: 'npm run migrate', exitCode: 3, output: '> platform@1.0.0 migrate\n> knex migrate:latest\nError: connect ECONNREFUSED 127.0.0.1:42311\n', durationMs: 300 },
        ], env: envFor('checkout-retry-a1f2', 42_310), note: null },
      { id: 'wtr_t', projectId, worktree: tree + 'old-spike-e1f6', phase: 'teardown', startedAt: now - 900_000, endedAt: now - 898_600, status: 'passed', planned: 1,
        results: [{ command: 'docker compose down', exitCode: 0, output: 'Container platform-db-1  Stopped\n', durationMs: 1_400 }],
        env: envFor('old-spike-e1f6', 43_540), note: null },
      { id: 'wtr_b', projectId, worktree: tree + 'rail-width-b7c3', phase: 'setup', startedAt: now - 1_200_000, endedAt: now - 1_159_000, status: 'passed', planned: 2,
        results: [
          { command: 'npm ci', exitCode: 0, output: 'added 812 packages in 38s\n', durationMs: 38_100 },
          { command: 'npm run migrate', exitCode: 0, output: 'Already up to date\n', durationMs: 2_900 },
        ], env: envFor('rail-width-b7c3', 42_770), note: null },
    ];
    const stored = { depsMode: 'clone', setup: ['npm ci', 'npm run migrate'], teardown: ['docker compose down'] };
    window.wanigan = new Proxy(original, { get(api, service) {
      if (service === 'worktrees') return new Proxy(api.worktrees, { get(w, method) {
        if (method === 'list') return async () => trees;
        if (method === 'forecast') return async (projectId) => ({ projectId, repoRoot: '/example/platform', at: now, unsupported: null, omitted: 0, worktrees: [], pairs: [] });
        if (method === 'setup') return async (projectId) => {
          call('setup', projectId);
          if (window.__setupRead === 'fail') throw new Error('Fixture read failed: the database is locked');
          return { projectId, ...stored, setup: [...stored.setup], teardown: [...stored.teardown], updatedAt: now - 86_400_000, include: { state: 'present', patterns: 3 } };
        };
        if (method === 'commandRuns') return async (projectId, limit) => { call('commandRuns', projectId, limit); return runs(projectId); };
        if (method === 'setDepsMode') return async (projectId, mode) => { call('setDepsMode', projectId, mode); stored.depsMode = mode; return mode; };
        if (method === 'saveCommands') return async (projectId, input) => {
          call('saveCommands', projectId, input);
          if (window.__save === 'cancel') throw new Error('Cancelled. The worktree commands were not saved, so nothing new will run in a worktree.');
          stored.setup = input.setup; stored.teardown = input.teardown;
          return { projectId, setup: input.setup, teardown: input.teardown, updatedAt: Date.now() };
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
      if (service === 'policy') return new Proxy(api.policy, { get(p, method) {
        if (method === 'trust' || method === 'defaultTrust') return async () => 'project';
        return p[method];
      } });
      if (service === 'sessions') return new Proxy(api.sessions, { get(s, method) {
        if (method === 'create') return async (options) => { call('create', options); throw new Error('Fixture launch was refused. No process was started.'); };
        return s[method];
      } });
      return api[service];
    } });
  });

  const shoot = async (name) => {
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      await page.screenshot({ path: path.join(out, `${name}-${theme}.png`), scale: 'css' });
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  };
  const calls = (kind) => page.evaluate((k) => window.__calls.filter((c) => c[0] === k), kind);
  const openChanges = async () => {
    await page.goto(rendererURL); await page.waitForSelector('.mission-room');
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.getByRole('button', { name: 'Changes', exact: true }).click();
    await page.getByRole('group', { name: 'Repository views' }).waitFor();
  };
  const setupDetails = () => page.locator('details.gt-review-controls').filter({ has: page.locator('summary', { hasText: 'Worktree setup' }) });
  const readable = async (locator, what) => {
    for (const el of await locator.all()) {
      const fit = await el.evaluate((node) => ({ scroll: node.scrollWidth, client: node.clientWidth, text: node.innerText }));
      assert(fit.scroll <= fit.client + 1, `${what} is clipped: ${JSON.stringify(fit)}`);
    }
  };
  const openLaunch = async () => {
    await page.keyboard.press('Meta+t');
    const launch = page.getByRole('dialog', { name: 'New session', exact: true });
    await launch.waitFor();
    await launch.getByRole('combobox', { name: 'Project', exact: true }).selectOption('p2');
    await launch.getByRole('checkbox', { name: /Isolate in a worktree/ }).check();
    return launch;
  };

  await openChanges();

  if (before) {
    await page.locator('details.gt-review-controls > summary', { hasText: 'Review gate' }).waitFor();
    await page.waitForTimeout(600);
    assert.equal(await setupDetails().count(), 0, 'the pre-change build has no worktree setup panel');
    await shoot('changes');
    record('before: Changes offers the review gate and nothing about what a new worktree is given');

    await page.getByRole('group', { name: 'Repository views' }).getByRole('button', { name: 'Branches', exact: true }).click();
    await page.locator('.gt-file').filter({ hasText: 'wanigan/checkout-retry-a1f2' }).first().waitFor();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.wt-boot').count(), 0);
    await shoot('branches');
    record('before: worktree branch rows say nothing about dependencies, copies, ports or setup');

    const launch = await openLaunch();
    await page.waitForTimeout(400);
    assert.equal(await launch.getByRole('group', { name: 'Dependency folders in the worktree' }).count(), 0);
    await shoot('launch');
    record('before: ticking isolation offers no dependency choice and says nothing about setup');
    await page.keyboard.press('Escape');
  } else {
    // ── the panel beside the review gate ─────────────────────────────────
    const details = setupDetails();
    await details.locator(':scope > summary').click();
    const panel = page.getByRole('region', { name: 'Worktree setup' });
    await panel.getByRole('textbox', { name: 'Worktree setup commands' }).waitFor();
    const setupCalls = await calls('setup');
    assert(setupCalls.length === 1 && setupCalls[0].length === 2 && typeof setupCalls[0][1] === 'string',
      'the panel asked for the settings once, by project id alone: ' + JSON.stringify(setupCalls));
    const projectId = setupCalls[0][1];
    record('opening Worktree setup reads the project’s settings once, by project id alone');

    const deps = panel.getByRole('group', { name: 'Dependency folders in new worktrees' });
    assert.equal(await deps.getByRole('button', { name: 'Clone', exact: true }).getAttribute('aria-pressed'), 'true');
    let text = flat(await panel.innerText());
    assert.match(text, /A copy-on-write clone per worktree, isolated from the main checkout\./);
    assert.match(text, /\.worktreeinclude has 3 patterns: gitignored files matching them are copied into each new worktree\./);
    assert.match(text, /A setup that fails keeps its worktree and does not stop the session from starting\./);
    assert.match(text, /Kept in Wanigan, never written into the repository\./);
    assert.equal(await panel.getByRole('textbox', { name: 'Worktree setup commands' }).inputValue(), 'npm ci\nnpm run migrate');
    assert.equal(await panel.getByRole('textbox', { name: 'Worktree teardown commands' }).inputValue(), 'docker compose down');
    assert.equal(await panel.getByRole('button', { name: 'Save commands', exact: true }).isDisabled(), true, 'nothing to save before an edit');
    record('the stored choice (clone), the include file’s 3 patterns and both command lists are shown, and saving is off until something changes');

    const runRows = panel.locator('details.wt-run');
    assert.equal(await runRows.count(), 3);
    const firstRun = flat(await runRows.first().locator('summary').innerText());
    assert.match(firstRun, /^✕ ?setup failed checkout-retry-a1f2 npm run migrate exited 3 · 2\.3s · the worktree was kept and the launch was not held back/);
    assert.match(flat(await runRows.nth(1).locator('summary').innerText()), /^✓ ?teardown passed old-spike-e1f6 1 command · 1\.4s/);
    await runRows.first().locator('summary').click();
    const opened = flat(await runRows.first().innerText());
    assert.match(opened, /npm run migrate exit 3 · 300ms/);
    assert.match(opened, /Error: connect ECONNREFUSED 127\.0\.0\.1:42311/);
    assert.match(opened, /ports 42310, 10 of them/);
    assert(!/\bundefined\b|\bNaN\b|\[object /.test(flat(await panel.innerText())), 'no raw value reaches the screen');
    await readable(panel.locator('.wt-run > summary, .wt-setup-caption'), 'a run summary or caption');
    record('recent runs list both phases; a failed setup names the command, its exit code, duration and that the launch went ahead, and opens to each command’s recorded output');
    await details.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await shoot('setup-panel');

    // Link's caption states the one write it makes to the repository's git
    // metadata, before anyone picks it.
    await deps.getByRole('button', { name: 'Link', exact: true }).click();
    const linkCaption = panel.locator('.wt-setup-caption').first();
    await linkCaption.filter({ hasText: 'Shared with the main checkout' }).waitFor();
    assert.match(flat(await linkCaption.innerText()), /Wanigan names each link in the repository’s local git exclude file, so git does not list it as untracked work\./);
    await details.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await shoot('setup-link');
    await deps.getByRole('button', { name: 'Clone', exact: true }).click();
    await linkCaption.filter({ hasText: 'A copy-on-write clone per worktree' }).waitFor();
    record('choosing Link says the worktree shares the main checkout’s folders and that each link is named in the local git exclude file, so it is not listed as untracked work');

    await panel.getByRole('textbox', { name: 'Worktree setup commands' }).fill('npm ci\nnpm run migrate\nnpm run seed');
    await panel.getByText('Unsaved changes', { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Save commands', exact: true }).click();
    await panel.getByText(/Commands saved\. Nothing ran now/).waitFor();
    const saves = await calls('saveCommands');
    assert.deepEqual(saves, [['saveCommands', projectId, { setup: ['npm ci', 'npm run migrate', 'npm run seed'], teardown: ['docker compose down'] }]]);
    record('saving sends both lists for the project id and says that nothing ran');

    await page.evaluate(() => { window.__save = 'cancel'; });
    await panel.getByRole('textbox', { name: 'Worktree teardown commands' }).fill('docker compose down\nrm -rf /tmp/platform-cache');
    await panel.getByRole('button', { name: 'Save commands', exact: true }).click();
    await panel.getByText(/Cancelled\. The worktree commands were not saved, so nothing new will run in a worktree\./).waitFor();
    assert.equal(await panel.getByText('Unsaved changes', { exact: true }).count(), 1, 'a cancelled save stays unsaved');
    record('a save the person cancels in main’s dialog shows main’s sentence and stays unsaved');

    await deps.getByRole('button', { name: 'Skip', exact: true }).click();
    await panel.getByText(/Dependency folders will be left out in new worktrees\. Worktrees that already exist keep what they have\./).waitFor();
    // The Link and Clone presses above stored their choices too; this one is the latest.
    assert.deepEqual((await calls('setDepsMode')).slice(-1), [['setDepsMode', projectId, 'skip']]);
    assert.equal(await deps.getByRole('button', { name: 'Skip', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.match(flat(await panel.innerText()), /Not made available in the worktree\. Install them with a setup command\./);
    record('choosing skip stores it for the project at once and says existing worktrees keep what they have');

    // ── the note under each worktree's branch row ────────────────────────
    // Folded first: an open panel takes the height the branch pane needs.
    await setupDetails().locator(':scope > summary').click();
    await page.getByRole('group', { name: 'Repository views' }).getByRole('button', { name: 'Branches', exact: true }).click();
    await page.locator('.gt-file').filter({ hasText: 'wanigan/checkout-retry-a1f2' }).first().waitFor();
    const note = (branch) => page.locator(`.gt-file:has-text("${branch}") + .wt-boot`);
    await note('wanigan/checkout-retry-a1f2').waitFor();
    assert.equal(await page.locator('.wt-boot').count(), 3, 'three of the four worktrees have a record; the fourth predates it');
    assert.equal(await note('wanigan/copy-pass-c9d4').count(), 0);
    const a = flat(await note('wanigan/checkout-retry-a1f2').innerText());
    assert.match(a, /✕ ?setup failed npm run migrate exited 3 · 2\.3s · the worktree was kept and the launch was not held back/);
    assert.match(a, /ports 42310–42319 · node_modules cloned in 15s · 2 files \(4\.1 KB\) copied from \.worktreeinclude; 1 match already there/);
    const b = flat(await note('wanigan/rail-width-b7c3').innerText());
    assert.match(b, /✓ ?setup passed 2 commands · 41s/);
    assert.match(b, /node_modules linked instead of cloned: it is not on the same APFS volume as the worktree/);
    const d = flat(await note('wanigan/idle-d0e5').innerText());
    assert.match(d, /ports 42880–42889 · node_modules not made available · \.worktreeinclude was not used: git could not list what it matches \(fatal: bad pattern\)\. Nothing was copied from it · no setup ran/);
    assert(!/0 files copied/.test(d), 'an unreadable include file is never "0 files copied"');
    record('each worktree row states its setup verdict, ports, dependency outcome and include copies; a clone that fell back says why; an unreadable include file is not reported as zero copies; a worktree with no record shows nothing');
    await readable(page.locator('.wt-boot-line'), 'a worktree bootstrap line');
    await page.locator('.gt-file').filter({ hasText: 'wanigan/checkout-retry-a1f2' }).first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await shoot('branches');
    await note('wanigan/checkout-retry-a1f2').locator('summary').click();
    assert.match(flat(await note('wanigan/checkout-retry-a1f2').locator('pre').innerText()), /Error: connect ECONNREFUSED 127\.0\.0\.1:42311/);
    record('the failed setup’s output tail opens under its row, and no bootstrap line is clipped in the narrow branch pane');
    await note('wanigan/checkout-retry-a1f2').locator('summary').click();

    // ── the launch dialog ────────────────────────────────────────────────
    const launch = await openLaunch();
    const choice = launch.getByRole('group', { name: 'Dependency folders in the worktree' });
    await choice.waitFor();
    const block = launch.locator('.wt-deps');
    assert.equal(await choice.getByRole('button', { name: 'Skip', exact: true }).getAttribute('aria-pressed'), 'true', 'the dialog starts on the project’s stored choice');
    const launchText = flat(await block.innerText());
    assert.match(launchText, /3 setup commands run in it before the agent starts; if one fails, the worktree is kept and the session starts anyway\. Gitignored files matching \.worktreeinclude \(3 patterns\) are copied in\./);
    assert.match(launchText, /What the worktree got, and any setup output, shows on its branch in Changes\./);
    const before = (await calls('setDepsMode')).length;
    await choice.getByRole('button', { name: 'Clone', exact: true }).click();
    assert.match(flat(await block.innerText()), /Saved as platform’s choice for every new worktree when this session starts\./);
    assert.equal((await calls('setDepsMode')).length, before, 'pressing a choice stores nothing until the session starts');
    await readable(block.locator('.wt-setup-caption'), 'a launch caption');
    record('ticking isolation shows the project’s stored dependency choice, what setup and the include file will do, and that a changed choice is saved only when the session starts');
    await block.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await shoot('launch');

    await launch.getByRole('button', { name: 'Start in a worktree', exact: true }).click();
    await launch.getByRole('alert').waitFor();
    const order = await page.evaluate(() => window.__calls.filter((c) => c[0] === 'setDepsMode' || c[0] === 'create').map((c) => c[0] === 'create' ? ['create', c[1].projectId, c[1].isolate] : c));
    assert.deepEqual(order.slice(-2), [['setDepsMode', 'p2', 'clone'], ['create', 'p2', true]]);
    record('starting stores the changed choice for the project before the launch request, which asks for isolation');
    await page.keyboard.press('Escape');

    // ── a read that failed ───────────────────────────────────────────────
    await page.evaluate(() => sessionStorage.setItem('probe-setup-read', 'fail'));
    await openChanges();
    await setupDetails().locator(':scope > summary').click();
    const failed = page.getByRole('region', { name: 'Worktree setup' });
    await failed.getByText(/Could not read this project’s worktree settings: .*Fixture read failed/).waitFor();
    assert.equal(await failed.getByRole('textbox').count(), 0, 'no command box to save over when the commands could not be read');
    assert.equal(await failed.getByText('Unavailable', { exact: true }).count(), 1);
    assert.equal(await failed.locator('details.wt-run').count(), 3, 'recorded runs are still shown: the two reads fail apart');
    record('a settings read that failed says so with a retry, never shows an empty command list, and still shows the recorded runs');
    await setupDetails().evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await shoot('setup-unreadable');

    const launchFailed = await openLaunch();
    await launchFailed.getByText(/Wanigan could not read how platform’s worktrees are set up: .*Fixture read failed.* The worktree still gets whatever was last saved for the project\./).waitFor();
    assert.equal(await launchFailed.getByRole('group', { name: 'Dependency folders in the worktree' }).count(), 0);
    record('the dialog says it could not read the project’s worktree settings instead of offering a choice it cannot compare');
    await page.keyboard.press('Escape');
    await page.evaluate(() => sessionStorage.removeItem('probe-setup-read'));
  }
  assert.deepEqual(errors, []);
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({
    at: new Date().toISOString(),
    provenance: 'Actual Electron renderer from out/renderer of the checkout this script ran in; synthetic git, worktree and session services; no real agent calls',
    mode: before ? 'before' : 'after', checks, errors,
  }, null, 2) + '\n');
} finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
