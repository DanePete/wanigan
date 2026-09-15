# helper sweep · P5 runtime — visuals

Produced by `scripts/probe-helper-p5-runtime.mjs` on the browser harness
(`scripts/renderer-harness.mjs`): the built renderer in plain Chromium with the
preload bridge stubbed, at 1440×1000, in both themes.

- `before/` — the base commit (`feat/helper-sweep`), built in a throwaway
  worktree and photographed with `--mode before`. The same fixtures are
  injected; the base build never calls them.
- `after/` — this branch, `--mode after`. `probe-results.json` records every
  assertion (67 in the last run, all passing, no page errors): each new element
  rendered, sits inside its card or the viewport, and carries the exact wording.

What each pair shows:

| file | surface |
| --- | --- |
| `*-fleet-inspector` | Fleet inspector: the tree's CPU, memory and listening port; "Requested opus, answered by claude-sonnet-5" with the cost attributed to Sonnet |
| `*-fleet-still-running`, `*-fleet-stop-confirm` (after only) | Still running after the session ended, and Stop's confirmation |
| `*-sessions-runtime` | A session's Processes and ports and Launch values drawers |
| `*-continue-in-codex` (after only) | The consent dialog: transcript file, CODEX_HOME, what is not imported |
| `*-new-session-summary`, `*-new-session-review-only` | Launch summary with Where these values come from; Review only (no command tools) |
| `*-usage` | The Codex reader note: unreadable compressed rollouts and unparsed lines |
| `*-runs`, `*-runs-composer` | Finer outcomes per row, Refused before starting, and the composer's /login warning |
| `*-settings-diagnostics`, `*-settings-config-files` (before: `*-settings-backup`) | Export diagnostics file list; Config files Wanigan rewrites |
| `*-settings-codex-doctor` (before: `*-settings-agents`) | codex doctor for a Codex account |
| `*-git-bar`, `*-git-review-pr-form`, `*-git-review-pr-dialog` | Review PR… and the launch dialog it opens on the review worktree |
| `*-timeline-substitution` | The substitution line under the Timeline's live strip |

This proves layout and wording only. ps/lsof sampling, the Codex app-server
import, git fetches and SQLite are exercised for real in `src/main/smoke34.ts`.
Stub artifacts to ignore: the trust card's "0" level and the "3D unavailable"
orb are the harness, not the product.

Not photographed: the per-goal "Review task: no command tools" toggle in
Review (Control), which needs a full docket fixture; its storage and call site
are covered by smoke34.
