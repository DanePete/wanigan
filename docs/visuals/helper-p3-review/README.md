# Helper sweep · P3 · reviewing the work

Before and after, both themes, from `scripts/probe-helper-p3-review.mjs`: the
actual renderer in an isolated Electron window, with synthetic sessions, git
and review services and no real agent calls. The main-process half — marks
against real content hashes, attribution through the real hook listener,
staging against real checkpoints, the regression proof in a real scratch
worktree, the PR body from a real worktree branch — is checked against real
repositories by `src/main/smoke32.ts`.

`before/` was shot from a build of `feat/helper-sweep` (the base of this
branch) in a scratch worktree; `after/` from this branch. Each folder's
`verification.json` lists the assertions that ran, the commit the renderer was
built from, and each screenshot with the body background it was taken on.

| View | Before | After |
| --- | --- | --- |
| Code rail | `code-rail` — a file list and a diff | `code-rail` — "Needs review · 1 of 5 files" with its diff stat and the rule in words, the Agent edits / Uncommitted / Branch scopes, tests first, filter and find, and a file header with its mark, kind, attribution and test alarms with line numbers |
| Code rail, image | — | `image` — a changed PNG before and after, side by side, from data URLs |
| Code rail, evidence | — | `evidence` — Dependencies (added and upgraded, with the install command) and Claims in the final message (verified, unsupported, needs review, each with its reason) |
| Code rail, unsent note | — | `unsent-note` — a note left unsent on another file is kept, with Return to it and Discard… |
| Code rail, staging | — | `stage-hunks` — Stage only the session's hunks: the file to stage, the refused file with its reason, and the confirmation |
| Turns | `turns` — files per turn | `turns` — files and +N −M per turn |
| Fleet | `fleet` | `fleet` — "Needs review · 1 of 5 files" and "+11 −5" on the roster row; a fully approved session shows only its stat |
| Git view | `git-branches` | `git-worktrees` — agent worktrees with review state and diff size, sorted by size, merge disabled while a high-tier file is unapproved; `git-risk-tiers` — the per-project tier editor with defaults offered as unsaved rows |
| PR dialog | `pr-dialog` — empty body | `pr-dialog` — a worktree branch's body written from recorded evidence, with the sentence saying so |
| Goal verify task | `goal-verify` — the review gate only | `goal-verify` — the regression proof: its saved command, "proved: fails before, passes after", both exit codes and durations |

Run it again with `npm run build && node scripts/probe-helper-p3-review.mjs`
(add `--before --out <dir>` from a checkout of the base).
