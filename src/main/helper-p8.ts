import type { BrowserWindow } from 'electron';
import { macSettings, setMacSetting, type MacSettings } from './p8-settings';
import { startMacPresence, stopMacPresence } from './mac-presence';
import {
  automationLedger, automationStatus, startAutomationSocket, stopAutomationSocket, takeAutomationDrafts,
} from './automation-socket';
import * as terminalsMod from './operator-terminals';

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

  handle('scripts:list', (projectId: unknown, target: unknown) => terminalsMod.listScripts(projectId, target));
  handle('scripts:favourite', (projectId: unknown, source: unknown, name: unknown, on: unknown) => terminalsMod.setScriptFavourite(projectId, source, name, on));
  handle('scripts:run', (projectId: unknown, source: unknown, name: unknown, target: unknown) => terminalsMod.runScript(projectId, source, name, target));
  handle('scripts:recentRuns', (projectId: unknown) => terminalsMod.recentOperatorRuns(projectId));
  handle('opterm:open', (projectId: unknown, target: unknown) => terminalsMod.openOperatorTerminal(projectId, target));
  handle('opterm:list', () => terminalsMod.listOperatorTerminals());
  handle('opterm:scrollback', (id: unknown) => terminalsMod.operatorTerminalScrollback(id));
  handle('opterm:close', (id: unknown) => terminalsMod.closeOperatorTerminal(id));
  handle('opterm:resize', (id: unknown, cols: unknown, rows: unknown) => terminalsMod.resizeOperatorTerminal(id, cols, rows));
  handle('opterm:write', (id: unknown, data: unknown) => terminalsMod.writeOperatorTerminal(id, data));
}

export function startP8Services(next: P8Deps): void {
  deps = next;
  terminalsMod.setOperatorTerminalWindow(next.liveWindow);
  void applySettings(macSettings()).catch((error) => console.warn('[wanigan] P8 services did not start:', error));
}

export function stopP8Services(): void {
  stopMacPresence();
  stopAutomationSocket();
  // The operator's terminals are the operator's, but a quit ends every child
  // process Wanigan spawned; a shell left orphaned would outlive the window
  // that was the only way to see it.
  terminalsMod.closeAllOperatorTerminals();
  deps = null;
}
