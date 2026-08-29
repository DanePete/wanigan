import { app } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
const LABEL = 'io.deadnorth.wanigan.scheduler';

function plistPath(): string { return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`); }
function xml(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

export function isDaemonInvocation(argv: string[] = process.argv): boolean { return argv.includes('--daemon'); }

export function daemonStatus(): { supported: boolean; installed: boolean; path: string; detail: string } {
  const file = plistPath();
  return process.platform === 'darwin'
    ? { supported: true, installed: fs.existsSync(file), path: file, detail: fs.existsSync(file) ? 'The local Wanigan scheduler starts at login and runs without a window.' : 'Schedules run only while Wanigan is open.' }
    : { supported: false, installed: false, path: file, detail: 'A durable local scheduler is currently implemented for macOS launchd.' };
}

/** Install an explicit per-user daemon; it never uploads a repository or opens
 * a port.  `--daemon` starts the same signed app with no BrowserWindow. */
export async function installDaemon(): Promise<ReturnType<typeof daemonStatus>> {
  if (process.platform !== 'darwin') throw new Error('Durable scheduling is currently available on macOS only.');
  const file = plistPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const args = app.isPackaged ? [process.execPath, '--daemon'] : [process.execPath, app.getAppPath(), '--daemon'];
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${LABEL}</string>\n<key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join('')}</array>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>ProcessType</key><string>Background</string>\n</dict></plist>\n`;
  fs.writeFileSync(file, body, { mode: 0o600 });
  try {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    await exec('launchctl', ['bootstrap', `gui/${uid}`, file], { timeout: 10_000 });
  } catch (e) {
    // A changed plist can already be bootstrapped; kickstart below is enough.
    const text = e instanceof Error ? e.message : String(e);
    if (!/already bootstrapped|service already loaded/i.test(text)) throw new Error(`LaunchAgent was written but could not start: ${text}`);
  }
  try { await exec('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? 0}/${LABEL}`], { timeout: 10_000 }); } catch { /* bootstrap normally started it */ }
  return daemonStatus();
}

export async function uninstallDaemon(): Promise<ReturnType<typeof daemonStatus>> {
  if (process.platform !== 'darwin') throw new Error('Durable scheduling is currently available on macOS only.');
  const file = plistPath();
  const uid = process.getuid?.() ?? 0;
  try { await exec('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { timeout: 10_000 }); } catch { /* it may not currently be loaded */ }
  try { fs.rmSync(file, { force: true }); } catch (e) { throw new Error(`Could not remove the LaunchAgent: ${e instanceof Error ? e.message : String(e)}`); }
  return daemonStatus();
}
