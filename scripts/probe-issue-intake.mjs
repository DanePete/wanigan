#!/usr/bin/env node
// Review · GitHub intake: each project's last check as fired, ran and how it
// ended, the gap sentence, GitHub events with their kind and a link out, the
// press that checks one project, and the opt-in timer in Settings › Connections.
// Actual renderer, isolated Electron, synthetic intake answers shaped like
// main's, no network and no real agent. The main-process polls themselves — gh
// through a fake binary, dedupe, every honest state, redaction — are exercised
// by the smoke suite (smoke25); this probe covers what a reader sees.
//
//   npm run build && node scripts/probe-issue-intake.mjs [--before] [--out dir]
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
  : path.join(root, 'docs/visuals/issue-intake', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-intake-probe-'));
writeFileSync(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({
  executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [path.join(dir, 'main.cjs'), `--user-data-dir=${dir}/profile`], env,
});
const checks = [], errors = [];
const record = (text) => { checks.push(text); console.log('✓', text); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(STUB);
  await page.addInitScript((isBefore) => {
    const original = window.wanigan, now = Date.now();
    Object.assign(window, { __checkCalls: [], __opened: [], __timerCalls: [], __check: 'quiet', __overview: sessionStorage.getItem('probe-overview') ?? 'ok',
      __timer: { enabled: false, intervalMinutes: 15 } });
    const REPO = 'https://github.com/example/platform';
    const event = (id, kind, summary, extra = {}) => ({ id, projectId: 'p2', source: 'github', kind, summary, status: 'new', docketId: null, createdAt: now - 50_000, ...extra });
    const manual = [
      event('m1', 'CI failure', 'Nightly deploy smoke test timed out after 20 minutes on the staging cluster.', { source: 'manual', projectId: 'p1', createdAt: now - 7_200_000 }),
      event('m2', 'incident', 'Checkout latency above 2 seconds for EU customers between 09:10 and 09:40.', { source: 'manual', projectId: 'p1', createdAt: now - 9_000_000 }),
    ];
    const github = [
      event('e1', 'opened', `Issue #88 opened by rosa in example/platform: “Rail collapses to zero width on resize” — ${REPO}/issues/88`),
      event('e2', 'labelled', `Issue #88 in example/platform carries the label “bug”: “Rail collapses to zero width on resize” — ${REPO}/issues/88`),
      event('e3', 'commented', `kofi commented on issue #71 in example/platform: “Still happens on 2.4 with the sidebar open, and the width comes back only after a reload.” — ${REPO}/issues/71#issuecomment-5001`),
      event('e4', 'CI failed', `CI failed in example/platform: CI on main (push), run #512: “Clamp the rail width” — ${REPO}/actions/runs/7001`),
    ];
    const later = [
      event('e6', 'labelled', `Issue #64 in example/platform carries the label “needs-triage”: “Docs link 404s” — ${REPO}/issues/64`, { createdAt: now - 3_000_000 }),
      event('e7', 'opened', `Issue #64 opened by amal in example/platform: “Docs link 404s” — ${REPO}/issues/64`, { createdAt: now - 3_000_000 }),
      event('e8', 'commented', `rosa commented on issue #52 in example/platform: “Fixed by the rail refactor?” — ${REPO}/issues/52#issuecomment-4001`, { createdAt: now - 3_100_000 }),
      event('e9', 'CI failed', `CI failed in example/platform: Docs on main (push), run #498: “Move the docs build” — ${REPO}/actions/runs/6900`, { createdAt: now - 3_200_000 }),
      event('e10', 'opened', `Issue #50 opened by kofi in example/platform: “Old report” — ${REPO}/issues/50`, { status: 'dismissed', createdAt: now - 3_300_000 }),
    ];
    const events = isBefore ? manual : [...github, manual[0], ...later, manual[1]];
    const kinds = { opened: 'opened', labelled: 'labelled', commented: 'commented', 'CI failed': 'ci_failed' };
    const links = github.concat(later).map((e) => ({ eventId: e.id, kind: kinds[e.kind], url: e.summary.split(' — ').pop(), happenedAt: now - 120_000, pollId: 'poll_p2' }));

    const counts = (o = 0, l = 0, c = 0, f = 0) => ({ opened: o, labelled: l, commented: c, ci_failed: f });
    const poll = (over) => ({ id: 'poll', projectId: 'p2', trigger: 'timer', firedAt: now - 60_000, ranAt: now - 59_000, finishedAt: now - 56_000,
      outcome: 'succeeded', reason: null, error: null, repo: 'github.com/example/platform', since: null, until: null, lookback: false,
      intervalMs: 15 * 60_000, gapMs: null, factsRead: 0, counts: counts(), capped: null, ...over });
    const success = poll({ id: 'poll_p2', since: now - 59_000 - 6 * 3_600_000, until: now - 59_000, gapMs: 6 * 3_600_000 - 15 * 60_000,
      factsRead: 6, counts: counts(1, 1, 1, 1) });
    const yesterday = poll({ id: 'poll_p1_ok', projectId: 'p1', repo: 'github.com/example/storefront', firedAt: now - 26 * 3_600_000,
      ranAt: now - 26 * 3_600_000 + 1_000, finishedAt: now - 26 * 3_600_000 + 4_000, since: now - 27 * 3_600_000, until: now - 26 * 3_600_000, factsRead: 2, counts: counts(1, 1) });
    const P1 = {
      // The gap main would record for a window that began at yesterday's success.
      unsigned: poll({ id: 'poll_p1', projectId: 'p1', repo: 'github.com/example/storefront', outcome: 'failed', since: yesterday.until, until: now - 59_000,
        gapMs: now - 59_000 - yesterday.until - 15 * 60_000,
        reason: 'gh is not signed in to github.com, so example/storefront could not be read and nothing from this check was recorded. Run `gh auth login` in your terminal, then check again.',
        error: 'HTTP 401: Bad credentials (https://api.github.com/graphql)' }),
      missing: poll({ id: 'poll_p1_missing', projectId: 'p1', trigger: 'manual', repo: 'github.com/example/storefront', outcome: 'skipped', ranAt: null, firedAt: now - 2_000, finishedAt: now - 1_900,
        reason: 'gh is not installed, or not on your shell PATH, so GitHub was not read. Install GitHub’s gh CLI and run `gh auth login`, then check again.' }),
      running: poll({ id: 'poll_p1_running', projectId: 'p1', trigger: 'manual', repo: 'github.com/example/storefront', outcome: null, firedAt: now - 1_500, ranAt: now - 1_400, finishedAt: null }),
    };
    const scene = { p1: P1.unsigned, p2: success, timer: { enabled: true, intervalMinutes: 15 } };
    const project = (projectId, projectName, watch, last, lastSucceeded) => ({ projectId, projectName, watch, last, lastSucceeded });
    const overview = () => ({
      timer: scene.timer, readAt: Date.now(), events: links,
      projects: [
        project('p1', 'storefront', { kind: 'github', repo: 'github.com/example/storefront', remote: 'upstream' }, scene.p1, yesterday),
        project('p2', 'platform', { kind: 'github', repo: 'github.com/example/platform', remote: 'origin' }, scene.p2, scene.p2.outcome === 'succeeded' ? scene.p2 : success),
        project('p3', 'docs-site', { kind: 'unwatched', detail: 'This repository’s remotes point at gitlab.com. Intake watches repositories on github.com and GitHub Enterprise Cloud (*.ghe.com) only, so nothing is watched.' }, null, null),
      ],
    });

    window.wanigan = new Proxy(original, { get(api, service) {
      if (service === 'control') return new Proxy(api.control, { get(c, method) {
        if (method === 'list' || method === 'outcomes') return async () => [];
        if (method === 'events') return async () => events;
        return c[method];
      } });
      if (service === 'intake') return new Proxy({}, { get(_i, method) {
        if (method === 'overview') return async () => {
          if (window.__overview === 'fail') throw new Error('Error invoking remote method \'intake:overview\': database is locked');
          return overview();
        };
        if (method === 'check') return async (...args) => {
          window.__checkCalls.push(args);
          if (window.__check === 'refused') throw new Error('That project is not registered with Wanigan.');
          if (args[0] === 'p2') scene.p2 = poll({ id: 'poll_p2_again', trigger: 'manual', firedAt: Date.now() - 3_000, ranAt: Date.now() - 2_900, finishedAt: Date.now() - 2_000,
            since: success.until, until: Date.now() - 2_900, factsRead: 6, counts: counts() });
          if (args[0] === 'p1') scene.p1 = P1[window.__check];
          return args[0] === 'p1' ? scene.p1 : scene.p2;
        };
        if (method === 'timer') return async () => ({ ...window.__timer });
        if (method === 'setTimer') return async (input) => {
          window.__timerCalls.push(input);
          if (input.intervalMinutes < 10) throw new Error(`The interval must be at least 10 minutes; ${input.intervalMinutes} would ask GitHub more often than intake allows.`);
          window.__timer = { ...input };
          return { ...window.__timer };
        };
        return undefined;
      } });
      if (service === 'shell') return new Proxy(api.shell, { get(s, method) {
        if (method === 'openExternal') return async (url) => { window.__opened.push(url); return true; };
        return s[method];
      } });
      return api[service];
    } });
  }, before);

  const shoot = async (name) => {
    for (const theme of ['dark', 'light']) {
      // Both halves of what applyThemePreference sets (theme-boot.ts): the
      // inline color-scheme outranks the stylesheet's, and native controls
      // follow it.
      await page.evaluate((t) => { const html = document.documentElement; html.dataset.theme = t; html.style.colorScheme = t; }, theme);
      await page.screenshot({ path: path.join(out, `${name}-${theme}.png`), scale: 'css' });
    }
  };
  /** Readable, not merely present: a clipped line passes a visibility wait. */
  const fits = async (locator, what) => {
    const fit = await locator.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    assert(fit.scroll <= fit.client + 1, `${what} is clipped: ${JSON.stringify(fit)}`);
  };
  let opened = false;
  const openReview = async () => {
    // A reload the second time: the same URL and hash again is a same-document
    // navigation, which mounts nothing and runs no init script.
    if (opened) await page.reload(); else await page.goto(rendererURL + '#goal=none');
    opened = true;
    await page.getByRole('heading', { name: 'Review', exact: true }).waitFor();
    const summary = page.locator('.control-support > summary');
    await summary.waitFor();
    await summary.click();
    await page.locator('.control-support[open]').waitFor();
  };
  const openConnections = async () => {
    await page.locator('.space-dock button').first().focus();
    await page.keyboard.press('Meta+,');
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
    await page.locator('#settings-tab-connections').click();
    await page.locator('#settings-connections').waitFor({ state: 'visible' });
  };

  await openReview();
  const intake = page.getByRole('region', { name: 'GitHub intake' });

  if (before) {
    await page.locator('.control-event').first().waitFor();
    await page.waitForTimeout(400);
    assert.equal(await intake.count(), 0, 'the pre-change build has no GitHub intake');
    assert.equal(await page.getByRole('button', { name: 'Check GitHub now' }).count(), 0);
    await page.locator('.control-lower > article').first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await shoot('review-inbox');
    record('before: Review’s event inbox holds only events typed in by hand, and nothing in it reads GitHub');
    await openConnections();
    await page.locator('[data-section-title="MCP servers"]').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    assert.equal(await page.locator('[data-section-title="GitHub intake"]').count(), 0);
    await shoot('settings-connections');
    record('before: Settings › Connections has no GitHub intake timer');
  } else {
    const calls = () => page.evaluate(() => window.__checkCalls);
    const group = (name) => intake.getByRole('group', { name: `${name} on GitHub` });
    await group('platform').waitFor();
    await page.waitForTimeout(300);
    assert.deepEqual(await calls(), [], 'opening Review and its inbox checked nothing');
    assert.equal(flat(await intake.locator('.sec-count').innerText()), '2', 'two projects are watched');
    assert.equal(flat(await intake.locator('.intake-lead').innerText()),
      'Issues opened, labelled or commented on, and failed CI runs, read through your gh and added to this inbox for you to triage. Nothing is written to GitHub.');
    assert.match(flat(await intake.locator('.intake-timer').innerText()),
      /^▸ ?timer every 15 minutes Only while Wanigan is running: nothing watches while it is closed or this Mac sleeps, and the next check says for how long\.$/);
    record('opening Review and its event inbox checks GitHub zero times; the section names what it reads, that nothing is written to GitHub, and that the timer only watches while Wanigan runs');

    const platform = flat(await group('platform').innerText());
    assert.match(platform, /^platform example\/platform Check GitHub now ● ?fired \S+( [AP]M)? by the timer ▸ ?ran \S+( [AP]M)? ✓ ?succeeded \S+( [AP]M)?/);
    assert.match(platform, /4 new events: 1 opened · 1 labelled · 1 commented · 1 CI failed\. 2 other facts read were already in the inbox\./);
    assert.match(platform, /Covered .+ to .+\./);
    assert.match(platform, /Nothing was watching for 5 h 45 min: the last successful check was 6 h before this one, and the timer asks every 15 minutes\. Wanigan was closed, this Mac was asleep, the timer was off, or checks failed in between\. An issue opened and closed, a label added and removed, or a run that failed and was re-run, in that time is not in this inbox\./);
    assert(!/\bundefined\b|\bNaN\b|\[object |Invalid Date/.test(platform), 'no raw value reaches the screen: ' + platform);
    for (const [locator, what] of [
      [group('platform').locator('.intake-states'), 'the fired, ran and succeeded line'],
      [group('platform').locator('.intake-counts'), 'the counts'],
      [group('platform').locator('.note'), 'the gap sentence'],
      [group('platform').locator('.intake-project-line'), 'the project line'],
    ]) await fits(locator, what);
    record('a timed check shows fired, ran and succeeded as three marks with times, the new events by kind beside the facts already recorded, the window, and the gap as a warning, none of it clipped');
    // The inbox scrolls inside Control's own support panel, which holds about one
    // project at a time at this window size: one shot from the top of the section,
    // one from the project that succeeded.
    await intake.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await shoot('intake');
    await group('platform').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await shoot('succeeded');

    const storefront = flat(await group('storefront').innerText());
    assert.match(storefront, /^storefront example\/storefront · via upstream Check GitHub now ● ?fired .+ by the timer ▸ ?ran .+ ✕ ?failed .+ gh is not signed in to github\.com, so example\/storefront could not be read and nothing from this check was recorded\. Run `gh auth login` in your terminal, then check again\. gh said: HTTP 401: Bad credentials \(https:\/\/api\.github\.com\/graphql\)/);
    assert.match(storefront, /The last successful check finished .+; the inbox holds what it and earlier checks recorded\.$/);
    assert(!/new event|Covered/.test(storefront), 'a failed check shows no counts and no window: ' + storefront);
    await fits(group('storefront').locator('.intake-reason'), 'the failure reason');
    await fits(group('storefront').locator('.intake-said'), 'gh’s own words');
    const folded = intake.locator('details.intake-unwatched');
    assert.equal(await folded.getAttribute('open'), null, 'unwatched projects start folded');
    assert.equal(flat(await folded.locator('summary').innerText()), '1 project not watched');
    await folded.locator('summary').click();
    assert.match(flat(await folded.innerText()), /docs-site This repository’s remotes point at gitlab\.com\. Intake watches repositories on github\.com and GitHub Enterprise Cloud \(\*\.ghe\.com\) only, so nothing is watched\./);
    await folded.locator('summary').click();
    record('a failed check shows the not-signed-in reason with gh’s own words and when the last success finished, the remote it watches when that is not origin, and a GitLab project folded under “not watched” with its reason');

    const rows = page.locator('.control-event');
    assert.equal(await rows.count(), 6, 'six rows are shown');
    const row = (i) => rows.nth(i);
    /** Kind, summary and buttons read apart: adjacent inline elements run together in innerText. */
    const facts = async (i) => ({
      // A mark is inline-flex, so whether its glyph and word come back spaced is the engine's call; one space is the reading.
      kind: flat(await row(i).locator(':scope > .mark, :scope > strong').innerText()).replace(/^([^\w\s]) ?/, '$1 '),
      bold: await row(i).locator(':scope > strong').count(),
      summary: flat(await row(i).locator(':scope > p').innerText()),
      buttons: (await row(i).getByRole('button').allInnerTexts()).map(flat),
    });
    const withLink = ['Open on GitHub', 'Create goal', 'Dismiss'];
    assert.deepEqual(await facts(0), { kind: '+ opened', bold: 0, summary: 'Issue #88 opened by rosa in example/platform: “Rail collapses to zero width on resize”', buttons: withLink });
    assert.deepEqual(await facts(1), { kind: '• labelled', bold: 0, summary: 'Issue #88 in example/platform carries the label “bug”: “Rail collapses to zero width on resize”', buttons: withLink });
    assert.deepEqual((await facts(2)).kind, '› commented');
    assert.deepEqual(await facts(3), { kind: '✕ CI failed', bold: 0, summary: 'CI failed in example/platform: CI on main (push), run #512: “Clamp the rail width”', buttons: withLink });
    assert.deepEqual(await facts(4), { kind: 'CI failure', bold: 1, summary: 'Nightly deploy smoke test timed out after 20 minutes on the staging cluster.', buttons: ['Create goal', 'Dismiss'] });
    assert.equal(await page.getByRole('button', { name: 'Open on GitHub' }).count(), 5, 'only GitHub events link out');
    assert(!(await rows.allInnerTexts()).some((t) => t.includes('https://')), 'the link is not printed in the row as well as behind its button');
    await row(0).getByRole('button', { name: 'Open on GitHub' }).click();
    await row(3).getByRole('button', { name: 'Open on GitHub' }).click();
    assert.deepEqual(await page.evaluate(() => window.__opened), ['https://github.com/example/platform/issues/88', 'https://github.com/example/platform/actions/runs/7001']);
    const hidden = page.locator('.control-lower > article').first().locator('.hint').last();
    assert.equal(flat(await hidden.innerText()), '4 more events are not shown; create a goal from one above or dismiss it to bring the next into view.');
    await fits(row(2).locator('p'), 'a comment excerpt');
    // An icon-led button on the text baseline sat three pixels above its neighbours.
    const middles = await row(0).getByRole('button').evaluateAll((buttons) => buttons.map((b) => { const r = b.getBoundingClientRect(); return r.top + r.height / 2; }));
    assert(Math.max(...middles) - Math.min(...middles) <= 1, 'the row’s buttons share one line: ' + JSON.stringify(middles));
    record('GitHub events show their kind as glyph and word, the summary without its repeated link, and Open on GitHub — level with the row’s other buttons — hands the external-open path exactly the event’s link; a typed event keeps its bold kind and no link; rows past the six shown are counted');
    await rows.first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await shoot('events');

    await group('platform').getByRole('button', { name: 'Check GitHub now' }).click();
    await group('platform').getByText(/No new events: 6 facts read, all already in the inbox\./).waitFor();
    assert.deepEqual(await calls(), [['p2']], 'one check, by project id alone');
    const again = flat(await group('platform').innerText());
    assert.match(again, /● ?fired .+ by a press ▸ ?ran .+ ✓ ?succeeded/);
    assert(!/Nothing was watching/.test(again), 'a check minutes after the last has no gap sentence: ' + again);
    record('a press checks one project by id, and its line becomes the new check: fired by a press, nothing new, no gap');

    await page.evaluate(() => { window.__check = 'missing'; });
    await group('storefront').getByRole('button', { name: 'Check GitHub now' }).click();
    await group('storefront').getByText(/gh is not installed, or not on your shell PATH/).waitFor();
    const skipped = flat(await group('storefront').innerText());
    assert.match(skipped, /● ?fired .+ by a press – ?did not run ⊘ ?skipped .+ gh is not installed, or not on your shell PATH, so GitHub was not read\./);
    assert(!/▸ ?ran|gh said/.test(skipped), 'a check that never ran shows no run time and no words from gh: ' + skipped);
    await group('storefront').evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await shoot('skipped');
    await page.evaluate(() => { window.__check = 'running'; });
    await group('storefront').getByRole('button', { name: 'Check GitHub now' }).click();
    await group('storefront').getByText('still reading').waitFor();
    await page.evaluate(() => { window.__check = 'refused'; });
    await group('storefront').getByRole('button', { name: 'Check GitHub now' }).click();
    await group('storefront').getByText('The check was not recorded: That project is not registered with Wanigan.').waitFor();
    record('a check that never ran reads “did not run” and “skipped” with its reason and no gh words, one in progress reads “still reading”, and a refused press says the check was not recorded');

    await page.evaluate(() => { window.__check = 'unsigned'; window.__overview = 'fail'; });
    await group('platform').getByRole('button', { name: 'Check GitHub now' }).click();
    await intake.getByText(/GitHub intake could not be read again, so this may be out of date: .*database is locked/).waitFor();
    await page.evaluate(() => sessionStorage.setItem('probe-overview', 'fail'));
    await openReview();
    const unread = page.locator('.control-lower > article').first();
    await unread.getByText('GitHub intake could not be read', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Check GitHub now' }).count(), 0);
    assert(!/No project has a GitHub remote|not watched/.test(flat(await unread.innerText())), 'an unread overview is never “no projects”');
    await page.evaluate(() => sessionStorage.removeItem('probe-overview'));
    record('an intake read that fails after one succeeded keeps the last answer under a warning, and one that never succeeded says it could not be read — never that no project is watched');

    await openConnections();
    const section = page.locator('[data-section-title="GitHub intake"]');
    await section.getByRole('switch', { name: 'Check GitHub on a timer' }).waitFor();
    await section.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    const toggle = section.getByRole('switch', { name: 'Check GitHub on a timer' });
    const interval = section.getByRole('spinbutton', { name: 'Minutes between checks (at least 10)' });
    assert.equal(await toggle.getAttribute('aria-checked'), 'false', 'the timer is off by default');
    assert.equal(await interval.inputValue(), '15');
    assert.match(flat(await section.innerText()), /Nothing is written to GitHub\. Nothing watches while Wanigan is closed or this Mac sleeps, and the next check says for how long\./);
    await interval.fill('9');
    await section.getByRole('button', { name: 'Save interval' }).click();
    await section.getByText('Nothing was saved. The interval must be at least 10 minutes; 9 would ask GitHub more often than intake allows.').waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await shoot('settings-refused');
    await interval.fill('20');
    await section.getByRole('button', { name: 'Save interval' }).click();
    await section.getByText(/The timer is off, with 20 minutes kept for when it is on\./).waitFor();
    await toggle.click();
    await section.getByText('GitHub is checked every 20 minutes while Wanigan is running. The first check comes within a minute.').waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    assert.deepEqual(await page.evaluate(() => window.__timerCalls), [
      { enabled: false, intervalMinutes: 9 }, { enabled: false, intervalMinutes: 20 }, { enabled: true, intervalMinutes: 20 },
    ]);
    await fits(section.locator('.set-caption'), 'the caption');
    await shoot('settings');
    record('Settings › Connections shows the timer off by default at 15 minutes; a nine-minute interval is refused in main’s words with nothing saved, and a twenty-minute interval and the switch each save and say what now happens');
  }
  assert.deepEqual(errors, []);
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({
    at: new Date().toISOString(),
    provenance: 'Actual Electron renderer from out/renderer of the checkout this script ran in; synthetic intake answers, events and timer; no network and no real agent calls',
    mode: before ? 'before' : 'after', checks, errors,
  }, null, 2) + '\n');
} finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
