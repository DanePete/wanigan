# Workflow and page usability audit — 19 September 2026

This is a read-only source audit of Home, Sessions, Goals, Board, Relay,
Changes, Fleet, Usage, and Insights at the start of the 19 September research
task. Findings are design hypotheses supported by code, not measured usability
results. No live workload was launched and no user record was changed for this
audit. The companion research covers online design guidance separately.

## What is already working

The recent work already addresses the largest obvious navigation problems:
six task families, a hideable desktop sidebar, query-ranked commands, searchable
session and goal lists, and more room for the selected work. Sessions keeps the
terminal and draft while expanding details. Goals retains selection outside a
filter. Relay has a clear current-stage action. A second broad navigation
redesign would discard useful work without evidence that it solves the next
problem. See [workspace simplification](../workspace-simplification-2026-09-19.md)
and [feature page simplification](../feature-pages-2026-09-19.md).

The strongest remaining opportunity is to finish the short paths between an
observed status, the record that explains it, and the exact action the operator
can take. The nine pages represent several legitimate readings of the same
work; they should share recognizable destinations without merging their trust
or execution semantics.

The bounded implementation selected from this audit follows the companion
[primary-source research](2026-09-19-usability-sources.md):
[Google's communication guidance](https://codelabs.developers.google.com/codelabs/material-communication-guidance)
supports naming Home's actual Open session destination;
[Carbon's filtering guidance](https://carbondesignsystem.com/patterns/filtering/)
supports the visible active Fleet filter and recovery action; and
[Microsoft's navigation guidance](https://learn.microsoft.com/en-us/windows/apps/design/basics/navigation-basics)
supports keeping the list/detail relationship and report directory available.
Preserving the inspected record during live status changes, keeping Relay
read-only after refresh failure, and avoiding billing claims from missing
local evidence are Wanigan-specific applications of those principles, not
outcomes measured by those sources.

## Page inventory

| Page | Daily job and primary action | Actual scope and side-effect boundary | Overlap that needs explanation |
| --- | --- | --- | --- |
| Home | Default landing is the companion; Back to work opens session triage, continuation, and launch. `MissionRoom.tsx:29-42`, `:124`; `HomeWork.tsx:20`, `:56`, `:69`. | Project or all-project operational records. Opening a row navigates. Sending an optional companion question calls the selected Claude API model and bills separately; `MissionRoom.tsx:96`, `:181`, `:193`. | Fleet presents the same attention records in more depth. Home's finished-session action currently opens the terminal rather than review. |
| Sessions | Talk to a real agent; find/resume saved conversations; inspect its checkout. `Sessions.tsx:1040`, `:1051`, `:1224`. | Optional project filter. Live PTY input, interrupt, end, resume, attachment staging, and launch are real operations. Checkout is `session.worktree ?? session.projectPath`; `Sessions.tsx:1238`, `:1288`. | The Changes detail and Review work both render `CodePanel`; the latter adds checks. Global Changes reads a repository, which may differ from this session's worktree. |
| Goals | Follow a contract through tasks, proof, and an explicit final decision. `Control.tsx:609`, `:618`, `:639`. | Workspace list with its own project/status filters. Starting launches an isolated task, gate execution runs commands, and acceptance records a decision. Autopilot is separately armed with a cap; `Control.tsx:653`, `:759`, `:959`. | Board is the cross-goal task reading. Relay is a constrained staged goal. A session's completed turn is neither a completed goal nor acceptance. |
| Board | Triage ready, running, waiting, blocked, parked, and closed tasks across goals. Open a task, then start/reopen/park it. `Board.tsx:13`, `:149`, `:253`. | Optional project scope. Same goal graph and Control commands, not another task store; `Board.tsx:8`, `:125`. A stale read blocks mutations; `:227`. | Planning routes through the same Interview; evidence and choices can continue in Goals. No drag-and-drop state invention is needed: columns reflect dependencies and recorded state. |
| Relay | Carry one outcome through plan, forecast, implement, verify, and review; act at the current stage. `Relay.tsx:183`, `:242`. | Required project. Real sessions for agent stages; forecast is local; verification runs review commands; request changes can launch another implementation turn. Route suggestion/create can each call the optional paid suggester; `RelayComposer.tsx:142`, `:205`. | Its graph and proof belong to Goals. Detailed dependency/evidence routes already target the exact goal task; `Relay.tsx:190`, `:209`. |
| Changes | Inspect/stage a repository diff, inspect history/branches/stashes, run its review gate, then commit/publish. `Git.tsx:644`, `:688`, `:842`, `:856`. | Required project, repository checkout. PR checks use `gh` on explicit request; push scans then asks for explicit publication; `Git.tsx:169`, `:742`. Destructive actions use confirmation. | Session review uses a potentially isolated checkout. Merge readiness, gate results, and human acceptance answer different questions and should remain distinguishable. |
| Fleet | Monitor sessions across projects and respond to those needing attention. Default attention sort, selected-session detail, optional metrics comparison. `Fleet.tsx:392`, `:584`, `:609`. | Workspace scope. Reads sessions, attention, usage, observed external processes separately. Interrupt/stop signal real processes and report the request, not an assumed exit; `Fleet.tsx:368`. | Home is a shorter attention queue. Sessions owns the conversation. Fleet still has different finished-state language and selection behavior from the simplified work views. |
| Usage | Decide whether an account has room to work, then inspect its local recorded consumption. `Usage.tsx:474`, `:498`, `:520`. | Account scope across all projects. Provider capacity is distinct from local token consumption. Explicit Refresh limits can probe a real CLI; local observed reads can poll; `Usage.tsx:333`, `:344`, `:355`. | Insights adds attribution, trends, token pace and budgets, but neither page gives a direct bridge to the adjacent question. |
| Insights | Understand recorded costs/activity and manage budgets. Spending, Tokens & pace, Budgets, Batch reports. `Insights.tsx:805`. | Workspace scope; reporting windows have different meanings by report. Budget and batch reports are month-to-date/all-time, independent of the header window; `Insights.tsx:849`, `:857`, `:865`. Meters remain explicit. | Usage owns plan capacity; Insights also shows live provider windows and local burn rate. `registry.tsx:138` passes neither an account-navigation door nor the optional batch-run navigation callback. |

Paths above are under `src/renderer/src/views/` unless a component filename is
given; `HomeWork`, `SessionReview` and `NewSessionDialog` are under
`src/renderer/src/components/`. This table describes observed source behavior,
not real workload outcomes.

## Ranked friction and practical changes

### 1. Keep the selected Fleet session stable while its status changes

**Evidence:** `Fleet.tsx:415-419` resolves selection from the filtered list, falls
back to its first item, and writes that fallback over `selectedId`. If the
operator is inspecting a session under Asking and its permission is answered,
the next poll can select a different session without an explicit selection.
The inspector is also omitted entirely when the filtered list is empty
(`Fleet.tsx:597-635`). That differs from the explicit preservation and recovery
already implemented in Goals (`Control.tsx:594-596`).

**Recommendation:** Resolve the selected record from the complete latest
session reading. Keep its inspector present when a filter excludes it, state
why, and offer Show selected session / Clear filters. Replace selection only
when the record is actually absent. Keep confirmation/draft ownership on the
same session. Verify a permission-to-working transition with two sessions and
with an empty filtered list; a status poll must not change the action target.

### 2. Make finished-work language consistent and route review intentionally

**Evidence:** Home marks `finished` as Ready to inspect (`HomeWork.tsx:8`) and
explains that the changes and verification still need review (`:60-63`). Its
Inspect session button nevertheless calls the same `onOpenSession` as an Open
terminal action (`:56-58`); `App.tsx:635-640` only selects the session and route.
The dedicated review exists behind another click (`Sessions.tsx:1051`). Fleet
filters use Done (`Fleet.tsx:48`, `:587-590`), while main's attention label is
also Done (`src/main/attention.ts:91`).

**Recommendation:** Either label the Home action Open session honestly, or
provide a typed, one-shot session-review destination through the existing view
context and open the existing review workspace. Prefer the latter if this
iteration can preserve session/checkout identity. Use Finished turn or Ready
to inspect consistently; never imply that a turn-end signal is accepted work.
Keep permission responses in the original agent terminal.

### 3. Preserve report access when Insights has no recorded spend

**Evidence:** `Insights.tsx:741-772` returns before its report directory when
`!everSpent && buds.length === 0`. It says Nothing has been billed yet, explains
that the page reports money already spent, and shows a BudgetEditor. But
`everSpent` includes local token/effort/transcript evidence (`:685-690`), and a
lack of local evidence cannot establish what the provider billed. This state
also prevents a new user from exploring the otherwise well-organized report
directory at `:805-824`.

**Recommendation:** Keep the report navigation available. Use No recorded
activity/costs for the selected scope as appropriate, with clear relevant
actions. Put budget creation in Budgets and a link to it in the empty spending
state. Preserve loading, no record, unpriced record, and failed read as distinct
states. Do not require the user to create a budget just to learn the page.

### 4. Match Relay's stale-state interaction to Board and Goals

**Evidence:** Failed Relay refreshes retain the last successful snapshot and
display a warning (`Relay.tsx:81-84`, `:165-167`). `RelayAction` receives `busy`
but not `readError` (`:186-190`), and all mutation buttons gate on busy alone
(`:249-277`). Board blocks changing a task after a read failure
(`Board.tsx:227-238`); Goals supplies an unavailable busy state
(`Control.tsx:639`, `:667-668`).

**Recommendation:** Keep inspection/session navigation available, but disable
launch, completion, forecast, verification and decision actions until a fresh
read succeeds, with a clear Retry refresh action. This is a consistency and
error-recovery finding; it does not claim the main process lacks validation.
Verify that the selected relay and existing evidence remain visible on failure.

### 5. Put the exact launch choice beside the task action

**Evidence:** Goals' Start isolated task is in `NodeCard` (`Control.tsx:959-961`),
while Provider for next task and Model override are below the evidence workspace
inside Execution & spending (`:653-665`). The folded summary carries the
provider, but the action itself does not say which agent/model it starts.
Board puts the provider directly beside Start task (`Board.tsx:256-260`), and
Relay states the route in its current action (`Relay.tsx:265`).

**Recommendation:** Show the chosen provider/model next to the selected task's
launch button with a targeted Change agent door. Keep autopilot, caps and
review policy in the separate disclosure. This exposes an execution consequence
without bringing every advanced field into the daily task flow.

### 6. Give account-capacity and spending pages explicit task doors

**Evidence:** Usage already derives a defensible same-harness/same-window spare
account (`Usage.tsx:374-395`), but the message ends with textual directions to
New session or Settings (`:460-470`). Usage receives no navigation props and
Insights receives none in `views/registry.tsx:138-139`. Insights' batch rows have
an optional `onOpenRun` (`Insights.tsx:395`, `:900`, `:2990`), which is not wired
by that registration. The existing schema is two distinct data products, not
simply two names for one number.

**Recommendation:** Add clear adjacent-task doors: Account limits from
Insights, Spending/Budgets from Usage, and an explicit new-session flow from a
capacity message. Pass only a proposed account into that launch flow; do not
silently switch active sessions or auto-start work. Wire batch records to the
owning Batches view only if the route can select the exact record. A larger
shared Monitor directory can follow, but should not collapse provider quotas,
local observations and estimated costs into one status.

### 7. Make report time scope visible where it changes meaning

**Evidence:** The Insights reporting-window select remains in the common header
(`Insights.tsx:693-701`) while Budgets says it is independent of that window
(`:857-858`) and Batch reports says all time plus a separate reconciliation
window (`:865-871`). Tokens & pace contains provider windows, selected-day
transcripts, and all-time distributions together (`:849-855`). There is already
honest explanatory copy, but the globally prominent control implies broader
effect than it has.

**Recommendation:** Put the date-window control with windowed reports or state
its scope next to the control. Give each report a visible active period. Keep
the period that produced a last-successful snapshot visible while refreshing
another period. No new chart is needed to fix this question.

### 8. Explain session Changes versus Review work at the entry points

**Evidence:** Sessions' Changes tab renders `CodePanel` (`Sessions.tsx:1237-1249`),
while Review work also renders `CodePanel` plus a separate checks tab
(`SessionReview.tsx:20-32`). The current implementation preserves both review
panels while switching, so that workspace is a useful existing destination.
Global Changes has repository operations and its own review gate
(`Git.tsx:842-861`).

**Recommendation:** Prefer one explicit review route for changes plus checks;
make a compact Changes reader's Review checks action open it at the correct
section. Keep the actual checkout path visible. Do not substitute repository
checks for isolated-session checks, and do not replace a live terminal when
switching readers. This is lower priority than stable action targets and
truthful missing-state copy because the existing paths are usable today.

## Module and verification constraints

All nine destinations already declare a renderer module in
`src/shared/view-registry.ts:51-250`, and are rendered through the exhaustive
`VIEW_RENDERERS` table in `src/renderer/src/views/registry.tsx:104-165`.
Presentation changes should use that seam and its existing typed context,
rather than adding another route-specific branch to `App.tsx`.

The renderer registry and main-process module registry are deliberately separate
(`src/main/module-registry.ts:17-26`). Only Scout, Suggest and Relay currently
register in `src/main/modules/register.ts`. Relay is already optional and owns
its namespace/marker (`src/main/modules/relay.ts:6-10`, `:25-43`); Control owns
goal launches and evidence. A renderer registration does not prove the complete
backend feature has been converted. If work changes an unconverted backend
surface, the repository requires a behavior-preserving conversion commit before
the behavioral change. None of these usability findings justifies the emergency
escape.

For implementation, take before/after screenshots of every changed view in both
themes, including a compact viewport, and exercise the specific transitions
named above in isolated renderer fixtures. Keep drafts, keyboard focus, scoped
identity, stale readings, action locks and exact action destinations in those
checks. Fictional fixtures are presentation evidence only. Run all eight
`npm test` gates with Node 22.23.2 for code changes and `git diff --check` before
handoff. This audit itself changes only this research note.
