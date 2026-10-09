// What the renderer can reach: `window.wanigan`. In the app it is the preload
// bridge; in the browser test harness it is the same shape over HTTP.
import type { LivePick, LiveProblem, LiveRegion } from './live.ts';
import type { CompareWidth } from './live-compare.ts';
import type { LiveEditSaved, LiveEdited, LivePaint, LiveTraceAnswer } from './live-lens.ts';
import type { ArrangeDrop, ArrangeSpec, LiveInsert, LiveMove, LiveMoveSaved } from './live-arrange.ts';
import type { Need } from './model.ts';
import type { EventName, Events, Method, Params, Result } from './protocol.ts';
import type { AppSettings, AppState } from './settings.ts';

export type CoreStatus = 'connected' | 'connecting' | 'unavailable';

/** Why the window cannot use the core as it is, and so what the owner is asked. */
export type CoreProblem =
  /** The core could not start: what it said, and the log with the rest. It is not started again until the owner asks. */
  | { kind: 'failed'; reason: string; log: string; at: number }
  /**
   * The core running is from another build of Wanigan (a pull, an upgrade, dev
   * and the packaged app on one data folder), and `live` sessions run in it.
   * Restarting it ends them: a terminal does not outlive the core it runs in.
   */
  | { kind: 'other-build'; pid: number; live: number };

/** What the owner answers: try a failed core again, or restart or keep one from another build. */
export type CoreAction = 'retry' | 'restart' | 'keep';

/** Files the owner picked to attach: each one's name and bytes (base64), and why any were left out. */
export interface PickedFiles { files: { name: string; data: string }[]; refused: string[] }

/** Where the live view's placeholder is, in the window's CSS pixels. */
export interface LiveBounds { x: number; y: number; width: number; height: number }

/** What the live view is showing, as the app reports it. */
export interface LiveViewState {
  projectId: string | null;
  /** The hosted environment shown (read-only, in its own private session); null or absent: the local site. */
  env?: string | null;
  url: string | null;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Why the page did not load, in Chromium's words (e.g. ERR_CERT_AUTHORITY_INVALID). */
  error: { code: number; description: string; url: string } | null;
  /** How many errors and warnings the page's console has logged since it loaded. */
  logged: number;
}

export type LiveTone = 'edit' | 'hover' | 'pick';

/** A full-page picture of one page, taken for a comparison. */
export interface LiveCompareRequest {
  projectId: string;
  /** The page, on the local site or on the hosted environment. */
  url: string;
  /** The hosted environment's id; null for the local site. */
  env: string | null;
  /** CSS pixels wide. */
  width: CompareWidth;
  /** The local site helper's token (never sent to a hosted environment). */
  token: string | null;
  /** Also read what made each part of the page (the local side, to name what changed). */
  scan: boolean;
}

export type LiveCompareShot =
  | {
    /** PNG, base64. */
    data: string;
    /** Pixels of the image (the CSS size times the screen's scale). */
    width: number;
    height: number;
    cssWidth: number;
    /** How tall the page is, in CSS pixels, up to the limit. */
    cssHeight: number;
    /** The page was taller than the limit and is shown down to it. */
    cut: boolean;
    /** The address the page ended up at, after any redirect. */
    url: string;
    /** The HTTP status the page answered with (0 when unknown). */
    status: number;
    regions: LiveRegion[];
  }
  | { error: string };

/**
 * The live view: the owner's local site laid over a placeholder in the window.
 * In the app the main process owns it (src/main/live-view.ts); the UI sweep's
 * test bridge plays it with a frame.
 */
export interface LiveBridge {
  /**
   * Show a project's site over the placeholder. False when the live view is off or the address is refused.
   * `token` is the site helper's, sent with the view's own page loads to that site. `env` shows a hosted
   * environment instead: https only, read-only, in its own private session, never with a token.
   */
  show(projectId: string, url: string, bounds: LiveBounds, token?: string | null, env?: string | null): Promise<boolean>;
  /** The placeholder moved or changed size. */
  bounds(bounds: LiveBounds): void;
  hide(): Promise<void>;
  /** Something covers the view (a dialog): it steps aside, and the last frame comes back as an image. */
  cover(covered: boolean): Promise<string | null>;
  reload(hard?: boolean): Promise<void>;
  /** Fetch the page's stylesheets again in place; reloads instead when they are aggregated. */
  css(): Promise<number>;
  /** Go to another page of the same site. */
  go(url: string): Promise<boolean>;
  back(): Promise<void>;
  forward(): Promise<void>;
  /** Open the page in the default browser. */
  open(): Promise<void>;
  devtools(): Promise<void>;
  /** The regions of the page and what produced each. */
  scan(): Promise<LiveRegion[]>;
  /** Outline regions by their index from the last scan: an edit's, a pointed-at row's (dashed), a pick's. Returns how many were drawn. */
  outline(indexes: number[], label: string | null, tone?: LiveTone): Promise<number>;
  clear(): Promise<void>;
  /** Let the owner pick an element; null when they pressed Escape or picking was cancelled. */
  pick(): Promise<LivePick | null>;
  cancelPick(): Promise<void>;
  /** A PNG (base64) of what the view shows, or of one rectangle of the page in CSS pixels of the view. */
  capture(rect?: { x: number; y: number; width: number; height: number }): Promise<string | null>;
  /** What the site says is wrong on the page, and what its console logged as errors since it loaded. */
  problems(): Promise<LiveProblem[]>;
  /** How many times the page has changed itself since it loaded: late content means scanning again. */
  mutations(): Promise<number>;
  /** The picked element, described again (after a tried style or new words). */
  picked(): Promise<LivePick | null>;
  /** Try style values on the picked element, in this copy of the page only. Returns its computed style. */
  style(values: Record<string, string>): Promise<Record<string, string> | null>;
  /** Put the picked element's own style back. */
  unstyle(): Promise<Record<string, string> | null>;
  /** Let the owner retype the picked element's words on the page. Null when they kept the old ones. */
  editText(): Promise<{ before: string; after: string } | null>;
  cancelEdit(): Promise<void>;
  /** The site helper's count of content changes (null without a helper, or when it did not answer). */
  helperChanged(): Promise<number | null>;
  /** Save words to a plain text field through the site helper, as the user logged in in the view. */
  helperSave(field: string, before: string, after: string): Promise<{ ok: boolean; error: string | null; label: string | null }>;
  /** A full-page picture of a page, local or hosted, at a comparison's width, in a hidden window. */
  compareShot(request: LiveCompareRequest): Promise<LiveCompareShot>;
  /** Whether this build carries the page script (regions, outlines, picking). */
  hasScript(): Promise<boolean>;
  onState(listener: (state: LiveViewState) => void): () => void;

  /* The site helper's trace, lenses and editing in place (src/main/live-inspect.ts). */

  /** The shown page's trace from the site helper, or why there is none. */
  trace(): Promise<LiveTraceAnswer>;
  /** Paint a lens over the page: regions by their index from the last scan. An empty list takes it away. Returns how many it painted. */
  paint(items: LivePaint[]): Promise<number>;
  /** Give the keyboard back to the window (after a pick in the page). */
  focusWindow(): Promise<void>;
  /** Where a region from the last scan is in the view now, in CSS pixels of the view; null when it is not on the page. */
  where(index: number): Promise<{ x: number; y: number; width: number; height: number } | null>;
  /** Open the site's own form for an edit target of the page's trace, laid over a sheet at `bounds` (window CSS pixels). */
  editOpen(target: string, bounds: LiveBounds): Promise<{ ok: boolean; error: string | null }>;
  /** The sheet moved or changed size. */
  editBounds(bounds: LiveBounds): void;
  editClose(): Promise<void>;
  /** Save a new value for an edit target the window draws a form for; the page reloads with it. */
  editSave(target: string, value: unknown): Promise<LiveEditSaved>;
  /** A sheet's form saved (the page reloads with it), or the sheet closed. */
  onEdited(listener: (edited: LiveEdited) => void): () => void;
  /** A key pressed in the page that the window acts on: Escape, while a lens is on. */
  onKey(listener: (key: 'Escape') => void): () => void;
  /** Let the owner drag what the spec allows on the page; answers what was dropped (shown on the page, not saved), or null when arranging stopped. */
  arrange(spec: ArrangeSpec): Promise<ArrangeDrop | null>;
  disarm(): Promise<void>;
  /** Show a part moved before, after or into another on the page, until unpreview or a reload. */
  preview(item: number, ref: number, place: 'before' | 'after' | 'into'): Promise<boolean>;
  unpreview(): Promise<void>;
  /** Save a move through the site helper; the page reloads with it. */
  move(move: LiveMove): Promise<LiveMoveSaved>;
  /** Insert a palette entry through the site helper; the page reloads with it. */
  insert(insert: LiveInsert): Promise<LiveMoveSaved>;
  /** Put back a move or insert, by the token the site gave for it. */
  undo(token: string): Promise<LiveMoveSaved>;
}

export interface WaniganBridge {
  call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>>;
  on(listener: <E extends EventName>(event: E, data: Events[E]) => void): () => void;
  status(): Promise<CoreStatus>;
  onStatus(listener: (status: CoreStatus) => void): () => void;
  /** What is wrong with the core, if anything; null when nothing is. */
  coreProblem(): Promise<CoreProblem | null>;
  onCoreProblem(listener: (problem: CoreProblem | null) => void): () => void;
  /** Answer the problem. Resolves when it is done; what follows arrives as status and problem. */
  coreAction(action: CoreAction): Promise<void>;
  pickFolder(): Promise<string | null>;
  /** Open the demo beside this window: its own instance and data, nothing real. False when already in it. */
  openDemo(): Promise<boolean>;
  /** The Attach dialog. Null when it was cancelled (or outside the app). */
  pickFiles(): Promise<PickedFiles | null>;
  openPath(path: string): Promise<void>;
  /** The app asks the window to go somewhere, e.g. after a notification is clicked. */
  onNavigate(listener: (hash: string) => void): () => void;
  /** Needs to show as alert cards, offered while the window is in front. */
  onAlerts(listener: (needs: Need[]) => void): () => void;
  /** Tell the app which alerts were shown, or were already on screen, by need key. */
  alertsSeen(keys: string[]): Promise<void>;
  /** Tell the app which alerts the owner dismissed or opened, so they are not announced again. */
  alertsDismissed(keys: string[]): Promise<void>;
  /** A command chosen from the app menu (an id from shared/shortcuts.ts). */
  onCommand(listener: (id: string) => void): () => void;
  /** The app's own settings and what they are doing now (null outside the app). */
  appState(): Promise<AppState | null>;
  setSettings(patch: Partial<AppSettings>): Promise<AppState | null>;
  /** Ask GitHub now whether a newer version is out. Resolves with the result (null outside the app). */
  checkForUpdates(): Promise<AppState | null>;
  /** Open the new version the last check found: its disk image, or its release notes. */
  openUpdate(which: 'download' | 'notes'): Promise<void>;
  onAppState(listener: (state: AppState) => void): () => void;
  /** The live view; absent where nothing can show a site. */
  live?: LiveBridge;
  platform: string;
}
