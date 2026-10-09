// Full-page pictures for comparing a page of the local site with the same
// page on a hosted environment (Dev, Test, Live). Each is taken in a hidden
// window the way the card's before and after are (src/main/live-view.ts
// shoot): the local side in the live view's own session, so its login,
// certificate trust and helper token apply; the hosted side in that
// environment's private, read-only session, which never gets the token. Only
// on the owner's Compare: nothing here runs on its own. The local side also
// reads what made each part of the page, so each change can be named.
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { LiveCompareShot } from '../shared/bridge.ts';
import { COMPARE_MAX_HEIGHT, type CompareWidth } from '../shared/live-compare.ts';
import { sameSite, type LiveRegion } from '../shared/live.ts';
import { compareRequest } from './live-compare-request.ts';
import type { LiveViewWiring } from './live-view.ts';

/** The isolated world the page script runs in inside a capture window (the live view's own is 4242). */
const WORLD = 4243;
const LOAD_MS = 30_000;
/** After the load: late content, web fonts, a first animation frame. */
const SETTLE_MS = 1_500;
const MAX_REGIONS = 2_000;
/** Pictures being taken at once: a comparison takes two. */
const MAX_AT_ONCE = 4;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export function wireLiveCompare(options: {
  trusted: (event: IpcMainInvokeEvent) => boolean;
  enabled: () => boolean;
  view: () => LiveViewWiring | null;
}): void {
  let taking = 0;
  ipcMain.handle('live:compareShot', async (event, raw: unknown): Promise<LiveCompareShot> => {
    if (!options.trusted(event)) return { error: 'Untrusted sender.' };
    if (!options.enabled()) return { error: 'The live view is off (Settings › Live view).' };
    const request = compareRequest(raw);
    const view = options.view();
    if (!request || !view) return { error: 'That is not a page Wanigan can compare.' };
    if (taking >= MAX_AT_ONCE) return { error: 'Wanigan is already taking pictures for a comparison. Wait for it to finish.' };
    taking++;
    try {
      const partition = view.partition(request.projectId, request.env, request.url, request.token);
      return await capture(partition, request.url, request.width, request.scan ? view.pageScript() : null);
    } finally {
      taking--;
    }
  });
}

/** Load a page in a hidden window at a width, grow the window to the page, and take it whole. */
async function capture(partition: string, url: string, width: CompareWidth, script: string | null): Promise<LiveCompareShot> {
  const host = new URL(url).host;
  const w = new BrowserWindow({
    show: false, width, height: 900, useContentSize: true, enableLargerThanScreen: true, paintWhenInitiallyHidden: true,
    webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
  });
  const wc = w.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, next) => { if (!sameSite(url, next)) e.preventDefault(); });
  wc.setAudioMuted(true);
  let failed: string | null = null;
  let status = 0;
  wc.on('did-fail-load', (_e, code, description, _u, isMainFrame) => { if (isMainFrame && code !== -3) failed = description; });
  wc.on('did-navigate', (_e, _u, code) => { status = code; });
  try {
    // Never the browser's cached copy: both sides are as their sites serve them now.
    const fresh = { extraHeaders: 'Cache-Control: no-cache\nPragma: no-cache\n' };
    const loaded = await Promise.race([wc.loadURL(url, fresh).then(() => true, () => false), pause(LOAD_MS).then(() => false)]);
    if (!loaded) {
      const why = failed as string | null;
      return { error: why ? `${host} did not load: ${why}` : `${host} did not answer within ${LOAD_MS / 1000} seconds.` };
    }
    await pause(SETTLE_MS);
    // A page grows as it settles at its size (late content, images that load once in view): grow the window to the
    // page, and again, until the height holds.
    let tall = 0;
    const measure = async (): Promise<number> => {
      const n = Number(await wc.executeJavaScript('Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, document.scrollingElement ? document.scrollingElement.scrollHeight : 0))'));
      tall = Number.isFinite(n) ? n : 900;
      return Math.max(300, Math.min(COMPARE_MAX_HEIGHT, tall));
    };
    let height = 900;
    for (let round = 0; round < 4; round++) {
      const next = await measure();
      if (next === height && round > 0) break;
      height = next;
      w.setContentSize(width, height);
      await pause(round === 0 ? 1_200 : 600);
    }
    let regions: LiveRegion[] = [];
    if (script) {
      try {
        await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: script }]);
        const found = await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: 'window.__wl ? window.__wl.scan() : []' }], true) as LiveRegion[];
        regions = Array.isArray(found) ? found.slice(0, MAX_REGIONS) : [];
      } catch { /* a page that would not be read is still compared; its changes are not named */ }
    }
    const image = await wc.capturePage();
    if (image.isEmpty()) return { error: `${host} drew nothing to take a picture of.` };
    const size = image.getSize();
    return {
      data: image.toPNG().toString('base64'), width: size.width, height: size.height,
      cssWidth: width, cssHeight: height, cut: tall > COMPARE_MAX_HEIGHT, url: wc.getURL() || url, status, regions,
    };
  } catch (error) {
    return { error: `${host} could not be pictured: ${(error as Error).message}` };
  } finally {
    w.destroy();
  }
}
