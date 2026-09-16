# W7: Observability, cost, evaluation and productivity measurement for coding agents (as of 2026-09-14)

Labels: **[V]** primary source read this session (URL, date). **[S]** second-hand, or search snippet only. **[B]** blocked or not found; nothing invented. About 50 search and fetch calls.

## 1. Telemetry standards and tooling

**OTel GenAI semantic conventions**
- Status: every `gen_ai.*` attribute, span, metric and event is still "Development", not Stable, as of 16 Jul 2026. v1.41.0 (28 Apr 2026) added `invoke_workflow`, time-to-first-chunk and time-per-chunk metrics, and split `invoke_agent` into client and internal spans. v1.42.0 (12 Jun 2026) moved GenAI out of the main repo into `open-telemetry/semantic-conventions-genai`, which had "no tagged release yet" on 16 Jul [S: dev.to/azena-ai, 16 Jul 2026]. The old page now says the conventions "have moved" [V: opentelemetry.io/docs/specs/semconv/gen-ai/].
- What this means locally: store raw OTLP attributes as opaque data and map names when reading. Don't bake `gen_ai.*` names into migrations.

**Claude Code monitoring** [V: code.claude.com/docs/en/monitoring-usage, fetched 14 Sep 2026]
- Metrics:
  - `session.count` (`start_type`: fresh, resume, continue, agents_view)
  - `lines_of_code.count`, `commit.count`, `pull_request.count`
  - `cost.usage` (USD) and `token.usage` (input, output, cacheRead, cacheCreation)
  - `code_edit_tool.decision`: decision, `source` (config, hook, user_permanent, user_temporary, user_abort, user_reject) and `language`
  - `active_time.total` (`type`: user or cli)
- Cost and token metrics now carry `query_source` (main, subagent, auxiliary), `speed`, `effort` (low through max), `agent.name`, `skill.name`, `plugin.name`, `marketplace.name`, `mcp_server.name` and `mcp_tool.name`. User-defined names become "custom" and third-party names become "third-party" unless `OTEL_LOG_TOOL_DETAILS=1`.
- Events:
  - `user_prompt` and `assistant_response` (v2.1.193+)
  - `tool_result`: duration and error type. On a successful `git commit` it adds `vcs.ref.head.revision` (v2.1.269+, needs the details flag).
  - `api_request`: cost, duration, the four token types, request ids, speed, effort
  - `api_error` and `tool_decision`
  - Join keys: `prompt.id` and `message.uuid` (links to the transcript).
- Cost is labelled "Estimated" throughout. Statusline cost is "computed client-side at list price unless a `modelPricing` table is in effect. May differ from your actual bill."
- **Traces (beta)**: set `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` plus `OTEL_TRACES_EXPORTER`. Span tree:
  - `claude_code.interaction` is the root for each prompt.
  - `llm_request`: `ttft_ms`, `first_content_ms` (v2.1.268+), `attempt`, `stop_reason`, `error_class`, cache tokens, `agent_id`/`parent_agent_id`.
  - `tool`: duration including the permission wait, `result_tokens`, `bash_command_class`, `bash_argv0`. Under it:
    - `tool.blocked_on_user`: wait time and decision.
    - `tool.execution`.
  - Subagent spans nest under the Agent tool.
  - The `claude_code.hook` span needs detailed beta tracing, and an org allowlist in the interactive CLI.
- Context propagation: Bash and PowerShell subprocesses inherit `TRACEPARENT`. `-p` and SDK sessions read an inbound `TRACEPARENT` and parent their interaction span to it (`parent.source` is env or none, v2.1.268+).
- New opt-ins:
  - `OTEL_LOG_ASSISTANT_RESPONSES`
  - `OTEL_LOG_TOOL_CONTENT`
  - `OTEL_LOG_RAW_API_BODIES=file:<dir>`: untruncated request bodies, including full history, written to disk with a `body_ref` pointer. This is the only exact-replay source.
  - `OTEL_METRICS_INCLUDE_REPOSITORY` (v2.1.269+)
- `OTEL_*` variables are not passed to subprocesses.

**Claude Code statusline JSON** [V: code.claude.com/docs/en/statusline]
- `rate_limits.five_hour|seven_day.{used_percentage,resets_at}`:
  - Pro and Max subscribers only, and only after the first API response.
  - Each window can be absent independently, and is dropped once `resets_at` passes.
  - `spend_limit` appears behind a Claude apps gateway (v2.1.251+).
- `prompt_cache` (v2.1.251+; main conversation only, subagents excluded):
  - State: `warm`, `caching_observed`, `ttl` (5m or 1h), `expires_at`, `requests`.
  - `misses`: re-processed more than 5% and at least 2,000 tokens, with no compaction to explain it.
  - `hit_ratio`: cache reads divided by all input.
  - Rebuild costs: `expected_rebuilds`, `cache_write_tokens`, `miss_recache_tokens`, `recache_tokens_if_cold`.
  - `last_miss_cause` and `miss_causes` (v2.1.260+): `tools_changed`, `system_prompt_changed`, `ttl_expired_5m`, `likely_server_side`.
  - The same figures appear on the `/usage` "Prompt cache (main)" line.
- Also available: `effort.level`, `pr` (number, url, review_state), `prompt_id` (equals OTel `prompt.id`) and `worktree`. The script re-runs when a window reaches `resets_at` or a warm cache reaches `expires_at`.

**Codex CLI** [V: learn.chatgpt.com/docs/config-file/config-advanced]
- The `[otel]` table in `~/.codex/config.toml` takes `environment`, `exporter` (otlp-http, otlp-grpc or none) and `log_user_prompt` (default false). Export is off by default.
- Events: `codex.conversation_starts`, `codex.api_request`, `codex.sse_event`, `codex.user_prompt`, `codex.tool_decision`, `codex.tool_result`.
- Metrics: counters and histograms covering API, tools, threads and memory. Token types include `cached_input`, `output` and `reasoning_output`.
- Rate limits: a primary window (300 min) and a secondary window (10,080 min), each with used percent and reset time, found in rollout JSONL `token_count` events [S: gists and community posts].
- Issue #42007: "5h rate limit went 0% -> 100% in 23 minutes while the weekly limit moved 1pp" [V: title only].

**Vendor analytics APIs**
- **Anthropic Claude Code Analytics API** (`/v1/organizations/usage_report/claude_code`) [V: platform.claude.com/docs/en/manage-claude/claude-code-analytics-api]
  - One record per user per day: sessions, lines added and removed, commits and PRs, Edit/MultiEdit/Write/NotebookEdit accepted and rejected, and per-model tokens including cache, with `estimated_cost` in cents.
  - Up to 1 h delay. Needs an Admin key, and is "unavailable for individual accounts".
  - Excludes Bedrock, Vertex and Foundry. Free to use.
- **Cursor AI Code Tracking API**: Enterprise only, "Alpha" [V: cursor.com/docs/account/teams/ai-code-tracking-api]
  - Per-commit `tabLinesAdded`, `composerLinesAdded` and `nonAiLinesAdded`, each with a Deleted counterpart.
  - Covers the top-level workspace repo only.
  - Mechanism: line signatures stored on the device and matched against later commits made on the same machine. Not implemented for the CLI or background agents [S: snippet].
- **GitHub Copilot usage metrics** [S: snippets]
  - GA on 27 Feb 2026.
  - Fields: `loc_added_sum` and `code_generation_activity_count`. Agent mode has no suggest-then-accept event.
  - 7 Aug 2026: added `totals_by_3rd_party_agent`.

**Hosted observability applied to coding agents**
- **Datadog Agent Console** (Preview) [V: docs.datadoghq.com/ai_agents_console/]
  - Covers Claude Code, Cursor and Copilot.
  - Views:
    - Findings: spend, sessions, time to merge, lines of code, turns per session.
    - Impact: adoption, velocity, stability.
    - "Detected Problems", each with an "estimated monthly cost".
    - Cost per line of code, and accepts vs rejects.
    - Team and user comparisons.
- **Langfuse** (Jul 2026) [V: langfuse.com/resources/engineering/coding-agent-tracing]
  - Claude Code through a Stop-hook script, Codex through plugin hooks, Copilot through native OTel.
  - Cost dashboards, failed-session reconstruction and full-text search. Self-hostable.
  - Admits the hooks can be disabled by the user and that CLAUDE.md and skills context is not captured.
- **Others**:
  - Honeycomb: Claude Code OTLP plus MCP queries over spend, tool failures and compaction triggers [S].
  - Arize Phoenix: ingests Harbor ATIF trajectories as span trees (3 Apr 2026) [S].
  - Views a local app typically lacks: trace waterfalls, datasets built from traces, side-by-side experiment diffs, annotation queues and online LLM judges (Braintrust, LangSmith, Weave) [S: prior knowledge, not re-checked].

## 2. Local usage and cost tools: what each observes vs infers
- **ccusage** (18.6k stars) [V: github.com/ryoppippi/ccusage; ccusage.com/guide/blocks-reports]
  - Reads local logs from 18 CLIs.
  - Reports: daily, weekly, monthly, session, blocks, and a statusline (beta).
  - Prices come from LiteLLM; `--offline` uses cached prices.
  - A block starts at your first message, lasts exactly 5 h, and is computed in UTC.
  - Burn rate is shown as tokens per minute and cost per hour. The projection is "if current rate continues".
  - `--token-limit max` uses your highest previous block.
  - The docs don't say that blocks only approximate Anthropic's real windows.
  - What it infers: windows and cost. What it observes: tokens.
- **Claude-Code-Usage-Monitor v4.0.0** (8.7k stars) [V: README]
  - "Custom" limit is the P90 of your sessions over the last 192 h.
  - Plan presets: Pro about 19k, Max5 about 88k, Max20 about 220k tokens.
  - v4 labels each figure "Official" (from statusline `rate_limits`) or "Local estimate", and falls back to the estimate when official data goes stale.
  - Claims "95% accuracy", with no method given.
- **CodexBar** (21.4k stars, MIT) [V: github.com/steipete/CodexBar]
  - 69 providers.
  - Claude data comes from the OAuth API, browser cookies (opt-in) or a CLI PTY fallback.
  - "On-device parsing by default". The pace projection method is undocumented.
- **agentsview** (5.9k stars, MIT) [V: github.com/kenn-io/agentsview]
  - 40+ agents; reads `~/.claude/projects` and `~/.codex/sessions`.
  - SQLite with FTS5 search.
  - Analytics: heatmaps, tool usage, duration distributions, "cache economics", peak context tokens.
  - No LLM in the core analytics. Optional semantic search uses an external embeddings endpoint.
  - Runs on 127.0.0.1:8080, plus desktop apps.
- **Others**: sniffly (localhost dashboard with error analysis) [S]; claude-view (live sessions, subagent trees) [S]; tokscale and claude-code-log [B].
- **Pattern**: every local tool infers limits from token counts. The only server-reported limit figures are Claude's statusline `rate_limits` and Codex's windows.

## 3. Session replay and trajectory analysis
- **ATIF** (Harbor), current version `ATIF-v1.8` [V: harborframework.com/docs/agents/trajectory-format]
  - Top level: `agent{name,version,model_name}`, `steps[]`, `final_metrics`.
  - Each step: `source`, `message`, `reasoning_content`, `tool_calls`, `observation`, and `metrics{prompt_tokens,completion_tokens,cached_tokens,cost_usd}`.
  - `subagent_trajectories` since v1.7.
  - Emitted natively by OpenHands, mini-SWE-agent, Gemini CLI, Claude Code and Codex.
- **Docent** (Transluce): LLM-driven summarization, clustering (with re-clustering of the top failure modes) and search. Used in the Terminal-Bench paper's failure analysis [S].
- **"Automated Transcript Analysis for Detecting Flaws in Agentic Benchmarks"** (29 Jul 2026) [V: arxiv.org/abs/2607.27518]
  - Scanners check for ground-truth access, tool failure, guessing vulnerability and answer-format ambiguity.
  - Found verified issues in five benchmarks, but "scanner performance varied substantially across benchmarks, criteria and models".
- **"Strained Coherence"** (5 Jun 2026) [V: arxiv.org/abs/2606.07889]
  - The pattern: the agent acknowledges a problem, then proceeds anyway.
  - A Claude Sonnet 4.6 judge read 44 Terminal-Bench-2 trajectories, plus 43 for replication.
  - Flagged runs failed 94% of the time vs 46% unflagged (p=0.003).
  - The first flag came at a median of about 83–84% of the way through: late, small sample, and it needs model calls.
- **Loop heuristic with a published number**: SWE-Gym defines "stuck in loop" as the same action three times in a row. 32B models hit it on 29.4% of SWE-Bench Verified tasks, and fine-tuning cut that by 4.6–18.6% [S: arXiv 2412.21139, via snippet].

## 4. Evaluating agents on your own repos
- **Harbor** (Apache-2.0, 5.2k stars) [V: repo]
  - Runs Claude Code, Codex CLI, OpenHands and others in local Docker, Daytona, Modal and more.
  - A task is an instruction plus an environment plus tests [S].
- **Harbor Adapters and Harbor-Index** (arXiv 2609.04298; 3 Sep 2026, v3 10 Sep) [V]
  - 80+ benchmarks ported, checked with parity experiments.
  - 8 models run across 54 benchmarks.
  - Harbor-Index is 82 tasks from 29 benchmarks. No configuration passes more than 30%; the best, GPT-5.5 with Codex, reaches 28.0%.
- **Anthropic, "Demystifying evals for AI agents"** (9 Jan 2026) [V]
  - pass@k means at least one of k tries succeeds; pass^k means all k succeed. "pass@k for tools where one success matters, pass^k for agents where consistency is essential."
  - "20-50 simple tasks drawn from real failures is a great start."
  - Track "latency, token usage, cost per task, and error rates", and read the transcripts.
- **"Beyond Pass@k"** (11 Aug 2026) [V: arxiv.org/abs/2608.14711]
  - Harnesses commonly misuse the pass@k estimator by counting unit tests as attempts. On a synthetic benchmark this inflated scores by 0.85–0.97 absolute.
  - Single-rollout proxies track repeated runs poorly (Spearman ρ=0.417).
  - In a 5-task SWE-bench Verified pilot, the hidden-test pass rate was 0.80 but strict resolution was 0.20.
- **Arithmetic worth showing**: at a 70% per-trial success rate, pass@3 is 97.3% and pass^3 is 34.3%.
- **Evals built from real PRs**: I found no primary source from May–Sep 2026 [B].

## 5. Productivity and quality of AI-written code
- **METR** [V: metr.org/blog/2026-02-24-uplift-update/]
  - 2025 study: tasks took "19% longer" with AI (CI +2% to +39%).
  - Late-2025 re-run: returning developers −18% (CI −38% to +9%); new recruits −4% (CI −15% to +9%).
  - 30–50% of developers held back tasks they didn't want to do without AI. METR calls the new data "only very weak evidence" and is redesigning the study.
  - I found nothing newer [B].
- **DORA**
  - "ROI of AI-assisted Software Development (2026.01)": a modelled 39% first-year ROI for a 500-person org, with about 8 months to payback. Speedups of 35–40% on simple greenfield work and 10% or less on complex legacy code [S: InfoQ, 11 May 2026].
  - The 2025 report found 90% adoption [S].
  - I found no 2026 State of AI-assisted Software Development report [B].
- **GitClear, "The Maintainability Gap"** (page dated Jan 2026) [V]
  - Based on 623M changes, 2023–2026.
  - Two-week churn up 15%; duplicated blocks rose from 40.3 to 73.0 per million lines; moved or refactored code fell from 21% to 3.8%.
  - These are correlations with the adoption period; no individual change is attributed to AI.
- **DX, Q2 2026 State of AI Impact** (22 Jul 2026; 500+ orgs) [V]
  - AI-authored code is "52.7% of all code, up from just 24% two quarters ago". The method is not disclosed.
  - PRs per engineer per week: 1.94, up 37%.
  - Change confidence down 6.1%, and change-failure-rate volatility widened.
  - Innovation ratio flat at 57–58%.
- **Faros AI**: teams with high AI adoption merged 98% more PRs, but PR review time rose 91%, bugs per developer rose 9%, and PR size rose 154% [S].
- **Survival study**, Rahman & Shihab (23 Jan 2026) [V: arxiv.org/abs/2601.16809]
  - 201 projects, 200k+ code units.
  - Agent-written lines had a "15.8 percentage-point lower modification rate" (HR=0.842).
  - Corrective changes: 26.3% vs 23.0%, a small effect (Cramér's V=0.116).
  - "Per-agent variation exceeds the agent-human gap."
- **Attribution standards**
  - **Agent Trace v0.1.0** (RFC, Jan 2026; Cursor plus Cognition, Cloudflare, Vercel, git-ai, Amp and others) [V: agent-trace.dev]
    - Contributor types: human, ai, mixed, unknown. AI contributions record `model_id`.
    - Each range carries a `content_hash`.
    - Storage-agnostic: "local files, git notes, a database".
  - **git-ai** (Apache-2.0) [V]
    - Agents call `git-ai checkpoint`, and line attribution is stored in Git Notes.
    - Attribution survives rebase, squash and cherry-pick.
    - "Does not use AI or heuristics to 'detect' AI code". Works offline.

## 6. Rate-limit forecasting and cache analytics
- Methods in use:
  - Straight-line extrapolation inside a locally inferred block (ccusage) [V].
  - P90 of the last 8 days (Usage Monitor) [V].
  - Server-reported percentages and reset times (Claude statusline [V], Codex [S]).
  - CodexBar: undocumented [V].
- I found no published accuracy evaluation for any of these forecasters [B]. Codex issue #42007 shows usage can jump non-linearly.
- Cache: Claude Code now diagnoses its own cache misses (section 1).

## Top 12 observability, cost and evaluation capabilities for a local-first control surface (ranked)

1. **A per-prompt waterfall built from Claude Code's beta traces.**
   - Why: it separates model time (`ttft_ms`, retries), tool execution, and time spent waiting on the human for permission (`tool.blocked_on_user`). All of it is observed. It also nests subagents.
   - Local feasibility: high. Add a traces receiver to the existing loopback collector. Gate on version, and show "not reported" when spans are absent.
   - Evidence: [V], but the feature is beta.
2. **The statusline JSON as an observed-state feed.**
   - Why: it is the only authoritative source for Claude's 5 h and 7 d usage and reset times, cache warmth, expiry and miss causes, `pr` and `effort`.
   - Local feasibility: high. Use a Wanigan-injected statusLine command that posts to loopback and chains to the user's own statusline. It is absent for API-key accounts; say so rather than estimate.
   - Evidence: [V]. Usage Monitor v4 already uses this feed, with provenance labels.
3. **Limit forecasts built on observed percentages.**
   - Why: it replaces guessing plan caps from token counts. Example: "at the last 30 min's observed rate, reaches 100% ≈14:40; resets 15:10 (observed)". Flag sudden jumps, and refuse to forecast from fewer than 2 samples.
   - Local feasibility: high.
   - Evidence: the fields are [V]; forecast accuracy is unpublished [B].
4. **A paired-trial runner for the experiments registry.**
   - Why: it unblocks the causal claims AGENTS.md currently forbids. It runs k repeats per arm at a pinned commit and reports pass@k and pass^k with n, plus cost per solved task with failed trials included. A `TRACEPARENT` per trial parents every span to that trial. Tasks come from 20–50 of the user's own PRs and failures.
   - Local feasibility: medium. Runs in worktrees or Docker, and spending tokens needs explicit consent and a budget. Harbor could serve as the runner.
   - Evidence: [V] for the Anthropic guidance, the ρ=0.417 finding and Harbor.
5. **A trial and session diff view.**
   - Why: this is the hosted-platform view local tools lack. It aligns two runs step by step: tools, files touched, tokens, cache ratio and outcome.
   - Local feasibility: high once items 1 and 4 exist.
   - Evidence: [S].
6. **Joins from session to commit to PR.**
   - Why: `vcs.ref.head.revision`, `OTEL_METRICS_INCLUDE_REPOSITORY` and statusline `pr` link these observed identities. That supports cost per merged PR, labelled as an association.
   - Local feasibility: high. Needs v2.1.269+ and the details flag.
   - Evidence: [V].
7. **A local authorship ledger, with survival and rework curves per repo.**
   - Why: the population-level reports disagree. GitClear shows churn rising, while the survival study shows agent lines being modified less. Write ranges and content hashes from hooks into SQLite, and export them as Agent Trace. Use git notes only on explicit opt-in, because AGENTS.md says not to write into user repos.
   - Local feasibility: medium. Remapping attribution through rebases is the hard part.
   - Evidence: [V].
8. **Spend attributed by skill, plugin, MCP server, subagent, effort and query_source.**
   - Why: it lets the learning engine state what a projected skill costs, and it makes auxiliary and compaction spend visible.
   - Local feasibility: high. The attributes are already on existing metrics, but names are redacted unless the details flag is set.
   - Evidence: [V].
9. **A prompt-cache panel.**
   - Why: it shows hit ratio, misses with the cause Claude Code diagnosed, and "idle past `expires_at` re-caches `recache_tokens_if_cold` tokens". For Codex, derive the same from `cached_input` and label it derived.
   - Local feasibility: high.
   - Evidence: [V].
10. **Loop and stuck reason codes.**
    - Why: rules include the same tool with the same argument hash three times in a row, the same file edited between repeated failing tests, repeated 429 or 529 errors, and PreCompact thrash. Show the rule and its evidence rows, never a score.
    - Local feasibility: high.
    - Evidence: the thresholds are weak [S]. Model-judged signals come from small samples and fire late [V].
11. **Codex parity: OTel events plus rate-limit windows.**
    - Why: the same timeline and cost views for the second harness, including reasoning and cached token types.
    - Local feasibility: high, if the config can be injected without editing `~/.codex/config.toml` (unverified).
    - Evidence: [V] and [S].
12. **ATIF export and import, local full-text search, and optional consented failure clustering.**
    - Why: portability to Harbor and Phoenix without a cloud tier. Clustering must go through the backend that produced the data and be labelled as model-judged.
    - Local feasibility: high for export and search. Clustering spends tokens.
    - Evidence: [V] for ATIF and the scanners paper; [S] for Docent.

## Things I could not verify
- **Primary sources I did not read**: OTel v1.41/v1.42 dates; Faros, LinearB and DORA figures (InfoQ only); Copilot's GA date and new fields; Cursor's detection mechanism.
- **Codex specifics**: exact metric names; rate-limit field names; whether `-c` or `CODEX_HOME` can inject `[otel]` without touching the user's config.
- **Accuracy claims**: Usage Monitor's "95% accuracy"; CodexBar's pace algorithm; how closely ccusage blocks match Anthropic's real windows.
- **Conflicting dates and figures**:
  - GitClear's publication date: the page says Jan 2026, a snippet said Jun 2026.
  - DX: a snippet cites "27.4% of production code", but the Q2 page says 52.7%.
  - Per-agent survival rates (Claude Code 41.0% and others) appeared in a snippet, not the abstract.
  - Claude Code Analytics API retention: the docs say no deletion period, a snippet said 90 days.
- **Harbor**: whether a `harbor view` command exists, and the task-file layout.
- **Research details**: Docent's features; SWE-Gym's 29.4% figure; "same-file edit loops are the top failure cause".
- **Hosted platforms**: specific LangSmith, Braintrust and Weave features.
- **Not found**: METR after Feb 2026, a 2026 DORA State report, Jellyfish, tokscale, claude-code-log, and a May–Sep 2026 study on evals from real PRs.
