# Contributing to Wanigan

The working rules for this repository live in [AGENTS.md](AGENTS.md) — they
apply to people as much as to agents, and this file does not restate them. Read
*Working in this repository* there first. (`CLAUDE.md` is a one-line import of
that file, because Claude Code is the one harness that does not read
`AGENTS.md` natively.) What follows is the mechanical part.

How we treat each other is in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
Vulnerabilities have their own address and timeline in
[SECURITY.md](SECURITY.md) — please do not open a public issue for one.

## Node

Node `22.23.2`, pinned in [`.nvmrc`](.nvmrc):

```bash
nvm use
npm install      # postinstall rebuilds node-pty and better-sqlite3 for Electron's ABI
```

Older Node is not a soft requirement. Node 16 fails `npm run build` with
`crypto$2.getRandomValues is not a function`, which reads like a Vite bug and is
not. `scripts/launch.sh`, `scripts/cli.sh` and `scripts/smoke.sh` prepend the
`.nvmrc` version to `PATH`; a bare `npm run build` does not.

## What `npm test` runs

Eight steps, in order, and all eight must pass before a change is handed off:

| Step | What it is |
|---|---|
| `npm run typecheck` | `tsconfig.node.json` (main + preload) then `tsconfig.web.json` (renderer) |
| `npm run test:shared` | plain `node --test` over `src/shared/*.test.ts`: no Electron, no display, no database. Answers in well under a second |
| `npm run test:renderer-style` | the renderer ratchets: inline style objects, `<style>` in TSX, literal font sizes and durations, modifiers a base rule shadows, form controls with no accessible name, native `title` tooltips |
| `npm run test:dead-code` | knip over the entry points in `knip.json`: an unused file, an unused dependency, or one that is imported but never declared. The last is the reason it exists — `@electron/asar` was required by two suites on this list while nothing declared it, so it resolved only as a transitive dependency of electron-builder |
| `npm run test:lint` | ESLint, and deliberately not a style tool. The type-aware half is the point: `no-floating-promises` needs the checker, and a `void somePromise()` that loses its `void` and its `.catch` swallows the rejection |
| `npm run test:package-hooks` | fixture checks over the electron-builder hooks: node-pty rebuild cache, Electron fuses, asar integrity, sealed-signature parsing |
| `npm run test:local-install` | fixture checks over the local macOS installer: argument parsing, verification order, quit/stage/promote sequence |
| `npm run smoke` | the suite inside a real Electron main process against the mock runner |

The two packaging suites build no bundle, sign nothing and never read or write
`/Applications`. The smoke suite makes no network call, needs no API key and
spends nothing: `scripts/smoke.sh` sets `WANIGAN_MOCK=1` and hands Electron a
throwaway `--user-data-dir`.

`eslint-suppressions.json` is the lint baseline, and obeys the same rule as
every ratchet here: it records what the tree carried the day the gate landed so
the gate could pass that day, and the only edit is downward. ESLint enforces
that in both directions by itself — a new violation fails, and a suppression
whose violation has since been fixed fails too until somebody runs `npm run
lint:prune`. `npm run lint:debt` ranks what is left.

CI runs the same eight steps, split by what each needs from the runner:
typecheck, the shared tests, the style gate, the dead-code and lint gates and
smoke on Ubuntu under Xvfb, the two packaging suites on macOS.

Three more workflows guard what `npm test` cannot read. **Hygiene** runs
actionlint over the workflow files, shellcheck over `scripts/*.sh`, and gitleaks
over every commit ever made — the last with `.gitleaks.toml`, which allowlists
the redaction suite's fixtures by value rather than by path, so a real
credential pasted into a smoke file still fails. **CodeQL** asks whether
untrusted input reaches somewhere it should not, and reports to the Security tab
rather than failing a build. **Scorecard** reports this repository's own
supply-chain posture.

## Where a test belongs

`src/shared` is pure by construction — no Electron, no `node:fs`, no closures —
so anything it decides can be tested beside it in `src/shared/<module>.test.ts`
and answered in a tenth of a second. Put a contract there whenever it needs no
process: what a surface may claim, how rows rank, what is selected by default.

The smoke suite is for what only a real main process can answer — SQLite, IPC,
the provider registry, native modules, this machine's actual paths. It costs
about thirty seconds, which is the right price for those and the wrong one for
a function that takes a record and returns three strings.
See [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Adding a smoke check

The suite is roughly 3,700 lines across `src/main/smoke.ts` … `smoke5.ts`, and
it is one process. `smoke.ts` owns the counters, the `say()` logger, the
`check()` assertion and the final `app.exit()`; `smoke2.ts` … `smoke5.ts` each
export one `run…Smoke(check, say)` that `smoke.ts` awaits at the end of
`runSmoke()`.

To add a check:

1. Find the file whose subject already matches — the batch lifecycle in
   `smoke.ts`; the numbered app phases (telemetry, hooks, policy, dispatcher,
   worktrees, transcripts, schedules, the phone fleet boundary…) in `smoke2.ts`
   and `smoke3.ts`; the learning engine in `smoke4.ts`; Improvement Scout in
   `smoke5.ts`.
2. Find or add a section header: `say('── <what this group proves>')`, matching
   the `phase N · subject` naming where the surrounding checks use it.
3. Append `check(condition, 'lower-case claim', detail)` under it. The third
   argument is optional and is printed only on failure — pass the actual value,
   because a red line with no observed value is a bug report you have to
   reproduce before you can read it.
4. Run `npm run smoke`. A failure prints `✗` plus that detail; the suite exits
   non-zero.

A genuinely new subject gets a new file: export
`export async function runXSmoke(check: Check, say: Say): Promise<void>`, reuse
the `Check`/`Say` type aliases the existing phase files declare, and `await` it
from the import block at the end of `runSmoke()` in `smoke.ts`. Nothing
auto-discovers a suite file — an unimported one silently never runs.

Keep a check offline and deterministic. Inject a fetcher or a fixture the way
`smoke5.ts` does rather than reaching a real host, and remember the suite kills
itself after 180 seconds instead of stranding a headless Electron process.

## The trust boundary

Wanigan is an Electron app that spawns coding agents, so this is not a style
preference:

- Privileged work — filesystem, spawning, git, keychain, network, SQLite —
  belongs in `src/main/`.
- The renderer reaches it only through the typed preload APIs in
  `src/preload/`. Never widen that surface with a generic passthrough.
- Everything arriving from the renderer is untrusted until the main process has
  validated it. Validate in main, not in the renderer that sent it.
- The renderer cannot widen the set of directories Wanigan will act on.
  `managedRoots()` in `src/main/roots.ts` is the validated allow-list every
  other guard reads, and it is seeded by the projects table; registering a
  root therefore takes a person choosing the directory in the main-process
  folder picker (`projects:pick`). The renderer may ask; main decides.

The same posture applies to data read from disk: a provider pack manifest, a
plugin listing or an adapter response is untrusted input, validated in main
before anything acts on it. See [docs/provider-packs.md](docs/provider-packs.md).

## Before you open a pull request

- `npm test` green.
- `git diff --check` for documentation and UI changes.
- Migrations additive only: `CREATE TABLE IF NOT EXISTS` and `addColumn`, never
  a destructive change. The SQLite database is the source of truth and existing
  user data has to keep working.
- Observed numbers render plain; an estimate carries `~` and the word *est.*
  Do not present a guess as measurement anywhere in the UI or in these docs.
- A UI change ships with before-and-after screenshots. `npm run build && node
  scripts/shots.mjs` writes every view from the real app into `docs/shots/`
  (seeded through the IPC surface, throwaway user-data directory; it launches
  with `--wanigan-automation`, the only mode in which the raw `projects:add`
  channel answers at all, and an installed build refuses that flag); attach
  the pair for each view you touched. Motion changes include a short
  recording.
  If that script times out waiting for a window — it happens on some machines,
  and it is the Electron harness rather than the app — fall back to `node
  scripts/shots-browser.mjs`, which renders the same build in Chromium behind a
  stubbed preload bridge. Say which one produced the shots: the browser run
  proves layout and both themes and nothing at all about IPC, and is never a
  reason to skip `npm test`.
- A change to a keyboard chord ships with `npm run build && npm run probe:chords`.
  It presses every chord in `src/renderer/src/bindings.ts` in the running
  renderer and reports the ones that did not do what the cheat sheet says. That
  file states the rule — "a chord the sheet prints is a chord that works" — and
  before this script existed the session tabs printed ⌘1 / ⌘2 / ⌘3 for a
  handler the shell had already taken in the capture phase. Reading the two
  files did not show it. A new binding with no probe fails the run, so the sheet
  cannot grow a claim nobody pressed.
- A change to how a pane attaches, primes, or forwards terminal input ships with
  `npm run probe:terminal`. A terminal answers questions, and a captured
  scrollback is the agent's own output — so the questions an agent TUI asks are
  *in* the buffer. Replaying it re-runs them, xterm replies on its data channel,
  and that channel goes to the live PTY: the running agent receives keystrokes
  nobody pressed. Reading `TerminalPane.tsx` does not show it, because the reply
  is generated inside xterm's parser and `write()` returns before the parser has
  run — so the flag that should have gated it was already clear. The probe fails
  if either half regresses.
