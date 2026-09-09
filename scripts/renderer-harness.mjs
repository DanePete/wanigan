#!/usr/bin/env node
/*
 * Open the built renderer in plain Chromium with the preload bridge stubbed.
 *
 * Shared by scripts/shots-browser.mjs and scripts/probe-chords.mjs. Neither is
 * a substitute for `npm test`: every window.wanigan call here is answered by a
 * stub, so a green run says how the app looks and behaves in the DOM, and
 * nothing at all about the main process, IPC, PTYs or persistence.
 *
 * Two things here are load-bearing and were each a blank white page first:
 *
 *  - It serves over http, not file://. The renderer ships a real
 *    Content-Security-Policy, and on a file:// origin `script-src 'self'` is
 *    opaque, so the module script never runs.
 *  - The stub is shape-agnostic. Fifteen views expect fifteen record shapes;
 *    answering with null or {} sends most of them into an error boundary that
 *    hides the page. anything() is array-like, indexable, and every field of it
 *    is another anything().
 */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(REPO, 'package.json'));

let chromium;
try { ({ chromium } = require('playwright-core')); }
catch { console.error('playwright-core is not resolvable from this repo; run `npm i -D playwright-core` and retry.'); process.exit(2); }


const MEASURE = process.argv.includes('--measure');

const STUB = `
(() => {
  const now = Date.now();
  // Example data, deliberately generic: this file is committed, and a fixture
  // naming someone's repositories or inbox is a fixture that leaks.
  const projects = [
    { id: 'p1', name: 'storefront', path: '/example/storefront', branch: 'main' },
    { id: 'p2', name: 'platform', path: '/example/platform', branch: 'feature/rail' },
  ];
  const sessions = [
    { id: 's1', projectId: 'p1', projectName: 'storefront', providerId: 'claude', status: 'running', pid: 4021, exitCode: null, unread: 3, title: 'claude · storefront', worktree: null, label: 'Checkout bug', accountLabel: 'work', createdAt: now - 900000, endedAt: null },
    { id: 's2', projectId: 'p2', projectName: 'platform', providerId: 'codex', status: 'running', pid: 4088, exitCode: null, unread: 0, title: 'codex · platform', worktree: 'fix/rail', label: null, accountLabel: 'personal', createdAt: now - 300000, endedAt: null },
    { id: 's3', projectId: 'p2', projectName: 'platform', providerId: 'claude', status: 'exited', pid: 3900, exitCode: 0, unread: 0, title: 'claude · platform', worktree: null, label: null, accountLabel: 'work', createdAt: now - 5400000, endedAt: now - 60000 },
  ];
  // Full ProviderInfo. The supports object is not optional in the type and the
  // launch dialog reads through it without a guard, so a fixture missing it
  // takes the whole Sessions view into its error boundary.
  // (No back-ticks in this file's stub: it is itself a template literal.)
  const supports = { model: true, effort: true, permissionMode: true, resume: true };
  const providers = [
    { id: 'claude', label: 'Claude Code', harnessId: 'claude-code', backendId: 'anthropic',
      path: '/usr/local/bin/claude', version: '1.0.0', supports, capabilities: {}, launchFields: [] },
    { id: 'codex', label: 'Codex', harnessId: 'codex', backendId: 'openai',
      path: '/usr/local/bin/codex', version: '1.0.0', supports, capabilities: {}, launchFields: [] },
  ];
  // Full Attention shape: label and transitionId are load-bearing (the queue
  // lower-cases the label, and dedupe keys off the transition).
  const attention = [
    { sessionId: 's1', kind: 'permission', transitionId: 't1', since: now - 240000,
      label: 'Asking', detail: 'Edit src/Checkout.php', tool: 'Edit', projectName: 'storefront' },
    { sessionId: 's2', kind: 'idle', transitionId: 't2', since: now - 60000,
      label: 'Idle', detail: null, tool: null, projectName: 'platform' },
  ];
  const usageSnapshot = {
    days: 7,
    limits: [
      { accountId: 'a1', accountLabel: 'Personal', harness: 'claude-code', plan: 'max', state: 'ok', detail: null, fetchedAt: now - 60000,
        identity: { email: 'you@example.com', orgName: null, plan: 'max', authMethod: 'claude.ai' },
        windows: [
          { kind: 'session', scope: null, usedPercent: 53, resetsAtText: 'Sep 6 at 1:29pm', resetsAt: now + 8880000 },
          { kind: 'week', scope: null, usedPercent: 52, resetsAtText: 'Sep 6 at 8:59pm', resetsAt: now + 97200000 },
          { kind: 'week', scope: 'Fable', usedPercent: 100, resetsAtText: 'Sep 6 at 8:59pm', resetsAt: now + 97200000 },
        ], factors: [] },
      { accountId: 'a2', accountLabel: 'Work', harness: 'claude-code', plan: 'max', state: 'ok', detail: null, fetchedAt: now - 62000,
        identity: { email: 'you@work.example', orgName: null, plan: 'max', authMethod: 'claude.ai' },
        windows: [
          { kind: 'session', scope: null, usedPercent: 0, resetsAtText: null, resetsAt: null },
          { kind: 'week', scope: null, usedPercent: 0, resetsAtText: null, resetsAt: null },
          { kind: 'week', scope: 'Fable', usedPercent: 0, resetsAtText: null, resetsAt: null },
        ], factors: [] },
      // A second agent's login, and one this build cannot ask: both belong on
      // the page, because "not shown" and "nothing left" look identical to
      // someone deciding where to run the next agent.
      { accountId: 'a3', accountLabel: 'Personal', harness: 'codex', plan: 'pro', state: 'ok',
        detail: 'Codex reports a spend control has been reached for this account.', fetchedAt: now - 40000,
        identity: null,
        windows: [
          { kind: '5h window', scope: null, usedPercent: 31, resetsAtText: null, resetsAt: now + 5400000 },
          { kind: 'week', scope: null, usedPercent: 74, resetsAtText: null, resetsAt: now + 320000000 },
        ], factors: [] },
      { accountId: 'a4', accountLabel: 'Personal', harness: 'gemini-cli', plan: null, state: 'unsupported',
        detail: 'Wanigan has no way to ask a gemini-cli account what it has left. Its consumption below is still recorded from the sessions Wanigan started.',
        fetchedAt: null, identity: null, windows: [], factors: [] },
    ],
    consumption: [], daily: [],
  };
  // One session's timeline, covering every event family the Timeline draws a
  // word for — including the lifecycle events that have no tool name, which is
  // the half that used to render as its own lower-cased identifier. Without
  // these three entries the stub answers with anything(), the rows are
  // meaningless, and a shot of this pane shows nothing worth reviewing.
  // (Deliberately generic: this file is committed.)
  const ev = (n, event, over) => Object.assign(
    { id: n, sessionId: 's1', at: now - (40 - n) * 9000, event,
      toolName: null, summary: null, durationMs: null, ok: null, paths: [] }, over);
  const timeline = [
    ev(1, 'SessionStart'),
    ev(2, 'InstructionsLoaded', { summary: 'Project \u00b7 session_start \u2014 CLAUDE.md', paths: ['/example/storefront/CLAUDE.md'] }),
    ev(3, 'UserPromptSubmit'),
    ev(4, 'PreToolUse', { toolName: 'Bash', summary: 'npm test' }),
    ev(5, 'PostToolUse', { toolName: 'Bash', summary: 'npm test', durationMs: 41200, ok: true }),
    ev(6, 'SubagentStart', { summary: 'Explore' }),
    ev(7, 'SubagentStart', { summary: 'general-purpose' }),
    ev(8, 'SubagentStop', { summary: 'general-purpose', durationMs: 18400, ok: true }),
    ev(9, 'SubagentStop', { summary: 'Explore', durationMs: 33900, ok: true }),
    ev(10, 'PostModelSwitch', { summary: 'claude-opus-5 \u2192 claude-sonnet-5 \u00b7 auto' }),
    ev(11, 'CwdChanged', { summary: 'storefront \u2014 storefront/web', paths: ['/example/storefront/web'] }),
    ev(12, 'DirectoryAdded', { summary: 'slash_command \u2014 shared-ui', paths: ['/example/shared-ui'] }),
    ev(13, 'ConfigChange', { summary: 'project_settings \u2014 settings.json', paths: ['/example/storefront/.claude/settings.json'] }),
    ev(14, 'WorktreeCreate', { summary: 'agent-checkout-fix' }),
    ev(15, 'TaskCreated', { summary: 'reviewer \u2014 Check the discount rounding' }),
    ev(16, 'TaskCompleted', { summary: 'reviewer \u2014 Check the discount rounding' }),
    ev(17, 'PermissionRequest', { toolName: 'Edit', summary: 'src/Checkout.php' }),
    ev(18, 'PermissionDenied', { toolName: 'Edit', summary: 'src/Checkout.php', ok: false }),
    ev(19, 'PostToolUseFailure', { toolName: 'Bash', summary: 'php artisan migrate', durationMs: 2600, ok: false }),
    ev(20, 'PreCompact'),
    ev(21, 'PostCompact', { ok: true }),
    ev(22, 'TeammateIdle', { summary: 'reviewer' }),
    ev(23, 'ElicitationResult', { summary: 'github \u2014 accept', ok: true }),
    ev(24, 'Elicitation', { summary: 'github \u2014 Approve pushing to origin/main?' }),
  ];
  const toolStats = [
    { toolName: 'Bash', calls: 12, totalMs: 74200, failures: 1 },
    { toolName: 'Edit', calls: 9, totalMs: 4100, failures: 0 },
    { toolName: 'Read', calls: 31, totalMs: 2600, failures: 0 },
  ];
  // Fleet reads usage.many and usage.throughput for every card, the whole stat
  // row and every column of its table. Neither had a fixture, so all of it came
  // from anything() and every cost, token and line count on the busiest view in
  // the app was fabricated by the proxy — which is how a sweep came back
  // reporting "forty zeros on Fleet" as if it were a product finding.
  // s2 is deliberately costStatus 'unavailable': Codex on a ChatGPT plan
  // reports token counters but no per-thread invoice, and a zero there has to
  // render as "not reported" rather than as $0.00. That is the one distinction
  // this view most has to get right, so the fixture has to contain it.
  const usageFor = (id, over) => Object.assign({
    sessionId: id, costUsd: 0, costStatus: 'reported', inTokens: 0, outTokens: 0,
    cacheRead: 0, cacheWrite: 0, linesAdded: 0, linesRemoved: 0, commits: 0,
    pullRequests: 0, activeSeconds: 0, requests: 0, errors: 0, refusals: 0,
    lastAt: null, models: [],
  }, over);
  const usageMany = {
    s1: usageFor('s1', { costUsd: 4.82, inTokens: 128400, outTokens: 19200, cacheRead: 91000,
      cacheWrite: 4200, linesAdded: 214, linesRemoved: 63, commits: 3, requests: 41,
      activeSeconds: 900, lastAt: now - 12000, models: ['claude-opus-5'] }),
    s2: usageFor('s2', { costStatus: 'unavailable', inTokens: 41200, outTokens: 7300,
      linesAdded: 38, linesRemoved: 12, requests: 11, activeSeconds: 300,
      lastAt: now - 45000, models: ['gpt-5-codex'] }),
    s3: usageFor('s3', { costUsd: 0.94, inTokens: 22100, outTokens: 3100, commits: 1,
      requests: 9, activeSeconds: 5400, lastAt: now - 3600000, models: ['claude-sonnet-5'] }),
  };
  const throughput = [0, 2, 9, 14, 22, 31, 27, 18, 24, 33, 41, 36, 29, 17, 11, 6, 14, 25, 38, 44, 31, 20, 12, 5];
  // Context is the one view anything() cannot fake: every slot's "is this
  // filled" reads through a proxy, so all seven compute as filled, the
  // unfilled list comes back empty and the setup card — the thing the page is mostly about —
  // never renders at all. A sweep of this view was green and meaningless.
  //
  // Shaped as a realistic PARTIAL project on purpose: AGENTS.md and memory
  // present, the CLAUDE.md chain and rules absent. That is the ordinary state
  // of most repositories, and the one where the numbered slots start at 3.
  const ctxInstructions = {
    files: [], atLaunch: [], onDemand: [], notes: [],
  };
  const ctxMemory = {
    dir: '/example/platform/.memory', derivedFrom: 'git-repo', exists: true, notes: [],
    index: { name: 'MEMORY.md', path: '/example/platform/.memory/MEMORY.md', kind: 'index',
             description: 'Index of what is remembered for this project.', bytes: 1807, lines: 11,
             modified: now - 86400000, modifiedFrontmatter: null, links: [], isIndex: true },
    indexBudget: { lines: 11, lineLimit: 200, bytes: 1807, byteLimit: 25600, loadedLines: 11,
                   droppedLines: 0, overBudget: false,
                   note: 'MEMORY.md fits: all 11 lines load (11/200 lines, 1.8 KB/25 KB).' },
    files: [
      { name: 'MEMORY.md', path: '/example/platform/.memory/MEMORY.md', kind: 'index',
        description: 'Index of what is remembered for this project.', bytes: 1807, lines: 11,
        modified: now - 86400000, modifiedFrontmatter: null, links: [], isIndex: true },
      { name: 'release-checklist', path: '/example/platform/.memory/release-checklist.md', kind: 'memory',
        description: 'The order the release steps have to run in, and why.', bytes: 2214, lines: 38,
        modified: now - 172800000, modifiedFrontmatter: null, links: [], isIndex: false },
    ],
    counts: { instruction: 0, memory: 1, reference: 0, index: 1 },
    danglingLinks: [], orphans: [], enabled: true,
  };
  const ctxConfig = {
    layers: [
      { layer: 'user', file: '/example/home/.claude/settings.json', exists: false },
      { layer: 'project', file: '/example/platform/.claude/settings.json', exists: false },
      { layer: 'project local', file: '/example/platform/.claude/settings.local.json', exists: false },
    ],
    settings: [], hooks: [], mcp: [], agents: [], commands: [], notes: [],
  };
  const ctxAgents = { present: true, imported: true, symlinked: false,
                      note: 'AGENTS.md is imported by CLAUDE.md, so it reaches context.' };
  const ctxBudget = { files: [], totalTokens: 0, totalCostUsd: 0, model: null, note: null };
  // Insights' two newest cards are the same trap as Context and Fleet above:
  // both render nothing at all when their record reads zero, and anything()
  // reads zero. Without these keys a sweep photographs an Insights page with a
  // burn rate and a transcript meter silently missing and calls it green.
  //
  // The transcript figures are shaped like the real thing rather than round:
  // most turns from an entrypoint Wanigan never launched (which is the whole
  // point of the card), a cache-read share that dominates the token count, and
  // one model with no published rate so the unpriced warning is on screen where
  // it can be reviewed.
  const transcriptMeter = {
    days: 30,
    coverage: { requests: 121254, outsideWanigan: 92318, firstAt: now - 240 * 86400000,
                lastAt: now - 600000, files: 5136, filesBehind: 0 },
    totals: { requests: 121254, inTokens: 5036976, outTokens: 115180069,
              cacheRead: 26572099438, cacheWrite: 715787384, costUsd: 486.31,
              unpricedRequests: 2468 },
    byDay: [],
    unpricedModels: [{ model: 'claude-fable-5-1', requests: 2468 }],
    telemetryUsd: 61.04, telemetryRequests: 4651, filesBehind: 0,
  };
  const burn = [
    { kind: 'session', scope: null, accountLabel: 'Personal', usedPercent: 42,
      resetsAtText: 'in 2h 51m', resetsAt: now + 2.85 * 3600000,
      windowStartMs: now - 2.15 * 3600000, spansMultipleAccounts: false,
      burn: { windowStartMs: now - 2.15 * 3600000, elapsedMinutes: 129, tokens: 4180000,
              requests: 96, tokensPerMinute: 32403, projectedTokens: 9720000 } },
    { kind: 'week', scope: 'Opus', accountLabel: 'Personal', usedPercent: 79,
      resetsAtText: 'Sep 12 at 8:59pm', resetsAt: now + 4 * 86400000,
      windowStartMs: now - 3 * 86400000, spansMultipleAccounts: false,
      burn: { windowStartMs: now - 3 * 86400000, elapsedMinutes: 4320, tokens: 51200000,
              requests: 1180, tokensPerMinute: 11851, projectedTokens: 119500000 } },
  ];
  const FIXED = {
    'usage.snapshot': usageSnapshot,
    'spend.transcripts': transcriptMeter, 'usage.burn': burn,
    'context.instructions': ctxInstructions, 'context.memory': ctxMemory,
    'context.config': ctxConfig, 'context.agentsMd': ctxAgents, 'context.budget': ctxBudget,
    'usage.many': usageMany, 'usage.throughput': throughput,
    'events.session': timeline, 'events.tools': toolStats,
    'events.live': { tool: null, since: now - 12000, blocked: true, lastAt: now - 12000 },
    'checkpoints.list': [],
    'projects.list': projects, 'sessions.list': sessions, 'providers.list': providers,
    'attention.list': attention, 'sessions.past': [], 'batch.runsInFlight': { readAt: now, runs: 2, requestsReturned: 1400, requestsOutstanding: 600 },
    'keys.has': true,
    // Two views read a bare scalar out of a record and then call a string or
    // number method on it. anything() answers those with a Proxy, which is
    // truthy, so the view sailed past its own fallback and died one line later
    // — Fleet on trustCopy(trust).label.toLowerCase(), Settings on
    // config.pushServer.trim(). Both were silent: the error boundary paints a
    // card, and a sweep that only counts screenshots still wrote a PNG. A
    // harness that renders 13 of 15 views is a harness that reviews 13.
    'policy.defaultTrust': 'project',
    'mobile.status': {
      config: { dashboardEnabled: false, remoteControlEnabled: false, port: 47831,
                dashboardUrl: '', pushEnabled: false, pushServer: 'https://ntfy.sh', pushTopic: '' },
      running: false, localUrl: 'http://127.0.0.1:47831', pairingUrl: '', pairingCode: '',
      tokenFingerprint: '', error: null, lastPushAt: null, lastPushError: null,
    },
    // DemoState.map is a list, but 'map' is also on Array.prototype, so the
    // empty-array target answered state.map with Array.prototype.map itself
    // and state.map.slice(0, 12) read .slice off a function. A field named
    // after an array method is the one shape anything() cannot fake.
    'demo.state': { on: false, blurTerminals: false, map: [] },
    // The model-assist card renders its consent branch off status.consent and
    // prints providerId into the DOM. anything() answers that with a Proxy,
    // which is truthy, so the card would take the approved branch and then die
    // rendering an object as a React child — the same class of failure the two
    // scalars above document. A real "nothing approved yet" record is the
    // honest default anyway: it is what a fresh install returns.
    // Learning reads its own settings over IPC rather than off the app settings
    // record, so without this key anything() answered allowModelAssistance with
    // a truthy Proxy and the governor card drew itself switched on beside its
    // own "nothing has been approved" sentence. A boolean a card branches on is
    // the same trap as a scalar it formats.
    // The inbox sweep row renders only when the count is above zero, and
    // anything() answers a bare number with a Proxy whose toPrimitive is 0 --
    // so without this the affordance is invisible to every sweep. Same class
    // of trap as the booleans above.
    'learning.unactionableCount': 7,
    'learning.settings': {
      enabled: true, contentMode: 'local-same-provider', automation: 'hybrid',
      allowModelAssistance: false, monthlyBudgetUsd: 0, briefingMaxTokens: 1200,
      consolidationEnabled: true,
    },
    'learning.modelAssistStatus': {
      switchedOn: false, effective: false, consent: null,
      routing: { ok: false, reason: 'not-consented',
                 detail: 'No provider has been approved for model-assisted phrasing.' },
      monthToDateUsd: 0, averageCostUsd: null, runs: [],
    },
  };
  const settings = {
    spendCapUsd: 1, motion: 'auto', navSidebar: 'open', telemetry: true, hooks: true,
    checkpoints: true, archiveTranscripts: true, notifications: true, mcpServerEnabled: false, pet: false,
    slots: { session: 4, headless: 2, batch: 1, scout: 1, node: 4 }, eventRetentionDays: 30,
    defaultTrust: 'project',
    theme: window.__WANIGAN_THEME__ ?? 'dark',
    learning: { enabled: true, contentMode: 'local-same-provider', automation: 'hybrid', allowModelAssistance: false,
                monthlyBudgetUsd: 0, briefingMaxTokens: 1200, consolidationEnabled: true },
  };
  function anything() {
    const target = [];
    const p = new Proxy(target, {
      get(t, prop) {
        if (prop === 'then') return undefined;
        if (prop === Symbol.toPrimitive) return () => 0;
        if (prop === Symbol.iterator) return t[Symbol.iterator].bind(t);
        if (prop === 'toJSON') return () => null;
        if (prop === 'toLocaleString' || prop === 'toFixed' || prop === 'toString') return () => '0';
        // A lookup into an empty list is the shape that sends views into their
        // error boundary here: list.find(...).model throws on undefined. The
        // stub answers with another anything() so the page still renders. That
        // a real view does this at all is worth knowing — the same call against
        // a real list that happens not to contain the row throws for real.
        if (prop === 'find' || prop === 'at' || prop === 'pop' || prop === 'shift') return () => p;
        if (prop === 'valueOf') return () => 0;
        if (prop in t) { const v = t[prop]; return typeof v === 'function' ? v.bind(t) : v; }
        if (typeof prop !== 'string') return undefined;
        return p;
      },
    });
    return p;
  }
  const listish = new Set(['list','all','recent','past','search','history','items','rows','runs','entries','suggestions','candidates']);
  function stub(pathParts) {
    return new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === 'then') return undefined;
        if (typeof prop !== 'string') return undefined;
        return stub([...pathParts, prop]);
      },
      apply(_t, _this, args) {
        const key = pathParts.join('.');
        if (pathParts[0] === 'on') return () => {};
        if (key === 'prefs.all' || key === 'settings.all') return Promise.resolve(settings);
        if (key in FIXED) return Promise.resolve(FIXED[key]);
        const leaf = pathParts[pathParts.length - 1];
        // anything(), not a plain []: a view that reads list[0].model before
        // checking list.length gets an object instead of undefined, while
        // .length stays 0 so empty states still render as empty.
        if (listish.has(leaf)) return Promise.resolve(anything());
        if (/^(has|is|can|should)[A-Z]/.test(leaf) || leaf === 'has') return Promise.resolve(false);
        // Shape-agnostic. Fifteen views expect fifteen different record shapes
        // and this harness exists to look at layout, not to re-implement the
        // main process: anything() is array-like so .map/.length work, and any
        // field of it is another anything(), so a view can walk as deep as it
        // likes without hitting an error boundary that hides the page.
        return Promise.resolve(anything());
      },
    });
  }
  window.wanigan = stub([]);
})();
`;

// Over http, not file://. The renderer ships a real CSP (script-src 'self'),
// and on a file:// origin 'self' is opaque, so the module script never runs and
// the page paints an empty #root. A one-file static server is the whole fix.
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
const ROOT = path.join(REPO, 'out/renderer');
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
// Never the reason a probe process stays alive after its last renderer closes.
server.unref();
const PORT = server.address().port;

export async function openRenderer({ theme = 'dark', width = 1440, height = 900, onError, instrument } = {}) {
if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error('No renderer build in out/. Run `npm run build` first.');
  process.exit(2);
}
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
await ctx.addInitScript(`window.__WANIGAN_THEME__ = ${JSON.stringify(theme)};`);
await ctx.addInitScript(STUB);
// Runs after the stub and before the bundle, which is the only window in which
// a probe can wrap a bridge method the app is about to subscribe to.
if (instrument) await ctx.addInitScript(instrument);
const page = await ctx.newPage();
page.on('pageerror', (e) => (onError ?? ((m) => console.log('[pageerror]', m)))(e.message));
page.on('console', (m) => { if (m.type() === 'error' && onError) onError(m.text().slice(0, 220)); });

  const url = `http://127.0.0.1:${PORT}/index.html`;
  await page.goto(url);
  await page.waitForTimeout(2200);
  // close() takes down the browser only. The static server is module-level and
  // shared, and closing it there made one openRenderer call per process the
  // only supported shape: a second call — a both-themes sweep, a before/after
  // comparison — failed at goto with ERR_CONNECTION_REFUSED, from a stack that
  // named the navigation rather than the server that was no longer listening.
  // The socket is unref'd at listen instead, so it never holds the process open
  // and never has to be closed to let one exit.
  return { browser, page, close: async () => { await browser.close(); } };
}
