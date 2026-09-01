# Contributing to Wanigan

The working rules for this repository live in [CLAUDE.md](CLAUDE.md) — they
apply to people as much as to agents, and this file does not restate them. Read
*Working in this repository* there first. What follows is the mechanical part.

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

Four steps, in order, and all four must pass before a change is handed off:

| Step | What it is |
|---|---|
| `npm run typecheck` | `tsconfig.node.json` (main + preload) then `tsconfig.web.json` (renderer) |
| `npm run test:package-hooks` | fixture checks over the electron-builder hooks: node-pty rebuild cache, Electron fuses, asar integrity, sealed-signature parsing |
| `npm run test:local-install` | fixture checks over the local macOS installer: argument parsing, verification order, quit/stage/promote sequence |
| `npm run smoke` | the suite inside a real Electron main process against the mock runner |

The two packaging suites build no bundle, sign nothing and never read or write
`/Applications`. The smoke suite makes no network call, needs no API key and
spends nothing: `scripts/smoke.sh` sets `WANIGAN_MOCK=1` and hands Electron a
throwaway `--user-data-dir`.

CI runs the same four steps, split by what each needs from the runner:
typecheck and smoke on Ubuntu under Xvfb, the two packaging suites on macOS.
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
