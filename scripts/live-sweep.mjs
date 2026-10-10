#!/usr/bin/env node
// The live view's deeper side, in both themes, against the harness's real core
// and a stand-in live view (scripts/ui-live-stub.mjs): a made-up acme trace
// over a plain wireframe, never a website. Screenshots go to
// .artifacts/live/<theme>-<name>.png: the lenses' legends, the Inspector's
// sections, moving a part by the keyboard, both edit sheets (and, on a made-up
// WordPress trace, formatted text edited as words or as its HTML, and a save
// shown beyond the page asked first with where), the request, the
// palette, the component library (listed, searched, pictured, an entry's
// details, placing one, a WordPress library's patterns and styles, an outdated
// helper), taking a part out (at once, or asked first with its reach), the
// design layer (words typed on the page itself from E, Retype the words and a
// double-click, with the status line saying so and its Keep and Put back; a
// style shown on the page as each control changes, then kept; a style and
// words made edits of it, once per Enter, the tray
// with their reach, state and what it means, made real where main would and
// refused where it would not, undo waiting while words are saved, a block's
// words saved to its own template with that reach said first and the write
// said when the mark is refused, Put back refused while the layer holds them,
// verified failing then passing with the edit staying in the site, never twice
// across the tray closing, a style's note to an agent, discarded, undone,
// redone, orphaned and retired, the page without it, the keyboard given back),
// and the
// states without a trace; and the layout itself: the bar's
// three groups and its site menu, the five verbs on a chosen part with the
// note under them, a part chosen in the tree offering what a pick offers, the
// tree kept beside the chosen part (above it and folded, or beside it when the
// window is wide) and following the choice from the page, Notes, Problems,
// Request and the page's DevTools in the dock beneath the page with the code
// editor (its keys, and what it shows kept on this Mac; DevTools laid over its
// tab and following it, its control and Chrome's chord on a Mac and on
// Windows, Show in DevTools at a part's centre, its own window, leaving), the
// status line, and every key the live view lists on the shortcut sheet; the bar and the project's tab bar fitting,
// nothing drawn over anything or cut off, at 1280, 1440 and 1920 px with the
// dock beside and beneath. Then the page script itself, in a
// real Chromium page of made-up markup: the trace's part marks read and paired,
// a lens painted, a part dragged to a new place and put back, the dock's keys
// taken from the page, words typed on the page (each keystroke, Escape, Enter,
// a link, a paste, clicking away, a double-click) and a style tried on it.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { BRIDGE, root, startGateway } from './ui-harness.mjs';
import { liveFixture, liveStub } from './ui-live-stub.mjs';
import { LIVE_DEFAULTS } from './ui-live-defaults.mjs';
import { LIVE_PAGE_KEYS } from '../src/shared/live-keys.ts';
import { compileLayer, trySheet } from '../src/shared/design-layer.ts';
import { fitProblems } from './ui-fit.mjs';

const out = join(root, '.artifacts', 'live');

/**
 * The made-up trace, as a WordPress helper's: the opening hours block offers a paragraph's words alone, a paragraph
 * with a link and bold in it, each the HTML its schema says it is, and a paragraph kept in a template part.
 */
function richTrace(base) {
  const words = (id, label, content) => ({
    id, kind: 'block-attributes', label, via: 'schema', revisions: true, value: { content },
    schema: { type: 'object', additionalProperties: false, properties: { content: { type: 'string', title: 'Words', contentMediaType: 'text/html', description: 'Its words as HTML, with inline formatting (bold, italic, links and the editor’s other formats).' } } },
  });
  const added = [
    words('e-rich-words', 'Paragraph block in page “Hours”', 'Fish &amp; chips on Fridays'),
    words('e-rich-markup', 'Paragraph block with a link in page “Hours”', 'Ask about <a href="/cakes">cakes</a> &amp; <strong>pies</strong>'),
    // Kept in a template part: the save shows on every page that uses it (helper 4's `shows`).
    { ...words('e-rich-shared', 'Paragraph block in the template part “Footer” (shows on every page that uses this template part)', 'Open daily'), shows: 'every page that uses the template part “Footer”' },
  ];
  return {
    ...base, platform: 'wordpress',
    parts: base.parts.map((p) => (p.id === 'p-hours' ? { ...p, edits: [...(p.edits ?? []), ...added.map((e) => e.id)] } : p)),
    edits: [...base.edits, ...added],
  };
}
mkdirSync(out, { recursive: true });
const failures = [];
const fail = (what) => { failures.push(what); console.error(`✗ ${what}`); };
const { base, gateway } = await startGateway({ demo: true, quiet: true });
const browser = await chromium.launch({ headless: true });

const option = async (page, button, text) => {
  await page.getByRole('button', { name: button, exact: true }).click();
  await page.locator('.sel-opt', { hasText: text }).first().click();
};

/** The tab the dock beneath the page shows ('' when it is closed). */
const dockIs = (page) => page.$eval('.editor-drawer:not([hidden]) .dock-tabs [aria-checked="true"]', (b) => b.textContent).catch(() => '');

/** Open the dock beneath the page on one of its tabs: from its tabs when it is open, from its strip when it is closed. */
const dockTo = async (page, name, fail) => {
  await page.locator('.dock-tabs button', { hasText: new RegExp(`^${name}`) }).first().click();
  await page.waitForSelector(`.editor-drawer:not([hidden]) .live-docked[data-tab="${name.toLowerCase()}"]`, { timeout: 3000 })
    .catch(() => fail(`dock: choosing ${name} did not show it in the dock`));
};

try {
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, deviceScaleFactor: 2 });
    await context.addInitScript(BRIDGE);
    await context.addInitScript(`try { localStorage.setItem('wanigan.theme', '${theme}'); } catch {}`);
    await context.addInitScript(liveStub, liveFixture);
    await context.addInitScript(LIVE_DEFAULTS);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    const shot = (name) => page.screenshot({ path: join(out, `${theme}-${name}.png`), animations: 'disabled' });
    const t = (what) => `${theme}/${what}`;

    await page.goto(`${base}#/p/NS/live`);
    await page.waitForSelector('.live-tree', { timeout: 15_000 }).catch(() => fail(t('layers: the Live tab never showed the parts')));
    await page.waitForFunction(() => window.__wgLive.calls.includes('trace'), null, { timeout: 5000 }).catch(() => fail(t('trace: the tab never asked for the trace')));
    const rows = await page.$$eval('.live-layer-title', (els) => els.map((e) => e.textContent));
    for (const want of ['Hero', 'Sidebar', 'Opening hours']) if (!rows.some((r) => r === want || r?.startsWith(want))) fail(t(`layers: no "${want}" row (${rows.join(', ')})`));
    await shot('layers');

    // Each lens: its legend and its counts, under the bar.
    const legends = {};
    for (const [lens, expect] of [['Owner', /Yours/], ['Cache', /Never cached/], ['Cost', /Heavy/], ['Editable', /Not here/], ['Changed', /Saved by hand/]]) {
      await option(page, 'Lens', lens);
      await page.waitForSelector('.live-lens', { timeout: 3000 }).catch(() => fail(t(`lens ${lens}: no legend`)));
      legends[lens] = await page.locator('.live-lens').first().innerText();
      if (!expect.test(legends[lens])) fail(t(`lens ${lens}: the legend reads "${legends[lens]}"`));
      await shot(`lens-${lens.toLowerCase()}`);
    }
    // Cost counts what the trace says: two parts at 50 ms or more, or 20 queries.
    await option(page, 'Lens', 'Cost');
    const heavy = await page.locator('.live-lens-key', { hasText: 'Heavy' }).innerText();
    if (!/Heavy\s*2/.test(heavy)) fail(t(`lens Cost: Heavy reads "${heavy}"`));
    // Choosing a legend entry shows only those; Escape goes back to Structure.
    await page.locator('.live-lens-key', { hasText: 'Heavy' }).click();
    const painted = await page.$$eval('#__wg_live_stub div', (els) => els.filter((e) => e.style.background.startsWith('rgba')).length);
    if (painted !== 2) fail(t(`lens Cost: showing only Heavy painted ${painted} parts`));
    await page.locator('.live-lens-name').click();
    await page.keyboard.press('Escape');
    await page.waitForSelector('.live-lens', { state: 'detached', timeout: 3000 }).catch(() => fail(t('lens: Escape did not go back to Structure')));

    // The Inspector: what the trace knows of the hero, every section opened.
    await page.locator('.live-layer', { hasText: 'Hero' }).first().click();
    await page.waitForSelector('.live-inspector', { timeout: 3000 }).catch(() => fail(t('inspector: choosing Hero opened nothing')));
    for (const section of ['Made by', 'Data', 'Cache', 'Cost', 'History', 'Access']) {
      const head = page.locator('.disclosure-head button', { hasText: section }).first();
      if (!(await head.count())) { fail(t(`inspector: no ${section} section`)); continue; }
      if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
    }
    const inspector = await page.locator('.live-inspector').innerText();
    for (const want of ['acme_preprocess_node', 'Fresh bread, every morning', 'node:12', '62.4 ms', 'Spring wording', 'Allowed']) {
      if (!inspector.includes(want)) fail(t(`inspector: "${want}" is not shown`));
    }
    // Every way to edit it is in one place: the Edit menu, the trace's targets and the override with them.
    await page.getByRole('button', { name: /^Edit Hero/ }).click();
    const editMenu = await page.locator('[role="menu"]').innerText().catch(() => '');
    for (const want of ['Hero props', 'Title (node 12)', 'Create override…']) if (!editMenu.includes(want)) fail(t(`inspector: the Edit menu has no "${want}" (${editMenu.replace(/\s+/g, ' ')})`));
    await page.keyboard.press('Escape');
    // The site's AI as its core reports it, under Why it looks like this.
    const siteAi = page.locator('.disclosure-head button', { hasText: 'AI on this site' }).first();
    if (!(await siteAi.count())) fail(t('inspector: no AI on this site section'));
    else {
      if ((await siteAi.innerText()).includes('no AI API in Drupal core') === false) fail(t(`inspector: AI on this site says "${await siteAi.innerText()}"`));
      await siteAi.click();
      const said = await page.locator('.live-site-ai').innerText();
      for (const want of ['Drupal core has no AI API', 'Saving a content item (node)', 'Acme Events (module)', 'never reads a key']) if (!said.includes(want)) fail(t(`inspector: AI on this site does not say "${want}"`));
      if (!(await page.evaluate(() => window.__wgLive.calls.includes('siteAi')))) fail(t('inspector: the site’s AI was not asked for'));
    }
    const sideways = await page.$$eval('.live-side, .live-split-part, .live-split-tree', (els) => els.some((el) => el.scrollWidth > el.clientWidth + 1));
    if (sideways) fail(t('inspector: the side panel is wider than itself'));
    // The part's details scroll on their own, under the tree that stays above them.
    await page.locator('.live-split-part').evaluate((el) => { el.scrollTop = 0; el.scrollLeft = 0; });
    await shot('inspector');
    await page.locator('.live-split-part').evaluate((el) => { el.scrollTop = el.clientHeight * 0.8; });
    await shot('inspector-data');
    await page.locator('.live-split-part').evaluate((el) => { el.scrollTop = el.clientHeight * 1.6; });
    await shot('inspector-more');

    // E on a part that is more than words (the sidebar's region) opens every way to edit it; on words alone it types on
    // them on the page ("layout", below).
    await page.getByRole('button', { name: 'Back to the layers' }).click();
    await page.locator('.live-layer', { hasText: 'Sidebar' }).first().click();
    await page.waitForFunction(() => document.querySelector('.live-inspector .live-side-title')?.textContent === 'Sidebar', null, { timeout: 3000 }).catch(() => fail(t('inspector: choosing Sidebar did not choose it')));
    await page.locator('.live-inspector .live-side-title').focus();
    await page.keyboard.press('e');
    await page.waitForSelector('[role="menu"]', { timeout: 2000 }).catch(() => fail(t('inspector: E on Sidebar, more than words, did not open the Edit menu')));
    if (await page.evaluate(() => window.__wgLive.calls.includes('layerType'))) fail(t('inspector: E on Sidebar, more than words, typed on the page'));
    await page.keyboard.press('Escape');

    // Moving by the keyboard: Alt+↓ on a block of the sidebar, said aloud; Escape puts it back.
    await page.getByRole('button', { name: 'Back to the layers' }).click();
    await page.locator('.live-layer', { hasText: 'Search' }).first().click();
    await page.locator('.live-inspector .live-side-title').focus();
    await page.keyboard.press('Alt+ArrowDown');
    await page.waitForFunction(() => document.querySelector('[aria-live="polite"].visually-hidden')?.textContent?.includes('Search, 2 of 3 in Sidebar blocks'), null, { timeout: 3000 })
      .catch(async () => fail(t(`move: Alt+↓ said "${await page.locator('[aria-live="polite"].visually-hidden').innerText()}"`)));
    if (!(await page.evaluate(() => window.__wgLive.calls.some((c) => /^preview \d+ before \d+$/.test(c))))) fail(t('move: the new order was not shown on the page'));
    await shot('move-keyboard');
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await page.waitForFunction(() => document.querySelector('[aria-live="polite"].visually-hidden')?.textContent?.includes('in Footer blocks'), null, { timeout: 3000 })
      .catch(() => fail(t('move: Alt+Shift+→ did not reach the footer')));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => /Move cancelled/.test(document.querySelector('[aria-live="polite"].visually-hidden')?.textContent ?? ''), null, { timeout: 3000 })
      .catch(() => fail(t('move: Escape did not put it back')));
    // Enter saves; a configuration move says what it changes and asks first.
    await page.keyboard.press('Alt+ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.dialog:has-text("every page that shows this region (41 pages)")', { timeout: 3000 }).catch(() => fail(t('move: a configuration move did not say what it changes')));
    if (!(await page.locator('.dialog').innerText()).includes('Saving here also runs code from: Acme Events (module).')) fail(t('move: the confirm does not say what else the save runs'));
    await shot('move-confirm');
    await page.locator('.dialog button', { hasText: 'Move it' }).click();
    await page.waitForSelector('.toast-info:has-text("Moved Search")', { timeout: 3000 }).catch(() => fail(t('move: no toast after saving')));
    const moved = await page.evaluate(() => window.__wgLive.calls.find((c) => c.startsWith('move ')));
    if (moved !== 'move {"collection":"c-sidebar","item":"p-search","to":{"collection":"c-sidebar","index":1}}') fail(t(`move: posted ${moved}`));
    await page.waitForSelector('.live-status-said:has-text("Search: moved, and the page shows the change after reloading.")', { timeout: 4000 })
      .catch(async () => fail(t(`check: a move that landed was not said (${await page.locator('.live-status-said').first().innerText().catch(() => 'no status line')})`)));
    await shot('move-saved');
    const beforeUndo = await page.evaluate(() => window.__wgLive.calls.length);
    await page.locator('.toast-info button', { hasText: 'Undo' }).click();
    if (!(await page.evaluate(() => window.__wgLive.calls.includes('undo u-1')))) fail(t('move: Undo did not ask the site'));
    // The undo reloads the page, which disarms dragging until the page is back: the drop below waits for the page to be
    // traced again and armed again, rather than racing the reload (a drop on the page being reloaded goes nowhere).
    await page.waitForFunction((k) => window.__wgLive.calls.slice(k).includes('trace') && window.__wgLive.armed, beforeUndo, { timeout: 4000 })
      .catch(() => fail(t('move: dragging was not armed again once the undo reloaded the page')));
    // A drop the page answers is saved the same way; a 409 says it changed meanwhile.
    await page.evaluate(() => { window.__wgLive.moveAnswer = { ok: false, conflict: true, items: null, error: 'It changed on the site since this page was shown, so nothing was moved. The page now shows the order as it is.' }; });
    await page.evaluate(() => window.__wgLive.drop({ kind: 'move', move: { collection: 'c-paras', item: 'p-para-2', to: { collection: 'c-paras', index: 0 } } }));
    await page.waitForSelector('.toast-error:has-text("It changed on the site since")', { timeout: 3000 }).catch(() => fail(t('move: a 409 was not said plainly')));
    await page.evaluate(() => { window.__wgLive.moveAnswer = null; });
    await page.locator('.toast-error .toast-x').click().catch(() => {});

    // Editing where it shows: the schema form, its checks, its save; the site's own form.
    await page.getByRole('button', { name: 'Back to the layers' }).click();
    await page.locator('.live-layer', { hasText: 'Hero' }).first().click();
    await page.getByRole('button', { name: /^Edit Hero/ }).click();
    await page.getByRole('menuitem', { name: /^Hero props/ }).click();
    await page.waitForSelector('.live-sheet form', { timeout: 3000 }).catch(() => fail(t('edit: the schema sheet did not open')));
    await shot('edit-schema');
    await page.getByLabel('Heading *').fill('');
    await page.locator('.live-sheet button[type="submit"]').click();
    await page.waitForSelector('.live-sheet .field-error:has-text("Heading is required.")', { timeout: 3000 }).catch(() => fail(t('edit: an empty required heading was not caught')));
    await shot('edit-schema-error');
    await page.getByLabel('Heading *').fill('Fresh bread, all day');
    await page.locator('.live-sheet button[type="submit"]').click();
    await page.waitForSelector('.toast-info:has-text("Saved Hero props")', { timeout: 3000 }).catch(() => fail(t('edit: saving did not say so')));
    const save = await page.evaluate(() => window.__wgLive.calls.find((c) => c.startsWith('editSave')));
    if (!save?.includes('"heading":"Fresh bread, all day"') || !save.includes('"image":{"src":"hero.jpg"}')) fail(t(`edit: saved ${save}`));
    // The save is read back once the page reloads: by the value the new trace holds for it, said in the status line.
    await page.waitForSelector('.live-status-said:has-text("Hero props: saved, and the site holds it after reloading.")', { timeout: 4000 })
      .catch(async () => fail(t(`check: an edit that landed was not said (${await page.locator('.live-status-said').first().innerText().catch(() => 'no status line')})`)));
    // A save the site called a success that changed nothing is said plainly, as a warning.
    await page.evaluate(() => { window.__wgLive.unchanged = true; });
    await page.getByRole('button', { name: /^Edit Hero/ }).click();
    await page.getByRole('menuitem', { name: /^Hero props/ }).click();
    await page.getByLabel('Heading *').fill('Fresh bread, all night');
    await page.locator('.live-sheet button[type="submit"]').click();
    await page.waitForSelector('.live-status-said.warn[role="alert"]:has-text("The site said it saved Hero props, but after reloading it holds the old value")', { timeout: 4000 })
      .catch(() => fail(t('check: a save that changed nothing was not said')));
    await shot('check-unchanged');
    await page.evaluate(() => { window.__wgLive.unchanged = false; });
    await page.locator('.toast-error .toast-x').click().catch(() => {});
    await page.getByRole('button', { name: /^Edit Hero/ }).click();
    await page.getByRole('menuitem', { name: /^Title \(node 12\)/ }).click();
    await page.waitForSelector('.live-sheet.native', { timeout: 3000 }).catch(() => fail(t('edit: the native sheet did not open')));
    if (!(await page.evaluate(() => window.__wgLive.calls.includes('editOpen e-title')))) fail(t('edit: the site’s form was not asked for'));
    if (!(await page.locator('.live-sheet').innerText()).includes('Saving here also runs code from: Acme Events (module).')) fail(t('edit: the sheet does not say what else saving runs'));
    await shot('edit-native');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.live-sheet', { state: 'detached', timeout: 3000 }).catch(() => fail(t('edit: Escape did not close the sheet')));

    // The request behind the page, in the dock beneath it.
    await page.getByRole('button', { name: 'Back to the layers' }).click();
    await dockTo(page, 'Request', (w) => fail(t(w)));
    await page.waitForSelector('.live-timeline', { timeout: 3000 }).catch(() => fail(t('request: no hook timeline')));
    const slow = await page.$$eval('.live-hook.slow', (els) => els.length);
    if (slow !== 5) fail(t(`request: ${slow} hooks marked slowest`));
    await shot('request-hooks');
    await page.getByRole('radio', { name: /^Queries/ }).click();
    await page.locator('.live-query', { hasText: 'node_field_data n INNER JOIN' }).hover();
    const outlined = await page.$$eval('#__wg_live_stub div', (els) => els.filter((e) => e.style.outline.includes('dashed')).length);
    if (outlined !== 1) fail(t(`request: pointing at a query outlined ${outlined} parts`));
    await shot('request-queries');
    await page.getByRole('radio', { name: /^Assets/ }).click();
    await shot('request-assets');

    // The palette.
    await page.getByRole('radio', { name: 'Add' }).click();
    await page.waitForSelector('.live-palette-entry', { timeout: 3000 }).catch(() => fail(t('palette: nothing listed')));
    await page.locator('.live-palette-entry', { hasText: 'Call to action' }).getByRole('button', { name: 'Choose where…' }).click();
    await shot('palette');
    await page.locator('.live-palette-entry', { hasText: 'Call to action' }).getByRole('button', { name: 'Place' }).click();
    await page.waitForSelector('.live-status:has-text("Placing Call to action")', { timeout: 3000 }).catch(() => fail(t('palette: Place did not say it is placing')));
    if ((await page.evaluate(() => window.__wgLive.spec?.placing?.entry)) !== 'pal.b.acme_cta_block') fail(t('palette: the page was not told what to place'));
    await shot('palette-placing');
    await page.keyboard.press('Escape');

    // ── The layout: the bar in three groups, the site menu, the four verbs with the note under them, a part chosen in
    // the tree offering what a pick offers, one status line, and the live view's keys from the window and the page.
    {
      const calls = () => page.evaluate(() => window.__wgLive.calls.slice());
      const since = async (n) => (await calls()).slice(n);
      const mark = async () => (await calls()).length;
      const pressed = (label) => page.$eval(`.live-widths button[aria-label^="${label}"]`, (b) => b.getAttribute('aria-pressed')).catch(() => null);
      const tabIs = () => page.$eval('.live-side > .segmented [aria-checked="true"]', (b) => b.textContent).catch(() => '');
      const nobody = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => { document.activeElement?.blur(); done(); }))));
      await page.locator('.toast .toast-x').click().catch(() => {});
      await page.getByRole('radio', { name: 'Layers' }).click();
      if (await page.$('.live-inspector')) await page.getByRole('button', { name: 'Back to the layers' }).click();

      // Three groups, in order: the site, the page, the tools; each holding what it says.
      const groups = await page.$$eval('.live-bar > [role="group"]', (els) => els.map((g) => ({
        name: g.getAttribute('aria-label'),
        controls: [...g.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent.trim()),
      })));
      if (groups.map((g) => g.name).join() !== 'The site,The page,Tools') fail(t(`layout: the bar's groups are ${groups.map((g) => g.name).join(', ')}`));
      const [siteGroup, pageGroup, toolGroup] = groups;
      if (siteGroup?.controls.length !== 1 || !/^Site: Local shown/.test(siteGroup.controls[0] ?? '')) fail(t(`layout: the site group holds ${JSON.stringify(siteGroup?.controls)}`));
      for (const want of [/^Back$/, /^Forward$/, /^Reload/, /^Go to a page of acme\.example\.test/, /^Phone/, /^Tablet/, /^Full width/, /^Lens$/]) {
        if (!pageGroup?.controls.some((c) => want.test(c))) fail(t(`layout: the page group has nothing like ${want} (${pageGroup?.controls.join(' | ')})`));
      }
      if (!/^Pick/.test(toolGroup?.controls[0] ?? '') || !/^Library/.test(toolGroup?.controls[1] ?? '') || !/^Edits: the design layer \(⇧E\)$/.test(toolGroup?.controls[2] ?? '')
        || !/^Snap \(⇧S\)$/.test(toolGroup?.controls[3] ?? '') || !/^Record \(⇧R\)$/.test(toolGroup?.controls[4] ?? '')
        || toolGroup?.controls[5] !== 'DevTools (⌥⌘I)'
        || !/^More/.test(toolGroup?.controls[6] ?? '') || toolGroup?.controls.length !== 7) fail(t(`layout: the tools are ${JSON.stringify(toolGroup?.controls)}`));
      for (const gone of ['Site settings', 'Open in the default browser', 'Go to a page of the site (Shift+Space)']) {
        if (await page.$(`.live-bar button[aria-label="${gone}"]`)) fail(t(`layout: "${gone}" is still a button of its own in the bar`));
      }
      if (await page.$('.live-bar button:has-text("Compare")')) fail(t('layout: Compare is still a button of its own in the bar'));

      // The site menu: the environments to show the page on, Compare, and the site settings, in one place.
      await page.getByRole('button', { name: /^Site: Local shown/ }).click();
      const site = await page.$$eval('[role="menu"] [role^="menuitem"]', (els) => els.map((e) => ({ role: e.getAttribute('role'), text: e.textContent, checked: e.getAttribute('aria-checked'), off: e.getAttribute('aria-disabled') })));
      if (site[0]?.role !== 'menuitemradio' || !/^Local/.test(site[0]?.text ?? '') || site[0]?.checked !== 'true') fail(t(`layout: the site menu does not start with Local, shown (${JSON.stringify(site[0])})`));
      const cmpItem = site.find((i) => /^Compare Local/.test(i.text));
      if (!cmpItem || cmpItem.off !== 'true' || !/Add a hosted environment .* in Site settings/.test(cmpItem.text)) fail(t(`layout: Compare in the site menu is ${JSON.stringify(cmpItem)}`));
      if (!site.some((i) => /^Site settings…/.test(i.text))) fail(t('layout: no Site settings in the site menu'));
      await shot('layout-site-menu');
      await page.keyboard.press('Escape');

      // The address field is where a page is typed: it opens Go to over itself, the address chosen; typing replaces it.
      await page.locator('.live-address').click();
      await page.waitForSelector('.goto.goto-anchored', { timeout: 3000 }).catch(() => fail(t('layout: the address field did not open Go to over itself')));
      const field = await page.evaluate(() => {
        const input = document.querySelector('.goto input');
        const at = document.querySelector('.live-address').getBoundingClientRect();
        const box = document.querySelector('.goto').getBoundingClientRect();
        return { value: input?.value, whole: input?.selectionStart === 0 && input?.selectionEnd === input?.value.length, focused: document.activeElement === input, over: Math.abs(box.left - at.left) < 2 && box.top <= at.top + 2 };
      });
      if (field.value !== 'https://acme.example.test/' || !field.whole || !field.focused) fail(t(`layout: Go to opened with ${JSON.stringify(field)}, not the address chosen`));
      if (!field.over) fail(t('layout: Go to did not open over the address field'));
      await shot('layout-goto');
      const before = await mark();
      await page.keyboard.press('Enter');
      await page.waitForSelector('.goto', { state: 'detached', timeout: 3000 }).catch(() => fail(t('layout: Enter on the address as it was did not go there')));
      if (!(await since(before)).includes('go https://acme.example.test/')) fail(t('layout: Enter on the address did not open it in the view'));
      await page.locator('.live-address').click();
      await page.keyboard.type('https://elsewhere.example.test/x');
      await page.waitForSelector('.goto-empty:has-text("elsewhere.example.test is another site")', { timeout: 3000 }).catch(() => fail(t('layout: another site’s address typed into the field was not refused with where to change it')));
      await page.keyboard.press('Escape');

      // Choosing a part in the tree offers what a pick offers: its element is chosen on the page, so its words and a style can be tried.
      let n = await mark();
      await page.locator('.live-layer', { hasText: 'Search' }).first().click();
      await page.waitForSelector('.live-inspector', { timeout: 3000 });
      await page.waitForFunction((k) => window.__wgLive.calls.slice(k).some((c) => /^choose \d+$/.test(c)), n, { timeout: 3000 }).catch(() => fail(t('layout: choosing in the tree did not choose the part on the page')));
      const order = await page.evaluate(() => [...document.querySelector('.live-inspector').children].map((c) => c.getAttribute('aria-label') ?? c.className));
      const verbsAt = order.findIndex((o) => /^What to do with Search$/.test(o));
      if (verbsAt < 0 || order[verbsAt + 1] !== 'Tell an agent' || order.at(-1) !== 'Why it looks like this') fail(t(`layout: the Inspector is in this order: ${order.join(' › ')}`));
      const verbs = await page.$$eval('.live-verbs > button', (els) => els.map((b) => b.querySelector('.live-verb-name')?.textContent.trim()));
      if (verbs.join() !== 'Edit,Move,Code,Alone,Take out') fail(t(`layout: the verbs are ${verbs.join(', ')}`));
      const folded = await page.$$eval('.live-why .disclosure-head button', (els) => els.filter((b) => b.getAttribute('aria-expanded') === 'true').length);
      if (folded) fail(t(`layout: ${folded} of the diagnostics are open before they are asked for`));
      await page.getByRole('button', { name: /^Edit Search/ }).click();
      const fromTree = await page.$$eval('[role="menu"] [role^="menuitem"]', (els) => els.map((e) => e.textContent));
      for (const want of [/^Retype the words/, /^Retype in a box/, /^Try a style/, /^Block settings/]) if (!fromTree.some((x) => want.test(x))) fail(t(`layout: chosen in the tree, the Edit menu lacks ${want} (${fromTree.join(' | ')})`));
      await shot('layout-tree-edit');
      await page.keyboard.press('Escape');

      // Picking from the keyboard: P starts on the chosen part, Enter (the page's) picks, and the same actions are offered.
      n = await mark();
      await page.locator('.live-inspector .live-side-title').focus();
      await page.keyboard.press('p');
      await page.waitForFunction((k) => window.__wgLive.calls.slice(k).some((c) => /^pick \d+$/.test(c)), n, { timeout: 3000 }).catch(() => fail(t('layout: P did not start picking from the chosen part')));
      await page.waitForSelector('.live-status:has-text("Picking")', { timeout: 3000 }).catch(() => fail(t('layout: the status line did not say it is picking')));
      await page.evaluate(() => window.__wgLive.enter());
      await page.waitForFunction(() => document.querySelector('.live-inspector .live-side-title')?.textContent === 'Search', null, { timeout: 3000 }).catch(() => fail(t('layout: Enter while picking did not choose the part')));
      await page.getByRole('button', { name: /^Edit Search/ }).click();
      const fromPick = await page.$$eval('[role="menu"] [role^="menuitem"]', (els) => els.map((e) => e.textContent));
      if (fromPick.join('|') !== fromTree.join('|')) fail(t(`layout: a pick offers other edits than the tree (${fromPick.join(' | ')})`));
      await page.keyboard.press('Escape');

      // The verbs' keys: E on words alone types on them on the page (Escape in the window puts them back), M opens Move,
      // . says why there is no code here, ⇧A shows it alone.
      await page.locator('.live-inspector .live-side-title').focus();
      n = await mark();
      await page.keyboard.press('e');
      await page.waitForSelector('.live-status:has-text("Typing on the page: Enter keeps it in the layer, Esc puts it back")', { timeout: 2000 })
        .catch(() => fail(t('layout: E on words alone did not type on them on the page')));
      if (!(await since(n)).includes('layerType')) fail(t('layout: E on words alone did not ask the page to type on them'));
      if (await page.$('[role="menu"]')) fail(t('layout: E on words alone opened the Edit menu as well'));
      await page.keyboard.press('Escape');
      await page.waitForFunction((k) => window.__wgLive.calls.slice(k).includes('layerTypeEnd false'), n, { timeout: 2000 }).catch(() => fail(t('layout: Escape in the window did not put the words back')));
      await page.waitForFunction(() => !/Typing on the page/.test(document.querySelector('.live-status')?.textContent ?? ''), null, { timeout: 2000 })
        .catch(() => fail(t('layout: the status line still says typing once the words were put back')));
      if (!(await page.$('.live-inspector'))) fail(t('layout: Escape that put the words back also closed the part’s details'));
      if ((await since(n)).some((c) => c.startsWith('layerAdd'))) fail(t('layout: words put back were added to the layer'));
      await page.locator('.live-inspector .live-side-title').focus();
      await page.keyboard.press('m');
      await page.waitForSelector('.live-move', { timeout: 2000 }).catch(() => fail(t('layout: M did not open Move')));
      if ((await page.getAttribute('.live-verbs button[aria-keyshortcuts="M"]', 'aria-pressed')) !== 'true') fail(t('layout: Move is not shown as on'));
      await page.waitForFunction(() => document.activeElement?.classList.contains('live-up'), null, { timeout: 2000 }).catch(() => fail(t('layout: M did not take the keyboard to Move')));
      await page.keyboard.press('ArrowDown');
      await page.waitForFunction(() => document.querySelector('[aria-live="polite"].visually-hidden')?.textContent?.includes('Search, 2 of 3 in Sidebar blocks'), null, { timeout: 3000 })
        .catch(() => fail(t('layout: ↓ in Move did not move the part')));
      await shot('layout-move');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => /Move cancelled/.test(document.querySelector('[aria-live="polite"].visually-hidden')?.textContent ?? ''), null, { timeout: 3000 }).catch(() => fail(t('layout: Escape did not put the move back')));
      await page.locator('.live-inspector .live-side-title').focus();
      await page.keyboard.press('.');
      await page.waitForSelector('.toast:has-text("The page does not say which file made it")', { timeout: 2000 }).catch(() => fail(t('layout: . did not say why the code cannot open')));
      n = await mark();
      await page.keyboard.press('Shift+A');
      await page.waitForFunction((k) => window.__wgLive.calls.slice(k).some((c) => c.startsWith('go https://acme.example.test/_wanigan/piece/block/acme_search')), n, { timeout: 2000 })
        .catch(() => fail(t('layout: ⇧A did not show the part alone')));
      await page.getByRole('button', { name: 'Back to the layers' }).click();
      await page.locator('.toast .toast-x').click().catch(() => {});

      // The tree stays with a chosen part: above its details, folded to the part's branch, the part marked in it; the
      // mark follows a choice made on the page; Escape goes back to the tree alone, unfolded as it was.
      {
        const rowsNow = () => page.$$eval('.live-tree [role="treeitem"]', (r) => r.length);
        const marked = () => page.$$eval('.live-tree [aria-selected="true"] .live-layer-title', (els) => els.map((e) => e.textContent).join());
        const rowsAlone = await rowsNow();
        const heroAt = Number(await page.locator('.live-layer', { hasText: /^Hero/ }).first().getAttribute('data-key'));
        await page.locator('.live-layer', { hasText: 'Search' }).first().click();
        await page.waitForSelector('.live-split-part .live-inspector', { timeout: 3000 }).catch(() => fail(t('layers: choosing Search showed no details beside the tree')));
        const split = await page.evaluate(() => {
          const tree = document.querySelector('.live-split-tree:has(.live-tree)')?.getBoundingClientRect();
          const part = document.querySelector('.live-split-part')?.getBoundingClientRect();
          const side = document.querySelector('.live-side');
          return { tree: !!tree, above: !!tree && !!part && tree.bottom <= part.top + 1 && tree.height > 0 && part.height > tree.height, top: side?.scrollTop };
        });
        if (!split.tree || !split.above || split.top !== 0) fail(t(`layers: with a part chosen the tree is not above its details, both in view (${JSON.stringify(split)})`));
        if ((await marked()) !== 'Search') fail(t(`layers: the tree marks ${await marked() || 'nothing'}, not Search`));
        const folded = await rowsNow();
        if (folded >= rowsAlone) fail(t(`layers: the tree is not folded to Search's branch (${folded} rows, ${rowsAlone} alone)`));
        await shot('layout-tree-part');
        // Chosen on the page: the tree follows, folded to the new part's branch.
        const k = await mark();
        await page.locator('.live-inspector .live-side-title').focus();
        await page.keyboard.press('p');
        await page.waitForFunction((x) => window.__wgLive.calls.slice(x).some((c) => /^pick \d+$/.test(c)), k, { timeout: 3000 }).catch(() => fail(t('layers: P did not pick')));
        await page.evaluate((i) => window.__wgLive.enter(i), heroAt);
        await page.waitForFunction(() => document.querySelector('.live-inspector .live-side-title')?.textContent === 'Hero', null, { timeout: 3000 }).catch(() => fail(t('layers: picking Hero on the page did not choose it')));
        await page.waitForFunction(() => [...document.querySelectorAll('.live-tree [aria-selected="true"] .live-layer-title')].map((e) => e.textContent).join() === 'Hero', null, { timeout: 3000 })
          .catch(async () => fail(t(`layers: chosen on the page, the tree marks ${await marked() || 'nothing'}, not Hero`)));
        const heroRow = await page.evaluate(() => {
          const row = document.querySelector('.live-tree [aria-selected="true"]')?.getBoundingClientRect();
          const box = document.querySelector('.live-split-tree')?.getBoundingClientRect();
          return !!row && !!box && row.top >= box.top - 1 && row.bottom <= box.bottom + 1;
        });
        if (!heroRow) fail(t('layers: the part chosen on the page is not in view in the tree'));
        // Escape: the tree alone again, as it was, and the keyboard on it.
        await page.keyboard.press('Escape');
        await page.waitForSelector('.live-inspector', { state: 'detached', timeout: 3000 }).catch(() => fail(t('layers: Escape did not go back to the tree alone')));
        if ((await rowsNow()) !== rowsAlone) fail(t(`layers: back alone the tree shows ${await rowsNow()} rows, not the ${rowsAlone} it had`));
        await page.waitForFunction(() => !!document.activeElement?.closest('.live-tree'), null, { timeout: 2000 }).catch(() => fail(t('layers: Escape left the keyboard nowhere, not on the tree')));
        // A wide window: the tree beside the part's details, unfolded.
        await page.setViewportSize({ width: 1920, height: 1000 });
        await page.locator('.live-layer', { hasText: 'Search' }).first().click();
        await page.waitForSelector('.live-split-part .live-inspector', { timeout: 3000 });
        const wide = await page.evaluate(() => {
          const tree = document.querySelector('.live-split-tree')?.getBoundingClientRect();
          const part = document.querySelector('.live-split-part')?.getBoundingClientRect();
          return { beside: !!tree && !!part && tree.right <= part.left + 1 && Math.abs(tree.top - part.top) < 2, rows: document.querySelectorAll('.live-tree [role="treeitem"]').length };
        });
        if (!wide.beside) fail(t('layers: in a wide window the tree is not beside the part’s details'));
        if (wide.rows !== rowsAlone) fail(t(`layers: beside the part the tree is folded (${wide.rows} rows, ${rowsAlone} alone)`));
        await shot('layout-tree-beside');
        await page.getByRole('button', { name: 'Back to the layers' }).click();
        await page.setViewportSize({ width: 1440, height: 900 });
      }

      // The bar's keys, from the window with nothing focused: widths, tabs, lens, Compare.
      await nobody();
      await page.keyboard.press('1');
      if ((await pressed('Phone')) !== 'true') fail(t('layout: 1 did not narrow to a phone'));
      await page.keyboard.press('2');
      if ((await pressed('Tablet')) !== 'true') fail(t('layout: 2 did not narrow to a tablet'));
      await page.keyboard.press('3');
      if ((await pressed('Full width')) !== 'true') fail(t('layout: 3 did not go back to full width'));
      // [ and ] step the side panel's tabs, which are Layers and Add now that Notes, Problems and Request are the dock's.
      const side = await page.$$eval('.live-side > .segmented [role="radio"]', (els) => els.map((e) => e.textContent));
      if (side.join() !== 'Layers,Add') fail(t(`layout: the side panel's tabs are ${side.join(', ')}`));
      await page.keyboard.press(']');
      if (await tabIs() !== 'Add') fail(t(`layout: ] went to ${await tabIs()}`));
      await page.keyboard.press('[');
      if (await tabIs() !== 'Layers') fail(t(`layout: [ went to ${await tabIs()}`));
      await page.keyboard.press('[');
      if (await tabIs() !== 'Add') fail(t(`layout: [ from the first tab went to ${await tabIs()}, not the last`));
      await page.keyboard.press(']');

      // The dock beneath the page: Code, Notes, Problems, Request, DevTools. Closed, its tabs wait in a strip, each opening it;
      // ⇧] and ⇧[ open it on the tab it showed, then step through them; ⌘J is the code editor's (from Notes it
      // shows Code, then hides the dock).
      if (await page.$('.editor-drawer:not([hidden])')) await page.click('.editor-actions button[aria-label^="Hide the"]');
      const strip = await page.$$eval('.dock-collapsed button', (els) => els.map((e) => e.textContent.trim()));
      if (strip.join() !== 'Code,Notes,Problems,Request,DevTools') fail(t(`layout: the closed dock offers ${strip.join(', ')}`));
      await page.locator('.dock-collapsed button', { hasText: /^Notes/ }).click();
      await page.waitForSelector('.editor-drawer:not([hidden]) .live-docked[data-tab="notes"]', { timeout: 3000 }).catch(() => fail(t('layout: Notes in the closed dock’s strip did not open it there')));
      await page.click('.editor-actions button[aria-label="Hide the dock"]');
      await page.waitForSelector('.dock-collapsed', { timeout: 2000 }).catch(() => fail(t('layout: Hide the dock did not close it')));
      await nobody();
      await page.keyboard.press('Shift+BracketRight');
      await page.waitForSelector('.editor-drawer:not([hidden]) .live-docked[data-tab="notes"]', { timeout: 3000 }).catch(() => fail(t('layout: ⇧] did not open the dock on Notes, the tab it showed')));
      if (await tabIs() !== 'Layers') fail(t('layout: ⇧] moved the side panel too'));
      await page.keyboard.press('Shift+BracketRight');
      if (!/^Problems/.test(await dockIs(page))) fail(t(`layout: ⇧] with the dock open went to ${await dockIs(page)}, not Problems`));
      await page.keyboard.press('Shift+BracketLeft');
      if (!/^Notes/.test(await dockIs(page))) fail(t(`layout: ⇧[ went to ${await dockIs(page)}`));
      // From the page too, as the page script passes them.
      await page.waitForFunction(() => typeof window.__wgLive.press === 'function', null, { timeout: 3000 });
      await page.evaluate(() => window.__wgLive.press('dock-next'));
      await page.waitForFunction(() => /^Problems/.test(document.querySelector('.editor-drawer:not([hidden]) .dock-tabs [aria-checked="true"]')?.textContent ?? ''), null, { timeout: 2000 })
        .catch(() => fail(t('layout: ⇧] in the page did not step the dock')));
      if (!(await page.$('.editor-drawer:not([hidden]) .live-docked[data-tab="problems"] .live-side-block'))) fail(t('layout: the dock does not show the problems'));
      await shot('layout-dock');
      await page.keyboard.press('Meta+j');
      await page.waitForSelector('.editor-drawer[data-shows="code"]:not([hidden])', { timeout: 2000 }).catch(() => fail(t('layout: ⌘J on Problems did not show the code editor')));
      await page.keyboard.press('Meta+j');
      await page.waitForSelector('.dock-collapsed', { timeout: 2000 }).catch(() => fail(t('layout: ⌘J on the code editor did not close the dock')));
      await page.keyboard.press('Shift+L');
      await page.waitForSelector('.sel-list [role="option"]:has-text("Owner")', { timeout: 2000 }).catch(() => fail(t('layout: ⇧L did not open the lens list')));
      await page.keyboard.press('Escape');
      await nobody();
      await page.keyboard.press('Shift+C');
      await page.waitForSelector('.toast:has-text("Add a hosted environment")', { timeout: 2000 }).catch(() => fail(t('layout: ⇧C without an environment did not say why')));
      await page.locator('.toast .toast-x').click().catch(() => {});

      // The same keys pressed in the page: the page script answers, and the window does what the key says.
      await page.waitForFunction(() => typeof window.__wgLive.press === 'function', null, { timeout: 3000 }).catch(() => fail(t('layout: the view is not waiting for its keys from the page')));
      await page.evaluate(() => window.__wgLive.press('width-tablet'));
      await page.waitForFunction(() => document.querySelector('.live-widths button[aria-label^="Tablet"]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 2000 }).catch(() => fail(t('layout: 2 in the page did not narrow to a tablet')));
      await page.waitForFunction(() => typeof window.__wgLive.press === 'function', null, { timeout: 3000 });
      await page.evaluate(() => window.__wgLive.press('width-full'));
      await page.waitForFunction(() => typeof window.__wgLive.press === 'function', null, { timeout: 3000 });
      n = await mark();
      await page.evaluate(() => window.__wgLive.press('pick'));
      await page.waitForFunction((k) => window.__wgLive.calls.slice(k).includes('pick page'), n, { timeout: 2000 }).catch(() => fail(t('layout: P in the page with nothing chosen did not pick from the page')));
      await page.waitForFunction(() => typeof window.__wgLive.press === 'function', null, { timeout: 3000 });
      await page.evaluate(() => window.__wgLive.press('pick'));
      await page.waitForSelector('.live-status:has-text("Picking")', { state: 'detached', timeout: 2000 }).catch(() => fail(t('layout: P again did not stop picking')));

      // Sending notes: ⇧⌘↩ with none waiting says so; with one, it goes to the agent.
      await nobody();
      await page.keyboard.press('Meta+Shift+Enter');
      await page.waitForSelector('.toast:has-text("No notes are waiting")', { timeout: 2000 }).catch(() => fail(t('layout: ⇧⌘↩ with nothing waiting did not say so')));
      await page.locator('.live-layer', { hasText: 'Opening hours' }).first().click();
      await page.fill('.live-inspector textarea[aria-label="What should change here?"]', 'Say the hours for holidays too.');
      await page.keyboard.press('Meta+Enter');
      await page.waitForSelector('.dock-tabs button:has-text("Notes 1")', { timeout: 3000 }).catch(() => fail(t('layout: ⌘↩ in the note box did not add the note')));
      await page.getByRole('button', { name: 'Back to the layers' }).click();
      await nobody();
      await page.keyboard.press('Meta+Shift+Enter');
      await page.waitForSelector('.toast:has-text("Sent the note to")', { timeout: 5000 }).catch(() => fail(t('layout: ⇧⌘↩ did not send the note waiting')));
      await page.waitForFunction(() => [...document.querySelectorAll('.dock-tabs button')].some((b) => b.textContent.trim() === 'Notes'), null, { timeout: 3000 })
        .catch(() => fail(t('layout: the notes sent are still waiting')));

      // One status line: the site, what it follows, the keys that work now, on every tab.
      for (const tab of ['Layers', 'Problems']) {
        if (tab === 'Layers') await page.getByRole('radio', { name: /^Layers/ }).click();
        else await dockTo(page, tab, (w) => fail(t(w)));
        const status = await page.locator('.live-status').innerText();
        if (!/Drupal · following every session in Northstar/.test(status) || !/pick/.test(status)) fail(t(`layout: on ${tab} the status line reads "${status}"`));
      }
      if (await page.$('.live-side-foot, .live-side > .live-note')) fail(t('layout: the side panel still says the state itself'));
      await page.getByRole('radio', { name: 'Layers' }).click();
      await shot('layout');
    }

    // ── The page's own DevTools in the dock (components/live/DevTools.tsx; the views are src/main/live-devtools.ts,
    // played here by a placeholder the stand-in draws where DevTools' view would be). The tab, the bar's control and
    // Chrome's chord (⌥⌘I: this window says it is a Mac; a Windows window is checked after both themes) open and close
    // it; it is laid exactly over the tab and follows it (the window, the dock's edge, its side, a theme change), clear
    // of the Talk to Wanigan button; anything over it steps it aside; Show in DevTools, from the chosen part, a row of
    // the tree and ⇧D, points DevTools at the centre of the element (where the page script says it is); its own window
    // and back; and leaving: another view of the project keeps it, leaving the project closes it.
    {
      const calls = () => page.evaluate(() => window.__wgLive.calls.slice());
      const mark = async () => (await calls()).length;
      const since = async (n) => (await calls()).slice(n);
      const nobody = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => { document.activeElement?.blur(); done(); }))));
      const frames = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      // A picture of what was just checked, without the toasts earlier steps left (they were checked there).
      const devShot = (name) => page.screenshot({ path: join(out, `${theme}-${name}.png`), animations: 'disabled', style: '.toasts { visibility: hidden !important; }' });
      const devtools = page.locator('.live-bar-tools button[aria-keyshortcuts="Alt+Meta+I"]');
      const open = () => page.waitForSelector('.editor-drawer:not([hidden]) .live-docked[data-tab="devtools"] .live-devtools-host', { timeout: 3000 }).then(() => true, () => false);
      /** Where the stand-in laid DevTools' view, against the tab's own area: the same box, to the pixel. */
      const laid = () => page.evaluate(() => {
        const h = document.querySelector('.live-devtools-host')?.getBoundingClientRect();
        const b = window.__wgLive.devtools.bounds;
        const r = (x) => Math.round(x);
        return { host: h ? [r(h.left), r(h.top), r(h.width), r(h.height)].join() : null, laid: b ? [r(b.x), r(b.y), r(b.width), r(b.height)].join() : null, drawn: !!document.getElementById('__wg_devtools_stub') };
      });
      const followed = async (what) => {
        await frames();
        await page.waitForFunction(() => {
          const h = document.querySelector('.live-devtools-host')?.getBoundingClientRect();
          const b = window.__wgLive.devtools.bounds;
          return !!h && !!b && Math.round(h.left) === Math.round(b.x) && Math.round(h.top) === Math.round(b.y) && Math.round(h.width) === Math.round(b.width) && Math.round(h.height) === Math.round(b.height);
        }, null, { timeout: 3000 }).catch(async () => fail(t(`devtools: after ${what} DevTools is not over the tab (${JSON.stringify(await laid())})`)));
      };
      /**
       * The centre DevTools must be pointed at for a part: what of it is on screen as the page is scrolled now, in the
       * page's pixels, the page being as big as its place in the window (shared/live-devtools.ts centreOf).
       */
      const centreFor = (index) => page.evaluate(async (i) => {
        const r = await window.wanigan.live.where(i);
        const d = document.querySelector('.live-device');
        if (!r || !d) return null;
        const y = r.y - (window.__wgLive.scrollY ?? 0);
        const left = Math.max(0, r.x), top = Math.max(0, y), right = Math.min(d.clientWidth, r.x + r.width), bottom = Math.min(d.clientHeight, y + r.height);
        return `${Math.min(d.clientWidth - 1, Math.floor((left + right) / 2))} ${Math.min(d.clientHeight - 1, Math.floor((top + bottom) / 2))}`;
      }, index);
      /** The region a row of the tree stands for: what choosing it chooses on the page (then back to the tree alone). */
      const regionOfRow = async (row) => {
        const k = await mark();
        await row.click();
        await page.waitForFunction((x) => window.__wgLive.calls.slice(x).some((c) => /^choose \d+$/.test(c)), k, { timeout: 3000 });
        const chosen = (await since(k)).find((c) => /^choose \d+$/.test(c))?.slice('choose '.length) ?? null;
        await page.getByRole('button', { name: 'Back to the layers' }).click();
        return chosen;
      };
      /** Show in DevTools asked: which part the page brought into view, and where DevTools was pointed. */
      const inspected = async (n, what) => {
        await page.waitForFunction((k) => window.__wgLive.calls.slice(k).some((c) => c.startsWith('devtoolsInspect ')), n, { timeout: 3000 })
          .catch(() => fail(t(`devtools: ${what} did not point DevTools at anything`)));
        const asked = await since(n);
        const reveal = asked.find((c) => c.startsWith('reveal '));
        const at = asked.find((c) => c.startsWith('devtoolsInspect '))?.slice('devtoolsInspect '.length) ?? null;
        if (!reveal || asked.indexOf(reveal) > asked.findIndex((c) => c.startsWith('devtoolsInspect '))) fail(t(`devtools: ${what} did not bring the part into view first (${asked.join(', ')})`));
        return { reveal: reveal?.slice('reveal '.length) ?? null, at };
      };

      await page.goto(`${base}#/p/NS/live`);
      await page.waitForSelector('.live-tree', { timeout: 15_000 });
      if (await page.$('.editor-drawer:not([hidden])')) await page.click('.editor-actions button[aria-label^="Hide the"]');
      if (!(await devtools.count())) fail(t('devtools: no DevTools control in the bar’s tools, keyed ⌥⌘I'));
      if ((await devtools.getAttribute('aria-label')) !== 'DevTools (⌥⌘I)') fail(t(`devtools: the control is named "${await devtools.getAttribute('aria-label')}"`));
      if ((await devtools.getAttribute('aria-pressed')) !== 'false') fail(t('devtools: the control says DevTools is shown before it is'));

      // The bar's control opens the tab, with the keyboard for DevTools, laid exactly over it, the button over the corner left clear.
      let n = await mark();
      await devtools.click();
      if (!(await open())) fail(t('devtools: the bar’s DevTools did not open the tab in the dock'));
      await page.waitForFunction((k) => window.__wgLive.calls.slice(k).includes('devtoolsShow focus'), n, { timeout: 3000 })
        .catch(async () => fail(t(`devtools: the tab did not open DevTools there, with the keyboard (${(await since(n)).join(', ')})`)));
      if ((await devtools.getAttribute('aria-pressed')) !== 'true') fail(t('devtools: the control does not say DevTools is shown'));
      if (!/DevTools/.test(await dockIs(page))) fail(t(`devtools: the dock's tabs show ${await dockIs(page)}, not DevTools`));
      await followed('opening');
      if (!(await laid()).drawn) fail(t('devtools: nothing was drawn where DevTools goes'));
      const clear = await page.evaluate(() => {
        const h = document.querySelector('.live-devtools-host')?.getBoundingClientRect();
        const f = document.querySelector('.chat-fab')?.getBoundingClientRect();
        return !h || !f || f.top >= h.bottom || f.left >= h.right || f.bottom <= h.top || f.right <= h.left;
      });
      if (!clear) fail(t('devtools: DevTools’ view would cover the Talk to Wanigan button'));
      const said = await page.locator('.live-devtools-foot').innerText();
      if (!said.includes('Wanigan’s marks are in this page’s HTML while the live view is on.')) fail(t(`devtools: the tab does not say what of the page is Wanigan’s (${said})`));
      if (!said.includes('X-Wanigan-Live')) fail(t('devtools: on a site with the helper the tab does not say the Network panel shows its key'));
      if (!said.includes('⌥⌘I opens or closes this tab.')) fail(t(`devtools: the tab does not say its key (${said})`));
      await devShot('devtools');

      // It follows the tab: the window resized, the dock's edge moved by the keyboard, the dock beside the page and back.
      await page.setViewportSize({ width: 1280, height: 800 });
      await followed('the window was resized');
      await page.focus('.editor-resizer');
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('ArrowUp');
      await followed('the dock grew');
      await page.click('.editor-actions button[aria-label="Put the dock beside the view"]');
      await page.waitForSelector('.editor-drawer[data-dock="right"]:not([hidden]) .live-devtools-host', { timeout: 3000 }).catch(() => fail(t('devtools: beside the page the tab is gone')));
      await followed('the dock went beside the page');
      await devShot('devtools-beside');
      await page.click('.editor-actions button[aria-label="Put the dock beneath the view"]');
      await followed('the dock came back beneath the page');
      await page.focus('.editor-resizer');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.setViewportSize({ width: 1440, height: 900 });
      await followed('the window was resized back');

      // Anything over it steps it aside, its last picture standing in: the palette, used here to change the theme.
      const other = theme === 'dark' ? 'light' : 'dark';
      for (const to of [other, theme]) {
        n = await mark();
        await page.keyboard.press('Meta+k');
        await page.waitForSelector('.palette', { timeout: 3000 });
        await page.waitForFunction((k) => window.__wgLive.calls.slice(k).includes('devtoolsHide frame') && !window.__wgLive.devtools.shown, n, { timeout: 3000 })
          .catch(() => fail(t('devtools: the palette over the dock did not step DevTools aside with its picture')));
        if ((await laid()).drawn) fail(t('devtools: DevTools is still drawn under the palette'));
        await page.keyboard.type(`Theme: ${to === 'dark' ? 'dark' : 'light'}`);
        await page.keyboard.press('Enter');
        await page.waitForSelector('.palette', { state: 'detached', timeout: 3000 });
        await page.waitForFunction((th) => document.documentElement.dataset.theme === th && window.__wgLive.devtools.shown, to, { timeout: 3000 })
          .catch(() => fail(t(`devtools: after the theme changed to ${to} DevTools did not come back`)));
        await followed(`the theme changed to ${to}`);
      }

      // Chrome's chord, from the window with nothing focused: closes the tab (DevTools kept, only hidden), opens it again.
      await nobody();
      n = await mark();
      await page.keyboard.press('Meta+Alt+KeyI');
      await page.waitForSelector('.dock-collapsed', { timeout: 3000 }).catch(() => fail(t('devtools: ⌥⌘I with DevTools shown did not close the tab')));
      if ((await since(n)).includes('devtoolsClose')) fail(t('devtools: hiding the tab closed DevTools instead of keeping it'));
      if (!(await since(n)).includes('devtoolsHide')) fail(t('devtools: hiding the tab did not step DevTools aside'));
      const strip = await page.$$eval('.dock-collapsed button', (els) => els.map((e) => e.textContent.trim()));
      if (strip.join() !== 'Code,Notes,Problems,Request,DevTools') fail(t(`devtools: the closed dock offers ${strip.join(', ')}`));
      n = await mark();
      await page.keyboard.press('Meta+Alt+KeyI');
      if (!(await open())) fail(t('devtools: ⌥⌘I did not open the DevTools tab'));
      await page.waitForFunction((k) => window.__wgLive.calls.slice(k).includes('devtoolsShow focus'), n, { timeout: 3000 }).catch(() => fail(t('devtools: ⌥⌘I did not show DevTools, with the keyboard')));
      // While typing too: it is an app chord.
      await page.getByRole('radio', { name: 'Layers' }).click();
      await page.locator('.live-layer', { hasText: 'Opening hours' }).first().click();
      await page.click('.live-inspector textarea[aria-label="What should change here?"]');
      await page.keyboard.press('Meta+Alt+KeyI');
      await page.waitForSelector('.dock-collapsed', { timeout: 3000 }).catch(() => fail(t('devtools: ⌥⌘I in the note box did not close the tab')));
      await page.keyboard.press('Meta+Alt+KeyI');
      if (!(await open())) fail(t('devtools: ⌥⌘I in the note box did not open the tab again'));
      await page.getByRole('button', { name: 'Back to the layers' }).click();

      // Show in DevTools, on the chosen part: the tab is open, and DevTools is pointed at the element's centre.
      await page.click('.editor-actions button[aria-label="Hide the dock"]');
      await page.locator('.live-layer', { hasText: /^Hero/ }).first().click();
      await page.waitForSelector('.live-inspector', { timeout: 3000 });
      // Beside the part's name (the tree above it, folded to Hero, has its own on Hero's row).
      const showHero = page.locator('.live-inspector').getByRole('button', { name: 'Show Hero in DevTools (⇧D)' });
      if (!(await showHero.count())) fail(t('devtools: the chosen part has no Show in DevTools'));
      n = await mark();
      await showHero.click();
      let asked = await inspected(n, 'Show in DevTools on the chosen part');
      if (asked.reveal !== 'null') fail(t(`devtools: Show in DevTools on a chosen part brought ${asked.reveal} into view, not the element chosen`));
      const heroAt = await page.evaluate(() => window.__wgLive.picked);
      if (asked.at !== await centreFor(heroAt)) fail(t(`devtools: DevTools was pointed at ${asked.at}, not the centre of Hero (${await centreFor(heroAt)})`));
      if (!(await open())) fail(t('devtools: Show in DevTools did not open the DevTools tab'));
      await devShot('devtools-inspect');
      // ⇧D does what the button does.
      await nobody();
      n = await mark();
      await page.keyboard.press('Shift+D');
      asked = await inspected(n, '⇧D on the chosen part');
      if (asked.at !== await centreFor(heroAt)) fail(t(`devtools: ⇧D pointed DevTools at ${asked.at}`));
      await page.getByRole('button', { name: 'Back to the layers' }).click();

      // On a row of the tree: the one pointed at has Show in DevTools at its end; ⇧D on the row with the keyboard.
      const sidebar = page.locator('.live-layer', { hasText: /^Sidebar/ }).first();
      const sidebarAt = await regionOfRow(sidebar);
      await sidebar.hover();
      const rowAct = page.getByRole('button', { name: 'Show Sidebar in DevTools (⇧D)' });
      await rowAct.waitFor({ timeout: 3000 }).catch(() => fail(t('devtools: the row pointed at has no Show in DevTools')));
      const beside = await page.evaluate(() => {
        const row = [...document.querySelectorAll('.live-layer')].find((r) => /^Sidebar/.test(r.textContent ?? ''))?.getBoundingClientRect();
        const act = document.querySelector('.live-layer-act')?.getBoundingClientRect();
        return !!row && !!act && act.top >= row.top - 1 && act.bottom <= row.bottom + 1 && Math.abs(act.right - row.right) <= 1;
      });
      if (!beside) fail(t('devtools: Show in DevTools is not at the end of the row pointed at'));
      await devShot('devtools-row');
      n = await mark();
      await rowAct.click();
      asked = await inspected(n, 'Show in DevTools on a row');
      if (asked.reveal !== sidebarAt) fail(t(`devtools: the row's Show in DevTools brought ${asked.reveal} into view, not Sidebar (${sidebarAt})`));
      if (asked.at !== await centreFor(Number(sidebarAt))) fail(t(`devtools: the row pointed DevTools at ${asked.at}, not the centre of Sidebar (${await centreFor(Number(sidebarAt))})`));
      if (!(await page.evaluate(() => window.__wgLive.scrollY > 0))) fail(t('devtools: Sidebar, below the fold, was not scrolled into view'));
      const search = page.locator('.live-layer', { hasText: /^Search/ }).first();
      const searchAt = await regionOfRow(search);
      await search.focus();
      n = await mark();
      await page.keyboard.press('Shift+D');
      asked = await inspected(n, '⇧D on a row of the tree');
      if (asked.reveal !== searchAt) fail(t(`devtools: ⇧D on the Search row brought ${asked.reveal} into view, not Search (${searchAt})`));
      if (await page.$('.live-inspector')) fail(t('devtools: ⇧D on a row chose the part as well'));

      // In its own window, for a second screen: the tab says so and brings it back.
      n = await mark();
      await page.getByRole('button', { name: 'Open in its own window' }).click();
      await page.waitForSelector('.live-devtools-away:has-text("DevTools is in its own window.")', { timeout: 3000 }).catch(() => fail(t('devtools: in its own window, the tab does not say where DevTools is')));
      if (!(await since(n)).includes('devtoolsDetach')) fail(t('devtools: Open in its own window did not ask for DevTools’ own window'));
      if ((await laid()).drawn) fail(t('devtools: DevTools is drawn in the dock and in its own window'));
      await devShot('devtools-detached');
      n = await mark();
      await page.getByRole('button', { name: 'Back into the dock' }).click();
      await page.waitForFunction((k) => { const c = window.__wgLive.calls.slice(k); return c.indexOf('devtoolsClose') >= 0 && c.indexOf('devtoolsShow focus') > c.indexOf('devtoolsClose'); }, n, { timeout: 3000 })
        .catch(async () => fail(t(`devtools: Back into the dock did not close its window and open it in the dock (${(await since(n)).join(', ')})`)));
      await followed('it came back into the dock');

      // Leaving: another view of the project hides it (kept); coming back shows it; leaving the project closes it.
      n = await mark();
      await page.goto(`${base}#/p/NS/board`);
      await page.waitForSelector('.card', { timeout: 8000 });
      if (!(await since(n)).includes('devtoolsHide')) fail(t('devtools: going to the board did not step DevTools aside'));
      if ((await since(n)).includes('devtoolsClose')) fail(t('devtools: another view of the project closed DevTools'));
      n = await mark();
      await page.goto(`${base}#/p/NS/live`);
      if (!(await open())) fail(t('devtools: back in the live view the dock did not come back on DevTools'));
      await page.waitForFunction((k) => window.__wgLive.calls.slice(k).includes('devtoolsShow'), n, { timeout: 3000 }).catch(() => fail(t('devtools: back in the live view DevTools did not show again')));
      n = await mark();
      await page.goto(`${base}#/needs`);
      await page.waitForFunction((k) => window.__wgLive.calls.slice(k).includes('devtoolsClose'), n, { timeout: 3000 }).catch(() => fail(t('devtools: leaving the project did not close DevTools')));
      if (await page.$('#__wg_devtools_stub')) fail(t('devtools: DevTools is still drawn after leaving the project'));
      await page.goto(`${base}#/p/NS/live`);
      await page.waitForSelector('.live-tree', { timeout: 15_000 });
      if (await page.$('.editor-drawer:not([hidden])')) await page.click('.editor-actions button[aria-label^="Hide the"]');
      await page.evaluate(() => window.__wgLive.scrollTo(0));
    }

    // ── The design layer: a style tried and words retyped on a chosen part are edits of the layer, shown on the page
    // through it; the tray (Edits, ⇧E) lists them with before → after, reach, state and what the state means, and makes
    // them real (words through a field the site stores; refused, with main's reasons, where main refuses; a block's
    // words its own template writes, with that template's reach said first), verifies them (failing and passing, the
    // edit staying in the site), discards, undoes and redoes, says why one is orphaned, and shows the page without it.
    // The stand-in plays the core's transitions and main's refusals, so what passes here is what they allow.
    {
      const calls = () => page.evaluate(() => window.__wgLive.calls.slice());
      const mark = async () => (await calls()).length;
      const since = async (n) => (await calls()).slice(n);
      const counted = async (n, re) => (await since(n)).filter((c) => re.test(c)).length;
      const nobody = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => { document.activeElement?.blur(); done(); }))));
      const edits = page.locator('.live-bar-tools button[aria-keyshortcuts="Shift+E"]');
      // An edit's row, by a line of its before → after (a verdict's words may name the same property).
      const rowOf = (text) => page.locator('.live-tray-edit').filter({ has: page.locator('.live-layer-lines li', { hasText: text }) });
      const stateIs = (text, state, what) => page.waitForFunction(([x, st]) => [...document.querySelectorAll('.live-tray-edit')]
        .find((e) => e.querySelector('.live-layer-lines')?.textContent.includes(x))?.getAttribute('data-state') === st, [text, state], { timeout: 3000 })
        .catch(() => fail(t(`layer: ${what}`)));
      const stateOf = (text) => rowOf(text).getAttribute('data-state').catch(() => null);
      const rowsAre = (n, what) => page.waitForFunction((k) => document.querySelectorAll('.live-tray-edit').length === k, n, { timeout: 3000 })
        .catch(async () => fail(t(`layer: ${what}: the tray lists ${(await page.$$('.live-tray-edit')).length} edits, not ${n}`)));
      const rowSays = (text, words, what) => page.waitForFunction(([x, w]) => [...document.querySelectorAll('.live-tray-edit')]
        .find((e) => e.querySelector('.live-layer-lines')?.textContent.includes(x))?.textContent.replace(/\s+/g, ' ').includes(w), [text, words], { timeout: 4000 })
        .catch(async () => fail(t(`layer: ${what} (${(await rowOf(text).innerText().catch(() => '')).replace(/\s+/g, ' ')})`)));
      const backToLayers = async () => { if (await page.$('.live-inspector')) await page.getByRole('button', { name: 'Back to the layers' }).click(); };
      // A picture of what was just checked: scrolled to it, without the toasts that would cover it (they were checked).
      const layerShot = async (name, at = null) => {
        if (at) await page.locator(at).first().evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => fail(t(`layer: ${at} is not there to picture`)));
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done())));
        await page.screenshot({ path: join(out, `${theme}-${name}.png`), animations: 'disabled', style: '.toasts { visibility: hidden !important; }' });
      };
      const set = (values) => page.evaluate((v) => Object.assign(window.__wgLive, v), values);
      const openTray = async () => {
        if (!(await page.$('.live-tray'))) await edits.click();
        await page.waitForSelector('.live-tray-edit', { timeout: 3000 }).catch(() => fail(t('layer: Edits did not open the tray')));
      };
      const closeTray = async () => {
        if (!(await page.$('.live-tray'))) return;
        await page.locator('.live-tray .live-side-title').focus();
        await page.keyboard.press('Escape');
        await page.waitForSelector('.live-tray', { state: 'detached', timeout: 3000 }).catch(() => fail(t('layer: Escape did not close the tray')));
      };
      // Notes, with Saved by hand under them, in the dock beneath the page.
      const notesTab = async () => { await closeTray(); await dockTo(page, 'Notes', (w) => fail(t(`layer: ${w}`))); };
      /** Choose a part in the tree and open Retype in a box on it (the keyboard and screen-reader way), with the new words typed. */
      const retype = async (part, words) => {
        await backToLayers();
        await page.locator('.live-layer', { hasText: part }).first().click();
        await page.getByRole('button', { name: new RegExp(`^Edit ${part}`) }).click();
        await page.getByRole('menuitem', { name: /^Retype in a box/ }).click();
        await page.waitForSelector('.live-layer-edit textarea', { timeout: 3000 }).catch(() => fail(t(`layer: Retype in a box on ${part} opened nothing to type in`)));
        await page.locator('.live-layer-edit textarea').fill(words);
      };
      const added = (words) => page.waitForSelector(`.live-layer-added:has-text("${words}")`, { timeout: 3000 }).catch(() => fail(t(`layer: “${words}” was not said to be in the layer`)));
      await page.locator('.toast .toast-x').click().catch(() => {});
      await page.getByRole('radio', { name: 'Layers' }).click();
      await backToLayers();
      if (!(await edits.count())) fail(t('layer: no Edits in the bar’s tools'));
      if ((await edits.getAttribute('aria-label')) !== 'Edits: the design layer (⇧E)') fail(t(`layer: with nothing in the layer the bar says ${await edits.getAttribute('aria-label')}`));

      // A style tried on a chosen part: every instance says what it reaches, and how many, before it is chosen.
      await page.locator('.live-layer', { hasText: /^Event/ }).first().click();
      await page.waitForFunction(() => document.querySelector('.live-inspector .live-side-title')?.textContent === 'Spring open house', null, { timeout: 3000 })
        .catch(() => fail(t('layer: choosing an event did not choose Spring open house')));
      await page.getByRole('button', { name: /^Edit Spring open house/ }).click();
      await page.getByRole('menuitemcheckbox', { name: /^Try a style/ }).click();
      const kind = page.locator('.live-layer-scope-option', { hasText: 'Every one of its kind' });
      await kind.waitFor({ timeout: 3000 }).catch(() => fail(t('layer: Try a style offers no way to change every instance')));
      if (!(await kind.innerText()).includes('every event node: 3 elements on this page')) fail(t(`layer: every instance does not say its reach first (${await kind.innerText().catch(() => '')})`));
      if (await page.locator('.live-layer-scope input[value="kind"]').isChecked()) fail(t('layer: every instance was chosen before the owner chose it'));
      if (!(await page.locator('.live-layer-scope input[value="this"]').isChecked())) fail(t('layer: a style is not for this element by default'));
      let n = await mark();
      await page.locator('#live-style-color').fill('#c0392b');
      // Each change shows on the page at once, as a preview: nothing is added to the layer until it is kept.
      await page.waitForFunction((k) => window.__wgLive.calls.slice(k).includes('layerTry this {"color":"#c0392b"}'), n, { timeout: 2000 })
        .catch(async () => fail(t(`layer: the colour chosen was not shown on the page as it changed (${(await since(n)).join(', ')})`)));
      if ((await since(n)).some((c) => c.startsWith('layerAdd'))) fail(t('layer: a style being tried was added to the layer before it was kept'));
      await page.locator('#live-style-color').fill('#1e8449');
      await page.waitForFunction((k) => window.__wgLive.calls.slice(k).includes('layerTry this {"color":"#1e8449"}'), n, { timeout: 2000 })
        .catch(() => fail(t('layer: a second colour did not replace the first on the page')));
      // Pictured with the page scrolled to the event the colour is tried on.
      await page.evaluate(() => window.__wgLive.scrollTo(820));
      await layerShot('layer-try');
      await page.evaluate(() => window.__wgLive.scrollTo(0));
      await page.locator('#live-style-color').fill('#c0392b');
      await page.waitForFunction(() => window.__wgLive.tried?.values?.color === '#c0392b', null, { timeout: 2000 }).catch(() => fail(t('layer: the page does not show the colour chosen last')));
      await layerShot('layer-style', '.live-layer-scope');
      n = await mark();
      await page.getByRole('button', { name: 'Show it on the page' }).click();
      await page.waitForSelector('.live-layer-added:has-text("for this element")', { timeout: 3000 }).catch(() => fail(t('layer: a style tried was not said to be in the layer')));
      if (!(await since(n)).includes('layerAdd style this')) fail(t('layer: the style was not added to the layer for this element'));
      if (!(await since(n)).includes('layerApply')) fail(t('layer: the page was not shown the layer again after the edit'));
      // The preview gives way only once the layer shows the same values: never a moment without them.
      await page.waitForFunction((k) => window.__wgLive.calls.slice(k).includes('layerTry off'), n, { timeout: 2000 }).catch(() => fail(t('layer: the preview stayed on the page once the style was kept')));
      {
        const after = await since(n);
        if (after.indexOf('layerTry off') < after.indexOf('layerApply')) fail(t(`layer: the preview went before the layer showed the style kept (${after.join(', ')})`));
      }
      await page.waitForFunction(() => document.querySelector('.live-bar-tools button[aria-keyshortcuts="Shift+E"]')?.getAttribute('aria-label') === 'Edits, 1 draft: the design layer (⇧E)', null, { timeout: 3000 })
        .catch(() => fail(t('layer: the bar does not count the draft')));
      n = await mark();
      await page.fill('#live-style-font-size', '22');
      await kind.click();
      await page.waitForFunction((k) => window.__wgLive.calls.slice(k).includes('layerTry kind {"font-size":"22px"}'), n, { timeout: 2000 })
        .catch(async () => fail(t(`layer: every one of its kind was not shown the size as it was chosen (${(await since(n)).join(', ')})`)));
      await page.getByRole('button', { name: 'Show it on the page' }).click();
      await page.waitForSelector('.live-layer-added:has-text("for every event node (3 elements on this page)")', { timeout: 3000 })
        .catch(() => fail(t('layer: a style for every instance was not said with its reach')));
      if (!(await since(n)).includes('layerAdd style kind')) fail(t('layer: the style was not added for every instance'));
      n = await mark();
      await page.fill('#live-style-padding-top', '30');
      await page.waitForFunction((k) => window.__wgLive.calls.slice(k).some((c) => c.startsWith('layerTry ') && c.includes('{"padding-top":"30px"}')), n, { timeout: 2000 })
        .catch(() => fail(t('layer: a third style was not shown on the page as it changed')));
      await page.getByRole('button', { name: 'Done' }).click();
      await page.waitForFunction((k) => window.__wgLive.calls.slice(k).at(-1) === 'layerTry off', n, { timeout: 2000 }).catch(() => fail(t('layer: Done left the style being tried on the page')));
      if ((await since(n)).some((c) => c.startsWith('layerAdd'))) fail(t('layer: a style tried and left with Done was added to the layer'));

      // Retyped words are a text draft; markup no part names is said to be fragile before the edit is made, and how:
      // its words guard it. Enter adds it once: not when an input method confirms a word, not again while it is held.
      await retype('Opening hours', 'Open every day, 7 to 6');
      const fragileFirst = await page.locator('.live-layer-edit .live-layer-fragile').innerText().catch(() => '');
      if (!/Its words guard it: if that place shows other words, the edit is set aside as orphaned/.test(fragileFirst)) fail(t(`layer: words no part names were not said to be fragile, and how, before the edit (${fragileFirst})`));
      await layerShot('layer-words');
      n = await mark();
      await page.locator('.live-layer-edit textarea').evaluate((el) => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, repeat: true }));
      });
      await added('Open every day, 7 to 6');
      const adds = await counted(n, /^layerAdd text this$/);
      if (adds !== 1) fail(t(`layer: an input method’s Enter, then Enter held, made ${adds} drafts, not one`));
      // Words typed on the page itself, in a field the site stores (an article's body). A double-click on them in the page
      // (answered by the page as a key is) or Retype the words puts the window into typing: the status line says so with
      // Keep and Put back, and the keys that work now are those two. Put back adds nothing; Keep adds one text edit and
      // shows the layer again, and the window is out of typing.
      const typingSaid = () => page.waitForSelector('.live-status:has-text("Typing on the page: Enter keeps it in the layer, Esc puts it back")', { timeout: 3000 });
      const notTyping = (what) => page.waitForFunction(() => !/Typing on the page/.test(document.querySelector('.live-status')?.textContent ?? ''), null, { timeout: 3000 })
        .catch(() => fail(t(`layer: ${what}: the status line still says typing`)));
      await backToLayers();
      await page.locator('.live-layer', { hasText: 'Body' }).first().click();
      await page.waitForFunction(() => document.querySelector('.live-inspector .live-side-title')?.textContent === 'Body', null, { timeout: 3000 }).catch(() => fail(t('layer: choosing Body did not choose it')));
      n = await mark();
      await page.waitForFunction(() => typeof window.__wgLive.press === 'function', null, { timeout: 3000 }).catch(() => fail(t('layer: the window is not waiting for the page')));
      await page.evaluate(() => window.__wgLive.press('retype'));
      await typingSaid().catch(() => fail(t('layer: a double-click on the chosen words in the page did not type on them')));
      if (!(await since(n)).includes('layerType')) fail(t('layer: the double-click did not ask the page to type'));
      const keysWhileTyping = await page.locator('.live-status-keys').innerText().catch(() => '');
      if (!/Enter\s*keep/.test(keysWhileTyping) || !/Esc\s*put back/.test(keysWhileTyping)) fail(t(`layer: while typing the status line’s keys read "${keysWhileTyping}"`));
      await page.evaluate(() => window.__wgLive.type('Fresh'));
      await page.getByRole('button', { name: 'Put back' }).click();
      await notTyping('Put back');
      if (!(await since(n)).includes('layerTypeEnd false')) fail(t('layer: Put back did not put the words back on the page'));
      if ((await since(n)).some((c) => c.startsWith('layerAdd'))) fail(t('layer: words put back were added to the layer'));
      n = await mark();
      await page.getByRole('button', { name: /^Edit Body/ }).click();
      await page.getByRole('menuitem', { name: /^Retype the words/ }).click();
      await typingSaid().catch(() => fail(t('layer: Retype the words did not put the window into typing on the page')));
      if (await page.$('.live-layer-edit textarea')) fail(t('layer: Retype the words opened the box as well as typing on the page'));
      for (const so of ['Fresh', 'Fresh loaves', 'Fresh loaves daily']) await page.evaluate((w) => window.__wgLive.type(w), so);
      await page.evaluate(() => window.__wgLive.scrollTo(320));
      await layerShot('layer-typing');
      await page.evaluate(() => window.__wgLive.scrollTo(0));
      await page.getByRole('button', { name: 'Keep' }).click();
      await added('Fresh loaves daily');
      await notTyping('Keep');
      {
        const after = await since(n);
        if (after.filter((c) => c === 'layerAdd text this').length !== 1) fail(t(`layer: keeping words typed on the page made ${after.filter((c) => c === 'layerAdd text this').length} text edits, not one`));
        if (after.lastIndexOf('layerApply') < after.indexOf('layerAdd text this')) fail(t('layer: the layer was not applied again once the words typed were added'));
      }
      // A block whose words its own template writes, retyped in the box: the keyboard and screen-reader way to do the same.
      await retype('Copyright', '© 2026 Acme Bakery');
      if (!(await page.locator('.live-layer-edit').innerText()).includes('For this element.')) fail(t('layer: Retype in a box does not say what it reaches'));
      await page.keyboard.press('Enter');
      await added('© 2026 Acme Bakery');

      // The tray, from the bar's key: the five drafts on this page, each with before → after, its reach, its state and what it means.
      await page.locator('.live-inspector .live-side-title').focus();
      await page.keyboard.press('Shift+E');
      await page.waitForSelector('.live-tray-edit', { timeout: 3000 }).catch(() => fail(t('layer: ⇧E did not open the tray')));
      if ((await edits.getAttribute('aria-pressed')) !== 'true') fail(t('layer: the bar’s Edits is not shown as on'));
      if (await page.$('.live-tree, .live-inspector')) fail(t('layer: the tray shares the panel with the layers'));
      if (!/Edits/.test(await page.locator('.live-tray .live-side-title').innerText())) fail(t('layer: the tray has no title'));
      await rowsAre(5, 'five drafts');
      if ((await page.locator('.live-tray-page .live-section-title').first().innerText()).toLowerCase() !== 'the front page, / · this page') fail(t('layer: the tray’s page is not named'));
      const want = [
        ['color', ['rgb(20, 20, 20)', '#c0392b', 'For this element.', 'Draft', 'An agent makes it in the theme, and the layer cannot tell yet when one has']],
        ['font-size', ['16px', '22px', 'For every event node (3 elements on this page).', 'Draft']],
        ['Open every day', ['Opening hours', 'Open every day, 7 to 6', 'For this element.', 'Fragile: No part of the site names this element', 'Its words guard it', 'Draft', 'the site does not have it']],
        ['Fresh loaves', ['Body', 'Fresh loaves daily', 'For this element.', 'Draft']],
        ['Acme Bakery', ['Copyright', '© 2026 Acme Bakery', 'For this element.', 'Draft']],
      ];
      for (const [row, says] of want) {
        const text = (await rowOf(row).innerText().catch(() => '')).replace(/\s+/g, ' ');
        for (const w of says) if (!text.includes(w)) fail(t(`layer: the ${row} edit does not say "${w}" (${text})`));
      }
      if (!/^Edits, 5 drafts/.test(await edits.getAttribute('aria-label'))) fail(t(`layer: the bar says ${await edits.getAttribute('aria-label')}`));
      await layerShot('layer-tray');

      // Undo and redo say what they would do, and do it.
      const undo = page.locator('.live-tray-tools button', { hasText: /^(Undo|Nothing to undo)/ });
      const redo = page.locator('.live-tray-tools button', { hasText: /^(Redo|Nothing to redo)/ });
      if ((await undo.innerText()) !== 'Undo: take “Copyright (block)” out of the layer') fail(t(`layer: Undo says "${await undo.innerText()}"`));
      if ((await redo.innerText()) !== 'Nothing to redo' || !(await redo.isDisabled())) fail(t('layer: Redo offers something before anything was undone'));
      await undo.click();
      await rowsAre(4, 'undo');
      if (await rowOf('Acme Bakery').count()) fail(t('layer: undo did not take the words out of the tray'));
      if ((await redo.innerText()) !== 'Redo: put “Copyright (block)” back in the layer') fail(t(`layer: Redo says "${await redo.innerText()}"`));
      await redo.click();
      await rowsAre(5, 'redo');
      // Discard takes a draft out; undo brings it back.
      await rowOf('font-size').getByRole('button', { name: /^Discard/ }).click();
      await rowsAre(4, 'discard');
      if ((await undo.innerText()) !== 'Undo: bring back “Spring open house (content)”') fail(t(`layer: after a discard Undo says "${await undo.innerText()}"`));
      await undo.click();
      await rowsAre(5, 'undoing the discard');
      if (!(await rowOf('font-size').count())) fail(t('layer: undo did not bring back the discarded edit'));
      // Every control is named by what it shows, and only an answer's words are announced, never a whole form.
      const misnamed = await page.$$eval('.live-tray button[aria-label]', (bs) => bs
        .filter((b) => b.innerText.trim() && !b.getAttribute('aria-label').startsWith(b.innerText.trim())).map((b) => `${b.innerText.trim()} / ${b.getAttribute('aria-label')}`));
      if (misnamed.length) fail(t(`layer: controls whose names do not begin with what they show: ${misnamed.join('; ')}`));

      // Words in markup no part names, and words in a field the site refused: said, and no template is offered for either.
      await rowOf('Open every day').getByRole('button', { name: 'Make it real: “Opening hours (no part names it)”' }).click();
      await rowSays('Open every day', 'markup no part of the page’s trace names', 'words no part names were made real, or not said why not');
      if (await rowOf('Open every day').getByRole('button', { name: /^Look in its template/ }).count()) fail(t('layer: a template was offered for markup no part names'));
      if ((await stateOf('Open every day')) !== 'draft') fail(t('layer: words no part names changed state'));
      await set({ saveRefusal: 'The field no longer holds those words: it was changed since the page was shown. Reload the page, then try again.' });
      await rowOf('Fresh loaves').getByRole('button', { name: /^Make it real/ }).click();
      await rowSays('Fresh loaves', 'The field no longer holds those words', 'the site’s refusal was not said');
      if (await rowOf('Fresh loaves').getByRole('button', { name: /^Look in its template/ }).count()) fail(t('layer: a template was offered after the site refused a field it stores'));
      if (await page.$$eval('.live-tray [role="status"]', (els) => els.filter((e) => e.querySelector('button, textarea, input, select')).length)) fail(t('layer: a status region holds controls, not only its words'));

      // Made real through the field it is kept in: while the site saves, undo, redo and discard wait, and the tray closed
      // and opened again does not start it twice. Closed, the keyboard goes back to the bar's Edits.
      await set({ implementMs: 900 });
      n = await mark();
      await rowOf('Fresh loaves').getByRole('button', { name: /^Make it real/ }).click();
      await page.waitForSelector('.live-tray:has-text("undo, redo and discard wait")', { timeout: 2000 }).catch(() => fail(t('layer: saving to the site was not said')));
      if (!(await undo.isDisabled())) fail(t('layer: Undo was offered while words were being saved to the site'));
      if (!(await rowOf('Acme Bakery').getByRole('button', { name: /^Discard/ }).isDisabled())) fail(t('layer: Discard was offered while words were being saved to the site'));
      await closeTray();
      await page.waitForFunction(() => document.activeElement?.matches('.live-bar button[aria-keyshortcuts="Shift+E"]'), null, { timeout: 2000 })
        .catch(() => fail(t('layer: closing the tray did not give the keyboard back to Edits')));
      await page.keyboard.press('Shift+E');
      await page.waitForSelector('.live-tray-edit', { timeout: 3000 }).catch(() => fail(t('layer: ⇧E from the bar did not open the tray again')));
      if (!(await rowOf('Fresh loaves').getByRole('button', { name: /^Make it real/ }).isDisabled().catch(() => true))) fail(t('layer: opened again while the words were being saved, the tray offers to save them again'));
      await stateIs('Fresh loaves', 'implemented', 'Make it real on a field did not mark the words implemented');
      await set({ implementMs: 0 });
      if ((await counted(n, /^layerImplement /)) !== 1) fail(t('layer: the words were made real more than once'));
      await page.waitForSelector('.toast:has-text("in the site, as revision 217")', { timeout: 3000 }).catch(() => fail(t('layer: making the words real did not say so')));
      if (!(await rowOf('Fresh loaves').innerText()).includes('In the site, not verified')) fail(t('layer: an implemented edit does not say it is not verified'));

      // Verify: failing at the styles, then at the pixels, the edit staying in the site; then passing.
      await set({ verdict: 'styles' });
      await rowOf('Fresh loaves').getByRole('button', { name: /^Verify/ }).click();
      await page.waitForSelector('.live-tray-edit:has-text("Fresh loaves") .live-tray-verdict.failed', { timeout: 4000 }).catch(() => fail(t('layer: a failing verification was not shown')));
      const failing = (await rowOf('Fresh loaves').innerText()).replace(/\s+/g, ' ');
      for (const w of ['Not verified at 390 and 1440 px', 'Step 1 of 3, the styles and boxes of the edited elements failed; the steps after it were not judged.',
        'At 1440 px, h3.teaser__title: color is rgb(20, 20, 20) in the site, rgb(192, 57, 43) in the design.', 'Noise floor: up to 3 of 255 in 12 pixels', 'Checked just now.']) {
        if (!failing.includes(w)) fail(t(`layer: a failing verdict does not say "${w}"`));
      }
      // Made real elsewhere, with no page from before: step 3 says it could not compare with it, and why; what was left
      // out and how far down the page was compared are said as statements, not differences.
      for (const w of ['Not compared with the page as it was before it was made real: No page from before was kept for it',
        'At 1440 px the page is 9,412 px tall: compared down to 6,000 px, and nothing below that.',
        'Left out of the pixel comparison, because the site says they change from one render to the next:', 'Who’s online (block): made for each user, at 390 and 1440 px.']) {
        if (!failing.includes(w)) fail(t(`layer: a failing verdict does not say "${w}"`));
      }
      if ((await rowOf('Fresh loaves').locator('.live-tray-differences[aria-label="What differs"] li').count()) !== 1) fail(t('layer: a statement of the verdict was listed among its differences'));
      await page.waitForSelector('.live-tray-edit:has-text("Fresh loaves") .live-tray-picture:has-text("The page before · 390 px") .live-tray-picture-none:has-text("None kept")', { timeout: 4000 })
        .catch(() => fail(t('layer: a verdict with no page from before does not say none was kept')));
      if ((await stateOf('Fresh loaves')) !== 'implemented') fail(t('layer: a failing verification took the edit out of the site'));
      await page.waitForSelector('.live-tray-edit:has-text("Fresh loaves") img[alt="Difference at 390 px"]', { timeout: 4000 }).catch(() => fail(t('layer: a failing verdict shows no difference picture')));
      await page.waitForSelector('.live-tray-edit:has-text("Fresh loaves") img[alt="The design at 1440 px"]', { timeout: 4000 }).catch(() => fail(t('layer: a verdict shows no design picture')));
      await layerShot('layer-verify-failed', '.live-tray-edit[data-state="implemented"] .live-tray-verdict.failed');
      await rowOf('Fresh loaves').getByRole('button', { name: 'Difference at 390 px, larger' }).click();
      await page.waitForSelector('.dialog .live-tray-large img[alt="Difference at 390 px"]', { timeout: 3000 }).catch(() => fail(t('layer: a verification picture did not open larger')));
      await page.keyboard.press('Escape');
      await set({ verdict: 'pixels' });
      await rowOf('Fresh loaves').getByRole('button', { name: /^Verify/ }).click();
      await page.waitForSelector('.live-tray-edit:has-text("At 390 px, 1,840 pixels differ around it, by up to 172 of 255, in a 320 × 60 box at 24, 910.")', { timeout: 4000 })
        .catch(() => fail(t('layer: a verdict failing at the pixels does not say where, and by how much')));
      if (!(await rowOf('Fresh loaves').innerText()).includes('Step 2 of 3, the pixels around the edited elements failed')) fail(t('layer: a verdict failing at the pixels does not say its step'));
      // Passing, slowly: closed and opened again meanwhile, the tray says it still runs and does not verify twice.
      await set({ verdict: 'pass', verifyMs: 1200 });
      n = await mark();
      await rowOf('Fresh loaves').getByRole('button', { name: /^Verify/ }).click();
      await closeTray();
      await page.keyboard.press('Shift+E');
      await page.waitForSelector('.live-tray-edit', { timeout: 3000 }).catch(() => fail(t('layer: ⇧E did not open the tray again')));
      const still = rowOf('Fresh loaves').getByRole('button', { name: /^Verifying…/ });
      if (!(await still.count()) || !(await still.isDisabled())) fail(t('layer: opened again, the tray does not say the verification still runs'));
      await page.waitForSelector('.live-tray-edit[data-state="verified"] .live-tray-verdict.ok', { timeout: 4000 }).catch(() => fail(t('layer: a passing verification was not shown')));
      await set({ verifyMs: 80 });
      if ((await counted(n, /^layerVerify /)) !== 1) fail(t('layer: the edit was verified twice'));
      if (await page.locator('.live-tray-edit[data-state="verified"] [role="alert"]').count()) fail(t('layer: a verified edit says it was not verified'));
      if (!(await rowOf('Fresh loaves').innerText()).includes('Verified at 390 and 1440 px: the site renders it as designed.')) fail(t('layer: a passing verdict does not say so'));
      await page.waitForSelector('.live-tray-edit[data-state="verified"] img[alt="The site at 390 px"]', { timeout: 4000 }).catch(() => fail(t('layer: a passing verdict shows no pictures')));
      // Passing: compared with the page as it was before too, held still, and what was left out said; no difference listed.
      const passing = (await rowOf('Fresh loaves').innerText()).replace(/\s+/g, ' ');
      for (const w of ['The rest of the page was also compared with the page as it was just before this was made real, at 390 and 1440 px.',
        'The site’s helper held relative dates and random orders still for every render', 'At 1440 px the page is 9,412 px tall: compared down to 6,000 px',
        'Who’s online (block): made for each user, at 390 and 1440 px.',
        'Noise floor: up to 3 of 255 in 12 pixels, the most the page with the layer or without it differed from itself when rendered twice, at any width, over what was not left out.',
        'The same words also changed in one other place on the page, where the site shows the same stored value: span.breadcrumb__current.']) {
        if (!passing.includes(w)) fail(t(`layer: a passing verdict does not say "${w}"`));
      }
      if (await rowOf('Fresh loaves').locator('.live-tray-differences[aria-label="What differs"]').count()) fail(t('layer: a verdict that passed lists a difference'));
      await page.waitForSelector('.live-tray-edit[data-state="verified"] img[alt="The page before at 390 px"]', { timeout: 4000 }).catch(() => fail(t('layer: a passing verdict does not picture the page as it was before')));
      if (await rowOf('Fresh loaves').getByRole('button', { name: /^Discard/ }).count()) fail(t('layer: an edit in the site can be discarded'));
      await layerShot('layer-verified', '.live-tray-edit[data-state="verified"] .live-tray-verdict');

      // A block's words that nothing the site stores holds. On Drupal the helper says its template writes them, and a
      // template is code: they go to an agent, and no template is offered here.
      const block = 'themes/custom/acme/templates/block--copyright.html.twig';
      const footer = 'themes/custom/acme/templates/region--footer.html.twig';
      await rowOf('Acme Bakery').getByRole('button', { name: /^Make it real/ }).click();
      await rowSays('Acme Bakery', `These words are written in ${block}, a template: a template is code`, 'on Drupal, words a template writes were not sent to an agent');
      if (await rowOf('Acme Bakery').getByRole('button', { name: /^Look in its template/ }).count()) fail(t('layer: on Drupal a template was offered for words its helper sends to an agent'));
      // Where the helper cannot say what writes them (a WordPress classic theme, its template files marked around what
      // they print), nothing holds them: the template that rendered the block itself is offered as its own action, its
      // reach said before the save; never the footer around it, which holds the same words.
      const asPlatform = (platform) => page.evaluate((pl) => { const w = window.__wgLive; w.answer = { ...w.answer, trace: { ...w.answer.trace, platform: pl } }; }, platform);
      await asPlatform('wordpress');
      await rowOf('Acme Bakery').getByRole('button', { name: /^Make it real/ }).click();
      await rowSays('Acme Bakery', 'Nothing this page offers to edit holds exactly these words, so there is nothing here to save them to', 'nothing stored holding a block’s words was not said');
      const look = rowOf('Acme Bakery').getByRole('button', { name: /^Look in its template/ });
      if (!(await look.count())) fail(t('layer: nothing the site stores holds the words, and the template was not offered'));
      await look.click();
      const save = rowOf('Acme Bakery').getByRole('button', { name: /^Save to block--copyright\.html\.twig, line 2/ });
      await save.waitFor({ timeout: 3000 }).catch(() => fail(t('layer: the block’s own template was not found')));
      const reachFirst = (await rowOf('Acme Bakery').innerText()).replace(/\s+/g, ' ');
      for (const w of [`${block}, line 2: the template that rendered this element`, 'every page that uses it shows the new words, not only this element', 'Verify compares this page only']) {
        if (!reachFirst.includes(w)) fail(t(`layer: before the save, the template’s reach does not say "${w}"`));
      }
      if (reachFirst.includes('region--footer')) fail(t('layer: the template around the block was offered'));
      await layerShot('layer-template', '.live-tray-template');
      // Read again just before writing: the page shown without the layer does not show the edit, and nothing is written.
      n = await mark();
      const without = page.getByRole('button', { name: 'Show the page without the layer' });
      await without.click();
      await save.click();
      await rowSays('Acme Bakery', 'The page is shown without the layer', 'a save while the edit was not shown was not refused');
      if (await counted(n, /^saveText /)) fail(t('layer: a template was written while the edit was not shown'));
      await without.click();
      // The core refuses the mark: the write is said all the same (a toast, the page reloaded), and so is the refusal.
      await rowOf('Acme Bakery').getByRole('button', { name: 'Look again' }).click();
      await save.waitFor({ timeout: 3000 }).catch(() => fail(t('layer: looking again did not find the template')));
      await set({ refuseMark: 'That edit is not in the layer now: it was undone or discarded.' });
      n = await mark();
      await save.click();
      await page.waitForSelector('.toast:has-text("Saved “Copyright (block)” to block--copyright.html.twig (line 2)")', { timeout: 3000 }).catch(() => fail(t('layer: a template written was not said when the layer refused to mark it')));
      await rowSays('Acme Bakery', 'The layer could not mark this edit implemented: That edit is not in the layer now', 'the refused mark was not said');
      if (!(await since(n)).includes('reload')) fail(t('layer: the page was not reloaded after the template was written'));
      if ((await stateOf('Acme Bakery')) !== 'draft') fail(t('layer: the layer says the site has words it refused to record'));
      const written = await page.evaluate(([b, f]) => [window.__wgLive.templates[b], window.__wgLive.templates[f]], [block, footer]);
      if (!written[0]?.includes('© 2026 Acme Bakery') || written[1]?.includes('Acme Bakery')) fail(t(`layer: the wrong template was written (${JSON.stringify(written)})`));
      await layerShot('layer-template-unmarked', '.live-tray-edit:has-text("Acme Bakery") [role="alert"]');
      // The layer does not hold them: Notes › Saved by hand puts them back.
      await notesTab();
      const savedRows = page.locator('.live-edits li', { hasText: 'Acme Bakery' });
      await savedRows.first().waitFor({ timeout: 3000 }).catch(() => fail(t('layer: the template save is not listed in Notes › Saved by hand')));
      await savedRows.first().getByRole('button', { name: 'Put back' }).click().catch(() => fail(t('layer: words the layer does not hold cannot be put back')));
      await page.waitForSelector('.toast:has-text("Put back “Copyright”")', { timeout: 3000 }).catch(() => fail(t('layer: putting the words back was not said')));
      if ((await page.evaluate((b) => window.__wgLive.templates[b], block)).includes('Acme Bakery')) fail(t('layer: Put back did not put the words back'));
      // Saved again, and marked: the edit says its reach, and while the layer holds it as in the site, no Put back.
      await page.getByRole('radio', { name: 'Layers' }).click();
      await openTray();
      await rowOf('Acme Bakery').getByRole('button', { name: /^Make it real/ }).click();
      await rowOf('Acme Bakery').getByRole('button', { name: /^Look in its template/ }).click();
      await save.waitFor({ timeout: 3000 }).catch(() => fail(t('layer: the template was not found again after it was put back')));
      await save.click();
      await stateIs('Acme Bakery', 'implemented', 'a template save did not mark the edit implemented');
      await asPlatform('drupal');
      await rowSays('Acme Bakery', 'For every page that uses block--copyright.html.twig: its words were saved to that template, line 2', 'an edit saved to a template does not say its reach');
      if ((await undo.innerText()) !== 'Nothing to undo: the newest edit is in the site' || !(await undo.isDisabled())) fail(t(`layer: with the newest edit in the site Undo says "${await undo.innerText()}"`));
      await layerShot('layer-template-saved', '.live-tray-edit[data-state="implemented"]');
      await notesTab();
      const held = page.locator('.live-edits li', { hasText: 'Acme Bakery' }).first();
      if (!(await held.innerText()).includes('In the design layer as in the site, which it never takes back: put back by hand')) fail(t(`layer: Saved by hand does not say the layer holds the words (${await held.innerText()})`));
      if (await held.getByRole('button', { name: 'Put back' }).count()) fail(t('layer: words the layer holds as in the site can be put back'));
      await layerShot('layer-put-back-held', '.live-edits');
      await page.getByRole('radio', { name: 'Layers' }).click();
      await openTray();

      // A style made real goes to an agent as intent: why, and the note to an agent carries the style; no session.
      await rowOf('color').getByRole('button', { name: /^Make it real/ }).click();
      await page.waitForSelector('.live-tray-edit:has-text("color") .live-tray-answer:has-text("A style goes into the theme’s CSS")', { timeout: 3000 })
        .catch(() => fail(t('layer: a style made real did not say it goes to an agent')));
      if ((await stateOf('color')) !== 'draft') fail(t('layer: a style sent to an agent changed state'));
      await layerShot('layer-agent', '.live-tray-answer');
      await rowOf('color').getByRole('button', { name: 'Add to notes' }).click();
      await page.waitForSelector('.toast:has-text("Added to the notes")', { timeout: 3000 }).catch(() => fail(t('layer: the note to an agent was not kept')));
      await notesTab();
      const kept = await page.locator('.live-notes li').first().innerText().catch(() => '');
      if (!kept.includes('color #c0392b')) fail(t(`layer: the note to an agent does not carry the style (${kept.replace(/\s+/g, ' ')})`));
      await page.getByRole('button', { name: 'Remove note 1' }).click();
      await page.getByRole('radio', { name: 'Layers' }).click();
      await openTray();

      // An orphaned edit says why, and can only be discarded; it is never shown on what is there now.
      await page.evaluate(() => { const l = window.__wgLive.layer; const e = l.edits.find((x) => x.scope === 'kind'); e.state = 'orphaned'; l.why[e.id] = 'Its element shows other words now.'; });
      await page.getByRole('button', { name: /^Reload/ }).first().click();
      await page.waitForSelector('.live-tray-edit[data-state="orphaned"] .live-tray-why:has-text("Orphaned: Its element shows other words now.")', { timeout: 4000 })
        .catch(() => fail(t('layer: an orphaned edit does not say why')));
      if (await rowOf('font-size').getByRole('button', { name: /^Make it real/ }).count()) fail(t('layer: an orphaned edit can be made real'));
      if (!(await rowOf('font-size').getByRole('button', { name: /^Discard/ }).count())) fail(t('layer: an orphaned edit cannot be discarded'));
      await layerShot('layer-orphaned', '.live-tray-edit[data-state="orphaned"]');

      // The page without the layer, said in the status line, and back.
      n = await mark();
      const off = page.getByRole('button', { name: 'Show the page without the layer' });
      await off.click();
      await page.waitForSelector('.live-status:has-text("Showing the page without the design layer")', { timeout: 3000 }).catch(() => fail(t('layer: the page without the layer is not said')));
      if (!(await since(n)).includes('layerShow false')) fail(t('layer: the page was not asked to show itself without the layer'));
      if ((await off.getAttribute('aria-pressed')) !== 'true') fail(t('layer: the switch is not shown as on'));
      await page.locator('.live-side').evaluate((el) => { el.scrollTop = 0; });
      await layerShot('layer-off');
      n = await mark();
      await page.locator('.live-status button', { hasText: 'Show the layer' }).click();
      await page.waitForSelector('.live-status:has-text("Showing the page without the design layer")', { state: 'detached', timeout: 3000 }).catch(() => fail(t('layer: Show the layer did not bring it back')));
      if (!(await since(n)).includes('layerShow true')) fail(t('layer: the page was not asked to show the layer again'));

      // Retiring a verified edit archives it: out of the tray. Escape closes the tray, and the panel shows the part
      // chosen before it opened: the tray never hides the layers or the Inspector for good.
      await rowOf('Fresh loaves').getByRole('button', { name: /^Retire/ }).click();
      await page.waitForSelector('.toast:has-text("Retired “Body (field)”")', { timeout: 3000 }).catch(() => fail(t('layer: retiring did not say so')));
      await rowsAre(4, 'retire');
      await closeTray();
      if ((await page.locator('.live-inspector .live-side-title').innerText().catch(() => '')) !== 'Copyright') fail(t('layer: closing the tray did not bring back the part chosen'));
      // Opened from the page's key too, as the Library is.
      await nobody();
      await page.waitForFunction(() => typeof window.__wgLive.press === 'function', null, { timeout: 3000 }).catch(() => fail(t('layer: the view is not waiting for its keys from the page')));
      await page.evaluate(() => window.__wgLive.press('edits'));
      await page.waitForSelector('.live-tray', { timeout: 3000 }).catch(() => fail(t('layer: ⇧E in the page did not open the tray')));
      await page.getByRole('button', { name: 'Close the edits (⇧E)' }).click();
    }

    // ── The component library: from the bar's key, listed by kind and searched, pictured a few at a time, an entry's
    // details (its pictures, props, slots, files, where this page uses it), placing one through the palette, and why
    // what cannot be placed cannot. Then taking parts out: content at once with Undo, shared configuration asked first.
    {
      const calls = () => page.evaluate(() => window.__wgLive.calls.slice());
      const said = () => page.locator('[aria-live="polite"].visually-hidden').innerText().catch(() => '');
      const nobody = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => { document.activeElement?.blur(); done(); }))));
      const row = (id) => page.locator(`.live-library-entry[data-entry="${id}"]`);
      const openEntry = async (id) => {
        await row(id).locator('.live-library-open').click();
        await page.waitForSelector('.live-library-detail', { timeout: 3000 }).catch(() => fail(t(`library: ${id} did not open its details`)));
      };
      const backToList = () => page.getByRole('button', { name: 'Back to the library' }).click();
      await page.locator('.toast .toast-x').click().catch(() => {});
      await page.getByRole('radio', { name: 'Layers' }).click();
      if (await page.$('.live-inspector')) await page.getByRole('button', { name: 'Back to the layers' }).click();
      await nobody();
      await page.keyboard.press('Shift+B');
      await page.waitForSelector('.live-library-entry', { timeout: 4000 }).catch(() => fail(t('library: ⇧B did not open the library')));
      if ((await page.getAttribute('.live-bar-tools button[aria-keyshortcuts="Shift+B"]', 'aria-pressed')) !== 'true') fail(t('library: the bar’s Library is not shown as on'));
      if (!(await page.evaluate(() => document.activeElement?.closest('.live-library-search') !== null))) fail(t('library: opening it did not put the keyboard in its search'));
      const heads = await page.$$eval('.live-library-group .live-section-title', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
      if (heads.join() !== 'Components 3,Blocks 5') fail(t(`library: the kinds read ${heads.join(' | ')}`));
      if ((await page.$$('.live-library-entry')).length !== 8) fail(t(`library: ${(await page.$$('.live-library-entry')).length} entries listed, not 8`));
      const lede = await page.locator('.live-library-list > p').first().innerText();
      if (!/What this Drupal site can place, as its core lists it: 3 components, 5 blocks\. Pictured in the acme theme\./.test(lede)) fail(t(`library: it opens with "${lede}"`));
      if (!(await page.locator('.live-library-group[aria-label="Components"]').innerText()).includes('Drupal core places a component only inside a template or a field that uses it, not on its own.')) fail(t('library: a component Drupal cannot place does not say why'));
      // Pictures: of the entries in view, both widths, never more entries at once than the main process takes.
      await page.waitForSelector('.live-library-entry[data-entry="sdc:acme:hero"] .live-library-thumb img', { timeout: 6000 }).catch(() => fail(t('library: Hero’s picture never showed')));
      const asks = await page.evaluate(() => window.__wgLive.pictureAsks);
      if (!asks.length || asks.some((a) => a.length > 24)) fail(t(`library: pictures were asked for as ${JSON.stringify(asks)}`));
      if (asks.flat().some((id) => id === 'sdc:northwind:badge' || id === 'block:northstar_pay_button')) fail(t('library: an entry with no picture was asked to be pictured'));
      await page.waitForTimeout(400);
      await shot('library');

      // Search: every word, across names, providers and categories.
      await page.locator('.live-library-search input').fill('newsletter');
      const found = await page.$$eval('.live-library-entry', (els) => els.map((e) => e.getAttribute('data-entry')));
      if (found.join() !== 'block:acme_newsletter_block') fail(t(`library: searching "newsletter" lists ${found.join(', ')}`));
      await page.waitForSelector('.live-library [role="status"]:has-text("1 entry matches")', { timeout: 2000 }).catch(() => fail(t('library: the search did not say how many match')));
      await page.locator('.live-library-search input').fill('northwind ui');
      if ((await page.$$('.live-library-entry')).length !== 2) fail(t('library: searching "northwind ui" did not find both of its entries'));
      await shot('library-search');
      await page.locator('.live-library-search input').fill('');

      // One entry: its pictures side by side, its props and slots, why it cannot be placed, and where this page uses it.
      await openEntry('sdc:acme:hero');
      await page.waitForSelector('.live-library-detail img[alt="Hero, rendered alone 1440 pixels wide"]', { timeout: 5000 }).catch(() => fail(t('library: Hero’s desktop picture is not in its details')));
      await page.waitForSelector('.live-library-detail img[alt="Hero, rendered alone 390 pixels wide"]', { timeout: 5000 }).catch(() => fail(t('library: Hero’s phone picture is not in its details')));
      const detail = (await page.locator('.live-library-detail').innerText()).replace(/\s+/g, ' ');
      for (const want of ['Component · acme · your code', 'heading *', 'string', 'Default “left”', 'One of “left”, “center”', 'media', 'A picture or a video beside the words.',
        'Drupal core places a component only inside a template or a field that uses it, not on its own.', 'The page shown, as its trace names its parts.', 'hero.twig', 'sdc:acme:hero', 'Rendered alone by the site with its own example, in the acme theme.']) {
        if (!detail.includes(want)) fail(t(`library: Hero’s details do not say "${want}"`));
      }
      const uses = await page.$$eval('.live-library-use', (els) => els.map((e) => e.textContent));
      if (uses.join() !== 'Hero') fail(t(`library: Hero is used on this page as ${JSON.stringify(uses)}`));
      await shot('library-entry');

      // Where the rest of the site uses it: the helper's search, grouped and counted, with what it cannot see.
      await page.waitForSelector('.live-library-site .live-library-place', { timeout: 3000 }).catch(() => fail(t('usage: Hero’s places across the site never showed')));
      if (!(await calls()).includes('usage sdc:acme:hero')) fail(t('usage: opening Hero did not ask where it is used'));
      const site = (await page.locator('.live-library-site').innerText()).replace(/\s+/g, ' ');
      if ((await page.locator('.live-library-site .live-section-title').textContent()) !== 'Across the site') fail(t('usage: the section is not called Across the site'));
      for (const want of ['Used in 3 places across the site.', 'Templates 3', 'node--article--full.html.twig', 'line 12, include; line 30, include · theme hook page__front, in acme',
        'Event teaser component (acme:event-teaser)', 'web/themes/custom/acme/components/event-teaser/event-teaser.twig', 'None of these has a page that is sure to show it.',
        'What this search cannot see', 'render array of #type component', 'chosen at render time, so any of them may use it: web/themes/custom/acme/templates/field--paragraph.html.twig', 'What it searched']) {
        if (!site.includes(want)) fail(t(`usage: Hero across the site does not say "${want}" (${site.slice(0, 300)})`));
      }
      if (await page.$('.live-library-site .live-library-place-open')) fail(t('usage: a template, which no one page is sure to show, offers to open a page'));
      await page.locator('.live-library-site').scrollIntoViewIfNeeded();
      await shot('library-usage');
      await page.locator('.live-library-detail').evaluate((el) => el.closest('.live-side').scrollTop = 10_000);
      await shot('library-entry-more');
      await page.locator('.live-library-shot-open').first().click();
      await page.waitForSelector('.dialog .live-library-large img', { timeout: 3000 }).catch(() => fail(t('library: a picture did not open larger')));
      await page.keyboard.press('Escape');
      // Choosing where it is used chooses that part of the page.
      await page.locator('.live-library-use', { hasText: 'Hero' }).click();
      await page.waitForFunction(() => document.querySelector('.live-inspector .live-side-title')?.textContent === 'Hero', null, { timeout: 3000 }).catch(() => fail(t('library: choosing where it is used did not choose the part')));
      if (await page.$('.live-library')) fail(t('library: it stayed open over the chosen part'));
      await page.getByRole('button', { name: 'Back to the layers' }).click();

      // No picture, and why; a picture that failed, and why; files open in the Code tab when they are in the project.
      await page.getByRole('button', { name: /^Library/ }).click();
      await page.waitForSelector('.live-library-entry', { timeout: 4000 });
      await openEntry('block:northwind_hours_block');
      await page.waitForSelector('.live-library-shot-why:has-text("The piece did not say it was drawn within 25 seconds.")', { timeout: 4000 }).catch(() => fail(t('library: a picture that failed does not say why')));
      await backToList();
      await openEntry('block:northstar_pay_button');
      const pay = (await page.locator('.live-library-detail').innerText()).replace(/\s+/g, ' ');
      if (!pay.includes('No picture. It shows the order of the page it is placed on, so it has nothing to show alone.')) fail(t('library: an entry with no picture does not say why'));
      if (!pay.includes('Takes from the page entity:commerce_order')) fail(t('library: what it takes from the page is not said'));
      if (!pay.includes('Nothing on this page takes it')) fail(t('library: a block no place here takes does not say so'));
      await page.waitForSelector('.live-library-files button.live-file-open', { timeout: 4000 }).catch(() => fail(t('library: none of its files opens')));
      const opens = await page.$$eval('.live-library-files button.live-file-open', (els) => els.map((e) => e.textContent));
      if (opens.join() !== 'web/modules/custom/northstar_checkout/templates/northstar-pay-button.html.twig,web/modules/custom/northstar_checkout/css/pay-button.css') fail(t(`library: the files that open are ${opens.join(', ')}`));
      if (!(await page.locator('.live-library-files').innerText()).includes('Not in the folder this project’s site serves')) fail(t('library: a file not in the project does not say so'));
      await shot('library-no-picture');
      await backToList();

      // A block placed, in a default layout and in one item's own layout: each opens its page, or the site's own
      // page for changing it, in the view; asking again goes to the site again.
      await openEntry('block:acme_cta_block');
      await page.waitForSelector('.live-library-site .live-library-place', { timeout: 3000 }).catch(() => fail(t('usage: the call to action’s places never showed')));
      const groupsSaid = await page.$$eval('.live-library-site .live-library-usehead', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
      if (groupsSaid.join() !== 'Block placements 2,Default layouts 1,Layouts of single items 1') fail(t(`usage: the call to action’s places are grouped as ${groupsSaid.join(' | ')}`));
      const placed = (await page.locator('.live-library-site').innerText()).replace(/\s+/g, ' ');
      for (const want of ['Used in 4 places across the site.', 'Sidebar region, Acme theme · no visibility conditions: any page in this theme', 'shows only where its visibility conditions allow (request_path)',
        'every Event shown this way without a layout of its own; the page opened is Spring open house', 'section 2 (Two columns), second region', 'visibility conditions']) {
        if (!placed.includes(want)) fail(t(`usage: the call to action across the site does not say "${want}"`));
      }
      const openable = await page.$$eval('.live-library-site .live-library-place-open', (els) => els.map((e) => e.textContent));
      if (openable.join() !== 'Call to action,Event (Default),About us (Basic page)') fail(t(`usage: the places that open a page are ${openable.join(', ')}`));
      let sent = (await calls()).length;
      await page.locator('.live-library-site .live-library-place-open', { hasText: 'About us (Basic page)' }).click();
      await page.waitForFunction((k) => window.__wgLive.calls.slice(k).includes('go https://acme.example.test/about'), sent, { timeout: 3000 }).catch(() => fail(t('usage: a place did not open its page in the view')));
      sent = (await calls()).length;
      await page.getByRole('button', { name: 'Call to action, events: open the site’s own page for changing it' }).click();
      await page.waitForFunction((k) => window.__wgLive.calls.slice(k).includes('go https://acme.example.test/admin/structure/block/manage/acme_cta_events'), sent, { timeout: 3000 })
        .catch(() => fail(t('usage: Change it did not open the placement’s own page in the view')));
      await page.locator('.live-library-site').scrollIntoViewIfNeeded();
      await shot('library-usage-block');
      await page.getByRole('button', { name: 'Search the site again' }).click();
      await page.waitForFunction(() => window.__wgLive.calls.includes('usage block:acme_cta_block refresh'), null, { timeout: 3000 }).catch(() => fail(t('usage: Search again did not ask the site afresh')));
      await backToList();

      // A search that did not finish says so, and says it of its count.
      await openEntry('block:acme_newsletter_block');
      await page.waitForSelector('.live-library-site .live-library-gaps', { timeout: 3000 }).catch(() => fail(t('usage: a search that stopped does not say so')));
      const stopped = (await page.locator('.live-library-site').innerText()).replace(/\s+/g, ' ');
      if (!stopped.includes('Used in 1 place it reached across the site.') || !stopped.includes('The search stopped after 10 seconds')) fail(t(`usage: a search that stopped reads "${stopped.slice(0, 200)}"`));
      await backToList();

      // Placing: Place, then the page shows where it can go; the drop is saved through the palette's insert.
      await row('block:system_branding_block').waitFor();
      if (!(await row('block:system_branding_block').innerText()).includes('Not placeable here')) fail(t('library: a block nothing here takes is not said to be unplaceable'));
      await row('block:acme_cta_block').getByRole('button', { name: /^Place Call to action/ }).click();
      await page.waitForSelector('.live-status:has-text("Placing Call to action")', { timeout: 3000 }).catch(() => fail(t('library: Place did not say it is placing')));
      await page.waitForFunction(() => window.__wgLive.spec?.placing?.entry === 'pal.b.acme_cta_block', null, { timeout: 3000 }).catch(() => fail(t('library: the page was not told what to place')));
      await shot('library-placing');
      await page.evaluate(() => window.__wgLive.drop({ kind: 'insert', insert: { collection: 'c-sidebar', entry: 'pal.b.acme_cta_block', index: 1 } }));
      await page.waitForSelector('.dialog:has-text("every page that shows this region (41 pages)")', { timeout: 3000 }).catch(() => fail(t('library: adding into shared configuration did not ask first')));
      await page.locator('.dialog button', { hasText: 'Add it' }).click();
      await page.waitForSelector('.toast-info:has-text("Added Call to action")', { timeout: 3000 }).catch(() => fail(t('library: adding did not say so')));
      const inserted = (await calls()).filter((c) => c.startsWith('insert ')).map((c) => JSON.parse(c.slice(7))).pop();
      if (inserted?.collection !== 'c-sidebar' || inserted.entry !== 'pal.b.acme_cta_block' || inserted.index !== 1) fail(t(`library: the insert saved was ${JSON.stringify(inserted)}, not the palette's into the sidebar`));
      await page.locator('.toast .toast-x').click().catch(() => {});

      // A WordPress library: block types, a pattern and a block style; a style is not placed.
      await page.evaluate(() => { window.__wgLive.libraryAnswer = { state: 'ok', library: window.__wgLive.wpLibrary }; });
      if (!(await page.$('.live-library'))) await page.getByRole('button', { name: /^Library/ }).click();
      await page.getByRole('button', { name: 'Ask the site again' }).click();
      await page.waitForFunction(() => [...document.querySelectorAll('.live-library-group .live-section-title')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()).join() === 'Blocks 2,Patterns 1,Block styles 1', null, { timeout: 4000 })
        .catch(async () => fail(t(`library: a WordPress library reads ${(await page.$$eval('.live-library-group .live-section-title', (els) => els.map((e) => e.textContent))).join(' | ')}`)));
      await openEntry('style:core/button:outline');
      if (!(await page.locator('.live-library-detail').innerText()).includes('A block style is how a block looks')) fail(t('library: a block style does not say it is not placed'));
      await backToList();
      await shot('library-wordpress');
      // A WordPress block in posts, a synced pattern, and through that pattern in a page and a template part.
      await openEntry('block:northwind/testimonial');
      await page.waitForSelector('.live-library-site .live-library-place', { timeout: 3000 }).catch(() => fail(t('usage: the testimonial’s places never showed')));
      const wpGroups = await page.$$eval('.live-library-site .live-library-usehead', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
      if (wpGroups.join() !== 'Content 3,Template parts 1,Synced patterns 1') fail(t(`usage: the testimonial’s places are grouped as ${wpGroups.join(' | ')}`));
      const wp = (await page.locator('.live-library-site').innerText()).replace(/\s+/g, ' ');
      for (const want of ['Used in 5 places across the site.', 'core/block · through the synced pattern “Kind words” · Page', 'Post; draft', '×2', 'wp-content/themes/northwind/parts/footer.html', 'Block Hooks']) {
        if (!wp.includes(want)) fail(t(`usage: the testimonial across the site does not say "${want}"`));
      }
      sent = (await calls()).length;
      await page.locator('.live-library-site .live-library-place-open', { hasText: 'Home' }).click();
      await page.waitForFunction((k) => window.__wgLive.calls.slice(k).includes('go https://acme.example.test/'), sent, { timeout: 3000 }).catch(() => fail(t('usage: a page reached through a synced pattern did not open')));
      await page.locator('.live-library-site').scrollIntoViewIfNeeded();
      await shot('library-usage-wordpress');
      await backToList();
      // A helper without the search says to update it, in the main process's words.
      await openEntry('block:core/paragraph');
      await page.waitForSelector('.live-library-site .live-library-why', { timeout: 3000 }).catch(() => fail(t('usage: an outdated helper does not say why there is no search')));
      if (!(await page.locator('.live-library-site').innerText()).includes('The site helper is older than this Wanigan and cannot say where an entry is used. Update it from the project’s Live tab.')) fail(t('usage: an outdated helper is not said in the main process’s words'));
      await backToList();
      await page.evaluate(() => { window.__wgLive.libraryAnswer = null; });
      await page.getByRole('button', { name: 'Close the library (⇧B)' }).click();
      if (await page.$('.live-library')) fail(t('library: Close did not close it'));

      // Taking out a content item: saved at once, said, with Undo.
      const before = (await calls()).length;
      await page.locator('.live-layer', { hasText: 'Quote paragraph' }).first().click();
      await page.locator('.live-inspector .live-side-title').focus();
      await page.keyboard.press('Shift+X');
      await page.waitForSelector('.toast-info:has-text("Took Quote paragraph out of Paragraphs on Article 12")', { timeout: 3000 }).catch(() => fail(t('take out: a content item was not taken out at once')));
      if (await page.$('.dialog')) fail(t('take out: a content item asked first'));
      if (!(await calls()).slice(before).includes('remove {"collection":"c-paras","item":"p-para-1"}')) fail(t('take out: the removal was not posted'));
      await page.waitForSelector('.live-status-said:has-text("Quote paragraph: taken out.")', { timeout: 4000 })
        .catch(async () => fail(t(`take out: the read-back was not said (${await page.locator('.live-status-said').first().innerText().catch(() => '')})`)));
      if (!/Took Quote paragraph out/.test(await said())) fail(t('take out: it was not said aloud'));
      await shot('take-out-saved');
      await page.locator('.toast-info:has-text("Took Quote paragraph") button', { hasText: 'Undo' }).click();
      await page.waitForFunction(() => window.__wgLive.calls.includes('undo u-3'), null, { timeout: 3000 }).catch(() => fail(t('take out: Undo did not ask the site')));

      // Taking out a shared placement: asked first, with where it shows; Cancel saves nothing.
      await page.getByRole('button', { name: 'Back to the layers' }).click();
      await page.locator('.live-layer', { hasText: 'Search' }).first().click();
      const mark = (await calls()).length;
      await page.locator('.live-verbs button', { hasText: 'Take out' }).click();
      await page.waitForSelector('.dialog:has-text("This takes the block off every page that shows this region (41 pages).")', { timeout: 3000 }).catch(() => fail(t('take out: a shared placement did not ask first with its reach')));
      const asked = await page.locator('.dialog').innerText().catch(() => '');
      if (!asked.includes('The placement is switched off, not deleted')) fail(t('take out: the question does not say what stays'));
      await shot('take-out-confirm');
      await page.locator('.dialog button', { hasText: 'Cancel' }).click();
      await page.waitForSelector('.dialog', { state: 'detached', timeout: 2000 }).catch(() => fail(t('take out: Cancel did not close the question')));
      if ((await calls()).slice(mark).some((c) => c.startsWith('remove '))) fail(t('take out: Cancel saved the removal anyway'));
      if (!/Not taken out\. Search stays where it is\./.test(await said())) fail(t('take out: Cancel was not said'));

      // A place nothing can be taken out of says why; a helper that says nothing about it says to update it.
      await page.getByRole('button', { name: 'Back to the layers' }).click();
      await page.locator('.live-layer', { hasText: 'Acme branding' }).first().click();
      await page.locator('.live-verbs button', { hasText: 'Take out' }).click();
      await page.waitForSelector('.live-out-why:has-text("may not administer blocks")', { timeout: 2000 }).catch(() => fail(t('take out: a place with a reason did not say it')));
      await shot('take-out-why');
      await page.evaluate(() => {
        const t0 = window.__wgLive.answer.trace;
        window.__wgLive.answer = { state: 'ok', trace: { ...t0, collections: t0.collections.map(({ removes, removeWhy, shows, ...c }) => c) } };
      });
      let traced = (await calls()).length;
      await page.getByRole('button', { name: /^Reload/ }).first().click();
      await page.waitForFunction((k) => window.__wgLive.calls.slice(k).includes('trace'), traced, { timeout: 3000 }).catch(() => fail(t('take out: the reload was not traced')));
      await page.waitForTimeout(150);
      await page.getByRole('button', { name: 'Back to the layers' }).click().catch(() => {});
      await page.locator('.live-layer', { hasText: 'Search' }).first().click();
      await page.locator('.live-verbs button', { hasText: 'Take out' }).click();
      await page.waitForSelector('.live-out-why:has-text("Update the helper from the Live tab")', { timeout: 3000 }).catch(() => fail(t('take out: an older helper did not say to update it')));
      if (!(await page.$('.live-out-why button:has-text("Update the helper…")'))) fail(t('take out: no way to update the helper from there'));
      await page.evaluate((tr) => { window.__wgLive.answer = { state: 'ok', trace: tr }; }, liveFixture.trace);
      await page.getByRole('button', { name: 'Back to the layers' }).click();
      traced = (await calls()).length;
      await page.getByRole('button', { name: /^Reload/ }).first().click();
      await page.waitForFunction((k) => window.__wgLive.calls.slice(k).includes('trace'), traced, { timeout: 3000 }).catch(() => fail(t('take out: the reload was not traced')));

      // Last, as it opens the code editor: a file of the entry opens there.
      await page.getByRole('button', { name: /^Library/ }).click();
      await page.waitForSelector('.live-library-entry', { timeout: 4000 });
      await openEntry('block:northstar_pay_button');
      await page.locator('.live-library-files button.live-file-open').first().click();
      await page.waitForFunction(() => document.querySelector('.editor-tab.active .editor-tab-name')?.textContent === 'northstar-pay-button.html.twig', null, { timeout: 8000 })
        .catch(() => fail(t('library: its file did not open in the code editor')));
      await page.keyboard.press('Meta+j');
      await page.waitForSelector('.editor-drawer:not([hidden])', { state: 'detached', timeout: 3000 }).catch(() => {});
      await page.getByRole('button', { name: 'Back to the library' }).click().catch(() => {});
      await page.getByRole('button', { name: 'Close the library (⇧B)' }).click().catch(() => {});
    }

    // States without a trace, each said plainly with the next step.
    await page.evaluate(() => { window.__wgLive.answer = { state: 'expired' }; });
    await page.getByRole('button', { name: /^Reload/ }).first().click();
    await dockTo(page, 'Request', (w) => fail(t(w)));
    await page.waitForSelector('.live-trace-note:has-text("This render’s trace is gone")', { timeout: 3000 }).catch(() => fail(t('states: an expired trace was not said')));
    await shot('state-expired');
    await page.evaluate(() => { window.__wgLive.answer = { state: 'down', error: 'connection refused' }; });
    await page.getByRole('button', { name: /^Reload/ }).first().click();
    await page.waitForSelector('.live-trace-note:has-text("The site did not answer")', { timeout: 3000 }).catch(() => fail(t('states: a site that did not answer was not said')));
    await shot('state-down');

    for (const e of errors) fail(t(e));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    if (overflow) fail(t('the page scrolls sideways'));
    await context.close();

    // An old helper: every place that needs the trace says to update it.
    const old = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, deviceScaleFactor: 2 });
    await old.addInitScript(BRIDGE);
    await old.addInitScript(`try { localStorage.setItem('wanigan.theme', '${theme}'); } catch {}`);
    await old.addInitScript(liveStub, liveFixture);
    await old.addInitScript(LIVE_DEFAULTS);
    await old.addInitScript(() => { window.__wgLive.outdated = true; window.__wgLive.answer = { state: 'missing' }; window.__wgLive.libraryAnswer = { state: 'outdated' }; });
    const p2 = await old.newPage();
    await p2.goto(`${base}#/p/NS/live`);
    await p2.waitForSelector('.live-tree', { timeout: 15_000 }).catch(() => fail(t('outdated: no layers')));
    await option(p2, 'Lens', 'Cache');
    await p2.waitForSelector('.live-lens:has-text("Update the helper to see this")', { timeout: 3000 }).catch(() => fail(t('outdated: the Cache lens did not say to update the helper')));
    await dockTo(p2, 'Request', (w) => fail(t(`outdated: ${w}`)));
    await p2.waitForSelector('.live-request, .live-trace-note:has-text("Update the helper to see this")', { timeout: 3000 }).catch(() => fail(t('outdated: the request did not say to update the helper')));
    await p2.screenshot({ path: join(out, `${theme}-state-outdated.png`), animations: 'disabled' });
    // The library says why there is none, in the main process's words, and offers the update.
    await p2.getByRole('button', { name: /^Library/ }).click();
    await p2.waitForSelector('.live-library-trouble:has-text("The site helper is older than this Wanigan and has no component library.")', { timeout: 3000 }).catch(() => fail(t('outdated: the library did not say the helper is too old')));
    if (!(await p2.$('.live-library-trouble button:has-text("Update the helper…")'))) fail(t('outdated: the library does not offer to update the helper'));
    await p2.screenshot({ path: join(out, `${theme}-library-outdated.png`), animations: 'disabled' });
    await old.close();

    // A helper another Wanigan set up: its own key refused (`other`), or none of this Wanigan's at all (`found` on disk).
    for (const [name, init] of [['other', () => { window.__wgLive.answer = { state: 'other' }; }], ['found', () => { window.__wgLive.found = true; }]]) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, deviceScaleFactor: 2 });
      await ctx.addInitScript(BRIDGE);
      await ctx.addInitScript(`try { localStorage.setItem('wanigan.theme', '${theme}'); } catch {}`);
      await ctx.addInitScript(liveStub, liveFixture);
      await ctx.addInitScript(LIVE_DEFAULTS);
      await ctx.addInitScript(init);
      const p3 = await ctx.newPage();
      await p3.goto(`${base}#/p/NS/live`);
      const note = p3.locator('.live-side .live-trace-note:not(.compact)').filter({ hasText: 'This site’s helper answers to another Wanigan' });
      await note.waitFor({ timeout: 8000 }).catch(() => fail(t(`${name}: the side panel did not say the helper answers to another Wanigan`)));
      if (!(await note.getByRole('button', { name: 'Set up the helper…' }).isVisible().catch(() => false))) fail(t(`${name}: the note did not offer setting it up again`));
      if (await p3.locator('.live-helper-offer').count()) fail(t(`${name}: the generic offer to set up a helper was shown beside the note`));
      await p3.screenshot({ path: join(out, `${theme}-state-${name}-wanigan.png`), animations: 'disabled' });
      await ctx.close();
    }

    // Drag handles switched off in the More menu: Place still arms the page for what is being placed.
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, deviceScaleFactor: 2 });
      await ctx.addInitScript(BRIDGE);
      await ctx.addInitScript(`try { localStorage.setItem('wanigan.theme', '${theme}'); localStorage.setItem('wanigan.live.arrange', '0'); } catch {}`);
      await ctx.addInitScript(liveStub, liveFixture);
      await ctx.addInitScript(LIVE_DEFAULTS);
      const p4 = await ctx.newPage();
      await p4.goto(`${base}#/p/NS/live`);
      await p4.waitForSelector('.live-tree', { timeout: 15_000 }).catch(() => fail(t('handles off: no layers')));
      await p4.keyboard.press('Shift+B');
      const cta = p4.locator('.live-library-entry[data-entry="block:acme_cta_block"]');
      await cta.waitFor({ timeout: 5000 }).catch(() => fail(t('handles off: the library did not open')));
      await cta.getByRole('button', { name: /^Place Call to action/ }).click();
      await p4.waitForFunction(() => window.__wgLive.spec?.placing?.entry === 'pal.b.acme_cta_block', null, { timeout: 3000 })
        .catch(() => fail(t('handles off: Place did not arm the page, so placing did nothing')));
      await ctx.close();
    }

    // Formatted text on a WordPress site (a string the schema calls HTML): words alone are edited as words and sent
    // escaped, never as markup; inline tags are shown as the HTML they are, with the tags WordPress keeps said.
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, deviceScaleFactor: 2 });
      await ctx.addInitScript(BRIDGE);
      await ctx.addInitScript(`try { localStorage.setItem('wanigan.theme', '${theme}'); } catch {}`);
      await ctx.addInitScript(liveStub, liveFixture);
      await ctx.addInitScript(LIVE_DEFAULTS);
      await ctx.addInitScript((tr) => { window.__wgLive.platform = 'wordpress'; window.__wgLive.answer = { state: 'ok', trace: tr }; }, richTrace(liveFixture.trace));
      const p5 = await ctx.newPage();
      const s5 = (name) => p5.screenshot({ path: join(out, `${theme}-${name}.png`), animations: 'disabled' });
      await p5.goto(`${base}#/p/NS/live`);
      await p5.waitForSelector('.live-tree', { timeout: 15_000 }).catch(() => fail(t('rich: no layers')));
      const openTarget = async (label) => {
        // From the layers, or from the part's details when it is still the chosen one after a save.
        const edit = p5.getByRole('button', { name: /^Edit Opening hours/ });
        if (!(await edit.isVisible().catch(() => false))) await p5.locator('.live-layer', { hasText: 'Opening hours' }).first().click();
        await edit.click();
        await p5.getByRole('menuitem', { name: new RegExp(`^${label}`) }).click();
        await p5.waitForSelector('.live-sheet form', { timeout: 3000 }).catch(() => fail(t(`rich: ${label} did not open its sheet`)));
      };
      await openTarget('Paragraph block in page “Hours”');
      const box = p5.getByLabel('Words', { exact: true });
      if ((await box.inputValue().catch(() => null)) !== 'Fish & chips on Fridays') fail(t(`rich: words alone were not shown as words (${await box.inputValue().catch(() => 'no box')})`));
      if (!(await p5.locator('.live-sheet').innerText()).includes('What you type is saved as words: an & or a < stays a character, never markup.')) fail(t('rich: the sheet does not say typed words are saved as words'));
      await box.fill('Fish & chips <b>every</b> Friday');
      await s5('edit-rich-words');
      await p5.locator('.live-sheet button[type="submit"]').click();
      await p5.waitForSelector('.toast-info:has-text("Saved Paragraph block")', { timeout: 3000 }).catch(() => fail(t('rich: saving the words did not say so')));
      const sent = await p5.evaluate(() => window.__wgLive.calls.find((c) => c.startsWith('editSave e-rich-words')));
      if (sent !== 'editSave e-rich-words {"content":"Fish &amp; chips &lt;b&gt;every&lt;/b&gt; Friday"}') fail(t(`rich: typed text went as ${sent}`));
      await p5.waitForSelector('.live-status-said:has-text("saved, and the site holds it after reloading")', { timeout: 4000 })
        .catch(async () => fail(t(`rich: the escaped words were not read back as held (${await p5.locator('.live-status-said').first().innerText().catch(() => 'no status line')})`)));

      await openTarget('Paragraph block with a link in page “Hours”');
      const html = p5.getByLabel('Words (HTML)', { exact: true });
      if ((await html.inputValue().catch(() => null)) !== 'Ask about <a href="/cakes">cakes</a> &amp; <strong>pies</strong>') fail(t('rich: inline tags were not shown as the HTML they are'));
      const said = await p5.locator('.live-sheet').innerText();
      for (const want of ['Only these inline tags are kept: <strong> <em> <a>', 'WordPress refuses any other tag']) if (!said.includes(want)) fail(t(`rich: the HTML sheet does not say "${want}"`));
      await s5('edit-rich-markup');
      await p5.keyboard.press('Escape');
      await p5.waitForSelector('.live-sheet', { state: 'detached', timeout: 3000 }).catch(() => fail(t('rich: Escape did not close the sheet')));
      if ((await p5.evaluate(() => window.__wgLive.calls.filter((c) => c.startsWith('editSave')).length)) !== 1) fail(t('rich: closing the HTML sheet saved something'));

      // Something shown beyond this page: the Edit menu and the sheet say so, and Save asks first; Back saves nothing.
      await p5.getByRole('button', { name: /^Edit Opening hours/ }).click();
      const item = p5.getByRole('menuitem', { name: /^Paragraph block in the template part “Footer”/ });
      if (!(await item.innerText().catch(() => '')).includes('shows beyond this page')) fail(t('reach: the Edit menu does not say the target shows beyond this page'));
      await item.click();
      await p5.waitForSelector('.live-sheet form', { timeout: 3000 }).catch(() => fail(t('reach: the sheet did not open')));
      if (!(await p5.locator('.live-sheet-reach').innerText().catch(() => '')).includes('Saving it changes every page that uses the template part “Footer”, not only this page.')) fail(t('reach: the sheet does not say where the save shows'));
      const saves = () => p5.evaluate(() => window.__wgLive.calls.filter((c) => c.startsWith('editSave')).length);
      await p5.getByLabel('Words', { exact: true }).fill('Open every day');
      await p5.locator('.live-sheet button[type="submit"]').click();
      const ask = p5.locator('.live-sheet-foot.ask');
      await ask.waitFor({ timeout: 3000 }).catch(() => fail(t('reach: Save did not ask first')));
      if (!(await ask.innerText()).includes('This changes it wherever it shows (every page that uses the template part “Footer”), not only on this page. Save it there?')) fail(t(`reach: the question reads "${await ask.innerText()}"`));
      if ((await p5.evaluate(() => document.activeElement?.textContent ?? '')) !== 'Save wherever it shows') fail(t('reach: the question did not take the focus to its answer'));
      if ((await saves()) !== 1) fail(t('reach: something was saved before the owner said yes'));
      await s5('edit-reach-ask');
      await ask.getByRole('button', { name: 'Back' }).click();
      if ((await saves()) !== 1 || !(await p5.locator('.live-sheet form').isVisible())) fail(t('reach: Back saved, or closed the sheet'));
      await p5.locator('.live-sheet button[type="submit"]').click();
      await p5.getByRole('button', { name: 'Save wherever it shows' }).click();
      await p5.waitForSelector('.toast-info:has-text("Saved Paragraph block in the template part")', { timeout: 3000 }).catch(() => fail(t('reach: the yes did not save')));
      const shared = await p5.evaluate(() => window.__wgLive.calls.find((c) => c.startsWith('editSave e-rich-shared')));
      if (shared !== 'editSave e-rich-shared {"content":"Open every day"}') fail(t(`reach: saved ${shared}`));
      await ctx.close();
    }

    // The dock is kept on this Mac: what it shows, its side and that it is open come back after the window reloads.
    // Elsewhere in the project, a tab only the live view has is not shown: the dock steps aside, and comes back with it.
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, deviceScaleFactor: 2 });
      await ctx.addInitScript(BRIDGE);
      await ctx.addInitScript(`try { localStorage.setItem('wanigan.theme', '${theme}'); } catch {}`);
      await ctx.addInitScript(liveStub, liveFixture);
      await ctx.addInitScript(LIVE_DEFAULTS);
      const p5 = await ctx.newPage();
      await p5.goto(`${base}#/p/NS/live`);
      await p5.waitForSelector('.live-tree', { timeout: 15_000 }).catch(() => fail(t('dock kept: no layers')));
      await dockTo(p5, 'Problems', (w) => fail(t(`dock kept: ${w}`)));
      await p5.click('.editor-actions button[aria-label="Put the dock beside the view"]');
      await p5.waitForSelector('.editor-drawer[data-dock="right"]:not([hidden])', { timeout: 3000 }).catch(() => fail(t('dock kept: the dock did not go beside the page')));
      await p5.waitForTimeout(200);
      await p5.screenshot({ path: join(out, `${theme}-layout-dock-beside.png`), animations: 'disabled' });
      await p5.reload();
      await p5.waitForSelector('.live-tree', { timeout: 15_000 }).catch(() => fail(t('dock kept: no layers after the reload')));
      await p5.waitForSelector('.editor-drawer[data-dock="right"]:not([hidden]) .live-docked[data-tab="problems"]', { timeout: 5000 })
        .catch(() => fail(t('dock kept: after a reload the dock is not open beside the page on Problems')));
      await p5.goto(`${base}#/p/NS/board`);
      await p5.waitForSelector('.card', { timeout: 8000 }).catch(() => fail(t('dock kept: no board')));
      if (await p5.$('.editor-drawer:not([hidden])')) fail(t('dock kept: the live view’s Problems showed on the board'));
      await p5.goto(`${base}#/p/NS/live`);
      await p5.waitForSelector('.editor-drawer:not([hidden]) .live-docked[data-tab="problems"]', { timeout: 8000 })
        .catch(() => fail(t('dock kept: back in the live view the dock did not come back on Problems')));
      await ctx.close();
    }

    // The bar fits whatever width the page gets: at three window widths, with the dock open beside and beneath it, no
    // control of the live view's bar or the project's tab bar is drawn over another or cut off (scripts/ui-fit.mjs
    // measures what is drawn, labels and keys included).
    for (const width of [1280, 1440, 1920]) {
      for (const side of ['right', 'bottom']) {
        const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, deviceScaleFactor: 2 });
        await ctx.addInitScript(BRIDGE);
        await ctx.addInitScript(`try { localStorage.setItem('wanigan.theme', '${theme}'); localStorage.setItem('wanigan.editor.prefs', '${JSON.stringify({ dock: side, open: true, shows: 'notes' })}'); } catch {}`);
        await ctx.addInitScript(liveStub, liveFixture);
        await ctx.addInitScript(LIVE_DEFAULTS);
        const p6 = await ctx.newPage();
        const at = `fit ${width} px, the dock ${side === 'right' ? 'beside' : 'beneath'}`;
        await p6.goto(`${base}#/p/NS/live`);
        await p6.waitForSelector('.live-tree', { timeout: 15_000 }).catch(() => fail(t(`${at}: no layers`)));
        await p6.waitForSelector(`.editor-drawer[data-dock="${side}"]:not([hidden]) .live-docked[data-tab="notes"]`, { timeout: 5000 }).catch(() => fail(t(`${at}: the dock is not open`)));
        await p6.waitForTimeout(200);
        for (const problem of await p6.evaluate(fitProblems)) fail(t(`${at}: ${problem}`));
        await p6.screenshot({ path: join(out, `${theme}-fit-${width}-${side}.png`), animations: 'disabled' });
        await ctx.close();
      }
    }
  }

  // On Windows and Linux the page's DevTools is Chrome's chord there, Ctrl+Shift+I: the control, the tab, the sheet and
  // the key itself say and do that, and the Mac's ⌥⌘I does nothing.
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', deviceScaleFactor: 2 });
    await ctx.addInitScript(BRIDGE);
    await ctx.addInitScript('window.wanigan.platform = "win32"; try { localStorage.setItem("wanigan.theme", "dark"); } catch {}');
    await ctx.addInitScript(liveStub, liveFixture);
    await ctx.addInitScript(LIVE_DEFAULTS);
    const pw = await ctx.newPage();
    const w = (what) => `windows/${what}`;
    await pw.goto(`${base}#/p/NS/live`);
    await pw.waitForSelector('.live-tree', { timeout: 15_000 }).catch(() => fail(w('no layers')));
    const control = pw.locator('.live-bar-tools button[aria-keyshortcuts="Control+Shift+I"]');
    if ((await control.getAttribute('aria-label').catch(() => null)) !== 'DevTools (Ctrl+Shift+I)') fail(w('devtools: the bar’s control is not named with Ctrl+Shift+I'));
    if ((await control.locator('kbd').textContent().catch(() => '')) !== 'Ctrl+Shift+I') fail(w('devtools: the control’s key cap is not Ctrl+Shift+I'));
    const tabOpen = () => pw.waitForSelector('.editor-drawer:not([hidden]) .live-docked[data-tab="devtools"]', { timeout: 3000 }).then(() => true, () => false);
    await pw.keyboard.press('Meta+Alt+KeyI');
    await pw.waitForTimeout(300);
    if (await pw.$('.live-docked[data-tab="devtools"]')) fail(w('devtools: the Mac’s ⌥⌘I opened DevTools on Windows'));
    await pw.keyboard.press('Control+Shift+KeyI');
    if (!(await tabOpen())) fail(w('devtools: Ctrl+Shift+I did not open the DevTools tab'));
    const said = await pw.locator('.live-devtools-foot').innerText().catch(() => '');
    if (!said.includes('Ctrl+Shift+I opens or closes this tab.')) fail(w(`devtools: the tab does not say Ctrl+Shift+I (${said})`));
    await pw.screenshot({ path: join(out, 'windows-devtools.png'), animations: 'disabled' });
    await pw.keyboard.press('Control+Shift+KeyI');
    await pw.waitForSelector('.dock-collapsed', { timeout: 3000 }).catch(() => fail(w('devtools: Ctrl+Shift+I did not close the tab')));
    // The sheet lists it as Windows writes it.
    await pw.keyboard.press('Control+Slash');
    await pw.waitForSelector('.shortcuts', { timeout: 3000 }).catch(() => fail(w('the shortcut sheet did not open')));
    const row = await pw.$$eval('.shortcut', (els) => els.map((e) => [e.querySelector('dt')?.textContent, e.querySelector('.shortcut-keys')?.getAttribute('aria-label')])
      .find(([l]) => l === 'The page’s DevTools, in the dock beneath it: open or close')?.[1] ?? null);
    if (row !== 'Ctrl+Shift+I') fail(w(`devtools: the shortcut sheet lists it as ${row}`));
    await pw.keyboard.press('Escape');
    // Windows' longer key caps still fit: the bar at 1280 px with DevTools open beside the page.
    await pw.setViewportSize({ width: 1280, height: 900 });
    await pw.keyboard.press('Control+Shift+KeyI');
    if (!(await tabOpen())) fail(w('devtools: Ctrl+Shift+I did not open the tab again'));
    await pw.click('.editor-actions button[aria-label="Put the dock beside the view"]');
    await pw.waitForSelector('.editor-drawer[data-dock="right"]:not([hidden]) .live-devtools-host', { timeout: 3000 }).catch(() => fail(w('devtools: the dock did not go beside the page')));
    await pw.waitForTimeout(200);
    for (const problem of await pw.evaluate(fitProblems)) fail(w(`fit 1280 px, DevTools beside: ${problem}`));
    await pw.screenshot({ path: join(out, 'windows-devtools-fit-1280-right.png'), animations: 'disabled' });
    await ctx.close();
  }

  // The page script itself, in a real page of made-up markup.
  const script = readFileSync(join(root, 'out/renderer/live-page.js'), 'utf8');
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.setContent(`<!doctype html><html><body style="margin:0;font:14px sans-serif">
<!-- THEME HOOK: 'region' -->
<!-- BEGIN OUTPUT from 'themes/custom/acme/templates/region--sidebar.html.twig' -->
<aside style="width:300px;padding:10px">
<!-- wl:part id="p-search" --><div data-wl-block="search_form_block@acme_search" style="height:60px;background:#eee;margin:8px 0">Search</div><!-- /wl:part id="p-search" -->
<!-- wl:part id="p-news" --><div data-wl-block="views_block:news@acme_news" style="height:60px;background:#ddd;margin:8px 0">Latest news</div><!-- /wl:part id="p-news" -->
<!-- wl:part id="p-hours" -->
<!-- THEME HOOK: 'block' -->
<!-- BEGIN OUTPUT from 'themes/custom/acme/templates/block--hours.html.twig' -->
<div style="height:60px;background:#ccc;margin:8px 0">Opening hours</div>
<!-- END OUTPUT from 'themes/custom/acme/templates/block--hours.html.twig' -->
<!-- /wl:part id="p-hours" -->
</aside>
<!-- END OUTPUT from 'themes/custom/acme/templates/region--sidebar.html.twig' -->
</body></html>`);
  await page.addScriptTag({ content: script });
  const regions = await page.evaluate(() => window.__wl.scan());
  const at = Object.fromEntries(regions.filter((r) => r.part).map((r) => [r.part, r.index]));
  if (Object.keys(at).sort().join() !== 'p-hours,p-news,p-search') fail(`page script: parts read as ${JSON.stringify(regions.map((r) => [r.index, r.part, r.file, r.block]))}`);
  const hoursRegion = regions.find((r) => r.part === 'p-hours');
  if (hoursRegion?.file !== 'themes/custom/acme/templates/block--hours.html.twig') fail('page script: the hours part did not pair with its template');
  const sidebar = regions.find((r) => r.file?.endsWith('region--sidebar.html.twig'))?.index ?? null;
  const n = await page.evaluate(() => window.__wl.paint([{ index: 0, color: '#86cfc3', fill: 0.2, label: '62 ms', dashed: false }]));
  if (n !== 1) fail(`page script: painted ${n}`);
  await page.evaluate(() => window.__wl.paint([]));
  // Picking from the keyboard, no pointer: from a part (the Layers tree's choice), or from the page; ↑ ↓ ← → walk, Enter picks.
  await page.evaluate((i) => { window.__pick = window.__wl.pick(i); }, at['p-hours']);
  await page.keyboard.press('Enter');
  const fromPart = await page.evaluate(() => window.__pick);
  if (fromPart?.text !== 'Opening hours') fail(`page script: Enter from the hours part picked ${JSON.stringify(fromPart?.text)}`);
  await page.evaluate(() => { window.__pick = window.__wl.pick(null); });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  const walked = await page.evaluate(() => window.__pick);
  if (walked?.text !== 'Latest news' || !walked.regions.some((r) => r.part === 'p-news')) fail(`page script: ↓ → Enter from the page picked ${JSON.stringify(walked?.text)}`);
  await page.evaluate(() => { window.__pick = window.__wl.pick(null); });
  await page.keyboard.press('p');
  if ((await page.evaluate(() => window.__pick)) !== null) fail('page script: P while picking did not stop');
  // Choosing a part from the tree makes its element the picked one: its words can be retyped, as a pick's can.
  const chosen = await page.evaluate((i) => window.__wl.choose(i), at['p-news']);
  if (chosen?.own !== 'Latest news' || chosen.selector !== (await page.evaluate(() => window.__wl.picked()?.selector))) fail(`page script: choosing the news part gave ${JSON.stringify(chosen && { own: chosen.own, selector: chosen.selector })}`);
  // Drag Opening hours to the top of the sidebar: a handle on hover, a drop answered, the order shown, then put back.
  await page.evaluate((spec) => { window.__drop = window.__wl.arrange(spec); }, {
    collections: [{ id: 'c-side', label: 'Sidebar blocks', container: sidebar, targets: ['c-side'], inserts: [], why: null,
      items: ['p-search', 'p-news', 'p-hours'].map((p) => ({ part: p, region: at[p], label: p })) }],
    groups: [], placing: null,
  });
  const hours = await page.locator('text=Opening hours').boundingBox();
  await page.mouse.move(hours.x + 100, hours.y + 30);
  const handle = await page.evaluate(() => {
    const h = [...document.getElementById('__wanigan_live_overlay').shadowRoot.querySelectorAll('div')].find((d) => d.textContent === '⋮⋮');
    const b = h?.getBoundingClientRect();
    return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
  });
  if (!handle) fail('page script: no drag handle on the hovered part');
  else {
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    const search = await page.locator('text=Search').boundingBox();
    await page.mouse.move(search.x + 100, search.y + 20, { steps: 8 });
    const line = await page.evaluate(() => [...document.getElementById('__wanigan_live_overlay').shadowRoot.querySelectorAll('div')].some((d) => d.style.height === '3px'));
    if (!line) fail('page script: no insertion line while dragging');
    await page.screenshot({ path: join(out, 'page-script-drag.png') });
    await page.mouse.up();
    const drop = await page.evaluate(() => Promise.race([window.__drop, new Promise((done) => setTimeout(() => done('no answer'), 3000))]));
    if (JSON.stringify(drop) !== JSON.stringify({ kind: 'move', move: { collection: 'c-side', item: 'p-hours', to: { collection: 'c-side', index: 0 } } })) fail(`page script: the drop answered ${JSON.stringify(drop)}`);
    const order = await page.evaluate(() => [...document.querySelectorAll('aside > div')].map((d) => d.textContent.trim()));
    if (order.join() !== 'Opening hours,Search,Latest news') fail(`page script: the preview shows ${order.join()}`);
    await page.evaluate(() => window.__wl.unpreview());
    const back = await page.evaluate(() => [...document.querySelectorAll('aside > div')].map((d) => d.textContent.trim()));
    if (back.join() !== 'Search,Latest news,Opening hours') fail(`page script: put back as ${back.join()}`);
  }
  // The dock's keys from the page: ⇧] and ⇧[ (a key event names them } and {) go to the window, never to the page.
  for (const [key, want] of [['Shift+BracketRight', 'dock-next'], ['Shift+BracketLeft', 'dock-previous'], ['BracketRight', 'tab-next']]) {
    await page.evaluate((k) => {
      window.__got = null;
      window.__wl.awaitGoto(k).then((v) => { window.__got = v; });
      document.activeElement?.blur();
    }, LIVE_PAGE_KEYS);
    await page.keyboard.press(key);
    await page.waitForTimeout(100);
    const got = await page.evaluate(() => window.__got);
    if (got !== want) fail(`page script: ${key} in the page answered ${got}, not ${want}`);
  }
  await page.evaluate(() => { window.__wl.awaitGoto(); });
  await page.close();

  // Show in DevTools brings a part into view before DevTools is pointed at it: off screen, the page scrolls to it
  // (instantly, even on a site that scrolls smoothly) and says where it is now; on screen, it stays put. A part marked
  // by comments, and the picked element (none here), too.
  {
    const tall = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await tall.setContent(`<!doctype html><html style="scroll-behavior:smooth"><body style="margin:0;font:14px sans-serif">
<div data-wl-block="hero@acme_hero" style="height:200px;background:#eee">Hero</div>
<div style="height:2400px"></div>
<!-- wl:part id="p-footer" --><footer data-wl-block="copyright@acme_copyright" style="height:80px;margin-left:120px;width:300px;background:#ddd">Copyright</footer><!-- /wl:part id="p-footer" -->
<div style="height:400px"></div>
</body></html>`);
    await tall.addScriptTag({ content: script });
    const found = await tall.evaluate(() => window.__wl.scan().map((r) => ({ index: r.index, block: r.block, part: r.part })));
    const heroAt = found.find((r) => r.block?.startsWith('hero'))?.index;
    const footAt = found.find((r) => r.block?.startsWith('copyright'))?.index;
    const markedAt = found.find((r) => r.part === 'p-footer' && !r.block)?.index ?? footAt;
    const before = await tall.evaluate((i) => window.__wl.where(i), footAt);
    if (!before || before.y < 600) fail(`page script: the footer should start off screen (${JSON.stringify(before)})`);
    const hero = await tall.evaluate((i) => ({ box: window.__wl.reveal(i), y: scrollY }), heroAt);
    if (hero.y !== 0 || hero.box?.y !== 0 || hero.box?.height !== 200) fail(`page script: revealing a part on screen moved the page or read it wrong (${JSON.stringify(hero)})`);
    const foot = await tall.evaluate((i) => ({ box: window.__wl.reveal(i), y: scrollY }), footAt);
    if (!foot.box || foot.y <= 0 || foot.box.y < 0 || foot.box.y + foot.box.height > 600 || foot.box.x !== 120 || foot.box.width !== 300) {
      fail(`page script: revealing a part off screen did not bring it into view (${JSON.stringify(foot)})`);
    }
    // The box answered is where it is now (the same as where() says after), with the viewport it was measured in.
    const { viewWidth, viewHeight, ...footBox } = foot.box;
    if (JSON.stringify(footBox) !== JSON.stringify(await tall.evaluate((i) => window.__wl.where(i), footAt))) fail('page script: reveal answered a box other than where the part is');
    if (viewWidth !== 800 || viewHeight !== 600) fail(`page script: reveal measured the part in a viewport of ${viewWidth} × ${viewHeight}, not 800 × 600`);
    await tall.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    const marked = await tall.evaluate((i) => ({ box: window.__wl.reveal(i), y: scrollY }), markedAt);
    if (!marked.box || marked.y <= 0 || marked.box.y < 0 || marked.box.y >= 600) fail(`page script: revealing a part marked by comments did not bring it into view (${JSON.stringify(marked)})`);
    if ((await tall.evaluate(() => window.__wl.reveal(null))) !== null) fail('page script: with nothing picked, reveal(null) answered a box');
    if ((await tall.evaluate(() => window.__wl.reveal(9999))) !== null) fail('page script: a region that is not there answered a box');
    await tall.close();
  }

  // The design layer patches words in place: only the element's own text nodes change, so the helper's wl:part marks
  // around a field item's words stay (and the part with them); an element with an element inside it is not written
  // to; and switched off, exactly what was there is put back.
  const words = await browser.newPage();
  const title = '<!-- wl:part id="p-title" -->Paddling 101<!-- /wl:part id="p-title" -->';
  const tag = '\n<!-- wl:part id="p-tag" -->Canoe<!-- /wl:part id="p-tag" -->\n';
  await words.setContent(`<!doctype html><html><body><h2 id="t1">${title}</h2><div id="t2">${tag}</div><p id="t3">Hello <b>world</b></p></body></html>`);
  await words.addScriptTag({ content: script });
  const inner = () => words.evaluate(() => ['t1', 't2', 't3'].map((id) => document.getElementById(id).innerHTML));
  const partsOf = () => words.evaluate(() => window.__wl.scan().map((r) => r.part).filter(Boolean).sort().join());
  const partsBefore = await partsOf();
  await words.evaluate(() => window.__wl.layerFind(['t1', 't2', 't3'].map((id, i) => ({ id: `e${i + 1}`, parts: null, inner: null, selector: `#${id}` })), true));
  await words.evaluate(() => window.__wl.layerSet({ tags: { e1: [0], e2: [0], e3: [0] }, texts: [{ id: 'e1', value: 'Paddling 102' }, { id: 'e2', value: 'Kayak' }, { id: 'e3', value: 'Bye' }], on: true, gate: 'g1' }));
  const shown = await inner();
  if (shown[0] !== title.replace('Paddling 101', 'Paddling 102') || shown[1] !== tag.replace('Canoe', 'Kayak')) fail(`page script: patched words took the part marks with them: ${JSON.stringify(shown.slice(0, 2))}`);
  if (shown[2] !== 'Hello <b>world</b>') fail(`page script: words were written into an element with an element inside it: ${JSON.stringify(shown[2])}`);
  if ((await partsOf()) !== partsBefore || partsBefore !== 'p-tag,p-title') fail(`page script: parts after patching words: ${await partsOf()} (before: ${partsBefore})`);
  if ((await words.evaluate(() => window.__wl.layerOf('e1')))?.words !== 'Paddling 101') fail('page script: a patched element did not answer the words the site rendered');
  await words.evaluate(() => window.__wl.layerSet({ tags: { e1: [0], e2: [0], e3: [0] }, texts: [], on: false, gate: null }));
  const putBack = await inner();
  if (putBack[0] !== title || putBack[1] !== tag) fail(`page script: words not put back exactly: ${JSON.stringify(putBack.slice(0, 2))}`);
  // One stored thing shown twice (the same plain words in the same field mark) is said to be one, so the main process
  // saves it once; elements showing different words are not.
  const mark = 'node:12:title:string:en';
  await words.setContent(`<!doctype html><html><body><div data-wl-field="${mark}"><h2 class="a">Paddling 101</h2></div><aside data-wl-field="${mark}"><h2 class="a">Paddling 101</h2></aside><h3 class="b">Paddling 101</h3><h3 class="b">Paddling…</h3></body></html>`);
  await words.addScriptTag({ content: script });
  await words.evaluate(() => window.__wl.layerFind([{ id: 'same', parts: null, inner: null, selector: 'h2.a' }, { id: 'apart', parts: null, inner: null, selector: 'h3.b' }], true));
  await words.evaluate(() => window.__wl.layerSet({ tags: { same: [0, 1], apart: [0, 1] }, texts: [], on: true, gate: 'g1' }));
  const same = await words.evaluate(() => [window.__wl.layerOf('same'), window.__wl.layerOf('apart')]);
  if (same[0]?.count !== 2 || same[0]?.same !== true || same[0]?.field !== mark) fail(`page script: one stored thing shown twice was not said to be one: ${JSON.stringify(same[0])}`);
  if (same[1]?.count !== 2 || same[1]?.same !== false) fail(`page script: elements showing different words were said to be one: ${JSON.stringify(same[1])}`);
  await words.close();

  // Typing on the page: the chosen element's own words, edited where they are (made-up markup). Each keystroke changes
  // the element; the live view's keys wait while it lasts; Escape puts back exactly what it held, the same text nodes
  // and the helper's part marks, whatever was typed over them; Enter keeps the words in the element's own nodes, which
  // the layer then writes to, while its words for keying are still the site's; a link around the words goes nowhere;
  // a paste is its plain text; clicking away keeps; an element with an element inside is refused; and a double-click
  // on the chosen words answers 'retype' to the window.
  const typed = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const navigated = [];
  typed.on('request', (r) => { if (r.url().includes('northwind.example.test')) navigated.push(r.url()); });
  await typed.setContent(`<!doctype html><html><body style="margin:24px;font:16px sans-serif">
<h2 id="t1"><!-- wl:part id="p-title" -->Paddling 101<!-- /wl:part id="p-title" --></h2>
<p><a id="trips" href="https://northwind.example.test/trips" onclick="window.__heard = true"><span id="t2">Book a trip</span></a></p>
<p id="t3">Paddles <b>for hire</b></p>
<p id="away">Opening hours</p>
</body></html>`);
  await typed.addScriptTag({ content: script });
  const choose = async (sel) => {
    await typed.evaluate(() => { window.__p = window.__wl.pick(null); });
    await typed.click(sel);
    return typed.evaluate(() => window.__p);
  };
  const startTyping = () => typed.evaluate(() => { window.__typed = 'typing'; window.__wl.layerType().then((v) => { window.__typed = v; }); });
  const answer = () => typed.evaluate(() => window.__typed);
  const t1 = () => typed.$eval('#t1', (e) => ({ html: e.innerHTML, text: e.textContent, editable: e.getAttribute('contenteditable'), style: e.getAttribute('style') }));
  const site = await t1();
  if ((await choose('#t1'))?.own !== 'Paddling 101') fail('page script: the title could not be chosen to type on');
  await typed.evaluate((k) => { window.__got = null; window.__wl.awaitGoto(k).then((v) => { window.__got = v; }); }, LIVE_PAGE_KEYS);
  await typed.evaluate(() => { window.__nodes = [...document.getElementById('t1').childNodes]; });
  await startTyping();
  if (!(await typed.evaluate(() => window.__wl.busy())) || (await typed.evaluate(() => document.activeElement?.id)) !== 't1') fail('page script: typing did not take the keyboard to the words, or let the live view’s keys go');
  let so = 'Paddling 101';
  for (const key of [' ', 'p', '3']) {
    await typed.keyboard.type(key);
    so += key;
    const now = (await t1()).text;
    if (now !== so) fail(`page script: after typing ${JSON.stringify(key)} the element reads ${JSON.stringify(now)}, not ${JSON.stringify(so)}`);
  }
  if ((await typed.evaluate(() => window.__got)) !== null) fail(`page script: a key typed into the words was taken as the live view’s (${await typed.evaluate(() => window.__got)})`);
  await typed.screenshot({ path: join(out, 'page-script-typing.png'), caret: 'initial' });
  // Everything selected and typed over, the part marks with it, then Escape: exactly what the site rendered, in the same nodes.
  await typed.keyboard.press('ControlOrMeta+A');
  await typed.keyboard.type('Canoe');
  await typed.keyboard.press('Escape');
  const back = await t1();
  if (JSON.stringify(back) !== JSON.stringify(site)) fail(`page script: Escape put back ${JSON.stringify(back)}, not ${JSON.stringify(site)}`);
  if (!(await typed.evaluate(() => { const now = [...document.getElementById('t1').childNodes]; return now.length === window.__nodes.length && now.every((n, i) => n === window.__nodes[i]); }))) fail('page script: Escape did not put back the element’s own nodes');
  if (JSON.stringify(await answer()) !== JSON.stringify({ kept: false, why: null, key: true })) fail(`page script: Escape answered ${JSON.stringify(await answer())}`);
  if (await typed.evaluate(() => window.__wl.busy())) fail('page script: still busy once typing ended');
  // Enter keeps the words, in the element's own text node between the part marks; keyed, it is still the site's words.
  await startTyping();
  await typed.keyboard.press('Backspace');
  await typed.keyboard.type('2');
  await typed.keyboard.press('Enter');
  const kept = await t1();
  if (JSON.stringify(await answer()) !== JSON.stringify({ kept: true, words: 'Paddling 102', key: true })) fail(`page script: Enter answered ${JSON.stringify(await answer())}`);
  if (kept.html !== site.html.replace('Paddling 101', 'Paddling 102') || kept.editable !== null || kept.style !== null) fail(`page script: Enter left ${JSON.stringify(kept)}`);
  if (!(await typed.evaluate(() => window.__nodes.every((n, i) => document.getElementById('t1').childNodes[i] === n)))) fail('page script: the words kept are not in the element’s own nodes');
  if ((await typed.evaluate(() => window.__wl.layerPick([])))?.text !== 'Paddling 101') fail('page script: words kept on the page are keyed by the words typed, not the site’s');
  await typed.evaluate(() => window.__wl.layerSet({ tags: {}, texts: [], on: true, gate: 'g1' }));
  if ((await t1()).html !== site.html) fail('page script: once the layer does not hold the words typed, the site’s were not put back');
  // Clicking away in the page keeps the words, as Enter does.
  await startTyping();
  await typed.keyboard.type('!');
  await typed.click('#away');
  if (JSON.stringify(await answer()) !== JSON.stringify({ kept: true, words: 'Paddling 101!', key: false })) fail(`page script: clicking away answered ${JSON.stringify(await answer())}`);
  await typed.evaluate(() => window.__wl.layerSet({ tags: {}, texts: [], on: true, gate: 'g1' }));
  // Words inside a link: typed into, the link never followed, its own click handler never told. A paste: its plain text only.
  if ((await choose('#t2'))?.own !== 'Book a trip') fail('page script: the link’s words could not be chosen');
  await startTyping();
  await typed.click('#t2');
  await typed.keyboard.type('!');
  await typed.waitForTimeout(200);
  if (navigated.length || typed.url() !== 'about:blank') fail(`page script: a click in a link’s words being typed followed the link (${navigated.join(', ') || typed.url()})`);
  if (await typed.evaluate(() => window.__heard)) fail('page script: a click in a link’s words being typed reached the page’s own click handler');
  if (!(await typed.$eval('#t2', (e) => e.textContent)).includes('!')) fail('page script: a click in a link’s words did not leave them typed into');
  await typed.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/html', '<b>Kayaks</b><script>x()</script>');
    data.setData('text/plain', ' and\nkayaks');
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  const pasted = await typed.$eval('#t2', (e) => ({ html: e.innerHTML, text: e.textContent }));
  if (!pasted.text.includes(' and kayaks') || /<|Kayaks/.test(pasted.html)) fail(`page script: a paste was not its plain text alone: ${JSON.stringify(pasted)}`);
  await typed.keyboard.press('Escape');
  if ((await typed.$eval('#t2', (e) => e.innerHTML)) !== 'Book a trip') fail('page script: Escape did not put the link’s words back');
  // Words with an element inside them are not typed into.
  await choose('#t3');
  await startTyping();
  await typed.waitForFunction(() => window.__typed !== 'typing', null, { timeout: 2000 }).catch(() => {});
  if (!(await answer())?.refused || (await typed.$eval('#t3', (e) => e.getAttribute('contenteditable'))) !== null) fail(`page script: words with an element inside were typed into: ${JSON.stringify(await answer())}`);
  // A double-click on the chosen words answers 'retype'; anywhere else, nothing.
  await choose('#t1');
  await typed.evaluate(() => { window.__got = null; window.__wl.awaitGoto([]).then((v) => { window.__got = v; }); });
  await typed.dblclick('#away');
  if ((await typed.evaluate(() => window.__got)) !== null) fail('page script: a double-click away from the chosen words answered the window');
  await typed.dblclick('#t1');
  if ((await typed.evaluate(() => window.__got)) !== 'retype') fail(`page script: a double-click on the chosen words answered ${await typed.evaluate(() => window.__got)}`);
  await typed.close();

  // Trying a style: one preview the page script owns, over the layer's own rule for the same property (both sheets
  // put in alike here, as at the user origin in the app, so their selectors decide), replaced on every change, on
  // every element of a kind, and gone without a trace.
  const trying = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await trying.setContent(`<!doctype html><html><body style="margin:24px;font:16px sans-serif">
<h2 id="t1" style="letter-spacing: 1px">Paddling 101</h2>
<div class="card"><h3>Canoes</h3></div><div class="card"><h3>Kayaks</h3></div><div class="card"><h3>Paddles</h3></div>
</body></html>`);
  await trying.addScriptTag({ content: script });
  const layered = [{ id: 'e1', target: { part: null, inner: null, selector: '#t1', textHash: null }, label: 'Title', page: '/', scope: 'this', breakpoint: 'all', change: { type: 'style', values: { color: 'rgb(30, 132, 73)' } }, before: {}, state: 'draft', by: 'owner', at: 1, verdict: null }];
  await trying.addStyleTag({ content: compileLayer(layered, [], 'g1') });
  await trying.addStyleTag({ content: trySheet() });
  await trying.evaluate(() => { document.documentElement.setAttribute('data-wl-layer', 'g1'); document.getElementById('t1').setAttribute('data-wl-edit', 'e1'); });
  const look = () => trying.$eval('#t1', (e) => ({ color: getComputedStyle(e).color, size: getComputedStyle(e).fontSize, style: e.getAttribute('style'), mark: e.getAttribute('data-wl-try') }));
  const plain = await look();
  if (plain.color !== 'rgb(30, 132, 73)') fail(`page script: the layer’s own colour did not show (${plain.color})`);
  const one = { parts: null, inner: null, selector: '#t1' };
  if ((await trying.evaluate((spec) => window.__wl.layerTry(spec, { color: 'rgb(192, 57, 43)', 'font-size': '30px' }), one)) !== 1) fail('page script: a style tried on one element did not say it showed there');
  const shownNow = await look();
  if (shownNow.color !== 'rgb(192, 57, 43)' || shownNow.size !== '30px') fail(`page script: the style tried did not show over the layer’s (${JSON.stringify(shownNow)})`);
  await trying.screenshot({ path: join(out, 'page-script-try.png') });
  await trying.evaluate((spec) => window.__wl.layerTry(spec, { color: 'rgb(41, 128, 185)' }), one);
  const replaced = await look();
  if (replaced.color !== 'rgb(41, 128, 185)' || replaced.size === '30px') fail(`page script: a second try did not replace the first (${JSON.stringify(replaced)})`);
  const cards = await trying.evaluate(() => window.__wl.layerTry({ parts: null, inner: null, selector: '.card > h3' }, { color: 'rgb(1, 2, 3)' }));
  const cardColors = await trying.$$eval('.card > h3', (els) => els.map((e) => getComputedStyle(e).color));
  if (cards !== 3 || cardColors.some((c) => c !== 'rgb(1, 2, 3)') || (await look()).color !== plain.color) fail(`page script: a style tried on every one of a kind showed on ${JSON.stringify(cardColors)} (and the title is ${(await look()).color})`);
  await trying.evaluate(() => window.__wl.layerTry(null, null));
  const gone = await look();
  const cardsGone = await trying.$$eval('.card > h3', (els) => els.map((e) => [e.getAttribute('style'), e.getAttribute('data-wl-try')]));
  if (JSON.stringify(gone) !== JSON.stringify(plain) || cardsGone.some(([style, mark]) => style !== null || mark !== null)) fail(`page script: the style tried left a trace: ${JSON.stringify({ gone, cardsGone })}`);
  await trying.close();

  // The verification's masks: where the trace's parts are on the page, and the blocks a helper marked as changing
  // between renders (data-wanigan-vary, held still or not), in document pixels.
  const areas = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await areas.setContent(`<!doctype html><html><body style="margin:0;font:14px sans-serif">
<!-- wl:part id="p-picks" --><section style="height:120px;margin:40px 0 0">Picks</section><!-- /wl:part id="p-picks" -->
<div data-wl-block="core/gallery" data-wanigan-vary="random-order" style="height:80px">Gallery</div>
<p data-wl-block="core/post-date" data-wanigan-vary="relative-date" data-wanigan-held="time" style="height:20px;margin:0">3 days ago</p>
</body></html>`);
  await areas.addScriptTag({ content: script });
  const got = await areas.evaluate(() => window.__wl.layerAreas(['p-picks', 'p-gone']));
  const picks = got?.parts?.['p-picks'];
  if (JSON.stringify(picks) !== JSON.stringify([{ x: 0, y: 40, width: 900, height: 120 }]) || 'p-gone' in (got?.parts ?? {})) fail(`page script: a part's boxes for the masks were ${JSON.stringify(got?.parts)}`);
  const vary = JSON.stringify(got?.vary);
  if (vary !== JSON.stringify([
    { reason: 'random-order', held: null, name: 'core/gallery', box: { x: 0, y: 160, width: 900, height: 80 } },
    { reason: 'relative-date', held: 'time', name: 'core/post-date', box: { x: 0, y: 240, width: 900, height: 20 } },
  ])) fail(`page script: the blocks marked as changing between renders were ${vary}`);
  await areas.close();

  // Step 3 against the page as it was reads the whole page element by element: each by its path from <body> (however
  // the layout moves), its own words (not its children's), its computed values as indexes into one table, whether it
  // is an edited element or inside one; never the page script's own overlay or what is never shown.
  const whole = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await whole.setContent(`<!doctype html><html><body style="margin:0;font:14px sans-serif">
<nav style="height:20px"><a style="color:rgb(0, 0, 255)">Home</a> / <span>Paddling 101</span></nav>
<script>void 0</script>
<h1 data-wl-edit="e1" style="margin:0;height:30px">Paddling <em>101</em></h1>
<p style="margin:0;height:40px">Learn the strokes.</p>
</body></html>`);
  await whole.addScriptTag({ content: script });
  const read = await whole.evaluate(() => window.__wl.layerPage(['color', 'margin-top'], 100));
  const shape = (read?.elements ?? []).map((e) => [e.p, e.t, e.e, read.table[e.v[0]]]);
  if (JSON.stringify(shape) !== JSON.stringify([
    ['body > nav:nth-of-type(1)', '/', false, 'rgb(0, 0, 0)'],
    ['body > nav:nth-of-type(1) > a:nth-of-type(1)', 'Home', false, 'rgb(0, 0, 255)'],
    ['body > nav:nth-of-type(1) > span:nth-of-type(1)', 'Paddling 101', false, 'rgb(0, 0, 0)'],
    ['body > h1:nth-of-type(1)', 'Paddling', true, 'rgb(0, 0, 0)'],
    ['body > h1:nth-of-type(1) > em:nth-of-type(1)', '101', true, 'rgb(0, 0, 0)'],
    ['body > p:nth-of-type(1)', 'Learn the strokes.', false, 'rgb(0, 0, 0)'],
  ]) || JSON.stringify(read?.keys) !== '["color","margin-top"]' || read?.cut !== false) fail(`page script: the page read whole was ${JSON.stringify({ keys: read?.keys, shape, cut: read?.cut })}`);
  const p1 = read?.elements?.find((e) => e.p === 'body > p:nth-of-type(1)');
  if (JSON.stringify(p1?.b) !== JSON.stringify([0, 50, 900, 40])) fail(`page script: an element's box when read whole was ${JSON.stringify(p1?.b)}`);
  if ((await whole.evaluate(() => window.__wl.layerPage(['color'], 2)))?.cut !== true) fail('page script: a page past the limit was not said to be cut');
  await whole.close();

  // What a script added after the page arrived is found from the HTML the server sent: lined up child by child, a
  // form put in front of the server's own div is the one added (a class added to a server element does not make it
  // the script's), left out of the page read whole without moving its siblings' paths, and answered apart. A server
  // element whose words changed is still read, so step 3 still fails it.
  const sentHtml = `<!doctype html><html><body style="margin:0;font:14px sans-serif"><main><p class="lead" style="margin:0;height:40px">Learn the strokes.</p><div class="note" style="height:20px">Open daily</div></main><footer style="height:20px">© Acme</footer></body></html>`;
  const lateTab = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await lateTab.setContent(sentHtml);
  // What a marketing script does after the page arrives: a form in front of the server's own div, and a class on one of them.
  await lateTab.evaluate(() => {
    const form = document.createElement('div');
    form.className = 'acme-signup-frame';
    form.style.height = '30px';
    form.innerHTML = '<form><input aria-label="Email"><button>Sign up</button></form>';
    document.querySelector('main').insertBefore(form, document.querySelector('.note'));
    document.querySelector('.lead').classList.add('is-ready');
    document.querySelector('footer').textContent = '© Northwind';
  });
  await lateTab.addScriptTag({ content: script });
  const lateAdded = await lateTab.evaluate((html) => window.__wl.layerLate(html), sentHtml);
  if (JSON.stringify(lateAdded) !== JSON.stringify([{ n: 'div.acme-signup-frame', b: [0, 40, 900, 30] }])) fail(`page script: what a script added after the page arrived was ${JSON.stringify(lateAdded)}`);
  const lateRead = await lateTab.evaluate(() => window.__wl.layerPage(['color'], 100));
  const latePaths = (lateRead?.elements ?? []).map((e) => [e.p, e.t]);
  if (JSON.stringify(latePaths) !== JSON.stringify([
    ['body > main:nth-of-type(1)', null],
    ['body > main:nth-of-type(1) > p:nth-of-type(1)', 'Learn the strokes.'],
    ['body > main:nth-of-type(1) > div:nth-of-type(1)', 'Open daily'],
    ['body > footer:nth-of-type(1)', '© Northwind'],
  ])) fail(`page script: read whole beside a script's form, the page was ${JSON.stringify(latePaths)} (the form left out, the note still the first div, the footer's new words kept)`);
  if (JSON.stringify(lateRead?.late) !== JSON.stringify([{ n: 'div.acme-signup-frame', b: [0, 40, 900, 30] }])) fail(`page script: the page read whole did not answer the script's form apart: ${JSON.stringify(lateRead?.late)}`);
  await lateTab.close();
} finally {
  await browser.close();
  gateway.kill('SIGTERM');
}

if (failures.length) {
  console.error(`Live sweep failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`Live sweep passed. Screenshots in ${out}`);
