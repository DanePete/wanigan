// Paths, the environment the app is launched with, and small process helpers
// shared by the recording and the edit.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const VIDEO_DIR = join(ROOT, 'scripts', 'video');
/** Large outputs: takes, renders, frames. Gitignored with the rest of .artifacts. */
export const ARTIFACTS = join(ROOT, '.artifacts', 'video');
/**
 * Where a take's throwaway data and test site live while it records. Not under
 * a home folder: every path the app shows (Claude Code's banner, the session
 * dialog, a worktree) is seen on camera, and must not carry a user name.
 */
export const WORK_ROOT = process.env.WANIGAN_VIDEO_WORK || '/tmp/wanigan-video';

export function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

export function flag(name) {
  return process.argv.includes(name);
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The environment the app runs in: the person's own, minus what would make it
 * behave unlike a launch from the Dock. ELECTRON_RUN_AS_NODE turns Electron into
 * Node; an editor's or an agent's variables (VS Code, Claude Code's own session
 * markers, CLAUDE_EFFORT) would leak into every session the app starts and
 * change how Claude Code behaves there, such as turning transcript saving off.
 */
export function appEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VSCODE_') || key === 'CLAUDECODE'
      || key.startsWith('CLAUDE_CODE_') || key.startsWith('CLAUDE_AGENT_') || key === 'CLAUDE_EFFORT' || key === 'CLAUDE_PID'
      || key.startsWith('WANIGAN_')) delete env[key];
  }
  return { ...env, ...extra };
}

/** How every video file here is tagged: limited range, BT.709, as players and LinkedIn expect for HD. */
export const VIDEO_COLOR = ['-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];
/** A filter step that brings any input (full-range JPEG frames, RGB PNGs) to that. */
export const TO_VIDEO = 'scale=out_range=tv:out_color_matrix=bt709';

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Stop the core a take started, then let it record its sessions before its folder goes. */
export async function stopCore(dataDir) {
  let pid = 0;
  try { pid = JSON.parse(readFileSync(join(dataDir, 'core.json'), 'utf8')).pid; } catch { return; }
  if (!pid || !alive(pid)) return;
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 80 && alive(pid); i++) await sleep(100);
}

/** The ffmpeg on PATH (Homebrew's), or a clear error. */
export function ffmpegPath(name = 'ffmpeg') {
  for (const dir of (process.env.PATH ?? '').split(':').concat(['/opt/homebrew/bin', '/usr/local/bin'])) {
    const p = join(dir, name);
    if (dir && existsSync(p)) return p;
  }
  throw new Error(`${name} was not found. Install it with Homebrew: brew install ffmpeg`);
}

/** Run ffmpeg to completion; reject with its last lines of output. */
export function ffmpeg(args, { quiet = true } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffmpegPath(), ['-hide_banner', '-y', ...(quiet ? ['-loglevel', 'error'] : []), ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err = (err + d).slice(-6000); });
    child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`ffmpeg exited ${code}: ${err.trim().split('\n').slice(-12).join('\n')}`))));
  });
}

export function probeDuration(file) {
  const out = execFileSync(ffmpegPath('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return Number(out.trim());
}
