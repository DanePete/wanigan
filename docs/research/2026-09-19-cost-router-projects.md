# Two cost-routing projects: implementation assessment

Checked 2026-09-19 against public source, without installing or executing either
project. GitHub browsing plus read-only HTTPS source retrieval were used because
some browser fetches returned cache misses. Findings below are source inspection,
not independently reproduced runtime behavior or measured Wanigan savings.

## llm-token-router

Snapshot: [`985e24da5b67edb7d405040243bcfb8568029d40`](https://github.com/jman4162/llm-token-router/tree/985e24da5b67edb7d405040243bcfb8568029d40).
Public Python source; [Apache-2.0 license](https://github.com/jman4162/llm-token-router/blob/985e24da5b67edb7d405040243bcfb8568029d40/LICENSE).

**Useful implemented baseline.** It filters eligible models, predicts success
from per-model/task-family historical outcomes, and selects the cheapest
candidate satisfying quality, latency, and cost constraints. The selection is a
small deterministic function with stable tie breaking and a no-feasible-result
return. This separation is a good fit for Relay's pure shared modules.
[Selector](https://github.com/jman4162/llm-token-router/blob/985e24da5b67edb7d405040243bcfb8568029d40/src/llm_token_router/optimizer/select.py).

**The success prediction is a prior plus counts, not established calibration.**
The implementation computes `(alpha + successes)/(alpha + beta + trials)`.
It marks calibration established when the sample count reaches a configured
threshold, default 30. It does not measure calibration error to set that flag.
The example priors explicitly describe themselves as uncalibrated policy.
Thirty observations alone cannot establish calibrated probabilities; that is
our statistical assessment of this implementation.
[Predictor](https://github.com/jman4162/llm-token-router/blob/985e24da5b67edb7d405040243bcfb8568029d40/src/llm_token_router/policies/predictors.py),
[priors](https://github.com/jman4162/llm-token-router/blob/985e24da5b67edb7d405040243bcfb8568029d40/configs/priors.example.yaml).

**Actual routing is narrower than the expected-route-cost ambition.** The router
selects using a single-call estimate, then attaches the cheapest more-expensive
candidate whose predicted success is at least as high. The returned expected
cost remains the initial call's cost. Fallback cost is not included in the
selection objective; a mandatory rule also bypasses constrained selection,
while the decision can report the quality floor unsatisfied.
[Router](https://github.com/jman4162/llm-token-router/blob/985e24da5b67edb7d405040243bcfb8568029d40/src/llm_token_router/router.py),
[candidate cost](https://github.com/jman4162/llm-token-router/blob/985e24da5b67edb7d405040243bcfb8568029d40/src/llm_token_router/cost/route_cost.py).

**The execution feedback is real code but needs a real task verifier.** It runs
the initial call, records its label/cost, escalates once on a hard validator
failure, and includes both calls in realized cost. The fallback receives the
same request. Empty validators accept automatically; bundled validators check
JSON and fields, which cannot establish accepted coding work. A Relay adapter
would need tests, checkout freshness, review, and human acceptance.
[Execution](https://github.com/jman4162/llm-token-router/blob/985e24da5b67edb7d405040243bcfb8568029d40/src/llm_token_router/execution.py),
[acceptance](https://github.com/jman4162/llm-token-router/blob/985e24da5b67edb7d405040243bcfb8568029d40/src/llm_token_router/policies/cascade.py).

**Evidence and adoption verdict.** The project calls itself early alpha. The
roadmap leaves learned prediction, calibration reports, offline replay, and
workflow-level optimization for later. Its public tree provides a fake adapter
and protocol, not a ready-made coding CLI integration. Treat the contracts,
filtering, cost accounting, and simple selector as references. Do not import it
as proof of savings or as Relay's production optimizer without independent
evaluation and the corrections above.
[Roadmap](https://github.com/jman4162/llm-token-router/blob/985e24da5b67edb7d405040243bcfb8568029d40/docs/roadmap.md),
[adapter source](https://github.com/jman4162/llm-token-router/tree/985e24da5b67edb7d405040243bcfb8568029d40/src/llm_token_router/adapters).

## CodeRouter

Snapshot: [`3cb23b8a292f399a86f861742c9d77a59a9f23b5`](https://github.com/Code-Router/CodeRouter/tree/3cb23b8a292f399a86f861742c9d77a59a9f23b5).
Public TypeScript source; [MIT license](https://github.com/Code-Router/CodeRouter/blob/3cb23b8a292f399a86f861742c9d77a59a9f23b5/LICENSE).

**Useful policy decomposition, with heuristic probabilities.** The four-layer
path extracts features, filters candidates, scores utility, and chooses a
procedure. Its pass estimate is a hand-authored function of a model coding
score and task hardness. Cost assumes 800/2,000/6,000 output tokens by patch
size. Utility combines risk-scaled success, dollars, and latency; low/medium
risk cap the benefit of extra predicted success. This is an explicit baseline,
not a learned or calibrated per-task success model.
[Policy](https://github.com/Code-Router/CodeRouter/blob/3cb23b8a292f399a86f861742c9d77a59a9f23b5/packages/core/src/routing/policies/heuristicPolicy.ts).

**Strategy declarations exceed the generic executor's quality guarantees.** It
can select single-shot, draft/verify, a cascade with two fallbacks, or holdout.
The generic executor defaults failure to invocation status; its verifier gets
the same task, without the draft passed in `InvokeRequest`. Overall success is
true if any invocation succeeds. Therefore this executor alone does not prove
that a verifier accepted a patch, nor enforce a total cascade budget. Its
roadmap explicitly plans stronger verifier and budget-aware cascade behavior.
[Strategy](https://github.com/Code-Router/CodeRouter/blob/3cb23b8a292f399a86f861742c9d77a59a9f23b5/packages/core/src/routing/strategySelector.ts),
[executor](https://github.com/Code-Router/CodeRouter/blob/3cb23b8a292f399a86f861742c9d77a59a9f23b5/packages/core/src/routing/executor.ts),
[roadmap](https://github.com/Code-Router/CodeRouter/blob/3cb23b8a292f399a86f861742c9d77a59a9f23b5/packages/core/src/routing/ROADMAP.md).

**Distinguish the live agent path.** Live agent routing takes the selected
primary model into its existing agent loop, not the generic strategy executor.
`routeAgentLive()` returns a legacy route on holdout or exception. Therefore a
holdout in this module is not necessarily an execution stop. Relay should keep
its own refusal and verification semantics if borrowing these ideas.
[Live route](https://github.com/Code-Router/CodeRouter/blob/3cb23b8a292f399a86f861742c9d77a59a9f23b5/packages/core/src/routing/agentRoute.ts),
[agent integration](https://github.com/Code-Router/CodeRouter/blob/3cb23b8a292f399a86f861742c9d77a59a9f23b5/packages/core/src/modes/agent.ts).

**The most reusable part is the evidence structure.** Separate request,
decision, invocation, and outcome tables can represent rejected candidates,
predictions, primary/verifier/fallback costs, tests, acceptance, and rollback.
The live routing decision reports propensity 1 and exploration 0. An older
memory-bias path uses route success/failure counts, with at least three samples;
that is useful feedback but not an unbiased comparison of untried routes.
[Store](https://github.com/Code-Router/CodeRouter/blob/3cb23b8a292f399a86f861742c9d77a59a9f23b5/packages/core/src/store/routing.ts),
[router](https://github.com/Code-Router/CodeRouter/blob/3cb23b8a292f399a86f861742c9d77a59a9f23b5/packages/core/src/routing/router.ts),
[bias](https://github.com/Code-Router/CodeRouter/blob/3cb23b8a292f399a86f861742c9d77a59a9f23b5/packages/core/src/routing/bias.ts).

**Evidence and adoption verdict.** I found no held-out end-to-end router
cost/success results in the inspected public tree. The roadmap refers to
`@coderouter/eval`, but the snapshot has no `packages/eval`; a root package
script naming it is not available evaluation evidence. Published per-model
benchmark priors and README savings language do not validate routing savings.
Use this as an architectural reference, especially its event schema, not a
replacement for Wanigan's runtime, consent, evidence, and acceptance kernel.
[Tree](https://github.com/Code-Router/CodeRouter/tree/3cb23b8a292f399a86f861742c9d77a59a9f23b5/packages),
[package script](https://github.com/Code-Router/CodeRouter/blob/3cb23b8a292f399a86f861742c9d77a59a9f23b5/package.json).

## Application to Relay

Our recommendation is to retain JEV as a bounded task-demand adviser and build
a small deterministic routing module: capability and consent filters first;
quality eligibility second; complete expected attempt cost third. Record every
decision and retry before learning from outcomes. Start with two or three
meaningfully different routes, keep unknown cost/quality explicit, and compare
against fixed defaults on representative accepted coding tasks. Neither reviewed
project supplies validated parameters that should be copied into that policy.
