# Architecture

How the window, Electron's main process, the core and the agents' command fit together, and where each agent's state comes from. Back to the [README](../../README.md).

```
renderer (React) ── typed IPC ──▶ Electron main ── socket ──▶ core (SQLite, PTYs, rules)
                                                                ▲
                                          wanigan CLI ── socket ┘  (session token = identity)
```

- **`src/core`** owns the database and every terminal. It is Electron's binary
  in Node mode, started detached, so quitting the app never ends a session.
  Board rules are enforced here.
- **`src/main`** starts or finds the core and forwards an allowlist of methods.
- **`src/renderer`** is the interface. It reaches the core only through
  `window.wanigan`.
- **`src/cli`** is the agents' `wanigan` command.
- **`src/shared`** is the typed protocol (`protocol.ts`, one map of every method
  and who may call it) and the pure rules: board transitions, how hook events
  become session state, Codex's lifecycle, notifications.

Claude Code state comes from hooks injected with `--settings` and relayed by a
three-line `sh` script over `nc`. Codex gets the same hooks from `-c` flags,
trusted by hash for that launch only after Codex's own app server lists them as
trusted (`scripts/codex-hooks-probe.ts` re-checks a new Codex version, spending
nothing); otherwise, and as a fallback, its state comes from the OSC 9
notifications it writes when asked to. A Codex turn that fails (its usage limit
included) or is interrupted fires neither a hook nor a notification; the
thread's rollout records it, and the core reads it there for the turn the
hook named. A shell reports only running, ended, or
failed with its exit code. Any session ended by a signal Wanigan did not send is
failed too.

AI review, Draft with Claude, commit-message drafting and Talk to Wanigan
require Claude Code with
`--safe-mode` and `--setting-sources` support; these flags were checked in
2.1.293's help. Advisory runs request that custom hooks, skills, plugins and
settings be disabled. Custom provider-routing settings may therefore be
unavailable. An unsupported CLI reports an error. This review verified the
launch contract with stand-ins; it did not repeat a real model run with these
flags.
