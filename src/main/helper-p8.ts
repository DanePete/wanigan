import type { BrowserWindow } from 'electron';
import { macSettings, setMacSetting, type MacSettings } from './p8-settings';
import { startMacPresence, stopMacPresence } from './mac-presence';
import {
  automationLedger, automationStatus, startAutomationSocket, stopAutomationSocket, takeAutomationDrafts,
} from './automation-socket';

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
async function applySettings(settings: MacSettings): Promise<void> {
  if (!deps || deps.smoke) return;
  if (settings.dockBadge || settings.menuBarSessions) startMacPresence({ reveal: deps.reveal });
  else stopMacPresence();
  if (settings.automationSocket) await startAutomationSocket({ liveWindow: deps.liveWindow });
  else stopAutomationSocket();
}

export function registerP8Ipc(handle: Handle): void {
  handle('mac:settings', () => macSettings());
  handle('mac:setSetting', async (key: unknown, value: unknown) => {
    const next = setMacSetting(key, value);
    await applySettings(next);
    return next;
  });
  handle('automation:status', () => automationStatus());
  handle('automation:ledger', (limit: unknown) => automationLedger(typeof limit === 'number' ? limit : 50));
  handle('automation:takeDrafts', () => takeAutomationDrafts());
}

export function startP8Services(next: P8Deps): void {
  deps = next;
  void applySettings(macSettings()).catch((error) => console.warn('[wanigan] P8 services did not start:', error));
}

export function stopP8Services(): void {
  stopMacPresence();
  stopAutomationSocket();
  deps = null;
}
