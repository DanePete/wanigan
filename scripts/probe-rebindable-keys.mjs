#!/usr/bin/env node
// Settings › App › Keyboard: rebind a shortcut in the running renderer, then
// press it. Actual renderer, isolated Electron, synthetic services, no agent.
// The keymap IPC is answered in this Node process by src/shared/keymap.ts —
// the module main validates every write with — so a refusal on screen is the
// refusal main would give. Main's own handlers, storage and menu bar are held
// by the smoke suite (smoke23); this probe covers what a reader sees and what
// a key press does.
//
//   npm run build && node scripts/probe-rebindable-keys.mjs [--before] [--out dir]
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), { _electron } = require('playwright-core');
const root = path.resolve(import.meta.dirname, '..'), before = process.argv.includes('--before');
const outArg = process.argv.indexOf('--out');
const out = outArg >= 0 ? path.resolve(process.argv[outArg + 1])
  : path.join(root, 'docs/visuals/rebindable-keys', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
// The pre-change build has no keymap module to import, and needs none.
const keymap = before ? null : await import(pathToFileURL(path.join(root, 'src/shared/keymap.ts')).href);
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-keys-probe-'));
writeFileSync(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({
  executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [path.join(dir, 'main.cjs'), `--user-data-dir=${dir}/profile`], env,
});
const checks = [], errors = [];
const record = (text) => { checks.push(text); console.log('✓', text); };
// The settings row main would hold, and every call that reached "main".
let stored = {};
const calls = [];
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  if (!before) {
    await page.exposeFunction('__probeKeymap', (method, ...args) => {
      calls.push([method, ...args]);
      const state = () => { const r = keymap.resolveKeymap(stored); return { keymap: r.keymap, ignored: r.ignored, unreadable: null }; };
      if (method === 'get') return state();
      if (method === 'resetAll') { stored = {}; return state(); }
      const change = method === 'set' ? keymap.validateRebinding(stored, args[0], args[1]) : keymap.resetRebinding(stored, args[0]);
      if (change.ok) { stored = change.keymap; return { applied: true, state: state() }; }
      return { applied: false, refusal: change.refusal, state: state() };
    });
  }
  await page.addInitScript(STUB);
  await page.addInitScript((withKeymap) => {
    try { localStorage.setItem('wanigan.settings.tab', 'app'); } catch { /* the default tab is still reachable */ }
    if (!withKeymap) return;
    const original = window.wanigan;
    window.wanigan = new Proxy(original, { get(api, service) {
      if (service === 'keymap') return {
        get: () => window.__probeKeymap('get'),
        set: (id, chord) => window.__probeKeymap('set', id, chord),
        reset: (id) => window.__probeKeymap('reset', id),
        resetAll: () => window.__probeKeymap('resetAll'),
      };
      return api[service];
    } });
  }, !before);
  await page.goto(rendererURL); await page.waitForSelector('.mission-room');

  // Pressed the way probe-chords presses: modifiers released first, letters
  // lower-cased so the driver does not add Shift to a chord that has none.
  const press = async (chord) => {
    for (const m of ['Meta', 'Control', 'Alt', 'Shift']) await page.keyboard.up(m).catch(() => {});
    await page.keyboard.press(chord);
    await page.waitForTimeout(350);
  };
  const shoot = async (name) => {
    for (const theme of ['dark', 'light']) {
      // Both, or native controls paint dark inside a light screenshot.
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; document.documentElement.style.colorScheme = t; }, theme);
      await page.waitForTimeout(120);
      await page.screenshot({ path: path.join(out, `${name}-${theme}.png`), scale: 'css' });
    }
  };
  const stepOff = () => page.evaluate(() => { document.querySelector('.hdr-toggle')?.focus(); });
  const dialogs = () => page.locator('[role="dialog"][aria-modal="true"]').count();
  const closeDialogs = async () => {
    for (let i = 0; i < 3 && await dialogs() > 0; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); }
  };
  const openSettings = async () => {
    await stepOff();
    await press('Meta+,');
    await page.locator('.set.pane').waitFor();
  };
  const openSheet = async () => {
    await press('Meta+/');
    await page.locator('.shortcut-sheet').waitFor();
  };
  // The section's own head — its title, its rules, Reset all — belongs in a
  // screenshot of it; scrollIntoViewIfNeeded would centre the middle rows.
  const toTop = (locator) => locator.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  const sheetKeysFor = (does) => page.locator('.shortcut-sheet tr').filter({ has: page.getByRole('cell', { name: does, exact: true }) })
    .locator('.shortcut-keys kbd').first().innerText();

  if (before) {
    await openSettings();
    const panel = page.locator('.set-tab-panel').filter({ has: page.locator('[data-section-title="Motion"]') });
    await panel.locator('[data-section-title="Motion"]').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('[data-section-title="Keyboard"]').count(), 0, 'the pre-change build has no Keyboard section');
    await shoot('settings-app');
    record('before: Settings › App has Appearance, Motion and Demo mode, and no way to change a shortcut');
    await openSheet();
    assert.equal(await sheetKeysFor('New session'), '⌘T');
    await shoot('sheet');
    record('before: the cheat sheet prints New session on ⌘T, the only chord it can have');
    await closeDialogs();
  } else {
    const calledSet = () => calls.filter(([method]) => method !== 'get').length;
    await openSettings();
    const section = page.locator('[data-section-title="Keyboard"]');
    await section.waitFor();
    await toTop(section);
    const groups = await section.getByRole('group').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
    assert.deepEqual(groups, ['Anywhere', 'Destination list', 'Sessions view', 'Composer', 'Command palette']);
    const rows = section.locator('.set-keys-row');
    const expectedRows = keymap.effectiveKeymap({}).bindings;
    assert.equal(await rows.count(), expectedRows.length);
    assert.equal(await section.getByRole('button', { name: /^Change the shortcut for / }).count(), expectedRows.filter((b) => b.rebindable).length);
    assert.equal(await section.locator('.set-keys-row .mark').filter({ hasText: 'fixed' }).count(), expectedRows.filter((b) => !b.rebindable).length);
    const newSession = section.locator('[data-binding="new-session"]');
    const textOf = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();
    assert.match(await textOf(newSession), /^New session ⌘T Change$/);
    assert.match(await textOf(section.locator('[data-binding="interrupt"]')),
      /^Interrupt the running agent Interrupt the running agent — works even while the terminal has focus ⌘\. — ?fixed The Sessions view answers this chord in a key handler of its own that does not read the keymap yet/);
    assert.match(await textOf(section.locator('[data-binding="send"]')), /^Send Send — or queue, when the agent is busy Enter — ?fixed Enter and ⇧Enter belong to the text field they are typed in/);
    assert.match(await textOf(section.locator('[data-binding="skill-menu"]')), /\$ — ?fixed Typing \$ in the composer opens the menu/);
    assert.match(await textOf(section.locator('[data-binding="view:fleet"]')), /^Open Fleet ⌘2 Change$/);
    const clipped = await section.locator('.set-keys-name, .set-keys-does, .set-keys-chord kbd, .set-keys-note').evaluateAll((els) =>
      els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent));
    assert.deepEqual(clipped, [], 'no name, chord or reason is clipped');
    assert(!/\bundefined\b|\bNaN\b|\[object /.test(await section.innerText()), 'no raw value reaches the screen');
    record(`Keyboard lists ${expectedRows.length} bindings in the sheet's five groups: ${expectedRows.filter((b) => b.rebindable).length} with Change, ${expectedRows.filter((b) => !b.rebindable).length} marked fixed with the reason in words, none clipped`);
    await shoot('settings-keyboard');

    // Change, then Escape: nothing recorded, nothing written, focus back.
    const change = newSession.getByRole('button', { name: 'Change the shortcut for New session' });
    await change.click();
    assert.equal(await newSession.getByRole('button', { name: 'Press the new chord…' }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.chordCapture), 'true');
    await newSession.getByRole('status').filter({ hasText: 'Recording: press the chord for New session, holding ⌘ or ⌃. Escape cancels.' }).waitFor();
    await press('Escape');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.chordCapture ?? null), null);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Change the shortcut for New session');
    assert.equal(calledSet(), 0, 'Escape wrote nothing');
    record('Change records the next chord and says so; Escape cancels it, writes nothing, and hands focus back to Change');

    // A chord another binding holds: refused, with that binding named, and
    // pressing it while recording did not also open the palette.
    await change.click();
    await press('Meta+k');
    const refusal = newSession.getByRole('alert');
    await refusal.waitFor();
    const refusalText = (await refusal.innerText()).replace(/\s+/g, ' ');
    assert.match(refusalText, /^✕ Not changed\. ⌘K already belongs to Command palette\. Change that one first, or choose another chord\.$/);
    assert.equal(await page.locator('.command-palette').count(), 0, 'the recorded ⌘K did not open the palette');
    assert.match((await newSession.locator('.set-keys-chord').innerText()).trim(), /^⌘T$/);
    assert.deepEqual(stored, {});
    const refusalFit = await refusal.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    assert(refusalFit.scroll <= refusalFit.client + 1, 'the refusal is not clipped: ' + JSON.stringify(refusalFit));
    record('a chord Command palette already holds is refused under the row with that binding named, the chord stays ⌘T, and recording ⌘K did not open the palette');
    await toTop(section);
    await shoot('refused');

    // A free chord: applied, printed, published.
    await change.click();
    await press('Meta+n');
    await newSession.getByRole('status').filter({ hasText: 'New session is now ⌘N.' }).waitFor();
    assert.deepEqual(stored, { 'new-session': 'Meta+N' });
    assert.match(await textOf(newSession), /^New session ⌘N ● ?changed Change Reset Default: ⌘T ✓ New session is now ⌘N\.$/);
    assert.equal(await newSession.getByRole('alert').count(), 0, 'the earlier refusal is gone');
    const header = page.locator('.nav-new-session');
    assert.equal(await header.getAttribute('aria-keyshortcuts'), 'Meta+N Control+N');
    assert.equal(await header.getAttribute('aria-label'), 'Start a new interactive agent session (Command N)');
    assert.equal((await header.locator('.nav-shortcut').innerText()).trim(), '⌘N');
    await section.locator('.note').filter({ hasText: 'The Sessions view’s own labels do not read the keymap yet, so it still prints ⌘T on its New session button and in its status line.' }).waitFor();
    record('⌘N is accepted: the row reads ⌘N, changed, with its ⌘T default and Reset; the header button prints ⌘N and publishes Meta+N Control+N; a note says the Sessions view’s own labels still print ⌘T');
    await toTop(section);
    await shoot('rebound');

    // The cheat sheet prints what was just stored.
    await openSheet();
    assert.equal(await sheetKeysFor('New session'), '⌘N');
    assert.equal(await page.locator('.shortcut-sheet kbd').filter({ hasText: /^⌘T$/ }).count(), 0, 'no row still prints ⌘T');
    record('the cheat sheet prints New session on ⌘N and nothing on ⌘T');
    await shoot('sheet-rebound');
    await closeDialogs();

    // Pressed: the new chord opens New session from a view that is not Sessions.
    const onView = (label) => page.waitForFunction((l) => document.querySelector('.brand-context')?.textContent === l, label);
    await stepOff();
    await press('Meta+2');
    await onView('Fleet');
    await stepOff();
    await press('Meta+n');
    await page.getByRole('dialog', { name: 'New session' }).waitFor();
    record('pressing ⌘N opens the New session dialog');
    await closeDialogs();

    // The old chord does nothing — on Fleet, and on Sessions, whose own handler
    // still tests ⌘T by hand; the shell stops it before that handler can run.
    // A bubble-phase listener on window, added last, is where a view handler
    // like Sessions' sits: whether it saw the key is whether one could have.
    const pressAndWatch = async (chord) => {
      // Only the chord's own key counts: the driver's keydown for Meta itself
      // bubbles, as it should, and would read as the chord getting through.
      await page.evaluate((key) => {
        window.__bubbled = false;
        window.__seen = (e) => { if (e.key.toLowerCase() === key) window.__bubbled = true; };
        window.addEventListener('keydown', window.__seen);
      }, chord.split('+').pop().toLowerCase());
      await press(chord);
      return page.evaluate(() => { window.removeEventListener('keydown', window.__seen); return window.__bubbled; });
    };
    const inTerminalNow = () => page.evaluate(() => !!document.activeElement?.closest('.terminal-host'));
    await stepOff();
    await press('Meta+2');
    await onView('Fleet');
    await stepOff();
    const fleetBubbled = await pressAndWatch('Meta+t');
    await page.waitForTimeout(400);
    assert.equal(await dialogs(), 0, 'no dialog on Fleet');
    await press('Meta+1');
    await page.locator('.sessions-view').waitFor();
    await page.waitForTimeout(900);  // a clicked session hands focus to its terminal in a frame
    await stepOff();
    // Otherwise this would test the terminal guard, not the retired chord.
    assert.equal(await inTerminalNow(), false, 'focus is off the terminal before ⌘T is pressed on Sessions');
    const sessionsBubbled = await pressAndWatch('Meta+t');
    await page.waitForTimeout(400);
    assert.equal(await dialogs(), 0, 'no dialog on Sessions');
    assert.equal(fleetBubbled, false);
    assert.equal(sessionsBubbled, false, 'the retired ⌘T never reached a bubble-phase handler');
    await stepOff();
    const freeBubbled = await pressAndWatch('Meta+j');
    assert.equal(freeBubbled, true, 'a chord nobody ever bound still propagates normally');
    record('pressing the old ⌘T does nothing on Fleet or on Sessions — stopped in the shell before the Sessions view’s own ⌘T handler could see it — while a never-bound chord such as ⌘J still propagates');

    // Reset restores the default, everywhere at once.
    await openSettings();
    const row = page.locator('[data-section-title="Keyboard"] [data-binding="new-session"]');
    await row.scrollIntoViewIfNeeded();
    await row.getByRole('button', { name: 'Reset the shortcut for New session to ⌘T' }).click();
    await row.getByRole('status').filter({ hasText: 'New session is back on ⌘T.' }).waitFor();
    assert.deepEqual(stored, {});
    assert.match((await row.locator('.set-keys-chord').innerText()).trim(), /^⌘T$/);
    assert.equal(await page.locator('.nav-new-session').getAttribute('aria-keyshortcuts'), 'Meta+T Control+T');
    await stepOff();
    await press('Meta+2');
    await onView('Fleet');
    await stepOff();
    await press('Meta+t');
    await page.getByRole('dialog', { name: 'New session' }).waitFor();
    await closeDialogs();
    record('Reset puts New session back on ⌘T: the row, the header and the key all follow, and ⌘T opens the dialog again');

    // Reset all, from two rebindings.
    await openSettings();
    const keyboard = page.locator('[data-section-title="Keyboard"]');
    await keyboard.scrollIntoViewIfNeeded();
    for (const [id, name, chord] of [['demo', 'Demo mode', 'Meta+j'], ['view:fleet', 'Open Fleet', 'Meta+Shift+F']]) {
      const target = keyboard.locator(`[data-binding="${id}"]`);
      await target.scrollIntoViewIfNeeded();
      await target.getByRole('button', { name: `Change the shortcut for ${name}` }).click();
      await press(chord);
      await target.getByRole('status').filter({ hasText: `${name} is now` }).waitFor();
    }
    assert.deepEqual(stored, { demo: 'Meta+J', 'view:fleet': 'Meta+Shift+F' });
    // The destination list starts closed; open it to read the row it prints.
    await page.locator('.hdr-toggle').click();
    const fleetRow = page.locator('[data-nav-tab="fleet"]');
    await fleetRow.waitFor();
    assert.equal(await fleetRow.getAttribute('aria-keyshortcuts'), 'Meta+Shift+F Control+Shift+F');
    assert.equal((await fleetRow.locator('.nav-tab-chord').innerText()).trim(), '⌘⇧F');
    await page.locator('.hdr-toggle').click();
    record('a rebound route is published and printed by its destination-list row: Fleet reads ⌘⇧F with Meta+Shift+F Control+Shift+F');
    await keyboard.scrollIntoViewIfNeeded();
    await keyboard.getByRole('button', { name: 'Reset all', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-section-title="Keyboard"] .set-keys-row .mark.tone-accent').length === 0);
    assert.deepEqual(stored, {});
    assert.equal(await keyboard.getByRole('button', { name: 'Reset all', exact: true }).isDisabled(), true, 'nothing left to reset');
    record('Reset all puts two rebindings back at once and then has nothing left to reset');
  }
  assert.deepEqual(errors, []);
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({
    at: new Date().toISOString(),
    provenance: 'Actual Electron renderer from out/renderer of the checkout this script ran in; synthetic services; keymap IPC answered by src/shared/keymap.ts in the probe process; no real agent calls',
    mode: before ? 'before' : 'after', checks, errors,
  }, null, 2) + '\n');
} finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
