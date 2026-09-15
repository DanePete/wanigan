import type { BrowserWindow } from 'electron';
import { macSettings, setMacSetting, type MacSettings } from './p8-settings';
import { startMacPresence, stopMacPresence } from './mac-presence';

/**
 * The Mac around the app, local automation and attribution, wired once.
 *
 * index.ts is the file every package touches, so this package's wiring lives
 * here and index.ts calls three functions: register the channels, start the
 * services, stop them. Every channel validates its own arguments in the module
 * it calls; the renderer is untrusted here as everywhere.
 */

type Handle = <T>(channel: string, fn: (...args: never[]) => T | Promise<T>) => void;

export type P8Deps = {
  /** Brings the window forward (creating it if it was closed) and resolves once it can take a message. */
  reveal: () => Promise<BrowserWindow | null>;
  liveWindow: () => BrowserWindow | null;
  smoke: boolean;
};

let deps: P8Deps | null = null;

/** Apply what the settings say to the running services. Idempotent. */
function applySettings(settings: MacSettings): void {
  if (!deps || deps.smoke) return;
  if (settings.dockBadge || settings.menuBarSessions) startMacPresence({ reveal: deps.reveal });
  else stopMacPresence();
}

export function registerP8Ipc(handle: Handle): void {
  handle('mac:settings', () => macSettings());
  handle('mac:setSetting', (key: unknown, value: unknown) => {
    const next = setMacSetting(key, value);
    applySettings(next);
    return next;
  });
}

export function startP8Services(next: P8Deps): void {
  deps = next;
  applySettings(macSettings());
}

export function stopP8Services(): void {
  stopMacPresence();
  deps = null;
}
