/**
 * The host half of `src/shared/platform.ts`: the part that touches the disk.
 *
 * `src/shared/platform.ts` decides *which* paths are worth probing, and is pure
 * so both platforms' rules are covered by `test:shared` from any machine. This
 * file does the probing, and it is the only place that reads
 * `process.platform`. Four modules used to answer "can this run?" with four
 * slightly different copies of the same three lines — `providers.ts`, `gh.ts`,
 * `headless.ts` and `code.ts` — and only `code.ts` had the `isFile()` guard.
 *
 * That guard is not a nicety. `access(X_OK)` on a *directory* is asking for
 * search permission, and it succeeds. So a `PATH` entry that happens to contain
 * a directory named `gh` resolved as the gh CLI, and the failure surfaced much
 * later as EACCES from execFile on a path the operator could see was a folder.
 */

import fs from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import {
  asPlatform,
  executableCandidates,
  extraSearchDirs,
  loginShellProbe,
  pathFor,
  splitPath,
  type Platform,
} from '../shared/platform';

const exec = promisify(execFile);

/** The one read of `process.platform` in the codebase's resolution path. */
export function hostPlatform(): Platform {
  return asPlatform(process.platform);
}

export function isWindows(): boolean {
  return hostPlatform() === 'win32';
}

/**
 * Can this exact path be started as a program?
 *
 * On Windows the extension already decided candidacy — `executableCandidates`
 * only proposes names `PATHEXT` sanctions — and there is no executable bit to
 * consult: `fs.accessSync(file, X_OK)` answers from the read-only attribute and
 * says yes to a .txt. So the honest test there is "is it a regular file".
 */
export function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (isWindows()) return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First candidate that can actually be started, or null. */
export function firstExecutable(candidates: readonly string[]): string | null {
  for (const candidate of candidates) if (isExecutableFile(candidate)) return candidate;
  return null;
}

/**
 * Resolve `bin` against a PATH value the way the host's shell would.
 *
 * `fallbacks` are absolute paths a provider declares for installs that are not
 * on PATH at all — the CLIs that ship inside an editor extension. They are
 * probed after PATH, never before, so a real install always wins.
 */
export function findOnPath(
  bin: string,
  PATH: string,
  fallbacks: readonly string[] = [],
): string | null {
  const platform = hostPlatform();
  const candidates = executableCandidates(bin, {
    platform,
    path: PATH,
    pathext: process.env.PATHEXT,
  });
  return firstExecutable(candidates) ?? firstExecutable(fallbacks);
}

/** Directories a PATH value names, split on the host's delimiter. */
export function pathDirs(PATH: string): string[] {
  return splitPath(PATH, hostPlatform());
}

/** Join directories into a PATH value for a child process. */
export function toPathValue(dirs: readonly string[]): string {
  return dirs.filter(Boolean).join(hostPlatform() === 'win32' ? ';' : ':');
}

/**
 * What a login shell thinks `PATH` is, or the inherited value.
 *
 * A macOS GUI app inherits launchd's PATH, not the shell's, so a CLI installed
 * by nvm or homebrew is invisible until the shell is asked. Windows has no
 * equivalent question: PATH there is the machine and user environment
 * variables this process already inherited in full, and there is no per-shell
 * rc file adding to it. `loginShellProbe` returns null for it, and this returns
 * the inherited PATH rather than spawning a PowerShell to be told what it
 * already has.
 */
export async function loginShellPath(): Promise<string> {
  const probe = loginShellProbe(hostPlatform(), process.env.SHELL);
  if (!probe) return process.env.PATH ?? '';
  try {
    const { stdout } = await exec(probe.file, probe.args, { timeout: 8000 });
    return stdout.trim() || process.env.PATH || '';
  } catch {
    return process.env.PATH ?? '';
  }
}

/**
 * Directories worth searching beyond PATH, for this host, that exist.
 *
 * Existence-filtered because the caller shows these to a person who has been
 * told a CLI is missing, and naming somewhere they do not have would pad that
 * list with places nothing could ever be.
 */
export function hostSearchDirs(): string[] {
  const platform = hostPlatform();
  const dirs = [...extraSearchDirs(platform, process.env, os.homedir()), ...nodeVersionManagerDirs(platform)];
  return dirs.filter((dir) => {
    try { return fs.statSync(dir).isDirectory(); } catch { return false; }
  });
}

/**
 * nvm, fnm and volta keep the active Node — and therefore every globally
 * installed CLI — under a versioned directory that is on the shell's PATH and
 * nowhere else. Newest first, because that is the one the operator is using.
 *
 * On Windows nvm-windows symlinks the active version to a fixed path instead of
 * versioning the directory, so `%NVM_SYMLINK%` is the whole answer there.
 */
function nodeVersionManagerDirs(platform: Platform): string[] {
  const p = pathFor(platform);
  const home = os.homedir();
  if (platform === 'win32') {
    const linked = process.env.NVM_SYMLINK;
    const out = linked ? [linked] : [];
    if (process.env.VOLTA_HOME) out.push(p.join(process.env.VOLTA_HOME, 'bin'));
    return out;
  }
  const out: string[] = [];
  for (const base of [p.join(home, '.nvm', 'versions', 'node'), p.join(home, '.local', 'share', 'fnm', 'node-versions')]) {
    try {
      out.push(
        ...fs.readdirSync(base)
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
          .map((v) => p.join(base, v, 'bin')),
      );
    } catch { /* this manager is not installed */ }
  }
  if (process.env.VOLTA_HOME) out.push(p.join(process.env.VOLTA_HOME, 'bin'));
  return out;
}
