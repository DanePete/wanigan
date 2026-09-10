# Wanigan: 2026 interface research and layout direction

Researched 2026-09-09 against primary sources. This is a design exploration, not an approved implementation specification.

## Brief

Redesign the full application. Apple is a reference for craft, and the user wants substantial personality, including an expressive orb with water or gas moving inside it. The key correction is structural: **the whole layout needs a stronger idea**. A conventional navigation sidebar with more gloss does not meet that brief.

## Useful current references

| Reference | Date evidence | Finding | Implication for Wanigan (design judgment) |
| --- | --- | --- | --- |
| [Linear's interface refresh](https://linear.app/now/behind-the-latest-design-refresh) | March 12, 2026 | Its designers reduced navigation prominence, softened separators, and standardized the location and view controls. | Keep orientation stable while the active work takes visual priority. Do not copy its issue-tracker layout as Wanigan's identity. |
| [Apple's macOS preview](https://www.apple.com/os/macos/) | Current macOS 27 page, accessed September 9; publication date not stated | Apple describes more uniform refraction, improved contrast, consistent toolbars, and edge-to-edge sidebars. | Glass should support legible controls and navigation. An opaque reading surface is compatible with a material-rich app. |
| [Tide Guide and Moonlitt in the Apple Design Awards](https://www.apple.com/newsroom/2026/06/apple-reveals-winners-of-the-2026-apple-design-awards/) | June 2, 2026 | Tide Guide won Visuals and Graphics; Moonlitt won Interaction. Apple highlights Tide Guide's aquatic identity, animated charts, and changing palette. | Give Wanigan one coherent visual idea that extends into its working screens. Avoid an unrelated mascot beside otherwise conventional forms. |
| [Tide Guide's developer walkthrough](https://developer.apple.com/videos/play/meet-with-apple/257/) | Official session; publication date not established on the inspected page | Tucker MacDonald demonstrates responsive controls, chart highlights, and a persistent customization popover that returns to its originating control. | Give overlays an obvious origin; let controls respond immediately; make detail available in context without forcing repeated navigation. |
| [Raycast's new desktop implementation](https://www.raycast.com/blog/a-technical-deep-dive-into-the-new-raycast) | May 14, 2026 | Raycast describes using React for its shared interface while deliberately matching desktop interaction conventions. | Native feel depends on focus, selection, transitions, and behavior as well as appearance. Wanigan's Electron architecture can remain. |
| [Not Boring: The Joy of Building Slow](https://notbor.ing/words/the-joy-of-building-slow) | March 3, 2026 | The studio describes building useful apps with 3D models, animation, sound, and haptics as part of their core experience. | The orb needs a designed interaction vocabulary: curiosity, inertia, settling, and material changes. More perpetual motion alone does not create character. |
| [Jitter's glass and effects releases](https://jitter.video/changelog/) | Glass: May 19, 2026; effects/shaders: June 30, 2026 | Its authoring controls separate refraction, thickness, dispersion, frost, and lighting. | Design materials with independent properties. A uniform blur and bright border on every panel erases hierarchy. Jitter is an authoring reference, not a proposed runtime dependency. |

The dates distinguish published 2026 work from older examples still useful today. The separate [orb research](2026-09-09-orb-materials.md) distinguishes procedural smoke, damped animation, wave simulation, and full fluid simulation.

## Three structural approaches

### A. Project spaces — recommended

The primary object is a repository and its ongoing work. Each project has a workspace with sessions, its board, changes, and knowledge close together. A compact global switcher reaches the fleet, accounts, automations, and library. Project selection is persistent; moving between a terminal, changes, and related evidence retains that context.

The visual center is a large working surface. A shallow session strip shows other open sessions, and a contextual inspector appears when useful. The orb belongs to the workspace chrome as a small physical companion; its material can react to direct input independently of the terminal. Its presence never claims an agent is thinking or working.

Tradeoff: this changes navigation and scope handling, so current per-view state and project selection must be reconciled deliberately. It best reflects Wanigan's actual premise: one operator working across repositories.

### B. A work canvas

The primary object is ongoing work across all projects. Sessions and review items occupy an arranged canvas; choosing one expands it into a focused terminal or evidence surface. A compact navigation dock leaves room for the work itself.

Tradeoff: the visual idea is more distinctive, but free positioning creates work for the operator and needs a strong keyboard and compact-window alternative. Do not make this an infinite canvas or a physics toy by default.

### C. An attention workspace

The primary object is the next decision. A quiet queue of sessions needing the operator sits beside a large terminal or evidence reader; the remainder of the fleet is a compact strip. Projects and reference tools open contextually.

Tradeoff: strong for supervision and review, less natural for initiating open-ended coding work. Every queue item must come from recorded evidence, with unknown and stale states preserved.

## Proposed mapping for project spaces

This maps presentation, not new capabilities. Existing route IDs and shortcuts remain stable. Every destination stays explicitly reachable through the switcher and command palette.

| Area | Existing surfaces | Layout intent |
| --- | --- | --- |
| Project workspace | Sessions, project-filtered Board, Git, Context | A continuous place to work with a clear selected project and session; contextual reading panes instead of unrelated full-screen forms. |
| Goals and review | Control, Board | Task flow and evidence adjacent to the operator's decision; retain cross-project views. |
| All work | Fleet | Cross-project overview with attention first and direct access to the real terminal. |
| Accounts and activity | Usage, Insights | Readable account allowances and measured activity, distinct from estimates and unavailable values. |
| Knowledge | Learning, Skills, Context | Browse, read, and review in a consistent list-and-reader structure; preserve scope and provenance. |
| Automations | Runs, Batches, Schedules | A consistent run history and configuration layout, with deliberate launch and spending actions. |
| Library and discovery | Plugins, Scout | Searchable collections with contextual detail and clearly scoped actions. |
| Preferences | Settings | Native-feeling grouped preferences, shorter summaries, and disclosure for secondary explanations. |
| Shared overlays | New session, command palette, dialogs, readers | Consistent dimensions, focus handling, material, and transitions from their invoking control. |

## Design criteria for the next study

- Establish the layout in monochrome before choosing surface effects. It must be recognizable with the orb and gradients removed.
- Show a populated workspace and its focused terminal/review state, not only an empty landing screen.
- Give projects, sessions, and decisions a stronger hierarchy than the list of available features.
- Use the same hierarchy in light and dark themes, with dedicated materials for each.
- Make typography and alignment do most of the structural work. Reserve glass, reflections, and movement for a small number of meaningful surfaces.
- Keep the real terminal readable, selectable, keyboard-driven, and stationary. Preserve its running process across view navigation.
- Keep decorative motion optional and stop it when hidden or disabled. A simulation is not operational evidence.
- Verify the complete route map, keyboard navigation, preserved view state, narrow windows, and both themes before shipping.

## Current status

Research and layout exploration only. The two generated concept images were not approved. The rejected animation implementation and unfinished orb exploration were parked outside the source tree; the original renderer shell is restored. Concurrent provider and Settings changes were preserved.

The reset check ran `npm test`: 1,475 smoke assertions passed and one failed, concerning the main-process host list versus the list printed in Settings. `git diff --check` passed. This is not a claim that the redesign is implemented or that the complete suite passed.
