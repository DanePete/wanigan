import { app, Menu, nativeImage, Tray, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { attentionFor } from './attention';
import { listSessions } from './sessions';
import { reviewSummaries } from './review-work';
import { macSettings } from './p8-settings';
import { badgeCount, badgeText, trayGlyphBgra, trayModel, trayRows, type TrayModel } from '../shared/mac-presence';

/**
 * The Dock badge and the menu-bar session list.
 *
 * Both answer "does anything need me" for a person who is not looking at the
 * window, and both are off until that person asks for them. The decisions —
 * what counts, what a row says, what must never be shown — live in
 * shared/mac-presence.ts. This file only reads the records, draws, and routes
 * a click back into the window the same way a clicked notification does.
 */

/** How often the surfaces are redrawn. Time-in-state is shown in minutes, so a few seconds is plenty. */
const REFRESH_MS = 3_000;
/**
 * How often "needs review" is re-read. It runs git over every session's
 * checkout, and review-work.ts already caches its own answer for a while; the
 * badge does not need to be fresher than the review surface that set it.
 */
const REVIEW_REFRESH_MS = 30_000;
const GLYPH_POINTS = 18;

type Deps = {
  /** Bring the window forward, creating it if the operator had closed it, and resolve once it can receive a message. */
  reveal: () => Promise<BrowserWindow | null>;
};

let deps: Deps | null = null;
let timer: NodeJS.Timeout | null = null;
let tray: Tray | null = null;
let lastBadge = '';
let lastTraySignature = '';
/** Electron has no getter for a Tray's tooltip; kept so the snapshot can report it. */
let lastTooltip: string | null = null;
let needsReview = new Set<string>();
let reviewReadAt = 0;
let reviewReading = false;

function glyph(filled: boolean): Electron.NativeImage {
  // Drawn at 2x and declared as such, so the menu bar gets a crisp 18-point
  // image on a Retina display. Template: macOS picks the colour for light,
  // dark and highlighted menu bars, which is also why the shape alone has to
  // carry the difference between quiet and not.
  const px = GLYPH_POINTS * 2;
  const image = nativeImage.createFromBitmap(Buffer.from(trayGlyphBgra(px, filled)), { width: px, height: px, scaleFactor: 2 });
  image.setTemplateImage(true);
  return image;
}

function refreshNeedsReview(): void {
  if (reviewReading || Date.now() - reviewReadAt < REVIEW_REFRESH_MS) return;
  reviewReading = true;
  const ids = listSessions().map((s) => s.id);
  reviewSummaries(ids)
    .then((summaries) => {
      needsReview = new Set(Object.entries(summaries).filter(([, s]) => s.needsReview).map(([id]) => id));
    })
    .catch(() => { /* unreadable review state adds nothing to the count rather than a guess */ })
    .finally(() => { reviewReadAt = Date.now(); reviewReading = false; });
}

/** The menu as Electron wants it, with every click routed through the handlers. Exported for the offline suite. */
export function trayTemplate(model: TrayModel, handlers: { open: () => void; halt: () => void; session: (id: string) => void }): MenuItemConstructorOptions[] {
  return model.items.map((item): MenuItemConstructorOptions => {
    switch (item.kind) {
      case 'heading': return { label: item.label, enabled: false };
      case 'separator': return { type: 'separator' };
      case 'open': return { label: item.label, click: handlers.open };
      case 'halt': return { label: item.label, click: handlers.halt };
      case 'session': return { label: item.label, click: () => handlers.session(item.sessionId) };
    }
  });
}

async function openSession(sessionId: string): Promise<void> {
  const w = await deps?.reveal();
  if (w && !w.isDestroyed()) w.webContents.send('notify:open', { kind: 'session', sessionId });
}

async function openWindow(): Promise<void> {
  await deps?.reveal();
}

/**
 * Opens the app's own halt confirmation, never pulls the handle. The header
 * control arms and waits for a second, deliberate click inside the window; a
 * menu-bar item that stopped every agent on one click would be the emergency
 * stop's one-click path, which the header was built specifically not to have.
 */
async function armHalt(): Promise<void> {
  const w = await deps?.reveal();
  if (w && !w.isDestroyed()) w.webContents.send('menu:route', { kind: 'halt' });
}

function current(): { model: TrayModel; badge: number } {
  const sessions = listSessions();
  const attention = attentionFor(sessions);
  const now = Date.now();
  const badge = badgeCount(attention, needsReview, now);
  return { model: trayModel(trayRows(sessions, attention, needsReview, now), badge, now), badge };
}

function draw(): void {
  const settings = macSettings();
  if (!settings.dockBadge && !settings.menuBarSessions) { tearDown(); return; }
  if (settings.dockBadge || settings.menuBarSessions) refreshNeedsReview();
  let state: { model: TrayModel; badge: number };
  try { state = current(); } catch { return; /* the database is closing; the next tick redraws */ }

  if (process.platform === 'darwin' && app.dock) {
    const text = settings.dockBadge ? badgeText(state.badge) : '';
    if (text !== lastBadge) { app.dock.setBadge(text); lastBadge = text; }
  }

  if (!settings.menuBarSessions) {
    if (tray) { tray.destroy(); tray = null; lastTraySignature = ''; }
    return;
  }
  if (!tray) {
    tray = new Tray(glyph(false));
    lastTraySignature = '';
  }
  const signature = JSON.stringify(state.model);
  if (signature === lastTraySignature) return;
  lastTraySignature = signature;
  tray.setImage(glyph(!state.model.quiet));
  tray.setTitle(state.model.title);
  tray.setToolTip(state.model.tooltip);
  lastTooltip = state.model.tooltip;
  tray.setContextMenu(Menu.buildFromTemplate(trayTemplate(state.model, {
    open: () => { void openWindow(); },
    halt: () => { void armHalt(); },
    session: (id) => { void openSession(id); },
  })));
}

function tearDown(): void {
  if (tray) { tray.destroy(); tray = null; }
  lastTraySignature = '';
  if (lastBadge && process.platform === 'darwin' && app.dock) app.dock.setBadge('');
  lastBadge = '';
}

/** Start (or re-read) both surfaces. Safe to call again after a setting changes. */
export function startMacPresence(next: Deps): void {
  deps = next;
  if (!timer) timer = setInterval(draw, REFRESH_MS);
  reviewReadAt = 0;
  draw();
}

/**
 * What is drawn right now, read back from Electron rather than from this
 * module's intentions: whether a menu-bar item exists, the title and tooltip it
 * carries, and the Dock's badge text. For the offline suite, which otherwise
 * never saw a real Tray created or a real badge set.
 */
export function presenceSnapshot(): { tray: boolean; title: string | null; tooltip: string | null; badge: string | null } {
  const alive = !!tray && !tray.isDestroyed();
  return {
    tray: alive,
    title: alive && process.platform === 'darwin' ? tray!.getTitle() : null,
    tooltip: alive ? lastTooltip : null,
    badge: process.platform === 'darwin' && app.dock ? app.dock.getBadge() : null,
  };
}

export function stopMacPresence(): void {
  if (timer) { clearInterval(timer); timer = null; }
  tearDown();
  deps = null;
}
