#!/usr/bin/env node
// Wanigan on a phone, end to end against a real seeded core, in both themes.
// The Mac's Settings › Phone turns phone access on (through the demo's
// stand-in Tailscale) and shows a pairing code; a phone-sized browser opens
// the real phone gateway, pairs with that code, then reads and acts: Needs
// you, a terminal, a new session, a new card accepted to Ready. Then the Mac
// makes it read-only and forgets it. Screenshots go to
// .artifacts/ui/<theme>-phone-*.png; look at them.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { BRIDGE, root, startGateway } from './ui-harness.mjs';

const out = join(root, '.artifacts', 'ui');
mkdirSync(out, { recursive: true });
const { base, gateway } = await startGateway();
const failures = [];
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
// A refused call is a 401 or 403 the page expects and says in its own words.
const EXPECTED = /status of (401|403)/;

function watchErrors(page, label, errors) {
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !EXPECTED.test(m.text())) errors.push(`${label} console: ${m.text()}`); });
}

/** What the QR code on the page says, read the way a camera would; null where the browser cannot read one. */
const decodeQr = (page) => page.evaluate(async () => {
  if (!('BarcodeDetector' in window)) return null;
  const svg = document.querySelector('svg.qr').cloneNode(true);
  for (const [cls, el] of [['qr-paper', 'rect'], ['qr-ink', 'path']]) {
    svg.querySelector(el).setAttribute('fill', getComputedStyle(document.querySelector(`svg.qr .${cls}`)).fill);
  }
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
  await img.decode();
  const canvas = Object.assign(document.createElement('canvas'), { width: 600, height: 600 });
  canvas.getContext('2d').drawImage(img, 0, 0, 600, 600);
  const [hit] = await new BarcodeDetector({ formats: ['qr_code'] }).detect(canvas);
  return hit?.rawValue ?? '';
});

const IPHONE = {
  safari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  chrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1',
};

const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const must = (promise, what) => promise.then(() => true, () => { failures.push(what); return false; });

const browser = await chromium.launch();
try {
  for (const theme of ['dark', 'light']) {
    const errors = [];
    const t = (what) => `${theme}/phone: ${what}`;
    const macContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme, deviceScaleFactor: 2 });
    await macContext.addInitScript(BRIDGE);
    await macContext.addInitScript(`try { localStorage.setItem('wanigan.theme', '${theme}'); } catch {}`);
    const mac = await macContext.newPage();
    watchErrors(mac, 'mac', errors);
    const section = mac.locator('section[aria-labelledby="set-phone"]');

    // From nothing: off, no phones (the first theme leaves both behind).
    await mac.goto(`${base}#/settings`);
    await mac.evaluate(async () => {
      for (const d of (await window.wanigan.call('phone.status', {})).devices) await window.wanigan.call('phone.forget', { id: d.id });
      await window.wanigan.call('phone.disable', {});
    });
    await mac.reload();
    await mac.waitForSelector('#set-phone');
    await must(section.getByText('Phone access is off').waitFor({ timeout: 5000 }), t('Settings does not say phone access is off'));
    const offText = await section.textContent();
    if (!offText.includes('connected as your-mac.example.ts.net')) failures.push(t('Settings does not say which Tailscale name this Mac has'));
    if (!offText.includes('tailscale serve --bg --https=443 --set-path=/wanigan http://127.0.0.1:47832')) failures.push(t('Settings does not show the command before it is run'));
    await section.scrollIntoViewIfNeeded();
    await section.screenshot({ path: join(out, `${theme}-phone-settings-off.png`) });

    // On, and a code to pair with.
    await section.getByRole('button', { name: 'Turn on phone access' }).click();
    await must(section.getByText('Phone access is on').waitFor({ timeout: 5000 }), t('turning it on is not said'));
    if (!(await section.textContent()).includes('https://your-mac.example.ts.net/wanigan/')) failures.push(t('Settings does not show the private address'));
    await section.getByRole('button', { name: 'Show a pairing code' }).click();
    await must(section.locator('svg.qr path').waitFor({ timeout: 5000 }), t('no QR code'));
    const code = (await section.locator('.phone-pair-code').textContent())?.trim() ?? '';
    if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) failures.push(t(`the pairing code reads "${code}"`));
    if (!(await section.locator('svg.qr').getAttribute('aria-label'))?.includes(code)) failures.push(t('the QR code does not say which code it holds'));
    await section.screenshot({ path: join(out, `${theme}-phone-settings-pairing.png`) });
    const decoded = await decodeQr(mac);
    if (decoded === null) console.log(`${theme}: this browser has no BarcodeDetector; the QR code was not decoded`);
    else if (decoded !== `https://your-mac.example.ts.net/wanigan/#pair=${code}`) failures.push(t(`the QR code holds "${decoded}"`));

    // The phone opens the address in the QR code, as the camera would.
    const { port } = await (await fetch(`${base}test/phone`)).json();

    // On an iPhone the code is kept for the Home Screen app; in Chrome there, one tap opens Safari.
    for (const [name, userAgent] of Object.entries(IPHONE)) {
      const iphone = await browser.newContext({ ...PHONE, userAgent, colorScheme: theme });
      const page = await iphone.newPage();
      watchErrors(page, `iphone-${name}`, errors);
      await page.goto(`http://127.0.0.1:${port}/wanigan/#pair=${code}`);
      await must(page.getByRole('heading', { name: 'Add Wanigan to your Home Screen' }).waitFor({ timeout: 5000 }), t(`an iPhone in ${name} is not told to add Wanigan to its Home Screen`));
      if (!(await page.textContent('.phone-pair'))?.includes(code)) failures.push(t(`an iPhone in ${name} is not shown the code to enter`));
      const safari = await page.getByRole('link', { name: 'Open in Safari' }).getAttribute('href', { timeout: 2000 }).catch(() => null);
      if (name === 'chrome' && safari !== `x-safari-http://127.0.0.1:${port}/wanigan/#pair=${code}`) failures.push(t(`Chrome on an iPhone has no Open in Safari (${safari})`));
      if (name === 'safari' && safari !== null) failures.push(t('Safari is offered Open in Safari'));
      await page.screenshot({ path: join(out, `${theme}-phone-iphone-${name}.png`) });
      await iphone.close();
    }
    const phoneContext = await browser.newContext({ ...PHONE, colorScheme: theme });
    await phoneContext.addInitScript(`try { localStorage.setItem('wanigan.theme', '${theme}'); } catch {}`);
    const phone = await phoneContext.newPage();
    watchErrors(phone, 'phone', errors);
    // Typed without its slash, as Tailscale would deliver it: the page moves under /wanigan/ and still loads.
    const typed = await phoneContext.newPage();
    watchErrors(typed, 'typed', errors);
    await typed.goto(`http://127.0.0.1:${port}/wanigan`);
    await must(typed.waitForURL(/\/wanigan\/$/, { timeout: 5000 }), t('/wanigan did not move to /wanigan/'));
    await must(typed.waitForSelector('#pair-title', { timeout: 5000 }), t('the page did not load at /wanigan'));
    await typed.close();
    await phone.goto(`http://127.0.0.1:${port}/wanigan/#pair=${code}`);
    await phone.waitForSelector('#pair-title');
    if ((await phone.getByLabel('Code').inputValue()) !== code) failures.push(t('the QR code did not fill in the code'));
    await phone.getByLabel('This phone’s name').fill('Test Phone');
    await phone.screenshot({ path: join(out, `${theme}-phone-pair.png`) });
    await phone.getByRole('button', { name: 'Pair' }).click();
    await must(phone.waitForSelector('.phone-tabs', { timeout: 8000 }), t('pairing did not open the app'));
    await must(section.locator('.phone-devices').getByText('Test Phone').waitFor({ timeout: 5000 }), t('the Mac does not list the paired phone'));
    await must(mac.getByText('Test Phone is paired.').waitFor({ timeout: 3000 }), t('the Mac does not say the phone paired'));
    if (await section.locator('svg.qr').count()) failures.push(t('the used code is still showing'));
    if (!(await section.getByRole('button', { name: 'Send a test notification' }).isDisabled())) failures.push(t('a test notification is offered with no phone taking them'));
    await section.screenshot({ path: join(out, `${theme}-phone-settings-paired.png`) });

    // Needs you.
    await must(phone.waitForSelector('.phone-group', { timeout: 8000 }), t('Needs you shows nothing from the seeded world'));
    if (!(await noSideScroll(phone))) failures.push(t('Needs you scrolls sideways'));
    await phone.screenshot({ path: join(out, `${theme}-phone-needs.png`), fullPage: true });

    // A running terminal, typed into from the phone: its own, started on the Mac, so nothing earlier is in it.
    const typedIn = `Typed from the phone (${theme})`;
    const shellId = await mac.evaluate(async (title) => {
      const project = (await window.wanigan.call('projects.list', {})).find((p) => p.pathOk && !p.pausedAt);
      return (await window.wanigan.call('sessions.start', { projectId: project.id, provider: 'shell', title, cols: 100, rows: 32 })).id;
    }, typedIn);
    await phone.getByRole('button', { name: 'Sessions' }).click();
    await phone.locator('.phone-row', { hasText: typedIn }).waitFor({ timeout: 8000 });
    await phone.screenshot({ path: join(out, `${theme}-phone-sessions.png`), fullPage: true });
    await phone.locator('.phone-row', { hasText: typedIn }).click();
    await phone.waitForSelector('.phone-terminal .xterm-rows');
    await phone.locator('.phone-terminal').click();
    await phone.keyboard.type('echo from-phone-$((40+2))');
    await phone.getByRole('button', { name: 'Enter' }).click();
    if (!(await phone.waitForSelector('.xterm-rows:has-text("from-phone-42")', { timeout: 15_000 }).then(() => true, () => false))) {
      // Which half failed: the keys reaching the Mac, or the output coming back.
      const onMac = await mac.evaluate(async (id) => (await window.wanigan.call('sessions.watch', { id })).replay, shellId);
      failures.push(t(/from-phone-42/.test(onMac) ? 'what was typed ran on the Mac, but its output never reached the phone' : `what was typed on the phone never reached the Mac (its terminal: ${JSON.stringify(onMac.slice(-200))})`));
    }
    if (!(await noSideScroll(phone))) failures.push(t('a session scrolls sideways'));
    await phone.screenshot({ path: join(out, `${theme}-phone-session.png`) });

    // A new session, started from the phone.
    await phone.getByRole('button', { name: 'New', exact: true }).click();
    await phone.waitForSelector('#new-title');
    await phone.getByRole('radio', { name: 'Shell' }).click();
    if (!(await noSideScroll(phone))) failures.push(t('New session scrolls sideways'));
    await phone.setViewportSize({ width: 360, height: 740 });
    if (!(await noSideScroll(phone))) failures.push(t('New session scrolls sideways at 360px'));
    await phone.setViewportSize(PHONE.viewport);
    await phone.screenshot({ path: join(out, `${theme}-phone-new.png`), fullPage: true });
    await phone.getByRole('button', { name: 'Start Shell' }).click();
    await must(phone.waitForSelector('#session-title', { timeout: 8000 }), t('starting a session did not open it'));

    // A card made and accepted on the phone, which Activity says was the phone.
    await phone.getByRole('button', { name: 'Boards' }).click();
    await phone.locator('.phone-row').first().click();
    await phone.waitForSelector('#board-title');
    await phone.screenshot({ path: join(out, `${theme}-phone-board.png`), fullPage: true });
    // A small phone: five columns scroll in their own row; the page never does.
    await phone.setViewportSize({ width: 360, height: 740 });
    if (!(await noSideScroll(phone))) failures.push(t('a board scrolls sideways at 360px'));
    await phone.setViewportSize(PHONE.viewport);
    await phone.getByRole('button', { name: 'New card' }).click();
    await phone.getByLabel('Title').fill(`Made on the phone (${theme})`);
    await phone.getByRole('button', { name: 'Add to Inbox' }).click();
    await must(phone.getByText(/is in the Inbox/).waitFor({ timeout: 5000 }), t('a new card was not added'));
    await phone.getByRole('radio', { name: /^Inbox/ }).click();
    await phone.locator('.phone-row', { hasText: `Made on the phone (${theme})` }).click();
    await phone.waitForSelector('#card-title');
    await phone.getByRole('button', { name: 'Accept' }).click();
    await must(phone.getByText(/accepted to Ready/).waitFor({ timeout: 5000 }), t('accepting a card is not said'));
    await phone.screenshot({ path: join(out, `${theme}-phone-card.png`), fullPage: true });
    const actors = await mac.evaluate(async (title) => {
      const projects = await window.wanigan.call('projects.list', {});
      for (const p of projects) {
        const card = (await window.wanigan.call('cards.list', { projectId: p.id })).find((c) => c.title === title);
        if (card) return (await window.wanigan.call('cards.get', { id: card.id })).activity.map((a) => a.actor);
      }
      return [];
    }, `Made on the phone (${theme})`);
    if (!actors.length || !actors.every((a) => a === 'phone:Test Phone')) failures.push(t(`Activity does not say the phone did it (${actors.join(', ')})`));

    await phone.getByRole('button', { name: 'This phone' }).click();
    await phone.waitForSelector('#phone-title');
    await phone.screenshot({ path: join(out, `${theme}-phone-this-phone.png`), fullPage: true });

    // Read-only: the Mac takes away acting, and the phone is told why it cannot.
    await section.locator('.phone-devices').getByLabel('Can act').uncheck();
    await phone.getByRole('button', { name: 'New', exact: true }).click();
    await phone.getByRole('radio', { name: 'Shell' }).click();
    await phone.getByRole('button', { name: 'Start Shell' }).click();
    await must(phone.getByText(/Test Phone may only read/).waitFor({ timeout: 5000 }), t('a read-only phone acting is not refused in words'));

    // Forgotten: the phone is back at pairing, at once.
    await section.locator('.phone-devices').getByRole('button', { name: 'Forget' }).click();
    await section.locator('.phone-forget').getByRole('button', { name: 'Forget' }).click();
    await must(phone.waitForSelector('#pair-title', { timeout: 10_000 }), t('a forgotten phone did not go back to pairing'));
    await phone.screenshot({ path: join(out, `${theme}-phone-forgotten.png`) });

    await section.getByRole('button', { name: 'Turn off' }).click();
    await must(section.getByText('Phone access is off').waitFor({ timeout: 5000 }), t('turning it off is not said'));
    failures.push(...errors.map((e) => `${theme}/${e}`));
    await phoneContext.close();
    await macContext.close();
  }
} finally {
  await browser.close();
  gateway.kill('SIGTERM');
}

if (failures.length) {
  console.error(`Phone sweep failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`Phone sweep passed. Screenshots in ${out}`);
