#!/usr/bin/env node
// Built renderer only. Isolated profile and explicit fictional fixtures; never
// launches a provider, writes a real setting, or executes a goal/run/session.
import { STUB, rendererURL } from './renderer-harness.mjs';
import { TAB_SHORTCUTS } from '../src/shared/routes.ts';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const phase = process.argv[2];
assert.ok(['before', 'after'].includes(phase), 'pass before or after');
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { _electron } = require('playwright-core');
const outAt = process.argv.indexOf('--out');
if (outAt >= 0 && (!process.argv[outAt + 1] || process.argv[outAt + 1].startsWith('--'))) throw new Error('--out requires a directory.');
const out = outAt >= 0 ? path.resolve(process.argv[outAt + 1]) : process.env.WANIGAN_FEATURE_CAPTURE_OUTPUT || path.join(root, 'docs/visuals/feature-pages-2026-09-19', phase);
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-feature-pages-'));
writeFileSync(path.join(dir, 'main.cjs'), "const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(dir, 'main.cjs'), `--user-data-dir=${dir}/profile`], env });
const screenshots = [], errors = [], checks = [];
const report = { phase,
  source: process.env.WANIGAN_FEATURE_CAPTURE_SOURCE || 'Current renderer build; caller must freeze source and output during capture.',
  provenance: 'Production renderer in an isolated Electron profile with explicit fictional Goals, Runs and Sessions fixtures. No Wanigan main process, real provider/PTY/model calls, user-data reads or writes. Renderer behavior only; not an IPC or persistence test.',
  screenshots, errors, checks,
  buildIndexSha256: crypto.createHash('sha256').update(readFileSync(path.join(root, 'out/renderer/index.html'))).digest('hex'),
};
let page;

function fixture() {
  const empty = new URLSearchParams(location.search).get('fixture') === 'empty';
  const requiredOption = new URLSearchParams(location.search).get('requiredOption') === 'true';
  const now = Date.now();
  const base = window.wanigan;
  const proxy = (target, changes) => new Proxy(target, { get(t, p) { return p in changes ? changes[p] : t[p]; } });
  window.__featureMutations = [];
  window.__featureRunReadFailure = new URLSearchParams(location.search).get('runRead') === 'fail';
  window.__featureRunReadPending = new URLSearchParams(location.search).get('runRead') === 'pending';
  window.__featureRunReaders = [];
  const refuse = name => async (...args) => { window.__featureMutations.push({ name, args }); throw new Error('Fictional fixture refuses execution: ' + name); };
  localStorage.setItem('wanigan.composer', '1');
  localStorage.setItem('wanigan.code', '0');
  localStorage.setItem('wanigan.navigation.visible', 'closed');
  const goal = (id, projectId, projectName, title, status) => ({ id, projectId, projectName, title,
    objective: 'Fictional objective: improve checkout clarity and preserve its recorded behavior.',
    acceptance: ['Checkout summary describes the selected plan.', 'Keyboard users can reach the next action.'],
    risk: 'low', budgetUsd: 3, baseCommit: 'abc123fixture', status, createdAt: now - 7200000, updatedAt: now - 240000,
    autopilot: { enabled: false, providerId: null, model: null, budgetUsd: 3, spendUsd: 0, spendStatus: 'none', haltedReason: null, haltedAt: null },
    gate: { onStop: false, returnFailures: false },
  });
  const goals = empty ? [] : [
    goal('fixture-goal-review', 'p1', 'storefront', 'Checkout clarity · fictional goal', 'review'),
    goal('fixture-goal-blocked', 'p2', 'platform', 'API pagination · fictional goal', 'blocked'),
    goal('fixture-goal-draft', 'p1', 'storefront', 'Keyboard navigation · fictional goal', 'draft'),
  ];
  const detail = id => {
    const value = goals.find(goal => goal.id === id);
    if (!value) throw new Error('Unknown fictional goal');
    return { ...value, nodes: ['plan', 'implement', 'verify', 'review'].map((kind, index) => ({
      id: id + '-task-' + index, docketId: id, kind,
      title: ['Define the change', 'Update checkout flow', 'Check the result', 'Decide what to keep'][index],
      instructions: 'Fictional task instructions. No task can execute in this visual fixture.',
      dependsOn: index ? [id + '-task-' + (index - 1)] : [], claimPath: null,
      status: value.status === 'review' ? index === 3 ? 'ready' : 'completed' : value.status === 'blocked' ? index === 1 ? 'blocked' : index === 0 ? 'completed' : 'pending' : index === 0 ? 'ready' : 'pending',
      providerId: null, model: null, effort: null, accountId: null, permissionMode: null,
      sessionId: null, worktree: null, startedAt: null, endedAt: null, detail: null,
      deferUntil: null, reopenedAt: null, gateRunningSince: null, gateReturns: 0, queued: false,
    })), claims: [], proofs: [], checkpoints: [], reviewCommands: 0 };
  };
  const run = (id, name, status, failed = 0) => ({ id, name, model: 'fixture-model', status,
    costUsd: .21, costStatus: 'reported', totalRequests: 1, createdAt: now - 1800000,
    submittedAt: now - 1790000, endedAt: status === 'in_progress' ? null : now - 1600000,
    error: null, succeeded: status === 'ended' && !failed ? 1 : 0, failed, blocked: 0,
    open: status === 'in_progress' ? 1 : 0, awaiting: 0, filesChanged: 1,
  });
  const runs = empty ? [] : [
    run('fixture-run-success', 'Checkout audit · fictional run', 'ended'),
    run('fixture-run-active', 'Accessibility pass · fictional run', 'in_progress'),
    run('fixture-run-failure', 'API contract check · fictional run', 'ended', 1),
  ];
  const rows = runId => [{ runId, projectId: 'p1', projectName: 'storefront', projectPath: '/example/storefront',
    status: runId === 'fixture-run-active' ? 'running' : runId === 'fixture-run-failure' ? 'errored' : 'succeeded',
    costUsd: .21, costReported: true, durationMs: 800, exitCode: 0, output: null, error: null,
    filesChanged: 1, worktree: null, startedAt: now - 1790000, endedAt: now - 1600000,
    held: null, hasOutput: true, hasError: runId === 'fixture-run-failure',
  }];
  const past = empty ? [] : [
    { id: 'fixture-history-pinned', projectId: 'p1', projectName: 'storefront', title: 'Receipt layout · fictional saved conversation', pinnedAt: now - 600000, settledAt: null },
    { id: 'fixture-history-recent', projectId: 'p2', projectName: 'platform', title: 'Pagination notes · fictional saved conversation', pinnedAt: null, settledAt: null },
    { id: 'fixture-history-settled', projectId: 'p1', projectName: 'storefront', title: 'Old invoice tests · fictional settled conversation', pinnedAt: null, settledAt: now - 900000 },
  ].map(value => ({ ...value, conversationId: value.id, providerId: 'codex', projectPath: '/example/' + value.projectName,
    worktree: null, model: 'fixture-model', effort: null, permissionMode: null,
    startedAt: now - 7200000, endedAt: now - 3600000, exitCode: 0, continuationCount: 1, live: true, titleSource: 'named' }));
  window.__featureFixture = { empty, goals, runs, past };
  window.wanigan = proxy(base, {
    prefs: proxy(base.prefs, { all: async () => ({ ...(await base.prefs.all()), navSidebar: 'closed', motion: 'off' }), set: refuse('prefs.set') }),
    providers: proxy(base.providers, { list: async () => (await base.providers.list()).map(provider => ({ ...provider,
      capabilities: { ...provider.capabilities, headlessJson: true },
      launchFields: [{ id: 'model', label: 'Model', kind: 'text', required: false }, { id: 'fixtureOption', label: requiredOption ? 'Required fixture option' : 'Optional fixture option', kind: 'text', required: requiredOption }],
    })) }),
    sessions: proxy(base.sessions, {
      list: async () => empty ? [] : (await base.sessions.list()).map(session => ({ ...session,
        displayTitle: session.id === 's1' ? 'Checkout review · fictional open session' : session.id === 's2' ? 'API cleanup · fictional open session' : 'Migration notes · fictional exited session',
        projectPath: '/example/' + session.projectName, model: 'fixture-model',
        harnessId: session.providerId === 'claude' ? 'claude-code' : 'codex', capabilities: { hooks: false },
      })), past: async () => past,
      baseline: async () => ({ head: 'abc123fixture', dirty: [], at: now }), buffer: async () => '',
      scrollback: async () => 'Fictional UI fixture. No live agent or terminal process.\r\n',
      write: refuse('sessions.write'), start: refuse('sessions.start'), launch: refuse('sessions.launch'), resume: refuse('sessions.resume'),
    }),
    attention: proxy(base.attention, { list: async () => empty ? [] : await base.attention.list() }),
    control: proxy(base.control, { list: async () => goals, get: async id => detail(id), outcomes: async () => [], events: async () => [],
      mcpTasks: async () => [], resumeReceipts: async () => [], traces: async () => [], sessionGoal: async () => null,
      start: refuse('control.start'), complete: refuse('control.complete'), runProof: refuse('control.runProof'), create: refuse('control.create') }),
    headless: proxy(base.headless, { runs: async () => {
      if (window.__featureRunReadFailure) throw new Error('Fictional run-history read failure.');
      if (window.__featureRunReadPending) await new Promise(resolve => window.__featureRunReaders.push(resolve));
      return runs;
    }, rows: async id => rows(id),
      rowDetail: async (runId, projectId) => ({ runId, projectId, output: 'Fictional recorded output. No command was executed.', error: null }),
      start: refuse('headless.start'), cancel: refuse('headless.cancel'), answerHeld: refuse('headless.answerHeld') }),
    worktrees: proxy(base.worktrees, { setup: async projectId => ({ projectId, depsMode: 'link', setup: [], teardown: [], updatedAt: null, include: { state: 'absent' } }), commandRuns: async () => [] }),
    transcripts: proxy(base.transcripts, { search: async () => [] }),
    handoff: proxy(base.handoff, { plan: async () => ({ targets: [] }) }),
    policy: proxy(base.policy, { trust: async () => 'project' }),
    code: proxy(base.code, { editors: async () => [],
      changes: async () => ({ isRepo: true, branch: 'fixture/review', headMoved: false, commits: 0, attributed: true, unreadable: null,
        files: [{ path: 'FICTIONAL-UI-FIXTURE.md', index: ' ', work: 'M', staged: false, untracked: false }] }),
      diff: async () => 'diff --git a/FICTIONAL-UI-FIXTURE.md b/FICTIONAL-UI-FIXTURE.md\n--- a/FICTIONAL-UI-FIXTURE.md\n+++ b/FICTIONAL-UI-FIXTURE.md\n@@ -1 +1 @@\n-Fictional previous text.\n+Fictional updated text.\n',
    }),
  });
}

try {
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(STUB + '\n(' + fixture.toString() + ')();');
  const clean = async () => {
    assert.equal(await page.getByRole('heading', { name: 'Let’s try this view again.' }).count(), 0, 'no error boundary');
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.__featureMutations), [], 'no mutation or execution requests');
  };
  const capture = async name => {
    await clean();
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.themePreference = theme;
        document.documentElement.style.colorScheme = theme;
        window.dispatchEvent(new CustomEvent('wanigan:theme-changed', { detail: { preference: theme, resolved: theme } }));
      }, theme);
      const file = name + '-' + theme + '.png';
      await page.screenshot({ path: path.join(out, file), scale: 'css', animations: 'disabled' });
      screenshots.push({ file, ...(await page.evaluate(() => ({ theme: document.documentElement.dataset.theme,
        viewport: { width: innerWidth, height: innerHeight }, scrollWidth: document.documentElement.scrollWidth, bodyText: document.body.innerText }))) });
    }
  };
  const visit = async route => {
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press(TAB_SHORTCUTS[route].aria.split(' ')[0]);
    await page.waitForTimeout(350);
    await clean();
  };
  for (const mode of ['empty', 'populated']) {
    await page.goto(rendererURL + '?fixture=' + mode);
    await page.locator('.home-room').waitFor();
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const route of ['control', 'runs', 'sessions']) {
      await visit(route);
      if (mode === 'populated' && route === 'control') await page.locator('.control-detail').waitFor();
      if (mode === 'populated' && route === 'runs') await page.locator('.hr-run.on').waitFor();
      if (mode === 'populated' && route === 'sessions') await page.locator('.terminal-host:visible .xterm').waitFor();
      await capture(`${route}-${mode}-1440x1000`);
      await page.setViewportSize({ width: 720, height: 640 });
      await capture(`${route}-${mode}-720x640`);
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await visit('runs');
    await page.getByRole('button', { name: 'New run', exact: true }).click();
    await page.locator('.hr-compose').waitFor();
    await capture(`runs-compose-${mode}-1440x1000`);
    await page.getByRole('button', { name: 'Back to runs', exact: true }).click();
    if (mode === 'populated') {
      await visit('sessions');
      await page.locator('.session-side-panel-toggle').click();
      await page.locator('.session-detail-reader:visible').waitFor();
      await capture('sessions-details-1440x1000');
      await page.locator('.session-side-panel-toggle').click();
      await page.setViewportSize({ width: 720, height: 640 });
      await page.locator('.session-picker-trigger').click();
      await page.getByRole('complementary', { name: 'Session picker', exact: true }).waitFor();
      await capture('sessions-picker-720x640');
      await page.getByRole('button', { name: 'Close session switcher', exact: true }).first().click();
      await page.locator('.session-side-panel-toggle').click();
      await page.locator('.session-detail-reader:visible').waitFor();
      await capture('sessions-details-720x640');
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
  }
  if (phase === 'after') {
    await page.goto(rendererURL + '?fixture=populated');
    await page.locator('.home-room').waitFor();
    await page.setViewportSize({ width: 1440, height: 1000 });
    const frames = async () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const focused = async locator => locator.evaluate(element => element === document.activeElement);

    await visit('control');
    await page.locator('.control-detail').waitFor();
    const initialGoal = await page.locator('.control-detail').getAttribute('id');
    await page.locator('.control-note summary').click();
    const note = page.getByRole('textbox', { name: 'Evidence or handoff note', exact: true });
    await note.fill('Fictional decision draft. Never saved.');
    const goalSearch = page.getByRole('searchbox', { name: 'Search goals', exact: true });
    await goalSearch.fill('pagination api');
    assert.match(await page.locator('.control-filter-results').textContent(), /1 of 3 goals/);
    assert.equal(await page.locator('[data-goal-id]').count(), 1);
    assert.equal(await page.locator('.control-detail').getAttribute('id'), initialGoal);
    assert.equal(await note.inputValue(), 'Fictional decision draft. Never saved.');
    await capture('goals-filtered-selection-1440x1000');
    await page.getByRole('button', { name: 'Show selected goal', exact: true }).click();
    await frames();
    assert.equal(await goalSearch.inputValue(), '');
    assert.equal(await focused(goalSearch), true);
    await page.locator('.control-filters summary').click();
    await page.getByRole('combobox', { name: 'Filter goals by project', exact: true }).selectOption('p2');
    assert.match(await page.locator('.control-filter-results').textContent(), /1 of 3 goals/);
    await page.getByRole('button', { name: 'Clear filters', exact: true }).first().click();
    await frames();
    assert.equal(await focused(goalSearch), true);
    await goalSearch.focus();
    await page.setViewportSize({ width: 720, height: 640 });
    await frames();
    const goalPicker = page.locator('.control-picker button');
    assert.equal(await focused(goalPicker), true, 'narrow resize restores visible goal picker');
    await goalPicker.click();
    await frames();
    assert.equal(await focused(goalSearch), true);
    const compactGoalList = await page.locator('.control-list').evaluate(element => {
      element.scrollTop = element.scrollHeight;
      return { height: element.clientHeight, contentHeight: element.scrollHeight, scrollTop: element.scrollTop };
    });
    assert.ok(compactGoalList.height <= 280, 'compact goal list stays bounded');
    assert.ok(compactGoalList.contentHeight > compactGoalList.height && compactGoalList.scrollTop > 0, 'compact goal list scrolls to its last item');
    await goalSearch.scrollIntoViewIfNeeded();
    await capture('goals-browse-720x640');
    await page.locator('[data-goal-id="fixture-goal-blocked"]').click();
    await page.locator('#goal-fixture-goal-blocked').waitFor();
    await frames();
    assert.equal(await goalPicker.getAttribute('aria-expanded'), 'false');
    assert.equal(await focused(goalPicker), true);
    await goalPicker.click();
    await page.locator('[data-goal-id="fixture-goal-review"]').click();
    await page.locator('#goal-fixture-goal-review').waitFor();
    await frames();
    assert.equal(await focused(goalPicker), true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await frames();
    assert.equal(await focused(goalSearch), true, 'desktop resize restores visible goal search');
    if (!(await note.isVisible())) await page.locator('.control-note summary').click();
    assert.equal(await note.inputValue(), 'Fictional decision draft. Never saved.');
    checks.push('Goals supports unordered search and accurate result counts without changing the selected goal or its draft. Filter recovery restores search focus; compact browse selects explicitly and restores picker focus; resizing preserves visible keyboard focus.');

    await visit('runs');
    await page.locator('.hr-run.on').waitFor();
    const selectedRunName = await page.locator('.hr-detail h2').first().textContent();
    const runSearch = page.getByRole('searchbox', { name: 'Search runs', exact: true });
    await page.getByRole('group', { name: 'Run filter', exact: true }).getByRole('button', { name: 'Attention', exact: true }).click();
    assert.match(await page.locator('.hr-filter-summary').textContent(), /1 of 3 recent runs/);
    assert.equal(await page.locator('.hr-detail h2').first().textContent(), selectedRunName);
    await page.locator('.hr-detail').getByRole('button', { name: 'Clear filters', exact: true }).click();
    await frames();
    assert.equal(await focused(runSearch), true);
    await runSearch.fill('nothing matches this fictional phrase');
    await page.getByRole('button', { name: 'Show all runs', exact: true }).click();
    await frames();
    assert.equal(await focused(runSearch), true);
    assert.equal(await page.locator('.hr-run').count(), 3);
    await page.getByRole('button', { name: 'New run', exact: true }).click();
    const task = page.getByRole('textbox', { name: 'Task for every repository', exact: true });
    await frames();
    assert.equal(await focused(task), true);
    assert.equal(await page.locator('.hr-agent-options').getAttribute('open'), null);
    await task.fill('Fictional assignment draft. Never launch this fixture.');
    await page.locator('.hr-project').filter({ hasText: 'storefront' }).click();
    await page.locator('.hr-agent-options summary').click();
    await page.getByRole('textbox', { name: 'Optional fixture option', exact: true }).fill('fictional option');
    await capture('runs-composer-draft-1440x1000');
    await page.getByRole('button', { name: 'Back to runs', exact: true }).click();
    await page.getByRole('group', { name: 'Runs area', exact: true }).getByRole('button', { name: 'Compare attempts', exact: true }).click();
    await page.getByRole('group', { name: 'Runs area', exact: true }).getByRole('button', { name: 'Repository runs', exact: true }).click();
    assert.equal(await page.locator('.hr-detail h2').first().textContent(), selectedRunName);
    await page.getByRole('button', { name: 'New run', exact: true }).click();
    assert.equal(await task.inputValue(), 'Fictional assignment draft. Never launch this fixture.');
    assert.equal(await page.locator('.hr-project[aria-pressed="true"]').count(), 1);
    if (!(await page.getByRole('textbox', { name: 'Optional fixture option', exact: true }).isVisible())) await page.locator('.hr-agent-options summary').click();
    assert.equal(await page.getByRole('textbox', { name: 'Optional fixture option', exact: true }).inputValue(), 'fictional option');
    await page.getByRole('button', { name: 'Back to runs', exact: true }).click();
    checks.push('Runs filters retain the selected inspector and explain when it is outside the list. Both recovery actions restore search focus. New run focuses the assignment, optional controls start folded, and assignment/project/options drafts and selected run survive leaving the form and a Compare attempts/Repository runs round trip without launching.');

    await visit('sessions');
    await page.locator('.terminal-host:visible .xterm').waitFor();
    const terminal = await page.locator('.terminal-host:visible .xterm').elementHandle();
    const composer = page.getByRole('textbox', { name: 'Message the agent', exact: true });
    await composer.fill('Fictional session draft. Never sent.');
    const sessionTitle = await page.locator('.session-toolbar h1').textContent();
    const conversationSearch = page.getByRole('searchbox', { name: 'Find a conversation', exact: true });
    await conversationSearch.fill('cleanup api');
    assert.match(await page.locator('#session-picker-search-scope').textContent(), /1 open/);
    await conversationSearch.fill('invoice old');
    assert.match(await page.locator('#session-picker-search-scope').textContent(), /0 open · 1 recent matches/);
    await page.getByText('Old invoice tests · fictional settled conversation', { exact: true }).waitFor();
    assert.equal(await page.locator('.session-toolbar h1').textContent(), sessionTitle);
    assert.equal(await terminal.evaluate(element => element.isConnected), true);
    assert.equal(await composer.inputValue(), 'Fictional session draft. Never sent.');
    await capture('sessions-search-settled-1440x1000');
    await conversationSearch.fill('no matching imaginary conversation');
    await page.getByText('No matching conversations here', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Search saved history', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search saved conversations', exact: true }).waitFor();
    assert.equal(await page.getByRole('searchbox', { name: 'Search saved conversations', exact: true }).inputValue(), 'no matching imaginary conversation');
    await page.getByRole('button', { name: 'Close history', exact: true }).click();
    await page.getByRole('button', { name: 'Clear conversation search', exact: true }).click();
    await page.locator('.session-side-panel-toggle').click();
    await page.getByRole('group', { name: 'Session details', exact: true }).waitFor();
    await page.locator('.session-detail-reader .code-file').first().click();
    await page.getByText('+Fictional updated text.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Expand details', exact: true }).click();
    await page.locator('[data-detail-focus="true"]').waitFor();
    await capture('sessions-expanded-details-1440x1000');
    assert.equal(await terminal.evaluate(element => element.isConnected), true);
    await page.keyboard.press('Meta+e');
    await frames();
    assert.equal(await page.locator('[data-detail-focus="true"]').count(), 0);
    assert.equal(await page.locator('.session-dock').getAttribute('data-open'), 'false');
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.xterm')), true, 'closing composer while details expanded focuses terminal');
    await page.getByRole('button', { name: 'Expand details', exact: true }).click();
    await frames();
    assert.equal(await focused(page.getByRole('button', { name: 'Back to terminal', exact: true })), true, 'expanded reader has settled before native event');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('wanigan:composer-menu', { detail: { show: true } })));
    await frames();
    assert.equal(await page.locator('[data-detail-focus="true"]').count(), 0);
    assert.equal(await focused(composer), true, 'native Show Composer focuses composer after expanded details');
    assert.equal(await composer.inputValue(), 'Fictional session draft. Never sent.');
    await page.getByRole('button', { name: 'Expand details', exact: true }).click();
    const backToTerminal = page.getByRole('button', { name: 'Back to terminal', exact: true });
    await backToTerminal.focus();
    await page.setViewportSize({ width: 720, height: 640 });
    await frames();
    assert.equal(await page.locator('[data-detail-focus="true"]').count(), 1);
    assert.equal(await focused(backToTerminal), true);
    await capture('sessions-expanded-details-720x640');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await frames();
    assert.equal(await page.locator('[data-detail-focus="true"]').count(), 1);
    assert.equal(await focused(backToTerminal), true);
    await backToTerminal.click();
    assert.equal(await terminal.evaluate(element => element.isConnected), true);
    assert.equal(await composer.inputValue(), 'Fictional session draft. Never sent.');
    await page.setViewportSize({ width: 720, height: 640 });
    const sessionPicker = page.locator('.session-picker-trigger');
    await sessionPicker.click();
    await frames();
    assert.equal(await focused(conversationSearch), true);
    await conversationSearch.fill('no matching imaginary conversation');
    await page.getByRole('button', { name: 'Search saved history', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search saved conversations', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await frames();
    assert.equal(await page.getByRole('searchbox', { name: 'Search saved conversations', exact: true }).count(), 0);
    assert.equal(await page.getByRole('complementary', { name: 'Session picker', exact: true }).isVisible(), true);
    await page.keyboard.press('Escape');
    await frames();
    assert.equal(await page.getByRole('complementary', { name: 'Session picker', exact: true }).isVisible(), false);
    assert.equal(await focused(sessionPicker), true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    checks.push('Sessions search covers open, recent, and settled names using unordered words without changing the active session, pooled terminal, or draft; full-history handoff preserves the query. Expanded details preserve terminal/draft and keyboard focus through composer shortcut, native Show Composer, and desktop/narrow resize round trips. Nested history and picker Escape closes only the top layer and returns focus to the picker trigger.');

    await page.goto(rendererURL + '?fixture=empty&runRead=pending');
    await page.locator('.home-room').waitFor();
    await visit('runs');
    await page.locator('.hr-history-state').getByText(/Reading recent runs/).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Nothing has run yet', exact: true }).count(), 0);
    assert.equal(await page.locator('.hr-history-state').count(), 1);
    assert.equal(await page.locator('.hr-history,.hr-detail').count(), 0);
    await capture('runs-reading-1440x1000');
    await page.evaluate(() => {
      window.__featureRunReadPending = false;
      window.__featureRunReaders.splice(0).forEach(resolve => resolve());
    });
    await page.getByRole('heading', { name: 'Nothing has run yet', exact: true }).waitFor();

    await page.goto(rendererURL + '?fixture=empty&runRead=fail');
    await page.locator('.home-room').waitFor();
    await visit('runs');
    await page.getByRole('heading', { name: 'Could not read recent runs', exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Nothing has run yet', exact: true }).count(), 0);
    await capture('runs-unavailable-1440x1000');
    await page.evaluate(() => { window.__featureRunReadFailure = false; });
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.getByRole('heading', { name: 'Nothing has run yet', exact: true }).waitFor();
    assert.equal(await page.locator('.hr-history-state').count(), 1);
    assert.equal(await page.locator('.hr-history,.hr-detail').count(), 0);
    checks.push('A pending initial run-history read remains Reading recent runs and a failure remains unavailable, neither claims zero runs. Resolve/retry reaches one full-width empty state, with no duplicate list/inspector placeholders.');

    await page.goto(rendererURL + '?fixture=empty&requiredOption=true');
    await page.locator('.home-room').waitFor();
    await visit('runs');
    await page.getByRole('button', { name: 'New run', exact: true }).click();
    const requiredOptions = page.locator('.hr-agent-options');
    const requiredField = page.getByRole('textbox', { name: 'Required fixture option · required', exact: true });
    assert.equal(await requiredOptions.getAttribute('open'), '');
    assert.equal(await requiredField.isVisible(), true);
    await page.getByRole('textbox', { name: 'Task for every repository', exact: true }).fill('Fictional required-options check. Never launch.');
    await page.locator('.hr-project').filter({ hasText: 'storefront' }).click();
    const oneRepoLaunch = page.getByRole('button', { name: 'Run in 1 repo', exact: true });
    assert.equal(await oneRepoLaunch.isDisabled(), true, 'missing required field blocks launch');
    await requiredOptions.locator('summary').click();
    assert.equal(await oneRepoLaunch.isDisabled(), true, 'folding required options does not bypass validation');
    await requiredOptions.locator('summary').click();
    await requiredField.fill('Fictional required value');
    assert.equal(await oneRepoLaunch.isEnabled(), true);
    await page.getByRole('button', { name: 'Select all projects', exact: true }).click();
    const allRepoLaunch = page.getByRole('button', { name: 'Run in 2 repos', exact: true });
    const declaration = page.getByRole('checkbox', { name: /Run in every registered repository/ });
    assert.equal(await declaration.isChecked(), false);
    assert.equal(await allRepoLaunch.isDisabled(), true, 'selecting all projects is not launch consent');
    await declaration.check();
    assert.equal(await allRepoLaunch.isEnabled(), true);
    const budget = page.getByRole('textbox', { name: 'CLI budget / repository', exact: true });
    await budget.fill('-1');
    assert.equal(await allRepoLaunch.isDisabled(), true, 'invalid budget blocks launch');
    await budget.fill('0');
    assert.equal(await allRepoLaunch.isEnabled(), true);
    await page.getByRole('combobox', { name: 'Timeout per repository', exact: true }).selectOption('30');
    assert.match(await page.locator('.hr-declare').innerText(), /zero budget passes no cost ceiling/);
    assert.equal(await page.getByRole('checkbox', { name: 'isolate in worktrees', exact: true }).isChecked(), true);
    assert.equal(await page.getByRole('checkbox', { name: 'hold approvals for me', exact: true }).isChecked(), false);
    await page.locator('.hr-project').filter({ hasText: 'platform' }).click();
    await page.locator('.hr-project').filter({ hasText: 'platform' }).click();
    assert.equal(await declaration.isChecked(), false, 'changing project selection retires all-repository declaration');
    assert.equal(await allRepoLaunch.isDisabled(), true);
    await page.setViewportSize({ width: 720, height: 640 });
    await allRepoLaunch.scrollIntoViewIfNeeded();
    const launchBounds = await allRepoLaunch.boundingBox();
    assert.ok(launchBounds && launchBounds.y >= 0 && launchBounds.y + launchBounds.height <= 640, 'compact run form scrolls to launch controls');
    await capture('runs-required-options-720x640');
    checks.push('Required agent options begin open and block launch even when folded. All-repository launch requires a fresh explicit declaration; changing selection retires it. Budget, timeout, worktree isolation, and approval controls remain explicit. Compact goal browsing and run setup scroll to their final controls. No launch button was pressed.');
  }
  await clean();
  report.result = 'pass';
  rmSync(path.join(out, 'failure.png'), { force: true });
  console.log(JSON.stringify({ result: report.result, screenshots: screenshots.length, checks, errors, output: out }, null, 2));
} catch (error) {
  report.result = 'fail'; report.failure = String(error.stack ?? error);
  if (page) { console.error((await page.locator('body').innerText()).slice(0, 16000)); await page.screenshot({ path: path.join(out, 'failure.png'), scale: 'css' }); }
  throw error;
} finally {
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  await app.close();
}
