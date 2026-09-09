# Wanigan eval machinery — map, gaps, and what a "bench" needs

Read-only audit, 2026-09-07. Repository: the Wanigan repository (HEAD 591d758).
Every file:line below was read in this pass. Nothing was executed.

## 0. Honesty rules in CLAUDE.md that constrain how results may be shown

- "do not present an estimate or a guess as observed fact" (preamble).
- Compound learning engine: "Do not call token savings causal unless a controlled experiment fixes the
  provider, model, effort and commit and ingests paired metrics. The current A/B registry does not launch
  workloads; a manually closed run remains an estimate. Mixed evidence inherits the weakest label."
- "A harness that reports no usage is proven unmetered by its own call ... an unpriced call is recorded as
  unpriced and never totalled as spend."
- Product guardrails: "Prefer an honest unsupported state to an invented integration" and do not imply a
  provider supports hooks/telemetry/resume/MCP/batch until verified end to end.
- Provider packs: "Route behavior by declared harness/headless/capabilities, not by hardcoded profile ids."
- Memory doctrine (wanigan-learning-ux-doctrine.md, referenced by MEMORY.md): no composite scores, reason
  codes, estimate grammar.
- In code, the same doctrine is spelled out at: src/main/batch/pricing.ts:95-99 (a costOf() number "is
  therefore only a price when isPricedModel(modelId) is true; every caller that shows it to somebody has to
  say which of the two it has"); src/main/spend.ts:5-34 (two meters, keep the split visible);
  src/main/headless.ts:1244-1250 ("Never invent a number: an estimate here is indistinguishable from a
  measurement once it is in the roll-up"); src/main/learning/experiments.ts:153-167 ('causal' requires a
  completed experiment; otherwise degrade to correlation/estimate); src/main/batch/evals.ts:701-706 (a
  26-24 split over 50 rows is noise; sqrt(n) lead needed before naming a winner).

## 1. Inventory — what exists today

### 1a. Batch "evals" (src/main/batch/evals.ts, 825 lines) — Message Batches API only
- Compares two *batch runs* (rows of the Anthropic Message Batches API), not agent sessions.
- `COMPARED` fields (evals.ts:29-32): model, maxTokens, temperature, system, userTemplate, keyColumn,
  cacheTtl, extendedOutput, effort, thinking, thinkingDisplay, schemaJson, source.
- `createPair` (evals.ts:130-166) refuses 0 or >1 differing fields — one variable, enforced.
- `diffOf` (evals.ts:225-297) matches rows by custom_id, counts same/different/onlyA/onlyB, prices each
  row via `costOf` (evals.ts:212-216).
- `runVariant` (evals.ts:355-423): re-submits base config with one change; pins glob/command sources as
  jsonl so priced rows == submitted rows.
- `judgePair` (evals.ts:507-590): LLM judge as another batch run, per-row random A/B swap, un-swapped in
  `ingestJudgement` (evals.ts:625-680). Judge model+effort recorded in eval_scores.judge_run
  (evals.ts:483-486).
- `regressionSummary` (evals.ts:684-736): wins/ties/mean margin/cost delta; declares "no clear winner"
  unless lead > sqrt(n).
- Golden sets (evals.ts:751-825) snapshot a run's rows so a later comparison is over the same dataset.
- Tables: eval_pairs, eval_scores, golden_sets (src/main/db.ts:395-418); runs.kind/eval_pair_id
  (db.ts:508-509).
- IPC actually registered (src/main/index.ts:2395-2402): evals:pairs, createPair, diff, summary, ingest,
  golden, saveGolden, goldenSource. **`runVariant` and `judgePair` are exported but registered nowhere**
  (grep across src: no reference outside evals.ts). Preload (src/preload/index.ts:541-550) matches.
- Renderer: Batches.tsx EvalsTab (2152+) — "Ingest scores" requires pasting a judge run id (2246, 2443-2450).

### 1b. Headless fan-out (src/main/headless.ts, 1723 lines) — the only unattended agent launcher
- `HeadlessConfig` (src/shared/types.ts:936-951): name, providerId (ONE per run), projectIds[], prompt,
  model?, effort?, providerOptions?, maxBudgetUsd, timeoutMs, isolate.
- Provider must declare headless 'claude-json' or 'codex-json' (headless.ts:265-310, 564-569); capability
  probed (headless.ts:584-589). Trust gate derives permission mode (headless.ts:80-146).
- Run row: runs(kind='headless', model = cfg.model or providerId, config_json = StoredHeadlessConfig with
  providerProfileFingerprint) (headless.ts:733-751). Rows: headless_rows one per project (db.ts:319-335).
- Worktree per row when isolate && mode != plan: `createWorktree(row.project_path, cfg.name, rowKey)`
  (headless.ts:882-897). Empty worktree removed after run (headless.ts:1206-1213).
- Base head captured (`headOf(cwd)`, headless.ts:895) and used only for the changed-file diff
  (headless.ts:1201-1204); **not persisted**.
- argv computed at spawn (headless.ts:1101) and **not persisted**; bin resolved (headless.ts:865) and
  **not persisted** on the row (session_log has `bin`, headless_rows does not).
- Output parse (`parseCliOutput`, headless.ts:353-397): reads total_cost_usd / cost_usd /
  usage.total_cost_usd, usage.input_tokens, output_tokens, cache_read_input_tokens,
  cache_creation_input_tokens, is_error, result, modelUsage[].contextWindow. Codex's
  `usage.cached_input_tokens` and `reasoning_output_tokens` are not read.
- Finish write (headless.ts:1265-1290): status, cost_usd (0 when null), cost_reported (0/1), duration_ms,
  exit_code, output (≤64KB), error, files_changed, worktree, ended_at, account_id.
- Tokens are summed into runs.in_tokens/out_tokens/cache_read/cache_write per RUN, not per row
  (`addUsage`, headless.ts:1329-1337).
- Run-level cost = SUM(rows.cost_usd) (`finalize`, headless.ts:1343-1346); `HeadlessRun.costStatus`
  'reported'|'partial'|'unreported' (types.ts:1015-1035).
- Renderer HeadlessRuns.tsx: row cost "no cost reported" when costReported !== true (60-69); run total
  "CLI-reported; never estimated" / "a floor" / "no repository reported a cost" (566-579). List shows
  model, not effort (531-532, 558).

### 1c. Attended sessions + telemetry
- session_log columns (db.ts:168-183 + addColumn 512-560, 900-904): provider_id, project, model, effort,
  permission_mode, exit_code, worktree, trust, bin, capabilities_json, baseline_head, baseline_dirty_json,
  initial_prompt, account_id, backend_id, harness_id, provider_pack_id/version. Insert at
  src/main/sessions.ts:1385-1400.
- OTLP usage per session (src/main/otel.ts:707-804 `usageForMany`/`usageFor`) -> SessionUsage
  (types.ts:443-468): costUsd + costStatus 'reported'|'unavailable', tokens, lines added/removed, commits,
  requests, errors, refusals, models[]. Per-turn session_api_events (db.ts:237-253) carries model, cost,
  duration, tokens, effort.

### 1d. Worktrees (src/main/worktrees.ts)
- `createWorktree(repoRoot, label, sessionId)` (318-410): `startPoint = baseBranch ?? head` (342),
  `git worktree add -b <branch> <dir> <startPoint>` (365). **No commit/ref parameter.** Records
  `branch.<b>.waniganbase` for merge (376).
- `mergeWorktree(p, {squash, message})` (522), `removeWorktree(p, force)` (655), `worktreeStatus`,
  `listWorktrees`, `reconcileWorktrees`.
- WorktreeInfo (types.ts:919-932) has head, dirty, ahead.

### 1e. Git (src/main/git.ts) — read/act, no test execution
- `commitDiff(dir, hash)` (477-489) returns numstat files + patch (≤400 KB). `fileDiff` (715). `status`,
  `log`, `stage`, `commit`, `checkout(ref, create)` (621), `merge`, `stashSave`. No "run tests" here.

### 1f. Review gate = the post-run verifier (src/main/review.ts, 250 lines)
- Recipe per project (review_recipes, db.ts:490-494); saved with consent (`saveRecipeWithConsent`, 59).
- `runAt(projectId, cwd?)` (220-246): runs each command via `$SHELL -lc` in cwd (167), records
  results [{command, exitCode, output, durationMs}] incrementally, status 'passed' only if every command
  exit 0 (242). review_runs (db.ts:495-503) has project_id, started/ended, status, results_json — **no
  cwd, no commit, no session/run id**.
- Callers: `review:run` IPC (index.ts:2207) and `control.runProof` (control.ts:681-692) which runs it in
  the node's worktree and stores a work_proofs row. Headless rows never call it.

### 1g. Control plane (src/main/control.ts) — the closest thing to paired outcomes
- Docket records base_commit = HEAD at creation (426-429). Node launch: `createSession({providerId,
  model, effort, permissionMode, isolate: true, ...})` (550-552) — worktree is created at launch from
  current HEAD (sessions.ts:1012 -> worktrees.ts:342), so base_commit is recorded, not enforced.
- `storeOutcome` (control.ts:705-714): work_model_outcomes(provider_id, model, task_kind, accepted,
  tests_passed, cost_usd = usage.costUsd only when costStatus==='reported' else 0). Schema db.ts:1078-1092.
- `outcomes()` (control.ts:763-773): GROUP BY provider, model, task_kind -> samples, acceptedRate,
  testPassRate, totalCostUsd; ORDER BY accepted DESC. Rendered as "Outcome router" in Control.tsx:550
  with usd(totalCostUsd). No effort, no commit, no evidence label, no "cost not reported" state.

### 1h. Learning A/B registry (src/main/learning/experiments.ts + learning-service.ts)
- learning_experiments columns (ExperimentRow, experiments.ts:9-15): provider_id, model, effort,
  commit_hash, config_json, status draft|running|completed|cancelled|failed, outcome_json.
- `createExperiment` (72-105) validates candidate/version and `assertFixedControls` (57-70): baseline and
  candidate config objects may not change providerId/model/effort/commitHash.
- `startExperiment` (123-129), `completeExperiment(id, outcome)` (131-140) — stores any outcome object,
  ≤128 KB, no check that metrics exist. `endExperiment` (142-149).
- `recordMetric` (169-196) + `attributedEvidenceLevel` (162-167): 'causal' is kept **iff the named
  experiment's status is 'completed'**; otherwise degrades. Nothing reads outcome_json.
- `summarizeArtifactRoi` (223-252): weakest label wins.
- IPC: learning:experiments, createExperiment, setExperimentStatus (index.ts:2531-2537); preload
  (preload/index.ts:652-660). Renderer Learning.tsx Experiments (2937-2974): "This release records the
  protocol and outcome; it does not yet launch paired workloads or ingest their metrics automatically. A
  closed manual run therefore remains an estimate." The Close button sends
  `{evidenceLevel:'estimate', note:'...paired metrics have not been ingested.'}` (2974) — a payload
  `attributedEvidenceLevel` never reads.
- No non-smoke caller records a metric with experimentId (grep: only smoke4.ts:1436-1439).

### 1i. Spend / pricing
- Two meters (spend.ts:5-34): CLI-reported (sessions, headless) vs Wanigan-priced (batch only).
- Batch table (batch/pricing.ts:19-30) is hard-coded; `findModel`/`isPricedModel` (45-60) vs `modelFor`
  (72-74) silently substitutes DEFAULT_MODEL. `costOf` (101-111) prices unknown ids at default rates and
  the doc at 95-99 requires callers to gate on isPricedModel. Callers that do: estimate.ts:130,
  refusal.ts:295. Callers that do not: evals.ts:212-216 (rowCost), evals.ts:696 (costDeltaUsd),
  Batches.tsx:2422-2424 ("Cost of B vs A").
- Codex plan usage is tokens only, never dollars (Insights.tsx:730; SessionUsage.costStatus).

### 1j. Queue / schedule
- Schedules may fire headless or batch (schedule.ts:19, 203-206). Queue is a generic kind/runner
  dispatcher (queue.ts:121, 268). No "repeat K times" concept anywhere.

## 2. Answers

### (1) Paired metrics recorded per run today
Headless row (headless.ts:1265-1290; table db.ts:319-335, +986, +992):
  status, cost_usd, cost_reported, duration_ms (wall), exit_code, output, error, files_changed, worktree,
  started_at/ended_at, account_id.
Headless run (headless.ts:733-751, 1329-1346): model (or providerId), config_json (providerId, model,
  effort, prompt, providerOptions, maxBudgetUsd, timeoutMs, isolate, providerProfileFingerprint),
  in/out/cache tokens summed across rows, cost_usd summed.
NOT recorded for headless: argv, resolved binary, base commit, per-row tokens, Codex cached/reasoning
  tokens, test result, diff/patch (worktree kept only if files changed; nothing snapshots it).
Attended session (sessions.ts:1385-1400 + otel usageFor): model, effort, permission_mode, bin, worktree,
  baseline_head, exit_code, account; cost with costStatus, tokens, lines +/-, commits, requests, errors.
Batch row (requests table db.ts:140-157): status, output, stop_reason, tokens; priced by costOf.
Control outcome (control.ts:705-714): provider, model, task_kind, accepted, tests_passed, cost_usd.

### (2) Fresh worktree at a pinned commit with chosen profile/model/effort?
Partially. Headless: yes to profile (providerId), model, effort, isolate=true worktree per row
(headless.ts:882-897). No to pinned commit: createWorktree has no ref argument and branches from the
current branch/HEAD (worktrees.ts:342, 365); the head it started from is computed (headless.ts:895) but
never stored. Control dockets store base_commit (control.ts:426) but launch worktrees from current HEAD
(control.ts:550 -> sessions.ts:1012). So "commit fixed" can be asserted only if the operator does not
touch the branch between launches — nothing verifies it.

### (3) Post-run verifier?
Yes, but disconnected. review.runAt(projectId, cwd) runs the project's consented recipe in any cwd and
records per-command exit codes/durations (review.ts:220-246). It is invoked from the Control goal's
"verify" proof in the node worktree (control.ts:681-692) and from the review:run IPC on the project
path. Headless rows never run it; review_runs does not record cwd, commit, or which run it verified.

### (4) What the A/B registry can and cannot do
Can: register a draft naming provider/model/effort/commit and a candidate/version; refuse a config whose
baseline and candidate differ on any control (experiments.ts:57-70); move draft->running->completed/
cancelled/failed; attach metrics with experimentId; degrade a 'causal' claim with no completed experiment
to correlation/estimate; report weakest-label ROI.
Cannot: launch any workload; ingest any metric automatically (no caller outside smoke); verify that the
recorded commit_hash matched the tree a session ran on; verify that any session used the recorded
provider/model/effort; tell a manually closed experiment from one whose paired metrics were ingested.
The last point contradicts CLAUDE.md: `completeExperiment` accepts any outcome (131-140) and
`attributedEvidenceLevel` grants 'causal' on status==='completed' alone (162-167); smoke4.ts:1421-1442
proves it by hand-closing an experiment with `{winner:'candidate', sampleCount:12}` and asserting that
metrics recorded afterwards read 'causal'. The renderer's "Close run" evidenceLevel:'estimate' is
ignored. Latent today (nothing records experiment metrics outside smoke), but the IPC to close is
renderer-reachable (index.ts:2535-2537).

### (5) Minimal additions for a "bench" (one task × N profiles × K repeats)
Reuse: headless runner (spawn, gate, hooks, worktree, cost parse), review.runAt for tests,
work_model_outcomes shape, evals' sqrt(n) noise rule and evidence labels, spend's two-meter split.
Add, in order of necessity:
 a. `bench_runs` + `bench_trials` tables (additive): bench id, task prompt hash, project, pinned commit,
    per trial: profile id + profile fingerprint, model, effort, argv_json, bin, base_head, worktree,
    exit_code, duration_ms, cost_usd + cost_reported, in/out/cache tokens (per trial, not per run),
    files_changed, patch_bytes (or patch path), verifier review_run_id + status, attempt index.
 b. Worktree at a ref: `createWorktree(..., { startPoint })` validated against OBJECT_NAME
    (git.ts:475) so every trial checks out the same commit; record `head` after creation.
 c. Per-row token/argv/bin/base_head columns on headless_rows (or only on bench_trials) — the
    `Reported` struct already has the tokens (headless.ts:369-380); extend parseCliOutput to read Codex
    `cached_input_tokens`/`reasoning_output_tokens`.
 d. A verifier hook after each trial: call review.runAt(projectId, worktree) when a recipe exists;
    store review_run id + passed on the trial; extend review_runs with cwd/head columns.
 e. A launcher that expands (profiles × K) into existing headless runs (one run per profile×attempt
    keeps the single-provider HeadlessConfig intact) and a bench row linking them; K > 1 must be
    explicit and the total ceiling (K × N × maxBudgetUsd) shown before consent.
 f. Report: per profile — pass rate (tests), mean ± SE over K (Miller 2024 §2.1), cost only from
    reported trials with "n of K reported", tokens split by meter, wall time. Label: 'causal' only when
    all trials share commit, prompt hash, and each profile's model+effort are fixed (compare
    profileFingerprint), and the verifier ran on every trial; else 'correlation'. Reuse the sqrt(n)
    rule before naming a winner. Never a composite score.
 g. Smoke: source-string assertions that the report never renders usd() for a trial with
    cost_reported=0 and that the evidence label is computed, not asserted.

## 3. Findings (file:line, quote, consequence, fix, size)

F1 [honesty] src/main/learning/experiments.ts:162-167
  `if (experiment?.status === 'completed') return 'causal';` and completeExperiment (131-140) stores any
  outcome. Consequence: a hand-closed experiment anchors 'causal' metrics; CLAUDE.md says a manually
  closed run remains an estimate. Learning.tsx:2974 sends evidenceLevel:'estimate' which is ignored.
  Fix: require outcome.ingested === true set only by a main-process ingest path (or a launched flag), else
  degrade to 'correlation'; update smoke4.ts:1411-1442. Size: S.

F2 [dead capability] src/main/batch/evals.ts:355 (runVariant), :507 (judgePair) exported but not in
  index.ts:2395-2402 or preload 541-550; Batches.tsx:2443 tells the operator to "paste the id of a judge
  run" that nothing can create. Fix: register evals:variant and evals:judge with consent; add UI. Size: M.

F3 [honesty] src/main/batch/evals.ts:212-216, 696 and Batches.tsx:2422-2424 price A/B rows with costOf
  and no isPricedModel gate; pricing.ts:95-99 says every such caller must say which it has. Consequence:
  "Cost of B vs A: $X more" for an unknown model at Sonnet-5 rates. Fix: return pricedA/pricedB in
  summary and label "not priced". Size: S.

F4 [missing record] src/main/headless.ts:895 (`const baseHead = await headOf(cwd)`) discarded after the
  diff; :1101 argv and :865 bin not stored; :1329-1337 tokens summed per run. Consequence: a finished row
  cannot say which commit, binary or flags produced it, or how many tokens it alone used. Fix: add
  base_head, bin, argv_json, in/out/cache token columns to headless_rows; write at 1265-1290. Size: M.

F5 [capability] src/main/worktrees.ts:342, 365 `startPoint = baseBranch ?? head` — no ref argument;
  control.ts:426 records base_commit but launch (550) does not use it. Fix: optional startPoint validated
  by OBJECT_NAME; store created head. Size: S.

F6 [honesty] src/main/control.ts:713 `usage?.costStatus === 'reported' ? usage.costUsd : 0` and
  Control.tsx:550 `usd(outcome.totalCostUsd)`; outcomes() (763-773) ranks by accepted DESC across tasks,
  commits and efforts with no evidence label. Consequence: "$0.00" reads as free; a ranking over
  uncontrolled samples reads as a router. Fix: cost_reported column + "n of m reported"; effort column;
  label 'correlation'. Size: S.

F7 [parse] src/main/headless.ts:373-380 reads cache_read_input_tokens only; Codex emits
  cached_input_tokens and reasoning_output_tokens (vendor doc, below). Consequence: Codex rows record 0
  cache read. Fix: read both spellings. Size: XS.

F8 [verifier link] src/main/review.ts:220-246 + db.ts:495-503: review_runs has no cwd/head/run id.
  Consequence: a pass cannot be tied to the tree it verified. Fix: add cwd, head, subject columns. Size: S.

F9 [test coverage] grep smoke*.ts: eval_pairs, createPair, regressionSummary, ingestJudgement,
  work_model_outcomes have zero smoke references (goldenSetSource only, smoke3.ts:791). Size: M.

F10 [wording] HeadlessRuns.tsx:579 "CLI-reported; never estimated" — Anthropic's own doc says
  total_cost_usd is a client-side estimate (below). Wanigan's claim (it did not estimate) is true; the
  sub could say "the CLI's own estimate; Wanigan never prices it". Size: XS.

F11 [one provider per run] types.ts:936-951 HeadlessConfig.providerId is singular; N-profile comparison
  is N unlinked runs; no repeat count anywhere. This is the bench gap, not a bug. Size: bench.

## 4. External sources (all fetched 2026-09-07)

- Claude Code "Run Claude Code programmatically" — https://code.claude.com/docs/en/headless (no page date;
  mentions v2.1.261). VERIFIED: "With --output-format json, the response payload includes total_cost_usd
  and a per-model cost breakdown ... Both figures are client-side estimates and can differ from your
  actual bill."; exit 0 on success / non-zero on failure; SIGTERM -> exit 143 and "records no result";
  stream-json last line is a result message with cost and session metadata; `--permission-prompts none`
  needs v2.1.259+. The page does not list the full result field table (usage, duration_ms, num_turns
  not quoted here — unverified in this pass).
- Codex non-interactive mode — https://learn.chatgpt.com/docs/non-interactive-mode (redirect from
  developers.openai.com/codex/noninteractive; no page date). VERIFIED: event types thread.started,
  turn.started, turn.completed, turn.failed, item.*, error; turn.completed carries
  usage:{input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens}; no dollar cost,
  duration or model name in any event per the page; --output-last-message, --output-schema.
- Anthropic Message Batches — https://platform.claude.com/docs/en/build-with-claude/batch-processing
  (no page date). VERIFIED: "All usage is charged at 50% of the standard API prices"; batch ≤100,000
  requests or 256 MB; results after all complete or 24 h; results available 29 days; custom_id
  ^[a-zA-Z0-9_-]{1,64}$; recommend 1-hour cache for batches. A "cache not guaranteed" sentence was not
  found verbatim on the page (spend.ts:390-394 says it; unverified here).
- SWE-bench harness — https://github.com/SWE-bench/SWE-bench (README, no date) and
  https://raw.githubusercontent.com/SWE-bench/SWE-bench/main/swebench/harness/grading.py. VERIFIED:
  Docker per instance; results cached by run_id+instance_id; resolved = FULL only when FAIL_TO_PASS and
  PASS_TO_PASS success fractions are both 1.0; report fields patch_is_None, patch_exists,
  patch_successfully_applied, resolved, infra_failure, tests_status.
- Terminal-Bench 2.1 — https://github.com/harbor-framework/terminal-bench-2-1 (2026 citation year).
  VERIFIED: "you must run at least 5 trials per task and upload them to Harbor Hub publicly"; example
  uses `-k 5`. pass@k / pass_majority definitions came only from a search snippet — NOT verified.
- Inspect (UK AISI) — https://inspect.aisi.org.uk/metrics.html (no date). VERIFIED: epochs rerun each
  sample; reducers mean (default), median, mode, majority, max, pass_at_{k}, pass_k_{k}, at_least_{k},
  collect.
- Miller, "Adding Error Bars to Evals" — https://arxiv.org/abs/2411.00640 and /html/2411.00640
  (submitted 2024-11-01). VERIFIED: paired differences are a "free" variance reduction when two models
  answer the same questions (§4.2); K resamples per question give Var(s_i)=σ_i²/K (§3.1); clustered SEs
  (§2.2); CI95 = mean ± 1.96·SE (§2.1); power analysis (§5).
- Aider polyglot leaderboard — https://aider.chat/docs/leaderboards/ (last updated 2025-11-20 per page).
  VERIFIED: columns model / percent correct / cost / command / edit format; 225 Exercism exercises in six
  languages; two-attempt scoring; cost = total to run the suite.
