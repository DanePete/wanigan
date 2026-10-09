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
  /** The live view: each project's local site inside Wanigan. Off until switched on; the rest of these need it. */
  liveView: boolean;
  /** Reload and outline as the agents edit. Off: an edit only says what changed, and the owner reloads. */
  liveFollow: boolean;
  /** Which kinds of site get a live view, and with it that platform's own integration. */
  liveDrupal: boolean;
  liveWordpress: boolean;
  /** Any other site: a JS app's dev server, a static site, anything with an address. */
  liveSites: boolean;
  /** Before and after screenshots of a card's page, on the card. */
  liveShots: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  keepAwake: true, notifications: 'all', updateChecks: 'ask',
  liveView: false, liveFollow: true, liveDrupal: true, liveWordpress: true, liveSites: true, liveShots: false,
};

/** Whether the live view is on for a kind of site (null: not chosen yet, so on if any kind is). */
export function liveFor(s: AppSettings, platform: 'drupal' | 'wordpress' | 'site' | null): boolean {
  if (!s.liveView) return false;
  if (platform === 'drupal') return s.liveDrupal;
  if (platform === 'wordpress') return s.liveWordpress;
  if (platform === 'site') return s.liveSites;
  return s.liveDrupal || s.liveWordpress || s.liveSites;
}

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
    liveView: typeof p.liveView === 'boolean' ? p.liveView : current.liveView,
    liveFollow: typeof p.liveFollow === 'boolean' ? p.liveFollow : current.liveFollow,
    liveDrupal: typeof p.liveDrupal === 'boolean' ? p.liveDrupal : current.liveDrupal,
    liveWordpress: typeof p.liveWordpress === 'boolean' ? p.liveWordpress : current.liveWordpress,
    liveSites: typeof p.liveSites === 'boolean' ? p.liveSites : current.liveSites,
    liveShots: typeof p.liveShots === 'boolean' ? p.liveShots : current.liveShots,
  };
}
