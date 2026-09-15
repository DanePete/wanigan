#!/usr/bin/env node
// helper sweep · P5 runtime — before/after shots of every surface the package
// changed, in both themes, with assertions that the new element rendered and
// is not clipped.
//
// Plain Chromium with the preload bridge stubbed (scripts/renderer-harness.mjs):
// evidence about layout, wording and what renders — never about ps, lsof, the
// Codex app-server, git or SQLite, which the smoke suite (src/main/smoke34.ts)
// exercises for real. The fixtures below answer the P5 channels with shapes
// copied from the main-process types; a base build never calls them, so the
// same script photographs the "before".
//
// Usage:  npm run build && node scripts/probe-helper-p5-runtime.mjs --mode after --out docs/visuals/helper-p5-runtime/after
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openRenderer } from './renderer-harness.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const MODE = argOf('--mode', 'after');
const OUT = path.resolve(REPO, argOf('--out', `docs/visuals/helper-p5-runtime/${MODE}`));
const AFTER = MODE === 'after';
mkdirSync(OUT, { recursive: true });

let failures = 0;
const results = [];
const check = (ok, label, detail) => {
  results.push({ ok, label });
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`);
  if (!ok) { failures += 1; if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 400)}`); }
};
const expect = (ok, label, detail) => { if (AFTER) check(ok, label, detail); };
const errors = [];
const onError = (m) => { if (!/WebGPU|Failed to load resource/.test(m)) errors.push(m); };

const INSTRUMENT = `
(() => {
  const now = Date.now();
  const base = window.wanigan;
  const sessions = [
    { id: 's1', projectId: 'p1', projectPath: '/example/storefront', projectName: 'storefront', providerId: 'claude', harnessId: 'claude-code', status: 'running', pid: 4021, exitCode: null, unread: 3, title: 'claude · storefront', displayTitle: 'Checkout bug', worktree: null, accountLabel: 'Work', accountId: 'a2', model: 'opus', createdAt: now - 900000, endedAt: null, trust: 'project', providerProfile: { id: 'claude', label: 'Claude Code', supports: { model: true, effort: true, permissionMode: true, resume: true }, launchFields: [] } },
    { id: 's2', projectId: 'p2', projectPath: '/example/platform', projectName: 'platform', providerId: 'codex', harnessId: 'codex', status: 'running', pid: 4088, exitCode: null, unread: 0, title: 'codex · platform', displayTitle: 'Rail refactor', worktree: '/example/worktrees/platform-rail', accountLabel: 'Personal', accountId: 'a3', createdAt: now - 300000, endedAt: null, trust: 'project' },
    { id: 's3', projectId: 'p2', projectPath: '/example/platform', projectName: 'platform', providerId: 'claude', harnessId: 'claude-code', status: 'exited', pid: 3900, exitCode: 0, unread: 0, title: 'claude · platform', displayTitle: 'Review PR #128', worktree: null, accountLabel: 'Work', accountId: 'a2', reviewOnly: true, createdAt: now - 5400000, endedAt: now - 60000, trust: 'project' },
  ];
  const processes = {
    s1: { sessionId: 's1', sampledAt: now - 4000, live: true, tree: { processes: 5, cpuPercent: 14.2, rssBytes: 641728512 }, ports: [{ pid: 4102, command: 'node node_modules/.bin/vite --port 5173', address: '127.0.0.1', port: 5173 }], survivors: [], recorded: 5, notes: [] },
    s2: { sessionId: 's2', sampledAt: now - 4000, live: true, tree: { processes: 2, cpuPercent: 0.4, rssBytes: 188411904 }, ports: [], survivors: [], recorded: 2, notes: ['Codex background terminals are not listed: the Codex 0.154 app-server has no thread/backgroundTerminals method, so Wanigan cannot see terminals Codex keeps outside this process tree (unsupported in this version).'] },
    s3: { sessionId: 's3', sampledAt: now - 4000, live: false, tree: null, ports: [], recorded: 7, notes: [], survivors: [
      { pid: 5120, command: 'node node_modules/.bin/next dev -p 3000', ports: [{ address: '*', port: 3000 }], startedAt: now - 5000000, cpuIdleMs: 2640000, cpuIdleBasis: 'observed' },
      { pid: 5188, command: 'python3 -m http.server 8000', ports: [{ address: '127.0.0.1', port: 8000 }], startedAt: now - 4900000, cpuIdleMs: 1320000, cpuIdleBasis: 'since-first-seen' },
    ] },
  };
  const values = (origin) => [
    { field: 'provider', label: 'Provider', value: 'Claude Code', source: origin === 'renderer' ? 'at-launch' : 'unrecorded', note: null },
    { field: 'model', label: 'Model', value: 'opus', source: 'at-launch', note: null },
    { field: 'effort', label: 'Effort', value: null, source: 'cli-default', note: null },
    { field: 'permissionMode', label: 'Permission mode', value: 'acceptEdits', source: 'provider-profile', note: 'its declared default' },
    { field: 'account', label: 'Account', value: 'Work', source: 'project-default', note: null },
    { field: 'isolation', label: 'Workspace', value: 'project checkout', source: 'app-default', note: null },
    { field: 'extraArgs', label: 'Extra CLI flags', value: null, source: 'app-default', note: 'none' },
    { field: 'env', label: 'Environment names', value: 'CLAUDE_CONFIG_DIR (the account); CLAUDE_CODE_FORCE_SESSION_PERSISTENCE, COLORTERM, FORCE_COLOR, PATH, TERM (app default)', source: 'app-default', note: 'names only, never values; the rest is inherited from your login shell' },
  ];
  const accounts = {
    'claude-code': [{ id: 'a2', harness: 'claude-code', label: 'Work', configDir: '/example/home/.claude', adopted: true, isDefault: true, present: true, signedIn: 'yes', createdAt: now, updatedAt: now }],
    codex: [{ id: 'a3', harness: 'codex', label: 'Personal', configDir: '/example/home/.codex', adopted: true, isDefault: true, present: true, signedIn: 'yes', createdAt: now, updatedAt: now }],
  };
  const FIX = {
    'sessions.list': () => sessions,
    // Runs offers only providers that proved a headless protocol.
    'providers.list': () => [
      { id: 'claude', label: 'Claude Code', harnessId: 'claude-code', backendId: 'anthropic', path: '/usr/local/bin/claude', version: '2.1.271', supports: { model: true, effort: true, permissionMode: true, resume: true }, capabilities: { headlessJson: true, headlessBudget: true, policy: true, probed: true }, launchFields: [] },
      { id: 'codex', label: 'Codex', harnessId: 'codex', backendId: 'openai', path: '/usr/local/bin/codex', version: '0.154.0', supports: { model: true, effort: true, permissionMode: false, resume: true }, capabilities: { headlessJson: true, headlessBudget: false, policy: false, probed: true }, launchFields: [] },
    ],
    'processes.forSession': (id) => processes[id] ?? processes.s1,
    'processes.survivors': () => [processes.s3],
    'processes.capture': () => true,
    'models.substitutions': (id) => ({ sessionId: id, note: null, substitutions: id === 's1' ? [{ requested: 'opus', reported: 'claude-sonnet-5', firstAt: now - 1800000, lastAt: now - 60000, count: 14, costUsd: 0.62, via: ['auto-switch', 'otel'] }] : [] }),
    'codexReaders.health': () => ({ checkedAt: now, cliVersion: '0.154.0', previousCliVersion: '0.153.4', versionRecordedAt: now - 2 * 86400000,
      accounts: [{ accountId: 'a3', label: 'Personal', home: '/example/home/.codex', rollouts: 500, unreadable: 3, codecs: ['zstd'], unparsedLines: 2, filesWithUnparsed: 1 }] }),
    'launchProvenance.forSession': (id) => ({ origin: id === 's2' ? 'unknown' : 'renderer', values: values(id === 's2' ? 'unknown' : 'renderer') }),
    'launchProvenance.envNames': () => ({ env: { provider: [], account: 'CLAUDE_CONFIG_DIR', wanigan: ['CLAUDE_CODE_FORCE_SESSION_PERSISTENCE', 'COLORTERM', 'FORCE_COLOR', 'PATH', 'TERM'] }, packSource: 'builtin', packLabel: 'wanigan.claude' }),
    'sessions.past': () => [
      { id: 'h1', conversationId: '11111111-2222-4333-8444-555555555555', providerId: 'claude', projectId: 'p1', projectPath: '/example/storefront', projectName: 'storefront', worktree: null, model: 'opus', effort: null, permissionMode: null, startedAt: now - 7200000, endedAt: now - 6000000, exitCode: 0, continuationCount: 1, live: true, pinnedAt: null, settledAt: null, title: 'Refund path audit', titleSource: 'prompt' },
      { id: 'h2', conversationId: '019c0000-0000-7000-8000-000000000000', providerId: 'codex', projectId: 'p2', projectPath: '/example/platform', projectName: 'platform', worktree: null, model: null, effort: null, permissionMode: null, startedAt: now - 9000000, endedAt: now - 8000000, exitCode: 0, continuationCount: 1, live: true, pinnedAt: null, settledAt: null, title: 'Rail spacing', titleSource: 'prompt' },
    ],
    'codexImport.plan': (sessionId) => ({ sessionId, conversationId: '11111111-2222-4333-8444-555555555555', title: 'Refund path audit', projectId: 'p1', projectName: 'storefront', cwd: '/example/storefront',
      transcript: { path: '/example/home/.claude/projects/-example-storefront/11111111-2222-4333-8444-555555555555.jsonl', bytes: 482113 },
      codex: { accountId: 'a3', label: 'Personal', home: '/example/home/.codex' }, codexAccounts: [{ accountId: 'a3', label: 'Personal', home: '/example/home/.codex' }],
      codexVersion: '0.154.0', notImported: ['Claude settings and config', 'hooks', 'MCP servers', 'subagents', 'slash commands', 'skills and plugins', 'CLAUDE.md, AGENTS.md and memory'], refusal: null }),
    'headless.runs': () => [{ id: 'run_1', name: 'Nightly audit', model: 'claude', status: 'ended', costUsd: 0.31, costStatus: 'partial', totalRequests: 3, createdAt: now - 3600000, submittedAt: now - 3590000, endedAt: now - 3000000, error: null, succeeded: 1, failed: 2, blocked: 0, open: 0, filesChanged: 2 }],
    'headless.rows': () => [
      { runId: 'run_1', projectId: 'p1', projectName: 'storefront', projectPath: '/example/storefront', status: 'succeeded', costUsd: 0.31, costReported: true, durationMs: 412000, exitCode: 0, output: null, error: null, hasOutput: true, hasError: false, filesChanged: 2, worktree: null, startedAt: now - 3590000, endedAt: now - 3178000 },
      { runId: 'run_1', projectId: 'p2', projectName: 'platform', projectPath: '/example/platform', status: 'errored', costUsd: 0, costReported: false, durationMs: 90000, exitCode: 1, output: null, error: null, hasOutput: true, hasError: true, filesChanged: 0, worktree: null, startedAt: now - 3590000, endedAt: now - 3500000 },
      { runId: 'run_1', projectId: 'p3', projectName: 'billing', projectPath: '/example/billing', status: 'timeout', costUsd: 0, costReported: false, durationMs: 900000, exitCode: null, output: null, error: null, hasOutput: true, hasError: true, filesChanged: 0, worktree: null, startedAt: now - 3590000, endedAt: now - 2690000 },
    ],
    'headlessTruth.outcomes': () => ({
      p1: { kind: 'waiting_on_input', reason: 'permission-denials', detail: 'The run was denied permission 2 times (Bash), so it ended without doing what it needed.' },
      p2: { kind: 'network_unreachable', reason: 'network-before-credentials', detail: 'Network was unreachable in the sandbox (not an auth failure): "Could not resolve host" appears next to "token". Codex\\u2019s workspace-write sandbox has no network unless sandbox_workspace_write.network_access is enabled.' },
      p3: { kind: 'timed_out', reason: 'timed-out', detail: 'Stopped at the timeout; partial output kept (38 KB).' },
    }),
    'headlessTruth.refusals': () => [{ id: 1, at: now - 7200000, source: 'schedule', label: 'Nightly resume', providerId: 'claude', harness: 'claude-code', command: '/resume', reason: '/resume only works in an interactive Claude Code terminal: Claude Code 2.1.271 marks it unavailable in print mode, so a headless run would send it to the model as text and the model would answer as though it had run. Start an attended session for it instead. Nothing was started and nothing was spent.' }],
    'accounts.list': (harness) => accounts[harness] ?? [],
    'codexDoctor.run': () => ({ accountId: 'a3', label: 'Personal', ranAt: now, durationMs: 2140, exitCode: 1, report: { state: 'report', overall: 'fail', codexVersion: '0.154.0',
      checks: new Array(23).fill(0).map((_, i) => ({ id: 'check.' + i, category: null, status: 'ok', summary: 'ok', remediation: null })),
      failing: [{ id: 'auth.credentials', category: 'auth', status: 'fail', summary: 'no Codex credentials were found', remediation: 'Run codex login or provide an API key through a supported auth env var.' }],
      warnings: [{ id: 'network.websocket_reachability', category: 'websocket', status: 'warning', summary: 'Responses WebSocket failed; HTTPS fallback may still work', remediation: 'Check proxy, VPN, firewall, DNS, custom CA, and WebSocket policy support.' }] } }),
    'diagnostics.preview': () => ({ excluded: ['transcripts, prompts and agent output', 'the contents of any database row', 'API keys, tokens, pairing secrets and provider credentials', 'environment variable values from provider manifests'], files: [
      { name: 'app.json', describes: 'Wanigan, Electron, Node and macOS versions, and the database schema fingerprint', bytes: 612 },
      { name: 'settings.redacted.json', describes: 'Settings, with every secret-named value replaced and the home folder shown as ~', bytes: 2210 },
      { name: 'providers.json', describes: 'Provider packs and profiles with manifest and adapter digests; no environment values or credentials', bytes: 3104 },
      { name: 'gate-results.json', describes: 'The last 20 review gate runs: each command and exit code, never its output', bytes: 144 },
      { name: 'preflight.json', describes: 'The first-run checklist as Wanigan reads it now', bytes: 1880 },
      { name: 'table-counts.json', describes: 'Row counts for every table; no row contents', bytes: 2401 },
      { name: 'config-files.json', describes: 'Which state files parse, entries the loader refuses and why, and the variable names blanked for MCP servers', bytes: 1302 },
      { name: 'readme.txt', describes: 'What this bundle is, and what it leaves out', bytes: 421 } ] }),
    'configFiles.report': () => ({ mcpBlankedEnv: ['NODE_OPTIONS'], stateFiles: [
      { label: 'MCP server approvals', path: '~/Library/Application Support/wanigan/.mcp-server-trust.json', state: 'unparseable', detail: 'Expected property name or \\u0027}\\u0027 in JSON at position 2. Read as no approvals; Wanigan will not overwrite it.', rejected: [], atomic: true },
      { label: 'Provider pack state and trust', path: '~/Library/Application Support/wanigan/provider-packs/.provider-packs-state.json', state: 'ok', detail: null, rejected: ['example.old: trustedManifestSha256 is not a sha256 digest, so it trusts nothing.'], atomic: true } ],
      generated: [
        { label: 'Hook settings, one per session', path: '~/Library/Application Support/wanigan/hooks/<session>.json', atomic: true, note: 'Rebuilt at each launch and passed with --settings; never written into a repository.' },
        { label: 'MCP config, one per launch', path: '~/Library/Application Support/wanigan/mcp/<project>-<session>-<id>.mcp.json', atomic: true, note: 'Rebuilt at each launch and passed with --mcp-config; removed when the session ends.' },
        { label: 'Scheduler LaunchAgent', path: '~/Library/LaunchAgents/io.deadnorth.wanigan.scheduler.plist', atomic: true, note: 'Written only when you install durable scheduling.' } ] }),
    'reviewOnly.preparePr': (projectId, n) => ({ projectId, prNumber: Number(String(n).replace(/\\D/g, '')), forge: 'github', ref: 'pull/128/head', head: 'a1b2c3d', worktree: '/example/worktrees/storefront-rev128', branch: 'wanigan/review-pr-128-rev1', noun: 'pull request',
      prompt: 'Review pull request #128. Its head is checked out in this worktree on branch wanigan/review-pr-128-rev1. Read the change against its merge base, and report correctness problems, risky changes and missing tests, each with the file and line. You have no command tools in this session, so do not claim that anything was run.' }),
  };
  function wrap(parts, target) {
    return new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === 'then') return undefined;
        if (typeof prop !== 'string') return undefined;
        return wrap([...parts, prop], target ? target[prop] : undefined);
      },
      apply(_t, _this, callArgs) {
        const key = parts.join('.');
        if (key in FIX) return Promise.resolve(FIX[key](...callArgs));
        return target(...callArgs);
      },
    });
  }
  window.wanigan = wrap([], base);
})();
`;

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
    document.documentElement.dataset.themePreference = t;
    document.documentElement.style.colorScheme = t;
    window.dispatchEvent(new CustomEvent('wanigan:theme-changed', { detail: { preference: t, resolved: t } }));
  }, theme);
  await page.waitForTimeout(350);
}

async function nav(page, tab) {
  await page.locator('.hdr-toggle').first().click().catch(() => {});
  await page.waitForTimeout(300);
  await page.locator(`[data-nav-tab="${tab}"]`).first().click();
  await page.waitForTimeout(900);
}

/** Not clipped: the element's own scroll box fits, and it lies inside the viewport horizontally. */
async function unclipped(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { present: false };
    const r = el.getBoundingClientRect();
    return { present: true, fits: el.scrollWidth <= el.clientWidth + 1, inside: r.left >= -1 && r.right <= window.innerWidth + 1, height: Math.round(r.height) };
  }, selector);
}

async function shoot(page, name, selector) {
  const file = path.join(OUT, `${name}.png`);
  if (selector && await page.locator(selector).count()) {
    await page.locator(selector).first().screenshot({ path: file });
  } else {
    await page.screenshot({ path: file });
  }
}

const background = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

for (const theme of ['dark', 'light']) {
  console.log(`── ${MODE} · ${theme}`);
  const { page, close } = await openRenderer({ theme, width: 1440, height: 1000, onError, instrument: INSTRUMENT });
  await setTheme(page, theme);
  console.log(`  body background ${await background(page)}`);

  // Fleet: processes, survivors across sessions, substitution, no command tools.
  await nav(page, 'fleet');
  check(await page.locator('.fleet-inspector').count() === 1, `${theme}: Fleet rendered`);
  await shoot(page, `${theme}-fleet-inspector`, '.fleet-inspector');
  expect(await page.locator('.fleet-inspector .proc-panel .proc-ports li').count() === 1, `${theme}: the inspector shows the tree's listening port`);
  const subs = await unclipped(page, '.fleet-inspector .model-subs');
  expect(subs.present && subs.inside, `${theme}: "Requested opus, answered by claude-sonnet-5" renders inside the card`, subs);
  expect((await page.locator('.fleet-inspector .model-subs').innerText().catch(() => '')).includes('Requested opus, answered by claude-sonnet-5'), `${theme}: with the exact sentence`);
  const across = await unclipped(page, '.proc-across');
  expect(across.present && across.inside, `${theme}: Still running after the session ended is listed across sessions`, across);
  if (await page.locator('.proc-across').count()) await shoot(page, `${theme}-fleet-still-running`, '.proc-across');
  if (AFTER) {
    await page.locator('.proc-across .proc-stop').first().click();
    await page.waitForTimeout(200);
    expect(await page.locator('.proc-across .confirm-note').count() === 1, `${theme}: Stop asks for confirmation before any signal`);
    await shoot(page, `${theme}-fleet-stop-confirm`, '.proc-across');
  }

  // Sessions: runtime details and launch values.
  await nav(page, 'sessions');
  check(await page.locator('.sessions-view').count() === 1, `${theme}: Sessions rendered`);
  await page.locator('.atq-chip', { hasText: 'storefront' }).first().click().catch(() => {});
  await page.waitForTimeout(600);
  for (const d of await page.locator('details.session-runtime').all()) await d.evaluate((el) => { el.open = true; });
  await page.waitForTimeout(400);
  expect(await page.locator('details.session-runtime').count() === 2, `${theme}: the session header carries Processes and ports and Launch values`);
  expect(await page.locator('.provenance-list [data-provenance-field="model"]').count() === 1, `${theme}: launch values list each value with its source`);
  if (await page.locator('.session-config').count()) await shoot(page, `${theme}-sessions-runtime`, '.session-config');
  else await shoot(page, `${theme}-sessions-runtime`);

  // Recent: Continue in Codex on the Claude row only, then the consent dialog.
  const codexButtons = page.locator('.past-codex');
  expect(await codexButtons.count() === 1, `${theme}: Continue in Codex is offered on the Claude conversation and not the Codex one`, await codexButtons.count());
  if (AFTER && await codexButtons.count()) {
    await codexButtons.first().evaluate((el) => el.click());
    await page.waitForTimeout(700);
    const dialog = await unclipped(page, '.codex-continue');
    expect(dialog.present, `${theme}: the consent dialog opens`, dialog);
    expect((await page.locator('[data-codex-transcript]').innerText().catch(() => '')).endsWith('.jsonl'), `${theme}: it names the exact transcript file`);
    expect((await page.locator('.codex-continue').innerText().catch(() => '')).includes('CODEX_HOME'), `${theme}: and the Codex account's CODEX_HOME`);
    await shoot(page, `${theme}-continue-in-codex`, '.codex-continue');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  // New Session dialog: review only and where the values come from.
  await page.locator('button', { hasText: /^\+?\s*New session/ }).first().click().catch(() => {});
  await page.waitForTimeout(900);
  if (await page.locator('.session-launch').count()) {
    const reviewCheck = page.locator('.review-only-check input');
    expect(await reviewCheck.count() === 1, `${theme}: the launch dialog offers Review only (no command tools) for Claude Code`);
    if (await reviewCheck.count()) { await reviewCheck.check(); await page.waitForTimeout(200); }
    await page.locator('.launch-provenance').evaluate((el) => { el.open = true; }).catch(() => {});
    await page.waitForTimeout(300);
    expect(await page.locator('.launch-provenance .provenance-list > div').count() >= 7, `${theme}: the summary resolves each launch value's source`);
    await shoot(page, `${theme}-new-session-summary`, '.launch-summary');
    if (await page.locator('.review-only-field').count()) await shoot(page, `${theme}-new-session-review-only`, '.review-only-field');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  // Usage: rollouts the Codex reader could not read.
  await nav(page, 'usage');
  check(await page.locator('.usage-view').count() === 1, `${theme}: Usage rendered`);
  const note = await unclipped(page, '.codex-reader-note');
  expect(note.present && note.inside, `${theme}: Usage says how many Codex sessions it cannot read`, note);
  expect((await page.locator('.codex-reader-note').innerText().catch(() => '')).includes('3 Codex sessions are stored in a format this version of Wanigan cannot read (compressed rollouts).'), `${theme}: in those words`);
  await shoot(page, `${theme}-usage`);

  // Runs: finer outcomes, refusals, the composer's slash-command check.
  await nav(page, 'runs');
  check(await page.locator('.hr-view').count() === 1, `${theme}: Runs rendered`);
  await page.waitForTimeout(800);
  expect(await page.locator('.hr-outcome').count() === 3, `${theme}: each finished row states its finer outcome`, await page.locator('.hr-outcome').count());
  expect(await page.locator('[data-outcome="network_unreachable"]').count() === 1, `${theme}: the network failure is labelled as not an auth failure`);
  expect(await page.locator('.hr-refusals li').count() === 1, `${theme}: Refused before starting lists the refused /resume`);
  await shoot(page, `${theme}-runs`);
  await page.getByRole('button', { name: 'New run' }).click().catch(() => {});
  await page.waitForTimeout(500);
  const prompt = page.locator('textarea[aria-label="Task for every repository"]');
  if (await prompt.count()) {
    await prompt.fill('/login');
    await page.waitForTimeout(300);
    expect((await page.locator('.hr-launch').innerText().catch(() => '')).includes('Wanigan will refuse this run.'), `${theme}: the composer warns before Start that /login would be refused`);
    await shoot(page, `${theme}-runs-composer`, '.hr-launch');
  }

  // Settings › Backup: diagnostics and config files.
  await nav(page, 'settings');
  await page.getByRole('tab', { name: /Backup/ }).first().click().catch(async () => { await page.locator('button', { hasText: 'Backup' }).first().click().catch(() => {}); });
  await page.waitForTimeout(700);
  const exportButton = page.locator('button', { hasText: 'Export diagnostics…' });
  expect(await exportButton.count() === 1, `${theme}: Settings › Backup offers Export diagnostics`);
  if (await exportButton.count()) { await exportButton.click(); await page.waitForTimeout(500); }
  expect(await page.locator('.diag-files li').count() === 8, `${theme}: the exact file list is shown before saving`);
  const diag = page.locator('[data-section-title="Export diagnostics"]');
  if (await diag.count()) await shoot(page, `${theme}-settings-diagnostics`, '[data-section-title="Export diagnostics"]');
  expect(await page.locator('[data-config-state="unparseable"]').count() === 1, `${theme}: a state file that does not parse is named as kept and never overwritten`);
  if (await page.locator('[data-section-title="Config files Wanigan rewrites"]').count()) await shoot(page, `${theme}-settings-config-files`, '[data-section-title="Config files Wanigan rewrites"]');
  else await shoot(page, `${theme}-settings-backup`);

  // Settings › Agents: codex doctor per account.
  await page.getByRole('tab', { name: /Agents/ }).first().click().catch(async () => { await page.locator('button', { hasText: 'Agents' }).first().click().catch(() => {}); });
  await page.waitForTimeout(800);
  const doctor = page.locator('button', { hasText: 'Run codex doctor' });
  expect(await doctor.count() === 1, `${theme}: the Codex account offers Run codex doctor`);
  if (await doctor.count()) { await doctor.click(); await page.waitForTimeout(500); }
  expect(await page.locator('.doctor-checks li').count() === 2, `${theme}: failing checks and warnings are named`);
  if (await page.locator('.doctor-panel').count()) {
    await page.locator('.doctor-panel').first().evaluate((el) => el.closest('.set-account-row')?.scrollIntoView({ block: 'center' }));
    await shoot(page, `${theme}-settings-codex-doctor`, '.set-account-group:has(.doctor-panel)');
  } else {
    await shoot(page, `${theme}-settings-agents`);
  }

  // Git: Review PR… and the prefilled launch dialog.
  await nav(page, 'git');
  const reviewPr = page.locator('button', { hasText: 'Review PR…' });
  expect(await reviewPr.count() === 1, `${theme}: the Git view offers Review PR…`);
  await shoot(page, `${theme}-git-bar`, '.gt-bar');
  if (AFTER && await reviewPr.count()) {
    await reviewPr.click();
    await page.waitForTimeout(200);
    await page.locator('#review-pr-number').fill('128');
    await shoot(page, `${theme}-git-review-pr-form`, '.gt-bar');
    await page.locator('button', { hasText: 'Fetch into a worktree' }).click();
    await page.waitForTimeout(1200);
    const field = await unclipped(page, '.review-only-field');
    expect(field.present, `${theme}: the launch dialog opens on the review worktree with review only on`, field);
    expect(await page.locator('.review-only-check input').isChecked().catch(() => false), `${theme}: Review only is ticked`);
    expect((await page.locator('#launch-first-message').inputValue().catch(() => '')).includes('pull request #128'), `${theme}: the first message names the PR`);
    if (await page.locator('.session-launch').count()) await shoot(page, `${theme}-git-review-pr-dialog`, '.session-launch');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  // The session Timeline carries the substitution too.
  await nav(page, 'sessions');
  await page.locator('.atq-chip', { hasText: 'storefront' }).first().click().catch(() => {});
  await page.waitForTimeout(500);
  const toggleRail = page.locator('.session-side-panel-toggle');
  if (await toggleRail.count()) { await toggleRail.first().click(); await page.waitForTimeout(500); }
  await page.locator('.code-head button', { hasText: 'Timeline' }).first().click().catch(() => {});
  await page.waitForTimeout(900);
  expect(await page.locator('.tl .model-subs').count() === 1, `${theme}: the Timeline shows the substitution under its live strip`);
  if (await page.locator('.tl-sticky').count()) await shoot(page, `${theme}-timeline-substitution`, '.tl-sticky');

  await close();
}

check(errors.length === 0, 'no page errors', errors.slice(0, 5));
writeFileSync(path.join(OUT, 'probe-results.json'), `${JSON.stringify({ mode: MODE, passed: results.filter((r) => r.ok).length, failed: failures, checks: results }, null, 2)}\n`);
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
