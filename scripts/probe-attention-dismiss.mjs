#!/usr/bin/env node
// Prove the attention strip can be answered: every chip carries a dismiss that
// puts one state away, a session the operator stopped is not reported as a
// failure, and nothing dismissed is lost — the count says how many and the
// Restore button brings them back.
//
// Plain Chromium with the preload bridge stubbed (scripts/renderer-harness.mjs).
// This is evidence about wording, layout and what the strip does with a click;
// the classifier's half of the same change is covered in the offline smoke
// suite, which is where exit code 129 is read.
//
// Usage:  npm run build && node scripts/probe-attention-dismiss.mjs [--out docs/visuals/attention-dismiss/after] [--before]
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openRenderer } from './renderer-harness.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
// --before runs against a build that predates the change: the strip has no
// dismiss control, so the assertions about one are skipped and only the
// screenshots are taken. Nothing else differs, which is what makes the pair
// comparable.
const BEFORE = args.includes('--before');
const OUT = path.resolve(REPO, outArg >= 0 ? args[outArg + 1] : `docs/visuals/attention-dismiss/${BEFORE ? 'before' : 'after'}`);
mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`);
  if (!ok) { failures += 1; if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 400)}`); }
};
const errors = [];
const onError = (m) => { if (!/WebGPU/.test(m)) errors.push(m); };

/*
 * The fleet from the report that prompted this: two agents blocked for hours,
 * two sessions the operator ended by hand — which the queue called "Failed ·
 * Exited with code 129", because a PTY killed by SIGHUP reports 128+1 — and one
 * still working. The main process owns dismissal; here it is a local record, so
 * the strip is exercised through exactly the calls the preload bridge exposes.
 */
const INSTRUMENT = `
(() => {
  const base = window.wanigan;
  const now = Date.now();
  const sessions = [
    { id: 's1', projectId: 'p1', projectName: 'storefront', providerId: 'claude', status: 'running', pid: 4021, exitCode: null, unread: 3, title: 'claude · storefront', worktree: null, accountLabel: 'work', createdAt: now - 25200000, endedAt: null },
    { id: 's2', projectId: 'p2', projectName: 'platform', providerId: 'codex', status: 'running', pid: 4088, exitCode: null, unread: 0, title: 'codex · platform', worktree: null, accountLabel: 'personal', createdAt: now - 10800000, endedAt: null },
    { id: 's3', projectId: 'p2', projectName: 'platform', providerId: 'claude', status: 'exited', pid: 3900, exitCode: 129, unread: 0, title: 'claude · platform', worktree: null, accountLabel: 'work', createdAt: now - 5400000, endedAt: now - 240000 },
    { id: 's4', projectId: 'p2', projectName: 'platform', providerId: 'claude', status: 'exited', pid: 3901, exitCode: 129, unread: 0, title: 'claude · platform', worktree: null, accountLabel: 'work', createdAt: now - 5400000, endedAt: now - 240000 },
    { id: 's5', projectId: 'p1', projectName: 'storefront', providerId: 'claude', status: 'running', pid: 4102, exitCode: null, unread: 0, title: 'claude · storefront', worktree: null, accountLabel: 'work', createdAt: now - 180000, endedAt: null },
  ];
  const stopped = {
    kind: 'finished', label: 'Stopped', detail: 'You stopped this session.', tool: null,
    reason: { rule: 'stopped', event: null, because: 'You asked Wanigan to stop this session, and code 129 is the signal it sent.' },
  };
  const rows = [
    { sessionId: 's1', kind: 'permission', transitionId: 'event:41', since: now - 25200000,
      label: 'Asking', detail: 'Edit · src/Checkout.php', tool: 'Edit',
      reason: { rule: 'permission-request', event: { name: 'PreToolUse', at: now - 25200000 }, because: 'The CLI reported it is waiting for a person to approve a step.' } },
    { sessionId: 's2', kind: 'permission', transitionId: 'event:42', since: now - 10800000,
      label: 'Asking', detail: 'Claude is waiting for your input', tool: null,
      reason: { rule: 'permission-request', event: { name: 'PreToolUse', at: now - 10800000 }, because: 'The CLI reported it is waiting for a person to approve a step.' } },
    { sessionId: 's3', ...stopped, transitionId: 'exit:1:129', since: now - 240000 },
    { sessionId: 's4', ...stopped, transitionId: 'exit:2:129', since: now - 240000 },
    { sessionId: 's5', kind: 'working', transitionId: 'event:44', since: now - 180000,
      label: 'Working', detail: 'Bash · npm test', tool: 'Bash',
      reason: { rule: 'working', event: { name: 'PreToolUse', at: now - 180000 }, because: 'A Bash call is in flight.' } },
  ];
  // A build that predates the change classifies the two stopped sessions from
  // their exit code alone, which is the state the report was filed against.
  const legacy = (row) => (row.reason?.rule === 'stopped'
    ? { ...row, kind: 'error', label: 'Failed', detail: 'Exited with code 129.',
        reason: { rule: 'nonzero-exit', event: null, because: 'The process exited with code 129.' } }
    : row);
  const put = new Map();
  const list = () => rows.map((row) => (window.__WANIGAN_LEGACY__ ? legacy(row) : row))
    .map((row) => ({ ...row, dismissedAt: put.get(row.sessionId) === row.transitionId ? now : null }));
  const attention = {
    list: async () => list(),
    dismiss: async (sessionId, transitionId) => { put.set(sessionId, transitionId); return list(); },
    restore: async (sessionId) => {
      if (sessionId) put.delete(sessionId); else put.clear();
      return list();
    },
  };
  window.wanigan = new Proxy(base, {
    get(target, prop) {
      if (prop === 'attention') return attention;
      if (prop === 'sessions') {
        const inner = target[prop];
        return new Proxy(inner, { get: (t, p) => (p === 'list' ? async () => sessions : t[p]) });
      }
      return target[prop];
    },
  });
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

// The strip lives at the top of the Sessions view, above the rail and the
// terminal, so that is where a probe has to stand to see it.
async function toSessions(page) {
  await page.keyboard.press('Meta+1');
  await page.waitForTimeout(700);
  if (await page.locator('.atq').count() === 0) {
    await page.locator('.hdr-toggle').first().click().catch(() => {});
    await page.waitForTimeout(300);
    await page.locator('[data-nav-tab="sessions"]').first().click().catch(() => {});
    await page.waitForTimeout(700);
  }
}

async function shot(page, name) {
  const box = await page.locator('.atq').boundingBox();
  await page.screenshot({
    path: path.join(OUT, `${name}.png`),
    clip: { x: box.x, y: Math.max(0, box.y - 8), width: box.width, height: box.height + 16 },
  });
}

const words = (page) => page.locator('.atq-chip .atq-word').allInnerTexts();

for (const theme of ['dark', 'light']) {
  console.log(`── ${theme}`);
  const { page, close } = await openRenderer({
    theme,
    width: 1440,
    height: 900,
    onError,
    instrument: BEFORE ? `window.__WANIGAN_LEGACY__ = true;\n${INSTRUMENT}` : INSTRUMENT,
  });
  await setTheme(page, theme);
  await toSessions(page);
  await page.waitForTimeout(600);

  check(await page.locator('.atq').count() === 1, 'the strip is on screen');
  const shown = await words(page);
  if (BEFORE) {
    check(shown.filter((w) => w === 'Failed').length === 2,
      'before: two sessions the operator ended are reported as failures', shown);
    check(await page.locator('.atq-x').count() === 0, 'before: no chip can be dismissed', shown);
    await shot(page, `${theme}-queue`);
    await close();
    continue;
  }

  check(!shown.includes('Failed'),
    'a session the operator stopped is not reported as a failure', shown);
  check(shown.filter((w) => w === 'Asking').length === 2,
    'the two blocked agents are still the queue', shown);
  check(shown.length > 0 && await page.locator('.atq-x').count() === shown.length,
    'every chip carries its own dismiss', await page.locator('.atq-x').count());
  await shot(page, `${theme}-queue`);

  // Dismiss the older of the two blocked agents. It leaves the strip, the count
  // says one is put away, and Restore is offered beside it.
  await page.locator('.atq-cell').first().locator('.atq-x').click();
  await page.waitForTimeout(400);
  const after = await words(page);
  check(after.length === shown.length - 1, 'the dismissed chip leaves the strip at once', after);
  const count = await page.locator('.atq-count').innerText();
  check(/1 dismissed/.test(count), 'the strip says how many states are put away', count);
  const restore = page.locator('.atq-toggle', { hasText: 'Restore' });
  check(await restore.count() === 1, 'and offers the way back', count);
  await shot(page, `${theme}-dismissed`);

  await restore.click();
  await page.waitForTimeout(400);
  check((await words(page)).length === shown.length, 'restore brings it back', await words(page));

  // What the two ended sessions say once the filter stops hiding them. The word
  // is the whole fix: the same exit code used to print "Failed · Exited with
  // code 129" for a session the operator ended on purpose.
  await page.locator('.atq-toggle', { hasText: 'idle, working & ended' }).click();
  await page.waitForTimeout(400);
  const all = await words(page);
  check(all.filter((w) => w === 'Stopped').length === 2,
    'the ended sessions are there under the filter, worded as stops', all);
  // The chip itself prints the detail line only for the two states that are a
  // question — a strip of three-line chips is a strip nobody scans — so the
  // sentence is checked where an ended session actually carries it.
  const stoppedLabel = await page.locator('.atq-cell', { hasText: 'Stopped' }).first()
    .locator('.atq-chip').getAttribute('aria-label');
  check(/You stopped this session/.test(stoppedLabel ?? ''), 'and say who ended them', stoppedLabel);
  await shot(page, `${theme}-all`);

  // The label is what a screen reader hears, and it has to say the chip comes
  // back — a dismiss that reads as "close" is a dismiss people will not use on
  // an agent that is genuinely blocked.
  const label = await page.locator('.atq-cell').first().locator('.atq-x').getAttribute('aria-label');
  check(/returns if this session changes/i.test(label ?? ''), 'the dismiss says the state can come back', label);

  await close();
}

check(errors.length === 0, 'no page errors', errors.slice(0, 3));
console.log(failures === 0 ? `\n✓ attention dismiss probe passed — shots in ${path.relative(REPO, OUT)}` : `\n✗ ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
