# Desktop workspaces — September 10, 2026

An interactive design study and the first production pass for extending the
approved Mission Room B direction through the working app. The concept remains
a preview; the Sessions and Changes layouts described below are now in renderer
source and were installed with the companion fixes. The next production pass
for Fleet, Usage, and Insights is documented in [fleet-ledgers](../fleet-ledgers/README.md).

## First production pass

Sessions now uses the shared page heading for the selected conversation, with
the project/provider identity and direct actions beside it. The existing list
selects conversations; the duplicate desktop tab strip is removed. Exited
sessions keep a named Close session action. Model, effort, and worktree controls
sit in a disclosure, with elevated trust always visible outside it. Attachment
guidance starts folded and respects an existing saved choice. All terminal hosts
stay mounted while selecting conversations or opening the controls.

Changes now gives the selected diff its own large reader. The repository browser
on the left switches between files, history, branches, and stashes. Review gate
configuration folds independently and retains its draft while opening/closing.
The existing repository actions and confirmations remain available. Project
switches still clear repository-specific drafts and refuse actions when the new
repository cannot be read; same-project navigation retains the commit draft.

[`before/`](before) and [`after/`](after) contain the actual Electron renderer in
both themes with deterministic sample records, distinct from the HTML concept.
`scripts/probe-desktop-workspaces.mjs` captures them and exercises session
selection, terminal mounting, command routing, commit drafts, file/history
selection, gate disclosure, push confirmation, project read failures, and the
narrow desktop session switcher. These are renderer fixtures, not a claim that
an actual provider was launched or a user's repository was changed during QA.

## Explore

`concept/wanigan-desktop.html` is the inline preview. Its four destinations show
Sessions, Changes, Fleet, and Settings. Switch appearance with the chrome's
appearance button or the Appearance preference. Select sessions, files, crew
members, and preference categories; open the companion briefing and activity
rail. Session drafts and preview staging survive navigation within the preview.

All transcripts, events, costs, provider availability, and project/session
records are illustrative fixtures. No process launches, model calls, repository
writes, or production preference changes occur. The companion uses an unmodified
frame from the existing water renderer, displayed at miniature size; it is not
a proposed replacement character or a new physics implementation.

The four-item dock is an exploration switcher for the four studies. Production
keeps the established destination groups, all 17 routes, and their keyboard
shortcuts. This study does not authorize dropping other destinations.

## The common design

- Keep one stable frame: project identity above, working content in the middle,
  destination navigation and companion below.
- Use charcoal and silver surfaces, ice accents, system typography, and a small
  amount of glass on navigation. Code and text use opaque working surfaces.
- Give each screen an appropriate arrangement. A terminal needs room; a diff
  needs a file list; agents need comparable rows; preferences need direct controls.
- Put supporting evidence beside the selected work. Avoid repeating the same
  area name in several headings or stacking permanent instructions above it.
- Reserve personality for the companion, carefully written status text, and
  restrained transitions. Status always has readable text alongside color.

This continues the [approved specification](../../superpowers/specs/2026-09-09-mission-room-design.md)
and the [existing UI audit](../../research/2026-09-10-ui-design-audit.md).

## Complete app coverage

| Area | Routes | Implementation status |
| --- | --- | --- |
| Shared frame | All routes | Implemented: shared materials, contextual navigation, a [searchable space switcher](../space-switcher/README.md), consistent focus and motion preferences, and the persistent companion. |
| Mission room | `mission` | The accepted character has a [personality pass](../orb-personality/README.md): playful wink, listening tilt, attention double-take, completion nod, and a warmer reply style. The Mission room anchors the shared desktop direction, with scoped conversation and operational evidence; [signature interactions](../orb-signatures/README.md) connect the companion to session events. |
| Project work | `sessions`, `git`, `board`, `context` | First production passes implemented. [Board](../board-workspace/README.md) has six task lanes, search and filters, and a task sheet. [Context](../context-workspace/README.md) has seven navigable areas, file lists, and a dedicated source reader. |
| Fleet | `fleet`, `usage`, `insights` | First production pass implemented: session roster/inspector, account-based Usage, and four Insights reports. See [evidence](../fleet-ledgers/README.md). |
| Review | `control` | First production pass implemented: searchable goals, a selectable task journey, focused decisions, and goal-wide evidence. See [Review](../review-workspace/README.md). |
| Knowledge | `learning`, `skills`, `scout`, `plugins` | First production passes implemented for [Learning](../learning-workspace/README.md), [Skills](../skills-workspace/README.md), and [Scout](../scout-workspace/README.md): focused libraries and readers, proposal review, briefing previews, and a local skill writer with explicit installation receipts. Scout separates proposals and evidence from source consent and scheduling. [Plugins](../desktop-remainder/README.md) now has Installed, Catalog, and Marketplaces areas with a focused inspector, source-bearing installation consent, and clear settings/CLI provenance. |
| Automation | `runs`, `batches`, `schedules` | Implemented: [Runs](../runs-workspace/README.md) has history and repository evidence, [Schedules](../schedules-workspace/README.md) has a searchable agenda and editor, and [Batches](../desktop-remainder/README.md) has a work queue, step-based preparation, results, and comparison tools. Status, scope, and cost retain their recorded meanings. |
| Preferences | `settings` | First production pass implemented across seven categories: searchable directory, continuous preferences surface, visual appearance choices, contextual disclosures, and reduced-motion-aware transitions. See [evidence](../settings-workspace/README.md). |

## Implementation sequence

1. Shared frame plus Sessions and Changes as one complete working flow.
2. Fleet, Usage, and Insights; then the remaining project work surfaces.
3. Knowledge, Automation, and Preferences using the same materials and controls.
4. Full desktop sweep: empty/loading/error/permission states, dialogs, keyboard
   focus, text contrast, reduced motion, and both themes. Responsive device work
   follows the desktop pass, as requested.

The prototype omits many operational controls to make the hierarchy reviewable.
Implementation must relocate those controls, not delete their functionality.
Preserve mounted PTYs across navigation; project/request identity when actions
resolve; per-project drafts and scroll position; trust and confirmation
boundaries; typed preload APIs; and recorded evidence as the source of truth.

## Verification

Production: [`after/verification.json`](after/verification.json) records the
Electron fixture checks for terminal mounting, selected-session command routing,
file/history selection, commit and review-gate drafts, push confirmation, failed
project switches, and the narrow desktop session picker. No renderer errors were
recorded. Screenshots cover both themes at 1440 × 1000 and the narrower layout at
820 × 960. In the same desktop fixture, terminal height increased from 350 to
423 CSS pixels. The required `npm test` passed all five stages, including 1509
offline smoke assertions; `git diff --check` passed. The probe routes commands
to a recording fixture; it does not launch a real agent or perform Git writes.

`concept/verification.json` records the isolated Chromium checks. The adjacent
screenshots show all four studies in both themes. This evidence covers only
the preview's local layout and interactions, not production IPC, terminals,
provider support, or persistence after an application restart.

Verified 32 combinations of view, appearance, and preview width (320–1024 CSS
pixels), with no horizontal overflow or JavaScript errors. Checked navigation,
draft retention, activity visibility, file selection, staging previews,
Fleet-to-session links, briefing actions, preference categories, appearance,
companion visibility, and sample session/message actions. All form controls have
accessible names, and all element IDs are unique. The required `npm test` run
also passed, including 1509 offline smoke assertions; `git diff --check` passed.

Earlier production references remain in
[`mission-room/after`](../mission-room/after) and
[`ui-deep-dive/after`](../ui-deep-dive/after). The four-screen concept and its
verification remain separate from this directory's production screenshots.

The remaining desktop route pass is recorded in [Plugins and Batches](../desktop-remainder/README.md). The combined verification reruns the existing workspace probes across the prior pages as well as the new layouts. Phone and tablet redesign remains a separate pass.

## Connected desktop journey

The [September 11 journey polish](../desktop-journey/README.md) connects goal
planning, sessions, attention, review, and acceptance across these workspaces.
It adds exact session-to-task return links, contextual companion guidance, and
a recorded completion state, with before/after captures in both themes.
