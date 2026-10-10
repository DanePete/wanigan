#!/usr/bin/env node
// The code editor against a real, seeded core whose demo projects are real
// folders, in both themes: open a file from Changes, type, save (and read the
// disk), quick open, breadcrumbs and their menus, Back and Forward, an agent's
// change to a file with nothing unsaved and with unsaved work, a save refused
// because the file changed first and the merge that follows, Drupal core read-
// only until Edit anyway, Code (.) on a part picked in the live view, the
// drawer beneath a session and beside the view. Fails on console errors and on
// anything the disk or the core does not confirm. Screenshots go to
// .artifacts/ui/<theme>-editor-<name>.png; look at them.
import { LIVE_DEFAULTS } from './ui-live-defaults.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { BRIDGE, root, startGateway } from './ui-harness.mjs';
import { PICK_STUB as LIVE_STUB } from './ui-pick-stub.mjs';

const out = join(root, '.artifacts', 'ui');
mkdirSync(out, { recursive: true });
const { base, gateway } = await startGateway();
const failures = [];

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
      // ".." is there at once; what is beside it comes when the folder has been read.
      await page.waitForFunction(() => [...document.querySelectorAll('.crumb-menu .crumb-menu-label')].some((l) => l.textContent !== '..'), null, { timeout: 8000 }).catch(() => {});
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
      // Code, one of the four verbs on the part (its key is .): the template, at the words picked.
      await page.waitForSelector('.live-verbs button[aria-keyshortcuts="."]:not([disabled])', { timeout: 8000 }).catch(() => fail('a picked part has no Code'));
      await page.focus('.live-inspector .live-side-title');
      await page.keyboard.press('.');
      await page.waitForFunction(() => document.querySelector('.editor-tab.active .editor-tab-name')?.textContent === 'northstar-pay-button.html.twig', null, { timeout: 8000 })
        .catch(() => fail('Code (.) did not open the template'));
      await settle();
      const line = await page.textContent('.editor-status button').catch(() => '');
      const wantLine = readFileSync(join(repo, twig), 'utf8').split('\n').findIndex((l) => l.includes('Pay')) + 1;
      if (line !== `Line ${wantLine}, column ${readFileSync(join(repo, twig), 'utf8').split('\n')[wantLine - 1].indexOf('Pay') + 1}`) fail(`Code opened at "${line}", not at the picked words (line ${wantLine})`);
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

    // Beside the view, then beneath a session; ⌘J hides and shows it. In the live view the drawer is its dock, and says so.
    await step('dock', async () => {
      await page.click('.editor-actions button[aria-label="Put the dock beside the view"]');
      await page.waitForSelector('.editor-drawer[data-dock="right"]');
      await shot('beside');
      await page.click('.editor-actions button[aria-label="Put the dock beneath the view"]');
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

    // The Code tab: the same editor as the project's view, beside its files. A fresh window, so nothing is open yet.
    await step('code-tab', async () => {
      await page.goto(`${base}#/p/${ns}/board`);
      await page.reload();
      await page.waitForSelector('.card');
      // Whether the drawer is open is kept on this Mac: it was open when the window reloaded, so it is open again, empty.
      if (!(await page.$('.editor-drawer[data-mode="drawer"]:not([hidden])'))) fail('the drawer’s open state was not kept across a reload');
      await page.keyboard.press('Meta+j');
      await page.waitForSelector('.editor-drawer:not([hidden])', { state: 'detached', timeout: 3000 }).catch(() => fail('⌘J did not close the drawer kept open'));
      const tabs = await page.$$eval('.topbar .tabs a', (a) => a.map((x) => x.textContent.replace(/\d+$/, '').trim()));
      if (tabs.join() !== 'Board,List,Sessions,History,Changes,Code,Decisions,Activity,Live') fail(`the project's tabs are ${tabs.join(', ')}`);
      const tip = await page.getAttribute('.topbar .tabs a:text-is("Code")', 'title');
      if (tip !== 'Code (G then E)') fail(`the Code tab's tip is "${tip}"`);
      // G then E, from the board.
      await page.keyboard.press('g');
      await page.keyboard.press('e');
      await page.waitForFunction((want) => location.hash === want, `#/p/${ns}/code`, { timeout: 3000 }).catch(() => fail('G then E did not go to the Code tab'));
      await page.waitForSelector('.code-tree [role="treeitem"]', { timeout: 8000 }).catch(() => fail('the Code tab shows no files'));
      if ((await page.getAttribute('.topbar .tabs a:text-is("Code")', 'aria-current')) !== 'page') fail('the Code tab is not marked as the current view');
      if (!/^Northstar Storefront · Code — Wanigan$/.test(await page.title())) fail(`the window title is "${await page.title()}"`);

      // Nothing open: one line that says so, offering ⌘P and the files; not an empty pane.
      const empty = (await page.textContent('.editor-drawer[data-mode="page"] .code-empty').catch(() => '')).replace(/\s+/g, ' ').trim();
      if (!/^No file open\. Find one by name ⌘P, or choose one from the files\.$/.test(empty)) fail(`with nothing open the tab says "${empty}"`);
      if (await page.$('.editor-drawer[data-mode="page"] .empty')) fail('with nothing open the tab shows the drawer’s empty panel too');
      const tree = await page.$eval('.code-tree [role="tree"]', (t) => ({ label: t.getAttribute('aria-label'), rows: [...t.querySelectorAll('[role="treeitem"]')].map((r) => [r.textContent, r.getAttribute('aria-level'), r.getAttribute('aria-expanded')]) }));
      if (tree.label !== 'Files in Northstar Storefront') fail(`the tree is named "${tree.label}"`);
      const top = tree.rows.map((r) => r[0]);
      if (!top.includes('web') || !top.includes('package.json') || top.indexOf('web') > top.indexOf('package.json')) fail(`the top folder lists ${top.join(', ')} (folders first)`);
      if (tree.rows.some((r) => r[1] !== '1') || tree.rows.find((r) => r[0] === 'web')?.[2] !== 'false') fail('the top rows are not a closed first level of a tree');
      if (top.includes('.git')) fail('the tree lists git’s own folder');
      await shot('code-empty');

      // The keyboard: into the tree from the line, a name typed, → to open and step in, Enter to open a file.
      const focused = () => page.evaluate(() => document.activeElement?.getAttribute('data-path') ?? document.activeElement?.className ?? null);
      await page.click('.code-empty button:has-text("choose one from the files")');
      if ((await focused()) !== top[0]) fail(`"choose one from the files" put the keys on ${await focused()}`);
      await page.keyboard.press('ArrowDown');
      if ((await focused()) !== top[1]) fail(`↓ went to ${await focused()}`);
      await page.keyboard.type('web');
      if ((await focused()) !== 'web') fail(`typing "web" went to ${await focused()}`);
      for (const dir of ['web/modules', 'web/modules/custom', 'web/modules/custom/northstar_checkout', 'web/modules/custom/northstar_checkout/css', css]) {
        const parent = dir.slice(0, dir.lastIndexOf('/'));
        await page.keyboard.press('ArrowRight');
        await page.waitForSelector(`.code-tree [data-path^="${parent}/"]`, { timeout: 5000 }).catch(() => fail(`→ did not open ${parent}`));
        if ((await page.getAttribute(`.code-tree [data-path="${parent}"]`, 'aria-expanded')) !== 'true') fail(`${parent} is open but not marked so`);
        await page.keyboard.press('ArrowRight');
        if (!(await focused())?.startsWith(`${parent}/`)) fail(`→ on the open ${parent} went to ${await focused()}, not into it`);
        await page.keyboard.type(dir.slice(parent.length + 1));
        if ((await focused()) !== dir) fail(`typing its name did not reach ${dir} (${await focused()})`);
      }
      await shot('code-tree');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.editor-tab.active .editor-tab-name')?.textContent === 'pay-button.css', null, { timeout: 8000 }).catch(() => fail('Enter on a file in the tree did not open it'));
      await page.waitForFunction(() => document.activeElement?.classList.contains('cm-content'), null, { timeout: 3000 }).catch(() => fail('Enter on a file did not put the cursor in it, as ⌘P does'));
      if ((await page.getAttribute(`.code-tree [data-path="${css}"]`, 'aria-selected')) !== 'true') fail('the open file is not marked in the tree');
      if ((await page.$$('.editor-drawer')).length !== 1 || (await page.$$('.cm-editor')).length !== 1) fail('the Code tab has a second editor');
      if (await page.$('.editor-collapsed')) fail('the drawer’s closed bar shows on the Code tab');

      // ← steps out and closes; typing jumps; Space opens a file and keeps the keys in the tree.
      await page.focus('.code-tree [role="treeitem"][tabindex="0"]');
      await page.keyboard.press('ArrowLeft');
      if ((await focused()) !== 'web/modules/custom/northstar_checkout/css') fail(`← from a file went to ${await focused()}`);
      await page.keyboard.press('ArrowLeft');
      if ((await page.getAttribute('.code-tree [data-path="web/modules/custom/northstar_checkout/css"]', 'aria-expanded')) !== 'false') fail('← on an open folder did not close it');
      await page.keyboard.type('templates');
      await page.keyboard.press('ArrowRight');
      await page.waitForSelector(`.code-tree [data-path="${twig}"]`, { timeout: 5000 }).catch(() => fail('→ did not open templates'));
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Space');
      await page.waitForFunction(() => document.querySelector('.editor-tab.active .editor-tab-name')?.textContent === 'northstar-pay-button.html.twig', null, { timeout: 8000 }).catch(() => fail('Space on a file did not open it'));
      await settle();
      if ((await focused()) !== twig) fail(`Space on a file took the keys to ${await focused()}`);

      // Back and Forward (from the tree too), the breadcrumbs, find, go to line and ⌘P, all on the tab.
      await page.keyboard.press('Control+Minus');
      await settle();
      if ((await activeTab()) !== 'pay-button.css') fail(`Back on the Code tab went to ${await activeTab()}`);
      await page.keyboard.press('Control+Shift+Minus');
      await settle();
      if ((await activeTab()) !== 'northstar-pay-button.html.twig') fail(`Forward on the Code tab went to ${await activeTab()}`);
      await page.click('.editor-code .cm-content');
      await page.keyboard.press('Meta+f');
      await page.waitForSelector('.editor-drawer[data-mode="page"] .cm-panel.cm-search', { timeout: 3000 }).catch(() => fail('⌘F did not open find on the Code tab'));
      await page.keyboard.press('Escape');
      await page.click('.editor-code .cm-content');
      await page.keyboard.press('Control+g');
      await page.waitForSelector('.editor-drawer[data-mode="page"] .cm-panel.cm-goto-line', { timeout: 3000 }).catch(() => fail('⌃G did not open go to line on the Code tab'));
      await page.keyboard.press('Escape');
      const path = await crumbs();
      if (path.slice(1, 7).join('/') !== twig) fail(`on the Code tab the breadcrumbs read ${path.join(' › ')}`);
      await page.keyboard.press('Meta+p');
      await page.waitForSelector('.quick-open', { timeout: 3000 }).catch(() => fail('⌘P did not open quick open on the Code tab'));
      await page.keyboard.type('routing.yml');
      await page.waitForSelector('.quick-open-option.active:has-text("northstar_checkout.routing.yml")', { timeout: 5000 });
      await page.keyboard.press('Enter');
      await page.waitForSelector('.code-tree-row.open-file[data-path="web/modules/custom/northstar_checkout/northstar_checkout.routing.yml"]', { timeout: 8000 })
        .catch(() => fail('a file opened with ⌘P is not marked in the tree'));
      if (!page.url().endsWith(`#/p/${ns}/code`)) fail(`⌘P on the Code tab left it for ${page.url()}`);
      await shot('code-file');
      const named = await page.$$eval('.editor-drawer[data-mode="page"] button, .editor-drawer[data-mode="page"] [role="treeitem"]', (els) => els
        .filter((e) => !(e.getAttribute('aria-label') || e.textContent.trim() || e.getAttribute('title'))).map((e) => e.outerHTML.slice(0, 80)));
      if (named.length) fail(`controls on the Code tab without a name: ${named.join(' | ')}`);

      // Leaving: the drawer was closed before the tab, and stays closed, its files kept. The cursor is left at
      // the end of the file, which the tab shows whole and the drawer, shorter, has to scroll to.
      await page.click('.editor-code .cm-content');
      await page.keyboard.press('Meta+ArrowDown');
      await page.click('.topbar .tabs a:text-is("Board")');
      await page.waitForSelector('.editor-collapsed:has-text("3 files")', { timeout: 3000 }).catch(() => fail('leaving the Code tab did not leave the drawer closed with its three files'));
      if (await page.$('.editor-drawer:not([hidden])')) fail('opening files on the Code tab opened the drawer behind it');

      // The drawer gives way: open beneath the board with unsaved text, then the Code tab, then back.
      await page.keyboard.press('Meta+j');
      await page.waitForSelector('.editor-drawer[data-mode="drawer"]:not([hidden]) .cm-content', { timeout: 3000 }).catch(() => fail('⌘J did not open the drawer'));
      await settle();
      const cursorLine = await page.evaluate(() => {
        const line = document.querySelector('.editor-drawer .cm-activeLine')?.getBoundingClientRect();
        const box = document.querySelector('.editor-drawer .cm-scroller')?.getBoundingClientRect();
        return !!line && !!box && line.top >= box.top - 1 && line.bottom <= box.bottom + 1;
      });
      if (!cursorLine) fail('the drawer opened after the Code tab does not show the line the cursor is on');
      await page.click('.editor-code .cm-content');
      await page.keyboard.press('Meta+ArrowDown');
      await page.keyboard.type(`# ${theme}: typed in the drawer`);
      await page.waitForSelector('.editor-tab.active.unsaved', { timeout: 3000 });
      const before = await page.$eval('.editor-drawer', (d) => {
        window.__codeView = d.querySelector('.cm-editor');
        return { height: Math.round(d.getBoundingClientRect().height), scrolled: Math.round(d.querySelector('.cm-scroller').scrollTop) };
      });
      if (!before.scrolled) fail('the drawer is not scrolled down to the line typed, so coming back scrolled is not tested');
      await shot('code-drawer-before');
      await page.click('.topbar .tabs a:text-is("Code")');
      await page.waitForSelector('.editor-drawer[data-mode="page"]', { timeout: 3000 }).catch(() => fail('the drawer did not give way to the Code tab'));
      await settle();
      const onTab = await page.evaluate(() => {
        const d = document.querySelector('.editor-drawer');
        const bar = document.querySelector('.topbar').getBoundingClientRect();
        const r = d.getBoundingClientRect();
        return { same: d.querySelector('.cm-editor') === window.__codeView, drawers: document.querySelectorAll('.editor-drawer').length, top: Math.round(r.top - bar.bottom), bottom: Math.round(innerHeight - r.bottom), text: [...d.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\n') };
      });
      if (!onTab.same || onTab.drawers !== 1) fail('the Code tab is not the drawer’s own editor');
      if (Math.abs(onTab.top) > 1 || Math.abs(onTab.bottom) > 1) fail(`the editor does not fill the view (${onTab.top}px under the bar, ${onTab.bottom}px above the bottom)`);
      if (!onTab.text.includes(`# ${theme}: typed in the drawer`) || !(await page.$('.editor-tab.active.unsaved'))) fail('the unsaved text typed in the drawer is not on the Code tab');
      await shot('code-drawer-gives-way');
      await page.click('.topbar .tabs a:text-is("Board")');
      await page.waitForSelector('.editor-drawer[data-mode="drawer"]:not([hidden])', { timeout: 3000 }).catch(() => fail('the drawer did not come back when the Code tab was left'));
      await settle();
      const after = await page.$eval('.editor-drawer', (d) => ({
        height: Math.round(d.getBoundingClientRect().height), scrolled: Math.round(d.querySelector('.cm-scroller').scrollTop), same: d.querySelector('.cm-editor') === window.__codeView,
      }));
      if (after.height !== before.height || !after.same) fail(`the drawer came back ${after.height}px high (was ${before.height}), ${after.same ? 'the same' : 'another'} editor`);
      if (Math.abs(after.scrolled - before.scrolled) > 1) fail(`the drawer came back scrolled to ${after.scrolled}px, not ${before.scrolled}px as it was`);
      await shot('code-drawer-back');
      await page.click('.editor-actions button[aria-label="Revert to the saved file"]');
      await page.waitForSelector('.editor-tab.active:not(.unsaved)', { timeout: 3000 }).catch(() => fail('Revert left the file unsaved'));

      // ⌘J on the Code tab puts the editor away: back to the view before it, the drawer closed.
      await page.click('.topbar .tabs a:text-is("List")');
      await page.waitForSelector('.table tbody tr');
      await page.click('.topbar .tabs a:text-is("Code")');
      await page.waitForSelector('.editor-drawer[data-mode="page"]');
      await page.keyboard.press('Meta+j');
      await page.waitForFunction((want) => location.hash === want, `#/p/${ns}/list`, { timeout: 3000 }).catch(async () => fail(`⌘J on the Code tab went to ${await page.evaluate(() => location.hash)}, not back to List`));
      await page.waitForSelector('.editor-collapsed', { timeout: 3000 }).catch(() => fail('⌘J on the Code tab left the drawer open'));
      if (await page.$('.editor-drawer:not([hidden])')) fail('⌘J on the Code tab left the drawer open');

      // A fault in the files takes only the files with it: the editor beside them, and its open file, stay.
      const quietFrom = errors.length;
      await page.evaluate(() => {
        window.__realCall = window.wanigan.call;
        window.wanigan.call = (m, p) => (m === 'files.dir' ? Promise.resolve({ path: '', entries: 'not a list', cut: false }) : window.__realCall(m, p));
      });
      await page.click('.topbar .tabs a:text-is("Code")');
      await page.waitForSelector('.editor-drawer[data-mode="page"] .code-tree .view-crash', { timeout: 5000 }).catch(() => fail('a fault in the Code tab’s files did not stay in their own panel'));
      if (!(await page.$('.editor-drawer[data-mode="page"] .editor-code .cm-content')) || (await page.$('.view-crash:has-text("The code editor")'))) fail('a fault in the files took the editor with it');
      await shot('code-files-fault');
      await page.evaluate(() => { window.wanigan.call = window.__realCall; });
      await page.click('.code-tree .view-crash button:has-text("Reload this view")');
      await page.waitForSelector('.code-tree [role="treeitem"]', { timeout: 5000 }).catch(() => fail('the files did not come back with Reload this view'));
      // What React reports about the fault it caught is the fault this check made.
      errors.splice(quietFrom).filter((e) => !/forEach is not a function|The above error occurred|not a list/.test(e)).forEach((e) => errors.push(e));
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
