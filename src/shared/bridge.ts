// What the renderer can reach: `window.wanigan`. In the app it is the preload
// bridge; in the browser test harness it is the same shape over HTTP.
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
  platform: string;
}
