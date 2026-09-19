# Feature page simplification — 19 September 2026

This follows the [workspace navigation changes](workspace-simplification-2026-09-19.md).
It reduces competing controls inside Sessions, Goals, and Runs while keeping
their existing recorded state and execution boundaries. These are local source
findings and design decisions, not measured productivity or usability results.

## Sessions: find the session, then choose a reading

The session picker can search the current sessions and the saved records
already loaded for the picker. Matching words may appear in any order across
the available session and project labels. Searching does not select a different
session or replace the active terminal. A separate Search saved history action
passes the query to the archive for a broader search.

The session reader uses Changes, Activity, and Context as its three readings.
Desktop users can expand details to the available workspace width and return
to the terminal. The terminal stays mounted, and the composer draft stays in
its existing state. Compact layouts use the same full-width details mode.
Context here means this session's recorded launch context; project instruction
files remain in the separate Context view.

Sources: `src/renderer/src/views/Sessions.tsx` and
`src/renderer/src/styles/sessions.css`.

## Goals: keep the selected work visible

Search remains immediately available. The project and status controls move
into a remembered Filters disclosure whose summary always names the active
scope. Search matches all query words across a goal's title, project, and
objective. Counts distinguish matching goals from the total records read.

Filtering does not silently replace the selected goal or discard task notes.
If the selected goal falls outside the list, its detail explains that state
and offers Show selected goal. Clearing filters returns keyboard focus to the
visible search field, or to Browse goals when the compact list is closed.

At compact widths, Browse goals opens a bounded list above the detail. Choosing
a goal closes the list and restores focus to its toggle. Resizing transfers
focus when the current control would become hidden. The list and its controls
stay mounted, retaining the search and filter state.

Sources: `src/renderer/src/views/Control.tsx` and
`src/renderer/src/styles/control.css`.

## Runs: put the task before the setup

Repository runs and Compare attempts name the two existing modes. New run
starts with the task textarea and focuses it. Agent choice and common settings
follow. Less common profile fields live under Additional agent options; that
section starts open if the profile declares a required field. Repository
selection, budget, timeout, isolation, and launch intent remain in the explicit
launch flow.

History loading, read failure, and an empty history each have one primary
message, replacing duplicate list and inspector placeholders. An empty history
offers Prepare a run and Compare attempts. A populated list states how many
recent runs match its filters, and the selected run remains open with an
explanation when it falls outside those filters.

Sources: `src/renderer/src/views/HeadlessRuns.tsx` and
`src/renderer/src/styles/runs.css`.

## Scope and trust

These presentation changes stay within the existing registered renderer views.
They do not change goal acceptance, autopilot consent, provider capability
verification, review gates, or launch payloads. Reading or searching a list
does not launch an agent, run a check, change a repository, or spend tokens.

Runs still requires an explicit task, selected repositories, valid provider
options and budget, and a fresh declaration when every registered repository
is selected. The existing action lock and disabled launch state remain in
place. Additional options use the existing explicit validation; hiding their
disclosure does not bypass it or introduce a hidden native form submission.

Loading and unavailable evidence remain separate from observed empty results.
Prior successful reads can remain visible after a refresh failure with the
existing warning. Filtering changes only the list, not the checkout, selected
record, recorded evidence, or ownership of a pending action.

The accompanying screenshots and interaction probes use clearly fictional
records in an isolated renderer fixture. They demonstrate presentation and
state transitions; they are not evidence that real workloads were launched or
completed. Main-process behavior is verified separately by the repository's
offline suite. No live PTY survival across a full application quit is promised.

## Verification

The coordinated shared-tree build (`npm run build`, Node 22.23.2) passed on
19 September. `node scripts/capture-feature-pages.mjs after` passed five
interaction groups with 52 screenshots, no renderer errors, and no fixture
execution or mutation requests. `node --check scripts/capture-feature-pages.mjs`
and the scoped `git diff --check` passed. The full shared-tree `npm test`
finished with exit 0: all eight gates passed, including 533 shared tests,
six async-credential scenarios, and 2,341 offline smoke assertions with zero
failures. The coordinated run log is `/private/tmp/wanigan-wrap-final-test.log`.

The [before report](visuals/feature-pages-2026-09-19/before/verification.json)
records 34 captures from an isolated archive of `ebad0f0`. The refreshed
[after report](visuals/feature-pages-2026-09-19/after/verification.json) records
the shared build over `a5f71c3`, including the concurrent Relay changes. Each
report records its renderer index hash, fixture provenance, viewport, and theme.
The after capture ran in `/private/tmp/wanigan-feature-repro` and its complete
output was copied into the evidence directory. It replaces the abandoned
partial run and its failure screenshot.

The interaction checks cover unordered search without changing active work;
selected-goal and run recovery; compact/desktop focus transfers; compact list
and run-form scrolling; preservation of the session terminal, composer and
run drafts; and nested history/picker Escape handling. Required options begin
open and continue blocking launch when folded. Selecting all repositories
does not declare launch intent, and changing the selection retires that
declaration. Invalid budgets block launch; zero-budget copy, timeout,
worktree isolation, and approval controls remain available. No launch button
was pressed. Initial loading and failed reads remain distinct from an observed
empty run history.

Representative before/after captures for all three views were inspected in
both themes. The desktop and compact screenshots show the selected work
remaining visible, the single empty Runs state, and the expanded session
reader without horizontal page overflow.

The updated checkout-review probe passed 11 checks, including session/project
scope, stale evidence, draft retention, and long-path layout. Its historical
baseline still passed three checks. The broader UI probe passed 13 behavior
groups, including the renamed details controls, focus, draft preservation,
error recovery, and accessibility preferences, with no renderer errors or PTY
writes. These runs used temporary output directories; their reports are saved
under [compatibility](visuals/feature-pages-2026-09-19/compatibility/).
Their fixture repairs supply current ledger/worktree API shapes and follow
the Home and review-section labels; they make no production behavior changes.
