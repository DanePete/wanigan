#!/usr/bin/env node
// Helper sweep · P9 · second opinions. The code rail's billed actions under the
// review verdict, the consent dialog for a second review and for the decisions
// search, the findings the operator adjudicates, the decisions with their
// dropped count, an unreadable reply shown raw, confirmed findings joining the
// review message, and the ledger in Insights. Actual renderer, isolated
// Electron, synthetic sessions and services, no real agent calls. The
// main-process half — consent digests, the native confirmation, the read-only
// call through headless.ts, metering and the location checks — runs against a
// real repository and a stand-in CLI in src/main/smoke38.ts.
//
//   npm run build && node scripts/probe-helper-p9-opinions.mjs [--before] [--out dir]
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
  : path.join(root, 'docs/visuals/helper-p9-opinions', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });

const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-p9-opinions-'));
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
  // Taller than this Mac's screen allows a window to be: the code rail stacks
  // the notes tray, the verdict, the actions and the scopes above its file
  // list, and at 982 pixels the list's row is a sliver in every shot.
  await page.setViewportSize({ width: 1600, height: 1400 });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(STUB);
  await page.addInitScript(() => {
    localStorage.setItem('wanigan.code', '1'); localStorage.setItem('wanigan.composer', '1');
    const now = Date.now();
    const BASE = '1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d';
    const ANCHOR = "this session's changes against 1a2b3c4d, the commit it started from";
    const patches = {
      'src/checkout.test.ts': ['diff --git a/src/checkout.test.ts b/src/checkout.test.ts', '--- a/src/checkout.test.ts', '+++ b/src/checkout.test.ts',
        "@@ -8,5 +8,5 @@ describe('checkout', () => {", "   it('charges once', () => {", '-    expect(charges).toHaveLength(1);', '-    expect(total).toBe(42);',
        '+    expect(charges.length).toBeGreaterThan(0);', '   });', "-  it('retries', () => {", "+  it.skip('retries', () => {", ''].join('\n'),
      'src/checkout.ts': ['diff --git a/src/checkout.ts b/src/checkout.ts', '--- a/src/checkout.ts', '+++ b/src/checkout.ts', '@@ -1,4 +1,7 @@',
        '-export function checkout() {', '+export function checkout(key: string) {', '+  const existing = payments.get(key);', '+  if (existing) return existing;',
        '+  retryCheckout(key);', '   return payments.create();', ' }', ''].join('\n'),
      'package.json': ['diff --git a/package.json b/package.json', '--- a/package.json', '+++ b/package.json', '@@ -3,5 +3,6 @@', '   "dependencies": {',
        '-    "react": "^18.2.0"', '+    "react": "^19.0.0",', '+    "p-retry": "6.2.0"', '   }', ''].join('\n'),
    };
    const review = (state) => ({ state, stale: false, marked: state === 'unreviewed' ? null : state, note: null, markedAt: null });
    const f = (p, over) => Object.assign({ path: p, oldPath: null, status: 'M', added: 3, removed: 1, binary: false, contentHash: 'h' + p.length,
      preexisting: false, review: review('unreviewed'), attribution: 'edit-tool', attributionLabel: 'edited by an edit tool', tier: null, kind: 'other', alarms: [], image: false }, over);
    const files = [
      f('src/checkout.test.ts', { added: 2, removed: 3, kind: 'test' }),
      f('src/checkout.ts', { added: 4, removed: 1 }),
      f('package.json', { added: 2, removed: 1 }),
    ];
    const counts = { files: 3, approved: 0, rejected: 0, commented: 0, stale: 0, unreviewed: 3, added: 8, removed: 5, binary: 0 };
    const work = { sessionId: 's1', root: '/example/storefront', base: BASE, anchor: ANCHOR,
      turn: 'turn-ended', files, verdict: { needsReview: true, reason: 'unapproved-files', because: 'Its turn ended with 3 changed files, and 3 are not approved.', counts },
      label: 'Needs review · 0 of 3 files', hooksRecorded: true, shellDiffReported: false, tiersConfigured: false, highTierUnapproved: [],
      truncated: false, patchTruncated: false, unreadable: null, projectId: 'p1' };
    window.__writes = []; window.__started = []; window.__judged = []; window.__added = []; window.__previews = [];

    const profile = (id, label, vendor, harness, metering, refusal, sameBackend) => ({
      providerId: id, label, backendId: vendor.toLowerCase(), vendor, harness, fingerprint: 'fp-' + id,
      cap: harness === 'claude-code' ? { kind: 'usd', defaultUsd: 1, minUsd: 0.05, maxUsd: 20 } : { kind: 'timeout-only' },
      metering, installed: true, refusal, sameBackend,
    });
    const profiles = {
      review: [
        profile('claude', 'Claude Code', 'Anthropic', 'claude-code', 'priced', null, true),
        profile('codex', 'Codex', 'OpenAI', 'codex', 'unpriced', null, false),
        profile('glm', 'GLM · Z.ai', 'Z.ai', 'claude-code', 'unmetered', 'GLM · Z.ai returned no usage figures on its recorded second-opinion runs, so what it spends cannot be recorded. It is not offered.', false),
      ],
      decisions: [
        profile('claude', 'Claude Code', 'Anthropic', 'claude-code', 'priced', null, true),
        profile('codex', 'Codex', 'OpenAI', 'codex', 'unpriced', 'Your messages and plan stay with the backend that processed them. This session ran on anthropic; Codex is openai.', false),
      ],
    };
    const statements = (kind, p, usd) => ({
      vendor: `${p.vendor} receives it, through ${p.harness === 'codex' ? 'the Codex CLI' : 'the Claude Code CLI'} and the login this Mac uses for ${p.label}.`,
      cap: p.cap.kind === 'usd'
        ? `Claude Code stops itself at $${Number(usd ?? 1).toFixed(2)} (--max-budget-usd), and Wanigan stops it after 10 minutes.`
        : 'Codex has no spending cap Wanigan can set. Wanigan stops it after 10 minutes; what it spends before then is not capped.',
      nothingElse: p.harness === 'codex'
        ? 'Wanigan adds nothing from this session or repository. Codex runs in its read-only sandbox, which blocks writes but not reads, so its agent can still read files elsewhere on this Mac if it decides to. It loads your ~/.codex configuration, including any MCP servers named there.'
        : `No other file from this session or repository, no transcript${kind === 'decisions' ? ' beyond your messages' : ''}, no MCP server, and no tool: every tool Wanigan can name is denied. Claude Code adds its own system prompt and loads your user-level settings and instructions, as it does anywhere.`,
      environment: 'It runs in an empty scratch folder holding only this payload, removed when the call ends.',
      billed: `This is billed. Wanigan records the cost the CLI reports and never estimates one.${p.metering === 'unpriced' ? ` ${p.label} has reported tokens but no price before, so this run is likely to read "unpriced".` : ''}`,
    });
    const argv = (p, usd) => p.harness === 'codex'
      ? ['codex', 'exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--cd', '<scratch folder>', '--output-schema', '<scratch folder>/reply-schema.json', '--output-last-message', '<scratch folder>/reply.txt', '<the payload described above>']
      : ['claude', '-p', '<the payload described above>', '--output-format', 'json', '--disallowedTools', 'Read,Glob,Grep,LS,NotebookRead,LSP,Bash,PowerShell,REPL,Write,Edit,MultiEdit,NotebookEdit,Task,Agent,Workflow,Skill,SlashCommand,ToolSearch,Monitor,WebFetch,WebSearch,Artifact,SendMessage,SendFile', '--strict-mcp-config', '--json-schema', '<the reply schema>', '--no-session-persistence', '--disable-slash-commands', '--max-budget-usd', Number(usd ?? 1).toFixed(2)];

    const finding = (id, file, s, e, severity, title, body, confidence, located, adjudication = 'unjudged') =>
      ({ id, file, lineStart: s, lineEnd: e, severity, title, body, confidence, adjudication, located });
    const runs = [
      { id: 'op-review', kind: 'review', sessionId: 's1', providerId: 'codex', profileLabel: 'Codex', vendor: 'OpenAI', headlessRunId: 'run_a', status: 'done',
        verdict: 'needs-attention', reason: null, raw: null, error: null, diffSha256: 'e'.repeat(64), diffBytes: 4301, sentBytes: 4301, truncated: false, baseCommit: BASE,
        costUsd: 0, costReported: false, costText: 'unpriced', inTokens: 6120, outTokens: 840, maxBudgetUsd: null, timeoutMs: 600000, structuredFlag: 'output-schema',
        createdAt: now - 180_000, endedAt: now - 120_000, findingsOmitted: 0, decisions: [], dropped: 0, unrealTouches: 0,
        findings: [
          finding('f1', 'src/checkout.ts', 2, 3, 'high', 'Returns a stored payment without checking the amount', 'A retry with a different cart total gets the first payment back. Compare the amount before returning it.', 0.82, 'lines-in-diff'),
          finding('f2', 'src/checkout.test.ts', 11, 11, 'medium', 'The retry test is skipped, not fixed', 'it.skip hides the retry case the change is about.', 0.9, 'lines-in-diff'),
          finding('f3', 'src/payments/ledger.ts', 40, 44, 'low', 'Ledger writes may not be idempotent', 'Not in this diff; the reviewer is guessing at code it was not sent.', 0.35, 'not-in-diff'),
        ] },
      { id: 'op-decisions', kind: 'decisions', sessionId: 's1', providerId: 'claude', profileLabel: 'Claude Code', vendor: 'Anthropic', headlessRunId: 'run_b', status: 'done',
        verdict: null, reason: null, raw: null, error: null, diffSha256: 'e'.repeat(64), diffBytes: 4301, sentBytes: 4301, truncated: false, baseCommit: BASE,
        costUsd: 0.0384, costReported: true, costText: '$0.04', inTokens: 7400, outTokens: 520, maxBudgetUsd: 1, timeoutMs: 600000, structuredFlag: 'json-schema',
        createdAt: now - 90_000, endedAt: now - 60_000, findingsOmitted: 0, findings: [], dropped: 2, unrealTouches: 1,
        decisions: [
          { id: 'd1', decision: 'Adds p-retry instead of the existing backoff helper', whyItMatters: 'A new runtime dependency for something the codebase already does; nobody asked for a library.', risk: 'medium',
            touches: [{ file: 'package.json', lineStart: 5, lineEnd: 5, raw: 'package.json:5' }], unrealTouches: 1 },
          { id: 'd2', decision: 'Skips the retry test rather than fixing it', whyItMatters: 'The one test that exercises the retry path no longer runs.', risk: 'high',
            touches: [{ file: 'src/checkout.test.ts', lineStart: 11, lineEnd: 11, raw: 'src/checkout.test.ts:11' }], unrealTouches: 0 },
        ] },
      { id: 'op-unreadable', kind: 'review', sessionId: 's1', providerId: 'glm', profileLabel: 'GLM · Z.ai', vendor: 'Z.ai', headlessRunId: 'run_c', status: 'unreadable',
        verdict: null, reason: 'The reply holds no JSON object.', raw: 'I reviewed the diff and it looks mostly fine, though the retry logic could be tighter and the test change deserves a second look.',
        error: null, diffSha256: 'e'.repeat(64), diffBytes: 4301, sentBytes: 4301, truncated: false, baseCommit: BASE,
        costUsd: 0.021, costReported: true, costText: '$0.02 as the CLI priced it (not this backend\'s bill)', inTokens: 5900, outTokens: 60, maxBudgetUsd: 1, timeoutMs: 600000,
        structuredFlag: 'json-schema', createdAt: now - 3_600_000, endedAt: now - 3_590_000, findings: [], findingsOmitted: 0, decisions: [], dropped: 0, unrealTouches: 0 },
    ];
    let visibleRuns = [];
    const ledgerOf = () => {
      const rows = visibleRuns.map((r) => ({ id: r.id, kind: r.kind, sessionId: 's1', sessionLabel: 'Checkout bug', providerId: r.providerId, profileLabel: r.profileLabel,
        status: r.status, costText: r.costText, costUsd: r.costUsd, costReported: r.costReported,
        confirmed: r.findings.filter((x) => x.adjudication === 'confirmed').length, refuted: r.findings.filter((x) => x.adjudication === 'refuted').length,
        unsure: r.findings.filter((x) => x.adjudication === 'unsure').length, unjudged: r.findings.filter((x) => x.adjudication === 'unjudged').length,
        kept: r.decisions.length, dropped: r.dropped, createdAt: r.createdAt }));
      const priced = rows.filter((r) => r.costReported);
      return { rows, pricedUsd: priced.reduce((n, r) => n + r.costUsd, 0), pricedRuns: priced.length, unpricedRuns: rows.length - priced.length };
    };

    const api = window.wanigan;
    const override = (service, methods) => new Proxy(api[service], { get(obj, key) { return key in methods ? methods[key] : obj[key]; } });
    const services = {
      code: override('code', {
        changes: async () => ({ isRepo: true, branch: 'wanigan/checkout-retry-a1b2', headMoved: false, commits: 0, attributed: true, unreadable: null,
          files: files.map((x) => ({ path: x.path, index: ' ', work: 'M', staged: false, untracked: false, preexisting: false })) }),
        diff: async (_root, file) => patches[file] ?? '',
        editors: async () => [],
      }),
      sessions: override('sessions', {
        list: async () => (await api.sessions.list()).map((x) => ({ ...x, capabilities: { hooks: true } })),
        baseline: async () => ({ head: BASE, dirty: [], at: now - 900_000 }),
        scrollback: async () => 'Wanigan renderer fixture — no live provider\r\n\r\n> Make checkout retries safe.\r\n',
        write: async (...args) => { window.__writes.push(args); },
      }),
      checkpoints: override('checkpoints', { list: async () => [] }),
      reviewWork: {
        work: async () => work,
        summaries: async () => ({}),
        setMark: async () => review('approved'),
        fileDiff: async (_s, file) => patches[file] ?? '',
        patch: async () => ({ patch: Object.values(patches).join(''), truncated: false }),
        turnStats: async () => ({}),
        dependencies: async () => ({ hooksRecorded: true, installs: [], manifests: [] }),
        claims: async () => ({ state: 'no-message', reason: 'No assistant message was found in this session\'s transcript.' }),
      },
      opinions: {
        profiles: async (_s, kind) => profiles[kind],
        preview: async ({ kind, providerId, maxBudgetUsd }) => {
          window.__previews.push([kind, providerId, maxBudgetUsd]);
          const p = profiles[kind].find((x) => x.providerId === providerId);
          return { kind, sessionId: 's1', profile: p, digest: `digest-${kind}-${providerId}-${maxBudgetUsd}`, diffSha256: 'e'.repeat(64),
            sends: { anchor: ANCHOR, diffBytes: 4301, sentBytes: 4301, capBytes: 98304, truncated: false, files: 3, filesListed: 3, preexistingLeftOut: 1,
              checks: ['A retried checkout charges once.'], checksOmitted: 0, reviewRules: null,
              messages: kind === 'decisions' ? { sent: 3, omitted: 0, chars: 412 } : null, goal: { title: 'Make checkout retries safe', planItems: 4 } },
            timeoutMs: 600000, statements: statements(kind, p, maxBudgetUsd), argv: argv(p, maxBudgetUsd), refusal: p.refusal };
        },
        start: async (input) => { window.__started.push(input); visibleRuns = runs; return { runId: 'op-review' }; },
        runs: async () => visibleRuns,
        adjudicate: async (id, verdict) => {
          window.__judged.push([id, verdict]);
          for (const r of runs) for (const x of r.findings) if (x.id === id) x.adjudication = verdict;
          return { id, adjudication: verdict };
        },
        decisionAdded: async (id) => { window.__added.push(id); return true; },
        ledger: async () => ledgerOf(),
      },
    };
    window.wanigan = new Proxy(api, { get(target, service) { return service in services ? services[service] : target[service]; } });
  });

  // A full-window shot, and — when a locator is given — the code rail (or the
  // element, off the Sessions view) at full resolution as well: the rail is a
  // few hundred pixels wide, and its text is hard to read in a whole window.
  const shoot = async (name, locator) => {
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      await page.waitForTimeout(150);
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      // No scrollIntoView: it scrolls every ancestor, the app shell included,
      // and the shot then shows a layout no operator ever sees.
      if (locator) await locator.waitFor();
      // The panel's own scroll area only, back to its first line: the clicks
      // that judged the findings left it scrolled to the last one.
      await page.evaluate(() => document.querySelectorAll('.so-panel-body').forEach((el) => { el.scrollTop = 0; }));
      const file = path.join(out, `${name}-${theme}.png`);
      await page.screenshot({ path: file, scale: 'css' });
      shots.push({ file: path.relative(root, file), theme, bodyBackground: bg });
      if (locator) {
        // The rail itself, not the element: the section sits inside the rail's
        // own scroll area, and an element shot outside that clip paints
        // whatever happens to be at those page coordinates.
        const detail = path.join(out, `${name}-detail-${theme}.png`);
        const rail = page.locator('.code-panel:visible').first();
        await ((await rail.count()) ? rail : locator).screenshot({ path: detail, scale: 'css' });
        shots.push({ file: path.relative(root, detail), theme, bodyBackground: bg, element: true });
      }
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
  // The stub opens on the Codex session; the fixture's review belongs to the
  // Claude Code session on storefront, so open that one first.
  await page.locator('.sessions-view').getByText('Claude Code', { exact: true }).first().click();
  await page.getByRole('heading', { name: 'storefront' }).first().waitFor();
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  await page.locator('.code-panel').waitFor();
  const summary = page.getByRole('region', { name: 'Review of this session' });
  await summary.getByText('Needs review · 0 of 3 files').waitFor();
  await page.locator('.code-file').filter({ hasText: 'src/checkout.ts' }).first().click();
  await page.locator('pre.diff').waitFor();

  if (before) {
    assert.equal(await page.locator('.so-actions').count(), 0, 'the base build has no second-opinion actions');
    assert.equal(await page.getByRole('button', { name: 'Get a second review…' }).count(), 0);
    await shoot('code-rail');
    record('before: the code rail shows the review verdict and Send review, with no way to ask a second model and no record of one');
  } else {
    const actions = page.getByRole('group', { name: 'Second opinions' });
    await actions.waitFor();
    const actionText = await noRawValues(actions, 'the second-opinion actions');
    assert.match(actionText, /Second opinions · billed, per run/);
    await notClipped(actions, 'the second-opinion actions row');
    assert.match(actionText, /Results · 0/);
    assert.equal(await page.getByRole('region', { name: 'Second opinions results' }).count(), 0, 'no results panel until one is asked for');
    await shoot('code-rail');
    await actions.getByRole('button', { name: 'Results · 0', exact: true }).click();
    const section = page.getByRole('region', { name: 'Second opinions results' });
    await section.getByText('none yet').waitFor();
    assert.match(await section.innerText(), /runs only when you start one from the bar above/);
    await section.getByRole('button', { name: 'Close', exact: true }).click();
    await section.waitFor({ state: 'detached' });
    record('under the verdict, "Get a second review…", "Find unrequested decisions…" and "Results · 0" sit in a row that says they are billed per run; the results panel says none has run and closes');

    /* ── consent: a second review ──────────────────────────────────── */
    await actions.getByRole('button', { name: 'Get a second review…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Get a second review' });
    await dialog.getByText('Exactly what is sent').waitFor();
    let text = await noRawValues(dialog, 'the review consent dialog');
    assert.match(text, /The diff against its base commit: 4\.2 KB, whole \(the cap is 96 KB\)\./);
    assert.match(text, /The list of 3 changed files; 1 file you had already changed before the session is left out\./);
    assert.match(text, /The goal “Make checkout retries safe”: 1 acceptance check\./);
    assert.match(text, /Scoped code review rules: none — this build has no collector for them, so none are sent\./);
    assert.match(text, /Nothing else\. No other file from this session or repository, no transcript, no MCP server, and no tool/);
    assert.match(text, /Anthropic receives it/);
    assert.match(text, /Claude Code stops itself at \$1\.00 \(--max-budget-usd\)/);
    assert.match(text, /This is billed\./);
    assert.equal(await dialog.getByRole('spinbutton', { name: 'Dollar cap' }).inputValue(), '1.00');
    await shoot('consent-review');
    record('the review dialog names the reviewer and vendor, exactly what is sent with its size and cap, that nothing else is, the dollar cap, and "This is billed."');

    await dialog.getByRole('spinbutton', { name: 'Dollar cap' }).fill('0.50');
    await dialog.getByText('Claude Code stops itself at $0.50 (--max-budget-usd)').waitFor();
    record('changing the dollar cap re-reads the preview, so the statement and the digest follow the number typed');

    await dialog.getByRole('combobox', { name: 'Reviewer profile' }).selectOption('codex');
    await dialog.getByText('Codex has no spending cap Wanigan can set.', { exact: false }).waitFor();
    text = await noRawValues(dialog, 'the Codex consent dialog');
    assert.match(text, /OpenAI receives it/);
    assert.match(text, /blocks writes but not reads/);
    assert.equal(await dialog.getByRole('spinbutton', { name: 'Dollar cap' }).count(), 0, 'no cap field for a harness that has no cap');
    await shoot('consent-review-codex');
    record('picking the other vendor says OpenAI receives it, that Codex has no hard cap and a 10-minute timeout applies, and what its sandbox does not stop');

    await dialog.getByRole('combobox', { name: 'Reviewer profile' }).selectOption('glm');
    await dialog.getByText(/returned no usage figures/).first().waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Run billed review…' }).isDisabled(), true);
    record('an unmetered profile is refused by name, and the run button is disabled');

    await dialog.getByRole('combobox', { name: 'Reviewer profile' }).selectOption('codex');
    await dialog.getByText('Codex has no spending cap Wanigan can set.', { exact: false }).waitFor();
    await dialog.getByRole('button', { name: 'Run billed review…', exact: true }).click();
    await page.waitForFunction(() => window.__started.length === 1);
    const started = (await page.evaluate(() => window.__started))[0];
    assert.equal(started.digest, 'digest-review-codex-null');
    assert.equal(started.fingerprint, 'fp-codex');
    assert.equal(started.providerId, 'codex');
    await dialog.waitFor({ state: 'detached' });
    record('Run billed review sends the previewed digest and the profile fingerprint to main, which asks again before anything is sent');

    /* ── findings ──────────────────────────────────────────────────── */
    await section.getByText('3 runs', { exact: false }).waitFor();
    assert.equal(await actions.getByRole('button', { name: 'Results · 3', exact: true }).getAttribute('aria-pressed'), 'true', 'starting a run opens the results panel');
    const findings = section.locator('.so-finding');
    await findings.first().waitFor();
    text = await noRawValues(section, 'the second-opinion section');
    assert.match(text, /needs attention 3 findings from Codex\. They are candidates until you judge them\./);
    assert.match(text, /Sent 4\.2 KB to OpenAI · unpriced · 6,120 tokens in, 840 out/);
    assert.match(text, /file not in this diff/);
    const verdict = (i) => findings.nth(i).getByRole('group', { name: /^Your verdict on/ });
    await verdict(0).getByRole('button', { name: 'Confirmed', exact: true }).click();
    await verdict(1).getByRole('button', { name: 'Refuted', exact: true }).click();
    await verdict(2).getByRole('button', { name: 'Not sure', exact: true }).click();
    await page.waitForFunction(() => window.__judged.length === 3);
    await section.getByRole('button', { name: 'Add 1 confirmed to review notes', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__judged), [['f1', 'confirmed'], ['f2', 'refuted'], ['f3', 'unsure']]);
    assert.equal(await verdict(0).getByRole('button', { name: 'Confirmed', exact: true }).getAttribute('aria-pressed'), 'true');
    record('each finding shows severity, confidence, its location and whether that location is in the diff, and is marked Confirmed, Refuted or Not sure');

    await section.getByRole('button', { name: 'Add 1 confirmed to review notes', exact: true }).click();
    const tray = page.getByRole('region', { name: 'Review notes' });
    await tray.getByText('1 review note').waitFor();
    assert.match(await tray.innerText(), /src\/checkout\.ts, lines 2–3: Returns a stored payment without checking the amount/);
    await section.getByText(/Added 1 confirmed finding to the review notes above\./).waitFor();
    await shoot('findings', section);
    record('adding confirmed findings puts one anchored note per finding into the review notes tray, and says Send review puts them in the message box');

    /* ── decisions ─────────────────────────────────────────────────── */
    await section.getByRole('combobox', { name: 'Showing' }).selectOption('op-decisions');
    await section.getByText("2 entries cited code that isn't in the diff and were dropped.").waitFor();
    text = await noRawValues(section, 'the decisions result');
    assert.match(text, /2 decisions nobody asked for, from Claude Code; every location below is in the diff\./);
    assert.match(text, /package\.json:5 1 cited location not in the diff removed/);
    assert.match(text, /Sent 4\.2 KB to Anthropic · \$0\.04/);
    await section.locator('.so-finding').nth(1).getByRole('button', { name: 'Add to review notes', exact: true }).click();
    await tray.getByText('2 review notes').waitFor();
    assert.deepEqual(await page.evaluate(() => window.__added), ['d2']);
    await section.locator('.so-finding').nth(1).getByRole('button', { name: 'Added to review notes', exact: true }).waitFor();
    await shoot('decisions', section);
    record('decisions show risk, the checked locations, how many were dropped for citing code not in the diff, and add to the review notes one at a time');

    /* ── an unreadable reply ───────────────────────────────────────── */
    await section.getByRole('combobox', { name: 'Showing' }).selectOption('op-unreadable');
    await section.getByText('Could not read findings: The reply holds no JSON object.').waitFor();
    assert.match(await section.locator('.so-raw').innerText(), /looks mostly fine/);
    await shoot('unreadable', section);
    record('a reply that could not be read says "Could not read findings" with the reason, and shows the reply as it came');

    const ledger = section.locator('.so-ledger');
    text = await noRawValues(ledger, 'the session ledger');
    assert.match(text, /Second review · Codex unpriced 1 confirmed · 1 refuted · 1 not sure/);
    assert.match(text, /Decisions · Claude Code \$0\.04 2 kept · 2 dropped/);
    assert.match(text, /\$0\.06 recorded across 2 priced runs · 1 run with no recorded price, not counted/);
    await notClipped(ledger, 'the session ledger list');
    record('the session ledger lists both kinds with reviewer, cost or unpriced, confirmed/refuted/not sure, kept/dropped, and totals only recorded dollars');

    /* ── the review message ────────────────────────────────────────── */
    await summary.getByRole('button', { name: 'Send review', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="Message the agent"]')?.value.includes('Review of this session'));
    const message = await page.getByRole('textbox', { name: 'Message the agent', exact: true }).inputValue();
    assert.match(message, /1\. `src\/checkout\.ts`, lines 2–3:\n {3}```diff\n {3}\+ {2}const existing = payments\.get\(key\);\n {3}\+ {2}if \(existing\) return existing;\n {3}```\n {3}Returns a stored payment without checking the amount \(high\)/);
    assert.match(message, /— second review by Codex, confirmed by the operator\./);
    assert.match(message, /2\. `src\/checkout\.test\.ts`, line 11:[\s\S]*A decision nobody asked for \(high risk\): Skips the retry test rather than fixing it/);
    assert.doesNotMatch(message, /The retry test is skipped, not fixed/, 'a refuted finding is not in the message');
    assert.deepEqual(await page.evaluate(() => window.__writes), [], 'nothing was typed into the terminal');
    record('Send review puts the confirmed finding, cited "second review by Codex", and the added decision into the message box, and sends nothing');

    /* ── consent: decisions, same backend only ─────────────────────── */
    await actions.getByRole('button', { name: 'Find unrequested decisions…', exact: true }).click();
    const dDialog = page.getByRole('dialog', { name: 'Find decisions nobody asked for' });
    await dDialog.getByText('Exactly what is sent').waitFor();
    text = await noRawValues(dDialog, 'the decisions consent dialog');
    assert.match(text, /Your 3 messages in this session \(412 characters\)\./);
    assert.match(text, /its objective and 4 plan items/);
    assert.match(text, /the backend this session ran on/);
    assert.match(text, /no transcript beyond your messages, no MCP server/);
    await shoot('consent-decisions');
    await dDialog.getByRole('combobox', { name: 'Profile (same backend only)' }).selectOption('codex');
    await dDialog.getByText(/stay with the backend that processed them/).first().waitFor();
    assert.equal(await dDialog.getByRole('button', { name: 'Run billed search…' }).isDisabled(), true);
    record('the decisions dialog counts the messages and plan items it sends, marks the same backend, and refuses another backend with the reason');
    await dDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  }

  /* ── Insights · Spending ─────────────────────────────────────────── */
  await page.keyboard.press('Meta+5');
  await page.locator('.insights').waitFor();
  const spending = page.locator('#ins-report-spending');
  await spending.waitFor();
  if (before) {
    assert.equal(await page.locator('.so-spend').count(), 0);
    await page.locator('.ins-report-content').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await shoot('insights-spending', page.locator('.ins-report:visible').last());
    record('before: the Spending report has no record of second opinions');
  } else {
    const card = page.getByRole('region', { name: 'Second opinions ledger' });
    await card.getByText('Checkout bug').first().waitFor();
    const cardText = await noRawValues(card, 'the Spend ledger card');
    assert.match(cardText, /Observed counts only\./);
    assert.match(cardText, /Second review Checkout bug Codex unpriced/);
    await notClipped(card.locator('.so-table-wrap'), 'the Spend ledger table');
    await shoot('insights-spending', card);
    record('the Spending report carries a Second opinions card: every run with its session, reviewer, cost or unpriced, and what came of it');
  }

  assert.deepEqual(errors, []);
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({
    at: new Date().toISOString(),
    provenance: 'Actual Electron renderer from out/renderer of the checkout this script ran in; synthetic sessions, review and second-opinion services; no real agent calls',
    mode: before ? 'before' : 'after',
    commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(),
    uncommittedChanges: execFileSync('git', ['-C', root, 'status', '--porcelain', '--', 'src']).toString().trim().split('\n').filter(Boolean).length,
    checks, errors, shots,
  }, null, 2) + '\n');
} finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
