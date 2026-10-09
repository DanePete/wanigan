# Contributing to Wanigan 2

Thanks for looking. Wanigan 2 is in beta, so the most useful things right now
are bug reports with steps, and small, well-tested fixes. For anything larger,
open an issue first so we can agree on the shape before you build it.

## Set up

Follow [Try it](README.md#try-it) in the README. Then:

```sh
npm test            # typecheck, unit and integration tests, UI sweep and control crawl
npm run smoke:app   # the real Electron app: core, window, a terminal, the CLI, outliving a quit
```

`npm test` must pass before a pull request. If you touched the app's startup,
the core process or packaging, run the smoke test too.

`npm run dev` rebuilds the main process, the core and the CLI as you edit. The
core outlives the app, so a new build finds the old core still running: the app
replaces it only when the core atomically confirms no sessions, pending
requests or background answers remain. Otherwise it asks before restarting;
older cores that cannot confirm this also require a decision.
`npm run core:stop` stops the core for the default data folder, or for
`WANIGAN_DATA_DIR`, ending its sessions.

## The rules that matter here

**Tests never touch your real machine.** `testCore()` in
`src/core/test-support.ts` gives each test a real core in a temporary folder,
with a fake home, stand-in `claude`, `codex` and shell agents, and the real hook
relay. The UI sweep and the demo use their own data the same way. A test that
reads your real home folder, your accounts or Wanigan's data folder is a bug.

**Nothing spends tokens without a click.** Tests use the stand-ins. Never call a
real model from a test or a script.

**Prove the outcome.** Assert on what changed: the row in the database, the file
on disk, the git state, the CLI's output. A test that only shows a function ran
proves little. [docs/features.md](docs/features.md) maps each feature to the
test that proves it; keep it current when you add or change one.

**Rules live in the core.** Board transitions, claims, who may approve: these
are enforced in `src/core`, never only in the interface. A new core method goes
in `Methods` in `src/shared/protocol.ts`, with its roles in `ACCESS`: `owner`
for the window, `session` for the agents' `wanigan` command. The window can
call only owner methods, and only through `window.wanigan`.

**The database only grows.** Add a migration as a new entry at the end of
`MIGRATIONS` in `src/core/db.ts`. Never edit or reorder one that has shipped:
people's data has already run it.

**Routine launch writes no harness configuration into a user's project.**
Hooks, settings, instructions and memory are handed to a session when it
starts, never left in its folder. Explicit owner actions such as copying a
skill, adding project MCP configuration, setup commands and git operations
retain their stated filesystem effects.

**The interface uses its own parts.** Build from
`src/renderer/src/components/ui.tsx`. Colours, spacing and type come from
`src/renderer/src/styles/tokens.css`, not literals. Amber means "needs you" and
nothing else. Every control has an accessible name. For a visible change, look
at the sweep's screenshots in `.artifacts/ui/` and put before and after, in both
themes, in the pull request.

**Say only what is true.** If a Claude Code or Codex feature has not been seen
working end to end, the README says so. Don't claim support from docs alone.

## Before you push

```sh
gitleaks git . --log-opts=--all
```

It must come back clean. A fake key in a test belongs in `.gitleaksignore`, by
its fingerprint.

Write commit messages that say what is now true ("Storage identity survives a
reboot"), and put the why in the body.

## License

By contributing, you agree that your contribution is licensed under the MIT
License in [LICENSE](LICENSE).
