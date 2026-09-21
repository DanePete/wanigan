# Jev, Relay, and cost versus quality

Checked 2026-09-19 against current TypeSafe documentation and the local
implementation. This is documentation research and source inspection, not a
live API test or a measured Relay benchmark. No credentials were read and no
paid requests were made.

Jev fits a narrow role: supply semantic judgments; Wanigan chooses the allowed
workflow and LLMs perform the coding. The current request shape supports that
division. It does **not** establish that Relay finds the cheapest route that
meets a quality target. That requires cost and outcome evidence which a
confident model-name choice does not supply.

## Verified service contract

The current evaluation endpoint remains `POST /v1/systemone`, with bearer
authentication and `state`, `model`, and a `questions` map. Answers are keyed
by question id; ids themselves are not inference input. `choice` returns a
chosen option, probabilities, and confidence; `score` returns a weighted level,
legend, probabilities, and confidence; `noul` returns a probability without a
separate confidence. The response also reports model identity and token usage.
These shapes match `SystemOneRequest` and the readers in
[`suggest-questions.ts`](../../src/shared/suggest-questions.ts).
[TypeSafe API reference](https://docs.typesafe.ai/api).

Current pricing is $0.042 per million input tokens, with free output tokens.
The documented model is `jev-1.13.0`, currently also selected by `jev-latest`.
The context limits are 64k total and 32k for state plus the largest question;
advertised rate limits may change during early access. **There is now a
documented authenticated `GET /v1/models` endpoint.** It lists available names,
descriptions, and release dates. The docs recommend pinning a version when
confidence thresholds were tuned to it, because aliases move.
[TypeSafe models](https://docs.typesafe.ai/models).

Choice supports at most 255 options. Its option names and descriptions are
both evaluated, unlike the question id. The docs recommend an explicit
other/none option when the offered list might not cover the input. A full
probability distribution sums to one; choosing the winner expresses relative
preference among those options, not proof that any option is sufficient.
[Choice](https://docs.typesafe.ai/primitives/choice).

Score takes 2–10 ordered, concrete descriptions. A fractional result is the
mean of level indices, not a physical measurement. Rounding is a documented
use, but different distributions can have the same mean. Confidence of one
means concentrated probability, not guaranteed correctness. Mapping that
result to a model's effort ladder is therefore a Wanigan policy to evaluate,
not a service guarantee of optimal reasoning effort.
[Score](https://docs.typesafe.ai/primitives/score).

## What current code gets right

Source inspection found the following boundaries in
[`suggest.ts`](../../src/main/modules/suggest.ts),
[`suggest-questions.ts`](../../src/shared/suggest-questions.ts), and
[`relay-route.ts`](../../src/shared/relay-route.ts):

- The optional module needs a readable credential and enabled capabilities;
  errors fall back to existing routes. It performs one attempt with a timeout.
- Operator intent is bounded, and repository contents or agent output are not
  inputs to the question builders. Candidates remain the profile's declared
  options, and operator choices outrank suggestions.
- Batched questions carry their stage meaning in instructions. Effort arithmetic
  stays in code and cannot leave the declared effort ladder.
- Pipeline narrowing preserves estimate, implementation, verification, and
  review. The estimate is local arithmetic rather than an LLM session.
- [`suggest-usage.ts`](../../src/main/suggest-usage.ts) records one usage row per
  successful HTTP call and freezes the computed cost. It records the returned
  model id when valid and leaves absent usage unmetered.

These choices agree with the vendor's guidance to decompose judgments and
combine their results in ordinary code. They provide structural safety, which
is separate from the semantic accuracy of the chosen route.
[Introduction](https://docs.typesafe.ai/introduction).

## Mismatches and limits that matter

| Finding | Evidence and consequence |
| --- | --- |
| Credential checking need not inherently run inference | `suggest.ts:verify()` and the September 18 spec say `/v1/models` does not exist and issue a real evaluation. The current [models documentation](https://docs.typesafe.ai/models) contradicts that premise. A schema-checked catalogue request can test authenticated access without performing an evaluation. Such a check would establish catalogue access, not end-to-end inference health. |
| The routing question has no explicit cost/quality objective | `relayPlanRequest()` asks for the best-fitting model using catalogue descriptions, truncated to 160 characters, or labels. Its inputs do not include prices, measured completion quality, retry cost, or a quality floor. `profileFor()` also constructs offers within an already selected provider profile. The present contract cannot establish a global cheapest acceptable route. |
| Thresholds are policy guesses | The route, deliberation, and pipeline gates use 0.8. The latter two explicitly call themselves uncalibrated. The [confidence documentation](https://docs.typesafe.ai/confidence) says thresholds depend on workload and consequences and should be checked against domain data. A concentrated preference does not mean an 80% probability of passing Wanigan's acceptance checks. |
| Aliases weaken reproducibility | Requests use `jev-latest`; usage records returned identity, but `RelayPlanReading` does not carry that identity alongside the route decision. A frozen model version, question/rubric version, candidate catalogue, and outcome link would make calibration and drift analysis reproducible. This is an engineering inference from the [alias guidance](https://docs.typesafe.ai/models). |
| Readers accept less than the full published answer contract | `distribution()` accepts any finite nonnegative value, including values greater than one; readers do not require matching answer `type`, complete candidate keys, or normalized mass. A supplied `choice` and confidence can therefore route even when the distribution is malformed. This is an offline hardening gap against the [documented answer schema](https://docs.typesafe.ai/api), not an observed failure of the live service. |
| Published batching numbers are not Relay results | Comments in both suggester files call batching 12.2× cheaper and 10× faster. Those are vendor cookbook results for a 13-question, roughly 54k-character GDPR document, comparing a batch with sequential individual calls. Relay bounds intent at 2,000 characters. Its actual token ratio depends on shared state versus question length. [Parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions). |

Batching remains a sensible design: independent questions can share state and
avoid round trips, while code ignores inapplicable answers. Extra questions
still consume input tokens, so batching is not a reason to ask questions whose
results are never used. The exact latency benefit is a workload observation,
not a guarantee. [Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out),
[Choice](https://docs.typesafe.ai/primitives/choice).

## Jev cannot provide the quality guarantee on its own

The vendor documents unreliable arithmetic/counting, weak numerical score
calibration, date-comparison failures, trouble with indirection, reduced
accuracy from irrelevant state, and susceptibility to adversarial state.
Separate questions also need not satisfy identities such as complementary
probabilities. A relative choice and an absolute suitability question are
different judgments. These limits support keeping budget arithmetic, allowed
routes, consent, verification, and escalation in Wanigan code.
[Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

TypeSafe's launch speed/cost comparisons are vendor results for structured
decision workflows. Their reference answers are probabilities from other
models, not a benchmark of accepted software changes. The vendor also qualifies
its zero-hallucination claim as schema validity. None of this demonstrates that
a selected cheaper coding model finishes a Relay task with equal quality.
[Launch methodology and caveats](https://typesafe.ai/blog/introducing-system-one-models-and-jev).

A more relevant vendor example combines Jev with an LLM for skill selection:
its published experiment reports fewer wrong skill loads, but also records
seven requests that the added suggestion broke among 315 covered requests.
It measures one turn's skill selection, not final code quality. This is useful
evidence that cooperation is plausible and should be measured; it does not
transfer the result to Relay model routing.
[Skill suggestion experiment](https://docs.typesafe.ai/cookbooks/skill_suggestion).

## Recommended acceptance criterion for the next routing design

This is an engineering recommendation, not a verified property of Jev:
minimize expected **total cost of an accepted change**, subject to a declared
quality floor and budget. Count planning, implementation, verification, review,
failed attempts, escalation, and suggester overhead. A low input-token price
alone is not that objective.

Keep exact prices, constraints, and comparisons in code. Let Jev provide narrow
task judgments and uncertainty. Use actual LLM runs and deterministic checks to
establish whether a route meets the floor, and retain a conservative default
when evidence is insufficient. Evaluate route candidates on the same task,
commit, acceptance checks, and documented model/effort settings before claiming
savings. Measure acceptance rate, reruns, total metered cost, and elapsed time;
distinguish missing usage from zero usage. Thresholds need held-out labeled
outcomes, not merely stable answers across repeated Jev calls.

The immediate justified work is contract maintenance and honest measurement.
The stronger claim—Jev plus LLMs selects the cheapest professional result—remains
an outcome to demonstrate with Relay evidence.
