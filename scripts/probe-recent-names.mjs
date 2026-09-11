#!/usr/bin/env node
// Prove that Recent now says what a past conversation was about — and that the
// name fits on its line.
//
// Why this exists rather than a unit test: the reader is covered in the fast
// lane and the smoke suite, but neither can see a ninety-character title
// wrapping a row to three lines, pushing the timestamp off screen, or landing
// identically on four sibling conversations. Every visual defect found while
// this app was being built was found by running it.
//
// It runs against a COPY of the real database, because the honest question is
// not "does a fixture resolve" but "how many of the operator's own forty-nine
// conversations get a name, and do those names fit". Nothing is written to the
// real profile: the copy is the app's whole world for the run, and no agent is
// launched.
//
// Usage:  npm run build && node scripts/probe-recent-names.mjs [--out docs/shots/recent]
import { mkdtempSync, mkdirSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { launchWanigan } from './electron-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const OUT = path.resolve(REPO, outArg >= 0 ? args[outArg + 1] : 'docs/shots/recent');

let electron;
try { ({ _electron: electron } = require('playwright-core')); }
catch { console.error('playwright-core is not resolvable; run `npm i -D playwright-core`.'); process.exit(2); }
if (!existsSync(path.join(REPO, 'out/main/index.js'))) {
  console.error('No build in out/. Run `npm run build` first.');
  process.exit(2);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];

mkdirSync(OUT, { recursive: true });
const udd = mkdtempSync(path.join(tmpdir(), 'wanigan-recent-'));

// The real profile is read once, here, and never opened by the app.
const realDb = path.join(homedir(), 'Library/Application Support/wanigan/wanigan.db');
let seeded = false;
if (existsSync(realDb)) {
  // dataDir() is app.getPath('userData'), which --user-data-dir sets directly.
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(realDb + suffix)) copyFileSync(realDb + suffix, path.join(udd, `wanigan.db${suffix}`));
  }
  seeded = true;
}

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`);
  if (!ok) {
    failures += 1;
    if (detail !== undefined) {
      const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
      console.log(`      ${String(text).slice(0, 600)}`);
    }
  }
};

const { app, page } = await launchWanigan(electron, { root: REPO, userData: udd, env });
try {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForSelector('.nav-tabs, .sidebar, nav', { timeout: 120_000 });

  const tab = page.locator('nav button, nav a', { hasText: /^\s*Sessions\b/ }).first();
  if (await tab.count()) await tab.click();
  // Recent lives inside the session picker, which collapses at narrow widths
  // and is aria-hidden while closed. Open it if this viewport collapsed it.
  await page.waitForSelector('.session-rail', { state: 'attached', timeout: 60_000 });
  if (await page.locator('.sessions--compact-picker:not(.sessions--picker-open)').count()) {
    const opener = page.locator('[aria-controls="wanigan-session-picker"], .session-picker-open-btn').first();
    if (await opener.count()) await opener.click();
  }
  await page.waitForSelector('.past-row', { state: 'attached', timeout: 60_000 });

  const seen = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.past-row')].map((row) => {
      const name = row.querySelector('.past-name');
      const meta = row.querySelector('.past-meta');
      const detail = row.querySelector('.past-meta-detail');
      const when = row.querySelector('.past-when');
      const linesOf = (el) => {
        if (!el) return 0;
        const style = getComputedStyle(el);
        const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
        return line ? Math.round(el.getBoundingClientRect().height / line) : 0;
      };
      return {
        name: name?.textContent?.trim() ?? '',
        meta: meta?.textContent?.trim() ?? '',
        detail: detail?.textContent?.trim() ?? '',
        when: when?.textContent?.trim() ?? '',
        // Anything that wraps is taller than one line of its own type.
        lines: linesOf(name),
        metaLines: linesOf(detail),
        clipped: name ? name.scrollWidth > name.clientWidth + 1 : false,
        // The timestamp is the one thing that must never be shortened away.
        whenClipped: when ? when.scrollWidth > when.clientWidth + 1 : false,
        whenVisible: when ? when.getBoundingClientRect().width > 0 : false,
        height: row.getBoundingClientRect().height,
        // Nothing may extend past the row it belongs to.
        overflowsRow: name && row ? name.getBoundingClientRect().right > row.getBoundingClientRect().right + 1 : false,
        tip: row.querySelector('.past-main')?.getAttribute('title') ?? '',
      };
    });
    const rail = document.querySelector('.session-rail');
    const first = document.querySelector('.past-row');
    const share = first
      ? Math.round((first.querySelector('.past-main').getBoundingClientRect().width
          / first.getBoundingClientRect().width) * 100)
      : 0;
    return {
      rows,
      mainShare: share,
      railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
      scrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });

  console.log(`\n── Recent, ${seen.rows.length} rows, from a copy of the real profile`);
  check(seen.rows.length > 0, 'Recent rendered rows at all', seen.rows.length);

  // The complaint, measured. A row whose name is the folder it ran in tells you
  // nothing the row beside it does not also tell you — that was 44 of 49 rows.
  // The meta line's first segment is that folder, so the comparison is against
  // what the row used to say rather than against a number typed in here.
  const bare = (r) => r.name.replace(/^\u2605\s*/, '').trim();
  const folderOf = (r) => (r.meta.split('·')[0] ?? '').trim();
  const informative = seen.rows.filter((r) => bare(r) && bare(r) !== folderOf(r));
  const share = Math.round((informative.length / seen.rows.length) * 100);
  console.log(`     rows saying more than their folder: ${informative.length}/${seen.rows.length} (${share}%)`);
  check(seeded ? informative.length > 0 : true,
    'conversations carry a name, not just the folder they ran in', informative.length);

  const distinct = new Set(seen.rows.map((r) => r.name));
  check(distinct.size > 1 || seen.rows.length <= 1,
    'the rows are no longer interchangeable — the names differ from each other',
    [...distinct].slice(0, 6));

  const wrapped = seen.rows.filter((r) => r.lines > 1);
  check(wrapped.length === 0,
    'no name wraps its row to a second line, so the timestamp beneath it stays put',
    wrapped.map((r) => `${r.lines} lines: ${r.name}`).slice(0, 4));

  // The regression this probe was extended to catch. Adding the project name
  // to the second line pushed it to three wrapped lines in a 240px rail, which
  // is a third of the conversations that used to fit on screen — a defect no
  // unit test can see and the first screenshot showed immediately.
  const wrappedMeta = seen.rows.filter((r) => r.metaLines > 1);
  check(wrappedMeta.length === 0,
    `no row's detail line wraps either, so a row stays two lines in a ${seen.railWidth}px rail`,
    wrappedMeta.map((r) => `${r.metaLines} lines: ${r.detail}`).slice(0, 4));

  const tallest = Math.max(...seen.rows.map((r) => r.height));
  check(tallest <= 72, 'the tallest row still fits the two-line shape', `${Math.round(tallest)}px`);

  check(seen.rows.every((r) => r.whenVisible && !r.whenClipped),
    'every row still shows its full timestamp — the detail clips, the time never does',
    seen.rows.filter((r) => !r.whenVisible || r.whenClipped).map((r) => r.when).slice(0, 4));

  // The row belongs to the conversation, not to three occasional controls that
  // were holding 71px of 231 permanently.
  console.log(`     the row's text gets ${seen.mainShare}% of its width`);
  check(seen.mainShare >= 90,
    'the conversation’s own name and detail get the row, not two thirds of it',
    `${seen.mainShare}%`);

  // Hiding them must not strand them: opacity hides, it does not un-focus.
  const keyboard = await page.evaluate(async () => {
    const row = document.querySelector('.past-row');
    const pin = row.querySelector('.past-actions button');
    pin.focus();
    await new Promise((r) => requestAnimationFrame(r));
    return {
      focused: document.activeElement === pin,
      visible: parseFloat(getComputedStyle(row.querySelector('.past-actions')).opacity) > 0.9,
      named: !!pin.getAttribute('aria-label'),
    };
  });
  check(keyboard.focused && keyboard.named,
    'the row’s actions are still reachable by keyboard and still named', keyboard);
  check(keyboard.visible,
    'and tabbing to one brings it back into view rather than focusing something invisible', keyboard);

  const spilled = seen.rows.filter((r) => r.overflowsRow);
  check(spilled.length === 0, 'no name paints outside the row it belongs to', spilled.map((r) => r.name).slice(0, 4));
  check(!seen.scrolls, 'the window gained no horizontal scrollbar');

  const clipped = seen.rows.filter((r) => r.clipped);
  check(clipped.every((r) => r.tip.includes(r.name.replace(/^★\s*/, '').slice(0, 20))),
    'every clipped name is readable in full from the row’s own tooltip',
    clipped.slice(0, 2).map((r) => ({ name: r.name, tip: r.tip })));

  // Provenance. A name has exactly two legal origins: read from a transcript,
  // which the tooltip must credit, or typed by the operator, which needs no
  // credit and leaves the tooltip as the plain resume line. A third state — a
  // name lifted from a transcript and shown as though somebody had chosen it —
  // is the one this excludes.
  const uncredited = informative.filter((r) =>
    !/the agent’s own name|the first thing asked/.test(r.tip)
    && !/^Resume this exact conversation/.test(r.tip));
  check(uncredited.length === 0,
    'a name read from a transcript always says whose words it is',
    uncredited.slice(0, 3).map((r) => ({ name: r.name, tip: r.tip })));

  await page.screenshot({ path: path.join(OUT, 'recent-named-dark.png') });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, 'recent-named-light.png') });
  console.log(`\n  captures: ${path.relative(REPO, OUT)}/recent-named-{dark,light}.png`);
  console.log('\n  first rows as rendered:');
  for (const r of seen.rows.slice(0, 10)) console.log(`    ${r.name}\n      ${r.meta}`);
} catch (error) {
  check(false, 'the Recent names probe completed', error?.stack ?? error?.message ?? error);
} finally {
  await app.close();
  try { rmSync(udd, { recursive: true, force: true }); } catch { /* a temp dir the OS will reap */ }
}

console.log(failures === 0 ? '\n════ Recent names probe passed ════' : `\n════ ${failures} failed ════`);
process.exit(failures === 0 ? 0 : 1);
