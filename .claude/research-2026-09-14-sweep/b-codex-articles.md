# B — OpenAI Codex articles and announcements (1 Aug – 14 Sep 2026)

Researcher slice B. Compiled 14 Sep 2026.

Labels: **[V]** read on the primary page this session · **[S]** second-hand · **[B]** blocked/unreadable.
Where Wanigan's own source was checked, that is marked **[W]** (grep of `/Users/dane/Projects/drupal/wanigan-gaps/src`).

Model names used below appear on primary OpenAI/Codex sources read this session: `gpt-6-astra` (openai/codex releases 0.153.1–0.154.0, developers.openai.com/api/docs/models/gpt-6-astra, learn.chatgpt.com/docs/models), `gpt-5.6-sol|terra|luna`, `gpt-5.3-codex-spark`. No other model names are repeated.

## Sources read (primary)

| Source | Date | Label |
|---|---|---|
| openai/codex GitHub releases rust-v0.146.1 … rust-v0.154.0, python-v0.154.0 (`gh release view`) | 5 Aug – 10 Sep 2026 | [V] |
| Codex changelog https://learn.chatgpt.com/docs/changelog (developers.openai.com/codex/changelog redirects here) | entries 7 Aug – 11 Sep | [V] |
| What's new digest https://learn.chatgpt.com/docs/whats-new | weekly to 11 Sep | [V] |
| Blog: "Rethinking skills and prompts for GPT-6 Astra" https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra | 11 Sep 2026 | [V] |
| Blog: "Automating repetitive work at OpenAI with Codex" (Runme + WebMCP) https://developers.openai.com/blog/automating-repetitive-work-at-openai-with-codex | 25 Aug 2026 | [V] |
| Blog: "Scaling cyber defenders with Daybreak" https://developers.openai.com/blog/scaling-cyber-defenders-with-daybreak | 21 Aug 2026 | [V] |
| Blog: "Codex as a platform: build on the open agent harness" https://developers.openai.com/blog/codex-as-a-platform | 19 Aug 2026 | [V] |
| Blog: "Custom Code Review rules for Codex" https://developers.openai.com/blog/custom-code-review-rules-for-codex | 20 Jul 2026 (just before window; linked from current AGENTS.md doc) | [V] |
| Docs (undated, current): worktrees, code-review, auto-review, AGENTS.md, rules, hooks, app-server, config-reference, long-running-work, notifications, slash-commands, permission-modes, import, models, pricing, speed, non-interactive-mode, subagents, security/cli — all under https://learn.chatgpt.com/docs/… | current 14 Sep | [V] |
| API model page https://developers.openai.com/api/docs/models/gpt-6-astra | current | [V] |
| GPT-6 Astra System Card https://deploymentsafety.openai.com/gpt-6-astra | changelog 9 Sep 2026 | [V] (monitorability section) |
| openai/codex merged PRs (#40308, #40315, #42039, #42101, #42354, #42358, #42372, #44701, #44870, #44948, #44970, #45089, #45090, #45409, #45506, #45516) via `gh pr view` | 24 Aug – 14 Sep | [V] |
| openai/codex Discussions (#40290, #40309, #41623, #41635, #41780, #42041, #42402, #42965, #44291, #44368, #44453, #45238, #45284, #45392) via GraphQL | 23 Aug – 14 Sep | [V] (practitioner claims, not OpenAI) |
| Local `codex` 0.154.0 binary `--help` output (`doctor --json`, `review`, `migrate-rollouts`, `app-server daemon`, `exec` flags) | 14 Sep | [V] |
| HN: "GPT-6 Astra in code review: Gains, privacy, and cost" https://news.ycombinator.com/item?id=49572875 ; "Ask HN: Initial Thoughts on GPT-6 Astra?" https://news.ycombinator.com/item?id=49571621 (Algolia API) | 5 Sep 2026 | [V] (comments) |

---

## (1) Candidate items

Ordered roughly by value to a one-operator review surface. Effort: S (days), M (a week or two), L (more).

### 1. Instruction and skill budget meter for Codex, with model-switch lint
- **What / mechanism.** Codex silently truncates and shortens what it loads: `project_doc_max_bytes` caps the concatenated AGENTS.md chain at **32 KiB** and stops adding files past it; `skills.max_context_tokens` caps the available-skills catalogue at **2% of the model's context window, explicit values capped at 10,000 tokens**, and when too many skills are installed "Codex starts shortening their descriptions to fit". Discovery is one file per directory (`AGENTS.override.md` → `AGENTS.md` → `project_doc_fallback_filenames`), root-down concatenation. OpenAI's 11 Sep post gives concrete anti-patterns that a deterministic lint can catch: over-broad skill descriptions ("Use when working with databases…" vs "Use when adding or changing a migration"), "Before every edit, read architecture.md…", strong stop-and-ask boundary language written for earlier models (Astra "could take it too seriously and may stop work"), instructions to run tests that Astra now does unprompted, and a skill root that is not a minimal router (progressive disclosure). It also says "Guidance that helps Sol or Luna may overconstrain GPT-6 Astra" — i.e. the audit should rerun when the session model changes.
- **Who.** OpenAI docs + blog; practitioners shipped read-only auditors: Harness Lens (Defined / Resolved / Observed / Evaluated claims kept separate) and Skill Sunset ("TEST is not RETIRE").
- **URLs.** config-reference https://learn.chatgpt.com/docs/config-file/config-reference [V]; AGENTS.md doc https://learn.chatgpt.com/docs/agent-configuration/agents-md [V]; blog 11 Sep 2026 [V]; Harness Lens https://github.com/openai/codex/discussions/40309 (24 Aug) [V]; Skill Sunset https://github.com/openai/codex/discussions/41635 (30 Aug) [V]; skill budget PR #38978 in 0.148 changelog [V].
- **Why it matters.** Wanigan's Context view already meters Claude's MEMORY.md prefix and import chain; the Codex half of the same question ("what did this session actually see, and what fell off the end?") is unmetered. Wanigan's learning engine also writes into AGENTS.md / `.agents/skills`, so it can push a repo over the 32 KiB or 2% line itself.
- **Effort.** M (resolver + meter S; lint rules S each). Entirely local, no model call.

### 2. `## Code Review Rules` in nested AGENTS.md, applied by changed-file scope, with a rule test bench
- **What / mechanism.** Codex Code Review reads a `## Code Review Rules` section from the AGENTS.md closest to the changed code, applies only rules whose scope covers the diff, and cites the rule in the finding. Each rule states the invariant **and a safe path**. OpenAI's eval: rule-guided review recovered 98% of required custom findings vs 58.3% baseline. Their test protocol: one change that should trigger the rule, one safe counterexample, one unrelated change — the first must produce a finding, the other two no noise. Formatting/lint stays in CI.
- **Who.** OpenAI (the openai/codex repo itself keeps review rules in AGENTS.md).
- **URLs.** https://developers.openai.com/blog/custom-code-review-rules-for-codex (20 Jul 2026) [V]; AGENTS.md doc "Add code review rules" [V].
- **Why it matters.** Wanigan already sends diff-line review notes and runs review-gate recipes. Collecting the scoped rules for the changed paths, handing them to whichever reviewer runs (Claude or Codex), requiring a rule citation, and offering the three-case bench before a rule is trusted gives the operator a way to know a rule works rather than hoping. Compatible with the learning engine projecting "instructions/rules" through the review inbox.
- **Effort.** M. Local; the reviewer call itself spends tokens and must be explicit.

### 3. Honour `.worktreeinclude`
- **What / mechanism.** A repo-root `.worktreeinclude` lists gitignored paths / gitignore-style patterns to **copy** into a managed worktree (`.env`, `config/secrets.json`). Codex copies only ignored files that match, skips source symlinks, never overwrites an existing file, and auto-copies an ignored `AGENTS.override.md`.
- **URLs.** https://learn.chatgpt.com/docs/environments/git-worktrees [V].
- **Why it matters.** [W] `src/main/worktrees.ts` hard-codes `COPY_FILES` (`.env`, `.env.local`, `auth.json`, `.npmrc`, …) and `LINK_DIRS`. A repo-declared list that Codex also honours means one file serves both harnesses and the operator stops editing Wanigan to add a project's odd config file.
- **Effort.** S. Local.

### 4. Worktree lifecycle parity: start from dirty branch, hand off to Local, retention with snapshot-before-delete
- **What / mechanism.** Codex app worktrees: choose the starting branch *including current uncommitted changes* (applied to the detached-HEAD worktree); **Handoff** moves a chat and its code between the worktree and the local checkout (handles the one-branch-one-worktree rule, returns to the same worktree later); "Create branch here" with a `codex/` prefix; **retention**: keeps the most recent 15 managed worktrees, never auto-deletes pinned / in-progress / permanent ones, **saves a snapshot before deleting** and offers restore when the chat is reopened; configurable worktree root. CLI: `--worktree` / `/worktree` became default-on (#44870, merged 11 Sep, not yet in a stable tag).
- **URLs.** worktrees doc [V]; PR https://github.com/openai/codex/pull/44870 (11 Sep) [V]; 0.154.0 release (9 Sep) [V].
- **Why it matters.** Wanigan has worktree-per-session with merge/discard. Handoff-to-local (so the operator can run the one dev server they have) and snapshot-before-prune are the two lifecycle steps a reviewer needs that merge/discard do not cover. Note the CLI `--worktree` itself is a known gap; the lifecycle pieces here are not.
- **Effort.** M. Local.

### 5. Price ChatGPT-plan Codex sessions in credits, with Fast and long-context multipliers
- **What / mechanism.** OpenAI publishes a credits-per-1M-token rate card: GPT-6 Astra 250 / 25 cached / 1,250 out; GPT-5.6 Sol 100/10/500; Terra 50/5/300; Luna 5/0.5/30 (Daybreak Blue = Sol rates, Red 312.5/31.25/1875). **Fast mode = 2.5x credits** for GPT-5.6/5.5 and Astra (2x for 5.4); `/fast on|off|status`, `service_tier = "fast"`. API list price for Astra: $10 in / $1 cached / **$12.50 cache write (1.25x)** / $50 out; **>272K input tokens → 2x input and cache, 1.5x output for the whole request**; Batch/Flex 50%; Fast 2x. The app-server itself now shows "estimated credits and USD cost" per task for Business/Enterprise (#44970, 12 Sep). Python SDK adds `turn_service_tier` for one turn.
- **URLs.** pricing https://learn.chatgpt.com/docs/pricing [V]; speed https://learn.chatgpt.com/docs/agent-configuration/speed [V]; API model page [V]; PR #44970 [V]; python-v0.154.0 release (10 Sep) [V].
- **Why it matters.** [W] `spend.ts` deliberately counts Codex plan sessions as "unpriced" rather than zero. A published rate card lets Wanigan show an *estimate in credits* (a unit the user's plan actually spends) beside the unpriced count, without ever calling it a bill; Fast turns and >272K requests are exactly where estimates silently go wrong.
- **Effort.** S. Local.

### 6. Reroute and usage-fallback evidence: record the model that actually answered
- **What / mechanism.** app-server notifications `model/rerouted { threadId, turnId, fromModel, toModel, reason }` and `model/safetyBuffering/updated { …, fasterModel }`; thread metadata gained nullable `model` and `reasoningEffort` (0.153.0). TUI **Luna Reserve**: when included usage is exhausted, eligible tasks are *automatically* switched to Luna Reserve, the prior model/effort saved, and restored after a fresh usage read confirms recovery; app-server rate-limit snapshots expose `normalModelSlug` (#42372, #42358, 2 Sep). Earlier warning when <50% of the 5-hour window remains (#42142, 0.153.0). 0.153.4 made Astra the bundled default when no model is configured.
- **URLs.** app-server doc https://learn.chatgpt.com/docs/app-server [V]; PRs #42372 / #42358 (2 Sep) [V]; release 0.153.0 / 0.153.4 (3–4 Sep) [V].
- **Why it matters.** Wanigan's values reject hidden routing — but the vendor now routes. The honest response is evidence: per-turn "asked for X, answered by Y, because Z", and a launch warning when a session with no pinned model will pick up a new, 2.5x-priced default. Spend attribution by requested model is wrong otherwise.
- **Effort.** S–M. Local. (Adjacent to the known app-server parity gap, but none of these notifications is on that list.)

### 7. Daemon-aware Halt and background-terminal cleanup
- **What / mechanism.** Codex now has a shared local app-server daemon (`codex app-server daemon start|stop|restart|version|bootstrap`; `codex agents` "Browse all agent sessions on the shared local app-server daemon") [V local 0.154.0 help]. Unified-exec background terminals outlive a turn; app-server exposes `thread/backgroundTerminals/list|terminate|clean` (experimental). #44870 blocks worktree creation when the daemon lacks `thread/backgroundTerminals/list` and tells users to run `codex app-server daemon update`. TUI history now shows "input sent to background terminals" (0.153.0). `/import` "isn't available … while connected to a local app-server daemon".
- **URLs.** app-server doc [V]; PR #44870 (11 Sep) [V]; import doc https://learn.chatgpt.com/docs/import [V]; 0.154.0 notes (Windows shared background server) [V].
- **Why it matters.** [W] Wanigan has no daemon handling. If a Codex session's work lives in a daemon or a background terminal rather than the PTY's process tree, the global Halt switch can report success while a dev server or turn keeps running. Needs a probe (does a PTY-launched TUI attach to the daemon on macOS?) and, if so, a Halt that also lists/terminates background terminals.
- **Effort.** S to verify, M to implement. Local.

### 8. Rollout-format drift guard (compressed rollouts, migration, removals)
- **What / mechanism.** `local_thread_store_compression` compresses cold rollout files including shared/forked histories (#42039, 1 Sep); compression is coordinated with active writers (#44138, 9 Sep); `codex exec resume` reads through a "compressed-rollout reader". `codex migrate-rollouts [--apply] [--json] [--max-mib-per-second]` "Inspect or migrate legacy local sessions to paginated thread history" [V local help; PR/date not found]. `thread/rollback` removed (#44915, 11 Sep). A practitioner reader reports partial trailing lines, torn records after upgrades, silent field renames, command output stored four times (a 12-day session reached 1.4 GB), and terminal events `task_started`/`task_complete` (decoder also accepts `turn_started`/`turn_complete`) plus retained aborted events.
- **URLs.** PR https://github.com/openai/codex/pull/42039 [V]; discussion https://github.com/openai/codex/discussions/45392 (14 Sep) [V].
- **Why it matters.** [W] `codex-sessions.ts` / `codex-usage.ts` read `~/.codex/sessions/**/rollout-*.jsonl` and have no compression handling. A compressed or migrated rollout would read as "no usage" — the zero-case trap Wanigan's own memory warns about. Guard: detect non-JSONL/compressed members and report "unreadable by this version" rather than 0; prefer app-server `thread/read`/`thread/turns/list` where available; show rollout disk size per session.
- **Effort.** S (detect + honest state), M (app-server read path). Local.

### 9. Headless worker terminal states: DONE / FAILED / STALL, plus a network-before-credential preflight
- **What / mechanism.** `codex exec --json` emits `thread.started`, `turn.started`, `item.*`, `turn.completed`, `turn.failed`, `error`. Practitioner tool agent-watch: take the *last* terminal event as authoritative; process gone with no terminal event = **STALL** (usually stopped to ask a question). Separately: `workspace-write` has no network, and `gh` reports DNS failure in wording the model reads as "token invalid" — two runs "failed auth" with a valid token. Fix is `-c sandbox_workspace_write.network_access=true` (which, per the reply and docs, gives unrestricted egress unless `features.network_proxy` + `domains` is on). Their preflight reports `NET_DISABLED` vs reachable **with the credential unset in the probe process**, and only then checks auth.
- **URLs.** https://github.com/openai/codex/discussions/42041 (1 Sep) [V]; https://github.com/openai/codex/discussions/42402 (3 Sep) [V]; non-interactive doc [V]; config-reference `features.network_proxy.*` [V].
- **Why it matters.** Wanigan runs headless fan-out and a durable queue. A worker misreporting "auth failed" is a false cause the operator acts on; STALL vs DONE is the difference between a finished row and a silently abandoned one. (Verify whether Wanigan's headless runner already distinguishes STALL — not checked.)
- **Effort.** S. Local.

### 10. MCP call attribution from Codex `_meta`
- **What / mechanism.** Codex MCP request metadata now carries `threadId`, `sessionId`, originating `windowId` and optional `itemId`, retained for code-mode cells across waits and compaction (#45409, merged 14 Sep — not in a stable release yet).
- **URLs.** https://github.com/openai/codex/pull/45409 [V].
- **Why it matters.** Wanigan is an MCP server. Binding every inbound tool call to the exact Codex thread/turn item turns "some agent called us" into session evidence, and makes cross-session tools auditable.
- **Effort.** S. Local.

### 11. Structured "while you were away" recap
- **What / mechanism.** Codex TUI automatic recaps (`tui.auto_recap`, manual `/recap`), now fired after **30 minutes** (#45089); prompt uses up to eight answered exchanges plus the pending request, bounded to 32 KiB; response schema requires `summary` (≤700 chars) and nullable `next_action` (≤200), malformed/oversized responses rejected (#45090, 12 Sep). The long-running doc recommends asking for a status recap in a side chat so the main task is not interrupted.
- **URLs.** PRs #42101 (1 Sep), #45089, #45090 (12 Sep) [V]; long-running-work doc https://learn.chatgpt.com/docs/long-running-work [V].
- **Why it matters.** The attention queue says *that* a session needs the operator; a bounded summary + one next action says *why* without opening the transcript. Must be opt-in per session (it is a model call) or derived from recap items Codex already wrote.
- **Effort.** M. Model call if generated by Wanigan.

### 12. Side question without interrupting the running turn
- **What / mechanism.** `/side` "Start a temporary side chat without interrupting the main chat"; desktop docs: "Use a side chat when you want a status recap or an explanation without interrupting the main chat"; iOS keeps side-chat messages until closed (1 Sep). CLI: 0.146 "switch between side conversations without closing them" and temporary forks.
- **URLs.** slash-commands https://learn.chatgpt.com/docs/reference/slash-commands [V]; long-running-work doc [V]; What's new (0.146.0 entry) [V]; changelog iOS 1.2026.237 (1 Sep) [V].
- **Why it matters.** A reviewer's most common question ("what are you doing and why?") currently has to be steered into the live turn. A read-only, ephemeral side fork answered from the session's context keeps the main run untouched. Depends on the known `exec fork` gap for the Codex side.
- **Effort.** M. Model call (explicit).

### 13. Bind remembered approvals to an authorization identity
- **What / mechanism.** Codex Guardian caches low-risk approval results with an **authorization version** built from history-rewrite generation, genuine user-message count, and successful host-input responses (plus a root-task version for worker threads), and **revalidates at the moment of use**; a mismatch sends the action back to review. Regression test covers revocation while the classifier is in flight. Also 0.154.0: "reject approvals invalidated by new user instructions or answers"; 0.151.0: "Prevented stale Guardian classifications from authorizing actions after permission state changes".
- **URLs.** discussion https://github.com/openai/codex/discussions/41780 (31 Aug) [V] citing commit 035295b4 (not opened); 0.151.0 / 0.154.0 release notes [V].
- **Why it matters.** Wanigan's PreToolUse policy gate and trust levels decide on behalf of the operator. Any "allow for this session" memory should become stale when the operator changes trust level, rewinds a checkpoint, or sends a contradicting instruction — not merely after a timeout.
- **Effort.** S–M. Local.

### 14. Fail-before / pass-after evidence for a fix, or a recorded proof gap
- **What / mechanism.** Codex Security's fix workflow: "When feasible, the workflow adds a regression test that fails before the fix and passes afterward… If a reliable test can't be created safely, the workflow records the remaining proof gap instead of overstating what was verified."
- **URLs.** https://developers.openai.com/blog/scaling-cyber-defenders-with-daybreak (21 Aug) [V].
- **Why it matters.** Wanigan already has the launch commit and per-turn checkpoints, so it can run the named test at the pre-change state (temp worktree) and at head, and store the pair as evidence — or say "proof gap" in so many words. That is the exact estimate-vs-observed discipline the product promises.
- **Effort.** M. Local.

### 15. Coverage labels on review and scan evidence (Codex Security CLI output contract)
- **What / mechanism.** `npx @openai/codex-security scan <repo> --output-dir <outside-repo>` writes `scan-manifest.json` (target, scope, producer, sealed artifacts), `findings.json` (severity, confidence, locations, evidence, remediation), **`coverage.json` (`complete|partial|unknown`, deferred work, open questions)**, `report.md`, `exports/results.sarif`. Scopes: `--working-tree --base HEAD`, `--diff origin/main --head HEAD`, `--path`, `--mode deep`; `--dry-run` checks inputs "without starting Codex, loading credentials"; `--json`; `--patch --patch-severity high`. Local scans "use your operating-system permissions and don't pause for approval". Bulk: CSV inventory with pinned revisions, `--workers`, `--max-attempts`, resumable; "Treat estimated cost limits as estimates, not hard spending caps."
- **URLs.** https://learn.chatgpt.com/docs/security/cli [V]; Daybreak blog (21 Aug) [V]; What's new (CLI 0.1.5, late July) [V].
- **Why it matters.** Two uses: ingest a scan of a session's working tree as review evidence (explicit, costed), and — cheaper — adopt the `coverage` vocabulary for Wanigan's own review gates so "review passed" can say "partial: skipped X".
- **Effort.** M (ingest), S (vocabulary). **Non-local parts:** model calls (OpenAI, or `--provider` OpenRouter/Fireworks/Bedrock); requires Codex Security access; the CLI runs without approvals, so it must run under Wanigan's own gate.

### 16. Ultra effort is implicit fan-out — label it, and lint for delegation language
- **What / mechanism.** Models doc: reasoning level **Ultra = "Maximum reasoning with automatic task delegation"**, "uses subagents to accelerate complex work". Subagents doc: "Current local Codex releases delegate when you ask directly or when applicable AGENTS.md or skill instructions request it." Nested subagent tokens now count toward root goal budgets (#41183, 0.151.0). `features.multi_agent` exposes `spawn_agent`, `send_input`, `wait_agent`, `close_agent`.
- **URLs.** https://learn.chatgpt.com/docs/models [V]; https://learn.chatgpt.com/docs/agent-configuration/subagents [V]; config-reference [V]; 0.151.0 notes [V].
- **Why it matters.** [W] Wanigan already offers `ultra` where the model accepts it. Its guardrails say "do not silently spend tokens or fan out work": the picker should say Ultra fans out, spend should roll subagent tokens into the parent session, and instruction files the learning engine writes should never contain delegation-triggering phrases by accident.
- **Effort.** S. Local.

### 17. Instruction-file trust: pin AGENTS.md like executable config
- **What / mechanism.** 0.150.0: "Untrusted projects no longer supply project-level AGENTS.md instructions"; `projects.<path>.trust_level = "trusted"|"untrusted"` — untrusted skips project `.codex/` layers (config, hooks, rules); 0.154.0: "Startup avoids running workspace-controlled helpers before trust is established, and the macOS sandbox blocks terminal input injection."
- **URLs.** releases 0.150.0 (26 Aug), 0.154.0 (9 Sep) [V]; config-reference [V].
- **Why it matters.** Wanigan pins repo executable config including `.codex/`. Instructions are the prompt-injection surface: a changed AGENTS.md since the operator last trusted the repo deserves the same diff-and-confirm, and Wanigan can pass `projects.<path>.trust_level` explicitly rather than inherit whatever the user's config says.
- **Effort.** S. Local.

### 18. PR-keyed persistent review session (local reproduction)
- **What / mechanism.** Proposal for Codex GitHub review: key one session by repo + PR number; reuse it for every follow-up; serialize concurrent events and dedupe webhooks; refresh head SHA, review threads and CI status on each turn; archive on close/merge.
- **URLs.** https://github.com/openai/codex/discussions/45284 (13 Sep) [V] (idea, not shipped).
- **Why it matters.** Wanigan has `gh pr create` and review notes; a local "this PR's session" that is resumed (Codex UUID recovery already exists) and re-briefed with the new head SHA/CI state each time avoids fragmenting context across review rounds. Adjacent to the known issue-intake gap, but the keyed-persistence mechanism is distinct.
- **Effort.** M. Local (uses `gh` polling, not webhooks).

### 19. Cross-harness review panel with a severity re-assessment pass
- **What / mechanism.** HN practitioners: "a panel of review agents using models and harnesses different from the one implementing… an n×m matrix of agents and highly specific review prompts" (intent fulfilment, correctness, security, API conformity); then "review the review with another llm pass… only surface real P0 to P2"; reviewer in a fresh context. OpenAI subagents doc gives the canonical prompt: one subagent each for security, test gaps, maintainability, wait for all, summarise by category.
- **URLs.** https://news.ycombinator.com/item?id=49572875 (5 Sep) [V]; subagents doc [V].
- **Why it matters.** Wanigan uniquely holds both harnesses locally; "implemented by Claude, reviewed by Codex (or vice-versa)" is cheap for it. Must be an explicit, cost-previewed action.
- **Effort.** M. Model calls.

### 20. Invoice reconciliation and the long-context misclassification
- **What / mechanism.** Bedrock user: AWS billed $5,589 for 26–28 Aug; Codex JSONL + ccusage estimated ~$697. AWS classed ~424M tokens as long-context input that local telemetry recorded as cached input; asks whether requests crossed 272K. Reply: capture provider, model, input/cached/output, context size, retries, service tier, provider-reported usage per request, then reconcile against the invoice separately.
- **URLs.** https://github.com/openai/codex/discussions/41623 (30 Aug) [V]; API pricing threshold [V].
- **Why it matters.** Wanigan's spend views are estimates by construction. An "import invoice CSV → show the gap" step, and flagging requests whose context crossed 272K, is how an 8x under-count becomes visible in a day rather than at month end.
- **Effort.** M. Local.

### 21. `codex doctor --json` health panel per account
- **What / mechanism.** `codex doctor --json` "Emit a redacted machine-readable report"; `--summary`; checks added in 0.149.0: endpoint protection, network/proxy failures, desktop app state, update connectivity, storage (#38795).
- **URLs.** 0.149.0 release (20 Aug) [V]; local `codex doctor --help` [V].
- **Why it matters.** Wanigan manages several `CODEX_HOME` accounts. Running doctor per home and showing failing rows before launch replaces "session died at startup" with a named cause.
- **Effort.** S. Local.

### 22. Async questions that do not block the turn
- **What / mechanism.** `request_user_input_async` (structured questions with suggested choices, text-only) and `send_message_to_user_async` (free-form updates) let the model ask or report without ending the turn; exposed only when the model catalogue opts in (Astra guidance references it); feature flag for async user messages (#45124, 12 Sep). 0.154.0 TUI: "Answer questions inline while Codex continues working… without losing your main draft." iOS 1.2026.244 (8 Sep): "Answer live questions while Codex continues working".
- **URLs.** PRs #42178, #42354 (2 Sep), #44948 (12 Sep) [V]; 0.153.0 / 0.154.0 notes [V]; changelog iOS entry [V].
- **Why it matters.** The attention queue currently models "blocked on the operator". A non-blocking question is a new reason code with a different urgency, and a natural phone interaction (tap a suggested choice).
- **Effort.** M. Local. (Reachable only through app-server; the parity gap is known, this method is not on the list.)

### 23. Decision capture at wrap-up, and a discoverable run index
- **What / mechanism.** Runme at OpenAI: a notebook "goal" cell (review a previous run → write plan in the notebook → **wait for approval** → document commands, output, interpretation); at wrap-up "capture decisions that would otherwise disappear into the conversation: why one option was chosen, which approach is now preferred, and what someone should do differently next time"; each notebook gets a companion `*.index.md` so later runs can discover earlier outcomes.
- **URLs.** https://developers.openai.com/blog/automating-repetitive-work-at-openai-with-codex (25 Aug) [V].
- **Why it matters.** Wanigan's goals already do plan→implement→verify→review; a required "decisions and dead ends" step at close gives the learning engine better-cited signals than transcripts, and a per-goal index is a query-scoped briefing source.
- **Effort.** M. Local (the capture prompt is a model turn in the existing session).

### 24. Multi-repo session with a combined last-turn diff
- **What / mechanism.** Desktop multi-folder projects: a primary folder drives new chats, Git operations and discovery of AGENTS.md / skills / config.toml; secondary folders are readable/editable. Review pane "Last turn" shows the assistant's latest changes across all attached repos ("All repos"); other scopes per selected repo. CLI: `codex exec --add-dir <DIR>` (additional writable directories).
- **URLs.** code-review doc https://learn.chatgpt.com/docs/code-review [V]; What's new 23 Jul / 30 Jul entries [V]; local `codex exec --help` [V].
- **Why it matters.** Wanigan reviews across repositories but per session-per-repo. Work that spans an API repo and its client lands as two unrelated diffs; a session with declared secondary roots, per-root checkpoints and one last-turn diff matches how such changes are reviewed.
- **Effort.** M–L. Local.

### 25. Window capture into the composer (appshot pattern) and a floating status HUD
- **What / mechanism.** Appshots: press both Command keys (both Alt on Windows, 11 Sep) to send the frontmost window's screenshot **plus available text** to a chat; destination configurable. Pets controls: floating status (Running / Needs input / Ready / Blocked), `Option+Space` quick chat with `@` context and `$` skill, bell to follow threads.
- **URLs.** changelog 26.908 (11 Sep) [V]; notifications doc https://learn.chatgpt.com/docs/notifications [V]; What's new [V].
- **Why it matters.** Wanigan has attachments and notifications; capturing the app the operator is looking at (with its accessibility text, not just pixels) into a chosen session, and a global-hotkey composer that routes to a session, remove two context switches. The "pet" itself is out of scope.
- **Effort.** M. Local; needs macOS Screen Recording and Accessibility permissions.

### 26. Small ones
- **Review model override**: `review_model` config key; reviews "use a different model from the current session"; `chatgpt.reviewDelivery = detached`. [V code-review doc, config-reference]. S.
- **Per-MCP-tool output caps**: `mcp_servers.<id>.tools.<tool>.output_token_limit` (0.152.0, 1 Sep) and `tool_output_token_limit`; Wanigan's MCP client registry could project caps per tool. [V]. S.
- **Auto titles and unread**: unnamed tasks get descriptive titles, `/rename` suggests one (0.150.0); Activity view unread/running/waiting with "Mark all as read"; persistent manually ordered sections (0.147.0). [V]. S.
- **Hermetic headless runs**: `codex exec --ignore-user-config --ignore-rules --ephemeral --strict-config` for reproducible queue/cron rows. [V local help, non-interactive doc]. S. (Relevant to the known paired-trial bench.)

---

## (2) Extends-known-gap items

- **extends: Codex hooks** — `type: "mcp_tool"` hook handlers call a tool on an *already-connected* MCP server with `${tool_input.file_path}` templating that preserves JSON types; synchronous, same trust review; errors don't block; not for SessionEnd. `async: true` command hooks. `additionalContextLimit` (default ~2,500 tokens) spills oversized output to `<temp_dir>/hook_outputs/<session_id>/<uuid>.txt` with a head/tail preview. Wanigan's own MCP server could be the hook target with no shell script. Also `--dangerously-bypass-hook-trust` exists on `exec`. Hooks doc https://learn.chatgpt.com/docs/hooks [V]; 0.148.0 notes (18 Aug) [V].
- **extends: `--approve-for-me` reviewer agent** — per-turn circuit breaker (interrupt after 3 consecutive denials or 10 of the last 50 reviews); `/approve` approves *one retry of one exact* denied action (up to 10 recent denials recorded) via a developer-scoped marker that the reviewer still evaluates; `[auto_review].policy` replaces (does not merge) the policy; `auto_review.experimental_policy_template` with `{{ tenant_policy_config }}` (#45516, 14 Sep); Guardian risk scores recorded on threads (#38540) and auto-review state in turn metadata (#38046). OpenAI's advice — "fix the boundary first instead of teaching the reviewer to approve noisy escalations", mine `~/.codex/sessions` for past escalations — maps to Wanigan mining its policy ledger into narrow prefix rules. Auto-review doc [V]; PR #45516 [V]; 0.148 changelog [V].
- **extends: sandbox per trust level** — Codex `.rules` (Starlark) `prefix_rule(pattern, decision=allow|prompt|forbidden, justification, match=[…], not_match=[…])` with inline examples validated at load; compound `bash -lc` scripts split with tree-sitter when safe; `codex execpolicy check --pretty --rules <file> -- <cmd>` returns JSON of the strictest decision. A Wanigan trust level can compile to a rules file *and* show the operator a dry-run table. Also `features.network_proxy.domains` and `shell_environment_policy.filters`. Rules doc https://learn.chatgpt.com/docs/agent-configuration/rules [V] (undated; "experimental").
- **extends: app-server parity (`thread/inject_items`)** — Python SDK 0.154.0 `ExternalMessage`: external content can start a turn or join an active one "with tool-level authority; it does not grant user authorization". This is the provenance distinction Wanigan needs when it injects CI output, review notes or phone input: label as external, never as user instruction. Release python-v0.154.0 (10 Sep) [V].
- **extends: app-server parity** — other methods seen in the current doc and not on the known list: `turn/diff/updated` (aggregated unified diff per turn), `thread/shellCommand` (user-initiated, runs **outside** the sandbox), `account/usage/read` (token-activity daily buckets), `hooks/list`, `hook/started|completed`, `thread/tokenUsage/updated`, `configRequirements/read`, `permissionProfile/list`, `externalAgentConfig/detect|import`. app-server doc [V].
- **extends: cross-session messaging** — `@` task mentions submit "bounded live thread references" loaded with `read_thread`; the `codex_tui` tool namespace lets an agent list, read, wait on, create, fork, message, rename, archive and restore tasks, with delegation routed through an authenticated local MCP server with explicit approval prompts (#40308, #40315, 24 Aug) [V]. Practitioner "postbag" passes letters between a Codex and a Claude Code session through `codex queue` (discussion #44109, 9 Sep) [V title only].
- **extends: `review/start`** — non-interactive `codex review [--uncommitted | --base <BRANCH> | --commit <SHA>] [--title] [PROMPT]` subcommand [V local 0.154.0 help]; `/review` presets include "Review a commit" and "Custom review instructions" [V code-review doc].
- **extends: structured live transcript** — experimental context management (`features.context_management.experimental_mode`, 0.153.0; ChatGPT Plus/Pro/Pro Lite only): token-budget context, **history notes**, a `new_context` tool, and searchable earlier context windows instead of repeated compaction. The transcript should show window boundaries and notes as such, not as "compaction". System card [V]: Astra has *lower* chain-of-thought monitorability than Sol but *higher action-only monitorability* — supports reviewing actions (tool calls, diffs) over reasoning summaries. Models doc, config-reference, system card §9.1.3 [V].
- **extends: session export** — desktop "shared thread snapshots" redact known secret patterns (20 Aug; hosted link is out of scope, a local static export with the same redaction is not). codex-preserve: manifest with size + SHA-256 per member and a three-outcome verifier `PASS` / `FAIL` / `UNVERIFIABLE` (fail closed). Changelog 20 Aug [V]; discussion #45238 (13 Sep) [V]. Also `/export` Markdown (0.148.0) [V].
- **extends: Stop-hook "verified done" gating** — practitioner report of a false PASS: the agent tested a proxy (simulated time advanced) while the agreed human-observable criteria (intermediate states visible, Stop responsive) failed; asks for locked acceptance criteria carried across handoffs (discussion #40290, 23 Aug) [V]. OpenAI's goal guidance: Outcome / Constraints / Verification, "A requirement to stop for review after the first implementation will pull the model toward an earlier stopping point" (blog 11 Sep, long-running doc) [V]. DoneAudit and isitdone (#43532, #44153) do deterministic evidence checks [V titles/body].
- **extends: paired-trial bench / best-of-N** — OrcaReplay records model exchanges and replays with provider egress blocked; `orca compare last --models a,b,c --verify "npm test"` restores the git tree and runs each model in its own worktree with the verify exit code as verdict. Gotcha verified by the author: `model_providers.<name>.base_url` in config.toml wins over `OPENAI_BASE_URL`; override with `-c model_providers.<selected>.base_url=…` (discussion #44453, 10 Sep) [V].
- **extends: `codex agents`** — agents overview gained worktree session creation (#45276), archive/delete (#44433), model grouping (#44957), task tokens and estimated credits/USD (#44970), 10–13 Sep [V titles; #44970 body].
- **extends: fork at earlier turn** — Python SDK `include_turns` on resume/fork ("History selection changes the returned response, not model context"); forks preserve multi-agent version at a turn cutoff (#43540, 7 Sep) [V].
- **extends: `AGENTS.override.md`** — auto-copied into managed worktrees when ignored (worktrees doc) [V].

---

## (3) Seen, rejected (out of scope by operator values)

- **Agents API (public beta)** — Codex harness as hosted cloud agents with OpenAI-hosted sandboxes (Releasebot summary [S]; API doc links present on changelog page). Cloud execution.
- **Codex cloud GitLab support (beta, 19 Aug)**, **Codex Security cloud continuous scanning**, **Codex Security Review on GitHub PRs** — hosted execution / webhooks. (Local pieces are item 15.)
- **Event-triggered scheduled tasks from Gmail/Slack/GitHub (25 Aug)** — ChatGPT web/mobile hosted; local reproduction is the known issue-intake gap.
- **Cloud browser sign-in**, **Sites hosting / co-editing / editable URLs** — hosted.
- **Computer History (13 Aug) and Chronicle** — turns cross-app activity into memories; continuous activity capture is vendor-telemetry-shaped.
- **Shared thread snapshot links** — hosted sharing (local redacted export kept in section 2).
- **Luna Reserve automatic model switch** and **Ultra automatic delegation** as behaviours to *emulate* — hidden routing / silent fan-out. Observing and labelling them is kept (items 6, 16).
- **Record & Replay → skill** (computer-use demonstration capture) — relies on computer use; not a review-surface helper.
- **Pets / whimsy**, **Codex Micro hardware** — not helpers (the status-HUD idea is kept separately, item 25).
- **`--dangerously-bypass-hook-trust`** — would undo hash trust.
- **Daybreak Blue/Red tiers** — access programmes, no local mechanism.
- **"Run many agents" dashboards** (CoCo, Orchestrator, VibeFuse, Command Center show-and-tells) — competitors; no new mechanism beyond known gaps.

---

## (4) Could not verify

- **openai.com/index/gpt-6-astra/** and **/gpt-6-astra-next-generation-work/** — HTTP 403 to both WebFetch and curl [B]. Launch-post claims (notes across context windows becoming Astra default "in the coming weeks", Trusted Access first on 3 Sep) come via Latent Space / 9to5Mac search snippets [S]. The Codex-side mechanism is confirmed on the models doc and 0.153.0 notes [V].
- **help.openai.com "Managing usage with GPT-6 Astra in Work and Codex"** — 403 [B]. Pricing doc covers credits instead [V].
- **Commit 035295b4 (Guardian authorization version)** — cited by discussion #41780; commit not opened.
- **`codex migrate-rollouts`** — present in local 0.154.0 help [V]; PR and date not found.
- **`ThreadInstructionsProvider` (#44701, 11 Sep)** — refreshable thread-scoped instructions (≤10,000 tokens, composed after global and before repository instructions, re-read at model-request boundaries). Merged in core; not verified whether app-server or `codex` CLI exposes it. If exposed, it would let Wanigan's Codex briefings refresh mid-session instead of being fixed at launch.
- **Whether a PTY-launched Codex TUI on macOS attaches to the shared app-server daemon by default** (item 7) — needs a probe.
- **Whether Wanigan's headless runner already distinguishes STALL** (item 9) — not checked.
- **`model/rerouted` introduction date** — present in current app-server doc; PR not located.
- **codex.danielvaughan.com "GPT-6 Astra Arrives" (3 Sep, updated 14 Sep)** [S] — contains a hooks example using `[[hooks.pre_tool_use]]` / `hooks.on_mcp_tool_result`, which does not match the documented event names (`PreToolUse`, `PostToolUse`, … `Interrupt`); treat its config snippets as unreliable. Its API figures ($10/$50, 1.05M context, 272K surcharge) do match the API model page [V].
- **"20 million active Codex users" (21 Aug)** — blog.mean.ceo / Releasebot [S].
- **agents-radar digest (csz0811/agents-radar #136)** labels #45284 as a Codex issue; it is a Discussion (idea). Other trend claims there are LLM-generated summaries [S].
- **Simon Willison** — tag page fetched; in-window Codex items are a game demo (7 Aug) and a Blender viewer (9 Sep); "Codex bundles LibreOffice" (1 Sep) seen only as a search snippet [S]. No new workflow mechanism.
- **Latent Space AINews "GPT-6 Astra"**, **Pragmatic Engineer** — not read; no in-window Codex workflow piece identified.
- **SEO/farm sources** (morphllm, blakecrosley, kingy.ai, mindstudio, catdoes, ustechautomations) — not used for any claim.
