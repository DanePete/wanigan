#!/usr/bin/env node
// Snap and Record, in both themes, against the harness's real core (the demo)
// and the live sweep's stand-in view (scripts/ui-live-stub.mjs, with
// scripts/ui-snap-stub.mjs): a made-up acme page drawn as a wireframe, never a
// website. Screenshots go to .artifacts/live-snap/<theme>-<name>.png.
//
// The window: Snap (⇧S) takes the view's picture, an area is dragged over it,
// marked up (a box, an arrow, a label, a blur; undo and redo), and Ask an agent
// opens the note composer with the marked-up picture and the context (the
// address and width, the parts the area covers and what made them, the
// console's errors); the blur is in the pixels of the picture attached; sent,
// the agent is queued the picture and those words; Save to Notes keeps one
// unsent; the whole page and the whole view are taken too. Record (⇧R) shows
// Recording with the time in the bar and the status line, Escape stops it, and
// the review shows the clip (a WebM written by src/shared/webm.ts from frames
// Chromium encoded, played here), the key frames and the step log; Ask an
// agent attaches the key frames and the log, says no video goes, and sends.
//
// Then the page script itself, in a real Chromium page of made-up markup: a
// click is logged with the part under it, typing in a field is logged with its
// label, a password field's and a one-time code's typing is not (nor after the
// field is switched to show its words), a scroll is logged, and Escape stops.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { BRIDGE, root, startGateway } from './ui-harness.mjs';
import { liveFixture, liveStub } from './ui-live-stub.mjs';
import { LIVE_DEFAULTS } from './ui-live-defaults.mjs';
import { snapStub } from './ui-snap-stub.mjs';
import { webm } from '../src/shared/webm.ts';
import { cleanStep } from '../src/shared/live-record.ts';

const out = join(root, '.artifacts', 'live-snap');
mkdirSync(out, { recursive: true });
const failures = [];
const fail = (what) => { failures.push(what); console.error(`✗ ${what}`); };
const { base, gateway } = await startGateway({ demo: true, quiet: true });
const browser = await chromium.launch({ headless: true });

/** A clip for the review: wireframe frames encoded by this Chromium's VP8 encoder, written into WebM by webm.ts. */
async function makeClip() {
  const p = await browser.newPage();
  await p.goto(base);
  const encoded = await p.evaluate(async () => {
    if (typeof VideoEncoder !== 'function') return { error: 'no VideoEncoder' };
    const W = 640, H = 400;
    const cv = new OffscreenCanvas(W, H); const g = cv.getContext('2d');
    const chunks = [];
    let err = null;
    const enc = new VideoEncoder({
      output: (c) => { const b = new Uint8Array(c.byteLength); c.copyTo(b); chunks.push({ data: Array.from(b), at: c.timestamp / 1000, key: c.type === 'key' }); },
      error: (e) => { err = String(e); },
    });
    enc.configure({ codec: 'vp8', width: W, height: H, bitrate: 400_000, framerate: 5 });
    // A page that sits still for a while between moves, as a real one does: each frame keeps its own time.
    const times = [0, 200, 400, 600, 800, 1000, 2200, 2400, 2600, 3000, 3200, 3400, 3600, 3800, 4000];
    times.forEach((t, i) => {
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#cfd8de'; g.fillRect(0, 50, W, 160);
      g.fillStyle = '#eef1f3'; g.fillRect(420, 240, 200, 140 - i * 4);
      g.fillStyle = '#5b6770'; g.font = '20px sans-serif'; g.fillText(`Acme Bakery · ${t} ms`, 24, 140);
      const f = new VideoFrame(cv, { timestamp: t * 1000 });
      enc.encode(f, { keyFrame: i === 0 || t === 2200 });
      f.close();
    });
    await enc.flush();
    return { chunks, err };
  });
  await p.close();
  if (encoded.error || encoded.err) return { error: encoded.error ?? encoded.err };
  const bytes = webm({ codec: 'V_VP8', width: 640, height: 400 }, encoded.chunks.map((c) => ({ data: Uint8Array.from(c.data), at: c.at, key: c.key })), 4200);
  return { clip: Buffer.from(bytes).toString('base64') };
}

/** Pixels darker than the wireframe's boxes (its names, in dark grey) in a rectangle of a canvas or picture on the page. */
const darkIn = (page, selector, rect) => page.evaluate(async ([sel, r]) => {
  const el = document.querySelector(sel);
  if (!el) return -1;
  let source = el;
  if (el instanceof HTMLImageElement) { await el.decode().catch(() => {}); }
  const c = document.createElement('canvas');
  const w = el instanceof HTMLImageElement ? el.naturalWidth : el.width;
  const h = el instanceof HTMLImageElement ? el.naturalHeight : el.height;
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.drawImage(source, 0, 0);
  const px = g.getImageData(Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)).data;
  let n = 0;
  const where = [];
  for (let i = 0; i < px.length; i += 4) {
    if (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2] < 140) { n++; if (where.length < 6) where.push([(i / 4) % Math.round(r.width), Math.floor(i / 4 / Math.round(r.width)), px[i], px[i + 1], px[i + 2]]); }
  }
  return n && n < 20 ? { n, where } : n;
}, [selector, rect]);

try {
  const made = await makeClip();
  if ('error' in made) fail(`clip: this Chromium could not encode the review's clip (${made.error})`);
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, deviceScaleFactor: 2 });
    await context.addInitScript(BRIDGE);
    await context.addInitScript(`try { localStorage.setItem('wanigan.theme', '${theme}'); } catch {}`);
    await context.addInitScript(liveStub, liveFixture);
    await context.addInitScript(LIVE_DEFAULTS);
    await context.addInitScript(snapStub);
    await context.addInitScript((clip) => {
      window.__wgLive.consoleErrors = ['Uncaught TypeError: menu is null (/themes/custom/acme/js/menu.js:12)'];
      window.__wgLive.clip = clip;
    }, made.clip ?? null);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    const shot = (name) => page.screenshot({ path: join(out, `${theme}-${name}.png`), animations: 'disabled', style: '.toasts { visibility: hidden !important; }' });
    const t = (what) => `${theme}/${what}`;
    const nobody = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => { document.activeElement?.blur(); done(); }))));
    const sent = () => page.evaluate(() => window.__wgLive.sent.splice(0));
    /** Wait for the composer's send to reach the core's queue (a toast from an earlier send may still be up). */
    const queuedNow = (what) => page.waitForFunction(() => window.__wgLive.sent.some((s) => s.method === 'sessions.queue'), null, { timeout: 6000 }).catch(() => fail(t(what)));
    const phase = (p, what) => page.waitForSelector(`.live-stage-snap[data-phase="${p}"]`, { timeout: 5000 }).catch(() => fail(t(what)));

    await page.goto(`${base}#/p/NS/live`);
    await page.waitForSelector('.live-tree', { timeout: 15_000 }).catch(() => fail(t('the Live tab never showed the parts')));
    await page.waitForFunction(() => window.__wgLive.calls.includes('trace'), null, { timeout: 5000 }).catch(() => fail(t('the tab never asked for the trace')));

    // ── Snap: the bar's control and ⇧S, an area dragged over the picture.
    if (!(await page.$('.live-bar .live-tools button[aria-keyshortcuts="Shift+S"][aria-label^="Snap"]'))) fail(t('snap: no Snap tool with its name and key in the toolbar'));
    await nobody();
    await page.keyboard.press('Shift+S');
    await phase('area', 'snap: ⇧S did not open the snap on the view’s picture');
    if (!(await page.evaluate(() => window.__wgLive.calls.includes('snap view')))) fail(t('snap: the view was not pictured'));
    await page.waitForFunction(() => document.querySelector('#__wg_live_stub')?.style.visibility === 'hidden', null, { timeout: 2000 }).catch(() => fail(t('snap: the view did not step aside under the snap')));
    await shot('snap-area');
    // The sidebar's search, dragged over from a little outside it: in the picture's CSS pixels, then the screen's.
    const regions = await page.evaluate(() => window.wanigan.live.scan());
    const search = regions.find((r) => r.part === 'p-search')?.rect;
    const view = await page.evaluate(() => { const b = document.querySelector('#__wg_live_stub').getBoundingClientRect(); return { width: b.width, height: b.height }; });
    const area = await page.locator('.live-snap-area').boundingBox();
    const k = area.width / view.width;
    const from = { x: area.x + (search.x - 10) * k, y: area.y + (search.y - 10) * k };
    const to = { x: area.x + (search.x + search.width + 10) * k, y: area.y + (search.y + search.height + 10) * k };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    await phase('mark', 'snap: dragging over the picture did not choose that area');

    // Markup: a box, an arrow, a blur over the search's name, a label; undo one, redo it.
    const canvas = page.locator('.live-snap-mark canvas');
    const cb = await canvas.boundingBox();
    const size = await canvas.evaluate((c) => ({ width: c.width, height: c.height }));
    const drag = async (key, a, b) => {
      await page.keyboard.press(key);
      await page.mouse.move(cb.x + a[0] * cb.width, cb.y + a[1] * cb.height);
      await page.mouse.down();
      await page.mouse.move(cb.x + b[0] * cb.width, cb.y + b[1] * cb.height, { steps: 5 });
      await page.mouse.up();
    };
    await nobody();
    await drag('b', [0.66, 0.4], [0.95, 0.85]);
    await drag('a', [0.9, 0.95], [0.6, 0.6]);
    // The search's name is written at its top left (12, 24 px into its box), and the drag began 10 px outside the box.
    const blurCss = { x: 4, y: 8, width: 120, height: 34 };
    const kk = size.width / (search.width + 20);
    const blur = { x: blurCss.x * kk, y: blurCss.y * kk, width: blurCss.width * kk, height: blurCss.height * kk };
    // Read a little inside the blur's edges: a drag lands to the nearest pixel.
    const inside = { x: blur.x + 3, y: blur.y + 3, width: blur.width - 6, height: blur.height - 6 };
    const darkBefore = await darkIn(page, '.live-snap-mark canvas', inside);
    await drag('u', [blur.x / size.width, blur.y / size.height], [(blur.x + blur.width) / size.width, (blur.y + blur.height) / size.height]);
    await page.keyboard.press('t');
    await page.mouse.click(cb.x + 0.1 * cb.width, cb.y + 0.92 * cb.height);
    await page.waitForSelector('.live-snap-label', { timeout: 2000 }).catch(() => fail(t('snap: the label tool did not open a box for its words')));
    await page.keyboard.type('Results overlap');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /4 marks/.test(document.querySelector('.live-snap-foot')?.textContent ?? ''), null, { timeout: 2000 })
      .catch(async () => fail(t(`snap: four marks were not made (${await page.locator('.live-snap-foot').innerText().catch(() => '')})`)));
    await nobody();
    await page.keyboard.press('Meta+z');
    await page.waitForFunction(() => /3 marks/.test(document.querySelector('.live-snap-foot')?.textContent ?? ''), null, { timeout: 2000 }).catch(() => fail(t('snap: ⌘Z did not undo the last mark')));
    await page.keyboard.press('Meta+Shift+z');
    await page.waitForFunction(() => /4 marks/.test(document.querySelector('.live-snap-foot')?.textContent ?? ''), null, { timeout: 2000 }).catch(() => fail(t('snap: ⇧⌘Z did not redo it')));
    const darkAfter = await darkIn(page, '.live-snap-mark canvas', inside);
    if (!(darkBefore > 20) || darkAfter !== 0) fail(t(`snap: the blur left the words under it readable (${JSON.stringify(darkBefore)} dark pixels before, ${JSON.stringify(darkAfter)} after, in ${JSON.stringify(blur)} of ${JSON.stringify(size)})`));
    await shot('snap-markup');

    // Ask an agent: the composer, with the picture attached and the context in words the owner can change.
    await page.keyboard.press('Meta+Enter');
    await phase('compose', 'snap: Ask an agent did not open the composer');
    const ctx = await page.locator('textarea[aria-label="Context sent with it"]').inputValue().catch(() => '');
    for (const want of ['Page: https://acme.example.test/ (the view', 'Pictured: An area of the page', 'Search (block): template web/core/modules/search/templates/search-form-block.html.twig', 'block search_form_block@acme_search', 'Console errors on this page:', 'menu is null']) {
      if (!ctx.includes(want)) fail(t(`snap: the context does not say "${want}":\n${ctx}`));
    }
    if (!(await page.$('.live-snap-compose .live-compose-voice[data-slot="voice"]'))) fail(t('snap: no place beside the explanation for voice input'));
    if ((await darkIn(page, '.live-snap-picture img', inside)) !== 0) fail(t('snap: the picture to be attached still has the blurred words in its pixels'));
    await page.fill('textarea[aria-label="What is wrong, in your words"]', 'The search box sits on the sidebar’s heading.');
    await shot('snap-compose');
    await page.locator('.live-snap-compose button', { hasText: /^Send/ }).first().click();
    await queuedNow('snap: sending did not go to the agent');
    // The status line says only the latest outcome: what it said is kept by the stand-in (ui-live-stub.mjs).
    await page.waitForFunction(() => (window.__wgLive.said ?? []).some((x) => x.includes('Sent to')), null, { timeout: 6000 }).catch(() => fail(t('snap: sending did not say so')));
    // The session it went to is a click away, to watch it take the note.
    await page.waitForSelector('.status-line button:has-text("Open the session")', { timeout: 3000 }).catch(() => fail(t('snap: the sent message does not offer to open the session')));
    const snapSent = await sent();
    const pic = snapSent.filter((s) => s.method === 'attachments.save');
    const queued = snapSent.find((s) => s.method === 'sessions.queue');
    if (pic.length !== 1 || pic[0].name !== 'live-snap-1.png' || !pic[0].data.startsWith('iVBOR')) fail(t(`snap: what was attached: ${JSON.stringify(pic.map((p) => p.name))}`));
    if (!queued || queued.attachments !== 1 || !queued.text.includes('The search box sits on the sidebar’s heading.') || !queued.text.includes('search_form_block@acme_search')
      || !queued.text.includes('Attached, in this order: note 1: the marked-up picture.')) fail(t(`snap: the message queued: ${queued?.text}`));
    if (await page.$('.live-stage-snap')) fail(t('snap: the snap stayed open after it was sent'));

    // Save to Notes, from the whole view; the whole page; Escape closes.
    await nobody();
    await page.keyboard.press('Shift+S');
    await phase('area', 'snap: ⇧S again did not open it');
    await page.keyboard.press('w');
    await phase('mark', 'snap: W did not take the whole view');
    await page.keyboard.press('Meta+Enter');
    await phase('compose', 'snap: ⌘↩ did not open the composer');
    if (!(await page.locator('textarea[aria-label="Context sent with it"]').inputValue()).includes('Pictured: What the view showed')) fail(t('snap: the whole view is not said to be pictured'));
    await page.fill('textarea[aria-label="What is wrong, in your words"]', 'The hero is too tall on this page.');
    await page.keyboard.press('Meta+Enter');
    await page.waitForSelector('.status-line .dock-tabs button[aria-label^="Notes, 1 waiting"]', { timeout: 3000 }).catch(() => fail(t('snap: Save to Notes (⌘↩) did not keep it in Notes')));
    if ((await sent()).length) fail(t('snap: Save to Notes sent something'));
    await page.locator('.status-line .dock-tabs button[data-dock="notes"]').click();
    await page.waitForSelector('.live-note-item:has-text("Snap")', { timeout: 3000 }).catch(() => fail(t('snap: the Notes tab does not list the snap')));
    await nobody();
    await page.keyboard.press('Shift+S');
    await phase('area', 'snap: ⇧S did not open it a third time');
    await page.keyboard.press('f');
    await phase('mark', 'snap: F did not take the whole page');
    if (!(await page.evaluate(() => window.__wgLive.calls.includes('snap page')))) fail(t('snap: the whole page was not asked for'));
    await page.keyboard.press('Escape');
    await phase('area', 'snap: Escape on the whole page did not go back to the view’s picture');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.live-stage-snap', { state: 'detached', timeout: 2000 }).catch(() => fail(t('snap: Escape on the view’s picture did not close the snap')));
    await page.waitForFunction(() => document.querySelector('#__wg_live_stub')?.style.visibility !== 'hidden', null, { timeout: 2000 }).catch(() => fail(t('snap: the view did not come back')));

    // ── Straight to an agent with none running: Ask an agent offers Start Claude Code with this (the agent New session
    // would start here), and one click starts it in the project, saves the picture to it and queues the words, as a send
    // to a running session does; the status line says so and offers the session. Nothing starts until it is pressed.
    {
      await page.evaluate(() => { window.__wgLive.noAgents = true; window.__wgLive.sent.splice(0); });
      await nobody();
      await page.keyboard.press('Shift+S');
      await phase('area', 'start: ⇧S did not open the snap');
      await page.keyboard.press('w');
      await phase('mark', 'start: W did not take the whole view');
      await page.keyboard.press('Meta+Enter');
      await phase('compose', 'start: ⌘↩ did not open the composer');
      const startButton = page.locator('.live-snap-compose .live-start button', { hasText: /^Start Claude Code with this/ });
      await startButton.waitFor({ timeout: 3000 }).catch(() => fail(t('start: with no agent running, the composer does not offer Start Claude Code with this')));
      if (await page.$('.live-snap-compose button:has-text("Send to")')) fail(t('start: with no agent running, the composer still offers to send to one'));
      if ((await sent()).some((x) => x.method === 'sessions.start')) fail(t('start: a session started before anything was pressed'));
      await page.locator('.live-snap-compose .live-start-other').click();
      const others = await page.$$eval('[role="menu"] [role^="menuitem"]', (els) => els.map((e) => `${e.textContent}|${e.getAttribute('aria-disabled') ?? ''}`));
      if (!/^Start Claude Code with this/.test(others[0] ?? '') || !others.some((x) => /^Start Codex with this/.test(x)) || !others.some((x) => /^Gemini CLI: not from here.*\|true$/.test(x))) {
        fail(t(`start: the other agents offered are ${others.join(' | ')}`));
      }
      await page.keyboard.press('Escape');
      await page.fill('textarea[aria-label="What is wrong, in your words"]', 'The footer overlaps the hours on a phone.');
      await shot('start-offer');
      await startButton.click();
      await page.waitForFunction(() => window.__wgLive.sent.some((x) => x.method === 'sessions.queue' && x.queued !== null), null, { timeout: 15_000 })
        .catch(() => fail(t('start: the note never reached the started session’s queue')));
      const went = await sent();
      const started = went.find((x) => x.method === 'sessions.start');
      const saved = went.filter((x) => x.method === 'attachments.save');
      const queued = went.find((x) => x.method === 'sessions.queue');
      if (!started || started.provider !== 'claude') fail(t(`start: what started was ${JSON.stringify(started)}`));
      if (saved.length !== 1 || saved[0].session !== started?.session || saved[0].name !== 'live-snap-1.png') fail(t(`start: the picture went ${JSON.stringify(saved.map((x) => [x.name, x.session]))}`));
      if (!queued || queued.session !== started?.session || queued.attachments !== 1 || !queued.text.includes('The footer overlaps the hours on a phone.') || !(queued.queued >= 1)) {
        fail(t(`start: the started session's queue holds ${JSON.stringify(queued && { session: queued.session === started?.session, attachments: queued.attachments, queued: queued.queued })}`));
      }
      // The core holds it: the picture left the session's composer with the message.
      const composerLeft = started ? await page.evaluate((id) => window.wanigan.call('attachments.list', { to: { session: id } }), started.session) : null;
      if (!Array.isArray(composerLeft) || composerLeft.length) fail(t(`start: the picture did not go with the queued message (${JSON.stringify(composerLeft)})`));
      await page.waitForFunction(() => (window.__wgLive.said ?? []).some((x) => x.startsWith('Claude Code started on it')), null, { timeout: 3000 }).catch(() => fail(t('start: the status line did not say the agent started on it')));
      if (!(await page.$('.status-line button:has-text("Open the session")'))) fail(t('start: the status line does not offer the session'));
      if (await page.$('.live-stage-snap')) fail(t('start: the snap stayed open after it was handed over'));
      await shot('start-done');
      if (started) await page.evaluate((id) => window.wanigan.call('sessions.stop', { id }), started.session);
      await page.evaluate(() => { window.__wgLive.noAgents = false; window.__wgLive.sent.splice(0); });
    }

    // ── Record: ⇧R, Recording in sight with its time, Escape stops it, the review.
    await nobody();
    const record = page.locator('.live-bar .live-tools .live-record-btn');
    if ((await record.getAttribute('aria-keyshortcuts')) !== 'Shift+R' || !/^Record/.test(await record.getAttribute('aria-label') ?? '')) fail(t('record: no Record control with its name and key'));
    await page.keyboard.press('Shift+R');
    await page.waitForSelector('.live-record-btn.on[aria-pressed="true"]', { timeout: 3000 }).catch(() => fail(t('record: ⇧R did not start recording')));
    await page.waitForSelector('.status-line .live-status-said.live-recording:has-text("Recording the live view")', { timeout: 2000 }).catch(() => fail(t('record: the status line does not say it is recording')));
    const said = await page.locator('.visually-hidden[role="status"][aria-live="assertive"]').innerText().catch(() => '');
    if (!/Recording the live view/.test(said)) fail(t(`record: the start was not announced (${said})`));
    await page.waitForFunction(() => /0:0[1-9]/.test(document.querySelector('.live-record-btn .live-record-time')?.textContent ?? ''), null, { timeout: 3000 })
      .catch(() => fail(t('record: the time recorded does not count up')));
    await shot('record-on');
    await nobody();
    await page.keyboard.press('Escape');
    await page.waitForSelector('.live-record-review', { timeout: 4000 }).catch(() => fail(t('record: Escape did not stop it and show the review')));
    if (!(await page.evaluate(() => window.__wgLive.calls.includes('recordStop')))) fail(t('record: Escape did not stop the recording'));
    const frames = await page.$$eval('.live-record-review .live-record-frame img', (imgs) => imgs.length);
    if (frames !== 3) fail(t(`record: the review shows ${frames} key frames, not 3`));
    const steps = await page.locator('.live-record-steps').innerText().catch(() => '');
    for (const want of ['Clicked link “Opening hours” (in Opening hours, block; block block_content:hours@acme_hours)', 'Typed in a password field', 'Request failed: POST /cart/add answered 500', 'Said: “The hours vanish after I sign in.”']) {
      if (!steps.includes(want)) fail(t(`record: the step log does not say "${want}"`));
    }
    if (made.clip) {
      const played = await page.waitForFunction(() => { const v = document.querySelector('.live-record-review video'); return v && v.readyState >= 1 ? { duration: v.duration, w: v.videoWidth } : null; }, null, { timeout: 5000 })
        .then((h) => h.jsonValue()).catch(() => null);
      if (!played || Math.abs(played.duration - 4.2) > 0.05 || played.w !== 640) fail(t(`record: the clip did not play as written (${JSON.stringify(played)})`));
    }
    if (!/Kept in Wanigan’s own data on this computer, never in the site/.test(await page.locator('.live-record-kept').innerText().catch(() => ''))) fail(t('record: the review does not say where it is kept'));
    await shot('record-review');

    // Ask an agent: the key frames attached, the log as words, and no video, said.
    await page.keyboard.press('Meta+Enter');
    await page.waitForSelector('.live-record-review .live-compose', { timeout: 3000 }).catch(() => fail(t('record: Ask an agent did not open the composer')));
    const notice = await page.locator('.live-record-review .live-compose-notice').innerText().catch(() => '');
    if (!/Agents don’t receive video/.test(notice) || !/3 key frames/.test(notice)) fail(t(`record: the composer does not say what goes: ${notice}`));
    const log = await page.locator('textarea[aria-label="Context sent with it"]').inputValue().catch(() => '');
    if (!log.includes('Steps, from the start:') || !log.includes('0:00.9  Clicked link “Opening hours”') || log.includes('hunter2')) fail(t(`record: the log filled in:\n${log}`));
    await page.fill('textarea[aria-label="What is wrong, in your words"]', 'After signing in the opening hours are gone.');
    await shot('record-compose');
    await page.locator('.live-record-review .live-compose button', { hasText: /^Send/ }).first().click();
    await queuedNow('record: sending did not go to the agent');
    const recSent = await sent();
    const names = recSent.filter((s) => s.method === 'attachments.save').map((s) => s.name);
    const q = recSent.find((s) => s.method === 'sessions.queue');
    if (JSON.stringify(names) !== JSON.stringify(['live-recording-1-frame-1.jpg', 'live-recording-1-frame-2.jpg', 'live-recording-1-frame-3.jpg'])) fail(t(`record: attached ${JSON.stringify(names)}`));
    if (!q?.text.includes('A recording’s video stays with the owner') || !q.text.includes('3 key frames from the recording') || /webm/i.test(JSON.stringify(recSent.map((s) => s.name ?? '')))) fail(t(`record: the message queued: ${q?.text}`));
    if (errors.length) fail(t(`the page reported: ${errors.slice(0, 3).join(' | ')}`));
    await context.close();
  }

  // ── The page script itself, in a real page of made-up markup.
  const script = readFileSync(join(root, 'out/renderer/live-page.js'), 'utf8');
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await page.setContent(`<!doctype html><html><body style="margin:0;font:14px sans-serif">
<!-- THEME HOOK: 'block' -->
<!-- BEGIN OUTPUT from 'themes/custom/acme/templates/block--hours.html.twig' -->
<!-- wl:part id="p-hours" --><div id="hours" data-wl-block="block_content:hours@acme_hours" style="height:60px;background:#eee"><h2 style="margin:0">Opening hours</h2><p style="margin:0">7 to 6</p></div><!-- /wl:part id="p-hours" -->
<!-- END OUTPUT from 'themes/custom/acme/templates/block--hours.html.twig' -->
<form onsubmit="return false" style="padding:10px">
  <label>Search <input id="q" name="q"></label>
  <label>Password <input id="pw" type="password" name="pass"></label>
  <label>Code <input id="otp" name="code" autocomplete="one-time-code"></label>
  <a id="more" href="#more">More hours</a>
</form>
<div style="height:3000px"></div>
</body></html>`);
  await page.addScriptTag({ content: script });
  await page.evaluate(() => { window.__wl.scan(); window.__wl.recordOn(Date.now()); });
  // Below its heading and its words, so the click is on the block itself.
  await page.click('#hours', { position: { x: 5, y: 56 } });
  await page.click('#pw');
  await page.keyboard.type('hunter2');
  // A password field switched to show its words stays secret for the rest of the recording.
  await page.evaluate(() => { document.getElementById('pw').type = 'text'; });
  await page.keyboard.type('xyz');
  await page.click('#otp');
  await page.keyboard.type('424242');
  await page.click('#q');
  await page.keyboard.type('flour');
  await page.keyboard.press('Enter');
  await page.click('#more');
  await page.evaluate(() => window.scrollTo(0, 800));
  await page.waitForTimeout(700);
  const raw = await page.evaluate(() => window.__wl.recordOff().steps);
  const kinds = raw.map((s) => s.type);
  const click = raw.find((s) => s.type === 'click');
  if (click?.part !== 'p-hours' || click.target !== 'div “Opening hours 7 to 6”' || !/^template block--hours\.html\.twig/.test(click.made ?? '')) fail(`page script: the click was logged as ${JSON.stringify(click)}`);
  if (raw.find((s) => s.type === 'click' && s.target === 'link “More hours”') === undefined) fail('page script: a click on a link was not named by its words');
  const typed = raw.filter((s) => s.type === 'typed');
  const search = typed.find((s) => s.target === 'field “Search”');
  if (search?.text !== 'flour' || search.secret) fail(`page script: typing in the search was logged as ${JSON.stringify(search)}`);
  const secrets = typed.filter((s) => s.secret);
  if (secrets.length < 2 || secrets.some((s) => s.text !== null && s.text !== '')) fail(`page script: password and code typing logged as ${JSON.stringify(secrets)}`);
  const json = JSON.stringify(raw);
  for (const leak of ['hunter2', 'xyz', '424242']) if (json.includes(leak)) fail(`page script: "${leak}", typed in a secret field, is in the log`);
  if (!raw.some((s) => s.type === 'key' && s.key === 'Enter' && s.target === 'field “Search”')) fail(`page script: Enter in the search was not logged (${kinds.join(', ')})`);
  if (!raw.some((s) => s.type === 'scroll' && s.y === 800)) fail(`page script: the scroll was not logged (${kinds.join(', ')})`);
  // And through the main process's check, as it is kept.
  const kept = raw.map((s) => cleanStep(s, raw[0]?.time ?? 0, 'acme.example.test')).filter(Boolean);
  if (kept.length !== raw.length || JSON.stringify(kept).includes('hunter2')) fail('page script: a step did not survive the main process’s check, or kept a secret');
  // Escape, while nothing is typed into, stops the recording.
  await page.evaluate(() => { document.activeElement?.blur(); window.__stop = window.__wl.recordWait(Date.now()); });
  await page.keyboard.press('Escape');
  const stopped = await page.evaluate(() => Promise.race([window.__stop, new Promise((done) => setTimeout(() => done('no answer'), 2000))]));
  if (stopped?.stop !== true) fail(`page script: Escape answered ${JSON.stringify(stopped)}`);
  await page.close();
} finally {
  await browser.close();
  gateway.kill('SIGTERM');
}

if (failures.length) {
  console.error(`Snap and Record sweep failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`Snap and Record sweep passed. Screenshots in ${out}`);
