// The live view's window side: one WebContentsView laid over a placeholder the
// window positions, showing the owner's local site. It runs in its own session
// per project (so a login there stays, and never mixes with Wanigan's own
// page), sandboxed and context-isolated, with no preload: the main process
// injects out/renderer/live-page.js into an isolated world and reads its
// answers directly. It stays on the site's own host; anything else opens in the
// default browser. Design: docs/design/2026-10-08-live-view.md.
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow, WebContentsView, ipcMain, session, shell, type IpcMainInvokeEvent, type Session } from 'electron';
import { liveUrl, sameSite, type LivePick, type LiveProblem, type LiveRegion } from '../shared/live.ts';
import type { LiveBounds, LiveViewState } from '../shared/bridge.ts';

/** The isolated world the page script runs in: the page's own scripts cannot reach it. */
const WORLD = 4242;
const MAX_SCAN = 2_000;
/** What the page's console said went wrong since it last loaded, newest kept. */
const MAX_CONSOLE = 40;
/** The style properties a hand edit may try (the page script holds the same list). */
const STYLE_VALUE = /^[^;{}<>]{0,120}$/;

export interface LiveViewWiring {
  /** The window went away: drop the view. */
  release(): void;
  /**
   * A full-page screenshot of a page of a project's site, taken in a hidden
   * window in the same session as the live view (its login, its certificate
   * trust, the helper's token). Null when the page did not load or drew nothing.
   */
  shoot(projectId: string, url: string, token: string | null): Promise<{ data: string; width: number; height: number } | null>;
}

/** Screenshots are a desktop page: this many CSS pixels wide, and as tall as the page up to a limit. */
const SHOT_WIDTH = 1440;
const SHOT_MAX_HEIGHT = 8_000;
const SHOT_LOAD_MS = 30_000;
/** After the load: late content, web fonts, a first animation frame. */
const SHOT_SETTLE_MS = 1_500;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

let pageScript: string | null | undefined;

/** The page script, built beside the window's page; null when this build has none (dev without a build). */
function script(): string | null {
  if (pageScript !== undefined) return pageScript;
  try { pageScript = readFileSync(join(__dirname, '../renderer/live-page.js'), 'utf8'); } catch { pageScript = null; }
  return pageScript;
}

let authority: X509Certificate | null | undefined;

/**
 * The owner's own local certificate authority, if mkcert made one: ddev signs
 * every *.ddev.site certificate with it (`mkcert -CAROOT`, or $CAROOT). Read,
 * never written; when mkcert has not been installed into the system's trust
 * store, this is how the view can still trust exactly those certificates.
 */
function localAuthority(): X509Certificate | null {
  if (authority !== undefined) return authority;
  const root = process.env.CAROOT || join(homedir(), 'Library', 'Application Support', 'mkcert');
  try {
    const pem = readFileSync(join(root, 'rootCA.pem'), 'utf8');
    authority = pem.length < 64 * 1024 ? new X509Certificate(pem) : null;
  } catch {
    authority = null;
  }
  return authority;
}

/**
 * Whether a certificate Chromium refused is one the owner's local authority
 * issued for this host, and is in date. Nothing else is overruled.
 */
function issuedLocally(pem: string, hostname: string): boolean {
  const ca = localAuthority();
  if (!ca || !ca.ca) return false;
  try {
    const leaf = new X509Certificate(pem);
    const now = Date.now();
    return leaf.issuer === ca.subject && leaf.verify(ca.publicKey) && leaf.checkHost(hostname) !== undefined
      && Date.parse(leaf.validFrom) <= now && now <= Date.parse(leaf.validTo);
  } catch {
    return false;
  }
}

/** A partition name for a project: Electron wants a plain string; ids are opaque, so keep only safe characters. */
function partitionFor(projectId: string): string {
  return `persist:wanigan-live-${projectId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)}`;
}

function bounds(raw: unknown): LiveBounds | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null);
  const x = n(b.x); const y = n(b.y); const width = n(b.width); const height = n(b.height);
  return x === null || y === null || width === null || height === null ? null : { x, y, width: Math.min(width, 10_000), height: Math.min(height, 10_000) };
}

export function wireLiveView(options: {
  window: () => BrowserWindow | null;
  trusted: (event: IpcMainInvokeEvent) => boolean;
  /** Whether the owner has the live view switched on. */
  enabled: () => boolean;
}): LiveViewWiring {
  let view: WebContentsView | null = null;
  let projectId: string | null = null;
  let base: string | null = null;
  let attached = false;
  let lastError: LiveViewState['error'] = null;
  let logged: LiveProblem[] = [];
  const prepared = new Set<string>();
  /** The host each project's view may load, for its certificate check. */
  const hosts = new Map<string, string>();
  /** The token each project's site helper answers to: sent with the view's own page loads to that host, and nothing else. */
  const tokens = new Map<string, string>();

  const send = (): void => {
    const w = options.window();
    if (!w || w.isDestroyed()) return;
    const wc = view?.webContents;
    const state: LiveViewState = wc && !wc.isDestroyed() ? {
      projectId, url: wc.getURL() || base, title: wc.getTitle(), loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(), error: lastError,
      logged: logged.length,
    } : { projectId: null, url: null, title: '', loading: false, canGoBack: false, canGoForward: false, error: null, logged: 0 };
    w.webContents.send('live:state', state);
  };

  /**
   * Lock a project's session down once: no permissions, no downloads, no new
   * windows. Certificates are Chromium's verdict, except that one the owner's
   * own mkcert authority issued for this project's site is trusted here.
   */
  const prepare = (ses: Session, partition: string, id: string): void => {
    if (prepared.has(partition)) return;
    prepared.add(partition);
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (event) => event.preventDefault());
    // The helper's token goes with the pages the view itself loads (and its frames), never with the page's own
    // fetches: a script on the page cannot borrow it to call the helper.
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const token = tokens.get(id);
      const host = hosts.get(id);
      if (token && host && (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame')) {
        try { if (new URL(details.url).hostname === host) details.requestHeaders['X-Wanigan-Live'] = token; } catch { /* not a URL: leave it */ }
      }
      callback({ requestHeaders: details.requestHeaders });
    });
    ses.setCertificateVerifyProc((request, callback) => {
      if (request.errorCode === 0) { callback(0); return; }
      const host = hosts.get(id);
      callback(host && request.hostname === host && issuedLocally(request.certificate.data, request.hostname) ? 0 : -3);
    });
  };

  const inject = async (): Promise<void> => {
    const code = script();
    const wc = view?.webContents;
    if (!code || !wc || wc.isDestroyed()) return;
    try { await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]); } catch { /* a page that went away mid-load */ }
  };

  const run = async <T>(code: string, fallback: T): Promise<T> => {
    const wc = view?.webContents;
    if (!wc || wc.isDestroyed() || !script()) return fallback;
    try {
      await inject();
      return (await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }], true)) as T;
    } catch {
      return fallback;
    }
  };

  const drop = (): void => {
    const w = options.window();
    if (view) {
      if (attached && w && !w.isDestroyed()) w.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
    view = null;
    projectId = null;
    base = null;
    attached = false;
    lastError = null;
    logged = [];
  };

  const create = (id: string): WebContentsView => {
    const partition = partitionFor(id);
    const ses = session.fromPartition(partition);
    prepare(ses, partition, id);
    const v = new WebContentsView({
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
    });
    const wc = v.webContents;
    // Off the site is outside the view: the default browser, never a frame of Wanigan's.
    const leave = (event: { preventDefault(): void }, url: string): void => {
      if (base && sameSite(base, url)) return;
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    };
    wc.on('will-navigate', leave);
    wc.on('will-redirect', leave);
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('dom-ready', () => { void inject(); });
    wc.on('did-start-navigation', (details) => { if (details.isMainFrame && !details.isSameDocument) logged = []; });
    wc.on('console-message', (details) => {
      // Electron's own advice to app developers is not the site's problem.
      if ((details.level !== 'error' && details.level !== 'warning') || details.message.includes('Electron Security Warning')) return;
      const where = details.sourceId ? ` (${details.sourceId.replace(/^https?:\/\/[^/]+/, '')}:${details.lineNumber})` : '';
      logged = [...logged, { level: details.level, text: `${details.message.slice(0, 400)}${where}`, source: 'console' as const }].slice(-MAX_CONSOLE);
      send();
    });
    for (const name of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated'] as const) {
      wc.on(name as 'did-stop-loading', () => {
        if (name === 'did-start-loading') lastError = null;
        send();
      });
    }
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      // -3 is an aborted load (a new navigation replaced it): not a failure.
      if (!isMainFrame || code === -3) return;
      lastError = { code, description, url };
      send();
    });
    wc.on('render-process-gone', (_e, details) => {
      lastError = { code: -1, description: `The page stopped (${details.reason}).`, url: wc.getURL() };
      send();
    });
    return v;
  };

  const ok = (event: IpcMainInvokeEvent): boolean => options.trusted(event) && options.enabled();

  ipcMain.handle('live:show', async (event, rawProject: unknown, rawUrl: unknown, rawBounds: unknown, rawToken: unknown) => {
    if (!ok(event)) return false;
    if (typeof rawProject === 'string' && rawProject) {
      if (typeof rawToken === 'string' && /^[0-9a-f]{16,128}$/.test(rawToken)) tokens.set(rawProject, rawToken); else tokens.delete(rawProject);
    }
    const w = options.window();
    const url = liveUrl(rawUrl);
    const b = bounds(rawBounds);
    if (!w || w.isDestroyed() || typeof rawProject !== 'string' || !rawProject || !url || !b) return false;
    if (projectId !== rawProject) {
      drop();
      view = create(rawProject);
      projectId = rawProject;
    }
    const v = view as WebContentsView;
    if (!attached) { w.contentView.addChildView(v); attached = true; }
    v.setBounds(b);
    v.setVisible(true);
    if (!base || !sameSite(base, url) || !v.webContents.getURL()) {
      base = url;
      hosts.set(rawProject, new URL(url).hostname);
      lastError = null;
      void v.webContents.loadURL(url).catch(() => {});
    }
    send();
    return true;
  });

  ipcMain.on('live:bounds', (event, rawBounds: unknown) => {
    if (!options.trusted(event as unknown as IpcMainInvokeEvent)) return;
    const b = bounds(rawBounds);
    if (b && view) view.setBounds(b);
  });

  ipcMain.handle('live:hide', (event) => {
    if (!options.trusted(event)) return;
    const w = options.window();
    if (view && attached && w && !w.isDestroyed()) { w.contentView.removeChildView(view); attached = false; }
  });

  // A dialog over the view: a native view draws above the page, so it steps aside and leaves its last frame.
  ipcMain.handle('live:cover', async (event, covered: unknown) => {
    if (!options.trusted(event) || !view) return null;
    if (covered === true) {
      let frame: string | null = null;
      try { frame = (await view.webContents.capturePage()).toDataURL(); } catch { frame = null; }
      view.setVisible(false);
      return frame;
    }
    view.setVisible(true);
    return null;
  });

  ipcMain.handle('live:reload', (event, hard: unknown) => {
    if (!ok(event) || !view) return;
    if (hard === true) view.webContents.reloadIgnoringCache(); else view.webContents.reload();
  });
  ipcMain.handle('live:go', (event, rawUrl: unknown) => {
    if (!ok(event) || !view || !base) return false;
    const url = liveUrl(rawUrl);
    if (!url || !sameSite(base, url)) return false;
    void view.webContents.loadURL(url).catch(() => {});
    return true;
  });
  ipcMain.handle('live:back', (event) => { if (ok(event) && view?.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack(); });
  ipcMain.handle('live:forward', (event) => { if (ok(event) && view?.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward(); });
  ipcMain.handle('live:open', (event) => {
    const url = view?.webContents.getURL();
    if (ok(event) && url && /^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  ipcMain.handle('live:devtools', (event) => { if (ok(event) && view) view.webContents.openDevTools({ mode: 'detach' }); });

  ipcMain.handle('live:css', async (event) => {
    if (!ok(event)) return 0;
    const swapped = await run<number>('window.__wl ? window.__wl.css() : 0', 0);
    // Aggregated stylesheets, or none the script could reach: only a reload shows the edit.
    if (swapped <= 0) view?.webContents.reload();
    return swapped;
  });
  ipcMain.handle('live:scan', async (event) => {
    if (!ok(event)) return [];
    const regions = await run<LiveRegion[]>('window.__wl ? window.__wl.scan() : []', []);
    return Array.isArray(regions) ? regions.slice(0, MAX_SCAN) : [];
  });
  ipcMain.handle('live:outline', async (event, indexes: unknown, label: unknown, tone: unknown) => {
    if (!ok(event)) return 0;
    const list = Array.isArray(indexes) ? indexes.filter((i): i is number => Number.isInteger(i) && i >= 0).slice(0, 200) : [];
    const text = typeof label === 'string' ? label.slice(0, 200) : null;
    const how = tone === 'hover' || tone === 'pick' ? tone : 'edit';
    return run<number>(`window.__wl ? window.__wl.outline(${JSON.stringify(list)}, ${JSON.stringify(text)}, ${JSON.stringify(how)}) : 0`, 0);
  });
  ipcMain.handle('live:clear', async (event) => { if (ok(event)) await run('window.__wl && window.__wl.clear()', null); });
  ipcMain.handle('live:pick', async (event) => {
    if (!ok(event)) return null;
    view?.webContents.focus();
    return run<LivePick | null>('window.__wl ? window.__wl.pick() : null', null);
  });
  ipcMain.handle('live:cancelPick', async (event) => { if (options.trusted(event)) await run('window.__wl && window.__wl.cancelPick()', null); });
  // The site helper's own routes, asked through the view's session (so as the user logged in there), with the token.
  ipcMain.handle('live:helper', async (event, action: unknown, rawBody: unknown) => {
    if (!ok(event) || !view || !base || !projectId) return null;
    const token = tokens.get(projectId);
    if (!token) return null;
    const origin = new URL(view.webContents.getURL() || base).origin;
    const headers = { 'X-Wanigan-Live': token, Accept: 'application/json' };
    try {
      if (action === 'changed') {
        const res = await view.webContents.session.fetch(`${origin}/_wanigan/changed`, { headers, credentials: 'include' });
        const data = await res.json() as { changed?: unknown };
        return res.ok && typeof data.changed === 'number' ? data.changed : null;
      }
      if (action === 'save' && rawBody && typeof rawBody === 'object') {
        const { field, before, after } = rawBody as Record<string, unknown>;
        if (typeof field !== 'string' || !/^[a-z0-9_]+:[^:\s]{1,64}:[a-z0-9_]+/.test(field) || typeof before !== 'string' || typeof after !== 'string') return { ok: false, error: 'That is not a field Wanigan can save to.' };
        const res = await view.webContents.session.fetch(`${origin}/_wanigan/save`, {
          method: 'POST', credentials: 'include', headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ field, before: before.slice(0, 2_000), after: after.slice(0, 2_000) }),
        });
        const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; label?: string } | null;
        return data && typeof data === 'object' ? { ok: data.ok === true, error: typeof data.error === 'string' ? data.error : null, label: typeof data.label === 'string' ? data.label : null }
          : { ok: false, error: `The site answered ${res.status}.`, label: null };
      }
    } catch (error) {
      return action === 'save' ? { ok: false, error: `The site did not answer: ${(error as Error).message}`, label: null } : null;
    }
    return null;
  });
  ipcMain.handle('live:problems', async (event) => {
    if (!ok(event)) return [];
    const page = await run<{ level: 'error' | 'warning'; text: string }[]>('window.__wl ? window.__wl.problems() : []', []);
    const own: LiveProblem[] = (Array.isArray(page) ? page : []).slice(0, 20).map((p) => ({ level: p.level === 'warning' ? 'warning' : 'error', text: String(p.text).slice(0, 400), source: 'page' }));
    return [...own, ...logged];
  });
  ipcMain.handle('live:mutations', async (event) => (ok(event) ? run<number>('window.__wl ? window.__wl.mutations() : 0', 0) : 0));
  ipcMain.handle('live:picked', async (event) => (ok(event) ? run<LivePick | null>('window.__wl ? window.__wl.picked() : null', null) : null));
  ipcMain.handle('live:style', async (event, raw: unknown) => {
    if (!ok(event) || !raw || typeof raw !== 'object') return null;
    const values = Object.fromEntries(Object.entries(raw as Record<string, unknown>)
      .filter((e): e is [string, string] => /^[a-z-]{1,40}$/.test(e[0]) && typeof e[1] === 'string' && STYLE_VALUE.test(e[1]))
      .slice(0, 30));
    return run<Record<string, string> | null>(`window.__wl ? window.__wl.style(${JSON.stringify(values)}) : null`, null);
  });
  ipcMain.handle('live:unstyle', async (event) => (ok(event) ? run<Record<string, string> | null>('window.__wl ? window.__wl.unstyle() : null', null) : null));
  ipcMain.handle('live:editText', async (event) => {
    if (!ok(event)) return null;
    view?.webContents.focus();
    return run<{ before: string; after: string } | null>('window.__wl ? window.__wl.editText() : null', null);
  });
  ipcMain.handle('live:cancelEdit', async (event) => { if (options.trusted(event)) await run('window.__wl && window.__wl.cancelEdit()', null); });
  ipcMain.handle('live:hasScript', (event) => options.trusted(event) && script() !== null);
  ipcMain.handle('live:capture', async (event, rawRect: unknown) => {
    if (!ok(event) || !view || view.webContents.isDestroyed()) return null;
    const r = rawRect === null ? null : bounds(rawRect);
    try {
      const image = r && r.width > 0 && r.height > 0 ? await view.webContents.capturePage(r) : await view.webContents.capturePage();
      return image.isEmpty() ? null : image.toPNG().toString('base64');
    } catch {
      return null;
    }
  });

  const shoot = async (id: string, rawUrl: string, token: string | null): Promise<{ data: string; width: number; height: number } | null> => {
    const url = liveUrl(rawUrl);
    if (!url || !options.enabled()) return null;
    const partition = partitionFor(id);
    prepare(session.fromPartition(partition), partition, id);
    if (!hosts.has(id)) hosts.set(id, new URL(url).hostname);
    if (token && /^[0-9a-f]{16,128}$/.test(token)) tokens.set(id, token);
    const w = new BrowserWindow({
      show: false, width: SHOT_WIDTH, height: 900, useContentSize: true, enableLargerThanScreen: true, paintWhenInitiallyHidden: true,
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
    });
    const wc = w.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event, next) => { if (!sameSite(url, next)) event.preventDefault(); });
    wc.setAudioMuted(true);
    try {
      // Never the browser's cached copy: a page sent with max-age would make the after the before again.
      const fresh = { extraHeaders: 'Cache-Control: no-cache\nPragma: no-cache\n' };
      const loaded = await Promise.race([wc.loadURL(url, fresh).then(() => true, () => false), pause(SHOT_LOAD_MS).then(() => false)]);
      if (!loaded) return null;
      await pause(SHOT_SETTLE_MS);
      // A page grows as it settles at its new size (late content, images that load once in view): grow the window
      // to the page, and again, until the height holds.
      const measure = async (): Promise<number> => {
        const tall = Number(await wc.executeJavaScript('Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, document.scrollingElement ? document.scrollingElement.scrollHeight : 0))'));
        return Math.max(600, Math.min(SHOT_MAX_HEIGHT, Number.isFinite(tall) ? tall : 900));
      };
      let height = 900;
      for (let round = 0; round < 4; round++) {
        const next = await measure();
        if (next === height && round > 0) break;
        height = next;
        w.setContentSize(SHOT_WIDTH, height);
        await pause(round === 0 ? 1_200 : 600);
      }
      const image = await wc.capturePage();
      if (image.isEmpty()) return null;
      const size = image.getSize();
      return { data: image.toPNG().toString('base64'), width: size.width, height: size.height };
    } catch {
      return null;
    } finally {
      w.destroy();
    }
  };

  return { release: drop, shoot };
}
