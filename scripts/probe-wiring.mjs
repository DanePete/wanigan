#!/usr/bin/env node
// Built and unreachable, now reachable: transcript recall in Settings, the
// budget note in the launch dialog and Insights, attachment retention, the
// contradiction acts in Knowledge, outcome evidence beside the provider
// picker, and a finished run's turns from Recent. Actual renderer, isolated
// Electron, synthetic services, no real agent calls.
//
//   npm run build && node scripts/probe-wiring.mjs [--before] [--out dir]
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), { _electron } = require('playwright-core');
const root = path.resolve(import.meta.dirname, '..'), before = process.argv.includes('--before');
const outArg = process.argv.indexOf('--out');
const out = outArg >= 0 ? path.resolve(process.argv[outArg + 1]) : path.join(root, 'docs/visuals/wiring', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-wiring-'));
writeFileSync(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({
  executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [path.join(dir, 'main.cjs'), `--user-data-dir=${dir}/profile`], env,
});
const checks = [], errors = [], failures = [];
const record = (text) => { checks.push(text); console.log('✓', text); };
const section = async (name, fn) => {
  try { await fn(); }
  catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); console.log('✗', name, error); }
};
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(STUB);
  await page.addInitScript(() => {
    localStorage.setItem('wanigan.code', '0'); localStorage.setItem('wanigan.composer', '1');
    const api = window.wanigan, now = Date.now(), DAY = 86_400_000;
    window.__calls = [];
    const call = (...args) => window.__calls.push(args);
    window.__recall = { p1: true, p2: false };
    window.__retention = { enabled: false, days: 0, last: null };
    const preview = (days) => ({ enabled: false, windowDays: days, cutoff: now - days * DAY, scanned: 214, directories: 61, filesEligible: 97, bytesEligible: 121_400_000,
      kept: { 'within-window': 118, referenced: 22, 'holds-agent-output': 9, 'session-still-open': 3, 'resumed-later': 1 } });
    const knowledgeItem = (id, title, text, status = 'active') => ({ id, title, kind: 'instruction', scope: 'project', projectId: 'p1', pathScope: null,
      canonicalText: text, status, confidence: 0.86, sourceCount: 2, currentVersion: 1, contentHash: `hash-${id}`, createdAt: now - 20 * DAY,
      updatedAt: now - DAY, lastValidatedAt: now - 2 * DAY, expiresAt: null, supersededBy: null });
    window.__items = [
      knowledgeItem('k1', 'Indent with tabs', 'Indent source files in this project with tabs.'),
      knowledgeItem('k2', 'Indent with two spaces', 'Indent source files in this project with two spaces.'),
      knowledgeItem('k3', 'Wrap at 100 columns', 'Wrap lines at 100 columns in TypeScript files.'),
    ];
    window.__relations = [];
    const past = (id, title, over = {}) => ({ id, conversationId: `conv-${id}`, providerId: 'claude', projectId: 'p2', projectPath: '/example/platform',
      projectName: 'platform', worktree: null, model: 'claude-opus-5', effort: null, permissionMode: null, startedAt: now - 3 * 3600_000,
      endedAt: now - 2 * 3600_000, exitCode: -1, continuationCount: 1, live: true, pinnedAt: null, settledAt: null, title, titleSource: 'agent', ...over });
    const cps = [
      { id: 1, sessionId: 'sp1', turn: 0, kind: 'session-start', at: now - 3 * 3600_000, repoRoot: '/example/platform', commitHash: 'a1b2c3d4e5f60718', treeHash: 't0', filesChanged: null, status: 'ok', detail: null },
      { id: 2, sessionId: 'sp1', turn: 1, kind: 'turn-start', at: now - 3 * 3600_000 + 60_000, repoRoot: '/example/platform', commitHash: 'a1b2c3d4e5f60718', treeHash: 't0', filesChanged: null, status: 'ok', detail: null },
      { id: 3, sessionId: 'sp1', turn: 1, kind: 'turn-end', at: now - 3 * 3600_000 + 600_000, repoRoot: '/example/platform', commitHash: 'b2c3d4e5f6071829', treeHash: 't1', filesChanged: 3, status: 'ok', detail: null },
      { id: 4, sessionId: 'sp1', turn: 2, kind: 'turn-start', at: now - 3 * 3600_000 + 700_000, repoRoot: '/example/platform', commitHash: 'b2c3d4e5f6071829', treeHash: 't1', filesChanged: null, status: 'ok', detail: null },
      { id: 5, sessionId: 'sp1', turn: 2, kind: 'turn-end', at: now - 2 * 3600_000 - 60_000, repoRoot: '/example/platform', commitHash: 'c3d4e5f607182930', treeHash: 't2', filesChanged: 1, status: 'ok', detail: null },
    ];
    const over = (scopeId, scopeName, spent, cap) => ({ scopeId, scopeName, monthlyUsd: cap, spentUsd: spent, sessionUsd: spent, batchUsd: 0, warnAt: 0.8,
      projectedUsd: spent * 2, daysElapsed: 14, daysInMonth: 30 });
    const docket = () => ({
      id: 'g1', projectId: 'p2', projectName: 'platform', title: 'Safe retries', objective: 'Make checkout retries idempotent.',
      acceptance: ['A repeated callback creates one charge.'], risk: 'low', budgetUsd: 20, baseCommit: null, status: 'active',
      createdAt: now - 7200000, updatedAt: now - 60000,
      autopilot: { enabled: false, providerId: null, model: null, budgetUsd: 20, spendUsd: 0, spendStatus: 'none', haltedReason: null },
      nodes: [
        { id: 'n1', docketId: 'g1', kind: 'plan', title: 'Plan the change', instructions: 'Plan.', dependsOn: [], claimPath: null, status: 'completed', providerId: null, model: null, sessionId: null, worktree: null, startedAt: null, endedAt: now - 5000000, detail: 'Planned.', deferUntil: null, reopenedAt: null, queued: false },
        { id: 'n2', docketId: 'g1', kind: 'implement', title: 'Make retries safe', instructions: 'Implement.', dependsOn: ['n1'], claimPath: null, status: 'ready', providerId: null, model: null, sessionId: null, worktree: null, startedAt: null, endedAt: null, detail: null, deferUntil: null, reopenedAt: null, queued: false },
      ],
      claims: [], checkpoints: [], proofs: [],
    });
    const outcomes = [
      { providerId: 'claude', model: 'claude-opus-5', taskKind: 'implement', samples: 5, accepted: 4, testsPassed: 5, totalCostUsd: 12.4, reportedSamples: 5, acceptedRate: 0.8, testPassRate: 1 },
      { providerId: 'codex', model: 'gpt-5.5', taskKind: 'implement', samples: 3, accepted: 1, testsPassed: 2, totalCostUsd: 0, reportedSamples: 0, acceptedRate: 1 / 3, testPassRate: 2 / 3 },
      { providerId: 'claude', model: 'claude-sonnet-5', taskKind: 'verify', samples: 4, accepted: 4, testsPassed: 4, totalCostUsd: 2.1, reportedSamples: 4, acceptedRate: 1, testPassRate: 1 },
    ];
    const services = {
      // Wanigan's own server is switched off in these settings, so nothing is bound.
      mcp: { server: async () => null },
      transcripts: {
        recall: async () => ({ ...window.__recall }),
        setRecall: async (projectId, on) => { call('setRecall', projectId, on); window.__recall[projectId] = on; return on; },
      },
      attach: {
        retention: async () => ({ ...window.__retention }),
        reclaimPreview: async (days) => { call('reclaimPreview', days); return preview(days ?? window.__retention.days); },
        setRetention: async (days) => { call('setRetention', days); window.__retention = { ...window.__retention, enabled: days > 0, days }; return { enabled: days > 0, days }; },
        reclaimNow: async () => {
          call('reclaimNow');
          const pass = { ranAt: Date.now(), how: 'on-request', windowDays: window.__retention.days, scanned: 214, directories: 61, filesRemoved: 97, bytesFreed: 121_380_112, kept: 153, errors: 0, firstError: null };
          window.__retention = { ...window.__retention, last: pass };
          return pass;
        },
      },
      budgets: {
        breached: async () => [over('p2', 'platform', 61.2, 50), over(null, 'All projects', 212.4, 300)],
        list: async () => [over('p2', 'platform', 61.2, 50), over(null, 'All projects', 212.4, 300)],
      },
      learning: {
        knowledge: async () => structuredClone(window.__items),
        relations: async (itemId) => structuredClone(window.__relations.filter((r) => !itemId || r.fromItemId === itemId || r.toItemId === itemId)),
        item: async (id) => ({ item: structuredClone(window.__items.find((i) => i.id === id)), versions: [], evidence: [], projections: [],
          roi: { samples: 0, tokensLoaded: 0, successfulUses: 0, failedUses: 0, tokensSaved: 0, evidenceLevel: 'none', metricCounts: { tokensLoaded: 0, uses: 0, tokensSaved: 0 } } }),
        overview: async () => ({ pending: 0, activeKnowledge: window.__items.filter((i) => i.status === 'active').length, quarantined: window.__items.filter((i) => i.status === 'quarantined').length, activeSkills: 0, experiments: 0, signals: 12, projectedTokenDelta: 0 }),
        diagnostics: async () => [],
        candidates: async () => [],
        signals: async () => [],
        freshness: async (id) => ({ itemId: id, fresh: true, checkedAt: now, checked: 0, skipped: 0, issues: [] }),
        markContradiction: async (a, b, reason) => {
          call('markContradiction', a, b, reason);
          for (const id of [a, b]) window.__items.find((i) => i.id === id).status = 'quarantined';
          const relation = { fromItemId: a, toItemId: b, relation: 'contradicts', confidence: 1, evidence: { reason }, createdAt: Date.now(), resolvedAt: null };
          window.__relations.push(relation);
          return relation;
        },
        keepOverContradiction: async (keep, drop, reason) => {
          call('keepOverContradiction', keep, drop, reason);
          window.__items.find((i) => i.id === drop).status = 'retired';
          window.__items.find((i) => i.id === keep).status = 'active';
          for (const r of window.__relations) if ((r.fromItemId === keep && r.toItemId === drop) || (r.fromItemId === drop && r.toItemId === keep)) r.resolvedAt = Date.now();
          return { kept: window.__items.find((i) => i.id === keep), retired: window.__items.find((i) => i.id === drop) };
        },
      },
      control: {
        list: async () => { const d = docket(); delete d.nodes; delete d.claims; delete d.proofs; delete d.checkpoints; return [d]; },
        get: async () => docket(),
        outcomes: async () => structuredClone(outcomes),
        board: async () => [], events: async () => [], mcpTasks: async () => [], resumeReceipts: async () => [], traces: async () => [],
      },
      sessions: {
        past: async () => [past('sp1', 'Make checkout retries idempotent'), past('sp2', 'Rail width regression', { startedAt: now - 2 * DAY, endedAt: now - 2 * DAY + 3600_000, exitCode: 0, continuationCount: 3 })],
        create: async (opts) => { call('create', opts); throw new Error('Fixture launch refused. No process was started.'); },
        scrollback: async () => 'Wanigan renderer fixture — no live provider\r\n',
      },
      checkpoints: {
        list: async (id) => { call('checkpointsList', id); return id === 'sp1' ? structuredClone(cps) : []; },
        diff: async (id, from, to) => ({ fromLabel: `turn ${from}`, toLabel: `turn ${to}`, files: [{ path: 'src/checkout/retry.ts', status: 'M', additions: 12, deletions: 3 }],
          totalFiles: 1, patch: 'diff --git a/src/checkout/retry.ts b/src/checkout/retry.ts\n@@ -1,3 +1,4 @@\n export function retry() {\n+  const existing = findPayment(key);\n   return charge();\n }\n', truncated: false }),
      },
    };
    window.wanigan = new Proxy(api, { get(target, service) {
      const mine = services[service];
      if (!mine) return target[service];
      return new Proxy(target[service], { get(obj, key) { return mine[key] ?? obj[key]; } });
    } });
  });
  const theme = async (name) => {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; document.documentElement.style.colorScheme = t; }, name);
    await page.waitForTimeout(150);
  };
  const shoot = async (name) => {
    for (const t of ['dark', 'light']) { await theme(t); await page.screenshot({ path: path.join(out, `${name}-${t}.png`), scale: 'css' }); }
    await theme('dark');
  };
  const focusDock = async () => { await page.evaluate(() => document.activeElement?.blur()); await page.locator('.space-dock button').first().focus().catch(() => {}); };
  const go = async (key) => { await focusDock(); await page.keyboard.press(key); };
  const readable = async (locator) => {
    const clipped = await locator.evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent?.slice(0, 80)));
    assert.deepEqual(clipped, [], `clipped text: ${clipped.join(' | ')}`);
  };
  await page.goto(rendererURL); await page.locator('.mission-room').waitFor();

  // 1 · Settings › Connections · transcript recall
  await section('recall', async () => {
    await go('Meta+,');
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
    await page.locator('#settings-tab-connections').click();
    await page.locator('#settings-connections').waitFor({ state: 'visible' });
    const sub = page.locator('.set-sub', { hasText: 'Transcript recall' });
    if (before) {
      assert.equal(await sub.count(), 0);
      await page.locator('.set-sub', { hasText: "Wanigan's own MCP server" }).scrollIntoViewIfNeeded();
      await shoot('recall');
      record('before: Settings offers Wanigan’s MCP server and no way to let a project’s sessions search its transcripts');
      return;
    }
    await sub.scrollIntoViewIfNeeded();
    const list = page.locator('.set-recall-list');
    await list.waitFor();
    assert.match(await page.locator('#settings-connections').innerText(), /Wanigan’s MCP server is off, so no session is offered this tool/);
    const platform = list.getByRole('switch', { name: 'platform', exact: true });
    assert.equal(await platform.getAttribute('aria-checked'), 'false');
    assert.equal(await list.getByRole('switch', { name: 'storefront', exact: true }).getAttribute('aria-checked'), 'true');
    await platform.click();
    await page.getByText(/Sessions in platform can now call wanigan_recall_transcripts/).waitFor();
    assert.deepEqual((await page.evaluate(() => window.__calls)).filter((c) => c[0] === 'setRecall'), [['setRecall', 'p2', true]]);
    assert.equal(await platform.getAttribute('aria-checked'), 'true');
    await sub.scrollIntoViewIfNeeded();
    await shoot('recall');
    record('Settings lists transcript recall per project, says the MCP server being off makes it inert, and switches one project by id');
  });

  // 2 · Settings › Privacy & data · attachment retention
  await section('retention', async () => {
    await page.locator('#settings-tab-privacy').click();
    await page.locator('#settings-privacy').waitFor({ state: 'visible' });
    const heading = page.locator('.set-sub', { hasText: 'Session attachment directories' });
    await heading.waitFor();
    await heading.scrollIntoViewIfNeeded();
    if (before) {
      assert.match(await page.locator('#settings-privacy').innerText(), /This screen cannot yet measure or reclaim it/);
      await shoot('retention');
      record('before: Settings says the attachment directories only grow and that no control has reached the panel');
      return;
    }
    const panel = page.locator('.set-retention');
    await panel.waitFor();
    assert.match(await panel.innerText(), /Retention is off\. Nothing is removed\./);
    await panel.getByLabel('Attachment retention window in days').fill('30');
    await panel.getByRole('button', { name: 'Preview', exact: true }).click();
    await panel.locator('.set-retention-preview').waitFor();
    const previewText = (await panel.locator('.set-retention-preview').innerText()).replace(/\s+/g, ' ');
    assert.match(previewText, /With a 30-day window, 61 of 214 session directories qualify now: 97 files, 115\.78 MB\./);
    assert.match(previewText, /Kept: 118 inside the window, 22 named in a prompt, 9 holding something the agent wrote, 3 still open, 1 resumed by a later session\./);
    assert.equal((await page.evaluate(() => window.__calls)).filter((c) => c[0] === 'setRetention' || c[0] === 'reclaimNow').length, 0, 'a preview deletes nothing');
    await shoot('retention-preview');
    await panel.getByRole('button', { name: 'Switch on…', exact: true }).click();
    const confirm = panel.locator('.confirm-note');
    await confirm.waitFor();
    assert.match(await confirm.innerText(), /Keep attachment directories for 30 days\?/);
    await shoot('retention-confirm');
    await confirm.getByRole('button', { name: 'Switch on and reclaim', exact: true }).click();
    await panel.getByText(/Retention is on at 30 days\. A pass you started .* removed 97 files from 61 directories and freed 115\.76 MB, and kept 153 directories\./).waitFor();
    assert.deepEqual((await page.evaluate(() => window.__calls)).filter((c) => c[0] === 'setRetention' || c[0] === 'reclaimNow'), [['setRetention', 30], ['reclaimNow']]);
    assert.equal(((await panel.innerText()).match(/A pass you started/g) ?? []).length, 1, 'the pass is stated once, not in the note and again below it');
    await readable(panel.locator('p'));
    await shoot('retention-on');
    record('attachment retention previews a window (what would go and why the rest stays) without deleting, waits for a confirmation, then reports the measured pass');
  });

  // 3 · the launch dialog · over budget
  await section('launch budget', async () => {
    await go('Meta+1'); await page.locator('.sessions-view').waitFor();
    await go('Meta+t');
    const dialog = page.getByRole('dialog', { name: 'New session', exact: true });
    await dialog.waitFor();
    await dialog.getByLabel('Project', { exact: false }).first().selectOption('p2').catch(() => {});
    await page.waitForTimeout(400);
    const note = dialog.locator('.note', { hasText: 'over this month’s budget' });
    if (before) {
      assert.equal(await note.count(), 0);
      await dialog.locator('#launch-message').scrollIntoViewIfNeeded().catch(() => {});
      await shoot('launch-budget');
      record('before: the launch dialog says nothing when the project is already over its monthly budget');
    } else {
      await note.waitFor();
      await note.scrollIntoViewIfNeeded();
      assert.match((await note.innerText()).replace(/\s+/g, ' '), /platform is over this month’s budget — \$61\.20 of \$50\.00\. This session is not held, because you are starting it\./);
      await shoot('launch-budget');
      record('the launch dialog names the over-budget scope and figures, and says the session a person starts is not held');
    }
    await page.keyboard.press('Escape');
  });

  // 4 · Insights · the breach banner and the budget editor
  await section('insights', async () => {
    await go('Meta+5'); await page.locator('.insights').waitFor();
    const banner = page.locator('.insights .note', { hasText: 'budget' }).first();
    await banner.waitFor();
    if (!before) {
      assert.match((await banner.innerText()).replace(/\s+/g, ' '), /wait in the queue until its budget is raised or the month turns/);
      record('Insights says a scope that is over holds its queued headless runs, scheduled batches and autopilot goal tasks');
    }
    await shoot('insights-budget');
  });

  // 5 · Knowledge · a contradiction recorded and resolved
  await section('contradiction', async () => {
    await go('Meta+6');
    await page.getByRole('tab', { name: /^Knowledge/ }).click();
    await page.locator('.knowledge-row').first().waitFor();
    const picks = page.locator('.knowledge-pick');
    await picks.nth(0).check(); await picks.nth(1).check();
    const bar = page.locator('.knowledge-bulkbar');
    await bar.waitFor();
    const contest = bar.getByRole('button', { name: 'They contradict each other…', exact: true });
    if (before) {
      assert.equal(await contest.count(), 0);
      await shoot('knowledge-select');
      record('before: two selected knowledge items can only be retired; nothing records that they contradict each other');
      return;
    }
    await shoot('knowledge-select');
    await contest.click();
    const dialog = page.getByRole('dialog', { name: 'Record a contradiction' });
    await dialog.waitFor();
    const record_ = dialog.getByRole('button', { name: 'Record the contradiction' });
    assert(await record_.isDisabled(), 'a contradiction waits for a reason');
    await dialog.getByRole('textbox').fill('One says tabs, the other two spaces.');
    await shoot('knowledge-record');
    await record_.click();
    await page.getByText(/are both quarantined — left out of every briefing — until you keep one/).waitFor();
    assert.deepEqual((await page.evaluate(() => window.__calls)).filter((c) => c[0] === 'markContradiction'), [['markContradiction', 'k1', 'k2', 'One says tabs, the other two spaces.']]);
    await page.locator('.knowledge-row', { hasText: 'Indent with tabs' }).click();
    await page.getByRole('radio', { name: 'Evidence' }).click().catch(async () => { await page.getByRole('button', { name: 'Evidence', exact: true }).click(); });
    const actions = page.locator('.knowledge-contest-actions');
    await actions.waitFor();
    await readable(actions.locator('button'));
    await shoot('knowledge-resolve');
    await actions.getByRole('button', { name: 'Keep this item…', exact: true }).click();
    const resolve = page.getByRole('dialog', { name: 'Resolve a contradiction' });
    await resolve.waitFor();
    await resolve.getByRole('textbox').fill('The formatter config uses tabs.');
    await resolve.getByRole('button', { name: 'Keep it, retire “Indent with two spaces”' }).click();
    await page.getByText(/Kept “Indent with tabs” and retired “Indent with two spaces” with your reason\./).waitFor();
    assert.deepEqual((await page.evaluate(() => window.__calls)).filter((c) => c[0] === 'keepOverContradiction'), [['keepOverContradiction', 'k1', 'k2', 'The formatter config uses tabs.']]);
    record('Knowledge records a contradiction between two selected items only with a reason, then resolves it from Evidence by keeping one and retiring the other');
  });

  // 6 · Control · outcome evidence beside the provider choice
  await section('outcomes', async () => {
    await go('Meta+3');
    await page.getByText('Safe retries').first().click().catch(() => {});
    const execution = page.locator('details.control-execution');
    await execution.waitFor();
    await execution.locator('summary').click();
    await execution.locator('.control-launch').waitFor();
    await execution.scrollIntoViewIfNeeded();
    if (!before) {
      const hint = execution.locator('.hint', { hasText: 'Recorded implement outcomes across goals' });
      await hint.waitFor();
      assert.match((await hint.innerText()).replace(/\s+/g, ' '),
        /Recorded implement outcomes across goals: claude · claude-opus-5 accepted 4 of 5; codex · gpt-5\.5 accepted 1 of 3\. Claude Code so far: claude · claude-opus-5 accepted 4 of 5\. Counts to read, not a recommendation; Wanigan does not choose from them\./);
      record('the provider choice for the next task shows that kind’s recorded outcomes and the chosen provider’s own, and says Wanigan picks nothing from them');
    }
    await shoot('control-outcomes');
  });

  // 7 · Sessions › Recent · a finished run's turns
  await section('past turns', async () => {
    await go('Meta+1'); await page.locator('.sessions-view').waitFor();
    if (await page.locator('.sessions--compact-picker:not(.sessions--picker-open)').count()) {
      await page.locator('[aria-controls="wanigan-session-picker"], .session-picker-open-btn').first().click().catch(() => {});
    }
    const row = page.locator('.past-row', { hasText: 'Make checkout retries idempotent' });
    await row.waitFor();
    await row.hover();
    const turns = row.getByRole('button', { name: /Read the turns and timeline of Make checkout retries idempotent/ });
    if (before) {
      assert.equal(await turns.count(), 0);
      await shoot('recent');
      record('before: a finished run in Recent can be resumed, pinned, settled or forgotten, and its turns cannot be opened');
      return;
    }
    await shoot('recent');
    await turns.click();
    const sheet = page.getByRole('dialog', { name: 'Make checkout retries idempotent' });
    await sheet.waitFor();
    await sheet.getByText('Turn 1', { exact: false }).first().waitFor();
    assert((await page.evaluate(() => window.__calls)).some((c) => c[0] === 'checkpointsList' && c[1] === 'sp1'));
    await sheet.getByText('Turn 2', { exact: false }).first().click();
    await sheet.getByText('src/checkout/retry.ts').first().waitFor();
    assert.equal(await sheet.getByRole('button', { name: /follow/ }).count(), 0, 'a finished run offers nothing to follow');
    await readable(sheet.locator('.past-evidence-title > *'));
    await shoot('past-turns');
    record('each Recent row opens its finished run’s turns by that run’s id, and a turn’s diff reads without resuming it');
    await page.keyboard.press('Escape');
  });

  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({
    at: new Date().toISOString(),
    provenance: 'Actual Electron renderer from out/renderer of the checkout this script ran in; synthetic services; no real agent calls',
    mode: before ? 'before' : 'after', checks, errors, failures,
  }, null, 2) + '\n');
  assert.deepEqual(failures, []);
  assert.deepEqual(errors, []);
} finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
