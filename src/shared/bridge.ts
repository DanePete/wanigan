// What the renderer can reach: `window.wanigan`. In the app it is the preload
// bridge; in the browser test harness it is the same shape over HTTP.
import type { LivePick, LiveProblem, LiveRegion } from './live.ts';
import type { CompareWidth } from './live-compare.ts';
import type { LiveEditSaved, LiveEdited, LivePaint, LiveTraceAnswer } from './live-lens.ts';
import type { ArrangeDrop, ArrangeSpec, LiveInsert, LiveMove, LiveMoveSaved, LiveRemove, LiveWriteOptions } from './live-arrange.ts';
import type { LibraryPicturesAnswer, LiveLibraryAnswer, LiveUsageAnswer } from './live-library.ts';
import type { LayerApplied, LayerImplemented, LayerPickTarget, LayerProperty, LayerTyped, LayerUndone, LayerVerdict } from './design-layer.ts';
import type { LiveSiteAiAnswer } from './live-ai.ts';
import type { SiteColours } from './site-colours.ts';
import type { LiveFailure } from './live-site.ts';
import type { LiveFindAnswer, LiveHere } from './live-goto.ts';
import type { LiveGesture, LiveKeyId } from './live-keys.ts';
import type { LiveDevtoolsMode, LiveRevealed } from './live-devtools.ts';
import type { LiveStep } from './live-record.ts';
import type { Need } from './model.ts';
import type { EventName, Events, Method, Params, Result } from './protocol.ts';
import type { AppSettings, AppState } from './settings.ts';
import type { VoiceModelId, VoiceSettings, VoiceStart, VoiceState } from './voice.ts';

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
  /**
   * Why the page did not load: Chromium's words (e.g. ERR_CERT_AUTHORITY_INVALID)
   * and, when it refused a certificate, that certificate as the site presented it.
   */
  error: LiveFailure | null;
  /** The HTTP status of the page shown, when one loaded (a router's 404 for a site that is not running, say). */
  status: number | null;
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
 * A picture Wanigan kept of a page on this site, for Compare's Before: a card's page from before (`made-real`, kept
 * when the card was made real; `label` names it) or one kept by hand (`kept`). At the widths it was kept at.
 */
export interface LiveKeptPage { id: string; at: number; why: 'made-real' | 'kept'; label: string | null; widths: number[] }

/** A picture of the live view for a snap: what it shows now, or the whole page taken again at its width. */
export type LiveSnapShot =
  | {
    scope: 'view' | 'page';
    /** PNG, base64. */
    data: string;
    /** Pixels of the image (the CSS size times the screen's scale). */
    width: number;
    height: number;
    /** What it shows, in CSS pixels: the view's size, or the page's width and the height pictured. */
    cssWidth: number;
    cssHeight: number;
    /** Where the view was scrolled (0 for the whole page). */
    scrollX: number;
    scrollY: number;
    url: string;
    /** The whole page's own regions, read as it was taken (null for the view: the window's last scan is the view's). */
    regions: LiveRegion[] | null;
    /** The page was taller than a picture holds and is shown down to there. */
    cut: boolean;
  }
  | { error: string };

/** Why a recording stopped: the owner (its control or its key), Escape on the page, the two-minute limit, the view going away, or a failure. */
export type LiveRecordStop = 'owner' | 'escape' | 'limit' | 'view' | 'error';

/** A recording of the live view, kept in Wanigan's data for the project (never in the site's files). */
export interface LiveRecording {
  id: string;
  projectId: string;
  /** The page it began on. */
  url: string;
  startedAt: number;
  /** How long it ran. */
  ms: number;
  /** The view's width in CSS pixels as it began. */
  viewWidth: number | null;
  /** The folder it is kept in, in Wanigan's own data. */
  folder: string;
  /** The clip, a WebM video for the owner (never sent to an agent); null with `clipWhy`. */
  clip: { file: string; bytes: number; width: number; height: number; frames: number } | null;
  clipWhy: string | null;
  /** The key frames an agent is sent, in time order: each a JPEG in the folder. */
  keyFrames: { n: number; file: string; at: number; why: string; step: number | null }[];
  steps: LiveStep[];
  /** The log stopped at its limit. */
  cut: boolean;
  stopped: LiveRecordStop;
}

/** The recorder as the window sees it. */
export interface LiveRecordState {
  /** Recording now. */
  on: boolean;
  projectId: string | null;
  startedAt: number | null;
  /** The longest a recording runs. */
  limitMs: number;
  frames: number;
  steps: number;
  /** Stopped, and writing the clip and the key frames. */
  saving: boolean;
  /** What the last recording came to, once saved. */
  done: LiveRecording | null;
  error: string | null;
}

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
  /**
   * The regions the last in-place stylesheet swap restyled: the parts its changed rules style (a theme's own CSS names
   * no part as its source). Waits for the new copies to load.
   */
  restyled(): Promise<number[]>;
  /** Hide the site's own admin bars in the view (Drupal's toolbar, top bar and sidebar; WordPress's admin bar), or show them; kept across loads. Answers what is now in force. */
  hideAdmin(hide: boolean): Promise<boolean>;
  /** The site's own status messages on each page the view loads (hidden in the page, said in Wanigan's pop-up there): for the window's tray. */
  onSiteMessages(listener: (said: { projectId: string; messages: { kind: 'status' | 'warning' | 'error'; text: string }[] }) => void): () => void;
  /** Go to another page of the same site. */
  go(url: string): Promise<boolean>;
  back(): Promise<void>;
  forward(): Promise<void>;
  /** Open the page in the default browser. */
  open(): Promise<void>;
  /*
   * The page's own Chromium DevTools (src/main/live-devtools.ts; the model is src/shared/live-devtools.ts): in a plain
   * view of its own laid over the dock's DevTools tab, or in a window of its own. It is the page's DevTools: the page's
   * WebContents has no Node and no Wanigan preload, and the view DevTools is drawn in is given neither.
   */

  /**
   * The dock shows the DevTools tab over these bounds (window CSS pixels): DevTools opens there, or shows again as it
   * was. Answers where DevTools is now: `detached` when it is in its own window (it stays there), `closed` with no page.
   * `focus`: the owner opened it just now (its key, its control), so the keyboard goes to it, as Chrome's does.
   */
  devtoolsShow(bounds: LiveBounds, focus?: boolean): Promise<LiveDevtoolsMode>;
  /** The tab's area moved or changed size. */
  devtoolsBounds(bounds: LiveBounds): void;
  /** The tab is not shown, or something covers it: DevTools steps aside, still open. With `frame`, its last picture comes back. */
  devtoolsHide(frame?: boolean): Promise<string | null>;
  /** Close DevTools, in the dock or in its own window: the owner left the project, or closed it. */
  devtoolsClose(): Promise<void>;
  /** DevTools in a window of its own, for a second screen; the dock's view closes. False with no page. */
  devtoolsDetach(): Promise<boolean>;
  /**
   * Select the element at a point of the page (CSS pixels of the view) in DevTools' Elements panel: in its own window
   * when it is there, else in the dock, opening it there when it is closed. False with no page or a point outside it.
   */
  devtoolsInspect(x: number, y: number): Promise<boolean>;
  /** Where DevTools is, each time that changes (its own window closed by the owner, too). */
  onDevtools(listener: (mode: LiveDevtoolsMode) => void): () => void;
  /**
   * A part's box in the view now (CSS pixels of the viewport; it may run off an edge) and the viewport's size it was
   * measured in, after scrolling the page to it when none of it was on screen: a region from the last scan, or the
   * picked element (null). Null when it is not on the page.
   */
  reveal(index: number | null): Promise<LiveRevealed | null>;
  /** The regions of the page and what produced each. */
  scan(): Promise<LiveRegion[]>;
  /** Outline regions by their index from the last scan: an edit's, a pointed-at row's (dashed), a pick's. Returns how many were drawn. */
  outline(indexes: number[], label: string | null, tone?: LiveTone): Promise<number>;
  clear(): Promise<void>;
  /**
   * Let the owner pick an element; null when they pressed Escape or picking was cancelled. `start` is a region from
   * the last scan where the keyboard starts walking (else the page's main content), so picking needs no pointer.
   */
  pick(start?: number | null): Promise<LivePick | null>;
  /** Make a region from the last scan the picked element, as choosing it in the Layers tree does; null when it has none. */
  choose(index: number): Promise<LivePick | null>;
  cancelPick(): Promise<void>;
  /** A PNG (base64) of what the view shows, or of one rectangle of the page in CSS pixels of the view. */
  capture(rect?: { x: number; y: number; width: number; height: number }): Promise<string | null>;
  /** What the site says is wrong on the page, and what its console logged as errors since it loaded. */
  problems(): Promise<LiveProblem[]>;
  /** How many times the page has changed itself since it loaded: late content means scanning again. */
  mutations(): Promise<number>;
  /** The picked element, described again: its words, its style and every region it sits in, innermost first. */
  picked(): Promise<LivePick | null>;
  /** The site helper's count of content changes (null without a helper, or when it did not answer). */
  helperChanged(): Promise<number | null>;
  /**
   * Save words to a plain text field through the site helper, as the user logged in in the view. When the site
   * did not answer, `failure` says how, for the same words the view uses.
   */
  helperSave(field: string, before: string, after: string): Promise<{ ok: boolean; error: string | null; label: string | null; failure?: LiveFailure | null }>;
  /** A full-page picture of a page, local or hosted, at a comparison's width, in a hidden window. */
  compareShot(request: LiveCompareRequest): Promise<LiveCompareShot>;
  /** Whether this build carries the page script (regions, outlines, picking). */
  hasScript(): Promise<boolean>;
  onState(listener: (state: LiveViewState) => void): () => void;

  /* The site helper's trace, lenses and editing in place (src/main/live-inspect.ts). */

  /** The shown page's trace from the site helper, or why there is none. */
  trace(): Promise<LiveTraceAnswer>;
  /** The site's AI as its core reports it (connectors and where their keys come from, abilities, what saving runs): read-only, free. */
  siteAi(): Promise<LiveSiteAiAnswer>;
  /** Paint a lens over the page: regions by their index from the last scan. An empty list takes it away. Returns how many it painted. */
  paint(items: LivePaint[]): Promise<number>;
  /** Give the keyboard back to the window (after a pick in the page). */
  focusWindow(): Promise<void>;
  /** Where a region from the last scan is in the view now, in CSS pixels of the view; null when it is not on the page. */
  where(index: number): Promise<{ x: number; y: number; width: number; height: number } | null>;
  /** What regions from the last scan show, as short hashes (null: not on the page): compared across a write and its reload. */
  fingerprints(indexes: number[]): Promise<Record<number, string | null>>;
  /** Open the site's own form for an edit target of the page's trace, laid over a sheet at `bounds` (window CSS pixels). */
  editOpen(target: string, bounds: LiveBounds): Promise<{ ok: boolean; error: string | null }>;
  /** The sheet moved or changed size. */
  editBounds(bounds: LiveBounds): void;
  editClose(): Promise<void>;
  /** Save a new value for an edit target the window draws a form for; the page reloads with it. */
  editSave(target: string, value: unknown, options?: LiveWriteOptions): Promise<LiveEditSaved>;
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
  move(move: LiveMove, options?: LiveWriteOptions): Promise<LiveMoveSaved>;
  /** Insert a palette entry through the site helper; the page reloads with it. */
  insert(insert: LiveInsert, options?: LiveWriteOptions): Promise<LiveMoveSaved>;
  /** Take one item out of its collection through the site helper: only its placement or reference goes. The page reloads with it. */
  remove(remove: LiveRemove, options?: LiveWriteOptions): Promise<LiveMoveSaved>;
  /** Put back a move, insert or removal, by the token the site gave for it. */
  undo(token: string): Promise<LiveMoveSaved>;
  /* The component library (src/main/live-library.ts; the helpers' contract is src/shared/live-library.ts). */

  /** What a project's site can place, from its core's registries through the helper, or why not. Kept a minute unless refreshed. */
  library(projectId: string, options?: { refresh?: boolean }): Promise<LiveLibraryAnswer>;
  /** Pictures of library entries rendered alone, at 390 and 1440 px (or the widths given): paths in Wanigan's data folder, kept by the library's hash. */
  libraryPictures(projectId: string, entries: string[], options?: { widths?: number[]; refresh?: boolean }): Promise<LibraryPicturesAnswer>;
  /** A kept picture of an entry at a width, as base64 PNG; null when there is none for the library as it is now. */
  libraryPicture(projectId: string, entry: string, width: number): Promise<string | null>;
  /**
   * Where a library entry is used across the site, as its stored data says, from the helper's search (read-only,
   * bounded at ten seconds): each place, the page that shows it, what the search covered and what it cannot see.
   * Kept half a minute unless refreshed.
   */
  libraryUsage(projectId: string, entry: string, options?: { refresh?: boolean }): Promise<LiveUsageAnswer>;
  /*
   * The design layer, the main process's side (src/main/live-layer.ts; the contract is src/shared/design-layer.ts).
   * The edits themselves are the core's (`live.layer*`); these show them on the page, key a new one, make one real
   * and verify it. After any change to the log the window calls layerApply().
   */

  /** Show the layer on the page shown: read the project's edits from the core, find each target, tag it, inject the preview, patch words. Runs again by itself after every load. */
  layerApply(): Promise<LayerApplied>;
  /** Show the page with the layer, or as the site renders it without one (for comparing). On by default; a load keeps the choice. */
  layerShow(on: boolean): Promise<LayerApplied>;
  /** The picked element as an edit would be keyed to it: its target, what `kind` would reach, its values before. Null with nothing picked. */
  layerTarget(): Promise<LayerPickTarget | null>;
  /** Make one edit real in the site, where phase 1 can (words in a plain text field, through the helper), and tell the core. */
  layerImplement(id: string): Promise<LayerImplemented>;
  /** Put back the words a stored-words save wrote for an edit (its answer said `undo`), while the site still holds them, from the page it was made on. */
  layerUndo(id: string): Promise<LayerUndone>;
  /** Verify one implemented edit (or every implemented edit of this page): the page as designed against the page as the site renders it, at the given widths (default 390 and 1440). Tells the core. */
  layerVerify(id: string | null, options?: { widths?: number[] }): Promise<LayerVerdict>;
  /** A verification picture (a path a verdict named) as base64 PNG, for a window that cannot read the data folder. */
  layerPicture(path: string): Promise<string | null>;
  /** The pictures kept of the page shown, newest first: Compare's Before. */
  layerKept(): Promise<LiveKeptPage[]>;
  /** A kept picture of the page shown and the page as it renders now, the same way and held at the same time. */
  layerKeptShot(id: string, width: number): Promise<{ before: LiveCompareShot; now: LiveCompareShot } | { error: string }>;
  /** Keep the page shown as it is now, at the kept widths. */
  layerKeep(): Promise<LiveKeptPage | { error: string }>;
  /**
   * Type on the picked element's own words in the page itself: it becomes editable in place (plain text only, the
   * caret at its end, the keyboard given to the view), and every keystroke shows on the page as it is typed. The
   * element is keyed first, as layerTarget keys it, so its target names the words the site rendered. Answers when
   * typing ends: `kept` with the words (Enter, clicking away in the page, or layerTypeEnd(true)), which the page goes on
   * showing until the window adds them as a text edit and applies the layer; `cancelled` (Escape, layerTypeEnd(false),
   * the same words or none, or the page going to another address, which says why) with the page as it was; `refused`,
   * with why, for an element that is not only words, nothing picked, or a page that is not the local site's.
   */
  layerType(): Promise<LayerTyped>;
  /** End typing on the page from the window: keep the words typed so far (true), or put back what the page showed (false). */
  layerTypeEnd(keep: boolean): Promise<void>;
  /**
   * Show style values at once on the picked element, before they are an edit: one preview the page script owns,
   * outranking the layer's own rules for those properties, never written anywhere. For `this` (the default) on the
   * elements an edit for it would reach, for `kind` on every element of its kind on the page. Each call replaces the
   * last; null, or no value the layer would set, takes it away. Answers how many elements show it.
   */
  layerTry(values: Partial<Record<LayerProperty, string>> | null, scope?: 'this' | 'kind'): Promise<number>;
  /**
   * The site's own colours, for Try a style (src/shared/site-colours.ts): the platform's declared palette from the
   * helper (WordPress's theme.json and global styles), the theme's colour tokens and the colours the page uses, each
   * said by where it came from. Read-only; nothing is made up.
   */
  siteColours(): Promise<SiteColours>;
  /* The Go to launcher (src/main/live-find.ts; the helpers' contract is src/shared/live-find.ts). */

  /** A project's site's destinations: the helper's index, or its search for `query`, or why there are none (with the pages the view knows). */
  find(projectId: string, query?: string, options?: { refresh?: boolean }): Promise<LiveFindAnswer>;
  /** What the page shown is, when the view shows this project's site; null otherwise. */
  findHere(projectId: string): Promise<LiveHere | null>;
  /**
   * Wait for Shift+Space on the page, or one of the live view's own keys (shared/live-keys.ts), while nothing there is
   * typed into: 'goto' or the key's id; 'retype' for a double-click on the picked element's own words; or null when a
   * newer wait or a new page replaced it.
   */
  awaitGoto(): Promise<'goto' | LiveKeyId | LiveGesture | null>;
  /** The launcher takes the keyboard; true when the view's page had it. */
  gotoFocus(): Promise<boolean>;
  /** Give the keyboard back to the view's page. */
  gotoReturn(): Promise<void>;
  /** Open a path of a project's site in the default browser (never with the helper's token). */
  openInBrowser(projectId: string, path: string): Promise<boolean>;
  /*
   * Snap and Record (src/main/live-snap.ts, src/main/live-record.ts; the step log is src/shared/live-record.ts). Nothing
   * here sends anything anywhere: what is kept goes to an agent only through the note composer, on the owner's click.
   */

  /**
   * A picture for a snap: what the view shows now ('view', Wanigan's own outlines left out), or the whole page taken
   * again in a hidden window at the view's width ('page', local site only). Null when the view shows nothing.
   */
  snap(mode: 'view' | 'page'): Promise<LiveSnapShot | null>;
  /**
   * Start recording the view: frames from its own frame subscription (Chromium's, never a screen capture), at most two
   * minutes and about five a second, and a step log the page script and the main process keep. Answers the recorder.
   */
  recordStart(): Promise<LiveRecordState>;
  /** Stop recording, and answer the recording once its clip and key frames are saved (null when none was running). */
  recordStop(): Promise<LiveRecording | null>;
  /**
   * Narration while recording (voice input), kept in the step log as a `said` step. `at` is when the words began, in
   * milliseconds since the epoch (clamped into the recording); without it, when they arrive. False when nothing is
   * recording.
   */
  recordSay(text: string, at?: number): Promise<boolean>;
  /** The recorder as it changes: started, a second later, stopped, saved. */
  onRecord(listener: (state: LiveRecordState) => void): () => void;
  /** One file of a kept recording, base64: its clip (WebM) or key frame n (JPEG). Null when it is not there. */
  recordFile(projectId: string, id: string, file: 'clip' | `frame-${number}`): Promise<string | null>;
  /** Show a kept recording's clip (or its folder) in the system's file manager. */
  recordReveal(projectId: string, id: string): Promise<boolean>;
  /** Delete a kept recording, folder and all. */
  recordDelete(projectId: string, id: string): Promise<boolean>;
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
  /** Voice input (src/main/voice.ts); absent where it cannot run (the phone page, a sweep that does not stub it). */
  voice?: VoiceBridge;
  platform: string;
  /** Tours never start on their own (WANIGAN_TOURS=off): automation that drives the window. Replaying one still works. */
  toursOff?: boolean;
}

/**
 * Voice input: settings, the speech models (downloaded only on the owner's click), and starting a stream. A started
 * stream's MessagePort arrives as a window message `{ wanigan: 'voice-port', id }` with the port (lib/voice.ts reads
 * it): audio goes to the voice worker and words come back over it, never through the bridge.
 */
export interface VoiceBridge {
  state(): Promise<VoiceState | null>;
  onState(listener: (state: VoiceState) => void): () => void;
  setSettings(patch: Partial<VoiceSettings>): Promise<VoiceState | null>;
  download(id: VoiceModelId): Promise<VoiceState | null>;
  cancel(id: VoiceModelId): Promise<VoiceState | null>;
  remove(id: VoiceModelId): Promise<VoiceState | null>;
  start(): Promise<VoiceStart>;
  /** Open the OS's microphone settings, where it has a page for them. False where it has none. */
  openMicSettings(): Promise<boolean>;
}
