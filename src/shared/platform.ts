/**
 * What "find and start a program" means on each platform, as pure functions.
 *
 * Wanigan resolved provider CLIs the way a POSIX shell does and nowhere else:
 * split `PATH` on `:`, join with `/`, and ask `access(X_OK)` whether the result
 * can run. Every one of those three is wrong on Windows, and each fails in a
 * way that does not look like a porting bug from the outside:
 *
 *   1. `PATH.split(':')` on `C:\Users\dane\bin;C:\Windows\system32` yields
 *      `['C', '\\Users\\dane\\bin;C', '\\Windows\\system32']`. The drive letter
 *      becomes its own directory, so nothing is ever found and the operator is
 *      told the CLI is not installed while it sits on their PATH.
 *   2. `PATHEXT` does not exist in the POSIX model at all. Claude Code installs
 *      on Windows as `claude.cmd` (plus `claude.ps1`, and a extensionless shell
 *      script only WSL and Git Bash can run). Probing for a file literally
 *      named `claude` finds that last one, which CreateProcess cannot start.
 *   3. `access(X_OK)` on Windows answers from the read-only attribute and not
 *      from anything to do with executability — `fs.accessSync(dir, X_OK)`
 *      succeeds on an ordinary *directory*. A probe built on it does not filter
 *      candidates; it accepts the first one that exists.
 *
 * So the platform is a parameter here rather than a read of `process.platform`.
 * That is not ceremony: it is the only way the Windows behaviour is covered by
 * `test:shared`, which runs on whatever machine the contributor has. A port
 * whose tests can only run on the ported platform is a port nobody re-verifies.
 *
 * Nothing in this file touches the filesystem. Deciding *which* candidates to
 * probe is separable from probing them, and only the first half can be pure.
 */

import path from 'node:path';

export type Platform = 'darwin' | 'win32' | 'linux';

/** Anything `process.platform` can be, narrowed to the three Wanigan reasons about. */
export function asPlatform(value: string): Platform {
  return value === 'win32' ? 'win32' : value === 'darwin' ? 'darwin' : 'linux';
}

/** The `path` helpers for a platform, so a macOS test can build Windows paths. */
export function pathFor(platform: Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** `;` on Windows, `:` everywhere else. `path.delimiter` reads the host, which is the bug. */
export function pathDelimiter(platform: Platform): ';' | ':' {
  return platform === 'win32' ? ';' : ':';
}

/** Directories in a `PATH` value, empty entries dropped. */
export function splitPath(value: string | undefined, platform: Platform): string[] {
  return (value ?? '').split(pathDelimiter(platform)).filter(Boolean);
}

/** The inverse, for handing a PATH to a child process. */
export function joinPath(dirs: readonly string[], platform: Platform): string {
  return dirs.filter(Boolean).join(pathDelimiter(platform));
}

/**
 * Windows' default when `PATHEXT` is unset or empty.
 *
 * Deliberately shorter than the real shell default, which also carries `.VBS`,
 * `.JS`, `.WSF` and friends. Those are script types handed to a *host*
 * (wscript, cscript) rather than started directly, and Wanigan is looking for
 * an agent CLI, not for anything the machine is willing to execute. A narrower
 * list cannot make us start something stranger than what was asked for.
 */
const DEFAULT_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD'];

/**
 * Extensions to try, in probe order, lowercased.
 *
 * Order is the whole point and it is `PATHEXT`'s order, not ours: on a machine
 * where both `claude.exe` and `claude.cmd` exist, the shell would run the
 * `.exe`, and a launcher that picked the `.cmd` instead would route a session
 * through a different program than the one the operator gets when they type
 * `claude` themselves. The empty string is appended last so an explicitly
 * named `claude.cmd` still resolves when `PATHEXT` has been trimmed.
 */
export function executableExtensions(platform: Platform, pathext?: string): string[] {
  if (platform !== 'win32') return [''];
  const declared = (pathext ?? '')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.startsWith('.') && e.length > 1);
  const out = declared.length ? declared : DEFAULT_PATHEXT.map((e) => e.toLowerCase());
  return [...out, ''];
}

/** Does this filename already carry an extension `PATHEXT` would have added? */
export function hasExecutableExtension(file: string, platform: Platform, pathext?: string): boolean {
  if (platform !== 'win32') return false;
  const ext = pathFor(platform).extname(file).toLowerCase();
  if (!ext) return false;
  return executableExtensions(platform, pathext).includes(ext);
}

export type CandidateOptions = {
  platform: Platform;
  /** The raw `PATH` value, unsplit. */
  path?: string;
  /** The raw `PATHEXT` value. Ignored off Windows. */
  pathext?: string;
  /** Extra directories to search after `PATH`, already absolute. */
  extraDirs?: readonly string[];
};

/**
 * Every absolute path worth probing for `bin`, in the order a shell would.
 *
 * An absolute or explicitly-relative `bin` names one file and is returned with
 * only its extension permutations — a manifest that says `bin: './tools/foo'`
 * is naming a path, and searching PATH for it would let a same-named program
 * elsewhere win. A bare name is searched across PATH.
 *
 * The current directory is never added. `cmd.exe` searches it first and a POSIX
 * shell does not, and inheriting that difference would mean a repository
 * containing a file called `claude.cmd` could decide what Wanigan launches when
 * a session starts in it. That is the whole attack, and it costs nothing to
 * refuse: a real install is on PATH.
 */
export function executableCandidates(bin: string, opts: CandidateOptions): string[] {
  const { platform, extraDirs = [] } = opts;
  const p = pathFor(platform);
  const exts = executableExtensions(platform, opts.pathext);
  const bare = hasExecutableExtension(bin, platform, opts.pathext) ? [''] : exts;

  const named = p.isAbsolute(bin) || bin.startsWith('.') || bin.includes('/') || (platform === 'win32' && bin.includes('\\'));
  const dirs = named ? [] : [...splitPath(opts.path, platform), ...extraDirs];

  const out: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string): void => {
    // Windows paths are case-insensitive, so `C:\Bin` and `c:\bin` are one
    // candidate and probing both would double every filesystem call.
    const key = platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(candidate);
  };

  if (named) {
    for (const ext of bare) add(ext ? bin + ext : bin);
    return out;
  }
  // Extension-major: try `foo.exe` in every directory before `foo.cmd`
  // anywhere. This is what a shell does, and it matters when a wrapper `.cmd`
  // early on PATH shadows the real `.exe` further along.
  for (const ext of bare) {
    for (const dir of dirs) add(p.join(dir, ext ? bin + ext : bin));
  }
  return out;
}

/**
 * Can this file be handed to CreateProcess, or does it need an interpreter?
 *
 * `.cmd` and `.bat` are not programs. CreateProcess — which is what both
 * `child_process` and node-pty's ConPTY path ultimately call — refuses them
 * with ENOENT, and the error names the file that plainly exists. They run only
 * as an argument to `cmd.exe`.
 *
 * This is not an edge case for Wanigan: `npm i -g @anthropic-ai/claude-code` on
 * Windows writes `claude.cmd`, so the *default* install of the flagship
 * provider lands here.
 */
export function needsCommandInterpreter(file: string, platform: Platform): boolean {
  if (platform !== 'win32') return false;
  const ext = pathFor(platform).extname(file).toLowerCase();
  return ext === '.cmd' || ext === '.bat';
}

/**
 * Why `cmd.exe` cannot carry this argument, or null.
 *
 * Everything below is a character `cmd.exe` acts on *before* the program sees
 * it, and that no escaping reliably survives. The argument matters because it
 * can be the goal text a person typed, so this is untrusted input reaching a
 * shell — CVE-2024-24576 exactly.
 *
 *   `"`  ends the quoted region this wrapper depends on. After it, `&` and `|`
 *        in the rest of the argument are live command separators. The
 *        CreateProcess convention for an embedded quote is `\"`, but `cmd.exe`
 *        does not know that convention: it sees a bare quote and toggles state.
 *        The two parsers disagree, and the disagreement is the vulnerability.
 *   `%`  paired, as in `%PATH%`, expands. A caret cannot suppress it — `^%`
 *        arrives as a literal `^%` — and doubling only works inside a .bat
 *        file, not on a command line. A lone `%`, as in "50% done", is fine.
 *   CR/LF ends the command line; anything after it is a second command.
 *   NUL  truncates it.
 *
 * With these refused, quoting is just wrapping in `"`: inside a quoted region
 * `cmd.exe` treats `&`, `|`, `<`, `>`, `(`, `)` and `^` literally, and `!` too
 * because `spawnPlan` passes `/v:off`.
 */
export function unquotableForCmd(arg: string): string | null {
  if (arg.includes('"')) return 'a double quote';
  if (/%[^%]*%/.test(arg)) return 'a %VARIABLE% that cmd.exe would expand';
  if (/[\r\n]/.test(arg)) return 'a line break';
  if (arg.includes('\0')) return 'a NUL byte';
  return null;
}

/**
 * Wrap one argument for a `cmd.exe /d /s /v:off /c` command line.
 *
 * Safe *only* for an argument `unquotableForCmd` has already cleared; it does
 * no escaping of its own, because the characters that would need escaping are
 * the ones that cannot be escaped. Trailing backslashes are doubled so the
 * closing quote is not itself escaped away when the target program re-parses
 * the line under CreateProcess rules.
 */
export function quoteForCmd(arg: string): string {
  return `"${arg.replace(/(\\+)$/, '$1$1')}"`;
}

export type SpawnPlan =
  | { kind: 'direct'; file: string; args: string[] }
  | { kind: 'interpreter'; file: string; args: string[]; via: 'cmd.exe' }
  | { kind: 'refused'; reason: string };

/**
 * How to actually start `file` with `args` on this platform.
 *
 * Off Windows, and for a real `.exe`, this is the identity. The interesting
 * case is the `.cmd` shim — the default Claude Code install on Windows — and
 * the interesting answer is that it is sometimes `refused`. Some arguments
 * cannot cross `cmd.exe` intact by any escaping, and the honest outcome is to
 * say so rather than to launch a session whose goal text has had an
 * environment variable spliced into it, or worse, half of it run as a command.
 * `AGENTS.md`: prefer an honest unsupported state to an invented integration.
 */
export function spawnPlan(file: string, args: readonly string[], platform: Platform): SpawnPlan {
  if (!needsCommandInterpreter(file, platform)) {
    return { kind: 'direct', file, args: [...args] };
  }
  for (const arg of [file, ...args]) {
    const why = unquotableForCmd(arg);
    if (why) {
      return {
        kind: 'refused',
        reason:
          `This provider is installed as a Windows .cmd shim, so it starts through cmd.exe, and `
          + `one argument contains ${why}. cmd.exe would act on it before the CLI saw it. Install `
          + `the CLI's .exe build, or take that character out of the session goal.`,
      };
    }
  }
  // `/d` skips the AutoRun commands in the registry, which would otherwise run
  // before the CLI does and inside this session's environment. `/v:off` makes
  // `!` literal whatever the machine's DelayedExpansion default is. `/s` pins
  // quote handling to one documented rule instead of the five-condition
  // heuristic cmd.exe otherwise applies.
  //
  // That rule is why the whole command carries a second pair of quotes: with
  // `/s`, cmd.exe strips the first character if it is a quote and removes the
  // last quote character, then runs what is left. Without the outer pair,
  //     "C:\npm\claude.cmd" "--print" "goal"
  // becomes
  //     C:\npm\claude.cmd" "--print" "goal
  // and the CLI is never started. Node's own `shell: true` wraps it the same
  // way for the same reason.
  const line = [quoteForCmd(file), ...args.map(quoteForCmd)].join(' ');
  return {
    kind: 'interpreter',
    file: 'cmd.exe',
    args: ['/d', '/s', '/v:off', '/c', `"${line}"`],
    via: 'cmd.exe',
  };
}

/**
 * A `SpawnPlan` as one command-line string, for node-pty on Windows.
 *
 * node-pty takes `args` as either an array or a string, and the two are not
 * equivalent. The array path runs `argsToCommandLine`, which escapes every `"`
 * as `\"` — correct for an ordinary program, and fatal here, because it would
 * rewrite the cmd.exe quoting above into something cmd.exe reads as one
 * argument full of backslashes. The string path is appended verbatim, which is
 * what a command line we have already quoted ourselves needs.
 */
export function commandLine(plan: SpawnPlan): string {
  if (plan.kind === 'refused') throw new Error(plan.reason);
  return plan.args.join(' ');
}

/**
 * How to run a user-authored shell command line on this platform.
 *
 * Unlike `spawnPlan`, a shell is what is *wanted* here. These are the commands
 * somebody put in a worktree bootstrap or a review gate — `npm ci && npm test`
 * — so `&&` is theirs and must keep working. The refusal logic in `spawnPlan`
 * would be exactly wrong applied to this.
 *
 * On Windows that is `cmd.exe /d /s /c`, and the command goes through as one
 * argument: Node quotes it, and `/s` strips precisely the first and last quote
 * before running the rest, so the line arrives intact. `/d` still skips the
 * registry's AutoRun, which would otherwise run inside this command's
 * environment.
 *
 * `%ComSpec%` rather than a literal, because that is where Windows says the
 * command interpreter is, and a machine with a relocated one is not a machine
 * to guess about.
 */
export function shellCommand(
  command: string,
  platform: Platform,
  env: Readonly<Record<string, string | undefined>> = {},
): { file: string; args: string[] } {
  if (platform === 'win32') {
    return { file: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  // A login shell, because these commands expect the PATH a person has: nvm,
  // pyenv and rbenv all install their shims from an rc file.
  return { file: env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh'), args: ['-lc', command] };
}

/**
 * How to ask this platform when a set of processes started.
 *
 * A pid is not an identity: a registry file left by a SIGKILL keeps its pid, the
 * kernel hands that number out again, and the stale row then looks live. The
 * answer both platforms have to give is the same — which of these pids exist,
 * and when each began — so that a start time can be compared against what the
 * file claims.
 *
 * On Windows this is PowerShell, passed as `-EncodedCommand`: base64 of the
 * UTF-16LE script. That is not ceremony either. The script contains quotes and
 * `$(...)`, and between Node's CreateProcess quoting and PowerShell's own
 * command-line parsing there are two layers that disagree about escaping — the
 * same class of problem `spawnPlan` refuses arguments over. Encoding sidesteps
 * both: there is nothing left for either layer to interpret.
 *
 * The output is shaped to the parser that already exists. `ps -o pid=,lstart=`
 * emits `<pid> <date>`, and so does this; ISO-8601 round-trips through
 * Date.parse exactly, where `lstart` needs LC_ALL=C to be readable at all.
 * `StartTime` throws for a process this account may not inspect, so that case
 * prints an unparseable stamp on purpose: the caller distinguishes "ps never
 * mentioned this pid" (gone) from "mentioned it, date unreadable" (running,
 * start unknown), and collapsing the second into the first drops a live session.
 */
export function processStartProbe(
  pids: readonly number[],
  platform: Platform,
): { file: string; args: string[] } | null {
  // Every pid is rendered into a command line, so each must be a plain
  // non-negative integer and nothing else.
  const safe = pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  if (!safe.length) return null;

  if (platform !== 'win32') {
    return { file: 'ps', args: ['-o', 'pid=,lstart=', '-p', safe.join(',')] };
  }
  const script = `Get-Process -Id ${safe.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { `
    + `try { "$($_.Id) $($_.StartTime.ToUniversalTime().ToString('o'))" } `
    + `catch { "$($_.Id) unknown" } }`;
  return {
    file: 'powershell.exe',
    args: [
      '-NoProfile',        // a profile script can print anything into stdout
      '-NonInteractive',   // never stop for a prompt inside a 5s probe
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
  };
}

/**
 * The kind of directory link this platform can make without elevated rights.
 *
 * `fs.symlink(..., 'dir')` on Windows needs either an Administrator token or
 * Developer Mode, and fails EPERM on an ordinary account. A *junction* is the
 * NTFS reparse point that needs neither, and for pointing one directory at
 * another — which is all Wanigan does with it, placing a gitignored dependency
 * folder into a fresh worktree — it behaves the same.
 *
 * The one thing a junction cannot do is point at a relative path, so callers
 * must pass an absolute target. That is not a new constraint here: the
 * dependency placement already joins against an absolute repository root.
 */
export function directoryLinkType(platform: Platform): 'dir' | 'junction' {
  return platform === 'win32' ? 'junction' : 'dir';
}

/**
 * The command that asks a login shell what it thinks `PATH` is, or null.
 *
 * A GUI app inherits the session PATH, not the shell's, so a CLI installed by
 * nvm, homebrew, volta or fnm is invisible until the shell is asked. On Windows
 * there is no equivalent question to ask: `PATH` is machine and user
 * environment variables that the process already inherited in full, and there
 * is no per-shell rc file adding to it the way `.zshrc` does. Returning null
 * says "the PATH you have is the PATH there is" rather than spawning a
 * PowerShell to be told what we already know.
 */
export function loginShellProbe(platform: Platform, shell?: string): { file: string; args: string[] } | null {
  if (platform === 'win32') return null;
  return {
    file: shell || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh'),
    args: ['-lic', 'printf %s "$PATH"'],
  };
}

/**
 * Directories to search after `PATH`, for installs a GUI session's PATH misses.
 *
 * The Windows entries are where the two supported installers actually put
 * things: npm's global prefix under `%APPDATA%\npm`, and a per-user install
 * under `%LOCALAPPDATA%\Programs`. Neither is on a fresh GUI process's PATH
 * reliably — `%APPDATA%\npm` is added by the npm installer to the *user* PATH,
 * which an already-running explorer.exe has not re-read.
 */
export function extraSearchDirs(
  platform: Platform,
  env: Readonly<Record<string, string | undefined>>,
  homedir: string,
): string[] {
  const p = pathFor(platform);
  if (platform === 'win32') {
    const appData = env.APPDATA || p.join(homedir, 'AppData', 'Roaming');
    const localAppData = env.LOCALAPPDATA || p.join(homedir, 'AppData', 'Local');
    return [
      p.join(appData, 'npm'),
      p.join(localAppData, 'Programs'),
      p.join(localAppData, 'Microsoft', 'WindowsApps'),
      p.join(homedir, '.local', 'bin'),
      p.join(homedir, '.bun', 'bin'),
    ];
  }
  if (platform === 'darwin') {
    return ['/opt/homebrew/bin', '/usr/local/bin', p.join(homedir, '.local', 'bin')];
  }
  return ['/usr/local/bin', p.join(homedir, '.local', 'bin')];
}
