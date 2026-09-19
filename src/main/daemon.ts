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
 * one for the host. launchd and Task Scheduler are both real implementations
 * rather than one plus an adapter written around it, which is the only way to
 * know the seam is in the right place.
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

/** The launchd job label; the Windows task name is below. Both want stability. */
const LABEL = 'io.deadnorth.wanigan.scheduler';
const TASK_NAME = 'Wanigan Scheduler';

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

/* ── Task Scheduler (Windows) ─────────────────────────────────────────── */

/**
 * `schtasks` rather than a .lnk in the Startup folder.
 *
 * A Startup shortcut would be simpler and is the wrong shape: it is a file
 * anything can drop, it runs only in an interactive session that has already
 * drawn a desktop, and it cannot say it failed. A registered task is inspectable
 * in one place the operator already trusts, and `/Query` gives an honest answer
 * to "is this installed" rather than "does a file exist".
 *
 * `/SC ONLOGON` is launchd's RunAtLoad. There is deliberately no equivalent of
 * its KeepAlive: restarting a dead task needs a full task XML definition rather
 * than a schtasks flag, and claiming a restart that will not happen is worse
 * than not claiming it. The caveat below says so rather than leaving somebody to
 * find out from a schedule that stopped firing.
 */
const schtasks: DaemonBackend = {
  id: 'schtasks',
  path: () => `Task Scheduler \\ ${TASK_NAME}`,
  caveat: 'This PC must be signed in and awake. The task starts at logon and is not restarted if it stops.',
  installedDetail: 'A Windows scheduled task starts the local Wanigan scheduler at logon, without a window.',

  async installed() {
    try {
      await exec('schtasks', ['/Query', '/TN', TASK_NAME], { timeout: 10_000, windowsHide: true });
      return true;
    } catch {
      // schtasks exits non-zero when the task does not exist, which is the
      // normal answer here rather than a failure to report.
      return false;
    }
  },

  async install(argv) {
    // One string for /TR, with the executable quoted because Program Files has
    // a space in it and schtasks splits on the first one otherwise.
    const [bin, ...rest] = argv;
    const command = [`"${bin}"`, ...rest].join(' ');
    try {
      await exec('schtasks', ['/Create', '/TN', TASK_NAME, '/TR', command, '/SC', 'ONLOGON', '/F'], {
        timeout: 15_000, windowsHide: true,
      });
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      throw new Error(`The scheduled task could not be created: ${text}`);
    }
  },

  async uninstall() {
    try {
      await exec('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { timeout: 10_000, windowsHide: true });
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      // Already gone is the outcome the caller wanted.
      if (/cannot find|does not exist/i.test(text)) return;
      throw new Error(`Could not remove the scheduled task: ${text}`);
    }
  },
};

/* ── selection ────────────────────────────────────────────────────────── */

function backend(): DaemonBackend | null {
  const platform = hostPlatform();
  if (platform === 'darwin') return launchd;
  if (platform === 'win32') return schtasks;
  // Linux is a systemd user unit and nobody has written or run one. Saying that
  // is better than a third implementation this repository cannot verify.
  return null;
}

const UNSUPPORTED = 'A durable local scheduler is implemented for macOS launchd and the Windows Task Scheduler. Schedules run while Wanigan is open.';

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
