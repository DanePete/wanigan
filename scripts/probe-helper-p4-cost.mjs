#!/usr/bin/env node
// Visual evidence for the cost, quota and context sweep (helper sweep · P4).
//
// Plain Chromium with the preload bridge stubbed (scripts/renderer-harness.mjs):
// evidence about layout, wording and both palettes — never about IPC, SQLite or
// the CLIs. Every cost.* channel is answered by a fixture below whose shape is
// the TypeScript type in src/shared/cost-types.ts, spend-yield.ts and
// session-anatomy.ts; a fixture that disagrees with its type is worse than
// none (see the browser-shot-harness memory), so each is spelled out in full.
//
// Usage:
//   npm run build && node scripts/probe-helper-p4-cost.mjs            → docs/visuals/helper-p4-cost/after
//   node scripts/probe-helper-p4-cost.mjs --before --out <dir>        → run from a checkout of the base commit
//
// With --before the new elements are expected to be absent: the same views are
// photographed at the same navigation state, and the probe asserts absence.
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openRenderer } from './renderer-harness.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const BEFORE = args.includes('--before');
const outArg = args.indexOf('--out');
const OUT = path.resolve(REPO, outArg >= 0 ? args[outArg + 1] : `docs/visuals/helper-p4-cost/${BEFORE ? 'before' : 'after'}`);
mkdirSync(OUT, { recursive: true });

let failures = 0;
const results = [];
const check = (ok, label, detail) => {
  results.push({ ok, label });
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`);
  if (!ok) { failures += 1; if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 500)}`); }
};
const errors = [];
const onError = (m) => { if (!/WebGPU|GPU|webgl/i.test(m)) errors.push(m); };

// Runs after the harness stub, before the bundle. No back-ticks: this string is
// injected as a script and kept plain.
const INSTRUMENT = String.raw`
(() => {
  const base = window.wanigan;
  const now = Date.now();
  const H = 3600000, M = 60000;
  try { localStorage.setItem('wanigan.code', '1'); } catch {}
  const bucket = (sessions, costUsd, unpricedSessions) => ({ sessions, costUsd, unpricedSessions });
  const over = {
    'sessions.list': [
      { id: 's1', projectId: 'p1', projectName: 'storefront', providerId: 'claude', harnessId: 'claude-code', status: 'running', pid: 4021, exitCode: null, unread: 0, title: 'Checkout retries', worktree: null, label: null, accountLabel: 'work', createdAt: now - 3 * H, endedAt: null },
      { id: 's2', projectId: 'p2', projectName: 'platform', providerId: 'claude', harnessId: 'claude-code', backendId: 'anthropic', status: 'running', pid: 4088, exitCode: null, unread: 0, title: 'Rail refactor', worktree: null, label: null, accountLabel: 'personal', createdAt: now - 2 * H, endedAt: null },
    ],
    'attention.list': [
      { sessionId: 's1', kind: 'idle', transitionId: 't1', since: now - 70 * M, label: 'Idle', detail: null, tool: null, projectName: 'storefront' },
      { sessionId: 's2', kind: 'idle', transitionId: 't2', since: now - 68 * M, label: 'Idle', detail: null, tool: null, projectName: 'platform' },
    ],
    'cost.yield': {
      days: 30, since: now - 30 * 24 * H, revertChecks: 2,
      note: 'Outcomes are recorded when Wanigan merges or removes a worktree. Removals before that record existed, and sessions that ran without a worktree, are not recorded rather than guessed. Dollars are the CLI’s own reported cost; sessions without a reported cost are counted beside the money, never added as $0. "Reverted" means a later commit on the target branch says "This reverts commit" for the merge itself.',
      groups: [
        { projectId: 'p1', projectName: 'storefront', model: 'claude-fable-5', repositories: ['https://example.com/acme/storefront.git'],
          merged: bucket(4, 18.4, 0), reverted: bucket(1, 3.1, 0), discarded: bucket(2, 6.25, 0), removedClean: bucket(1, 0.4, 0), open: bucket(2, 4.1, 1),
          notRecorded: { ...bucket(3, 2.2, 0), noWorktree: 2, historical: 1 },
          costPerMergedCommit: { status: 'observed', usdPerCommit: 1.53, commits: 12, costUsd: 18.4 },
          sessions: [
            { sessionId: 's1', source: 'session', bucket: 'open', reverted: false, costUsd: 3.2, priced: true },
            { sessionId: 'x1', source: 'session', bucket: 'merged', reverted: true, costUsd: 3.1, priced: true },
            { sessionId: 'x2', source: 'headless', bucket: 'discarded', reverted: false, costUsd: 2.05, priced: true },
          ] },
        { projectId: 'p2', projectName: 'platform', model: 'gpt-6-astra', repositories: [],
          merged: bucket(2, 0, 2), reverted: bucket(0, 0, 0), discarded: bucket(0, 0, 0), removedClean: bucket(0, 0, 0), open: bucket(1, 0, 1),
          notRecorded: { ...bucket(1, 0, 1), noWorktree: 1, historical: 0 },
          costPerMergedCommit: { status: 'withheld', reason: 'unpriced-merge' }, sessions: [] },
      ],
      detail: {
        s1: { title: 'Checkout retries', startedAt: now - 3 * H, live: true, worktree: '/example/wt/storefront-a1', branch: 'wanigan/checkout-a1', mergeSha: null, revertedBy: null, commits: null },
        x1: { title: 'Discount rounding', startedAt: now - 5 * 24 * H, live: false, worktree: '/example/wt/storefront-b2', branch: 'wanigan/discount-b2', mergeSha: '4f1c2a9e0d', revertedBy: '9a8b7c6d5e', commits: 3 },
        x2: { title: 'Headless · nightly lint', startedAt: now - 2 * 24 * H, live: false, worktree: '/example/wt/storefront-c3', branch: 'wanigan/nightly-c3', mergeSha: null, revertedBy: null, commits: 1 },
      },
    },
    'cost.codexCredits': {
      days: 30,
      rateCard: { source: 'OpenAI Codex pricing, credits per 1M tokens (learn.chatgpt.com/docs/pricing)', readOn: '14 Sep 2026', fastMultiplier: 2.5,
        models: { 'gpt-6-astra': { input: 250, cached: 25, output: 1250 }, 'gpt-5.6-sol': { input: 100, cached: 10, output: 500 }, 'gpt-5.6-terra': { input: 50, cached: 5, output: 300 }, 'gpt-5.6-luna': { input: 5, cached: 0.5, output: 30 } } },
      sessions: [
        { sessionId: 'c1', title: 'Rail refactor', projectName: 'platform', startedAt: now - 2 * H, authMode: 'chatgpt', tokens: { input: 1210000, cached: 900000, output: 42000 },
          estimate: { status: 'estimated', model: 'gpt-6-astra', credits: 152.5, range: null, fast: true, tierNote: 'fast' } },
        { sessionId: 'c2', title: 'Flaky test hunt', projectName: 'storefront', startedAt: now - 26 * H, authMode: 'chatgpt', tokens: { input: 480000, cached: 300000, output: 21000 },
          estimate: { status: 'estimated', model: 'gpt-5.6-sol', credits: 31.5, range: null, fast: null, tierNote: 'tier not recorded' } },
        { sessionId: 'c3', title: 'Old experiment', projectName: 'platform', startedAt: now - 3 * 24 * H, authMode: 'chatgpt', tokens: null,
          estimate: { status: 'no-rate', model: 'gpt-reserve', reason: 'gpt-reserve is not on the 14 Sep 2026 rate card.' } },
      ],
      totalCredits: 184, upperCredits: 184, estimatedSessions: 2, tierNotRecorded: 1, unestimated: 1,
    },
    'cost.causes': {
      days: 30,
      idle: { gaps: 14, cappedTokens: 612000, uncappedTokens: 1840000, requestsRead: 5210, truncated: false,
        conversations: [
          { conversation: 'c0ffee01', gaps: 6, cappedTokens: 310000, uncappedTokens: 910000, longestGapMs: 72 * M, sessionId: 's1', live: true, title: 'Checkout retries', where: 'storefront' },
          { conversation: 'c0ffee02', gaps: 4, cappedTokens: 190000, uncappedTokens: 520000, longestGapMs: 41 * M, sessionId: null, live: false, title: null, where: '/example/scratch' },
        ] },
      reads: { files: 5, sessions: 2, extraReads: 17,
        rows: [
          { sessionId: 's1', path: '/example/storefront/src/Checkout.php', reads: 9, live: true, title: 'Checkout retries', where: 'storefront' },
          { sessionId: 's2', path: '/example/platform/src/rail/Rail.tsx', reads: 5, live: true, title: 'Rail refactor', where: 'platform' },
        ] },
      mcp: { days: 14, configured: 4, hooklessNote: 'Calls from a harness without Wanigan’s hooks never reach this count.',
        unused: [
          { id: 'm1', name: 'figma-export', enabled: true, createdAt: now - 40 * 24 * H, callsInWindow: 0, lastCalledAt: null },
          { id: 'm2', name: 'jira-cloud', enabled: true, createdAt: now - 90 * 24 * H, callsInWindow: 0, lastCalledAt: now - 31 * 24 * H },
        ] },
      cacheMiss: { recorded: true, missedTokens: 88100, transcriptsScanned: 38, sessionsConsidered: 41, cliVersions: ['2.1.270', '2.1.271'],
        types: [{ type: 'tools_changed', count: 11 }, { type: 'unavailable', count: 4 }, { type: 'previous_message_not_found', count: 1 }],
        sessions: [{ sessionId: 's1', live: true, title: 'Checkout retries', where: 'storefront', types: { tools_changed: 7 } }],
        note: 'Reasons as Claude Code recorded them in message.diagnostics.cache_miss_reason; this is the harness’s own claim.' },
    },
    'context.instructions': (root) => {
      const file = (name, scope, order, extra) => Object.assign({ path: root + '/' + name, scope, exists: true, bytes: 1800, lines: 40, order, depth: 0, importedBy: null, external: false, conditional: null, duplicate: false, warnings: [], excludedBy: null }, extra || {});
      const files = [file('CLAUDE.md', 'project', 1), file('AGENTS.md', 'import', 2, { depth: 1, importedBy: root + '/CLAUDE.md', bytes: 3400, lines: 74 })];
      return { harness: 'claude-code', files, totalBytes: 5200, totalLines: 114, atLaunch: files, onDemand: [], notes: [], root, isGitRepo: true };
    },
    'cost.referenceLint': {
      files: [{ path: '/example/platform/CLAUDE.md', harness: 'claude-code', references: 14 }, { path: '/example/platform/AGENTS.md', harness: 'both', references: 22 }],
      issues: [
        { file: '/example/platform/AGENTS.md', line: 31, kind: 'path', text: 'src/main/checkout/Retry.php', suggestion: 'src/Checkout/Retry.php' },
        { file: '/example/platform/CLAUDE.md', line: 12, kind: 'command', text: 'yarn', suggestion: null },
      ],
      tracked: true,
      note: 'Backticked paths are checked relative to the file and to the repository root; shell-fenced commands against the login-shell PATH agents launch with. URLs, globs, ~/ paths, $VARIABLES, <placeholders> and two-word spans like "and/or" are never flagged. Files outside the project are not read.',
    },
    'cost.codexLoader': {
      projectRoot: '/example/platform', codexHome: '/example/home/.codex', accountLabel: 'Personal', homeSource: 'account',
      configPath: '/example/home/.codex/config.toml', configExists: true, maxBytes: 32768, maxBytesFrom: 'default', fallbacks: [], rootMarkers: ['.git'], rootDir: '/example/platform',
      chain: { maxBytes: 32768, loadedBytes: 32768, totalBytes: 35980, droppedBytes: 3212, usedShare: 1.098,
        files: [
          { path: '/example/platform/AGENTS.md', dir: '/example/platform', name: 'AGENTS.md', bytes: 29800, offset: 0, loadedBytes: 29800, status: 'loaded', droppedRange: null, shadows: [], runningTotal: 29800 },
          { path: '/example/platform/src/AGENTS.override.md', dir: '/example/platform/src', name: 'AGENTS.override.md', bytes: 6180, offset: 29800, loadedBytes: 2968, status: 'truncated', droppedRange: [2968, 6180], shadows: ['AGENTS.md'], runningTotal: 32768 },
        ] },
      global: { path: '/example/home/.codex/AGENTS.md', name: 'AGENTS.md', bytes: 912 },
      model: 'gpt-6-astra', contextWindow: 272000, contextWindowSource: 'models_cache.json',
      skillBudget: { status: 'known', tokens: 5440, source: 'window-share', contextWindow: 272000 },
      skills: [
        { name: 'imagegen', description: 'Generate or edit raster images', path: '/example/home/.codex/skills/.system/imagegen/SKILL.md', dir: '/example/home/.codex/skills/.system/imagegen', root: 'codex-home', implicit: null, listed: true, estTokens: 132 },
        { name: 'review-agent', description: 'Find actionable bugs in code changes', path: '/example/home/.codex/skills/.system/review-agent/SKILL.md', dir: '/example/home/.codex/skills/.system/review-agent', root: 'codex-home', implicit: false, listed: false, estTokens: 0 },
        { name: 'release-notes', description: 'Draft release notes from merged changes', path: '/example/platform/.agents/skills/release-notes/SKILL.md', dir: '/example/platform/.agents/skills/release-notes', root: 'project', implicit: null, listed: true, estTokens: 41 },
      ],
      listedSkills: 2, listedTokens: 173,
      notes: ['Profile-level overrides are not read. Whether a whitespace-only AGENTS.md consumes budget is modelled as not.'],
    },
    'cost.agentDefinitions': {
      keySince: '2.1.271', installedVersion: '2.1.271 (Claude Code)', supported: true,
      note: 'Marked from each file’s frontmatter. Built-in agents are not listed here; the 2.1.271 binary turns omitClaudeMd on for built-ins such as Explore.',
      agents: [
        { name: 'migration-checker', description: 'Checks a migration against the schema contract', path: '/example/platform/.claude/agents/migration-checker.md', scope: 'project', plugin: null, model: 'inherit', omitClaudeMd: true },
        { name: 'reviewer', description: 'Reviews a diff for the storefront conventions', path: '/example/platform/.claude/agents/reviewer.md', scope: 'project', plugin: null, model: null, omitClaudeMd: false },
        { name: 'docs:writer', description: 'Writes user-facing docs', path: '/example/home/.claude/plugins/cache/docs/agents/writer.md', scope: 'plugin', plugin: 'docs@example', model: 'claude-sonnet-5', omitClaudeMd: 'unknown' },
      ],
    },
    'cost.skillListing': {
      codexHome: '/example/home/.codex',
      note: 'Token figures estimate each listed skill’s name and description, the part a harness shows the model every turn; the skill body loads only when the skill is used. A skill whose setting Wanigan cannot read is counted as listed.',
      providers: [
        { harness: 'claude-code', label: 'Claude Code', listed: 2, hidden: 1, unknown: 0, estTokens: 96, rows: [
          { harness: 'claude-code', name: 'tidy-imports', description: 'Sort imports before a commit', path: '/example/home/.claude/skills/tidy-imports/SKILL.md', source: 'user', listed: true, decidedBy: 'default', personal: true, managed: true, toggle: true, estTokens: 38 },
          { harness: 'claude-code', name: 'deploy-check', description: 'Run the deploy checklist', path: '/example/storefront/.claude/skills/deploy-check/SKILL.md', source: 'project', listed: true, decidedBy: 'default', personal: false, managed: false, toggle: false, estTokens: 58 },
          { harness: 'claude-code', name: 'scratch', description: 'Personal notes skill', path: '/example/home/.claude/skills/scratch/SKILL.md', source: 'user', listed: false, decidedBy: 'disable-model-invocation', personal: true, managed: false, toggle: false, estTokens: 0 },
        ] },
        { harness: 'codex', label: 'Codex', listed: 1, hidden: 1, unknown: 0, estTokens: 132, rows: [
          { harness: 'codex', name: 'imagegen', description: 'Generate or edit raster images', path: '/example/home/.codex/skills/.system/imagegen/SKILL.md', source: 'codex-home', listed: true, decidedBy: 'default', personal: false, managed: false, toggle: false, estTokens: 132 },
          { harness: 'codex', name: 'lean-diff', description: 'Keep a diff small', path: '/example/home/.agents/skills/lean-diff/SKILL.md', source: 'personal', listed: false, decidedBy: 'allow_implicit_invocation', personal: true, managed: true, toggle: true, estTokens: 0 },
        ] },
      ],
    },
    'cost.projectionBudget': { applies: true, target: '/example/storefront/src/AGENTS.md', kind: 'agents-md', verdict: 'refuse', share: 1.12,
      reason: 'The projected block would end at byte 36,410 of the AGENTS.md chain, past Codex’s 32,768-byte project_doc_max_bytes cut, so sessions would never see it. Shorten or remove earlier instructions, or raise project_doc_max_bytes in this account’s config.toml.' },
    'learning.candidates': [{
      id: 'cand1', itemId: null, targetKind: 'instruction', scope: 'path', providerId: 'codex', projectId: 'p1', pathScope: 'src/**',
      title: 'Retry payments idempotently', proposedText: 'Return the stored payment when the idempotency key matches.', rationale: 'Three sessions re-implemented the retry and one duplicated a charge.',
      confidence: 0.8, status: 'pending', evidenceCount: 3, taskCount: 3, estimatedTokenDelta: 60, conflicts: [], signalIds: [], createdAt: now - H, updatedAt: now - H,
      reviewedAt: null, reviewerNote: null, clusterKey: null, snoozedAt: null, wake: null,
    }],
    'cost.windowShare': {
      note: 'Shares are of the tokens Wanigan’s own Claude Code sessions reported in the window, not of the provider’s limit: work outside Wanigan, and Codex sessions (whose counters are not timestamped per request), are not in them.',
      accounts: [
        { accountId: 'a1', label: 'Personal', windowStart: now - 2.2 * H, windowFrom: 'reported-reset', usedPercent: 53, readingAt: now - M, totalTokens: 4180000,
          sessions: [
            { sessionId: 's1', tokens: 2930000, share: 0.701, live: true, title: 'Checkout retries', project: 'storefront' },
            { sessionId: 's2', tokens: 1040000, share: 0.249, live: true, title: 'Rail refactor', project: 'platform' },
            { sessionId: 's3', tokens: 210000, share: 0.05, live: false, title: 'Morning triage', project: 'platform' },
          ] },
        { accountId: 'a2', label: 'Work', windowStart: now - 5 * H, windowFrom: 'rolling', usedPercent: 0, readingAt: now - M, totalTokens: 0, sessions: [] },
      ],
    },
    'schedule.list': [{ id: 'sch1', name: 'Nightly flaky-test hunt', cron: '7 3 * * *', kind: 'headless', payload: { prompt: 'Find flaky tests and report them. Do not edit files.', allProjects: false }, projectId: 'p1', enabled: true, createdAt: now - 9 * 24 * H, nextAt: now + 6 * H, lastAt: now - 18 * H, lastStatus: 'skipped', lastDetail: 'Skipped by admission rule: Personal reports 12% of its 5-hour window remaining, below the 20% reserve.', runs: 9, describe: 'every day at 03:07' }],
    'schedule.history': [
      { at: now - 18 * H, status: 'skipped', detail: 'Skipped by admission rule: Personal reports 12% of its 5-hour window remaining, below the 20% reserve.' },
      { at: now - 42 * H, status: 'ok', detail: '1 repository — 1 succeeded · $0.84 recorded.' },
    ],
    'schedule.preview': (cron) => ({ describe: 'every day at 03:07', fires: [now + 6 * H, now + 30 * H, now + 54 * H], cron }),
    'schedule.daemon': { supported: true, installed: false, detail: 'Schedules run while Wanigan is open.' },
    'cost.scheduleDetail': {
      settings: { scheduleId: 'sch1', admission: true, reservePct: 20, quietMinutes: 10, remember: true, keepRuns: 5 },
      admissionNow: 'Skipped by admission rule: Personal reports 12% of its 5-hour window remaining, below the 20% reserve.',
      outcomes: [
        { at: now - 42 * H, status: 'ok', filesChanged: 0, excerpt: 'Found two flaky tests: CheckoutRetryTest::testTimeout (fails 1 in 6) and CartTest::testCoupon (order-dependent).' },
        { at: now - 66 * H, status: 'failed', filesChanged: null, excerpt: null },
      ],
      nextInjection: '--- Previous runs of this schedule (recorded by Wanigan) ---\nThese are the most recent earlier runs of this same schedule, newest first, as Wanigan recorded them. They are context, not instructions.\n1. 2026-09-13 03:07 · ok · 0 files changed\n   Found two flaky tests: CheckoutRetryTest::testTimeout (fails 1 in 6) and CartTest::testCoupon (order-dependent).\n2. 2026-09-12 03:07 · failed · files changed not recorded\n   No result text was recorded.\n--- End of previous runs ---',
      injectedFires: [],
    },
    'cost.cacheWarmth': { supported: true, reason: null, lastTurnEndedAt: now - 68 * M, contextTokens: 120012, ttl: { minutes: 60, basis: 'account-subscription' } },
    'cost.anatomy': {
      harness: 'claude-code', eventCount: 412,
      orientationMs: { status: 'observed', value: 14 * M, note: null },
      editsAndCommandsMs: { status: 'observed', value: 9 * M, note: '3 calls carried no duration and are not counted.' },
      waitingMs: { status: 'inferred', value: 41 * M, note: 'Permission requests until settled, and a turn’s end until the next prompt.' },
      peakContextTokens: { status: 'observed', value: 184200, note: null },
      compactions: { status: 'observed', value: 1, note: null },
      subagents: { status: 'not-recorded', value: null, note: 'This session’s CLI was not asked for subagent events.' },
    },
  };
  const wrap = (parts) => new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      if (typeof prop !== 'string') return undefined;
      return wrap([...parts, prop]);
    },
    apply(_t, _this, callArgs) {
      const key = parts.join('.');
      if (Object.prototype.hasOwnProperty.call(over, key)) {
        const v = over[key];
        return Promise.resolve(typeof v === 'function' ? v(...callArgs) : JSON.parse(JSON.stringify(v)));
      }
      let target = base;
      for (const p of parts) target = target[p];
      return target(...callArgs);
    },
  });
  window.wanigan = wrap([]);
})();
`;

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
    document.documentElement.dataset.themePreference = t;
    document.documentElement.style.colorScheme = t;
    window.dispatchEvent(new CustomEvent('wanigan:theme-changed', { detail: { preference: t, resolved: t } }));
  }, theme);
  await page.waitForTimeout(300);
}

async function chord(page, keys) {
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.keyboard.press(keys);
  await page.waitForTimeout(900);
}

/** The element is on screen, has size, and nothing inside it overflows sideways. */
async function visibleAndUnclipped(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { present: false };
    el.scrollIntoView({ block: 'start' });
    const r = el.getBoundingClientRect();
    const clipped = [...el.querySelectorAll('h3, h4, .stat-value, .cost-cause-value, .cost-cell-money, strong')]
      .filter((node) => node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflow !== 'visible').length;
    const text = el.innerText;
    return { present: true, width: Math.round(r.width), height: Math.round(r.height), clipped, bad: /NaN|undefined|\[object Object\]|Invalid Date/.test(text) };
  }, selector);
}

async function capture(page, name, theme) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, `${name}-${theme}.png`) });
}

async function expectElement(page, name, selector, theme) {
  const state = await visibleAndUnclipped(page, selector);
  if (BEFORE) {
    check(!state.present, `${theme} · ${name}: absent before the change`, state);
  } else {
    check(state.present && state.width > 0 && state.height > 0, `${theme} · ${name}: rendered`, state);
    check(state.present && state.clipped === 0, `${theme} · ${name}: no clipped headings or values`, state);
    check(state.present && !state.bad, `${theme} · ${name}: no NaN/undefined/[object Object] on screen`, state);
  }
  await page.waitForTimeout(150);
  await capture(page, name, theme);
}

for (const theme of ['dark', 'light']) {
  console.log(`── ${theme}${BEFORE ? ' (before)' : ''}`);
  const { page, close } = await openRenderer({ theme, width: 1440, height: 900, onError, instrument: INSTRUMENT });
  try {
    await setTheme(page, theme);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check(true, `${theme} · palette applied (body ${bg})`);

    // Insights › Spending: where the money went, Codex credits.
    await chord(page, 'Meta+5');
    await page.locator('.insights').first().waitFor({ timeout: 10000 });
    await page.waitForTimeout(800);
    if (BEFORE) {
      await page.evaluate(() => document.querySelector('#ins-report-spending .chart-card:last-of-type')?.scrollIntoView({ block: 'end' }));
    }
    await expectElement(page, 'insights-where-the-money-went', 'section[aria-label="Where the money went"]', theme);
    if (!BEFORE) {
      const expanded = await page.evaluate(() => {
        const button = document.querySelector('section[aria-label="Where the money went"] .cost-row-toggle');
        button?.click();
        return !!button;
      });
      await page.waitForTimeout(300);
      check(expanded && await page.locator('.cost-drill-list li').count() === 3, `${theme} · a project row expands to its sessions`);
      await page.evaluate(() => document.querySelector('.cost-drill')?.scrollIntoView({ block: 'center' }));
      await capture(page, 'insights-yield-drill-through', theme);
    }
    await expectElement(page, 'insights-codex-credits', 'section[aria-label="Codex credits"]', theme);

    // Insights › Tokens & pace: cost by cause.
    await page.getByRole('button', { name: /Tokens & pace/ }).click();
    await page.waitForTimeout(700);
    await expectElement(page, 'insights-cost-by-cause', 'section[aria-label="Cost by cause"]', theme);

    // Context: stale references (Instructions), Codex loader, Subagents.
    await chord(page, 'Meta+Shift+c');
    await page.locator('.ctx-view').first().waitFor({ timeout: 10000 });
    await page.waitForTimeout(900);
    const tabs = page.getByRole('tablist', { name: 'Context sections' });
    await tabs.getByRole('tab', { name: 'Instructions', exact: true }).click().catch(() => {});
    await page.waitForTimeout(500);
    if (BEFORE) {
      await capture(page, 'context-instructions', theme);
      check(await page.getByText('References that do not resolve').count() === 0, `${theme} · context lint: absent before the change`);
      check(await tabs.getByRole('tab', { name: 'Codex loader', exact: true }).count() === 0, `${theme} · Codex loader area: absent before the change`);
      await tabs.getByRole('tab', { name: 'AGENTS.md', exact: true }).click().catch(() => {});
      await page.waitForTimeout(400);
      await capture(page, 'context-agents-md', theme);
      await tabs.getByRole('tab', { name: 'Settings & hooks', exact: true }).click().catch(() => {});
      await page.waitForTimeout(400);
      await capture(page, 'context-settings', theme);
    } else {
      const lint = page.locator('.ctx-area:visible .cost-card').filter({ hasText: 'References that do not resolve' });
      await lint.first().scrollIntoViewIfNeeded().catch(() => {});
      check(await lint.count() === 1 && await lint.getByText('did you mean').count() === 1, `${theme} · stale references listed with a did-you-mean`);
      await capture(page, 'context-instructions-stale-references', theme);
      await tabs.getByRole('tab', { name: 'Codex loader', exact: true }).click();
      await page.waitForTimeout(500);
      const codex = page.locator('#ctx-area-codex');
      check(await codex.getByText('bytes 2,968–6,180 of AGENTS.override.md').count() === 1, `${theme} · Codex loader names the byte range past the budget`);
      check(await codex.locator('meter.cost-meter').count() === 1, `${theme} · Codex budget meter present`);
      await capture(page, 'context-codex-loader', theme);
      await page.evaluate(() => [...document.querySelectorAll('#ctx-area-codex .sec-head')].find((el) => el.textContent.includes('Skills listing'))?.scrollIntoView({ block: 'start' }));
      await capture(page, 'context-codex-skills', theme);
      await tabs.getByRole('tab', { name: 'Subagents', exact: true }).click();
      await page.waitForTimeout(500);
      check(await page.locator('#ctx-area-subagents').getByText('loads no CLAUDE.md (managed policy still loads)').count() === 1, `${theme} · subagent with omitClaudeMd marked`);
      await capture(page, 'context-subagents', theme);
    }

    // Skills › Listing cost.
    await chord(page, 'Meta+Shift+s');
    await page.getByRole('heading', { name: 'Skills', exact: true }).waitFor({ timeout: 10000 });
    const listingOption = page.getByRole('button', { name: 'Listing cost', exact: true });
    if (BEFORE) {
      check(await listingOption.count() === 0, `${theme} · Skills listing cost: absent before the change`);
      await page.getByRole('button', { name: 'Sources', exact: true }).click().catch(() => {});
      await page.waitForTimeout(500);
      await capture(page, 'skills-sources', theme);
    } else {
      await listingOption.click();
      await page.waitForTimeout(600);
      await expectElement(page, 'skills-listing-cost', 'section[aria-label="Skill listing cost"]', theme);
      await page.getByRole('button', { name: 'Make manual-only', exact: true }).first().click();
      await page.waitForTimeout(250);
      check(await page.locator('.confirm-note').count() === 1, `${theme} · the manual-only switch asks for confirmation naming the file it writes`);
      await capture(page, 'skills-manual-only-confirm', theme);
    }

    // Schedules detail: admission and memory.
    await chord(page, 'Meta+8');
    await page.getByRole('heading', { name: 'Schedules', exact: true }).waitFor({ timeout: 10000 });
    await page.waitForTimeout(900);
    if (BEFORE) {
      await page.evaluate(() => document.querySelector('.sc-inspector')?.scrollTo(0, 0));
      check(await page.getByText('Admission', { exact: true }).count() === 0, `${theme} · schedule admission: absent before the change`);
      await capture(page, 'schedules-detail', theme);
    } else {
      await expectElement(page, 'schedules-admission-and-memory', 'section[aria-label="Admission and memory"]', theme);
      await page.evaluate(() => document.querySelector('.cost-injection')?.scrollIntoView({ block: 'center' }));
      await capture(page, 'schedules-previous-runs-section', theme);
    }

    // Usage: who is using the 5-hour window.
    await chord(page, 'Meta+Shift+u');
    await page.waitForTimeout(1200);
    await expectElement(page, 'usage-window-share', 'section[aria-label="Who is using the 5-hour window"]', theme);

    // Learning › Inbox: the Codex budget verdict before Apply.
    await chord(page, 'Meta+6');
    await page.waitForTimeout(900);
    await page.getByRole('tab', { name: /Inbox/ }).first().click().catch(() => {});
    await page.waitForTimeout(900);
    await expectElement(page, 'learning-inbox-codex-budget', '.cost-budget-note', theme);

    // Sessions: composer cold-cache note, Timeline anatomy.
    await chord(page, 'Meta+1');
    await page.waitForTimeout(900);
    const chip = page.locator('.atq-chip').filter({ hasText: 'platform' }).first();
    if (await chip.count()) { await chip.click(); await page.waitForTimeout(600); }
    const area = page.locator('.composer-area').first();
    if (await area.count()) {
      await area.click();
      await page.waitForTimeout(400);
      await page.keyboard.type('Pick the rail work back up');
      await page.waitForTimeout(900);
    }
    if (BEFORE) {
      check(await page.locator('.cost-cold-cache').count() === 0, `${theme} · cold-cache note: absent before the change`);
    } else {
      check(await page.locator('.cost-cold-cache').count() === 1, `${theme} · cold-cache note shows under a draft in an idle Claude session`, await page.locator('.composer').count());
      const text = await page.locator('.cost-cold-cache').first().innerText().catch(() => '');
      check(/Idle 68 min: this message likely re-reads ~120,012 tokens without cache \(estimate; cache lifetime 1 h, inferred/.test(text), `${theme} · the note names idle time, size and the inferred lifetime`, text);
    }
    const col = await page.locator('.term-col').boundingBox().catch(() => null);
    if (col) {
      const y = Math.max(col.y, col.y + col.height - 340);
      await page.screenshot({ path: path.join(OUT, `sessions-composer-${theme}.png`), clip: { x: col.x, y, width: col.width, height: col.y + col.height - y } });
    } else {
      await capture(page, 'sessions-composer', theme);
    }
    await page.getByRole('button', { name: 'Timeline', exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(900);
    if (BEFORE) {
      check(await page.locator('.cost-anatomy').count() === 0, `${theme} · session anatomy: absent before the change`);
      await capture(page, 'sessions-timeline', theme);
    } else {
      const drawer = page.locator('.cost-anatomy summary').first();
      if (await drawer.count()) await drawer.click();
      await page.waitForTimeout(400);
      check(await page.locator('.cost-anatomy-status.is-inferred').count() === 1 && await page.getByText('not recorded', { exact: true }).count() >= 1,
        `${theme} · anatomy labels each value observed, inferred or not recorded`);
      await page.evaluate(() => {
        const scroller = document.querySelector('.tl-scroll');
        const drawer = document.querySelector('.cost-anatomy');
        const sticky = document.querySelector('.tl-sticky');
        if (scroller && drawer) scroller.scrollTop += drawer.getBoundingClientRect().top - (sticky?.getBoundingClientRect().bottom ?? scroller.getBoundingClientRect().top) - 8;
      });
      await capture(page, 'sessions-timeline-anatomy', theme);
    }
  } finally {
    await close();
  }
}

check(errors.length === 0, 'no page errors while rendering', errors.slice(0, 5));
writeFileSync(path.join(OUT, 'verification.json'), JSON.stringify({ before: BEFORE, generatedBy: 'scripts/probe-helper-p4-cost.mjs', checks: results, pageErrors: errors }, null, 2));
console.log(`\n${results.filter((r) => r.ok).length} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
