# Helper sweep · P8 · the Mac around the app, local automation and attribution

Before and after, both themes, from `scripts/probe-helper-p8-mac.mjs`: the
actual renderer in an isolated Electron window, with synthetic services and no
real agent calls. The main-process half — the Unix socket round trip with file
modes, tokens and lsof-named peers, real shell PTYs, real MCP grants, real git
worktrees, checkpoints, blame and notes, real hook commands, real transcripts —
is checked by `src/main/smoke37.ts`.

`before/` was shot from a build of `feat/helper-sweep` at `e133cf1` (the base
of this branch) in a scratch worktree; `after/` from this branch. Each folder's
`verification.json` lists the assertions that ran, the commit the renderer was
built from, and each screenshot with the body background it was taken on.

The Dock badge and the menu-bar item are native macOS surfaces outside the
renderer, so this probe cannot photograph them. smoke37 builds the real
Electron menu from the model, clicks each item into its handler, checks that no
prompt text reaches a label, and creates the glyph as an 18-point template
image.

| View | Before | After |
| --- | --- | --- |
| Mission room | `mission-week` — ends with the project spaces | `mission-week` — This week: sessions and conversations, merged and discarded read from git with the rule stated, goals accepted, gates failed, open worktrees, half-finished conversations, observed cost, Last week, Export Markdown… |
| Sessions toolbar | `sessions-toolbar` — no way to run a script | `scripts-launcher` — package.json, Makefile and justfile entries, favourite first, the command each runs, a worktree choice, no Run for a name that is not shell-safe |
| Your terminal | — | `your-terminal` — the operator's own shell in a dock apart from session tabs, labelled operator-run and outside the policy gate |
| Recent | `recent` | `recent` — "3 messages may be skipped when this conversation resumes (broken message chain in the transcript)" on the broken conversation only; `resume-chain` — the same sentence in the confirmation, saying the transcript was read and not changed |
| Code rail, Files | `code-files` — a plain file view | `code-attribution` — lines added in turns against lines still present, Export as git notes…, Show who wrote this with turn marks in the gutter and each range's session and turn in the legend |
| Context, hooks | `context-hooks` — commands listed | `context-hook-bench` — Test with sample input per command hook (HTTP hooks say they are not run) and the result: would block, exit 2, stderr, the rule, the sample input and environment names |
| Settings › App | `settings-app` | `settings-app` — Count on the Dock icon and Sessions in the menu bar, both off by default |
| Settings › Connections | `settings-connections` — one MCP server switch | `settings-mcp-tools` — all, none or selected Wanigan tools per provider profile; `settings-automation` — the socket path, the token kept out of the window, Allow scripts to send, and the ledger with peer executables and pids |
| Settings › Projects & safety | `settings-projects` | `settings-naming` — title and branch formats previewed live with a valid-ref mark; `settings-naming-invalid` — a format git would refuse, with Save disabled |

Run it again with `npm run build && node scripts/probe-helper-p8-mac.mjs`
(add `--before --out <dir>` from a checkout of the base).
