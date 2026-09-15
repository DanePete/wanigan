#!/usr/bin/env node
// Helper sweep · P8 · the Mac around the app, local automation and attribution.
// Settings (Dock and menu bar, Wanigan tools per provider, the automation
// socket and its ledger, session and branch naming), the Sessions view's
// script launcher and "your terminal" dock, the Recent row and resume
// confirmation for a broken transcript chain, the Mission room's This week,
// the Context view's hook bench, and the code rail's attribution. Actual
// renderer, isolated Electron, synthetic services, no real agent calls. The
// main-process half runs against real sockets, PTYs, git and SQLite in
// src/main/smoke37.ts. The Dock badge and the menu-bar item are native macOS
// surfaces this renderer probe cannot photograph; smoke37 builds and clicks
// the real Electron menu instead.
//
//   npm run build && node scripts/probe-helper-p8-mac.mjs [--before] [--out dir]
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), { _electron } = require('playwright-core');
const root = path.resolve(import.meta.dirname, '..'), before = process.argv.includes('--before');
const outArg = process.argv.indexOf('--out');
const out = outArg >= 0 ? path.resolve(process.argv[outArg + 1])
  : path.join(root, 'docs/visuals/helper-p8-mac', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });

const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-p8-mac-'));
writeFileSync(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({
  executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [path.join(dir, 'main.cjs'), `--user-data-dir=${dir}/profile`], env,
});
const checks = [], errors = [], shots = [];
const record = (text) => { checks.push(text); console.log('✓', text); };

try {
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(STUB);
  await page.addInitScript(() => {
    localStorage.setItem('wanigan.code', '1');
    const now = Date.now();
    const DAY = 86_400_000;
    const monday = (() => { const d = new Date(now); const back = (d.getDay() + 6) % 7; d.setHours(0, 0, 0, 0); return d.getTime() - back * DAY; })();
    window.__calls = [];
    const api = window.wanigan;
    const override = (service, methods) => new Proxy(api[service], { get(obj, key) { return key in methods ? methods[key] : obj[key]; } });
    const terminal = { id: 'opt_1', projectId: 'p1', cwd: '/example/storefront', targetLabel: 'storefront', label: 'test', pid: 5120,
      command: 'npm run test', startedAt: now - 4_000, exitCode: null, endedAt: null };
    const past = (id, title, over = {}) => ({ id, conversationId: `conv-${id}`, providerId: 'claude', projectId: 'p1', projectPath: '/example/storefront', projectName: 'storefront',
      worktree: null, model: 'opus', effort: null, permissionMode: null, startedAt: now - 3 * 3_600_000, endedAt: now - 2 * 3_600_000, exitCode: 0,
      continuationCount: 1, live: true, pinnedAt: null, settledAt: null, title, titleSource: 'agent', ...over });
    const services = {
      mac: { settings: async () => ({ dockBadge: true, menuBarSessions: true, automationSocket: true, automationSend: false }), setSetting: async () => ({ dockBadge: true, menuBarSessions: true, automationSocket: true, automationSend: false }) },
      automation: {
        status: async () => ({ enabled: true, listening: true, sendAllowed: false, socketPath: '/Users/you/Library/Application Support/wanigan/automation/wanigan.sock',
          tokenPath: '/Users/you/Library/Application Support/wanigan/automation/token', error: null, queued: 1 }),
        ledger: async () => [
          { id: 4, at: now - 40_000, verb: 'send', sessionId: 's1', projectId: 'p1', peerPid: 7311, peerCommand: '/opt/homebrew/bin/python3', outcome: 'refused', detail: 'Scripts are not allowed to send. Turn on "Allow scripts to send"…' },
          { id: 3, at: now - 90_000, verb: 'draft', sessionId: 's1', projectId: 'p1', peerPid: 7311, peerCommand: '/opt/homebrew/bin/python3', outcome: 'drafted', detail: '64 characters' },
          { id: 2, at: now - 120_000, verb: 'list', sessionId: null, projectId: null, peerPid: 7302, peerCommand: '/bin/zsh', outcome: 'answered', detail: '2 sessions' },
          { id: 1, at: now - 300_000, verb: 'list', sessionId: null, projectId: null, peerPid: null, peerCommand: 'unknown peer', outcome: 'refused', detail: 'wrong token' },
        ],
        takeDrafts: async () => [],
        onDraft: () => () => {},
      },
      mcpTools: {
        state: async (ids) => ({
          catalogue: [
            { name: 'wanigan_list_goals', title: 'List Goals', readOnly: true }, { name: 'wanigan_get_goal', title: 'Inspect a Goal', readOnly: true },
            { name: 'wanigan_goal_checkpoint', title: 'Record a Goal checkpoint', readOnly: false }, { name: 'wanigan_goal_claim', title: 'Claim a Goal file path', readOnly: false },
            { name: 'wanigan_submit_run', title: 'Submit a batch run (spends money, always asks you)', readOnly: false },
            { name: 'wanigan_start_session', title: 'Start an agent session (always asks you)', readOnly: false },
          ],
          grants: Object.fromEntries(ids.map((id) => [id, id === 'codex' ? { mode: 'some', tools: ['wanigan_get_goal', 'wanigan_list_goals'] } : { mode: 'all', tools: [] }])),
        }),
        set: async (_id, grant) => grant,
      },
      naming: { get: async () => ({ title: '{ticket}: {summary}', branch: 'feature/{ticket}-{summary}' }), set: async (_p, t) => t },
      scripts: {
        list: async () => ({
          target: { kind: 'project', path: '/example/storefront', label: 'storefront', branch: 'main' },
          targets: [{ kind: 'project', path: '/example/storefront', label: 'storefront', branch: 'main' },
            { kind: 'worktree', path: '/example/worktrees/storefront-a1b2', label: 'wanigan/checkout-retry-a1b2', branch: 'wanigan/checkout-retry-a1b2' }],
          packageManager: 'npm', notes: [],
          scripts: [
            { source: 'package.json', name: 'test', body: 'vitest run', doc: null, favourite: true, command: 'npm run test' },
            { source: 'Makefile', name: 'build', body: 'go build ./...', doc: 'Build the service binary', favourite: false, command: 'make build' },
            { source: 'package.json', name: 'lint', body: 'eslint .', doc: null, favourite: false, command: 'npm run lint' },
            { source: 'justfile', name: 'deploy-preview', body: '(parameters: env="staging")\n./scripts/preview.sh {{env}}', doc: 'Ship a preview build', favourite: false, command: 'just deploy-preview' },
            { source: 'package.json', name: 'build:ssr client', body: 'vite build --ssr', doc: null, favourite: false, command: null },
          ],
        }),
        favourite: async () => [],
        run: async () => { window.__calls.push('run'); return terminal; },
        recentRuns: async () => [],
      },
      operatorTerminal: {
        list: async () => [], open: async () => terminal, close: async () => [], resize: async () => true, write: async () => true,
        scrollback: async () => '\x1b[1m~/example/storefront\x1b[0m % npm run test\r\n\r\n> storefront@1.0.0 test\r\n> vitest run\r\n\r\n \x1b[32m✓\x1b[0m src/cart.test.ts (12 tests) 41ms\r\n \x1b[32m✓\x1b[0m src/checkout.test.ts (9 tests) 88ms\r\n\r\n Test Files  2 passed (2)\r\n      Tests  21 passed (21)\r\n',
        onData: () => () => {}, onExit: () => () => {}, onList: () => () => {},
      },
      recap: {
        week: async () => ({
          projectName: 'storefront', start: monday, end: monday + 7 * DAY, sessionsRun: 9, conversations: 6, outcomeMethod: 'git', merged: 3, discarded: 1,
          goalsAccepted: [{ title: 'Checkout totals', at: now - DAY }], gatesFailed: 2, gatesRun: 7, failedCommands: ['npm test', 'npm run lint'],
          worktreesOpen: [{ path: '/example/worktrees/a', branch: 'wanigan/search-endpoint-c3d4', sessionId: 's2', createdAt: now - 2 * DAY, removedAt: null, outcome: 'open' }],
          halfFinished: [{ sessionId: 's9', title: 'Build the search endpoint', endedAt: now - 5 * 3_600_000, branch: 'wanigan/search-endpoint-c3d4' },
            { sessionId: 's8', title: 'Tidy the refund copy', endedAt: now - 30 * 3_600_000, branch: 'wanigan/refund-copy-e5f6' }],
          cost: { usd: 14.62, sessionsReporting: 7 }, operatorRuns: 4, nothingRecorded: false,
        }),
        exportMarkdown: async () => '/Users/you/Documents/wanigan-storefront-week.md',
      },
      hookBench: {
        run: async (target) => ({
          event: target.event, exitCode: 2, signal: null, timedOut: false, durationMs: 38,
          stdout: '', stderr: 'Refusing: rm -rf is not allowed in this repository.\n', stdoutTruncated: false, stderrTruncated: false,
          input: { session_id: 'wanigan-hook-bench', transcript_path: '/tmp/wanigan-hook-bench/transcript.jsonl', permission_mode: 'default', cwd: '/example/storefront',
            hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo wanigan-hook-bench' }, tool_use_id: 'toolu_wanigan_bench' },
          verdict: { effect: 'block', because: 'Exit code 2 is a blocking error; stderr is fed back as the reason.', feedback: 'Refusing: rm -rf is not allowed in this repository.' },
          envNames: ['PATH', 'HOME', 'TMPDIR', 'CLAUDE_PROJECT_DIR'],
        }),
      },
      chain: { check: async (ids) => Object.fromEntries(ids.map((id) => [id, id === 'h2'
        ? { checked: true, skipped: 3, breaks: 1, kinds: ['progress'], messages: 42, bytes: 180_000 }
        : { checked: true, skipped: 0, breaks: 0, kinds: [], messages: 12, bytes: 40_000 }])) },
      attribution: {
        summary: async () => ({ sessionId: 's1', computedAt: now - 60_000, addedByTurns: 48, addedInCommits: 36, commits: 2,
          stillPresent: { lines: 31, target: 'wanigan/checkout-retry-a1b2 at 9f8e7d6', merged: false }, note: null }),
        compute: async () => ({ sessionId: 's1', computedAt: now, addedByTurns: 48, addedInCommits: 36, commits: 2, stillPresent: { lines: 31, target: 'wanigan/checkout-retry-a1b2 at 9f8e7d6', merged: false }, note: null }),
        file: async () => ({ lines: 14, unmarked: 7, note: null, ranges: [
          { start: 5, end: 8, sessionId: 's1', title: 'Make checkout retries safe', turn: 1, origin: 'commit' },
          { start: 11, end: 13, sessionId: 's1', title: 'Make checkout retries safe', turn: 2, origin: 'checkpoint' },
        ] }),
        exportNotes: async () => ({ written: 2, skipped: 0, ref: 'refs/notes/ai' }),
      },
      sessions: override('sessions', {
        list: async () => (await api.sessions.list()).map((x) => ({ ...x, capabilities: { hooks: true } })),
        past: async () => [past('h1', 'Tidy the refund copy'), past('h2', 'Build the search endpoint', { startedAt: now - 26 * 3_600_000, endedAt: now - 25 * 3_600_000 })],
        scrollback: async () => 'Wanigan renderer fixture — no live provider\r\n',
        baseline: async () => ({ head: 'a'.repeat(40), dirty: [], at: now - 900_000 }),
      }),
      code: override('code', {
        list: async () => [{ name: 'src', rel: 'src', dir: true, size: 0 }, { name: 'checkout.ts', rel: 'checkout.ts', dir: false, size: 420 }],
        read: async () => ({ rel: 'checkout.ts', truncated: false, binary: false, text: [
          "import { payments } from './payments';", '', 'const attempts = new Map<string, number>();', '',
          'export function checkout(key: string) {', '  const existing = payments.get(key);', '  if (existing) return existing;', '  attempts.set(key, (attempts.get(key) ?? 0) + 1);',
          '  return payments.create(key);', '}', '', 'export function retryCheckout(key: string) {', '  return checkout(key);', '}',
        ].join('\n') }),
        changes: async () => ({ isRepo: true, branch: 'wanigan/checkout-retry-a1b2', headMoved: false, commits: 0, files: [] }),
        editors: async () => [],
      }),
      context: override('context', {
        config: async () => ({
          settings: [], agents: [], commands: [], mcp: [], notes: [], permissions: [],
          layers: [{ layer: 'project', path: '/example/storefront/.claude/settings.json', exists: true, keys: 1 }],
          hooks: [
            { event: 'PreToolUse', matcher: 'Bash', type: 'command', summary: 'On PreToolUse matching Bash: runs .claude/hooks/guard.sh', from: 'project', source: '/example/storefront/.claude/settings.json' },
            { event: 'Stop', matcher: null, type: 'command', summary: 'On every Stop: runs npm run lint --silent', from: 'user', source: '/Users/you/.claude/settings.json' },
            { event: 'PostToolUse', matcher: 'Edit', type: 'http', summary: 'On PostToolUse matching Edit: posts to https://hooks.example.com/…', from: 'user', source: '/Users/you/.claude/settings.json' },
          ],
        }),
      }),
    };
    window.wanigan = new Proxy(api, { get(target, service) { return service in services ? services[service] : target[service]; } });
  });

  const shoot = async (name) => {
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      await page.waitForTimeout(150);
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const file = path.join(out, `${name}-${theme}.png`);
      await page.screenshot({ path: file, scale: 'css' });
      shots.push({ file: path.relative(root, file), theme, bodyBackground: bg });
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  };
  const noRawValues = async (locator, what) => {
    const text = (await locator.innerText()).replace(/\s+/g, ' ');
    assert(!/\bundefined\b|\bNaN\b|\[object |\bnull\b/.test(text), `no raw value reaches the screen in ${what}: ${text.slice(0, 300)}`);
    return text;
  };
  const notClipped = async (locator, what) => {
    const fit = await locator.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    assert(fit.scroll <= fit.client + 1, `${what} is not clipped: ${JSON.stringify(fit)}`);
  };
  const toView = async (chord, selector) => {
    await page.evaluate(() => document.querySelector('.hdr-toggle')?.focus());
    await page.keyboard.press(chord);
    await page.locator(selector).first().waitFor();
  };

  await page.goto(rendererURL); await page.locator('.mission-room').waitFor();
  await page.evaluate(() => document.activeElement?.blur());

  /* ── Mission room · This week ─────────────────────────────────────── */
  if (before) {
    assert.equal(await page.locator('.p8-recap').count(), 0);
    await page.locator('.mission-projects').scrollIntoViewIfNeeded();
    await shoot('mission-week');
    record('before: the Mission room ends with the project spaces and says nothing about the week');
  } else {
    const recap = page.getByRole('region', { name: 'This week' });
    await recap.getByText('Sessions run').waitFor();
    await recap.scrollIntoViewIfNeeded();
    const text = await noRawValues(recap, 'This week');
    assert.match(text, /Sessions run 9 6 conversations/);
    assert.match(text, /Merged 3 read from git/);
    assert.match(text, /Gates failed 2 of 7 run/);
    assert.match(text, /Half-finished 2 exited without a merge/);
    assert.match(text, /\$14\.62 reported by 7 sessions/);
    assert.match(text, /Build the search endpoint/);
    assert.match(text, /no model wrote any of this/);
    await recap.getByRole('button', { name: 'Export Markdown…' }).waitFor();
    await shoot('mission-week');
    await recap.getByRole('button', { name: 'Export Markdown…' }).click();
    await recap.getByText('/Users/you/Documents/wanigan-storefront-week.md').waitFor();
    record('the Mission room carries This week: sessions, merged and discarded with the git rule, goals, gates, open worktrees, half-finished conversations and observed cost, with Export Markdown…');
  }

  /* ── Sessions · scripts, your terminal, Recent ───────────────────── */
  await toView('Meta+1', '.sessions-view');
  await page.locator('.terminal-host:visible').waitFor();
  if (before) {
    assert.equal(await page.locator('.session-scripts').count(), 0);
    await shoot('sessions-toolbar');
    record('before: the Sessions toolbar has no way to run a project script');
  } else {
    const scripts = page.getByRole('button', { name: /^Scripts: run this project/ });
    await scripts.click();
    const dialog = page.getByRole('dialog', { name: 'Project scripts' });
    await dialog.locator('.p8-script').first().waitFor();
    const text = await noRawValues(dialog, 'the script launcher');
    assert.match(text, /Runs in your terminal — a plain shell that belongs to you, not an agent session/);
    assert.equal(await dialog.locator('.p8-script').count(), 5);
    assert.equal(await dialog.getByRole('button', { name: 'Remove test from favourites' }).getAttribute('aria-pressed'), 'true');
    assert.equal(await dialog.getByRole('button', { name: 'Run build:ssr client in your terminal' }).isDisabled(), true);
    assert.equal(await dialog.getByRole('combobox', { name: 'Run scripts in' }).count(), 1);
    await shoot('scripts-launcher');
    record('Scripts lists package.json, Makefile and justfile entries with the favourite first, the command each runs, a worktree choice, and no Run for a name that is not shell-safe');
    await dialog.getByRole('button', { name: 'Run test in your terminal' }).click();
    const dock = page.getByRole('region', { name: 'Your terminals' });
    await dock.getByText('your terminal').waitFor();
    await page.waitForFunction(() => document.querySelector('.p8-dock .xterm-rows')?.textContent?.includes('21 passed'));
    const dockText = await noRawValues(dock.locator('.p8-dock-head'), 'the terminal dock');
    assert.match(dockText, /your terminal/);
    assert.match(await dock.locator('.p8-dock-note').innerText(), /recorded as operator-run, never sent through the policy gate/);
    const box = await dock.boundingBox();
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    assert(box && box.x >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height, 'the dock sits inside the window: ' + JSON.stringify(box));
    await shoot('your-terminal');
    record('Run opens "your terminal" in a dock apart from the session tabs, labelled as operator-run and outside the policy gate');
    await dock.getByRole('button', { name: /^Close your terminal/ }).click();
  }

  const recentRow = page.locator('.past-row').filter({ hasText: 'Build the search endpoint' });
  await page.getByRole('button', { name: /^Choose a session/ }).click().catch(() => {});
  await recentRow.first().waitFor();
  await recentRow.first().scrollIntoViewIfNeeded();
  if (before) {
    assert.equal(await page.locator('.past-chain').count(), 0);
    await shoot('recent');
    record('before: a Recent row says nothing about whether its transcript will resume whole');
  } else {
    const warning = recentRow.locator('.past-chain');
    await warning.waitFor();
    assert.equal((await warning.innerText()).trim(), '⚠ 3 messages may be skipped when this conversation resumes (broken message chain in the transcript)');
    await notClipped(warning, 'the chain warning');
    assert.equal(await page.locator('.past-row').filter({ hasText: 'Tidy the refund copy' }).locator('.past-chain').count(), 0);
    await shoot('recent');
    record('the Recent row of a conversation with a broken chain says how many messages may be skipped; an intact one says nothing');
    await recentRow.locator('.past-main').click();
    const confirm = page.getByRole('dialog', { name: 'Resume with a broken message chain?' });
    await confirm.getByText(/3 messages may be skipped when this conversation resumes/).waitFor();
    assert.match(await confirm.innerText(), /changed nothing in it/);
    await shoot('resume-chain');
    record('resuming it first asks, repeating the sentence and saying the transcript was read and not changed');
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  }

  /* ── Code rail · attribution ─────────────────────────────────────── */
  await page.keyboard.press('Escape');
  const chip = page.locator('.atq-chip').filter({ hasText: 'storefront' }).first();
  if (await chip.count()) await chip.click();
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  await page.locator('.code-panel').waitFor();
  await page.locator('.code-tab').filter({ hasText: 'Files' }).click();
  await page.locator('.code-file').filter({ hasText: 'checkout.ts' }).first().click();
  await page.locator('pre.filepre').waitFor();
  if (before) {
    assert.equal(await page.locator('.p8-attr').count(), 0);
    await shoot('code-files');
    record('before: the Files tab shows a file with no way to see which session wrote a line');
  } else {
    const bar = page.locator('.p8-attr');
    await bar.getByText('lines added in the agent’s turns').waitFor();
    const barText = await noRawValues(bar, 'the attribution bar');
    assert.match(barText, /48 lines added in the agent’s turns/);
    assert.match(barText, /31 of those still present on wanigan\/checkout-retry-a1b2 at 9f8e7d6/);
    await page.getByRole('checkbox', { name: 'Show who wrote this' }).check();
    await page.locator('.p8-who .mark').first().waitFor();
    assert.equal(await page.locator('.p8-who .mark').count(), 2);
    assert.equal(await page.locator('.fl[data-attributed="true"]').count(), 7);
    const legend = await noRawValues(page.locator('.p8-who-legend'), 'the attribution legend');
    assert.match(legend, /lines 5–8 Make checkout retries safe · turn 1 committed/);
    assert.match(legend, /lines 11–13 Make checkout retries safe · turn 2 uncommitted, from its checkpoint/);
    await notClipped(page.locator('.p8-who-legend li').first(), 'a legend row');
    await page.locator('.fl[data-attributed="true"]').first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const gutter = await page.locator('.p8-who .mark').first().evaluate((el) => ({ scroll: el.scrollWidth, client: el.parentElement.clientWidth }));
    assert(gutter.scroll <= gutter.client, 'the gutter mark fits its column: ' + JSON.stringify(gutter));
    await shoot('code-attribution');
    await bar.getByRole('button', { name: 'Export as git notes…' }).click();
    await page.getByText(/Wrote 2 notes under refs\/notes\/ai\. Nothing was pushed\./).waitFor();
    record('the Files tab shows lines added in turns against lines still present, Export as git notes…, and Show who wrote this marking each range with its session and turn');
  }

  /* ── Context · hook bench ────────────────────────────────────────── */
  await toView('Meta+Shift+C', '.ctx');
  const tabs = page.getByRole('tablist', { name: 'Context sections' });
  await tabs.getByRole('tab', { name: 'Settings & hooks', exact: true }).click();
  const hooksTable = page.locator('table.grid').filter({ hasText: 'PreToolUse' });
  await hooksTable.waitFor();
  await hooksTable.scrollIntoViewIfNeeded();
  if (before) {
    assert.equal(await page.getByRole('button', { name: /Test the .* hook with sample input/ }).count(), 0);
    await shoot('context-hooks');
    record('before: the hooks table lists commands with no way to try one');
  } else {
    assert.equal(await page.getByRole('button', { name: /Test the .* hook with sample input/ }).count(), 2);
    assert.match(await hooksTable.innerText(), /http hooks are not run/);
    await page.getByRole('button', { name: 'Test the PreToolUse hook with sample input' }).click();
    const result = page.getByRole('region', { name: /Hook test result/ });
    await result.getByText('Claude Code would block').waitFor();
    const text = await noRawValues(result, 'the hook bench result');
    assert.match(text, /exit 2/);
    assert.match(text, /Exit code 2 is a blocking error/);
    assert.match(text, /Refusing: rm -rf is not allowed/);
    await result.scrollIntoViewIfNeeded();
    await shoot('context-hook-bench');
    record('each command hook offers Test with sample input; the result shows exit code, stderr, and what Claude Code would make of it');
  }

  /* ── Settings ────────────────────────────────────────────────────── */
  await toView('Meta+,', '.set-panels');
  const tab = (name) => page.getByRole('tab', { name: new RegExp(`^${name}`) }).first();
  await tab('App').click();
  if (before) {
    assert.equal(await page.locator('[data-section-title="Dock and menu bar"]').count(), 0);
    await page.locator('[data-section-title="Motion"]').scrollIntoViewIfNeeded();
    await shoot('settings-app');
    record('before: Settings › App has no Dock or menu-bar switch');
  } else {
    const section = page.locator('[data-section-title="Dock and menu bar"]');
    await section.scrollIntoViewIfNeeded();
    const text = await noRawValues(section, 'Dock and menu bar');
    assert.match(text, /never shows what a session was asked/);
    assert.equal(await section.getByRole('switch').count(), 2);
    await shoot('settings-app');
    record('Settings › App carries the Dock count and the menu-bar list, each saying what it shows and what it never shows');
  }

  await tab('Connections').click();
  if (before) {
    await page.locator('[data-section-title="MCP servers"]').scrollIntoViewIfNeeded();
    await shoot('settings-connections');
    record('before: Settings › Connections has one switch for Wanigan\'s MCP server and no per-provider choice or automation socket');
  } else {
    const grants = page.locator('[data-section-title="Wanigan tools per provider"]');
    await grants.scrollIntoViewIfNeeded();
    await grants.locator('.p8-grant').first().waitFor();
    const text = await noRawValues(grants, 'Wanigan tools per provider');
    assert.match(text, /Claude Code claude .*6 of 6 tools/);
    assert.match(text, /Codex codex .*2 of 6 tools/);
    await grants.locator('details.p8-grant-tools summary').first().click();
    assert.equal(await grants.getByRole('checkbox', { name: /wanigan_get_goal/ }).isChecked(), true);
    await shoot('settings-mcp-tools');
    record('Wanigan tools per provider sets all, none or a chosen subset per profile');
    const socket = page.locator('[data-section-title="Automation socket"]');
    await socket.scrollIntoViewIfNeeded();
    const socketText = await noRawValues(socket, 'Automation socket');
    assert.match(socketText, /listening/);
    assert.match(socketText, /never shown in this window/);
    assert.match(socketText, /\/opt\/homebrew\/bin\/python3 · pid 7311/);
    assert.match(socketText, /unknown peer/);
    await notClipped(socket.locator('.p8-socket-line'), 'the socket path line');
    await shoot('settings-automation');
    record('the automation socket shows where it listens, keeps the token out of the window, and ledgers every call with its peer process');
  }

  await tab('Projects').click();
  if (before) {
    await page.locator('[data-section-title="Worktrees"]').scrollIntoViewIfNeeded();
    await shoot('settings-projects');
    record('before: Settings › Projects & safety has no naming format');
  } else {
    const naming = page.locator('[data-section-title="Session names and branches"]');
    await naming.scrollIntoViewIfNeeded();
    await naming.getByText('valid git ref').waitFor();
    const text = await noRawValues(naming.locator('.p8-preview'), 'the naming preview');
    assert.match(text, /Title JIRA-123: Fix the checkout total rounding on refunds/);
    assert.match(text, /Branch feature\/JIRA-123-fix-the-checkout-total-rounding-on-a1b2c3 ✓ valid git ref/);
    const branch = naming.getByRole('textbox', { name: 'Worktree branch format' });
    await branch.fill('feature branch/{summary}');
    await naming.getByText(/may use only letters, digits/).waitFor();
    assert.equal(await naming.getByRole('button', { name: 'Save formats' }).isDisabled(), true);
    await shoot('settings-naming-invalid');
    await branch.fill('feature/{ticket}-{summary}');
    await naming.getByText('valid git ref').waitFor();
    await shoot('settings-naming');
    record('Session names and branches previews the title and branch live against a sample prompt, marks a valid ref, and refuses a format git would reject');
  }

  assert.deepEqual(errors, []);
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({
    at: new Date().toISOString(),
    provenance: 'Actual Electron renderer from out/renderer of the checkout this script ran in; synthetic services; no real agent calls',
    mode: before ? 'before' : 'after',
    commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(),
    uncommittedChanges: execFileSync('git', ['-C', root, 'status', '--porcelain', '--', 'src']).toString().trim().split('\n').filter(Boolean).length,
    checks, errors, shots,
  }, null, 2) + '\n');
} finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
