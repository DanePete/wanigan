# Relay — a staged pipeline with per-stage routing

One prompt, three real sessions, and a rail that shows the work moving between
them. You describe an outcome; a planner proposes; you approve; an implementer
builds; a reviewer checks. Each stage runs on the profile that suits it, and
every moving thing on the rail is bound to a measurement that actually
happened.

Status: design, awaiting review. Nothing here is implemented.

## What this spec now costs — read this first

`AGENTS.md` gained an "Everything is a module" section after this spec was
written, and it invalidates how Relay was to be delivered. The rule names the
exact shape specced below:

> A new feature ships as an extension. Not a view wired into `App.tsx`, a table
> in `db.ts` and a handler in `index.ts`: that triple is the symptom this rule
> exists to stop.

Relay is that triple. So the design below stands and the delivery does not.

**Relay cannot be a third-party extension, and this is not a matter of effort.**
`ExtensionManifest.provides` admits exactly four things — `mcpServers`,
`skills`, `gates`, `instructions` — and `extension-manifest.ts` states the
premise plainly: an extension "is never a place to load code, and nothing it
ships runs inside Wanigan's process." That is the whole reason a stranger's
bundle is installable. A renderer view with its own IPC, queue runners and
schema is code in Wanigan's process, so widening the manifest to admit it would
not be extending the system; it would be removing the property the system
exists to have.

**There is no first-party module system yet.** A search for any module registry
returns nothing. So the two kinds are not equally real today: third-party
extensions are declarative and shipped, while "the defaults are extensions too"
describes an architecture whose registration seams have not been built.

Which puts Relay precisely on the rule's own escape clause — not the urgent-fix
one, which does not apply here (nobody is blocked, no data is at risk, nothing
is live), but this one:

> If a feature cannot be expressed as an extension, that is a statement about a
> missing extension point, and building the extension point is the work.

### The missing point, measured

A view today is registered by hand in seven places, and the report that
enumerated them found the most important one is checked by nothing:

| What | Where | Enforced by |
| --- | --- | --- |
| Route row | `routes.ts` `TABS` | position matters; an insert before index 9 silently drops ⌘9 |
| Icon | `routes.ts` `TAB_ICONS` | `tsc`, but nothing renders it |
| Shortcut | `routes.ts` `TAB_SHORTCUTS` | `tsc` |
| Shortcut order | `routes.ts` `VIEW_SHORTCUT_ORDER` | one count identity in `keymap.test.ts` |
| Sidebar area | `spaces.ts` `SPACE_AREAS` | a shared test and smoke |
| Project scope | `spaces.ts` `projectScopeFor` | nothing — unlisted silently means `workspace` |
| Phone disposition | `mobile-nav.ts` | smoke, and easy not to know exists |
| The render branch | `App.tsx` | **nothing. A registered view with no branch renders blank and every gate passes.** |

That is the cost the new rule cites — "seventeen views reached the sidebar one
hand-wired route at a time" — stated as a table. A view module should declare
these once.

**This is not a hypothetical cost.** While this spec was being written, the
session that authored the "Everything is a module" rule added one route the
hand-wired way and missed two of the seven places: `MOBILE_ABSENT` in
`mobile-nav.ts`, and the style gate's shadowed-modifier baseline. Both were
caught by the suite, which is the system working as designed. The distinction
worth keeping is that the gates made them **detectable**; a registration seam
would have made them **unmissable**. The author of the rule, minutes after
writing it, with every gate available, still needed two failing assertions to
find them — which is the argument for the seam stated better than any
reasoning about it could.

The one row no gate covers at all remains the `App.tsx` branch: a destination
registered in every table with no branch renders an empty pane and all eight
steps pass.

### Delivery, in the order the rule requires

> The conversion and the change are two commits in that order.

1. **The view-module seam**, behaviour-preserving. One declaration carrying
   route, icon, shortcut, ordering, area, project scope, phone disposition and
   demo disposition, with the tables derived from the registry rather than
   hand-edited. Per the rule that defaults prove the point is real, every
   existing destination moves onto it rather than a sample — a seam half the
   views use is two systems.

   **The conversion is provable rather than reviewed.** The registry derives
   the tables; a test asserts the derived tables deep-equal the current
   hand-written ones, field for field, id for id. If that passes, the change is
   a move by construction, which is exactly what the rule asks a conversion
   commit to be.

   **The missing render branch is removed, not detected.** A destination
   registered in every table with no branch in `App.tsx` renders an empty pane
   today and nothing fails. A test could catch it; a seam should make it
   impossible. The split that does so:

   - `src/shared/view-registry.ts` stays pure data — no React, so `test:shared`
     keeps answering in under a second and the main process and the phone can
     read it.
   - `src/renderer/src/views/registry.tsx` maps each id to its renderer as a
     `Record<Tab, (ctx: ViewContext) => ReactNode>`. Because `Tab` is derived
     from the registry, **a destination with no entry is a compile error**, and
     `App.tsx` renders `registry[tab](ctx)` instead of a chain of eighteen
     `tab === '…' &&` lines nobody counts.

   `ViewContext` is the shared bag `App.tsx` already threads by hand — projects,
   providers, the selected project, the open handlers. Collecting it is the part
   of this commit that is genuinely a refactor rather than a move, so it lands
   with the props each view already receives, unchanged in meaning.
2. **Relay as the first module built on it.** Everything in this spec below —
   the sluice, the phases, the router, the forecast — unchanged in design, but
   registered rather than wired.

What already exists survives both: `src/shared/relay.ts`, `relay-route.ts`,
their tests and `relay.css` are module-shaped already and import nothing from
the core. The two additive `work_nodes` columns are a migration on an existing
table rather than a new feature triple, so they stand either way.

**What this changes for whoever reads this next:** Relay is no longer a
self-contained piece of work. It is the second half of one, and the first half
is a seam the app has needed since its fourth view.

## Why this is not the Board and not Review

`control` (Review) answers "how is this one goal going" and `board` answers
"what is outstanding across every goal". Both are list-shaped and both are
about work that already exists. Relay is the surface where work is *composed* —
a single intent becomes a staged docket, and the operator's attention is on the
handoff between stages rather than on a backlog. That is a different question,
so it is a different view rather than a tab inside one, for the same reason
stated above `usage` and `board` in `src/shared/routes.ts`.

It is also the first surface where Wanigan chooses *which* profile does a piece
of work rather than asking the operator to pick before anything starts. That
choice is the feature, and it needs somewhere it can be shown, overridden and
audited.

## The premise it must not break

A live PTY is a real agent process. Relay does not simulate a stage, does not
fabricate progress, and does not move a pixel because time passed. From
`src/renderer/src/styles/motion.css`:

> Nothing spins to look busy, and nothing loops to fill silence — a moving
> thing in this app is a claim about the world, so it has to be true.

Every animated element below names the recorded fact it is bound to. Where no
fact exists, the element is still — and stillness is the honest rendering of
"Wanigan is waiting on a person", not a gap to be filled.

## Architecture

### Stages are work nodes, not a new table

A relay is a `work_dockets` row with **five phases**: the four the repo already
declares, plus `estimate`. `DocketNodeKind` is today
`'plan' | 'implement' | 'verify' | 'review'`, and `DEFAULT_DOCKET_PLAN` in
`shared/types.ts` already carries those four with their dependency edges — deliberately in `shared` because the renderer's plan
editor seeds a new graph from the same array, with a comment warning that a
second copy "would read as identical and then drift".

Relay therefore **invents no topology**. It seeds from `DEFAULT_DOCKET_PLAN`
and renders what the docket actually holds, so a planner that proposes a richer
graph renders correctly with no change here. The schema already carries the
rest: `kind`, `status`, `provider_id`, `model`, `session_id`, `worktree`,
`depends_json`, `started_at`, `ended_at`.

| Phase | Kind | How it runs | Existing mechanism |
| --- | --- | --- | --- |
| Plan | `plan` | PTY session in the harness's plan mode | `goal-plans.ts` records the accepted plan from the `ExitPlanMode` hook |
| Estimate | `estimate` | Local computation, no session | `goal-trace.ts` history, `spend.ts` rates — **new kind** |
| Implement | `implement` | PTY session in a linked worktree | `work_claims` for path claims, `collisions.ts` for the forecast |
| Verify | `verify` | The deterministic gate | `goal-gate.ts` — and the one phase with a real denominator |
| Review | `review` | Headless run, judgment only | `headless.ts` (`claude-json` / `codex-json`) |

That the repo had already split `verify` from `review` is what makes the gauge
rule below clean rather than a special case: the phase that counts steps is not
the phase that forms an opinion.

The planner's output does not need inventing: Claude Code hands the plan to
hooks on `ExitPlanMode`, `tool_response.plan` carries it as accepted with
`planWasEdited`, and `goal-plans.ts` already stores it against the goal and
hands it to the tasks that come after. Relay is the surface that finally *shows*
that handoff, which is the gap that module's header comment names.

**Two additive migrations**, in keeping with the rule that migrations are
additive and preserve existing user data:

```sql
ALTER TABLE work_nodes ADD COLUMN effort    TEXT;
ALTER TABLE work_nodes ADD COLUMN handbacks INTEGER NOT NULL DEFAULT 0;
```

`effort` because `provider_id` and `model` are already there and effort is the
third field of the same decision — and because `learning/experiments.ts` pins
`provider_id, model, effort, commit_hash`, so a stage that does not record its
effort can never be the subject of a controlled experiment.

No new table for routing decisions. A route is evidence of what Wanigan chose
and why, so it is a `work_proofs` row with `kind = 'route'`, its `summary`
carrying the one-line reason and its `detail_json` the distribution. That keeps
the audit trail in the table the operator already reads.

### Stages are separate sessions, necessarily

The model of a live `claude` PTY cannot be changed mid-conversation, and no
harness offers a cross-harness continuation. So a relay is not one session that
switches models — it is a sequence of sessions, each with its own frozen
pack/profile/backend snapshot, with Wanigan passing evidence forward. This also
means every cross-backend rule in `AGENTS.md` holds without a special case:
nothing semantic crosses a backend, because each stage's content stays in the
session that produced it and only the operator-visible artifact (the plan, the
diff, the gate output) moves between them.

`handoff.ts` remains what it is — continuing one conversation on another
account of the *same* harness — and is not involved here.

### The router is a pure function with a pluggable suggester

```
src/shared/relay.ts         (pure) — stage topology, cadence, tally, verdict
src/shared/relay-route.ts   (pure) — the router

  chooseStage(stage, candidates, suggestion?) -> StageRoute
```

`relay.ts` holds the stage-shaped derivations the renderer and the main process
both need: the stage order and its dependency edges, the cadence period, the
tally cap and the verdict classification. Both modules are pure by
construction, so they answer in `test:shared` rather than in the thirty-second
suite.

`candidates` is exactly what `launch-choices.ts` already produces: the rows a
profile declares, each with its declared `efforts`. The comment at
`launch-choices.ts:163` is the contract — a caller may read the profile's
declared efforts and **may never widen them**. The router obeys that: its legal
move set is handed to it, and a suggestion naming anything outside it is
discarded rather than clamped.

With no suggester, `chooseStage` returns the profile's declared default. That is
the shipping default: **Relay works with no model-choice intelligence at all**,
and the router UI shows the profile's own default as the pick. This is
deliberate — an honest unsupported state beats an invented integration, and it
means the animation work is not blocked behind an early-access API.

A suggester is an optional source of a `StageSuggestion { model, effort,
distribution, confidence }`. TypeSafe/Jev fits this interface exactly: model
selection is a `choice` over the candidate rows, effort is a `score` over the
declared levels (2–10 ordered levels maps onto the declared set), ~100 ms and
~$0.0004 per call, and it returns a distribution plus confidence rather than a
bare pick. Below a configured confidence threshold the suggestion is dropped and
the profile default stands.

Jev's documented weaknesses constrain the question shapes. It is unreliable at
counting and arithmetic, so the state must never ask "how many files will this
touch". It asks about shape — "does this task require understanding code the
prompt does not include" as a `noul`, "which of these stages does this
instruction most resemble" as a `choice`. It also does not treat its state as
hostile, so the state is the operator's own typed intent plus the enumerated
candidate labels, never repository content or agent output.

Adopting a suggester carries the same infrastructure as any other egress: a
hand-enumerated row in `egress.ts`, a credential in `keys.ts` with a
`GET /v1/models` validation ping, `refuseIfHalted()`, and a local rate table.
Jev prices input at $0.042/MTok with free output and states the price may be
subsidised, so a computed cost is Wanigan's own arithmetic and carries the
label `spend.ts` already uses for that. It is never presented as a reported
cost.

### Guesses become measurements

The router's pick is a guess, shown as a guess, and overridable. It never
becomes a savings claim. `AGENTS.md` already fixes the standard:

> Do not call token savings causal unless a controlled experiment fixes the
> provider, model, effort and commit and ingests paired metrics.

Because every node now records all four, a closed relay is an experiment's
worth of evidence. Relay writes `ArtifactMetric` rows at the existing
`evidence_level` vocabulary and nothing above it. The A/B registry does not
launch workloads, so a manually closed run stays an estimate and is labelled
one. Relay adds no new claim; it makes the existing one reachable.

## The Sluice

Wanigan is a supply raft on a log drive and the companion is a real fluid, so
the pipeline is not plumbing — it is a channel with basins, and the work is
water. The choreography below is one idea carried all the way through: **a
single orb travels the whole run**, sitting in the basin of whichever phase is
live and falling into the next at each handoff. You follow one object from
intent to verdict.

**The column runs downward, and that is a physical claim rather than a layout
preference.** The companion's solver is Position Based Fluids running at
`gravity: 9.81`; a horizontal rail would have been asking a fluid to move
sideways for no reason anyone could see. Vertical means every handoff is a
fall, which is the one direction water needs no explanation to travel.

Each basin's floor is a **gate**. It is shut while the phase runs, and when the
phase completes the gate opens and the water falls into the basin below. That
is what a sluice gate is for, and it gives the completion moment a mechanism
instead of a fade: the phase does not "transition", it *lets go*.

Each basin keeps its own state after the water leaves it — its sediment pile,
its route chip, its verdict mark and its handback counter all persist. So the
rail reads at a glance even though only one basin is ever live, and a
long-running relay you check in on tells you where the work has been as well as
where it is.

A new surface prefix, `rl-`, with rules in
`src/renderer/src/styles/relay.css`. No colour, no literal size or duration —
tokens from `index.css` and `motion.css` only. The view roots on `.pane` with
`PageHead` and composes `Section`, `SectionHead`, `Segmented`, `Chip`, `Pill`,
`Mark`, `Stat`, `Note`, `ConfirmNote`, `Reading`, `EmptyState`, `Explainer` and
`Hint` from `bits.tsx`. No new `*-card`, `*-head` or `*-chip` family.

### The elements

| Element | Class | What you see | Bound to |
| --- | --- | --- | --- |
| The Sluice | `.rl-sluice` | The whole rail: basins along a channel | The docket's nodes, in dependency order |
| A Basin | `.rl-basin` | One stage, holding the work while it runs | One `work_nodes` row; `data-state` is its status plus its session's attention class |
| The Swell | `.rl-swell` | The live basin's water rises and falls | Measured interval between that session's completed tool calls |
| The Sediment | `.rl-silt` | Grains drop and settle on the basin floor | One grain per completed tool call |
| The Gate | `.rl-gate` | A basin's floor; shut while it runs, parting when it completes | That node reaching a terminal status |
| The Fall | `.rl-fall` | Water leaving through the open gate into the basin below | Exactly one recorded successor transition to `running`, filling across its bring-up milestones |
| The Gauge | `.rl-gauge` | A basin's level rising | Only where a real denominator exists — see below |
| The Level | — | Everything goes glass-flat and still | An approval Wanigan is waiting on |
| The Backwash | — | Water runs the race uphill | One recorded hand-back inside budget |
| The Seal | `.rl-seal` | A verdict mark settles into the basin | A recorded review pass — drawn by the rail, never the orb's keepsakes |
| The Drain | — | Basins empty left to right; the sluice goes dormant | The relay reaching a terminal state |

### The Swell — why there is no spinner

A running basin's water rises and falls on the `.mo-breathe[data-flow='live']`
primitive, with `--mo-period` set from the measured interval between that
session's completed tool calls. This is that primitive used exactly as its
comment intends: "An indicator breathes at the rate output actually arrives,
and stops when it stops."

**That primitive currently has no consumer.** `.mo-breathe`, `.mo-bump`,
`--mo-period` and `data-flow="live"` have correct, intact rules in `motion.css`
and are rendered by nothing: the markup that drove them was removed with the
horizontal rail and the old nav badges, and the comments in `motion.css` still
describe an `App.tsx` implementation that no longer exists. `--mo-p` survives
at exactly one site, and the renderer contains no `style.setProperty` call at
all.

So Relay is not reusing a living primitive, it is reviving a stylesheet that
outlived its caller — and this spec says so rather than letting a future reader
infer a precedent that is not there. Two consequences, both in scope: the
stale `motion.css` comments are corrected in the same change that gives them a
consumer again, and `.nav-ink` is left alone. `smoke3.ts` actively asserts the
`nav-tabs` selector is gone, so the measured-slide technique may be borrowed
but that selector may not be reintroduced.

The consequence is the best thing in this design. An agent hammering tool calls
makes a choppy basin; a slow one makes a long swell; a stalled one goes
glass-flat. The texture of the motion *is* the information, readable across a
room, and every frame of it is true. `attention.ts` already separates a real
stall from quiet output — `DEFAULT_STALL_MS` is measured against hook events
rather than terminal repaints, precisely because every agent here is a TUI and
a spinner is output — so flat water is a classification, not missing data.

Below three recorded tool calls there is no measured interval yet, so the basin
does not swell at all. It shows its state and its sediment and nothing more. A
period guessed from one event would be the invented progress this surface
exists to refuse.

**Flat water must never carry meaning on its own**, because two different
states produce it. A *stall* is basin-local and happens while a session is
running but has stopped finishing work. A *hold* is sluice-wide and happens
when a phase has completed and Wanigan is waiting on a person — nothing is
running at all. They cannot both be true of one basin, since a completed basin
reports no cadence to begin with, so there is no precedence question to settle.

What there is, is a legibility requirement: a stalled basin carries a visible
mark saying it has stalled, and the hold is announced by its `ConfirmNote`.
Neither leans on stillness to say what it means. This falls straight out of the
still-image rule — if the only difference between "your agent is stuck" and
"your turn" is which thing is not moving, then with motion off they are the
same picture.

### The Sediment — earned progress with no denominator

One grain per completed tool call, dropping and settling once. Bounded: past
the cap the pile stops growing and a count takes over, because an unbounded
pile is a memory leak wearing a metaphor.

It is deliberately not a progress bar. Nobody knows how many tool calls a task
needs, so a percentage would be a fabrication, and `motion.css` requires that
no primitive carry "a default that implies activity". A pile that grew is a
fact about work that happened.

Positions are not computed per grain. A free-form coordinate would need the
inline-style channel the gate denies a new file, so the scatter lives in
`relay.css` as **24 hand-placed slots** selected by `data-rl-i`, and each basin
picks one of **8 whole-scatter variants** by `data-rl-seed`, derived from the
node id. Nothing is sampled randomly, so the same relay silts up the same way
twice — the discipline `Pet.tsx` already keeps ("NOTHING IS RANDOM... seeded
from the hatch time") — and a screenshot stays reproducible.

`SEDIMENT_CAP` is therefore load-bearing rather than cosmetic: it is pinned to
the slot count in `relay.css`, and the two must change together. A grain whose
index has no slot matches no position rule and stacks in the corner, which is a
silent visual bug. The coupling is stated in both files.

### The Spill — the handoff, and the only honest progress bar

The moment the feature exists for, and the one place a filling gauge is not a
lie.

On each recorded transition of a successor node to `running`, the finished
basin's **gate opens** and its water falls into the basin below, visibly
**filling it**. The orb falls with it, and the receiving basin takes a single
squash-and-settle as the mass lands.

The gate is the part worth building carefully. A phase that completes does not
dissolve into the next one — its floor parts and it releases what it was
holding. That reads as a mechanism with a cause, and it is the moment the whole
surface exists to show.

The fill is bound to the successor's bring-up, which is a bounded event with an
observable start and an observable end: the transition is recorded, the process
is spawned, the session reports ready, the first hook event arrives. The fill
advances across those recorded milestones and reaches full when the stage is
genuinely live. It completes because the thing it measures completes, and it is
a native `<progress>` over that fixed list rather than a styled bar.

This is worth stating plainly because it inverts a dead spot. Session bring-up
is several seconds during which Wanigan today shows nothing, and it is the
exact interval an operator is most likely to wonder whether anything is
happening. A gauge that fills over a real, short, terminating event is both the
most satisfying moment in the surface and one of the few places in this app
where a progress bar is honest.

Its trigger discipline is unchanged: one recorded transition, one spill, never
on a poll or a re-render, with the transition id retained so a remount cannot
replay it. A spill is also the one place the orb's fluid receives a real
impulse, so the arrival disturbs actual water rather than playing a canned
splash.

### Which basins may fill, and which may never

A fill claims a denominator, so it is allowed only where one exists. This is
the same rule the sediment obeys, applied to the other direction.

| Fill | Denominator | Honest? |
| --- | --- | --- |
| The race, during a spill | Successor bring-up milestones, a fixed known list | Yes — bounded event, observable completion |
| The verify basin | Gate steps passed over gate steps total | Yes — a real, known total |
| The estimate basin | Tasks priced over tasks in the plan | Yes — a real, known total |
| The plan basin | none — a plan is done when it is done | **No.** Swell and sediment only |
| The implement basin | none — nobody knows how many tool calls a task needs | **No.** Swell and sediment only |
| The review basin | none — a judgment has no step count | **No.** Swell and sediment only |

The three open-ended phases carry no gauge at all. That asymmetry is deliberate
and visible: a basin with a rising level is a stage whose end is known, and a
basin with only swell and silt is a stage whose end is not. An operator learns
that distinction in one run, and from then on the rail is telling them
something a uniform row of progress bars would have hidden.

### The estimate phase — what it will cost, before you spend it

A step, not a panel, and it sits between the plan and the work. The planner
produces a task list; this phase prices that list; only then does the rail hold
for your approval. That ordering is the point: "do you like this plan" becomes
"do you like this plan, and here is what it will cost."

**It costs nothing to run.** Wanigan already records what this needs.
`goal-trace.ts` writes `durationMs`, `costUsd`, `inTokens` and `outTokens` per
node; `work_nodes` carries `started_at`, `ended_at`, `provider_id`, `model` and
— after this spec's migration — `effort`; `spend.ts` already aggregates cost by
effort. So the forecast is a query over the operator's own history, keyed on
project, phase kind and the exact route each phase will run at. No egress, no
credential, no API, no spend.

That is also why it is better than a general-purpose estimator. A hosted tool
prices a generic project from industry data and needs the feature description
sent off-machine; this one knows that *on this project, at this effort, your
implement phases have taken a median 22 minutes and $2.40*.

**The forecast recomputes when a route chip changes.** Overriding a phase's
model moves the number while you are still deciding, so the router's cost
consequence is visible at the moment of the decision rather than in next
month's spend view.

**It has a real denominator** — tasks priced over tasks in the plan — so unlike
the plan and implement basins it earns a gauge. It is also the fastest basin on
the rail, which is its own small pleasure: it fills and drains almost at once.

**What it must never do.** Below a minimum number of comparable recorded
phases there is no number at all, only an `EmptyState` saying there is not
enough history yet — a median drawn from one sample is the invented progress
this whole surface refuses, wearing a currency symbol. Every forecast is
labelled an estimate and shows the N it was drawn from. And it never becomes a
savings claim: that still requires a closed experiment pinning provider, model,
effort and commit, exactly as `AGENTS.md` demands.

A later, near-free refinement is available and out of scope here: a suggester
classifying whether a new intent *resembles* the relays that historically ran
long, as a `choice` over the operator's own clusters at roughly $0.0004. The
median works without it.

**Blast radius of the new kind**, stated because it touches shipped surfaces:
`DocketNodeKind` and `DOCKET_NODE_KINDS` in `shared/types.ts`;
`DEFAULT_DOCKET_PLAN` gains a node; `PlanEditor.tsx`'s
`KIND_HINT: Record<DocketNodeKind, string>` **will fail to compile** until the
kind has a hint, which is the coupling working as intended; `Control.tsx`'s
section-label ternary should name it rather than falling through to "Selected
task"; and `interview.ts` validates against `DOCKET_NODE_KINDS`, so it accepts
the new kind with no edit. `DocketProof.kind` gains `'estimate'` so a forecast
can be stored as evidence beside the plan it prices.

### The Level — stillness as the loudest state

When a stage finishes and Wanigan needs a person, the plan arrives as a
`Reading` panel with `mo-view-in` and then the rail stops dead. Glass-flat
water, no swell, no drift. The only thing that moves is the `ConfirmNote`
carrying the decision.

Nothing else in Wanigan goes deliberately still, so it will read instantly as
*you are the bottleneck*. That is the honest rendering: motion here would be
claiming work is happening when the only pending actor is the operator. The
stillness is the feature, not the absence of one.

### The verdict

Three outcomes, each reusing a signature already documented in
`docs/visuals/orb-signatures/README.md` rather than inventing a fourth visual
language:

- **Pass — the Seal and the Drain.** A verdict mark settles into the review
  basin, then basins empty left to right in sequence and the sluice goes
  dormant. The mark is drawn by the rail. It is explicitly **not** an orb
  keepsake: those six slots are derived from `OrbStory.compaction.completed`
  and mean a completed compaction hook. Driving them from a review verdict
  would be fabricating a compaction to borrow its visual, which is the same
  class of lie as a spinner.
- **Fail inside budget — the Backwash.** The water goes back **up** the column
  to the implement basin, the handback counter steps down with a single bump,
  and that basin re-enters its measured cadence. Water climbing is the wrong
  direction for a fluid under gravity, so it reads as wrong in the gut before
  the label is read — the correct feeling for an automatic retry. The counter
  stays visible throughout, so the loop is never a surprise.
- **Fail past budget — the Slack.** The gate stays shut, the basin takes the
  unresolved tint, and it waits. Nothing falls, because nothing is happening.

### Theatre

A `Segmented` control switches the rail between compact and theatre. Theatre
gives the sluice the pane, enlarges the orb and makes sediment legible. Same
data, more room — it adds no information and invents none, it just makes a
long-running relay something you can sit and watch.

### How each element is actually driven

The renderer has settled idioms for all of this, and Relay follows them rather
than introducing a parallel style.

**Custom properties are not written with an inline style prop.** The gate
counts the literal text `style={{` per file and allows a file not in its
baseline exactly zero, so the one live `--mo-p` site cannot be copied into a new
view — that precedent is baselined for its own file, not licensed generally.
Relay therefore uses three channels, chosen per value:

- **A bounded integer** — the stagger index — is a `data-rl-i` attribute with
  attribute selectors in the sheet. This is the idiom `motion.css` already uses
  for `data-flow="live"`, and a selector carrying `[attr]` is structurally
  invisible to the gate's shadowed-modifier check as a bonus.
- **A continuous ratio with a real total** — every gauge — is a native
  `<progress value max>`, which is what the renderer already does where a
  completed/total exists, and which carries an accessible value for free.
- **A measured duration** — `--mo-period` on a swelling basin — is set on a ref
  with `setProperty`, which is precisely how the removed implementation did it.
  Reviving a primitive with its own original technique is not inventing a
  convention; reaching for a text-matching gap in the ratchet would be.

That last point is worth stating because a fourth option exists and is
rejected: hoisting the object to a `const` and passing `style={obj}` slips past
the gate's text match, and the repo does contain instances of it. It would pass.
It is still routing around a ratchet, and a spec that recommended it would be
teaching the next surface to do the same.

**A real total gets a real `<progress>`.** Where a completed/total exists the
renderer already uses a native `<progress>` element rather than a styled bar,
and a smoke check asserts it. The verify gauge is therefore a `<progress>`,
which also gives it an accessible value for free. The race fill, whose
denominator is a fixed list of bring-up milestones, is the same.

**One-shot motion uses a previous-snapshot ref, never a timer.** The live
pattern diffs the incoming snapshot against a `useRef` of the last one, derives
a Set of ids that genuinely changed, and applies the animation class only to
those. Two properties of it matter here and are requirements, not incidentals:
the first read finds an empty previous map, so nothing animates on mount or on
a scope change; and the ref never causes a render, so the diff cannot loop.
Spills, sediment grains and the handback bump all use it.

**Counters that must fire exactly once use a last-seen ref initialised to the
current value.** That is how the orb's existing event props work, and it is why
a remount establishes a baseline instead of replaying every gesture. The
spill's orb impulse rides that same channel.

**A looping animation must be switched off twice.** Reduced motion zeroes
`--mo-state` and `--mo-view`, but it does **not** zero `--mo-period`. So the
Swell — the one animation here that loops — needs its own explicit
`animation: none` under both `:root[data-motion='off']` and the
`prefers-reduced-motion` query, exactly as `.mo-breathe` already declares for
itself. Relying on a zeroed token would leave it breathing for the operators
who asked it not to.

**Suppressed motion is consumed, not queued.** When motion is off, the existing
story director absorbs an incident by ageing it out rather than holding it, so
nothing performs later when motion returns. Relay's one-shots do the same: with
motion off, the state advances and the animation is dropped, never deferred.

### Passing the style gate

The gate is narrower than `AGENTS.md` and stricter where it bites. Both facts
matter, and the difference is recorded here so the next reader does not mistake
a review convention for a machine-checked one.

**Hard zero for a new file**, because an unlisted file's allowance is zero and
these baselines are empty: any `<style` text at all (comments and strings
included), any `style={{`, any literal duration in a `transition*`/`animation*`
value, any `title=` on a lowercase tag, any form control without an accessible
name, and any hook below an early return.

**Durations.** The rule is exactly: no digit immediately followed by `s` or
`ms` anywhere in a `transition*` or `animation*` value — `0s` and `0ms`
included, comments included. Arithmetic over tokens is fine and verified:
`animation-delay: calc(var(--rl-i) * var(--mo-state) / 8)` passes, and
`animation: rl-sweep calc(var(--mo-period) / 2) linear infinite` passes.

**Where the sheet loads is a real decision.** The shadowed-modifier check only
sees sheets that `index.css` imports. Imported there, `.rl-basin { gap }` on an
element also wearing `.pane` is a violation, and the fix is a compound selector
— which then also outranks `compact.css`'s breakpoint ladder and its
coarse-pointer touch targets, silently opting the surface out of responsive
layout. `relay.css` therefore imports from `Relay.tsx`, the pattern ten sheets
already follow. The compound-selector discipline still applies; it is simply
owed to review rather than to the script.

**Not machine-checked, still required.** Colour literals, spacing literals and
the `*-card`/`*-head`/`*-chip` family ban are `AGENTS.md` rules with no check
behind them. An `id` alone satisfies the gate's accessible-name test, but
`AGENTS.md` wants a matching `<label for>`, so Relay writes one.

### The rig — one apparatus, one body of water

The demo settled the geometry, and it replaces two earlier ideas in this
document: the spherical cavity as the container, and an orb *instance* mounted
on the rail. Neither survives contact with what the surface is for.

**Vessels, not spheres.** A basin is an open vessel with a funnel floor that
slopes to a gated drain; below every drain is a vertical pipe into the vessel
beneath. The rig is a thin tank — a 3D slab a few particle spacings deep — so
the section reads like a diagram while the solver stays 3D. The boundary the
solver projects against is the rig itself: walls, sloped floors along their
normals, the gate, the pipe walls, plus Akinci boundary samples on every wetted
surface with per-sample ψ so the water reads its own density correctly at the
glass and flows through the drain instead of jamming. With that support the
demo holds `avg ρ/ρ₀` at 0.99.

**No orb on the rail.** The rail mounts no instance of the companion's WebGPU
character at all. What travels is the water — the same body, running the
vendored Position Based Fluids solver with the companion's own constants,
draining vessel to vessel as phases complete. That dissolves the earlier
one-instance constraint rather than working around it, and it is the honest
reading of "one orb travelling": the orb's *fluid* is on the rail; the orb's
*face* stays at Home.

**Gates open and stay open.** A completing phase parts its floor; the water
runs out through the funnel, falls down the pipe and lands in the next vessel.
A drained vessel's gate stays open — it has nothing left to hold, and shutting
it again traps the last of the water as a puddle on the hatch. Only `reset`
shuts them all. Two rules the demo needed and the implementation carries: a
particle found in a pipe whose gate is shut punched through the floor in one
substep and is put back on the gate (nothing can be below a shut gate), and an
open gate is *no boundary at all* for the water leaving through it.

**Sediment settles on the funnel floor**, where a pile of silt belongs; the
labels are etched at the top of each vessel above the water line; a phase's
state is a word in a pill, never a colour alone.

**The hand-back is a pump, and says so.** Water cannot climb. On a
request-changes verdict inside budget the review vessel drains into a return
line drawn up the side, and what leaves the last drain re-enters above the
implement vessel's pipe. It is the one physically assisted element on the rig
and it is drawn as one — dashed, in the warning colour, only while running.

### The orb, and what the runtime will actually allow

The orb is a small element on the rail, not the rail. Four constraints from the
existing runtime shape the design, and each of them tightens it:

**One instance, travelling by transform.** `OrbRuntime.create()` takes a canvas
and nothing else, and each instance owns its own `GPUDevice`, its own HDR probe
decode, its own ~17 pipeline compilations, and its own `queue.onSubmittedWorkDone()`
drain per frame. `snow.ts` additionally keeps a module-level retained
`SnowPhysics` shared by every instance, so two live orbs on that temperament
double-step the same CPU state. So the rail mounts **exactly one orb**. The
travelling design is therefore not a preference — a basin-per-orb rail would be
a correctness bug before it was an expense.

Travel is a CSS transform on a stable host, never a React reparent. Moving the
canvas in the tree unmounts it, which destroys the device and pays for the
whole decode-and-compile again. The host stays put in the DOM; only its
transform changes, which is compositor-only and already what `motion.css`
requires.

**The canvas is square.** `render()` sets `canvas.width = canvas.height` from
`clientWidth`, clamped to 200–900 device pixels. Basins are laid out to host a
square orb rather than expecting the runtime to letterbox.

**The solver's own numbers are the design's numbers.** The companion resets its
liquid with `spacing: .055`, `restDensity: 1000`, `gravity: 9.81`,
`substeps: 2`, `iterations: 4`, `cfmEpsilonRel: .01`, `sCorrK: .1`,
`sCorrDq: .3`, `xsphC: .066`, `omega: 1.03`, `surfaceTensionK: .4`. Two of
those are already driven by state rather than fixed: Float sets
`gravity = 9.81 * (1 - float)` while `surfaceTensionK = .4 + float * .45`, so
as weight leaves the water it balls up instead of merely drifting. A surface
built on this fluid should read those values rather than restate them.

**Impulses go through counter props.** The bounded `nudge()` is public but the
runtime instance is closure-private to the `Orb` component, so the supported
channel is the monotonic-counter props the component already exposes — a change
fires one gesture, with its own throttle. The spill's arrival uses the existing
`playEvent` with kind `splash`, which is already in the runtime's vocabulary.
Nothing new is invented; the handoff lands in real water because the existing
impulse path is fed a real event.

**The tint is already the right vocabulary.** The orb's `signal` prop takes
`quiet | working | permission | error | finished | unavailable`, which maps onto
stage state without inventing a parallel language: `working` while a stage runs,
`permission` at the Level, `error` on a failed verdict, `finished` at the Drain.
The orb's colour is therefore driven by the same recorded state the basin's
`data-state` is, and the two can never disagree.

**What the orb will not do.** It will not gaze at each basin on demand: the
`gazeTarget` prop points at one element, applies to both internal gaze slots at
once, saturates beyond roughly 1.6 orb-widths, and is only consulted in certain
expression states. So the rail may hint the orb toward the live basin when it
is adjacent, and the design claims nothing more than that.

### The fluid is a module, and the sluice works without it

The water is a **material, not information**. Every fact the rail carries —
phase state, sediment count, gauge value, verdict mark, handback counter, which
basin is live — lives in the DOM and is derived from recorded rows. None of it
is drawn by a renderer. That is what makes the fluid removable rather than
load-bearing, and it is the same property the still-image rule already demands:
if the rail must be legible with every animation suppressed, it must also be
legible with the renderer absent.

So the fluid surface ships as an **optional module**, and the sluice declares a
fallback rather than a failure. Three tiers, each complete on its own:

| Tier | Condition | What the basin renders |
| --- | --- | --- |
| Fluid | The module is installed and the device can run it | A real Position Based Fluids surface: the companion's solver, screen-space depth, smoothing, normals, Fresnel at IOR 1.333 against a studio environment |
| Simple | The module is uninstalled, or the device cannot run it | A CSS water body that swells at the measured cadence and falls through the open gate on a transform — still animated, still bound to the same facts |
| Still | Motion off or `prefers-reduced-motion` | Every value, no movement |

The Simple tier is not a degraded picture of the Fluid tier, and it is not a
placeholder. It is the rail's own rendering, and it is what `relay.css` already
describes: `.rl-water` scaled on the compositor, `.mo-breathe` taking its period
from the measured interval between completed tool calls, the gate parting, the
body falling. It costs nothing per frame and it says the same true things.

**Why this is worth the seam rather than a feature flag.** A per-frame GPU
fluid is the most expensive thing this app would draw, and it is decorative by
construction. A machine that cannot afford it, a session on battery, an
operator who simply does not want it — each should get a surface that works,
not a surface with a hole. Making it a module also puts it under the rule the
rest of the app follows: it is compared against the default, and the default is
what proves the extension point is real.

**How it is switched today, honestly.** The extension system admits no code
and there is no first-party registry for renderer modules yet, so "uninstall"
ships as a setting — Settings › Appearance, `auto | on | off` — and the tier
falls out of a pure function over that setting, WebGL2 availability, the
motion setting and the OS preference (`fluidTier` in `src/shared/relay-rig.ts`).
The behaviour asked for is what ships: remove the module and the rail still
animates. The word "uninstall" waits for the registry, and this paragraph is
here so nobody mistakes the setting for it.

**What the module may not do.** It renders. It never becomes the source of a
value, never decides a phase's state, and never gates an action. If removing it
could change what the rail *says* rather than how it looks, it would not be a
material and this whole arrangement would be a lie.

### Motion off, reduced motion, and the terminal

`data-motion='off'` and `prefers-reduced-motion` keep every value — sediment
count, handback counter, swell state, route chip, verdict mark — and drop every
movement, exactly as the rest of `motion.css` does. The design constraint this
imposes is the useful one: **the rail must be fully legible as a still image**,
because for some operators that is all it will ever be. Every state is carried
by shape, position and number, never by movement alone.

The sluice never renders inside `.terminal-host`, and every selector in
`relay.css` stops there. Animation is transform and opacity only; nothing here
touches width, height or offsets, so no frame of the choreography lands on the
same main-thread work as an xterm repaint.

### Registration

`routes.ts` reads `TABS` positionally for the digit row (`DIGIT_ROUTES = 9`),
so a new entry is **appended** past it beside `board` and `mission`, never
inserted — an insert beside `insights` would silently move every shortcut after
it. Relay needs a `TABS` row with `group`, `hint` and `keywords`, an entry in
`TAB_ICONS`, and a place in the matching `SPACE_AREAS` area that
`SIDEBAR_GROUPS` maps over. The `hint` describes what the surface does rather
than restating its label, because `filterPalette` matches the query against
title, hint and keywords as one string.

## The reviewer's authority

A failed review returns to the implementer automatically, capped, reusing the
precedent in `gate-feedback.ts`: `HANDBACK_LIMIT = 2`, excerpts bounded to 60
lines and 4,000 characters, ANSI and control characters stripped, and the
operator's own redactor applied. Past the cap, failures wait for a person.

Two conditions on an automatic hand-back, both already established: it is
refused unless the session is plainly waiting at the prompt it stopped at, and
it is refused when the fleet is halted. A hand-back starts another agent turn
and spends tokens, so it is also refused when the relay's budget is exhausted.

The hand-back decision itself is a candidate for a cheap gate later — a noul
over the bounded excerpt asking whether it contains an actionable error rather
than a timeout or an unrelated crash, so a flaky failure does not consume one of
the two. That is an enhancement, not a dependency, and it is out of scope here.

## Dispatch

Stages are queue items, not a bespoke scheduler. `queue.ts` is already the one
dispatcher in front of every surface that starts work, re-reads ready work from
SQLite each tick rather than caching rows, and owns retry with backoff and
`MAX_ATTEMPTS`. A relay stage becomes ready when its `depends_json`
predecessors are `done` and, for the implementer, when its approval is
recorded. Relay registers a runner per stage kind and owns no timers.

This matters for correctness after a crash: a relay whose state lives in
`work_nodes` and `queue` resumes from the database, and the rail renders
whatever the rows say. There is no in-memory pipeline to disagree with disk.

## Data flow

1. Operator types an intent in the Relay composer and presses go.
2. Main validates the input (renderer input is untrusted until validated in the
   main process), creates the docket and its nodes, and records a `route` proof
   per node — the profile default, or a suggestion that cleared its threshold.
3. The planner node is enqueued. Its PTY session starts in plan mode.
4. `ExitPlanMode` fires; `goal-plans.ts` records the accepted plan as the
   goal's evidence. The planner node goes `done`; the rail holds.
5. Operator approves. The implementer node is enqueued into a linked worktree
   with its path claims taken.
6. Hook events drive the implementer cell's cadence and tally. `goal-trace.ts`
   records duration, cost and tokens per node from existing signals.
7. Implementer stops. The reviewer node is enqueued: the deterministic gate
   runs, then the headless review.
8. Verdict. Pass seals the rail; a failure within budget hands back; a failure
   past budget waits.

## Error handling

Every failure is a recorded state, never a silent retreat. A stage whose
session dies mid-run is `failed` with the reason kept beside Wanigan's own
sentence, following the pattern in `pr-readiness.ts` of never collapsing "could
not read" into "none". A router suggestion that errors, times out or returns
low confidence is dropped and the profile default stands — the same posture
`learning-model-assist.ts` takes, where every refusal returns null and the
caller falls back, so a build where the suggester never succeeds behaves
exactly like the build before it existed.

A live stage cannot survive a full Wanigan quit, and the view says so rather
than implying otherwise.

## Testing

- `src/shared/relay.ts` and `src/shared/relay-route.ts` are pure and belong in
  `test:shared` under `node --test`: stage topology and dependency order, the
  handback budget predicate, cadence period derivation from event timestamps,
  the tally cap, candidate-bounded route selection (including that an
  out-of-bounds suggestion is discarded rather than clamped), and verdict
  classification.
- Main-process behaviour goes in the offline `smoke` suite: migration
  idempotence, queue readiness, the one-spill-per-transition invariant, the
  hand-back refusals, and route proofs written exactly once per node.
- Three choreography invariants are contracts, not polish, and each gets a
  test: **no gauge without a denominator** (the planner and implementer basins
  must expose no fill value at any state), **seeded sediment** (the same node id
  yields the same grain layout across runs, so a screenshot is reproducible),
  and **still-image legibility** (every distinguishable rail state differs by
  shape, position or number with all animation suppressed — asserted by
  rendering each state under `data-motion='off'`).
- `test:renderer-style` must pass with no new baseline entries. Every
  `<input>`, `<select>` and `<textarea>` on the surface carries an accessible
  name; the gate holds that count at zero.
- `test:dead-code` (knip): a suggester dependency must be declared and used, or
  implemented with `fetch` like `glm.ts`, `deepseek.ts` and `xai.ts` do. Prefer
  `fetch` — it adds no dependency and keeps the hand-enumerated egress table
  literally true.
- Before and after screenshots of the Relay view in both themes, plus one of
  the rail mid-spill, one at the Level waiting on an approval, one after a
  backwash, and one with motion off.

## Scope

**In:** the Relay view and its sluice; the four existing phase kinds plus `estimate`; the local history forecast; the two additive
columns; route proofs; queue runners; the bounded hand-back; the pure shared
modules and their tests; route registration; and giving `.mo-breathe`,
`.mo-bump`, `--mo-period` and `data-flow="live"` a consumer again, with their
stale `motion.css` comments corrected in the same change.

**Out, deliberately:** any suggester integration (the interface ships, a
provider does not); parallel or fan-out stages; more than one implementer;
operator-defined stage graphs; anything that auto-commits; any causal savings
claim.

## Assumptions to correct in review

1. Five phases: the four `DEFAULT_DOCKET_PLAN` already declared, seeded from
   that array rather than redeclared, plus `estimate` between plan and
   implement. Relay renders whatever graph the docket holds; authoring a
   richer graph is out of scope.
2. The planner uses the harness's own plan mode and its approval stays in the
   CLI's own plan prompt, with Relay recording and displaying the result.
3. The reviewer runs headless rather than as a PTY, because it needs no
   terminal; the verify phase is the deterministic gate and the one with a
   real denominator.
4. `Relay` is the name, `⌘⇧R` the chord, area Projects, appended past the
   digit row, absent from the phone with its reason stated.
5. Ships with no suggester; the router shows profile defaults until one is
   added.
6. **No orb instance on the rail.** The rig supersedes the spherical cavity:
   the water is the fluid module's — the companion's solver against the rig
   as its boundary — and the companion's character stays at Home. The
   one-`GPUDevice` constraint is dissolved rather than worked around.
7. Reviving the dormant motion primitives is part of this change; the stale
   `motion.css` comments are corrected in the same commit that gives them a
   consumer again.
8. The verdict mark is the rail's own. The orb's six keepsakes keep meaning a
   completed compaction hook.
9. "Uninstall the fluid module" is the `fluid` preference (`auto | on | off`)
   until a first-party renderer-module registry exists; the three tiers are
   decided by `fluidTier()` in `src/shared/relay-rig.ts`.
10. The hand-back is a pump — the only physically assisted element on the rig
    — drawn as a dashed return line only while it runs.
11. Delivery is two commits in the rule's order: the seam conversion (tables
    derived from `VIEWS`; `VIEW_RENDERERS` replacing the App.tsx chain; the
    one resolved shortcut-order drift named in the message), then Relay.
