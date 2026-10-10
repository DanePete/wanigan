// The hidden window every comparable render uses (live-capture.ts). Windows cannot be opened under this test
// runner; what is checked here are the rules a change could quietly undo.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { CLOCK, folderOf, inHiddenWindow, type HiddenPage, type HiddenWindow } from './live-capture.ts';
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

/**
 * A hidden window played by a stand-in: it answers everything at once, except the one step named, which it never
 * answers (a page whose script waits on the clock it stopped, a renderer that is stuck). It records what was done to it.
 */
function standIn(hang: 'tick' | 'height' | 'snapshot' | 'picture' | null): { window: HiddenWindow; log: string[] } {
  const log: string[] = [];
  const never = new Promise<never>(() => {});
  let attached = false;
  const wc = {
    on: () => wc, setWindowOpenHandler: () => {}, setAudioMuted: () => {}, setBackgroundThrottling: () => {},
    getURL: () => 'https://acme.example.test/paddling',
    loadURL: async () => {},
    insertCSS: async () => 'key',
    executeJavaScript: (code: string) => (hang === 'tick' && code.includes('tick(3000)') ? never : Promise.resolve(0)),
    executeJavaScriptInIsolatedWorld: (_world: number, scripts: { code: string }[]) => {
      const code = scripts[0]?.code ?? '';
      if (hang === 'height' && code.includes('scrollHeight')) return never;
      if (hang === 'snapshot' && code.includes('layerSnap')) return never;
      return Promise.resolve(code.includes('scrollHeight') ? 900 : null);
    },
    debugger: {
      attach: () => { attached = true; log.push('attach'); },
      isAttached: () => attached,
      detach: () => { attached = false; log.push('detach'); },
      on: () => {},
      sendCommand: (method: string) => (hang === 'picture' && method === 'Page.captureScreenshot' ? never : Promise.resolve(method === 'Page.captureScreenshot' ? { data: Buffer.from('png').toString('base64') } : {})),
    },
  };
  return { log, window: { webContents: wc as never, destroy: () => { log.push('destroy'); } } };
}

/** What a verification's render does with its page, in order: run its clock, grow it, measure it, picture it. */
const render = async (page: HiddenPage): Promise<string> => {
  await page.freeze();
  const { height } = await page.grow(6_000);
  await page.read('window.__wl.layerSnap()', [], 4242);
  return (await page.shoot(height, true)) ? 'pictured' : 'no picture';
};
const options = { partition: 'persist:test', url: 'https://acme.example.test/paddling', base: 'https://acme.example.test/', width: 390, freeze: true, what: 'The page', failed: 'The page could not be rendered' };

test('every step of a hidden render has a deadline: a page that never answers fails the render, saying where, and its window goes', { timeout: 10_000 }, async () => {
  const fine = standIn(null);
  assert.equal(await inHiddenWindow({ ...options, open: () => fine.window, stepMs: 50 }, render), 'pictured', 'a page that answers is rendered');
  assert.deepEqual(fine.log, ['attach', 'detach', 'destroy']);
  for (const [hang, step] of [['tick', 'its clock was advanced'], ['height', 'it was read'], ['snapshot', 'it was read'], ['picture', 'it was pictured']] as const) {
    const stuck = standIn(hang);
    const started = Date.now();
    const answer = await inHiddenWindow({ ...options, open: () => stuck.window, stepMs: 50 }, render);
    assert.deepEqual(answer, { error: `The page could not be rendered: it did not answer within 50 ms while ${step}, so its window was closed` }, hang);
    assert.deepEqual(stuck.log, ['attach', 'detach', 'destroy'], `${hang}: the debugger detached and the window destroyed`);
    assert.ok(Date.now() - started < 2_000, `${hang}: no step after the stuck one waited out its own deadline`);
  }
  // The render as a whole has an end too, for what it waits on besides the page.
  const slow = standIn(null);
  const forever = await inHiddenWindow({ ...options, open: () => slow.window, stepMs: 50, renderMs: 80 }, () => new Promise<string>(() => {}));
  assert.deepEqual(forever, { error: 'The page could not be rendered: it did not answer within 80 ms while it was rendered, so its window was closed' });
  assert.deepEqual(slow.log, ['attach', 'detach', 'destroy']);
});
