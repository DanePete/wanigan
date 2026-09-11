#!/usr/bin/env node
// The handover bubble, in the real renderer with every service a fixture.
//
// The decision function is unit-tested in src/shared/context-handover.test.ts.
// What this proves is different: that the shipped bundle renders the bubble on
// a reading it should speak for, stays silent on the readings it must not, and
// that both look right at a phone width as well as a desktop one.
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url), { _electron } = require('playwright-core');
const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'docs/visuals/context-handover', 'after');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-handover-'));
writeFileSync(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1280,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(dir, 'main.cjs'), `--user-data-dir=${dir}/profile`], env });

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`);
  if (!ok) { failures += 1; if (detail !== undefined) console.log(`      ${JSON.stringify(detail)}`); }
};
const errors = [];

/**
 * Only the context reading is ours, and it is wrapped rather than spread.
 *
 * The stub bridge is Proxy-based — `anything()` synthesises namespaces on
 * access — so `{...window.wanigan}` keeps only own enumerable keys and quietly
 * drops the rest. Doing that cost an afternoon here: the page threw on
 * `startup.status` of undefined, which reads like a fixture problem and was
 * really the spread. Each reading arrives in the URL so this script is added
 * once rather than stacked per case.
 */
const FIXTURE = `
  const base = window.wanigan;
  const params = new URLSearchParams(location.search);
  const raw = params.get('ctx');
  const lim = params.get('lim');
  const reading = raw ? JSON.parse(decodeURIComponent(raw)) : null;
  const known = lim ? JSON.parse(decodeURIComponent(lim)) : null;
  const wrap = (name, method, value) => (target) => new Proxy(Reflect.get(target, name), {
    get: (t, k) => (k === method ? (async () => value) : Reflect.get(t, k)),
  });
  // The harness session fixture carries accountLabel but no accountId, and the
  // limit message attaches to an account id — so give it one here rather than
  // changing the shared fixture out from under twenty other probes.
  if (reading || known) window.wanigan = new Proxy(base, {
    get(target, key) {
      if (key === 'transcripts' && reading) return wrap('transcripts', 'context', reading)(target);
      if (key === 'usage' && known) return wrap('usage', 'known', known)(target);
      if (key === 'sessions' && known) {
        const inner = Reflect.get(target, key);
        return new Proxy(inner, {
          get: (t, k) => (k === 'list'
            ? (async () => (await t.list()).map((row) => (row.id === 's1' ? { ...row, accountId: 'work' } : row)))
            : Reflect.get(t, k)),
        });
      }
      return Reflect.get(target, key);
    },
  });
`;

const ok = (over = {}) => ({ kind: 'ok', tokens: 180000, window: 200000, percent: 90,
  model: 'claude-opus-5', at: Date.now(), conversationMatch: 'exact', windowSource: 'cli-reported', ...over });

try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.addInitScript(STUB);
  await page.addInitScript(FIXTURE);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('pageerror', (e) => errors.push(`${e.message} :: ${String(e.stack||'').split('\n')[1]||''}`.slice(0,200)));

  // The harness's own session s1 runs as account 'work'; these fixtures speak
  // about that account so the bubble has something to attach to.
  const limitsFor = (percent, extra = []) => ({ at: Date.now(), limits: [
    { accountId: 'work', accountLabel: 'Work', harness: 'claude-code', identity: null, state: 'ok',
      detail: null, fetchedAt: Date.now(), plan: 'Max', factors: [],
      windows: [{ kind: 'week', scope: null, usedPercent: percent, resetsAtText: 'Friday 4:15pm', resetsAt: Date.now() + 3600000 }] },
    ...extra ] });

  const cases = [
    ['a measured window at 90% speaks', ok(), true, undefined],
    ['an assumed window stays silent', ok({ windowSource: 'assumed-200k' }), false, undefined],
    ['a stale reading stays silent', ok({ at: Date.now() - 130_000 }), false, undefined],
    ['an ordinary 50% stays silent', ok({ percent: 50, tokens: 100000 }), false, undefined],
    ['a reached account limit speaks', ok({ percent: 50, tokens: 100000 }), true, limitsFor(96)],
    ['stale limits stay silent', ok({ percent: 50, tokens: 100000 }), false,
      { at: Date.now() - 11 * 60_000, limits: limitsFor(96).limits }],
  ];

  for (const [label, reading, expected, limits] of cases) {
    const q = [`ctx=${encodeURIComponent(JSON.stringify(reading))}`];
    if (limits !== undefined) q.push(`lim=${encodeURIComponent(JSON.stringify(limits))}`);
    await page.goto(`${rendererURL}?${q.join('&')}`);
    await page.waitForTimeout(1800);
    // The orb follows the *active* session, and nothing is active until one is
    // opened — so open it the way a person would.
    await page.evaluate(() => {
      const go = [...document.querySelectorAll('button')].find((b) => /Projects|Sessions/.test(b.textContent || ''));
      go?.click();
    });
    await page.waitForTimeout(900);
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('button, [role="tab"]')].find((b) => /Checkout bug|storefront/.test(b.textContent || ''));
      row?.click();
    });
    await page.waitForTimeout(2200);
    const shown = await page.evaluate(() => document.querySelectorAll('.handover-bubble').length > 0);
    check(shown === expected, label, { shown, expected });
    if (expected && shown) {
      const text = await page.evaluate(() => document.querySelector('.handover-bubble')?.innerText);
      console.log('      ' + String(text).split('\n').join(' / '));
      const wide = await page.evaluate(() => {
        const b = document.querySelector('.handover-bubble');
        const r = b.getBoundingClientRect();
        const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + 12));
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left),
          right: Math.round(r.right), vw: window.innerWidth, vh: window.innerHeight,
          onTop: !!hit && (hit === b || b.contains(hit)) };
      });
      check(wide.top >= 0 && wide.bottom <= wide.vh && wide.left >= 0 && wide.right <= wide.vw && wide.onTop,
        'it is actually visible at desktop width, not merely present in the DOM', wide);
      await page.screenshot({ path: path.join(out, 'bubble-1280.png'), clip: { x: 0, y: 420, width: 640, height: 480 } });
      await page.setViewportSize({ width: 430, height: 900 });   // a phone
      await page.waitForTimeout(600);
      // Horizontal fit is not the same as visible. A bubble anchored above the
      // companion can sit above the top of a short viewport, or behind the
      // dock, and still measure a sane width — so this asks the document what
      // is actually painted at the middle of it.
      const fits = await page.evaluate(() => {
        const b = document.querySelector('.handover-bubble');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + 12));
        return {
          left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom),
          vw: window.innerWidth, vh: window.innerHeight,
          onTop: !!hit && (hit === b || b.contains(hit)),
        };
      });
      check(fits !== null && fits.left >= 0 && fits.right <= fits.vw,
        'and it fits inside a phone-width viewport without overflowing', fits);
      check(fits !== null && fits.top >= 0 && fits.bottom <= fits.vh,
        'and sits inside the viewport vertically rather than above its top edge', fits);
      check(fits !== null && fits.onTop,
        'and is the thing actually painted there, not covered by the dock', fits);
      await page.screenshot({ path: path.join(out, 'bubble-430.png') });
      await page.setViewportSize({ width: 1280, height: 900 });
    }
  }
  check(errors.length === 0, 'the renderer raised no page errors', errors.slice(0, 2));
} catch (e) {
  check(false, 'the handover probe completed', String(e).slice(0, 160));
} finally {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures === 0 ? '\n════ handover probe passed ════' : `\n════ ${failures} failed ════`);
process.exit(failures === 0 ? 0 : 1);
