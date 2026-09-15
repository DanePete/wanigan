#!/usr/bin/env node
// Helper sweep · P10 · agents explain their own diff. The code rail's count of
// notes written by the agent, each note under the lines it covers with its
// mark and the session's title, "the code changed since this note", the guided
// walk driven from the keyboard, "Make it my review note" landing in the
// operator's tray as a quote, and Dismiss note. Actual renderer, isolated
// Electron, synthetic sessions and services, no real agent calls. The
// main-process half — the MCP tools over loopback with real per-launch tokens,
// hunk containment against a real diff, redaction, the limit, grants and the
// SQL trace that proves no review-mark table is touched — runs in
// src/main/smoke39.ts.
//
//   npm run build && node scripts/probe-helper-p10-notes.mjs [--before] [--out dir]
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
  : path.join(root, 'docs/visuals/helper-p10-notes', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });

const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-p10-notes-'));
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
  // Tall enough that the rail's verdict, notes bar and scopes leave the diff room.
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

    // The notes as main returns them: walk order, staleness decided in main.
    const current = { state: 'current', stale: false, because: 'The lines still read as they did when the note was written.' };
    const note = (id, p, side, startLine, endLine, body, quote, over = {}) => Object.assign({ id, path: p, side, startLine, endLine, body, quote, quoteOmitted: 0,
      hunkHeader: '@@', createdAt: now - 300_000, dismissedAt: null, quotedAt: null, staleness: current }, over);
    const notes = [
      note('cn_00000000000000a1', 'package.json', 'new', 5, 5,
        'p-retry rather than our own backoff: it honours Retry-After, which the payment gateway sends with every 429.', ['+    "p-retry": "6.2.0"']),
      note('cn_00000000000000a2', 'src/checkout.test.ts', 'new', 11, 11,
        'Skipped until the payment sandbox supports idempotency keys. The retry path is covered by the new charges-once test.', ["+  it.skip('retries', () => {"],
        { staleness: { state: 'lines-changed', stale: true, because: 'The new line 11 reads differently from when the note was written.' } }),
      note('cn_00000000000000a3', 'src/checkout.ts', 'new', 2, 3,
        'Returning the stored payment is what makes a retried checkout charge once. The key comes from the caller, so a double-click reuses it.',
        ['+  const existing = payments.get(key);', '+  if (existing) return existing;']),
    ];
    const state = { sessionId: 's1', sessionTitle: 'Make checkout retries safe', base: BASE, notes, withdrawn: 1, written: 4, limit: 60, toolGranted: true, unreadable: null };
    window.__dismissed = []; window.__quoted = []; window.__writes = [];
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
      changeNotes: {
        list: async (sessionId) => structuredClone({ ...state, sessionId }),
        dismiss: async (sessionId, id) => { window.__dismissed.push([sessionId, id]); const n = notes.find((x) => x.id === id); n.dismissedAt = Date.now(); return { id, at: n.dismissedAt }; },
        quote: async (sessionId, id) => { window.__quoted.push([sessionId, id]); const n = notes.find((x) => x.id === id); n.quotedAt = Date.now(); return { id, at: n.quotedAt }; },
      },
    };
    window.wanigan = new Proxy(api, { get(target, service) { return service in services ? services[service] : target[service]; } });
  });

  // A full-window shot, and the code rail at full resolution: the rail is a few
  // hundred pixels wide, and its text is hard to read in a whole window.
  const shoot = async (name) => {
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      await page.waitForTimeout(150);
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const file = path.join(out, `${name}-${theme}.png`);
      await page.screenshot({ path: file, scale: 'css' });
      shots.push({ file: path.relative(root, file), theme, bodyBackground: bg });
      const detail = path.join(out, `${name}-detail-${theme}.png`);
      await page.locator('.code-panel:visible').first().screenshot({ path: detail, scale: 'css' });
      shots.push({ file: path.relative(root, detail), theme, bodyBackground: bg, element: true });
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
  /** The element's box lies inside the rail's visible box, so nothing a reader must read is cut off at its edge. */
  const insideRail = async (locator, what) => {
    const [box, rail] = await Promise.all([locator.boundingBox(), page.locator('.code-panel:visible').first().boundingBox()]);
    assert(box && rail && box.x >= rail.x - 1 && box.x + box.width <= rail.x + rail.width + 1, `${what} fits inside the rail: ${JSON.stringify({ box, rail })}`);
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
    await page.waitForTimeout(600);
    assert.equal(await page.locator('.an-bar').count(), 0, 'the base build has no notes from the agent in the rail');
    assert.equal(await page.getByRole('button', { name: "Walk the agent's notes" }).count(), 0);
    assert.equal(await page.locator('.an-inline').count(), 0);
    await shoot('code-rail');
    record('before: the code rail shows the verdict, the file list and the diff, with nothing the agent wrote about its own change');
  } else {
    /* ── the bar ── */
    const bar = page.getByRole('region', { name: "The agent's notes" });
    await bar.getByText('3 notes written by the agent').waitFor();
    const barText = await noRawValues(bar, 'the notes bar');
    assert.match(barText, /1 where the code changed since/);
    assert.match(barText, /1 withdrawn by the agent/);
    await notClipped(bar.locator('.an-bar-line'), 'the notes bar line');
    record('the rail counts "3 notes written by the agent", one where the code changed since, and the one the agent withdrew');

    /* ── a note under its lines ── */
    const inline = page.getByRole('complementary', { name: 'Note written by the agent on src/checkout.ts, new lines 2–3' });
    await inline.waitFor();
    const inlineText = await noRawValues(inline, 'the inline note');
    assert.match(inlineText, /written by the agent/);
    assert.match(inlineText, /Make checkout retries safe/);
    assert.match(inlineText, /Returning the stored payment is what makes a retried checkout charge once/);
    assert.doesNotMatch(inlineText, /code changed since/);
    const placed = await page.evaluate(() => {
      const aside = document.querySelector('aside.an-inline');
      const prev = aside?.previousElementSibling;
      return { prevText: prev?.textContent ?? '', prevNoted: prev?.classList.contains('an-noted') ?? false,
        covered: [...document.querySelectorAll('pre.diff .dl.an-noted')].map((el) => el.textContent) };
    });
    assert.equal(placed.prevText, '+  if (existing) return existing;', 'the note sits under the last line it covers');
    assert.deepEqual(placed.covered, ['+  const existing = payments.get(key);', '+  if (existing) return existing;'], 'exactly the covered lines carry the agent rule');
    await insideRail(inline, 'the inline note');
    await notClipped(inline.locator('.an-body'), 'the note body');
    await inline.scrollIntoViewIfNeeded();
    await shoot('inline-note');
    record('a note sits under the last line it covers, marked "written by the agent" with the session title, and only its two lines carry the agent rule');

    /* ── the list, and a stale note ── */
    await bar.locator('summary').click();
    const listText = await noRawValues(bar.locator('.an-list'), 'the list of notes');
    assert.match(listText, /All notes from Make checkout retries safe, in file order/);
    assert.match(listText, /package\.json new line 5 .*src\/checkout\.test\.ts new line 11 .*the code changed since this note.*src\/checkout\.ts new lines 2–3/);
    await bar.getByRole('button', { name: /src\/checkout\.test\.ts/ }).click();
    const stale = page.getByRole('complementary', { name: 'Note written by the agent on src/checkout.test.ts, new line 11' });
    await stale.getByText('the code changed since this note').waitFor();
    assert.match(await stale.innerText(), /The new line 11 reads differently from when the note was written\./);
    await insideRail(stale, 'the stale note');
    await stale.scrollIntoViewIfNeeded();
    await shoot('stale-note');
    await bar.locator('summary').click();
    record('the list runs in file order; opening the test file\'s note shows "the code changed since this note" with the reason');

    /* ── the walk, from the keyboard ── */
    await bar.getByRole('button', { name: "Walk the agent's notes", exact: true }).click();
    const walk = page.getByRole('region', { name: "Walking the agent's notes" });
    await walk.getByText('Note 1 of 3').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('an-walk')), true, 'the walk takes focus so the keys work at once');
    assert.match(await walk.innerText(), /package\.json/);
    await page.locator('.code-file.on').filter({ hasText: 'package.json' }).waitFor();
    await page.getByRole('complementary', { name: 'Note written by the agent on package.json, new line 5' }).and(page.locator('.an-current')).waitFor();
    await noRawValues(walk, 'the walk');
    await notClipped(walk.locator('.an-walk-line'), 'the walk line');
    await shoot('walk-1');
    await page.keyboard.press('ArrowRight');
    await walk.getByText('Note 2 of 3').waitFor();
    await page.locator('.code-file.on').filter({ hasText: 'src/checkout.test.ts' }).waitFor();
    assert.match(await walk.innerText(), /the code changed since this note/);
    await page.keyboard.press('j');
    await walk.getByText('Note 3 of 3').waitFor();
    await page.locator('.code-file.on').filter({ hasText: 'src/checkout.ts' }).waitFor();
    await page.locator('aside.an-inline.an-current[data-agent-note="cn_00000000000000a3"]').waitFor();
    assert.equal(await walk.getByRole('button', { name: 'Next →' }).isDisabled(), true, 'the last note has no next');
    await shoot('walk-3');
    await page.keyboard.press('k');
    await walk.getByText('Note 2 of 3').waitFor();
    await page.keyboard.press('ArrowLeft');
    await walk.getByText('Note 1 of 3').waitFor();
    await page.keyboard.press('Escape');
    await bar.waitFor();
    assert.equal(await walk.count(), 0);
    record('Walk the agent\'s notes opens each file\'s diff at its note in file and line order; → and j step forward, ← and k back, Esc ends it');

    /* ── the operator's copy ── */
    await page.locator('.code-file').filter({ hasText: 'src/checkout.ts' }).first().click();
    await inline.waitFor();
    await inline.getByRole('button', { name: 'Make it my review note', exact: true }).click();
    const tray = page.getByRole('region', { name: 'Review notes' });
    await tray.getByText('1 review note').waitFor();
    const trayText = await noRawValues(tray, 'the review tray');
    assert.match(trayText, /src\/checkout\.ts, lines 2–3: Quoted from the agent's own note on this change \(Make checkout retries safe\): > Returning the stored payment/);
    assert.deepEqual(await page.evaluate(() => window.__quoted), [['s1', 'cn_00000000000000a3']]);
    await inline.getByText('quoted into your review notes').waitFor();
    await page.getByText(/Copied into your review notes as your own note, marked as quoted from the agent\./).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__writes), [], 'nothing was typed into the terminal');
    // Both rules on a line the operator and the agent both noted, neither hiding the other.
    const both = await page.evaluate(() => [...document.querySelectorAll('pre.diff .dl.an-noted.review-noted')].map((el) => {
      const cs = getComputedStyle(el);
      return { text: el.textContent, shadow: cs.boxShadow, image: cs.backgroundImage };
    }));
    assert.equal(both.length, 2, 'the two quoted lines carry both the operator\'s and the agent\'s rule');
    assert(both.every((b) => b.shadow !== 'none' && b.image.includes('linear-gradient')), `both rules paint: ${JSON.stringify(both)}`);
    await inline.scrollIntoViewIfNeeded();
    await shoot('quoted');
    record('"Make it my review note" puts a note in the operator\'s own tray that says it quotes the agent, records the quote, and sends nothing');

    /* ── dismissing ── */
    const pkgInline = page.getByRole('complementary', { name: 'Note written by the agent on package.json, new line 5' });
    await page.locator('.code-file').filter({ hasText: 'package.json' }).first().click();
    await pkgInline.getByRole('button', { name: 'Dismiss note', exact: true }).click();
    await bar.getByText('2 notes written by the agent').waitFor();
    assert.match(await bar.innerText(), /1 dismissed/);
    assert.equal(await pkgInline.count(), 0, 'a dismissed note leaves the diff');
    assert.deepEqual(await page.evaluate(() => window.__dismissed), [['s1', 'cn_00000000000000a1']]);
    await bar.locator('summary').click();
    assert.match(await bar.locator('.an-list').innerText(), /package\.json\s+new line 5\s+–\s*dismissed/);
    await shoot('dismissed');
    record('Dismiss note records the dismissal, takes the note out of the diff and the walk, and the list keeps it marked dismissed');
  }

  assert.deepEqual(errors, []);
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({
    at: new Date().toISOString(),
    provenance: 'Actual Electron renderer from out/renderer of the checkout this script ran in; synthetic sessions, review and change-note services; no real agent calls',
    mode: before ? 'before' : 'after',
    commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(),
    uncommittedChanges: execFileSync('git', ['-C', root, 'status', '--porcelain', '--', 'src']).toString().trim().split('\n').filter(Boolean).length,
    checks, errors, shots,
  }, null, 2) + '\n');
} finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
