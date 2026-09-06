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
    { id: 's1', projectId: 'p1', projectName: 'storefront', providerId: 'claude', status: 'running', pid: 4021, exitCode: null, unread: 3, title: 'claude · storefront', worktree: null, label: 'Checkout bug', accountLabel: 'work', startedAt: now - 900000 },
    { id: 's2', projectId: 'p2', projectName: 'platform', providerId: 'codex', status: 'running', pid: 4088, exitCode: null, unread: 0, title: 'codex · platform', worktree: 'fix/rail', label: null, accountLabel: 'personal', startedAt: now - 300000 },
    { id: 's3', projectId: 'p2', projectName: 'platform', providerId: 'claude', status: 'exited', pid: 3900, exitCode: 0, unread: 0, title: 'claude · platform', worktree: null, label: null, accountLabel: 'work', startedAt: now - 5400000 },
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
  const FIXED = {
    'usage.snapshot': usageSnapshot,
    'projects.list': projects, 'sessions.list': sessions, 'providers.list': providers,
    'attention.list': attention, 'sessions.past': [], 'batch.runsInFlight': { readAt: now, runs: 2, requestsReturned: 1400, requestsOutstanding: 600 },
    'keys.has': true,
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
  return { browser, page, close: async () => { await browser.close(); server.close(); } };
}
