# Wanigan’s desktop interface

## Direction

Wanigan should feel like a considered place to supervise work: a companion and
briefing at the entrance, a broad quiet surface when working, and evidence close
to every consequential decision. Its identity can be unusually expressive
without requiring every control, list, and document to perform a visual effect.
The orb is the signature object; the rest of the interface should make its
presence feel intentional.

The most useful 2026 finding is that Apple is refining hierarchy, readability,
adaptability, and agency alongside material effects. This is a stronger direction
for Wanigan than treating a modern appearance as a collection of translucent
rectangles. Apple's June 2026 design principles connect purpose to the user's
actual goal, simplicity to reducing friction, and delight to a deliberately
chosen feeling. The proposed feeling for Wanigan is **companionship and calm
control**. That last phrase is our design judgment, not Apple's prescription.
[Apple, Principles of great design, WWDC26](https://developer.apple.com/videos/play/wwdc2026/250/).

The design requires a stronger organizing idea across the whole application.
Different working arrangements suit sessions,
fleet supervision, evidence review, changes, and preferences. Shared material,
type, spacing, and interaction conventions should connect those arrangements;
one repeated card grid should not replace their distinct jobs.

## What is actually new in 2026

Apple's WWDC26 platform presentation describes refinements for the **27 releases**:
stronger diffusion behind Liquid Glass, a darker edge and brighter specular
highlights, and a setting that ranges from clear to tinted. It also describes
edge-to-edge sidebars on Mac and iPad, accent-colored sidebar icons, more
consistent window corners, and a unified toolbar surface when content scrolls
under floating controls. macOS 27 gains the `show borders` environment value for
custom controls. These are verified announcements, not claims about an installed
Mac's OS or a final shipping date.
[Apple, Platforms State of the Union, WWDC26](https://developer.apple.com/videos/play/wwdc2026/102/).

Liquid Glass itself is a **2025 foundation**, not a new 2026 invention. Apple's
current materials guidance distinguishes a navigation/control layer from a
content layer. It recommends using glass sparingly and keeping ordinary content
on standard materials. The regular variant modifies the background to aid
legibility; clear glass is intended for media-rich backdrops. The page's visible
change log dates its Liquid Glass guidance to June and September 2025.
[Apple HIG, Materials](https://developer.apple.com/design/human-interface-guidelines/materials).

Apple published iOS, iPadOS, and macOS 27 design kits on June 23, 2026. That is a
useful current component reference, but the existence of a design kit does not
mean its native rendering or behavior is present in Wanigan's custom renderer.
[Apple Developer, Design kits announcement](https://developer.apple.com/news/?id=e2lxw9l1).

Apple's current HIG reintroduced a dedicated design-principles page on June 8,
2026. Its emphasis on agency and direct access is especially pertinent to an
agent control surface: the companion should help users understand and reach
their work while keeping navigation and decisions under their control.
[Apple HIG, Design principles](https://developer.apple.com/design/human-interface-guidelines/design-principles).

## Material and visual hierarchy

**Recommendation for Wanigan:** establish three materials with different jobs.
The window chrome and dock use restrained translucent material; working content
uses quiet opaque or nearly opaque surfaces; the Mission room and orb carry
environmental lighting, depth, and expressive motion. These are Wanigan design
roles, not a proposal to mimic native Liquid Glass with an identical shader.

The current source already contains the beginnings of this separation in
[`mission.css`](../../src/renderer/src/styles/mission.css). However, similar
capsule treatments appear on project navigation, local routes, the dock, the
composer, and companion controls. Each object can be attractive alone while
their repetition weakens the hierarchy. Reduce the weight of supporting controls
and let the selected project, active work, and conversation have recognizably
different shapes and positions.

The light theme needs its own lighting composition. Preserve the studio image's
depth near the sphere, but give briefing text a dependable graphite-on-porcelain
reading field. A localized gradient or soft opaque backing can keep the room
visible without whitening the whole scene. A material should not require the
reader to guess where the text will remain legible as the background changes.

For normal text, WCAG 2.2's minimum contrast criterion uses 4.5:1, with 3:1 for
qualifying large text. A screenshot-based check should include the actual
composited background rather than only two declared token values. This is a
verification recommendation, not a claim that the current UI passes WCAG.
[W3C, Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).

Use a simple visual grammar: a surface separates major work regions; a fine
divider separates related rows; whitespace groups information; one clear accent
identifies selection and useful actions. Status still needs text or shape.
Avoid giving every metric a separate box. A dense table can be appropriate for
comparison, while an individual decision deserves a readable evidence surface.

## Navigation should explain scope

The approved design has three distinct questions to answer:

| Navigation level | Question it answers | Recommended treatment |
| --- | --- | --- |
| Project spaces | Which repositories does this view concern? | A compact scope control in the top chrome, with persistent selection and a clear all-projects option. |
| Global destinations | What kind of work am I doing? | The stable bottom dock, with readable destination names and predictable positions. |
| Local routes and tools | What part of the selected area am I using? | A shallow local toolbar or route row, visually subordinate to the active content. |

The first two rows should remain visually distinct. Selecting a project changes
scope; selecting Sessions changes destination. A global Fleet or Settings view
must say when it is not narrowed by the selected project. Repeating the selected
project in several large headers does not clarify scope as effectively as one
consistent scope location and a concise exception where necessary.

Apple's toolbar guidance separates navigation, title, and actions; recommends
logical grouping by function and frequency; and discourages overcrowding. Its
leading, center, and trailing groupings put persistent orientation and critical
actions in predictable locations. The recommendations are current, but the
page's latest visible change-log entry is December 16, 2025.
[Apple HIG, Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars?changes=la).

Apple's Mac guidance explicitly values keyboard shortcuts, menu-bar access,
resizable windows, personalization, and sufficient information density for large
displays. A desktop redesign therefore needs to protect operational space, not
only look appealing in a wide hero screenshot.
[Apple HIG, Designing for macOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos/).

**Recommendation:** retain Wanigan's route IDs and shortcuts, keep every
destination discoverable through the existing drawer and command palette, and
make the main path shorter through consistent project scope. Avoid replacing
the broad route inventory with an unexplained icon-only rail. When a window
narrows, preserve the active workspace and primary action before secondary
labels, extra metrics, and supplementary inspectors.

The current HIG advises adapting continuously across window sizes and, for
complex split layouts, hiding tertiary columns before abandoning the full
layout. Its specific discussion here is under iPadOS; applying the priority
ordering to Wanigan is an inference, not a quoted macOS requirement.
[Apple HIG, Layout](https://developer.apple.com/design/human-interface-guidelines/layout?changes=la).

## What professional workspaces demonstrate

Linear's March 12, 2026 refresh addresses accumulated interface inconsistency.
Its designers reduced navigation prominence, made desktop tabs more compact,
removed excess icon treatments, softened redundant borders, and standardized
header organization. Its useful lesson is allocation of attention, not a reason
to copy Linear's issue-tracker layout or palette into Wanigan.
[Linear, A calmer interface for a product in motion](https://linear.app/now/behind-the-latest-design-refresh).

Logic Pro's current guide places the project at the center and surrounds it with
areas the user can show or hide. The inspector changes with the selection, while
the control bar holds frequent commands and visibility controls. The examined
guide exposes version 12.3; these workspace patterns are longstanding, not
evidence of a new 2026 invention.
[Apple, Logic Pro main window](https://support.apple.com/guide/logicpro/main-window-interface-lgcpe9cc403a/mac).

Figma's documentation describes separate navigation, canvas tools, and properties
areas. The properties panel changes according to both selection and permissions.
That is a valuable model for review: place the selected evidence and its valid
actions together, with the available operations reflecting actual authority.
This is a current documented pattern; no introduction date is inferred.
[Figma, Properties panel](https://help.figma.com/hc/en-us/articles/360039832014-Design-prototype-and-explore-layer-properties-in-the-right-sidebar).

VS Code documents an optional secondary sidebar, visible layout controls,
keyboard/menu access to hidden regions, persisted panel placement, and a reset
command. The transferable lesson is recoverable personalization: a focused
layout must remain easy to leave or restore. Wanigan does not need arbitrary
panel rearrangement to gain that benefit.
[VS Code, Custom layout](https://code.visualstudio.com/docs/configure/custom-layout).

Apple's split-view guidance reinforces persistent selection, adjacent levels of
information, reasonable pane sizes, and multiple discoverable ways to reopen
hidden panes. This supports a list-and-reader arrangement for evidence, while
keeping the terminal's own interaction model intact.
[Apple HIG, Split views](https://developer.apple.com/design/human-interface-guidelines/split-views?changes=_6).

## Distinct recommendations by surface

These are design proposals based on Wanigan's domain and the references above.
They are not descriptions of capabilities in the external products.

### Mission room: arrival, orientation, conversation

Keep the horizontal relationship between the orb and a concise observed
briefing. The globe is an inhabitant of the room, not an illustration at the
top of a generic dashboard. Let the conversation field remain close to the
briefing so asking a question feels like continuing that exchange.

Move temperament and spin into a compact companion disclosure. Leave the orb
itself directly interactive and provide accessible explicit controls in that
disclosure. The design should not require a permanent row of simulation
demonstration controls beneath the character. Keep a discoverable motion
preference; compacting the controls must not remove the user's ability to stop
decorative movement.

Make the project shelf useful at first glance. A single project should occupy
purposeful space instead of appearing as a one-third-width orphan. Several
projects should share a continuous shelf with project identity, branch, relevant
observed attention, and direct entry. Do not imply a health score or progress
estimate where the database contains only lifecycle or attention facts. If
there is nothing to report, give the user a calm truthful next step.

### Sessions: a working instrument

The session surface should open with the selected project and session already
established. Give the terminal most of the window, with a compact session list
or strip and a stable header. Put provider, branch, and lifecycle in a concise
identity region; place relevant controls together instead of scattering them
over stacked full-width bars.

Separate **changing the session's configuration** from **seeing its current
configuration**. Routine reading can use a compact summary, while editable
controls appear in an explicit panel. Trust or recovery conditions that affect
safe operation must remain apparent; collapsing detail must never conceal a
required decision.

An optional adjacent inspector can hold the selected session's operational
evidence, attachments, or related project context. It should not become an
always-open transcript duplicate. On narrow windows, close that supplementary
region before shrinking terminal text or making the main workspace unusable.
Preserve xterm selection, keyboard focus, scroll state, and mounted live PTYs.
The orb's material language can survive in the chrome without animating near
the terminal or inserting a second large hero.

### Review: a decision desk

Use a selected-item list beside a larger reader. The list answers what needs
review; the reader answers what happened, what evidence supports it, and what
the user can do next. Keep the selected goal and its concrete actions in the
same place as polling refreshes the surrounding data.

Creation is a separate, deliberate flow, well suited to a sheet opened from a
clear action. It should not occupy the default reading surface with a long
form. Secondary operational details can use disclosure, but the claim,
provenance, uncertainty, scope, and consequence of the current decision belong
in the primary reading flow. Empty and unsupported states need concise,
specific language rather than decorative placeholders.

### Fleet: supervision and comparison

Fleet should be the broadest view of concurrent work. Favor a legible roster
with a common set of comparable columns, supported by a compact strip of
observed aggregate counts. Distinguish attention, lifecycle, provider, project,
and measured usage instead of presenting them as equally weighted badges.

Group work that requires the operator separately, then provide access to the
rest. Preserve a stable row order while someone is reading or targeting an
action; live changes can update fields without constantly relocating controls.
Clicking a session should have a predictable direct path to its real workspace.
An expandable detail region can explain a measurement or status without
turning every roster entry into a tall dashboard card.

Retain the distinction between measured, unpriced, estimated, and unavailable
usage. A row of matching spark lines would be visually tidy but misleading if
some providers have no verified telemetry. A neutral unsupported cell is a
designed state, not a hole to fill with animation.

### Git: a change reader

Use the repository and branch as a compact context header, then emphasize the
relationship between the change list and the selected diff. Keep staging,
commit composition, and remote operations in coherent, distinct action groups.
Make the exact target of an operation visible beside that operation.

Maintain monospaced diff alignment and give code a steady high-contrast surface
in both themes. Extra metadata belongs near the selection or in an inspector;
it should not consume repeated bands above the diff. Favor the actual selected
file path and state over generic marketing copy. A commit composer can be a
focused region of the workspace, but it must preserve drafts and the existing
guardrails on destructive or external operations.

### Settings: a readable preferences book

Use a stable category index with a single readable content column. Rows should
pair a clear preference name and short explanation with a control aligned
consistently. Group related rows on quiet surfaces instead of giving each
setting a hero card. Let appearance previews show actual light/dark materials
and motion choices at a useful size.

Separate routine preferences from connection setup, trust review, diagnostics,
and destructive maintenance. Their interaction costs and consequences differ.
Keep the exact manifest or adapter consent details in their review flow, even
if the index and surrounding explanations become much shorter. Search should
lead to the relevant category and visible setting, with focus and context
preserved. A saved setting needs a local acknowledgement, not a large global
celebration.

## Motion and personality

Apple's current motion guidance says system motion varies by input modality:
Liquid Glass responds more strongly to direct touch and more subtly to a
trackpad. This suggests restrained desktop hover/press feedback rather than
applying a large elastic touch effect to every mouse interaction.
[Apple HIG, Motion](https://developer.apple.com/design/human-interface-guidelines/motion?changes=_3).

The WWDC26 brand session places distinctive identity primarily in content while
familiar navigation remains easy to understand. It also advocates purposeful
color and typography. This session is explicitly about **iOS**; using its
content-versus-navigation distinction to guide a Mac app is a design inference.
For Wanigan, the orb, atmosphere, briefing, and project shelf are the strong
identity opportunities. The toolbar and evidence reader can be quieter.
[Apple, Communicate your brand identity, WWDC26](https://developer.apple.com/videos/play/wwdc2026/251/).

Recommended motion vocabulary:

| Trigger | Response | Meaning and boundary |
| --- | --- | --- |
| Direct press | Small immediate press feedback | The control received input; it says nothing about success. |
| Selected row changes | Immediate selected state; restrained adjacent-reader transition | The detail belongs to this item. Preserve the user's target and focus. |
| A new observed event arrives | One short emphasis near that event | A recorded state changed. Avoid continuous pulses implying ongoing work. |
| Companion receives a question | Intentional gaze and bounded expression | The user addressed the companion. Request status remains separate text. |
| Companion answer is recorded | Brief acknowledgement | A real response arrived; source links remain authoritative. |
| User spins or stirs the orb | Physical response followed by settling | An explicitly decorative interaction, independent of agent execution. |
| Motion is disabled | Immediate final UI states and frozen decoration | No delayed access, essential information loss, or forced animation. |

Apple warns against changing focus without the user's interaction. A new
notification, reply, or evidence refresh should therefore not steal the cursor
from a terminal, draft, or review action. A companion can look toward an event
without forcing the user's focus there.
[Apple HIG, Focus and selection](https://developer.apple.com/design/human-interface-guidelines/focus-and-selection/).

W3C's Pause, Stop, Hide criterion addresses automatically moving content that
continues beyond five seconds alongside other content, as well as automatic
updates. A pause mechanism must leave the rest of the interface usable. The
existing explicit motion preference is an important foundation; verify that it
stops every decorative subsystem and remains easy to find.
[W3C, Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html).

### Platform and animation-library choice

Wanigan currently declares Electron 44 and React 19 in
[`package.json`](../../package.json), and already centralizes CSS motion in
[`motion.css`](../../src/renderer/src/styles/motion.css). The immediate visual
pass does not require another animation package.

| Option | Verified capability | Recommendation for Wanigan |
| --- | --- | --- |
| Existing CSS plus browser view transitions | Chromium documents DOM-update snapshots, named elements, CSS-controlled transitions, and interruption of the previous transition when a new one begins. [Chrome documentation](https://developer.chrome.com/docs/web-platform/view-transitions/same-document). | Keep for restrained route/disclosure feedback. Preserve the existing exclusion around live terminal transitions and handle interruption without treating it as an application failure. |
| Motion for React | Current documentation supports transform-based layout animation, shared layout IDs, springs, and gestures. [Motion React documentation](https://motion.dev/docs/react). | Consider only when a concrete UI needs interruptible coordinated movement, such as an interactive panel or selected-control indicator. It is optional; it does not simulate the orb's fluid. |
| Motion reduced-motion APIs | `MotionConfig` and `useReducedMotion` expose preference-based adaptation. [Motion accessibility guide](https://motion.dev/docs/react-accessibility). | If adopted, connect them to Wanigan's existing application preference. Do not create a competing second motion setting. |
| New Motion view/layout wrappers | The inspected `AnimateView` page labels it Motion+ Early Access; the JavaScript `animateLayout` page labels it alpha/early access. [AnimateView](https://motion.dev/docs/react-animate-view), [animateLayout](https://motion.dev/docs/layout-animations). | Do not make the redesign depend on these simply because they look new. Recheck status and dependencies before any later adoption. |
| Electron native theme signals | Main-process `nativeTheme` exposes reduced-transparency, high-contrast, and macOS differentiation-without-color preferences. [Electron nativeTheme](https://www.electronjs.org/docs/latest/api/native-theme). | A future small typed bridge can drive stronger opaque materials and status alternatives. Check the pinned Electron API before implementation; CSS glass does not acquire native accessibility behavior automatically. |

These are current capability checks, not performance benchmarks or assertions
that the libraries were introduced in 2026. The orb's WebGPU simulation remains
a separate rendering system with its own bounds and visibility lifecycle.

## Recommended rollout and acceptance

**First: establish the room and the decision desk.** Compact companion controls,
make the project shelf useful for one or many projects, strengthen light-theme
reading, and implement the list-and-reader review arrangement. This produces a
visible structural advance while preserving the approved character and room.

**Second: connect the working surfaces.** Refine Sessions and Git together so
moving from a live session to its changes preserves project identity, useful
space, and a consistent local toolbar. Verify real focus, selections, draft
retention, terminal mounting, and direct return paths before adding motion.

**Third: make supervision scale.** Redesign Fleet around a stable roster and
selected detail, then align measured usage presentations across the relevant
surfaces. Test zero, one, and many projects; active, completed, and unsupported
sessions; long names; and live changes during selection.

**Fourth: simplify setup and maintenance.** Rework Settings as a category index
and preference rows, retaining exact trust disclosures and operational detail
where a decision requires them. Use reusable primitives so these refinements
also benefit the remaining knowledge and automation views.

For every stage, compare populated before/after screenshots in both themes and
at narrow desktop widths. Verify keyboard reachability, persistent selection,
readable status without color alone, motion off, reduced transparency where
wired, and controls that remain reachable as content grows. Run the repository's
required full tests and `git diff --check`. A successful screenshot is evidence
of visual layout in that state, not proof of a complete workflow or accessibility
conformance.

The design is successful when the user can answer three things without hunting:
what needs attention, which project/session a view concerns, and what will happen
when they act. The expressive companion should make that experience feel more
personal while the underlying work remains concrete and reviewable.

## Sources

Primary-source pages consulted September 10, 2026. WWDC26 references describe
2026 announcements; other pages are current documentation unless a date is
stated in the discussion. No release date or performance result is inferred
from a documentation page.

1. [Apple, Principles of great design, WWDC26](https://developer.apple.com/videos/play/wwdc2026/250/).
2. [Apple, Platforms State of the Union, WWDC26](https://developer.apple.com/videos/play/wwdc2026/102/).
3. [Apple HIG, Materials](https://developer.apple.com/design/human-interface-guidelines/materials).
4. [Apple Developer, Design kits announcement](https://developer.apple.com/news/?id=e2lxw9l1).
5. [Apple HIG, Design principles](https://developer.apple.com/design/human-interface-guidelines/design-principles).
6. [W3C, Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).
7. [Apple HIG, Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars?changes=la).
8. [Apple HIG, Designing for macOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos/).
9. [Apple HIG, Layout](https://developer.apple.com/design/human-interface-guidelines/layout?changes=la).
10. [Linear, A calmer interface for a product in motion](https://linear.app/now/behind-the-latest-design-refresh).
11. [Apple, Logic Pro main window](https://support.apple.com/guide/logicpro/main-window-interface-lgcpe9cc403a/mac).
12. [Figma, Properties panel](https://help.figma.com/hc/en-us/articles/360039832014-Design-prototype-and-explore-layer-properties-in-the-right-sidebar).
13. [VS Code, Custom layout](https://code.visualstudio.com/docs/configure/custom-layout).
14. [Apple HIG, Split views](https://developer.apple.com/design/human-interface-guidelines/split-views?changes=_6).
15. [Apple HIG, Motion](https://developer.apple.com/design/human-interface-guidelines/motion?changes=_3).
16. [Apple, Communicate your brand identity, WWDC26](https://developer.apple.com/videos/play/wwdc2026/251/).
17. [Apple HIG, Focus and selection](https://developer.apple.com/design/human-interface-guidelines/focus-and-selection/).
18. [W3C, Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html).
19. [Chrome documentation](https://developer.chrome.com/docs/web-platform/view-transitions/same-document).
20. [Motion React documentation](https://motion.dev/docs/react).
21. [Motion accessibility guide](https://motion.dev/docs/react-accessibility).
22. [AnimateView](https://motion.dev/docs/react-animate-view).
23. [animateLayout](https://motion.dev/docs/layout-animations).
24. [Electron nativeTheme](https://www.electronjs.org/docs/latest/api/native-theme).
