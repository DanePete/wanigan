# The relay suggester on TypeSafe/Jev

How to build against a System One model, why almost every habit carried over
from an LLM integration is wrong here, and where the code lands in a repository
whose first rule is that a feature ships as a module.

Status: design. Supersedes the TypeSafe paragraph in
`2026-09-17-relay-design.md`, which was written from launch coverage before the
API docs were read. Three of its claims were wrong; §5 lists them.

## 1. Jev is not an LLM, and this is the whole design

Jev does not generate. There is no decoding loop, no token stream, no place for
a chain of thought to live. It takes program state plus a set of typed
questions and returns, in one parallel pass, a probability distribution per
question. That is the entire capability.

Every instinct from prompt engineering is either useless or actively harmful
here, and the failure mode is quiet: the call succeeds, returns a well-typed
answer, and is wrong.

| LLM habit | Why it fails on Jev | What to do instead |
| --- | --- | --- |
| Write a prompt, parse the reply | Nothing is generated; there is nothing to parse | Declare `state`, `instructions`, `criteria` as three separate JSON fields |
| "Think step by step" | No decoding, so no steps exist to take | Split the reasoning into separate questions and compose them in code |
| System/user roles, few-shot examples | No conversation and no message array | Put worked meaning into `instructions` and `criteria` as structured objects |
| Ask the model to return JSON | Output is typed by construction | Declare the options; an undeclared option cannot be returned |
| "How confident are you?" | On an LLM that is a *generated* token — a vibe | Confidence is computed from the real distribution |
| One big prompt does the whole job | Accuracy falls as unrelated state grows | One narrow judgment per question, many questions per call |
| Chain calls to refine | Questions in a call cannot see each other | One round trip, speculative fan-out, code picks the applicable answer |
| Let the model drive the workflow | It cannot call tools or hold a goal | **Code owns the workflow.** The model supplies semantic judgment only |

The inversion in that last row is the one to internalise. With an LLM you hand
over control and hope for structure back. With Jev you keep control and buy one
thing: a calibrated opinion about meaning, at ~100 ms, in a shape your code can
branch on without a parser.

### The jagged edges are load-bearing, not disclaimers

Quoted from `docs.typesafe.ai/model-jaggedness/jev-1.13.md`, because each one
rules a question shape out of this design:

- *"jev-1.13 does not count reliably."* — never ask how many files a task touches.
- *"Jev is not a calculator. We strongly recommend implementing any mathematical
  logic in code."* — the effort-ladder arithmetic in §4 is ours, deliberately.
- *"jev-1.13 reads dates as text, not as ordered quantities."* — no recency or
  staleness questions.
- *"Instructions carrying double negatives or complex indirection are answered
  less reliably."* — and *"a question about a property of a property … costs
  accuracy."*
- *"Accuracy falls as the state grows with content unrelated to the decision."*
- *"jev-1.13 does not treat [state] as hostile by default. Content written to
  adversarially steer the model … can move the answer."*

That last one is a security property, and it decides what may enter `state`.
**Repository content, file diffs and agent output must never reach it.** A
suggester fed a diff is a suggester an attacker can steer by committing a file,
and it would be steering a decision that spends the operator's tokens. The
state is the operator's own typed intent plus the enumerated candidate labels
Wanigan already holds. Nothing else. This is not a hardening step to add later;
it is the boundary the feature is built inside.

## 2. The verified contract

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <key>
Content-Type: application/json
```

```json
{ "state": "…", "model": "jev-latest",
  "questions": { "<id>": { "type": "choice|score|noul",
                           "instructions": "…", "criteria": … } } }
```

- **choice** — `criteria` is an object of `option_key -> description`. Returns
  `choice`, `probabilities`, `confidence`. Max 255 options.
- **score** — `criteria` is an *ordered array* of 2–10 concrete level
  descriptions. Returns `score` (a probability-weighted float that may fall
  between levels), `legend`, `probabilities`, `confidence`.
- **noul** — a binary proposition. Returns `noul`, a probability. **No
  confidence field.** §5 explains why that matters to our types.

Response carries `usage.input_tokens` / `usage.output_tokens`. Errors: 401 bad
key, 422 malformed question, 429 rate limit, 529 overloaded. Context is 64k
total, 32k for state plus the longest question. Rates: 250k tok/s, 1,200
req/min, "adjusting dynamically during early access". Price $0.042/MTok input,
output free, and TypeSafe says early pricing may be subsidised.

Question ids are *not sent to the model*. A question named `effort` that relies
on its own name to mean anything means nothing.

## 3. Why a System One model is what makes the extension point real

`AGENTS.md` says a feature ships as an extension, and that a capability only a
built-in can reach is an extension point that does not exist. It also says an
extension never loads code — `module-registry.ts` states the split plainly: a
third-party extension is "declarations over surfaces that already exist", a
module is "first-party code that *provides* one of those surfaces."

An LLM-backed suggester could not respect that. Prompt-and-parse needs a
parser, a retry policy and a schema fixer — all code, all necessarily shipped
by whoever wrote the prompt.

**A Jev question is pure JSON.** `{ type, instructions, criteria }` is data all
the way down, with no executable part. So a suggester extension can declare its
questions the way `provides.scoutSources` already declares a page to poll —
`ExtensionScoutSource` is the precedent, and it is the proof that `provides`
grows by adding a data shape rather than a plugin host.

That is the architectural payoff, and it is worth stating plainly: we are not
choosing Jev because it is cheap or fast. We are choosing it because its
interface is declarative, and a declarative interface is the only kind this
codebase can hand to a third party.

The built-in suggester is therefore a *default that proves the point*, in the
sense `AGENTS.md` means — the thing a contributed module is compared against.
It is **not required**: it spends money, so it must be switchable off, and
`WaniganModule.required` is `null` with the module saying what switching it off
costs (nothing but the suggestion; the profile default still runs).

## 4. The three questions, one request

The relay phases are `plan | estimate | implement | verify | review`
(`types.ts:1401`). `EFFORT_LEVELS` is `low | medium | high | xhigh | max`
(`types.ts:222`), and a candidate declares a *subset*: the router's own fixture
has Codex at four levels, Sonnet at two, and Opus at none.

That variability is the design problem the previous spec missed. `score`
criteria is one fixed ordered array per question, so there is no single score
question that covers three different ladders. Two ways out, and the second is
better:

1. Two sequential calls — choose the model, then score effort on that model's
   ladder. Correct, but it doubles latency and makes the suggester a two-hop
   dependency for no gain.
2. **Ask a model-independent question and do the ladder arithmetic in code.**
   "How much deliberation does this task need" is one coherent dimension that
   does not depend on which model answers it. Code then maps the result onto
   whichever ladder the chosen candidate declares.

Option 2 keeps every question independent, so all three go in one request and
run in parallel. It also puts the only arithmetic in code, which is exactly
what the jaggedness page asks for.

```jsonc
{
  "state": {
    "phase": "implement",
    "operator_intent": "<the operator's own words for this stage>",
    "candidates": [ {"id": "gpt-5.1-codex", "label": "Codex 5.1"},
                    {"id": "opus", "label": "Opus"},
                    {"id": "sonnet", "label": "Sonnet"} ]
  },
  "model": "jev-latest",
  "questions": {
    "model": {
      "type": "choice",
      "instructions": "Which of these models is the best fit for the described stage of work?",
      "criteria": { "gpt-5.1-codex": "…", "opus": "…", "sonnet": "…" }
    },
    "deliberation": {
      "type": "score",
      "instructions": "How much deliberation does this stage of work require?",
      "criteria": [
        "A mechanical change whose shape is fully determined by the instruction.",
        "A change with one obvious approach and a few details left to the writer.",
        "A change requiring a choice among several defensible approaches.",
        "A change whose approach is not yet known and must be worked out first."
      ]
    },
    "needs_unseen_context": {
      "type": "noul",
      "instructions": "Does this stage require understanding code that the instruction does not itself contain?"
    }
  }
}
```

Note what the `criteria` levels do *not* say. Not "medium effort", not "harder
than the last one" — `score.md` is explicit that levels must describe concrete
situations and must avoid numeric or relative language, because each level is
evaluated independently against the state with no knowledge of its neighbours.

The `choice` descriptions are the one place a profile's own words matter: they
are what the model actually reads about each candidate, and a row described
only by its id is a row chosen by name recognition.

**The mapping, in code.** `deliberation.score` is a float in `[0, n-1]` over
our four levels. Normalise to `[0, 1]`, multiply by `ladder.length - 1`, round.
A candidate declaring no ladder gets `effort: null`. By construction this
cannot leave the declared set, which is the contract `relay-route.ts` exists to
keep — and it is rounding, not clamping, because there is nothing outside the
ladder to clamp from.

## 4b. Which stages run at all, and why it is a separate switch

The higher-value question is not which model runs a stage — it is whether a
stage needs to run. "This instruction already says what to change" is a
judgment over the operator's own words, which is safe state, and acting on it
skips a whole agent session rather than choosing a cheaper one.

It is a `choice` over whole pipelines rather than one `noul` per stage, and
that is the topology talking. Stages have dependency edges; there is no
verifying what was never implemented. Independent `noul`s would cheerfully
return a pipeline that verifies nothing and reviews it, where a choice over
pipelines can only return one that holds together.

**`UNSKIPPABLE` is the safety property.** `implement`, `verify` and `review`
appear in every pipeline on offer, so no answer this model can give — however
confident, however wrong, however steered — can remove a stage that checks the
work. Dropping a preparation stage is cheap and visible: you get a
worse-informed implementation and you can see that you did. Dropping a check is
invisible, and it is how a relay ships a bug while reporting five green nodes.
The legal move set is narrowing the front of the pipeline and nothing else,
which is the same shape as the router's rule about never widening a declared
set, pointed the other way.

It is asked once per docket, in its own request, because its answer decides
which stages there are to route. That is the documented justification for a
second round trip — an earlier answer determining the next options — and it is
the only place this design spends one.

### Off unless switched on, and switched on separately

**Wanigan must not assume this service exists.** Most installs will never have
a TypeSafe credential, so the path that exists for everyone is the one where
none of this is asked: `NO_SUGGESTER` is the default, every builder returns
`null`, and `phasesFor()` returns the docket untouched. A missing credential, a
disabled module, a declined answer, a 429 and a malformed body all arrive at
the same place by the same route, which is why that fallback is one function
rather than a `?? requested` written at each call site.

`route` and `pipeline` are **two switches, not one**, because they are two
different bargains. One spends a call to pick a model for a stage that was
going to run anyway; the other spends one to propose that a stage not run at
all. Bundling them would mean turning off a model preference to stop a docket
being narrowed. `SUGGESTER_CAPABILITIES` declares both as data — id, label,
what it asks, and what switching it off costs — so a settings surface
enumerates switches rather than hardcoding two checkboxes, and so the same list
can become what an extension says it provides.

## 5. What the current code and the previous spec get wrong

**`StageSuggestion` has one confidence, and we now have two.** The type is
`{ model, effort, distribution, confidence }`. A two-question design produces a
model confidence and a deliberation confidence, which can disagree — a
confident model pick with a vague effort read is the common case, and it should
yield the suggested model at the profile's default effort rather than dropping
whole. The type needs to carry both, and `chooseStage` needs to gate them
separately. `needs_unseen_context` is a noul and has *no* confidence at all, so
it can inform the reason line but can never gate anything.

**`DEFAULT_MIN_CONFIDENCE = 0.8` is unfounded, and its shape is wrong.** The
docs give 0.5 as a review floor and 0.9 for automatic high-stakes action;
`confidence-routing.md` uses a 0.6 floor and 0.85 for consequential actions.
0.8 is a plausible pick between them, but both pages say the same thing — the
threshold must be evaluated on your own data. Worse, choice confidence
summarises distribution *concentration*, so it is easier to reach with three
candidates than with twelve. A single constant across profiles of different
widths is measuring different things and calling them one number. It should be
calibrated (§8), and probably expressed per candidate count.

**Three errors in `2026-09-17-relay-design.md`, now corrected there:**

- "~$0.0004 per call" is roughly 10–30× high. Our state is a few hundred tokens;
  at $0.042/MTok, 800 input tokens is **$0.0000336**. That is Wanigan's own
  arithmetic and carries the label `spend.ts` already uses for arithmetic, never
  presented as a reported cost. It stays arithmetic for a second reason: with
  output free and pricing possibly subsidised, there is no invoice line to
  reconcile it against.
- "2–10 ordered levels maps onto the declared set" — true of the range, but it
  skipped that the declared set *varies per candidate*, which is what §4 fixes.
- "a credential in `keys.ts` with a `GET /v1/models` validation ping" — there is
  no such endpoint. `/v1/systemone` is the only route, so verifying a key means
  one minimal real call. That is a difference from every other provider here.

**And one correction aimed at the launch coverage**, because that is where the
phrase reaches anyone who hears about this model before reading the docs:
"mathematically cannot hallucinate" is a claim about *format validity*. Jev
cannot return an option you did not declare; it can and will return the wrong
declared option. Typed output guarantees the interface, not the truth. The 09-17
spec never made this claim — the press did — but it is the one most likely to be
repeated back to us, so it is worth having an answer ready.

The good news: the two constraints the spec asserted from launch coverage are
both real and now sourced verbatim — unreliable counting and arithmetic, and
state not treated as hostile. The paragraph's conclusions were right; its
citations were not.

## 6. Where the code goes

```
src/shared/suggest-questions.ts   (pure) — builds the request, maps score → ladder
src/shared/relay-route.ts         (pure) — gains a second confidence; gates each
src/main/modules/suggest.ts               — the module: client, channels, settings
```

`suggest-questions.ts` is pure by construction, so the question shapes and the
ladder arithmetic answer in `test:shared` in under a second rather than in the
thirty-second suite. That matters more than usual here: the ladder mapping is
the one place a bug silently launches a stage at an effort nobody chose.

`src/main/modules/suggest.ts` registers with `module-registry.ts` alongside
`scout.ts`, which is the closest existing shape — a non-required module that
owns an egress destination and a settings surface. It carries the standing cost
every egress here carries:

- a hand-enumerated row in `egress.ts` with `host: 'api.typesafe.ai'`,
  `paths: ['/v1/systemone']`, `by: 'wanigan'`, and a `when` that says plainly
  that the operator's typed intent and the candidate labels leave the machine
  and that project files, diffs, prompts and terminal output do not;
- a credential through the existing `hasProviderKey('typesafe')` /
  `getProviderKey('typesafe')` path — no new mechanism, and the verification
  ping is a minimal real `/v1/systemone` call, since there is no `/v1/models`
  to probe;
- `refuseIfHalted('suggest a route')` before every call;
- a local rate table beside `batch/pricing.ts`, with `history` left empty for
  the reason that file already gives — no rate change is recorded until one is
  verified against a published schedule.

Kill switch and failure behaviour are the same sentence: on 401, 422, 429, 529,
timeout, low confidence, or the module being switched off, `chooseStage`
receives no suggestion and returns the profile default. `smoke-relay.ts:67`
already asserts that path. A build where the suggester never succeeds must
behave exactly like the build before it existed — that is already written in
`relay-route.ts`'s header, and it is the property that makes this safe to ship.

## 7. What Wanigan must not claim

`AGENTS.md` forbids presenting an estimate as observed fact, and this feature
offers several tempting ways to break that.

- The route is **a guess, shown as a guess, and overridable.** `RouteSource` is
  already `'profile-default' | 'suggested' | 'operator'`, and the reason line
  names which one and why.
- A suggestion never becomes a savings claim. Picking a cheaper model is not
  evidence that the cheaper model sufficed.
- Do not describe Jev as unable to be wrong. If the UI says anything about its
  guarantee, it says the option set was fixed in advance.
- The computed cost is arithmetic and is labelled as such.
- Until a real call has been made and its shape observed, the UI says the
  suggester is unsupported rather than implying it works.

## 8. Calibrate before you threshold

The probe is the first commit and it touches no product code: a scratchpad
script that sends the §4 request over a set of real relay intents and records
latency, `usage`, both confidence values and the full distributions.

It answers the questions that decide whether this ships at all:

1. Does choice confidence separate a clear intent from a vague one, or does it
   sit near the same value regardless? A suggester whose confidence never moves
   is a constant wearing a distribution.
2. Where does confidence actually land for 3 candidates versus 8? That sets the
   threshold, and tells us whether one constant can serve both.
3. Does `deliberation.score` track the intent monotonically, or does it saturate?
4. Is the round trip inside the ~100 ms we are designing against, from here?

Cost of the whole exercise is cents. Until it runs, the threshold is a number
copied from a blog post, and this document is a plan rather than a finding.

## 9. Order of commits

1. **Probe** — scratchpad only, no repo code. Produces the calibration table.
2. **Correct the 2026-09-17 spec** — the three errors in §5, with sources.
3. **`suggest-questions.ts` + `test:shared` tests** — pure, offline, no network.
   The ladder mapping, the question builders, the pipeline narrowing and the
   off-by-default posture land here with their tests. **Done.**
4. ~~**`relay-route.ts`: two confidences**~~ — **not needed.** Writing step 3
   dissolved it. A low effort confidence makes the suggester report
   `effort: null`, which the router already reads as "nobody named one" and
   answers with the profile's default. The router's rule that a suggestion is
   admitted whole stays intact, and the two judgments are gated where they are
   made rather than where they are consumed.
5. **`src/main/modules/suggest.ts`** — the module, with its egress row,
   credential, halt check and rate table. Off by default.
6. **`provides.suggesters`** — only once the built-in has run long enough to
   show which parts of a question an author actually needs to vary. An
   extension point is a promise; publishing it early promises the wrong shape.

Steps 1–4 are safe to do now and cost almost nothing. Step 5 is where the
standing cost lands. Step 6 should wait.
