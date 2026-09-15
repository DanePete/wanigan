#!/usr/bin/env node
// The helper sweep's attention surfaces, in the built renderer: the attention
// strip's denial actions and helper lines, the session tab's Resume, limit
// resume, away summary and triage menu, the Fleet inspector's evidence blocks,
// and the provider-status switch in Settings.
//
// Plain Chromium with the preload bridge stubbed (scripts/renderer-harness.mjs),
// so this is evidence about layout, wording and focus — never about IPC, hooks,
// PTYs or persistence; smoke31 covers those. Every shot is one scenario and one
// file name, and each is asserted to have rendered what its name promises.
//
// Usage:
//   npm run build && node scripts/probe-helper-p2-attention.mjs [--before] [--out docs/visuals/helper-p2-attention/after]
// --before shoots the same routes against a build that predates the feature and
// asserts only that each view rendered.
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openRenderer } from './renderer-harness.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const BEFORE = args.includes('--before');
const outArg = args.indexOf('--out');
const OUT = path.resolve(REPO, outArg >= 0 ? args[outArg + 1] : `docs/visuals/helper-p2-attention/${BEFORE ? 'before' : 'after'}`);
mkdirSync(OUT, { recursive: true });

let failures = 0;
const results = [];
const check = (ok, label, detail) => {
  results.push({ ok, label });
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`);
  if (!ok) { failures += 1; if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 500)}`); }
};
const expect = (ok, label, detail) => { if (!BEFORE) check(ok, label, detail); };
const errors = [];
const onError = (m) => { if (!/WebGPU|favicon/.test(m)) errors.push(m); };

// Generic example data only: this file is committed.
const INSTRUMENT = `
(() => {
  const api = window.wanigan, now = Date.now();
  localStorage.setItem('wanigan.code', '0');
  localStorage.setItem('wanigan.composer', '1');
  const projects = [
    { id: 'p1', name: 'storefront', path: '/example/storefront', branch: 'main' },
    { id: 'p2', name: 'platform', path: '/example/platform', branch: 'main' },
    { id: 'p3', name: 'billing', path: '/example/billing', branch: 'main' },
    { id: 'p4', name: 'docs', path: '/example/docs', branch: 'main' },
  ];
  const base = { providerId: 'claude', harnessId: 'claude-code', backendId: 'anthropic', unread: 0, worktree: null, pid: 4100, exitCode: null, endedAt: null, model: 'claude-opus-5' };
  const sessions = [
    { ...base, id: 's1', projectId: 'p1', projectName: 'storefront', title: 'Claude Code · storefront', displayTitle: 'Checkout bug', status: 'running', createdAt: now - 900000, conversationId: 'c1' },
    { ...base, id: 's2', projectId: 'p2', projectName: 'platform', title: 'Claude Code · platform', displayTitle: 'Release notes', status: 'running', createdAt: now - 1800000, conversationId: 'c2', unread: 4 },
    { ...base, id: 's4', projectId: 'p3', projectName: 'billing', title: 'Claude Code · billing', displayTitle: 'Invoice sync', status: 'running', createdAt: now - 2400000, conversationId: 'c4' },
    { ...base, id: 's5', projectId: 'p4', projectName: 'docs', title: 'Claude Code · docs', displayTitle: 'Docs pass', status: 'running', createdAt: now - 600000, conversationId: 'c5' },
    { ...base, id: 's3', projectId: 'p2', projectName: 'platform', title: 'Claude Code · platform', displayTitle: 'Overnight migration', status: 'exited', exitCode: 1, pid: null, createdAt: now - 7200000, endedAt: now - 1500000, conversationId: 'c3' },
  ];
  const reason = (rule, name, because) => ({ rule, event: name ? { name, at: now - 90000 } : null, because });
  const incident = { source: 'status.claude.com', name: 'Elevated errors on Claude Code', status: 'investigating', impact: 'major',
    components: ['Claude Code'], url: 'https://stspg.io/abc123', startedAt: now - 1200000, readAt: now - 60000 };
  const attention = [
    { sessionId: 's1', kind: 'permission', transitionId: 't1', since: now - 240000, label: 'Asking', tool: 'AskUserQuestion',
      detail: 'Which date library should the invoices use?',
      reason: reason('question-asked', 'PreToolUse', 'The agent called AskUserQuestion and nothing has answered it yet.'),
      helper: { questions: { at: now - 240000, why: 'Answer in the terminal. The dialog is a numbered list navigated with ↑/↓ and Enter, but which option starts highlighted was not verified — so Wanigan does not type an answer for you.',
        items: [{ question: 'Which date library should the invoices use?', header: 'Library', multiSelect: false,
          options: [{ label: 'date-fns', description: 'small, tree-shakeable' }, { label: 'luxon', description: 'time zones built in' }] }] } } },
    { sessionId: 's2', kind: 'error', transitionId: 't2', since: now - 130000, label: 'Denied by auto mode', tool: 'Bash',
      detail: 'Bash · git push --force origin main — [Irreversible] rewrites a protected branch',
      reason: reason('auto-mode-denied', 'PermissionDenied', "Auto mode in Claude Code refused a tool call in the last 5 minutes, and neither a new prompt nor the same call succeeding has settled it."),
      helper: { denial: { tool: 'Bash', summary: 'git push --force origin main', reason: '[Irreversible] rewrites a protected branch', at: now - 130000,
        retryDraft: 'You may retry Bash \\\`git push --force origin main\\\`: I approve it.' } } },
    { sessionId: 's4', kind: 'error', transitionId: 't4', since: now - 70000, label: 'Failed', tool: null,
      detail: 'StopFailure. Open incident: Elevated errors on Claude Code.',
      reason: reason('provider-incident', 'StopFailure', 'The newest event is a failure, recorded within the last 5 minutes. status.claude.com has an open incident (investigating) on Claude Code: “Elevated errors on Claude Code”.'),
      helper: { incident } },
    { sessionId: 's3', kind: 'finished', transitionId: 't3', since: now - 1500000, label: 'Done', tool: null, detail: 'Exited.',
      reason: reason('exited', null, 'The process ended.') },
    { sessionId: 's5', kind: 'finished', transitionId: 't5', since: now - 300000, label: 'Done', tool: null, detail: 'Finished its turn.',
      reason: reason('turn-ended', 'Stop', 'The agent reported the end of its turn and nothing has happened since.'),
      helper: { snoozedUntil: now + 3600000 } },
  ];
  const away = { sessionId: 's2', since: now - 42 * 60000, until: now, turnsCompleted: 3,
    filesChanged: { count: 4, paths: ['/example/platform/CHANGELOG.md'], source: 'hooks' },
    failedCommands: [{ tool: 'Bash', summary: 'npm run release:check', at: now - 600000 }], failedTotal: 1,
    costDeltaUsd: 1.84, verdict: { kind: 'error', label: 'Denied by auto mode' },
    recap: { text: 'Drafted the 2.4 release notes and tagged the commits; the push to main was refused.', at: now - 300000 }, nothingRecorded: false };
  const offer = { sessionId: 's3', evidence: 'Its last turn ended with StopFailure rate_limit and nothing ran after it.',
    reset: { resetsAt: now + 2 * 3600000, kind: 'session', scope: null, accountLabel: 'Personal', readAt: now - 120000 }, note: null, armed: null };
  const usage = (id) => ({ sessionId: id, costUsd: 1.2, costStatus: 'reported', inTokens: 42000, outTokens: 6100, cacheRead: 30000,
    cacheWrite: 900, linesAdded: 40, linesRemoved: 8, commits: 1, pullRequests: 0, activeSeconds: 600, requests: 14, errors: 0, refusals: 0,
    lastAt: now - 20000, models: ['claude-opus-5'] });
  const helper = {
    snooze: async () => ({ untilAt: now + 3600000 }), unsnooze: async () => true, markUnread: async () => true,
    sessionLeft: async () => true, sessionReturned: async (id) => (id === 's2' ? away : null),
    reopenClosed: async () => null, resumeCheck: async () => ({ liveInWanigan: null, outsideWriter: null, fork: { supported: true, how: '--fork-session', why: '' } }),
    resumeAsFork: async () => { throw new Error('Fixture: no launch.'); },
    limitOffer: async (id) => (id === 's3' ? offer : { sessionId: id, evidence: '', reset: null, note: null, armed: null }),
    armResume: async () => { throw new Error('Fixture: nothing armed.'); }, cancelResume: async () => true, resumes: async () => [],
    statusReport: async () => ({ enabled: true, lastCheckedAt: now - 60000, lastError: null, nextCheckAt: now + 120000, incidents: [incident] }),
    setStatusChecks: async (on) => ({ enabled: on, lastCheckedAt: null, lastError: null, nextCheckAt: null, incidents: [] }),
    denialRetryDrafted: async () => true, takeReplies: async () => [],
  };
  window.wanigan = new Proxy(api, { get(target, service) {
    if (service === 'helper') return helper;
    if (service === 'projects') return new Proxy(target.projects, { get(o, k) { return (k === 'list' || k === 'refresh') ? async () => projects : o[k]; } });
    if (service === 'sessions') return new Proxy(target.sessions, { get(o, k) {
      if (k === 'list') return async () => sessions;
      if (k === 'past') return async () => [];
      if (k === 'scrollback') return async () => 'Wanigan renderer fixture — no live provider\\r\\n';
      return o[k];
    } });
    if (service === 'attention') return { list: async () => attention };
    if (service === 'usage') return new Proxy(target.usage, { get(o, k) {
      if (k === 'many') return async (ids) => Object.fromEntries((ids ?? sessions.map((s) => s.id)).map((id) => [id, usage(id)]));
      if (k === 'session') return async (id) => usage(id);
      return o[k];
    } });
    return target[service];
  } });
})();
`;

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
    document.documentElement.dataset.themePreference = t;
    document.documentElement.style.colorScheme = t;
    window.dispatchEvent(new CustomEvent('wanigan:theme-changed', { detail: { preference: t, resolved: t } }));
  }, theme);
  await page.waitForTimeout(400);
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

const clipped = (page, selector) => page.evaluate((sel) => {
  const found = [...document.querySelectorAll(sel)];
  return found.map((el) => ({ text: el.textContent?.trim().slice(0, 60), clipped: el.scrollWidth > el.clientWidth + 1 }));
}, selector);

async function toView(page, key, tab) {
  await page.evaluate(() => document.querySelector('.hdr-toggle')?.focus());
  await page.keyboard.press(key);
  await page.waitForTimeout(900);
  if (tab && await page.locator(`.${tab}`).count() === 0) {
    await page.locator('.hdr-toggle').first().click().catch(() => {});
    await page.waitForTimeout(300);
  }
}

async function shootBox(page, locator, file, pad = 8) {
  const box = await locator.boundingBox();
  if (!box) return false;
  const vp = page.viewportSize();
  const clip = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: Math.min(vp.width, box.width + pad * 2), height: Math.min(vp.height - Math.max(0, box.y - pad), box.height + pad * 2) };
  await page.screenshot({ path: path.join(OUT, file), clip });
  return true;
}

for (const theme of ['light', 'dark']) {
  console.log(`\n── ${BEFORE ? 'before' : 'after'} · ${theme}`);
  const { page, close } = await openRenderer({ theme, width: 1440, height: 900, onError, instrument: INSTRUMENT });
  try {
    const bg = await setTheme(page, theme);
    check(true, `palette switched (${bg})`);

    /* the attention strip */
    await toView(page, 'Meta+1', 'sessions-view');
    await page.locator('.sessions-view').waitFor({ timeout: 8000 });
    await page.waitForTimeout(2400); // the strip polls every two seconds
    const strip = page.locator('.atq').first();
    check(await strip.count() === 1 && (await strip.textContent()).includes('Attention'), 'the attention strip rendered');
    const chips = await page.locator('.atq-chip').count();
    check(chips >= 3, 'the strip shows the waiting sessions', chips);
    expect(await page.locator('.atq-act', { hasText: 'Tell it to retry' }).count() === 1
      && await page.locator('.atq-act', { hasText: 'Open the timeline' }).count() === 1,
    'the denial chip carries Tell it to retry and Open the timeline');
    expect(await page.locator('.atq-act', { hasText: 'Status page' }).count() === 1, 'the incident chip carries its status-page link');
    expect((await page.locator('.atq-count').textContent()).includes('1 snoozed'), 'the snoozed session is counted and left out of the strip');
    const counted = await page.locator('.atq-count').textContent();
    expect(counted.includes('1 denied by auto mode') && counted.includes('1 failed'),
      'the strip counts each word separately, so a denial and a failure are not both called denials', counted);
    expect(await page.locator('.atq-chip', { hasText: 'docs' }).count() === 0, 'the snoozed session has no chip');
    const acts = await clipped(page, '.atq-act, .atq-helper');
    expect(acts.length >= 4 && acts.every((a) => !a.clipped || a.text?.startsWith('Open incident')), 'the new strip controls are not clipped', acts);
    await shootBox(page, strip, `strip-${theme}.png`, 0);

    /* the session tab: away summary on a running session */
    await page.locator('.session-item', { hasText: 'Release notes' }).first().click();
    await page.waitForTimeout(900);
    await page.evaluate(() => document.querySelector('.hdr-toggle')?.focus());
    expect(await page.locator('.session-away').count() === 1
      && (await page.locator('.session-away').textContent()).includes("Claude's recap"),
    'returning to a tab shows what was recorded since, with Claude’s recap labelled as Claude’s');
    const triage = page.locator('.session-tab-triage').nth(1);
    if (await triage.count()) { await triage.click(); await page.waitForTimeout(300); }
    expect(await page.locator('.session-tab-menu button', { hasText: 'Mark unread' }).count() === 1
      && await page.locator('.session-tab-menu button', { hasText: 'Snooze 15 minutes' }).count() === 1,
    'the tab menu offers Mark unread and the snooze presets');
    await shootBox(page, page.locator('.sessions').first(), `session-tab-running-${theme}.png`, 0);

    /* the session tab: an exited session */
    await page.locator('.session-item', { hasText: 'Overnight migration' }).first().click();
    await page.waitForTimeout(1000);
    await page.evaluate(() => document.querySelector('.hdr-toggle')?.focus());
    const toolbar = page.locator('.session-toolbar').first();
    check(await toolbar.count() === 1 && (await toolbar.textContent()).includes('Exited'), 'the exited session is on screen');
    expect(await page.locator('.session-resume-inplace').count() === 1
      && (await toolbar.textContent()).includes('Resume starts a new process on this same conversation'),
    'an exited tab has an in-place Resume that says it starts a new process on the same conversation');
    expect(await page.locator('.session-limit button', { hasText: 'Resume at' }).count() === 1,
      'an exited tab that stopped on a limit offers Resume at the reset time');
    const resumeClip = await clipped(page, '.session-resume-inplace, .session-limit button');
    expect(resumeClip.every((r) => !r.clipped), 'the resume controls are not clipped', resumeClip);
    await shootBox(page, page.locator('.session-main').first(), `session-tab-exited-${theme}.png`, 0);

    /* the Fleet inspector */
    await toView(page, 'Meta+2', 'fleet');
    await page.waitForTimeout(1200);
    const entry = page.locator('.fleet-entry', { hasText: 'Release notes' }).first();
    check(await entry.count() === 1, 'Fleet rendered its roster');
    await entry.click();
    await page.waitForTimeout(600);
    const inspector = page.locator('#fleet-inspector');
    check((await inspector.textContent()).includes('Denied by auto mode'), 'the inspector shows the denial verdict');
    expect(await inspector.locator('.helper-block[data-kind="denial"] button', { hasText: 'Tell it to retry' }).count() === 1
      && await inspector.locator('.helper-block[data-kind="snooze"] button').count() === 4,
    'the inspector shows the denial’s evidence and actions, and the four snooze presets');
    await inspector.evaluate((el) => { el.scrollTop = 0; });
    await shootBox(page, inspector, `fleet-inspector-denial-${theme}.png`, 0);

    const asking = page.locator('.fleet-entry', { hasText: 'Checkout bug' }).first();
    await asking.click();
    await page.waitForTimeout(600);
    expect(await inspector.locator('.helper-options li').count() === 2
      && (await inspector.textContent()).includes('Answer in the terminal'),
    'the inspector lists the question’s options read-only and says to answer in the terminal');
    await shootBox(page, inspector, `fleet-inspector-question-${theme}.png`, 0);

    /* Settings: the provider status switch */
    await toView(page, 'Meta+,', 'settings');
    await page.waitForTimeout(900);
    const privacy = page.locator('button', { hasText: 'Privacy & data' }).first();
    if (await privacy.count()) { await privacy.click(); await page.waitForTimeout(700); }
    const toggle = page.locator('.set-row', { hasText: 'Provider status checks' }).first();
    const observation = page.locator('.set-row', { hasText: 'Desktop notifications' }).first();
    check(await observation.count() === 1, 'Settings rendered its Observation switches');
    expect(await toggle.count() === 1 && (await toggle.textContent()).includes('no user data'),
      'Settings has the provider status switch, saying it is a public GET with no user data');
    const row = (await toggle.count()) ? toggle : observation;
    await row.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await shootBox(page, row, `settings-status-${theme}.png`, 6);
  } finally {
    await close();
  }
}

check(errors.length === 0, 'no page errors while driving the views', errors.slice(0, 5));
writeFileSync(path.join(OUT, 'verification.json'), `${JSON.stringify({
  generator: 'scripts/probe-helper-p2-attention.mjs', mode: BEFORE ? 'before' : 'after',
  renderer: 'out/renderer served over http with the preload bridge stubbed', at: new Date().toISOString(), results,
}, null, 2)}\n`);
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
