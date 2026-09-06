#!/usr/bin/env node
/*
 * Every chord the cheat sheet prints, pressed in the running renderer.
 *
 * bindings.ts states the invariant this enforces: "a chord the sheet prints is
 * a chord that works, and a chord that works is one the sheet prints." Nothing
 * checked it, and it was not true. The session tabs printed ⌘1 / ⌘2 / ⌘3 and the
 * status bar said "⌘1–9 switch", while the shell had already bound ⌘1–9 to the
 * view routes on window in the capture phase with stopPropagation — so the
 * bubble-phase listener in Sessions that would have honoured them could never
 * run. Reading the two files did not show it. Pressing the key did.
 *
 * Two checks, and both matter:
 *
 *   1. COMPLETENESS. Every id in BINDINGS has an entry below. A chord added to
 *      the table without a probe fails here, so the sheet cannot grow a claim
 *      nobody pressed.
 *   2. EFFECT. Each chord is pressed with focus where its scope says it belongs,
 *      and the page is asked whether the stated thing happened. Where the effect
 *      is not observable in the DOM the probe falls back to asserting the event
 *      was consumed — weaker, and marked as such in the output.
 *
 * What it cannot check: anything the main process does. Every window.wanigan
 * call is stubbed. A chord that reaches IPC is verified as far as the bridge and
 * no further.
 *
 * Usage:  npm run build && node scripts/probe-chords.mjs [--verbose]
 * Exit 0 when every chord passes, 1 otherwise.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRenderer } from './renderer-harness.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');

/* ── what the table says, read from the table ───────────────────────────
   Parsed rather than imported: bindings.ts is renderer TypeScript and this is a
   plain node script. The shape it reads is one line per row, which is how that
   file is written and how it should stay. */
function declaredBindings() {
  const src = fs.readFileSync(path.join(REPO, 'src/renderer/src/bindings.ts'), 'utf8');
  const body = src.slice(src.indexOf('export const BINDINGS'), src.indexOf('/** The sheet lists groups'));
  return [...body.matchAll(/\{\s*id:\s*'([a-z-]+)',\s*keys:\s*'([^']*)'[\s\S]*?scope:\s*'([a-z-]+)'/g)]
    .map(([, id, keys, scope]) => ({ id, keys, scope }));
}

/* ── pressing a chord ───────────────────────────────────────────────────
   aria-keyshortcuts is the published spelling and what bindingMatches tests
   against, so the probe presses exactly that rather than a second transcription
   of the same chord. */
const MOD = { Meta: 'Meta', Control: 'Control', Alt: 'Alt', Shift: 'Shift' };

async function press(page, aria) {
  const alt = aria.split(/\s+/)[0];
  const parts = alt.split('+');
  const key = parts.pop();
  const mods = parts.filter((m) => MOD[m]);
  // Start from no modifiers held. A modifier left down by an earlier probe
  // turns the next chord into a different one — bindingMatches compares the
  // whole set, so a stray Alt makes ⌘E fail to match Meta+E and the run reports
  // a working chord as broken.
  for (const m of Object.keys(MOD)) await page.keyboard.up(m).catch(() => {});
  for (const m of mods) await page.keyboard.down(m);
  // Lower-cased on purpose. aria-keyshortcuts spells a letter in upper case
  // ("Meta+E"), and pressing the upper-case character asks the driver for the
  // shifted key — which arrives with shiftKey set, and bindingMatches rejects a
  // shifted letter for a chord that did not list Shift. The chord under test is
  // ⌘E, not ⌘⇧E.
  const send = key === ' ' ? 'Space' : (/^[A-Z]$/.test(key) ? key.toLowerCase() : key);
  await page.keyboard.press(send);
  for (const m of mods.slice().reverse()) await page.keyboard.up(m);
  await page.waitForTimeout(340);
}

function ariaFor(id) {
  const src = fs.readFileSync(path.join(REPO, 'src/renderer/src/bindings.ts'), 'utf8');
  const row = new RegExp(`\\{\\s*id:\\s*'${id}',[\\s\\S]*?aria:\\s*'([^']*)'`).exec(src);
  if (!row) throw new Error(`no aria for ${id}`);
  return row[1];
}

/* ── focus helpers ──────────────────────────────────────────────────────
   Scope is not decoration. Every Sessions chord is dead while the terminal has
   focus, by design — the PTY owns its keystrokes — so a probe that presses one
   with the terminal focused is testing the guard, not the chord. */
const stepOffTerminal = (page) => page.evaluate(() => {
  document.querySelector('[data-nav-tab="sessions"]')?.focus();
});
const count = (page, sel) => page.locator(sel).count();

/* ── the probes ─────────────────────────────────────────────────────────
   `check` returns a string when the chord did not do what it says, and null
   when it did. `weak: true` marks a probe that only proves the event was
   consumed, not that the right thing happened. */
const PROBES = {
  palette: {
    async run(page) {
      await press(page, ariaFor('palette'));
      const open = await count(page, '.command-palette');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      return open === 1 ? null : 'the command palette did not open';
    },
  },
  'new-session': {
    async run(page) {
      await press(page, ariaFor('new-session'));
      const open = await count(page, '[role="dialog"][aria-modal="true"]');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      return open >= 1 ? null : 'no dialog opened';
    },
  },
  sheet: {
    async run(page) {
      await press(page, ariaFor('sheet'));
      const open = await count(page, '.shortcut-sheet');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      return open === 1 ? null : 'the keyboard cheat sheet did not open';
    },
  },
  demo: {
    async run(page) {
      await press(page, ariaFor('demo'));
      // It asks before it masks anything, which is the whole point of the
      // confirmation: a mistyped chord used to rewrite every name on screen.
      const asked = await page.locator('text=demo mode').count();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      return asked > 0 ? null : 'nothing asked about demo mode';
    },
  },
  sidebar: {
    async run(page) {
      const before = await count(page, '.sidebar');
      await press(page, ariaFor('sidebar'));
      const after = await count(page, '.sidebar');
      await press(page, ariaFor('sidebar'));
      return before !== after ? null : 'the destination list did not appear or disappear';
    },
  },
  'rail-move': {
    async run(page) {
      await page.evaluate(() => document.querySelector('[data-nav-tab="sessions"]')?.focus());
      const before = await page.evaluate(() => document.activeElement?.dataset?.navTab);
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(220);
      const after = await page.evaluate(() => document.activeElement?.dataset?.navTab);
      return before && after && before !== after
        ? null
        : `focus did not move down the list (${before} -> ${after})`;
    },
  },
  'side-panel': {
    async run(page) {
      await stepOffTerminal(page);
      const before = await count(page, '.term-split');
      await press(page, ariaFor('side-panel'));
      const after = await count(page, '.term-split');
      await stepOffTerminal(page);
      await press(page, ariaFor('side-panel'));
      return before !== after ? null : `the side panel did not open or close (.term-split ${before} -> ${after})`;
    },
  },
  composer: {
    async run(page) {
      await stepOffTerminal(page);
      const before = await count(page, '.composer-area');
      await press(page, ariaFor('composer'));
      const after = await count(page, '.composer-area');
      await stepOffTerminal(page);
      await press(page, ariaFor('composer'));
      return before !== after ? null : `the composer did not open or close (.composer-area ${before} -> ${after})`;
    },
  },
  'session-prev': {
    async run(page) {
      await stepOffTerminal(page);
      const before = await page.locator('.session-item.active').first().textContent().catch(() => null);
      await press(page, ariaFor('session-prev'));
      const after = await page.locator('.session-item.active').first().textContent().catch(() => null);
      return before !== after ? null : `the selection did not move (${before})`;
    },
  },
  'session-next': {
    async run(page) {
      await stepOffTerminal(page);
      const before = await page.locator('.session-item.active').first().textContent().catch(() => null);
      await press(page, ariaFor('session-next'));
      const after = await page.locator('.session-item.active').first().textContent().catch(() => null);
      return before !== after ? null : `the selection did not move (${before})`;
    },
  },
  'close-tab': {
    // The chord closes an *exited* session and deliberately does nothing for a
    // running one, so the probe has to select an exited session first or it is
    // testing the guard rather than the chord. Proving the handler is reached is
    // the honest limit here: the removal itself goes through IPC, which this
    // harness answers with a stub.
    weak: true,
    async run(page) {
      const exited = page.locator('.session-item', { hasText: 'exited' }).first();
      if (await exited.count() === 0) return 'no exited session in the fixture to close';
      await exited.click();
      await page.waitForTimeout(900);
      await stepOffTerminal(page);
      const consumed = await pressAndAskIfConsumed(page, ariaFor('close-tab'));
      return consumed ? null : 'nothing consumed the chord with an exited session selected';
    },
  },
  interrupt: {
    weak: true,
    async run(page) {
      await stepOffTerminal(page);
      const consumed = await pressAndAskIfConsumed(page, ariaFor('interrupt'));
      return consumed ? null : 'nothing consumed the chord';
    },
  },
  // The composer and palette groups are chords inside a control that already has
  // focus, and their effects are the control's own text handling. They are
  // covered by the smoke suite's source contracts; here they are recorded as
  // present in the table and not pressed.
  send: { skip: 'inside the composer; Enter is the textarea’s own key' },
  newline: { skip: 'inside the composer; Shift+Enter is the textarea’s own key' },
  stash: { skip: 'inside the composer' },
  'skill-menu': { skip: 'inside the composer' },
  'palette-move': { skip: 'inside the palette' },
  'palette-ends': { skip: 'inside the palette' },
  'palette-run': { skip: 'inside the palette' },
  'palette-close': { skip: 'inside the palette' },
};

/** Did any handler call preventDefault on this chord? */
async function pressAndAskIfConsumed(page, aria) {
  await page.evaluate(() => {
    window.__consumed = false;
    window.__probe = (e) => { if (e.defaultPrevented) window.__consumed = true; };
    window.addEventListener('keydown', window.__probe);
  });
  await press(page, aria);
  const consumed = await page.evaluate(() => {
    window.removeEventListener('keydown', window.__probe);
    return window.__consumed;
  });
  return consumed;
}

/* ── run ────────────────────────────────────────────────────────────────── */
const declared = declaredBindings();
const missing = declared.filter((b) => !PROBES[b.id]).map((b) => b.id);
const extra = Object.keys(PROBES).filter((id) => !declared.some((b) => b.id === id));

const { page, close } = await openRenderer({ onError: (m) => VERBOSE && console.log('  [page]', m) });
await page.locator('[data-nav-tab="sessions"]').click();
await page.waitForTimeout(900);

const results = [];
for (const binding of declared) {
  const probe = PROBES[binding.id];
  if (!probe) { results.push({ ...binding, status: 'NO PROBE' }); continue; }
  if (probe.skip) { results.push({ ...binding, status: 'skipped', note: probe.skip }); continue; }
  let failure = null;
  try { failure = await probe.run(page); }
  catch (e) { failure = `probe threw: ${e.message}`; }
  results.push({ ...binding, status: failure ? 'FAILED' : (probe.weak ? 'consumed' : 'ok'), note: failure });
  // Leave the app on Sessions with nothing open, whatever the last probe did.
  // A dialog left open would block every chord after it through modalOpen(),
  // and the run would report the whole tail as broken.
  for (let i = 0; i < 3; i++) {
    if (await page.evaluate(() => !document.querySelector('[role="dialog"][aria-modal="true"]')
      && document.documentElement.dataset.modalOpen !== 'true')) break;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(180);
  }
  await page.locator('[data-nav-tab="sessions"]').click().catch(() => {});
  await page.waitForTimeout(400);
  // A view that threw takes its rail and its chords with it, and every probe
  // after it would report a failure it did not cause. Put it back before the
  // next one, and say which chord left it broken.
  if (await page.locator('text=stopped rendering').count() > 0) {
    console.log(`      (${binding.id} left a view in its error boundary; reloading it)`);
    await page.locator('text=Reload view').click().catch(() => {});
    await page.waitForTimeout(600);
  }
  if (VERBOSE) {
    const state = await page.evaluate(() => ({
      view: document.querySelector('.brand-context')?.textContent,
      modal: !!document.querySelector('[role="dialog"][aria-modal="true"]'),
      rows: document.querySelectorAll('.session-item').length,
      active: document.querySelectorAll('.session-item.active').length,
      focus: document.activeElement?.className || document.activeElement?.tagName,
    }));
    console.log(`      after ${binding.id}:`, JSON.stringify(state));
  }
}
await close();

const width = Math.max(...results.map((r) => r.id.length));
for (const r of results) {
  const mark = r.status === 'ok' ? '✓' : r.status === 'FAILED' || r.status === 'NO PROBE' ? '✗' : '·';
  const line = `  ${mark} ${r.id.padEnd(width)}  ${r.keys.padEnd(12)} ${r.status}`;
  if (r.status === 'ok' && !VERBOSE) console.log(line);
  else console.log(`${line}${r.note ? ` — ${r.note}` : ''}`);
}

const failed = results.filter((r) => r.status === 'FAILED' || r.status === 'NO PROBE');
if (extra.length) console.log(`\n  probes for chords no longer in the table: ${extra.join(', ')}`);
if (missing.length) console.log(`  chords in the table with no probe: ${missing.join(', ')}`);
console.log(`\n${failed.length === 0 ? 'every published chord did what it says' : `${failed.length} published chord(s) did not do what they say`}`);
process.exit(failed.length === 0 && extra.length === 0 ? 0 : 1);
