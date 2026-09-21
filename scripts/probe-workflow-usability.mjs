#!/usr/bin/env node
// Production renderer, fictional records, and refused mutation calls only.
// Before: WANIGAN_RENDERER_ROOT=<frozen renderer> node ... before
// After: npm run build, then node ... after
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { openRenderer } from './renderer-harness.mjs';

const phase = process.argv[2];
assert(['before', 'after'].includes(phase), 'pass before or after');
const before = phase === 'before';
if (before) assert(process.env.WANIGAN_RENDERER_ROOT, 'before requires a frozen renderer root');
const root = path.resolve(import.meta.dirname, '..');
const rendererRoot = process.env.WANIGAN_RENDERER_ROOT || path.join(root, 'out/renderer');
const out = process.env.WANIGAN_WORKFLOW_CAPTURE_OUTPUT || path.join(root, 'docs/visuals/workflow-usability-2026-09-19', phase);
mkdirSync(out, { recursive: true });
const checks = [], errors = [], environmentNotes = [], screenshots = [];
let passed = false;

function fixture() {
  const base = window.wanigan, now = Date.now();
  const proxy = (target, changes) => new Proxy(target, { get: (t, key) => key in changes ? changes[key] : t[key] });
  window.__workflowMutations = [];
  const refuse = name => async (...args) => { window.__workflowMutations.push({ name, args }); throw new Error('Fixture refuses ' + name); };
  localStorage.setItem('wanigan.project', 'p1');
  localStorage.setItem('wanigan.navigation.visible', 'closed');
  const session = (id, title, projectId) => ({ id, displayTitle: title, title, projectId, projectName: projectId === 'p1' ? 'storefront' : 'platform',
    projectPath: '/example/' + projectId, providerId: 'claude', harnessId: 'claude-code', status: 'running', pid: 1000,
    exitCode: null, unread: 0, worktree: null, createdAt: now - 100000, endedAt: null, trust: 'project', capabilities: { hooks: true } });
  window.__workflowSessions = [session('s1', 'Checkout retries · fictional session', 'p1'), session('s2', 'API pagination · fictional session', 'p2'), session('s3', 'Receipt review · fictional session', 'p1')];
  const attention = (sessionId, kind) => ({ sessionId, kind, transitionId: sessionId + ':' + kind, since: now - 10000,
    label: kind === 'finished' ? 'Done' : 'Asking', detail: kind === 'finished' ? 'The agent finished its turn.' : 'Review an original permission prompt in the terminal.', tool: null });
  window.__workflowAttention = [attention('s1', 'permission'), attention('s2', 'permission'), attention('s3', 'finished')];
  window.__workflowRelayFailure = false;
  const kinds = ['plan', 'estimate', 'implement', 'verify', 'review'];
  const nodes = kinds.map((kind, i) => ({ id: 'fixture-' + kind, docketId: 'fixture-relay', kind, title: kind + ' the checkout change',
    instructions: 'Fictional stage evidence. No workload runs in this fixture.', dependsOn: i ? ['fixture-' + kinds[i - 1]] : [], claimPath: null,
    status: kind === 'review' ? 'running' : 'completed', providerId: ['estimate', 'verify'].includes(kind) ? null : 'claude',
    model: 'fixture-model', effort: 'high', accountId: null, permissionMode: null, sessionId: kind === 'review' ? 's3' : null,
    worktree: null, startedAt: now - 100000, endedAt: null, detail: null, deferUntil: null, reopenedAt: null, gateRunningSince: null, gateReturns: 0, queued: false }));
  window.__workflowRelay = { relay: true, docket: { id: 'fixture-relay', projectId: 'p1', projectName: 'storefront', title: 'Checkout evidence · fictional relay',
    objective: 'Review a finished implementation before accepting it.', acceptance: [], risk: 'low', budgetUsd: 5, baseCommit: 'fixture', status: 'review',
    createdAt: now, updatedAt: now, autopilot: { enabled: false }, gate: {}, nodes, proofs: [{ id: 'proof', nodeId: 'fixture-verify', kind: 'test', status: 'passed', summary: 'Fictional recorded check passed.', createdAt: now }], claims: [], checkpoints: [], reviewCommands: 1 },
    nodes: nodes.map(node => ({ nodeId: node.id, effort: node.effort, handbacks: 0, completed: 1, completions: [], route: null })), pipeline: null, forecast: null, handbackLimit: 3 };
  window.wanigan = proxy(base, {
    prefs: proxy(base.prefs, { all: async () => ({ ...(await base.prefs.all()), navSidebar: 'closed', motion: 'off', fluid: 'off' }) }),
    preflight: proxy(base.preflight, { read: async () => ({ agents: [{ id: 'claude', label: 'Fictional agent', harnessId: 'claude-code', found: true,
      path: '/example/fixture-agent', version: 'fixture', signedIn: 'unknown', credential: 'harness-login' }], searched: ['/example'], projects: 2, sessionsStarted: 3 }) }),
    sessions: proxy(base.sessions, { list: async () => structuredClone(window.__workflowSessions), kill: refuse('sessions.kill'), interrupt: refuse('sessions.interrupt'), start: refuse('sessions.start'), write: refuse('sessions.write') }),
    attention: proxy(base.attention, { list: async () => structuredClone(window.__workflowAttention) }),
    teams: proxy(base.teams, { read: async () => ({ teams: [], enabled: false, note: null }) }),
    budgets: proxy(base.budgets, { list: async () => [], breached: async () => [], accuracy: async () => [], set: refuse('budgets.set') }),
    spend: proxy(base.spend, { unified: async () => window.__workflowUnpriced ? [{ day: '2026-09-19', sessionUsd: 0, batchUsd: 0, headlessUsd: 0, unpricedRequests: 1, unpricedHeadlessRows: 0 }] : [],
      byProject: async () => [], effort: async () => [], cache: async () => [], transcripts: async () => null,
      sources: async () => ({ days: 30, since: now, groups: { source: [], skill: [], plugin: [], mcp: [], agent: [] }, totals: {}, rows: 0 }) }),
    batch: proxy(base.batch, { insights: async () => ({ totals: { runs: 0 }, byModel: [], outcomes: [], perRun: [] }) }),
    codex: proxy(base.codex, { usageSummary: async () => ({ totalTokens: 0 }) }),
    usage: proxy(base.usage, { burn: async () => [] }),
    relay: proxy(base.relay, { list: async () => [structuredClone(window.__workflowRelay.docket)], read: async () => {
      if (window.__workflowRelayFailure) throw new Error('Fictional refresh failure'); return structuredClone(window.__workflowRelay);
    }, create: refuse('relay.create'), preview: refuse('relay.preview'), estimate: refuse('relay.estimate') }),
    control: proxy(base.control, { start: refuse('control.start'), complete: refuse('control.complete'), runProof: refuse('control.runProof'), retry: refuse('control.retry') }),
  });
}

const { page, close } = await openRenderer({ width: 1440, height: 1000, instrument: '(' + fixture.toString() + ')();', onError: message => {
  if (message.startsWith('Wanigan orb initialization: Error: A WebGPU adapter is unavailable')) environmentNotes.push('Headless Chromium has no WebGPU adapter; the existing orb fallback is shown.');
  else errors.push(message);
} });
page.setDefaultTimeout(10000);
const capture = async name => {
  await page.evaluate(() => document.activeElement?.blur());
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; }, theme);
    await page.waitForTimeout(80);
    const file = name + '-' + theme + '.png';
    await page.screenshot({ path: path.join(out, file), scale: 'css', animations: 'disabled' });
    screenshots.push({ file, theme, viewport: page.viewportSize() });
  }
};
const refresh = async () => { await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); };
const go = async (chord, selector) => { await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press(chord); await page.locator(selector).waitFor(); };
const fresh = async () => { await page.reload(); await page.locator('.app-header').waitFor(); };
const safe = async () => { assert.deepEqual(await page.evaluate(() => window.__workflowMutations), [], 'no mutation requests'); assert.deepEqual(errors, []); };
try {
  await go('Meta+2', '.fleet-view');
  await page.locator('.fleet-chips').getByRole('button', { name: /Asking/ }).click();
  await page.locator('.fleet-entry').filter({ hasText: 'Checkout retries' }).click();
  await capture('fleet-selected');
  await page.evaluate(() => { window.__workflowAttention[0] = { ...window.__workflowAttention[0], kind: 'working', label: 'Working', detail: 'The agent is continuing the recorded task.' }; });
  await refresh();
  await page.waitForFunction(() => document.querySelectorAll('.fleet-entry').length === 1);
  if (!before) {
    assert.match(await page.locator('.fleet-inspector h2').innerText(), /Checkout retries/);
    assert.match(await page.locator('.fleet-inspector').innerText(), /outside the current status filter/);
  }
  await capture('fleet-status-changed');
  await page.evaluate(() => { window.__workflowAttention[1] = { ...window.__workflowAttention[1], kind: 'working', label: 'Working', detail: 'The agent is continuing the recorded task.' }; });
  await refresh();
  await page.waitForFunction(() => document.querySelectorAll('.fleet-entry').length === 0);
  if (!before) {
    assert.match(await page.locator('.fleet-inspector h2').innerText(), /Checkout retries/);
    assert.equal(await page.locator('.fleet-chips').getByRole('button', { name: /Asking/ }).getAttribute('aria-pressed'), 'true', 'the active empty filter stays visible');
  }
  await capture('fleet-empty-filter');
  await page.setViewportSize({ width: 900, height: 760 }); await capture('fleet-empty-filter-compact');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('.fleet-chips').getByRole('button', { name: before ? /Done/ : /Ready to inspect/ }).click();
  await page.locator('.fleet-entry').filter({ hasText: 'Receipt review' }).click();
  if (!before) assert.match(await page.locator('.fleet-inspector').innerText(), /Ready to inspect/);
  await capture('fleet-finished');
  if (!before) {
    await page.evaluate(() => { window.__workflowAttention[2].label = 'Stopped'; }); await refresh();
    await page.waitForFunction(() => document.querySelector('.fleet-inspector .pill')?.textContent.includes('Stopped'));
  }
  await page.evaluate(() => { window.__workflowSessions = window.__workflowSessions.filter(s => s.id !== 's3'); window.__workflowAttention = window.__workflowAttention.filter(a => a.sessionId !== 's3'); });
  await refresh();
  await page.waitForFunction(() => !document.querySelector('.fleet-inspector')?.textContent.includes('Receipt review'));
  if (!before) assert.match(await page.locator('.fleet-inspector h2').innerText(), /Checkout retries/);
  checks.push(before ? 'Captured Fleet baseline before and after live status changes and record removal.' : 'Fleet preserves the selected session when its live status leaves a filter, retains an empty-filter inspector, and replaces a truly removed record.');
  await safe();

  await fresh(); await go('Meta+5', '.insights');
  await page.getByText(before ? 'Nothing has been billed yet' : 'No recorded activity yet', { exact: true }).waitFor();
  await capture('insights-empty');
  if (!before) {
    assert.equal(await page.locator('.ins-reports > button').count(), 4);
    await page.getByRole('button', { name: 'View budgets', exact: true }).click();
    await page.getByRole('button', { name: 'Set a budget', exact: true }).click();
    await page.getByRole('spinbutton', { name: 'Monthly cap (USD)' }).fill('75');
    await page.locator('.ins-reports').getByRole('button', { name: /Spending/ }).click();
    await page.locator('.ins-reports').getByRole('button', { name: /^Budgets/ }).click();
    assert.equal(await page.getByRole('spinbutton', { name: 'Monthly cap (USD)' }).inputValue(), '75');
    await capture('insights-budget-draft');
    await page.locator('.ins-reports').getByRole('button', { name: /Tokens & pace/ }).click();
    await page.locator('#ins-report-activity').waitFor({ state: 'visible' });
    await page.locator('.ins-reports').getByRole('button', { name: /Batch reports/ }).click();
    await page.locator('#ins-report-batch').waitFor({ state: 'visible' });
    checks.push('Empty Insights exposes all four reports, opens budget creation deliberately, and retains an unsaved budget across report changes.');
  }
  await page.setViewportSize({ width: 900, height: 760 });
  if (!before) await page.locator('.ins-reports').getByRole('button', { name: /Spending/ }).click();
  await capture('insights-empty-compact'); await page.setViewportSize({ width: 1440, height: 1000 });
  if (!before) {
    await go('Meta+2', '.fleet-view');
    await page.evaluate(() => { window.__workflowUnpriced = true; });
    await go('Meta+5', '.insights');
    await page.locator('.ins-filters').waitFor();
    assert.equal(await page.getByText('No recorded activity yet', { exact: true }).count(), 0);
    checks.push('An unpriced recorded request is activity, not an empty ledger.');
  }
  await safe();

  await fresh(); await go('Meta+Shift+R', '.rl-view');
  await page.getByRole('button', { name: 'Approve', exact: true }).waitFor();
  await capture('relay-review');
  await page.evaluate(() => { window.__workflowRelayFailure = true; }); await refresh();
  await page.getByText(/Fictional refresh failure/).waitFor();
  if (!before) for (const name of ['Approve', 'Request changes', 'Reject']) assert(await page.getByRole('button', { name, exact: true }).isDisabled(), name + ' blocked while stale');
  assert(await page.getByRole('button', { name: 'Open live session', exact: true }).isEnabled());
  await capture('relay-stale-review');
  await page.setViewportSize({ width: 900, height: 760 }); await capture('relay-stale-review-compact'); await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { window.__workflowRelayFailure = false; });
  await page.getByRole('button', { name: 'Retry refresh', exact: true }).click();
  await page.waitForFunction(() => !document.body.textContent.includes('Fictional refresh failure'));
  assert(await page.getByRole('button', { name: 'Approve', exact: true }).isEnabled());
  if (!before) {
    for (const [kind, status, name] of [['plan', 'ready', 'Start planning'], ['estimate', 'ready', 'Run forecast'], ['implement', 'running', 'Complete implementation'], ['verify', 'ready', 'Run verification'], ['implement', 'failed', 'Reopen stage']]) {
      await page.evaluate(({ kind, status }) => { let passed = true; window.__workflowRelay.docket.nodes.forEach(node => { node.status = node.kind === kind ? status : passed ? 'completed' : 'blocked'; if (node.kind === kind) passed = false; }); }, { kind, status });
      await refresh(); await page.getByRole('button', { name, exact: true }).waitFor();
      await page.evaluate(() => { window.__workflowRelayFailure = true; }); await refresh();
      await page.getByText(/Fictional refresh failure/).waitFor();
      assert(await page.getByRole('button', { name, exact: true }).isDisabled(), name + ' blocked while stale');
      await page.evaluate(() => { window.__workflowRelayFailure = false; }); await page.getByRole('button', { name: 'Retry refresh', exact: true }).click();
      await page.waitForFunction(() => !document.body.textContent.includes('Fictional refresh failure'));
    }
    checks.push('Stale Relay reads block decisions, launch, completion, forecast, verification and reopening; evidence/session doors remain usable and retry restores actions.');
  }
  await safe();

  await fresh(); await go('Meta+Shift+H', '.home-room');
  if (await page.getByRole('button', { name: 'Back to work', exact: true }).isVisible()) await page.getByRole('button', { name: 'Back to work', exact: true }).click();
  await page.locator('.home-work-row').filter({ hasText: 'Receipt review' }).click();
  if (!before) {
    assert(await page.locator('.home-work-detail').getByRole('button', { name: 'Open session', exact: true }).isVisible());
    assert.match(await page.locator('.home-work-guidance').innerText(), /choose Review work/);
    checks.push('Home names its actual Open session destination and explains the Review work step.');
  }
  await capture('home-finished');
  await safe();
  passed = true;
} catch (error) {
  await page.screenshot({ path: path.join(out, 'failure.png'), scale: 'css' }).catch(() => {});
  throw error;
} finally {
  if (passed && existsSync(path.join(out, 'failure.png'))) unlinkSync(path.join(out, 'failure.png'));
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ phase, passed, rendererRoot, indexSha256: createHash('sha256').update(readFileSync(path.join(rendererRoot, 'index.html'))).digest('hex'),
    provenance: 'Isolated production renderer with explicit fictional records and refused mutations. No real provider, PTY, user-data, budget, or repository operation. Before captures record the old behavior; after assertions verify the listed changes.',
    checks, errors, environmentNotes: [...new Set(environmentNotes)], screenshots }, null, 2) + '\n');
  await close();
}
console.log(JSON.stringify({ phase, checks: checks.length, screenshots: screenshots.length, errors }, null, 2));
