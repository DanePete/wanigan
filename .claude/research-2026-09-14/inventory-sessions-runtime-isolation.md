<!-- Final report of a read-only code inventory agent, 2026-09-14, against main at a9e454e plus the uncommitted working tree. -->

Everything below comes from reading the code on `main`, including uncommitted changes. Nothing was run. Three caveats before the inventory:

- **Uncommitted work.** The session permission controls (`src/shared/session-permissions.ts`, and the matching edits in `sessions.ts`, `preload/index.ts` and `Sessions.tsx`) exist only in the working tree.
- **Hook events that never arrive.** `hooks.ts:187-259` only asks for the newer events (subagents, model switch, InstructionsLoaded, teams, CwdChanged and others) when given `options.cliVersion`. Neither caller passes it (`sessions.ts:1121`, `headless.ts:984`), so only the base events at `hooks.ts:152-156` are ever requested. Code that depends on the newer events receives nothing.
- **One broken-looking flow.** Codex account handoff looks broken by code reading; details under Continuity.

## Part A — What exists

**Session runtime** (`src/main/sessions.ts`, `TerminalPane.tsx`, `Sessions.tsx`)
- **SHIPPED:** real CLIs in node-pty (spawn `:1389`) with a cleaned environment. Parent-session markers are stripped, and your own Anthropic key is withheld when a profile points somewhere else (`:133-284`).
- **SHIPPED:** checks before launch refuse the session if the fleet is halted (`:960`), the interactive session limit is reached (`:871`), the monthly budget is used up (`:906`), a provider key is missing (`:944`), or the provider profile changed during setup (`:1257`).
- **SHIPPED:** what gets added at launch:
  - Claude Code: hook settings (`:1121`), MCP config (`:1125`), a session id Wanigan chooses (`:1042`).
  - Learning briefing and goal capsule: `--append-system-prompt` for Claude, `developer_instructions` for Codex (`:1211-1218`).
  - Codex: OSC 9 lifecycle notifications (`:1222`).
  - Attachment folders via `--add-dir`; Codex also gets `--sandbox workspace-write` (`:1141-1150`).
- **SHIPPED:** the first prompt is typed in after start; for Codex it waits for the ready prompt (`:442`, `:1734`).
- **SHIPPED:** 512 KiB of scrollback kept in memory per session (`:85`). Each session keeps one xterm that survives tab switches, and it replays the scrollback once when the pane opens (`TerminalPane.tsx:35,187,277`).
- **SHIPPED:** only one terminal is visible at a time. The Sessions view has:
  - Switching with ⌥⌘←/→, and renaming that persists.
  - An unread badge, closing exited tabs, and opening the session folder.
  - Interrupt (sends Escape; ⌘. works even inside the terminal) and end session (`Sessions.tsx:519-583,1047,1141-1164`).
- **MAIN-ONLY:** forced Ctrl+C interrupt (`sessions.ts:2262`); no renderer code passes `force`.
- **SHIPPED:** quitting asks for confirmation, then kills sessions with a 2-second grace period before SIGKILL (`index.ts:828-880`). After a crash, leftover rows are closed with exit code -1 on next start (`sessions.ts:1784`).

**Launch and providers**
- **SHIPPED:** five built-in profiles: claude, codex, glm, deepseek and xai (`provider-packs.ts:854-997`). GLM, DeepSeek and xAI are the Claude Code binary pointed at another endpoint.
- **SHIPPED:** local provider packs. These are JSON manifests with separate trust for the manifest digest and the adapter digest, plus enable/disable/remove/restore and a consent review (`providers.ts:538-649`, `provider-adapter.ts:155`, `Settings.tsx:1248-1340`). A local profile is a plain terminal unless a trusted adapter proves more.
- **SHIPPED:** New session dialog (`NewSessionDialog.tsx:472,934,983,1004`):
  - Provider and project; model from a catalogue labelled live, published or declared (`launch-choices.ts:235`); effort.
  - Six permission modes including plan (`provider-packs.ts:849`) and manifest launch fields.
  - Free-text extra args, initial prompt, isolate toggle and account picker.
  - A warning when another live session already uses the same checkout.
- **SHIPPED:** accounts are labelled `CLAUDE_CONFIG_DIR` / `CODEX_HOME` folders with a per-project default (`accounts.ts:377-449`). A resumed conversation is pinned to its original account (`sessions.ts:745`).
- **SHIPPED:** changing a running session: Claude `/model` and `/effort` are typed in and recorded (`sessions.ts:2180`, `Sessions.tsx:1595`); Codex gets `/model` and `/plan` buttons (`Sessions.tsx:1467-1510`).
- **SHIPPED (uncommitted):** permission controls — Shift+Tab to cycle, `/permissions` (`session-permissions.ts`, `Sessions.tsx:1428`).

**Isolation**
- **SHIPPED:** git worktree per session on branch `wanigan/<slug>-<id>` (`worktrees.ts:317-405`).
  - Gitignored dependency folders (node_modules, vendor, .venv, target…) are symlinked in; `.env*`, `auth.json`, `.npmrc` and `.tool-versions` are copied (`:266-315`).
  - Merge back (`:523`) and discard (`:656`); a clean worktree is removed automatically at exit (`sessions.ts:1719`).
  - Orphaned worktrees are listed and removable in Settings (`Settings.tsx:4752`).
  - Resume reuses the worktree or makes a fresh one (`sessions.ts:692-724`).
- **MAIN-ONLY:** `worktrees:relink` (`index.ts:2238`).
- **SHIPPED:** trust levels (read-only / project / trusted). A PreToolUse hook denies or asks and writes a ledger; it only applies to Claude Code sessions, and the code itself says it is "NOT CONTAINMENT" (`policy.ts:272`, `hooks.ts:453`).
- **SHIPPED:** Halt stops all agents, denies further tool calls and blocks launches, and it stays on across restarts. A phone can pull it; only the Mac can clear it (`halt.ts:231-289`, `App.tsx:1788`, `mobile/halt.ts:42`).

**Checkpoints and revert** (Claude Code sessions with hooks on, in a git repo)
- **SHIPPED — capture:** snapshots at session start, each prompt submit (turn start), each Stop (turn end), session end and before any revert. Each is `git add -A` into a scratch index → `write-tree` → `commit-tree`, chained on `refs/wanigan/checkpoints/<id>`. Unchanged trees are skipped, and capture turns off after 2 failures (`checkpoints.ts:80-208`). Gitignored files are not captured.
- **SHIPPED — restore:** Code panel "Turns" tab shows each turn's diff and "Restore to before turn N" with a preview (`CodePanel.tsx:141-219,476-560`).
  - Restore runs `git restore --source --worktree` and deletes files created since, after a safety snapshot (`checkpoints.ts:361-448`).
  - **Only files come back. The conversation is not rewound, and the git index is not touched.**
- **SHIPPED:** revert one file or all files to the launch commit (`revert.ts:77-221`); the launch commit is saved, so this works after a restart (`sessions.ts:2084`). Also: pruning (`queue.ts:620`), per-repo ref cleanup (`Settings.tsx:1773`), and an on/off toggle (`:1931`).
- **Gap:** the Turns tab and Timeline only open for sessions in the current in-memory list (`Sessions.tsx:1103-1121`). After a restart, a previous run's checkpoints can't be reached from the UI, even though the main process supports it (`checkpoints.ts:314`).

**Interaction**
- **SHIPPED — Composer** (`Composer.tsx:51-576`, `composer-queue.ts`):
  - Multi-line bracketed paste, per-session drafts and a saved-prompt stash.
  - A `$skill` menu and a `/compact` button.
  - A queue that sends when the agent is idle or finished, never into a permission prompt, plus "send now". The queue lives in memory only.
- **SHIPPED:** attachments by drop, paste or browse. The file is checked and copied to a per-session folder, and its path is typed into the prompt; images show an estimated cost (`attachments.ts:958-1030`, `Sessions.tsx:2005-2305`).
- **DEAD:** attachment retention and reclaim (`attachments.ts:1090-1398`); nothing calls them.
- **SHIPPED:** send a skill or `/init` into a live session (`index.ts:2591`, `Skills.tsx:267`, `Context.tsx:463`).

**Observation**
- **SHIPPED:** local hook server with a bearer token per session (`hooks.ts:83,318`).
- **SHIPPED:** attention states (permission / error / finished / idle / working, plus "Stalled") (`attention.ts:370`), shown in the attention strip and in Fleet. Fleet is a roster plus one inspector card with interrupt/stop (both confirmed), cost, tokens and sparkline (`Fleet.tsx:607-640,751`).
- **SHIPPED:** Timeline of tool calls, durations and failures (`Timeline.tsx`).
- **SHIPPED:** notifications to desktop and phone (ntfy / Web Push) for permission, error and finished (`notify.ts:106,879`).
- **SHIPPED:** read-only view of Claude sessions started outside Wanigan (`observed.ts:422`, ObservedBand).
- **SHIPPED (read-only):** agent teams panel (`teams.ts:197`, `TeamPanel.tsx`).
- **DEAD:** subagent tracking (`hooks.ts:676-700`) and model-switch write-back (`index.ts:905`); both wait for events that are never requested.

**Continuity**
- **SHIPPED:** Recent conversations — exact resume, pin/settle/forget, titles and launch counts (`sessions.ts:1822-2074`, `Sessions.tsx:384-907`).
- **SHIPPED:** exact Codex UUID recovery, which checks Codex's index, rollout, folder and writer lock (`sessions.ts:815`, `codex-sessions.ts:134-218`, `Sessions.tsx:1190`).
- **SHIPPED:** Claude transcripts are archived when a session exits, with full-text search and a reader in Settings (`transcripts.ts:382`, `Settings.tsx:5213-5276`).
- **SHIPPED — handover** at ≥85% context: asks the agent for a handover note, waits for Stop, and opens a fresh session seeded with it (`handover.ts:45-87`, `HandoverBubble.tsx:73`).
- **PARTIAL — limit variant of the same bubble:** it offers "carry the work to <roomier account>", but the new session uses the same account (`handover.ts:80-86` ignores `accountId` from `companion-says.ts:113`).
- **PARTIAL, likely broken — Codex account handoff:** the rollout is hardlinked into the other account (`handoff.ts:116`). The follow-up resume passes the target account (`SessionHandoff.tsx:41-47`), which `createSession` refuses in both states:
  - After exit: owner ≠ requested account (`sessions.ts:767-772`).
  - While running: "already open" (`sessions.ts:1031-1039`).
  - The smoke test (`smoke13`) covers only the link step.
- **SHIPPED:** MCP tools for goal checkpoint/claim, and for starting a session after human approval (`mcp/server.ts:301-391,777`).
- **DEAD:** `wanigan_recall_transcripts`; its opt-in setter `setRecallEnabled` has no IPC or UI caller (`transcripts.ts:992`).

**Remote access, power and misc**
- **SHIPPED:** phone web app over loopback with a bearer token, exposed via Tailscale serve from Settings (`tailnet.ts:392-426`). It shows the fleet, alerts and Recent. With the separate remote-control opt-in it can also:
  - Launch, resume, type prompts, press ↑/↓/←/→/Enter/Esc, interrupt, and read coloured terminal text.
  - Pause schedules, cancel headless runs, record goal review decisions, and pull Halt.
  - Git review/commit needs a further opt-in (`mobile/control.ts:43-248`, `index.ts:1226-1283`).
- **SHIPPED:** keeps the Mac awake while agents run (`awake.ts:175`).
- **SHIPPED:** goal interview (`interview.ts:413-510`), Mission room companion (`companion.ts:115`), project discovery from agent history (`discovery.ts:181`), macOS menu (`menu.ts:53`), project spaces (`spaces.ts:4`).
- **MAIN-ONLY:** `usage:events` (`index.ts:2179`) and `worktrees:forSession` (`index.ts:2239`).

## Part B — Presence checks

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | Split/grid terminals | ABSENT | `Sessions.tsx:1047` renders every pane but `visible={s.id===active?.id}`; others are `display:none` (`TerminalPane.tsx:355`). `.term-split` is terminal + side panel (`index.css:937`). Fleet shows no terminals. grep `term-grid\|terminal-grid\|split view\|mosaic` |
| 2 | Broadcast input to many | ABSENT (interactive) | Writes go to one session id (`Composer.tsx:61`, `TerminalPane.tsx:255`); grep `broadcast\|sendToAll\|writeAll\|multi-?select`. Nearby: headless fan-out, one prompt → one headless agent per repo (`types.ts:1145`, `headless.ts:559`, Runs view) |
| 3 | Structured transcript, live session | PARTIAL | Live sessions only get Timeline (tool calls, no messages) and phone terminal text (`mobile/terminal-text.ts`). Turn-by-turn reading exists only for archived, exited Claude sessions (`Settings.tsx:5213`, `transcripts.ts:661`) |
| 4 | Fork / resume at earlier turn | ABSENT | Resume is always the whole conversation (`provider-packs.ts:869,909`); grep `fork-session\|forkSession\|--fork\|resume-session-at` returns nothing, `rewind` only appears in comments. Free-text extra args exist (`NewSessionDialog.tsx:135`) but there is no fork feature |
| 5 | Per-turn checkpoints + rewind | PRESENT (files only) | `checkpoints.ts:80-448`, Turns tab; no conversation rewind; Claude Code + hooks + git only; previous runs unreachable after restart |
| 6 | Container/VM per session | ABSENT | Worktrees only. grep `docker\|devcontainer\|podman\|lima\|orbstack\|colima\|\bvm\b` → only `.docker` in a credential-path list (`policy.ts:231`) |
| 7 | OS sandbox / network allowlist | PARTIAL | Codex gets `--sandbox workspace-write` (`sessions.ts:1149`). Claude gets no sandbox settings — the injected file holds only `hooks` (`hooks.ts:318-347`). grep `sandbox-exec\|seatbelt\|allowlist\|allowedDomains`. Trust gate is "NOT CONTAINMENT" (`policy.ts:272`) |
| 8 | Remote execution over SSH | ABSENT | Local node-pty only (`sessions.ts:1389`); grep `\bssh\b\|remoteHost` → git's `GIT_SSH_COMMAND` (`git.ts:109`) and path guards. The phone controls the local Mac |
| 9 | Worktree bootstrap | PARTIAL | Symlinks ignored dependency folders and copies `.env*`/`auth.json`/`.npmrc` (`worktrees.ts:266-315`). No setup/teardown scripts, installs or APFS clone: grep `FICLONE\|clonefile\|cp -c\|apfs\|setup.?script\|postCreate\|worktreeinclude\|npm (ci\|install)` |
| 10 | Ports / dev server / preview | ABSENT | grep `dev.?server\|BrowserView\|WebContentsView\|previewUrl\|\bPORT\b\|portfinder`; webviews disabled (`index.ts:669,696`) |
| 11 | Voice / dictation | ABSENT | grep `voice\|dictat\|speech\|SpeechRecognition\|microphone\|whisper\|getUserMedia`; no microphone entitlement |
| 12 | Rebindable shortcuts | ABSENT | Fixed `BINDINGS` table (`bindings.ts:37`); settable preferences don't include keys (`settings.ts:137-178`); grep `rebind\|remap\|keybinding\|keymap` |
| 13 | Auto-update | ABSENT (stub) | `checkForUpdates()` always returns unavailable and nothing calls it (`cli.ts:728-746`); no electron-updater dependency |
| 14 | Windows/Linux builds | ABSENT | `electron-builder.yml` has only mac dmg/zip targets; scripts are `dist:mac*` only |
| 15 | ACP | ABSENT | grep `\bACP\b\|agent.client.protocol\|zed-industries\|session/new\|session/prompt\|claude-code-acp\|codex-acp` → no hits |
| 16 | Gemini, OpenCode, Copilot, Cursor, Amp, Droid, Goose, Aider, Ollama/LM Studio | ABSENT built-in; PARTIAL via packs | Built-ins are claude/codex/glm/deepseek/xai (`provider-packs.ts:854-997`). Any dedicated CLI can be a local pack, but as a plain terminal (`providers.ts:538-548`). grep `gemini\|opencode\|copilot\|cursor-agent\|droid\|goose\|aider\|ollama\|lmstudio` → only `GEMINI_API_KEY` in an env denylist (`provider-packs.ts:103`) |
| 17 | Model routing / subagent model | ABSENT | grep `CLAUDE_CODE_SUBAGENT_MODEL\|subagentModel\|modelRouter\|auto.?route`. Autopilot fixes one model per goal (`control.ts:1200-1215`); per-model outcomes are recorded but not used for routing (`control.ts:1023`) |
| 18 | Stuck/loop detection | PRESENT (Claude Code) | 6 identical failures in a row → "Stalled", notified (`attention.ts:49,292`). No completed tool call for 10 min → "Stalled", not notified (`:40,328`); no UI for the threshold. Codex sends no PostToolUse, so neither rule fires for it |
| 19 | Messaging / handoff between sessions | PARTIAL | No live messaging; `wanigan_list_sessions` "cannot see the other agents" (`mcp/server.ts:353`). Exists: `wanigan_start_session` after approval (`:777`), handover note (`handover.ts:62`), goal path claims, and verify/review steps reusing the implementer's worktree (`control.ts:558-597`) |
| 20 | Subagent tree; agent teams | ABSENT tree; PARTIAL teams | Subagent code is never fed (no `cliVersion`, `sessions.ts:1121`). Teams: read-only members, tasks and inbox previews (`teams.ts:197`, `Fleet.tsx:641`) |
| 21 | Plan-mode review surface | ABSENT | Plan exists only as a launch mode (`provider-packs.ts:849`), the Codex `/plan` button (`Sessions.tsx:1500`) and goal-step default (`control.ts:595`); approval happens in the terminal. PlanEditor edits goal task graphs, not agent plans. `ExitPlanMode` appears only at `policy.ts:123` |
| 22 | Session export/share | ABSENT | Save dialogs exist only for batch results, policy ledger and backup (`index.ts:2053,2573,3130`); grep `markdown\|text/html\|export.*session` |
| 23 | Terminal recording/replay | ABSENT | Only the in-memory 512 KiB buffer (`sessions.ts:85`), replayed once on pane open; lost on quit. grep `asciinema\|asciicast\|recording\|playback` |
| 24 | Queued follow-ups | PRESENT | `Composer.tsx:65-167`, `composer-queue.ts:22-45`; in memory only, not kept across restart |
| 25 | Resume after restart | PARTIAL | **Comes back:** exact conversation (Claude `--resume <uuid>`; Codex `resume <uuid>` or its picker), worktree reused or recreated, pinned account, title, attachment folders, pins, launch commits, archived transcripts, drafts/stash, Halt latch, orphan worktrees, phone resume (`index.ts:1249`). **Does not:** live process, scrollback, open tabs, queue, unread counts, UI access to earlier checkpoints. Interrupted rows get exit -1 (`sessions.ts:1784`); running goal steps are marked failed (`control.ts:1359`); crashed sessions' transcripts are never archived (archiving only runs on exit, `sessions.ts:1686`). No auto-relaunch |
