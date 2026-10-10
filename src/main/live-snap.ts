// Snap, the main process's side: the picture a snap starts from. What the view
// shows now (capturePage of the view itself, with Wanigan's own outlines left
// out for that one frame), or the whole page, taken again in a hidden window at
// the view's width through live-capture.ts (the same render the component
// library pictures with), with its regions read as it was taken. The markup,
// the blur and the words around it are the window's (components/live/Snap.tsx):
// nothing here is kept or sent. Design: docs/design/2026-10-08-live-view.md, "Snap and Record".
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { LiveSnapShot } from '../shared/bridge.ts';
import type { LiveRegion } from '../shared/live.ts';
import { cleanRegions } from '../shared/live-agent.ts';
import type { LiveCurrent } from './live-view.ts';
import { inHiddenWindow } from './live-capture.ts';

/** The isolated world the page script runs in (live-view.ts). */
const WORLD = 4242;
/** The whole page is pictured down to here, as the before and after shots are. */
const PAGE_MAX_HEIGHT = 8_000;

const HIDE_MARKS = `(() => { const h = document.getElementById('__wanigan_live_overlay'); if (h) h.style.visibility = 'hidden';
  return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done({ x: Math.round(scrollX), y: Math.round(scrollY), w: innerWidth, h: innerHeight })))); })()`;
const SHOW_MARKS = `(() => { const h = document.getElementById('__wanigan_live_overlay'); if (h) h.style.visibility = ''; return true; })()`;

export function wireLiveSnap(options: {
  ipc: Pick<IpcMain, 'handle'>;
  trusted: (event: IpcMainInvokeEvent) => boolean;
  enabled: () => boolean;
  current: () => LiveCurrent | null;
  run: <T>(code: string, fallback: T) => Promise<T>;
  /** The view's width in CSS pixels, as the window laid it out. */
  width: (projectId: string) => number | null;
  /** The session a capture of a project's page runs in (live-view.ts `partition`). */
  partition: (projectId: string, env: string | null, url: string, token: string | null) => string;
  pageScript: () => string | null;
}): void {
  const { ipc } = options;
  const ok = (event: IpcMainInvokeEvent): boolean => options.trusted(event) && options.enabled();

  /** What the view shows now, at the screen's scale: Wanigan's outlines hidden for the frame taken, then put back. */
  const view = async (c: LiveCurrent): Promise<LiveSnapShot | null> => {
    const at = await options.run<{ x: number; y: number; w: number; h: number } | null>(HIDE_MARKS, null);
    try {
      const image = await c.webContents.capturePage();
      if (image.isEmpty()) return null;
      const size = image.getSize();
      const cssWidth = at && at.w > 0 ? at.w : options.width(c.projectId) ?? size.width;
      const cssHeight = at && at.h > 0 ? at.h : Math.round(size.height * (cssWidth / size.width));
      return {
        scope: 'view', data: image.toPNG().toString('base64'), width: size.width, height: size.height, cssWidth, cssHeight,
        scrollX: at?.x ?? 0, scrollY: at?.y ?? 0, url: c.webContents.getURL(), regions: null, cut: false,
      };
    } catch {
      return null;
    } finally {
      await options.run(SHOW_MARKS, false);
    }
  };

  /** The whole page, loaded again in a hidden window in the view's own session at the view's width. */
  const page = async (c: LiveCurrent): Promise<LiveSnapShot> => {
    const url = c.webContents.getURL();
    const width = Math.max(320, Math.min(2560, options.width(c.projectId) ?? 1280));
    const partition = options.partition(c.projectId, c.env, url, c.env ? null : c.token);
    const taken = await inHiddenWindow<LiveSnapShot>(
      { partition, url, base: c.base, width, what: 'The page', failed: 'The whole page could not be pictured' },
      async (p) => {
        await p.settle();
        const { height, cut } = await p.grow(PAGE_MAX_HEIGHT);
        const script = options.pageScript();
        let regions: LiveRegion[] = [];
        if (script) {
          await p.read(script, null, WORLD);
          regions = cleanRegions(await p.read<unknown>('window.__wl ? window.__wl.scan() : []', [], WORLD));
        }
        const png = await p.shoot(height);
        if (!png) return { error: 'The page could not be pictured.' };
        const { nativeImage } = await import('electron');
        const size = nativeImage.createFromBuffer(png).getSize();
        return {
          scope: 'page', data: png.toString('base64'), width: size.width, height: size.height, cssWidth: width, cssHeight: height,
          scrollX: 0, scrollY: 0, url: p.wc.getURL(), regions, cut,
        };
      },
    );
    return taken;
  };

  ipc.handle('live:snap', async (event, mode: unknown): Promise<LiveSnapShot | null> => {
    if (!ok(event) || (mode !== 'view' && mode !== 'page')) return null;
    const c = options.current();
    if (!c || c.webContents.isDestroyed()) return null;
    return mode === 'view' ? view(c) : page(c);
  });
}
