#!/usr/bin/env node
// The live view's deeper side, in both themes, against the harness's real core
// and a stand-in live view (scripts/ui-live-stub.mjs): a made-up acme trace
// over a plain wireframe, never a website. Screenshots go to
// .artifacts/live/<theme>-<name>.png: the lenses' legends, the Inspector's
// sections, moving a part by the keyboard, both edit sheets, the request, the
// palette and the states without a trace; and the layout itself: the bar's
// three groups and its site menu, the four verbs on a chosen part with the
// note under them, a part chosen in the tree offering what a pick offers, the
// status line, and every key the live view lists on the shortcut sheet. Then the page script itself, in a
// real Chromium page of made-up markup: the trace's part marks read and paired,
// a lens painted, a part dragged to a new place and put back.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { BRIDGE, root, startGateway } from './ui-harness.mjs';
import { liveFixture, liveStub } from './ui-live-stub.mjs';
import { LIVE_DEFAULTS } from './ui-live-defaults.mjs';

const out = join(root, '.artifacts', 'live');
mkdirSync(out, { recursive: true });
const failures = [];
const fail = (what) => { failures.push(what); console.error(`✗ ${what}`); };
const { base, gateway } = await startGateway({ demo: true, quiet: true });
const browser = await chromium.launch({ headless: true });

const option = async (page, button, text) => {
  await page.getByRole('button', { name: button, exact: true }).click();
  await page.locator('.sel-opt', { hasText: text }).first().click();
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
    const sideways = await page.locator('.live-side').evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    if (sideways) fail(t('inspector: the side panel is wider than itself'));
    await page.locator('.live-side').evaluate((el) => { el.scrollTop = 0; el.scrollLeft = 0; });
    await shot('inspector');
    await page.locator('.live-side').evaluate((el) => { el.scrollTop = el.clientHeight * 0.8; });
    await shot('inspector-data');
    await page.locator('.live-side').evaluate((el) => { el.scrollTop = el.clientHeight * 1.6; });
    await shot('inspector-more');

    // Moving by the keyboard: Alt+↓ on a block of the sidebar, said aloud; Escape puts it back.
    await page.locator('.live-crumb', { hasText: 'Hero' }).count();
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
    await shot('move-confirm');
    await page.locator('.dialog button', { hasText: 'Move it' }).click();
    await page.waitForSelector('.toast-info:has-text("Moved Search")', { timeout: 3000 }).catch(() => fail(t('move: no toast after saving')));
    const moved = await page.evaluate(() => window.__wgLive.calls.find((c) => c.startsWith('move ')));
    if (moved !== 'move {"collection":"c-sidebar","item":"p-search","to":{"collection":"c-sidebar","index":1}}') fail(t(`move: posted ${moved}`));
    await shot('move-saved');
    await page.locator('.toast-info button', { hasText: 'Undo' }).click();
    if (!(await page.evaluate(() => window.__wgLive.calls.includes('undo u-1')))) fail(t('move: Undo did not ask the site'));
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
    await page.getByRole('button', { name: /^Edit Hero/ }).click();
    await page.getByRole('menuitem', { name: /^Title \(node 12\)/ }).click();
    await page.waitForSelector('.live-sheet.native', { timeout: 3000 }).catch(() => fail(t('edit: the native sheet did not open')));
    if (!(await page.evaluate(() => window.__wgLive.calls.includes('editOpen e-title')))) fail(t('edit: the site’s form was not asked for'));
    await shot('edit-native');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.live-sheet', { state: 'detached', timeout: 3000 }).catch(() => fail(t('edit: Escape did not close the sheet')));

    // The request behind the page.
    await page.getByRole('button', { name: 'Back to the layers' }).click();
    await page.getByRole('radio', { name: 'Request' }).click();
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
    if ((await page.evaluate(() => window.__wgLive.spec?.placing?.entry)) !== 'pal-cta') fail(t('palette: the page was not told what to place'));
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
      const nobody = () => page.evaluate(() => document.activeElement?.blur());
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
      if (!/^Pick/.test(toolGroup?.controls[0] ?? '') || !/^More/.test(toolGroup?.controls[1] ?? '') || toolGroup?.controls.length !== 2) fail(t(`layout: the tools are ${JSON.stringify(toolGroup?.controls)}`));
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
      if (verbs.join() !== 'Edit,Move,Code,Alone') fail(t(`layout: the verbs are ${verbs.join(', ')}`));
      const folded = await page.$$eval('.live-why .disclosure-head button', (els) => els.filter((b) => b.getAttribute('aria-expanded') === 'true').length);
      if (folded) fail(t(`layout: ${folded} of the diagnostics are open before they are asked for`));
      await page.getByRole('button', { name: /^Edit Search/ }).click();
      const fromTree = await page.$$eval('[role="menu"] [role^="menuitem"]', (els) => els.map((e) => e.textContent));
      for (const want of [/^Retype the words/, /^Try a style/, /^Block settings/]) if (!fromTree.some((x) => want.test(x))) fail(t(`layout: chosen in the tree, the Edit menu lacks ${want} (${fromTree.join(' | ')})`));
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

      // The verbs' keys: E opens Edit, M opens Move, . says why there is no code here, ⇧A shows it alone.
      await page.locator('.live-inspector .live-side-title').focus();
      await page.keyboard.press('e');
      await page.waitForSelector('[role="menu"]', { timeout: 2000 }).catch(() => fail(t('layout: E did not open the Edit menu')));
      await page.keyboard.press('Escape');
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

      // The bar's keys, from the window with nothing focused: widths, tabs, lens, Compare.
      await nobody();
      await page.keyboard.press('1');
      if ((await pressed('Phone')) !== 'true') fail(t('layout: 1 did not narrow to a phone'));
      await page.keyboard.press('2');
      if ((await pressed('Tablet')) !== 'true') fail(t('layout: 2 did not narrow to a tablet'));
      await page.keyboard.press('3');
      if ((await pressed('Full width')) !== 'true') fail(t('layout: 3 did not go back to full width'));
      await page.keyboard.press(']');
      if (!/^Notes/.test(await tabIs())) fail(t(`layout: ] went to ${await tabIs()}`));
      await page.keyboard.press('[');
      if (await tabIs() !== 'Layers') fail(t(`layout: [ went to ${await tabIs()}`));
      await page.keyboard.press('[');
      if (await tabIs() !== 'Add') fail(t(`layout: [ from the first tab went to ${await tabIs()}, not the last`));
      await page.keyboard.press(']');
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
      await page.waitForSelector('.live-side > .segmented button:has-text("Notes 1")', { timeout: 3000 }).catch(() => fail(t('layout: ⌘↩ in the note box did not add the note')));
      await page.getByRole('button', { name: 'Back to the layers' }).click();
      await nobody();
      await page.keyboard.press('Meta+Shift+Enter');
      await page.waitForSelector('.toast:has-text("Sent the note to")', { timeout: 5000 }).catch(() => fail(t('layout: ⇧⌘↩ did not send the note waiting')));
      await page.waitForFunction(() => [...document.querySelectorAll('.live-side > .segmented button')].some((b) => b.textContent === 'Notes'), null, { timeout: 3000 })
        .catch(() => fail(t('layout: the notes sent are still waiting')));

      // One status line: the site, what it follows, the keys that work now, on every tab.
      for (const tab of ['Layers', 'Problems']) {
        await page.getByRole('radio', { name: new RegExp(`^${tab}`) }).click();
        const status = await page.locator('.live-status').innerText();
        if (!/Drupal · following every session in Northstar/.test(status) || !/pick/.test(status)) fail(t(`layout: on ${tab} the status line reads "${status}"`));
      }
      if (await page.$('.live-side-foot, .live-side > .live-note')) fail(t('layout: the side panel still says the state itself'));
      await page.getByRole('radio', { name: 'Layers' }).click();
      await shot('layout');
    }

    // States without a trace, each said plainly with the next step.
    await page.evaluate(() => { window.__wgLive.answer = { state: 'expired' }; });
    await page.getByRole('button', { name: /^Reload/ }).first().click();
    await page.getByRole('radio', { name: 'Request' }).click();
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
    await old.addInitScript(() => { window.__wgLive.outdated = true; window.__wgLive.answer = { state: 'missing' }; });
    const p2 = await old.newPage();
    await p2.goto(`${base}#/p/NS/live`);
    await p2.waitForSelector('.live-tree', { timeout: 15_000 }).catch(() => fail(t('outdated: no layers')));
    await option(p2, 'Lens', 'Cache');
    await p2.waitForSelector('.live-lens:has-text("Update the helper to see this")', { timeout: 3000 }).catch(() => fail(t('outdated: the Cache lens did not say to update the helper')));
    await p2.getByRole('radio', { name: 'Request' }).click();
    await p2.waitForSelector('.live-request, .live-trace-note:has-text("Update the helper to see this")', { timeout: 3000 }).catch(() => fail(t('outdated: the request did not say to update the helper')));
    await p2.screenshot({ path: join(out, `${theme}-state-outdated.png`), animations: 'disabled' });
    await old.close();
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
  await page.close();
} finally {
  await browser.close();
  gateway.kill('SIGTERM');
}

if (failures.length) {
  console.error(`Live sweep failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`Live sweep passed. Screenshots in ${out}`);
