# Relay deep audit — next-session execution plan

Prepared 2026-09-19 against `324bca7f137198a78583ec9b8cb07cfd1c667c71` on `feat/routing-suggester`.

**Objective:** maximize useful, accepted development work for the money. Measure total cost per accepted result, including routing, failures, retries and review, while preserving tests, human review and honest evidence. Relay should discover what each connected account can actually run, what allowance is left, which tools are ready, and when using a paid route is justified.

**Authorization:** the user explicitly approved **$50 initial total API spend for the next session's audit**, including JEV suggestions, model calls, retries and paid review. This is one shared ceiling across all providers, tools, agents and trials. Do not ask again for this allowance. This document plans that session; no paid trial or new connection was made while preparing it.

## Intended user experience

The operator supplies a task, chooses **Auto or Manual**, and sets a cost/quality preference and spending limit. Auto should consider account access, remaining quota, reset times, required tools, task demands and observed outcomes before choosing a model and effort. Manual must honor the chosen legal route without buying a JEV suggestion.

The explanation should read like: “This model can do the job using your included allowance. Its usage was checked recently.” Or: “Your included allowance is exhausted. Wait until the reported reset, or use this paid route within your limit.” These are desired examples, not current measured claims. If information is unavailable, explain that and the next useful action. Preserve manual control.

OpenRouter and open-weight models are candidate sources, not automatic winners. Included quota can have opportunity cost; a cheap first attempt can become expensive after repairs. MCP provides tool connections and can assist discovery; each billable MCP tool still belongs in the spending ledger. Account discovery and the model API must remain usable without asking a model to guess live prices or quota.

## Baseline and reading order

1. Read [AGENTS.md](../../../AGENTS.md), this plan, then the four coverage notes below. Their scenarios are the detailed backlog; this plan governs ordering and budget where proposals differ.
2. Capture the actual next-session HEAD, diff, app/CLI versions and runtime capabilities. The planning baseline was pushed, rebuilt, installed and reopened in the preceding implementation session. Version `0.1.0` alone cannot identify its source.
3. Historical verification: all eight `npm test` stages passed at the baseline, including 2,620 offline main-process checks. This planning pass did not rerun them. Repeat on the exact audit revision before live trials; old green output does not certify a changed checkout.
4. Treat [earlier live trials](../../research/2026-09-19-relay-live-trials.md) as dated integration evidence. They reported Codex tokens without billed dollars and did not establish a controlled accepted-result comparison.

| Coverage note | Use it for |
| --- | --- |
| [Account/model/quota/MCP discovery](../../research/2026-09-19-relay-audit-capability-discovery.md) | Current interfaces, official sources, source gaps and D01–D12. |
| [Routing and JEV](../../research/2026-09-19-relay-audit-routing-coverage.md) | Legal routes, receipts, prices, tool conformance and R01–R12. |
| [Cost and recovery](../../research/2026-09-19-relay-audit-cost-coverage.md) | Billing coverage, unknown spend, queue ownership and twelve adversarial cases. |
| [Runtime and review](../../research/2026-09-19-relay-audit-runtime-coverage.md) | Real PTY, worktree, checkpoint, process, review and packaging boundaries. |

## Budget control before any paid call

| Envelope | Maximum | Purpose |
| --- | ---: | --- |
| Connection and metering conformance | $5 | Minimal JEV schema and supported-provider/tool/billing checks. |
| Controlled development pilot | $25 | Up to three paired tasks, subject to actual affordable reservations. |
| Targeted failure/review reproductions | $10 | Only issues that need a real provider; reuse pilot evidence where possible. |
| Uncommitted reserve | $10 | Completion, delayed charges or one essential reproduction. |
| **Total** | **$50** | Includes every paid route and billable MCP call. |

These are spending allocations, not price estimates or promises that every trial fits. Plan at most $40 of new work; preserve $10 headroom and finish early when evidence is sufficient. Reallocation may occur within the same ceiling after reconciliation. No automatic top-up, subscription purchase or expansion of the ceiling.

Create one durable audit ledger before launch. One coordinator admits calls; subagents do not launch paid work independently. Each entry includes trial/purpose, provider/account, request or session identity, reserved maximum liability, actual reported amount, estimate separately, pending liability, billing source/time, cancellation and reconciliation state. Recover the ledger after restart before admitting more work.

Admission requires:

```text
confirmed audit charges
+ conservative liability for unsettled requests
+ reservations for admitted but unfinished work
+ the proposed run's maximum liability
<= $50
```

Count each liability once as it changes state. A timeout, disconnect or cancellation can still be billed. Keep its reservation until the provider resolves it. Stop paid launches if reconciliation is ambiguous; continue useful local checks. Never replace unknown dollars with zero, sum cumulative review snapshots, or discard failed attempts.

Relay's pre-turn spend guard cannot cap an already-running turn. Before each paid lane, verify provider-side controls and a conservative bound on requests, context, output, reasoning, retries and tools. A wall-clock timeout or public token estimate alone is not a hard maximum. If the current CLI cannot be bounded, use a smaller supported conformance path or mark the paid lane blocked. Do not bypass production guards to buy evidence. Provider key/account limits supplement this ledger; they do not combine different providers into a global cap.

Subscription usage is a separate resource. Confirm whether overage/usage credits are enabled; record their real charges in the same ledger if used. Do not assign invented API dollars to included subscription tokens. A subscription-only trial can produce functional/throughput evidence while remaining ineligible for a complete dollar comparison.

## Phase 1 — isolated lab and evidence baseline

- Inspect the working tree and preserve unrelated changes. Use Node `22.23.2` from `.nvmrc` for all npm commands.
- Create a disposable clone pinned to the audit commit, private dependencies, dedicated userData and a separate provider-pack root. `--user-data-dir` alone does not isolate the provider-pack registry; explicitly set `WANIGAN_PROVIDER_PACKS_DIR` for the lab. Record every root before a mutation.
- Use fixture accounts/configurations first. Native settings and learned content must not silently cross into a different backend. Never copy secrets into the repository. If real evidence needs a database copy, make a consistent SQLite backup that accounts for WAL state.
- Keep production sessions and the installed application's data out of crash, restore, malformed-state and installer experiments. Use a disposable application destination or separate test account/VM for destructive install trials.
- Run `npm test`, `git diff --check`, and the separately declared terminal replay probe after checking its current package script. Keep logs by commit. A failing baseline is a result to diagnose before paid work.
- For each case label evidence as source inspection, pure contract, production code with substituted collaborators, real filesystem/SQLite/process, real Electron/IPC, real provider, or human-accepted outcome. Renderer probes that replace `window.wanigan` remain fixtures even when launched in Electron.

**Deliverable:** a dated environment manifest, known baseline failures, coverage matrix and empty spending ledger. No model call is needed to establish these.

## Phase 2 — intelligent availability and connection audit

Run D01–D12 from the [discovery note](../../research/2026-09-19-relay-audit-capability-discovery.md), starting with offline responses. Then use minimal supported read-only account discovery; first verify that a purported status command cannot accidentally invoke inference.

For every connected account record available models/efforts, capability evidence, quota type/bucket, remaining amount, reset, spend controls, freshness and authentication state. Distinguish the public catalog, account-filtered catalog and observed execution. Preserve model/backend/profile/account identities separately. Two models sharing a quota bucket do not have two pools of allowance.

Priorities identified in source:

1. Codex quota is account-scoped, but model discovery uses a global cache and ambient environment; quota parsing reads only the legacy single bucket. Test account changes and multiple buckets.
2. Other backend catalogs cache by backend id; test credentials changing under that identity.
3. Claude's human-text probe needs current CLI and provider-cache verification. Do not mistake probe time for the age of the provider's reading.
4. Relay currently does not join quota/access/MCP readiness or numerical price quotes into its routing candidates. Record this as a missing integration, not as a secretly working optimizer.
5. A required tool must be usable through the selected harness and account. Test auth expiry, tool-list change, cancellation, tool errors, large tool catalogs, task-scoped discovery and permission changes. Include MCP context overhead in cost measurements.

Evaluate the target decision order: **required capability and consent → account access and freshness → available quota and budget → likely accepted-result cost and latency → model/effort choice**. Unknown data needs a visible policy; it cannot be treated as abundant capacity. Before paid dispatch, recheck evidence that can change while queued. On 402/429, use bounded backoff, wait for reset or an authorized eligible alternative, without circumventing account restrictions.

### OpenRouter and MCP setup

Inspect the existing connection's safe status first. If missing, tell the user to sign in or create an account and use [OpenRouter's key page](https://openrouter.ai/settings/keys); enter a dedicated capped key in Wanigan's connection controls. Check the actual remaining audit allocation before choosing its cap. Do not ask for a key in chat. A saved key still needs authentication and tool/bill conformance. [Existing connection contract](../../openrouter-connection.md).

Compare authenticated model access and key allowance with public prices. Account-wide wallet reads may require broader permissions than an inference key; preserve an honest unavailable state instead of expanding privileges automatically. See the official API references in the discovery note.

Evaluate OpenRouter's official MCP connection for metadata and diagnostics using the existing Wanigan-owned configuration/consent path. Its billable test-inference tool must reserve money too. The official server does not itself implement Relay metering or make every harness MCP-capable. If OAuth or injection is unsupported, record the missing extension point; do not modify repository/global CLI configuration as a shortcut. [Official MCP service](https://openrouter.ai/blog/announcements/openrouter-mcp-server/).

**Deliverable:** a truthful availability table, connection steps only where needed, and ranked missing joins. Retain the current OpenRouter manual/unpriced status until the implementation and evidence justify a deliberate capability change.

## Phase 3 — free adversarial integration tests

Execute the detailed notes with these priorities. Use actual local processes/Git/SQLite where those boundaries are the question; use transport fixtures for provider faults. Do not spend on a failure reproducible locally.

| Priority | Boundary | Required result |
| --- | --- | --- |
| P0 | Global ledger; missing, mixed, delayed and duplicate cost; failure after request submission | No unknown-as-zero or double charge; unresolved liability stops new paid work. |
| P0 | Pause/halt/budget/profile/account/ownership changes during preparation and dequeue | Refusal survives the last pre-spawn check; no orphaned paid launch. |
| P0 | Actual process death around lease/PTY ownership; two competing runners | No duplicate paid work; recovery reconciles process ownership and persisted evidence. |
| P0 | Private dependency setup, external/nested symlinks, hardlinks, clone/disk failure | Parent tree stays unchanged; unsupported isolation refuses before launch. |
| P0 | Restore preview changes, live writer, symlink replacement and failed safety snapshot | No unreviewed destructive change or out-of-root write; explicit partial failures and recoverable undo. |
| P0 | Review descendants on graceful quit and crash | Observe actual PIDs/sentinel writes; a stopped database row is not proof of a stopped process. |
| P1 | First prompt, startup modal, stale terminal readiness, resumed conversation | One intended prompt/turn, no automatic Enter into a changed modal, correct conversation identity. |
| P1 | Stop events, failed test feedback, duplicate ticks and changed permission | One bounded repair when eligible; no swallowed paste, repeated turn or bypassed gate. |
| P1 | Immediate first file edit and native checkpoint hooks | Pre-agent bytes and real turn boundaries when advertised; honest unsupported/failed capture otherwise. |
| P1 | Verification checkout/recipe changes, newer failures, limits and concurrent runs | Current matching evidence only; large/ignored inputs have explicit limits; no false “verified”. |
| P1 | Retained clean worktree, retry and restart | Preserve checkout/history; missing or unrelated retry target refuses clearly. |
| P1 | JEV confidence boundaries, manual choice, receipt reuse/expiry/mutation/race | Legal choices, mandatory stages, zero Manual inference, one authorized batch, no stale authority. |
| P1 | Price refresh/network bounds, stale/conditional prices, credential changes | Honest freshness and unknowns, no background retry storm or unsupported cheapest claim. |

Checkpoint launch ordering, Codex hook registration, detached review shutdown and restore preview binding are source-derived risks in the runtime note. Attempt reproduction before severity is assigned. Never turn a proposed pass criterion into a claimed existing guarantee.

Audit the renderer in both themes with keyboard navigation and accessible names: Auto versus Manual, route explanation, stale/unknown/exhausted allowance, connect action, changed budget, disabled automatic work, failed verification and direct human review. Include duplicate clicks, project switches and a background budget update on the same Relay. Any later UI fix requires before/after screenshots per AGENTS.md.

**Deliverable:** reproduced findings with exact boundaries, negative controls and artifacts. Stop the affected live lane for data-loss, false-verification or unbounded-spend findings. If fixing is authorized, follow module conversion rules and verify the fix before resuming; otherwise keep it as a blocker with useful free work continuing.

## Phase 4 — smallest useful paid conformance

Reserve before each run and reconcile immediately afterward; run sequentially until metering is proven.

1. Use up to three small synthetic JEV previews covering representative preferences. Record requested/returned version, legal model/effort, confidence/fallback, request count and usage; reuse receipts for create. Do not lower the 0.80 threshold merely to get a cheaper experimental choice. Treat confidence as a routing output, not a calibrated chance of coding success.
2. On a funded supported lane, perform one tiny real Relay task that reads a file, fixes a deterministic failing test, runs verification and reaches review. Capture actual requested/effective route, tools, checkpoints and billing. Reuse its evidence for runtime conformance.
3. If connected and bounded, perform one separately labeled **manual OpenRouter conformance** run in a disposable tiny repository: inspect, edit, run a test, continue from its actual output, and cancel a bounded follow-up if needed. Reconcile request/generation or complete session identity, effective model/upstream and all charges. No inference is needed just to inspect catalog/key metadata.
4. If a bill or effective upstream cannot be attributed, report that limitation and stop this lane's paid comparison. A working text response or one successful tool call cannot promote the experimental profile into automatic Relay execution.

**Deliverable:** connection/conformance results with actual costs or explicit failed prerequisites. No successful conformance claim without physical diff/process evidence and appropriate provider evidence.

## Phase 5 — controlled development pilot through Relay

Start with **three tasks × two policies = at most six complete trajectories**, only if per-run reservations fit the $25 envelope. This replaces larger alternative matrices in the detailed notes. Do not buy every model/effort combination. If only one task pair fits, finish that pair and report the reduced sample.

| Task | Example scope | Predeclared acceptance |
| --- | --- | --- |
| A: small user-facing change | One useful plain-language/UI improvement in an eligible extension | Requested behavior/copy, accessible controls, both themes, repository gates. |
| B: deterministic bug | A real bounded error path plus meaningful regression coverage | Reproduction fails before, passes after; neighboring behavior and required gates pass. |
| C: multi-file change | A bounded extension refactor or feature with explicit interfaces | Contract preserved or deliberately updated, no unrelated edits, required tests/review. |

Choose unresolved useful work at the audit revision. An already-fixed no-op is not a coding task. If real work is too broad or blocked by conversion requirements, use a clearly labeled realistic seeded defect in the disposable clone; never present synthetic damage as an existing product bug.

Compare a fixed Manual baseline against **Auto / lower cost**. Pin the brief, starting commit, allowed tools, harness/account conditions, pipeline policy, retry ceiling, acceptance commands and review rubric. Record actual model/effort choices rather than presuming Auto picked cheaper. Alternate or randomize run order; disclose cache and quota differences. A same-route pair can test routing overhead, but do not buy it solely to fill a table.

All product tasks must be created/launched through the actual Relay UI or its production typed main-process path and traverse verification/review. The existing headless Attempts runner and DOM fixture probes can support tests but cannot stand in for Relay integration. Never weaken tests or accept modified acceptance criteria from a tested model.

Score automated checks separately from human acceptance. Have patches reviewed without model/price labels where practical. The operator makes the final human decision; if unavailable, keep the result review-ready/unaccepted. Do not press Approve merely to make the metric computable. Count retries and agent review against the original trajectory.

Optional only after reconciliation: one held-out task pair or one isolated model/effort comparison if it resolves a specific finding and fits the remaining envelope. Preserve a usable result before starting another experiment. Repeated trials or broad confidence calibration require more evidence than this small pilot.

## Measurement and reporting

For each predeclared policy cohort:

```text
API cost per accepted result =
  all cohort API charges (routing + successful/failed attempts + repairs + paid review)
  / number of distinct human-accepted task results
```

Zero acceptances means undefined, not zero. Partial/unpriced costs mean an incomplete dollar metric; such a route cannot win a fully priced comparison. Keep conformance/discovery overhead separate from recurring per-task cost while reporting it in total audit spend. Do not sum repeated cumulative review snapshots.

Also report first-pass success, accepted results per elapsed hour, time to review-ready/accepted, human review and repair time, repair loops, tool failures, context/cache usage, discarded work, requested/effective model and cost coverage. Separate human waiting time and included quota consumption. A low invoice with excessive human repair is not the intended win.

This is a descriptive pilot. Different route/model/effort policies do not prove causal token savings. A context-saving claim needs paired metrics with provider, model, effort and commit fixed, as AGENTS.md requires. Third-party benchmarks can shortlist candidates; they cannot substitute for task acceptance or train a reliable quality predictor from six runs.

Each finding needs: id, severity, status (hypothesis/reproduced/refuted/blocked), commit and versions, source entrypoints, minimal steps, expected/actual behavior, evidence paths and hashes/ids, user/cost impact, competing explanation or negative control, regression coverage level and owning extension. Two reports repeating a source observation are not two independent reproductions.

Keep sanitized artifacts under a dated audit directory. Do not commit credentials, unrelated transcripts, native auth files or raw private prompts. Preserve failed trials and unresolved liabilities alongside successful work.

## Phase 6 — recovery, closeout and next changes

- Reopen the isolated app with pending/failed/completed fixtures; verify retained work, ledger recovery, current review evidence and no duplicate launch. Record the actual observation window; a short restart test is not a long soak.
- If source changes were made, run all eight `npm test` gates and `git diff --check`. Follow repository extension rules, including separate behavior-preserving conversion and fix commits where required. Do not batch unrelated changes into a supposed small fix.
- If testing a new packaged build, verify output against ASAR, native helpers, signature/fuses and a real renderer/typed IPC/credential-free PTY. Check native rebuild outcome separately. Use the lab for failure cases; normal installation/restart of the user's app remains a distinct action with live-session consequences.
- Reconcile every paid entry, report actual/estimated/unresolved totals and remaining allowance. Do not continue paid calls just to exhaust $50.
- Deliver a capability/account table, coverage results, reproduced findings, accepted-result pilot, and an ordered implementation backlog. Prioritize billing correctness and usable eligibility, then improved selection, then throughput optimizations. Preserve Auto/Manual and cost/quality choices.

The audit is complete when every P0 boundary has executed evidence or a concrete blocker, all paid liabilities are reported, no unsupported route is presented as verified, and each economic conclusion names its evidence limits. A blocked paid lane is a valid finding; the session must still complete independent local analysis. Claim improved economics only if measured results support it.

## Next-session kickoff

> Read AGENTS.md and docs/superpowers/plans/2026-09-19-relay-deep-audit.md and execute the audit in order. The user has already approved one $50 total API allowance including JEV, retries, paid review and billable MCP calls; keep one durable ledger and do not ask again for that allowance. First verify the exact revision and isolated lab, run local checks, then inventory actual account/model/quota/tool support. Inspect the existing OpenRouter connection and give precise sign-in/key/OAuth steps only if needed. Do not mistake public catalogs or key presence for access, or unreported spend for zero. Run the smallest attributable, bounded real Relay trials after prerequisites pass. Preserve manual choices, required tests and human acceptance. Keep production data and live sessions out of failure experiments. Report reproduced findings, blocked capabilities, actual costs and the best-supported next changes; do not claim that the planned integrations already exist.
