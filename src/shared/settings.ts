// The app's own settings: what the Electron app does on this Mac, as opposed to
// anything about projects or sessions (those live in the core). Kept by the main
// process in a small file; the window only ever sends a patch, which is
// untrusted until it has been through `patchSettings`.
import { UPDATE_CHECKS, type UpdateChecks, type UpdateStatus } from './updates.ts';

/** What gets announced: everything, only permission requests and failures, or nothing. */
export const NOTIFY_LEVELS = ['all', 'urgent', 'off'] as const;
export type NotifyLevel = (typeof NOTIFY_LEVELS)[number];

export interface AppSettings {
  /** Keep the Mac from sleeping while any session is live. */
  keepAwake: boolean;
  /** Notifications while Wanigan is in the background, and alert cards while it is in front. */
  notifications: NotifyLevel;
  /** Check GitHub for a new version once a day, or only when asked. "ask" until the owner answers. */
  updateChecks: UpdateChecks;
}

export const DEFAULT_SETTINGS: AppSettings = { keepAwake: true, notifications: 'all', updateChecks: 'ask' };

/** What the window is told: the settings, and what they are doing right now. */
export interface AppState {
  settings: AppSettings;
  /** Whether Wanigan is holding the Mac awake now, and for how many live sessions. */
  awake: { holding: boolean; live: number };
  /** This app's version. */
  version: string;
  /** What the last update check found; null where the app does not check (the demo). */
  updates: UpdateStatus | null;
}

/** Settings from disk: anything missing or of the wrong type is the default, never an error. */
export function readSettings(raw: unknown): AppSettings {
  return patchSettings(DEFAULT_SETTINGS, raw);
}

/** Apply an untrusted patch: known fields of the right type only; the rest is ignored. */
export function patchSettings(current: AppSettings, patch: unknown): AppSettings {
  const p = (patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}) as Record<string, unknown>;
  return {
    keepAwake: typeof p.keepAwake === 'boolean' ? p.keepAwake : current.keepAwake,
    notifications: (NOTIFY_LEVELS as readonly unknown[]).includes(p.notifications) ? p.notifications as NotifyLevel : current.notifications,
    updateChecks: (UPDATE_CHECKS as readonly unknown[]).includes(p.updateChecks) ? p.updateChecks as UpdateChecks : current.updateChecks,
  };
}
