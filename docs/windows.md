# Wanigan on Windows

Wanigan was written on a Mac and its CI has run on Linux, which between them hid
every Windows-shaped assumption for a long time. This page is what is true now,
including the parts that are not finished — an app that quietly does less on one
platform is worse than one that says where the edges are.

## What you need

| | |
|---|---|
| Windows | 10 or 11, x64. Windows-on-ARM is not built; see [Packaging](#packaging) |
| Node | `22.23.2`, the version in [`.nvmrc`](../.nvmrc). [nvm-windows](https://github.com/coreybutler/nvm-windows) or [fnm](https://github.com/Schniz/fnm) both work |
| Build tools | Visual Studio Build Tools with the **Desktop development with C++** workload, and Python 3 |
| An agent CLI | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex](https://github.com/openai/codex), installed natively and already signed in |

The build tools are not optional and not a nicety. `node-pty` and
`better-sqlite3` are native addons compiled from source against Electron's ABI
during `npm ci`; without a C++ toolchain that step fails and nothing else runs.
The error names node-gyp, which reads like an npm problem and is not.

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install Python.Python.3.12
```

## Getting it running

```powershell
git clone https://github.com/DanePete/wanigan.git
cd wanigan
nvm use 22.23.2      # or: fnm use
npm ci               # compiles node-pty and better-sqlite3 — the slow step
npm run app          # build and launch
```

`npm run app` goes through [`scripts/launch.mjs`](../scripts/launch.mjs), which
builds first and refuses to start against a build older than `src/`. `npm run
dev` is `electron-vite dev` and skips that.

To build an installer:

```powershell
npm run dist:win     # NSIS installer + zip, into release/
```

## Where Wanigan looks for your agent CLI

`npm i -g @anthropic-ai/claude-code` on Windows writes three files into your npm
prefix: `claude.cmd`, `claude.ps1`, and an extensionless shell script that only
WSL and Git Bash can run. Wanigan resolves the name the way your shell does —
through `PATHEXT`, preferring `claude.exe` over `claude.cmd` — and never
searches the current directory, because `cmd.exe` does and a repository
containing a file named `claude.cmd` must not be able to decide what a session
launches.

A `.cmd` is a batch file rather than a program, so it cannot be started
directly; Wanigan runs it through `cmd.exe` with AutoRun and delayed expansion
switched off. One consequence is visible: **a session goal containing a double
quote, a `%VARIABLE%` or a line break is refused** rather than passed through,
because `cmd.exe` would act on it before the CLI ever saw it. Wanigan says so by
name when it happens. Installing a CLI that ships a real `.exe` avoids the
restriction entirely.

If the CLI is installed but not found, it is almost always because npm's global
prefix (`%APPDATA%\npm`) was added to your *user* `PATH` by the installer and
the already-running desktop session has not re-read it. Wanigan searches there
anyway; signing out and back in fixes it everywhere else.

## What is not there yet

These are honest gaps, not bugs to report. Each one says what you get instead.

| Feature | On Windows |
|---|---|
| **Durable scheduling** | Not available. The background scheduler is a macOS LaunchAgent. Schedules still run while Wanigan is open. |
| **Status line relay** | Not available. The relay is a POSIX shell script; Wanigan says so on screen rather than failing per launch. |
| **Codex hook forwarding** | Not available. The forwarding command needs `/bin/sh` and `/usr/bin/curl`. |
| **Codex writer locks** | Fails closed. Verifying that a lock file is held needs `lsof`, so Wanigan refuses to open a second writer rather than risk two. Delete the stale `.lock` under your Codex home if you are sure. |
| **Copy-on-write worktree deps** | Falls back to a link. `cp -c` cloning is APFS-only; Windows gets an NTFS junction, which needs no elevation and shares rather than copies. |
| **Built-in skills list** | Empty, and labelled as Wanigan's gap. Nobody has read the path this platform's Claude Code extracts bundled skills to. |
| **Code signing** | Unsigned. SmartScreen will warn on first run until the binary earns reputation or an Authenticode certificate is configured. |
| **Electron fuses** | Not yet flipped on the `win` target. Enabling asar integrity validation with wrong integrity data produces an app that dies before drawing a window, so it waits on a verified Windows build. |

## How much of this has actually run on Windows

Be suspicious of a port's own confidence. As of this page:

- The platform rules — `PATH` splitting, `PATHEXT` resolution, `cmd.exe`
  quoting and its refusals, the process probe, junction selection — are pure
  functions in [`src/shared/platform.ts`](../src/shared/platform.ts) and are
  covered by `npm run test:shared`, which runs the **Windows** cases on any
  machine. That is deliberate: a port whose ported behaviour can only be
  exercised on the ported platform is a port nobody re-verifies.
- `.github/workflows/ci.yml` has a `windows-latest` job running typecheck, the
  shared tests, the style and dead-code gates, lint, and the full smoke suite
  inside a real Electron main process. That job is what proves `node-pty` and
  `better-sqlite3` compile here at all.
- Everything that talks to the operating system rather than to a string —
  `taskkill`, ConPTY, the NSIS installer — is exercised only by that job and by
  people running it. If something here is wrong, this is where it will be.
