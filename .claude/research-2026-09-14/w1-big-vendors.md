# W1 — Big vendors' agent products: advanced capabilities and mechanisms (May–14 Sep 2026)

Labels: [V] read on a primary source · [S] second-hand · [B] blocked or unreadable. "Local" means a desktop wrapper can reproduce or drive the capability.

Source keys:
- CC-CL: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md. The changelog has no dates, so each date is the npm publish time of the version that introduced the feature.
- CC: https://code.claude.com/docs/en/<page>
- CX-rel: https://github.com/openai/codex/releases (tags rust-v0.x)
- CX: https://learn.chatgpt.com/docs/<page> (the Codex docs moved here)
- CUR: https://cursor.com/changelog/<slug> · CUR-docs: https://cursor.com/docs/<page>
- GH: https://github.blog/changelog/ · CPCLI: https://github.com/github/copilot-cli/blob/main/changelog.md
- AGY: https://antigravity.google/changelog · AGY-CLI: https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md
- GEM: https://github.com/google-gemini/gemini-cli/blob/main/docs/changelogs/index.md · JULES: https://jules.google/docs/changelog/
- KIRO: https://kiro.dev/changelog/ and https://kiro.dev/docs/
- AIR: https://blog.jetbrains.com/air/ · JUNIE: https://junie.jetbrains.com/whats-new
- DEVIN: https://docs.devin.ai/release-notes/overview · DD: https://windsurf.com/changelog (serves the Devin Desktop changelog)

## 1. Per-vendor capabilities

### Anthropic: Claude Code (CLI 2.1.128 on 4 May → 2.1.271)

**Orchestration**
- **Agent view and the supervisor** [V] (CC-CL 2.1.139, 11 May; research preview; CC agent-view).
  - A per-user supervisor daemon hosts every background session as its own process. Sessions survive terminal close, auto-update and sleep, but not shutdown.
  - Verbs: `claude --bg`, `attach`, `logs`, `stop`, `respawn [--all]`, `rm`, `daemon status|stop`.
  - `claude agents --json [--all]` returns, per session:
    - `state`: working, blocked, done, failed or stopped.
    - `status`: busy, waiting or idle.
    - `waitingFor`: permission prompt, input needed, sandbox request, worker request or dialog open. Added in 2.1.162, 3 Jun.
    - Also `pid` and `sessionId`.
  - `~/.claude/jobs/<id>/state.json` is explicitly not a stable interface. Each `CLAUDE_CONFIG_DIR` gets its own supervisor. Local.
- **`/fork`** copies the conversation into a background session with its own worktree (2.1.212, 16 Jul; 2.1.221). SessionStart reports `source:"fork"` [V].
- **Dynamic workflows** [V] (2.1.154, 28 May; CC workflows).
  - Claude writes a JavaScript script (`agent()`, `pipeline()`, `parallel()`, schema outputs) and a runtime executes it outside the conversation.
  - Scripts save to `.claude/workflows/`. A run replays on resume: cached results for completed agents, re-run from the first changed or failed agent.
  - Limits: 16 concurrent agents, env-raisable to 256 (2.1.269); 1,000 agents per run.
  - OTel attribute `workflow.run_id`. Local.
- **Subagents** [V]: background by default (2.1.198, 1 Jul); nesting depth 3 (2.1.219); fork subagent inherits context and cache (2.1.232, 13 Aug); permission rules can match parameters, e.g. `Agent(model:opus)` (2.1.178).
- **Agent teams** [V]: still experimental. One implicit team per session (2.1.178). File mailboxes at `~/.claude/teams/{team}/inboxes/{agent}.json`; `TeammateIdle` hook.
- **Cross-session messaging** [V] (2.1.224, 7 Aug).
  - Tools: `ListAgents` and `SendMessage`.
  - Each session has a Unix-socket inbox (`CLAUDE_CODE_MESSAGING_SOCKET` + `_TOKEN`); scripts can post one JSON line.
  - Delivery is gated by `crossSessionInbound` (accept, hold or refuse). `notify_when_idle` gives a one-shot idle notice (2.1.236).
  - Relayed messages carry no user authority (2.1.166). Local for same-machine delivery.
- **`/goal`** [V] (2.1.139; CC goal): a small model judges the completion condition after every turn; idle check-ins back off.

**Headless and SDK** [V]
- `--permission-prompts none` (2.1.259, 2 Sep): anything that would prompt is denied; stream-json emits `permission_denied` and the result lists `permission_denials`.
- PreToolUse `permissionDecision:"defer"` (CC hooks), `-p` only:
  - The run exits with `stop_reason:"tool_deferred"` and a `deferred_tool_use` payload (id, name, input).
  - The host gets an answer, then runs `claude -p --resume`; the hook returns `allow` with `updatedInput`.
  - Works only when the turn made a single tool call.
- stream-json additions:
  - `--forward-subagent-text` (2.1.211).
  - `init.mcp_server_errors` (2.1.219).
  - `set_model` control request applied mid-turn (2.1.212).
  - `register_repo_root` control request.
- Other flags: `--restricted` (2.1.248), `--safe-mode` (2.1.169), `--fork-session`, `--session-id`, `--from-pr`, `--teleport`. `auth status --json` now includes `configDirectory` (2.1.268).

**Hooks** [V] (CC hooks): 33 events. Handler types: `command`, `http`, `mcp_tool`, `prompt`, and `agent` (experimental). New since May:
- New events:
  - `MessageDisplay` (2.1.152).
  - `DirectoryAdded` (2.1.219).
  - `PreModelSwitch` / `PostModelSwitch`, with resume hooks receiving staleness and estimated re-cache cost (2.1.251, 28 Aug).
- Notification types: `agent_needs_input` / `agent_completed` (2.1.198); `quota_auto_resume_*` (2.1.234).
- New inputs: Stop receives `background_tasks` and `session_crons` (2.1.145). Hooks receive `effort.level` (2.1.133).
- New outputs and config: SessionStart `sessionTitle` and `reloadSkills` (2.1.152); `terminalSequence` (2.1.141); exec-form `args[]` (2.1.139).
- Also listed (ship dates unchecked): `InstructionsLoaded` (fires whenever CLAUDE.md or rules load), `PostToolBatch`, `PermissionDenied{retry}`, `ConfigChange`, `FileChanged`.

**Telemetry** [V] (CC-CL; CC monitoring-usage)
- OTel additions:
  - `claude_code.assistant_response` event, redacted unless `OTEL_LOG_ASSISTANT_RESPONSES=1` (2.1.193).
  - `message.uuid`, `client_request_id`, `tool_source` (2.1.214).
  - `agent_id` / `parent_agent_id` on spans (2.1.139, 2.1.145).
  - `OTEL_METRICS_INCLUDE_REPOSITORY` adds `vcs.*` (2.1.269).
  - Also listed: `tool.blocked_on_user`, `permission_mode_changed`, `compaction`.
- Status line JSON: `rate_limits.{five_hour,seven_day,spend_limit}` and `prompt_cache` with a likely miss cause (2.1.251, 2.1.260).
- `modelPricing` managed setting feeds cost figures (2.1.243). Transcripts record effort per message (2.1.212).

**Safety** [V]
- Auto mode: default for new Pro, Max and Team sessions from 14 Aug (CC whats-new w32). `hard_deny` (2.1.136); denial reasons (2.1.193); `claude auto-mode config`.
- Sandbox: credential masking with TLS termination and SigV4 re-signing (2.1.224); `network.strictAllowlist` (2.1.219).
- Checkpoints: one per prompt, last 100 kept. `/rewind` restores code, conversation, or both; "Summarize up to here" (2.1.141); rewind past `/clear` (2.1.191). The SDK exposes file checkpointing (CC checkpointing).

**Plugins and skills** [V]
- `claude plugin eval` (2.1.269, 11 Sep):
  - Each case runs in a fresh, isolated `-p` session with only the plugin loaded.
  - Graders: regex, tool-called, or judge rubric. Three runs per case, a no-plugin baseline, a threshold, JSON and HTML reports. Runs are billed.
- `/skill-doctor` shows unused skills and their context cost (2.1.261).
- `plugin details` shows projected token cost (2.1.139).
- `--json` on plugin commands (2.1.259). `/output-style` works headless (2.1.269).
- The LSP tool predates May (2.0.74, Dec 2025).

**Remote and cloud** [V]
- Routines (research preview): cloud or self-hosted runs, triggered by schedule (minimum 1 h), API POST or GitHub events.
- Desktop local scheduled tasks: minimum 1 min, only while the app is open, optional worktree (CC desktop-scheduled-tasks).
- Remote Control is out of research preview; a phone can start a session on a machine (w34). `CLAUDE_CLIENT_PRESENCE_FILE` suppresses mobile push while at the machine (2.1.181).
- Dispatch (Pro and Max): the Cowork tab spawns badged Code sessions (CC desktop; undated).
- Channels (preview): an MCP server pushes events into a running session.

### OpenAI: Codex (CLI 0.129 on 7 May → 0.154 on 9 Sep)
- `codex mcp-server` is **removed**; integrations must use `codex app-server`, which is experimental [V] (CX mcp-server).
  - Transport: JSON-RPC over stdio, a Unix socket, or authenticated WebSocket.
  - Methods [V] (CX app-server):
    - `turn/steer` (needs `expectedTurnId`).
    - `thread/inject_items`.
    - `thread/status/changed` with `activeFlags:["waitingOnApproval"]`.
    - `review/start` with target uncommittedChanges, baseBranch, commit or custom; inline or detached.
    - `thread/goal/set` with `tokenBudget` and `tokensUsed`.
    - Fork through a turn (0.143, 8 Jul).
- `exec --json` JSONL events [V] (CX non-interactive-mode): `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, `error`. Also `--output-schema`, `--ephemeral`, `exec resume`, `exec fork` (0.148, 18 Aug).
- Hooks [V] (CX hooks):
  - 12 events. `Interrupt` is new in 0.150 (26 Aug); async and MCP-tool hooks are new in 0.148.
  - Inputs carry `turn_id` and `permission_mode`.
  - Trust is recorded per hook hash; `--dangerously-bypass-hook-trust` skips it; managed hooks come via `requirements.toml`.
- Sessions [V]:
  - `codex agents` dashboard (0.149, 20 Aug).
  - `codex queue` messages an existing local or remote session (0.149).
  - Tasks can `@`-mention and message other tasks (0.150).
  - Experimental `--worktree` (0.154). Windows shared background server with daemon (0.154).
- Budgets and safety [V]:
  - Rollout token budgets abort turns when exhausted (0.142, 22 Jun).
  - Goals on by default (0.133).
  - Permission profiles (beta).
  - `--approve-for-me` (0.147, 7 Aug) routes approvals to a reviewer agent without widening what is permitted (CX sandboxing/auto-review).
- `/import` from Claude Code and Cursor (0.140, 0.145) [V].
- AGENTS.md: `AGENTS.override.md` takes precedence; files concatenate root→cwd up to `project_doc_max_bytes` (32 KiB) [V].
- Memories are a local store with per-chat `/memories` controls [V].
- App and cloud [V]:
  - The Codex app is now a mode of the ChatGPT desktop app.
  - Scheduled tasks can run in a local worktree but must be created in the app or web; there is no CLI scheduler (CX automations). Gmail, Slack and GitHub event triggers on web (25 Aug).
  - Codex Remote from the phone.
  - Codex Micro keys light up by chat state: idle, thinking, complete, requires input, error.

### Cursor [V, CUR]
- **Projects** (10 Sep, beta): a coordinator agent that plans and delegates but doesn't write code; shared context files synced across machines; subscriptions. Cloud.
- **Self-hosted machines and worker pools** (2 Sep).
- **Cloud agents** (19 Aug): subscriptions wake agents on PR or Slack events; skills pinned as custom modes; subagents on their own VMs; `/goal`. Builds keep warm environments (13 Aug).
- **Side chats and search** (10 Jul): side chats, a local transcript search index, and new cloud-agent hooks `beforeSubmitPrompt`, `afterAgentResponse`, `afterAgentThought`, `stop`, `subagentStart`.
  - The hooks reference also lists `preToolUse` / `postToolUse`, `beforeShellExecution`, `beforeMCPExecution`, `afterFileEdit`, `preCompact`, `workspaceOpen`.
  - Cursor loads Claude Code hooks (CUR-docs hooks).
- iOS Remote Control of local agents (29 Jun). `/in-cloud` subagents and local↔cloud handoff (17 Jun).
- Auto-review run mode: a classifier subagent gates Shell, MCP and Fetch calls (29 May). The SDK auto-review is steered by `allow_instructions` / `block_instructions`, with JSONL agent stores (4 Jun).
- `/review` runs Bugbot before push (10 Jun). `/loop` (20 May). Build in Parallel and Split PRs (7 May).
- CLI: `agent -p --output-format json`; `agent acp` speaks JSON-RPC over stdio (CUR-docs).

### GitHub Copilot [V, GH and CPCLI]
- Copilot app GA (17 Jun): parallel worktree sessions, canvases, cloud automations.
- Agentic Workflows public preview (11 Jun): Markdown compiles to Actions YAML.
- Agent tasks REST API (13 May; Pro on 4 Jun). Cloud-agent automations (2 Jun) and comment triggers (3 Aug).
- Copilot SDK GA in six languages with W3C trace propagation (2 Jun). Local and cloud sandboxes, public preview (2 Jun).
- `/chronicle`: cross-surface session insights; local sessions sync to GitHub (2 Jun).
- Agent session streaming to a SIEM or REST (2 Jul, EMU). AI-credit session limits, `--max-ai-credits` (1 Jul).
- Agent Plugins 1.0, a cross-vendor standard (6 Aug).
- Issue automation (23 Jul): each change carries a confidence rating and a rationale; low-confidence changes are held as suggestions.
- Code review can approve PRs (preview, 1 Sep) and auto-resolves addressed comments (11 Sep).
- Enterprise managed permissions (9 Sep).
- Copilot CLI:
  - `/fork` (1.0.45).
  - `/autopilot <objective>` aliased `/goal` (1.0.55).
  - `/every` and `/after` scheduling (1.0.64); `/rubber-duck` cross-model critique (1.0.49).
  - `preMcpToolCall` hook (1.0.51); hooks get `traceparent` (1.0.81, 27 Aug).
  - ACP subagent IDs and raw events (1.0.81); `--usage-output-file` per-agent (1.0.81).
  - "Mission Control" appears only as the remote upload target (1.0.74).

### Google
- **Antigravity 2.0** [V, AGY]: standalone agent app, first release 19 May. Remote Control with push notifications (2.9.1, 20 Aug). Embedded terminal and git (2.10). Hook fixes: stop hooks capped, failing hooks no longer end sessions (2.6, 7 Aug).
- **Antigravity CLI** [V, AGY-CLI] (1.0.4 on 1 Jun → 1.2.2 on 12 Sep):
  - `-p --output-format stream-json` with typed `init` / `step_update` / `result` events and `--json-schema` (1.1.8, 28 Jul).
  - `--input-format stream-json` keeps one session open (1.1.15).
  - `denied_actions` in JSON output (1.1.27). Status line `cost` (1.1.21).
  - `proceed-in-sandbox` permission mode; `/goal` (1.0.14).
  - `remote-control start` installs an OS service (1.2.0).
- **Antigravity SDK** 0.1.x [V] (29 May on): session budget limits (0.1.11); pre-tool argument modification hooks (0.1.13).
- **Jules** [V]: last changelog entry 9 Mar 2026; nothing since May.
- **Gemini CLI** [V, GEM]: Auto Memory inbox with a canonical-patch contract (0.42, 12 May); session export/import (0.43). July–September releases are mostly security fixes.

### AWS Kiro [V, KIRO]
- **Kiro Crew** is an "open-source personal AI agent" with a local Gateway at `localhost:5476`, installed via desktop app, wheel or Docker. It is the closest analogue to Wanigan.
  - 0.5.0 (29 Aug): session tabs; a conductor splits a goal into sessions and messages them; a fleet-wide `security_policy.json`.
  - 0.6.0 (5 Sep, preview): pick **Claude Code, Codex or KAS** as the harness per session; remote crews.
- **Kiro CLI 3.0** (early `--v3`):
  - `permissions.yaml`.
  - `.kiro/hooks/*.json` triggers: SessionStart, Stop, PreToolUse, PostToolUse, PreTaskExec, PostTaskExec, UserPromptSubmit, PostFileCreate, PostFileSave, PostFileDelete, Manual.
  - Also Tangent, Goal, queue steering, ACP, headless.
  - Session dashboard (2.21.0, 1 Sep).
- Server-side OTel usage export (1 Sep).

### JetBrains [V, AIR and JUNIE]
- **Air**: preview 9 Mar. Hosts ACP agents including Copilot, OpenCode, Pi and Cline (21 Jul). Multiproject view (19 Aug).
- **Junie**: GA 17 Jun. Junie Local runs fully on-device (24 Aug). CLI adds `/branch` and live session cost (7 Sep).

### Cognition [V, DD and DEVIN]
- **Devin Desktop**:
  - Windsurf renamed Devin Desktop (2 Jun).
  - Devin Local: mid-turn revert; sanitized shared transcripts; permission layers where an explicit deny wins and each denial names its layer (3.7.16, 10 Aug).
  - Cascade removed (8 Sep).
  - ACP always on; remote agent hosts over SSH with transcript recovery (3.10.23, 10 Sep).
  - `post_setup_worktree` hooks (3.8.20). Codemaps can be @-mentioned (29 Jul).
- **Devin cloud**:
  - Network access requests (1 Jul); Outposts self-hosted workloads (22 Jul).
  - Automations API v3 with Terraform provider; security profiles (7 Aug).
  - Nested sub-Devin tree (21 Aug).
  - Idempotent session creation and PagerDuty automations (11 Sep).
- **DeepWiki**: only a "faster MCP answering" note (24 Jul).

## 2. CLI-layer hooks a wrapper can use

1. **Claude Code: `claude agents --json --all`** (`state`, `status`, `waitingFor`), plus `attach`, `logs`, `stop`, `respawn` for supervisor-hosted sessions [V].
2. **Claude Code: Notification hook** `agent_needs_input` / `agent_completed` (fire only while agent view is open) and `quota_auto_resume_*`. Use `PermissionRequest` for immediate firing [V].
3. **Claude Code: PreToolUse `defer`** → `tool_deferred` → `--resume`, for phone approval of headless runs [V].
4. **Claude Code: `--permission-prompts none`**; unattended denials are recorded in `permission_denials` [V].
5. **Claude Code: inbox socket** `CLAUDE_CODE_MESSAGING_SOCKET`; launch with `--settings '{"crossSessionInbound":"accept"}'` [V].
6. **Claude Code: hook events and handlers**: `InstructionsLoaded` shows the real context chain; `PreModelSwitch` / `PostModelSwitch`; resume re-cache cost; `http` handlers POST to a local server [V].
7. **Claude Code: telemetry**: status line `rate_limits` and `prompt_cache`; OTel `assistant_response`, `message.uuid`, `agent_id` / `parent_agent_id`, `workflow.run_id`, `vcs.*` [V].
8. **Claude Code: stream-json**: `--forward-subagent-text`; `set_model` and `register_repo_root` control requests [V].
9. **Codex `app-server`**: `thread/status/changed`, `turn/steer`, `thread/inject_items`, `review/start`, `thread/goal/*` (tokenBudget), approvals as JSON-RPC requests [V].
10. **Codex CLI**: `exec --json`, `--output-schema`, `exec resume` / `exec fork`; `codex queue`; `Interrupt` hook. Hash-based hook trust means injected hooks trigger a review unless they are managed or trust is bypassed [V].
11. **ACP servers**: Cursor `agent acp`, Kiro CLI, Copilot CLI (subagent IDs, `closeSession`), Junie. Air and Devin Desktop already host ACP agents [V].
12. **Copilot CLI**: `--max-ai-credits`, `--usage-output-file`, hook `traceparent` [V].
13. **Antigravity CLI**: typed stream-json in and out, `denied_actions`, status line `cost` [V].
14. **Kiro CLI**: `.kiro/hooks` with `PreTaskExec` / `PostTaskExec` spec gating; ACP [V].

## 3. Top 12 for a local-first control surface (ranked)

1. **Host Claude sessions on Claude Code's supervisor** (`--bg`, `attach`, `agents --json`).
   - Why: PTYs can re-attach after a Wanigan quit instead of dying.
   - Feasibility: local, Claude-only, research preview. Still stops at shutdown; one supervisor per config dir.
2. **One structured "blocked-on" model**: Claude `waitingFor`, Codex `activeFlags`, `agent_needs_input`, ACP permission requests.
   - Why: sharper ranking of which session needs the operator, with no scraping.
   - Feasibility: local.
3. **Deferred approvals for headless fan-out**: `defer` → approve on phone → `--resume`; `--permission-prompts none` denials stored as evidence.
   - Feasibility: local.
4. **ACP adapter for generic provider packs**.
   - Why: plans, tools and permissions arrive as data. Air, Devin Desktop and Kiro Crew host many harnesses this way.
   - Feasibility: local, but verify each CLI end to end.
5. **Codex via app-server**: steer, inject, review, goal budgets.
   - Why: `mcp-server` is gone.
   - Feasibility: local, experimental API.
6. **Push budget caps into the harness**: Codex rollout token budgets and goal `tokenBudget`, Copilot `--max-ai-credits`, Claude `--max-budget-usd`.
   - Why: caps get enforced, not just watched. Semantics differ; Copilot's is a soft cap.
   - Feasibility: local.
7. **Harness-reported metering**: status line `rate_limits` and `prompt_cache`, OTel `assistant_response` / `message.uuid` joins, resume re-cache cost.
   - Why: per-account limits and cache waste become observed facts.
   - Feasibility: local. Keep pricing labeled as an estimate.
8. **Harness-native goals with judge verdicts recorded**: Claude `/goal`, Codex `thread/goal`, Copilot autopilot, Kiro Goal.
   - Why: evidence of why a loop continued or stopped.
   - Feasibility: local. The judge is a billed call.
9. **Operator→session injection**: Claude inbox socket, `codex queue`, `turn/steer`.
   - Why: no keystroke faking.
   - Feasibility: local.
10. **Restore-point timeline**: Claude `/rewind` and SDK file checkpoints, Codex fork-through-turn, Junie `/branch`.
    - Feasibility: local. No non-interactive rewind CLI flag was found.
11. **Eval-gate learned projections**: `claude plugin eval` vs. no-plugin baseline, `/skill-doctor`, `InstructionsLoaded` to confirm actual loading.
    - Feasibility: local. Billed runs, so consent-gate them.
12. **Record classifier verdicts and rationale in the policy ledger**: Claude auto-mode denial reasons, Codex auto-review rationale, Cursor allow/block instructions, GitHub confidence-held suggestions.
    - Feasibility: local capture. The classifiers are vendor models.

## 4. Could not verify

- **Claude Code dates** are npm publish times of the introducing version. Ship dates for Dispatch and `InstructionsLoaded` were not established.
- **Codex cloud best-of-N**: only the phrase "compare several attempts" was found; mechanism and date unknown [B].
- **Cursor multi-model or best-of-N runs**: no changelog entry since May.
- **GitHub "Agent HQ / mission control"**: absent from 300 Copilot changelog titles (Feb–Sep).
- **Antigravity "Agent Manager" and browser verification**: not seen in 2.x changelog headlines.
- **Gemini CLI hooks and checkpointing**: pre-date May; not re-verified.
- **Kiro Crew**: launch date (earliest feed entry 17 Aug) and repository location unverified.
- **JetBrains Air / Junie**: details beyond blog and what's-new pages unread.
- **devin.ai/changelog** returned 429 [B]; docs.devin.ai was used instead.
