# Relay, JEV and cost per accepted result

Read-only implementation audit, 2026-09-19. No model calls, credentials,
production database access, or product changes were made for this report.

The existing pieces support bounded routing advice and historical estimates.
They do not yet establish the cheapest route to an accepted result. In
particular, the metering and retry attribution defects below need fixing before
their output becomes an optimization input.

## Findings

1. **Missing cost telemetry can become a measured zero.**
   `EMPTY_USAGE` starts with `costStatus: 'reported'`, `costUsd: 0`
   (`src/shared/types.ts:589`). `blankUsage()` and `usageForMany()` preserve this
   state when no cost metric arrives (`src/main/otel.ts:757`, `:843`, `:867`).
   The final downgrade considers backend identity, not meter presence
   (`src/main/otel.ts:802`, `:814`); Anthropic is reconcilable
   (`src/main/providers.ts:396`, `:450`). Relay accepts that reported zero
   (`src/main/relay.ts:582`). The isolated probe below confirms both an empty
   meter and token-only telemetry can produce a $0 forecast after three samples.
   A real zero cost metric must remain distinguishable from those two cases.

2. **Model outcomes undercount repairs and can preserve the wrong route.**
   `storeOutcome()` reads only the current `node.session_id`, then upserts one
   row per node (`src/main/control.ts:1136`). A later review overwrites the
   earlier rejection and its cost; the update also leaves the old provider and
   model unchanged (`:1147`). The SQLite probe records a failed $7 attempt then
   an accepted $2 attempt on another route: the row becomes accepted at $2,
   still attributed to the first provider/model. The fixture's two recorded
   sessions total $9. `outcomes()` also groups without effort (`:1386`), although
   effort is stored. Current acceptance rates and aggregate costs therefore
   cannot measure repair-inclusive cost per accepted result by model/effort.
   Relay's forecast already has the better session-union pattern
   (`src/main/relay.ts:568`), which can be reused.

3. **JEV does not receive or optimize observed cost and quality evidence.**
   `relayPlanRequest()` supplies bounded intent and candidate labels/descriptions;
   its question asks for best fit, with no price or outcome input
   (`src/shared/suggest-questions.ts:575`, `:606`). `createRelay()` fixes the
   provider from operator/default input and offers models within that provider
   (`src/main/relay.ts:281`, `:304`). `chooseStage()` admits a confident choice,
   otherwise falls back; it explicitly is not a scorer
   (`src/shared/relay-route.ts:22`, `:165`). Forecasts are calculated separately
   for the route already chosen (`src/main/relay.ts:610`). No call site feeds
   `control.outcomes()` into routing. Thus neither cross-profile optimization
   nor quality-constrained expected-cost selection is presently implemented.

4. **The available evidence has comparability and attribution limits.**
   Forecasts select completed phases, use the latest run's duration, and match
   only profile/model/effort, with broader model/provider fallbacks
   (`src/main/relay.ts:548`, `:562`; `src/shared/relay-forecast.ts:33`, `:64`).
   They do not condition on workload class, accepted outcome, profile version,
   account billing mode, or actual model resolved from an alias. A forecast is
   correctly labelled an estimate (`src/main/relay.ts:621`), but is not a
   controlled model comparison. Backend-based dollar verification does not
   establish marginal charges for a particular account/subscription
   (`src/main/otel.ts:824`; `src/main/providers.ts:450`). Token/quota consumption,
   API-equivalent estimates, and invoiced or marginal dollars must stay separate.

5. **Routing overhead is recorded, but not joined to a decision episode.**
   `suggest_usage` correctly freezes estimated cost per successful HTTP call and
   preserves absent metering (`src/main/suggest-usage.ts:8`, `:37`). Its schema
   contains no docket, node, purpose, or decision identifier. Relay copies the
   same whole-call usage into each route proof (`src/main/relay.ts:355`), so
   summing proofs would multiply one call's cost. Preview calls and failed
   transport attempts also lack episode attribution. The requested JEV model is
   `jev-latest`; effort and pipeline thresholds are explicitly uncalibrated
   (`src/shared/suggest-questions.ts:88`, `:100`, `:606`). Recorded distributions
   are useful evidence, but are not measured success probabilities.

## Offline reproduction

Temporary script: `/tmp/wanigan-jev-cost-audit.mjs`.

Run from the repository:

```sh
source ~/.nvm/nvm.sh
nvm use
node /tmp/wanigan-jev-cost-audit.mjs
```

The script uses TypeScript's AST to extract the actual `blankUsage`, `attrOf`,
`norm`, `unverifiedSessions`, `markUnverifiedCost`, `usageForMany`, and
`storeOutcome` functions, then transpiles them without changing their bodies.
The telemetry database/provider/Codex boundaries are fixtures; `EMPTY_USAGE`
and `forecastPhase` are imported directly from production shared modules.
The outcome probe runs the extracted production upsert against an in-memory
`node:sqlite` database with two fabricated sessions. It invokes the outcome
function directly; it does not exercise a complete Relay launch/review cycle.
These are reproducible implementation defects under controlled inputs, not
observations of user sessions or estimates of actual user savings.

Exact stdout with Node 22.23.2:

```jsonl
{"scenario":"no-meter","usage":{"costUsd":0,"costStatus":"reported","lastAt":null,"inputTokens":0},"forecast":{"n":3,"nPriced":3,"basis":"exact","medianMs":1000,"medianUsd":0}}
{"scenario":"tokens-only","usage":{"costUsd":0,"costStatus":"reported","lastAt":1700000000000,"inputTokens":420},"forecast":{"n":3,"nPriced":3,"basis":"exact","medianMs":1000,"medianUsd":0}}
{"scenario":"zero-cost-meter","usage":{"costUsd":0,"costStatus":"reported","lastAt":1700000000000,"inputTokens":0},"forecast":{"n":3,"nPriced":3,"basis":"exact","medianMs":1000,"medianUsd":0}}
{"scenario":"first-review-request-changes","row":{"provider_id":"profile-first","model":"small","accepted":0,"tests_passed":0,"cost_usd":7,"effort":"low"}}
{"scenario":"accepted-after-retry-and-route-change","row":{"provider_id":"profile-first","model":"small","accepted":1,"tests_passed":1,"cost_usd":2,"effort":"high"},"expectedTotalFromRecordedFixtureSessions":9}
```

## Minimal integration sequence

1. Convert any affected unconverted surface before changing behavior, per
   `AGENTS.md`. Keep metering corrections at the evidence boundary and test
   absent meter, token-only, reported zero, and mixed-meter retries.
2. Add a routing-evidence module through `WaniganModule` migration/IPC seams
   (`src/main/module-registry.ts:59`), with append-only decision/attempt records.
   Freeze actual route, effort, account cost basis, policy/question version,
   resolved JEV identity, one call ID, review result, and all attempt sessions.
   Reuse existing Control proofs and session evidence rather than copying text.
3. Let JEV classify task demands; let deterministic code compare eligible
   routes against a quality floor using comparable outcomes and total attempt
   cost. Treat insufficient or missing evidence as unknown. Retain conservative
   defaults and the existing verification/human-review gates. Begin with
   recommendations; no automatic paid exploration is necessary.
4. Evaluate on a fixed set of representative tasks and commits, with repeated
   runs, recorded retries, quality outcomes, latency, token use, and explicit
   billing basis. Separate policy comparisons from single-variable model or
   effort comparisons. The batch A/B engine enforces single-variable configs
   (`src/main/batch/evals.ts:139`), but is not an end-to-end coding Relay eval;
   the learning experiment registry's start/complete calls only update records
   (`src/main/learning/experiments.ts:123`, `:131`). Neither currently proves
   routing savings or calibrates JEV's routing thresholds.
