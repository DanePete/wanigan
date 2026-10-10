#!/usr/bin/env node
// Guided tours, in the built renderer against a real seeded core, both themes.
// The welcome tour plays by itself on a first launch and walks its stops: each
// lit area is the target the step names, the card is inside the window and
// beside what it describes, → and ← step, the window's own keys wait, and once
// ended it never plays again. A view with a tour shows the compass and, on the
// first visit, the offer; Take the tour plays it and Not now puts the offer away
// for good; a view without one shows neither. The palette and Settings replay
// and reset them. Screenshots: .artifacts/ui/<theme>-tour-*.png.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { BRIDGE, root, startGateway } from './ui-harness.mjs';

const out = join(root, '.artifacts', 'ui');
mkdirSync(out, { recursive: true });
const { base, gateway } = await startGateway();
const failures = [];

/** The step on the screen now: its title, count, the lit area and its target, the card, and where focus is. */
const readStep = (page) => page.evaluate(() => {
  const card = document.querySelector('.tour-card');
  if (!card) return null;
  const spotEl = document.querySelector('.tour-spot');
  const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
  const name = spotEl?.getAttribute('data-tour-target') ?? null;
  const target = name ? document.querySelector(`[data-tour~="${name}"]`) : null;
  return {
    title: card.querySelector('.tour-title')?.textContent ?? '',
    count: card.querySelector('.tour-count')?.textContent ?? '',
    where: card.querySelector('.tour-where')?.textContent ?? '',
    name,
    spot: spotEl ? box(spotEl) : null,
    target: target ? box(target) : null,
    card: box(card),
    view: { w: innerWidth, h: innerHeight },
    focused: card.contains(document.activeElement),
    primary: [...card.querySelectorAll('button')].map((b) => b.textContent.trim()).find((x) => x === 'Next' || x === 'Done') ?? null,
    modal: card.getAttribute('aria-modal') === 'true' && !!card.getAttribute('aria-labelledby'),
  };
});

const overlaps = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
const tourState = (page) => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('wanigan.tours') ?? 'null'); } catch { return null; } });

const browser = await chromium.launch();
try {
  for (const theme of ['dark', 'light']) {
    const t = (m) => `${theme}/${m}`;
    const fail = (m) => failures.push(t(m));
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    // Before the bridge: it reads this when it is made. A first launch: nothing seen yet.
    await context.addInitScript(`try { localStorage.setItem('wanigan.test.tours', 'on'); } catch {}`);
    await context.addInitScript(BRIDGE);
    await context.addInitScript(`try { localStorage.setItem('wanigan.theme', '${theme}'); } catch {}`);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    await page.goto(base);
    await page.waitForSelector('.rail-projects a');

    // ── the welcome tour, by itself, once ──────────────────────────────────
    if (!(await page.waitForSelector('.tour-card', { timeout: 8000 }).catch(() => null))) fail('welcome: the welcome tour did not start on a first launch');
    const titles = [];
    for (let i = 0; i < 14; i++) {
      // A step settles in a frame or two: its card placed, and the lit area moved onto its target.
      await page.waitForFunction(() => {
        const card = document.querySelector('.tour-card');
        if (!card || card.style.opacity === '0') return !card;
        const spot = document.querySelector('.tour-spot');
        if (!spot) return true;
        const el = document.querySelector(`[data-tour~="${spot.getAttribute('data-tour-target')}"]`);
        if (!el) return false;
        const a = spot.getBoundingClientRect(); const b = el.getBoundingClientRect();
        return a.left <= b.left + 0.5 && a.top <= b.top + 0.5 && a.right >= b.right - 0.5 && a.bottom >= b.bottom - 0.5;
      }, null, { timeout: 3000 }).catch(() => {});
      const s = await readStep(page);
      if (!s) break;
      titles.push(s.title);
      if (!s.modal) fail(`welcome "${s.title}": the card is not a named modal dialog`);
      if (!s.focused) fail(`welcome "${s.title}": focus is not in the card`);
      if (s.card.l < 0 || s.card.t < 0 || s.card.r > s.view.w || s.card.b > s.view.h) fail(`welcome "${s.title}": the card is outside the window ${JSON.stringify(s.card)}`);
      if (s.name) {
        if (!s.target) fail(`welcome "${s.title}": the lit target "${s.name}" is not on the screen`);
        else if (!(s.spot.l <= s.target.l + 0.5 && s.spot.t <= s.target.t + 0.5 && s.spot.r >= s.target.r - 0.5 && s.spot.b >= s.target.b - 0.5)) fail(`welcome "${s.title}": the lit area does not hold "${s.name}"`);
        if (s.spot && overlaps(s.card, s.spot)) fail(`welcome "${s.title}": the card covers what it describes`);
      }
      if (i === 0) await page.screenshot({ path: join(out, `${theme}-tour-welcome.png`) });
      if (s.name === 'rail-projects') await page.screenshot({ path: join(out, `${theme}-tour-rail.png`) });
      if (s.name === 'project-views') await page.screenshot({ path: join(out, `${theme}-tour-views.png`) });
      if (i === 2) {
        // ← goes back a stop, → comes forward again; a window key (C, a new card) waits while the tour is up.
        await page.keyboard.press('ArrowLeft');
        const back = await readStep(page);
        if (back?.title !== titles[1]) fail(`welcome: ← from "${s.title}" showed "${back?.title}", not "${titles[1]}"`);
        await page.keyboard.press('c');
        await page.waitForTimeout(200);
        if (await page.$('.dialog')) fail('welcome: C opened a dialog under the tour');
        await page.keyboard.press('ArrowRight');
        const again = await readStep(page);
        if (again?.title !== s.title) fail(`welcome: → came back to "${again?.title}", not "${s.title}"`);
      }
      if (s.primary === 'Done') { await page.keyboard.press('Enter'); break; }
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction((was) => document.querySelector('.tour-title')?.textContent !== was || !document.querySelector('.tour-card'), s.title, { timeout: 4000 }).catch(() => {});
    }
    const want = ['Welcome to Wanigan', 'Your projects', 'Needs you', 'Sessions', 'One place for each job', 'Change the site in place', 'Find anything'];
    if (JSON.stringify(titles.slice(0, want.length)) !== JSON.stringify(want)) fail(`welcome: the stops were ${JSON.stringify(titles)}`);
    await page.waitForTimeout(200);
    if (await page.$('.tour-card')) fail('welcome: Done did not end the tour');
    if (!(await tourState(page))?.seen?.includes('welcome')) fail('welcome: ending it did not record it as seen');
    await page.reload();
    await page.waitForSelector('.rail-projects a');
    await page.waitForTimeout(1500);
    if (await page.$('.tour-card')) fail('welcome: it played again after it was seen');

    // ── a view's tour: the compass and the first-visit offer go together ───
    const nsHref = await page.$eval('.rail-projects a[aria-label^="Northstar"]', (a) => a.getAttribute('href'));
    const ns = nsHref.match(/#\/p\/([^/]+)/)[1];
    const places = [['board', `#/p/${ns}/board`], ['sessions', `#/p/${ns}/sessions`], ['changes', `#/p/${ns}/changes`], ['history', `#/p/${ns}/history`],
      ['decisions', `#/p/${ns}/decisions`], ['activity', `#/p/${ns}/activity`], ['list', `#/p/${ns}/list`], ['running', '#/running'], ['needs', '#/needs'], ['settings', '#/settings']];
    let offered = 0;
    for (const [place, hash] of places) {
      await page.goto(`${base}${hash}`);
      await page.waitForSelector('.status-line', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(300);
      const compass = await page.$('.status-tour');
      const offer = await page.$('.tour-offer');
      if (!compass) { if (offer) fail(`${place}: a tour is offered with no compass to replay it`); continue; }
      if (!offer) { fail(`${place}: the first visit did not offer the view's tour`); continue; }
      offered++;
      if (offered === 1) {
        await page.screenshot({ path: join(out, `${theme}-tour-offer.png`) });
        await page.click('.tour-offer button:has-text("Take the tour")');
        const first = await page.waitForSelector('.tour-card', { timeout: 4000 }).then(() => readStep(page)).catch(() => null);
        if (!first?.where.includes('Tour of')) fail(`${place}: Take the tour did not play it (${first?.where})`);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        if (await page.$('.tour-card')) fail(`${place}: Esc did not end the tour`);
        if (await page.$('.tour-offer')) fail(`${place}: the offer came back after the tour`);
        await page.click('.status-tour');
        if (!(await page.waitForSelector('.tour-card', { timeout: 4000 }).catch(() => null))) fail(`${place}: the compass did not replay the tour`);
        await page.keyboard.press('Escape');
      } else if (offered === 2) {
        await page.click('.tour-offer button[aria-label^="Not now"]');
        await page.reload();
        await page.waitForSelector('.status-line');
        await page.waitForTimeout(300);
        if (await page.$('.tour-offer')) fail(`${place}: Not now did not put the offer away for good`);
        if (!(await page.$('.status-tour'))) fail(`${place}: after Not now the compass is gone too`);
      }
    }

    // ── the board's and the List's tours: each stop lights what it names, its card in the window and beside it ──
    for (const [place, hash, want] of [
      ['board', `#/p/${ns}/board`, ['The lanes', 'A card', 'Move a card', 'Narrow the board', 'Saved views', 'New card', 'How this works']],
      ['list', `#/p/${ns}/list`, ['Every card', 'Sort', 'Walk the rows', 'Open a card', 'Board or List']],
    ]) {
      await page.goto(`${base}${hash}`);
      if (!(await page.waitForSelector('.status-tour', { timeout: 8000 }).catch(() => null))) { fail(`${place} tour: no compass`); continue; }
      await page.click('.status-tour');
      await page.waitForSelector('.tour-card', { timeout: 4000 }).catch(() => fail(`${place} tour: the compass did not play it`));
      const stops = [];
      for (let i = 0; i < 10; i++) {
        await page.waitForFunction(() => {
          const card = document.querySelector('.tour-card');
          if (!card || card.style.opacity === '0') return !card;
          const spot = document.querySelector('.tour-spot');
          if (!spot) return true;
          const el = document.querySelector(`[data-tour~="${spot.getAttribute('data-tour-target')}"]`);
          if (!el) return false;
          const a = spot.getBoundingClientRect(); const b = el.getBoundingClientRect();
          return a.left <= b.left + 0.5 && a.top <= b.top + 0.5 && a.right >= b.right - 0.5 && a.bottom >= b.bottom - 0.5;
        }, null, { timeout: 3000 }).catch(() => {});
        const s = await readStep(page);
        if (!s) break;
        stops.push(s.title);
        if (s.card.l < 0 || s.card.t < 0 || s.card.r > s.view.w || s.card.b > s.view.h) fail(`${place} tour "${s.title}": the card is outside the window`);
        if (!s.name) fail(`${place} tour "${s.title}": it points at nothing`);
        else if (!s.target) fail(`${place} tour "${s.title}": "${s.name}" is not on the screen`);
        else if (s.spot && overlaps(s.card, s.spot) && (s.spot.r - s.spot.l) * (s.spot.b - s.spot.t) < s.view.w * s.view.h * 0.5) fail(`${place} tour "${s.title}": the card covers what it describes`);
        if (s.name === 'board-card' || s.name === 'list-row') await page.screenshot({ path: join(out, `${theme}-tour-${place}.png`) });
        if (s.primary === 'Done') { await page.keyboard.press('Enter'); break; }
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction((was) => document.querySelector('.tour-title')?.textContent !== was || !document.querySelector('.tour-card'), s.title, { timeout: 4000 }).catch(() => {});
      }
      if (JSON.stringify(stops) !== JSON.stringify(want)) fail(`${place} tour: the stops were ${JSON.stringify(stops)}`);
      await page.waitForTimeout(200);
      if (await page.$('.tour-card')) fail(`${place} tour: Done did not end it`);
    }

    // ── the palette replays; Settings turns offers off and resets them ─────
    await page.goto(`${base}#/p/${ns}/board`);
    await page.waitForSelector('.status-line');
    await page.keyboard.press('Meta+k');
    await page.waitForSelector('.palette input, [role="combobox"]', { timeout: 4000 }).catch(() => fail('palette: did not open'));
    await page.keyboard.type('welcome tour');
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
    if (!(await page.waitForSelector('.tour-card', { timeout: 4000 }).catch(() => null))) fail('palette: Welcome tour did not play it');
    else {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      if (await page.$('.tour-card')) fail('palette: Esc did not end the replayed welcome tour');
    }
    await page.goto(`${base}#/settings`);
    const toggle = page.locator('label.toggle:has-text("Offer a view’s tour") input');
    if (!(await toggle.count())) fail('settings: no switch for first-visit tours');
    else {
      await toggle.click();
      if ((await tourState(page))?.off !== true) fail('settings: the switch did not turn first-visit tours off');
      await page.screenshot({ path: join(out, `${theme}-tour-settings.png`) });
      await toggle.click();
      await page.click('button:has-text("Offer every tour again")');
      const st = await tourState(page);
      if (st?.off !== false || st?.seen?.length || st?.dismissed?.length) fail(`settings: Offer every tour again left ${JSON.stringify(st)}`);
    }
    for (const e of errors) fail(e);
    await context.close();
  }
} finally {
  await browser.close();
  gateway.kill();
}
if (failures.length) {
  for (const f of failures) console.error(`✗ ${f}`);
  process.exit(1);
}
console.log(`Tour sweep passed. Screenshots in ${out}`);
