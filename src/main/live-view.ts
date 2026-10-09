// The live view's window side: one WebContentsView laid over a placeholder the
// window positions, showing the owner's local site. It runs in its own session
// per project (so a login there stays, and never mixes with Wanigan's own
// page), sandboxed and context-isolated, with no preload: the main process
// injects out/renderer/live-page.js into an isolated world and reads its
// answers directly. It stays on the site's own host; anything else opens in the
// default browser. A hosted environment (Dev, Test, Live) shows in a private
// session of its own instead: read-only, never with the helper's token, its
// certificate judged by Chromium alone. Design: docs/design/2026-10-08-live-view.md.
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow, WebContentsView, ipcMain, session, shell, type IpcMainInvokeEvent, type NativeImage, type Session, type WebContents } from 'electron';
import { liveUrl, sameSite, type LivePick, type LiveProblem, type LiveRegion } from '../shared/live.ts';
import { cleanRegions, regionById, type LiveCapture, type LiveViewNow, type TimedProblem } from '../shared/live-agent.ts';
import { certificateOf, failureKind, principal, type LiveFailure, type LivePresented } from '../shared/live-site.ts';
import type { LiveBounds, LiveViewState } from '../shared/bridge.ts';
import { envId, hostedPage } from './live-compare-request.ts';

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
   * trust, the helper's token). When the page did not load, why (the same
   * failure the view reports); null when it loaded and drew nothing.
   */
  shoot(projectId: string, url: string, token: string | null): Promise<LiveShotTaken | { failure: LiveFailure } | null>;
  /**
   * A page of a project's site rendered for an agent, in a hidden window in
   * the live view's session: never the owner's own view, which stays where it
   * is. Its regions as the page script reads them, and a picture when asked.
   */
  render(projectId: string, url: string, token: string | null, options: RenderOptions): Promise<RenderedPage | { error: string }>;
  /** What the owner's view shows now, if it is on this project's site; null when there is no view. */
  now(projectId: string): LiveViewNow | null;
  /** What the owner's view's console logged since its page loaded, with when; null when it is not on this project. */
  logged(projectId: string): TimedProblem[] | null;
  /**
   * The session a capture of a project's page runs in, prepared as the view's own are: the local site's (its login,
   * certificate trust and the helper's token), or a hosted environment's private one. `url` must be https for `env`.
   */
  partition(projectId: string, env: string | null, url: string, token: string | null): string;
  /** The page script, for reading what made each part of a captured page; null when this build has none. */
  pageScript(): string | null;
  /** What the view shows now, for what is built on it (live-inspect.ts); null when there is no view. */
  current(): LiveCurrent | null;
  /** Run code in the page script's isolated world (putting the script in first); `fallback` when it cannot. */
  run<T>(code: string, fallback: T): Promise<T>;
}

export interface RenderOptions {
  /** CSS pixels wide, and the first screen's height. */
  width: number;
  screenHeight: number;
  capture: LiveCapture;
  /** The part to crop to and read the style of, by its id. */
  part: string | null;
  /** Read the page's regions and their words. */
  scan: boolean;
}

export interface RenderedPage {
  url: string;
  title: string;
  width: number;
  /** The document's height in CSS pixels. */
  height: number;
  regions: LiveRegion[];
  texts: Record<string, string>;
  partFound: boolean | null;
  style: Record<string, string> | null;
  /** This load's own messages, console and failed requests. */
  problems: LiveProblem[];
  /** The picture, at the screen's scale, and what of the page it shows (CSS pixels). */
  image: NativeImage | null;
  imageRect: { x: number; y: number; width: number; height: number } | null;
  cut: boolean;
}

/** The live view as it is now: its page, the site it may show, and the helper's token for that site. */
export interface LiveCurrent {
  projectId: string;
  webContents: WebContents;
  /** The site's address, as the owner set it: what the view may stay on. */
  base: string;
  token: string | null;
}

/** Where what is built on the view hears of it: a project's session locked down, a view made or gone. */
export interface LiveViewHooks {
  /** Once per project session, after it is locked down. */
  session?(ses: Session, projectId: string): void;
  /** A view was made for a project, or went away (null). */
  view?(webContents: WebContents | null, projectId: string | null): void;
}

export interface LiveShotTaken { data: string; width: number; height: number }

/** Screenshots are a desktop page: this many CSS pixels wide, and as tall as the page up to a limit. */
const SHOT_WIDTH = 1440;
const SHOT_MAX_HEIGHT = 8_000;
const SHOT_LOAD_MS = 30_000;
/** After the load: late content, web fonts, a first animation frame. */
const SHOT_SETTLE_MS = 1_500;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const originOf = (url: string): string => { try { return new URL(url).origin; } catch { return 'another address'; } };

let pageScript: string | null | undefined;

/** The page script, built beside the window's page; null when this build has none (dev without a build). */
function script(): string | null {
  if (pageScript !== undefined) return pageScript;
  try { pageScript = readFileSync(join(__dirname, '../renderer/live-page.js'), 'utf8'); } catch { pageScript = null; }
  return pageScript;
}

/** Where mkcert keeps its authority: $CAROOT, or mkcert's own folder (`mkcert -CAROOT`). */
const caroot = (): string => process.env.CAROOT || join(homedir(), 'Library', 'Application Support', 'mkcert');

/**
 * The owner's own local certificate authority, if mkcert made one: ddev signs
 * every *.ddev.site certificate with it. Read, never written, and read again
 * each time a certificate is refused (it is only then that it is wanted), so
 * one made by `mkcert -install` after Wanigan started counts. When mkcert has
 * not been installed into the system's trust store, this is how the view can
 * still trust exactly those certificates.
 */
function localAuthority(): X509Certificate | null {
  try {
    const pem = readFileSync(join(caroot(), 'rootCA.pem'), 'utf8');
    const ca = pem.length < 64 * 1024 ? new X509Certificate(pem) : null;
    return ca?.ca ? ca : null;
  } catch {
    return null;
  }
}

/**
 * A certificate Chromium refused: whether the owner's local authority issued
 * it for this host and it is in date (then it is trusted here; nothing else is
 * overruled), and, either way, the certificate as it describes itself, so
 * the view can say exactly what was refused.
 */
function judge(pem: string, hostname: string, verdict: string): { trusted: boolean; presented: LivePresented | null } {
  const ca = localAuthority();
  let leaf: X509Certificate;
  try { leaf = new X509Certificate(pem); } catch { return { trusted: false, presented: null }; }
  let local = false;
  try { local = !!ca && leaf.issuer === ca.subject && leaf.verify(ca.publicKey); } catch { local = false; }
  const now = Date.now();
  const trusted = local && leaf.checkHost(hostname) !== undefined && Date.parse(leaf.validFrom) <= now && now <= Date.parse(leaf.validTo);
  let presented: LivePresented | null = null;
  try {
    presented = { certificate: certificateOf(leaf), local, authority: ca ? principal(ca.subject) : null, caroot: caroot(), verdict };
  } catch { presented = null; }
  return { trusted, presented };
}

/** Chromium's error code from a failed request's message (`net::ERR_CERT_DATE_INVALID`), as far as the words say. */
const NET_CODES: Record<string, number> = {
  ERR_CERT_COMMON_NAME_INVALID: -200, ERR_CERT_DATE_INVALID: -201, ERR_CERT_AUTHORITY_INVALID: -202, ERR_CONNECTION_REFUSED: -102,
  ERR_NAME_NOT_RESOLVED: -105, ERR_CONNECTION_RESET: -101, ERR_CONNECTION_CLOSED: -100, ERR_TIMED_OUT: -7, ERR_CONNECTION_TIMED_OUT: -118,
};
function failureFrom(error: unknown, url: string): Omit<LiveFailure, 'certificate'> {
  const message = error instanceof Error ? error.message : String(error);
  const name = /ERR_[A-Z_]+/.exec(message)?.[0] ?? message.slice(0, 200);
  return { code: NET_CODES[name] ?? (/^ERR_CERT_/.test(name) ? -200 : -2), description: name, url };
}

/** A partition name for a project: Electron wants a plain string; ids are opaque, so keep only safe characters. */
function partitionFor(projectId: string): string {
  return `persist:wanigan-live-${projectId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)}`;
}

/**
 * A hosted environment's session: one per environment, never the local site's, and in memory only (no
 * `persist:`), so nothing it is given outlives the app and no cookie crosses between Local and Live.
 */
function hostedPartitionFor(projectId: string, env: string): string {
  const safe = (v: string): string => v.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return `wanigan-live-env-${safe(projectId)}-${safe(env)}`;
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
  hooks?: LiveViewHooks;
}): LiveViewWiring {
  let view: WebContentsView | null = null;
  let projectId: string | null = null;
  /** The hosted environment the view shows; null: the local site. */
  let env: string | null = null;
  let base: string | null = null;
  let attached = false;
  let lastError: LiveViewState['error'] = null;
  /** The view is stepped aside for something over it (a dialog). */
  let covered = false;
  let logged: TimedProblem[] = [];
  /** Hidden windows rendering for an agent, by webContents id: what their requests reported. */
  const collecting = new Map<number, LiveProblem[]>();
  /** The HTTP status of the page the view shows, when one loaded. */
  let lastStatus: number | null = null;
  const prepared = new Set<string>();
  /** The host each project's view may load, for its certificate check. */
  const hosts = new Map<string, string>();
  /** The token each project's site helper answers to: sent with the view's own page loads to that host, and nothing else. */
  const tokens = new Map<string, string>();
  /** The certificate each project's site last presented and Chromium refused, by host: what a failure says was refused. */
  const refusedCerts = new Map<string, LivePresented>();
  const certKey = (id: string, hostname: string): string => `${id}\n${hostname.toLowerCase()}`;
  /** A failure, with the certificate behind it when it was a refused one. */
  const failure = (id: string, base: Omit<LiveFailure, 'certificate'>): LiveFailure => {
    let host = '';
    try { host = new URL(base.url).hostname; } catch { /* no address: no certificate to look for */ }
    return { ...base, certificate: failureKind(base) === 'certificate' && host ? refusedCerts.get(certKey(id, host)) ?? null : null };
  };

  const send = (): void => {
    const w = options.window();
    if (!w || w.isDestroyed()) return;
    const wc = view?.webContents;
    const state: LiveViewState = wc && !wc.isDestroyed() ? {
      projectId, env, url: wc.getURL() || base, title: wc.getTitle(), loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(), error: lastError,
      status: lastStatus, logged: logged.length,
    } : { projectId: null, env: null, url: null, title: '', loading: false, canGoBack: false, canGoForward: false, error: null, status: null, logged: 0 };
    w.webContents.send('live:state', state);
  };

  /**
   * Lock a project's session down once: no permissions, no downloads, no new
   * windows. Certificates are Chromium's verdict, except that one the owner's
   * own mkcert authority issued for this project's site is trusted here. A hosted environment's session gets
   * none of that: Chromium's own certificate verdict, no token, and only requests that cannot change a site.
   */
  const prepare = (ses: Session, partition: string, id: string, hosted = false): void => {
    if (prepared.has(partition)) return;
    prepared.add(partition);
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (event) => event.preventDefault());
    if (hosted) {
      // Read-only: a form cannot be sent and nothing can be saved from here; what a page loads by POST stays empty.
      ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !['GET', 'HEAD', 'OPTIONS'].includes(details.method) }));
      return;
    }
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
    // Requests that failed, for an agent reading a page in a hidden window (never the owner's view, which records none).
    const failed = (wcId: number | undefined, text: string): void => {
      const list = wcId === undefined ? undefined : collecting.get(wcId);
      if (list && list.length < 40) list.push({ level: 'error', text: text.slice(0, 400), source: 'network' });
    };
    const path = (url: string): string => { try { const u = new URL(url); return `${u.host === hosts.get(id) ? '' : u.host}${u.pathname}`; } catch { return url.slice(0, 200); } };
    ses.webRequest.onCompleted((details) => {
      if (details.statusCode >= 400) failed(details.webContentsId, `${details.statusCode} ${details.method} ${path(details.url)}`);
    });
    ses.webRequest.onErrorOccurred((details) => {
      if (details.error !== 'net::ERR_ABORTED') failed(details.webContentsId, `${details.error} ${details.method} ${path(details.url)}`);
    });
    ses.setCertificateVerifyProc((request, callback) => {
      const key = certKey(id, request.hostname);
      if (request.errorCode === 0) { refusedCerts.delete(key); callback(0); return; }
      const host = hosts.get(id);
      const { trusted, presented } = judge(request.certificate.data, request.hostname, request.verificationResult);
      if (host && request.hostname === host && trusted) { refusedCerts.delete(key); callback(0); return; }
      if (presented) refusedCerts.set(key, presented); else refusedCerts.delete(key);
      callback(-3);
    });
    options.hooks?.session?.(ses, id);
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
    if (view) options.hooks?.view?.(null, null);
    view = null;
    projectId = null;
    env = null;
    base = null;
    attached = false;
    covered = false;
    lastError = null;
    lastStatus = null;
    logged = [];
  };

  const create = (id: string, hosted: string | null): WebContentsView => {
    const partition = hosted ? hostedPartitionFor(id, hosted) : partitionFor(id);
    const ses = session.fromPartition(partition);
    prepare(ses, partition, id, hosted !== null);
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
      logged = [...logged, { level: details.level, text: `${details.message.slice(0, 400)}${where}`, source: 'console' as const, at: Date.now() }].slice(-MAX_CONSOLE);
      send();
    });
    for (const name of ['did-start-loading', 'did-stop-loading', 'did-navigate-in-page', 'page-title-updated'] as const) {
      wc.on(name as 'did-stop-loading', () => {
        if (name === 'did-start-loading') lastError = null;
        send();
      });
    }
    wc.on('did-navigate', (_e, _url, httpResponseCode) => {
      lastStatus = httpResponseCode > 0 ? httpResponseCode : null;
      send();
    });
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      // -3 is an aborted load (a new navigation replaced it): not a failure.
      if (!isMainFrame || code === -3) return;
      lastError = failure(id, { code, description, url });
      lastStatus = null;
      send();
    });
    wc.on('render-process-gone', (_e, details) => {
      lastError = { code: -1, description: `The page stopped (${details.reason}).`, url: wc.getURL(), certificate: null };
      send();
    });
    options.hooks?.view?.(wc, id);
    return v;
  };

  const ok = (event: IpcMainInvokeEvent): boolean => options.trusted(event) && options.enabled();

  ipcMain.handle('live:show', async (event, rawProject: unknown, rawUrl: unknown, rawBounds: unknown, rawToken: unknown, rawEnv: unknown) => {
    if (!ok(event)) return false;
    const hosted = envId(rawEnv);
    if ((rawEnv !== null && rawEnv !== undefined && !hosted)) return false;
    // The helper's token is the local site's: a hosted environment never sees it, nor changes what the local view keeps.
    if (typeof rawProject === 'string' && rawProject && !hosted) {
      if (typeof rawToken === 'string' && /^[0-9a-f]{16,128}$/.test(rawToken)) tokens.set(rawProject, rawToken); else tokens.delete(rawProject);
    }
    const w = options.window();
    const url = hosted ? hostedPage(rawUrl) : liveUrl(rawUrl);
    const b = bounds(rawBounds);
    if (!w || w.isDestroyed() || typeof rawProject !== 'string' || !rawProject || !url || !b) return false;
    if (projectId !== rawProject || env !== hosted) {
      drop();
      view = create(rawProject, hosted);
      projectId = rawProject;
      env = hosted;
    }
    const v = view as WebContentsView;
    if (!attached) { w.contentView.addChildView(v); attached = true; }
    v.setBounds(b);
    v.setVisible(true);
    covered = false;
    if (!base || !sameSite(base, url) || !v.webContents.getURL()) {
      base = url;
      if (!hosted) hosts.set(rawProject, new URL(url).hostname);
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

  const isCovered = (value: boolean): void => { covered = value; };
  // A dialog over the view: a native view draws above the page, so it steps aside and leaves its last frame.
  ipcMain.handle('live:cover', async (event, covered: unknown) => {
    if (!options.trusted(event) || !view) return null;
    if (covered === true) {
      let frame: string | null = null;
      try { frame = (await view.webContents.capturePage()).toDataURL(); } catch { frame = null; }
      view.setVisible(false);
      isCovered(true);
      return frame;
    }
    view.setVisible(true);
    isCovered(false);
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
    if (!ok(event) || !view || !base || !projectId || env) return null;
    const token = tokens.get(projectId);
    if (!token) return null;
    const origin = new URL(view.webContents.getURL() || base).origin;
    const headers = { 'X-Wanigan-Live': token, Accept: 'application/json' };
    const id = projectId;
    let saving = false;
    try {
      if (action === 'changed') {
        const res = await view.webContents.session.fetch(`${origin}/_wanigan/changed`, { headers, credentials: 'include' });
        const data = await res.json() as { changed?: unknown };
        return res.ok && typeof data.changed === 'number' ? data.changed : null;
      }
      if (action === 'save' && rawBody && typeof rawBody === 'object') {
        saving = true;
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
      // Why the site did not answer is said in the view's own words (the window asks the core whether it runs);
      // this is only the fallback.
      if (!saving) return null;
      const why = failure(id, failureFrom(error, `${origin}/_wanigan/save`));
      return { ok: false, error: `The site did not answer (${why.description}).`, label: null, failure: why };
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
    if (!ok(event) || env || !raw || typeof raw !== 'object') return null;
    const values = Object.fromEntries(Object.entries(raw as Record<string, unknown>)
      .filter((e): e is [string, string] => /^[a-z-]{1,40}$/.test(e[0]) && typeof e[1] === 'string' && STYLE_VALUE.test(e[1]))
      .slice(0, 30));
    return run<Record<string, string> | null>(`window.__wl ? window.__wl.style(${JSON.stringify(values)}) : null`, null);
  });
  ipcMain.handle('live:unstyle', async (event) => (ok(event) ? run<Record<string, string> | null>('window.__wl ? window.__wl.unstyle() : null', null) : null));
  ipcMain.handle('live:editText', async (event) => {
    if (!ok(event) || env) return null;
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

  /**
   * Load a page of a project's site in a hidden window in the live view's own
   * session (its login, its certificate trust, the helper's token), never
   * leaving the site, and read it: its height, its regions and their words,
   * what it reported, and a picture of the first screen, the whole page (the
   * window grown to it, as the before and after shots are) or one part.
   */
  const render = async (id: string, rawUrl: string, token: string | null, opts: RenderOptions): Promise<RenderedPage | { error: string; failure?: LiveFailure }> => {
    const url = liveUrl(rawUrl);
    if (!url) return { error: 'That is not an address Wanigan opens.' };
    if (!options.enabled()) return { error: 'The live view is off: the owner switches it on in Settings › Live view.' };
    const partition = partitionFor(id);
    prepare(session.fromPartition(partition), partition, id);
    if (!hosts.has(id)) hosts.set(id, new URL(url).hostname);
    if (token && /^[0-9a-f]{16,128}$/.test(token)) tokens.set(id, token);
    const width = Math.max(320, Math.min(2560, Math.round(opts.width)));
    const screen = Math.max(400, Math.min(2000, Math.round(opts.screenHeight)));
    const w = new BrowserWindow({
      show: false, width, height: screen, useContentSize: true, enableLargerThanScreen: true, paintWhenInitiallyHidden: true,
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
    });
    const wc = w.webContents;
    const problems: LiveProblem[] = [];
    collecting.set(wc.id, problems);
    let left: string | null = null;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Never off the site: a link, a redirect or a script that would leave is stopped, and said.
    const stay = (event: { preventDefault(): void }, next: string): void => { if (!sameSite(url, next)) { event.preventDefault(); left ??= next; } };
    wc.on('will-navigate', stay);
    wc.on('will-redirect', stay);
    wc.on('console-message', (details) => {
      if ((details.level !== 'error' && details.level !== 'warning') || details.message.includes('Electron Security Warning') || problems.length >= 40) return;
      const where = details.sourceId ? ` (${details.sourceId.replace(/^https?:\/\/[^/]+/, '')}:${details.lineNumber})` : '';
      problems.push({ level: details.level, text: `${details.message.slice(0, 400)}${where}`, source: 'console' });
    });
    wc.setAudioMuted(true);
    const isolated = async <T>(code: string, fallback: T): Promise<T> => {
      try { return (await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }], true)) as T; } catch { return fallback; }
    };
    let failed: Omit<LiveFailure, 'certificate'> | null = null;
    wc.on('did-fail-load', (_e, code, description, failedUrl, isMainFrame) => {
      if (isMainFrame && code !== -3) failed = { code, description, url: failedUrl || url };
    });
    try {
      // Never the browser's cached copy: a page sent with max-age would make the after the before again.
      const fresh = { extraHeaders: 'Cache-Control: no-cache\nPragma: no-cache\n' };
      const loaded = await Promise.race([wc.loadURL(url, fresh).then(() => true, () => false), pause(SHOT_LOAD_MS).then(() => false)]);
      if (left) return { error: `The page sent the browser off the site, to ${originOf(left)}; Wanigan does not follow it.` };
      if (!loaded) {
        // Why, as the live view itself says it (shared/live-site.ts): a site that is not running, a refused certificate, a timeout.
        return { error: `The page did not load within ${SHOT_LOAD_MS / 1000} seconds, or failed to load: ${url}`,
          failure: failure(id, failed ?? { code: -7, description: `The page did not finish loading within ${SHOT_LOAD_MS / 1000} seconds`, url }) };
      }
      if (!sameSite(url, wc.getURL())) return { error: 'The page left the site; Wanigan does not follow it.' };
      await pause(SHOT_SETTLE_MS);
      const measure = async (): Promise<number> => {
        const tall = Number(await wc.executeJavaScript('Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, document.scrollingElement ? document.scrollingElement.scrollHeight : 0))'));
        return Number.isFinite(tall) && tall > 0 ? tall : screen;
      };
      let height = await measure();
      let shown = screen;
      if (opts.capture === 'page') {
        // A page grows as it settles at its new size (late content, images that load once in view): grow the window
        // to the page, and again, until the height holds.
        shown = 0;
        for (let round = 0; round < 4; round++) {
          const next = Math.max(600, Math.min(SHOT_MAX_HEIGHT, height));
          if (next === shown && round > 0) break;
          shown = next;
          w.setContentSize(width, shown);
          await pause(round === 0 ? 1_200 : 600);
          height = await measure();
        }
      }
      let regions: LiveRegion[] = [];
      let texts: Record<string, string> = {};
      let part: LiveRegion | null = null;
      let style: Record<string, string> | null = null;
      const code = script();
      if (code && (opts.scan || opts.part)) {
        try { await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]); } catch { /* read below as nothing */ }
        regions = cleanRegions(await isolated<unknown>('window.__wl ? window.__wl.scan() : []', [])).slice(0, MAX_SCAN);
        texts = Object.fromEntries(Object.entries(await isolated<Record<string, string>>('window.__wl ? window.__wl.texts(200) : {}', {}))
          .filter((e): e is [string, string] => typeof e[1] === 'string'));
        part = opts.part ? regionById(regions, opts.part) : null;
        if (part) style = await isolated<Record<string, string> | null>(`window.__wl ? window.__wl.styleOf(${part.index}) : null`, null);
        const own = await isolated<{ level?: unknown; text?: unknown }[]>('window.__wl ? window.__wl.problems() : []', []);
        if (Array.isArray(own)) {
          for (const p of own.slice(0, 20)) problems.unshift({ level: p.level === 'warning' ? 'warning' : 'error', text: String(p.text).slice(0, 400), source: 'page' });
        }
      }
      let image: NativeImage | null = null;
      let imageRect: RenderedPage['imageRect'] = null;
      let cut = false;
      if (opts.capture === 'screen') {
        image = await wc.capturePage();
        imageRect = { x: 0, y: 0, width, height: Math.min(screen, height) };
        cut = height > screen;
      } else if (opts.capture === 'page') {
        image = await wc.capturePage();
        imageRect = { x: 0, y: 0, width, height: shown };
        cut = height > shown;
      } else if (opts.capture === 'part' && part) {
        // Scrolled to, not grown to: growing the window would change a page that sizes itself to the screen.
        const pad = 8;
        const top = Math.max(0, part.rect.y - pad);
        const scrolled = Number(await wc.executeJavaScript(`(window.scrollTo(0, ${top}), Math.round(window.scrollY))`)) || 0;
        await pause(300);
        const x = Math.max(0, part.rect.x - pad);
        const y = Math.max(0, top - scrolled);
        const rect = { x, y, width: Math.max(1, Math.min(width - x, part.rect.width + pad * 2)), height: Math.max(1, Math.min(screen - y, part.rect.height + pad * 2)) };
        image = await wc.capturePage(rect);
        imageRect = { x, y: top, width: rect.width, height: rect.height };
        cut = part.rect.height + pad * 2 > rect.height;
      }
      if (image?.isEmpty()) image = null;
      return {
        url: wc.getURL(), title: wc.getTitle(), width, height, regions, texts,
        partFound: opts.part ? !!part : null, style, problems, image, imageRect: image ? imageRect : null, cut,
      };
    } catch (error) {
      return { error: `The page could not be read: ${(error as Error).message}` };
    } finally {
      collecting.delete(wc.id);
      w.destroy();
    }
  };

  const shoot = async (id: string, rawUrl: string, token: string | null): Promise<LiveShotTaken | { failure: LiveFailure } | null> => {
    const page = await render(id, rawUrl, token, { width: SHOT_WIDTH, screenHeight: 900, capture: 'page', part: null, scan: false });
    if ('error' in page) return page.failure ? { failure: page.failure } : null;
    if (!page.image) return null;
    const size = page.image.getSize();
    return { data: page.image.toPNG().toString('base64'), width: size.width, height: size.height };
  };

  const now = (id: string): LiveViewNow | null => {
    const wc = view?.webContents;
    if (!view || !wc || wc.isDestroyed()) return null;
    const showing = projectId === id;
    const b = view.getBounds();
    return {
      showing, visible: showing && attached && !covered, url: showing ? wc.getURL() || base : null, title: showing ? wc.getTitle() : '',
      width: showing && b.width > 0 ? b.width : null, height: showing && b.height > 0 ? b.height : null, loading: showing && wc.isLoading(),
    };
  };

  const partitionOf = (id: string, hosted: string | null, url: string, token: string | null): string => {
    if (hosted) {
      const partition = hostedPartitionFor(id, hosted);
      prepare(session.fromPartition(partition), partition, id, true);
      return partition;
    }
    const partition = partitionFor(id);
    prepare(session.fromPartition(partition), partition, id);
    if (!hosts.has(id)) hosts.set(id, new URL(url).hostname);
    if (token && /^[0-9a-f]{16,128}$/.test(token)) tokens.set(id, token);
    return partition;
  };

  const current = (): LiveCurrent | null => (view && !view.webContents.isDestroyed() && projectId && base
    ? { projectId, webContents: view.webContents, base, token: tokens.get(projectId) ?? null } : null);

  return { release: drop, shoot, render, now, logged: (id) => (view && projectId === id ? [...logged] : null), partition: partitionOf, pageScript: script, current, run };
}
