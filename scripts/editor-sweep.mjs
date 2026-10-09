#!/usr/bin/env node
// The code editor against a real, seeded core whose demo projects are real
// folders, in both themes: open a file from Changes, type, save (and read the
// disk), quick open, breadcrumbs and their menus, Back and Forward, an agent's
// change to a file with nothing unsaved and with unsaved work, a save refused
// because the file changed first and the merge that follows, Drupal core read-
// only until Edit anyway, Edit code from a part picked in the live view, the
// drawer beneath a session and beside the view. Fails on console errors and on
// anything the disk or the core does not confirm. Screenshots go to
// .artifacts/ui/<theme>-editor-<name>.png; look at them.
import { LIVE_DEFAULTS } from './ui-live-defaults.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { BRIDGE, root, startGateway } from './ui-harness.mjs';

const out = join(root, '.artifacts', 'ui');
mkdirSync(out, { recursive: true });
const { base, gateway } = await startGateway();
const failures = [];

/** The live view, played: a page with one part (the demo module's pay button), picked on request. */
const LIVE_STUB = `(() => {
  const region = {
    index: 0, file: 'modules/custom/northstar_checkout/templates/northstar-pay-button.html.twig', entity: null, block: null, view: null, element: null,
    component: null, piece: null, hook: 'northstar_pay_button', field: null, suggestions: ['northstar-pay-button'], parent: null, order: 0,
    rect: { x: 40, y: 40, width: 220, height: 48 },
  };
  const listeners = new Set();
  window.__liveCalls = [];
  const state = { projectId: null, url: 'https://northstar.example.test/checkout/7/pay', title: 'Pay', loading: false, canGoBack: false, canGoForward: false, error: null, logged: 0 };
  const answers = {
    show: async (projectId) => { state.projectId = projectId; setTimeout(() => { for (const l of listeners) l({ ...state }); }, 50); return true; },
    bounds: () => {}, hide: async () => {}, cover: async () => null, go: async () => true,
    // What the page was asked to do after an edit: the sweep reads these.
    reload: async (hard) => { window.__liveCalls.push(hard ? 'reload-hard' : 'reload'); }, css: async () => { window.__liveCalls.push('css'); return 1; },
    back: async () => {}, forward: async () => {}, open: async () => {}, devtools: async () => {},
    scan: async () => [region], outline: async () => 1, clear: async () => {}, cancelPick: async () => {},
    pick: async () => ({ url: state.url, selector: 'button.pay-button', tag: 'button', text: 'Pay', own: null, classes: ['pay-button'], rect: region.rect, style: {}, regions: [region] }),
    capture: async () => null, problems: async () => [], mutations: async () => 0, picked: async () => null, style: async () => null, unstyle: async () => null,
    editText: async () => null, cancelEdit: async () => {}, helperChanged: async () => null, helperSave: async () => ({ ok: false, error: 'no helper', label: null }),
    hasScript: async () => true,
    onState: (l) => { listeners.add(l); return () => listeners.delete(l); },
  };
  window.wanigan.live = answers;
})();`;

const browser = await chromium.launch();
try {
  let first = true;
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, deviceScaleFactor: 2 });
    await context.addInitScript(BRIDGE);
    await context.addInitScript(LIVE_STUB);
    await context.addInitScript(LIVE_DEFAULTS);
    await context.addInitScript(`try { localStorage.setItem('wanigan.theme', '${theme}'); } catch {}`);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    const fail = (what) => failures.push(`${theme}/editor: ${what}`);
    const shot = async (name) => { await page.waitForTimeout(250); await page.screenshot({ path: join(out, `${theme}-editor-${name}.png`) }); };
    const callCore = (method, params) => page.evaluate(([m, p]) => window.wanigan.call(m, p), [method, params]);
    const hook = (sessionId, event, input) => page.evaluate(async (body) => {
      const r = await fetch('/test/hook', { method: 'POST', body: JSON.stringify(body) });
      if (!r.ok) throw new Error(await r.text());
    }, { sessionId, event, input });
    const text = () => page.evaluate(() => [...document.querySelectorAll('.editor-code .cm-line')].map((l) => l.textContent).join('\n'));
    const activeTab = () => page.textContent('.editor-tab.active .editor-tab-name').catch(() => null);
    const crumbs = () => page.$$eval('.crumbs-path .crumb-button', (b) => b.map((x) => x.textContent.trim()));
    const symbols = () => page.$$eval('.crumbs-path .crumb-symbol .crumb-button', (b) => b.map((x) => x.textContent.trim()));
    const settle = () => page.waitForTimeout(300);
    /** One part of the sweep: a part that throws is a failure, with a picture of where it stopped, and the rest still runs. */
    const step = async (name, run) => {
      try { await run(); } catch (e) {
        fail(`${name}: ${String(e.message ?? e).split('\n')[0]}`);
        await page.screenshot({ path: join(out, `${theme}-editor-stopped-${name}.png`) }).catch(() => {});
      }
    };

    await page.goto(base);
    await page.waitForSelector('.rail-projects a');
    const projects = await callCore('projects.list', {});
    const project = projects.find((p) => /northstar/i.test(p.name));
    const ns = project.key;
    const repo = project.path;
    const css = 'web/modules/custom/northstar_checkout/css/pay-button.css';
    const twig = 'web/modules/custom/northstar_checkout/templates/northstar-pay-button.html.twig';
    const php = 'web/modules/custom/northstar_checkout/src/Controller/CheckoutController.php';
    const coreTwig = 'web/core/modules/system/templates/page.html.twig';
    const agent = (await callCore('sessions.list', { live: true })).find((x) => x.title === 'Free shipping banner');
    if (first) {
      // Drupal core in the demo's site, only for this sweep: what opens read-only, and the docroot the live view finds.
      for (const [file, body] of [['web/core/lib/Drupal.php', '<?php\n// Drupal core, as far as this sweep needs it.\nclass Drupal {}\n'], [coreTwig, '<main role="main">\n  {{ page.content }}\n</main>\n']]) {
        mkdirSync(join(repo, file, '..'), { recursive: true });
        writeFileSync(join(repo, file), body);
      }
      first = false;
    }

    // From Changes: Edit opens the file in the drawer, at the top, with its path as breadcrumbs.
    await step('changes', async () => {
      await page.goto(`${base}#/p/${ns}/changes`);
      await page.waitForSelector('.dl-add');
      await page.locator(`.diff-slot[data-path="${css}"] button:has-text("Edit")`).click();
      await page.waitForSelector('.editor-code .cm-content', { timeout: 15_000 }).catch(() => fail('Edit in Changes did not open the editor'));
      await page.waitForFunction(() => document.querySelector('.editor-code .cm-line')?.textContent?.includes('pay button'), null, { timeout: 8000 }).catch(() => fail('the CSS file did not show'));
      const path = await crumbs();
      if (path.slice(1, 7).join('/') !== css) fail(`the breadcrumbs read ${path.join(' › ')}`);
      await page.waitForFunction(() => document.activeElement?.classList.contains('cm-content'), null, { timeout: 3000 }).catch(() => fail('opening a file did not put the cursor in it'));
      const label = await page.getAttribute('.editor-code .cm-content', 'aria-label');
      if (!/pay-button\.css, CSS/.test(label ?? '')) fail(`the text is named "${label}" for a screen reader`);
      if (!(await page.$('.editor-code .cm-content .tok-propertyName, .editor-code .cm-content span[class]'))) fail('the CSS has no highlighting');
      await shot('changes');

      // Type and save: the dot, ⌘S, and the disk.
      await page.keyboard.press('Meta+ArrowDown');
      await page.keyboard.press('Enter');
      const rule = `.pay-button--${theme} {`;
      await page.keyboard.type(`${rule}`);
      await page.keyboard.press('Enter');
      await page.keyboard.type('gap: 4px;');
      await page.keyboard.press('Escape'); // any completion pop-up
      await page.waitForSelector('.editor-tab.active.unsaved', { timeout: 3000 }).catch(() => fail('typing did not mark the file unsaved'));
      await shot('unsaved');
      await page.keyboard.press('Meta+s');
      await page.waitForSelector('.editor-tab.active:not(.unsaved)', { timeout: 5000 }).catch(() => fail('⌘S did not save'));
      const onDisk = readFileSync(join(repo, css), 'utf8');
      if (!onDisk.includes(`${rule}\n  gap: 4px;\n}`)) fail(`the saved file does not hold what was typed (brackets closed, indented): ${JSON.stringify(onDisk.slice(-80))}`);
      const activity = await callCore('activity.list', { projectId: project.id, limit: 3 });
      if (!activity.some((a) => a.actor === 'owner' && a.verb === 'edited' && a.detail === css)) fail('the save is not in the activity');
    });

    // Quick open, at a line: a PHP method, named in the breadcrumbs.
    await step('quick-open', async () => {
      await page.keyboard.press('Meta+p');
      await page.waitForSelector('.quick-open', { timeout: 3000 }).catch(() => fail('⌘P did not open quick open'));
      await page.keyboard.type('chkctl');
      await page.waitForSelector('.quick-open-option.active:has-text("CheckoutController.php")', { timeout: 5000 }).catch(() => fail('quick open did not find CheckoutController.php by its humps'));
      await shot('quick-open');
      await page.fill('.quick-open input[role="combobox"]', 'CheckoutController.php:25');
      await page.waitForSelector('.quick-open-option.active:has-text("CheckoutController.php")');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.editor-tab.active .editor-tab-name')?.textContent === 'CheckoutController.php', null, { timeout: 8000 }).catch(() => fail('Enter did not open the file'));
      await settle();
      const status = await page.textContent('.editor-status button').catch(() => '');
      if (!/^Line 25,/.test(status)) fail(`the file opened at "${status}", not line 25`);
      await page.waitForFunction(() => [...document.querySelectorAll('.crumbs-path .crumb-symbol .crumb-button')].map((b) => b.textContent.trim()).join(' › ') === 'CheckoutController › build', null, { timeout: 5000 })
        .catch(async () => fail(`at line 25 the symbols read ${(await symbols()).join(' › ')}`));
      // The method's crumb lists its siblings; choosing one jumps there.
      await page.locator('.crumb-symbol').last().locator('.crumb-button').click();
      await page.waitForSelector('.crumb-menu .crumb-menu-item', { timeout: 3000 }).catch(() => fail('the method crumb has no menu'));
      const siblings = await page.$$eval('.crumb-menu .crumb-menu-label', (l) => l.map((x) => x.textContent));
      if (siblings.join() !== 'build,access') fail(`the methods beside build are ${siblings.join(', ')}`);
      await shot('crumb-symbols');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await settle();
      if ((await symbols()).at(-1) !== 'access') fail(`choosing access left the cursor in ${(await symbols()).join(' › ')}`);
      // A folder crumb lists what is beside it; a folder opens in place.
      await page.locator('.crumb-folder .crumb-button', { hasText: 'src' }).click();
      await page.waitForSelector('.crumb-menu .crumb-menu-item', { timeout: 3000 });
      const beside = await page.$$eval('.crumb-menu .crumb-menu-label', (l) => l.map((x) => x.textContent));
      for (const want of ['src/', 'templates/', 'css/', 'northstar_checkout.routing.yml']) if (!beside.includes(want)) fail(`the src crumb's menu lacks ${want} (${beside.join(', ')})`);
      await shot('crumb-folder');
      await page.keyboard.type('routing');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.editor-tab.active .editor-tab-name')?.textContent === 'northstar_checkout.routing.yml', null, { timeout: 5000 })
        .catch(() => fail('a file chosen from a folder crumb did not open'));
      await settle();
    });

    // Back and Forward, across files: ⌃- twice, ⌃⇧- once; the mouse's back button; the recent places.
    await step('back-forward', async () => {
      await page.keyboard.press('Control+Minus');
      await settle();
      if ((await activeTab()) !== 'CheckoutController.php' || (await symbols()).at(-1) !== 'access') fail(`Back went to ${await activeTab()} ${(await symbols()).join(' › ')}`);
      await page.keyboard.press('Control+Minus');
      await settle();
      if ((await symbols()).at(-1) !== 'build') fail(`Back again went to ${(await symbols()).join(' › ')}, not build`);
      await page.keyboard.press('Control+Shift+Minus');
      await settle();
      if ((await symbols()).at(-1) !== 'access') fail(`Forward went to ${(await symbols()).join(' › ')}`);
      const box = await page.locator('.editor-code').boundingBox();
      await page.mouse.move(box.x + 200, box.y + 40);
      await page.evaluate(() => {
        const at = document.querySelector('.editor-code');
        for (const type of ['mousedown', 'mouseup']) at.dispatchEvent(new MouseEvent(type, { button: 3, bubbles: true }));
      });
      await settle();
      if ((await symbols()).at(-1) !== 'build') fail(`the mouse's back button went to ${(await symbols()).join(' › ')}`);
      await page.click('.crumbs-nav button[aria-label="Recent places"]');
      await page.waitForSelector('.crumbs-recent .crumb-menu-item', { timeout: 3000 }).catch(() => fail('Recent places has no list'));
      await shot('recent');
      await page.keyboard.press('Escape');
      // ⌘⇧. moves to the breadcrumbs; arrows move along them; Escape goes back to the text.
      await page.keyboard.press('Meta+Shift+Period');
      await settle();
      if (!(await page.evaluate(() => document.activeElement?.classList.contains('crumb-button')))) fail('⌘⇧. did not move to the breadcrumbs');
      await page.keyboard.press('ArrowLeft');
      if ((await page.evaluate(() => document.activeElement?.textContent?.trim())) !== 'CheckoutController') fail('← did not move to the crumb before');
      await page.keyboard.press('Escape');
      if (!(await page.evaluate(() => document.activeElement?.classList.contains('cm-content')))) fail('Escape on the breadcrumbs did not go back to the text');
      // Escape then Tab leaves the editor.
      await page.keyboard.press('Escape');
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => !!document.activeElement?.closest('.cm-editor'))) fail('Escape then Tab did not leave the editor');
    });

    // An agent changes the template while nothing is unsaved: it reloads, and says who.
    await step('agent', async () => {
      await page.keyboard.press('Meta+p');
      await page.waitForSelector('.quick-open');
      await page.keyboard.type('pay-button.html.twig');
      await page.waitForSelector('.quick-open-option.active:has-text("northstar-pay-button.html.twig")', { timeout: 5000 });
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.editor-tab.active .editor-tab-name')?.textContent === 'northstar-pay-button.html.twig', null, { timeout: 8000 });
      await settle();
      const before = readFileSync(join(repo, twig), 'utf8');
      writeFileSync(join(repo, twig), before.replace('<button', `<button data-theme="${theme}"`));
      await hook(agent.id, 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: join(repo, twig) } });
      await page.waitForSelector('.editor-notice:has-text("Claude Code (Free shipping banner) changed this file")', { timeout: 6000 }).catch(() => fail('an agent’s edit did not reload the file, naming the agent'));
      if (!(await text()).includes(`data-theme="${theme}"`)) fail('the reloaded text is not the agent’s');
      await shot('reloaded');
      await page.click('.editor-notice button:has-text("Compare")');
      await page.waitForSelector('.compare .cm-mergeView', { timeout: 5000 }).catch(() => fail('Compare did not show the two versions'));
      await shot('compare');
      await page.click('.compare button:has-text("Close the comparison")');

      // With unsaved work: the agent's change is not applied; Compare and merge; Save merged writes the result.
      await page.click('.editor-code .cm-content');
      await page.keyboard.press('Meta+ArrowDown');
      await page.keyboard.type(`{# ${theme}: mine #}`);
      await page.waitForSelector('.editor-tab.active.unsaved');
      const theirs = readFileSync(join(repo, twig), 'utf8').replace('type="submit"', `type="submit" data-agent-${theme}`);
      writeFileSync(join(repo, twig), theirs);
      await hook(agent.id, 'PostToolUse', { tool_name: 'Write', tool_input: { file_path: join(repo, twig) } });
      await page.waitForSelector('.editor-notice-strong:has-text("while you were editing it")', { timeout: 6000 }).catch(() => fail('an agent’s edit over unsaved work did not say so'));
      if ((await text()).includes(`data-agent-${theme}`)) fail('the agent’s change replaced unsaved work');
      await shot('changed');
      await page.click('.editor-notice-strong button:has-text("Compare and merge")');
      await page.waitForSelector('.compare .cm-merge-revert button', { timeout: 5000 }).catch(() => fail('the merge view has no arrows to take their change'));
      await shot('merge');
      await page.click('.compare .cm-merge-revert button');
      await settle();
      await page.click('.compare button:has-text("Save merged")');
      await page.waitForSelector('.editor-tab.active:not(.unsaved)', { timeout: 6000 }).catch(() => fail('Save merged did not save'));
      const merged = readFileSync(join(repo, twig), 'utf8');
      if (!merged.includes(`data-agent-${theme}`) || !merged.includes(`{# ${theme}: mine #}`)) fail(`the merge did not keep both: ${JSON.stringify(merged.slice(-160))}`);

      // A save refused because the file changed first opens the merge straight away.
      await page.click('.editor-code .cm-content');
      await page.keyboard.press('Meta+ArrowDown');
      await page.keyboard.type(`{# ${theme}: again #}`);
      writeFileSync(join(repo, twig), `${readFileSync(join(repo, twig), 'utf8')}{# someone else #}\n`);
      await page.keyboard.press('Meta+s');
      await page.waitForSelector('.compare .cm-mergeView', { timeout: 6000 }).catch(() => fail('a refused save did not open the merge'));
      if (readFileSync(join(repo, twig), 'utf8').includes(`${theme}: again`)) fail('a save over someone else’s change wrote anyway');
      await page.click('.compare button:has-text("Use theirs")');
      await page.waitForSelector('.editor-tab.active:not(.unsaved)', { timeout: 3000 }).catch(() => fail('Use theirs left the file unsaved'));
    });

    // Drupal core: read-only with the reason; Edit anyway makes it editable; closing unsaved asks.
    await step('read-only', async () => {
      await page.keyboard.press('Meta+p');
      await page.waitForSelector('.quick-open');
      await page.keyboard.type('system page.html');
      await page.waitForSelector('.quick-open-option.active:has-text("page.html.twig")', { timeout: 5000 });
      await page.keyboard.press('Enter');
      await page.waitForSelector('.editor-notice-locked:has-text("Drupal core")', { timeout: 8000 }).catch(() => fail('Drupal core did not open read-only with its reason'));
      await page.click('.editor-code .cm-content');
      await page.keyboard.type('x');
      if ((await text()).includes('x<main') || (await page.$('.editor-tab.active.unsaved'))) fail('read-only Drupal core took typing');
      await shot('readonly');
      await page.click('.editor-notice-locked button:has-text("Edit anyway")');
      await page.click('.editor-code .cm-content');
      await page.keyboard.type('x');
      await page.waitForSelector('.editor-tab.active.unsaved', { timeout: 3000 }).catch(() => fail('Edit anyway did not make it editable'));
      await page.click('.editor-tab.active .editor-tab-close');
      await page.waitForSelector('.dialog:has-text("Save the changes to page.html.twig?")', { timeout: 3000 }).catch(() => fail('closing an unsaved file did not ask'));
      await shot('close-unsaved');
      await page.click('.dialog button:has-text("Close without saving")');
      if (readFileSync(join(repo, coreTwig), 'utf8') !== '<main role="main">\n  {{ page.content }}\n</main>\n') fail('closing without saving changed Drupal core');
    });

    // Unsaved text outlives the window: typed, the window reloaded, the file opened again.
    await step('draft', async () => {
      await page.keyboard.press('Meta+p');
      await page.waitForSelector('.quick-open');
      await page.keyboard.type('routing.yml');
      await page.waitForSelector('.quick-open-option.active:has-text("northstar_checkout.routing.yml")', { timeout: 5000 });
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.editor-tab.active .editor-tab-name')?.textContent === 'northstar_checkout.routing.yml', null, { timeout: 8000 });
      await page.click('.editor-code .cm-content');
      await page.keyboard.press('Meta+ArrowDown');
      await page.keyboard.type(`# ${theme}: not saved yet`);
      await page.waitForTimeout(1200);
      await page.reload();
      await page.waitForSelector('.rail-projects a');
      await page.keyboard.press('Meta+p');
      await page.waitForSelector('.quick-open');
      await page.keyboard.type('routing.yml');
      await page.waitForSelector('.quick-open-option.active:has-text("northstar_checkout.routing.yml")', { timeout: 5000 });
      await page.keyboard.press('Enter');
      await page.waitForSelector('.editor-notice:has-text("Your unsaved changes from")', { timeout: 8000 }).catch(() => fail('unsaved text did not come back after the window reloaded'));
      if (!(await text()).includes(`# ${theme}: not saved yet`) || !(await page.$('.editor-tab.active.unsaved'))) fail('the text that came back is not the unsaved text');
      await shot('draft');
      await page.click('.editor-actions button[aria-label="Revert to the saved file"]');
      await page.waitForSelector('.editor-tab.active:not(.unsaved)', { timeout: 3000 }).catch(() => fail('Revert left the file unsaved'));
    });

    // A turn's changes: Edit opens the file the turn changed, in the card's worktree the session worked in.
    await step('turn', async () => {
      const stock = (await callCore('sessions.list', { live: true })).find((x) => x.title === 'Low-stock badge on product cards');
      await page.goto(`${base}#/p/${ns}/s/${stock.id}`);
      await page.click('.turn-change .turn-diff');
      await page.click('.turn-panel .changes-files button:has(.fname:text-is("LowStockBadge.tsx"))');
      await page.waitForSelector('.turn-panel .dl-del', { timeout: 8000 });
      await page.click('.turn-panel .diff-head button:has-text("Edit")');
      await page.waitForFunction(() => document.querySelector('.editor-tab.active .editor-tab-name')?.textContent === 'LowStockBadge.tsx', null, { timeout: 8000 })
        .catch(() => fail('Edit in a turn’s changes did not open the file'));
      // The tab names the card's worktree once the cards have been read.
      await page.waitForFunction(() => /’s worktree: src\/products\/LowStockBadge\.tsx$/.test(document.querySelector('.editor-tab.active .editor-tab-open')?.getAttribute('title') ?? ''), null, { timeout: 5000 })
        .catch(async () => fail(`the turn’s file opened from "${await page.getAttribute('.editor-tab.active .editor-tab-open', 'title')}", not the card’s worktree`));
      const inTree = await callCore('files.read', { projectId: project.id, cardId: stock.cardId, path: 'src/products/LowStockBadge.tsx' });
      await page.waitForFunction((want) => [...document.querySelectorAll('.editor-code .cm-line')].map((l) => l.textContent).join('\n') === want, inTree.text, { timeout: 5000 })
        .catch(() => fail('the editor does not show the worktree’s copy of the file'));
      await page.keyboard.press('Escape');
      await shot('turn');
    });

    // The live view: a part picked on the page opens its template at the words picked.
    await step('live', async () => {
      await page.evaluate(() => window.wanigan.setSettings({ liveView: true, liveDrupal: true }));
      await callCore('live.setSite', { projectId: project.id, url: 'https://northstar.example.test/', platform: 'drupal' });
      await page.goto(`${base}#/p/${ns}/live`);
      await page.waitForSelector('.live-bar', { timeout: 8000 }).catch(() => fail('the live view did not open'));
      // Picked once the page has loaded and its parts are known, as the owner would.
      await page.waitForSelector('.live-side .live-layer', { timeout: 8000 }).catch(() => fail('the live view listed no parts'));
      await page.waitForTimeout(400);
      await page.click('.live-bar button:has-text("Pick")');
      await page.waitForSelector('.live-inspector button:has-text("Edit code")', { timeout: 8000 }).catch(() => fail('a picked part has no Edit code'));
      await page.click('.live-inspector button:has-text("Edit code")');
      await page.waitForFunction(() => document.querySelector('.editor-tab.active .editor-tab-name')?.textContent === 'northstar-pay-button.html.twig', null, { timeout: 8000 })
        .catch(() => fail('Edit code did not open the template'));
      await settle();
      const line = await page.textContent('.editor-status button').catch(() => '');
      const wantLine = readFileSync(join(repo, twig), 'utf8').split('\n').findIndex((l) => l.includes('Pay')) + 1;
      if (line !== `Line ${wantLine}, column ${readFileSync(join(repo, twig), 'utf8').split('\n')[wantLine - 1].indexOf('Pay') + 1}`) fail(`Edit code opened at "${line}", not at the picked words (line ${wantLine})`);
      await shot('live');
      // A save follows exactly as an agent's edit does: a template reloads the page past the cache, a stylesheet is swapped in place.
      const calls = () => page.evaluate(() => window.__liveCalls.slice());
      await page.evaluate(() => { window.__liveCalls.length = 0; });
      await page.click('.editor-code .cm-content');
      await page.keyboard.press('Meta+ArrowDown');
      await page.keyboard.type(`{# ${theme}: from the live view #}`);
      await page.keyboard.press('Meta+s');
      await page.waitForFunction(() => window.__liveCalls.includes('reload-hard'), null, { timeout: 5000 }).catch(async () => fail(`saving the template did not reload the page (asked: ${(await calls()).join(', ') || 'nothing'})`));
      await page.keyboard.press('Meta+p');
      await page.waitForSelector('.quick-open');
      await page.keyboard.type('pay-button.css');
      await page.waitForSelector('.quick-open-option.active:has-text("pay-button.css")', { timeout: 5000 });
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.editor-tab.active .editor-tab-name')?.textContent === 'pay-button.css', null, { timeout: 8000 });
      await page.click('.editor-code .cm-content');
      await page.keyboard.press('Meta+ArrowDown');
      await page.keyboard.type(`/* ${theme} */`);
      await page.evaluate(() => { window.__liveCalls.length = 0; });
      await page.keyboard.press('Meta+s');
      await page.waitForFunction(() => window.__liveCalls.includes('css'), null, { timeout: 5000 }).catch(async () => fail(`saving the stylesheet did not swap the page's styles (asked: ${(await calls()).join(', ') || 'nothing'})`));
      if ((await calls()).some((c) => c.startsWith('reload'))) fail('saving a stylesheet reloaded the whole page');
    });

    // Beside the view, then beneath a session; ⌘J hides and shows it.
    await step('dock', async () => {
      await page.click('.editor-actions button[aria-label="Put the editor beside the view"]');
      await page.waitForSelector('.editor-drawer[data-dock="right"]');
      await shot('beside');
      await page.click('.editor-actions button[aria-label="Put the editor beneath the view"]');
      await page.goto(`${base}#/p/${ns}/s/${agent.id}`);
      await page.waitForSelector('.xterm-rows');
      await settle();
      if (!(await page.$('.editor-drawer:not([hidden])'))) fail('the drawer did not stay open beneath a session');
      await shot('session');
      await page.keyboard.press('Meta+j');
      await page.waitForSelector('.editor-collapsed', { timeout: 3000 }).catch(() => fail('⌘J did not hide the editor'));
      await page.keyboard.press('Meta+j');
      await page.waitForSelector('.editor-drawer:not([hidden]) .cm-content', { timeout: 3000 }).catch(() => fail('⌘J did not show the editor again'));
    });

    // Every control in the drawer has a name.
    const unnamed = await page.$$eval('.editor-drawer button, .editor-drawer input, .editor-drawer [role="separator"]', (els) => els
      .filter((e) => !(e.getAttribute('aria-label') || e.textContent.trim() || e.getAttribute('title')))
      .map((e) => e.outerHTML.slice(0, 80)));
    if (unnamed.length) fail(`controls without a name: ${unnamed.join(' | ')}`);

    for (const e of errors) failures.push(`${theme}/editor: ${e}`);
    await context.close();
  }
} finally {
  await browser.close();
  gateway.kill('SIGTERM');
}

if (failures.length) {
  console.error(`Editor sweep failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`Editor sweep passed. Screenshots in ${out}`);
