<!-- Final report of a read-only code inventory agent, 2026-09-14, against main at a9e454e plus the uncommitted working tree. -->

# Wanigan capability inventory: knowledge/context, observability/cost, security/governance

All paths are under `/Users/dane/Projects/drupal/wanigan/`. Main-process code is in `src/main/`, views are in `src/renderer/src/views/`, and components are in `src/renderer/src/components/`.

**Tags:** SHIPPED = reachable from a view or the CLI. MAIN-ONLY = backend or IPC with no renderer surface. PARTIAL = part of the feature exists. DEAD = no production caller (only the smoke tests call it).

## Part A: Capabilities by subsystem

### A1. Learning engine
Files: `src/main/learning/*`, `src/main/learning-service.ts`, `src/main/learning-model-assist.ts`, `views/Learning.tsx`.

- **Signal capture: SHIPPED (automatic).**
  - `recordSignal` (`learning/signals.ts:59`) stores a summary of at most 4 KB and JSON detail of at most 32 KB, de-duplicated by sha256.
  - Hook events become tool-success/failure, permission-denied, session-success/failure and compaction signals (`learning-service.ts:1850`). Shell command text is discarded and credentials are redacted.
  - Other producers: review-gate results (`:1899`), Teach from the Learning and Sessions views (`:336`), skill installs, and retirements.
  - `FileChanged` is never requested from Claude (`hooks.ts:176`), so `file-change` signals never arrive.
- **Consolidation: SHIPPED.** Runs on a 5-minute timer (`:1983`), from a Consolidate button, and via CLI `learn-consolidate` (`cli.ts:718`).
  - Signals are clustered on provider, backend, project and structured facets: tool, outcome, error class, path prefix and failing command (`:569`).
  - Six hand-written templates produce claims (`:635-707`). Anything else becomes a "NEEDS AUTHORING" nomination (`:720`).
  - Clusters of pure successes are consumed rather than nominated (`claimPossible`, `:1249`). Signals age out after 45 days (`:956`). The run heartbeat keeps 2,000 rows (`learning/ledger.ts:181`).
- **Automation gate: SHIPPED.**
  - Only personal `memory` can auto-promote: confidence ≥0.9, ≥2 pieces of evidence, ≥2 independent tasks, never snoozed, no conflicts (`learning/classifier.ts:70`).
  - Machine-derived confidence is capped at 0.85, so derived claims never actually auto-apply (`learning-service.ts:785`).
  - Each check is explained in the UI (`learning/ledger.ts:566`).
- **Review inbox: SHIPPED.** Approve, reject, snooze, reopen and edit; a snoozed candidate wakes when a new independent task sees it (`learning/repository.ts:293,409`). Unactionable nominations can be swept (`learning-service.ts:1192`, CLI `learn-sweep`).
- **Model-assisted phrasing: PARTIAL.**
  - The consent card is SHIPPED (`Learning.tsx:2656`). The pass itself runs on the timer and via CLI `learn-phrase`. IPC `learning:phrase` has no renderer caller (MAIN-ONLY).
  - Gates (`learning-model-assist.ts:271-363`): consent pinned to a profile fingerprint, same provider/backend as the signals, a declared headless protocol, metering proven from `learning_model_runs`, and a monthly budget that is >0 and not used up.
  - The payload is 9 facet fields plus 2 counts (`:59`).
- **Canonical store: SHIPPED.** Versioned items with evidence, including sha256 of touched files (`learning/repository.ts:519,577`). Retire-with-reason (`:719`). FTS5 bm25 search (`:826`).
- **Briefing: SHIPPED.** `buildBriefing` (`learning/briefing.ts:152`):
  - What is eligible: only mission/instruction/rule/memory kinds.
  - Query: up to 12 non-stopword terms from the launch prompt, plus an optional path hint that must exist on disk.
  - Ranking: 0.55 × normalised bm25 + 0.35 × confidence + a scope boost.
  - Budget and freshness: token ceiling defaults to 1,200 (setting range 200–8,000); at most 25 citation re-hashes per launch; items with changed or missing cited files are quarantined.
  - Output: lines of the form `- [kind] title: claim (wanigan:<id>; ≤3 citations)`.
  - Delivery: Claude `--append-system-prompt` or Codex `--config developer_instructions=` (`sessions.ts:1160-1217`), headless argv (`headless.ts:287,303`), or SessionStart `additionalContext` (`hooks.ts:634`).
  - Each delivery is recorded in `session_briefings` plus a `tokens_loaded` estimate (`learning/ledger.ts:39-85`). Delivery extends the 90-day TTL on machine-derived items (`:119`).
  - A read-only preview exists (`learning-service.ts:1668`, `Learning.tsx:2508`).
- **Projections: SHIPPED.**
  - Claude targets: CLAUDE.md, `~/.claude/CLAUDE.md`, `.claude/rules/<slug>.md` with `paths:`, `.claude/skills/*/SKILL.md`. Codex targets: AGENTS.md, nested `dir/AGENTS.md` (only for `dir/**`), `~/.codex/AGENTS.md`, `.agents/skills` (`learning/compilers.ts:134,189`).
  - Writes a managed block, checks the base hash, writes atomically inside granted roots, keeps the prior content, and undo is hash-guarded (`learning/projections.ts:213,267`).
  - Cross-backend projection is refused and skills pass the Skill Doctor gate (`learning-service.ts:1539-1600`). Nothing is ever committed.
- **Per-session ledger: SHIPPED** (`Sessions.tsx:1124`, `learning/ledger.ts:391`). Shows briefings, signals, knowledge contributions, candidates and hook-observed Skill calls.
  - The transcript citation scan `recordTranscriptCitations` (`:331`) is DEAD (only `smoke4.ts:1645` calls it), so its status always reads "not-scanned".
- **Pipeline stats: SHIPPED** (`learning/ledger.ts:460`).
- **Optimizer diagnostics: SHIPPED** (`learning/optimizer.ts:17`). Flags duplicate, expired, weak-evidence, oversized, procedure-as-rule, unused for 45 days, and projection drift.
  - The contradiction finding can never fire: relations are written only by `recordContradiction` and `indexExactDuplicates` (`learning/staleness.ts:130,146`), which are DEAD.
  - `diagnoseCacheShape` (`optimizer.ts:128`) is also DEAD.
- **Experiments/ROI: PARTIAL.** You can register, start and close A/B drafts (`learning/experiments.ts:72`), but nothing launches workloads (the UI says so at `Learning.tsx:2948`). The only metrics written in production are `tokens_loaded` and `invocation`.

### A2. Context inspection
Files: `src/main/context/{instructions,memory,config}.ts`, `views/Context.tsx`.

- **CLAUDE.md chain prediction: SHIPPED** (`instructions.ts:1093`, `Context.tsx:673,724`). Claude only. Covers managed, user, ancestor, project and local files, rule globs, `@imports` up to 4 hops, and the 4 MiB skip.
- **AGENTS.md checks: SHIPPED** (`instructions.ts:927`, `Context.tsx:761,797`). Whether Claude reads AGENTS.md, and whether Codex will read the files Wanigan writes.
- **Predicted-vs-actually-loaded reconciliation: DEAD.** `reconcileInstructions` (`:1014`) and `instructionsLoaded` (`hooks.ts:1133`) are smoke-only, even though InstructionsLoaded events are stored.
- **Auto-memory and MEMORY.md budget meter: SHIPPED** (`memory.ts:37,43,633`, `Context.tsx:848`). Limit is 200 lines or 25 KiB.
- **Settings layers, hooks, MCP, agents, commands, permissions: SHIPPED** (`config.ts:737`, `Context.tsx:907`). Secrets are redacted.
- **Token and USD-per-session estimate: SHIPPED** (`config.ts:854`, `Context.tsx:1103`).

### A3. Skills
Files: `src/main/skills.ts`, `src/main/learning/skills.ts`, `views/Skills.tsx`.

- **Catalogue: SHIPPED** (`skills.ts:544`). User, project, plugin, built-ins seen on disk, and the `.agents` family, with shadowing and invocability. You can read a skill body and type its invocation into a session without pressing Enter (`:661,726`).
- **Skill Forge and Skill Doctor: SHIPPED** (`learning/skills.ts:31,131`; `Skills.tsx:418-447`).
  - Doctor checks: frontmatter, name, trigger words, over 500 lines, missing verification section, `rm -rf`/`sudo`/`curl|sh`, escaping or dead references, ≥70% trigger overlap with other skills.
  - Doctor runs only on forged or projected text, not on skills discovered on disk.
- **Invocation metric: SHIPPED** (`learning-service.ts:1830`). Only for skills Wanigan installed.

### A4. Transcripts and handover
File: `src/main/transcripts.ts`.

- **Archive, search, read, forget: SHIPPED** (Settings > Privacy and the command palette). Archive on exit for the Claude harness (`:382`), FTS5 search (`:532`), reader (`:661`), forget including the file on disk (`:708`).
- **Context occupancy: SHIPPED** (`:924`, `App.tsx:1651`). Tokens against a window assumed at 200k or 1M, or reported by the CLI.
- **MCP tool `wanigan_recall_transcripts`: MAIN-ONLY** (`mcp/server.ts:391`). Its per-project switch `setRecallEnabled` (`:992`) has no IPC or UI, only smoke tests.
- **Handover when the window fills: SHIPPED** (`handover.ts:45-88`, HandoverBubble).

### A5. Telemetry, hooks, usage, spend
Files: `otel.ts`, `hooks.ts`, `usage.ts`, `claude-usage.ts`, `claude-limits.ts`, `codex-usage.ts`, `codex-status.ts`, `limits.ts`, `spend.ts` (all in `src/main/`); views `Insights.tsx`, `Usage.tsx`.

- **OTLP receiver: SHIPPED.** Loopback only, token-authenticated (`otel.ts:103,170`).
  - Banks cost, tokens, lines, commits, PRs and active time, plus api_request/error/refusal logs (`:44-90`).
  - Traces are ignored and set to `none`; prompt/response content logging is pinned off (`:277,294-328`). Claude harness only.
  - `usage:events` is MAIN-ONLY.
- **Hook events requested** (`hooks.ts:154-266`):
  - Base set: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, PermissionDenied, Notification, Stop, StopFailure, PreCompact, PostCompact.
  - Gated on CLI version: InstructionsLoaded, SubagentStart/Stop, PostModelSwitch, ConfigChange, CwdChanged, DirectoryAdded, Elicitation/ElicitationResult, TaskCompleted, TeammateIdle, TaskCreated, WorktreeCreate/Remove.
  - Codex sends only OSC-9 lifecycle notifications (`sessions.ts:1222`).
- **Timeline rail: SHIPPED** (`Timeline.tsx`). Groups events by turn, with duration tiers, a tool timing table and checkpoint diff links.
- **Attention queue: SHIPPED.**
  - A "Stalled" loop fires on 6 identical consecutive failures within 5 minutes and is sent as a notification (`attention.ts:50,292`; `notify.ts:106`).
  - A no-progress stall after 10 minutes shows in the queue only (`attention.ts:328`). The `stall_minutes` setting has no writer.
- **Claude transcript token backfill: SHIPPED** (`claude-usage.ts:352`, timer at `index.ts:1134`).
- **Live limits: SHIPPED.** Claude via `claude -p "/usage"` per account (`claude-limits.ts:298`), Codex via app-server (`codex-status.ts:294`), merged in `limits.ts:120` and shown in `Usage.tsx`.
- **Burn rate: SHIPPED** (`usage.ts:197`, `Insights.tsx:1079`).
- **Spend views: SHIPPED** (`spend.ts:168-1225`). By day/surface, by project, by effort, cache rate, Admin-API reconciliation and estimate accuracy. `spend:sync` is MAIN-ONLY.
- **Budgets: SHIPPED as warnings only.** Monthly global and per-project budgets with an 80% warning and run-rate projection (`spend.ts:646,682,840`), shown as a banner. `budgetBreachesFor` (`:856`) is DEAD.

### A6. Policy, egress, secrets, data
Files: `policy.ts`, `egress.ts`, `redact.ts`, `keys.ts`, `backup.ts`, `db.ts`, `settings.ts`, `roots.ts`, `pack-consent.ts`, `mcp/registry.ts` (all in `src/main/`); `views/Settings.tsx`.

- **Trust levels: SHIPPED.** readonly, project and trusted, with a default and per-project overrides (`policy.ts:58-110`).
- **PreToolUse gate** (`policy.ts:434`):
  - Order: halt → deny; trusted → allow everything; home credential directories → ask.
  - readonly: known reads allowed, including WebFetch and WebSearch; MCP tools judged by a read-verb regex; everything else asks.
  - project: shell string rules and writes outside the project root ask (`:302-544`).
  - Unattended runs turn "ask" into "deny" (`:596`).
  - Coverage: Claude-hook sessions and headless runs only. Headless readonly also uses `plan` plus `--disallowedTools` (`headless.ts:70-110`).
- **Policy ledger: SHIPPED.** Records denies, asks and notable allows, with redacted summaries (`:701,736`). You can list it, see a summary, and export it as JSONL (`:796-842`).
- **Egress report: SHIPPED** (`egress.ts:499`). Lists hosts, OTEL pins, data paths, and caveats about traffic it cannot enumerate.
- **Other:**
  - Credential redactor at `redact.ts:21`.
  - API keys stored with safeStorage (`keys.ts`).
  - MCP stdio trust digest (`mcp/registry.ts:180`).
  - Provider-pack digest dialogs (`pack-consent.ts:148,223`).
  - Root confinement for paths named by the renderer (`roots.ts:101`).
  - Allow-listed settings writes (`settings.ts:117`).
- **Backup/verify/restore: SHIPPED** (`backup.ts:258,421,565`).
- **Retention and deletion: SHIPPED** (details in B19).
- **SQLite schema** (`db.ts`):
  - Core: projects, runs, batches, requests, events, session_log, companion_turns, queue, uploads, worktrees, headless_rows, mcp_servers, accounts.
  - Telemetry and evidence: session_metrics, session_api_events, session_events, transcripts, transcript_fts (FTS5), session_checkpoints, claude_usage_events/files, conversation_flags.
  - Evals and review: eval_pairs, eval_scores, golden_sets, review_recipes, review_runs.
  - Governance and scheduling: budgets, policy_ledger, project_trust, schedules, schedule_runs.
  - Learning: learning_signals, knowledge_items/versions/candidates/evidence/relations/projections, knowledge_fts (FTS5), learning_experiments, artifact_metrics, session_briefings, consolidation_runs, learning_model_runs.
  - Goals: work_dockets/nodes/claims/proofs/checkpoints/model_outcomes/trace_events/node_sessions/resume_receipts, control_events, mcp_task_records, interviews.
  - Scout: improvement_scout_* (5 tables).
  - Created elsewhere: settings, attachments, model_cache.
  - Files are mode 0600 and not encrypted.

## Part B: Presence/absence checks

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | Semantic/embedding search | ABSENT | Only FTS5 bm25 (`learning/repository.ts:846`, `transcripts.ts:532,1062`). Grep `embedding\|vector\|cosine\|semantic search\|sqlite-vec\|faiss\|hnsw\|text-embedding\|voyage` matches only SVG `vectorEffect`. Runtime deps are just @anthropic-ai/sdk, better-sqlite3, node-pty. |
| 2 | Codebase index / repo map / wiki | ABSENT | Grep `tree-sitter\|ctags\|repo.?map\|codebase index\|symbol index\|deepwiki\|architecture doc\|wiki`: nothing relevant. The "Living Project Map" only groups stored knowledge by path (`Learning.tsx:2453`), and the `project-map` kind compiles to unsupported (`compilers.ts:115`). |
| 3 | LSP diagnostics | ABSENT | Grep `lsp\|language.?server\|tsserver\|publishDiagnostics\|pyright\|gopls\|rust-analyzer`: only a plugin-install warning (`Plugins.tsx:270`) and the scout's own flag `lspDiagnosticBridge: false` (`improvement-scout.ts:487`). |
| 4 | Skill test/eval, lint | PARTIAL | Lint: Skill Doctor (`learning/skills.ts:131`) runs in the Forge (`Skills.tsx:432`) and is a hard gate on install/apply (`learning-service.ts:1593,1921`). Hook-observed invocation metric (`:1830`). No trigger tests or outcome evals; the experiment registry launches nothing (`Learning.tsx:2948`). |
| 5 | Prompt library | PARTIAL | Composer "Saved prompts" stash: ⌘S, search, restore, 50 max, renderer localStorage only (`Composer.tsx:42-43,220-235,534-572`). Hardcoded batch presets (`batch/presets.ts:17`). No database-backed or variable templates. |
| 6 | MCP security | PARTIAL | stdio server config is pinned by sha256 over name/scope/command/args; any change withdraws trust (`mcp/registry.ts:180-208,356`). HTTP servers are not gated (`:92`). Grep `tool.?poison\|rug.?pull\|description hash`: none. Third-party tool definitions are never fetched or hashed; `tools/list` exists only in Wanigan's own server (`mcp/server.ts:890`). |
| 7 | Secret scanning of diffs/output | ABSENT | Grep `gitleaks\|trufflehog\|detect-secrets\|secret.?scan`: only the repo's own CI (`.github/workflows/hygiene.yml:75`). The product only redacts stored text (`redact.ts:21`); its commit and push are plain (`git.ts:629,674`). |
| 8 | Per-session egress allowlist | ABSENT | Egress is a report only (`egress.ts:484,499`). Grep `allowedDomains\|allowed_domains\|network_access\|sandbox_mode\|domain allow`: none. Only related controls: Codex `--sandbox workspace-write` for attachments (`sessions.ts:1149`) and headless readonly disallowing WebFetch/WebSearch (`headless.ts:72-77`). |
| 9 | Destructive-command guards | PARTIAL | String rules (`policy.ts:302-420`): rm/chmod on `/` or `~` is hard-denied; mutations or redirects outside the project ask; `push --force/-f/--mirror/+ref` to protected branches asks; curl\|sh and sudo ask; fork bomb and mkfs/dd are denied. Bypassed entirely at trusted (`:458`). No rule for `DROP TABLE`, `git reset --hard`, or `rm -rf` inside the project. Claude-hook sessions only. |
| 10 | Prompt-injection detection | ABSENT | Grep `prompt.?injection\|jailbreak\|ignore previous\|untrusted content`: none. Only adjacent behaviour: learning signals default to `semanticEligible` false (`learning/types.ts:103`). |
| 11 | AI authorship in git | ABSENT | Grep `co-authored-by\|git notes\|refs/notes\|agent.?trace\|git-ai\|authorship`: none. Per-turn checkpoints live only under `refs/wanigan/checkpoints/<session>` with a fixed identity (`checkpoints.ts:15-50`). |
| 12 | Trace/span waterfall | PARTIAL | Timeline groups tool calls by turn, with duration tiers and span bars scaled to the longest span (`Timeline.tsx:24-30,139-142`), plus a tool stats table (`hooks.ts:1276`). No time-offset waterfall or nested spans; OTel traces are off (`otel.ts:277,305`). |
| 13 | Terminal/session replay | PARTIAL | Grep `asciinema\|recordTerminal\|pty_log`: none. Scrollback is 512 KB in memory and dies with the process (`sessions.ts:85,2109`). Available instead: transcript reader (`Settings.tsx:5213`), event timeline, and per-turn checkpoint diffs. |
| 14 | Cost per outcome/PR/goal | PARTIAL | Reported spend per goal (`control.ts:122`, `Control.tsx:480`). Per model/task: accept %, test-pass % and total cost (`control.ts:1024`, `Control.tsx:544`), but no cost-per-accepted ratio. The PR count is collected (`otel.ts:747`) but never joined to cost. |
| 15 | Quota forecasting | PARTIAL | Provider-reported % used and reset time (`Usage.tsx`). Claude burn rate with "~N tokens by reset at this rate" (`usage.ts:197`, `Insights.tsx:1102-1103`). No time-to-exhaustion estimate. |
| 16 | Anomaly alerts | PARTIAL | Repeated identical failures raise a notified "Stalled" (`attention.ts:50,292`, `notify.ts:106`). The no-progress stall is queue-only (`attention.ts:328`). Grep `spike\|anomal\|burn.*alert`: none. |
| 17 | Budget enforcement | PARTIAL | **Hard stops:** batch per-run cap (`batch/submit.ts:47`); headless `--max-budget-usd` (Claude only, `headless.ts:307`); schedules capped at $2 (`index.ts:339`); goal autopilot requires a budget and halts when spend reaches it (`control.ts:1210,1302`); interview cap (`interview.ts:325`); learning-phrasing cap (`learning-model-assist.ts:341`). **Warnings only:** monthly project/global budgets (`spend.ts:840`; `policy.ts:662-665` says nothing refuses on breach). Interactive sessions have no cap. |
| 18 | OTLP forwarding | ABSENT | Endpoint pinned to 127.0.0.1 (`otel.ts:307`). Grep `langfuse\|honeycomb\|grafana\|datadog\|jaeger\|signoz\|forward.*otlp`: none. |
| 19 | Retention & deletion | PARTIAL | `event_retention_days` (default 30) prunes hook events and checkpoints (`queue.ts:612`, `hooks.ts:1319`). Forget transcript (`transcripts.ts:708`). Forget session deletes session_log and checkpoints only (`sessions.ts:2033`). No retention for api events, metrics, signals, knowledge, or the ledger (deliberate, `queue.ts:604`). Attachment directories are never reclaimed (`Settings.tsx:5133`). |
| 20 | Encrypted backup | PARTIAL | Backup is a VACUUM INTO copy plus transcripts and a sha256 manifest, with verify and restore (`backup.ts:258,421,565`). It is not encrypted: grep `encrypt\|cipher\|safeStorage\|passphrase` in backup.ts returns nothing. |
| 21 | Tamper-evident ledger | ABSENT | Plain AUTOINCREMENT table, append-only by convention only (`db.ts:437-450`, `policy.ts:730`). Grep `CREATE TRIGGER\|prev_hash\|hash_chain\|merkle`: none. |
| 22 | Cross-machine/team knowledge | PARTIAL | Project projections write git-trackable CLAUDE.md, `.claude/*`, AGENTS.md and `.agents/skills`, never committed (`compilers.ts:134-222`). Ledger JSONL export (`policy.ts:811`); whole-database backup. Grep `exportKnowledge\|importKnowledge\|knowledge.*export`: none. `rebuildKnowledgeFts` (`repository.ts:887`) has no caller. |
| 23 | Compaction visibility / utilisation | PARTIAL | PreCompact/PostCompact are requested (`hooks.ts:157`) and shown in the Timeline (`Timeline.tsx:645`). Per-session utilisation % for Claude (`transcripts.ts:924`). Nothing records the trigger, before/after tokens, or what was dropped. No Codex context meter. |
| 24 | Context handover | PRESENT | Offered at ≥85% of the window, dropping away below 78% (`shared/context-handover.ts:25-26`). Wanigan types the handover prompt into the session, reads the last assistant turn from the transcript, and launches a new session with the same provider/project/account/model; the old session is left alone (`handover.ts:45-88`). Claude only. |
| 25 | Productivity measurement | PARTIAL | Accept and test-pass rates per model (`control.ts:1024`). Per-session lines added/removed, commits and PRs (`otel.ts:742-747`, `Fleet.tsx:326,734`). Grep `dora\|lead time\|deployment frequency\|change failure\|churn\|rework`: none. |
