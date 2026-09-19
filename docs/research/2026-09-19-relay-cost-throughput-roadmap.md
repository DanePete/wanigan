# Relay: lower cost and more accepted work

Research date: 2026-09-19. Implementation inspected at `e0eed17`.

## Recommendation

Broaden Relay's model pool to include hosted open models, direct APIs, existing
coding subscriptions, and optional local models. Then choose the cheapest
**complete path to an accepted change**: model, effort, context, checks, recovery,
and escalation. A low token price alone does not identify that path.

Keep JEV as a bounded source of task judgments. Deterministic code should own
price arithmetic, eligibility, budgets, evidence, and execution. Learn which
judgments predict acceptance from local outcomes before treating them as success
probabilities. Fix wasted launches and recovery before training a complex router
on the resulting data. This is a recommendation, not a measured savings claim.

Supporting investigations:

- [Model and effort routing](2026-09-19-relay-routing-frontier.md).
- [Context, caching, and tool efficiency](2026-09-19-relay-context-efficiency.md).
- [Execution reliability and integration feasibility](2026-09-19-relay-reliability-throughput.md).
- [OpenRouter and open-model economics](2026-09-19-relay-open-model-economics.md).
- [Earlier JEV audit](2026-09-19-jev-relay-deep-dive.md) and
  [actual Relay trials](2026-09-19-relay-live-trials.md).

This pass produced research and an offline decision probe. It did not change
product behavior, connect credentials, install models, or launch paid provider
experiments. The proposed integrations below are not shipping capabilities.

## A wider model market, with a small proven working set

Inventory broadly; evaluate selectively. Discover available models and endpoint
prices automatically, eliminate incompatible choices, and trial a few promising
routes. Paying to benchmark every listed model would itself waste the budget.

[Models.dev](https://github.com/anomalyco/models.dev/blob/dev/README.md) provides
community-maintained machine-readable model and provider metadata, including
prices, capabilities, open weights, and serving limits. Use it for discovery;
verify prices against the actual service. A model identity and a hosting endpoint
are different records, with potentially different limits, pricing and behavior.

Use a versioned catalogue containing source URL, retrieval time, model revision,
endpoint, currency/unit, input/output/cache/reasoning prices where documented,
fees, context tiers, supported controls, availability, and license metadata.
Unknown is distinct from zero. Keep the price snapshot used for each decision.
List prices can change; update discovery without silently rewriting historical
costs or changing a running task's route.

OpenRouter is a useful candidate gateway. Relay still needs a real coding harness
to edit files and use tools, compatible reasoning/tool protocols, and trustworthy
usage attribution. A model appearing in an API catalogue does not verify those
capabilities in Wanigan. See the integration and economics memos for the concrete
adapter boundaries and primary documentation.

OpenRouter already offers a [Pareto coding router](https://openrouter.ai/docs/guides/routing/routers/pareto-router):
it picks the cheapest available model within a coding-benchmark tier, with
same-tier availability fallbacks. Its score is a relative benchmark tier, not
the chance of passing a Wanigan task; session stickiness is best effort. Treat
it as a baseline worth testing, not a replacement for local acceptance evidence.

There is also a direct [JEV-verified cascade recipe](https://openrouter.ai/docs/cookbook/evaluate-and-optimize/jev-verified-cascade):
cheap draft, JEV check, at most one stronger-model attempt, then human handoff.
It checks answers against help-center excerpts, not repository behavior. Its
reported fixture also includes a cheaper single-model baseline with zero wrong
answers, so adding a verifier has not automatically earned its cost. Reuse the
bounded decision structure; preserve real tests and human acceptance in Relay.
The routing memo examines the implementation, accounting and content boundaries.

Suggested initial pool, subject to conformance and local task results:

| Lane | Intended use | Economic question |
| --- | --- | --- |
| Existing subscription harness | Work covered by an already-paid plan | Is there available quota without new cash spend, and what capacity must remain for harder work? |
| Economical hosted open model | Bounded changes, implementation from a clear plan | Does its tool/edit reliability keep retries and review below the alternative? |
| Strong hosted model | Difficult diagnosis, architecture, trust boundaries | Does paying more initially avoid expensive failed attempts? |
| Small local model | Optional classification, narrow transformations, offline/private tasks | Is observed quality and speed sufficient after memory pressure and operator time are counted? |

A read-only hardware check found Apple M2 Pro and 32 GiB RAM. This makes a
bounded local experiment reasonable; it does not prove a particular model fits
with the necessary context or matches hosted coding quality. Count model weights,
KV cache, competing apps, load time, sustained throughput and power. Do not buy
hardware before a representative trial on the existing machine.

Separate marginal cash spend, subscription allocation, quota consumption, and
local operating cost. A small API charge can increase out-of-pocket spending
relative to unused subscription capacity; a slow local model can decrease useful
output despite having no per-token bill. Neither should be labelled simply free.

## What to measure

Freeze submission cohorts and observation cutoffs so fast-reviewed work does not
silently replace unfinished work in comparisons. Define a quality floor and
latency tolerance before choosing the lowest cost, or show the cost/quality/time
trade-offs explicitly. Dollars, quota and operator time remain separate axes
unless the operator supplies a conversion policy.

| Measure | Definition and qualification |
| --- | --- |
| Cost per accepted result | All attributable cohort cost, including failed/rejected attempts, routing, paid summaries and review, divided by final accepted tasks. No finite value when none are accepted. |
| Throughput | Accepted tasks per elapsed wall-clock hour, with task mix shown; simultaneous agents do not create extra elapsed hours. |
| Time to acceptance | Submission through final human acceptance, separating queue, execution, verification and human waiting where observed. |
| First-pass acceptance | Acceptance without repair or requested changes; unresolved tasks stay separately visible. |
| Durability | Reopened/regressed results and subsequent repair cost over a declared follow-up window. |
| Evidence coverage | Attempts with dollars, tokens, cache buckets, effective route and timestamps; missing coverage accompanies comparisons. |

Unfinished work has no acceptance verdict but still consumed resources. Include
its expenditure without inventing rejection labels. Count a goal once, not its
plan, implementation and verification as separate accepted changes. Deduplicate
billable events instead of summing repeated cumulative review snapshots. Unknown
dollar costs remain unknown; token estimates are not subscription invoices.

Current final review propagates one human verdict to every launched phase
(`control.ts:1232`). That labels the completed path; it does not establish each
participating model's independent success probability. Keep policy-level
acceptance and attempt-specific failure causes distinct in future training data.

## Concrete gaps in today's implementation

| Observation | Local evidence | Improvement |
| --- | --- | --- |
| The chooser has descriptions and confidence, not calibrated economic predictions | `suggest-questions.ts:165`; `relay-route.ts:207` | Compare legal model/effort policies using acceptance evidence, whole-path cost and time. |
| Routing precedes historical forecasting | `relay.ts:301–321`, `historyFor():597`, `forecastFor():646` | Keep descriptive forecasts separate from a future route-ranking model. Completed-phase medians exclude unfinished work and can pool mixed attempts under a current route. |
| Preview and create ask JEV twice | `relay.ts:394–430` | Reuse a main-owned, validated decision receipt for unchanged input. |
| Some phases need no model | `control.ts:694`, `runGate()`, direct final human review | Route by actual executor type; don't ask for a model to run arithmetic, commands, or a human decision. |
| Existing capsules already carry plans and requested changes | `control.ts:646` | Extend with concise validated evidence rather than adding a second full-history prompt. |
| Automatic retries use inconsistent cost coverage | `control.ts:1659`, `stopGateTarget():1788`, `goal-gate.ts:154` | Apply one resource-authorization rule at every automatic paid boundary. |
| Session cleanup can defeat task recovery | `sessions.ts:511`, `sessions.ts:1935` | Current-input readiness checks and task-owned checkout retention. |
| Private dependencies are available but not guaranteed | `worktree-bootstrap.ts:46`, `worktrees.ts:443–496` | Require private trees for mutating dependency work; don't silently accept link fallback as isolation. |
| Frozen outcomes omit cached input | `control-outcomes.ts:38–39`, `codex-usage.ts:64–74` | Record supported usage buckets and baseline/delta attribution for resumed threads. |
| Local pack catalogue identity does not match Relay's effective backend identity | `providers.ts:371–374`, `launch-choices.ts:160–167` | Resolve namespaced backend identity consistently before relying on live catalogues for local packs. See the integration memo's mocked-dependency probe and limits. |

The startup-menu, missing-retry-tree and shared-dependency failures were observed
in the live trials. Other rows are source observations, not claims of live failure.

### Offline budget probe

Using Node 22.23.2, the pure `handBackVerdict` received enabled=true,
halted=false, returnsSoFar=0, budgetUsd=5, spendUsd=0, sessionStatus=running,
attention=finished/event:7 and stopEventId=7. It returned:

```json
{"send":true,"attempt":1}
```

`autopilotSpend()` can return numeric zero with `spendStatus: 'unreported'`;
`stopGateTarget()` forwards only the number. The retry cannot distinguish unknown
spend from measured zero. This confirms a decision gap, not live overspending.
Existing enablement and session-state checks still apply. Review hand-back in
`relay.ts:775` also checks only numeric spend, but merely reopens a node; assess
its subsequent launch separately rather than calling reopening a billed event.

## Implementation order

### 1. Reliable execution and complete accounting

Use one authorization contract for launches, automatic failure prompts, retries,
escalation, and optional paid routing/review. Distinguish actual dollars from
estimates and unknowns; consider concurrent in-flight work. Do not promise a hard
dollar cap when the harness cannot meter or stop a running call. Attempt and time
limits are useful separate controls for subscription CLIs, not dollar equivalents.

Retain checkouts while goals, retries, verification or human review need them.
Reuse existing checkpoints with launch-intent and receipt IDs to avoid duplicate
submission on recovery. A saved Git ref is not a live terminal. Detect the current
CLI input state rather than historical welcome text. Verify actual private
dependency placement before allowing installation/rebuild work.

Acceptance fixtures: update dialogs cannot receive an unintended Enter; a clean
failed attempt remains retryable; each resumed attempt is counted once; modifying
child dependencies leaves the parent untouched; cost coverage is checked before
every automatic paid action. Record billing mode and requested/effective route.

### 2. Broad catalogue, narrow verified integration

Add pricing/capability discovery as an extension. Start one OpenRouter-compatible
coding-harness integration with an explicit tested model/endpoint allowlist.
Verify tool execution, patch application, effort support, cancellation, session
identity, usage, error handling and resume separately. Expand only capabilities
that passed; a generic terminal integration can remain honestly limited.

Today's Relay chooses models within a selected profile. Cross-profile route
selection is additional work: build eligible profile/backend/endpoint candidates
first, then choose model and supported effort. Do not flatten endpoint-dependent
capabilities into a global model-name list.

Pin choices during comparisons. A gateway's automatic model/provider switch must
not make different backends look like the same training example. Record effective
model, endpoint, backend identity and price snapshot. Preserve explicit egress
consent and same-backend semantic-learning boundaries. Never silently allow a
fallback to widen provider access or the operator's spending authorization.

### 3. Avoid unnecessary paid decisions and repeated discovery

Represent executor type explicitly: computation, command gate, human, optional
agent. Required checks stay in the graph without requiring an extra LLM session.
Skip only questions whose answer is already fixed by a manual choice or a single
legal model/effort pair. One model can still have several effort settings, and an
otherwise useful batch may still contain an unresolved pipeline question.

For preview reuse, bind an opaque main-owned receipt to intent, preferences,
overrides, candidate/profile digests, policy version, consent and expiry. Recheck
eligibility and halt state at creation. Do not trust renderer-supplied model
output. The observed JEV estimate was small; this is principally a consistency
improvement, not the largest predicted saving.

Extend the current capsule with relevant entry points, module ownership, selected
symbols, current change identity, failed approaches and remaining check failures.
An [Aider repository map](https://aider.chat/docs/repomap.html) is an implemented
reference for bounded symbol selection. Assemble known facts locally and retain
full source on demand. Do not send repository content through JEV's deliberately
bounded operator-intent interface.

Run required commands unchanged. Preserve exit status and full evidence before
returning concise failures/counts, truncation markers and retrieval references.
Do not assume Relay can intercept a CLI's native tool output. Introduce context
controls only through version-tested capabilities.

The trials recorded 6,181,000 cumulative input tokens, including 5,789,568 cached
input (93.7%). This supports measuring repeated context, but proves neither waste
nor dollar savings. See the context memo for cache and API/CLI distinctions.

### 4. Task-specific routing and bounded escalation

JEV supplies task judgments; local code compares legal model/effort/context/
recovery policies. Its 0.8 answer concentration is not an 80% acceptance rate.
With sparse evidence, show a heuristic choice and uncertainty.

| Situation | Proposed behavior |
| --- | --- |
| Mechanical change with a precise check | Economical eligible model/effort, then required verification. |
| Unclear diagnosis or sensitive cross-module behavior | Stronger initial reasoning when evidence supports avoiding a failed cheap attempt. |
| Specific code failure after progress | One bounded repair if justified; retain the patch and concise failure evidence. |
| Repeated failure or newly discovered complexity | Escalate at the next supported boundary, or stop for a decision. |
| Auth, startup, missing checkout or dependency fault | Repair infrastructure; a stronger reasoning model is not the first remedy. |

Estimate fallback success conditional on the first route failing. The stronger
model's overall average pass rate is not a valid substitute. Include handoff,
context reconstruction, verification and paid review. Keep manual choices binding;
disclose and bound any automatic escalation. Don't imply live mid-conversation
model/effort changes where only a new-session launch is supported.

### 5. Selective specialization and concurrency

[Aider's architect/editor mode](https://aider.chat/docs/usage/modes.html) implements
separate planning and editing models, but also documents that the second request
can increase cost and latency. Evaluate a strong planner plus economical editor
on tasks with reusable plans; don't force two models onto a one-line change.
Use deterministic codemods, formatters and reusable modules where the requested
transformation is already expressible precisely.

For recurring work, reuse reviewed recipes and approved project modules instead
of paying to rediscover their design on every task. Bind retrieval to relevant
repository/version evidence and invalidate stale assumptions. Feed durable
learning through the existing review/projection rules; a successful run does
not authorize automatically publishing a new global instruction or skill.

For independent, non-urgent prompts, evaluate discounted asynchronous processing.
[Gemini Batch API](https://ai.google.dev/gemini-api/docs/batch-api) documents 50%
of standard interactive cost with a 24-hour turnaround target on supported
models. This could serve bounded offline evaluations or approved background
drafts. It is not a drop-in discount for a live CLI/tool loop; Relay would need
a distinct metered batch capability, and repeated submission must not duplicate
jobs. Include waiting time and all job failures in comparisons.

Parallelize independent work only with private state, non-overlapping claims,
available CPU/RAM/provider capacity, and room in the review queue. Google's
[CATS](https://research.google/pubs/cost-effective-agent-test-time-scaling/)
accounts for both tokens and tool calls when allocating sequential and parallel
search; those search results are not a coding savings prediction.

[Scaling Test-Time Compute for Agentic Coding](https://arxiv.org/html/2604.16529v1)
reuses structured rollout summaries, but its main parallel experiments use 16
rollouts plus selection. Borrow the bounded handoff concept; don't adopt its
fan-out as a cheap default or turn higher benchmark pass rates into dollar claims.

## Evaluation and product contract

Use a versioned local suite covering wording/UI, bounded logic, cross-module and
trust-boundary tasks. Include cheap-sufficient tasks, hard tasks, infrastructure
failures and requests that should pause. Compare current defaults, deterministic
policy, bounded cheap-first escalation, and JEV-assisted routing. Add promising
open models as candidates after compatibility checks, not as an uncontrolled
extra dimension on every experiment.

Include fixed economical, fixed capable, and task-independent mixed-route
baselines; a more complex router must beat those too. Offline replay and shadow
decisions reveal policy behavior but cannot establish outcomes of routes that
were never run. Historical operator choices introduce selection bias; consented
paired experiments are needed for causal savings claims.

Keep each task's starting commit, environment, acceptance recipe and review
standard identical. For context experiments fix provider/model/effort; for routing
experiments vary the route deliberately. Separate tuning and held-out tasks;
retries are not independent samples. Record harness versions and cache conditions.
The first pilot detects gross regressions; it cannot calibrate every route.

Report family-level acceptance and uncertainty alongside total cost/throughput.
[EcoAgent-Bench](https://arxiv.org/html/2608.05519v1) exposes policies that always
escalate or always save by testing opposite decision regimes. Its action prices
are abstractions and its workspace accounting differs from its tool track; it
does not establish Relay's dollar savings.

Include follow-up extensions to accepted implementations.
[SlopCodeBench v2](https://arxiv.org/abs/2603.24755v2) studies iterative extension
over 36 problems/196 checkpoints and measures code erosion and redundancy. It is
a deliberately difficult benchmark, not Wanigan's predicted failure rate. The
useful lesson is to measure future changeability and repair cost alongside today's
pass. Complexity or line counts alone should not become rejection rules.

Keep Auto/Manual and Lower cost/Balanced/Best quality. Add a separate allowed-model
pool and explicit fallback policy without requiring the user to study hundreds of
prices. Explain the initial choice, escalation trigger and retry ceiling in plain
language. Show accepted changes, attempts, time and cost coverage before token
charts. Never label JEV confidence as predicted correctness.

Implement selection/catalogue as extensions. Keep budget authorization, evidence,
session launch and acceptance in required modules. Control and Review already
have module hosts. Unconverted session/worktree ownership needs the required
behavior-preserving conversion first, in a separate commit before fixes;
`sessions.ts` already occupies its one urgent-fix ledger entry. Extend existing
capsules/checkpoints instead of adding competing state stores.

The recommended next build combines reliable execution/accounting with one
verified hosted-open-model lane, then measures whether it beats existing routes
on accepted work per dollar and per hour. Broad discovery and a small proven
working set offer a more economical starting point than training or testing every
available model. No saving percentage is promised before the comparison.
