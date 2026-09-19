# Wanigan usability research and implementation

Date: 2026-09-19. Audited source baseline: `6fd50c7`.

The audit covered all 19 destinations and their principal child workflows. The
implementation improves ten pages without adding another navigation layer or
changing how agents execute work. These are evidence-informed design changes,
not a claim that a user study has demonstrated faster or easier task completion.

## Research trail

- [Work and monitoring audit](2026-09-19-workflow-ui-audit.md): Home, Sessions,
  Goals, Board, Relay, Changes, Fleet, Usage, Insights. Includes page jobs,
  overlapping concepts, operational boundaries, and source references.
- [Advanced feature audit](2026-09-19-advanced-ui-audit.md): Learning, Skills,
  Context, Scout, Runs, Batches, Schedules, Settings, Extensions, Plugins.
  Includes launch prerequisites, provider limitations, and module ownership.
- [Online usability research](2026-09-19-usability-sources.md): primary guidance
  from Google PAIR and Material, Microsoft, IBM Carbon, GOV.UK, W3C, and Nielsen's
  original progressive-disclosure article. Each recommendation distinguishes
  what the source says from its proposed application to Wanigan.

The source audit followed the renderer through preload and main-process handlers
where a label or action's meaning was uncertain. For example, Skills' scanner
already returned separate Codex records; the renderer's smaller local interface
discarded them. Runs' required provider fields, by contrast, were already opened
automatically. The implementation repairs the first and preserves the second.

## Design decisions

[Google PAIR](https://pair.withgoogle.com/chapter/mental-models/) supports
introducing a capability in the context of the user's task and stating its limits.
[GOV.UK Details](https://design-system.service.gov.uk/components/details/) supports
disclosing secondary information while retaining commonly needed information.
Together, these informed visible agent coverage and action consequences, with
optional architectural explanation behind a disclosure.

[Microsoft navigation guidance](https://learn.microsoft.com/en-us/windows/apps/design/basics/navigation-basics)
and [Carbon filtering](https://carbondesignsystem.com/patterns/filtering/) informed
the stable Fleet inspector and visible filter recovery. Keeping an inspection
target stable under a live status change is our application of those principles;
neither source specifically tested Wanigan's polling behavior.

[Carbon's time picker guidance](https://carbondesignsystem.com/components/date-picker/usage/)
and [GOV.UK validation guidance](https://design-system.service.gov.uk/patterns/validation/)
informed ordinary schedule inputs and specific batch recovery actions. Existing
main-process validation remains authoritative. Navigation never performs a paid
estimate, test request, or submission on the user's behalf.

The visual direction stays within Wanigan's existing typography, tokens, page
frame, and primitives. The purpose is clearer decisions and continuity of work,
not a new decorative theme.

## Implemented changes

| Surface | Before | Now |
| --- | --- | --- |
| Fleet | A status filter could replace the selected session on the next poll. | The latest full session list owns selection. An out-of-filter session remains open with a clear notice; a session actually removed from the list is not retained. |
| Fleet | A generic finished-turn signal appeared as Done. | It reads Ready to inspect. Explicit stop labels retain their meaning. The active status filter stays visible even when its count reaches zero. |
| Home | Inspect session opened the terminal, despite sounding like a review destination. | Open session names the actual destination and tells the operator to choose Review work there. |
| Insights | An empty local ledger hid the report directory and asserted that nothing had been billed. | All reports remain reachable. The empty state says no activity has been recorded and offers View budgets. Unpriced recorded activity is not treated as absence. |
| Relay | A failed refresh retained old state with enabled stage decisions. | Retained evidence stays readable; stage mutations require a successful refresh. Both handlers and controls enforce this presentation boundary. |
| Batches | Submission blockers were a comma-separated sentence; finding their controls required translating the text into a tab. | Each blocker takes focus to its answer or preflight control. Back/Next provide orientation through the four steps; free tab navigation remains available. |
| Schedules | Changing a preset time required editing cron. | Daily, weekdays, and weekly schedules use Repeat, Time, and Day controls. Custom cron preserves patterns outside that subset. Timezone and main-process upcoming occurrences remain visible. |
| Skills | The catalogue omitted Codex files and offered typing for any selected session. | Both agents' files and roots appear with agent/source filters. Codex offers file reading and Copy name. Claude typing checks the current session, project, stale-read state, and known manual-invocation restriction, and names the destination. Main still makes the final decision. |
| Context | Its broad page description hid the overall coverage limit in a closed guide. | The header states that loading predictions and estimates cover Claude Code; Codex launch order remains unverified. |
| Scout | The main action's online effect was primarily in a tooltip. | Check local inventory and Check official sources online state the difference. Visible copy says which sources are checked and that the weekly watch is unchanged. |
| Extensions | Expanded architectural explanation preceded the library. | The page leads with what a bundle adds, visibly distinguishes Wanigan extensions from Claude Code plugins, and discloses architecture on demand. Install inspection and consent remain at their decision point. |

Skills' catalogue type now lives in `src/shared/skill-catalogue.ts` and types
the existing preload call. The main-process change moves type declarations only;
it changes neither discovery, invocation validation, file access, nor runtime
registration. UI changes stay in the existing registered renderer modules. The
schedule helper recognizes a small subset of cron; it is not a new scheduler.

## What this pass deliberately preserves

The nine other destinations were audited, not ignored. Sessions, Goals, Board,
Changes, Runs, Learning, Usage, Settings, and Plugins keep their current page
structure in this implementation. Their remaining findings are recorded in the
audit documents for a later bounded change.

The prior work already gave Sessions, Goals, Runs, and Relay more room and stable
workspaces. A new universal wizard or another sidebar rearrangement would undo
that continuity without stronger evidence. Usage capacity and Insights spend
also answer different questions; combining them would not resolve their distinct
source and freshness semantics. Required fields, repository scope, spending
limits, and trust decisions remain visible at the relevant action.

This pass does not claim Codex skill invocation or context loading support. It
does not add model assistance, start a live provider, install an extension, or
change the user's schedules. Test actions use isolated fictional bridge records.

## Verification and visual evidence

The baseline renderer was frozen before production edits at
`/private/tmp/wanigan-usability-before-20260919/renderer`. The same fixtures run
against that build and the changed renderer. Screenshots document layout; the
interaction assertions check behavior. Neither substitutes for real usability
testing with an operator.

- [Skills screenshots and checks](../visuals/usability-research-2026-09-19/skills/):
  both agents, search, file reads, stale/error states, typing, writer drafts,
  partial installation receipts, keyboard navigation, and compact layouts.
- [Workflow screenshots and checks](../visuals/workflow-usability-2026-09-19/):
  Fleet live selection, empty reports, stale Relay decisions, and Home copy.
- [Capability screenshots and checks](../visuals/usability-capability-clarity/):
  Context coverage, Scout action arguments, and extension consent.
- [Automation screenshots and checks](../visuals/usability-2026-09-19/automation/README.md):
  ordinary timing, preserved custom cron, incomplete input, batch navigation,
  focused prerequisite recovery, and deliberate preflight execution.

All changed pages have before/after evidence in dark and light themes. Browser
fixtures can use the existing no-WebGPU fallback; that environment limitation is
recorded separately where applicable. These fixtures establish renderer behavior,
not actual provider execution, billing, or persistence.

Final verification used Node 22.23.2:

- `npm test` passed all eight gates: typecheck, 539 shared tests plus six async
  credential scenarios, renderer style, dead code, lint, package hooks, local
  installation checks, and 2,341 offline main-process smoke assertions.
- The first full run exposed one source assertion still expecting Scout's old
  local-action label. That expectation now checks both explicit local/online
  labels; the second complete run passed with zero failures. The behavioral
  probe independently verifies the request arguments and unchanged watch settings.
- The final renderer passes 21 grouped checks across Skills (9), workflow
  inspection (5), automation preparation (4), and capability clarity (3).
  Existing Scout (7) and Schedules (5) probes also pass, bringing the UI
  regression groups to 33. Six new pure tests cover schedule timing and skill
  typing prerequisites; they are included in the shared-suite count above.
- `git diff --check` passed. The renderer index SHA-256 is
  `c826f947f5fb7ba4c5d2a723f9f5baa917d00da33aea4eed69da128eb0059236`;
  the before index is
  `263b6bc2c0142eabca0c30e54eb754155087f3275a5189555a5cf0b450a75263`.

The final source and evidence hashes are listed in
[the verification manifest](2026-09-19-usability-verification.json).

## Remaining empirical question

The next useful evaluation is to ask an operator to schedule a weekly task,
prepare a batch from a dataset, find a Codex skill, and inspect a session while
its status changes. Measure correct first choices, recovery success, retained
work, and task completion. The external research supports these design choices;
only that kind of comparison can establish how much easier they are for Wanigan
users. The online research document contains the proposed task protocol.
