#!/usr/bin/env node
// UI-only evidence: built renderer, isolated Electron profile, fictional bridge.
// No Wanigan main process, real agents, user records, or network model calls.
// Run after `nvm use && npm run build`:
//   node scripts/capture-workspace-simplification.mjs before|after
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const phase = process.argv[2];
assert.ok(['before', 'after'].includes(phase), 'pass before or after');
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { _electron } = require('playwright-core');
const out = path.join(root, 'docs/visuals/workspace-simplification-2026-09-19', phase);
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-workspace-capture-'));
writeFileSync(path.join(dir, 'main.cjs'), "const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(dir, 'main.cjs'), `--user-data-dir=${dir}/profile`], env });
const screenshots = [], errors = [], checks = [];
const report = {
  phase,
  provenance: 'Production renderer, isolated Electron profile, explicitly fictional STUB bridge. No real providers, PTYs, user-data reads, repository writes or model calls. Proves renderer layout only.',
  fixtureNote: 'SessionReview Changes uses an explicit fictional modified Markdown file and fictional diff. No filesystem change or review command is executed.',
  screenshots, errors, checks,
  buildIndexSha256: crypto.createHash('sha256').update(readFileSync(path.join(root, 'out/renderer/index.html'))).digest('hex'),
};
let page;
try {
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(STUB + `
    (() => {
      localStorage.setItem('wanigan.composer', '1');
      const readPrefs = () => JSON.parse(localStorage.getItem('__workspaceFixturePrefs') || '{}');
      window.__workspacePrefWrites = JSON.parse(localStorage.getItem('__workspaceFixturePrefWrites') || '[]');
      window.__workspaceReviewWrites = [];
      window.__workspacePrefFailures = [];
      window.__workspaceFailNextPrefWrite = false;
      const base = window.wanigan;
      const proxy = (target, changes) => new Proxy(target, { get(t, p) { return p in changes ? changes[p] : t[p]; } });
      window.wanigan = proxy(base, {
        sessions: proxy(base.sessions, {
          list: async () => (await base.sessions.list()).map(session => ({ ...session,
            displayTitle: session.id === 's1' ? 'Checkout review · fictional fixture' : null,
            projectPath: session.projectId === 'p1' ? '/example/storefront' : '/example/platform',
            harnessId: session.providerId === 'claude' ? 'claude-code' : 'codex', capabilities: { hooks: false },
          })),
          baseline: async () => ({ head: 'abc123', dirty: [], at: Date.now() }),
          buffer: async () => '', scrollback: async () => 'Fictional UI fixture. No live terminal.\\r\\n',
          write: async () => { throw new Error('Fixture cannot send terminal input'); },
        }),
        policy: proxy(base.policy, {
          trust: async () => 'project',
          chain: async () => ({ total: 0, unchainedBefore: 0, chained: 0, verifiedThrough: 0,
            lastVerifiedId: null, firstBreak: null, head: null, watched: null, checkedAt: Date.now(),
            signature: { state: 'unsigned', reason: 'Fictional empty ledger.' }, keyFingerprint: null }),
        }),
        worktrees: proxy(base.worktrees, { setup: async projectId => ({projectId,depsMode:'link',setup:[],teardown:[],updatedAt:null,include:{state:'absent'}}), commandRuns: async () => [] }),
        transcripts: proxy(base.transcripts, { search: async () => [] }),
        handoff: proxy(base.handoff, { plan: async () => ({ targets: [] }) }),
        providers: proxy(base.providers, { checkObserveOnlyHooks: async () => {
          throw new Error('Fictional UI fixture; runtime capability checks are not performed.');
        } }),
        review: proxy(base.review, {
          recipe: async () => ({ commands: [] }), history: async () => [],
          run: async (...args) => { window.__workspaceReviewWrites.push(['run', ...args]); throw new Error('Fixture cannot run checks'); },
          saveRecipe: async (...args) => { window.__workspaceReviewWrites.push(['saveRecipe', ...args]); throw new Error('Fixture cannot save checks'); },
        }),
        code: proxy(base.code, {
          changes: async () => ({ isRepo: true, branch: 'fixture/review', headMoved: false, commits: 0,
            attributed: true, unreadable: null,
            files: [{ path: 'FICTIONAL-UI-FIXTURE.md', index: ' ', work: 'M', staged: false, untracked: false }] }),
          diff: async () => 'diff --git a/FICTIONAL-UI-FIXTURE.md b/FICTIONAL-UI-FIXTURE.md\\n--- a/FICTIONAL-UI-FIXTURE.md\\n+++ b/FICTIONAL-UI-FIXTURE.md\\n@@ -1 +1 @@\\n-Fictional previous text.\\n+Fictional review text. This file does not exist.\\n',
          editors: async () => [],
        }),
        prefs: proxy(base.prefs, {
          all: async () => ({ ...(await base.prefs.all()), motion: 'off', navSidebar: 'open', ...readPrefs() }),
          set: async (key, value) => {
            if (key === 'nav_sidebar' && window.__workspaceFailNextPrefWrite) {
              window.__workspaceFailNextPrefWrite = false;
              window.__workspacePrefFailures.push({ key, value });
              throw new Error('Fictional preference save failure.');
            }
            const saved = { ...readPrefs(), [key === 'nav_sidebar' ? 'navSidebar' : key]: value };
            localStorage.setItem('__workspaceFixturePrefs', JSON.stringify(saved));
            window.__workspacePrefWrites.push({ key, value });
            localStorage.setItem('__workspaceFixturePrefWrites', JSON.stringify(window.__workspacePrefWrites));
            return { ...(await base.prefs.all()), motion: 'off', navSidebar: 'open', ...saved };
          },
        }),
      });
    })();
  `);
  await page.goto(rendererURL);
  await page.locator('.home-room').waitFor();
  const searchBox = () => page.getByRole('combobox', { name: 'Search views, projects, live sessions, settings and archived transcripts', exact: true });
  const capture = async name => {
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.themePreference = theme;
        document.documentElement.style.colorScheme = theme;
        window.dispatchEvent(new CustomEvent('wanigan:theme-changed', { detail: { preference: theme, resolved: theme } }));
      }, theme);
      const file = `${name}-${theme}.png`;
      await page.screenshot({ path: path.join(out, file), scale: 'css', animations: 'disabled' });
      screenshots.push({ file, ...(await page.evaluate(() => ({
        theme: document.documentElement.dataset.theme,
        bodyColor: getComputedStyle(document.body).backgroundColor,
        viewport: { width: innerWidth, height: innerHeight },
        scrollWidth: document.documentElement.scrollWidth,
        navigationButtons: document.querySelectorAll('.workbench-navigation button').length,
        visibleNavigationButtons: [...document.querySelectorAll('.workbench-navigation button')].filter(button => button.getClientRects().length > 0).length,
        bodyText: document.body.innerText,
      }))) });
    }
  };
  const visit = async route => {
    const destination = page.locator(`[data-nav-tab="${route}"]`).last();
    if (await destination.isVisible()) await destination.click();
    else {
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press('Meta+k');
      const search = searchBox();
      const labels = { mission: 'Home', sessions: 'Sessions', learning: 'Learning', runs: 'Runs', settings: 'Settings', control: phase === 'before' ? 'Review' : 'Goals', board: 'Board', relay: 'Relay' };
      await search.fill(labels[route]);
      await page.locator('.command-item').filter({ hasText: labels[route] }).first().click();
    }
    if (phase === 'after') await page.waitForFunction(route => document.querySelector('[aria-label="Switch workspace view"]')?.value === route, route);
    else await page.locator('.workbench-location').filter({ hasText: { mission: 'Home', sessions: 'Sessions', learning: 'Learning', runs: 'Runs', settings: 'Settings', control: /Review|Goals/, board: 'Board', relay: 'Relay' }[route] }).waitFor();
    await page.waitForTimeout(350);
    const boundary = page.getByRole('heading', { name: 'Let’s try this view again.' });
    if (await boundary.count()) {
      await page.getByText('Technical details', { exact: true }).click();
      throw new Error(`${route} error boundary: ${await page.locator('body').innerText()}`);
    }
  };
  for (const route of ['mission', 'sessions', 'learning', 'runs', 'settings', 'control', 'board', 'relay']) {
    await visit(route);
    await capture(`${route}-1440x1000`);
  }
  await visit('learning');
  await page.getByRole('tab', { name: /^Context/ }).click();
  await page.locator('.learning-scroll[data-area="context"]').waitFor();
  await capture('learning-context-1440x1000');
  await visit('sessions');
  await page.getByRole('button', { name: 'Review work', exact: true }).click();
  await page.getByRole('dialog', { name: 'Review session work', exact: true }).waitFor();
  await page.locator('.session-review .code-file').first().click();
  await capture('session-review-1440x1000');
  if (phase === 'after') {
    const sections = page.getByRole('group', { name: 'Session review section', exact: true });
    await sections.getByRole('button', { name: 'Checks & evidence', exact: true }).click();
    await capture('session-review-checks-1440x1000');
    const commands = page.getByRole('textbox', { name: 'Review gate commands', exact: true });
    await commands.fill('# Fictional review draft. Never run.');
    const commandsHandle = await commands.elementHandle();
    await sections.getByRole('button', { name: 'Changes', exact: true }).click();
    assert.equal(await commands.isVisible(), false);
    assert.equal(await commandsHandle.evaluate(element => element.isConnected), true);
    assert.equal(await page.locator('.session-review .code-file.on').count(), 1);
    await sections.getByRole('button', { name: 'Checks & evidence', exact: true }).click();
    assert.equal(await commands.inputValue(), '# Fictional review draft. Never run.');
    assert.deepEqual(await page.evaluate(() => window.__workspaceReviewWrites), []);
    await page.setViewportSize({ width: 960, height: 560 });
    await capture('session-review-checks-960x560');
    await sections.getByRole('button', { name: 'Changes', exact: true }).click();
    await capture('session-review-changes-960x560');
    await page.setViewportSize({ width: 1440, height: 1000 });
    checks.push('Session review switches between Changes and Checks & evidence without unmounting or losing unsaved commands; switching makes no save or run request. Both sections captured at desktop and compact widths.');
  }
  await page.getByRole('button', { name: 'Back to session', exact: true }).click();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Meta+k');
  await searchBox().waitFor();
  await capture('command-palette-1440x1000');
  await page.keyboard.press('Escape');
  await visit('sessions');
  await page.setViewportSize({ width: 960, height: 560 });
  await capture('sessions-960x560');
  const opener = page.getByRole('button', { name: /(?:Open|Show) navigation/ });
  if (await opener.isVisible()) await opener.click();
  await capture('navigation-960x560');
  if (phase === 'after') {
    const route = () => page.getByRole('combobox', { name: 'Switch workspace view', exact: true }).inputValue();
    const toggle = () => page.locator('.hdr-toggle');
    const navigation = () => page.getByRole('navigation', { name: 'Workspace navigation', exact: true });
    const palette = async () => {
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press('Meta+k');
      await searchBox().waitFor();
      return searchBox();
    };
    const waitForPreference = async value => page.waitForFunction(value => {
      const writes = window.__workspacePrefWrites;
      return writes.length > 0 && writes.at(-1).key === 'nav_sidebar' && writes.at(-1).value === value;
    }, value);
    const assertNoOverflow = async () => {
      const geometry = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(geometry.scroll <= geometry.viewport, JSON.stringify(geometry));
    };

    // Drawer closure must preserve desktop preference and restore focus.
    const writesBeforeDrawer = await page.evaluate(() => window.__workspacePrefWrites.length);
    const drawer = page.getByRole('dialog', { name: 'Workspace navigation', exact: true });
    assert.equal(await drawer.isVisible(), true);
    assert.equal(await drawer.locator('.workbench-area-button[aria-current]').evaluate(element => element === document.activeElement), true);
    const drawerRoute = await route();
    await page.keyboard.press('ArrowDown');
    assert.equal(await route(), drawerRoute);
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'detached' });
    assert.equal(await toggle().getAttribute('aria-expanded'), 'false');
    assert.equal(await toggle().evaluate(element => element === document.activeElement), true);
    assert.equal(await page.evaluate(() => window.__workspacePrefWrites.length), writesBeforeDrawer);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await navigation().waitFor();
    assert.equal(await toggle().getAttribute('aria-expanded'), 'true');
    checks.push('Narrow drawer focuses the current area; arrows only move focus; Escape restores the opener without changing desktop preferences.');

    // Closing chrome must not remount or destroy the active terminal/draft.
    await visit('sessions');
    await page.locator('.terminal-host:visible .xterm').waitFor();
    const terminal = await page.locator('.terminal-host:visible .xterm').elementHandle();
    const composer = page.getByRole('textbox', { name: 'Message the agent', exact: true });
    await composer.fill('Unsaved fictional navigation probe. Never sent.');
    const openWidth = await page.locator('.terminal-host:visible').evaluate(element => element.getBoundingClientRect().width);
    await toggle().click();
    await navigation().waitFor({ state: 'detached' });
    await waitForPreference('closed');
    assert.equal(await toggle().getAttribute('aria-expanded'), 'false');
    assert.equal(await terminal.evaluate(element => element.isConnected), true);
    assert.equal(await composer.inputValue(), 'Unsaved fictional navigation probe. Never sent.');
    const hiddenWidth = await page.locator('.terminal-host:visible').evaluate(element => element.getBoundingClientRect().width);
    assert.ok(hiddenWidth > openWidth, `terminal expanded from ${openWidth} to ${hiddenWidth}`);
    await assertNoOverflow();
    await capture('sessions-navigation-hidden-1440x1000');
    const headerAttention = page.locator('.app-header').getByRole('button', { name: /need you.*Show who is waiting/ });
    await headerAttention.click();
    await page.getByRole('dialog', { name: 'Sessions that need you', exact: true }).waitFor();
    await capture('hidden-navigation-attention-1440x1000');
    await page.keyboard.press('Escape');
    await toggle().click();
    await navigation().waitFor();
    await waitForPreference('open');
    assert.equal(await terminal.evaluate(element => element.isConnected), true);
    assert.equal(await composer.inputValue(), 'Unsaved fictional navigation probe. Never sent.');
    checks.push(`Desktop hide/show preserves the draft and pooled xterm; terminal width increases from ${openWidth}px to ${hiddenWidth}px. Hidden navigation retains an actionable attention control.`);

    // Both independent controls in an area heading must do what their name says.
    const beforeDisclosure = await route();
    let disclosure = navigation().getByRole('button', { name: /^Expand / }).first();
    if (await disclosure.count() === 0) {
      await navigation().getByRole('button', { name: /^Collapse / }).last().click();
      disclosure = navigation().getByRole('button', { name: /^Expand / }).first();
    }
    const expandedName = (await disclosure.getAttribute('aria-label')).replace('Expand ', '');
    await disclosure.click();
    assert.equal(await route(), beforeDisclosure);
    assert.equal(await navigation().getByRole('button', { name: `Collapse ${expandedName}`, exact: true }).getAttribute('aria-expanded'), 'true');
    while (await navigation().getByRole('button', { name: /^Collapse / }).count()) {
      await navigation().getByRole('button', { name: /^Collapse / }).first().click();
    }
    const sourceRoutes = (await import('../src/shared/routes.ts')).TABS;
    const search = await palette();
    await page.getByRole('group', { name: 'Search category', exact: true }).getByRole('button', { name: 'Views', exact: true }).click();
    for (const entry of sourceRoutes) {
      await search.fill(entry.label);
      assert.ok((await page.locator('.command-item strong').allTextContents()).includes(entry.label), `search exposes ${entry.id}`);
    }
    await search.fill('Skills');
    await page.locator('.command-item').filter({ has: page.locator('strong', { hasText: /^Skills$/ }) }).click();
    await page.locator('.workbench-location').filter({ hasText: 'Skills' }).waitFor();
    const selectedRoute = page.locator('.workbench-local-routes [data-nav-tab="skills"]');
    await selectedRoute.waitFor({ state: 'visible' });
    assert.equal(await selectedRoute.getAttribute('aria-current'), 'page');
    checks.push(`Area disclosure does not navigate. Every ${sourceRoutes.length} registered destination is searchable with all groups folded; choosing Skills reveals its selected route.`);

    const settingsSearch = await palette();
    await page.getByRole('group', { name: 'Search category', exact: true }).getByRole('button', { name: 'Settings', exact: true }).click();
    assert.equal(await settingsSearch.inputValue(), '');
    assert.ok((await page.locator('.command-item strong').allTextContents()).includes('Installed agent runtimes'), 'empty Settings scope includes indexed settings');
    await capture('command-palette-settings-1440x1000');
    await page.getByRole('group', { name: 'Search category', exact: true }).getByRole('button', { name: 'Views', exact: true }).click();
    await settingsSearch.fill('backup privacy');
    assert.ok((await page.locator('.command-item strong').allTextContents()).includes('Settings'));
    await settingsSearch.fill('review git');
    assert.ok((await page.locator('.command-item strong').allTextContents()).includes('Changes'));
    await capture('command-palette-multiword-1440x1000');
    await page.keyboard.press('Escape');
    checks.push('Empty Settings search scope exposes indexed sections. Unordered multiword queries “backup privacy” and “review git” find Settings and Changes.');

    // This proves renderer preference requests/reload semantics, not SQLite IPC.
    await toggle().click();
    await waitForPreference('closed');
    await page.reload();
    await page.locator('.app-header').waitFor();
    assert.equal(await toggle().getAttribute('aria-expanded'), 'false');
    assert.equal(await navigation().count(), 0);
    await toggle().click();
    await waitForPreference('open');
    await page.reload();
    await navigation().waitFor();
    assert.equal(await toggle().getAttribute('aria-expanded'), 'true');
    const writesBeforeResize = await page.evaluate(() => window.__workspacePrefWrites.length);
    await page.setViewportSize({ width: 960, height: 560 });
    await navigation().waitFor({ state: 'detached' });
    assert.equal(await toggle().getAttribute('aria-expanded'), 'false');
    await toggle().click();
    await drawer.waitFor();
    await navigation().getByRole('button', { name: 'Automation', exact: true }).click();
    await drawer.waitFor({ state: 'detached' });
    assert.equal(await route(), 'runs');
    assert.equal(await toggle().evaluate(element => element === document.activeElement), true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await navigation().waitFor();
    assert.equal(await toggle().getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => window.__workspacePrefWrites.length), writesBeforeResize);
    await assertNoOverflow();
    checks.push('Desktop open and closed choices survive reload through the recorded prefs bridge. Resizing and selecting a narrow-drawer destination preserve desktop preference and restore opener focus.');

    // Palette actions may remove their own opener or hand focus to a drawer.
    await page.getByRole('button', { name: 'Search all tools', exact: true }).click();
    await searchBox().fill('Hide navigation');
    await page.keyboard.press('Enter');
    await navigation().waitFor({ state: 'detached' });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await toggle().evaluate(element => element === document.activeElement), true, 'hidden palette opener falls back to navigation toggle');
    const routePicker = page.getByRole('combobox', { name: 'Switch workspace view', exact: true });
    assert.equal(await routePicker.locator('option').count(), sourceRoutes.length);
    await routePicker.selectOption('control');
    await page.getByRole('heading', { name: 'Goals', exact: true }).waitFor();
    assert.equal(await route(), 'control');
    assert.equal(await navigation().count(), 0);
    await page.setViewportSize({ width: 960, height: 560 });
    await page.locator('.app-header .nav-views-button').click();
    await searchBox().fill('Show navigation');
    await page.keyboard.press('Enter');
    await drawer.waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await drawer.evaluate(element => element.contains(document.activeElement)), true, 'palette action leaves focus inside opened drawer');
    await page.keyboard.press('Escape');
    checks.push('Rail search → Hide navigation restores focus to the surviving header toggle. Compact header search → Show navigation leaves focus inside the drawer. The hidden-rail view picker lists all routes and opens Goals.');

    assert.equal(await route(), 'control');
    const projectSearch = await palette();
    await page.getByRole('group', { name: 'Search category', exact: true }).getByRole('button', { name: 'Projects', exact: true }).click();
    await projectSearch.fill('storefront');
    await page.locator('.command-item').filter({ hasText: 'storefront' }).first().click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Switch workspace view"]')?.value === 'sessions');
    assert.equal(await route(), 'sessions');
    assert.match(await page.locator('.space-switch-trigger').textContent(), /storefront/);
    checks.push('Opening storefront from project search after Goals selects Sessions and storefront scope, instead of reusing workspace-wide Goals.');

    await page.setViewportSize({ width: 720, height: 560 });
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Meta+1');
    await page.locator('.sessions-view').waitFor();
    await assertNoOverflow();
    const headerOverflow = await page.locator('.app-header').evaluate(element => [...element.querySelectorAll('button, select')]
      .filter(control => control.getClientRects().length > 0)
      .map(control => ({ label: control.getAttribute('aria-label') || control.textContent, left: control.getBoundingClientRect().left, right: control.getBoundingClientRect().right }))
      .filter(control => control.left < 0 || control.right > innerWidth));
    assert.deepEqual(headerOverflow, [], 'visible header controls fit 720px');
    await capture('sessions-720x560');
    checks.push('At 720px, the page has no horizontal overflow and every visible header button/select stays within the viewport.');

    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.equal(await toggle().getAttribute('aria-expanded'), 'false');
    await page.evaluate(() => { window.__workspaceFailNextPrefWrite = true; });
    await toggle().click();
    await navigation().waitFor();
    await page.getByRole('alert').filter({ hasText: 'Navigation changed for this window, but its preference could not be saved' }).waitFor();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('__workspaceFixturePrefs')).navSidebar), 'closed');
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('wanigan:prefs-changed'));
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    assert.equal(await navigation().isVisible(), true);
    assert.equal(await toggle().getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape');
    const writesBeforeRecovery = await page.evaluate(() => window.__workspacePrefWrites.length);
    await toggle().click();
    await page.waitForFunction(count => window.__workspacePrefWrites.length > count, writesBeforeRecovery);
    await waitForPreference('closed');
    await toggle().click();
    await waitForPreference('open');
    report.preferenceFailures = await page.evaluate(() => window.__workspacePrefFailures);
    await page.reload();
    await navigation().waitFor();
    assert.equal(await toggle().getAttribute('aria-expanded'), 'true');
    checks.push('A rejected preference save reports the failure and retains chosen visibility across focus/preferences refresh. Later successful toggles save and survive reload.');
    report.preferenceWrites = await page.evaluate(() => window.__workspacePrefWrites);
  }
  assert.deepEqual(errors, []);
  report.result = 'pass';
  rmSync(path.join(out, 'failure.png'), { force: true });
  console.log(JSON.stringify({ result: 'pass', output: out, screenshots: screenshots.map(shot => shot.file), errors, checks }, null, 2));
} catch (error) {
  report.result = 'fail'; report.failure = String(error.stack ?? error);
  if (page) console.error((await page.locator('body').innerText()).slice(0, 12000));
  if (page) await page.screenshot({ path: path.join(out, 'failure.png'), scale: 'css' }).catch(() => {});
  throw error;
} finally {
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  await app.close();
}
