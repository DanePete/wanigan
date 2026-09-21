# Making Wanigan easier to use: primary-source research

Retrieved 2026-09-19. Research question: how should an operator find, configure,
run, and review work in a desktop agent tool with many overlapping capabilities?

This is the external-evidence half of the audit. It combines first-party Google,
Microsoft, IBM, GOV.UK, and W3C guidance with Jakob Nielsen's original explanation
of progressive disclosure. Pages were opened and their relevant sections read;
search-result snippets alone are not the basis for the recommendations below.
The recommendations are design hypotheses for Wanigan, not measured improvements
in Wanigan task completion or user comprehension.

The strongest direction is to make the ordinary task visible, explain what a
choice changes, and keep its relevant evidence and next action together. Making
everything smaller, hiding every control, or adding another welcome dashboard
does not follow from this evidence.

## Evidence and how it applies

Each entry separates source guidance from the application proposed here.

### 1. Introduce capabilities when the task makes them relevant

**Source:** [Google PAIR: Mental Models](https://pair.withgoogle.com/chapter/mental-models/),
sections “Onboard in stages” and “Explain the benefit, not the technology.”
Google recommends explaining value and limitations early, introducing features
in context, and keeping initial onboarding short. It warns that hiding how an
AI product works can create mistaken expectations. Its guide draws partly on
proprietary studies whose details are not published.

**Wanigan inference:** the first explanation of Sessions, Runs, Goals, or Relay
should answer what work the person wants to do. Setup and provider internals can
follow when needed. A dormant page should lead to a useful action in that page;
it should not repeat a tour of the entire product. Learning must explain what is
recorded, what may change future sessions, and what still needs review.

**Caveat:** “AI learns over time” is not a blanket description of Wanigan or its
providers. Describe only the learning mechanisms actually enabled and recorded.

### 2. Make copy describe the user's objective and the action's consequence

**Source:** [Google Material: Communication Principles](https://codelabs.developers.google.com/codelabs/material-communication-guidance),
sections 2–5. Guidance calls for direct, concise text, essential contextual
details, and sentences beginning with the user's goal. It explicitly retains
critical consequences in dialogs. Suggested evaluation includes asking readers
to explain the words back and measuring completion and time on task.

**Wanigan inference:** explain specialist choices before asking people to choose
them. “Agent setups” is a candidate replacement for “Arms”; “Attempts per setup”
is a candidate replacement for “Repeats per arm.” Keep benchmark terms in the
explanation where their exact meaning matters. Launch buttons should identify
what starts; comparison pages should distinguish looking at results from keeping
or applying a result.

**Caveat:** short text can become ambiguous. “Run” alone does not explain whether
an action starts one process, several repositories, or repeated attempts.

### 3. Disclose uncommon options, with an obvious way to find them

**Source:** [Jakob Nielsen: Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/),
published 2006-12-03. Core/frequent options belong in the initial view; specialized
options can follow a clearly labeled control. Nielsen warns about more than two
disclosure levels and distinguishes optional disclosure from a linear wizard.
Interdependent choices belong together when people need to compare or revise them.

**Wanigan inference:** keep task, selected project(s), agent, and launch consequence
visible together. Group uncommon launch tuning behind a descriptive control.
Keep details mounted where switching sections would otherwise discard a draft,
selection, or running read. SessionReview already does this for its two sections.

**Caveat:** this is established design guidance, not a recent controlled study of
coding-agent tools. Usage frequency must be observed; a developer's favorite
feature is not evidence that it belongs on every initial screen.

### 4. Required information is not “advanced” information

**Source:** [GOV.UK: Details](https://design-system.service.gov.uk/components/details/),
“When to use” and “When not to use.” Details can reduce scanning effort for
information only some users need. The guidance specifically rejects hiding
information most users need.

**Wanigan inference:** required provider launch fields should appear without
opening an optional-settings disclosure. A selected option that creates a new
requirement should reveal it immediately. If submission finds an error in a
collapsed section, reveal the section before directing focus to that error.

**Caveat:** an optional explanation of a field can be collapsed even when the
field is required. The input and its requirement must remain discoverable.

### 5. Navigation should clarify relationships and avoid repeated backtracking

**Source:** [Microsoft: Navigation design basics](https://learn.microsoft.com/en-us/windows/apps/design/basics/navigation-basics),
“Principles,” “General recommendations,” and “Use the right controls.” Microsoft
emphasizes familiar controls, clear destination labels, shallow hierarchies, and
avoiding trips up and down a hierarchy merely to reach related content. List/detail
is appropriate when people switch frequently among records and inspect details.

**Wanigan inference:** retain a stable grouping of work destinations and describe
each by its distinct job. A goal's task should link directly to its associated
session and recorded evidence. A list of runs should retain the operator's
selection while they inspect results. Two pages both headed “Runs” need an
immediately visible distinction in mode, purpose, or subtitle.

**Caveat:** Microsoft's suggested item counts are heuristics, not universal limits.
Its Windows control implementation is not a reason to change Wanigan's React
component system or copy Windows visual styling onto macOS.

### 6. Adapt list/detail to available width

**Source:** [Google Android: Build a list-detail layout](https://developer.android.com/develop/ui/compose/layouts/adaptive/list-detail),
pattern definition and window-size behavior. Google describes side-by-side list
and details when space permits and one pane at a time in smaller windows. Selection
and navigation state are explicit parts of the pattern.

**Wanigan inference:** use this for Runs, schedule history, knowledge review, and
other repeated record inspection. A compact layout needs a clear route back to
the list and the same selected record after resizing. Do not squeeze three narrow
panes into a laptop window merely because all three fit mathematically.

**Caveat:** the source's Compose APIs and Android back behavior are platform
specific. The transferable evidence is the interaction structure, not its API,
breakpoints, or dependency recommendations.

### 7. Keep list-wide controls distinct from record actions

**Source:** [IBM Carbon: Data table usage](https://carbondesignsystem.com/components/data-table/usage/),
“Expandable,” “Interactions,” and “Table toolbar.” Carbon places global controls
in the toolbar, gives each action a distinct target, and reserves expansion for
supplementary detail. It advises a dedicated page or side panel when expanded
content becomes cramped.

**Wanigan inference:** search, filter, and refresh belong above the collection;
retry, keep, review, and remove belong to the selected record. A row selection
must not unexpectedly execute its primary operation. Detailed evidence and long
logs should get a reading area rather than an increasingly tall table cell.

**Caveat:** not every collection needs a data table. Cards or simple rows can
implement the same action boundaries, especially with few records.

### 8. Filters need visible state and a quick escape

**Source:** [IBM Carbon: Filtering](https://carbondesignsystem.com/patterns/filtering/),
“Selection methods,” “Filter states,” and “Resetting filters.” Carbon differentiates
single/multiple selection and instant/batched updates. Applied filters need a
visible indication if their container closes, with a way to clear them. Multiple
categories need a way to clear all filters.

**Wanigan inference:** show the current result count, active filter state, and a
clear reset beside run, schedule, or session searches. A “No matching runs” state
should reset the conditions without requiring the person to remember every filter.
Persisted filter state must not make old results appear to be missing data.

**Caveat:** instant local filtering is appropriate only when cheap. Expensive
remote reads or complex multi-category changes may warrant an explicit Apply.

### 9. Validation should preserve work and give a specific recovery path

**Sources:** [GOV.UK: Recover from validation errors](https://design-system.service.gov.uk/patterns/validation/)
and [Error summary](https://design-system.service.gov.uk/components/error-summary/).
GOV.UK retains entered values, puts errors next to fields, and focuses a summary
with links to the invalid answers. It generally validates at continuation or
submission, rather than while an answer is incomplete. Backend validation remains
necessary even with client validation. Unavailable service and permission states
are treated separately from invalid answers.

**Wanigan inference:** preserve task and configuration drafts after launch fails.
Explain the actual prerequisite near a disabled action; a gray button by itself
does not explain what is missing. Inline errors should name the field and fix.
Keep main-process validation authoritative. Unsupported agent capabilities should
explain the limitation and available next action, rather than accuse the user of
entering an invalid value.

**Caveat:** GOV.UK's exact summary heading, page-title convention, and full-page
flow are not mandatory in a small Electron dialog. Choose the focus destination
to fit the form's size while maintaining the same recovery path.

### 10. Accessibility is part of simplifying interaction

**Sources:** [W3C WAI: User Notification](https://www.w3.org/WAI/tutorials/forms/notifications/),
[WCAG 2.2 Understanding: Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html),
and [WAI-ARIA APG: Accordion](https://www.w3.org/WAI/ARIA/apg/patterns/accordion/).
WAI explains associating field errors through `aria-describedby`, reporting
submission outcomes, and directing focus to problems. Status messages should be
programmatically available without taking focus, with care to avoid excessive
announcements. Custom accordion buttons expose their expanded state and controlled
panel; Enter/Space operates the header and Tab reaches focusable controls.

**Wanigan inference:** use concise polite announcements for completed searches
and user-triggered operations, not every telemetry tick. Collapsed controls must
not remain in the Tab sequence. A changed count alone does not replace a named
status message. Test focus after opening, canceling, submitting, and returning to
a list, in addition to checking accessible names.

**Caveat:** Understanding pages and APG are informative guidance; passing one
pattern or automated check does not establish full WCAG conformance. Native
`details`/`summary` can be preferable to rebuilding a custom accordion.

### 11. Empty states should diagnose the kind of absence

**Source:** [IBM Carbon: Empty states](https://carbondesignsystem.com/patterns/empty-states-pattern/),
“Types of empty states.” Carbon distinguishes first use, empty results after a
user action, and failures or missing prerequisites. It calls for a contextual
next step, concise language, and a single most useful action when one exists.
An empty attention queue can simply indicate that nothing needs attention.

**Wanigan inference:** preserve the existing distinction between nothing yet,
nothing in scope, and a failed read. “Create a schedule,” “Clear filters,” and
“Retry loading” solve different problems and should not share the same generic
empty message. An empty successful queue should not push the user into creating
unnecessary work.

**Caveat:** a call to action is useful only if it actually addresses the cause.
Do not suggest creating new records when a read failed.

### 12. Evidence should help a decision, without manufacturing certainty

**Source:** [Google PAIR: Explainability + Trust](https://pair.withgoogle.com/chapter/explainability-trust/),
“Optimize for understanding” and “Manage influence on user decisions.” The guide
recommends explanations relevant to the user's decision and distinguishes general
system explanations from explanations of a specific output. Confidence displays
need testing and a meaningful relationship to the next action; a number alone
can be difficult to interpret.

**Wanigan inference:** show the observed state, relevant source, and available
next action together. A successful command should remain a successful command,
not become a claim that the user's entire request is complete. Keep estimated
costs, unpriced usage, missing telemetry, and observed spend distinguishable.
An operator reviewing a suggestion needs the evidence and effect of accepting it.

**Caveat:** review evidence is not necessarily model confidence. Do not recast
deterministic checks as probabilities or add confidence numbers without calibration.

### 13. Schedule time through ordinary controls while preserving exact expressions

**Source:** [IBM Carbon: Date and time pickers](https://carbondesignsystem.com/components/date-picker/usage/),
“Time format” and “Time pickers.” Carbon recommends a time input for scheduling,
clear labels, an explicit AM/PM selection for 12-hour time, and a specified time
zone. It supports both 12-hour and 24-hour formats.

**Wanigan inference:** offer daily, weekdays, or weekly cadence with a labeled
time control for ordinary schedules. Keep the existing custom cron expression
available and preserve its exact value until the operator deliberately chooses
a different cadence. Show upcoming occurrences and local-time behavior alongside
the editor. The preview should describe the actual parser's interpretation.

**Caveat:** this source does not define cron semantics, recurrence, daylight-saving
behavior, or which presets Wanigan should support. Those depend on the existing
scheduler contract and must be tested against it; do not approximate arbitrary
cron expressions by silently replacing them with the nearest preset.

### 14. Disabled submit controls need an understandable path forward

**Source:** [GOV.UK: Button](https://design-system.service.gov.uk/components/button/),
“How it works” and “Disabled buttons.” GOV.UK favors action-describing labels and
warns that disabled controls can be confusing, recommending avoiding them where
possible.

**Wanigan inference:** batch submission can remain blocked when prerequisites
or spending checks fail, but the prerequisite list should identify a correction
and take the user to the relevant field or operation. “Run the estimate” should
reach estimation; “Name the run” should focus its input. Explain the prerequisite
in visible text rather than a tooltip available only on hover.

**Caveat:** the guidance does not authorize bypassing eligibility or budget gates.
Disabling a duplicate submission during an active request is a different problem
from requiring someone to guess which incomplete field prevents submission.

### 15. Live filtering must have predictable effects

**Source:** [W3C: Understanding On Input](https://www.w3.org/WAI/WCAG22/Understanding/on-input.html).
Changing a control's value should not cause an unannounced change of context.
The page distinguishes ordinary content updates from context changes such as
moving focus or significantly rearranging a page.

**Wanigan inference:** filter the collection without silently substituting the
record being inspected when its live status changes. If the selection no longer
matches, keep its identity visible and explain that it is outside the current
filter. An explicit selection, deletion, or scope change may require a different
policy. Preserve focus while result counts update.

**Caveat:** WCAG does not prescribe this exact selection policy, and an updated
detail pane is not automatically a conformance failure. Stable inspection is our
application of the predictability principle to an operational tool.

## Concrete opportunities found while cross-checking the code

These are code observations and design proposals, not a complete live UI audit.
Paths refer to the shared working tree inspected during this research.

| Surface | Observation | Proposed application |
| --- | --- | --- |
| `src/renderer/src/views/HeadlessRuns.tsx` | Additional launch fields already open automatically when a required field is present (`open={additionalFields.some(field => field.required)}`). | Preserve this good pattern. It is not a hidden-required-field defect. Verify recovery if the operator manually collapses it before submission. |
| `src/renderer/src/views/Attempts.tsx` | Setup asks for “Best of N,” “Paired bench,” “Arms,” and “Repeats per arm.” | Lead with the intended outcome: choose a result versus compare setups. Keep statistical definitions in contextual explanation. Preserve exact attempt counts and spending consequences. |
| `src/renderer/src/views/Attempts.tsx` and `HeadlessRuns.tsx` | Both page heads use “Runs,” while the work models differ. | Make the visible mode label and one-sentence purpose discriminate repeated attempts from one task across repositories. Test that users can choose correctly without reading technical help. |
| `src/renderer/src/views/Schedules.tsx` | Search-empty copy suggests clearing filters; cron presets and the cron expression are both present. | Ensure the empty state has an actual reset action. Keep preset selection and human-readable upcoming windows primary; preserve custom cron access and clear local-time behavior. |
| `src/renderer/src/views/Batches.tsx` | Submission blockers are shown as a comma-separated “Still to do” sentence below the disabled button. | Make each correctable blocker lead to the corresponding field or operation, retaining all backend and spending gates. |
| `src/renderer/src/components/SessionReview.tsx` | Changes and Checks & evidence use two mounted sections, and the check section explicitly limits what recorded results prove. | Preserve draft/selection continuity and the evidence boundary while testing whether operators can find checks and return to the same file with the keyboard. |
| `src/renderer/src/components/SpaceNavigation.tsx` | Stable workspace areas, a project switcher, and a search entry already exist. | Improve destination descriptions and cross-links before adding another navigation layer. Preserve the destination when a sidebar group is expanded or the window narrows. |

## Ranked implementation recommendations

The ranking is our judgment based on probable user impact and bounded change
size. It does not claim measured usage frequency.

1. **Make launch requirements and blockers actionable.** Preserve visible required
   inputs, keep drafts after errors, and link prerequisites to their corrections.
   Validate required-field and unsupported-profile paths through the existing
   typed API, including keyboard-only recovery. Basis: evidence 4, 9, 10, 14.
2. **Clarify the workflow decision before the form.** Differentiate interactive
   Sessions, multi-repository Runs, repeated attempts, Goals, and Relay through
   concrete task language. Start with the existing mode switch and page copy;
   do not add a universal wizard without evidence. Basis: evidence 1, 2, 5.
3. **Make scheduling approachable.** Let common recurring work use a cadence and
   time control while custom cron and exact upcoming windows stay available.
   Round-trip existing expressions without changing their meaning. Basis: evidence 13.
4. **Make collection state reversible.** Add or verify result counts, explicit
   active filters, reset actions, truthful empty states, and retained inspection
   as live data changes. Check broad, filtered, empty, failed, and compact states.
   Basis: evidence 6–8, 11, 15.
5. **Group optional configuration around the operator's task.** One clearly
   named secondary level can contain uncommon tuning. Keep scope, spend, approval
   effects, and required settings visible. Basis: evidence 2–4.
6. **Put the next action beside the evidence that enables it.** Retain clear
   boundaries between inspecting, verifying, keeping, merging, and publishing.
   Link related work directly instead of sending the user to search again.
   Basis: evidence 5, 7, 12 and the repository's explicit trust constraints.

## How to test whether this is actually easier

The following is a proposed Wanigan evaluation protocol, not a result:

- Ask an operator to choose the right workflow for a conversation, the same fix
  in three repositories, and three alternative solutions to one task. Record
  the first destination chosen and any reversals.
- Start a task with an agent whose manifest has an extra required field. Check
  that the requirement is visible and correctable without hunting for it.
- Fail a launch after entering a substantive task. Confirm the task survives,
  the error identifies its cause, and retry does not create duplicate work.
- Filter a populated history to zero matches, clear it, select a result, inspect
  its evidence, resize the window, and return. Record lost selection, unexpected
  scrolling, and repeated navigation.
- Review a completed command and ask what it proves. A participant should not
  infer overall task completion, review approval, or publication from a green
  command result alone.
- Repeat the main paths using keyboard only, both themes, and a compact window.
  Check focus visibility, reading order, status announcements, and preservation
  of drafts. Screenshots demonstrate layout; they do not demonstrate usability.

For comparison, retain the same data and task wording before and after changes.
Measure task success, wrong destinations, recovery success, and time after users
understand the task. Do not label lower click count or a smaller screenshot as
proof of improved usability. No new telemetry collection is implied or authorized
by this proposed protocol.

## Research limits

Apple's [Sidebars HIG](https://developer.apple.com/design/human-interface-guidelines/sidebars)
was also investigated. Its direct page returned a JavaScript-only shell in the
reader; search exposed substantial indexed text, but it was not used as an
independent implementation requirement. Material 3's navigation overview could
not be read directly, so the accessible first-party Material codelab and Android
adaptive guidance were used instead. No third-party paraphrase substitutes for
those unavailable pages.

These sources support interaction decisions, not an exact visual redesign.
Their platform components, pixels, and palettes should not replace Wanigan's
existing frame, tokens, primitives, extension rules, or main-process trust
boundary. The external evidence alone does not establish which feature an
individual Wanigan operator uses most often.
