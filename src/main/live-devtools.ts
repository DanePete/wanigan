// The page's own Chromium DevTools, inside the window: drawn in a plain view
// laid over the dock's DevTools tab, or in a window of its own for a second
// screen. Built on the page view in live-view.ts, which tells it of each page
// view made or gone (LiveViewHooks.view). What each event does is the pure
// model in shared/live-devtools.ts; this runs its effects on the views.
//
// - Trust: DevTools belongs to the page's WebContents, which has no Node and
//   no Wanigan preload. The view DevTools is drawn in is plain too: sandboxed,
//   context-isolated, no preload, in an in-memory session of its own (never
//   Wanigan's own window's), never navigated anywhere but DevTools itself, and
//   it opens no window. A link DevTools opens goes to the default browser.
// - Electron draws DevTools into a view once: closing it in the dock is
//   destroying that view; opening it again makes a new one.
// - Chrome's DevTools chord (⌥⌘I on a Mac, Ctrl+Shift+I elsewhere) pressed in
//   the page or in DevTools runs the window's command, as the menu would: the
//   window decides whether the tab opens or closes.
// - Electron's isDevToolsOpened() says false for DevTools drawn in a view of
//   ours, and closeDevTools() leaves such a view showing it: where DevTools is
//   is this module's own record, and the dock's DevTools is closed only by
//   destroying its view.
// Design: docs/design/2026-10-08-live-view.md.
import { WebContentsView, ipcMain, nativeTheme, shell, type BrowserWindow, type Input, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { isDevtoolsKey } from '../shared/shortcuts.ts';
import {
  DEVTOOLS_CLOSED, devtoolsBox, devtoolsPoint, devtoolsStep, revealedOf,
  type DevtoolsEffect, type DevtoolsEvent, type DevtoolsModel, type LiveDevtoolsMode,
} from '../shared/live-devtools.ts';
import type { LiveViewHooks } from './live-view.ts';

/** The in-memory session the dock's DevTools view runs in: nothing of Wanigan's own window's, and nothing kept. */
const PARTITION = 'wanigan-live-devtools';

export function wireLiveDevtools(options: {
  window: () => BrowserWindow | null;
  trusted: (event: IpcMainInvokeEvent) => boolean;
  /** Whether the owner has the live view switched on. */
  enabled: () => boolean;
  /** Run code in the page script's isolated world (live-view.ts). */
  run: <T>(code: string, fallback: T) => Promise<T>;
  /** Run a window command, as the app menu does (the DevTools chord pressed in the page or in DevTools). */
  command: (id: 'live-devtools') => void;
  mac?: boolean;
}): { hooks: LiveViewHooks; mode(): LiveDevtoolsMode } {
  const mac = options.mac ?? process.platform === 'darwin';
  let model: DevtoolsModel = DEVTOOLS_CLOSED;
  let page: WebContents | null = null;
  /** The view the dock's DevTools is drawn in, while it is open there. */
  let dock: WebContentsView | null = null;
  /**
   * Whether the dock's DevTools has drawn itself: until then the view stays hidden over the tab's "Opening DevTools…",
   * which showed through as one white frame of an empty view (take devtools-d1, 9.1 s). Where it goes meanwhile is kept.
   */
  let dockPainted = false;
  let dockPlace: { visible: boolean; bounds: { x: number; y: number; width: number; height: number } | null } | null = null;
  /** DevTools closings this module caused itself, whose `devtools-closed` is not the owner closing its window. */
  let expected = 0;

  const ok = (event: IpcMainInvokeEvent): boolean => options.trusted(event) && options.enabled();
  const live = (wc: WebContents | null): wc is WebContents => !!wc && !wc.isDestroyed();
  const tell = (mode: LiveDevtoolsMode): void => {
    const w = options.window();
    if (w && !w.isDestroyed()) w.webContents.send('live:devtoolsMode', mode);
  };
  /** The chord, wherever it is pressed: the window's command, never the page's key nor Wanigan's own DevTools. */
  const chord = (e: { preventDefault(): void }, input: Input): void => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
    if (!isDevtoolsKey({ key: input.key, code: input.code, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift }, mac)) return;
    e.preventDefault();
    options.command('live-devtools');
  };

  const makeDock = (): void => {
    const w = options.window();
    if (!live(page) || !w || w.isDestroyed()) return;
    const v = new WebContentsView({
      webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
    });
    const wc = v.webContents;
    // DevTools itself, and nothing else: no window, no navigation away from it.
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event, url) => { if (!url.startsWith('devtools://')) event.preventDefault(); });
    wc.on('before-input-event', chord);
    const stopped = (): void => { if (dock === v) dispatch({ type: 'gone' }); };
    wc.on('render-process-gone', stopped);
    wc.on('destroyed', stopped);
    v.setVisible(false);
    w.contentView.addChildView(v);
    dock = v;
    dockPainted = false;
    dockPlace = null;
    // Shown once DevTools has drawn itself in its theme: built, and on a dark system its background dark (it paints a
    // light page first and applies its theme after, which showed as three seconds of white panel in a dark window,
    // take devtools-d2). At most 3 s on, for a frontend that never says.
    const shown = (): void => { if (dock !== v || dockPainted) return; dockPainted = true; place(); };
    const painted = `new Promise((done) => {
      const t0 = Date.now();
      const dark = matchMedia('(prefers-color-scheme: dark)').matches;
      const lum = (el) => { const m = /\\d+(\\.\\d+)?/g; const c = (getComputedStyle(el).backgroundColor.match(m) || []).map(Number); return c.length >= 3 && (c[3] ?? 1) > 0 ? 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] : null; };
      const themed = () => !dark || [document.body, document.documentElement].some((el) => el && lum(el) !== null && lum(el) < 128);
      const look = () => (document.body && document.body.childElementCount > 0 && themed()) || Date.now() - t0 > 2500
        ? requestAnimationFrame(() => requestAnimationFrame(() => done(true))) : setTimeout(look, 40);
      look();
    })`;
    wc.once('did-finish-load', () => { void wc.executeJavaScript(painted).catch(() => null).finally(shown); });
    setTimeout(shown, 3000);
    // DevTools follows the system's light or dark (its own default), told so: in the app its view saw light on a dark
    // Mac and drew a white panel in the dark window (take devtools-probe: system dark, DevTools prefers-color-scheme
    // light). Set on DevTools' own view before it loads, and again when the system changes.
    const scheme = (): void => {
      if (wc.isDestroyed()) return;
      void wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: nativeTheme.shouldUseDarkColors ? 'dark' : 'light' }] }).catch(() => {});
    };
    try { wc.debugger.attach('1.3'); scheme(); nativeTheme.on('updated', scheme); wc.once('destroyed', () => nativeTheme.off('updated', scheme)); } catch { /* left to DevTools */ }
    page.setDevToolsWebContents(wc);
    page.openDevTools({ mode: 'detach', activate: false });
  };

  /** The dock where the tab says, shown only once DevTools has drawn itself in it. */
  const place = (): void => {
    const p = dockPlace;
    if (!dock || !p) return;
    if (!p.visible || !p.bounds || p.bounds.width < 1 || p.bounds.height < 1) {
      // Stepping aside with the keyboard in it gives the keyboard back to the window.
      if (dock.webContents.isFocused()) options.window()?.webContents.focus();
      dock.setVisible(false);
      return;
    }
    dock.setBounds(p.bounds);
    dock.setVisible(dockPainted);
  };

  const undock = (): void => {
    const v = dock;
    dock = null;
    if (!v) return;
    const w = options.window();
    if (w && !w.isDestroyed()) w.contentView.removeChildView(v);
    // Destroying the view is what closes DevTools drawn in it (and resets the page's choice of view).
    if (live(page)) expected++;
    if (!v.webContents.isDestroyed()) v.webContents.close();
  };

  const effect = (e: DevtoolsEffect): void => {
    switch (e.do) {
      case 'dock': makeDock(); return;
      case 'undock': undock(); return;
      case 'detach':
        if (live(page)) page.openDevTools({ mode: 'detach', activate: true });
        return;
      case 'close-window':
        if (live(page) && page.isDevToolsOpened()) { expected++; page.closeDevTools(); }
        return;
      case 'place': {
        dockPlace = { visible: e.visible, bounds: e.bounds ?? null };
        place();
        return;
      }
      case 'inspect':
        if (live(page)) page.inspectElement(e.x, e.y);
        return;
      case 'tell': tell(e.mode);
    }
  };

  function dispatch(event: DevtoolsEvent): void {
    const step = devtoolsStep(model, event);
    model = step.model;
    for (const e of step.effects) effect(e);
  }

  /** Give DevTools the keyboard: in the dock's view, or its own window. */
  const focus = (): void => {
    if (dock && !dock.webContents.isDestroyed()) dock.webContents.focus();
    else if (live(page) && model.mode === 'detached') page.devToolsWebContents?.focus();
  };

  /** A page went away: its DevTools closes, with the page still the one the effects act on. */
  const pageGone = (): void => {
    if (page) dispatch({ type: 'page', page: null, project: null });
    page = null;
    expected = 0;
  };

  const hooks: LiveViewHooks = {
    // live-view.ts says a page went (null) before it says another came.
    view(wc, projectId) {
      if (page && page !== wc) pageGone();
      if (!wc) return;
      page = wc;
      expected = 0;
      wc.on('before-input-event', chord);
      // The owner closing DevTools' own window; closings this module made are not that.
      wc.on('devtools-closed', () => {
        if (page !== wc) return;
        if (expected > 0) { expected--; return; }
        if (model.mode === 'detached' && !wc.isDevToolsOpened()) dispatch({ type: 'gone' });
      });
      // A link DevTools opens (a request's address, a source's): the default browser, as links off the site go.
      wc.on('devtools-open-url', (_event, url) => { if (/^https?:\/\//i.test(url)) void shell.openExternal(url); });
      dispatch({ type: 'page', page: wc.id, project: projectId });
    },
  };

  ipcMain.handle('live:devtoolsShow', (event, raw: unknown, wantFocus: unknown): LiveDevtoolsMode => {
    if (!ok(event)) return 'closed';
    const bounds = devtoolsBox(raw);
    if (!bounds) return model.mode;
    dispatch({ type: 'show', bounds });
    // Opened by the owner's own key or control: the keyboard goes to it, as Chrome's does.
    if (wantFocus === true && model.mode === 'docked') focus();
    return model.mode;
  });
  ipcMain.on('live:devtoolsBounds', (event: IpcMainEvent, raw: unknown) => {
    if (!options.trusted(event as unknown as IpcMainInvokeEvent)) return;
    const bounds = devtoolsBox(raw);
    if (bounds) dispatch({ type: 'bounds', bounds });
  });
  ipcMain.handle('live:devtoolsHide', async (event, frame: unknown): Promise<string | null> => {
    if (!options.trusted(event)) return null;
    let picture: string | null = null;
    // Something covers it: its last picture stands in for it, as the page's does.
    if (frame === true && dock && model.shown && !dock.webContents.isDestroyed()) {
      try {
        const image = await dock.webContents.capturePage();
        picture = image.isEmpty() ? null : image.toDataURL();
      } catch {
        picture = null;
      }
    }
    dispatch({ type: 'hide' });
    return picture;
  });
  ipcMain.handle('live:devtoolsClose', (event) => { if (options.trusted(event)) dispatch({ type: 'close' }); });
  ipcMain.handle('live:devtoolsDetach', (event): boolean => {
    if (!ok(event)) return false;
    dispatch({ type: 'detach' });
    return model.mode === 'detached';
  });
  ipcMain.handle('live:devtoolsInspect', (event, x: unknown, y: unknown): boolean => {
    if (!ok(event) || !live(page)) return false;
    const at = devtoolsPoint(x, y);
    if (!at) return false;
    dispatch({ type: 'inspect', x: at.x, y: at.y });
    focus();
    return true;
  });
  // Show in DevTools: the part scrolled into view when none of it is on screen, and where it is then.
  ipcMain.handle('live:reveal', async (event, index: unknown) => {
    if (!ok(event) || (index !== null && (!Number.isInteger(index) || (index as number) < 0))) return null;
    const box = await options.run<unknown>(`window.__wl && window.__wl.reveal ? window.__wl.reveal(${JSON.stringify(index)}) : null`, null);
    return revealedOf(box);
  });

  return { hooks, mode: () => model.mode };
}
