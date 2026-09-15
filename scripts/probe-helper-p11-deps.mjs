#!/usr/bin/env node
// Visual evidence for dependencies, finished (helper sweep · P11): which turn
// added each package with a jump to that turn's diff, the opt-in advisory
// lookup under the code rail's Dependencies section, and its switch in Settings.
//
// Plain Chromium with the preload bridge stubbed (scripts/renderer-harness.mjs):
// evidence about layout, wording and both palettes — never about IPC, git, OSV
// or SQLite, which src/main/smoke40.ts covers against a real repository and a
// loopback stub. The advisory report fixture is not typed by hand: it is built
// by shared/dependency-advisories.ts's own assembleAdvisoryReport, so the page
// is shown the shape main returns.
//
// Usage:
//   npm run build && node scripts/probe-helper-p11-deps.mjs          → docs/visuals/helper-p11-deps/after
//   node scripts/probe-helper-p11-deps.mjs --before --out <dir>      → from a checkout of the base commit
//
// With --before the new elements are expected to be absent; the same views are
// photographed at the same navigation state.
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openRenderer } from './renderer-harness.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const BEFORE = args.includes('--before');
const outArg = args.indexOf('--out');
const OUT = path.resolve(REPO, outArg >= 0 ? args[outArg + 1] : `docs/visuals/helper-p11-deps/${BEFORE ? 'before' : 'after'}`);
mkdirSync(OUT, { recursive: true });

let failures = 0;
const results = [];
const shots = [];
const check = (ok, label, detail) => {
  results.push({ ok, label });
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`);
  if (!ok) { failures += 1; if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 600)}`); }
};
const errors = [];
const onError = (m) => { if (!/WebGPU|GPU|webgl|Failed to load resource/i.test(m)) errors.push(m); };

const NOW = Date.now();
const H = 3600_000;

/* ── the advisory report, built by the module main uses ──────────────── */
let lookupReport = null;
let cachedReport = null;
if (!BEFORE) {
  // Resolved from this checkout, which the --before run (from the base) does not have.
  const mod = await import(pathToFileURL(path.join(REPO, 'src/shared/dependency-advisories.ts')).href);
  const sources = (manifest, spec, change = 'added') => [{ manifest, section: 'dependencies', change, spec }];
  const answered = (ids, fromCache = false, at = NOW - 20_000) => ({ state: 'answered', answer: { advisories: ids.map((id) => ({ id, modified: '2026-09-10T03:49:04Z' })), more: false }, checkedAt: at, fromCache });
  const rows = [
    { ecosystem: 'npm', name: 'left-pad', version: { exact: '1.3.0' }, sources: sources('package.json', '1.3.0'), osv: answered([]), publish: { state: 'read', at: Date.parse('2018-04-09T01:10:45.796Z') } },
    { ecosystem: 'npm', name: 'p-retry', version: { exact: '6.2.0' }, sources: sources('package-lock.json', '6.2.0'), osv: answered([], true, NOW - 3 * H), publish: { state: 'read', at: NOW - 30 * H } },
    { ecosystem: 'npm', name: 'lodash', version: { exact: '4.17.15' }, sources: [...sources('package.json', '^4.17.15', 'upgraded'), ...sources('package-lock.json', '4.17.15', 'upgraded')],
      osv: answered(['GHSA-29mw-wpgm-hmr9', 'GHSA-35jh-r3h4-6jhm', 'GHSA-f23m-r3pf-42rh']), publish: { state: 'read', at: Date.parse('2019-07-19T02:28:46.584Z') } },
    { ecosystem: 'npm', name: 'flatmap-stream', version: { exact: '0.1.1' }, sources: sources('package.json', '0.1.1'), osv: answered(['GHSA-mh6f-8j2x-4483', 'MAL-2025-20690']), publish: { state: 'read', at: Date.parse('2018-09-05T00:00:00Z') } },
    { ecosystem: 'PyPI', name: 'httpx', version: { exact: '0.27.2' }, sources: sources('requirements.txt', '==0.27.2'), osv: { state: 'failed', reason: 'OSV is limiting requests (HTTP 429); it asks to wait 30 s. Try again later.' }, publish: { state: 'failed', reason: 'pypi.org did not answer within 15 s' } },
    { ecosystem: 'crates.io', name: 'serde', version: { notExact: 'a requirement, not an exact version (Cargo reads "1.0" as ^1.0)' }, sources: sources('Cargo.toml', '1.0'), osv: { state: 'not-asked', reason: 'a requirement, not an exact version (Cargo reads "1.0" as ^1.0)' }, publish: { state: 'not-covered' } },
  ];
  lookupReport = mod.assembleAdvisoryReport({ mode: 'lookup', enabled: true, now: NOW, rows, notes: [],
    requests: [{ host: 'api.osv.dev', count: 1 }, { host: 'registry.npmjs.org', count: 3 }, { host: 'pypi.org', count: 1 }] });
  cachedReport = mod.assembleAdvisoryReport({ mode: 'cache-only', enabled: false, now: NOW, notes: [], requests: [],
    rows: rows.map((r) => ({ ...r, osv: { state: 'not-asked', reason: 'no check has been run for this version' }, publish: r.publish.state === 'not-covered' ? r.publish : { state: 'not-asked', reason: 'no check has been run for this version' } })) });
}

const INSTRUMENT = (advisoriesOn) => String.raw`
(() => {
  const base = window.wanigan;
  const now = ${NOW};
  const H = 3600000, M = 60000;
  const BASE = '1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d';
  const LOOKUP = ${JSON.stringify(lookupReport)};
  const CACHED = ${JSON.stringify(cachedReport)};
  try { localStorage.setItem('wanigan.code', '1'); } catch {}
  const session = { id: 's1', projectId: 'p1', projectName: 'storefront', projectPath: '/example/storefront', providerId: 'claude', harnessId: 'claude-code', status: 'exited', pid: 4021, exitCode: 0, unread: 0, title: 'Checkout retries', worktree: null, label: null, accountLabel: 'work', createdAt: now - 3 * H, endedAt: now - 5 * M, capabilities: { hooks: true } };
  const review = (state) => ({ state, stale: false, marked: state === 'unreviewed' ? null : state, note: null, markedAt: null });
  const f = (p, over) => Object.assign({ path: p, oldPath: null, status: 'M', added: 3, removed: 1, binary: false, contentHash: 'h' + p.length, preexisting: false, scratch: null,
    review: review('unreviewed'), attribution: 'edit-tool', attributionLabel: 'edited by an edit tool', tier: null, kind: 'other', alarms: [], image: false }, over || {});
  const files = [f('package.json', { added: 4, removed: 1 }), f('package-lock.json', { added: 40, removed: 12, attribution: 'shell-reported', attributionLabel: 'changed by a shell command (reported by Claude Code)' }), f('src/retry.ts', { status: 'A', added: 22, removed: 0 })];
  const counts = { files: 3, approved: 0, rejected: 0, commented: 0, stale: 0, unreviewed: 3, added: 66, removed: 13, binary: 0 };
  const work = { sessionId: 's1', root: '/example/storefront', base: BASE, anchor: "this session's changes against 1a2b3c4d, the commit it started from", turn: 'exited', files,
    verdict: { needsReview: true, reason: 'unapproved-files', because: 'It exited with 3 changed files, and none is approved.', counts },
    label: 'Needs review · 0 of 3 files', hooksRecorded: true, shellDiffReported: true, tiersConfigured: false, highTierUnapproved: [], truncated: false, patchTruncated: false, unreadable: null, projectId: 'p1' };
  const patch = ['diff --git a/package.json b/package.json', '--- a/package.json', '+++ b/package.json', '@@ -3,5 +3,8 @@', '   "dependencies": {', '-    "react": "^18.2.0"', '+    "react": "^19.0.0",', '+    "left-pad": "1.3.0",', '+    "p-retry": "6.2.0",', '+    "zod": "3.23.8"', '   }', ''].join('\n');
  const cp = (id, turn, kind, at, commit) => ({ id, sessionId: 's1', turn, kind, at: now - at, repoRoot: '/example/storefront', commitHash: commit.repeat(40), treeHash: 't' + id, filesChanged: 1, status: 'ok', detail: null });
  const checkpoints = [cp(1, 0, 'session-start', 50 * M, 'a'), cp(2, 1, 'turn-start', 45 * M, 'a'), cp(3, 1, 'turn-end', 40 * M, 'b'), cp(4, 2, 'turn-start', 30 * M, 'b'), cp(5, 2, 'turn-end', 20 * M, 'c'), cp(6, 2, 'session-end', 5 * M, 'c')];
  const dependencies = { hooksRecorded: true,
    installs: [{ command: 'pip install httpx', ok: true, exitCode: null, at: now - 42 * M }, { command: 'npm install p-retry@6.2.0', ok: true, exitCode: null, at: now - 25 * M }],
    manifests: [{ path: 'package.json', kind: 'package.json', note: null, error: null,
      changes: [
        { name: 'left-pad', section: 'dependencies', change: 'added', before: null, after: '1.3.0' },
        { name: 'p-retry', section: 'dependencies', change: 'added', before: null, after: '6.2.0' },
        { name: 'zod', section: 'dependencies', change: 'added', before: null, after: '3.23.8' },
        { name: 'react', section: 'dependencies', change: 'upgraded', before: '^18.2.0', after: '^19.0.0' },
      ],
      lines: [],
      attributions: [
        { state: 'before-first-checkpoint', alsoTurns: [], detail: 'The working tree already had this change when the launch snapshot was taken, before the first turn.' },
        { state: 'turn', turn: 2, fromCheckpoint: 4, toCheckpoint: 5, alsoTurns: [], detail: "Turn 2's snapshots are the first to show this change.",
          install: { state: 'ran', commands: [{ command: 'npm install p-retry@6.2.0', ok: true, exitCode: null }] } },
        { state: 'outside-turns', alsoTurns: [], detail: 'This change first appears in the working tree since the last snapshot, after turn 2.' },
        { state: 'turn', turn: 1, fromCheckpoint: 2, toCheckpoint: 3, alsoTurns: [2], detail: "Turn 1's snapshots are the first to show this change.", install: { state: 'none-recorded' } },
      ] }] };
  const over = {
    'sessions.list': [session],
    'attention.list': [{ sessionId: 's1', kind: 'finished', transitionId: 't1', since: now - 5 * M, label: 'Finished', detail: null, tool: null, projectName: 'storefront' }],
    'checkpoints.list': checkpoints,
    'checkpoints.diff': { from: 'b'.repeat(40), to: 'c'.repeat(40), files: [{ path: 'package.json', status: 'M' }, { path: 'src/retry.ts', status: 'A' }], totalFiles: 2, truncated: false, patch },
    'code.changes': { isRepo: true, branch: 'main', headMoved: false, commits: 0, attributed: true, unreadable: null,
      files: files.map((x) => ({ path: x.path, index: ' ', work: x.status === 'M' ? 'M' : '?', staged: false, untracked: x.status !== 'M', preexisting: false })) },
    'code.diff': patch, 'code.editors': [],
    'sessions.baseline': { head: BASE, dirty: [], at: now - 3 * H },
    'sessions.scrollback': 'Wanigan renderer fixture — no live provider\r\n',
    'reviewWork.work': work,
    'reviewWork.fileDiff': patch,
    'reviewWork.patch': { patch, truncated: false },
    'reviewWork.turnStats': { 1: { files: 1, added: 2, removed: 1 }, 2: { files: 2, added: 26, removed: 0 } },
    'reviewWork.summaries': {},
    'reviewWork.dependencies': dependencies,
    'reviewWork.claims': { state: 'no-message', reason: 'No final message was archived for this session yet.' },
    'depth.maintainability': { state: 'no-checkpoints', detail: 'Not measured in this probe.', base: null, latest: null, latestTurn: null, latestAt: null, changedFiles: 0, report: null },
    'deps.advisorySetting': { enabled: ${advisoriesOn ? 'true' : 'false'} },
    'deps.setAdvisoryLookup': (on) => ({ enabled: on === true }),
    'deps.advisories': (_sid, opts) => (opts && opts.lookup ? LOOKUP : CACHED),
  };
  const wrap = (parts) => new Proxy(function () {}, {
    get(_t, prop) { if (prop === 'then' || typeof prop !== 'string') return undefined; return wrap([...parts, prop]); },
    apply(_t, _this, callArgs) {
      const key = parts.join('.');
      if (Object.prototype.hasOwnProperty.call(over, key)) {
        const v = over[key];
        return Promise.resolve(typeof v === 'function' ? v(...callArgs) : JSON.parse(JSON.stringify(v)));
      }
      let target = base;
      for (const p of parts) target = target[p];
      return target(...callArgs);
    },
  });
  window.wanigan = wrap([]);
})();
`;

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
    document.documentElement.dataset.themePreference = t;
    document.documentElement.style.colorScheme = t;
    window.dispatchEvent(new CustomEvent('wanigan:theme-changed', { detail: { preference: t, resolved: t } }));
  }, theme);
  await page.waitForTimeout(300);
}

async function chord(page, keys) {
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.keyboard.press(keys);
  await page.waitForTimeout(900);
}

/** Present, sized, no raw values, and nothing a reader needs clipped sideways. */
async function inspect(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { present: false };
    const r = el.getBoundingClientRect();
    const clipped = [...el.querySelectorAll('.mark, .mono, button, dt, dd, p, span')]
      .filter((node) => node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflow !== 'visible').length;
    const overflowX = el.scrollWidth > el.clientWidth + 1;
    return { present: true, width: Math.round(r.width), height: Math.round(r.height), clipped, overflowX, bad: /\bNaN\b|\bundefined\b|\[object Object\]|Invalid Date|\bnull\b/.test(el.innerText), text: el.innerText.slice(0, 8000) };
  }, selector);
}

async function expectElement(page, theme, what, selector) {
  const s = await inspect(page, selector);
  if (BEFORE) { check(!s.present, `${theme} · ${what}: absent before the change`, s); return s; }
  check(s.present && s.width > 0 && s.height > 0, `${theme} · ${what}: rendered`, s);
  check(s.present && s.clipped === 0 && !s.overflowX, `${theme} · ${what}: nothing a reader needs is clipped`, s);
  check(s.present && !s.bad, `${theme} · ${what}: no NaN/undefined/null/[object Object] on screen`, s);
  return s;
}

async function capture(page, name, theme, locator) {
  await page.waitForTimeout(250);
  const file = path.join(OUT, `${name}-${theme}.png`);
  if (locator) {
    const box = await locator.boundingBox();
    const vp = page.viewportSize();
    if (box) {
      const y = Math.max(0, box.y - 12);
      await page.screenshot({ path: file, clip: { x: Math.max(0, box.x - 12), y, width: Math.min(vp.width - Math.max(0, box.x - 12), box.width + 24), height: Math.min(vp.height - y, box.height + 24) } });
    } else await page.screenshot({ path: file });
  } else await page.screenshot({ path: file });
  shots.push({ file: path.relative(REPO, file), theme, bodyBackground: await page.evaluate(() => getComputedStyle(document.body).backgroundColor) });
}

async function openCodeRail(page) {
  await chord(page, 'Meta+1');
  await page.locator('.sessions-view').first().waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Code', exact: true }).first().click();
  await page.locator('.code-panel').first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(1200);
}

/** The code rail's view pane scrolls; bring the Dependencies section to its top. */
async function scrollDeps(page, selector) {
  await page.evaluate((sel) => {
    const el = [...document.querySelectorAll('details.rw-section')].find((d) => d.querySelector('summary')?.textContent?.startsWith('Dependencies'));
    const target = sel ? el?.querySelector(sel) ?? el : el;
    target?.scrollIntoView({ block: 'start' });
  }, selector ?? null);
  await page.waitForTimeout(300);
}

for (const theme of ['dark', 'light']) {
  console.log(`── ${theme}${BEFORE ? ' (before)' : ''}`);

  /* The code rail with advisory lookups on. */
  {
    const { page, close } = await openRenderer({ theme, width: 1440, height: 2000, onError, instrument: INSTRUMENT(true) });
    try {
      await setTheme(page, theme);
      check(true, `${theme} · palette applied (body ${await page.evaluate(() => getComputedStyle(document.body).backgroundColor)})`);
      await openCodeRail(page);
      const deps = page.locator('details.rw-section').filter({ hasText: /^Dependencies/ }).first();
      check(await deps.count() === 1, `${theme} · the Dependencies section rendered in the code rail`);
      await scrollDeps(page);
      await expectElement(page, theme, 'turn attribution on dependency rows', '.rw-dep-origin');
      if (!BEFORE) {
        const text = (await deps.innerText()).replace(/\s+/g, ' ');
        check(/left-pad 1\.3\.0 · dependencies before the first checkpoint/.test(text), `${theme} · a package already there at launch says "before the first checkpoint"`, text);
        check(/p-retry 6\.2\.0 · dependencies turn 2 ↗ an install command ran in that turn: npm install p-retry@6\.2\.0\./.test(text), `${theme} · p-retry names turn 2 with its install command`, text);
        check(/zod 3\.23\.8 · dependencies outside the recorded turns · This change first appears in the working tree since the last snapshot, after turn 2\./.test(text), `${theme} · a change after the last snapshot is outside the recorded turns and says where`, text);
        check(/turn 1 ↗ no install command is recorded in that turn\. Also changed in turn 2\./.test(text), `${theme} · an upgrade touched twice names both turns`, text);
        check(await page.getByRole('button', { name: "Open turn 2's diff" }).count() === 1, `${theme} · the turn jump is a button with an accessible name`);
        check(!/No registry or advisory lookup was made/.test(text), `${theme} · the old "no lookup was made" sentence is gone`);
        check(/No advisory lookup has been made for these packages yet\./.test(text) && await page.getByRole('button', { name: 'Check advisories' }).count() === 1,
          `${theme} · before a check the section says none was made and offers the button`, text);
      } else {
        check(/No registry or advisory lookup was made/.test(await deps.innerText()), `${theme} · before: the section ends by saying no lookup was made`);
      }
      await capture(page, 'code-rail-dependencies', theme, deps);

      if (!BEFORE) {
        await page.getByRole('button', { name: 'Check advisories' }).click();
        await page.locator('.rw-adv-list').waitFor({ timeout: 5000 });
        await page.waitForTimeout(400);
        const adv = await expectElement(page, theme, 'advisory results', '.rw-adv');
        const names = await page.locator('.rw-adv-row .rw-adv-head .mono').allInnerTexts();
        check(names[0] === 'flatmap-stream@0.1.1' && names[1] === 'lodash@4.17.15', `${theme} · the malware advisory is listed first, then the package with advisories`, names);
        const firstIds = await page.locator('.rw-adv-row').first().locator('.rw-adv-ids button').allInnerTexts();
        check(/^malware · MAL-2025-20690/.test(firstIds[0] ?? ''), `${theme} · within the package the MAL- id comes first and is named malware`, firstIds);
        const text = (adv.text ?? '').replace(/\s+/g, ' ');
        check(/new, review p-retry@6\.2\.0.*published 30 h ago — under 72 hours, so review it before trusting it/.test(text), `${theme} · a version published 30 h ago is flagged new, review, from the publish time read`, text);
        check(/OSV lists no advisory for this version — not a finding that it is safe, or even that the package exists/.test(text), `${theme} · none listed is not worded as safe`, text);
        check(/unknown: OSV is limiting requests \(HTTP 429\); it asks to wait 30 s\./.test(text), `${theme} · a rate-limited lookup is unknown with its reason`, text);
        check(/checked 3 h ago, from an earlier check/.test(text), `${theme} · a cached answer shows its age`, text);
        check(/not looked up: a requirement, not an exact version/.test(text), `${theme} · a Cargo requirement says why it was not looked up`, text);
        check(/This check sent 1 request to api\.osv\.dev, 3 requests to registry\.npmjs\.org, 1 request to pypi\.org\./.test(text), `${theme} · the requests this check sent are counted per host`, text);
        check(/npm advisories covered/.test(text) && /PyPI advisories error/.test(text) && /crates\.io advisories covered .* publish time not covered/.test(text), `${theme} · coverage is shown per ecosystem`, text.slice(text.indexOf('npm advisories')));
        check(!/\bsafe\b(?!, or even)/.test(text.replace('not a finding that it is safe', '')), `${theme} · nothing on the panel calls a package safe`);
        await scrollDeps(page, '.rw-adv');
        await capture(page, 'code-rail-advisories', theme, page.locator('.rw-adv'));
        await scrollDeps(page, '.rw-adv-coverage');
        await capture(page, 'code-rail-advisory-coverage', theme, page.locator('.rw-adv-coverage'));
      }

      /* The jump to the turn's diff. */
      const jump = page.getByRole('button', { name: "Open turn 2's diff" });
      if (!BEFORE) {
        await jump.click();
        await page.waitForTimeout(900);
        const selected = await page.locator('.code-file.on').allInnerTexts();
        check(selected.some((t) => /Turn 2/.test(t)), `${theme} · the jump opens the Turns tab on turn 2`, selected);
        check(await page.locator('.code-tab.on').filter({ hasText: 'Turns' }).count() === 1 && await page.locator('pre.diff, .review-diff').first().count() === 1,
          `${theme} · turn 2's diff is on screen`);
      } else {
        await page.getByRole('button', { name: /^Turns/ }).first().click().catch(() => {});
        await page.waitForTimeout(600);
        await page.locator('.code-file').filter({ hasText: 'Turn 2' }).first().click().catch(() => {});
        await page.waitForTimeout(600);
        check(await jump.count() === 0, `${theme} · before: no dependency row offers a jump to its turn`);
      }
      await capture(page, 'turn-jump', theme, page.locator('.code-panel').first());
    } finally { await close(); }
  }

  /* Lookups off: the section says so and offers no button; Settings has the switch. */
  {
    const { page, close } = await openRenderer({ theme, width: 1440, height: 2000, onError, instrument: INSTRUMENT(false) });
    try {
      await setTheme(page, theme);
      if (!BEFORE) {
        await openCodeRail(page);
        await scrollDeps(page, '.rw-adv');
        const off = await expectElement(page, theme, 'advisories while lookups are off', '.rw-adv');
        check(/Lookups are off\. Turn on “Dependency advisory lookups” in Settings to check these packages against OSV\./.test(off.text ?? '') && await page.getByRole('button', { name: 'Check advisories' }).count() === 0,
          `${theme} · with the switch off there is no button, only where to turn it on`, off.text);
        await capture(page, 'advisories-off', theme, page.locator('.rw-adv'));
      }

      await chord(page, 'Meta+,');
      await page.locator('#settings-tab-privacy').click();
      await page.locator('#settings-privacy').waitFor({ state: 'visible' });
      await page.waitForTimeout(800);
      const row = page.locator('.set-row').filter({ hasText: 'Dependency advisory lookups' }).first();
      if (BEFORE) {
        check(await row.count() === 0, `${theme} · before: Settings has no advisory switch`);
        const status = page.locator('.set-row').filter({ hasText: 'Provider status checks' }).first();
        await status.scrollIntoViewIfNeeded().catch(() => {});
        await capture(page, 'settings-observation', theme, (await status.count()) ? status : undefined);
      } else {
        await row.scrollIntoViewIfNeeded();
        await page.waitForTimeout(250);
        const text = (await row.innerText()).replace(/\s+/g, ' ');
        const sw = row.getByRole('switch', { name: 'Dependency advisory lookups' });
        check(await sw.getAttribute('aria-checked') === 'false', `${theme} · the switch reads off`);
        check(/api\.osv\.dev/.test(text) && /registry\.npmjs\.org/.test(text) && /pypi\.org/.test(text), `${theme} · the switch text names all three hosts`, text);
        check(/the package ecosystem, name and version of each package that session added or upgraded — nothing else/.test(text) && /nothing is looked up automatically/.test(text),
          `${theme} · it says exactly what is sent, and that nothing runs on its own`, text);
        const fit = await row.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
        check(fit.scroll <= fit.client + 1, `${theme} · the switch row is not clipped`, fit);
        await capture(page, 'settings-observation', theme, row);
        await sw.click();
        await page.waitForTimeout(300);
        check(await sw.getAttribute('aria-checked') === 'true', `${theme} · pressing it turns it on through the bridge`);
      }
    } finally { await close(); }
  }
}

check(errors.length === 0, 'no page errors while driving the views', errors.slice(0, 5));
writeFileSync(path.join(OUT, 'verification.json'), `${JSON.stringify({
  probe: 'scripts/probe-helper-p11-deps.mjs',
  mode: BEFORE ? 'before' : 'after',
  commit: execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD']).toString().trim(),
  uncommittedChanges: execFileSync('git', ['-C', REPO, 'status', '--porcelain', '--', 'src']).toString().trim().split('\n').filter(Boolean).length,
  renderer: 'out/renderer, served by scripts/renderer-harness.mjs in Chromium with the preload bridge stubbed',
  checks: results,
  shots,
}, null, 2)}\n`);
console.log(`\n${results.length - failures} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
