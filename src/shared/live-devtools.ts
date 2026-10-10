// The page's own Chromium DevTools in the live view's dock, as data: where it
// is (closed, in the dock, in a window of its own), what each thing the owner
// does or the page does changes, and what the main process must then do to the
// views. Pure, so the main process (src/main/live-devtools.ts) runs exactly
// what the tests here run, and the window measures a part's centre the same way.
//
// - The dock's DevTools is a plain view of its own, handed to the page's
//   setDevToolsWebContents() before openDevTools(). Electron loads DevTools
//   into a view once: a view that has shown DevTools is never given it again,
//   so closing DevTools in the dock is destroying that view, and opening it
//   again makes a new one.
// - Hiding the tab steps the view aside and keeps DevTools (its console, its
//   selection); the dock's bounds are kept for when it shows again.
// - A new page view while the tab is shown (another environment of the same
//   project) gets DevTools again, where it was; any other page closes it, and
//   so does leaving the project.
// - In its own window (for a second screen) it is Electron's detached DevTools;
//   the dock's view is gone, and the tab says where DevTools is.
// Design: docs/design/2026-10-08-live-view.md.

/** Where a view is laid in the window, in CSS pixels. */
export interface DevtoolsBox { x: number; y: number; width: number; height: number }

/** Where the page's DevTools is: nowhere, in the dock beneath (or beside) the page, or in a window of its own. */
export type LiveDevtoolsMode = 'closed' | 'docked' | 'detached';

export interface DevtoolsModel {
  mode: LiveDevtoolsMode;
  /** The dock's view is on screen: the tab is shown and nothing covers it. */
  shown: boolean;
  /** Where the dock's view goes when shown: the tab's area, as the window last measured it. */
  bounds: DevtoolsBox | null;
  /** The page it is the DevTools of (its WebContents id), and that page's project; null without a page. */
  page: number | null;
  project: string | null;
}

export const DEVTOOLS_CLOSED: DevtoolsModel = { mode: 'closed', shown: false, bounds: null, page: null, project: null };

export type DevtoolsEvent =
  /** The dock shows the DevTools tab, over these bounds: DevTools opens there unless it is in its own window. */
  | { type: 'show'; bounds: DevtoolsBox }
  /** The tab's area moved or changed size. */
  | { type: 'bounds'; bounds: DevtoolsBox }
  /** The tab is not shown, or something covers it: the view steps aside, DevTools stays open. */
  | { type: 'hide' }
  /** The owner left the project, or closed DevTools: closed, wherever it is. */
  | { type: 'close' }
  /** Open in its own window, for a second screen. */
  | { type: 'detach' }
  /** Select the element at a point of the page in the Elements panel; opens DevTools in the dock when it is closed. */
  | { type: 'inspect'; x: number; y: number }
  /** A page view was made for a project (or went away: null). */
  | { type: 'page'; page: number | null; project: string | null }
  /** DevTools closed by itself: its own window was closed, or the dock's view stopped. */
  | { type: 'gone' };

export type DevtoolsEffect =
  /** Make a plain view, hand it to the page's setDevToolsWebContents(), open DevTools into it (hidden until placed). */
  | { do: 'dock' }
  /** Destroy the dock's view: DevTools closes with it. */
  | { do: 'undock' }
  /** Electron's own DevTools window for the page. */
  | { do: 'detach' }
  /** Close DevTools' own window. */
  | { do: 'close-window' }
  /** Lay the dock's view over these bounds, on screen or not. */
  | { do: 'place'; bounds: DevtoolsBox | null; visible: boolean }
  | { do: 'inspect'; x: number; y: number }
  /** Tell the window where DevTools is now. */
  | { do: 'tell'; mode: LiveDevtoolsMode };

/** What an event changes, and what must be done to the views for it, in order. */
export function devtoolsStep(model: DevtoolsModel, event: DevtoolsEvent): { model: DevtoolsModel; effects: DevtoolsEffect[] } {
  const m = model;
  const told = (next: DevtoolsModel, effects: DevtoolsEffect[]): { model: DevtoolsModel; effects: DevtoolsEffect[] } => (
    { model: next, effects: next.mode === m.mode ? effects : [...effects, { do: 'tell', mode: next.mode }] });
  const closeNow = (): DevtoolsEffect[] => (m.mode === 'docked' ? [{ do: 'undock' }] : m.mode === 'detached' ? [{ do: 'close-window' }] : []);
  switch (event.type) {
    case 'show': {
      const bounds = event.bounds;
      if (m.page === null) return { model: { ...m, shown: true, bounds }, effects: [] };
      // In its own window it stays there: the tab says where it is, and brings it back only when asked.
      if (m.mode === 'detached') return { model: { ...m, shown: true, bounds }, effects: [] };
      const open: DevtoolsEffect[] = m.mode === 'closed' ? [{ do: 'dock' }] : [];
      return told({ ...m, mode: 'docked', shown: true, bounds }, [...open, { do: 'place', bounds, visible: true }]);
    }
    case 'bounds':
      if (m.mode !== 'docked') return { model: { ...m, bounds: event.bounds }, effects: [] };
      return { model: { ...m, bounds: event.bounds }, effects: [{ do: 'place', bounds: event.bounds, visible: m.shown }] };
    case 'hide':
      if (m.mode !== 'docked') return { model: { ...m, shown: false }, effects: [] };
      return { model: { ...m, shown: false }, effects: m.shown ? [{ do: 'place', bounds: m.bounds, visible: false }] : [] };
    case 'close':
      return told({ ...m, mode: 'closed', shown: false }, closeNow());
    case 'detach':
      if (m.page === null || m.mode === 'detached') return { model: m, effects: [] };
      return told({ ...m, mode: 'detached' }, [...closeNow(), { do: 'detach' }]);
    case 'inspect': {
      if (m.page === null) return { model: m, effects: [] };
      const at: DevtoolsEffect = { do: 'inspect', x: event.x, y: event.y };
      if (m.mode !== 'closed') return { model: m, effects: [at] };
      // Opened for the inspection, in the dock: on screen once the tab shows it (it is being opened on that tab).
      return told({ ...m, mode: 'docked' }, [{ do: 'dock' }, { do: 'place', bounds: m.bounds, visible: m.shown }, at]);
    }
    case 'page': {
      const { page, project } = event;
      if (page === m.page && (page === null || project === m.project)) return { model: m, effects: [] };
      // The old page went away (another environment, another project, the window closed, the live view switched off):
      // its DevTools closes with it. Without a page, the project it was for is kept, to know the next page's.
      const effects = closeNow();
      if (page === null) return told({ ...m, mode: 'closed', page: null }, effects);
      const gone: DevtoolsModel = { ...m, mode: 'closed', page, project };
      // A new page of the same project while the tab shows DevTools gets it again, where it was.
      if (m.shown && (m.project === null || m.project === project)) {
        return told({ ...gone, mode: 'docked' }, [...effects, { do: 'dock' }, { do: 'place', bounds: m.bounds, visible: true }]);
      }
      return told({ ...gone, shown: false }, effects);
    }
    case 'gone':
      if (m.mode === 'closed') return { model: m, effects: [] };
      return told({ ...m, mode: 'closed' }, m.mode === 'docked' ? [{ do: 'undock' }] : []);
  }
}

/** A box the window sent, checked: four finite numbers, whole pixels, never negative, within reason; null otherwise. */
export function devtoolsBox(raw: unknown): DevtoolsBox | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.min(10_000, Math.max(0, Math.round(v))) : null);
  const x = n(b.x), y = n(b.y), width = n(b.width), height = n(b.height);
  return x === null || y === null || width === null || height === null ? null : { x, y, width, height };
}

/** A point of the page the window sent, checked: inside a page of at most 10,000 pixels a side; null otherwise. */
export function devtoolsPoint(x: unknown, y: unknown): { x: number; y: number } | null {
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10_000;
  return ok(x) && ok(y) ? { x: Math.round(x), y: Math.round(y) } : null;
}

/** A part's box in the page's viewport as the page script read it (it may run off any edge); null when it is not one. */
export function viewportBox(raw: unknown): DevtoolsBox | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const n = (v: unknown, min: number): number | null => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1_000_000 && v >= min ? Math.round(v) : null);
  const x = n(b.x, -1_000_000), y = n(b.y, -1_000_000), width = n(b.width, 0), height = n(b.height, 0);
  return x === null || y === null || width === null || height === null ? null : { x, y, width, height };
}

/** A part brought into view, as the page script read it: its box in the viewport, and the viewport's size then. */
export interface LiveRevealed { box: DevtoolsBox; view: { width: number; height: number } }

/** What the page script answered for a part brought into view, checked; null when it is not that. */
export function revealedOf(raw: unknown): LiveRevealed | null {
  const box = viewportBox(raw);
  if (!box || !raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const side = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 100_000 ? Math.round(v) : null);
  const width = side(r.viewWidth), height = side(r.viewHeight);
  return width === null || height === null ? null : { box, view: { width, height } };
}

/**
 * Where to point DevTools' inspector at a part: the centre of what of it is on screen, in the page's own pixels
 * (`box` is in the viewport, `view` is the viewport's size). Null when none of it is on screen.
 */
export function centreOf(box: DevtoolsBox, view: { width: number; height: number }): { x: number; y: number } | null {
  const left = Math.max(0, box.x);
  const top = Math.max(0, box.y);
  const right = Math.min(view.width, box.x + box.width);
  const bottom = Math.min(view.height, box.y + box.height);
  if (right - left < 1 || bottom - top < 1) return null;
  // Inside the viewport, never on its last pixel row or column.
  return { x: Math.min(view.width - 1, Math.floor((left + right) / 2)), y: Math.min(view.height - 1, Math.floor((top + bottom) / 2)) };
}

/** Whether none of a part is on screen: the page must scroll to it before DevTools can be pointed at it. */
export const offScreen = (box: DevtoolsBox, view: { width: number; height: number }): boolean => centreOf(box, view) === null;
