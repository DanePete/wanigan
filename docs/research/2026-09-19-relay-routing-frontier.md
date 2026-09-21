# Routing toward cheaper accepted coding results

Primary-source research, checked 2026-09-19. This extends the earlier
[Jev research](2026-09-19-jev-primary-sources.md) and
[real Relay trials](2026-09-19-relay-live-trials.md). No packages were installed,
models called, credentials inspected, or application code changed. Paper dates
below are first arXiv submissions unless a venue date is specified. Repository
links identify the inspected files on their named branches; they are mutable
snapshots, not pinned reproductions. All external performance numbers are
author-reported; I did not independently reproduce them or find a verified
independent reproduction of the exact headline results in the sources inspected.

The most useful next step is **a small, calibrated selector over legal
model–effort pairs, followed by bounded recovery after a real failure**.
Keep Jev as an inexpensive task signal. Let local code compare measured cost,
acceptance, and time, and keep the existing tests and human decision as the
acceptance boundary. The research supports this direction; it does not provide
a ready-made policy proven cheapest for Wanigan's CLI workloads.

## Ten sources and what they actually establish

### 1. TwinRouterBench — closest evidence to coding agents

First submitted **2026-05-14**. The paper separates 970 static routing prefixes
from live software-agent evaluation. On its 100 held-out SWE-bench cases,
trained UncommonRoute resolved **75/100 for $25.66**, versus unrouted Opus 4.6
at **74/100 for $54.73**: 53.1% lower API spend. The rule-based router resolved
73/100 for $172.56. Thus a plausible routing heuristic can be substantially more
expensive than the strongest-model baseline. These are author results under
a fixed pool and harness, not evidence about native Codex effort settings.
[Paper, Table 3](https://arxiv.org/html/2605.18859v1#S6.SS2).

**Important inconsistency:** the paper says the 100 cases were randomly sampled;
the current README says they are the lexicographically first 100 common result
IDs after removing supervision cases—**18 Astropy and 82 Django**. Treat the
headline as a narrow selected-split result pending clarification. Static labels
also cannot certify a changed model pool. Reuse the two-track evaluation design,
not its exact tier labels.
[Released split protocol](https://github.com/CommonstackAI/TwinRouterBench#paper-held-out-split-100-swe-bench-verified-instances).

Inspected [`swerouter/leaderboard/score.py`](https://github.com/CommonstackAI/TwinRouterBench/blob/main/swerouter/leaderboard/score.py):
`avg_cost_per_resolved_usd` divides a bill **including a hypothetical unresolved
penalty** by resolved count. Relay should retain real spend per accepted result
and any failure-penalty objective as separate fields. Confidence: high in the
source finding; medium in transfer to Relay.

The exact released cost table is
[`data/dynamic/model_pricing.json`](https://github.com/CommonstackAI/TwinRouterBench/blob/main/data/dynamic/model_pricing.json):
schema 12, fetched 2026-04-23, USD per million tokens, with separate input,
output, cache-read and cache-write rates. Reuse versioned billing provenance;
do not copy these OpenRouter benchmark rates into native CLI subscription costs.

### 2. RouterBench — a stronger baseline than “always expensive”

First submitted **2024-03-18**; over 405,000 recorded inference outcomes.
Its Zero Router mixes models without reading the query, using their cost–quality
frontier. The tested KNN/MLP routers did not significantly beat that baseline
overall. Cascade performance depended strongly on the simulated judge: results
deteriorated as its error exceeded 0.2. The paper explicitly leaves latency and
throughput outside its evaluation.
[Paper §§3.2, 5.3, 6](https://arxiv.org/html/2403.12031v2).

Inspected [`routers/run_cascading_router.py`](https://github.com/withmartian/routerbench/blob/main/routers/run_cascading_router.py):
the evaluator-error parameter and precomputed responses make this a simulation,
not a deployed coding verifier. Relay's router must beat a fixed cheap route,
a fixed capable route, and a task-independent mixture at matched budget.
Otherwise added semantic routing complexity has not earned its overhead.
Confidence: high in the evaluation lesson; low in transferring old-model scores.

### 3. RouteLLM — cheap predictive routing, with a calibration naming trap

First submitted **2024-06-26**, revised **2025-02-23**, ICLR 2025. It learns
strong-versus-weak preference prediction. The repository advertises up to 85%
lower cost while retaining 95% GPT-4 benchmark performance, including MT-Bench;
that is neither unchanged quality nor accepted repository changes.
[Paper history](https://arxiv.org/abs/2406.18665),
[official implementation](https://github.com/lm-sys/RouteLLM).

Inspected [`routellm/calibrate_threshold.py`](https://github.com/lm-sys/RouteLLM/blob/main/routellm/calibrate_threshold.py):
calibration takes a **quantile of router scores to target a strong-model traffic
share**. It does not bound incorrect cheap-model decisions. Reuse lightweight
prediction and offline threshold sweeps; distinguish allocation calibration
from outcome calibration. Its embedding-based routers also require an external
embedding API in the documented default configuration, which cannot silently
receive Relay's protected semantic data. Confidence: high.

### 4. FrugalGPT — a cascade requires a useful stopping test

First submitted **2023-05-09**. It learns model sequences and answer-scoring
thresholds. The often repeated 98% saving comes from a particular HEADLINES
setting: Table 3 reports **98.3% HEADLINES, 73.3% OVERRULING, 59.2% CoQA** to
match the best individual model. A separate HEADLINES point improves accuracy
from 0.857 to 0.872 while reducing cost from $33.1 to $6.5. The tasks are news
classification, legal classification, and reading comprehension, not agentic
code repair. [Paper, Tables 2–3](https://arxiv.org/pdf/2305.05176),
[official repository](https://github.com/stanford-futuredata/FrugalGPT).

Relay can use the cascade principle after deterministic checks or a reviewed
rejection, with a finite attempt budget. A cheaper first attempt is beneficial
only if its success probability offsets wasted attempts, verification, and
fallback costs. A confident answer alone is insufficient. Confidence: high in
the principle; no portable savings percentage.

### 5. BEST-Route — optimize the model and compute allocation jointly

First submitted **2025-06-28**, ICML 2025. It predicts quality for each
**model × number-of-samples** combination, filters by a quality threshold,
then selects the cheapest remaining combination; otherwise it uses the reference
model. On 10,000 mixed instructions, the reported 60% cost reduction corresponds
to **0.80% lower armoRM reward score**, not a 0.80-point software acceptance loss.
Its billing assumption charges prompt tokens once for multiple samples; do not
carry that assumption into separate CLI sessions.
[Paper §§4–5](https://arxiv.org/html/2506.22716v1).

Inspected [`train_router.py`](https://github.com/microsoft/best-route-llm/blob/main/train_router.py)
and the [data-generation workflow](https://github.com/microsoft/best-route-llm#how-to-run).
The reusable idea is a joint action space: in Relay, each candidate is a legal
model–effort pair. Best-of-N is a different compute knob from provider reasoning
effort, and adopting it would require explicitly funded parallel trials and
safe worktree isolation. Confidence: high in the algorithm; medium in the
model–effort adaptation; no direct coding-outcome proof.

### 6. Conformal LLM Routing — explicit risk and abstention

Published **July 2026, ACL Student Research Workshop**. A logistic gate and
held-out Clopper–Pearson calibration limit cases where the cheap model is wrong
and the expensive one is right. At α=0.30, GSM8K coverage is 36.7%, observed
violation 28.0%, saving 35%; MMLU uses α=0.20 and reports 87% saving. These
tolerances are substantial, and the label treats “both models wrong” as safe
relative routing: it is **not an absolute correctness guarantee**.
[Paper, Table 2](https://aclanthology.org/2026.acl-srw.70.pdf).

The paper assumes exchangeability and discusses threshold-search monotonicity;
its stricter fixed-sequence alternative matters when implementing a guarantee.
Do not describe a searched threshold's ordinary confidence interval as certified
without handling selection. The [author repository](https://github.com/IqtedarU/conformal-llm-routing)
contains the experiment notebook, but no license was visible in the inspected
root. Reuse the statistical design after review, not unlicensed copied code.
Confidence: high in the need for separate calibration; conditional in any guarantee.

### 7. BaRP — learning from only the action actually taken

First submitted **2025-10-08**. BaRP conditions a contextual-bandit policy on
cost/quality preference and trains from partial feedback. Its in-distribution
average score is **73.57 versus 70.87** for the largest model; this is a task
score comparison, not a same-quality savings claim. The important qualification
is explicit: training simulates bandit feedback from **static offline logs**;
the study is not continuously learning from live deployment, and its decision
model is single-step. The paper promises code on publication; a canonical public
implementation was not verified in this search.
[Paper, Table 2 and limitations](https://arxiv.org/html/2510.07429v1),
[submission date](https://arxiv.org/abs/2510.07429).

Relay normally observes only its chosen route. A missing alternative outcome
must not become a failure or success label. Log selection probability for any
future randomized experiment, keep operator overrides distinct, and recognize
that deterministic logs cannot identify untried alternatives. Confidence: high
in this data constraint; medium in BaRP's practical applicability.

### 8. Router-R1 — bounded escalation, but costly machinery

First submitted **2025-06-10**, NeurIPS 2025. A trained LLM interleaves internal
reasoning and calls to other models, optimizing answer correctness and cost.
The study uses seven QA benchmarks and bounds routing to four rounds; increasing
the cost coefficient can reduce answer accuracy. This is not a model-selection
function that can simply be pasted in front of a coding CLI.
[Paper and appendix](https://arxiv.org/html/2506.09033v1).

Inspected [`router_r1/llm_agent/route_service.py`](https://github.com/ulab-uiuc/Router-R1/blob/master/router_r1/llm_agent/route_service.py):
the cost signal uses completion tokens times a fixed model rate, omits prompt
tokens there, and its request helper defaults to 500 outer attempts plus SDK
retries. These are poor production defaults for Relay's total-budget objective.
Reuse outcome-grounded escalation and hard round limits, not the transport or
cost accounting. Confidence: high in source findings; low in direct adoption.

### 9. Route-and-Reason / R2-Reasoner — decomposition is part of the policy

First submitted **2025-06-06**, revised **2025-12-04**. A trained decomposer
and allocator route subtasks across nine models. The 84.46% average API-cost
reduction is **API cost**, with local small models treated as fee-free.
Program-synthesis accuracy is **38% versus GPT-4o CoT's 42%**, while MATH is
76.5% versus 51.5%; the benefit varies by task. It does not demonstrate universal
quality preservation or total compute savings.
[Paper, setup and Table 1](https://arxiv.org/html/2506.05901v2).

The [official repository](https://github.com/tsinghua-fib-lab/R2-Reasoner)
provides research training/inference setup and only some benchmark artifacts.
Relay should compare stage decompositions as complete policies, because splitting
work can add handoff cost and change downstream success. Internal thought-level
routing crosses a different boundary from Relay's stage-level CLI launches.
Confidence: high in the mismatch; low priority for direct reuse.

### 10. CascadeFlow — useful runtime patterns, weaker quality promises

The inspected [release history](https://github.com/lemony-ai/cascadeflow/releases)
exposes v1.2.0 at commit `6412166`, with trace export/offline simulation.
Its README claims 69% MT-Bench and 93% GSM8K savings while retaining 96% GPT-5
quality, yet elsewhere promises zero quality loss. These are vendor claims
with different wording and are not evidence of accepted coding throughput.
[README](https://github.com/lemony-ai/cascadeflow/blob/main/README.md).

Inspected [`cascadeflow/quality/confidence.py`](https://github.com/lemony-ai/cascadeflow/blob/main/cascadeflow/quality/confidence.py):
confidence combines logprobs when present, semantic heuristics, alignment,
provider adjustments, and clamping. That score cannot replace compiling,
testing, or human review. Reuse observe-before-enforce rollout, decision traces,
and explicit budget checks. Its in-process model/tool interception is not a
drop-in fit for Relay's native CLI lifecycle. Confidence: high in the source
mechanism; low in transferring vendor savings/latency claims.

## OpenRouter Jev recipes — concrete implementations, narrower guarantees

Checked 2026-09-19; publication dates are not displayed. These are official
code recipes, not independent evaluations. No recipe was executed here.

**[Jev-verified cascade](https://openrouter.ai/docs/cookbook/evaluate-and-optimize/jev-verified-cascade):**
`answerWithCascade` drafts with Luna, sends question/excerpts/answer to Jev, and
sends the answer only for `supported` with confidence at least 0.8. `declined`
hands off immediately, without a confidence floor or stronger call. Other results
try Astra once and verify again; failure hands off. Each tier incurs generation
plus Jev cost. Neither tier sets reasoning effort. The examples discard usage
and return the requested model alias, so they are not a complete cost ledger or
effective-route receipt.

The author-reported 50-question fixture has 27 answerable questions: cascade
cost $0.012 with zero wrong answers; Astra $0.175 with two; Luna alone $0.004
with zero. The cascade escalated twice and handed off two answerable questions.
Earlier runs differ, and the introduction describes Astra as having zero wrong.
This does not establish improvement over the cheap baseline, calibrated safety,
or coding acceptance. Retain its bounded recovery/handoff structure, not the
headline saving as a Relay prediction.

**[Tool-call gate](https://openrouter.ai/docs/cookbook/building-agents/gate-tool-calls-with-jev):**
`gateRefund` rejects missing orders or excessive amounts locally, then batches
three Noul judgments about request, order and policy. All at least 0.9 approves;
any at most 0.1 blocks; the middle pauses for a human. The Agent SDK hooks execute
only after approval, and parse/network failures return an error without issuing
the refund. The recipe keeps static restrictions for inherently dangerous tools,
requires execution-time balance checks/idempotency, and binds human review to
the stored pending arguments. Its under-$0.0001 check cost is an author-observed
example, not a fixed price. Its helper discards usage and explicitly recommends
retaining it with request/provider IDs for reconciliation. Reuse deterministic
prechecks, reason records and abstention; four fixtures do not certify the
0.9/0.1 thresholds for coding tools or hostile repository content.

**Accounting and confidence:** both recipes use `typesafe/jev-1.13` at
`POST /api/alpha/decisions`. The
[API reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request)
shows request ID, resolved model, provider, tokens and `usage.cost`; preserve
these rather than inferring invoice cost from a model catalogue alone.
The cascade calls confidence a correctness probability, but TypeSafe's
[definition](https://docs.typesafe.ai/confidence) describes a statistic of the
answer distribution. Neither supplies a held-out coding-risk guarantee.

**Relay boundary:** these patterns inspect generated answers or proposed tool
arguments. Sending CLI output, diffs or source to Jev would expand Relay's
currently bounded intent interface and violate its same-backend semantic
boundary where that content originated elsewhere. A shared OpenRouter key does
not make distinct model backends identical. Keep required tests, human acceptance
and permission enforcement; an SDK tool hook is not a native CLI interception
capability. Adopt only the policy structure within those boundaries unless a
separately authorized, faithful integration is designed.

## Concrete Relay design suggested by the evidence

These are engineering recommendations, not measured product improvements.

1. **Rank legal model–effort pairs locally.** Preserve manual choice. In Auto,
   combine Jev's bounded intent/stage features with route-specific outcome
   estimates; do not ask Jev to do price arithmetic. Filter pairs by a lower
   confidence bound on acceptance, then compare complete expected cost and
   time. Abstain to the configured default when evidence is absent, stale, or
   incomparable. Current [`suggest-questions.ts`](../../src/shared/suggest-questions.ts)
   already retains model-conditioned effort answers and policy/model identity;
   this is the foundation, not an outcome-calibrated optimizer yet.

2. **Make recovery conditional on the kind of failure.** A compile/test failure
   or reviewed logic defect may justify more effort or a stronger model.
   Missing dependencies, permissions, CLI update menus, and unavailable checkout
   fingerprints need environment repair. Raising model effort does not repair
   those conditions. Permit a bounded retry/escalation only under the user's
   chosen budget; retain the original attempt and re-run the same acceptance
   gates. The [live trials](2026-09-19-relay-live-trials.md) supply concrete
   infrastructure failures that should not train “model incapable” labels.

3. **Compare complete policies, including fallback.** For one cheap-first
   attempt, a useful accounting identity is
   `E[cost] = cheap attempt + validation + P(escalate) × E[fallback cost | escalation]`.
   Include paid routing, failures, retries, cache loss, and review in the
   appropriate terms. Compare this with going directly to the capable route,
   under the same acceptance and time requirements. Do not assume fallback
   cost or success is independent of the failed first attempt. This is a
   decision model to fit with evidence, not a claim of known probabilities.

4. **Optimize accepted throughput as well as spend.** Report total comparable
   spend divided by accepted tasks, accepted tasks per wall-clock hour, first-pass
   acceptance, retries, p50/p95 completion time, and operator intervention minutes.
   Include failed tasks in the cost numerator; an empty accepted denominator is
   undefined, not zero. Report unpriced sessions separately. Reserve enough budget
   for verification/review, and account for shared provider queues and rate limits.
   None of the quoted percentages establishes this full Relay objective.

5. **Calibrate without pretending the current three trials are sufficient.**
   Freeze task-family labels, model/effort/harness versions, starting commit,
   recipe, and billing basis. Keep training, threshold selection, and evaluation
   tasks separate; split by repository/task family to reduce near-duplicate
   leakage. A calculation illustrating sample size: for one preselected rule,
   59 independent trials with zero harmful downgrades give a one-sided 95%
   Clopper–Pearson upper bound below 5% (`1 - 0.05^(1/59)`). Searching many rules,
   model drift, and dependent tasks require additional treatment; this is not
   a recommended universal sample quota or a current Relay guarantee.

6. **Start with replay and shadow recommendations.** Replay stored Jev answers
   and observed costs locally. This can test decision logic and agreement, but
   cannot invent what an unchosen model would have done. An explicitly consented,
   capped paired trial can add those missing outcomes. Only promote a policy
   after it beats the fixed-route baselines on an untouched task set without
   unacceptable regressions. Continuous bandit exploration and parallel
   best-of-N should wait for evidence volume and explicit spending consent.

All semantic learning must retain Wanigan's same-backend and consent rules.
Cross-backend operational counts are useful; routing improvements do not justify
sending source, diffs, tool output, or native transcripts to Jev, a new embedding
service, or another provider. Keep decisions at stage/retry boundaries and use
the required module seams for any future implementation. The earliest valuable
deliverable is an offline evaluator with honest counterfactual limits, followed
by a conservative calibrated policy—not a replacement agent runtime.

## Existing implementation seams

- [`relay-route.ts:chooseStage`](../../src/shared/relay-route.ts) is the pure
  legality/precedence boundary. Keep it authoritative; a future local scorer
  should rank only admissible model–effort pairs upstream and preserve operator
  priority. Record learned-policy evidence separately from Jev's answer.
- [`relay.ts`](../../src/main/relay.ts) performs the batched suggestion and route
  selection in both creation and preview. Both paths need the same pure policy;
  Manual must continue to bypass paid routing. Retry decisions belong at the
  existing stage lifecycle boundary, with a bounded budget and explicit reason.
- [`modules/control.ts`](../../src/main/modules/control.ts) owns the
  `work_model_outcomes` schema and
  [`control.ts:outcomes`](../../src/main/control.ts) exposes it. Build a local
  evaluation view over outcome/attempt evidence through this module seam;
  retain rejected and infrastructure-failed attempts instead of training only
  on successful completions. Human acceptance and passed checks need distinct
  labels; absent pricing stays absent.
- [`relay-forecast.ts`](../../src/shared/relay-forecast.ts) supplies descriptive
  medians with a three-sample minimum and progressively broader route matching.
  That is useful for planning but is not enough for a risk certificate. Keep
  pooled forecasts separate from held-out, exact-route quality calibration.
