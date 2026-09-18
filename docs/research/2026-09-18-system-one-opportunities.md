# What else Wanigan could do with a System One model

A read of every page of `docs.typesafe.ai` — concepts, primitives, patterns, all
eighteen cookbooks — plus the community routers that appeared in the three days
since Jev launched. Companion to `2026-09-18-system-one-by-example.md` (the
mental model) and `../superpowers/specs/2026-09-18-typesafe-suggester.md` (what
we built).

Two things in here are corrections to the suggester we just shipped. The rest
are opportunities, ranked, with the ones Wanigan's own rules forbid marked as
forbidden rather than quietly dropped.

---

# Part one: what we got wrong

## 1. We make four calls where one would do

`createRelay` asks once for the pipeline, then once per agent stage. Three
stages is four round trips for one intent.

The `parallel_questions` cookbook measures the alternative: thirteen questions
batched into one request is **12.2× cheaper and 10.0× faster** than thirteen
calls, because "the document dominates every request. N single-question calls
pay for it N times, in N round trips; the batched call pays once." And quality
does not change — "each question receives independent scoring against the
document, so its answer doesn't depend on what else is in the request."

`jev-harness-router` in the wild sends **~20 questions in one call** for a whole
agent turn — model tier, effort, tools and skill — at a median 351–376 ms.

The fix is `patterns/fan-out.md`, which is the same pattern we already use for
the three questions inside one stage, applied one level up: ask the pipeline
choice *and* every stage's model choice *and* every stage's deliberation score
in a single request, then have code consume only the stages the pipeline
answer kept. Speculative questions about stages that get narrowed away cost
tokens on a call we were making anyway, and cost no latency at all.

Expected: 4 calls → 1, and the preview stops being noticeably slower than the
profile default it replaces.

## 2. The candidate list is in the state *and* in the criteria

`stageRequest` puts `candidates` in `state` and the same rows again in the
choice's `criteria`. That is wrong three times over:

- `skill_suggestion` keeps the 182-skill roster **out of state entirely** —
  "the roster itself isn't in state (it's loaded once), preserving prefix
  caching across all turns." We defeat that caching by restating it.
- The jaggedness page says accuracy falls as state grows with content unrelated
  to the decision. The duplicate is exactly that: unrelated to every question
  except the one that already has it.
- We pay for the tokens twice.

The state should be the stage and the operator's words. The candidates belong
only where they are the answer space.

---

# Part two: things worth building

Ranked by what they would actually change, with the source cookbook for each.

## A. Which skill, MCP server or extension this session needs — **highest value**

`cookbooks/skill_suggestion.md`, and the reason this document exists: several
independent implementations of exactly this appeared within days of launch
(`jev-skillful`, `jev-harness-router`, `typesafe-skill-router`, `pi-jev`).

The measured problem it solves is one Wanigan has. A large roster degrades
selection because index descriptions are truncated and ambiguous. The cookbook
takes **182 skills** and cuts wrong loads from **16.8% to 7.3%**, and needless
loads from **9.8% to 4.0%**.

The shape is two stages:

1. **Wide rank.** One `choice` over the entire roster (255 options max) using
   short index descriptions, plus **three `noul`s** asking whether the request
   needs action on real systems, whether it follows a documented procedure, and
   whether prose alone would do. The mean of those three, over a `0.30` gate,
   decides whether *any* skill is wanted. That "does this need a procedure at
   all" question is the part we do not have anywhere.
2. **Shortlist verify.** A second call over the top three with *full*
   descriptions plus opening body text, and one `fits` noul per candidate. The
   best must clear `0.30` or nothing is suggested.

Wanigan has the roster already: project and personal skills, installed
extensions, MCP servers, gates. It has the injection point too — session launch
already composes instructions. And the wording the cookbook uses is exactly
Wanigan's posture: *"Relevant to the current request: [skill]. Ignore this if it
does not fit what the user actually asked for."* A suggestion that says ignore me.

The honest caveat comes from `jev-skillful`'s own README, and it is the right
one to keep: *"Whether injecting a suggestion actually makes an agent complete a
task better is the question that matters, and it is unanswered."* Their
recall@K was 0.824 on dev and **0.600 on holdout** against a 0.90 target. So
this ships as a suggestion with a measurement, or it does not ship.

## B. Semantic citation checking in the learning engine

`cookbooks/citation_check.md`. `AGENTS.md` already requires: "Validate citations
immediately before briefing retrieval. Quarantine stale, missing, changed or
out-of-root evidence."

Every one of those checks is structural. A citation can be present, unchanged,
in-root and still **not support the claim it is attached to**. The cookbook
closes exactly that gap with a two-step: exact string match first (fabricated
quotes die there, free), then one `choice` over `supports` / `contradicts` /
`says_nothing`. At confidence **≥ 0.8** the verdict stands; below, a person
looks. On RFC 7519 it verified 4, caught 1 fabricated and 1 contradicted, and
escalated 2.

This is the strongest fit in the whole doc set, because it adds a check Wanigan
already believes in and cannot currently perform, on evidence Wanigan already
holds, with a threshold the vendor measured rather than guessed.

## C. Classifying briefing passages before they reach a session

`cookbooks/classifying_rag_passages.md`. `AGENTS.md`: "Keep briefings
query-scoped and inside their configured token budget."

Four questions per passage, thresholded in a fixed order: injection > 0.70
excludes; contradicts-premise > 0.70 goes to a **separate conflict block**;
relevance < 0.45 excludes; evidence > 0.55 includes. The insight is the one
Wanigan would otherwise get wrong: *"merge them into one and the generator has
no way to tell a passage that answers the query from one that denies its
premise."*

It also means a briefing that would have quietly reinforced a false premise
instead arrives labelled as a conflict.

## D. A cascade for headless and batch work

`cookbooks/sde_cascade.md`. A cheap model extracts; a verifier asks narrow
per-field noul questions about whether anything is wrong; anything over `0.70`
escalates to the expensive model. The result "sits up-and-left of every single
model" on the cost/quality frontier across 100 prompts, against a reasoning
model costing ~7× the mini.

Wanigan runs headless fan-outs and batch submissions where this is the whole
game. Note it does not need agent output in the state as a *judgment* — it
needs per-field checks on structured extraction, which is a narrower and safer
surface than "review this diff".

## E. Attention classification

`AGENTS.md` already names the attention classifier as a built-in default that
proves an extension point is real. "Which project needs your eye right now" is a
semantic judgment, the stakes of a wrong answer are one unnecessary
notification, and `src/main/attention.ts` exists. `patterns/confidence-routing`
is the shape: a universal floor around 0.6, higher bars for louder alerts.

## F. Duplicate knowledge items, with a curator lane

`cookbooks/entity_alignment.md` is a nice trick: instead of tuning a similarity
threshold, use a **three-level `score`** whose levels *are* the decisions —
different (leave), related-but-uncertain (curator), same (merge). On 450 pairs:
8.9% merged, 11.1% to the queue, 80% unlinked, **with no parameter fitting**,
"only clear semantic descriptions of what each decision level represents."

Wanigan's review inbox is already the curator lane. This maps onto it directly.

## G. The long game: discover which features predict a good relay

`cookbooks/autoresearch_feature_discovery.md`. A loop proposes semantic
questions, turns the answers into numeric columns (a score becomes mean +
spread; a noul becomes a probability), fits a model, and reads the errors to
revise the questions. On 2,000 wine reviews it went from RMSE 1.87 to 1.77 over
five rounds with **38 auto-discovered questions and none hand-written**.

Wanigan records provider, model, effort and commit per phase and has an A/B
registry. The question this answers is the one the compound learning engine is
ultimately for: *which semantic properties of a task predict that it went well?*
It is also the only item here that would make `claimPossible()` richer rather
than just cheaper.

Far off, and it needs the controlled-experiment discipline `AGENTS.md` demands
before any of it could be called causal.

---

# Part three: forbidden, and why

**The learning classifier.** `src/main/learning/classifier.ts` assigns
confidence by hardcoded constant — `0.56`, `0.75`, `0.95` — where a calibrated
probability belongs. It is the most obvious candidate in the codebase.

It is also forbidden. `AGENTS.md`: "Semantic model assistance may inspect
content only through the same backend that first processed it, and only when the
signal opted in. Cross-provider operational counts are fine; cross-backend
semantic content is not." Jev is a different backend from whatever produced the
signal. Routing learning content to it breaks the rule that makes the learning
engine's privacy claim true.

Not a thing to work around. If it is ever wanted, the rule changes first, in
`AGENTS.md`, deliberately — and the rule exists for a good reason.

**Verdicts on agent output.** Already settled in the spec: the model is
documented as not treating state as hostile, and a verdict is what an attacker
wants moved. Note the nuance the cookbooks add: you *may* ask about hostile
content as the **subject** of a question — `llm_guardrails` scores a
"Neurosemantical Inversitis" jailbreak at 0.74 and blocks it, and
`classifying_rag_passages` runs an injection noul. What you may not do is trust
a judgment about *something else* when the input is adversarial. Detecting
injection is fair game. Approving a diff is not.

---

# Part four: the technique notes worth keeping

Small things from across the docs that change how questions get written.

- **Confidence for a multi-part decision is the minimum, not the product.**
  `function_calling`: "confidence reports the least certain judgement in the
  call, rather than the product of all of them," because one wrong argument
  invalidates the whole call.
- **Closed sets kill hallucinated arguments.** Arguments drawn from `Literal`
  types mean "whatever reaches the function is a value the function accepts."
  The same trick as our effort ladder, generalised.
- **Decision bands beat thresholds.** `consistency_noul`: below 0.30 no,
  0.30–0.70 uncertain, above 0.70 yes. It absorbs run-to-run fluctuation
  instead of letting a 0.43–0.53 wobble flip a 0.5 gate.
- **Consistency is measurable without labels.** Run the same question 15 times
  with fresh uids and take the probability standard deviation. Jev's mean
  per-question σ was **0.0102**. This is how our three uncalibrated 0.8s get
  replaced by numbers, and it needs no ground truth — only repetition.
- **A threshold buys coverage, not just accuracy.** `classification_using_confidence`:
  at 0.9, half the filings are 90% right and half are 40% right. Rather than
  discarding the uncertain half, it **reports a coarser answer** — the division
  instead of the group — taking 39/60 correct to 48/60 useful. The relay
  analogue: when unsure of the effort, name the model and leave the effort to
  the profile. Which is exactly what we already do, arrived at independently.
- **Beam search for deep taxonomies.** `hierarchical_classification`: keep K
  paths, rank by `product(edges) ** (1/decisions)` so depth is fair. Beam K=3
  got 4/4 where greedy got 2/4.
- **Structured criteria for confusable options.** `primitives/advanced`: an
  option's description can be an object with `what`, `not_for` and `examples`.
  Our pipeline criteria are bare sentences and would sharpen this way.
- **Hard limits.** 255 choice options; 2–10 score levels; 64k context with 32k
  for state plus the longest question; text only, English strongest.

---

# What I would do next, in order

1. **Batch the relay's calls into one** (Part one, §1). Pure win, no new
   surface, and it makes the preview feel free.
2. **Take the candidates out of the state** (Part one, §2). A three-line fix to
   a real accuracy and cost bug.
3. **Measure consistency** rather than arguing about 0.8 — 15 repeats per
   question, report σ, set decision bands from what comes back.
4. **Semantic citation checking** (B). The best fit in the doc set: a check
   Wanigan already wants, on evidence it already has, at a measured threshold.
5. **Skill routing** (A), as a suggestion with a measurement attached, not as a
   silent injection — and only once there is a way to tell whether it helped.

---

# Part five: what the ecosystem built, three days in

A GitHub sweep by stars. Included because several of these solve problems
Wanigan has, and one of them corrects a recommendation made above.

| Stars | Project | What it is |
| --- | --- | --- |
| 5336 | `browser-use/jev-ultrafast` | Speed work on the inference path |
| 3100 | `tamaratran/fast-jev-compaction` | **Claude Code plugin replacing the compaction summary with keep/drop decisions** |
| 1562 | `TheoLeeCJ/SemIf` | Semantic `if` on open models, at home |
| 513 | `Anil-matcha/awesome-jev-by-typesafe` | The catalogue below is largely from here |
| 358 | `TianyuCodings/NanoJev` | A nano replica — parallel decisions, dynamic candidates |
| 294 | `thruwire/foreman` | **A supervisor loop watching a coding agent** |
| 264 | `devagrawal09/jev-review` | Staged code review over a diff |
| 133 | `gargpratyush/jev-router` | **Per-turn model tier routing for Claude Code** |
| 117 | `NiazMorshed2007/jev-review` | Local-first MCP plugin for continuous quality review |
| 4 | `abhixhek/jevcal` | **Threshold calibration and drift checking** |

Three `awesome-jev` lists, an open reimplementation (`wfzyx/von`,
`ekzhang/openjev-sglang`, `jaredpalmer/kev`) and a Ruby, an Elixir/OTP and a Go
client exist already. This is moving fast enough that anything we build against
it should expect the surface to shift.

## 1. `jevcal` corrects Part four's advice, and it matters

I wrote above that consistency measurement would "replace our three
uncalibrated 0.8s". That was wrong, and the distinction is worth being precise
about:

- **Consistency** (σ over repeated runs, needs no labels) measures whether the
  model gives the *same* answer twice. Jev's was 0.0102.
- **Calibration** (needs labels) measures whether the answer is *right*, and
  whether a threshold buys the accuracy you wanted.

`jevcal` does the second properly: thresholds fitted on one half of the data
and **verified on the held-out half**, a `--conservative` mode requiring the 95%
lower bound rather than the point estimate to clear the target, and a
`decisions.lock.json` recording "thresholds + the evidence behind them" so a
`check` command can exit 1 on drift in CI. Its own warning is the one that
binds us: **under ~100 labeled rows per question, thresholds do not hold.**

So our honest position is: we can measure stability today, and we cannot
calibrate until relays have accumulated outcomes worth labelling. The 0.8s stay
declared guesses until then, and `jevcal`'s lockfile-and-drift-check shape is
the thing to copy when there is data.

## 2. `foreman` is Wanigan's supervisor loop, already written

It runs two loops — a Codex worker, and an independent watcher asking **nine
noul questions in one parallel call**:

- Job: implementation complete, tests sufficient, requirements satisfied, needs
  independent verification, ready to finish.
- Floor: meaningful progress, worker stuck, work tracked, **needs a human**.

A Python policy turns those into `CONTINUE`, `STEER_WORKER`, `STOP_WORKER`,
`RETRY_WORKER`, `START_VERIFIER`, `FINISH`, `ESCALATE`, ordered safety-first.

Wanigan already has every one of those concepts: `attention.ts`, hand-backs
bounded by `HANDBACK_LIMIT`, a verify phase, a review inbox. What it does not
have is a *semantic* read on "is this worker stuck" — it has elapsed time and
tool-call counts. The author's framing is the right one: *"Supervisory questions
such as 'is this worker stuck?' are narrower"* than the work itself.

Their own caveat is also right, and applies to us: no measured results, and
"significant limitations around Jev calibration and accuracy for this use case."

## 3. `jev-router` has a better idea than ours: asymmetric confidence

Four signals — task complexity, reasoning requirement, tool complexity, context
size — and a policy worth copying nearly verbatim:

- Explicit requests win (`use opus`). Ours does this already.
- **Low confidence prevents downgrades and caps upgrades at balanced.**
- Large conversations avoid downgrades that would waste cached tokens.
- Unavailable tiers escalate upward rather than falling back to something weaker.
- Tool-loop continuations keep the tier chosen at the start of the turn.

The second one is the insight. We treat an unconfident answer symmetrically —
below the bar, drop it entirely. But the two mistakes are not symmetric:
downgrading on a weak signal under-provisions the work, while upgrading on a
weak signal only costs money. A threshold that is one number in both directions
is measuring two different risks with one instrument.

That maps onto our effort ladder directly: an unconfident deliberation score
should be allowed to move effort *up* from the profile default and not down.

## 4. `fast-jev-compaction` is the one I did not see coming

3,100 stars for replacing an LLM-written compaction summary with per-tool-call
keep/drop judgments. Two nouls per call — should the call stay, should its
result stay verbatim — over a state where results are replaced by
`ok, 4213 chars (omitted)` placeholders so the model sees shape without bulk.
Above 0.5 keep; call-only keeps a 300-character truncation; below, drop both.

The argument is exactly the one Wanigan makes about evidence everywhere else:
*"A summary is lossy: a file path, exact error, constraint, or command can
disappear even when it matters later."* It never rewrites; it keeps verbatim or
removes.

Wanigan meters `MEMORY.md` overflow in its Context view and owns a transcript
archive. "Which of this survives, verbatim" is a decision it already makes by
line count and could make by meaning — and doing it this way preserves the
"recorded evidence is the source of truth" premise, because nothing is ever
reworded.

## 5. `jev-review` partly answers the objection I raised

I argued a verdict over a diff is unsafe because the model is not hardened
against hostile state. `jev-review` mitigates rather than ignores: it *"selects
concrete diff hunks or source regions before scoring impact"* rather than
judging raw diffs, and uses "structured hints, counterexamples, and explicit
decision boundaries."

Select-then-judge narrows what reaches the model and is a real technique. It
does not make an *approval* safe — an attacker still wants that outcome moved —
but it makes an advisory read over a diff defensible in a way I said it was not.
The line I would now draw: a judgment that **raises** attention is fine on
selected regions; a judgment that **lowers** it is not.

Related and worth a look if we go there: `jev-git` (pre-commit diff risk gates),
`is-malicious` (source, config and CI scanning), `jev-guard` (tool-call risk
scoring — which is Wanigan's policy layer).

## 6. The local-model escape hatch

`wfzyx/von` describes itself as "the open-source System One decision model.
Sub-15ms, non-autoregressive, local," and `openjev-sglang`, `openjev` and `kev`
are all reimplementations against open weights.

This matters more to Wanigan than to most, for one specific reason. The
learning classifier is forbidden from semantic assistance (Part three) because
routing content to Jev crosses a backend boundary. **A local System One model
does not leave the machine at all.** That does not automatically satisfy the
rule as written — the rule is about backends, not about egress — but it removes
the concern the rule exists to protect, and it would be the right moment to
revisit the wording deliberately.

Worth watching rather than acting on: none of these are close to the hosted
model's quality yet, and Wanigan should not stake a privacy claim on a weight
file somebody published last week.
