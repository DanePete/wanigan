#!/usr/bin/env node
// Observed telemetry: limits read from sessions' status lines on Usage, the
// per-prompt trace waterfall and prompt cache readout on a session's Timeline,
// and spend by source on Insights. Actual renderer, isolated Electron,
// synthetic readings, spans and spend, no real agent calls. The main-process
// half — the relay and its bearer, span sanitising, retention and attribution —
// runs against the real listener and collector in src/main/smoke18.ts; this
// probe covers what a reader sees, including every failure and absence.
//
//   npm run build && node scripts/probe-observed-telemetry.mjs [--before] [--out dir]
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), { _electron } = require('playwright-core');
const root = path.resolve(import.meta.dirname, '..'), before = process.argv.includes('--before');
const outArg = process.argv.indexOf('--out');
const out = outArg >= 0 ? path.resolve(process.argv[outArg + 1])
  : path.join(root, 'docs/visuals/observed-telemetry', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-observed-probe-'));
writeFileSync(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({
  executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [path.join(dir, 'main.cjs'), `--user-data-dir=${dir}/profile`], env,
});
const checks = [], errors = [];
const record = (text) => { checks.push(text); console.log('✓', text); };
const squash = (s) => s.replace(/\s+/g, ' ').trim();
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(STUB);
  await page.addInitScript(() => {
    const original = window.wanigan, now = Date.now(), MIN = 60_000;
    window.__observed = 'full'; window.__sources = 'full'; window.__calls = [];
    // The session rail open, as an operator who has used it before leaves it.
    // about:blank runs this too, and has no storage to write.
    try { localStorage.setItem('wanigan.code', '1'); } catch { /* opaque origin */ }

    /* Usage · what two accounts' status lines reported. */
    const reset5 = now + 110 * MIN;
    const observed = (mode) => ({
      at: now, relayEnabled: mode !== 'relay-off', hooksEnabled: true, unsupported: null,
      accounts: mode === 'relay-off' ? [] : [
        { accountId: 'a1', accountLabel: 'Personal', harness: 'claude-code', readings: 38, latestAt: now - 4 * MIN, cliVersion: '2.1.270',
          windows: [
            { kind: 'five_hour', usedPercent: 62, resetsAt: reset5, observedAt: now - 4 * MIN, readings: 21,
              forecast: { state: 'reaches', at: now + 70 * MIN, perHour: 33, resetsAt: reset5 },
              jumps: [{ fromPercent: 38, toPercent: 51, fromAt: now - 26 * MIN, toAt: now - 22 * MIN }] },
            { kind: 'seven_day', usedPercent: 41, resetsAt: now + 3 * 86_400_000, observedAt: now - 4 * MIN, readings: 1,
              forecast: { state: 'insufficient', samples: 1, spanMs: 0 }, jumps: [] },
          ] },
        { accountId: 'a2', accountLabel: 'Work', harness: 'claude-code', readings: 6, latestAt: now - 12 * MIN, cliVersion: '2.1.270', windows: [] },
      ],
    });

    /* Timeline · three turns: a whole trace, none, and one killed mid-flight. */
    const T1 = now - 19 * MIN, T2 = now - 11 * MIN, T3 = now - 3 * MIN;
    const ev = (id, event, at, over = {}) => Object.assign(
      { id, sessionId: 's1', at, event, toolName: null, summary: null, durationMs: null, ok: null, paths: [] }, over);
    const events = [
      ev(12, 'Stop', T3 + 32_000),
      ev(11, 'PostToolUse', T3 + 21_000, { toolName: 'Bash', summary: 'npm test', durationMs: 16_200, ok: 1 }),
      ev(10, 'PreToolUse', T3 + 4_800, { toolName: 'Bash', summary: 'npm test' }),
      ev(9, 'UserPromptSubmit', T3),
      ev(8, 'Stop', T2 + 40_000),
      ev(7, 'PostToolUse', T2 + 20_000, { toolName: 'Edit', summary: 'src/cart.ts', durationMs: 900, ok: 1 }),
      ev(6, 'UserPromptSubmit', T2),
      ev(5, 'PostToolUse', T1 + 12_000, { toolName: 'Read', summary: 'README.md', durationMs: 300, ok: 1 }),
      ev(4, 'UserPromptSubmit', T1),
      ev(3, 'SessionStart', T1 - MIN),
    ];
    const row = (spanId, kind, label, depth, offsetMs, durationMs, facts = [], extra = {}) => Object.assign(
      { spanId, kind, label, depth, offsetMs, durationMs, incomplete: null, error: false, facts, agentId: null }, extra);
    const traces = {
      sessionId: 's1', requested: true, enabledNow: true, spans: 7, capped: false,
      interactions: [
        { traceId: 'b'.repeat(32), startAt: T1 + 200, endAt: null, durationMs: null, rootMissing: true, incomplete: true, sequence: null,
          totals: { llmMs: 3_400, toolMs: 0, blockedMs: 0 },
          rows: [
            row('b1', 'llm_request', 'claude-opus-5', 0, 0, 3_400, ['first token 910ms', 'stop tool_use'],
              { incomplete: 'the prompt’s interaction span was not recorded' }),
            row('b2', 'tool', 'Read', 0, 3_600, null, [], { incomplete: 'no end time was exported' }),
          ] },
        { traceId: 'a'.repeat(32), startAt: T3 + 150, endAt: T3 + 31_800, durationMs: 31_650, rootMissing: false, incomplete: false, sequence: 3,
          totals: { llmMs: 14_700, toolMs: 16_200, blockedMs: 11_300 },
          rows: [
            row('a1', 'llm_request', 'claude-opus-5', 0, 120, 4_300, ['first token 820ms', 'stop tool_use', '12,400 in · 310 out', '11,900 cached']),
            row('a2', 'tool', 'Bash', 0, 4_600, 16_200, ['40 result tokens']),
            row('a3', 'blocked', 'waiting on you', 1, 4_700, 11_300, ['you chose allow (user_temporary)']),
            row('a4', 'execution', 'running', 1, 16_100, 4_600, []),
            row('a5', 'llm_request', 'claude-opus-5', 0, 21_000, 10_400, ['first token 1210ms', 'attempt 2', 'stop end_turn', '12,900 in · 640 out']),
          ] },
      ],
    };
    const statusLine = {
      sessionId: 's1', readings: 14, observedAt: now - 2 * MIN, lastSeenAt: now - 20_000, cliVersion: '2.1.270', effort: 'xhigh', pr: null,
      cache: { warm: true, cachingObserved: true, ttl: '1h', expiresAt: now + 48 * MIN, requests: 23, misses: 2, expectedRebuilds: 1,
        hitRatio: 0.91, cacheWriteTokens: 88_000, missRecacheTokens: 41_000, lastMissAt: now - 9 * MIN,
        lastMissCauses: ['tools_changed'], missCauses: [{ cause: 'tools_changed', count: 1 }, { cause: 'ttl_expired_5m', count: 1 }],
        recacheTokensIfCold: 64_000 },
    };

    /* Insights · every dimension adds back to the same $18.42 and the same token totals. */
    const g = (key, costUsd, inTokens, outTokens, cacheReadTokens, unverifiedUsd = 0) =>
      ({ key, costUsd, unverifiedUsd, inTokens, outTokens, cacheReadTokens, cacheWriteTokens: 0 });
    const sources = (days, empty) => ({
      days, since: now - days * 86_400_000, rows: empty ? 0 : 42,
      totals: empty ? g('', 0, 0, 0, 0) : { costUsd: 18.42, unverifiedUsd: 1.1, inTokens: 912_000, outTokens: 61_200, cacheReadTokens: 7_400_000, cacheWriteTokens: 0 },
      groups: empty ? { source: [], skill: [], plugin: [], mcp: [], agent: [] } : {
        source: [g('main', 12.9, 610_000, 44_000, 5_200_000), g('subagent', 4.8, 250_000, 15_800, 2_000_000, 1.1),
          g('auxiliary', 0.61, 52_000, 1_400, 200_000), g('', 0.11, 0, 0, 0)],
        skill: [g('', 15.2, 800_000, 52_000, 6_600_000, 1.1), g('third-party', 2.1, 80_000, 6_000, 600_000), g('release-notes', 1.12, 32_000, 3_200, 200_000)],
        plugin: [g('', 16.3, 832_000, 55_200, 6_800_000, 1.1), g('third-party', 2.12, 80_000, 6_000, 600_000)],
        mcp: [g('', 17.1, 880_000, 58_000, 7_100_000, 1.1), g('custom', 1.32, 32_000, 3_200, 300_000)],
        agent: [g('', 13.62, 662_000, 45_400, 5_400_000), g('custom', 3.2, 170_000, 10_200, 1_300_000, 1.1), g('Explore', 1.6, 80_000, 5_600, 700_000)],
      },
    });

    const wrap = (target, overrides) => new Proxy(target, { get(t, method) { return overrides[method] ?? t[method]; } });
    window.wanigan = new Proxy(original, { get(api, service) {
      if (service === 'usage') return wrap(api.usage, {
        observed: async () => {
          window.__calls.push('observed');
          if (window.__observed === 'fail') throw new Error('Fixture: the observations table could not be read');
          return observed(window.__observed);
        },
        // Only the Claude session has a trace or a status line; asking for
        // another session's gets that session's honest nothing.
        traces: async (id) => {
          window.__calls.push(['traces', id]);
          return id === 's1' ? traces : { sessionId: id, requested: false, enabledNow: true, spans: 0, capped: false, interactions: [] };
        },
        statusLine: async (id) => { window.__calls.push(['statusLine', id]); return id === 's1' ? statusLine : null; },
      });
      if (service === 'events') return wrap(api.events, {
        session: async () => events,
        live: async () => ({ tool: null, since: now - MIN, blocked: false, lastAt: now - 20_000 }),
      });
      if (service === 'spend') return wrap(api.spend, {
        sources: async (days) => {
          window.__calls.push(['sources', days]);
          if (window.__sources === 'fail') throw new Error('Fixture: spend by source could not be read');
          return sources(days, window.__sources === 'empty');
        },
      });
      return api[service];
    } });
  });

  await page.goto(rendererURL); await page.locator('.mission-room').waitFor();
  const go = async (key) => {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press(key);
  };
  const palette = async (words) => {
    await go('Meta+k'); await page.getByRole('dialog').waitFor();
    await page.keyboard.type(words); await page.keyboard.press('Enter');
  };
  // Both halves of a theme, as theme-boot.ts writes them: the attribute alone
  // leaves native controls drawn in the other scheme.
  const shoot = async (name) => {
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t; document.documentElement.style.colorScheme = t;
        window.dispatchEvent(new CustomEvent('wanigan:theme-changed', { detail: { preference: t, resolved: t } }));
      }, theme);
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(out, `${name}-${theme}.png`), scale: 'css', animations: 'disabled' });
    }
  };
  const readable = async (locator, what) => {
    const fits = await locator.evaluateAll((els) => els.map((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, text: el.innerText.slice(0, 60) })));
    assert(fits.length > 0, `${what}: nothing to measure`);
    for (const f of fits) assert(f.scroll <= f.client + 1, `${what} is clipped: ${JSON.stringify(f)}`);
  };

  /* ── Usage ─────────────────────────────────────────────────────────── */
  await palette('What is left on each account');
  await page.getByRole('heading', { name: 'Usage', exact: true }).waitFor();
  await page.locator(before ? '.u-limit' : '.u-comparison').first().waitFor();
  if (before) {
    await page.waitForTimeout(600);
    assert.equal(await page.locator('.u-observed').count(), 0, 'the pre-change build has no observed limits');
    await shoot('usage');
    record('before: Usage shows the /usage probe card and nothing a running session’s status line reported');
  } else {
    const observations = page.locator('.u-details');
    assert.equal(await observations.getAttribute('open'), null, 'historical observations start collapsed');
    await observations.locator('summary').click();
    const personal = page.getByRole('region', { name: 'Observed limits · Personal' });
    await personal.getByText(/reaches 100% ≈/).waitFor();
    const text = squash(await personal.innerText());
    assert.match(text, /Observed · status line 38 readings · CLI 2\.1\.270/);
    // A time not today carries its weekday ("Tue 00:29"), which a run near
    // midnight produces for the five-hour reset.
    const at = String.raw`(?:[A-Z][a-z]{2} )?\d{1,2}:\d{2}(?: [AP]M)?`;
    assert.match(text, new RegExp(String.raw`5-hour window 62% used Observed from a live session’s status line, 4m ago · resets ${at} \(observed\)`));
    assert.match(text, new RegExp(String.raw`At the last 30 minutes' observed rate, reaches 100% ≈ ${at}; resets ${at} \(observed\)\.`));
    assert.match(text, /▲ ?sudden jump 38% → 51% between readings at/);
    assert.match(text, /7-day window 41% used .*Not enough observations to forecast: one reading in the last 30 minutes, and a forecast needs 2\./);
    assert(!/\bundefined\b|\bNaN\b|\[object /.test(text), 'no raw value reaches the screen');
    await readable(personal.locator('.u-ow-line'), 'an observed limits line');
    record('Usage states each observed window with its provenance and age, forecasts the five-hour window from its readings, flags the jump, and refuses to forecast the seven-day window from one reading');
    const probeCard = page.locator('.u-comparison');
    const [cardBox, observedBox] = [await probeCard.boundingBox(), await personal.boundingBox()];
    assert(cardBox && observedBox && observedBox.y >= cardBox.y + cardBox.height - 1, 'historical observations sit below the current account comparison');
    record('historical observations start collapsed and remain separate from current provider checks');
    await personal.scrollIntoViewIfNeeded();
    await shoot('usage-observed');

    await page.getByRole('button', { name: 'Show local records for Work, Claude Code', exact: true }).click();
    const work = page.getByRole('region', { name: 'Observed limits · Work' });
    await work.getByText(/carried no limit windows/).waitFor();
    assert.match(squash(await work.innerText()), /An API-key login has none, and a subscription reports them only after a session’s first response\. Nothing is estimated in their place\./);
    assert.equal(await work.locator('.u-ow').count(), 0, 'no window is drawn for an account that reported none');
    record('an account whose status lines carried no windows says so, draws no meter and estimates nothing');
    await shoot('usage-no-windows');

    await page.evaluate(() => { window.__observed = 'relay-off'; });
    await page.getByRole('button', { name: 'Refresh limits', exact: true }).click();
    await work.getByText(/Status line readings are off in Settings › Privacy & data/).waitFor();
    record('with the relay switched off, an account with no readings is told why rather than shown as empty');

    await page.evaluate(() => { window.__observed = 'fail'; });
    await page.getByRole('button', { name: 'Refresh limits', exact: true }).click();
    await work.getByText(/could not read/).waitFor();
    assert.match(squash(await work.innerText()), /✕ ?could not read Error invoking remote method|✕ ?could not read .*observations table could not be read/);
    record('a failed read of the observations says could not read, never an empty or zero reading');
    await shoot('usage-failed');
    await page.evaluate(() => { window.__observed = 'full'; });
  }

  /* ── Timeline ──────────────────────────────────────────────────────── */
  await go('Meta+1'); await page.locator('.sessions-view').waitFor();
  // The Claude Code session on storefront; the Codex one has no status line or trace to show.
  await page.locator('.sessions-view').getByText('pid 4021', { exact: true }).click();
  await (before ? page : page.getByRole('group', { name: 'Session details', exact: true })).getByRole('button', { name: before ? 'Timeline' : 'Activity', exact: true }).click();
  await page.locator('.tl').waitFor();
  await page.locator('.tl-turns').waitFor();
  if (before) {
    await page.waitForTimeout(600);
    assert.equal(await page.locator('.tt').count(), 0, 'the pre-change build has no trace waterfall');
    await shoot('timeline');
    record('before: the Timeline groups tool calls by turn with no model time, no permission wait and no prompt cache');
  } else {
    // dur() rounds ten seconds and over to whole seconds: 31.65s reads "32s".
    const trace = page.getByRole('region', { name: 'Per-prompt trace, 32s' });
    await trace.waitFor();
    const text = squash(await trace.innerText());
    assert.match(text, /Trace ?model 15s · tools 16s · waiting on you 11s · turn 32s/);
    assert.match(text, /◆ model claude-opus-5 ?\+120ms · 4\.3s ?first token 820ms · stop tool_use · 12,400 in · 310 out · 11,900 cached/);
    assert.match(text, /⏸ waiting on you ?\+4\.7s · 11s ?you chose allow \(user_temporary\)/);
    assert.match(text, /▹ running ?\+16s · 4\.6s/);
    assert(!/waiting on you waiting on you|running running/.test(text), 'a row is not named by its kind twice');
    assert.match(text, /attempt 2/);
    assert.equal(await trace.locator('.tt-row').count(), 5);
    assert.equal(await trace.locator('.tt-d1').count(), 2, 'the wait and the execution nest under their tool call');
    await readable(trace.locator('.tt-label'), 'a waterfall label');
    await readable(trace.locator('.tt-facts'), 'a waterfall fact line');
    const asked = await page.evaluate(() => window.__calls.filter((c) => Array.isArray(c) && (c[0] === 'traces' || c[0] === 'statusLine')));
    assert(asked.length >= 2 && asked.every((c) => c[1] === 's1'), 'the Timeline asked for this session’s traces and status line by id alone: ' + JSON.stringify(asked));
    record('the newest turn draws its model calls, tool call and the wait on you as a waterfall offset from the prompt, with the CLI’s own facts');
    // Scrolled so the turn's own head sits just below the rail's sticky filters.
    const underSticky = (selector) => page.evaluate((sel) => {
      const el = document.querySelector(sel); const scroller = el?.closest('.tl-scroll');
      if (!el || !scroller) return;
      const sticky = scroller.querySelector('.tl-sticky');
      scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - (sticky?.offsetHeight ?? 0) - 8;
    }, selector);
    await underSticky('.tl-turns > .tl-li');
    await shoot('timeline-waterfall');

    await page.locator('.tl-summary > summary').filter({ hasText: 'Prompt cache' }).waitFor();
    const cacheSummary = squash(await page.locator('.tl-summary > summary').filter({ hasText: 'Prompt cache' }).innerText());
    assert.match(cacheSummary, /Prompt cache 91% hit · 2 misses/);
    await page.locator('.tl-summary > summary').filter({ hasText: 'Prompt cache' }).click();
    const cache = page.locator('.tl-summary[open]').filter({ hasText: 'What the prompt cache did' });
    await cache.waitFor();
    const cacheText = squash(await cache.innerText());
    assert.match(cacheText, /Hit ratio 91%/);
    assert.match(cacheText, /Misses 2 of 23 requests/);
    assert.match(cacheText, /TTL 1h expires/);
    assert.match(cacheText, /tools_changed \(tool definitions changed\) ×1/);
    assert.match(cacheText, /ttl_expired_5m \(idle past the 5m TTL\) ×1/);
    assert.match(cacheText, /If it goes cold, the CLI expects to re-cache 64,000 tokens\./);
    assert.match(cacheText, /From this session’s status line · reported 2m ago · CLI 2\.1\.270/);
    record('the prompt cache readout gives the hit ratio, misses with the CLI’s own cause names and words, the TTL and expiry, and where the figures came from');
    await readable(cache.locator('.pc-line'), 'a prompt cache line');
    await underSticky('.tl-summary[open]');
    await shoot('timeline-cache');
    await page.locator('.tl-summary > summary').filter({ hasText: 'Prompt cache' }).click();

    const turns = page.locator('.tl-turns > .tl-li');
    const middle = turns.nth(1);
    await middle.locator('.tl-turntoggle').click();
    await middle.getByText('No trace recorded for this turn.', { exact: true }).waitFor();
    record('a turn of a traced session with no spans says no trace recorded for this turn');
    const oldest = turns.nth(2);
    await oldest.locator('.tl-turntoggle').click();
    const partial = oldest.getByRole('region', { name: 'Per-prompt trace, incomplete' });
    await partial.waitFor();
    const partialText = squash(await partial.innerText());
    assert.match(partialText, /◌ ?incomplete/);
    assert.match(partialText, /Trace ?model 3\.4s · tools unfinished ?◌/);
    assert(!/tools 0ms|waiting on you 0ms/.test(partialText), 'an unended tool call and an unrecorded wait are not totalled as zero');
    assert.match(partialText, /The prompt’s interaction span was not recorded, so offsets are from the earliest span that was\./);
    assert.match(partialText, /▸ tool Read ?\+3\.6s · no end ?◌ ?incomplete no end time was exported\./);
    record('a turn killed mid-flight is marked incomplete, names what is missing, and draws the unended tool call without a bar');
    await underSticky('.tl-turns > .tl-li:nth-child(2)');
    await shoot('timeline-incomplete');
  }

  /* ── Insights ──────────────────────────────────────────────────────── */
  await go('Meta+5');
  await page.getByRole('region', { name: 'Spending report' }).waitFor();
  const anchor = page.getByText('Compare with synchronous pricing', { exact: true });
  if (before) {
    await page.waitForTimeout(800);
    assert.equal(await page.getByRole('region', { name: 'Spend by source' }).count(), 0, 'the pre-change build has no spend by source');
    await anchor.scrollIntoViewIfNeeded();
    await shoot('insights');
    record('before: Insights splits spend by surface and project, and nothing says which skill, plugin, MCP server or subagent spent it');
  } else {
    const card = page.getByRole('region', { name: 'Spend by source' });
    await card.getByText('main', { exact: true }).waitFor();
    const text = squash(await card.innerText());
    assert.match(text, /main — the conversation itself \$12\.90 70\.0% 610,000 44,000 5,200,000/);
    assert.match(text, /subagent — agents and hook agents it started \$4\.80 \+ \$1\.10 unbilled/);
    assert.match(text, /auxiliary — the CLI’s own background calls \$0\.61/);
    assert.match(text, /not reported \$0\.11/);
    assert.match(text, /All session spend \$18\.42 \+ \$1\.10 unbilled 100\.0% 912,000 61,200 7,400,000/);
    assert.match(text, /These are the CLI’s own estimated costs at list price, not your bill/);
    assert.match(text, /User-defined and third-party names read custom or third-party unless tool details are logged/);
    const asked = await page.evaluate(() => window.__calls.filter((c) => Array.isArray(c) && c[0] === 'sources'));
    assert(asked.length >= 1 && asked.every((c) => typeof c[1] === 'number'), 'spend by source was asked for by window alone: ' + JSON.stringify(asked));
    record('spend by source splits the window into main, subagent and auxiliary, keeps unattributed and unbilled spend visible, and says the figures are the CLI’s own estimates');
    await card.scrollIntoViewIfNeeded();
    await readable(card.locator('h3, p.sub'), 'the spend by source heading');
    await shoot('insights-spend-by-source');

    await card.getByRole('button', { name: 'Skill', exact: true }).click();
    await card.getByText('third-party — name withheld by the CLI', { exact: true }).waitFor();
    const skills = squash(await card.innerText());
    assert.match(skills, /no skill \$15\.20 \+ \$1\.10 unbilled/);
    assert.match(skills, /release-notes \$1\.12/);
    record('grouped by skill, a withheld name reads as withheld and spend with no skill is its own row');
    // Back to the headline grouping, so view memory does not carry Skill into the next visit.
    await card.getByRole('button', { name: 'Source', exact: true }).click();

    await page.evaluate(() => { window.__sources = 'empty'; });
    await go('Meta+1'); await page.locator('.sessions-view').waitFor();
    await go('Meta+5');
    await page.getByRole('region', { name: 'Spend by source' }).getByText('No attributed spend on record in this window.', { exact: true }).waitFor();
    record('a window with no attributed rows says so, instead of a table of zeroes');
    await page.evaluate(() => { window.__sources = 'fail'; });
    await go('Meta+1'); await page.locator('.sessions-view').waitFor();
    await go('Meta+5');
    await page.getByRole('region', { name: 'Spend by source' }).getByText(/Could not read spend by source\./).waitFor();
    record('a failed read says could not read, never an empty window');
  }
  assert.deepEqual(errors, []);
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({
    at: new Date().toISOString(),
    provenance: 'Actual Electron renderer from out/renderer of the checkout this script ran in; synthetic status line readings, trace spans and spend; no real agent calls',
    mode: before ? 'before' : 'after', checks, errors,
  }, null, 2) + '\n');
} finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
