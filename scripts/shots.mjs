#!/usr/bin/env node
// Screenshot every Wanigan view from the real Electron build into docs/shots/.
//
// Why this exists: the renderer has no UI tests, so a change to a view is
// only ever seen by whoever happens to open it. This drives the built app
// headlessly through Playwright, seeds one project, one docket and one
// learning candidate over the real IPC surface (so the same validation a user
// hits runs), and writes 1440x900 captures of every view in both themes plus a
// 960px window. Attach before/after shots to any UI change (CONTRIBUTING.md).
//
// Usage:  npm run build && node scripts/shots.mjs [--out docs/shots] [--light]
// Requires playwright-core to be resolvable (it ships as a transitive
// dependency today; `npm i -D playwright-core` if that ever changes). Never
// touches the real user-data directory: it launches with a temp one.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const require = createRequire(import.meta.url);

let electron;
try { ({ _electron: electron } = require('playwright-core')); }
catch { console.error('playwright-core is not resolvable from this repo; run `npm i -D playwright-core` and retry.'); process.exit(2); }

const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const OUT = path.resolve(REPO, outArg >= 0 ? args[outArg + 1] : 'docs/shots');
const themes = args.includes('--light') ? ['dark', 'light'] : ['dark'];
mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'runtime-log.txt');
writeFileSync(LOG, '');
const log = (s) => { appendFileSync(LOG, s + '\n'); console.log(s); };

if (!existsSync(path.join(REPO, 'out/main/index.js'))) { console.error('No build in out/. Run `npm run build` first.'); process.exit(2); }

// Same environment scrub as scripts/launch.sh: a VS Code shell exports
// ELECTRON_RUN_AS_NODE, which makes the binary run as plain Node and die.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const k of Object.keys(env)) if (k.startsWith('VSCODE_')) delete env[k];
const udd = mkdtempSync(path.join(tmpdir(), 'wanigan-shots-'));

const binary = process.platform === 'darwin'
  ? path.join(REPO, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(REPO, 'node_modules/electron/dist/electron');

// `--wanigan-automation` is the launch marker src/main/automation.ts reads.
// It is the only mode in which the raw projects:add channel answers: a
// headless run cannot click the folder picker that registers a root for a
// person, and the marker cannot be reached from the page, only from argv.
// An installed build refuses it outright (app.isPackaged).
const app = await electron.launch({ executablePath: binary, args: ['.', `--user-data-dir=${udd}`, '--wanigan-automation'], cwd: REPO, env, timeout: 120_000 });
const page = await app.firstWindow({ timeout: 120_000 });
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) log(`[console.${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => log(`[pageerror] ${e.message}`));
await page.waitForSelector('.nav-tabs, .sidebar, nav', { timeout: 120_000 });
await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1440, 900); w.show(); });
await page.waitForTimeout(800);

// Seed through the real IPC surface, then reload so the shell's project list
// refreshes. projects.add answers here only because of the launch marker above.
const seed = await page.evaluate(async (repo) => {
  const out = {};
  try {
    const p = await window.wanigan.projects.add(repo); out.project = p.id;
    try { const d = await window.wanigan.control.create({ projectId: p.id, title: 'Tighten the Fleet card hierarchy', objective: 'Make blocked sessions read first at a glance without colour carrying the state alone.', acceptance: ['Permission-blocked cards sort first', 'Every status has a glyph and a word', 'No layout shift on status change'], risk: 'low' }); out.docket = d?.docket?.id ?? d?.id ?? 'created'; } catch (e) { out.docketError = String(e?.message ?? e); }
    try { const c = await window.wanigan.learning.teach({ projectId: p.id, title: 'Run npm test before handing off', text: 'Run `npm test` (typecheck, package hooks, local install, smoke) before handing off any code change in this repo.', kind: 'instruction', scope: 'project', outcome: 'preference' }); out.candidate = c?.id ?? 'created'; } catch (e) { out.teachError = String(e?.message ?? e); }
  } catch (e) { out.projectError = String(e?.message ?? e); }
  return out;
}, REPO);
log('seed: ' + JSON.stringify(seed));
await page.reload();
await page.waitForSelector('.nav-tabs, .sidebar, nav', { timeout: 120_000 });
await page.waitForTimeout(1200);

const VIEWS = ['Sessions', 'Fleet', 'Control', 'Batches', 'Insights', 'Learning', 'Plugins', 'Schedules', 'Git', 'Runs', 'Usage', 'Scout', 'Settings'];
const CHORDS = { Skills: 'Meta+Shift+S', Context: 'Meta+Shift+C' };

async function setTheme(theme) {
  await page.evaluate(async (t) => {
    try { await window.wanigan.prefs.setTheme(t); } catch {}
    document.documentElement.dataset.theme = t; document.documentElement.dataset.themePreference = t; document.documentElement.style.colorScheme = t;
    window.dispatchEvent(new CustomEvent('wanigan:theme-changed', { detail: { preference: t, resolved: t } }));
    window.dispatchEvent(new CustomEvent('wanigan:prefs-changed'));
  }, theme);
  await page.waitForTimeout(400);
}
async function goTo(label) {
  // Works with the tab rail and with a sidebar: any button whose text starts with the label.
  const btn = page.locator('nav button, nav a', { hasText: new RegExp(`^\\s*${label}\\b`) }).first();
  if (await btn.count()) { await btn.click(); return true; }
  return false;
}
async function shot(theme, name) { const dir = path.join(OUT, theme); mkdirSync(dir, { recursive: true }); await page.screenshot({ path: path.join(dir, `${name}.png`) }); log(`shot ${theme}/${name}`); }

for (const theme of themes) {
  await setTheme(theme);
  for (const label of VIEWS) {
    if (!(await goTo(label))) { log(`no nav control for ${label}`); continue; }
    await page.waitForTimeout(900);
    await shot(theme, label.toLowerCase());
  }
  for (const [label, chord] of Object.entries(CHORDS)) {
    await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press(chord); await page.waitForTimeout(900); await shot(theme, label.toLowerCase());
  }
  await page.keyboard.press('Meta+K'); await page.waitForTimeout(500); await shot(theme, 'overlay-palette'); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  await page.keyboard.press('Meta+T'); await page.waitForTimeout(700); await shot(theme, 'overlay-new-session'); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  await page.keyboard.press('Shift+Slash'); await page.waitForTimeout(500); await shot(theme, 'overlay-shortcuts'); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
}

await setTheme('dark');
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 760));
await page.waitForTimeout(600);
for (const label of ['Sessions', 'Fleet', 'Learning', 'Settings']) { if (await goTo(label)) { await page.waitForTimeout(700); await shot('narrow', label.toLowerCase()); } }

await app.close();
rmSync(udd, { recursive: true, force: true });
log('done');
