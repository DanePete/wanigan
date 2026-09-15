# The helper sweep, built

Built 14–15 September 2026 on `feat/helper-sweep`, from the
[helper sweep report](https://claude.ai/artifact/3bVrmdHkLTJScrKDQa1rfU) (raw
findings in the main checkout at `.claude/research-2026-09-14-sweep/`). Nine
packages were built in parallel worktrees and merged here in this order: P2, P3,
P4, P1, P5, P9, P6, P8, P7. After the merges, an integration pass connected
pieces that had been built separately.

Nothing is pushed. No real agent session or paid call was started by any build,
test or probe. Every package has before and after screenshots in both themes
under `docs/visuals/helper-<package>/`, taken by `scripts/probe-helper-<package>.mjs`.

## Status against the report

"Built" means it exists, is reachable from the UI, and has shared tests and
smoke checks. "Partly" names what is missing. Items marked *extends* went past
what the report listed.

### Build first

| # | Item | Status | Where |
|---|---|---|---|
| 1 | Show what `npm run` / `make` / `just` actually runs in an approval | Built | P1: `shared/script-explain.ts`, `shared/shell-parse.ts`; Fleet inspector, phone card |
| 2 | Auto-mode denials as attention items; trust level → `autoMode` rules | Built | P2: rule `auto-mode-denied`; P1: `shared/auto-mode.ts`, injected via `--settings` (version-gated), shown read-only in Context |
| 3 | "Needs review" with per-file reviewed marks | Built | P3: `shared/review-marks.ts`, `main/review-work.ts`; Fleet chip, Git rows, code rail; integration: the attention queue labels it |
| 4 | "Since you last looked" from evidence | Built | P2: `shared/away-summary.ts`; Claude's own `away_summary` line shown, labelled |
| 5 | Agent edits vs everything else; `bashEditDiffEnabled` | Built | P3: three diff scopes, "changed outside edit tools", stage only the session's hunks |
| 6 | Usage-limit wait named, not stalled | Partly | P2: `limit-wait` / `limit-reset` / `limit-stopped`; resume-at-reset persisted and cancellable. The CLI sends no event when a wait *starts*, so the state is inferred from StopFailure `rate_limit` and says so |
| 7 | Codex instruction budget meter | Built | P4: Codex loader in Context, projection pre-check, stale-reference lint |
| 8 | Spend yield | Built | P4: worktree outcome columns, revert detection, `OTEL_METRICS_INCLUDE_REPOSITORY`; Insights › Where the money went |
| 9 | New dependencies as review items | Partly | P3: parsers for ten manifest kinds, install-command detection. No per-turn attribution, no network advisory lookup |
| 10 | What a session left running | Built | P5: process tree, listening ports, survivors after exit or Halt, verified stop. Codex background terminals: unsupported in 0.154 (no app-server method) |
| 11 | Triage keys | Built | P2: snooze, mark unread, ⌘J next-needs-you, ⌘⇧T reopen, in-place Resume |
| 12 | Provider incidents | Built | P2: status.claude.com unresolved incidents; status.openai.com has no such endpoint, so its list is filtered by title |

### Approvals and the policy gate (P1, P7)

Built:
- Shell parsing before matching, with 19 bypass fixtures proven against the old matcher.
- Gate self-test at start.
- Download tripwire.
- Approval fatigue, labelled inferred.
- History-rewrite evidence pinned under `refs/wanigan/evidence/`.
- Grants for unattended runs (opt-in).
- Skill capability lock.
- Exposure paths ("lead, not proof").
- "Always ask before history-rewriting git commands, even at Trusted" (opt-in, P7).
- Rejected steps kept visible on the Timeline (P7).

Not built: remembered-approval expiry and widening an approval's scope. Approvals are answered in the CLI's terminal, and Wanigan holds no approval of its own that could expire or widen.

### Reviewing the work (P3, P7, P9)

Built:
- Tests-first order and test alarms.
- Fail-before/pass-after regression proof.
- Claims in the final message graded against the diff.
- Risk tiers per repository, gating merge.
- PR body from recorded evidence.
- Hide whitespace, find across the diff, path filter, image before/after, diff-stat badges, unsent-note guard.
- Scoped Code Review Rules (P7), carried by Send review, goal review tasks and second opinions.
- Maintainability numbers per checkpoint, labelled heuristic (P7).
- Scratch files kept out of counts (P7).
- A second review from another vendor, adjudicated by the operator (P9, billed, consent twice).
- Decisions nobody asked for (P9, same backend only).
- Line-level attribution computed locally, with an explicit git-notes export (P8).

Not built: agent-authored annotations on the diff (hunk-style).

### Session state and talking to sessions (P2, P5, P6)

Built:
- Spinning.
- Replying from a notification (the reply lands as a draft).
- Same conversation open twice, with resume as a fork.
- Headless refusal of interactive-only slash commands, read from the binary.
- Finer headless outcomes.
- Network-before-auth labelling.
- Asked-for vs answered-by model.
- Session tags and sections.
- Terminal links.
- Copy helpers.
- Quote into message.
- Side question (Claude `/btw`; Codex `/side` alone).
- Code rail in its own window.
- Shortcut search.

Partly built:
- Questions as buttons: options are shown read-only, because the TUI's selection keys were not verified.
- Mermaid: shown as source only, because rendering needs a dependency and none was added.

Not built: non-blocking Codex questions as a reason code (reachable only through app-server).

### Cost, quota and context (P4)

Built:
- Codex credits estimate.
- Cold-cache warning.
- Cost by cause, including `cache_miss_reason`.
- Window share per session.
- Schedule admission and schedule memory.
- Session anatomy.
- Skill listing cost and Codex's manual-only switch.
- Byte-stable projections.
- Subagents that skip CLAUDE.md.
- Weekly recap (P8), reading recorded outcomes where they exist and git for the rest.

Not built: behaviour drift across CLI versions. It needs the per-session `cli_version` that the observed-telemetry worktree is adding.

### Across harnesses and honest readers (P5)

Built:
- Continue a Claude conversation in Codex through Codex's own importer (sessions only).
- Compressed-rollout and unparsed-line reporting.
- `codex doctor` per account.
- Diagnostics export.
- Launch value provenance.
- Review-only sessions (`--restricted`) and Review PR #N.
- Config files never overwritten when they fail to parse. This fixed a real bug: an unparseable approvals file was saved over, deleting its grants.

Not built:
- A built-in Antigravity (`agy`) profile: not installed, so it cannot be verified.
- Usage adapters for other harnesses' stores.
- A hook and permission map per harness.

### The Mac around the app and local automation (P8)

Built:
- Dock badge and menu-bar session list (opt-in).
- Owner-only automation socket with a ledger (opt-in; send needs its own toggle).
- Script launcher with operator-owned terminals.
- Per-provider Wanigan MCP tools.
- Title and branch naming templates.
- Hook dry-run bench.
- Transcript chain check before resume.

Not built: keeping a lid-closed Mac awake. It needs a privileged helper installed with an administrator password, which is a trust-boundary decision and could not be done or verified here.

## Integration after merging

- **Attention queue:** it now reads policy signals and review state. A tripwire or pinned history rewrite in the last 15 minutes becomes an error-kind verdict ("Tripwire", "History rewritten") unless a person is already being asked or has since sent the session a prompt. A finished session whose diff needs review carries "Needs review · N of M files". Both come through callbacks, so no import cycle is added. Rules are in `shared/attention-evidence.ts`.
- **Second opinions:** they send the Code Review Rules covering the changed files, each cited, and the consent dialog counts them.
- **Settings writer:** the injected Claude settings file carries P3's version-gated keys and P1's auto-mode block in one atomic write (P5).
- **Recent rows:** "Continue in Codex…" moved into the row's "#" panel. Two packages' actions had pushed the hover strip over the conversation's name.
- **Renderer harness:** fixtures for channels the packages added. Sessions, Context, Schedules and Settings had fallen into the error boundary for every probe that did not override them, and the whole window went blank on subscriptions named `onX`.

## Known limits of the evidence

- The screenshot probes stub the preload bridge. They prove layout, wording and both themes, not IPC. Smoke covers the main process against real SQLite, git and the hook listener.
- These were never exercised live: the menu-bar item, the Dock badge, macOS notification replies, the pop-out window's IPC, the Codex import's resume, and a real limit-wait signal from Claude Code.
- No duplicate code was consolidated. P8's script listing and P1's script resolution each parse `package.json`, Makefiles and justfiles separately.
