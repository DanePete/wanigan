// What the renderer can reach: `window.wanigan`. In the app it is the preload
// bridge; in the browser test harness it is the same shape over HTTP.
import type { LivePick, LiveProblem, LiveRegion } from './live.ts';
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

/**
 * The live view: the owner's local site laid over a placeholder in the window.
 * In the app the main process owns it (src/main/live-view.ts); the UI sweep's
 * test bridge plays it with a frame.
 */
export interface LiveBridge {
  /**
   * Show a project's site over the placeholder. False when the live view is off or the address is refused.
   * `token` is the site helper's, sent with the view's own page loads to that site.
   */
  show(projectId: string, url: string, bounds: LiveBounds, token?: string | null): Promise<boolean>;
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
  /** Whether this build carries the page script (regions, outlines, picking). */
  hasScript(): Promise<boolean>;
  onState(listener: (state: LiveViewState) => void): () => void;
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
