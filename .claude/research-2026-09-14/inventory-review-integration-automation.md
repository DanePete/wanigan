<!-- Final report of a read-only code inventory agent, 2026-09-14, against main at a9e454e plus the uncommitted working tree. -->

Every capability listed below was checked against the code. For each one I confirmed that something outside tests and comments actually calls it (IPC handler, renderer call, or runner registration). Smoke files were left out of all greps.

**Path legend.** Bare `name.ts` means `/Users/dane/Projects/drupal/wanigan/src/main/name.ts`. `V/` is `/Users/dane/Projects/drupal/wanigan/src/renderer/src/views/`, `C/` is `/Users/dane/Projects/drupal/wanigan/src/renderer/src/components/`, `S/` is `/Users/dane/Projects/drupal/wanigan/src/shared/`. `index` is `index.ts`.

## Part A: capability inventory

### Control / Goals (control.ts; V/Control.tsx, whose tab is labelled "Review" at S/routes.ts:25; V/Board.tsx)
- **Goal create** (436-475): title, objective, 1–16 acceptance checks, risk, optional budget, and the base commit it was recorded at. SHIPPED.
- **Task graph** (340-434): node kinds plan/implement/verify/review, up to 40 nodes. Validation requires no cycles, exactly one review node that every other node leads to, and no overlapping path claims between tasks that can run at once. The default graph is four phases (S/types.ts:1347-1356), editable by hand in C/PlanEditor.tsx. SHIPPED.
- **startNode** (558-647, 754-782): takes the task's declared claim, then launches a PTY session with the goal's contract as the prompt.
  - Implement tasks get a fresh worktree and `acceptEdits`.
  - Plan, verify and review tasks default to `plan` permission mode.
  - Verify and review tasks reuse the implementation worktree, found by walking dependencies.
  - A snapshot "goal capsule" is delivered through the system prompt or Codex developer-instructions (sessions.ts:1193-1199). SHIPPED.
- **Claims** (493-508): an overlapping claim anywhere in the project is refused. Claims are advisory: nothing in policy.ts or hooks.ts checks them. **Checkpoints** (649-683) record a note, commit, worktree and conversation id. SHIPPED.
- **What a "proof" is:** a `work_proofs` row. Three writers:
  - `test`: a review-gate result, with a summary plus `detail_json` holding cwd and per-command exit code and duration (784-822).
  - `review` / `decision`: written when a task is completed (877-880).
  - Autopilot halt reasons (1185-1189). SHIPPED.
- **completeNode** (853-897):
  - A verify task needs its latest gate run to have passed.
  - Approving a review needs every verify task passed.
  - `request_changes` and `reject` mark the review task failed; reject also marks the goal rejected.
  - `retryNode` only reopens failed or canceled tasks (1150-1153), so completed implement or verify tasks can never be re-run inside the same goal.
  - The decision note is stored but never sent to any agent.
  - SHIPPED, on desktop and from the paired phone (mobile/goals.ts:933-938).
- **What autopilot actually does:**
  - Arming requires a budget and freezes the provider and model (1200-1218).
  - A 10-second sweep (index:359, 1103-1114) queues every ready task except review into the queue's `node` lane (1283-1323), which calls startNode (1335-1351).
  - It halts itself, with a recorded reason, when the provider or budget is missing or reported spend reaches the cap (1292-1305).
  - It never completes a task, runs a gate, or decides a review. `runProof` and `completeNode` are only called from human actions (index:2742-2744, mobile/goals.ts:874).
  - SHIPPED (V/Control.tsx:595-660).
- **Board** (928-1021): tickets across all goals in columns, with start, retry and park. There is no dragging between columns, even though the route hint says "columns you can move" (S/routes.ts:49). SHIPPED.
- **Outcomes** (1023-1038): acceptance rate, test pass rate and reported cost per provider/model/task kind. SHIPPED as a table only (V/Control.tsx:544). Comments at 881-893 mention a "router" that reads this; nothing does (ModelOutcome appears only in control.ts, Control.tsx and types.ts). Router: DEAD.
- **Event inbox** (1040-1086): hand-typed events that can be turned into a goal or dismissed. SHIPPED.
- **mcpTasks / cancelMcpTask** (1088-1140): internal records using MCP-task status words. Cancelling kills the session and releases claims. SHIPPED as a list in Control; not exposed over MCP.
- **resumeReceipts** (690-715), **traces** (goal-trace.ts:13-59, written from hooks.ts:739, otel.ts:623 and control.ts:632), and reconciliation on exit and startup (1359-1406). SHIPPED (C/ReviewEvidence.tsx).
- **S/goal-journey.ts**: `#goal=&task=` deep links and next-step guidance text, used by C/GoalCompanion.tsx and C/SessionGoalTrail.tsx. SHIPPED.

### review.ts (the review gate)
- **Recipe:** up to 20 commands per project. Newly added lines need a native consent dialog (59-98).
- **Run** (125-246): sequential `$SHELL -lc`, stops at the first failure, 10-minute per-command timeout with SIGKILL, 128KB output cap. Results are saved as each command finishes; runs interrupted by a crash are closed as failed.
- **Surfaces:** V/Git.tsx:669-672, the Control verify task (V/Control.tsx:695), and the phone (mobile/git.ts:1503). SHIPPED.

### git.ts / gh.ts / worktree merge (V/Git.tsx)
- **git.ts** (322-741): status, log with lane graph, diffs, branches, stashes; stage, unstage, discard, commit/amend, checkout/create, delete, merge, fetch, `pull --ff-only`, push (no force). Subdirectory projects are read-only (298-310). SHIPPED.
- **gh.ts:**
  - PR status for the current branch: state, review decision, and check pass/fail/pending counts. Read only when the chip is clicked, cached 60s (gh.ts:140-259; V/Git.tsx:348-362).
  - `createPr` with title, body, draft and base (gh.ts:273-334). SHIPPED.
- **mergeWorktree** (worktrees.ts:501-640): merges into the recorded base branch, refuses dirty trees, no-ff or squash. On conflict it aborts and lists the files. Only one merge per repo at a time (in-process lock). Reachable from Git branch rows (V/Git.tsx:893-909), HeadlessRuns "Squash merge…" (V/HeadlessRuns.tsx:391-403) and Sessions (V/Sessions.tsx:1847). SHIPPED.

### headless.ts (V/HeadlessRuns.tsx, tab "Runs") — SHIPPED
- One prompt across N projects, one row per repo. Selecting every project requires an explicit `allProjects` flag (559-731).
- Invocation: Claude `-p --output-format json`, Codex `exec --json` (266-314).
- Permission mode comes from project trust. Read-only trust adds a tool deny list and `--strict-mcp-config`; Codex is refused below Trusted (84-144).
- Timeout is required; Claude also gets `--max-budget-usd`.
- Optional worktree per repo, removed if nothing changed (912-934, 1211-1220).
- Policy-ledger hooks (978-1016). The files-changed count excludes files that were already dirty.
- Cancel kills the whole process group. When a run ends it notifies and writes the schedule outcome (1381-1413).

### queue.ts
- **Dispatcher:** durable (SQLite). Kinds session/headless/batch/scout/node, per-kind slots (S/types.ts:1821), priority, 5 retries with 429 backoff, cross-process leases (122-635).
- **Runners:** only headless, batch, scout and node are registered (index:972, 1037, 1064, 1086). `session` items wait forever (357-360), so that kind is DEAD.
- List, cancel and slot settings are SHIPPED; `queue:counts` is MAIN-ONLY.

### schedule.ts + daemon.ts (V/Schedules.tsx)
- **Schedules:** 5-field cron (with daylight-saving gap handling), description, preview; create, edit, pause (cancels queued fires), delete, history, "run due now".
- **Kinds:** headless (a prompt) and batch (re-submit a saved run). Session schedules are refused (190-217).
- **Firing:** each fire is claimed atomically; a fire is skipped while the previous one is still outstanding; one catch-up fire after sleep; the outcome is written back to history (409-732).
- **Daemon:** a macOS LaunchAgent that starts the app with `--daemon` (daemon.ts:25-42) and runs the services with no window (index:750-755). That includes the scheduler, queue runners, the autopilot sweep, and the MCP server if enabled (index:887-1162). SHIPPED, macOS only.

### automation.ts
Only a `--wanigan-automation` launch flag, honoured in unpackaged builds, so scripts/shots.mjs (Playwright) can screenshot Wanigan's own UI (automation.ts:38-57; index:1938). Developer tooling, not a user feature.

### preflight.ts + S/preflight.ts
First-run checklist: whether each agent CLI is found, its version and sign-in evidence, project count, sessions started, and install hints (preflight.ts:69-99; S/preflight.ts:187-201). SHIPPED (C/SetupChecklist.tsx, shown in V/MissionRoom.tsx:189). It is not a merge or PR preflight.

### teams.ts
Read-only viewer of Claude Code's experimental Agent Teams files: members, tasks with blocked counts, inbox previews, across account directories (28-261). SHIPPED (C/TeamPanel.tsx, shown in V/Fleet.tsx:472, 641).

### interview.ts (V/Interview.tsx, opened from V/Control.tsx:427 and V/Board.tsx:144)
- Calls the Messages API with a Platform key and exactly two tools, `ask_one_question` and `propose_goal`.
- 1–20 questions; hitting the cap forces a proposal. The dollar budget is checked before every call; unpriced models are refused (107-192, 323-465).
- The operator edits the proposal, then it goes through the same createDocket validation (482-508). Resume works.
- SHIPPED. Abandon is MAIN-ONLY (no renderer caller). The manual "write the plan yourself" path is SHIPPED.

### batch/ (V/Batches.tsx)
- **Batches:** sources csv/jsonl/glob/files/command (batch/sources.ts:40-44); estimate, one-row dry run, submit under a spend cap, poll, retry, cancel, export CSV/JSONL (index:2028-2060); refusal rescue; cache diagnostics.
- **evals.ts:**
  - Variant runs that change one field (359-428).
  - Pairs that must differ in exactly one field (139-168).
  - Row-by-row diff (220-333).
  - LLM judge that randomises A/B order per row (517-687).
  - Verdict that flags results inside the noise (691-754).
  - Golden sets (780-825).
- SHIPPED (Evals tab, V/Batches.tsx:1353).

### mcp/
- **server.ts:** Wanigan as an MCP server; tools are listed in B17.
  - Transport: stateless HTTP on 127.0.0.1 with an Origin check.
  - Access: a per-launch bearer token that is only valid while that Wanigan session is live and in the same project (935-981; capabilities.ts:49-71).
  - Also serves a `ui://wanigan/goal-inspector` resource.
  - Off by default (settings.ts:56; toggle at V/Settings.tsx:4445). SHIPPED; `mcp:pending` is MAIN-ONLY.
- **registry.ts:**
  - Global or per-project stdio/http servers; URLs must be https or loopback.
  - A stdio server needs SHA-256 trust through a native dialog, and enabling is a separate step. Untrusted servers are left out of configs.
  - Each launch gets its own `--mcp-config` file; `{{PROJECT_PATH}}` substitution; usage counts come from hook events (356-742; index:2284-2341).
  - SHIPPED. The config is only given to Claude Code harness PTY sessions (sessions.ts:1117-1127).

### plugins.ts (V/Plugins.tsx)
Scan of installed plugins, catalog from the CLI, details including always-on tokens, install (user scope), enable/disable, marketplace add (native confirm) and update (303-650). SHIPPED. Marketplace remove is MAIN-ONLY.

### improvement-scout.ts (V/ImprovementScout.tsx)
- Fetches a fixed allow-list of vendor changelog pages (40-80, 566-593).
- Keyword rules compare them against Wanigan's hard-coded list of its own capabilities and produce proposals about Wanigan itself (477-493, 597-667).
- Triage statuses; turning a proposal into a goal with an evidence proof (921-951); manual, preview, or opt-in weekly. SHIPPED.

### Also relevant
- cli.ts: see B20.
- halt.ts: a persistent global stop switch honoured by the queue (queue.ts:301), schedules (schedule.ts:586) and autopilot (control.ts:1288).

## Part B: presence checks

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | Diff-line comments sent to agent | ABSENT | CodePanel is read-only (C/CodePanel.tsx:44-49). Grep `line comment\|inline comment\|diff comment\|lineComment\|reviewComment\|addComment\|send (this )?selection` found nothing; "hunk" is only a CSS class (CodePanel.tsx:724, 807). Review notes are stored only (control.ts:874-880). |
| 2 | Agent self-review of its diff | PARTIAL | A goal's Review task can start an agent session (V/Control.tsx:699) in the implementation worktree, in `plan` mode (control.ts:588-596), instructed to "Review the diff" (S/types.ts:1354). Its output is not captured and autopilot never dispatches it (control.ts:1307). No standalone action: grep `self-review\|review code\|reviewCode\|/review\|code-review\|critique` found none. A generic skill/slash-command send exists (index:2591-2600). |
| 3 | PR create / generated title-body / draft / stacked | PARTIAL | Create PRESENT (gh.ts:296-334; V/Git.tsx:640-667), including a draft checkbox and base branch. Title is prefilled from the HEAD commit subject, body is blank, no LLM (V/Git.tsx:571). Needs an upstream (566). Only the project's checked-out branch; no PR action in HeadlessRuns, Sessions, Fleet or Control. Stacked PRs ABSENT (grep `stacked\|stack of` finds only CSS/comments). |
| 4 | CI monitoring / auto-fix | PARTIAL | Pass/fail/pending counts from `statusCheckRollup` (gh.ts:137-151, 191-194), fetched only on click with a 60s cache (V/Git.tsx:348-362). No per-check detail, polling, or fix loop: grep `gh run\|workflow run\|auto-?fix\|fix ci` found none. A CI failure can be typed into the event inbox by hand (V/Control.tsx:187). |
| 5 | Ingest PR review comments | ABSENT | Grep `pr comments?\|review comments?\|pulls/.*/comments\|gh api\|gh pr view\|gh pr review\|gh pr checks\|reviewThreads` found none. gh.ts only runs `pr list`, `auth status`, `pr create`, `--version`. |
| 6 | Issue-tracker intake | ABSENT | Grep `linear\.app\|jira\|github issue\|gh issue\|issue tracker\|issues api\|atlassian\|api\.github\.com` matches only palette keywords (S/routes.ts:49). Manual event inbox only (control.ts:1051-1082). |
| 7 | Predict merge conflicts | ABSENT | Grep `merge-tree\|mergeTree\|predict.*conflict\|would conflict\|overlapping (files\|changes)` found none. Related: advisory path claims (control.ts:420-431, 493-503); conflicts detected only at merge time, then aborted (worktrees.ts:615-626). |
| 8 | Merge queue / ordered landing | ABSENT | Grep `merge queue\|mergeQueue\|landing order\|landAll\|merge train` found none. One merge button per worktree; concurrent merges into a repo are refused (worktrees.ts:501-547). Accepting a goal merges nothing. |
| 9 | Best-of-N | PARTIAL | Batches only: one-variable variants plus LLM judge (evals.ts:359-428, 517-754). For agent tasks ABSENT: a headless run has one row per repository, and grep `best[- ]of\|bestOf\|tournament\|pick (the )?winner` found none. Model acceptance rates are display-only (V/Control.tsx:544). |
| 10 | Test/build gates tied to "done" | PRESENT | Recipe of shell commands (review.ts:31-98), run via `$SHELL -lc` (159-246). For a goal, it runs in the implementation worktree (control.ts:784-822). Recorded in `review_runs` (full output) and a `work_proofs` `test` row. Verify completion and review approval are blocked without a passing latest run (control.ts:829-872). Only started by a human (index:2742). Headless runs and schedules have no gate. |
| 11 | Visual verification | ABSENT | Grep `playwright\|puppeteer\|chrome-devtools\|capturePage\|screenshot\|video` in main/shared/preload: only pasting clipboard screenshots as attachments (attachments.ts:648-659). Playwright appears only in the developer screenshot script (automation.ts:15-20). |
| 12 | Non-cron triggers | ABSENT | Grep `webhook\|fs\.watch(\|chokidar\|watchFile\|slack\|\bwatch\(` found no receivers or watchers. control.ts:1049-1050 says remote ingress was deliberately not built; notify.ts:13-29 says the webhook receiver was removed. Only cron, the autopilot sweep, and Scout's weekly run. |
| 13 | Spec-driven planning / interview → spec | PARTIAL | The interview produces a goal contract (title, objective, acceptance checks, risk, task graph) saved as database rows (interview.ts:107-192, 482-508). Grep `requirements\.md\|design\.md\|tasks\.md\|spec-driven\|EARS\|user stor` found no spec documents. |
| 14 | Plan approval before implementation | PARTIAL | Default graph is plan → implement, and the plan step says "Do not make changes until the plan is accepted" (S/types.ts:1348-1349). The plan runs in `plan` mode (control.ts:595); implement only becomes ready once a human marks the plan complete. The plan's content is not captured or passed to the implement agent (the capsule holds only titles, statuses and claims: sessions.ts:786-806). |
| 15 | Multi-user / teams | ABSENT | teams.ts is a local read-only viewer of Claude Agent Teams files (teams.ts:5-19, 197-261). Grep `invite\|collaborator\|multi-?user\|rbac` found none. "Accounts" means multiple logins for one operator. |
| 16 | Export goal/run/session as a report | PARTIAL | Exports that exist: batch results CSV/JSONL (index:2053-2060; cli.ts:231-285), policy ledger JSONL (index:2573-2581), full database backup (index:3130-3140). The save dialog is used only at those three places. Goals offer only "Copy goal ID" (V/Control.tsx:316-318). |
| 17 | Wanigan as MCP server | PRESENT (off by default) | Tools (server.ts:194-407): `wanigan_estimate_run`, `wanigan_dry_run`, `wanigan_submit_run` (native approval dialog; fails closed after 5 min), `wanigan_run_status`, `wanigan_fetch_results`, `wanigan_list_runs`, `wanigan_list_goals`, `wanigan_get_goal`, `wanigan_goal_checkpoint` and `wanigan_goal_claim` (own task only), `wanigan_list_projects`, `wanigan_find_repos`, `wanigan_list_sessions` (self only), `wanigan_start_session` (approval required), plus `wanigan_recall_transcripts` when the project opts in. There is no complete/approve tool. Callers: only live Wanigan-launched Claude Code harness sessions, using a per-launch bearer token over 127.0.0.1 (server.ts:957-981; registry.ts:703-714; sessions.ts:1117-1127). |
| 18 | MCP client host | PARTIAL | Enable plus SHA-256 trust consent (registry.ts:356-432; index:2311-2335); remote https servers allowed (registry.ts:453-471). No OAuth or custom headers for remote servers (HTTP entries carry only type and url, 648/681; headers only on Wanigan's own entry, 710-713). No connection health (542-559). Elicitation is only observed, to mark a session as waiting (hooks.ts:1212-1219). MCP Tasks not implemented (server advertises only tools and resources, server.ts:877). |
| 19 | Plugin install / update | PARTIAL | Install, enable/disable, marketplace add and update all (plugins.ts:622-644; V/Plugins.tsx:196, 210, 249, 273). Marketplace remove is MAIN-ONLY. Grep `plugin.*(uninstall\|update)\|'uninstall'` found no per-plugin update or uninstall. |
| 20 | Public CLI / API | PARTIAL | `npm run cli --` (package.json:40) runs: runs, status, poll, export, queue (session\|headless\|batch), sessions, phone-launch, phone-start, learn-probe, learn-phrase, learn-sweep, learn-consolidate, help (cli.ts:36, 479-512). `queue session` items never run; no goal or schedule commands. Other interfaces are scoped: the session-bound MCP server, and the paired-phone HTTP routes on loopback (mobile/server.ts:38-44; mobile/goals.ts:911-938). |
| 21 | Agent eval harness on real repo tasks | ABSENT | evals.ts works on Batches API rows only (evals.ts:10-18). Grep `benchmark\|trials\|k repeats\|pinned commit\|swe-bench\|terminal-bench` matches only Scout proposal text (improvement-scout.ts:646). Scout's own inventory marks `providerChangeEvaluationRecipes: false` (490). |
| 22 | Cost per accepted outcome | PARTIAL | Outcome rows store accepted, tests_passed and reported cost (control.ts:836-851); aggregated per model (1023-1038); the table shows accept %, test %, total cost (V/Control.tsx:544). No cost ÷ accepted and no link to merged PRs: grep `per accepted\|costPerAccepted` found none. |
| 23 | Scheduled agent runs | PRESENT | Schedulable: headless prompts, run with the default provider, $2 budget, 15-minute timeout and worktrees (index:340-341, 984-1027), and batch re-submits (index:1037-1058). Session schedules are refused (schedule.ts:204-208). Runs while the app is closed only if the opt-in macOS LaunchAgent is installed (daemon.ts:19, 25-42; V/Schedules.tsx:249-251). |
| 24 | Rollback / revert | PRESENT | Per file or batch (up to 2,000 files) back to the session's baseline commit, with a plan preview (revert.ts:77-221; C/CodePanel.tsx:274-297). Per turn: whole working tree back to a hook-bounded checkpoint, with a safety snapshot first (checkpoints.ts:14-28, 361-448; CodePanel.tsx:201-211). Not per hunk; no revert at goal or headless-run level. |
| 25 | Two sessions in one repo without worktrees | PARTIAL | Only warns and attributes, no prevention: warning when other sessions share the checkout (C/NewSessionDialog.tsx:225, 983-995); baseline of already-dirty files (sessions.ts:52-77); headless snapshot taken before the run (headless.ts:936-940); advisory claims (control.ts:493-503; no checks in policy.ts or hooks.ts). No locks, no detection of concurrent edits. |
