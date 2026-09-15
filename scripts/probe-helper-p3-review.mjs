#!/usr/bin/env node
// Helper sweep · P3 · reviewing the work. The code rail's needs-review verdict,
// per-file marks, scopes, alarms, image before/after, dependencies, claims and
// the unsent-note guard; Fleet's needs-review chip; the Git view's agent
// worktree rows, risk tiers and the evidence-written PR body. Actual renderer,
// isolated Electron, synthetic sessions and services, no real agent calls. The
// main-process half runs against real repositories in src/main/smoke32.ts.
//
//   npm run build && node scripts/probe-helper-p3-review.mjs [--before] [--out dir]
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), { _electron } = require('playwright-core');
const root = path.resolve(import.meta.dirname, '..'), before = process.argv.includes('--before');
const outArg = process.argv.indexOf('--out');
const out = outArg >= 0 ? path.resolve(process.argv[outArg + 1])
  : path.join(root, 'docs/visuals/helper-p3-review', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });

/** A small real PNG: a coloured field with a bar, so before and after differ visibly. */
function png(width, height, fill, bar) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = [0];
    for (let x = 0; x < width; x++) row.push(...(y > height * 0.4 && y < height * 0.6 && x < width * bar ? [240, 240, 240] : fill));
    rows.push(Buffer.from(row));
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const IMAGES = { before: png(160, 90, [28, 96, 142], 0.35), after: png(160, 90, [18, 114, 71], 0.8) };

const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-p3-review-'));
writeFileSync(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({
  executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [path.join(dir, 'main.cjs'), `--user-data-dir=${dir}/profile`], env,
});
const checks = [], errors = [];
const record = (text) => { checks.push(text); console.log('✓', text); };
const shots = [];

try {
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(STUB);
  await page.addInitScript((images) => {
    localStorage.setItem('wanigan.code', '1'); localStorage.setItem('wanigan.composer', '1');
    const now = Date.now();
    const BASE = '1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d';
    const patches = {
      'src/checkout.test.ts': ['diff --git a/src/checkout.test.ts b/src/checkout.test.ts', '--- a/src/checkout.test.ts', '+++ b/src/checkout.test.ts',
        '@@ -8,5 +8,5 @@ describe(\'checkout\', () => {', "   it('charges once', () => {", '-    expect(charges).toHaveLength(1);', '-    expect(total).toBe(42);',
        '+    expect(charges.length).toBeGreaterThan(0);', '   });', "-  it('retries', () => {", "+  it.skip('retries', () => {", ''].join('\n'),
      'src/checkout.ts': ['diff --git a/src/checkout.ts b/src/checkout.ts', '--- a/src/checkout.ts', '+++ b/src/checkout.ts', '@@ -1,4 +1,7 @@',
        '-export function checkout() {', '+export function checkout(key: string) {', '+  const existing = payments.get(key);', '+  if (existing) return existing;',
        '+  retryCheckout(key);', '   return payments.create();', ' }', ''].join('\n'),
      'package.json': ['diff --git a/package.json b/package.json', '--- a/package.json', '+++ b/package.json', '@@ -3,5 +3,6 @@', '   "dependencies": {',
        '-    "react": "^18.2.0"', '+    "react": "^19.0.0",', '+    "p-retry": "6.2.0"', '   }', ''].join('\n'),
      '.github/workflows/ci.yml': ['diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml', 'new file mode 100644', '--- /dev/null', '+++ b/.github/workflows/ci.yml',
        '@@ -0,0 +1,3 @@', '+on: push', '+jobs:', '+  test: { runs-on: ubuntu-latest }', ''].join('\n'),
      'docs/flow.png': 'diff --git a/docs/flow.png b/docs/flow.png\nBinary files a/docs/flow.png and b/docs/flow.png differ\n',
    };
    const review = (state, over = {}) => ({ state, stale: false, marked: state === 'unreviewed' ? null : state, note: null, markedAt: state === 'unreviewed' ? null : now - 60_000, ...over });
    const f = (path, over) => Object.assign({ path, oldPath: null, status: 'M', added: 3, removed: 1, binary: false, contentHash: 'h' + path.length,
      preexisting: false, review: review('unreviewed'), attribution: 'edit-tool', attributionLabel: 'edited by an edit tool', tier: null, kind: 'other', alarms: [], image: false }, over);
    const files = [
      f('src/checkout.test.ts', { added: 2, removed: 3, kind: 'test', attribution: 'outside-edit-tools', attributionLabel: 'changed outside edit tools',
        alarms: [{ kind: 'assertions-removed', label: '2 assertion lines removed, 1 added', line: 9, text: '-    expect(charges).toHaveLength(1);' },
                 { kind: 'skip-added', label: 'test skipped', line: 11, text: "+  it.skip('retries', () => {" }] }),
      f('src/checkout.ts', { added: 4, removed: 1, review: review('approved') }),
      f('package.json', { added: 2, removed: 1, attribution: 'shell-reported', attributionLabel: 'changed by a shell command (reported by Claude Code)', review: review('commented', { note: 'Why p-retry rather than our own backoff?' }) }),
      f('.github/workflows/ci.yml', { status: 'A', added: 3, removed: 0, tier: 'high', review: review('unreviewed', { stale: true, marked: 'approved', note: null }) }),
      f('docs/flow.png', { added: null, removed: null, binary: true, image: true, attribution: 'outside-edit-tools', attributionLabel: 'changed outside edit tools' }),
    ];
    const counts = { files: 5, approved: 1, rejected: 0, commented: 1, stale: 1, unreviewed: 3, added: 11, removed: 5, binary: 1 };
    const work = { sessionId: 's1', root: '/example/storefront', base: BASE, anchor: "this session's changes against 1a2b3c4d, the commit it started from",
      turn: 'turn-ended', files, verdict: { needsReview: true, reason: 'unapproved-files', because: 'Its turn ended with 5 changed files, and 4 are not approved.', counts },
      label: 'Needs review · 1 of 5 files', hooksRecorded: true, shellDiffReported: true, tiersConfigured: true, highTierUnapproved: ['.github/workflows/ci.yml'],
      truncated: false, patchTruncated: false, unreadable: null, projectId: 'p1' };
    window.__marks = []; window.__writes = []; window.__staged = [];
    const summary = (id, needs, c) => ({ sessionId: id, needsReview: needs, reason: needs ? 'unapproved-files' : 'all-approved', because: '', label: `Needs review · ${c.approved} of ${c.files} files`, counts: c, highTierUnapproved: needs ? 1 : 0 });
    const wt = { path: '/example/worktrees/storefront-a1b2', branch: 'wanigan/checkout-retry-a1b2', head: 'abc1234', repoRoot: '/example/storefront', sessionId: 's1', dirty: 0, ahead: 3 };
    const wt2 = { path: '/example/worktrees/storefront-c3d4', branch: 'wanigan/copy-pass-c3d4', head: 'def5678', repoRoot: '/example/storefront', sessionId: 's3', dirty: 0, ahead: 1 };
    const api = window.wanigan;
    const override = (service, methods) => new Proxy(api[service], { get(obj, key) { return key in methods ? methods[key] : obj[key]; } });
    const services = {
      code: override('code', {
        changes: async () => ({ isRepo: true, branch: 'wanigan/checkout-retry-a1b2', headMoved: false, commits: 0, attributed: true, unreadable: null,
          files: files.filter((x) => x.path !== '.github/workflows/ci.yml').map((x) => ({ path: x.path, index: ' ', work: x.status === 'A' ? '?' : 'M', staged: false, untracked: false, preexisting: false })) }),
        diff: async (_root, file) => patches[file] ?? '',
        editors: async () => [],
      }),
      sessions: override('sessions', {
        // Hook-capable, so the rail offers what a hook-capable session gets.
        list: async () => (await api.sessions.list()).map((x) => ({ ...x, capabilities: { hooks: true } })),
        baseline: async () => ({ head: BASE, dirty: [], at: now - 900_000 }),
        scrollback: async () => 'Wanigan renderer fixture — no live provider\r\n\r\n> Make checkout retries safe.\r\n',
        write: async (...args) => { window.__writes.push(args); },
      }),
      checkpoints: override('checkpoints', {
        list: async () => [
          { id: 1, sessionId: 's1', turn: 0, kind: 'session-start', at: now - 900_000, repoRoot: '/example/storefront', commitHash: BASE, treeHash: 't0', filesChanged: null, status: 'ok', detail: null },
          { id: 2, sessionId: 's1', turn: 1, kind: 'turn-start', at: now - 800_000, repoRoot: '/example/storefront', commitHash: BASE, treeHash: 't0', filesChanged: 0, status: 'skipped-unchanged', detail: null },
          { id: 3, sessionId: 's1', turn: 1, kind: 'turn-end', at: now - 700_000, repoRoot: '/example/storefront', commitHash: 'c'.repeat(40), treeHash: 't1', filesChanged: 3, status: 'ok', detail: null },
          { id: 4, sessionId: 's1', turn: 2, kind: 'turn-start', at: now - 600_000, repoRoot: '/example/storefront', commitHash: 'c'.repeat(40), treeHash: 't1', filesChanged: 0, status: 'skipped-unchanged', detail: null },
          { id: 5, sessionId: 's1', turn: 2, kind: 'turn-end', at: now - 500_000, repoRoot: '/example/storefront', commitHash: 'd'.repeat(40), treeHash: 't2', filesChanged: 2, status: 'ok', detail: null },
        ],
      }),
      reviewWork: {
        work: async () => work,
        summaries: async () => ({ s1: summary('s1', true, counts), s3: summary('s3', false, { files: 2, approved: 2, rejected: 0, commented: 0, stale: 0, unreviewed: 0, added: 9, removed: 2, binary: 0 }) }),
        setMark: async (...args) => { window.__marks.push(args); return review(args[2], { note: args[3] ?? null }); },
        fileDiff: async (_s, file) => patches[file] ?? '',
        patch: async () => ({ patch: Object.values(patches).join(''), truncated: false }),
        image: async () => ({ before: { dataUrl: 'data:image/png;base64,' + images.before, bytes: 1840, note: null }, after: { dataUrl: 'data:image/png;base64,' + images.after, bytes: 2210, note: null } }),
        turnStats: async () => ({ 1: { files: 3, added: 9, removed: 4 }, 2: { files: 2, added: 2, removed: 1 } }),
        dependencies: async () => ({ hooksRecorded: true,
          installs: [{ command: 'npm install p-retry@6.2.0', ok: true, exitCode: null, at: now - 650_000 }],
          manifests: [{ path: 'package.json', kind: 'package.json', note: null, error: null,
            changes: [{ name: 'p-retry', section: 'dependencies', change: 'added', before: null, after: '6.2.0' }, { name: 'react', section: 'dependencies', change: 'upgraded', before: '^18.2.0', after: '^19.0.0' }],
            lines: ['added `p-retry` 6.2.0 (package.json dependencies)', 'upgraded `react` ^18.2.0 → ^19.0.0 (package.json dependencies)'] }] }),
        claims: async () => ({ state: 'graded', source: 'the archived transcript', messageChars: 420, claims: [
          { kind: 'file-changed', subject: 'src/checkout.ts', quote: 'Updated `src/checkout.ts` to reuse the stored payment.', grade: 'verified', because: '`src/checkout.ts` is in the diff (modified).' },
          { kind: 'symbol-added', subject: 'retryCheckout', quote: 'Added a `retryCheckout()` helper.', grade: 'unsupported', because: '`retryCheckout` does not appear in any added line of the diff.' },
          { kind: 'tests-pass', subject: null, quote: 'All tests pass.', grade: 'unsupported', because: 'The last recorded test command, `npm test`, exited 1.' },
          { kind: 'vague', subject: null, quote: 'It should work now.', grade: 'needs-review', because: 'A general statement with nothing specific in it to check.' },
        ] }),
        stagePlan: async () => ({ ok: true, refusal: null, digest: 'a'.repeat(64), root: '/example/storefront', turns: 2, untouched: ['notes/todo.md'], patch: patches['src/checkout.ts'],
          files: [{ path: 'src/checkout.ts', action: 'stage', turns: [1, 2], mixed: true, reason: null, patch: patches['src/checkout.ts'] },
                  { path: 'src/checkout.test.ts', action: 'refuse', turns: [], mixed: true, reason: 'An edit to `src/checkout.test.ts` after the last turn touches lines the session\'s earlier turns changed, so the two cannot be staged apart.', patch: '' }] }),
        stageApply: async (...args) => { window.__staged.push(args); return { staged: ['src/checkout.ts'], detail: 'Staged the session\'s hunks in 1 file.' }; },
        mergeCheck: async () => ({ allowed: false, sessionId: 's1', highTier: ['.github/workflows/ci.yml'], detail: '1 high-tier file in this diff is not approved: .github/workflows/ci.yml. Approve it in the session\'s code rail before merging.' }),
        prDraft: async (rootPath) => rootPath.startsWith('/example/worktrees/')
          ? { kind: 'draft', sessionId: 's1', goalTitle: 'Make checkout retries safe', body: ['## Goal: Make checkout retries safe', '', 'Acceptance checks, as written on the goal (not graded here):', '- A retried checkout charges once.', '',
              '## What changed', '- 2 turns recorded in the session', '- 5 files changed (+11 −5, 1 binary file not counted)', '  - `src/checkout.ts` +4 −1', '', '## Checks run', '- `npm test` → exit 0 in 12.3s (goal verification)', '',
              '## Dependencies', '- added `p-retry` 6.2.0 (package.json dependencies)', '', '---', "Written from Wanigan's recorded evidence."].join('\n') }
          : { kind: 'none', reason: 'No Wanigan session was launched on main, so there is no recorded evidence to write a body from.' },
      },
      riskTiers: {
        list: async () => [{ pattern: '.github/workflows/**', tier: 'high' }, { pattern: '**/migrations/**', tier: 'high' }, { pattern: 'package-lock.json', tier: 'medium' }],
        save: async (_p, rules) => rules,
        defaults: async () => [{ pattern: '**/auth/**', tier: 'high' }, { pattern: 'Dockerfile', tier: 'high' }],
      },
      worktrees: override('worktrees', { list: async () => [wt, wt2], forecast: async () => ({ projectId: 'p1', repoRoot: '/example/storefront', at: now, unsupported: null, omitted: 0, worktrees: [], pairs: [] }) }),
      git: override('git', {
        status: async (r) => ({ isRepo: true, root: r, repoRoot: r, subpath: null, branch: 'main', detached: false, upstream: 'origin/main', ahead: 0, behind: 0,
          staged: [], unstaged: [], untracked: [], conflicted: [], clean: true, operation: null }),
        branches: async () => [
          { name: 'main', current: true, remote: false, upstream: 'origin/main', ahead: 0, behind: 0, at: now - 3600_000, subject: 'Release 2.4' },
          { name: wt.branch, current: false, remote: false, upstream: 'origin/' + wt.branch, ahead: 3, behind: 0, at: now - 600_000, subject: 'Reuse the stored payment' },
          { name: wt2.branch, current: false, remote: false, upstream: null, ahead: 1, behind: 0, at: now - 900_000, subject: 'Copy pass' },
        ],
        log: async () => [{ hash: 'abc1234'.padEnd(40, '0'), short: 'abc1234', parents: [], author: 'Smoke', email: 's@x', at: now - 600_000, subject: 'Release 2.4', body: '', refs: ['HEAD -> main'], head: true, lane: 0, color: 0 }],
      }),
      gh: override('gh', { prStatus: async () => ({ status: { kind: 'none', branch: 'main' }, checkedAt: now, gh: { path: '/usr/local/bin/gh', version: '2.60.0' } }) }),
      control: override('control', (() => {
        const node = (id, kind, title, status, deps = []) => ({ id, docketId: 'g1', kind, title, status, instructions: 'Prove the retry is safe before review.', dependsOn: deps, claimPath: null,
          providerId: 'claude', model: null, sessionId: null, worktree: null, startedAt: null, endedAt: null, detail: null, deferUntil: null, queued: false, reopenedAt: null });
        const goal = { id: 'g1', projectId: 'p1', projectName: 'storefront', title: 'Make checkout retries safe', objective: 'A retried checkout charges once.', acceptance: ['A retried checkout charges once.'],
          risk: 'elevated', budgetUsd: null, baseCommit: BASE, status: 'executing', createdAt: now - 86_400_000, updatedAt: now - 60_000,
          autopilot: { enabled: false, providerId: null, model: null, budgetUsd: null, spendUsd: 0, spendStatus: 'none', haltedReason: null, haltedAt: null },
          nodes: [node('n1', 'plan', 'Map the retry boundary', 'completed'), node('n2', 'implement', 'Protect every payment', 'completed', ['n1']),
                  node('n3', 'verify', 'Prove retries are safe', 'ready', ['n2']), node('n4', 'review', 'The final review', 'blocked', ['n3'])],
          claims: [], checkpoints: [], proofs: [] };
        return { list: async () => [goal], get: async () => structuredClone(goal), sessionGoal: async () => null, mcpTasks: async () => [], resumeReceipts: async () => [], traces: async () => [], events: async () => [], outcomes: async () => [] };
      })()),
      proof: {
        regressionCommand: async () => ({ command: 'npm test -- checkout.retry', approvedAt: now - 3_600_000 }),
        saveRegressionCommand: async (_n, command) => ({ command, approvedAt: now }),
        latestRegression: async () => ({ id: 'proof_r1', nodeId: 'n3', command: 'npm test -- checkout.retry', verdict: 'proved', label: 'proved: fails before, passes after',
          because: 'The command exited 1 at the base commit and 0 at head.', linked: ['node_modules'], createdAt: now - 120_000,
          before: { commit: BASE, exitCode: 1, durationMs: 8400, outputTail: 'FAIL src/checkout.test.ts\n  ● checkout › retries › charges once\n    Expected: 1\n    Received: 2', notRun: null },
          after: { commit: 'c'.repeat(40), exitCode: 0, durationMs: 7900, outputTail: 'PASS src/checkout.test.ts\nTests: 12 passed, 12 total', notRun: null } }),
        runRegression: async () => { throw new Error('not run in the probe'); },
      },
    };
    window.wanigan = new Proxy(api, { get(target, service) { return service in services ? services[service] : target[service]; } });
  }, IMAGES);

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

  await page.goto(rendererURL); await page.locator('.mission-room').waitFor();
  await page.evaluate(() => document.activeElement?.blur());

  /* ── the code rail ─────────────────────────────────────────────────── */
  await page.keyboard.press('Meta+1');
  await page.locator('.sessions-view').waitFor();
  await page.locator('.terminal-host:visible').waitFor();
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  await page.locator('.code-panel').waitFor();

  if (before) {
    await page.locator('.code-file').filter({ hasText: 'src/checkout.ts' }).first().click();
    await page.locator('pre.diff').waitFor();
    assert.equal(await page.locator('.rw-summary').count(), 0, 'the base build has no review verdict in the rail');
    await shoot('code-rail');
    record('before: the code rail lists changed files and a diff, with no verdict, no marks, no scopes and no evidence under the diff');
    await page.getByRole('button', { name: /^Turns/ }).click();
    await page.locator('.code-file').filter({ hasText: 'Turn 1' }).waitFor();
    await shoot('turns');
    record('before: each turn row says how many files it changed and nothing about lines');
  } else {
    const summary = page.getByRole('region', { name: 'Review of this session' });
    await summary.getByText('Needs review · 1 of 5 files').waitFor();
    const summaryText = await noRawValues(summary, 'the review summary');
    assert.match(summaryText, /\+11 −5/);
    assert.match(summaryText, /1 commented .*1 changed since marked .*1 high-tier unapproved/);
    assert.match(summaryText, /Its turn ended with 5 changed files, and 4 are not approved\./);
    record('the rail states the verdict as "Needs review · 1 of 5 files" with its diff stat, its counts and the rule in words');

    const scope = page.getByRole('group', { name: 'Diff scope' });
    assert.match((await scope.innerText()).replace(/\s+/g, ' '), /Agent edits 3 Uncommitted 4 Branch 5/);
    const rows = page.locator('.code-list .code-file');
    const order = await rows.allInnerTexts();
    assert.match(order[0], /src\/checkout\.test\.ts/, 'tests come first in review order: ' + JSON.stringify(order));
    record('three scopes are counted, and the branch scope lists the test file first in review order');

    await rows.filter({ hasText: 'src/checkout.test.ts' }).first().click();
    const bar = page.locator('.rw-filebar');
    await bar.waitFor();
    const barText = await noRawValues(bar, 'the file header');
    assert.match(barText, /2 assertion lines removed, 1 added · line 9/);
    assert.match(barText, /test skipped · line 11/);
    assert.match(barText, /changed outside edit tools/);
    assert.doesNotMatch(barText, /not (by )?the agent/i);
    await notClipped(bar.locator('.rw-tags'), 'the alarm tags');
    await shoot('code-rail');
    record('a test file\'s header carries its alarms with their lines and says "changed outside edit tools", never "not the agent"');

    await bar.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.waitForFunction(() => window.__marks.length === 1);
    const marked = (await page.evaluate(() => window.__marks))[0];
    assert.deepEqual(marked.slice(1, 3), ['src/checkout.test.ts', 'approved']);
    assert(/^s\d$/.test(marked[0]), 'the mark names the open session: ' + marked[0]);
    record('Approve sends the session id, the path and the state; main computes the hash');

    await rows.filter({ hasText: '.github/workflows/ci.yml' }).first().click();
    const ciBar = page.locator('.rw-filebar');
    await ciBar.getByText('changed since you marked it').waitFor();
    assert.match(await ciBar.innerText(), /high tier/);
    record('an approval made on an older version of a file shows "changed since you marked it", beside its high tier');

    await rows.filter({ hasText: 'docs/flow.png' }).first().click();
    const images = page.getByRole('group', { name: 'Before and after for docs/flow.png' });
    await images.locator('img').nth(1).waitFor();
    const sizes = await images.locator('img').evaluateAll((els) => els.map((el) => ({ w: el.naturalWidth, src: el.getAttribute('src').slice(0, 22) })));
    assert.deepEqual(sizes.map((s) => s.src), ['data:image/png;base64,', 'data:image/png;base64,']);
    assert(sizes.every((s) => s.w === 160), 'both images decoded: ' + JSON.stringify(sizes));
    await shoot('image');
    record('a changed PNG shows before and after side by side, both decoded from data URLs');

    // Both open themselves when they hold something to act on: an added package, an unsupported claim.
    for (const name of ['Dependencies', 'Claims in the final message']) {
      const section = page.locator('details.rw-section').filter({ hasText: name });
      await section.waitFor();
      assert.equal(await section.evaluate((el) => el.open), true, `${name} opens itself when it holds something to act on`);
    }
    const deps = await noRawValues(page.locator('details.rw-section').filter({ hasText: 'Dependencies' }), 'dependencies');
    assert.match(deps, /added p-retry 6\.2\.0 · dependencies/);
    assert.match(deps, /upgraded react \^18\.2\.0 → \^19\.0\.0/);
    assert.match(deps, /npm install p-retry@6\.2\.0/);
    const claims = await noRawValues(page.locator('details.rw-section').filter({ hasText: 'Claims in the final message' }), 'claims');
    assert.match(claims, /1 verified · 2 unsupported · 1 needs review/);
    assert.match(claims, /The last recorded test command, npm test, exited 1\./);
    assert.equal(await page.locator('.rw-claims .mono').filter({ hasText: 'npm test' }).count(), 1, 'code in a claim\'s reason is set in monospace, not shown with backticks');
    await page.locator('.rw-sections').scrollIntoViewIfNeeded();
    await shoot('evidence');
    record('under the diff, Dependencies lists the added and upgraded packages with the install command, and Claims grades each claim with its reason');

    // The unsent-note guard: write a note on a line, move to another file.
    await rows.filter({ hasText: 'src/checkout.ts' }).first().click();
    await page.locator('.review-diff .dl').filter({ hasText: 'if (existing) return existing;' }).first().click();
    await page.getByRole('textbox', { name: 'Review note for the selected lines' }).fill('Compare the amount before returning the stored payment.');
    await rows.filter({ hasText: 'package.json' }).first().click();
    const kept = page.locator('.rw-unsent');
    await kept.getByText(/An unsent note on src\/checkout\.ts is kept/).waitFor();
    await shoot('unsent-note');
    await kept.getByRole('button', { name: 'Return to it', exact: true }).click();
    await page.getByRole('textbox', { name: 'Review note for the selected lines' }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Review note for the selected lines' }).inputValue(), 'Compare the amount before returning the stored payment.');
    record('a note left unsent survives a move to another file and comes back with its text when the operator returns');
    await page.getByRole('button', { name: 'Cancel', exact: true }).last().click();
    await page.getByText('Discard this note? It has not been added, and it cannot be recovered.').waitFor();
    record('cancelling a written note asks before discarding it');
    await page.getByRole('button', { name: 'Discard note', exact: true }).click();

    await summary.getByRole('button', { name: 'Send review', exact: true }).click();
    const draft = page.getByRole('textbox', { name: 'Message the agent', exact: true });
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="Message the agent"]')?.value.includes('Review of this session'));
    const message = await draft.inputValue();
    assert.match(message, /^Review of this session's changes against 1a2b3c4d, the commit it started from\.\nAddress each one, or reply saying why you are leaving it as it is\./);
    assert.match(message, /1\. `package\.json` — comment:\n {3}Why p-retry rather than our own backoff\?/);
    assert.match(message, /Dependencies this diff adds, changes or removes — say why each one is needed:\n- added `p-retry` 6\.2\.0 \(package\.json dependencies\)/);
    assert.deepEqual(await page.evaluate(() => window.__writes), [], 'nothing was typed into the terminal');
    record('Send review puts one message with the comment and the new dependency into the message box, and sends nothing');

    await scope.getByRole('button', { name: /^Agent edits/ }).click();
    assert.equal(await rows.count(), 3);
    await page.getByRole('button', { name: "Stage only the session's hunks…", exact: true }).click();
    const stage = page.getByRole('region', { name: "Stage only the session's hunks" });
    await stage.getByText(/From 2 turns: 1 file to stage, 1 refused\./).waitFor();
    assert.match(await stage.innerText(), /cannot be staged apart/);
    await shoot('stage-hunks');
    await stage.getByRole('button', { name: 'Stage 1 file', exact: true }).click();
    await page.waitForFunction(() => window.__staged.length === 1);
    assert.equal((await page.evaluate(() => window.__staged))[0][1], 'a'.repeat(64));
    record('the agent-edits scope previews the session\'s hunks with the refused file and its reason, and stages with the previewed digest');

    await page.getByRole('button', { name: /^Turns/ }).click();
    const turn1 = page.locator('.code-file').filter({ hasText: 'Turn 1' });
    await turn1.getByText('3 files · +9 −4').waitFor();
    await shoot('turns');
    record('each turn row carries its +N −M badge from the checkpoints');
  }

  /* ── Fleet ─────────────────────────────────────────────────────────── */
  await page.keyboard.press('Meta+2');
  await page.locator('.fleet-view').waitFor();
  const entry = page.locator('.fleet-entry').filter({ hasText: 'storefront' }).first();
  await entry.waitFor();
  if (before) {
    assert.equal(await page.locator('.fleet-entry-review').count(), 0);
    await shoot('fleet');
    record('before: a Fleet row says what state a session is in and nothing about whether its diff was reviewed');
  } else {
    const chip = entry.locator('.fleet-entry-review');
    await chip.getByText('Needs review · 1 of 5 files').waitFor();
    assert.match(await chip.innerText(), /\+11 −5/);
    await notClipped(chip, 'the Fleet review chip');
    const reviewed = page.locator('.fleet-entry').filter({ hasText: 'platform' }).locator('.fleet-entry-review');
    assert.match((await reviewed.allInnerTexts()).join(' '), /\+9 −2/);
    assert.doesNotMatch((await reviewed.allInnerTexts()).join(' '), /Needs review/);
    await shoot('fleet');
    record('a Fleet row carries "Needs review · 1 of 5 files" and its diff stat; a fully approved session shows only its stat');
  }

  /* ── Git ───────────────────────────────────────────────────────────── */
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  const views = page.getByRole('group', { name: 'Repository views' });
  await views.waitFor();
  await views.getByRole('button', { name: 'Branches', exact: true }).click();
  await page.locator('.gt-file').filter({ hasText: 'wanigan/checkout-retry-a1b2' }).first().waitFor();

  if (before) {
    await shoot('git-branches');
    record('before: the branches pane lists agent worktree branches with no review state or diff size');
    await page.getByRole('button', { name: 'Check for a PR' }).click();
    await page.getByRole('button', { name: 'Create PR', exact: true }).click();
    await page.getByRole('textbox', { name: 'Pull request body' }).waitFor();
    await shoot('pr-dialog');
    record('before: the create-PR dialog opens with an empty body');
  } else {
    const section = page.getByRole('region', { name: 'Agent worktrees' });
    await section.getByText('Needs review · 1 of 5 files').waitFor();
    const text = await noRawValues(section, 'the worktree rows');
    const firstRow = (await section.locator('.rw-worktree').first().innerText()).replace(/\s+/g, ' ');
    assert.match(firstRow, /^wanigan\/checkout-retry-a1b2/, 'sorted by diff size, the bigger diff leads: ' + firstRow);
    assert.match(text, /5 files · \+11 −5/);
    assert.match(text, /1 high-tier unapproved/);
    assert.equal(await section.getByRole('button', { name: 'merge into main', exact: true }).first().isDisabled(), true);
    await section.getByRole('button', { name: 'Branch', exact: true }).click();
    const byName = (await section.locator('.rw-worktree').first().innerText()).replace(/\s+/g, ' ');
    assert.match(byName, /^wanigan\/checkout-retry-a1b2/);
    await section.getByRole('button', { name: 'Diff size', exact: true }).click();
    await shoot('git-worktrees');
    record('the Git view lists agent worktrees with their review state and diff size, sorted by size, with merge disabled while a high-tier file is unapproved');

    const tiers = page.locator('details.gt-review-controls').filter({ hasText: 'Risk tiers' });
    await tiers.locator('summary').click();
    await tiers.getByRole('textbox', { name: 'Path pattern 1' }).waitFor();
    assert.equal(await tiers.getByRole('textbox', { name: 'Path pattern 1' }).inputValue(), '.github/workflows/**');
    await tiers.getByRole('button', { name: 'Offer defaults', exact: true }).click();
    await tiers.getByRole('textbox', { name: 'Path pattern 5' }).waitFor();
    assert.match(await tiers.innerText(), /Unsaved changes\./);
    await shoot('git-risk-tiers');
    record('the risk tier editor shows the project\'s rules and offers the defaults as unsaved rows, never applying them');
    await tiers.locator('summary').click();

    await section.getByRole('button', { name: 'create PR…', exact: true }).first().click();
    const body = page.getByRole('textbox', { name: 'Pull request body' });
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="Pull request body"]')?.value.includes('Written from'));
    const value = await body.inputValue();
    assert.match(value, /^## Goal: Make checkout retries safe/);
    assert.match(value, /- `npm test` → exit 0 in 12\.3s \(goal verification\)/);
    assert.match(value, /Written from Wanigan's recorded evidence\.$/);
    await page.getByText(/The body is written from Wanigan's recorded evidence for the goal “Make checkout retries safe”\. Edit it before creating\./).waitFor();
    assert.match(await page.locator('.gt-notice').filter({ hasText: 'Open a pull request for' }).innerText(), /wanigan\/checkout-retry-a1b2/);
    await shoot('pr-dialog');
    record('create PR on a worktree opens the dialog for that branch with a body written from recorded evidence, and says so');
  }

  /* ── a goal's verify task ─────────────────────────────────────────── */
  await page.goto(rendererURL + '#goal=g1');
  await page.getByRole('heading', { name: 'Make checkout retries safe', exact: true }).waitFor();
  await page.locator('.control-steps [data-node-id="n3"]').click();
  await page.getByRole('heading', { name: 'Prove retries are safe', exact: true }).waitFor();
  if (before) {
    assert.equal(await page.locator('.rw-proof').count(), 0);
    await shoot('goal-verify');
    record('before: a verify task offers the review gate and nothing that runs a test before and after the change');
  } else {
    const proofRegion = page.getByRole('region', { name: 'Regression proof' });
    await proofRegion.getByText('proved: fails before, passes after').waitFor();
    const text = await noRawValues(proofRegion, 'the regression proof');
    assert.match(text, /The command exited 1 at the base commit and 0 at head\. The base checkout linked node_modules from the repository\./);
    assert.match(text, /Before \(base commit\) exit 1 · 1a2b3c4d · 8\.4s/);
    assert.equal(await proofRegion.getByRole('textbox', { name: 'Regression proof test command' }).inputValue(), 'npm test -- checkout.retry');
    await proofRegion.scrollIntoViewIfNeeded();
    await shoot('goal-verify');
    record('a verify task shows its saved test command and the last regression proof: proved, with both exit codes and durations');
  }

  assert.deepEqual(errors, []);
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({
    at: new Date().toISOString(),
    provenance: 'Actual Electron renderer from out/renderer of the checkout this script ran in; synthetic sessions, git and review services; no real agent calls',
    mode: before ? 'before' : 'after',
    // Read from the checkout that built out/renderer, when this script ran.
    commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(),
    uncommittedChanges: execFileSync('git', ['-C', root, 'status', '--porcelain', '--', 'src']).toString().trim().split('\n').filter(Boolean).length,
    checks, errors, shots,
  }, null, 2) + '\n');
} finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
