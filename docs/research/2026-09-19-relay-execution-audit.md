# Relay execution and accepted-result cost audit

Date: 2026-09-19. Objective: minimize total cost per accepted result, including
retries, without weakening verification or human approval.

## Evidence and scope

Read-only product audit. No providers, paid models, real agent sessions or
network calls were used for these reproductions. The probe at
`/private/tmp/relay-control-offline-audit.cjs` bundles the actual `control.ts`
and its shared modules with esbuild, uses a real temporary SQLite database,
and mocks external process launch, telemetry and review services. Its output
is `/private/tmp/relay-control-offline-audit-output.json`. Assertions exercise
actual exported `startNode`, `startQueuedNode`, `retryNode`, `completeNode`,
`sweepAutopilot` and `docket` functions. This proves the control boundary's
behavior; it does not claim end-to-end provider or filesystem launch validation.

No product code was changed. Control is not an extension yet, so its conversion
must precede fixes under the repository's architecture rule.

## Highest-priority findings

1. **A retry requests a fresh checkout instead of the work being corrected.**
   `retryNode` retains the implementation worktree while clearing its session
   (`src/main/control.ts:1559`). `startNode` inherits a checkout only for verify
   and review (`:707`, `:735`) and sends implementation retries `isolate: true`
   with no `useWorktree` or `resumeFrom` (`:745`). Session creation consequently
   creates another checkout (`src/main/sessions.ts:1189`), based on the project
   rather than the previous patch. The probe confirms retained
   `/old/implementation` followed by `isolate: true`, `useWorktree: null`,
   `resumeFrom: null`. Preserve and validate the previous implementation
   checkout for correction; fail clearly if it disappeared. This avoids paying
   to recreate the first attempt.

2. **Autopilot overrides per-stage routing.**
   `startQueuedNode` passes the docket-wide provider and model
   (`src/main/control.ts:1889`) even when the stage has its own provider/model.
   The probe pins `stage-profile/stage-cheap` and observes launch parameters
   `global-profile/global-expensive`. Autopilot should consume the accepted
   stage route and use docket defaults only where no stage pin exists.

3. **Launch parameters and durable route evidence diverge.**
   Launch correctly falls back to the node's model and effort
   (`src/main/control.ts:746`), but the following update writes only
   `input.model || null` (`:763`, receipt `:780`), erasing a model when the caller
   omits it. CLI Relay starts do omit it (`src/main/index.ts:900`); Board starts
   also omit it. Explicit effort overrides are launched but never written back
   to the node. Probe: actual launch `stage-cheap`, node/receipt `null`; launch
   effort `high`, node effort still `low`. This weakens future routing, resume
   receipts and model/effort forecast matching. Persist one resolved launch
   specification and distinguish original route from later overrides.

4. **The dollar cap is a dispatch hint, not an enforceable total-spend limit.**
   The sweep compares reported spend only (`src/main/control.ts:1848`), ignores
   `spendStatus`, and dispatch does not recheck budget (`:1880`). Probe: an
   already queued stage launches with a zero-dollar budget; a stage with
   unreported earlier spend is queued with reported spend zero. No mechanism
   here reserves estimated attempt cost or bounds an already running session.
   Gate hand-backs likewise compare only reported dollars
   (`src/shared/gate-feedback.ts:159`). Recheck at dispatch, represent unknown
   spend explicitly, and describe any limit according to what it can enforce.

5. **Model outcomes lose retry cost and misattribute upgrades.**
   `storeOutcome` reads only the latest session and upserts one row per node
   (`src/main/control.ts:1138`, `:1147`). The conflict clause updates verdict,
   cost and effort, but not provider/model. Probe: a $2 cheap first attempt and
   $3 upgraded second attempt produce an accepted outcome labeled
   `stage-profile/cheap-first`, cost `$3`, effort `high`; the docket ledger
   correctly totals `$5`. This is unsuitable training evidence for choosing
   the cheapest accepted result. Keep attempt-level observations and a separate
   accepted-result total, including failed attempts and route changes.

6. **A routed model can receive outcome credit without running.**
   Final review records every node with `provider_id`, not every launched node
   (`src/main/control.ts:1238`). Relay pins verification models, but its normal
   UI verification action runs deterministic commands and completes the node
   without a model (`src/renderer/src/views/Relay.tsx:133`, `:271`). Probe shows
   accepted outcome rows for never-launched verify/review models, with
   `cost_reported: 0`. Route planning is not model execution: require execution
   identity for a model outcome and represent deterministic verification and
   human decisions separately.

## What already works

- The route chooser admits only declared models/efforts, honors a validated
  operator override, and otherwise requires confidence at least 0.8 before
  replacing the profile default (`src/shared/relay-route.ts:184`).
- Verification and approval check current gate evidence against the actual
  implementation checkout and configured commands, with stale-evidence and
  concurrent-update checks (`src/main/control.ts:1094`, `:1153`). Independent
  checks remain necessary even if a routing classifier reports high confidence.
- Review rejection reopens implementation/verification with bounded durable
  hand-back counts (`src/main/relay.ts:739`). The missing part is preserving the
  implementation at the next launch, not the reopen state transition.
- Docket spend unions live and historical node sessions, so reopening cannot
  erase earlier spend (`src/main/control.ts:188`). Forecast cost likewise sums
  attempt sessions and remains unpriced if any cost is unavailable
  (`src/main/relay.ts:555`).
- Forecasts require at least three comparable samples, declare their basis,
  and withhold totals when any phase is unknown
  (`src/shared/relay-forecast.ts:94`, `:123`). They are estimates, not proof that
  a route is optimal.

## Missing optimization loop

Relay currently selects routes before planning, from declared model choices and
suggester answers. Recorded outcomes are explicitly display evidence, not input
to the router (`src/main/control.ts:1236`). There is no learned estimate of
acceptance probability, retry-adjusted cost, or bounded escalation after a cheap
attempt fails. A complete cost-quality loop needs trustworthy execution and
outcome records first, then candidate evaluation using total expected cost per
accepted result. A high JEV answer confidence is not a measured probability that
the selected coding model will pass the project's acceptance checks.

The normal Relay UI uses local verification commands, while routing and forecasts
still count verification as an agent stage. The execution plan should declare
which phases are deterministic commands, model sessions, or human decisions;
only actual model stages need model-selection questions and model cost samples.
