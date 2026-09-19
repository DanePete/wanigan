/**
 * A scheduler that keeps running when the window is closed, per platform.
 *
 * This was launchd and a hardcoded `process.platform !== 'darwin'` throw, which
 * is what "currently implemented for macOS" looks like from the inside: no seam
 * to add a second one at, so adding Windows meant three more branches through
 * the same three functions. `AGENTS.md` calls that a missing extension point,
 * and says building the point is the work.
 *
 * So a backend answers four questions — where its registration lives, whether
 * it is installed, how to install it, how to remove it — and `backend()` picks
 * one for the host. This commit is the move alone: launchd goes behind the seam
 * and every platform still does exactly what it did.
 *
 * What a backend does NOT get to decide is the shape of the answer. `status()`
 * always returns the same record, including `caveat`, which exists because the
 * Schedules view used to hardcode "This Mac must be awake" — a sentence that is
 * true of launchd, false of nothing in particular on Windows, and not the
 * renderer's to know either way.
 */

import { app } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostPlatform } from './platform';

const exec = promisify(execFile);

/** The launchd job label. A backend that registers by name uses this too. */
const LABEL = 'io.deadnorth.wanigan.scheduler';

export type DaemonStatus = {
  supported: boolean;
  installed: boolean;
  /** Where the registration lives, for somebody who wants to look at it. */
  path: string;
  detail: string;
  /**
   * What is true while it is installed, in one clause, or '' when it is not.
   * Platform-specific and therefore the backend's to say, not the view's.
   */
  caveat: string;
};

type DaemonBackend = {
  id: string;
  /** Where the registration lives. Shown even when nothing is installed. */
  path(): string;
  installed(): Promise<boolean>;
  install(argv: string[]): Promise<void>;
  uninstall(): Promise<void>;
  /** Said while installed. Names what the operator is still responsible for. */
  caveat: string;
  installedDetail: string;
};

/**
 * The argv a background instance is started with.
 *
 * Packaged, the executable is Wanigan itself. Unpackaged, Electron needs the app
 * directory as its first argument or it opens its default window instead — which
 * is a background scheduler that is neither.
 */
function daemonArgv(): string[] {
  return app.isPackaged
    ? [process.execPath, '--daemon']
    : [process.execPath, app.getAppPath(), '--daemon'];
}

export function isDaemonInvocation(argv: string[] = process.argv): boolean {
  return argv.includes('--daemon');
}

/* ── launchd (macOS) ──────────────────────────────────────────────────── */

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const launchd: DaemonBackend = {
  id: 'launchd',
  path: () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`),
  installed: async () => fs.existsSync(launchd.path()),
  caveat: 'This Mac must be awake. A closed window does not pause schedules.',
  installedDetail: 'The local Wanigan scheduler starts at login and runs without a window.',

  async install(argv) {
    const file = launchd.path();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${LABEL}</string>\n<key>ProgramArguments</key><array>${argv.map((a) => `<string>${xml(a)}</string>`).join('')}</array>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>ProcessType</key><string>Background</string>\n</dict></plist>\n`;
    fs.writeFileSync(file, body, { mode: 0o600 });
    const uid = process.getuid?.() ?? 0;
    try {
      await exec('launchctl', ['bootstrap', `gui/${uid}`, file], { timeout: 10_000 });
    } catch (e) {
      // A changed plist can already be bootstrapped; kickstart below is enough.
      const text = e instanceof Error ? e.message : String(e);
      if (!/already bootstrapped|service already loaded/i.test(text)) {
        throw new Error(`LaunchAgent was written but could not start: ${text}`);
      }
    }
    try {
      await exec('launchctl', ['kickstart', '-k', `gui/${uid}/${LABEL}`], { timeout: 10_000 });
    } catch { /* bootstrap normally started it */ }
  },

  async uninstall() {
    const file = launchd.path();
    const uid = process.getuid?.() ?? 0;
    try { await exec('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { timeout: 10_000 }); } catch { /* it may not currently be loaded */ }
    try { fs.rmSync(file, { force: true }); } catch (e) {
      throw new Error(`Could not remove the LaunchAgent: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

/* ── selection ────────────────────────────────────────────────────────── */

function backend(): DaemonBackend | null {
  const platform = hostPlatform();
  if (platform === 'darwin') return launchd;
  // Windows and Linux have backends to write — a scheduled task and a systemd
  // user unit — and neither is written here. This commit moves launchd behind
  // the seam without changing what any platform does.
  return null;
}

const UNSUPPORTED = 'A durable local scheduler is currently implemented for macOS launchd. Schedules run while Wanigan is open.';

export async function daemonStatus(): Promise<DaemonStatus> {
  const impl = backend();
  if (!impl) return { supported: false, installed: false, path: '', detail: UNSUPPORTED, caveat: '' };
  const installed = await impl.installed();
  return {
    supported: true,
    installed,
    path: impl.path(),
    detail: installed ? impl.installedDetail : 'Schedules run only while Wanigan is open.',
    caveat: installed ? impl.caveat : '',
  };
}

/**
 * Install an explicit per-user background scheduler; it never uploads a
 * repository or opens a port. `--daemon` starts the same signed app with no
 * BrowserWindow.
 */
export async function installDaemon(): Promise<DaemonStatus> {
  const impl = backend();
  if (!impl) throw new Error(UNSUPPORTED);
  await impl.install(daemonArgv());
  return daemonStatus();
}

export async function uninstallDaemon(): Promise<DaemonStatus> {
  const impl = backend();
  if (!impl) throw new Error(UNSUPPORTED);
  await impl.uninstall();
  return daemonStatus();
}
