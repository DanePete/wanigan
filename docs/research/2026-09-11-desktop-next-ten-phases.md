# Wanigan: the next ten desktop design phases

Research date: September 11, 2026. This is a design and verification brief, not a
record of completed implementation. The target is the Electron app; the marketing
website is outside this pass.

The resulting implementation, before/after captures and verification are recorded
in the [delivery record](../visuals/next-ten/README.md).

Wanigan now has an established visual direction and recent redesign evidence for
all top-level destinations. The next useful improvement is to carry that quality
through the smaller surfaces people repeatedly touch: finding work, launching a
session, drafting, inspecting evidence, recovering from a problem, and making room
for the task. The companion remains the expressive center of the product.

## Research basis

The March 12, 2026 Linear refresh reduced the prominence of navigation, compacted
desktop tabs, removed excessive icon treatments, and standardized headers. Its
stated problem was useful features accumulating into inconsistent controls. That
closely matches Wanigan's remaining secondary surfaces. The transferable idea is
an allocation of attention, not copying Linear's issue-tracker layout.
[Linear, A calmer interface for a product in motion](https://linear.app/now/behind-the-latest-design-refresh).

Apple's WWDC26 design principles emphasize agency, familiar behavior, Mac-specific
precision, concise wording, and responsive craft. Its account of delight connects
emotion to the whole experience rather than to isolated flourishes. For Wanigan,
the design judgment is **a quietly mischievous companion within a dependable work
environment**. That phrase is our proposed direction, not Apple's wording.
[Apple, Principles of great design](https://developer.apple.com/videos/play/wwdc2026/250/).

The current sources below are not all newly introduced in 2026. Dates are given
only where a primary source identifies them. Apple native API examples do not
establish that the same capabilities work in Electron. Their principles need a
tested browser or typed preload implementation before Wanigan can claim support.

## 1. Make the command palette a composed launcher

**Surfaces:** `App.tsx`'s `CommandPalette`, the command styles, and the existing
shared palette ranking/route definitions.

**Current evidence:** The palette already searches destinations, projects,
sessions, settings, and archived transcripts; it also remembers recent choices.
Its presentation is a long grouped list beneath a very long placeholder. The
selected item is stored as an array index while asynchronous transcript results
can change the list. The dialog also captures Home and End while the input has
focus, replacing ordinary text editing with result navigation.

**Design change:** Give the launcher a concise search field, clear section
rhythm, a stronger selected row, and a restrained bottom instruction strip.
Expose which kind of result is selected and what Enter will do. Preserve the
selected identity across background result changes when it still exists. Keep
text-editing keys in the input; arrow keys continue to navigate results. Searches
that are waiting, failed, empty, or capped need distinct language. Do not add
model-generated search suggestions or change any command's side effects.

**Rationale:** Raycast makes a primary action and grouped contextual actions
discoverable, with their keyboard shortcuts alongside. The APG combobox pattern
keeps typing in the field and explicitly cautions against intercepting ordinary
text-editing keys. These are relevant interaction references, not a proposal to
import Raycast's shortcut assignments.
[Raycast, Action Panel](https://manual.raycast.com/action-panel),
[W3C APG, Combobox](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/).

**Validation:** Search a project, a session, a setting, and an archive result;
change results out of order; confirm selected identity, one activation, Escape,
focus return, and normal caret movement. Inspect both themes, a long path, and a
short desktop window. Existing destination and terminal shortcut contracts stay
intact.

## 2. Turn keyboard help into a searchable reference

**Surfaces:** `components/ShortcutSheet.tsx`, shared binding/route data, shortcut
styles.

**Current evidence:** The sheet correctly derives its rows from the running
binding tables. It is an unsearchable document with long introductory notes and
many rows. Replacing its data source would sacrifice an existing strength.

**Design change:** Add local search by action, chord, and context. Display
shortcuts as consistent keycaps, retain grouping, and keep a compact context note
near each group. Place the terminal ownership rule prominently in plain language.
A zero-result state should offer Clear search. This is a reference, not a shortcut
editor; do not advertise bindings that the app does not implement.

**Rationale:** Raycast's action interface teaches shortcuts beside actual actions
and filters a long command list by its names. Applying that discoverability to a
reference sheet is a Wanigan-specific inference.
[Raycast, Action Panel](https://manual.raycast.com/action-panel).

**Validation:** Search by action, symbol, and context; clear a failed search;
compare every rendered row to the canonical binding tables. Check keyboard focus
containment and return, both themes, and scrolling at reduced window height.

## 3. Give new sessions a deliberate launch surface

**Surfaces:** `components/NewSessionDialog.tsx`, launch-specific styles, the
existing provider/catalogue/trust reads.

**Current evidence:** This remains a long form with provider, project, trust,
model, effort, permission, account, custom fields, working-tree choice, first
message, and additional CLI flags. Many settings use separate inset boxes and
inline layout. The latest planning-table redesign does not solve this launch
surface.

**Design change:** Compose a wider desktop sheet with a clear launch identity and
three legible groups: where the work happens, how the agent starts, and the first
message. Give the exact project/provider/model/worktree choices a compact summary
beside the primary action. Keep ordinary model controls visible; place genuinely
optional extras in labeled disclosures. Preserve all trust, permission, backend,
and adapter consent details at the decision point. Busy or unavailable choices
must remain visibly distinct. The summary must use actual selected values,
including an explicit CLI-default state.

**Rationale:** Apple's design principles connect consistent placement and clear
hierarchy with predictable decisions. APG modal guidance establishes initial
focus, a contained Tab sequence, Escape, and focus return; a beautiful sheet must
preserve these behaviors.
[Apple, Principles of great design](https://developer.apple.com/videos/play/wwdc2026/250/),
[W3C APG, Modal dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).

**Validation:** Use synthetic bridge fixtures for built-in and custom profiles,
missing CLI, unavailable catalogue, restricted trust, long values, and launch
failure. Verify that selections survive disclosures and failed launch, that
duplicate launch is blocked, and that the summary matches the exact payload.
Do not launch a paid workload for visual QA.

## 4. Make drafting and saved prompts easier to read

**Surfaces:** `components/Composer.tsx`, composer styles, the existing local draft
and stash store.

**Current evidence:** The composer already has careful send-versus-queue rules,
draft persistence, a skill picker, and a saved-prompt stash. Its placeholder
contains several instructions at once. The stash is an icon-led popup of prompt
rows with no search, and queued messages rely heavily on truncation and hover.

**Design change:** Use a short drafting prompt with a quiet shortcut/help line.
Present the actual delivery mode next to the action so Send, Queue, and blocked
states remain obvious. Give saved prompts a named, searchable reader with useful
previews and explicit restore/delete actions. Keep queue ordering and unsent
status visible. A local acknowledgement should distinguish stashing a draft from
sending bytes to a real terminal. Restoring a prompt must not silently send it.

**Rationale:** Apple's principles favor concise interface language and immediate
feedback; WCAG status-message guidance explains how an update can be announced
without taking focus. These support a calmer drafting surface with explicit
delivery semantics.
[Apple, Principles of great design](https://developer.apple.com/videos/play/wwdc2026/250/),
[W3C, Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html).

**Validation:** Exercise idle, busy, permission wait, unavailable attention, and
exited-session states. Search and restore a stash entry without sending; preserve
a multiline draft across session changes; verify the skill picker still owns
Enter while open. Preserve the current queue safety contract and explicit
send-now behavior.

## 5. Refine the activity timeline as evidence

**Surfaces:** `components/Timeline.tsx`, timeline styles, session detail rail.

**Current evidence:** The timeline already groups turns, folds tool start/result
pairs, supports filtering, displays duration, and discloses its event limits.
Its useful signal is surrounded by many small labels, chip-like filters, counts,
and explanatory bands. A redesign should preserve its measured distinctions.

**Design change:** Give the current observed state one stable place, use a concise
filter toolbar, and make turn headings and individual tool events visibly
different levels. Let the selected evidence and duration comparison carry the
weight. Place result counts and the loaded-range limit together. Keep a visible
path from a tool event to its existing file or turn diff. Avoid decorative
progress or inferred success. Refreshes should update text without bouncing rows
or changing a user's selected target.

**Rationale:** Linear's 2026 refresh reduces redundant borders and competing icon
treatments while retaining dense working information. WCAG status guidance also
warns that excessive live announcements can make an interface too chatty.
[Linear, A calmer interface for a product in motion](https://linear.app/now/behind-the-latest-design-refresh),
[W3C, Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html).

**Validation:** Inspect a long session, an in-flight call, permission wait,
failed call, capped history, filtered-empty state, and unavailable read. Polling
must preserve open turns, focus, and scroll. Confirm every displayed duration
comes from recorded timing and that incomplete calls remain incomplete.

## 6. Finish the source and diff reading experience

**Surfaces:** `components/CodePanel.tsx` and its `CodeInspector`, code styles.

**Current evidence:** The full-height inspector already provides search, wrap,
Top/Bottom, external opening, and a truncation notice. Search counts matching
lines, but its match button only scrolls to the first matching line. The header
combines identity and numerous equal-weight controls.

**Design change:** Give the selected file path a dependable identity area and
search its own compact toolbar. Add previous/next matching-line navigation and
an active-match counter; accurately label these as matching lines unless actual
occurrence indexing is implemented. Keep wrap and external-open secondary.
Preserve monospaced alignment and meaningful add/delete/hunk distinctions in both
themes. Do not turn inspection into an editor or weaken restore/staging consent.

**Rationale:** Linear's header consistency study supports separating location
from view actions. Its February 5, 2026 changelog also explicitly records a fix
for restoring list scroll position after returning from an item; this is useful
evidence that continuity is part of desktop craft.
[Linear, A calmer interface for a product in motion](https://linear.app/now/behind-the-latest-design-refresh),
[Linear, February 5 changelog](https://linear.app/changelog/2026-02-05-linear-mcp-for-product-management).

**Validation:** Navigate multiple matching lines in both directions, including
no matches and wraparound. Check a long filename, a long line, binary and
truncated content, both themes, and keyboard-only close/focus return. Opening the
reader must not mutate files or change the terminal's session selection.

## 7. Give alerts and recovery a consistent, calm voice

**Surfaces:** `App.tsx`'s `AlertStack`, `components/ErrorBoundary.tsx`, shared
status/error styles and announcements.

**Current evidence:** Alerts already distinguish urgent permission waits from
ordinary notifications and use deadlines for transient dismissal. The render
boundary correctly preserves global navigation while recovering a failed view,
but its fallback is a generic centered error layout with raw diagnostic text in
the main reading path. The existing sentence that a formerly running process
“is still running” is stronger than the renderer can independently establish.

**Design change:** Give notifications a compact event identity, one clear target
action, and a stable dismissal affordance. Refine view recovery into a readable
surface: what failed, what can be retried, and optional technical details. Say
that reloading this view does not intentionally stop agent processes; do not
guarantee a process's current lifecycle without a fresh observation. Retain
urgent versus ordinary behavior and preserve the source text for diagnosis.

**Rationale:** Linear's September 3, 2026 Priority inbox separates work that needs
attention from updates that can wait. Wanigan can apply that hierarchy to its
existing observed urgency without introducing automatic model classification.
WCAG allows status updates to be announced without moving keyboard focus.
[Linear, Priority inbox](https://linear.app/changelog/2026-09-03-priority-inbox),
[W3C, Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html).

**Validation:** Trigger synthetic ordinary and urgent alerts, repeated rerenders,
target navigation, dismissal, and an isolated render failure. Confirm no focus
steal, no urgent timeout, correct transient deadlines, and preserved navigation.
Recovery must never quit the Electron application.

## 8. Keep secondary work reachable in compact desktop windows

**Surfaces:** `views/Sessions.tsx`, detail-rail controls, shell/panel styles,
existing view-memory helpers.

**Current evidence:** Sessions measures its own available width and collapses the
details rail before the terminal becomes too narrow. That is good. However, its
Details control is disabled at compact widths, removing the direct path to that
supporting information while the window is narrow.

**Design change:** Keep the side-by-side arrangement at generous widths. At
compact desktop widths, offer a deliberate full-width detail reader or sheet
with an obvious return to the terminal. Reuse the same selected session and
detail state; keep PTYs mounted. Focus, terminal selection, composer draft, and
scroll should survive entering and leaving the reader. Any focus layout needs a
visible way to restore the normal workspace.

**Rationale:** VS Code documents visible controls, menu/keyboard alternatives,
persisted panel state, and reset commands for its layout. That supports
recoverable focusing rather than simply hiding a panel. WCAG's focus-obscuration
criterion is also pertinent to floating toolbars and the bottom dock.
[VS Code, Custom Layout](https://code.visualstudio.com/docs/configure/custom-layout),
[W3C, Focus Not Obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html).

**Validation:** Resize through 1720, 1280, 1080, 960, and 720-pixel widths and
short heights. Open evidence at compact width, return to the terminal, then
expand the window. Verify no duplicated PTY mount, preserved selection/draft,
reachable return controls, and no focused element hidden behind chrome.

## 9. Make the materials adapt to how people need to see

**Surfaces:** `index.css`, `styles/shell.css`, `styles/motion.css`, relevant
surface styles, `theme.ts`, and appearance controls only if an explicit manual
fallback is needed.

**Current evidence:** Wanigan already has light/dark themes and Auto/Full/Off
motion controls. The audited theme/chrome styles do not yet provide comparable
reduced-transparency, increased-contrast, or forced-color treatments. Bright
ambient layers and low-contrast separators therefore require more than a theme
switch to accommodate these preferences.

**Design change:** Add opaque chrome/readers and clearer borders where a
supported preference requests them. Keep selection, focus, control boundaries,
and status words legible without relying on blur or hue. Use centralized tokens
and the existing motion policy. Check actual Electron preference propagation;
if a native signal needs bridging, use a typed main/preload API and state the
support boundary. A CSS rule is not evidence that an OS signal reaches it.

**Rationale:** Apple's WWDC26 platform presentation explicitly describes stronger
toolbar legibility and adapting Liquid Glass to reduced transparency and
increased contrast, plus a macOS 27 show-borders value. W3C Media Queries Level 5
defines the related browser preference queries; its February 19, 2026 publication
is a Working Draft, not a guarantee of browser support.
[Apple, Platforms State of the Union](https://developer.apple.com/videos/play/wwdc2026/102/),
[W3C, Media Queries Level 5](https://www.w3.org/TR/mediaqueries-5/#prefers-reduced-transparency).

**Validation:** Inspect both themes with reduced motion, Motion Off, reduced
transparency, increased contrast, and forced colors where supported. Verify the
composited text/control contrast, visible keyboard focus, and stable layout.
Document emulated tests separately from verified native signal tests; do not
claim blanket accessibility conformance.

## 10. Make the companion's personality discoverable

**Surfaces:** `components/Orb.tsx`, `CompanionPresence.tsx`, Mission room companion
controls, existing expression/runtime actions, and related styles.

**Current evidence:** Wanigan already has detailed shared GPU physics, intentional
reactions, a compact presence on working pages, and an accessible activation
label. Much of its direct manipulation is implicit. A label that names an action
is useful to assistive technology, but it does not teach a sighted new user what
the glass will do when dragged or which gestures differ from navigation.

**Design change:** Give the large companion a restrained interaction hint and
give the small presence a readable hover/focus invitation that states its actual
action: talk, or show sessions needing attention. Expose available decorative
actions with explicit labels in the existing companion controls. Teach the
current material's real behavior, not unsupported gestures. A nudge may earn a
brief mischievous response; routine navigation does not need a performance. Keep
live status text separate from decorative mood. Motion Off must remain usable.

**Rationale:** Apple's WWDC26 custom-controls session uses an interactive virtual
cat to demonstrate exposing the control's purpose, current reaction, available
actions, and feedback. This is unusually direct inspiration for Wanigan; the
specific SwiftUI/VoiceOver APIs are not a web implementation prescription. The
brand session also treats content and voice as identity opportunities while
ordinary navigation remains familiar; applying that iOS guidance here is an
explicit desktop design inference.
[Apple, Refine accessibility for custom controls](https://developer.apple.com/videos/play/wwdc2026/220/),
[Apple, Communicate your brand identity on iOS](https://developer.apple.com/videos/play/wwdc2026/251/).

**Validation:** Test pointer hover, keyboard focus, activation, labeled decorative
actions, and current-material hints on the large and small companion. Verify
that an interaction does not accidentally navigate, that urgent session links
still point to their actual records, and that decorative reactions do not imply
a paid request or successful agent result. Check Motion Off and reduced-motion
behavior against the current policy; prolonged automatic animation must have a
usable pause mechanism.
[W3C, Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html),
[W3C, Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html).

## Delivery boundaries

The ten phases reuse existing workflows and shared primitives. They do not call
for a new animation dependency, fabricated activity, a provider capability
expansion, or another top-level navigation system. Some secondary components have
legacy inline styles; new surface styling belongs in token-based stylesheets,
with the renderer style gate's baseline only decreasing.

Capture affected states before and after in both themes using isolated authored
fixtures, then run focused interaction probes, the required six-step `npm test`,
and `git diff --check`. Distinguish source implementation, tested build, staged
installation, and the currently running app in the delivery record. The running
Wanigan must not be quit to finish visual verification while it owns live agent
processes.

Local evidence consulted:
[original audit](2026-09-10-ui-design-audit.md),
[primary-source study](2026-09-10-desktop-ui-primary-sources.md),
[desktop journey](../visuals/desktop-journey/README.md), and
[remaining workspace pass](../visuals/desktop-remainder/README.md), alongside the
current component implementations named in each phase.
