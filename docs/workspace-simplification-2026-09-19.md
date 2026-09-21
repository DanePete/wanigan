# Workspace simplification — 19 September 2026

Wanigan's depth has outgrown its navigation. The source audit found 19
destinations spread across seven groups, several nested directories, and names
that ask the operator to understand how a feature was built before finding it.
The first change should make the existing work easier to find and give it more
room. Combining navigation does not require combining execution, evidence, or
consent.

This is a local code audit and implementation rationale. It does not claim
measured usability gains or results from user testing.

The findings describe the starting UI. Its screenshot baseline was rebuilt
from commit `fe967c4`, which only extracts the existing navigation lifecycle
without changing behavior. The updated UI is captured separately using the
same fictional records.

## What makes the current workspace hard to learn

| Finding | Source evidence | Consequence |
| --- | --- | --- |
| The desktop sidebar cannot be hidden. | `SpaceNavigation.tsx`, `WorkspaceNavigation`, renders the desktop aside regardless of `open`; `App.tsx` treats the sidebar button as a focus action outside compact mode. | Sessions and other dense views permanently lose horizontal room. |
| Every group's local destinations are visible together. | `SpaceNavigation.tsx`, `NavigationContents`, maps every area's `tabs`. | The operator scans an application inventory on every visit. The same file records an earlier discovery failure when inactive routes were completely hidden, so folding groups needs an obvious way to reveal and search them. |
| One workflow is split across Projects and Review. | `Board.tsx` reads goal tasks and opens the same goals as `Control.tsx`; `Relay.tsx` opens its goal in Review. `view-registry.ts` puts Board and Relay in Projects and Control alone in Review. | A task's planning, execution, and acceptance look like separate products. |
| Review names both a whole feature and a decision within it. | `Control.tsx` owns goal creation, task journeys, dispatch, evidence, and final acceptance; its page title is Review. `SessionReview.tsx` and `Git.tsx` also expose review. | A user looking for goals has to learn an indirect name, while a user looking for a session diff has several plausible doors. |
| Sessions can display three adjacent navigation or inspection columns. | The shell sidebar, `Sessions.tsx` session picker, and its Code/Timeline/Learning reader each take space. `CodePanel` is also reused in `SessionReview.tsx` and `SessionHistory.tsx`. | Hiding global navigation provides immediate room; a later inspector consolidation needs care to preserve terminal state and distinct checkout scopes. |
| Usage and Insights answer adjacent questions. | `Usage.tsx` shows account capacity and recorded consumption. `Insights.tsx` adds spending, tokens and pace, budgets, and batch reports. | A common Monitor family helps discovery without implying provider limits and local token counts measure the same thing. |
| Context has two meanings. | `Context.tsx` reads project instruction, memory, and configuration files. Learning's Context section in `Learning.tsx` contains briefings, costs, and controls. | The same label points to different objects; the Learning section is renamed Context budget. |
| Knowledge contains three kinds of work. | The original group contains Learning, Skills, Scout, Extensions, and Plugins. | Remembering knowledge, discovering improvements, and installing integrations compete for attention. Installation belongs beside administration. |
| Settings already offers a useful directory, but the palette also exposes every detail immediately. | `Settings.tsx`, `SETTINGS_INDEX`, declares 30 sections in seven categories. `App.tsx` adds these and appearance actions to the command palette. | Opening search becomes another long inventory. Detailed settings should appear when queried or explicitly recalled through Recent. |
| Palette search expects one contiguous phrase. | `palette.ts`, `filterPalette`, uses one substring over title, hint, and keywords. | A query such as “backup restore” can miss an item whose title is Restore a backup. Search should match all words in any order and favor a matching title. |

Paths in this table are under `src/renderer/src/` except `view-registry.ts`
and `palette.ts`, which are under `src/shared/`.

## Decision: six navigation families

Keep existing route identities and keyboard shortcuts, while organizing the
destinations around the operator's work:

| Family | Destinations | Question it answers |
| --- | --- | --- |
| Home | Home | Where should I begin? |
| Work | Sessions, Board, Goals, Relay, Changes | What am I doing, and what happens next? |
| Monitor | Fleet, Usage, Insights | What is running, what needs me, and what did it consume? |
| Knowledge | Learning, Skills, Context, Scout | What do agents know, and what could improve? |
| Automation | Runs, Schedules, Batches | What work runs without an interactive terminal? |
| Manage | Settings, Extensions, Plugins | How is this workspace configured and extended? |

Goals is the visible name for the existing `control` route. Its final Review
task remains a review decision. Legacy route identities and search aliases
continue to work.

The Goals heading and routes into it now use the same name in Board, Relay,
Scout, and Settings. Renderer instructions for the review gate point to
Changes. Learning's Context budget tab and its internal links use the more
specific name while retaining both the `context` ID and the older `optimize`
deep link. These are presentation changes; they do not alter review decisions,
retrieval policy, or any spending control.

The sidebar can fold away on desktop and return through an always-available
button and keyboard command. Its preference is separate from the temporary
compact-screen drawer. Groups can expand to reveal their contents; a selected
destination remains findable, and the palette still searches every route.
Regrouping must not infer that all members share a project filter: each route
keeps its declared project scope.
Opening a project also rejects a remembered workspace-wide destination:
returning to Work can restore Goals, while selecting a project from search
opens Sessions if the remembered view cannot use that project filter.

A grouped view picker in the header keeps every destination reachable while
the sidebar is hidden. Waiting-session alerts move to the header in that mode.
The compact drawer omits desktop descriptions and its companion footer so its
space goes to destinations; expanded groups still scroll when needed.

Session review now offers Changes and Checks & evidence in the same workspace,
with one checkout identity and the full panel width for either reading. Both
panels remain mounted when switching, preserving selected files, unsaved check
commands, and reads of running checks. Switching sections never runs or saves
a command.

Search without a query emphasizes commands, destinations, and recent work.
Settings details and appearance choices remain searchable. A saved Recent
entry stays visible even when its original row is normally search-only.
Multiword queries match all tokens across the title, description, and search
aliases. Exact titles and title prefixes rank first, with stable ordering for
ties. Transcript hits retain the archive index's matching decision and order;
they never appear as results for an empty query.

## Boundaries that consolidation preserves

- **Checkout identity:** session review uses the session checkout, including an
  isolated worktree. Repository Changes uses the selected repository. Their
  command results cannot be silently substituted for one another.
- **Acceptance:** successful commands are evidence, not proof that a goal's
  full contract was satisfied. The operator's goal decision remains distinct.
- **Installation ownership:** Wanigan extensions and Claude Code plugins have
  different installers, owners, and consent contracts. Sharing Manage does
  not merge their trust decisions.
- **Meter provenance:** provider quota readings, recorded consumption, local
  pricing estimates, and actual spend keep their labels and source limits.
- **Execution:** interactive sessions, headless runs, scheduled work, and batch
  API submissions retain their explicit launch and spending decisions.
- **Live terminals:** navigation changes do not promise a PTY can survive a
  full application quit or update. Saved sessions and live processes are
  different things.

## Follow-on opportunities

A coherent session inspector could bring changes, checks, activity, and
launch context together while keeping the terminal mounted. Accounts and
reporting could share one directory with Capacity, Activity, Costs, and
Budgets. Automation could offer one explicit creation chooser that routes to
the existing launch flows. Attention could consistently lead from a status
to the exact session or task needing a decision.

These are candidates for subsequent work, not claims that their underlying
surfaces have been merged. Under `AGENTS.md`, work on an unconverted feature
requires a behavior-preserving module conversion first, followed by the
behavior change in a separate commit. The existing shared view registry is
the navigation seam; it is not permission to couple feature IPC or trust
logic inside the shell. This simplification is not an emergency fix and does
not use the urgent-fix exception.

## Verification

Verified under Node 22.23.2:

- `npm run build` passed.
- All eight `npm test` stages passed, including 532 shared tests, the six
  asynchronous credential scenarios, packaging and installer fixtures, and
  2,341 offline main-process smoke assertions.
- `git diff --check` passed.
- The updated existing navigation probe passed its five regression groups.
- The new renderer probe passed ten groups covering visibility persistence,
  compact navigation, focus, search, project scope, terminal and review draft
  preservation, 720-pixel header geometry, and preference-save failure recovery.

[Visual evidence](visuals/workspace-simplification-2026-09-19/README.md) includes
26 before and 42 after screenshots in both themes, plus eight captures from
the existing navigation regression probe. The isolated renderer fixtures
reported no page errors. Hiding navigation increased the fixture terminal's
width from 984 to 1192 pixels at a 1440-pixel viewport; this is a layout
measurement, not a productivity claim. Real IPC and main-process behavior
are covered by the separate offline suite.
