# Relay lanes: orchestration that spends less and lands more

Status: design, awaiting the operator's review. Nothing here is implemented.
Date: 2026-09-20. Branch read: `feat/mcp-store` at `95f54ab`.

Research behind it: `reports/AI orchestration tools vs Wanigan.md` (the field,
and why Relay is not yet an orchestrator), plus code audits of Control, Relay,
the module registry, worktrees, the review gate, usage limits and outcome
evidence. Interactive mockup: `reports/Relay lanes mockup.html`.

## The goal, stated as something we can measure

The operator's goal is to **save money while producing more and better work**.
The three pull against each other. More agents cost more, and parallel writers
make more mistakes unless one verifier checks the combined result. So this
design is judged by outcomes, not by how much runs at once:

- **Money**, in the currency each route actually uses:
  - billed dollars per accepted change, for pay-as-you-go keys;
  - percent of each plan window per accepted change, for subscriptions;
  - minutes of local compute, for local models.
  Every failed attempt counts in the numerator, and an unpriced attempt is shown
  as unpriced, never as zero.
- **More**: accepted changes per operator-hour and per calendar day.
- **Better**: first-pass acceptance, gate passes on the combined tree, and
  changes reopened within 14 days.

Following `AGENTS.md`, no screen claims a saving until a paired comparison
(same tasks, same starting commits, lanes against one lane) has measured one.
Until then, figures are labelled as estimates.

## Decisions made in this design

The operator asked for these to be decided rather than left open. Each can be
overridden. The rest of this document assumes them.

1. **Orchestration lives in Relay, not a new view.** Relay becomes the one front
   door for "outcome in, one checked change out". Goals and the Board remain the
   underlying record and the power-user graph editor ("Open in Goals"). Reasons:
   - the operator already thinks of Relay as the orchestrator;
   - Relay already owns routing, forecasting, automation and delivery;
   - Relay has the product's strongest visual language, the Sluice rig, and
     lanes fit it naturally (see UI below);
   - `AGENTS.md` cites seventeen views reaching the sidebar one hand-wired route
     at a time, and an eighteenth would repeat that.
2. **Relay stays single-lane by default.** Lanes appear only when the plan finds
   areas that don't overlap and the project has checks that can test the
   combined result. The operator approves the split and what it will use first.
3. **Integration is deterministic.** Merging is git plus the project's own
   checks, with no model. One resolver agent for a conflict is opt-in and
   budgeted. Cursor removed its integrator agent as a bottleneck, and Cognition
   reports that only single-threaded writes work reliably.
4. **Plans first, pay-as-you-go last.** Subscription headroom and local models
   are used before any per-token key. Wanigan asks before moving work onto a
   pay-as-you-go key. Every plan window keeps a reserve for the operator
   (default 10%).
5. **Lane count comes from the plan.** One lane per non-overlapping area.
   Wanigan proposes up to 6 by default. The hard ceiling is 16, because a merge
   node depends on every lane and Control allows 16 dependencies per task
   (`MAX_DOCKET_NODE_DEPENDENCIES`, `src/shared/types.ts:1497`).
6. **Concurrency stays at the node-lane default of 2** (`DEFAULT_SLOTS.node`,
   `src/shared/types.ts:2299`). Extra lanes queue, and the operator can raise the
   limit in Settings.
7. **The human final review is unchanged.** One terminal review task, never
   dispatched to an agent, with approval bound to the exact merged tree.

## What the operator sees

Four moments, all in the Relay view. The mockup shows each, with a lane-count
switch (2 / 3 / 4 / 6 / 8).

1. **Describe.** One outcome box, then:
   - where the relay may run: plan and account chips, including local models and
     any pay-as-you-go key, which is marked "ask first";
   - Spend (Lower cost / Balanced / Higher quality), a preference that already
     exists;
   - "Keep for yourself: 10% of every plan window";
   - Lanes (Split when it pays / Always one lane).

   Per-stage model choice, account, commit and deploy move behind one
   disclosure. Today's composer shows seven fields and four paragraphs before the
   first button.
2. **Approve the plan (the deal).** After planning, one card:
   - "The plan splits into N lanes that don't overlap", with two options side by
     side: N lanes, or one lane. Each shows billed dollars, time, and the
     percent of each plan window it will use.
   - An honest verdict on each option, such as "Recommended", "Needs one
     change", or "Won't fit this window". The one-lane Opus option can need more
     of the Claude session than is left.
   - Reasons, each a checkable fact:
     - files don't overlap, with the claimed paths;
     - the checks can judge the combined result;
     - work is spread by headroom ("Claude's session is 82% used, so lane B runs
       on Codex and C on this Mac");
     - every plan keeps the reserve, or which lane to move if one wouldn't.
   - A table of who does what, with a "Will use" column in each route's own unit.
   - Actions: Run N lanes, Run as one lane, Open in Goals.
3. **Lanes at work.** A calm "Nothing needs you" state until something does. The
   lane list shows state, worker, recorded activity (tool calls, never percent
   complete) and usage so far. The merge basin shows lanes merged so far, the
   combined checks and the conflict forecast.
4. **Your call.** One combined change:
   - checks passed on the merged tree, with its hash;
   - lanes merged cleanly;
   - read-only reviewer notes, labelled as advice that cannot approve;
   - Approve / Request changes / Reject, where Request changes picks the lane
     that owns the files and the other lanes stay merged;
   - a receipt of what each plan window actually moved, local minutes, billed
     dollars, and the API-price equivalent.

A **Your plans** panel sits in the relay summary throughout. For each account:
- a bar of what is already used, this relay's projected slice (hatched), and a
  mark at the reserve;
- when the window resets, and the week window beneath it;
- local models as "free · ≈N min";
- pay-as-you-go keys in dollars.

Its footer says "$0.00 billed · worth ≈$X at API prices, covered by plans you
already pay for". The panel is a shared component, so Usage and Fleet can adopt
it later.

## Where the savings come from, in order of certainty

1. **Stop defaulting every Claude stage to Opus.**
   - Claude Code's model field has no default (`src/main/provider-packs.ts:896`),
     and the published choices start with `opus`
     (`src/main/launch-choices.ts:100-111`).
   - So Relay's profile-default route is Opus for every stage
     (`src/shared/relay-route.ts:271-278`).
   - Per-stage-kind defaults declared by the provider pack fix this with no
     model call and no new evidence: plan and implement on Sonnet, the read-only
     reviewer on Haiku.
2. **Use what is already paid for.**
   - Subscription windows are read live today, for Claude through
     `claude -p "/usage"` (`src/main/modules/usage-claude-limits.ts`) and for
     Codex through its app-server (`src/main/modules/usage-limits.ts`).
   - Nothing routes by them yet. Routing by headroom turns idle subscription
     capacity into accepted work, before any per-token dollar.
3. **Replace model calls with deterministic steps.** These cost no tokens:
   forecasting (already), merging, combined checks, bisecting a failed merge,
   and conflict forecasting.
4. **Right-size each lane.** A scoped lane ("idempotency keys in `payments/`")
   can succeed on a cheaper model where one lane doing everything needs the
   strongest. This is a hypothesis to measure, and the ledger measures it.
5. **Cut rework.** Checks run on the combined tree before a person looks.
   Hand-back goes only to the lane that broke the build, and a capped nudge goes
   to a stalled lane. Rework costs more than any routing choice saves.

What parallelism buys is mostly time and throughput, not tokens. The deal card
says so: lanes win on money only when scoped lanes let cheaper routes pass.

## Architecture

The work is shaped by `AGENTS.md` ("everything is a module"): the kernel gains
extension points, Relay is rebuilt on them as the proving default, and new
behaviour ships as modules. Control stays a required module. What "verified"
means cannot be shadowed:
- one terminal human review;
- review never dispatched to an agent;
- a budget or allowance before unattended work;
- no overlapping concurrent claims.

### 1. Kernel: open node kinds (Control extension point)

Today `DocketNodeKind` is a closed five-value union
(`src/shared/types.ts:1414`, `DOCKET_NODE_KINDS` at `:1493`), and `buildPlan`
refuses anything else (`src/main/control.ts:463-557`).

**Change.** A registry of node kinds, declared on the module record:

```ts
type NodeKindDefinition = {
  id: string;                          // 'integrate', 'inspect', …
  label: string;                       // what the board and the planner read
  runs: 'agent' | 'wanigan';           // 'wanigan' = deterministic, no provider spend
  producesTree: boolean;               // becomes the verification root for its dependents
  dispatchable: boolean;               // may autopilot start it (review: never)
  defaultPermission?: 'plan' | 'acceptEdits';
  validate?(node: PlannedNode, graph: PlannedNode[]): string | null;
  run?(nodeId: string): Promise<void>; // required when runs === 'wanigan'
};
```

- The five built-in kinds register through the same path, from Control itself.
  `review` is registered by the required module as not dispatchable, and no
  third-party kind may take its id.
- The renderer reads kinds over typed IPC instead of importing the array, so
  the PlanEditor and the planner refusal list show registered kinds.
- `estimate` is the precedent for `runs: 'wanigan'`. It is refused in
  `startNode` (`control.ts:704-706`) and run by a completion listener
  (`relay.ts:865-887`).
- Deterministic kinds are dispatched on the existing `'node'` queue lane,
  through the automatic-runner seam (`control.ts:1606-1629`). That seam widens
  in two ways: it applies to any registered `runs: 'wanigan'` kind, and it
  applies whether or not autopilot is armed. A free step should not need
  autopilot.
- "Cannot authorize provider spend" becomes enforced, where today it is a
  comment. A `wanigan` runner receives no provider or session API.

### 2. Kernel: routes on plan nodes

`DocketPlanNode` has no route (`types.ts:1470-1478`), so plain goals cannot
declare which account or model a task uses. Relay writes pins with raw
`UPDATE`s after `createDocket` (`relay.ts:375-400`).

**Change.** `route?: { providerId; model?; effort?; accountId?; permissionMode? }`
on plan nodes, validated as Relay's `profileFor` validates
(`relay.ts:176-210`): an invalid choice is refused, never clamped.
`createDocket` writes it, and Relay stops writing pins by hand. Autopilot
already prefers a node pin over the goal-level model (`control.ts:1983`).

### 3. Kernel: amend a graph after planning

Nodes are written once in `createDocket` (`control.ts:559-596`), and lanes are
only known after the plan.

**Change.** One narrow operation:

```ts
splitNode(docketId, nodeId, lanes: DocketPlanNode[]): DocketDetail
```

- It replaces a pending implement node with N implement lanes plus one
  `integrate` node, and rewires the replaced node's dependents onto the
  integrate node.
- It re-runs every `buildPlan` invariant over the whole resulting graph:
  acyclic, one reachable review, no concurrent claim overlap, and 16
  dependencies at most.
- It is allowed only while the target and everything downstream are pending.
- The operator's acceptance is the approval; nothing is split silently. The
  before and after graphs are recorded as evidence.

This is deliberately not a general graph-editing API.

### 4. Kernel rules that must learn about a merge

Each of these refuses parallel work today because there was no integration
operation:

- **`verificationTree`** walks every upstream implement node and refuses more
  than one checkout (`control.ts:949-986`, message at `:942`). **Change:** a
  node whose kind `producesTree` is a root. Its worktree is taken, and the walk
  does not continue past it.
- **The review coverage rule** requires every implement checkout to carry a
  passing gate (`control.ts:1206-1216`). **Change:** an implement node whose
  downstream integrate node holds a current passing proof counts as covered,
  and its own lane gate still has to have passed.
- **Relay delivery** requires one implementation checkout
  (`src/main/relay-delivery.ts:216-242`). **Change:** it resolves to the
  integrate node's worktree when one exists. The binding chain stays exactly as
  it is (`relay-delivery.ts:341-379`): approved tree, then staged `write-tree`,
  then committed `HEAD^{tree}`.
- **Relay hand-back** refuses when more than one implementer leads to the
  review (`relay.ts:829-839`). **Change:** it targets the lane that the
  integration blamed, or the lane the operator picks.

### 5. Module: integration (`integrate` node kind)

A new first-party module. It is optional, because a project without lanes never
uses it. It reuses what already exists.

**Before lanes start.**
- Lane worktrees are cut from one base, the docket's `base_commit`, through
  `createWorktree(…, { startPoint })` (`src/main/worktrees.ts:990-1156`).
- Today goal worktrees are cut from the branch tip at launch
  (`src/main/sessions.ts:1224`), so parallel lanes could have different merge
  bases. That is a correctness fix in its own right.

**When the last lane completes.** The integrate node runs as a deterministic
step:

1. **Freeze each lane.** The lane's session has ended and its gate has passed,
   so Wanigan commits the lane's work on the lane branch as one commit ("Lane B:
   Order creation on retry"). It does this through the guarded commit path
   (`src/main/guarded-git.ts:62`, which includes the secret scan). It refuses if
   a live session holds the checkout, as delivery does
   (`relay-delivery.ts:232-238`). The commit id is recorded on the node.
2. **Forecast.** Chain `git merge-tree` across the lanes in claim order. Reuse
   `parseMergeTree` and `classifyPair` (`src/shared/collisions.ts:104-134`) and
   add an exported N-way chain. The result is either the predicted merged tree,
   or the conflicting files and lane pair, found before touching any checkout.
3. **Merge.** Merge into a Wanigan-owned integration worktree cut from the same
   base: `merge --no-ff` per lane, in order. Reuse the abort and restore
   sequence and `conflictedFiles` from `runMerge` (`worktrees.ts:1312-1409`).
   The worktree row gains an owner that is a node rather than a session, so
   `reconcileWorktrees` does not list it as an orphan (`worktrees.ts:1593-1595`).
4. **Check the whole.** Run `review.runAt(projectId, integrationCwd)`
   (`src/main/review.ts:421-520`). Its doc comment already anticipates cwds that
   the main process owns. Record a `test` proof on the integrate node, with the
   tree hash from `snapshotTree`.
5. **On red, blame one lane.** Binary-search the merge prefixes: check out each
   prefix merge commit in the integration worktree and gate it. That is at most
   ⌈log₂ N⌉ + 1 gate runs, with no tokens spent. The first failing prefix names
   the lane, which gets:
   - a hand-back packet built with `failureExcerpt`
     (`src/shared/gate-feedback.ts:65`);
   - the earlier lanes' merged commit merged into its branch before it
     relaunches, so it fixes the interaction against real code;
   - the existing cap, `HANDBACK_LIMIT = 2` (`gate-feedback.ts:17`).

   The other lanes stay merged.
6. **On conflict, stop and name it.** Show the files and the two lanes, then
   offer three choices:
   - send the later lane back with the conflict against the merged code;
   - resolve it yourself in the integration worktree;
   - opt in, with a budget, to one resolver agent, added through `splitNode` as
     an implement node that runs in the integration worktree.

   The resolver is never automatic.
7. **On green,** the integrate node completes with proof
   `{ tree, lanes: [{ nodeId, commit }], forecast, gateRunId }`. Verify, the
   read-only reviewer and the human review all run against the integration
   worktree through rule 4 above.

**Checks run one at a time.** Gates across worktrees run in series, as Attempts
already does (`src/main/attempts.ts:217-246`), because suites in sibling
worktrees can share ports and databases.

### 6. Module: allowances (plans, local models and keys as one budget)

**The problem.** The unattended-spend verdict speaks only dollars.
`automaticSpendVerdict` refuses any `partial` or `unreported` coverage
(`src/shared/automatic-spend.ts:13-29`). Codex never reports dollars, so
unattended Codex work cannot pass it. And a lane launched a moment ago has no
cost metric yet, so parallel autopilot probably halts itself as soon as two
lanes run. That second point is inferred from `control.ts:191-205` and
`:1875-1913`, not observed.

**The allowance model.**

```ts
type Allowance =
  | { kind: 'window'; accountId; harness; windows: { kind: string; usedPercent: number; resetsAt: number | null }[];
      fetchedAt: number; state: AccountLimits['state'] }        // from usage-limits.ts
  | { kind: 'dollars'; scope: 'relay' | 'month'; limitUsd: number; reportedUsd: number;
      coverage: 'reported' | 'partial' | 'unreported' }         // today's budgets
  | { kind: 'local'; profileId: string };                        // no quota; minutes are recorded
```

**Readings.**
- A new additive table,
  `allowance_readings(account_id, window_kind, used_percent, resets_at, observed_at)`.
  It is written whenever Usage reads limits, and additionally when a node starts
  or stops on that account.
- Claude's status line already records `five_hour_pct` and `seven_day_pct` per
  session (`status_observations`, `src/main/modules/usage-storage.ts:99-120`),
  and that history is reused.

**What a stage will use, as an estimate.** For each account and
(stage kind, model, effort), take the median percent the primary window moved
across completed stages of that kind.
- Stages that overlapped another session on the same account are excluded, or
  apportioned by recorded tokens (`claude_usage_events`, `src/main/db.ts:580-600`).
- With fewer than three clean samples the answer is "not enough history yet",
  never a number. Wanigan then reads the window as the work runs.
- The note on the screen says plainly that other use of the same account,
  including claude.ai chat, shares the limit.

**The dispatch verdict for window routes.** Refuse to start a stage when
`left − projected − reserved < reserve`. Here `reserved` holds the projected
slice of lanes already launched on that account and not yet settled. That
reservation is what lets lanes launch side by side without the self-halt.
- Mid-run, a window that crosses the reserve never kills a turn. The next lane
  waits for the reset, or is offered a move to another account with the
  operator's consent.
- Dollar routes keep today's verdict unchanged.
- Local routes need no verdict, and their minutes are recorded.

**Placement.** For each lane:
- filter routes the project's ledger has seen accepted on this kind of work;
- prefer $0 billed;
- among $0 routes, prefer the one that uses the smallest share of its remaining
  headroom (`projected ÷ left`);
- respect every reserve.

This is deterministic and explainable in one sentence on the deal card.
Anything that needs paid judgment stays with the existing consented suggester
(`src/main/modules/suggest.ts`), which currently sees no prices or outcomes.

**Worth at API prices.** Token counts × the public price snapshot already held
by `model-economics` (`src/main/modules/model-economics.ts:198-201`), labelled
as an estimate. It is never presented as billed.

### 7. Module: ledger (what routing and the receipt read)

`work_outcome_reviews` already keeps every attempt of every node, including
failed ones, with route identity and cost coverage (`control-outcomes.ts:13-73`).
Nothing reads it outside the smoke tests.

**Change.** A reader that builds a cohort per project:
- for each (stage kind, route): attempts, accepted, first-pass gate rate,
  reworks, billed dollars, window percent, local minutes and API-price
  equivalent;
- unfinished goals rebuilt from `work_node_sessions`, so abandoned work still
  counts in the numerator;
- acceptance, which is per goal, credited to every stage and labelled as
  correlation, not attribution;
- a lane's own first-try gate pass as the stage-level signal.

Placement, the forecast and the receipt's 30-day trend all read this one ledger.

### 8. Relay: the lanes recipe

The pipeline: plan → estimate → (split) → lanes → integrate → verify →
read-only review → human, with a single lane when the plan doesn't split.

**Where lanes come from, cheapest first.**
1. **The plan agent's own output.** The plan stage's instructions ask it to end
   with a fenced `lanes` block (title, instructions, claimed path) when the work
   splits cleanly. The accepted plan is already captured, up to 32,000
   characters (`src/main/goal-plans.ts:28`). Parsing the block is free and
   strict, and anything invalid falls back to one lane.
2. **The Interview module, if the operator opts in.** It already proposes
   graphs that "nothing … is trusted" until accepted
   (`src/main/modules/interview.ts:22`). It is budgeted.
3. **The operator**, through Edit lanes.

Then `splitNode` writes the lanes, after the operator accepts the deal.

**Read-only reviewer depth follows Spend.** Lower cost runs zero or one reviewer
on Haiku, Balanced runs one, and Higher quality runs three with different focus
(correctness, tests, security). This is a registered `inspect` kind: agent,
plan permission mode, runs on the merged verified tree. Findings are recorded
as evidence, and it cannot approve.

### 9. Later modules (named so the extension points fit them)

- **Watchdog**, built on the module heartbeat from
  `feat/routing-suggester-ports` (`7d71511`). That branch merges onto this one
  with no textual conflict, but three gaps must be fixed first: the tick has no
  re-entrancy guard, no beat checks the halt, and errors are swallowed without
  logging. The watchdog acts on attention's existing "Stalled" verdicts
  (`src/main/attention.ts:296-393`), in order:
  1. notify;
  2. one templated nudge (opt-in, counted against the allowance);
  3. hand over to a fresh session.
  4. mark the node failed.

  Handover currently loses the worktree and the node binding
  (`src/main/handover.ts:90-122`), and that must be fixed first.
- **Triggers** that create draft relays from schedules and issue intake, armed
  only with an allowance.
- **Structured drivers** (ACP, Codex app-server) beside the terminal. Claude
  stays on its real CLI.

## The rig

The Sluice geometry is a pure module (`src/shared/relay-rig.ts`), with a WebGL
fluid tier and an SVG/CSS tier (`src/renderer/src/relay/`).

- `rigLayout` gains one optional row of N side-by-side lane basins between
  forecast and merge. They are fed by a manifold and drain into one wider merge
  basin.
- The single-lane layout stays byte-for-byte identical, so the particle-count
  pins in `relay-rig.test.ts` hold.
- In the first delivery, a relay with more than one lane renders on the SVG/CSS
  tier. `useFluidTier` falls back rather than extending the SPH solver's
  boundaries in the same change.
- What the water means stays honest:
  - Water sits where work is, and splits into the lanes.
  - A lane drains into the merge basin when it merges, so the merge basin's
    level is merged lanes ÷ N. That is a count, not an estimate.
  - Sediment is recorded activity, and nothing is ever percent complete.
- Beyond four lanes, the per-lane labels collapse into a summary, and the lane
  list carries the detail.

It follows the renderer rules:
- the view roots on `.pane` with `PageHead`;
- `SectionHead`, `Pill`, `Chip`, `Segmented`, `Stat`, `Note` and `Explainer`
  from `bits.tsx`;
- no new `*-card` family;
- tokens only, in `styles/relay.css`;
- every control named;
- before and after screenshots in both themes.

## Data changes (all additive)

- `work_nodes`: `source_commit TEXT` (a lane's frozen commit). Kinds become
  registry-validated text; the column is already `TEXT`.
- `worktrees`: `owner_kind TEXT DEFAULT 'session'`, `owner_id TEXT`. The
  integration worktree is owned by its node.
- `allowance_readings` (new), and `allowance_reservations(node_id, account_id,
  window_kind, projected_percent, created_at, settled_at)` (new).
- `relay_lanes` evidence rows: the proposed split, the accepted split, and where
  it came from (plan block, interview, or operator).
- Provider-pack manifests: optional `stageDefaults` per stage kind. They are
  validated like every launch field, and unknown kinds are ignored.

## Failure handling

| Situation | What happens |
|---|---|
| The plan's lanes block is missing or invalid | One lane. The deal card says why ("the plan didn't split cleanly"). |
| Lanes claim overlapping paths | `splitNode` refuses with task numbers, exactly as `buildPlan` does today. |
| A lane's gate fails | The existing capped paste-back in that lane. The merge waits. |
| Merge conflict predicted | Stop before touching a checkout. Name the files and lanes, and offer the three choices. |
| Combined checks fail | Bisect, blame one lane, hand back with the merged context. Others stay merged. |
| A plan window would cross the reserve | The deal card shows it before start, with a one-click move. Mid-run, the next lane waits or asks. |
| A window can't be read (signed out, stale, unsupported) | The account shows that state (`AccountLimits.state`). Its routes are not used unattended. |
| Halt pulled | Nothing new starts. The integrate step checks `halted()` before each merge and each gate run. |
| Wanigan quits mid-merge | The integration worktree is Wanigan's own. On restart it is reset to the last recorded merge and resumed. Lane branches are untouched. |
| An operator runs something in the integration worktree | Freshness rules already refuse a stale pass (`review.ts:135-149`). The merge restarts from the recorded commits. |

## Testing

- **Shared, pure** (`node --test`, under a second):
  - lanes-block parsing and validation;
  - `splitNode` graph invariants;
  - the N-way `merge-tree` chain parser;
  - the prefix-bisect selector;
  - allowance projection and the reserve verdict, including reservations for
    siblings that haven't reported yet;
  - placement ordering;
  - the ledger cohort rules (failed attempts in the numerator, unpriced never
    summed as zero, cumulative snapshots not double-counted).
- **Main-process smoke, with real git and SQLite** (like `smoke26.ts` and
  `smoke-control-outcomes.ts`):
  - three lanes on a fixture repository merge clean;
  - a planted conflict is predicted before merging;
  - a planted cross-lane test failure is blamed on the right lane;
  - approval is bound to the merged tree;
  - delivery commits exactly that tree;
  - a halt pulled mid-merge stops the next step.
- **Control dispatch** (`scripts/test-control-dispatch.cjs`):
  - two lanes launch side by side without an unknown-spend halt;
  - a window route is refused under the reserve;
  - a deterministic kind runs without autopilot armed.
- **Renderer:** the style gate, and screenshots of all four moments in both
  themes.
- **The claim that it saves money** is not a unit test. It is a paired pilot on
  a fixed task set with a declared allowance, reported with its uncertainty, as
  `docs/research/2026-09-19-relay-reliability-throughput.md` lays out.

## Delivery order

Each phase ships on its own, gets its own implementation plan, and follows
`AGENTS.md`: convert a surface into a module first, in a behaviour-preserving
commit, then change it.

0. **Foundations.**
   - The Relay automation now on `feat/mcp-store` reaches `main`. That is the
     operator's call on landing the branch.
   - Per-stage default models in provider packs, which ends the Opus-everywhere
     fallback.
   - Goal worktrees are pinned to the docket's base commit.

   The first two are the cheapest savings in this document.
1. **Allowances.**
   - Readings, per-stage estimates, the reserve, reservations, and a
     window-route dispatch verdict.
   - The Your plans panel, and the receipt, on today's single-lane Relay.

   This saves money before lanes exist, and it is a prerequisite for unattended
   Codex lanes.
2. **Lanes.**
   - Node-kind registry, plan-node routes, `splitNode`, the kernel rules in §4,
     the integration module, the lanes recipe and hand-back to the blamed lane.
   - The deal card, the lane rig (SVG tier), the lane list and the merge basin.

   This is the phase that makes Wanigan a true orchestrator.
3. **Ledger-driven placement**, read-only reviewer depth by Spend, the 30-day
   trend, and the paired pilot.
4. **Watchdog, triggers and structured drivers.**

## Out of scope, deliberately

- Merging on green without the human review.
- An LLM integrator in the merge path by default.
- Driving a harness's own swarm (Claude agent teams) from inside one terminal.
- Hundreds of agents over days. A live PTY does not survive a Wanigan quit.
- Task ledgers written into the user's repository.
- Any savings claim without the paired comparison.
