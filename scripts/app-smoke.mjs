#!/usr/bin/env node
// Launch the real app against a throwaway data directory and check what only
// the real app can show: it starts the core, the window gets a working bridge,
// a real terminal session runs and the wanigan CLI works inside it, and
// quitting leaves the core running. `--app <path to .app>` tests a packaged build;
// `--allow-no-window` lets a machine with no display pass on the core alone.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';
import electronBinary from 'electron';
import { smokeEnvironment } from '../src/main/smoke-environment.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appArg = process.argv.indexOf('--app');
const packaged = appArg >= 0 ? resolve(process.argv[appArg + 1]) : null;
const allowNoWindow = process.argv.includes('--allow-no-window');
const dataDir = mkdtempSync(join(tmpdir(), 'wg-app-'));
const projectDir = mkdtempSync(join(tmpdir(), 'wg-app-project-'));
const env = smokeEnvironment(dataDir);
mkdirSync(env.HOME, { recursive: true });

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const results = [];
let corePid = 0;
let app;
try {
  app = packaged
    ? await _electron.launch({ executablePath: join(packaged, 'Contents', 'MacOS', basename(packaged, '.app')), args: [], env, timeout: 60_000 })
    : await _electron.launch({ args: [root], env, timeout: 60_000 });
  results.push(packaged ? `packaged app launched (${basename(packaged)})` : 'app launched');
  const deadline = Date.now() + 20_000;
  while (!existsSync(join(dataDir, 'core.json')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  corePid = existsSync(join(dataDir, 'core.json')) ? JSON.parse(readFileSync(join(dataDir, 'core.json'), 'utf8')).pid : 0;
  results.push(corePid && alive(corePid) ? `core started (pid ${corePid})` : 'FAIL: the app did not start the core');
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    await win.waitForSelector('.rail', { timeout: 20_000 });
    const hello = await win.evaluate(async () => (await window.wanigan.call('projects.list', {})).length);
    results.push(`window rendered; bridge answered projects.list (${hello} projects)`);
    const output = await win.evaluate(async (path) => {
      const project = await window.wanigan.call('projects.add', { path, name: 'Smoke' });
      const session = await window.wanigan.call('sessions.start', { projectId: project.id, provider: 'shell' });
      await window.wanigan.call('sessions.input', { id: session.id, data: 'wanigan status; echo "pty-$((6*7))"\n' });
      for (let i = 0; i < 100; i++) {
        const { replay } = await window.wanigan.call('sessions.watch', { id: session.id });
        if (/pty-42/.test(replay) && /Smoke \(SMO\)/.test(replay)) {
          await window.wanigan.call('sessions.stop', { id: session.id });
          return replay;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      return (await window.wanigan.call('sessions.watch', { id: session.id })).replay;
    }, projectDir);
    results.push(/pty-42/.test(output) ? 'a real terminal session ran' : `FAIL: no terminal output: ${output.slice(-300)}`);
    results.push(/Smoke \(SMO\)/.test(output) ? 'the wanigan CLI answered inside the session' : `FAIL: wanigan status did not answer: ${output.slice(-300)}`);
    // The app menu is built from the shortcut table, lists open projects, and
    // a menu item runs its command in the window.
    await new Promise((r) => setTimeout(r, 800));
    const menu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map((m) => ({
      label: m.label, role: m.role, items: (m.submenu?.items ?? []).map((i) => ({ label: i.label, accelerator: i.accelerator, sublabel: i.sublabel })),
    })));
    const entry = (top, label) => menu.find((m) => m.label === top || m.role === top)?.items.find((i) => i.label === label);
    const menuOk = entry('Go', 'Needs You')?.sublabel === 'G then N' && entry('Go', 'Smoke (SMO)')?.accelerator === 'CmdOrCtrl+1'
      && entry('Session', 'New Session')?.accelerator === 'CmdOrCtrl+T' && entry('Session', 'Search…')?.accelerator === 'CmdOrCtrl+K'
      && entry('help', 'Keyboard Shortcuts')?.accelerator === 'CmdOrCtrl+/';
    results.push(menuOk ? 'the Go, Session and Help menus carry the shortcut table and the open project' : `FAIL: the menu is not what the shortcut table says: ${JSON.stringify(menu.filter((m) => ['Go', 'Session', 'help'].includes(m.label) || m.role === 'help'))}`);
    await app.evaluate(({ Menu }) => {
      const help = Menu.getApplicationMenu().items.find((m) => m.role === 'help');
      help.submenu.items.find((i) => i.label === 'Keyboard Shortcuts').click();
    });
    const sheet = await win.waitForSelector('.shortcuts', { timeout: 5000 }).then(() => true, () => false);
    results.push(sheet ? 'Help › Keyboard Shortcuts opened the sheet in the window' : 'FAIL: the Help menu did not open the shortcut sheet');
    await win.keyboard.press('Escape');

    // The window's own title (Window menu, Mission Control) follows the view.
    await win.evaluate(() => { location.hash = '#/p/SMO/board'; });
    let title = '';
    for (let i = 0; i < 30 && title !== 'Smoke · Board — Wanigan'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      title = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle() ?? '');
    }
    results.push(title === 'Smoke · Board — Wanigan' ? 'the window title follows the view ("Smoke · Board — Wanigan")' : `FAIL: the window title is "${title}"`);

    // Observe only this app's native blocker IDs. Delegate to Electron's real
    // implementation; this does not inspect the system-wide assertion list.
    const waitHolding = (want) => win.evaluate(async (w) => {
      for (let i = 0; i < 60; i++) {
        const s = await window.wanigan.appState();
        if (s?.awake.holding === w) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    }, want);
    if (!(await waitHolding(false))) throw new Error('the prior session still holds the app awake');
    await app.evaluate(({ powerSaveBlocker }) => {
      const originalStart = powerSaveBlocker.start;
      const starts = [];
      globalThis.smokePowerBlockerObserver = { originalStart, starts };
      powerSaveBlocker.start = function (type) {
        const id = originalStart.call(this, type);
        starts.push({ id, type });
        return id;
      };
    });
    try {
      const awakeSession = await win.evaluate(async () => {
        const project = (await window.wanigan.call('projects.list', {})).find((p) => p.name === 'Smoke');
        return (await window.wanigan.call('sessions.start', { projectId: project.id, provider: 'shell', title: 'Awake' })).id;
      });
      const held = await waitHolding(true);
      const started = await app.evaluate(({ powerSaveBlocker }) => globalThis.smokePowerBlockerObserver.starts.map((s) => ({ ...s, active: powerSaveBlocker.isStarted(s.id) })));
      const nativeHeld = started.length === 1 && started[0].type === 'prevent-app-suspension' && started[0].active;
      results.push(held && nativeHeld ? 'a live session starts this app’s native prevent-app-suspension blocker'
        : `FAIL: own-app blocker not active (app says ${held}, native IDs: ${JSON.stringify(started)})`);
      await win.evaluate((id) => window.wanigan.call('sessions.stop', { id }), awakeSession);
      const released = await waitHolding(false);
      const stopped = await app.evaluate(({ powerSaveBlocker }) => globalThis.smokePowerBlockerObserver.starts.map((s) => ({ ...s, active: powerSaveBlocker.isStarted(s.id) })));
      const nativeReleased = stopped.length === 1 && stopped[0].id === started[0]?.id && !stopped[0].active;
      results.push(released && nativeReleased ? 'the same native blocker stops with the last live session'
        : `FAIL: own-app blocker was not released (app says ${released}, native IDs: ${JSON.stringify(stopped)})`);
    } finally {
      await app.evaluate(({ powerSaveBlocker }) => {
        powerSaveBlocker.start = globalThis.smokePowerBlockerObserver.originalStart;
        delete globalThis.smokePowerBlockerObserver;
      });
    }

    // With the window in front, a session failing elsewhere arrives as an alert
    // card from the main process. Skipped, with nothing failed, if the window
    // cannot take focus here: a failure then would be a real macOS notification.
    await app.evaluate(({ app: a, BrowserWindow }) => { a.focus({ steal: true }); BrowserWindow.getAllWindows()[0]?.focus(); });
    await new Promise((r) => setTimeout(r, 500));
    const focused = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFocused() ?? false);
    if (!focused) results.push('in-window alerts not checked: the window could not take focus here');
    else {
      await win.evaluate(async () => {
        location.hash = '#/accounts';
        const project = (await window.wanigan.call('projects.list', {})).find((p) => p.name === 'Smoke');
        const session = await window.wanigan.call('sessions.start', { projectId: project.id, provider: 'shell', title: 'Doomed' });
        await window.wanigan.call('sessions.input', { id: session.id, data: 'exit 3\n' });
      });
      const alert = await win.waitForSelector('.alert', { timeout: 15_000 }).then((el) => el.textContent()).catch(() => null);
      results.push(alert && /failed/.test(alert) ? 'a session failing elsewhere showed as an alert in the focused window' : `FAIL: no alert for a failed session (${alert})`);
    }
    // Updates. Nothing is checked before the owner answers the rail; then
    // Check for Updates… goes through Electron's own network stack, redirected
    // to a stand-in GitHub on this machine, and the menu answers with a dialog
    // whose Download opens the disk image the check found.
    const updatesFile = join(dataDir, 'electron', 'updates.json');
    const untouched = await win.evaluate(async () => (await window.wanigan.appState())?.updates?.state);
    const asking = await win.waitForSelector('.rail-update-ask', { timeout: 5000 }).then(() => true, () => false);
    results.push(untouched === 'never' && asking && !existsSync(updatesFile)
      ? 'the rail asks whether to check for updates daily, and nothing was checked before an answer'
      : `FAIL: before an answer (status ${untouched}, rail asks ${asking}, results kept ${existsSync(updatesFile)})`);
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    const next = `${Number(version.split('.')[0]) + 1}.0.0`;
    const tagPage = `https://github.com/DanePete/wanigan/releases/tag/v${next}`;
    const dmg = `https://github.com/DanePete/wanigan/releases/download/v${next}/Wanigan-2-${next}-mac-arm64.dmg`;
    const githubAsked = [];
    const github = createServer((req, res) => {
      githubAsked.push({ url: req.url, agent: req.headers['user-agent'], cookie: req.headers.cookie ?? null });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ tag_name: `v${next}`, name: `${next}: smoke`, draft: false, prerelease: false, html_url: tagPage, published_at: new Date().toISOString(), assets: [{ name: `Wanigan-2-${next}-mac-arm64.dmg`, browser_download_url: dmg }] }]));
    });
    await new Promise((r) => github.listen(0, '127.0.0.1', r));
    try {
      await app.evaluate(({ dialog, session, shell }, port) => {
        session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://api.github.com/*'] }, (d, done) => {
          const u = new URL(d.url);
          done({ redirectURL: `http://127.0.0.1:${port}${u.pathname}${u.search}` });
        });
        globalThis.updateAsked = [];
        globalThis.opened = [];
        dialog.showMessageBox = async (...args) => {
          const o = args.at(-1);
          globalThis.updateAsked.push(`${o.message} [${o.buttons.join('/')}]`);
          return { response: 0 };
        };
        shell.openExternal = async (url) => { globalThis.opened.push(url); };
      }, github.address().port);
      await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find((i) => i.label === 'Check for Updates…').click());
      let said = [];
      for (let i = 0; i < 100 && !said.length; i++) { await new Promise((r) => setTimeout(r, 100)); said = await app.evaluate(() => globalThis.updateAsked); }
      const opened = await app.evaluate(() => globalThis.opened);
      const sent = githubAsked[0];
      results.push(githubAsked.length === 1 && sent.url === '/repos/DanePete/wanigan/releases?per_page=20' && sent.agent === 'Wanigan-2-update-check' && !sent.cookie
        ? 'Check for Updates… asked GitHub’s releases list once, saying only what was asking'
        : `FAIL: the check asked ${JSON.stringify(githubAsked)}`);
      results.push(said[0] === `Wanigan ${next} is available [Download/Release Notes/Later]` && opened.join() === dmg
        ? `the menu named ${next} in a dialog, and Download opened its disk image`
        : `FAIL: the dialog said ${JSON.stringify(said)} and opened ${JSON.stringify(opened)}`);
      const news = await win.waitForSelector('.rail-update', { timeout: 5000 }).then(() => true, () => false);
      const kept = existsSync(updatesFile) ? JSON.parse(readFileSync(updatesFile, 'utf8')) : null;
      results.push(news && kept?.state === 'available' && kept.release.version === next && (statSync(updatesFile).mode & 0o777) === 0o600
        ? 'the rail says a new version is out, and the result is kept for the owner only'
        : `FAIL: after the check (rail shows it ${news}, kept ${JSON.stringify(kept)})`);
    } finally {
      github.close();
    }

    await win.screenshot({ path: join(root, '.artifacts', 'app-window.png') });

    // Quitting with a session running says that nothing will notify; "Keep open" keeps it open, once per launch.
    await win.evaluate(async () => {
      const [project] = await window.wanigan.call('projects.list', {});
      await window.wanigan.call('sessions.start', { projectId: project.id, provider: 'shell', title: 'Left running' });
    });
    await app.evaluate(({ dialog }) => {
      globalThis.quitAsked = [];
      dialog.showMessageBox = async (...args) => {
        const o = args.at(-1);
        globalThis.quitAsked.push(`${o.message} ${o.detail} [${o.buttons.join('/')}] ${o.checkboxLabel}`);
        return { response: 1, checkboxChecked: true };
      };
    });
    await app.evaluate(({ app: electronApp }) => { electronApp.quit(); });
    await new Promise((r) => setTimeout(r, 1500));
    const asked = await app.evaluate(() => globalThis.quitAsked);
    results.push(asked.length === 1 && /^1 session keeps running\. Wanigan won’t notify you while it’s closed\. \[Quit\/Keep open\] Don’t ask again$/.test(asked[0])
      ? 'quitting with a live session asked first, and Keep open kept the app open'
      : `FAIL: the quit warning did not show as expected: ${JSON.stringify(asked)}`);
    const prefs = join(dataDir, 'electron', 'quit-warning.json');
    results.push(existsSync(prefs) && JSON.parse(readFileSync(prefs, 'utf8')).ask === false
      ? '“Don’t ask again” was kept for the next launch'
      : 'FAIL: “Don’t ask again” was not saved');
  } catch (error) {
    // A window check that could not run is a failure: passing on the core alone
    // claimed checks it never made. --allow-no-window is for a machine with no display.
    results.push(`${allowNoWindow ? 'NOTE' : 'FAIL'}: the window could not be checked: ${error.message.split('\n')[0]}`);
  }
  await app.close();
  app = null;
  await new Promise((r) => setTimeout(r, 800));
  results.push(corePid && alive(corePid) ? 'core still running after the app quit' : 'FAIL: the core died with the app');
} catch (error) {
  results.push(`FAIL: ${error.message.split('\n')[0]}`);
} finally {
  if (app) await app.close().catch(() => {});
  if (corePid && alive(corePid)) {
    process.kill(corePid, 'SIGTERM');
    // The core records its sessions as it stops; let it finish before removing its folder.
    for (let i = 0; i < 50 && alive(corePid); i++) await new Promise((r) => setTimeout(r, 100));
  }
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// A core that cannot start says why in the window, and Try again starts it once
// the reason is gone. Its own launch and data: another app's database sits
// where Wanigan's would be, which the core must refuse.
{
  const refusedDir = mkdtempSync(join(tmpdir(), 'wg-app-refused-'));
  const store = join(refusedDir, 'wanigan.db');
  execFileSync('/usr/bin/sqlite3', [store, 'CREATE TABLE notes (body TEXT);']);
  let refused;
  let pid = 0;
  try {
    const refusedEnv = { ...env, WANIGAN_DATA_DIR: refusedDir };
    refused = packaged
      ? await _electron.launch({ executablePath: join(packaged, 'Contents', 'MacOS', basename(packaged, '.app')), args: [], env: refusedEnv, timeout: 60_000 })
      : await _electron.launch({ args: [root], env: refusedEnv, timeout: 60_000 });
    const win = await refused.firstWindow({ timeout: 30_000 });
    const panel = await win.waitForSelector('.core-problem', { timeout: 20_000 }).then((el) => el.textContent(), () => null);
    results.push(panel && /core could not start/.test(panel) && /not created by Wanigan 2/.test(panel) && panel.includes(join(refusedDir, 'core.log'))
      ? 'a core that refused its store said why in the window, with its log'
      : `FAIL: no reason in the window for a core that could not start: ${panel}`);
    const rail = await win.textContent('.core-status').catch(() => '');
    results.push(/Core unavailable/.test(rail) ? 'the rail says the core is unavailable' : `FAIL: the rail says "${rail}"`);
    rmSync(store);
    await win.click('.core-problem button:has-text("Try again")');
    const back = await win.waitForSelector('.core-status:has-text("Core running")', { timeout: 20_000 }).then(() => true, () => false);
    const gone = !(await win.$('.core-problem'));
    pid = existsSync(join(refusedDir, 'core.json')) ? JSON.parse(readFileSync(join(refusedDir, 'core.json'), 'utf8')).pid : 0;
    results.push(back && gone ? 'Try again started the core once the reason was gone, and the panel went' : `FAIL: Try again (running: ${back}, panel gone: ${gone})`);
  } catch (error) {
    results.push(`FAIL: the refused-store launch: ${error.message.split('\n')[0]}`);
  } finally {
    if (refused) await refused.close().catch(() => {});
    if (pid && alive(pid)) {
      process.kill(pid, 'SIGTERM');
      for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    }
    rmSync(refusedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

// Started with ELECTRON_RUN_AS_NODE set, as `npm run dev` from a shell that
// exports it: a plain sentence and exit 1, not a TypeError from inside main.
// Only from source: a packaged app is opened by Finder or the Dock, which never
// pass the variable on, and inside it there is no `electron` module to resolve.
if (!packaged) {
  const electron = packaged ? join(packaged, 'Contents', 'MacOS', basename(packaged, '.app')) : electronBinary;
  const entry = packaged ? join(packaged, 'Contents', 'Resources', 'app.asar', 'out', 'main', 'index.js') : join(root, 'out', 'main', 'index.js');
  let ran;
  try {
    execFileSync(electron, [entry], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
    ran = { status: 0, stderr: '' };
  } catch (error) {
    ran = { status: error.status, stderr: String(error.stderr ?? ''), error };
  }
  results.push(ran.status === 1 && /Unset ELECTRON_RUN_AS_NODE, then start Wanigan again\./.test(ran.stderr) && !/TypeError/.test(ran.stderr)
    ? 'started with ELECTRON_RUN_AS_NODE set, it says to unset it and exits 1'
    : `FAIL: with ELECTRON_RUN_AS_NODE set: exit ${ran.status}, ${(ran.stderr || ran.error?.message || '').trim().slice(0, 300)}`);
}

console.log(results.map((r) => `  ${r}`).join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
