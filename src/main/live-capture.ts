// A page of the owner's site rendered in a hidden window so that two renders can be compared
// (docs/design/2026-10-09-design-layer.md, "Stage 3: verify"): the component library's pictures
// (live-library.ts) and the design layer's verification (live-layer.ts) both render this way.
//
// - The view's own session (its login, its certificate trust, the helper's token on page loads), never throttled
//   (backgroundThrottling off), one device pixel per CSS pixel, reduced motion asked for, focus emulated.
// - Only the site's own pages load: a link, a redirect or a script that would leave is stopped, and said.
// - What a render does once loaded is its caller's: settle() switches animations, transitions and the caret off and
//   waits for lazy images, fonts and two frames; grow() makes the viewport as tall as the page; shoot() takes it
//   through the DevTools protocol (Page.captureScreenshot), never capturePage, which takes only the viewport and
//   gives two device pixels a CSS pixel on a Retina screen.
// - No virtual time: whether DevTools virtual time works in Electron is still to be proved
//   (the design's "Still to prove"), so the settle waits are real time.
import { createHash } from 'node:crypto';
import type { Debugger, WebContents } from 'electron';
import { sameSite } from '../shared/live.ts';

/** Everything moving stopped, so a picture is the same each time it is taken. */
export const STILL_CSS = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}';

/** Lazy images loaded and decoded, fonts loaded, two frames drawn. */
const SETTLE = `(async () => {
  const images = Array.from(document.images);
  for (const img of images) if (img.loading === 'lazy') img.loading = 'eager';
  const decode = (img) => (img.decode ? img.decode().catch(() => {}) : null);
  await Promise.race([
    Promise.all(images.map((img) => (img.complete ? decode(img) : new Promise((done) => {
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    }).then(() => decode(img))))),
    new Promise((done) => setTimeout(done, 8000)),
  ]);
  if (document.fonts && document.fonts.ready) await Promise.race([document.fonts.ready, new Promise((done) => setTimeout(done, 5000))]);
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  return true;
})()`;

const DOCUMENT_HEIGHT = 'Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0))';
const FRAMES = 'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))';
const LOAD_MS = 30_000;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const originOf = (url: string): string => { try { return new URL(url).origin; } catch { return 'another address'; } };

/** A project id as a folder name: ids are opaque, so only safe characters are kept, and a hash keeps them apart. */
export function folderOf(projectId: string): string {
  const safe = projectId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return `${safe}-${createHash('sha256').update(projectId).digest('hex').slice(0, 8)}`;
}

/** A loaded page in a hidden window, for its caller to read and take. */
export interface HiddenPage {
  wc: WebContents;
  cdp: Debugger;
  /** CSS pixels wide, and the first screen's height. */
  width: number;
  screen: number;
  /** Run code in an isolated world of the page: the page's own scripts cannot reach it. */
  read<T>(code: string, fallback: T, world: number): Promise<T>;
  /** Animations, transitions and the caret off; lazy images, fonts and two frames waited for. */
  settle(): Promise<void>;
  /** The viewport grown to the page (up to `max` CSS pixels), again while the page grows with it: its height, and whether it was cut. */
  grow(max: number): Promise<{ height: number; cut: boolean }>;
  /** The page from its top, `height` CSS pixels tall, as a PNG at one device pixel per CSS pixel; null when nothing came. */
  shoot(height: number): Promise<Buffer | null>;
  /** The main document's response headers, names in lower case; null unless the network was watched, or none came. */
  headers(): Record<string, string> | null;
  /** Where the page tried to send the browser off the site, if it did. */
  left(): string | null;
}

export interface HiddenOptions {
  partition: string;
  url: string;
  /** The site's address: what the page may stay on. */
  base: string;
  width: number;
  /** Read the main document's response headers (a trace id). */
  network?: boolean;
  /** How what is rendered is named in what goes wrong: "The piece", "The page". */
  what: string;
  /** What is said when it throws: "The piece could not be pictured". */
  failed: string;
}

/** Render a page of the site in a hidden window and hand it to `during`; the window is always destroyed after. */
export async function inHiddenWindow<T>(o: HiddenOptions, during: (page: HiddenPage) => Promise<T | { error: string }>): Promise<T | { error: string }> {
  // Loaded here, not at the top: what is built on this runs, and is tested, without Electron's windows.
  const { BrowserWindow } = await import('electron');
  const screen = o.width < 600 ? 844 : 900;
  const mobile = o.width < 600;
  const w = new BrowserWindow({
    show: false, width: o.width, height: screen, useContentSize: true, enableLargerThanScreen: true, paintWhenInitiallyHidden: true,
    webPreferences: { partition: o.partition, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
  });
  const wc = w.webContents;
  let left: string | null = null;
  const stay = (event: { preventDefault(): void }, next: string): void => { if (!sameSite(o.base, next)) { event.preventDefault(); left ??= next; } };
  wc.on('will-navigate', stay);
  wc.on('will-redirect', stay);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.setAudioMuted(true);
  wc.setBackgroundThrottling(false);
  const cdp = wc.debugger;
  /** Document responses as the protocol reported them: which frame, and its headers. */
  const documents: { frameId: string; headers: Record<string, string> }[] = [];
  let mainFrame: string | null = null;
  const read = async <R>(code: string, fallback: R, world: number): Promise<R> => {
    try { return (await wc.executeJavaScriptInIsolatedWorld(world, [{ code }], true)) as R; } catch { return fallback; }
  };
  const metrics = (height: number): Promise<unknown> => cdp.sendCommand('Emulation.setDeviceMetricsOverride', { width: o.width, height, deviceScaleFactor: 1, mobile });
  try {
    // A window that has loaded nothing has no page for the protocol to act on: the first Emulation command sent to
    // one crashes Electron's main process (EXC_BAD_ACCESS, seen on 9 October 2026 on the first library picture).
    // An empty page first gives it one.
    await wc.loadURL('about:blank');
    cdp.attach('1.3');
    await metrics(screen);
    await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await cdp.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    if (o.network) {
      cdp.on('message', (_event, method, params: { type?: string; frameId?: string; response?: { headers?: Record<string, unknown> } }) => {
        if (method !== 'Network.responseReceived' || params.type !== 'Document' || !params.frameId || documents.length >= 50) return;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(params.response?.headers ?? {})) if (typeof v === 'string') headers[k.toLowerCase()] = v.slice(0, 4_000);
        documents.push({ frameId: params.frameId, headers });
      });
      await cdp.sendCommand('Network.enable');
    }
    // Never the browser's cached copy: the page is drawn as the site's files are now.
    const fresh = { extraHeaders: 'Cache-Control: no-cache\nPragma: no-cache\n' };
    const loaded = await Promise.race([wc.loadURL(o.url, fresh).then(() => true, () => false), pause(LOAD_MS).then(() => false)]);
    if (left) return { error: `${o.what} sent the browser off the site, to ${originOf(left)}; Wanigan does not follow it.` };
    if (!loaded) return { error: `${o.what} did not load within ${LOAD_MS / 1000} seconds.` };
    if (o.network) {
      try {
        const tree = await cdp.sendCommand('Page.getFrameTree') as { frameTree?: { frame?: { id?: string } } };
        mainFrame = tree.frameTree?.frame?.id ?? null;
      } catch { mainFrame = null; }
    }
    const page: HiddenPage = {
      wc, cdp, width: o.width, screen, read,
      async settle() {
        await wc.insertCSS(STILL_CSS);
        await read(SETTLE, false, 4_244);
      },
      async grow(max) {
        const tall = async (): Promise<number> => {
          const h = Number(await read(DOCUMENT_HEIGHT, screen, 4_244));
          return Number.isFinite(h) && h > 0 ? h : screen;
        };
        let height = await tall();
        let shown = screen;
        for (let round = 0; round < 3; round++) {
          const next = Math.max(screen, Math.min(max, height));
          if (next === shown) break;
          shown = next;
          await metrics(shown);
          await read(FRAMES, true, 4_244);
          await pause(300);
          height = await tall();
        }
        return { height: Math.min(max, height), cut: height > max };
      },
      async shoot(height) {
        const shot = await cdp.sendCommand('Page.captureScreenshot', {
          format: 'png', captureBeyondViewport: true, fromSurface: true, clip: { x: 0, y: 0, width: o.width, height: Math.max(1, height), scale: 1 },
        }) as { data?: string };
        return shot.data ? Buffer.from(shot.data, 'base64') : null;
      },
      headers() {
        const mine = documents.filter((d) => d.frameId === mainFrame);
        return mine.at(-1)?.headers ?? null;
      },
      left: () => left,
    };
    return await during(page);
  } catch (error) {
    return { error: `${o.failed}: ${(error as Error).message}` };
  } finally {
    try { if (cdp.isAttached()) cdp.detach(); } catch { /* the window is going anyway */ }
    w.destroy();
  }
}
