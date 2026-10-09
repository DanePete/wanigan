#!/usr/bin/env node
// The live view's Go to launcher in both themes, against the demo's core and a
// stand-in live view with a made-up Acme site (scripts/ui-goto-stub.mjs):
// opened by Shift+Space, by its button, from the page and by ⌘⇧Space from the
// board; filtered, jumped, its actions, each way of leaving, and each state the
// site can be in. Screenshots go to .artifacts/ui/goto/<theme>-<name>.png:
// look at them; the assertions only catch what was thought of in advance.
import { LIVE_DEFAULTS } from './ui-live-defaults.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { BRIDGE, root, startGateway } from './ui-harness.mjs';
import { LIVE_STUB } from './ui-goto-stub.mjs';

const out = join(root, '.artifacts', 'ui', 'goto');
mkdirSync(out, { recursive: true });
const ORIGIN = 'https://acme.example.test';
const failures = [];
const fail = (name, why) => { failures.push(`${name}: ${why}`); console.error(`✗ ${name}: ${why}`); };
const { base, gateway } = await startGateway({ demo: true, quiet: true });
const browser = await chromium.launch();

try {
  // ── The page script's part (src/renderer/src/live-page-goto.ts), built, in a made-up page that never leaves this
  // process: Shift+Space is taken only while the window waits and nothing is typed into, and the page never hears it.
  {
    const name = 'page script';
    const probe = await browser.newPage();
    const html = `<!doctype html><html><head><title>Spring open house | Acme</title>
      <link rel="canonical" href="${ORIGIN}/events/spring-open-house"><link rel="shortlink" href="${ORIGIN}/node/12"></head>
      <body class="path-node page-node-type-event"><main><h1> Spring open house </h1>
      <a href="/about">About Acme</a> <a href="/about">About, again</a> <a href="https://elsewhere.example/x">Away</a> <a href="/files/menu.pdf">Menu (PDF)</a>
      <a href="/events?page=2" aria-label="More events"></a>
      <input id="field"> <input id="box" type="checkbox"> <textarea id="area"></textarea> <div id="rich" contenteditable="true">Words</div>
      <div id="text" role="textbox" tabindex="0">A widget</div> <button id="btn">A button</button> <div id="host"></div></main>
      <div style="height: 4000px"></div></body></html>`;
    await probe.route(`${ORIGIN}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
    await probe.goto(`${ORIGIN}/events/spring-open-house`);
    await probe.addScriptTag({ path: join(root, 'out', 'renderer', 'live-page.js') });
    await probe.evaluate(() => {
      document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<input id="inner">';
      window.__heard = 0;
      addEventListener('keydown', (e) => { if (e.code === 'Space') window.__heard++; });
      window.__wait = () => { window.__got = null; window.__wl.awaitGoto().then((v) => { window.__got = v; }); };
    });
    const press = async (focus, wait = true) => {
      await probe.waitForTimeout(400); // any smooth scroll from the last press has settled
      await probe.evaluate(({ f, w }) => {
        if (w) window.__wait(); else window.__got = null;
        const el = f === 'page' ? null : f === 'inner' ? document.getElementById('host').shadowRoot.getElementById('inner') : document.getElementById(f);
        if (el) el.focus({ preventScroll: true }); else document.activeElement?.blur();
        scrollTo({ top: 1500, behavior: 'instant' });
      }, { f: focus, w: wait });
      const heard = await probe.evaluate(() => window.__heard);
      await probe.keyboard.press('Shift+Space');
      await probe.waitForTimeout(400);
      return probe.evaluate((h) => ({ got: window.__got, heard: window.__heard - h, y: Math.round(scrollY) }), heard);
    };
    for (const typed of ['field', 'area', 'rich', 'text', 'inner']) {
      const r = await press(typed);
      if (r.got !== null) fail(name, `Shift+Space while typing in #${typed} opened Go to`);
    }
    const r = await press('page');
    if (r.got !== 'goto') fail(name, 'Shift+Space on the page (nothing typed into) did not open Go to');
    if (r.heard !== 0) fail(name, 'the page heard the Shift+Space Go to took');
    if (r.y !== 1500) fail(name, `the page scrolled (to ${r.y}) for the Shift+Space Go to took`);
    for (const focus of ['btn', 'box']) if ((await press(focus)).got !== 'goto') fail(name, `#${focus} is not typing, but Shift+Space there did not open Go to`);
    // Not waiting: the key is the page's own, and does what it always does.
    const own = await press('page', false);
    if (own.heard !== 1) fail(name, 'with nothing waiting, the page did not hear its own Shift+Space');
    if (own.y >= 1500) fail(name, 'with nothing waiting, Shift+Space did not scroll the page as it always does (so "did not scroll" above proves nothing)');
    // A newer wait replaces the older, which answers null.
    const replaced = await probe.evaluate(async () => { const first = window.__wl.awaitGoto(); window.__wl.awaitGoto(); return first; });
    if (replaced !== null) fail(name, `a replaced wait answered ${replaced}`);
    const here = await probe.evaluate(() => window.__wl.gotoHere());
    if (here.heading !== 'Spring open house' || !here.canonical?.endsWith('/events/spring-open-house') || !here.shortlink?.endsWith('/node/12')) fail(name, `the page says it is ${JSON.stringify(here)}`);
    const links = await probe.evaluate(() => window.__wl.gotoLinks());
    const urls = links.map((l) => l.url);
    if (urls.join() !== '/about,/events?page=2') fail(name, `its links are ${JSON.stringify(links)}`);
    if (links[1]?.label !== 'More events') fail(name, 'a link with no words is not named by its aria-label');
    await probe.close();
    console.log('page script: Shift+Space, what the page is, and its links');
  }

  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, deviceScaleFactor: 2 });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(base).origin });
    await context.addInitScript(BRIDGE);
    await context.addInitScript(LIVE_STUB);
    await context.addInitScript(LIVE_DEFAULTS);
    await context.addInitScript(`try { localStorage.setItem('wanigan.theme', '${theme}'); } catch {}`);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    const fail = (name, why) => { failures.push(`${theme}/${name}: ${why}`); console.error(`✗ ${theme}/${name}: ${why}`); };
    const shot = (name) => page.screenshot({ path: join(out, `${theme}-${name}.png`), animations: 'disabled' });
    const live = () => page.evaluate(() => ({ went: [...window.__wgLive.went], browser: [...window.__wgLive.browser], returned: window.__wgLive.returned, finds: window.__wgLive.finds.map((f) => f.query) }));
    const open = async (how = 'button') => {
      if (how === 'button') await page.click('.live-bar button[aria-label^="Go to a page"]');
      else if (how === 'keys') { await page.focus('.live-bar button[aria-label^="Go to a page"]'); await page.keyboard.press('Shift+Space'); }
      await page.waitForSelector('.goto [role="option"]', { timeout: 5000 });
    };
    const closed = () => page.waitForSelector('.goto', { state: 'detached', timeout: 5000 });
    const type = async (text) => { await page.fill('.goto input', text); };
    const options = () => page.$$eval('.goto [role="option"]', (els) => els.map((e) => ({ label: e.querySelector('.goto-label')?.textContent ?? '', active: e.getAttribute('aria-selected') === 'true', id: e.id })));
    const firstIs = async (name, label) => {
      await page.waitForFunction((l) => document.querySelector('.goto [role="option"] .goto-label')?.textContent === l, label, { timeout: 4000 })
        .catch(async () => fail(name, `the first result is "${(await options())[0]?.label}", not "${label}"`));
    };

    await page.goto(base);
    await page.waitForSelector('.rail-projects a');
    const projectId = await page.evaluate(async () => {
      const ns = (await window.wanigan.call('projects.list', {})).find((p) => p.key === 'NS');
      window.__wgLive.projectId = ns.id;
      // Chosen before, on this Mac: what frecency and "Most used" show.
      const t = Date.now();
      const v = (id, label, url, kind, times) => ({ id, label, url, kind, count: times.length, last: Math.max(...times), times });
      localStorage.setItem(`wanigan.goto.${ns.id}`, JSON.stringify([
        v('route:entity.node_type.collection', 'Content types', '/admin/structure/types', 'structure', [t - 3e6, t - 9e6, t - 9e7, t - 2e8]),
        v('route:system.performance_settings', 'Performance', '/admin/config/development/performance', 'setting', [t - 5e6, t - 4e7, t - 3e8]),
        v('node:44', 'Northwind partnership announced', '/news/northwind-partnership', 'content', [t - 6e5, t - 7e7]),
      ]));
      return ns.id;
    });
    if (!projectId) { fail('setup', 'no demo project NS'); await context.close(); continue; }
    await page.evaluate(() => { location.hash = '#/p/NS/live'; });
    await page.waitForSelector('.live-bar', { timeout: 8000 }).catch(() => fail('setup', 'the live view did not show with the stand-in'));

    // ── Shift+Space in the live view's bar opens it, with this page's tasks, recent pages and the most used.
    await open('keys').catch(() => fail('open', 'Shift+Space in the live view did not open Go to'));
    const opened = await page.evaluate(() => {
      const input = document.querySelector('.goto input');
      const list = document.getElementById(input?.getAttribute('aria-controls') ?? '');
      const active = document.getElementById(input?.getAttribute('aria-activedescendant') ?? '');
      return {
        focused: document.activeElement === input, role: input?.getAttribute('role'), list: list?.getAttribute('role'),
        active: active?.getAttribute('role') === 'option' && active.getAttribute('aria-selected') === 'true',
        groups: [...document.querySelectorAll('.goto-group-head')].map((h) => h.textContent),
        count: document.querySelector('.goto-count')?.textContent ?? '', live: !!document.querySelector('.goto [aria-live="polite"]'),
        modal: document.querySelector('.goto')?.getAttribute('aria-modal'), frame: !!document.querySelector('.live-frame'),
        overflow: (() => { const g = document.querySelector('.goto'); return g ? g.scrollWidth > g.clientWidth + 1 : false; })(),
        ids: [...document.querySelectorAll('.goto [role="option"]')].every((o) => o.id),
      };
    });
    if (!opened.focused) fail('open', 'the search field does not have the keyboard');
    if (opened.role !== 'combobox' || opened.list !== 'listbox' || !opened.active || !opened.ids) fail('open', `not a combobox over a listbox with an active option (${JSON.stringify(opened)})`);
    if (opened.modal !== 'true' || !opened.live) fail('open', 'not a modal dialog with a live count');
    for (const g of ['This page · Spring open house', 'Recent', 'Most used']) if (!opened.groups.includes(g)) fail('open', `no "${g}" group (${opened.groups.join(', ')})`);
    if (!/^Displaying \d+ of \d+$/.test(opened.count)) fail('open', `the count reads "${opened.count}"`);
    if (opened.overflow) fail('open', 'the launcher overflows sideways');
    if (!opened.frame) fail('open', 'the live view did not step aside for the launcher (no last frame)');
    await shot('open');

    // ── Filtered: acronyms and word starts, a label before a tag, the site's own search merged in.
    await type('ct');
    await firstIs('filtered', 'Content types');
    await type('spring');
    await page.waitForSelector('.goto-label:has-text("Spring sale 2025")', { timeout: 4000 }).catch(() => fail('filtered', 'the site’s search did not add older content'));
    const spring = await page.evaluate(() => ({ count: document.querySelector('.goto-count')?.textContent ?? '', status: [...document.querySelectorAll('.goto-status')].map((s) => s.textContent) }));
    if (!/^Displaying \d+ of \d+$/.test(spring.count)) fail('filtered', `the count reads "${spring.count}"`);
    await firstIs('filtered', 'Spring open house');
    await type('jobs');
    await firstIs('filtered', 'Careers at Acme');
    const draft = await page.$eval('.goto [role="option"]', (o) => ({ status: o.querySelector('.goto-status')?.textContent, via: o.querySelector('.goto-via')?.textContent, color: getComputedStyle(o.querySelector('.goto-status')).color }));
    if (draft.status !== 'Draft') fail('filtered', `a draft is not said to be one (${draft.status})`);
    if (!/jobs/.test(draft.via ?? '')) fail('filtered', 'a match on a tag does not say which');
    const amber = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--amber').trim());
    if (draft.color && amber && draft.color.replace(/\s/g, '') === amber.replace(/\s/g, '')) fail('filtered', 'a draft is amber');
    await type('perfromance');
    await firstIs('filtered', 'Performance');
    await type('spring');
    await page.waitForSelector('.goto-label:has-text("Spring sale 2025")', { timeout: 4000 }).catch(() => {});
    await shot('filtered');

    // ── → shows the chosen destination's tasks; ← goes back; Enter on a task opens it in the view.
    await type('spring open');
    await firstIs('actions', 'Spring open house');
    await page.keyboard.press('ArrowRight');
    await page.waitForSelector('.goto-acts-head', { timeout: 3000 }).catch(() => fail('actions', '→ did not show the actions'));
    const acts = (await options()).map((o) => o.label);
    for (const a of ['Open in the live view', 'Edit', 'Layout', 'Revisions', 'Translate', 'Delete', 'Open in the default browser', 'Copy the address']) {
      if (!acts.includes(a)) fail('actions', `no "${a}" (${acts.join(', ')})`);
    }
    await shot('actions');
    await page.keyboard.press('ArrowLeft');
    await page.waitForSelector('.goto-acts-head', { state: 'detached', timeout: 2000 }).catch(() => fail('actions', '← did not go back'));
    await page.keyboard.press('Tab');
    await page.waitForSelector('.goto-acts-head', { timeout: 2000 }).catch(() => fail('actions', 'Tab did not show the actions'));
    await page.keyboard.press('ArrowDown'); // Edit
    await page.keyboard.press('ArrowDown'); // Layout
    await page.keyboard.press('Enter');
    await closed().catch(() => fail('actions', 'running an action did not close Go to'));
    let seen = await live();
    if (!seen.went.includes(`${ORIGIN}/node/12/layout`)) fail('actions', `Layout did not open in the view (${seen.went.join(', ')})`);
    await page.waitForTimeout(200);
    if (seen.returned < 1 && (await live()).returned < 1) fail('actions', 'the keyboard did not go back to the page after opening there');

    // ── A path or an id jumps straight there; ⌥↩ edits, ⌘↩ is the default browser, ⌘C copies.
    await open();
    await type('12');
    await firstIs('jump', 'Spring open house');
    const jumpMeta = await page.$eval('.goto [role="option"] .goto-meta', (m) => m.textContent);
    if (!/node 12/.test(jumpMeta ?? '') || !/\/node\/12/.test(jumpMeta ?? '')) fail('jump', `the jump row says "${jumpMeta}"`);
    await shot('jump');
    await page.keyboard.press('Enter');
    await closed().catch(() => fail('jump', 'Enter did not close Go to'));
    if (!(await live()).went.includes(`${ORIGIN}/node/12`)) fail('jump', '12 did not go to /node/12');

    await open();
    await type('/admin/str');
    const pathRows = (await options()).map((o) => o.label);
    if (pathRows[0] !== '/admin/str' || !pathRows.includes('Structure')) fail('jump', `a typed path does not complete addresses (${pathRows.slice(0, 4).join(', ')})`);
    await type('about');
    await firstIs('edit', 'About Acme');
    await page.keyboard.press('Alt+Enter');
    await closed().catch(() => fail('edit', '⌥↩ did not close Go to'));
    if (!(await live()).went.includes(`${ORIGIN}/node/7/edit`)) fail('edit', '⌥↩ did not open the edit form');

    await open();
    await type('perf');
    await firstIs('browser', 'Performance');
    await page.keyboard.press('Meta+c');
    await page.waitForSelector('.goto-count:has-text("Copied")', { timeout: 2000 }).catch(() => fail('copy', '⌘C did not say it copied'));
    const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    if (copied !== `${ORIGIN}/admin/config/development/performance`) fail('copy', `the clipboard holds "${copied}"`);
    await page.keyboard.press('Meta+Enter');
    await closed().catch(() => fail('browser', '⌘↩ did not close Go to'));
    if (!(await live()).browser.includes('/admin/config/development/performance')) fail('browser', '⌘↩ did not ask for the default browser');

    // ── Escape closes and puts the keyboard back: on the bar's button, or in the page when opened from there.
    await open('keys');
    await page.keyboard.press('Escape');
    await closed().catch(() => fail('escape', 'Escape did not close Go to'));
    const back = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName);
    if (!/^Go to a page/.test(back ?? '')) fail('escape', `focus went to ${back}, not back where it was`);
    const before = (await live()).returned;
    await page.waitForFunction(() => typeof window.__wgLive.press === 'function', null, { timeout: 4000 }).catch(() => fail('page', 'the live view is not waiting for Shift+Space from the page'));
    await page.evaluate(() => window.__wgLive.press?.());
    await page.waitForSelector('.goto [role="option"]', { timeout: 4000 }).catch(() => fail('page', 'Shift+Space in the page did not open Go to'));
    await page.keyboard.press('Escape');
    await closed().catch(() => {});
    await page.waitForTimeout(200);
    if ((await live()).returned <= before) fail('page', 'Escape did not give the keyboard back to the page');

    // ── Nothing found: said plainly; one letter offers the site's own search.
    await open();
    await type('zzqx');
    await page.waitForSelector('.goto-empty', { timeout: 4000 }).catch(() => fail('nothing', 'no empty state for a query that matches nothing'));
    const nothing = await page.$eval('.goto-empty', (e) => e.textContent).catch(() => '');
    if (!/Nothing on the site matches “zzqx”/.test(nothing)) fail('nothing', `it says "${nothing}"`);
    await shot('nothing');
    await type('z');
    const offer = (await options()).at(-1)?.label;
    if (offer !== 'Search acme.example.test for “z”') fail('nothing', `one letter is not offered the site’s search (the last row is "${offer}")`);
    await page.keyboard.press('ArrowUp');
    await shot('search-offer');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__wgLive.finds.some((f) => f.query === 'z'), null, { timeout: 3000 }).catch(() => fail('nothing', 'the offer did not search the site'));
    await page.keyboard.press('Escape');
    await closed().catch(() => {});

    // ── Each state the site can be in, each with what still works and the one thing that fixes it.
    for (const [state, title, button] of [
      ['no-helper', 'Search the whole site with the helper', 'Set up the Drupal helper…'],
      ['outdated', 'This site’s helper is older than this Wanigan', 'Update the helper…'],
      // Logging in happens in the view itself, so this notice has nothing to press.
      ['log-in', 'Log in to search the whole site', null],
      ['down', 'Nothing answered at acme.example.test', 'Try again'],
    ]) {
      await page.evaluate((s) => { window.__wgLive.state = s; }, state);
      await page.click('.live-bar button[aria-label^="Go to a page"]');
      await page.waitForSelector(`.goto-notice:has-text("${title}")`, { timeout: 4000 }).catch(() => fail(state, `no "${title}" notice`));
      if (button && !(await page.$(`.goto-notice button:has-text("${button}")`))) fail(state, `no "${button}" button`);
      if (!button && await page.$('.goto-notice button')) fail(state, 'a button where there is nothing to press');
      if (state !== 'down' && !(await page.$('.goto-group-head:has-text("Pages the live view knows"), .goto-group-head:has-text("Recent")'))) fail(state, 'the pages the view knows are not offered');
      await shot(state);
      if (state === 'no-helper') {
        await type('care');
        await firstIs(state, 'Careers');
        await page.click('.goto-notice button');
        await page.waitForSelector('.dialog:has-text("Set up the Drupal helper")', { timeout: 4000 }).catch(() => fail(state, 'the helper’s plan did not open'));
        await page.click('.dialog button:has-text("Cancel")').catch(() => {});
        await page.waitForSelector('.dialog', { state: 'detached', timeout: 3000 }).catch(() => {});
      } else {
        await page.keyboard.press('Escape');
        await closed().catch(() => {});
      }
    }
    await page.evaluate(() => { window.__wgLive.state = 'ready'; });

    // ── ⌘⇧Space from elsewhere in the project: Enter opens the live view, at that page.
    await page.evaluate(() => { location.hash = '#/p/NS/board'; });
    await page.waitForSelector('.live-bar', { state: 'detached', timeout: 5000 }).catch(() => {});
    await page.keyboard.press('Meta+Shift+Space');
    await page.waitForSelector('.goto [role="option"]', { timeout: 4000 }).catch(() => fail('board', '⌘⇧Space on the board did not open Go to'));
    if (await page.$('.goto-group-head:has-text("This page")')) fail('board', 'off the live view, it still offers "This page"');
    await shot('board');
    await type('contact');
    await firstIs('board', 'Contact');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => location.hash.endsWith('/live'), null, { timeout: 4000 }).catch(() => fail('board', 'Enter did not open the live view'));
    await page.waitForFunction((u) => window.__wgLive.went.includes(u), `${ORIGIN}/contact`, { timeout: 4000 }).catch(() => fail('board', 'the live view did not go to the page chosen'));
    await page.keyboard.press('Meta+Shift+Space');
    await page.waitForSelector('.goto', { timeout: 4000 }).catch(() => fail('toggle', '⌘⇧Space did not open Go to in the live view'));
    await page.keyboard.press('Meta+Shift+Space');
    await closed().catch(() => fail('toggle', '⌘⇧Space again did not close it'));

    for (const e of errors) fail('console', e);
    console.log(`${theme}: Go to swept`);
    await context.close();
  }
} finally {
  await browser.close();
  gateway.kill('SIGTERM');
}

if (failures.length) {
  console.error(`\n${failures.length} Go to failure${failures.length === 1 ? '' : 's'}:\n${failures.map((f) => `  ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(`Go to: both themes, screenshots in ${out}`);
