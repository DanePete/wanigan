# C. Third-party helper tools for Claude Code: capability gaps for Wanigan

Researched 14 Sep 2026. Sources used this session:
- the awesome-claude-code resources CSV, sorted by `Date Added` (212 rows, newest 2026-09-14)
- `gh search repos` sorted by stars with `--updated >2026-07-01`
- HN Algolia Show HN posts since 2026-06-01, filtered to more than 8 points
- READMEs, and in a few cases docs or source, fetched with `gh api repos/<o>/<r>/readme`

Labels:
- [V] means I read it on the primary README, docs page or source file this session.
- [S] means it is second-hand: an awesome-list blurb, an HN title, or a search snippet.
- [B] means the source was blocked or not found.

"pushed" is the repo's `pushed_at` date from the GitHub API [V]. Stars were also read from the API [V].

I surveyed about 60 tools and read 55 READMEs. They are grouped below into 25 new capability items, 16 extends-known-gap items, a subsumed list and a rejected list.

---

## 1. Capability items: what Wanigan lacks

### 1.1 Semantic shell parsing and stateful policy rules (instead of string matching)
**Tools**
- **cc-safety-net**: https://github.com/kenryu42/cc-safety-net. ★1539, pushed 2026-09-14, MIT [V]
- **Dippy**: https://github.com/ldayton/Dippy. ★244, pushed 2026-06-12, MIT [V]
- **Probity** (successor to TDD Guard ★2341): https://github.com/nizos/probity. ★201, pushed 2026-09-14, MIT [V]
- **redstamp**: https://github.com/askalf/redstamp. ★4, pushed 2026-09-14, MIT [V]
- **hstack `probe-dedupe.sh`**: https://github.com/howardchan2008/hstack. ★3, pushed 2026-09-14 [V]

**Mechanism**
- Dippy parses bash with its own hand-written parser, Parable (14,000+ tests between the two).
  - It auto-approves read-only pipelines and chains, including `$(pwd)` substitution.
  - It blocks subshell injection (`git $(echo rm)`), writes hidden in redirects (`curl … > script.sh`, `tee`), and destructive chains as a whole.
  - Deny rules carry a steering message, for example `deny rm -rf "Use trash instead"`, so the agent keeps going instead of wasting a turn. Config lives in `~/.dippy/config` and `.dippy` [V].
- cc-safety-net parses what a command does, so wrapping it in `bash -c` or `python -c`, or reordering flags, does not hide it.
  - Secret-path rules cover Read, Edit, Write and Search tools as well as the shell.
  - Rulebooks (Terraform, AWS, gcloud, Azure) can only add blocks and can never loosen built-ins.
  - Three presets: Standard, Strict (blocks commands it cannot parse) and Paranoid.
  - `explain "<cmd>"` prints a step-by-step analysis trace. `logs` is a local decision audit trail without output or prompts.
  - "Linked-worktree mode relaxes only local discard" [V].
- Probity rules read the session transcript, so a rule can depend on what already happened.
  - `requireCommand()` means "tests must have run before commit".
  - `enforceTdd()` blocks production code before a failing test has been observed.
  - Rules are path-scoped.
  - A rule is either deterministic (string or regex) or AI-validated through the vendor SDK, which costs a turn [V].
- hstack `probe-dedupe` refuses the fourth look at a question already answered three times.
  - It matches on the subject of a probe, not its string: only 5 of 406 repeated shell calls in one audit were byte-identical [V].

**Why it matters:** Wanigan's PreToolUse gate matches strings (`rm -rf /`, force push, `curl|sh`, sudo). String rules miss wrapped or reordered commands and can't say "no commit until tests ran". A deny reason the agent can act on cuts wasted turns, and an `explain` trace lets the operator audit why the gate fired. Subject-level repeat detection would catch stalls earlier than Wanigan's "6 identical failures" rule.

**Effort:** M. Embed a parser or `checkCommand`-style library in main. Add sequence rules that read the recorded hook timeline.

**Non-local:** none.

### 1.2 Guard self-tests and a check that guards are actually live
**Tools:** hstack `tests/run.sh`, `wiring-verify.sh` and `doctor.sh` [V]; cc-safety-net `doctor` self-test [V].

**Mechanism**
- Every hstack guard is tested twice: once against a payload it must refuse and once against an ordinary payload it must let through. Either arm failing fails the suite.
- `wiring-verify.sh` checks that registered hooks are live, not merely present. It also flags any registered hook it does not recognise, because "an addition is as interesting as a deletion".
- `tests/parity.py` keeps the roster equal to the shipped set [V].
- cc-safety-net `doctor` runs a self-test and warns that legacy inline config "enforces nothing" silently [V].

**Why it matters:** Wanigan's own memory (gate blind spots) records bypasses found by running each check's regex. A block/allow fixture corpus for the policy gate, run at launch and shown in the policy ledger, turns "the gate is on" from a claim into a measurement. It also flags hooks Wanigan did not inject.

**Effort:** S.

**Non-local:** none.

### 1.3 Dependency-install gate
**Tool:** **deptrust**: https://github.com/clidey/deptrust. ★61, pushed 2026-08-19, MIT [V]

**Mechanism**
- A CLI and MCP server check `ecosystem package version` against OSV and the GitHub Advisory DB, including malware advisories.
- Recommendation: critical or high means block, medium or unknown means review, low or none means allow.
- A version published in the last 72 hours is flagged for review.
- It reports `advisory_coverage` as full, partial, none or error. When no provider covers the ecosystem it returns `unknown`, never "safe".
- GitHub Actions refs that can move (`v4`, `main`) get a review signal.
- An exact-version check that could not be registry-verified is never `allow` [V].

**Why it matters:** agents install stale or brand-new packages (slopsquatting). A PreToolUse check on `npm/pip/cargo add|install` is a clear policy-gate extension, and deptrust's honesty rules (unknown is not safe, and coverage is reported) match Wanigan's evidence doctrine.

**Effort:** M.

**Non-local:** yes. Queries go to OSV and `api.github.com` (optionally through the `gh` token). They must be an explicit, disclosed egress.

### 1.4 Credentials the agent process never sees
**Tools**
- **authsome**: https://github.com/agentrhq/authsome. ★90, pushed 2026-07-24, MIT [V]
- **claudit guard**: https://github.com/bharathkumar96g/claudit. ★1, pushed 2026-09-14, MIT [V]

**Mechanism**
- authsome: `authsome login github` does OAuth2 PKCE or device code once. `authsome run -- <cmd>` then starts the child behind a local HTTP proxy.
  - The proxy injects auth headers matched by the provider's `api_url`, so nothing lands in the child's environment.
  - Tokens are encrypted at rest and refreshed before expiry. It supports multiple accounts per provider [V].
- claudit `guard`: a masking proxy on `ANTHROPIC_BASE_URL`.
  - Detected secrets in the outbound request are replaced with pseudonyms and restored in the streamed reply, so a key typed or read into context travels as a pseudonym [V].

**Why it matters:** Wanigan launches real CLIs with the operator's environment. Brokered credentials shrink what a compromised or confused session can take away. Pseudonymising is the only listed mechanism that protects a secret after it has entered context.

**Effort:** L. It needs an HTTPS interception or explicit proxy design, and verification that the CLIs honour it.

**Non-local:** none beyond the services themselves.

**Caution:** OneCLI (https://github.com/onecli/onecli, ★3479) started as a local Rust credential vault but v2 is a team platform with a MITM gateway and a hosted option. See section 4.

### 1.5 Tool-output compaction with full-output recovery
**Tool:** **rtk (Rust Token Killer)**: https://github.com/rtk-ai/rtk. ★80,398, pushed 2026-09-14, Apache-2.0 [V]

**Mechanism**
- A PreToolUse hook on Bash rewrites the command before execution (`git status` becomes `rtk git status`). Since v0.37.2 it runs as a native binary (`rtk hook claude`).
- Per-command filters apply:
  - test runners show failures only
  - `git log` shows hash, author and subject
  - `git push` becomes "ok main"
  - lint output is grouped by rule
  - `rtk curl` truncates and saves the full output
  - some commands get "tee recovery", so the agent can fetch the full text
- `rtk gain` keeps a savings history. `rtk discover --all --since 7` scans past sessions for missed savings. `rtk session` shows adoption.
- The README is explicit that it measures bash-output reduction, "not the same as cutting your bill", and that token counts are `bytes/4` estimates.
- Built-in Read, Grep and Glob bypass the hook [V].

**Why it matters:** this is the highest-traction helper in the ecosystem right now. Wanigan already injects hooks from its user-data directory, so an opt-in output-compaction layer fits without writing into repositories. Wanigan's burn-rate and cache data could label the effect honestly, as an estimate unless paired.

**Effort:** M. Either wire rtk as an optional injected hook or build filters. A recovery path is mandatory, because a truncated failure is worse than a long one.

**Non-local:** none.

### 1.6 Cost attributed to its cause: idle cache rewrites, re-reads, dead-weight config
**Tools**
- **looptax**: https://github.com/ahian-lee/looptax. ★1, pushed 2026-07-27, MIT [V]
- **mcp-prune**: https://github.com/mstuart/mcp-prune. ★0, pushed 2026-09-01, MIT [V]
- **cc-audit**: https://github.com/pa-arth/cc-audit. ★9, pushed 2026-08-27, MIT [V]
- **CodeBurn `optimize`**: https://github.com/getagentseal/codeburn. ★11,014, pushed 2026-09-14, MIT [V]
- **CRUSTS**: https://github.com/Abinesh-L/claude-crusts. ★83, pushed 2026-08-31, MIT [V]

**Mechanism**
- looptax reads provider usage fields from the JSONL (`cache_read_input_tokens` and `cache_creation_input_tokens`, with the 5m/1h split), deduplicated by request id. It computes four "taxes":
  - **Idle tax:** cache writes after a gap of 5 minutes or more. The estimate is capped at the previous request's cached footprint, with the uncapped number shown as an upper bound.
    - Author's corpus: 1.3% of requests caused 22% of cache writes.
  - **Amnesia:** repeat `Read`s of the same file in the same stream, sized from tool_result chars/4, labelled as an estimate.
  - **Replay** and **retry.**
  - It never prices unknown models at $0, and it reports "no data" when a corpus has no compaction events [V].
- mcp-prune counts real `tool_use` per MCP server across `~/.claude/projects/**/*.jsonl`.
  - It classes servers as active, idle ≥7d, idle ≥14d, or never called, and tags scope (project, plugin or user).
  - `apply` shells out to `claude mcp remove` from the owning directory. Plugin servers are flagged but never auto-removed [V].
- cc-audit reports:
  - an "always-on context tax" (what CLAUDE.md, memory, skills, plugins and MCP cost every turn)
  - "avoidable carry" past the ~160K `/compact` line
  - a skill/MCP ROI ledger [V]
- CodeBurn `optimize` flags:
  - re-reads across sessions and low Read:Edit ratio
  - uncapped `BASH_MAX_OUTPUT_LENGTH`
  - ghost agents, skills and commands never invoked
  - bloated CLAUDE.md with `@-import` expansion counted [V]
- CRUSTS splits the live context into six categories: Conversation, Retrieved, User, System, Tools, State. When a threshold is crossed it writes a ready-to-paste `/compact focus "…"` command [V].

**Why it matters:** Wanigan meters spend, cache rate and context occupancy, but not *why* spend happened. Idle-gap rewrites and never-called MCP servers are fixable, operator-level causes. The honest-bounds method (a cap plus an upper bound, "no data" is not zero) fits the estimate grammar.

**Effort:** M. All inputs are in transcripts Wanigan already archives.

**Non-local:** none. cc-audit's `--judge` and `--open` upload data; exclude them.

### 1.7 A fix-and-verify loop for optimisation advice
**Tool:** **CodeBurn `optimize --apply` / `act`** [V]

**Mechanism**
- Every applied config fix is backed up and journaled. `act undo <id>` refuses if the files changed since.
- After three or more days, `act report` compares estimated savings against what sessions actually did. The verdict is worked, under estimate, or did not help.
- `--auto-revert` undoes fixes that measured no reduction, but never CLAUDE.md rules.
- Repeat runs classify findings as new, improving or resolved against a 48-hour window [V].

**Why it matters:** Wanigan's improvement scout proposes changes. Checking a change's effect after the fact, and offering a revert for "did not help", is the missing half. It mirrors the learning engine's undo-if-hash-matches rule. (CodeBurn's A–F "health grade" is a composite score and should not be copied.)

**Effort:** M.

**Non-local:** the CodeBurn CLI sends nothing. Its desktop app has opt-in telemetry [V].

### 1.8 Spend yield: shipped, reverted or abandoned
**Tool:** **CodeBurn `yield`** [V]

**Mechanism:** sessions are matched to git commits by timestamp window. Each commit is credited to the tightest session window containing it. Each session is then one of:
- Productive: commits landed in main
- Reverted: commits were later reverted
- Abandoned: no commits, or never merged
- Ambiguous: parallel sessions

The JSON carries `methodology: "timestamp-window"` [V].

**Why it matters:** this answers "did the money ship?" per project and model. Wanigan can do it *exactly* rather than heuristically, because every session has a worktree with a recorded merge or discard and per-turn checkpoints. It is a flagship review-surface number with a clean evidence label.

**Effort:** S–M.

**Non-local:** none.

### 1.9 Model and harness drift from your own history
**Tools**
- **claude-regression**: https://github.com/koreyshirey/claude-regression. ★0, pushed 2026-09-15, MIT [V]
- **CodeBurn `compare`** [V]
- **Piebald claude-code-system-prompts**: https://github.com/Piebald-AI/claude-code-system-prompts. ★12,668, pushed 2026-09-15, MIT [V]
- **ccxray system-prompt tracking**: https://github.com/lis186/ccxray. ★293, pushed 2026-09-09, PolyForm Noncommercial [V]

**Mechanism**
- claude-regression tracks a pre-specified primary metric: the per-request rate at which Claude concedes it was wrong.
  - Also tracked: output tokens and tool calls per request. Blind hand-labelling cross-checks the direction.
  - Bonferroni correction, and out-of-sample replication on later weeks.
  - It explicitly lists what the data cannot conclude, such as that model quality is the cause.
  - It warns that `cleanupPeriodDays` defaults to 30, so the baseline deletes itself [V].
- CodeBurn `compare` reports per-model:
  - one-shot rate: same file re-edited after a shell step counts as a retry
  - retry rate, self-correction, cost per edit, cache hit rate [V]
- Piebald tracks 515 prompt strings and token counts per Claude Code version, with a changelog across 289 versions [V].
- ccxray detects system-prompt versions from proxied requests and diffs them. It also reports "prompt hash stability", meaning how often the system, tools or core prompt changes between turns [V].

**Why it matters:** the operator runs several models and CLI versions. "Did behaviour change when the model or CLI version changed?" is a review question Wanigan can answer from its archive. It needs to record CLI version per session and carry paired-evidence labels (observational, not causal).

**Effort:** M.

**Non-local:** Piebald is a GitHub repo, so reading it is network. The local alternative is to record the CLI version and hash the assembled prompt.

### 1.10 Line-level agent attribution (AI blame)
**Tools**
- **Git AI**: https://github.com/git-ai-project/git-ai. ★2718, pushed 2026-09-14, Apache-2.0, release v1.7.5 on 2026-09-09 [V]
- **Atlas**: https://github.com/pacifio/atlas. ★4408, pushed 2026-09-14, MIT, Tauri app [V]

**Mechanism**
- Git AI Standard v3.0.0 stores authorship logs as Git Notes under `refs/notes/ai`, never `refs/notes/commits`.
  - The attestation section maps each file to keys plus line ranges.
  - `s_<14hex>::t_<14hex>` is an AI session plus a per-checkpoint trace. The session id is `SHA256("<tool>:<conversation_id>")[0..14]`.
  - `h_` keys mark known humans. Uncovered lines count as "untracked".
  - A metadata JSON section holds prompt records.
  - `git ai blame` is a drop-in `git blame`.
  - `git ai stats` reports `ai_additions` against `ai_accepted` and human overrides per tool and model.
  - Prompts are stored outside git, redacted [V].
- Atlas links commits to the producing session in `.atlas/sessions.db`, even when committed from another tool. Links survive rebase and amend [V].

**Why it matters:** Wanigan has per-turn checkpoints and a transcript per session, which is exactly the data needed. Emitting standard-compliant notes gives the operator "which session and which prompt wrote this line", readable by the existing Git AI editor plugins. It also gives accepted-versus-generated lines per model, a review metric no Wanigan view has.

**Effort:** M–L.

**Non-local:** none.

**Caution:** notes refs are repository metadata. Make this opt-in per repo and never push notes automatically, consistent with "never auto-commit a learned projection".

### 1.11 Decision ledger: agent-initiated choices surfaced for review
**Tools**
- **Grepathy**: https://github.com/evansjp/grepathy. ★67, pushed 2026-07-17, MIT [V]
- **add-reasoning-to-prs**: https://github.com/backthread/add-reasoning-to-prs. ★35, pushed 2026-09-10, MIT [V]
- **Selvedge**: https://github.com/masondelan/selvedge. ★23, pushed 2026-09-14, MIT [V, head only]

**Mechanism**
- Grepathy distils decisions from transcripts after the fact. It found that asking agents to log decisions mid-task does not work.
  - Each entry carries `Status: agent-initiated — not requested in plan or prompts`, `Touches:` globs, a risk note and a reviewer-attention line.
  - Two deterministic checks sit behind the summariser: a secret and finance scanner, and "every entry must point at real code".
  - Human edits and deletions are respected forever.
  - A PreToolUse hook injects matching entries before an agent edits a file with history [V].
- add-reasoning-to-prs is a PreToolUse hook on `gh pr create` or on a commit to the default branch.
  - If no "why" block is present, the command is refused until the agent writes one: Decisions, Trade-offs, Assumptions, Limitations.
  - Lines must trace to real decisions in the session. An empty block is valid for a routine change [V].
- Selvedge is an MCP server that agents call to log change events with reasoning into `.selvedge/` SQLite, including approaches tried and rejected [V].

**Why it matters:** the question a reviewer actually asks is "which choices did nobody approve?". Wanigan already owns transcripts, goals and plans, so it can diff decisions against the prompt and plan. It could show the ledger beside the diff and fill Wanigan's `gh pr create` body.

**Effort:** M.

**Non-local:** the distillation is a model call. It must go through the learning engine's consent, routing and metering gates, and the output belongs in Wanigan's DB, not `.ai/why/` in the repo.

### 1.12 Request-coverage ledger: did every ask get answered?
**Tools**
- **hstack** `prompt-items.py`, `carryover-queue.py`, `stop-justify.sh` [V]
- **mindwalk** task scorecard: https://github.com/cosmtrek/mindwalk. ★1333, pushed 2026-08-10, MIT [V]

**Mechanism**
- `prompt-items` splits the prompt into numbered items and re-injects them next turn. It carries a `--self-test`.
- `carryover-queue` treats an interrupt as a push onto a queue, never a cancel.
- `stop-justify` blocks ending the turn when any of these is true [V]:
  - the tree is dirty
  - commits exist on no remote, including a branch with no upstream whose ahead-count errors silently
  - a request item was never answered
- mindwalk `analyze` drafts criteria from the user's own request wording before scoring.
  - Every finding must cite clickable timeline events.
  - Verdicts are rolled up mechanically from finding severities, not decided by the model.
  - An unverifiable criterion reads "no signal", a blind spot rather than a failure [V].

**Why it matters:** Wanigan's attention queue says *finished*. It doesn't say "finished 2 of 3 asks". A per-session checklist derived from the composer message, with "no signal" states, is a review aid adjacent to but distinct from the Stop-hook verified-done gap.

**Effort:** M.

**Non-local:** mindwalk's evaluation is an explicit model call through the user's CLI. Splitting items can be deterministic.

### 1.13 Pause before the rate limit, resume when the window resets
**Tool:** **claude-powernap**: https://github.com/asiagenawi/claude-powernap. ★8, pushed 2026-07-18, MIT [V]

**Mechanism**
- A hook checks usage every ~2 minutes, every 30s above 80%, and on every event above 90%.
- At 90%, or when the burn rate projects the limit within 9 minutes, it injects a message into the live conversation: "you're at 91%, window resets at 3:00am, pause now".
- Claude writes a checkpoint file (done, in flight, next steps) and schedules a one-shot resume just after the reset.
- A launchd, systemd or Task Scheduler watcher reopens a hard-stopped session after reset, or notifies instead if the window is still open. It never forks a live session.
- There is an optional weekly guard, with no auto-resume.
- It reads Claude Code's OAuth token from the Keychain to query real usage. `endpoint_enabled: false` switches to local-only estimation [V].

**Why it matters:** Wanigan has usage limits, burn rate, a durable queue and cron. What it lacks is session-level graceful degradation: warn the *agent*, capture a checkpoint, then resume the same session at reset. That's the overnight-run failure the operator will hit.

**Effort:** M. It composes existing limits, queue and resume.

**Non-local:** the usage endpoint. Wanigan's `claude -p /usage` path already exists.

### 1.14 Porting a session between Claude Code and Codex
**Tool:** **claude-code-tools `aichat port`**: https://github.com/pchalasani/claude-code-tools. ★2000, pushed 2026-09-07, MIT [V: docs `tools/aichat/port.mdx`]

**Mechanism**
- Converts a Claude session into a native, resumable Codex rollout, or the reverse, with the full transcript as real conversation history rather than a summary.
- Source detection is content-first, and lineage is recorded to the untouched original.
- Lookup accepts id, partial id, `/rename` title or rollout timestamp. On ambiguity it shows a chooser and never guesses.
- It prints the exact resume command (`claude --resume <id>` or `codex resume <id>`) [V].

**Why it matters:** Wanigan runs both harnesses. Moving a stuck or rate-limited conversation to the other provider without losing history is a strong operator move.

**Effort:** M–L. Transcript formats are undocumented, so the round-trip must be verified end to end before claiming support.

**Non-local:** none.

### 1.15 Waking a session on an external event (GitHub reply or CI)
**Tool:** **claude-code-tools `github-wake`** [V: docs `tools/github-wake.mdx`]

**Mechanism**
- Registers a durable watch on an existing issue and runs one shared per-user daemon.
- The daemon polls once per repository with conditional requests, overlapping windows and retry-safe cursors.
- On the first new comment it delivers a normalised message to the originating session, wrapped as untrusted data. Delivery goes through Claude Code's `Monitor` tool, or the Codex App Server for Codex.
- State stores the gh config directory, not a token [V].

**Why it matters:** Wanigan has `gh pr create`, but no loop back from PR comments or check failures to the session that opened the PR. A watch with "untrusted" wrapping matches Wanigan's trust boundary.

**Effort:** M.

**Non-local:** GitHub API polling through the operator's `gh`.

### 1.16 Session process and port hygiene
**Tool:** **cctop**: https://github.com/stefanprodan/cctop. ★139, pushed 2026-09-01, Apache-2.0 [V]

**Mechanism**
- For each running session it shows PID, CPU, memory, uptime, host app, context size and model.
- A live sub-agent and sub-process tree lists open and *orphaned* TCP ports.
- `f` reclaims the orphan ports held by a session's leftover dev server (SIGTERM, with confirm). `x` quits a runaway session.
- It is read-only apart from its own preferences. `--capture-usage` reads the status-line stdin and persists 5h/7d limits [V].

**Why it matters:** parallel worktree sessions leave dev servers holding ports and CPU after they exit. Wanigan owns the PTYs, so it knows each session's process tree precisely. Showing and reaping orphans is a natural addition that the ports gap alone does not cover.

**Effort:** S–M.

**Non-local:** none.

### 1.17 Hook dry-run bench
**Tool:** **CC Harness**: https://github.com/lookfree/cc-harness. ★48, pushed 2026-08-06, MIT, Electron [V]

**Mechanism:** runs any hook with simulated input and shows stdout, stderr, exit code and the transformed result, without opening a real session. The environment is isolated to `PATH`, `HOME` and `TMPDIR`, with no API tokens or credentials [V].

**Why it matters:** the Context view already lists settings, hooks and MCP layers. A "run this hook against a sample PreToolUse payload" button turns the listing into something testable, and shares fixtures with 1.2.

**Effort:** S.

**Non-local:** none.

### 1.18 Visibility into Claude Code's own background features
**Tools:** **CC Harness** loop and background-task monitor, and its auto-memory diffs [V]; **claude-esp** parser [V: source `internal/parser/parser.go`].

**Mechanism**
- CC Harness aggregates `ScheduleWakeup` events across sessions and classes each as pending, fired or expired, with trigger history.
- It snapshots `MEMORY.md` before and after each auto-memory consolidation pass, showing added, deleted, modified, merged and conflict-resolved changes [V].
- claude-esp shows these transcript line types exist today, and Wanigan's source has no match for any of them (grep this session):
  - `system` subtypes `away_summary`, `api_error` (with retry progress), `compact_boundary` (with preTokens), `turn_duration`, `agents_killed`, `local_command`
  - top-level `continued-in`, `cost-state`, `queue-operation`, `pr-link`, `frame-link`
  - attachment types `deferred_tools_delta`, `mcp_instructions_delta`, `skill_listing`, `task_status`, `plan_mode_exit`, `auto_mode` [V]

**Why it matters:** Wanigan's cron and queue are its own. The CLI's native wakeups, loops and memory consolidation happen invisibly inside sessions Wanigan launched. Memory diffs matter doubly because Wanigan meters `MEMORY.md` but does not show what the CLI rewrote.

**Effort:** M.

**Non-local:** none.

### 1.19 Skill supply-chain review and a skill capability lock
**Tools**
- **NVIDIA SkillSpector**: https://github.com/NVIDIA/SkillSpector. ★17,210, pushed 2026-09-15, Apache-2.0 [V]
- **SkilLock**: https://github.com/skills-lock/skil-lock. ★4, pushed 2026-09-09, Apache-2.0 [V]

**Mechanism**
- SkillSpector scans a git repo, URL, zip, directory or single file.
  - 71 patterns in 17 categories, including prompt injection, exfiltration, MCP least privilege, MCP tool poisoning, memory poisoning, AST dangerous code, taint tracking and YARA.
  - Static first, with an optional LLM stage.
  - Fail-closed ingest caps: 100 MiB, 10,000 zip members.
  - A baseline file suppresses accepted findings, so re-scans show only new ones. SARIF output.
  - Its research subset: 26.1% of 31,132 skills vulnerable, 5.2% likely malicious [V].
- SkilLock pins each skill's *capability surface* in `skills.lock`: shell commands, network hosts, file reads and writes.
  - On change it computes the delta and blocks until a human approval entry is added.
  - Its scan of 17,065 skills: 38.8% execute shell commands, 4.0% declare it [V].

**Why it matters:** Wanigan installs plugins and marketplace skills and pins MCP by digest. A digest says *that* something changed. A capability delta says *what it can now do*, which is the review a one-operator surface should show at install and update time.

**Effort:** M.

**Non-local:** SkillSpector queries OSV.dev, with offline fallback. Its LLM stage is optional.

### 1.20 Exposure-path forensics: sensitive read followed by a way out
**Tools**
- **Confessor**: https://github.com/ninjahawk/Confessor. ★10, pushed 2026-07-11, MIT, zero network calls [V]
- **claudit**: https://github.com/bharathkumar96g/claudit [V]
- **Node9 `scan` / `posture`**: https://github.com/node9-ai/node9-proxy. ★213, pushed 2026-09-14, Apache-2.0 [V]

**Mechanism**
- Confessor replays `~/.claude/projects/**/*.jsonl` and extracts four things:
  - **Files:** read, written or edited via Read, Write and Edit, and via `cat`/`cp` inside Bash. They are classified against a path ruleset: `.env`, `~/.ssh`, `.aws/credentials`, browser password stores, shell history, tax and medical documents.
  - **Secrets in tool *results*:** what actually entered context. 30 secret patterns and 13 PII patterns, with Luhn checks.
  - **Sinks:** WebFetch and WebSearch, `curl`/`wget`/`scp`/`nc`/`git push`, and external MCP calls.
  - **Exposure paths:** a sensitive read followed by a sink in the same session, with the time gap. Presented as "a lead, not proof" [V].
- claudit records each secret appearance's origin: typed, assistant read, assistant wrote, assistant said, or thinking. It keeps one row per secret across sessions, with rotation state [V].
- Node9 `posture` lists credential files an agent could reach now and services bound to 0.0.0.0 [V].

**Why it matters:** Wanigan has an egress report and a hook timeline. Joining "read `.env`" to "curl POST 15s later" is the correlation that turns two logs into a finding. It sits next to the secret-scanning gap but is a different mechanism.

**Effort:** M.

**Non-local:** none.

**Caution:** Node9's score is a composite. Keep the findings and drop the grade.

### 1.21 Agent-written annotations on the diff, and a guided review tour
**Tool:** **hunk**: https://github.com/modem-dev/hunk. ★9272, pushed 2026-09-14, MIT [V: README and `docs/agent-workflows.md`]

**Mechanism**
- Each Hunk TUI registers with a local loopback daemon, and agents drive it with `hunk session …`. Session controls need an owner-private credential with signed responses.
- `session review --json` returns the file and hunk structure without the raw patch.
- `session navigate --file … --hunk 2` moves the *reviewer's* live view.
- `session comment add|apply` anchors agent notes to a hunk, old line or new line, with replies by id.
- Agents can remove human notes but cannot create or edit them.
- `--agent-context notes.json` loads pre-written rationale as a sidecar [V].

**Why it matters:** Wanigan's review notes flow human → session. The reverse, an agent explaining its own change inline and walking the operator through it, would reuse Wanigan's MCP server. The authorship boundary (agents can't author human notes) is the right one.

**Effort:** M.

**Non-local:** none.

**Caution:** Hunk's installer uses an "anonymous aggregate endpoint" for release discovery [V].

### 1.22 Codebase footprint replay
**Tool:** **mindwalk** [V]

**Mechanism**
- Draws the repo as a radial tree or treemap. Each file keeps its deepest touch state: seen, read, edited or unvisited.
- Deleted files linger as "ghosts". Friction signals include error rate, churned files and *edits after the last verify*.
- A playback histogram colours observation cool and mutation warm.
- Timeline marks show compactions, subagent launches and user turns. Subagent "lenses" replay each subagent on the same map.
- Client-side `.webm` export. It reads Claude Code, Codex and pi logs [V].

**Why it matters:** "did the agent's footprint match the scope I intended?" is a one-glance review question that Wanigan's diff view can't answer. The diff shows what changed, not what was explored.

**Effort:** M–L.

**Non-local:** none, except the explicit evaluate step.

### 1.23 Human-gated landing queue for parallel worktrees
**Tool:** **claude-code-merge-queue**: https://github.com/funador/claude-code-merge-queue. ★125, pushed 2026-08-24, MIT [V]

**Mechanism**
- `land` does a FIFO rebase and push onto the integration branch, so two lanes are never mid-push at once.
- `checkCommand` must pass. A pre-push hook rejects direct pushes.
- `build-lock -- <cmd>` serialises heavy builds machine-wide.
- `preview` mirrors a lane's live working tree, uncommitted changes included, onto the main checkout.
- Each lane gets `portBase + n`. `sync` fast-forwards the main checkout and reinstalls if the lockfile changed.
- `promote` is human-only [V].

**Why it matters:** Wanigan has merge and discard plus a conflict forecast, but nothing that serialises several approved merges, re-runs checks after each rebase, or locks shared builds. The build lock and preview mirror are independently useful.

**Effort:** M.

**Non-local:** none.

**Caution:** in the tool, agents land their own work once checks are green. For Wanigan, keep the queue but make entry a human approval (see section 4). It also writes CLAUDE.md, `.claude/settings.json` and husky hooks into the repo, which Wanigan must not do.

### 1.24 Scoped keep-awake with the lid closed
**Tool:** **Adrafinil**: https://github.com/kageroumado/adrafinil. ★475, pushed 2026-08-24, MIT, notarised [V]

**Mechanism**
- Sessions acquire and release reference-counted holds, round-tripping in under 50ms via hooks, an MCP tool or `adrafinil hold`.
- It uses `IOPMAssertion` for idle sleep and `pmset disablesleep` for clamshell (lid-closed) sleep, through a root helper exposing only `setSleepBlocked(Bool)`.
- A thermal cutout force-releases holds if temperature crosses a threshold with the lid closed.
- Holds are dropped when the owning process dies or goes CPU-idle.
- A chime plays on lid close. On lid open it summarises what ran, peak temperature, and whether the cutout fired [V].

**Why it matters:** Wanigan's `awake.ts` uses Electron `powerSaveBlocker`. The Adrafinil README says the cleaner IOKit paths do not keep a lid-closed Mac without a display awake. That's the exact overnight case, and the thermal cutout is the safety half.

**Effort:** S–M. It needs a privileged helper, which is a real trust-boundary change.

**Non-local:** none.

### 1.25 Transcript repair before resume
**Tool:** **claude-code-tools `fix-session`** [V: docs `tools/fix-session.mdx`]

**Mechanism:** finds conversation entries whose `parentUuid` points at a non-conversation entry (progress or subagent), relinks each to the previous conversation entry, and verifies the chain. It supports dry run and `.bak` in-place fixes. Upstream issue anthropics/claude-code#22107. It corroborates claude-esp's observed `cache_miss_reason.type = previous_message_not_found` [V].

**Why it matters:** Wanigan offers resume and pin. A pre-resume chain check ("this session will resume with N messages missing") is honest and cheap.

**Effort:** S.

**Non-local:** none.

---

## 2. Extends-known-gap items (materially new mechanisms only)

- **Extends status-line `prompt_cache`.** Cause-attributed cache busts come straight from the transcript: `assistant.diagnostics.cache_miss_reason` `{type, cache_missed_input_tokens}`.
  - Observed types: `tools_changed` (the tool list mutated, common after ToolSearch) and `previous_message_not_found`. From claude-esp https://github.com/phiat/claude-esp, ★153, pushed 2026-09-07, MIT [V: source].
  - This needs no proxy.
  - ccxray adds: plan detection from `cache_creation` fields; a cache-TTL countdown with a plan-aware lead time (5 minutes on Max, 60 seconds on Pro or API key); "cache hit rate by inter-turn gap"; and a 5m/1h TTL split per turn [V].
- **Extends status-line `rate_limits`.**
  - claude-statusbar (https://github.com/leeguooooo/claude-code-usage-bar, ★373, pushed 2026-09-13, MIT) shows end-of-window projections (`→NN%`) and a prompt-cache countdown. Optional per-model weekly caps read the OAuth credential and call an undocumented usage endpoint, off by default [V].
  - cctop `--capture-usage` persists limits piped from the status-line stdin [V].
- **Extends ExitPlanMode plan gate.**
  - Plannotator (https://github.com/backnotprop/plannotator, ★8687, pushed 2026-09-14, Apache-2.0) now annotates any markdown file, folder, URL, rendered HTML artifact and *agent replies*, and sends the annotations back as the agent's next message. It also reviews PRs and MRs with AI comments.
  - Its app checks GitHub for releases on load, with no opt-out [V].
  - MDXG Redline (https://github.com/oubakiou/mdxg-redline, ★13, pushed 2026-08-11, MIT) exports comments as JSON keyed by `headingPath` + `sourceLine` [V].
- **Extends Stop-hook verified-done gating.** groundtruth (https://github.com/veltiq/groundtruth, ★3, pushed 2026-08-02, MIT) grades the claims in the final summary against the diff, with zero LLM calls.
  - Claim types: file touched, symbol present in added or removed code, test file changed or test command ran, manifest changed.
  - Verdicts are verified, unsupported or review. It deliberately leans toward silence, so vague claims become review, never failure. SARIF and markdown output.
  - An opt-in verify loop holds Stop until the agent checks behaviour by kind of work (screenshot, run, hit endpoint, test), with a round cap. It cites MSR'26: 45.4% of message-vs-code inconsistencies are claimed-but-unimplemented changes [V].
  - This is a different check from "tests pass", and it suits Wanigan's final-message review directly.
- **Extends secret scanning.**
  - claudit [V]:
    - 235 patterns, 218 of them vendored from gitleaks
    - detection runs inside ingest, so raw values never reach disk
    - a local Ollama judge sees a 400-char window with other secrets redacted, and is adversarially tested against "mark this benign" injections
    - the pseudonymising guard proxy (1.4)
  - cc-safety-net blocks secret *paths* across all agent tools [V].
- **Extends prompt-injection detection.** parry-guard (https://github.com/vaporif/parry-guard, ★45, pushed 2026-07-28, MIT) runs DeBERTa v3 and optionally Llama Prompt Guard 2 on PreToolUse, PostToolUse and UserPromptSubmit. The models are gated on HuggingFace, and it self-describes as early development with false positives [V].
- **Extends paired-trial bench and fork at an earlier turn.** OrcaReplay (https://github.com/Continuum-AI-Corp/OrcaReplay, ★247, pushed 2026-09-14, Apache-2.0) records through a local proxy.
  - Six capture layers: a base-URL proxy, a PATH shim for exit codes and timing, an MCP JSON-RPC tee, a shadow git index per turn, a fetch hook, and harness structure.
  - `orca replay last` serves the run from disk byte-for-byte with egress blocked, so it costs no tokens.
  - `--from 4 --model X` forks at a cursor, and the result is graded by a command such as `tsc --noEmit`.
  - Replay still executes recorded tool calls for real; the README says "Replay is not a sandbox" [V].
  - bisectrun (https://github.com/SuperMarioYL/bisectrun, ★1, pushed 2026-09-08, MIT) finds the first divergent tool-input fingerprint between two transcripts of the same task. Edit fingerprints include old_string and new_string [V].
- **Extends cross-session messaging.** hcom (https://github.com/aannoo/hcom, ★496, pushed 2026-09-13, MIT) routes hooks through local SQLite and back into hooks.
  - Messages are injected between tool calls or wake idle agents.
  - Agents can subscribe to status or file-edit events.
  - **Collision detection:** two agents editing the same file within 30s both get notified [V]. That's a live complement to Wanigan's merge-conflict forecast.
- **Extends structured live transcript.** See the event taxonomy under 1.18 (claude-esp) [V].
- **Extends spend by skill/plugin/MCP.**
  - CC Harness splits per session into skills, subagents, MCP, plugins and base. Clicking a slice ranks its most expensive turns, and it can reprice at another model [V].
  - cc-audit keeps a skill/MCP ROI ledger [V].
  - ccxray `usage --tools` gives a tool and skill breakdown [V].
- **Extends subagent tree.** CC Harness shows a live topology five levels deep with per-node latency, cost and nesting depth [V]. cctop shows a sub-agent tree [V].
- **Extends session export/share.** mindwalk exports `.webm` client-side [V]. claude-replay (https://github.com/es617/claude-replay, ★830, pushed 2026-08-29) produces embeddable HTML replays [S: list blurb].
- **Extends sandbox settings.** Node9 `sandbox run <agent>` offers "kernel egress + scoped mounts" [V: one line only, mechanism not read]. Container Use, Brood Box (microVMs), Cleat and code-on-incus are [S].
- **Extends OTel trace waterfall.** ccxray splits multi-agent sessions into parallel lanes (orchestrator, Fork, Teammate) with a tracker for sequential versus concurrent turns. It is proxy-based [V].
- **Extends voice input.** VoiceMode (https://github.com/mbailey/voicemode, ★1364, pushed 2026-09-09, MIT) is an MCP server with local Whisper/Kokoro or a cloud backend [V].
- **Extends codebase index/repo map.** Graft (https://github.com/trailhq/Graft, ★7811, pushed 2026-09-15, MIT) writes linked markdown nodes per system into the repo and injects matching nodes per prompt [V]. Its install behaviour is rejected in section 4.

---

## 3. Subsumed by Wanigan already

- ccusage (★18,553) and goccc: daily and session cost from JSONL. Covered by the OTLP receiver, spend views and burn rate [S].
- ccstatusline (★12,884), claude-hud (★27,970), claude-powerline, CCometixLine (last push 2026-03-14, stale), cc-costline, ccvitals: status-line meters. Covered by the context meter and usage limits [S].
- c9watch, claude-control (Electron), Claude Status, claude-status-bar, so-agentbar, tmux-claude-status-tabs, Caprock (★10, [V]) and claude-notch (★43): live session and attention monitors. Covered by the attention queue and desktop notifications [S/V].
- Happy Coder (★23,788), Pulse, Shellular, Chatcode: phone control. Covered by the phone web app over Tailscale. Happy also needs a relay server; see section 4 [V].
- ai-agent-notifier, Claudio (sounds), Lockpaw (screen glow): notifications. Covered by ntfy, Web Push and desktop notifications [S].
- ctx (ctxrs, ★1109), Callimachus, session-indexer, recensa, hindcast, claude-sessions-dashboard, ccsession, claude-code-recap: history search and resume. Covered by the FTS archive and recent conversations. The semantic parts fall under the known semantic-search gap [S].
- ccundo (★1406, last push 2025-07-27): undo edits. Covered by per-turn checkpoints and file restore [V].
- cap'n hook (★97, [V]): exploration answers keyed by sha256 of the backing files, self-deleted on change. Covered by the learning engine's citation validation and stale-evidence quarantine before briefing.
- autoharness (★4537, [V]), Hivemind, Wienerdog, roampal-core: sessions distilled into skills. Covered by the learning engine and review inbox. autoharness's "adherence-based pruning" (loads over the requests a skill was available for) would enrich Skill Doctor.
- claude-mem (★93,894): has pivoted to "Grok Mem" [V]. Memory is covered by the learning engine.
- Rulesync, agents-md-cookbook: cross-agent config conversion. Covered by per-provider projection compilers [S].
- agnix (★413, [V]): 456 lint rules for CLAUDE.md, SKILL.md, hooks and MCP. Largely covered by Skill Doctor and the Context view. Only its hooks and MCP rule families would be new; fold them into 1.2/1.17 rather than adopting the linter.
- claude-code-guardrails (tillmeier, ★51, [V]): session-start baseline commit, PreCompact handoff file, blind reviewer that never sees the task brief. Covered by checkpoints, 85% handover and review-gate recipes.
- spec-kit (★136,814), BMAD-METHOD (★53,012), Task Master (★28,073, last push 2026-04-28) and ccpm: spec and task frameworks. Covered by goals with task graphs and review gates. They are methodologies that write files into the repo [V metadata, S content].
- tuicr (★3117, [V]): exports local review comments as a real inline PR review on GitHub, GitLab, Gitea, Bitbucket, Azure or Gerrit. Wanigan has review notes and `gh pr create`. Posting inline PR reviews would be a small addition, not a new capability.

---

## 4. Seen, rejected

- **pxpipe** (★7392, [V]): a proxy that renders the system prompt, tool docs and old history as PNGs to cut input tokens.
  - It is lossy by its own account: exact 12-character hex strings recalled 13/15 on Fable 5 and 2/15 on Opus 5, and "misses are silent confabulations".
  - It silently mutates requests. That's the opposite of recorded evidence.
- **Graft** ([V]): `graft init` drops hooks and a status line into the repo's `.claude/` for committing, and has anonymous telemetry that is on unless you opt out. Both violate the no-generated-hooks-in-repo rule and the no-vendor-telemetry value.
- **OneCLI v2** ([V]): now a team platform with IdP, Slack and a cloud-hosted option, plus a MITM credential gateway. Cloud and team, not local-first.
- **better-ccflare** (★265, [V]): load-balances requests across multiple Claude accounts to "never hit rate limits". That's hidden routing and account pooling. Wanigan's multi-account support should stay explicit.
- **claude-code-router** (★37,238, [V]): routing on header and body conditions, credential pools, fallbacks, and "AgentClaw" relays through WeChat, Slack, Telegram and others. Hidden routing plus cloud chat relays.
- **llm-router, Rayline, workweave/router** [S]: cheapest-model routing under the CLI. Hidden routing.
- **Happy's relay server, Claude Threads (Slack/Mattermost), tg-claude, the WhatsApp channel plugin, lark-coding-agent-bridge** [V/S]: third-party cloud chat relays.
- **cc-audit `--judge` and `--open`** ([V]): upload task gists and publish a public report, and switch on data sharing.
- **Agents landing their own work in claude-code-merge-queue** ([V]): "No human reviews any of this before it lands." The queue mechanics are adopted in 1.23; the self-landing is not.
- **Ralph loops** (ralph-orchestrator, frank bria), munder-difflin ("an office of agents"), Omnigent and loopx [S]: pitches for running many agents unattended in a loop.
- **tweakcc** (★2500, [V metadata]): patches the installed Claude Code binary's system prompt. Behaviour can no longer be verified against the shipped CLI.
- **Prompt Improver** (★1925, pushed 2026-06-03, [V]): a UserPromptSubmit hook that makes the model evaluate every prompt and possibly run Explore research. That's token spend on every message the operator did not ask for.
- **ccxray "Context HUD"** ([V]): appends a stats footer to Claude's responses by default. The README admits this can truncate sub-agent returns ("silent data loss").
- **ccxray "Intercept & Edit Requests"** ([V]): holds a request and lets a person edit the system prompt or messages before forwarding. Useful for experiments, but the recorded session would no longer reflect what the CLI sent unless marked. Treat it as rejected for a review surface unless made explicit and clearly labelled.
- **OrcaReplay `orca compare`** ([V]): defaults to the vendor's OrcaRouter endpoint.
- **CodeBurn and Node9 composite grades** (A–F, and a score out of 100): banned by the learning UX doctrine. Findings are usable, scores are not.

---

## 5. Could not verify, or not searched

- claude-trace: `badlogic/claude-trace` returned 404 [B]. It may have moved into another repo and was not located. ccxray and OrcaReplay cover the proxy-capture mechanism instead.
- Node9 `sandbox run` internals, meaning what "kernel egress" is on macOS [V for the one-line claim only].
- Git AI's capture path: the README claims "no per-repo setup or git hooks" but I did not read *how* edits are checkpointed. It is probably agent hooks calling the git-ai checkpoint command [unverified].
- Probity's AI-validated rule internals, and whether transcript reads work for Codex [not read beyond README].
- Selvedge beyond its README head; presence (sara-star-quant); seedeep; claude-replay; Callimachus; AgentSight (eBPF, Linux-only per HN title) [S].
- Container Use, Brood Box, Cleat, machine and code-on-incus sandbox mechanisms [S: list blurbs only].
- Atlas's claim that "links survive rebases and amends": mechanism not read [V claim, mechanism unverified].
- Claims of token or dollar savings in any README (rtk, Graft, capn-hook 77%, CodeBurn, CRUSTS): author-reported. None were reproduced, so treat all as estimates.
- r/ClaudeAI, r/ClaudeCode and Product Hunt were **not searched** this session. Coverage came from the awesome-claude-code CSV, GitHub search and HN Show HN only.
