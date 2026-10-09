// The hidden window every comparable render uses (live-capture.ts). Windows cannot be opened under this test
// runner; what is checked here are the rules a change could quietly undo.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { CLOCK, folderOf, inHiddenWindow } from './live-capture.ts';
import { captureInWindow } from './live-library.ts';

test('a hidden window is given a page before the debugger acts on it: the first Emulation command on an empty one crashes Electron', () => {
  // Reproduced end to end on a demo site on 9 October 2026; this keeps the line that stops it above the attach.
  const src = inHiddenWindow.toString();
  const blank = src.indexOf("loadURL('about:blank')"), attach = src.indexOf("attach('1.3')"), emulate = src.indexOf('await metrics(screen)');
  assert.ok(blank > 0 && attach > blank && emulate > attach, 'about:blank is loaded before the debugger attaches and emulates');
  assert.match(captureInWindow.toString(), /inHiddenWindow/, 'the library’s pictures render through it');
});

test('pictures are taken through the protocol at one device pixel per CSS pixel, never capturePage', () => {
  const src = inHiddenWindow.toString();
  assert.match(src, /deviceScaleFactor: 1/);
  assert.match(src, /Page\.captureScreenshot/);
  assert.doesNotMatch(src, /capturePage\(/);
});

test('a project’s folder name keeps only safe characters, and a hash keeps two projects apart', () => {
  assert.match(folderOf('p1'), /^p1-[0-9a-f]{8}$/);
  assert.notEqual(folderOf('a/b'), folderOf('ab'));
  assert.doesNotMatch(folderOf('../../etc'), /[./]/);
});

test('a verification’s page runs on its own clock, put in before the page loads, with scrollbars hidden', () => {
  const src = inHiddenWindow.toString();
  const clock = src.indexOf('Page.addScriptToEvaluateOnNewDocument'), page = src.indexOf('wc.loadURL(o.url');
  assert.ok(clock > 0 && page > clock, 'the clock is added before the page is navigated to');
  assert.match(src, /Emulation\.setScrollbarsHidden/);
});

test('the injected clock: time stands still until it is advanced, then timers and frames run in order, and chance is seeded', () => {
  const run = () => {
    const page = vm.createContext({ performance: { now: () => 123.4 } });
    page.window = page;
    vm.runInContext(CLOCK, page);
    return page;
  };
  const page = run();
  // Values cross from the page's realm as JSON: its arrays are not this realm's.
  const at = (code: string): unknown => JSON.parse(vm.runInContext(`JSON.stringify((() => { return ${code}; })())`, page) ?? 'null');
  assert.equal(at('Date.now()'), Date.UTC(2026, 0, 1, 9, 0, 0));
  assert.equal(at('new Date().toISOString()'), '2026-01-01T09:00:00.000Z');
  assert.equal(at('new Date(0).getTime()'), 0, 'a date the page names is that date');
  assert.equal(at('performance.now()'), 0);
  vm.runInContext(`globalThis.seen = [];
    setTimeout(() => seen.push('timeout 100 at ' + performance.now()), 100);
    const every = setInterval(() => { seen.push('interval at ' + performance.now()); if (seen.length > 3) clearInterval(every); }, 40);
    requestAnimationFrame((t) => seen.push('frame at ' + t));
    setTimeout(() => seen.push('never'), 5000);`, page);
  assert.deepEqual(at('seen.slice()'), [], 'nothing runs until the clock moves');
  assert.equal(at('__wlClock.tick(3000)'), 3000);
  assert.deepEqual(at('seen.slice()'), ['frame at 16', 'interval at 40', 'interval at 80', 'timeout 100 at 100', 'interval at 120']);
  assert.equal(at('Date.now()'), Date.UTC(2026, 0, 1, 9, 0, 3));
  assert.equal(at('new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "numeric", minute: "numeric", second: "numeric", hour12: false }).format()'), '09:00:03', 'the time of day a page prints is the clock’s');
  const draws = (p: vm.Context): unknown => JSON.parse(vm.runInContext('JSON.stringify([Math.random(), Math.random()])', p));
  assert.deepEqual(draws(run()), draws(run()), 'the same numbers on every load');
  assert.equal(at('Object.keys(window).includes("__wlClock")'), false, 'not enumerable on the page');
});
