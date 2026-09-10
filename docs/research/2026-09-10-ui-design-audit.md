# Wanigan UI design audit

Wanigan’s strongest organizing idea is a room for supervising agent work. The
companion welcomes the operator, the briefing identifies observed attention,
project spaces hold the work, and the working views provide the detail needed
to act. The approved [concept B](../visuals/mission-room/concept/approved-b.png)
establishes that relationship. It calls for more than decorating the existing
application with a sphere and a glass navigation bar.

The [primary-source research](2026-09-10-desktop-ui-primary-sources.md) supports a
clear separation between expressive content and predictable controls. Its most
relevant 2026 finding is Apple’s emphasis on stronger readability and structure
in its refinements to Liquid Glass. The design direction here is an application
of those principles to an Electron agent workspace, not a claim to reproduce
Apple’s native material implementation.

## Interface diagnosis

The screenshots in [the before collection](../visuals/ui-deep-dive/README.md)
show a partially completed redesign. Mission room and the global shell have a
recognizable visual direction, but the working surfaces still inherit much of
the former interface’s density and hierarchy. Several views spend their first
screen explaining or configuring a workflow before presenting the work itself.
The resulting inconsistency is structural: the application changes character
when the operator leaves its home view.

| Surface | Observed problem | Design consequence |
| --- | --- | --- |
| Mission room | The orb, caption, two temperament choices, and spin control each occupy vertical space. The project shelf continues below the initial viewport in the earlier single-project capture. | The home view reads partly as a simulation demonstration; projects are harder to reach than the companion. |
| Review, previously labeled Control | A large creation form precedes the selected goal. Existing work appears below it. | Returning to inspect work starts in the wrong mode. The list and its selected record lack a clear spatial relationship. |
| Sessions | Attention, session tabs, worktree actions, provider controls, attachments, the composer, and footer each contribute a horizontal band. | The terminal competes with its supporting interface. A future pass should recover working space without losing state or required decisions. |
| Fleet | The name repeats in the area label, local route, and page header. The empty view includes a large explanation of external-session observation. | The hierarchy gives too much emphasis to orientation and setup. Populated rosters require a separate review; an empty screenshot cannot establish their density or stability. |
| Git | Repository actions, review-gate configuration, history, and working changes all compete above or beside the selected code. | The relationship between a file and its diff deserves more emphasis than a permanently open configuration form. |
| Settings | Category navigation is already present, but the first category opens with multiple layers of explanatory material, nested boxes, and a connection form. | Keep the useful index; simplify individual rows and disclose details where they affect a decision. Rebuilding the index alone would not address the problem. |

These observations refer to the captured states, not every possible session or
configuration. The populated Sessions examples in the earlier renderer harness
use explicitly synthetic data. The main-process captures use an isolated local
profile and deliberately seeded records. Neither collection describes activity
in an operator’s installed application.

## A consistent design grammar

The base palette remains charcoal `#171e24`, silver `#f1f5f8`, graphite `#1c2731`,
porcelain `#f4f6f8`, and ice blue `#a6d9f8`. The light theme retains a darker
interactive blue so small controls remain readable. System UI type provides
familiar desktop reading and controls; monospaced type remains reserved for
code, identifiers, or values whose alignment helps inspection.

The signature composition is asymmetrical: a physical character on the left,
a short briefing and conversation field on the right, and a continuous shelf
underneath. Working views use a different arrangement because their task is
different. Review places a narrow list beside a broad record. Sessions and Git
should ultimately place their working content in the center, with optional
supporting regions at the edges. Settings remains an index and a measured
reading column.

This distinction matters. Using the same large rounded rectangle for every
surface would make the application consistent at the expense of making each
task clear. One shared token system can support a room, a terminal workspace,
a roster, a change reader, and a preferences book without turning them into
matching dashboard cards.

The navigation contract remains stable: project spaces narrow the supported
project views; the bottom dock chooses the global area; local routes choose a
view within that area. The existing shell clears the project-space selection
when entering global destinations and returns to Mission room when a project
is chosen from a global destination. Route IDs and keyboard chords remain
unchanged. The visible Control route is now Review, matching its dock label;
“control” remains a command-palette search term.

## Implemented in this pass

### Mission room

The companion’s temperament and spin buttons are now in a compact native
popover opened from the Wanigan control below the sphere. Direct manipulation
of the orb remains available. The control has a visible surface in both themes,
an accessible name, and browser-managed dismissal. CSS anchor positioning
keeps its popover near the trigger and permits a vertical flip when necessary.
This is a concrete use of the browser’s documented top-layer and anchor
features, rather than a dependency on a new animation package.
[Chrome, CSS anchor positioning](https://developer.chrome.com/docs/css-ui/anchor-positioning-api).

The stage uses less vertical space and a slightly tighter display type scale.
Its lighting now protects the briefing’s reading area while leaving more of the
room visible around the sphere. The reading field is part of the scene’s
continuous lighting rather than a separate rounded card. The compact layout uses vertical lighting so its stacked briefing has the
same reading contrast. This composition is independent of the orb shader; it does not claim to improve the water or glass
simulation itself.

The project shelf uses the available width. A single project presents identity,
session information, and its entry action across a horizontal shelf at wide
desktop sizes. Multiple projects use a responsive grid, and compact windows
stack the content. Source status, session provider, branch, attention count,
and navigation targets continue to come from local records. No progress score,
health estimate, or synthetic activity has been added.

### Review

Review now opens on a goal list beside the selected record. The objective and
acceptance criteria appear immediately, followed by task status and the actions
already supported by the application. The goal list can remain visible while
the longer record scrolls; at compact widths it moves above the record. This
is an actual change to the reading order, not only a restyled container.

New goal opens a focused sheet. Draft fields remain in the parent view so
closing and reopening the sheet retains them while Review remains mounted.
The shared dialog implementation handles initial focus, Tab containment,
Escape, and return focus. Main-process validation still governs creation, and
errors appear inside the sheet where they can be corrected. Creating a goal
continues to create a local record; starting an agent is a separate action.

Execution and spending controls are in a labeled disclosure. Its collapsed
summary states whether autopilot is off, halted, or armed; when armed it names
the frozen provider and the goal’s cap. Opening the disclosure reveals the
existing controls and their consent requirements. Record identifiers, event
entry, model outcome details, and longer guidance remain accessible without
occupying the primary reading path.

The implementation preserves goal IDs, deep links, status filtering, recorded
evidence, task actions, and the main-process trust boundary. The redesign does
not infer that a draft or a completed CLI turn is approved work. Proof, task
state, and human decisions remain distinct records.

## What still needs design work

The next coherent implementation should pair Sessions and Git. Both represent
the same project at different moments: one is where an agent works, the other
is where the operator examines changes. Shared project identity, a compact
local toolbar, and explicit return paths would make that transition clearer.
The acceptance condition is usable terminal/diff space with selection, drafts,
scroll position, and mounted PTYs preserved. Merely changing border radii would
not meet it.

Fleet needs a populated comparison study before a roster redesign. A stable
order, measured usage, unsupported telemetry, attention changes during pointer
interaction, and long project names are important cases. Settings then needs a
row-by-row content pass: the current category index can remain, while repeated
instructions and nested surfaces are simplified. Exact trust, credential, and
destructive-action details must remain available at the relevant decision.

The companion also remains below the approved visual target in glass and water
appearance. Its live physics, gaze, fire, and spin are implemented, but the
current rendering has a visibly tinted shell and a less refined fluid surface
than the concept. This UI pass leaves the solver and optical pipeline intact.
Their remaining work is documented separately in the orb research reports.

A later material-accessibility pass should connect OS reduced-transparency and
contrast signals through a typed main/preload API, then test the resulting
opaque alternatives. The current research identifies that capability; this
pass does not implement it or claim complete accessibility conformance.

## Verification evidence

[Before/after screenshots and verification notes](../visuals/ui-deep-dive/README.md)
record the affected views in both themes, the creation sheet, companion
controls, and narrower desktop captures. The real-main harness verifies
selection layout, dialog focus, draft retention, creation validation and
success, and that creating a goal launches no agent. It also checks the
companion’s gaze, globe spin, temperament persistence, and native visibility
pause through the actual preload bridge.

The research and implementation have separate boundaries: the source report
contains recommendations for the full application, while this pass changes
Mission room and Review, plus the visible links that name Review elsewhere.
It does not represent a completed redesign of every view, a production install,
or a benchmark of normal application startup. The isolated automation harness
uses its documented bootstrap to attach Playwright before loading the real main
process.
