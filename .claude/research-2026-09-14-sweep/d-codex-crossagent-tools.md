# Slice D: third-party Codex helpers and cross-agent tools (Jun to 14 Sep 2026)

Researcher D. Written 14 Sep 2026.

**Labels.** [V] means I read it this session on the primary README, repo source, protocol file or project page. [S] means second-hand (a search-result description or another tool's README). [B] means blocked or not fetched.

**Metadata.** Star counts, last push and latest release all come from `gh api repos/<r>` and `releases/latest`, read 14 Sep 2026. The raw table is in `d-meta.tsv` next to this file. The READMEs I read are in `d-readmes/`.

**Coverage.** I surveyed 70 repos (62 READMEs read, plus source files for codex-plugin-cc and the openai/codex app-server protocol). Sources were:
- GitHub search (15+ queries)
- Show HN through the Algolia API, for `codex`, `claude code`, `agents.md`, `coding agents`, `gemini cli` and `opencode`, from Jul 2026 on
- RoggeOhta/awesome-codex-cli
- The nimbalyst.com session-manager roundup (it lists ADEs only, so none of it is used below)

I did not search r/codex or Product Hunt.

**Checks against the Wanigan source.** I grepped the `wanigan-gaps` worktree to avoid reporting things it already does:
- `src/main/context/instructions.ts` checks whether AGENTS.md reaches *Claude*. It does not model Codex's AGENTS.md loader or its byte budget.
- `src/main/skills.ts` predicts `disable-model-invocation` for Claude. It does not read Codex's `agents/openai.yaml` `policy.allow_implicit_invocation`.
- There are no hits for `worktreeinclude`, `review/start`, `externalAgentConfig`, `thread/search` or `refs/notes`.

---

## (1) Capability items: new

### 1. Move a conversation from Claude Code into Codex with Codex's own session importer
**Tools**
- **openai/codex-plugin-cc**: https://github.com/openai/codex-plugin-cc. 33,154★, v1.0.6 (2026-07-08). [V README + source `plugins/codex/scripts/lib/codex.mjs`, `claude-session-transfer.mjs`]
- **openai/codex app-server protocol**: https://github.com/openai/codex, `codex-rs/app-server-protocol`. [V `common.rs`, `ExternalAgentConfig*.ts`]
- **yigitkonur/cli-continues**: https://github.com/yigitkonur/cli-continues. 1,505★, last push 2026-05-07, just outside the window. [V] Any-to-any handoff across 16 tools.
- **ww-w-ai/super-token-saver**: https://github.com/ww-w-ai/super-token-saver. 31★, v3.6.1 (2026-09-07). [V]
- **yazcaleb/rses**: https://github.com/yazcaleb/rses. 10★, 2026-03-26, outside the window. [V]

**Mechanism**
- `/codex:transfer` opens a direct app-server and sends `externalAgentConfig/import` with `migrationItems: [{itemType:"SESSIONS", cwd:null, details:{sessions:[{path, cwd, title:null}], plugins:[], mcpServers:[], hooks:[], subagents:[], commands:[]}}]`.
- It then waits for the `externalAgentConfig/import/completed` notification, with a 2-minute timeout.
- It reads the new thread id from `$CODEX_HOME/external_agent_session_imports.json`. That ledger keys records by `source_path` plus `content_sha256` and stores `imported_thread_id`.
- The source must realpath under `~/.claude/projects`. On an older Codex the call fails with RPC `-32601`, which the plugin reports as "upgrade Codex".
- The result is a normal Codex thread with visible turns, which `codex resume <id>` opens. [V source]
- There is also a detect call, `externalAgentConfig/detect {includeHome, cwds, maxSessionAgeDays, maxSessions}`. The item type enum is `AGENTS_MD | CONFIG | SKILLS | PLUGINS | MCP_SERVER_CONFIG | SUBAGENTS | HOOKS | COMMANDS | MEMORY | SESSIONS`. [V protocol]

**Alternatives when no importer exists**
- rses and continues build a handoff prompt instead: the original task, `git log` since the session started, working-tree status, the last N turns, and a pointer to the source file so the receiving agent can read the full history. [V]
- super-token-saver rewrites a Codex rollout into Claude's transcript shape line for line, keeping `L{n}` markers back to the original line. It keys sessions on `payload.id` because a spawned subagent inherits the thread's `session_id`. [V]

**Why it matters.** Wanigan holds both transcripts and already hands off Codex between accounts. When one vendor's window is spent mid-task, the natural operator move is "continue this in the other harness". The native importer produces a real, resumable Codex thread rather than a pasted summary.
- Use only the `SESSIONS` item, and only on an explicit user action.
- Refuse the `CONFIG`, `MCP_SERVER_CONFIG`, `HOOKS`, `SUBAGENTS`, `COMMANDS` and `MEMORY` items. Those would make Claude's artifacts Codex's input, and the repo-scoped ones write config.

**Effort** M. **Non-local:** none. The import is local; tokens are spent only when the thread resumes.

### 2. A second vendor reviews a session's diff or plan, with structured findings the operator adjudicates
**Tools**
- **Codex app-server `review/start`**: [V `ReviewStartParams.ts`, `ReviewTarget.ts`]
- **openai/codex-plugin-cc** `/codex:review` and `/codex:adversarial-review`. [V]
- **ledger-rocket/rocket-review**: https://github.com/ledger-rocket/rocket-review. 1★, v0.4.1 (2026-09-10). [V]
- **vasilievyakov/claude-codex-bridge**: https://github.com/vasilievyakov/claude-codex-bridge. 0★, v0.1.0 (2026-09-14). [V]
- **0xNyk/council-of-high-intelligence**: https://github.com/0xNyk/council-of-high-intelligence. 4,236★, v1.2.0 (2026-07-04). [V] This is persona deliberation that preserves dissent; it is not cross-model.

**Mechanism**
- **Codex native review.** `review/start {threadId, target, delivery}`. The target is `uncommittedChanges`, `baseBranch {branch}`, `commit {sha, title}` or `custom {instructions}`. `delivery: "detached"` is deprecated; start a new thread and review inline instead. [V]
- **Plugin adversarial review.** Output follows `review-output.schema.json`: `verdict: approve|needs-attention`, `summary`, `findings[{severity: critical|high|medium|low, title, body, file, line_start, line_end, confidence, recommendation}]`, `next_steps`. [V]
- **Plugin review gate.** An optional Stop-hook gate blocks Claude's stop when Codex finds issues. The plugin itself warns this can loop and drain usage limits. [V]
- **rocket-review.**
  - `rr --diff`, `rr plan.md` (plans are reviewable too).
  - `--backend codex,claude` fans out to both vendors and shows where they disagree.
  - `--docs` auto-discovers AGENTS.md or CLAUDE.md so findings cite the repo's own rules.
  - `--json --fail-on high` exits 2.
  - It posts nothing anywhere. [V]
- **claude-codex-bridge.**
  - Exchange is file-based and Codex runs in a read-only sandbox.
  - The author model re-checks every finding against the code and marks it Confirmed, Refuted, Out of scope or Uncertain.
  - Worker patches are never auto-applied.
  - Exit codes: 2 bad args, 3 answer outside the format, 4 worktree exists, 124 timeout. [V]

**Why it matters.** Wanigan has a Batches LLM judge and review notes that flow back to a session. It has no "have the other vendor review what this session did before I read it". The findings (file, line range, severity, verdict column) map directly onto review notes, and a person still decides.
- Content crosses vendors, so each run needs explicit per-run consent, the target backend's own profile, and metering from the recorded run.
- It must never be an automatic Stop gate.

**Effort** M.

### 3. Session anatomy: time spent orienting vs implementing, activity buckets, peak context, compactions, time waiting on the user
**Tools**
- **dosu-ai/decant**: https://github.com/dosu-ai/decant. 59★, v0.5.2 (2026-09-09). [V README + `docs/analytics-methodology.md`]
- **jazzyalex/agent-sessions** (Session Info): https://github.com/jazzyalex/agent-sessions. 862★, v5.3 (2026-09-15). [V]
- **graykode/abtop** (per-session context % bars): https://github.com/graykode/abtop. 3,553★, v0.5.5 (2026-09-14). [V]

**Mechanism (decant)**
- **Activity buckets.**
  - *context*: reads, searches, read-only shell and git commands; unknown tools default here.
  - *planning*: thinking blocks and plan tools.
  - *code*: edits and mutating shell commands.
  - *communicating*: visible text.
- **Phases.** *Orientation* is everything before the first detected file edit. Shell edits count only for high-confidence patterns such as `git apply` and `sed -i`.
- **Active time.** The gap between messages is charged to the later message and capped at 5 minutes. Gaps closed by user text are reported separately as `waiting_on_user_ms`.
- **Context occupancy** per call is `input + cache_read + cache_creation`. The session reports its peak. Codex logs carry the model window explicitly; for Claude and Gemini the window is inferred and marked inferred.
- **Compactions** come from provider boundary records, and missing pre/post counts stay unavailable.
- **Diagnostics.** `unparsed_line` counts as data loss; other notices are format-drift sensors.

agent-sessions adds a history of model and reasoning-effort changes that jumps to the point in the transcript where each change happened. [V]

**Why it matters.** A reviewer triaging many sessions wants "this one spent 80% of its time orienting and hit 91% peak context before compacting". The observed vs inferred labelling already matches Wanigan's estimate grammar. Show separate facts, not a composite score.

**Effort** M.

### 4. Usage ingestion for the harnesses provider packs launch, read from each harness's local store
**Tools**
- **junhoyeo/tokscale**: https://github.com/junhoyeo/tokscale. 5,434★, v4.16.0 (2026-09-12). [V]
- **ccusage/ccusage**: https://github.com/ccusage/ccusage. 18,553★, v20.0.20 (2026-08-15). [V] Supports `ccusage codex daily` plus 17 more harnesses.
- **Piebald-AI/splitrail**: https://github.com/Piebald-AI/splitrail. 223★, v3.9.1 (2026-09-06). [V] Real-time tracking and a `splitrail mcp` server.

**Mechanism.** tokscale's README is a verified path registry for about 50 harnesses. Examples:
- Gemini: `$GEMINI_CLI_HOME/tmp/*/chats/*.json`
- OpenCode: `~/.local/share/opencode/opencode.db`
- Amp: `~/.local/share/amp/threads/`
- Qwen: `~/.qwen/projects/`
- Goose: `~/.local/share/goose/sessions/sessions.db`
- Pi: `~/.pi/agent/sessions/`
- Droid: `~/.factory/sessions/`
- Kiro: `~/.local/share/kiro-cli/data.sqlite3`
- Zed: `threads.db`
- Devin CLI: `sessions.db`
- Sakana via Codex: `model_provider: sakana`

Other tokscale mechanisms:
- `--group-by workspace,model --merge-worktrees` folds worktrees into their repo.
- `session,model` attributes cost to one CLI session.
- Pricing comes from LiteLLM, with cache discounts.
- For a harness that does not persist usage, it captures headless runs (`mcode exec --output-format stream-json`). [V]

**Why it matters.** Wanigan launches any CLI through a provider pack, but its spend views are Claude and Codex only. A pack manifest could declare a usage-store adapter (validated in the main process, read-only) so pack sessions get observed token counts instead of nothing.

**Effort** M per adapter family (JSONL, SQLite). **Non-local:** tokscale `submit`, viberank and tokenmaxxing leaderboards, and splitrail cloud upload (`auto_upload=false` by default) are all rejected.

### 5. Which live session is burning the quota window, and whether scheduled work may start
**Tools**
- **jazzyalex/agent-sessions** Quota Meter. [V]
- **Adashuai5/quota-autopilot**: https://github.com/Adashuai5/quota-autopilot. 0★, v0.2.0 (2026-07-21). [V]
- **bobby33400/Lea**: https://github.com/bobby33400/Lea. 10★, 2026-07-20. [V] Runs its queue the moment a ccusage block resets.

**Mechanism**
- **Agent Sessions.** Shows per-active-session burn against the 5-hour and weekly windows. Views: 5-hour, weekly, tokens/hour, and API-equivalent $/hour, the last labelled an estimate. States are explicitly "unavailable" when a provider exposes no usable limit. [V]
- **quota-autopilot admission.** Wake on an interval, then:
  1. Check session health and whether the owner was recently active.
  2. Read local quota and reset windows (Codex through a verified app-server session).
  3. Keep a reserve and pace usage.
  4. Run exactly one reviewable task.
  5. Fail closed when metadata is `UNKNOWN`.
- **quota-autopilot `sessions health`** flags subagent fan-out, token density, active-context pressure, long sessions and abnormal quota decline within one window. It deserialises only `session_meta` and `token_count` records, dedupes inherited child token events, and drops expired rate-limit snapshots. [V]

**Why it matters.** Wanigan has schedules and reads Codex limits. It lacks attribution ("session X ate 40% of this week") and a human-first admission rule (skip scheduled work if the operator typed in the last N minutes or the reserve would fall below Y). An abnormal quota slope is also a good attention reason code.

**Effort** S–M.

### 6. Tests that catch transcript-format changes when a CLI updates
**Tools**
- **jazzyalex/agent-sessions** `STEWARDS.md` plus Session-Bench v0.4: https://jazzyalex.github.io/agent-sessions/bench/. [V page]
- **dosu-ai/decant** ingest diagnostics. [V]
- **PixelPaw-Labs/codex-trace**: https://github.com/PixelPaw-Labs/codex-trace. 104★, v0.4.0 (2026-06-28). [V] Handles new (≥0.44), mid and oldest rollout formats.

**Mechanism**
- Session-Bench has 20 pass/fail gates across Signal, Complete, Stable, Open and Tooling. A measurement that could not be taken is "not run" and leaves the denominator. Tested versions are recorded (Claude Code 2.1.220, Codex 0.146.0, OpenCode 1.18.11, …).
- Its vendor report card lists what each format would need to change. For Codex: lean session, no fixed-cost dumps, dollar cost recorded, declares a format version, documented schema, naive-reader safe.
- A steward per agent re-runs one redacting check command two or three times a year. [V]
- Ignore the composite leaderboard; the gates are the useful part.

**Why it matters.** Wanigan's exact Codex UUID recovery, spend views and archive all parse formats that vendors change without notice. The memory note on CLI output parsers records a zero-case bug already. A gate keyed to the installed CLI version could put "reader unverified for codex 0.15x" in the attention queue instead of silently mis-parsing.

**Effort** S.

### 7. Line-level attribution: which session and model wrote which lines, and how many survived
**Tools**
- **git-ai-project/git-ai**: https://github.com/git-ai-project/git-ai. 2,718★, v1.7.5 (2026-09-09). [V README + `specs/git_ai_standard_v3.0.0.md`]
- **re-cinq/shift-log**: https://github.com/re-cinq/shift-log. 49★, v3.1.34, push 2026-09-12. [V]
- **hsusul/lore**: https://github.com/hsusul/lore. 140★, v0.1.1 (2026-08-14). [V]

**Mechanism**
- **git-ai.**
  - `git ai blame` is a drop-in `git blame`.
  - `git ai stats <a>..<b> --json` returns `human_additions`, `ai_additions`, `ai_accepted` and a `tool_model_breakdown`.
  - The standard stores notes under `refs/notes/ai`. Attestation lines map file line ranges to `s_<14hex>::t_<14hex>` keys (session, then checkpoint trace).
  - Session id is `"s_" + SHA256("<tool>:<conversation_id>")[0..14]`.
  - Prompts are stored outside git and redacted.
  - It supports Claude Code, Codex, Cursor, Copilot, OpenCode, Pi, Gemini, Amp and Droid.
- **shift-log.** Attaches the conversation since the last commit as a git note. It installs by writing hooks into the repo's `.claude/settings.json`, `.gemini/settings.json` and so on; that part is rejected.
- **lore.** Keeps "commit recorded during the session" separate from "repository state observed later". [V]

**Why it matters.** "Show me the lines this session wrote that reached main" is the core question of a review surface across repositories. Wanigan already has per-turn checkpoints and a worktree per session, so it can compute attestation in SQLite without writing to the user's repo. Exporting `refs/notes/ai` would be a separate, deliberate action.

**Effort** L.

### 8. Stale paths in instruction files, and Codex's AGENTS.md byte-budget truncation
**Tools**
- **openintelligence-labs/agents-md-lint**: https://github.com/openintelligence-labs/agents-md-lint. 0★, v0.1.0 (2026-08-07). [V]
- **satoissei/agents-doctor**: https://github.com/satoissei/agents-doctor. 3★, v0.2.3 (2026-08-02). [V]

**Mechanism**
- **agents-md-lint.** Checks that paths in backticks exist, with a did-you-mean from `git ls-files`. Checks that commands in shell fences resolve on `PATH`. It is deliberately conservative: it stays quiet on URLs, globs, `~/` paths, `$VARS` and the project's own CLI. No LLM. Its own measurement: 30 findings and 0 false positives across 14 files.
- **agents-doctor.** Reproduces Codex's loader: AGENTS.md files concatenated from the repo root down to the cwd, then cut at a byte budget.
  - Because root files come first, the most specific rules are the first to disappear, silently.
  - `explain --format json` gives the load plan.
  - `budget` shows budget pressure across a monorepo.
  - `--codex-config ~/.codex/config.toml` honours the user's loader settings.
  - Output is also available as SARIF. [V]

**Why it matters.** Wanigan's learning engine writes projections into CLAUDE.md, AGENTS.md and nested AGENTS.md. A projection that pushes a nested chain past Codex's budget removes the very rule it added, and nothing on screen says so. Wanigan's `agentsMdStatus()` answers only "does Claude read AGENTS.md" (checked in source). Run both checks before a projection is applied and in the Context view.

**Effort** S.

### 9. What a session pays for skill listings, and Codex's manual-only switch
**Tools**
- **kurtextrem/skillzero**: https://github.com/kurtextrem/skillzero. 1★, v0.2.0 (2026-09-04). [V]

**Mechanism**
- **Hidden skills** (the model does not see the name or description, but the user can still invoke them). For Claude and Cursor this is `disable-model-invocation: true` in SKILL.md. For Codex it is `policy.allow_implicit_invocation: false` in `agents/openai.yaml`.
- **Collections** bundle several skills into one skill the agent reads lazily.
- It keeps state in `skillzero/` inside the skills root, with undo, redo and dry-run. [V]

**Why it matters.** Wanigan already predicts Claude invocability (`src/main/skills.ts`) but not the Codex policy file, and it does not count the per-turn listing tokens. The Context view could show "N skills listed, about X tokens every turn" and offer the per-provider toggle. Personal skills change on explicit action; project skills go through the review inbox.

**Effort** S.

### 10. Security audit of skill contents before install or trust
**Tools**
- **runkids/skillshare**: https://github.com/runkids/skillshare. 2,658★, v0.20.29 (2026-09-10). [V README + https://skillshare.runkids.cc/docs/reference/commands/audit]

**Mechanism.** `skillshare audit` scans every text file in a skill against 100+ rules: prompt injection, data exfiltration, credential access, command safety tiers, supply-chain trust and cross-skill interaction.
- It uses static and dataflow analyzers.
- `--threshold high` blocks the install, and auto-scan runs on install and update.
- Output formats: SARIF 2.1.0, JSON and Markdown.
- Its aggregate score is explicitly informational; the severity gate decides. [V]

**Why it matters.** Wanigan trusts MCP servers by digest and catalogues skills. A digest proves the bytes are unchanged, not that they are safe. Showing findings on the consent screen at trust time fits the existing digest-trust flow. Adopt the severity gate, not the aggregate score.

**Effort** M.

### 11. A plain explanation of the command in each approval request (deterministic, no model)
**Tools**
- **pacejiang-awesome/codex-approval-explainer**: https://github.com/pacejiang-awesome/codex-approval-explainer. 0★, 2026-07-17. [V]
- **constansino/codex-attention-notifier**: https://github.com/constansino/codex-attention-notifier. 2★, 2026-05-07. [V]

**Mechanism**
- **codex-approval-explainer.** A `PermissionRequest` hook reads `tool_name`, `tool_input.command` and `cwd`. It returns only a `systemMessage` covering purpose, main arguments, scope, risk level and reversibility; it never returns allow or deny. Unrecognised flags are marked "cannot reliably confirm". Tokens, passwords and cookies are redacted first. Nothing is logged or sent over the network. [V]
- **codex-attention-notifier** documents a gap: Codex has no stable signal that a child process is waiting on stdin (for example `sudo Password:`). [V]

**Why it matters.** Approvals reach Wanigan's attention queue and the phone remote. A deterministic "what this does, what it touches, can it be undone" card makes approving from a phone safer. It works today from the Claude hook payload. For Codex it depends on the known Codex-hooks gap, and a PTY password-prompt heuristic could become its own reason code.

**Effort** S.

### 12. Warning before sending into a session whose prompt cache has likely expired
**Tools**
- **ww-w-ai/super-token-saver** (Token Guardian). [V]

**Mechanism.** It remembers when the last reply arrived. If more than the cache TTL minus 10 s has passed (3,590 s for the 1-hour tier), it warns or, in block mode, blocks the send. It is off by default because a hook block message does not reach Remote Control. `CC_TOKEN_SAVER_CACHE_GUARD=warn` makes the first line of the reply say the full context was re-sent. [V]

**Why it matters.** Wanigan's composer and queue know the idle time and the last turn's context size from the transcript. An inline "idle 68 min: this send likely re-reads ~N tokens without cache (estimate)" helps the operator choose between sending, starting fresh, or handing off. Only warn, never block. Label the TTL tier as inferred, since it varies by harness and cache tier.

**Effort** S.

### 13. Optional capture of the exact API requests a session sends
**Tools**
- **liaohch3/claude-tap**: https://github.com/liaohch3/claude-tap. 3,196★, v0.1.145 (2026-08-16). [V]
- **WEIFENG2333/phistory**: versioned system-prompt snapshots built on claude-tap. [S, from the claude-tap README]

**Mechanism**
- **Reverse mode.** Rewrites `ANTHROPIC_BASE_URL`, `ANTHROPIC_BEDROCK_BASE_URL` or `ANTHROPIC_VERTEX_BASE_URL` to a local proxy.
- **Forward mode.** Injects `HTTPS_PROXY` plus a local CA into the child process. This is the default for Gemini, OpenCode and Codex App. Real `*.amazonaws.com` endpoints are not rewritten because that would break SigV4.
- It records system prompts, tool schemas, tool calls, reconstructed streams and token usage, and shows structured diffs between adjacent requests.
- Common auth headers are redacted, and a run exports to a self-contained HTML file. [V]

**Why it matters.** Wanigan's Context view models what should load (the CLAUDE.md chain). The request on the wire is what actually loaded: exact system-prompt and tool-schema bytes. Offer it as an opt-in "trace this session" launch option, labelled "observed on wire".
- Costs: a MITM CA in the child's environment, secrets inside request bodies, and possible ToS exposure.
- Never make it a default.

**Effort** L.

### 14. Leftover processes and ports after agent sessions
**Tools**
- **graykode/abtop**. [V]
- **0x0funky/Agentinel**: https://github.com/0x0funky/Agentinel. 49★, 2026-06-09. [V]

**Mechanism**
- **abtop.** Discovers Claude, Codex and OpenCode sessions from process and file state. Shows child processes, open ports, orphan-port detection, context % and rate limits. `--json` gives a snapshot.
- **Agentinel.**
  - Identifies agent processes, falling back to `argv[0]` when a CLI rewrites its process title.
  - Groups them by project and builds parent/child trees.
  - Tracks idle time since last CPU activity, which is a better zombie signal than uptime, and flags duplicate sessions and orphans.
  - Kills or suspends nothing until the user clicks. [V]

**Why it matters.** Wanigan owns the PTY, but dev servers and MCP servers an agent spawns can outlive the session, and Halt stops only the session. A "survivors" list (pid, port, parent session, idle time) with explicit kill buttons closes that loop.

**Effort** S–M.

### 15. Reference tables for how each harness exposes hooks, permissions, MCP settings and review checks
**Tools**
- **dyoshikawa/rulesync**: https://github.com/dyoshikawa/rulesync. 1,424★, v16.32.1 (2026-09-14). [V README + `docs/reference/file-formats.md`]
- **intellectronica/ruler**: https://github.com/intellectronica/ruler. 2,926★, v0.3.44 (2026-06-30). [V]
- **farion1231/cc-switch**: https://github.com/farion1231/cc-switch. 132,865★, v3.20.3 (2026-09-11). [V]

**Mechanism (rulesync)**
- **Hooks.** `.rulesync/hooks.jsonc` uses canonical camelCase events, translated per tool:
  - Claude, Codex, Qwen and Goose: PascalCase.
  - OpenCode and Kilo: a JS plugin with `tool.execute.before`, where `permissionRequest` becomes `permission.asked`.
  - Pi: `tool_call`, where a non-zero exit denies with `{block:true, reason}`.
  - Where an event cannot match or cannot block, the docs say so explicitly.
- **Permissions.** `.rulesync/permissions.jsonc` sets allow, ask or deny per category (`bash`, `read`, `edit`, `webfetch`, `mcp__…`) with globs. For Codex this becomes `default_permissions` and `approval_policy`. Blank keys and `__proto__` are refused.
- **Checks.** `.rulesync/checks/*.md` are review checks with severity. They compile to Cursor `.cursor/BUGBOT.md`, Amp `.agents/checks/`, Factory `review-guidelines` skill, Augment YAML and a Hermes `pre_verify` plugin.
- **MCP.** `envVars` becomes Codex `env_vars`, and `oauth.clientId` is duplicated to `client_id`.

**Mechanism (ruler and cc-switch)**
- **ruler** adds a per-agent table of MCP config locations (Codex `.codex/config.toml`, Gemini `.gemini/settings.json`, Qwen `.qwen/settings.json`, Zed `.zed/settings.json`), `.bak` backups, `ruler revert` and `--dry-run`.
- **cc-switch** syncs MCP servers, skills and prompts two-way across Claude, Codex, Gemini, OpenCode, Grok and Hermes, and backfills from the live files.

**Why it matters.** Wanigan's policy gate is Claude-hooks-only, and its compiler targets two providers.
- rulesync's matrix is a maintained, verified map of which events exist in each harness and which can *block*. That is what Wanigan needs to extend the gate to packs honestly, returning `unsupported` where no blocking event exists.
- Review checks are a new knowledge kind that could feed item 2 and the Batches judge.
- Use these tables as mapping data. Do not run the tools to write config into repositories.

**Effort** M. This partly extends the Codex-hooks gap.

### 16. Stopping at the plan-approval moment to annotate the plan
**Tools**
- **backnotprop/plannotator**: https://github.com/backnotprop/plannotator. 8,687★, v0.27.14 (2026-09-11). [V]

**Mechanism.** Plan mode is wired in through each harness's hooks, covering Claude Code, Codex, Copilot CLI, Gemini, OpenCode, Kiro, Droid, Amp and Pi.
- When the agent proposes a plan, a local browser review surface opens.
- The operator annotates inline and sends structured feedback back to the agent.
- `plannotator archive` keeps saved plan decisions read-only.
- Code review of local diffs and PRs works the same way. [V]

**Why it matters.** Wanigan sends review notes to a session after the work is done. The cheapest correction point is before any code exists. Plan annotation, together with an archive of plan decisions, fits the review surface.
- Reject its share portal and hosted Workspaces.
- It also checks GitHub for updates on every load; Wanigan should not copy that.

**Effort** M.

### 17. Weekly work recap across repositories, built from recorded evidence
**Tools**
- **jquinteiroo/devrecap**: https://github.com/jquinteiroo/devrecap. 2★, v0.3.0 (2026-09-14), listed in the OpenAI Plugins Directory. [V]
- **smixs/mentor**: https://github.com/smixs/mentor. 80★, 2026-08-08. [V]

**Mechanism**
- **devrecap** reads only the Codex and Claude history and git evidence the user authorises. It separates completed, investigated-only and in-progress work, then the host AI phrases the recap.
- **mentor's `collect.py`** counts facts deterministically: sessions, tool mix, edits, model tiering. The agent then writes the report, including a friction section where each friction comes with a proposed CLAUDE.md line or hook. [V]

**Why it matters.** One operator across many repositories needs "what actually got done this week, and what is half-finished". Wanigan already records sessions, checkpoints, PRs and goals. Produce the deterministic facts first; any model phrasing goes through the learning engine's consent, routing and metering gates. mentor's friction-to-rule step overlaps the learning engine and is not new.

**Effort** M.

### 18. Copy gitignored local files (`.env`, certificates) into new session worktrees
**Tools**
- **kbwo/ccmanager**: https://github.com/kbwo/ccmanager. 1,239★, v4.4.3 (2026-09-13). [V]

**Mechanism.** A repo-root `.worktreeinclude` lists gitignored files to copy into a newly created worktree. ccmanager says it uses the same filename and semantics as Claude Code, Conductor, OpenAI Codex and `git-worktreeinclude`. [V for the ccmanager claim; S for the vendors]

**Why it matters.** Wanigan creates a worktree per session. Without the gitignored files the agent's first test run fails, and the session burns its orientation phase on it. Wanigan would only read a user-authored file, never generate one. No hits in Wanigan's source.

**Effort** S.

### 19. Which Codex config layer set a value, validated against the official schema
**Tools**
- **SpaceDudem/CODEX_TUI**: https://github.com/SpaceDudem/CODEX_TUI. 0★, 2026-08-31. [V]

**Mechanism**
- `inspect --effective model` reports the discovered layers and which one set each effective value.
- `validate` uses a cached snapshot of the official Codex JSON schema, with an offline fallback.
- `diff` compares two configs.
- `backup` makes a byte-exact checkpoint with a SHA-256 concurrency token; `apply --expected-sha` writes a candidate only if the file is still unchanged. [V]

**Why it matters.** Wanigan launches Codex with a per-account `CODEX_HOME` and pins repo executable config. "Why is this session on model X with effort Y" is a layer-provenance question. Schema validation catches keys a Codex upgrade renamed.

**Effort** S–M. Low adoption, but the mechanism is sound.

### 20. Try a skill in one session without installing it
**Tools**
- **vercel-labs/skills**: https://github.com/vercel-labs/skills. 31,634★, v1.5.26 (2026-09-11). [V]

**Mechanism.** `skills use <source> --skill <name>` writes the skill files to a temporary directory and prints a generated prompt. With `--agent claude-code` it starts that agent interactively. [V]

**Why it matters.** Wanigan's `$skill` menu covers installed skills. Trialling a catalogue skill for one session, injected from Wanigan's user-data directory, fits the rule of never writing into the user's repo just to make a session work.
- The telemetry this CLI sends by default is rejected.
- How Wanigan would inject per harness is unverified.

**Effort** S–M.

---

## (2) Items that add a new mechanism to an already-known gap

- **Codex app-server parity.** `codex-rs/app-server-protocol/src/protocol/common.rs` [V] now lists these methods:
  - `thread/search` and `thread/searchOccurrences` (both experimental; the second reads persisted paginated history)
  - `thread/inject_items`, which appends raw Responses items without starting a turn
  - `thread/fork`, `thread/revert`, `thread/queue/{add,list,update,delete,reorder,start}`
  - `thread/goal/*`, `memory/status`, `memory/reset`, `thread/memoryMode/set`
  - `review/start`, `externalAgentConfig/{detect,import}`, `hooks/list`, `skills/list`, `permissionProfile/list`
  - `thread/backgroundTerminals/{list,terminate,clean}`

  They extend four known gaps: Codex transcript search (native search instead of parsing rollouts), `codex queue`, Codex memories, and cross-session messaging (`inject_items`). `thread/backgroundTerminals/*` also gives item 14 a Codex-native path. The `ThreadSearchParams` shape was not readable at the path I tried; see section 5.

- **Cross-session messaging.**
  - **fujibee/agmsg** (https://github.com/fujibee/agmsg, 1,500★, v1.3.0 2026-09-15) [V]: a shared WAL-mode SQLite file, bash only, no daemon. A hook or Monitor stream delivers messages, and `history.sh` replays a room into a fresh agent.
  - **Dicklesworthstone/mcp_agent_mail** (https://github.com/Dicklesworthstone/mcp_agent_mail, 2,142★, v0.3.2 2026-04-16, push 2026-09-06) [V header]: identities, inboxes, searchable threads and advisory file leases over MCP, git and SQLite.
  - **buidangminh23/codex-mcp-bridge** (https://github.com/buidangminh23/codex-mcp-bridge, 9★, v1.16.0 2026-09-14) [V]: `send_to_codex_thread` and `send_to_claude_session`. It checks for an account switch before delivery and returns a `reply_received` receipt; a timeout does not mean the task stopped.
  - New mechanisms: advisory file leases between parallel sessions, and delivery receipts.

- **Transcript search for Codex, and semantic search.**
  - **Dicklesworthstone/coding_agent_session_search (`cass`)** (https://github.com/Dicklesworthstone/coding_agent_session_search, 1,129★, v0.8.0 2026-09-10) [V]: lexical search is required; a MiniLM model is downloaded only on explicit `cass models install`. SQLite is the only authoritative store, and derived indexes are quarantined rather than deleted. `--robot-meta` reports the requested vs actual search mode.
  - **kenn-io/agentsview** (https://github.com/kenn-io/agentsview, 5,901★, v0.43.0 2026-09-14) [V]: 20+ agents, a daemon, and optional `s3://` roots (non-local).
  - **ay-bh/chat-history** (https://github.com/ay-bh/chat-history, 11★, v0.6.0 2026-09-12) [V]: `search --scope errors|similar`, a `--branch` filter, and resume across Claude, Codex and Cursor. It quietly installs a skill into `~/.claude/skills` and `$CODEX_HOME/skills`; that part is rejected.
  - **decant**: FTS over Claude, Codex and Gemini.
  - New mechanisms: "similar errors" recall, and reporting the requested vs actual search mode.

- **Rollout token budgets.**
  - **RoninForge/budgetclaw** (https://github.com/RoninForge/budgetclaw, 8★, v1.7.56 2026-09-14) [V]: attributes cost to a {project, git branch} pair from Claude JSONL. At the cap it sends SIGTERM and a phone alert.
  - **shanirsh/prismodev** (https://github.com/shanirsh/prismodev, 20★, push 2026-07-02) [V]: separates "verified saved" (later sessions show waste dropped) from "live prevented" (estimated). The verification layer is Prismo Cloud, which is rejected; the labels map onto Wanigan's paired-trial gap.
  - New mechanism: per-branch budget attribution.

- **Structured live transcript.**
  - **PixelPaw-Labs/codex-trace**: live tail over SSE, plus "collaboration chains" that link orchestrator and worker rollouts. [V]
  - **super-token-saver**: a subagent inherits the parent `session_id`, so sessions must be keyed on `payload.id`. [V]
  - **agent-sessions 5.3**: keeps the Codex subagent tree intact. [V]
  - New mechanism: parent/child rollout linkage.

- **Session export.**
  - **es617/claude-replay** (https://github.com/es617/claude-replay, 830★, v0.11.0 2026-08-29) [V]: a self-contained HTML replay with redaction, bookmarks and collapsible tools and thinking, across 7 formats.
  - **decant**: exports to Markdown, JSON and trajectory; the README credits Letta Trajectory as a normalised cross-runtime record format. [V]

- **Best-of-N, model routing and account handoff.**
  - **razzant/claudexor** (https://github.com/razzant/claudexor, 453★, v3.12.0 2026-09-14) [V]: races with cross-family reviewers and arbitration. Unknown cost is never shown as $0. Rotating a spent account on a typed vendor limit is opt-in. Credential profiles each have their own scoped state.
  - New mechanism: typed limit events as the rotation trigger.

- **Codex hooks.** [V] These tools confirm Codex `PermissionRequest` and `Stop` payloads (`hook_event_name`, `tool_name`, `tool_input.command`, `cwd`), `[features].codex_hooks`, and `~/.codex/hooks.json`:
  - constansino/codex-attention-notifier
  - pacejiang-awesome/codex-approval-explainer (`/hooks` trust prompt on first use)
  - christianaranda/codex-notify (plugin-bundled Stop hook)

  Nainish-Rai/agent-rollback (6★, v1.1.1 2026-06-11) snapshots files through Codex hooks plus MCP, which is already covered by Wanigan's checkpoints.

- **Codex memories.** plastic-labs/codex-honcho (51★) integrates memory at the harness level through Codex hooks. [S, search description only]

- **Codebase index.** colbymchenry/codegraph (70,865★) and DeusData/codebase-memory-mcp (43,268★). [S, descriptions only]

---

## (3) Already covered by Wanigan

- **Codex usage menu-bar apps.**
  - steipete/CodexBar (21,401★, v0.60.2 2026-09-14) [S/V meta]
  - shanggqm/codexU, jordan-edai/codex-reset-watcher, thrr87/codex-limits, dennykim123/claude-codex-battery [S]
  - MacSteini/Codex-Usage (107★, v1.3.0) [V]: reset credits come from *undocumented* ChatGPT backend endpoints, a fragility worth noting.

  Covered by Codex limits via app-server plus spend views.
- **Codex profile and account managers.** Ducksss/codex-profiles (146★, v1.1.0 2026-09-13) [V]: named `CODEX_HOME` profiles without copying tokens. Also midhunmonachan/codex-profiles, lordydord/Codex-Account-Switcher and domanski-ai/headroom [V header]. Covered by multiple accounts and Codex account handoff.
- **Notification bridges.** MiUPa/codex-notify (`notify` hook) [V] and christianaranda/codex-notify [V]. The latter's Stop-hook digest includes status, prompt and result summary, verification lines, repo/branch/SHA/dirty, a PR link and SQLite history. Covered by notifications incl. OSC 9 and the attention queue; the digest field list is worth comparing against Wanigan's notification body.
- **Session browsers and managers.** twidi/twicc, vakovalskii/codbash, hsusul/lore, jazzyalex/agent-sessions (resume), kbwo/ccmanager (busy/waiting/idle detection), jerriclynsjohn/tmux-agent-pulse, and ADEs from the nimbalyst roundup. Covered by PTY sessions, recent conversations with resume, and the attention queue.
- **Learning from transcripts.**
  - kunchenguid/backpass (998★, v0.1.22 2026-09-13) [V]: evidence from ≥2 distinct sessions and a human accept/reject gate; model calls go through `acpx`. The same contract as Wanigan's learning engine.
  - Dicklesworthstone/cass_memory_system (439★, v0.2.14) [V]: confidence halves every 90 days without revalidation, a harmful mark counts 4× a success, and 3 harmful marks invert a rule into an anti-pattern. Worth a look as a refinement to Wanigan's promotion and pruning rules.
  - thedotmack/claude-mem. [S]
- **AGENTS.md hierarchy authoring.** agent0ai/dox (1,456★) [V] is instruction-only: the agent maintains child AGENTS.md files. caliber-ai-org/ai-setup (1,269★, v1.53.5) [S] generates cross-tool config. Covered by learning-engine projections.
- **Codex evidence dossiers.** rudrankriyam/agent-dossier (5★) [V] is included for its honest negative result: on a 10-question blinded holdout, dossier answers passed 4/10 vs 6/10 for native Codex history reconstruction, while using 94% fewer tokens. Not worth adopting.
- **Codex history "provider rebind" tools.** GODGOD126/codex-history-sync-tool (500★, v1.0.0 2026-08-11) [V], severinzhong/codex-history-manager, ChenglongLi777/codex-migrate. Codex Desktop hides threads whose `model_provider`/`model` differ from the current setting; these tools rewrite the SQLite state, session meta and sidebar index after taking a backup. This is a **risk to check** for Wanigan's exact UUID recovery when a pack or account uses a different `model_provider`, not a feature to build.
- **Codex subagent collections and orchestrators.** VoltAgent/awesome-codex-subagents, leonardsellem/codex-subagents-mcp (last push 2025-12, stale), oh-my-codex teams. Covered by headless fan-out and schedules, or out of scope.

---

## (4) Seen and rejected

- **Relays, proxies and hidden routing.** cc-switch's local proxy with failover and "signature bypass" utility, and its Dropbox, OneDrive and WebDAV cloud sync [V]. Also diegosouzapw/OmniRoute, router-for-me/CLIProxyAPI and Wei-Shaw/sub2api [S], and agiwhitelist/tokdiet, a reverse proxy that *compacts blobs* in flight [S].
- **Silent rewriting of what the agent sees.** rtk-ai/rtk (80,401★, v0.49.0 2026-09-11) [V]: `rtk init -g --codex` installs a PreToolUse hook that rewrites Bash commands (`git status` becomes `rtk git status`), so the agent receives filtered output and the transcript no longer matches the command that ran. The only acceptable form would be a declared per-session opt-in measured in a paired trial. JuliusBrussee/caveman (105,598★) [S] is a terse-output style skill; it belongs in a bench, not a default.
- **Leaderboards and uploads.** tokscale `submit`, sculptdotfun/viberank, 851-labs/tokenmaxxing, splitrail cloud, tenequm/pond (S3 archive) and agentsview `s3://` roots.
- **One provider's artifacts as another's input.** Codex `externalAgentConfig/import` for `CONFIG`, `MCP_SERVER_CONFIG`, `HOOKS`, `SUBAGENTS`, `COMMANDS` or `MEMORY` (Claude artifacts becoming Codex config). rulesync `convert --from cursor --to claudecode` for the same reason.
- **Tools that write generated config into repos or user config just to work.**
  - shift-log `init`: repo `.claude/settings.json` hooks
  - rulesync and ruler `generate`/`apply`: when run automatically
  - chat-history: quiet skill install
  - oh-my-codex: `.omx/` state in the repo, plus `--madmax --yolo`
  - codealmanac: wiki written into the repo by agents
- **Auto-approval.** ccmanager "Auto Approval (experimental)", engchina/codex-approval-guard (window detection plus allowlist) and 040822/dsh-codex-approval (AI risk tiers auto-allow). These belong with the known `--approve-for-me` gap, and none is acceptable without a human.
- **Telemetry and credential scraping.** vercel-labs/skills sends telemetry by default. zetagao/LimitHUD reads Chrome cookies. MacSteini/Codex-Usage's online report calls undocumented endpoints.
- **Hosted surfaces.** plannotator share portal and Workspaces, Supafork [B], Type.com and Castforge [S].
- **Automatic review loops.** The codex-plugin-cc Stop-hook review gate as a default, and ai-pr-loop / codex-review-loop "until VERDICT: CLEAN" [S]. They loop without a human and drain quota.

---

## (5) Could not verify

- **contextify.sh** (Show HN 2026-07-03, "Pull Claude Code transcripts into your Codex session, and vice versa"): page not fetched. [B]
- **Supafork** (Show HN 2026-09-01, share and fork sessions across harnesses): not fetched; probably hosted. [B]
- **`ThreadSearchParams` shape:** the method exists and is marked experimental in `common.rs` [V], but the schema file was 404 at `schema/typescript/v2/ThreadSearchParams.ts`. It probably lives in an experimental schema directory. [B]
- **`.worktreeinclude` in Claude Code and Codex:** asserted only by ccmanager's README. [S]
- **Session-Bench scores:** the project's own measurements. I read the page but did not reproduce them. [V page, not reproduced]
- **plastic-labs/codex-honcho, colbymchenry/codegraph, thedotmack/claude-mem, graphify:** search descriptions only. [S]
- **phistory:** described in claude-tap's README only. [S]
- **r/codex and Product Hunt:** not searched. The Show HN sweep covered Jul to 14 Sep only.
- **Star counts** may include automated inflation; several very large numbers (for example ECC 258k, cc-switch 132k) are reported as returned by the API.
- **Tools just outside the Jun to 14 Sep window:** cli-continues (push 2026-05-07), rses (2026-03), sync-agents-settings (2026-03), codex-attention-notifier (2026-05-07), codex-approval-guard (2026-05-31). They are included only where their mechanism is load-bearing.
