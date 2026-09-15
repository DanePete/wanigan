# W6: Context, memory, code intelligence, coordination, protocols (as of 2026-09-14)

Labels: **[V]** primary page fetched this session. **[S]** second-hand, or a primary page seen only as a search snippet. **[B]** not verified. **Inference** marks my own reasoning. I made 54 search/fetch calls.

## 1. Memory systems

**Claude Code auto memory** [V] code.claude.com/docs/en/memory
- **Storage:** `~/.claude/projects/<project>/memory/`, one per git repo, shared by its worktrees. `autoMemoryDirectory` relocates it. Holds a `MEMORY.md` index plus one topic file per memory.
- **What gets saved:** frontmatter `type` is `user`, `feedback`, `project` or `reference`. Claude skips anything derivable from the code or already in CLAUDE.md.
- **Loading:** the first 200 lines or 25KB of `MEMORY.md`, whichever comes first. Topic files load on demand. A write over the limit succeeds but returns an error telling Claude to rewrite the index.
- **Timestamps:** since v2.1.214, each write stamps a `modified` ISO-8601 field, only in files that already have frontmatter.
- **Retention and controls:** exempt from the `cleanupPeriodDays` sweep. On by default; `autoMemoryEnabled` or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` turn it off. Subagents don't get it (forks do); a subagent's `memory` field gives it its own directory.
- **Facts for the Context view:**
  - A CLAUDE.md over 4 MiB is skipped, and block HTML comments are stripped before injection.
  - `claudeMdExcludes` excludes files.
  - The `InstructionsLoaded` hook logs which files loaded and why.
  - `/import` (v2.1.213+) appends a one-time copy of AGENTS.md into CLAUDE.md.
  - Imports go four hops deep and are skipped inside code spans.
  - `/doctor` proposes CLAUDE.md trims (v2.1.206+).
  - A `paths` brace-expansion list is capped at 1,000 patterns.
  - `CLAUDE_CODE_PROJECT_DIR_NAME` (v2.1.234+) fixes the project directory name.

**Codex Memories** [V] learn.chatgpt.com/docs/customization/memories
- **Generation:** background job after a chat goes idle; skips short or active chats; redacts secrets. Extraction and consolidation models are configurable.
- **Storage:** `~/.codex/memories/`, which respects `CODEX_HOME`. Holds summaries, durable entries, recent inputs and evidence. OpenAI calls it "generated state", not for hand editing.
- **Config:** `[features] memories`, `memories.generate_memories`, `memories.use_memories`, `memories.disable_on_external_context`, `memories.min_rate_limit_remaining_percent`. Off by default; `/memories` toggles it per chat.
- **Gaps:** retention, deletion and audit are not documented.
- **Chronicle** (macOS screen history turned into memories): captures deleted after 6h [S].

**GitHub Copilot Memory** [V] github.blog, 2026-01-15
- **Mechanism:** the agent stores a memory through a tool call: subject, fact, citations to code locations, and reasoning. Before use it re-checks the citations against the current branch. A contradiction produces a corrected memory; a memory that checks out is stored again with a new timestamp.
- **Evidence (vendor A/B):** coding-agent PR merge rate 90% with memory vs 83% without; positive review feedback 77% vs 75%; p<0.00001.
- **Expiry:** deleted after 28 days unused; the timer can reset on validated use [S, docs snippet].
- **Timeline:** public preview 2026-01-15 [V]; on by default for Pro/Pro+ 2026-03-04 [S]; repo admin off switch and CLI `/memory on|off|show` 2026-05-26 [V]; JetBrains 2026-08-11 [S].
- **Scope:** each entry is a user-level preference or a repo-level fact. Repo facts can only be created by contributors with write access, and are used only on that repo.
- **More evidence:** code-review precision +3%, recall +4%.

**Other tools**
- **Cursor:** Memories removed in 2.1.x in favour of Rules [S].
- **Windsurf and Devin:** Windsurf became "Devin Desktop" on 2026-06-02, and Cascade was deprecated on 2026-07-01 [S, blogs]. Devin Knowledge entries are org-level, pinned per repo, retrieved when relevant [S].
- **Letta Context Repositories** [V] 2026-02-12:
  - Memory is local files. Files in `system/` are always loaded; the rest are disclosed through frontmatter descriptions.
  - Background reflection writes memory; defragmentation reorganizes it into 15–25 files.
  - It is git-versioned with commit messages. Subagents work in separate worktrees and merge back through git.
  - Letta Code was #1 among open-source agents on Terminal-Bench at 42.5% [S].
- **mem0 report** [V page; vendor self-reported]: Mem0 LoCoMo 92.5 at 6,956 tokens/query, LongMemEval 94.4. Competitors as quoted: Zep 80.32, Letta 74.0, OpenAI 52.9. No independent replication.
- **Graphiti:** bi-temporal facts; superseded facts invalidated, not deleted [S].
- **Basic Memory:** local Markdown files indexed in SQLite, served over MCP [S].

**Evaluations**
- **SWE-ContextBench** (arXiv 2602.08316, v3 2026-05-06) [V]:
  - 1,476 tasks across 51 repos.
  - Well-summarized prior experience raises resolution and cuts tokens.
  - "Unfiltered or incorrectly selected context provides limited or negative benefits."

## 2. Code intelligence

- **Claude Code LSP** [V] plugins-reference
  - `.lsp.json` requires `command` and `extensionToLanguage`.
  - `diagnostics` (default true) pushes diagnostics into context after edits; `restartOnCrash` and `maxRestarts` handle crashes.
  - Official plugins: pyright, typescript and rust-analyzer. The server binary must already be installed; otherwise the `/plugin` Errors tab shows "Executable not found in $PATH".
  - The LSP tool arrived in v2.0.74 [S].
- **Plugin monitors** (experimental) [V]: background commands whose stdout lines become notifications.
- **Augment Context Engine MCP** [V vendor, 2026-02-06]
  - Runs locally through the Auggie CLI (index stays local) or hosted (code uploaded).
  - Benchmark: 900 attempts on 300 Elasticsearch PRs. Claude Code +80%, Cursor/Opus +71%, Cursor/Composer +30%.
  - Grader unspecified; no replication.
- **Cursor semantic search** [S; cursor.com/blog/semsearch snippet]
  - +12.5% accuracy answering codebase questions (6.5–23.5% depending on model).
  - Online A/B: code retention +0.3%, and +2.6% in repos of 1,000+ files.
- **Claude Context (Zilliz):** about 40% fewer tokens at equal recall [S vendor]. **Serena** claims 60–80% [S anecdotal]; I found no controlled study.
- **Codebase wikis** [S]: Google Code Wiki (preview Nov 2025); Windsurf Codemaps; DeepWiki MCP (free; `ask_question`, `read_wiki_structure`, `read_wiki_contents`).

## 3. Context window management

**Claude Code compaction** [V] code.claude.com/docs/en/context-window
- **Reloaded from disk:** project-root CLAUDE.md, unscoped rules, auto memory, and the plan-mode plan.
- **Reloaded on demand:** path rules and nested CLAUDE.md files return when a matching file is read.
- **Files:** up to 5 of the most recently modified files are re-read. A file over 5,000 tokens comes back as a path only.
- **Skills:** invoked skill bodies are re-injected, capped at 5,000 tokens each and 25,000 in total. The skill listing is not re-injected.
- **Hooks:** earlier hook context is summarized away. **SessionStart hooks matching `compact` run again, and their output enters the compacted context.**
- **Subagents** return only final text plus a trailer with token counts and duration.
- **MCP schemas** are deferred by default (`ENABLE_TOOL_SEARCH`).

**Auto-compact thresholds** [V] model-config
- Models with a native 1M window compact at about 967K tokens by default; 200K configurations at 200K.
- `/autocompact 500k` saves `autoCompactWindow`, and `--autocompact` overrides it for one launch.
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` wins over both (accepted range 100K–1M).
- `CLAUDE_CODE_MAX_CONTEXT_TOKENS` corrects the window for gateway model IDs.
- "Microcompaction" was not on the pages I fetched [B].

**Claude API** [V] context-editing doc
- **Beta header:** `context-management-2025-06-27`.
- **`clear_tool_uses_20250919`:** trigger defaults to 100K tokens and keeps 3 tool uses; also `clear_at_least`, `exclude_tools` and `clear_tool_inputs`. `count_tokens` returns the count before and after editing.
- **Other strategies:** `clear_thinking_20251015`, and server-side compaction `compact_20260112`.
- **Reporting:** responses list `applied_edits` with cleared counts and tokens. The memory tool `memory_20250818` runs client-side.

**Context rot**
- **Chroma** [V] 2025-07-14: all 18 models degrade as input grows, even on simple tasks. Distractors and low similarity between question and answer make it worse, and shuffled haystacks beat coherent ones. Focused ~300-token vs full ~113K-token LongMemEval prompts show a large gap.
- **arXiv 2606.29718** (2026-06-29) [V]: models give up early more often as context grows, at the same difficulty. Behavior-aware parallel sampling adds +2.6–4.9%.
- **"Classifier Context Rot"** (arXiv 2605.12366): LLM monitors degrade with context length [S, title only].
- **Handoffs:** Amp `/handoff` starts a new thread from an editable prompt [S].

## 4. Skills and instruction standards

- **Agent Skills** [V] agentskills.io
  - Developed by Anthropic and released as an open standard.
  - `SKILL.md` needs at least `name` and `description`; optional `scripts/`, `references/`, `assets/`.
  - Loading has three stages: discovery, activation, execution.
  - About 40 listed clients, including Claude Code, Codex, Copilot, VS Code, Cursor, Gemini CLI, OpenCode, Goose, Amp, Letta, Factory, Junie, Kiro, Roo Code, OpenHands and Mistral Vibe.
- **AGENTS.md:** used by 60,000+ projects [S]. Contributed to the Linux Foundation's Agentic AI Foundation (announced 2025-12-09) with MCP and goose [S].
- **Claude Code and AGENTS.md** [V]: Claude Code reads CLAUDE.md only; the docs recommend an `@AGENTS.md` import or a symlink.
- **`claude plugin eval`** [V] (v2.1.269+)
  - Cases are prompts with graders (`regex`, `tool_used`, `tool_order`, `file_exists`, `llm`, `baseline`).
  - Three runs per case by default. `--ablation with-without` gives WITH, W/OUT and Δ.
  - Sandboxed; personal CLAUDE.md, memory and other plugins don't load.
  - `--json` writes `aggregate-result.json` (`schemaVersion: 1`) with `costUsd` (a list-price estimate), `partial` and `skippedPaidGraders`.
  - Exit code 2 means partial (the cost ceiling was hit).
- `/skill-doctor` and skill registries: [B].

## 5. Multi-agent coordination

**Claude Code agent teams** [V] (v2.1.178+)
- **Status:** experimental (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), interactive sessions only.
- **On-disk state:**
  - Mailboxes: `~/.claude/teams/{team}/inboxes/{agent}.json`.
  - Team config: `config.json` with a `members` array; deleted at session end.
  - Tasks: `~/.claude/tasks/{team}/`, which persist.
  - Team name: `session-` plus the first 8 characters of the session ID.
- **Tasks** have dependencies, and **claims use file locking.**
- **Hooks:** `TeammateIdle`, `TaskCreated`, `TaskCompleted`; exit code 2 blocks.
- **Permissions:** teammate prompts appear in the lead's session, and the lead auto-approves teammate plans. Messages from other agents are marked as not coming from the user, and approvals they relay are untrusted. Not available with `-p` or the SDK.
- **Guidance:** 3–5 teammates. Same-file edits "lead to overwrites." No nested teams, and in-process teammates don't survive a resume.

**Other harnesses**
- **Codex:** `[agents] max_threads` (default 6) and `max_depth` (default 1) [S]. `SubagentStart` and `SubagentStop` hooks exist [V].
- **Amp:** isolated subagents; Oracle gives second opinions; Librarian searches other repos and docs [S].

**Evidence on when multi-agent helps**
- **Cognition, "Multi-Agents: What's Actually Working"** (2026-04-22) [V]:
  - Works "when writes stay single-threaded and the additional agents contribute intelligence rather than actions."
  - Clean-context reviewers work best; Devin Review finds about 2 bugs per PR, ~58% severe (vendor).
  - "Smart friend" advisors work only when both models are frontier; SWE-1.5 as primary could not tell when to escalate.
  - Parallel-writer swarms lack adoption. The open problems are all communication.
- **Scaling-agents paper** (arXiv 2512.08296) [S]:
  - 180 configurations tested.
  - Multi-agent variants scored 39–70% worse on sequential planning; centralized coordination scored +80.8% on decomposable tasks.
  - Independent agents amplified errors 17.2×, centralized ones 4.4×. Its framework predicted the best architecture for 87% of held-out configurations.
- **MAST** (arXiv 2503.13657) [S]: 14 failure modes in 3 categories, from 1,600+ traces.
- **Gap:** I found no cross-harness file-claim standard [B].

## 6. Interop protocols

**ACP (Agent Client Protocol)** [V] agentclientprotocol.com
- **Transport:** local agents run as client subprocesses speaking JSON-RPC over stdio. Remote support over HTTP or WebSocket is "a work in progress."
- **Agent methods:** `initialize`, `session/new`, `session/prompt`, `session/load`, `session/cancel`.
- **Client methods:** `session/request_permission`, `fs/*`, `terminal/*`.
- **`session/update` variants:** `plan`, `agent_message_chunk`, `tool_call`, `tool_call_update`, `usage_update`, plus mode and command updates.
- **Tool calls:** a `kind` and a `status` (pending, in_progress, completed, failed). Content can be a `diff` (`path`, `oldText`, `newText`) or a `terminal`.
- **Permissions:** options are `allow_once`, `allow_always`, `reject_once`, `reject_always`.
- **Stop reasons:** `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`.
- **More fields:** tool calls also carry `locations` (path, line), `rawInput` and `rawOutput`. A permission outcome is `selected` with an `optionId`, or `cancelled`. ACP reuses MCP's JSON types where it can.
- **Agents:** 37 native, including Gemini CLI, GitHub Copilot (preview 2026-01-28), Cursor, Goose, OpenCode, Cline, Factory Droid, Junie, Kiro, Kimi, Qwen Code, Mistral Vibe, OpenHands and Augment. Three through adapters: Claude Agent (`claude-agent-acp`), Codex (`codex-acp`) and Pi.
- **PTY viability** (Inference):
  - ACP is not a side channel on a running TUI; the client launches the agent in ACP mode and draws the whole interface.
  - Viable as a separate launch type, not as extra data on a PTY session.
  - Each agent's `usage_update` and `plan` output must be checked before Wanigan claims metering or plans.

**MCP 2026-07-28** [V] blog.modelcontextprotocol.io
- **Stateless core:** `initialize` and `Mcp-Session-Id` retired; capabilities travel in `_meta`; `server/discover` is optional.
- **MRTR (multi round-trip requests):** servers return `input_required` and clients retry with `inputResponses`. This replaces server-initiated elicitation and sampling.
- **HTTP headers:** Streamable HTTP requires `Mcp-Method` and `Mcp-Name`.
- **Notifications and caching:** notifications arrive on `subscriptions/listen`; list and read results carry `ttlMs` and `cacheScope`.
- **Extensions:** `io.modelcontextprotocol/tasks` (`tasks/get` polling, new `tasks/update`), MCP Apps, and Enterprise Managed Authorization.
- **Deprecations:** Roots, Sampling and Logging (at least 12 months), plus legacy HTTP+SSE. DCR is deprecated in favour of CIMD.
- **SDKs:** TypeScript, Python, Go and C#; Rust in beta.

**Other protocols**
- **A2A:** a Linux Foundation project with 150+ organizations [S]; built for remote agents.
- **AG-UI:** an event protocol from agent backend to web frontend [S vendor]; not for CLIs.
- **OpenTelemetry GenAI:** conventions moved to `semantic-conventions-genai` [V]; still "Development" [S].

**Codex hooks** [V] learn.chatgpt.com/docs/hooks
- **Status:** stable; `[features] hooks` controls it (`codex_hooks` is a deprecated alias). Configured in `hooks.json` or `config.toml`, at user or repo level. Handlers are `command` or `mcp_tool`. First shipped in v0.114, March 2026 [S].
- **Events:** SessionStart and End, SubagentStart and Stop, PreToolUse, PermissionRequest, PostToolUse, PreCompact and PostCompact, UserPromptSubmit, Stop, Interrupt.
- **Payload:** `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `turn_id`, `permission_mode`.

---

## Top 12 capabilities a local-first control surface should consider

1. **Codex hooks for observed status.**
   - **Why:** twelve events cover session start and end, permissions, subagents, compaction and stop. That moves Codex status from inferred to observed, using the same evidence model Wanigan already uses for Claude.
   - **Feasibility:** high, with one open question. I have not verified how to inject hooks without writing to `~/.codex` or the repo. Setting `CODEX_HOME` also moves memories [V]; whether it moves auth too is [B].
   - **Evidence:** [V] strong.
2. **Compaction metering, and keeping the briefing through compaction.**
   - **Why:** each session's compaction window is knowable (~967K on 1M models; env > flag > setting), and compaction events are observable (Claude SessionStart `compact`; Codex PreCompact/PostCompact).
   - Wanigan can re-inject its briefing through SessionStart `compact`, and model the survival rules (5 files; 5K/25K skill caps).
   - **Feasibility:** high. **Evidence:** [V].
3. **ACP structured-session launch mode, for packs that declare it.**
   - **Why:** 37 native agents would give real plan, tool-call, diff, permission, stop and usage events without screen-scraping.
   - **Feasibility:** medium. It needs a second renderer, cannot attach to a PTY, and remote support is unfinished.
   - **Evidence:** spec [V]; what each agent actually emits [B].
4. **Memory freshness: last validated, last used, expiry proposals through review.**
   - **Why:** Copilot's citation checks plus 28-day expiry came with +7 points of merge rate, and SWE-ContextBench shows wrong context helps little or hurts.
   - Stale items should go to the review inbox, not be silently deleted.
   - **Feasibility:** high. **Evidence:** vendor A/B [V] plus academic [V].
5. **Read-only inspector for provider memory.**
   - **What:** Claude's `type` and `modified` fields and what overflows the 200-line/25KB prefix; Codex's `~/.codex/memories` and flags. Copilot memory is cloud-only, so the honest state is "not local."
   - **Feasibility:** high. **Evidence:** [V].
6. **Checking what actually loaded.**
   - **Why:** the `InstructionsLoaded` hook checks the modelled import chain against reality.
   - Also strip HTML comments when sizing, flag the 4 MiB skip, and detect `/import` copies of AGENTS.md (the drift this repo warns about).
   - **Feasibility:** high. **Evidence:** [V].
7. **Ledger of teams and subagents.**
   - **What:** read `~/.claude/teams/*` (members, inbox traffic) and `~/.claude/tasks/*` (claims, dependencies), plus the TaskCreated/TaskCompleted/TeammateIdle and Codex SubagentStart/Stop hooks.
   - **Feasibility:** medium-high; the formats are experimental, so read-only. **Evidence:** [V].
8. **Single-writer conflict warning.**
   - **Why:** two live sessions editing the same file or worktree lose work, so flag it and suggest worktrees. Claude's docs say such edits overwrite, Cognition says keep writes single-threaded, and the scaling paper found sequential tasks degrade and errors amplify.
   - **Feasibility:** high, from PostToolUse paths plus git. **Evidence:** [V] and [S].
9. **Skill eval results as evidence.**
   - **What:** read `aggregate-result.json` for per-case WITH, W/OUT and Δ, `partial`, `skippedPaidGraders`, and cost labelled as an estimate. It could gate learned skills in review.
   - Runs must be started by the user (they cost tokens), and results shown per case, never as a composite score.
   - **Feasibility:** medium. **Evidence:** [V].
10. **Readiness for MCP 2026-07-28 in Wanigan's MCP host and server.**
    - **What:** stateless `_meta`, `server/discover`, MRTR, `subscriptions/listen`, and Tasks for long-running operations.
    - **Avoid:** building anything new on the deprecated Sampling or Roots.
    - **Feasibility:** medium. **Evidence:** [V].
11. **Code-intelligence readiness panel.**
    - **What:** whether LSP plugins are present and healthy (binary on PATH, diagnostics on or off), and whether each semantic index keeps data local or uploads it.
    - **Caveat:** benefit figures are vendor claims only (Augment +30–80%, Cursor +12.5%).
    - **Feasibility:** high for status. **Evidence:** mechanism [V]; effect vendor or [S].
12. **Clean-context handover and review.**
    - **What:** prefer fresh sessions with editable handoffs, and clean-context reviewers, over long compaction chains. Show context-rot facts (tokens in use, number of compactions), never a health score.
    - **Feasibility:** high; the handover flow already exists. **Evidence:** Chroma [V], arXiv 2606.29718 [V], Cognition [V vendor].

Later: OTel GenAI export, once its schema leaves "Development."

## Things I could not verify

- **Skills:** `/skill-doctor`; registries; Agent Skills field limits.
- **Claude:** "microcompaction"; the published gains for the Claude memory tool.
- **MCP:** the 2025-06-18 and 2025-11-25 releases; registry status.
- **Cursor:** parallel agents; the primary source for Memories' removal.
- **Windsurf and Devin:** the rename dates; Windsurf memories; Devin playbooks.
- **Code tools:** Aider repo map, OpenCode and Crush LSP, Codanna, Serena measurements.
- **Codex:** subagent defaults; the app-server protocol; hook injection without writing files.
- **ACP:** adapter internals; which agents emit `usage_update` or `plan`.
- **Other protocols:** A2A versions; AG-UI events; OTel stability status.
- **Snippet-only figures:** the scaling paper, MAST, the Copilot 28-day expiry, Cursor semantic search.
