// The environment a session starts with. A macOS app opened from the Dock
// inherits launchd's PATH, not the shell's, so a CLI installed by nvm, Homebrew
// or the Claude installer is invisible until the login shell is asked.
import { execFile } from 'node:child_process';
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { CLI_NAME, notInstalledMessage, type Cli } from '../shared/clis.ts';
import { CoreError } from '../shared/protocol.ts';

const MARK_START = '__WANIGAN_PATH_START__';
const MARK_END = '__WANIGAN_PATH_END__';

/**
 * Variables that must never reach a session: they belong to the process that
 * started Wanigan. That includes what Claude Code sets on every process it
 * starts (2.1.292), for a Wanigan run from a terminal inside Claude Code: passed
 * on, CLAUDE_CODE_CHILD_SESSION turns transcript saving off in each Claude
 * session, and the rest name a parent session and effort that are not its own.
 */
const SCRUB = [
  /^ELECTRON_/, /^VSCODE_/, /^WANIGAN_/, /^npm_/, /^NODE_OPTIONS$/,
  /^CLAUDECODE$/, /^CLAUDE_CODE_ENTRYPOINT$/, /^CLAUDE_CODE_CHILD_SESSION$/, /^CLAUDE_CODE_SESSION_ID$/,
  /^CLAUDE_CODE_SESSION_ATTENDED$/, /^CLAUDE_PID$/, /^CLAUDE_EFFORT$/, /^AI_AGENT$/,
];

let cachedPath: Promise<string> | null = null;

/**
 * The login shell's PATH, asked once. Falls back to the inherited PATH. Known
 * install folders are added on every call, not once: one an installer makes
 * after Wanigan started (~/.local/bin, Claude's native installer) still counts.
 */
export function loginPath(): Promise<string> {
  cachedPath ??= probeLoginPath();
  return cachedPath.then((path) => withKnownDirs(path));
}

/** A CLI is missing: the refusal says how to install it. */
export function notInstalled(cli: Cli): CoreError {
  return new CoreError('refused', notInstalledMessage(cli));
}

/**
 * Where a CLI is on the login shell's PATH, with that PATH, or a refusal that
 * names its install command. `given` is a test seam: that executable instead.
 */
export async function requireCli(cli: Cli, given?: string | null): Promise<{ bin: string; path: string }> {
  const path = await loginPath();
  const bin = given ?? which(cli, path);
  if (!bin) throw notInstalled(cli);
  return { bin, path };
}

/** A folder that is there. A command run in a missing one fails as if the command were missing. */
export function isDir(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** A folder a run would start in is gone: say that, not that the CLI is missing. */
export function folderMissing(folder: string, cli: Cli | 'shell'): CoreError {
  return new CoreError('refused', `The folder ${folder} is missing, so ${cli === 'shell' ? 'a shell' : CLI_NAME[cli]} cannot run there.`);
}

function probeLoginPath(): Promise<string> {
  const shell = process.env.SHELL || '/bin/zsh';
  // Interactive login, because nvm and friends hook PATH in rc files. Banner
  // text from those files is why the value is fenced by markers.
  return new Promise((resolve) => {
    execFile(shell, ['-lic', `printf '${MARK_START}%s${MARK_END}' "$PATH"`], { timeout: 8000, env: cleanEnv(process.env) },
      (error, stdout) => {
        const match = String(stdout ?? '').match(new RegExp(`${MARK_START}(.*)${MARK_END}`, 's'));
        resolve(!error && match?.[1] ? match[1] : (process.env.PATH ?? ''));
      });
  });
}

function withKnownDirs(path: string): string {
  const home = homedir();
  const dirs = path.split(delimiter).filter(Boolean);
  const extra = [
    join(home, '.local', 'bin'), join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin',
    join(home, '.bun', 'bin'), join(home, '.volta', 'bin'), ...nvmBins(home),
  ];
  for (const dir of extra) if (!dirs.includes(dir) && isDir(dir)) dirs.push(dir);
  return dirs.join(delimiter);
}

function nvmBins(home: string): string[] {
  const root = join(home, '.nvm', 'versions', 'node');
  try {
    return readdirSync(root).sort().reverse().map((v) => join(root, v, 'bin'));
  } catch {
    return [];
  }
}

/** The first executable called `name` on `path`, or null. */
export function which(name: string, path: string): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

export function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || SCRUB.some((re) => re.test(key))) continue;
    out[key] = value;
  }
  return out;
}

const cachedVars = new Map<string, Promise<string | null>>();

/**
 * One variable from the login shell, asked once: an app opened from the Dock
 * does not see what ~/.zshrc exports. Used for a key the owner keeps there.
 */
export function loginVariable(name: string): Promise<string | null> {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) return Promise.resolve(null);
  const inherited = process.env[name]?.trim();
  if (inherited) return Promise.resolve(inherited);
  let found = cachedVars.get(name);
  if (!found) {
    const shell = process.env.SHELL || '/bin/zsh';
    found = new Promise((resolve) => {
      execFile(shell, ['-lic', `printf '${MARK_START}%s${MARK_END}' "$${name}"`], { timeout: 8000, env: cleanEnv(process.env) },
        (error, stdout) => {
          const match = String(stdout ?? '').match(new RegExp(`${MARK_START}(.*)${MARK_END}`, 's'));
          resolve(!error && match?.[1]?.trim() ? match[1].trim() : null);
        });
    });
    cachedVars.set(name, found);
  }
  return found;
}
