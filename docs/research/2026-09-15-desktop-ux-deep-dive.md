# Wanigan desktop: make the work easier to supervise

September 15, 2026 · Audit and proposed design · Not an implementation record

## Recommendation

Make Wanigan a dependable workbench around four questions:

1. What needs me now?
2. Which task and project am I looking at?
3. What actually changed, and what evidence supports it?
4. How do I continue this work later?

Keep the companion, real terminals, existing visual identity, provider boundaries,
and evidence model. Give those strengths a more coherent interaction model. The
largest opportunity is the connection between existing screens: attention,
session, changes, checks, review, and history.

“10×” is an ambition, not a measured result. This investigation found concrete
defects and design opportunities; it did not measure human task completion time
or demonstrate an order-of-magnitude productivity gain.

## Evidence and limits

- Audited the working tree at `8a7a7b2`, including the existing uncommitted session
  permission changes. Those changes remain untouched.
- Three parallel source audits covered workflows, navigation/accessibility, and
  onboarding/settings/automation. The primary pass examined the shared shell,
  current designs, and screenshots and checked the highest-impact source findings.
- Built the current app with Node 22.23.2. The build succeeded with chunk-size and
  mixed static/dynamic import warnings.
- Captured **52 current screenshots**, including all **17 destinations in both
  themes**, supporting overlays, and six compact views. These use the actual
  Electron main process and preload in an isolated temporary profile. The capture
  runner creates local example goal/learning records and registers this repository;
  it starts no coding agents. These are not observations of a productive fleet.
- The capture runner reported zero renderer errors and passed its 11 checks,
  including planner draft/focus behavior and validated goal creation without an
  agent launch. This is not a substitute for the full `npm test` suite.
- A separate isolated renderer probe reproduced four problem groups with authored
  fixtures: project/view context loss, sidebar focus/Escape behavior, visible-name
  search failures, and unreadable Git evidence rendered as no changes. It reported
  zero renderer errors. It verifies renderer behavior, not real Git, IPC or PTYs.
- No changes were installed, published, or made to production application source.
  No running user app was quit.

Evidence: [capture record](../visuals/ux-audit-2026-09-15/current/verification.json),
[runtime log](../visuals/ux-audit-2026-09-15/current/runtime-log.txt),
[problem reproductions](../visuals/ux-audit-2026-09-15/probes/verification.json).

## What is already good

The September 10–11 work already established a strong shared frame, light/dark
tokens, motion preferences, a categorized command palette, launch summary,
recoverable planning drafts, compact session details, code reader search, and
multiple workspace layouts. Recommending those as missing would be stale.

Keep the shared `bits.tsx` primitives, typed main/preload boundary, exact resume
identity, observed-versus-unavailable distinctions, and worktree safeguards.
Keep the companion's personality. Keep permission prompts inside the real
harness unless an explicitly verified control exists.

Prior evidence: [next-ten delivery](../visuals/next-ten/README.md),
[desktop journey](../visuals/desktop-journey/README.md),
[composer research](2026-09-11-sessions-composer-layout.md).

## Findings ranked by user consequence

P1 means blocked work, misleading evidence, or a substantial repeated workflow
cost. P2 means orientation, discoverability, or avoidable effort. Severity is a
design judgment; no numeric score pretends to be usage telemetry.

| Priority | Finding | Consequence | First change |
| --- | --- | --- | --- |
| P1 | Git read failure can look like no changes | A reviewer trusts missing evidence | Explicit loading, stale, unavailable and attribution states |
| P1 | Checks can stay “running” after navigation | The operator cannot trust completion | Follow durable run state across view lifetimes |
| P1 | Adding a first folder does not refresh setup | The next step remains disabled | Refresh preflight after successful registration |
| P1 | Scheduled work does not name its execution profile | The user cannot choose who receives the task | Persist and preview the exact profile and applicable execution settings |
| P1 | Mission attention has a different priority order | Urgent blocked work can be buried | Shared ordered attention model with task identity |
| P1 | Ordinary sessions lack a complete review handoff | Evidence must be assembled across views | Session review with changes, checks and explicit limits |
| P1 | History is split between immediate resume and Settings | Reading old work can start a process | Read-first history with a separate Resume action |
| P2 | Area switching loses project/view context | Repeated navigation requires reconstruction | Remember area destination and scoped selection |
| P2 | Visible names disagree with search | Users cannot find what they just named or saw | Shared display names and aliases |
| P2 | Destination overlay lacks a focus/dismissal lifecycle | Keyboard navigation becomes unpredictable | Apply the existing dialog contract or use a pinned rail |
| P2 | Launch prompt is late and transient | Starting with an intent takes unnecessary setup | Task-first launcher with preserved draft |
| P2 | Home and shell devote substantial space to chrome | Setup and work begin below the fold | Compact companion and task-first content hierarchy |

### 1. Missing change evidence is presented as a clean state

**Source:** `src/main/code.ts:201–207,224–227,245–247` returns `attributed` and
`unreadable`. `src/renderer/src/components/CodePanel.tsx:64–65` excludes those
fields from its handwritten state type; `121–123` swallows rejected reads.
`580–585` renders “Not a git repository” initially or “No changes yet” for an
empty returned list. `332` filters using `preexisting` without consuming the
top-level attribution state.

**Change:** Use the typed result and a separate read lifecycle. A pending read
shows “Reading changes…”. An unavailable read says why and offers Retry. A
previous successful result remains visible with “Last read … · Refresh failed”.
Unknown attribution becomes “Workspace changes; session attribution unavailable”.
Never infer ownership from the absence of a pre-existing marker.

**Acceptance:** Cover delayed first read, rejected IPC, returned `unreadable`,
stale retained files, non-repository, and missing baseline. None may masquerade
as a verified clean workspace. Destructive actions retain main-owned validation.

### 2. Verification is tied to the component that started it

**Source:** `components/ReviewGate.tsx:24–36` reads history only on mount.
`51–55` updates only after its own awaited run. Navigating away unmounts that
component; returning during the run reads a running row with no subsequent
subscription or polling. `src/main/review.ts:235–239` already records completed
commands during execution.

**Change:** Give the UI a durable run identity. Observe it while active; re-read
on return and window visibility. Show recorded command progress and output as
available. Keep editable recipe state separate so refresh cannot overwrite a
draft. A session-level review links to these same results.

**Acceptance:** Start a multi-command run, navigate away, return before completion,
and observe it finish without user refresh. Failed commands show exit/output.
Do not rerun commands as a side effect of reading or remounting.

### 3. First-run setup does not refresh after the native folder picker

**Source:** `components/SetupChecklist.tsx:35–47` reads preflight on mount.
The folder actions at `125,187` call `onAddProject` without re-reading.
`App.tsx:763–768` updates the app project list, while Mission keeps its checklist
instance (`views/MissionRoom.tsx:189`). The import-discovered path explicitly
re-reads at `SetupChecklist.tsx:74`. Re-check is conditional at `117`; Start
depends on the old snapshot at `132`.

**Change:** Successful project registration invalidates readiness everywhere.
Prefer an explicit project-registration result/event or refresh key over remounting
the entire app. Cancellation leaves state intact. Show the next actionable step
above the fold and make agent setup distinct from the optional companion API.

**Acceptance:** On a machine with an available agent and no registered projects,
choose a folder and immediately see the project step become ready and Start
enabled. Test discovery/import and native selection separately; cancellation
must not imply success.

### 4. Schedules hide who will execute the work

**Source:** `views/Schedules.tsx:225–227` persists prompt and scope without a
provider. The execution fallback in `src/main/index.ts:574–577,1015–1017` chooses
the first installed headless-capable profile in registry order at execution time.

**Change:** The schedule editor must show “Runs with …” and persist an explicitly
chosen execution profile. Expose applicable model/account settings through the
profile's declared capabilities. Preview project scope, cost cap, next due time,
and readiness together. If that profile is unavailable, block with a repair path;
do not silently change backend. Existing schedules need a reviewable migration,
not retroactive inferred consent. Batch schedules retain their own API semantics.

**Acceptance:** Two installed profiles cannot make a saved schedule change backend
when ordering changes. Disabling its profile creates a visible unavailable state.
Saved versus executable versus actually running remain distinct.

**Related readiness issue:** Enabled/Next due appears in the record at
`views/Schedules.tsx:280–290`, while closed-app scheduling is in collapsed settings
at `306–312`. Put the observed execution condition beside Next due: “Runs while
Wanigan is open” or the observed background scheduler state. Daily/weekly/time
inputs can produce the existing cron representation; keep arbitrary expressions
intact in Advanced and preview with the main-owned timezone calculation. Do not
promise execution through sleep or other unobserved machine conditions.

### 5. Mission cannot reliably answer “what needs me first?”

**Source:** `src/main/companion.ts:30,42` orders by project need counts and recent
session creation. `views/MissionRoom.tsx:102` takes two items from those grouped
projects. The primary rows show project/state (`148–149`); shelf rows show
provider/state (`197–199`). The snapshot lacks task title, waiting duration and
attention detail (`src/shared/companion.ts:10–17`). The existing global attention
queue already preserves main's ranked order.

**Change:** All local attention surfaces consume the same ranked records. Every
row shows task identity, project, observed reason, age, and next action. Permission
and failure precede completed-turn updates. A shortened list has an explicit
“View all N” action. Preserve stable selection while the queue refreshes.

**Privacy boundary:** Local session titles/details must not automatically be added
to the companion model request. Keep the local attention view separate from the
bounded, backend-aware companion snapshot. The useful local overview requires no
paid model call.

**Acceptance:** A long-waiting permission in a quiet project ranks consistently
across Home, Fleet and the attention queue. Two same-provider sessions in the same
project remain distinguishable. Unknown state never becomes “working” or “done”.

### 6. Ordinary completed sessions have no coherent review destination

**Source:** Sessions splits Code, Timeline and Learning (`views/Sessions.tsx:1098–1134`).
`components/SessionGoalTrail.tsx:14,26` renders only for an existing goal. Review's
empty state asks for a new goal (`views/Control.tsx:453,463–466`); command checks
live separately in Git (`views/Git.tsx:669–671`).

**Change:** Offer “Review work” for an ordinary session. Bring its recorded final
output, known baseline/worktree, changes, relevant checks, and unresolved gaps into
one evidence reader. Existing goals link to that reader. A session does not need
a four-phase goal retroactively created to inspect its work.

**Acceptance:** A finished-turn item reaches changes and relevant checks within
two deliberate actions. “Turn finished”, “Checks passed” and “Accepted by you” are
different facts. A check run against a different checkout or revision cannot
silently certify the selected work. Review does not merge, push, or revert.

### 7. History navigation can start work instead of opening it

**Source:** Recent row activation invokes `sessions.create` with a resume handle
(`views/Sessions.tsx:403–415,788–792`). Archive search does exist, but palette hits
open Settings → Privacy & data → Search transcripts (`App.tsx:1158–1163`). The
archive reader uses raw session identity and oldest-first output
(`views/Settings.tsx:5219–5224,5236–5241`). Recent is globally capped before project
filtering (`src/main/sessions.ts:1884–1886`; `views/Sessions.tsx:274–275`).

**Change:** Put Live and History beside each other in Sessions. Opening history
reads only. Show the latest recorded work, project, title, provider and evidence
links; make Resume an explicit action. Preserve exact conversation handles and
honest unsupported cases. Apply project filters before bounded pagination in main.
Settings keeps retention/privacy controls, not the primary work reader.

**Acceptance:** Opening any history or search result launches zero processes.
Find an older project conversation despite more than 40 newer conversations in
other projects. Resume reopens the exact selected conversation where supported.

### 8. The shell loses context between work areas

**Source:** `App.tsx:595–598` clears `spaceId` when entering most other areas.
`components/SpaceNavigation.tsx:114–115` always opens an area's first tab. Project
selection from another area can redirect to Mission (`App.tsx:1226–1228`). Some
project-scoped views still receive `projectId` while the header says All spaces.

**Change:** Separate remembered project, visible scope, area and destination.
Global Fleet can explicitly say “All projects” without destroying the remembered
project. Returning to Projects restores its last destination and view state.
Project-scoped actions always show their actual destination project. Explicit
deep links override remembered state only for that navigation.

**Acceptance:** Project A → Changes/file X → Fleet → Projects restores A, Changes
and file X. A preserved composer draft stays attached to the same session.
Keyboard routes, palette and pointer routes use the same state transition.

### 9. Visible labels and search identities disagree

**Source:** `spaceLabel` calls Git “Changes” (`src/shared/spaces.ts:18`), but the
palette indexes the legacy routes (`App.tsx:1097–1104`; `src/shared/routes.ts:31`).
Live rename writes `displayTitle` (`src/main/sessions.ts:1983`) and Sessions shows
it (`views/Sessions.tsx:617`); the palette uses `s.title` (`App.tsx:1116,1121`).

**Change:** One canonical display-name helper for sessions; one destination table
for visible labels, aliases, grouping and keywords. Keep opaque IDs and existing
shortcuts stable. Search both the user's title and useful operational metadata.

**Acceptance:** Every visible destination label finds itself in the palette.
Rename a session to a unique phrase and immediately find that exact session.
Legacy names remain searchable aliases during the transition.

### 10. The destination list behaves visually like an overlay but not like one for focus

**Source:** `.mission-shell .sidebar` is positioned over content
(`styles/mission.css:15`). The conditional nav at `App.tsx:1312–1366` does not
use the existing dialog helper. Route activation unmounts its button at `1319`.

**Change:** Use one navigation pattern at a time. A pinned desktop rail is normal
document navigation. At compact widths its modal version must focus the selected
route on open, contain focus, dismiss with Escape, and return focus to its opener
or the destination heading. Do not remove the established terminal key ownership.

**Acceptance:** Keyboard-only open/select/close works at every supported window
width. No focus moves behind an overlay; no route selection strands focus on
`body`. Verify this in Electron, not solely by scanning ARIA attributes.

### 11. The launcher's order favors configuration over the task

**Source and screenshot:** The launch summary is useful and already implemented.
The first-message input follows the launch controls (`components/NewSessionDialog.tsx:1028–1032`),
starts as local empty state (`136`), and is destroyed when the dialog closes
(`views/Sessions.tsx:1182–1185`).

**Change:** Lead with “What should the agent do?” and the selected project. Show
agent/account, workspace, permissions and any cost-relevant settings in a compact
resolved summary. Advanced tuning expands when needed. Save unfinished task text
per project with an explicit discard action, using established draft patterns.
Credential inputs never become general persisted renderer draft state.

**Acceptance:** Closing to inspect a file and reopening preserves the draft.
Established safe defaults allow one deliberate launch submission. Profile changes
refresh all capability-dependent controls and the summary before launch.

### 12. Home's visual hierarchy delays the useful work

**Runtime observation:** In the 1440×900 captures, the Mission stage measures
524.19 CSS pixels. The project shelf bottom is 1106.47 while the workspace ends at
824. Setup actions are below the initial viewport. At 960×760 the scene still
dominates the captured screen. This is normal scrolling, not a clipping defect.

**Source:** Non-Mission shell tokens reserve 68px header + 44px route strip + 76px
footer (`index.css:38–42`), before attention, page heading or composer. That is a
nominal 188px stack; actual occupied geometry varies by view and breakpoint.

**Change:** Keep a compact, expressive companion on working screens. Put Needs
attention and Continue working at the top of Home. First-run Home puts setup
there instead. Retain the large companion scene as a deliberate companion view.
Consolidate global navigation into one quiet rail and one context header, subject
to design approval; avoid stacking a rail, dock and duplicate navigation band.

**Acceptance:** At 1280×800, the leading attention action or first setup step is
visible without scrolling. At the supported 960×560 minimum, navigation and the
primary action remain reachable. Terminal space is measured, not claimed from
token arithmetic. Test long names, failures, drafts and populated lists.

## Five additional opportunities after the core workflow

These belong behind the first wave, but matter to a complete product pass.

### Agent setup should answer readiness in one place

Settings separates runtimes, accounts, packs and API keys
(`views/Settings.tsx:817–835,927–1008`). Runtime rows show missing paths without a
coherent repair journey; sign-in chooses the first project and installed harness
profile (`3753–3764`). A connection record should lead with agent, account,
installation/authentication evidence, supported modes and the next useful action.
Show detailed harness/backend/configuration data in the inspector. Preview where
sign-in will open. Preserve exact manifest and executable trust disclosures at
their separate consent decisions. Unknown authentication stays unknown.

Acceptance: identify why an agent cannot start and the next action from one
record. Shared runtimes must not read as five separate installations.

### Name context and learning settings by what they control

The standalone Context page covers session inputs (`views/Context.tsx:659`),
while Learning has another Context destination containing global learning policy
(`views/Learning.tsx:2818–2907`). Settings search does not index those controls
(`views/Settings.tsx:75–101`). Use “Session context” for the files/briefing preview
and “Learning settings” for collection/consolidation/model-assistance policy.
Search and deep links must carry the selected project/provider and reach the
exact control. Claude-only predictions identify their scope before the report.

Acceptance: “pause learning”, “briefing budget” and “model assistance” each find
their controls; two unrelated destinations do not share the bare Context label.

### Knowledge approval should explain the effect

Teach defaults source to the first provider (`views/Learning.tsx:1341–1343`) and
asks for Scope/Kind/Source profile (`1363–1373`). Candidate rows share application
language and provider targeting (`1708–1731`) although only some kinds have Apply
(`1737`). Lead with what changes: future briefing context, approved instruction,
or a proposed file write. Human authorship must not be attributed to an arbitrary
provider. Keep canonical approval and applying a projection distinct.

Acceptance: memory shows the future-context effect; instructions/rules/skills
show the destination and exact diff before Apply; feedback states what is active
now. No redesign broadens automatic promotion or cross-backend semantic access.

### Spending limits need their actual workload in the label

Settings labels a batch-specific limit “Maximum estimated cost per run” and
confirms broadly that “Runs” above it will be blocked
(`views/Settings.tsx:1031–1059`). Schedules use a separate fixed per-repository
budget (`views/Schedules.tsx:68–76`; `src/main/index.ts:1021`). Name the former
“Batch submission limit” and show distinct links to goal, schedule and learning
limits. Zero should say “No batch submission limit”. A directory of limits is
useful; a fictional global cap is not.

Acceptance: every spending field, confirmation and execution preview names the
workload and unit governed by its actual enforcement.

### Empty states should perform the next step

Context's no-project state offers “Check for projects” while telling the user to
add one elsewhere (`views/Context.tsx:478–512`). Learning's initial overview gives
next steps as prose (`views/Learning.tsx:748–762`). Replace these detours with
scoped Add project / Start session / Teach a preference actions. Read failures
offer a local retry rather than requiring navigation or a full view reload.

Acceptance: create the missing prerequisite and return to the original surface;
failed reads never erase drafts or appear as empty stores.

## Three possible directions

| Direction | What changes | Benefit | Trade-off |
| --- | --- | --- | --- |
| Repair the current shell | Fix truth states, names, scope and focus; keep layout | Lowest migration cost | Home and review remain fragmented |
| **Work-centered desktop — recommended** | The repairs plus actionable Home, remembered project workbench, session review/history and one stable navigation model | Connects daily supervision end to end | Requires deliberate navigation/state migration |
| Conversation-centered app | Companion conversation becomes the primary router | Most conversational experience | Routine local facts risk being hidden behind model interaction; difficult to scan parallel work |

The recommended design keeps direct manipulation and a local overview available
at all times. The companion provides interpretation and personality; requesting a
model answer remains an explicit, separately billed action.

## Proposed navigation and surface responsibilities

| Area | Primary job | Secondary destinations |
| --- | --- | --- |
| Home | Act on what needs you; continue recent work | First-run readiness, optional companion conversation |
| Projects | Work within the selected repository | Sessions (Live/History), Board, Changes, Context |
| Fleet | Supervise all active work | Activity, account limits, recorded usage/insights |
| Review | Make decisions with evidence | Session reviews and existing goal reviews |
| Knowledge | Inspect and approve future context | Learning, Skills, Scout, Plugins |
| Automation | Schedule and inspect unattended work | Runs, Schedules, Batches |
| Settings | Configure the application | Appearance, agent connections, privacy, retention |

These are presentation groups over existing route identities, not a request to
merge backend stores or rewrite every view. Automation gets a visible route.
Global and project scopes are named explicitly. No default route depends on a
paid companion connection.

The full shell retains a labeled New session action, Search and the existing
deliberate Halt control. The Home concept concentrates on attention and inspection;
it does not yet depict those global controls or the other area's full pages.
Settings remains directly reachable. A compact navigation mode must have a visible
way back, and existing keyboard routes keep their meanings.

## Visual direction

Preserve Wanigan's cool slate and ice-blue identity. Existing dark palette anchors
are canvas `#171e24`, chrome `#141b21`, raised surface `#202930`, primary text
`#f1f5f8`, secondary text `#c5cfd7`, and action accent `#a6d9f8`. Light mode continues
to use the existing semantic token pairs. These are inherited source tokens, not
a claim that every proposed composition has already passed contrast checks.

Use the native system UI face for navigation and work identity; monospace belongs
to commands, diffs and code. Give task names more weight than provider names.
Left-align operational reading. Group peer work into scan-friendly rows; give the
selected evidence reader space rather than framing every fact as another card.
Keep the orb as the one expressive element. Show status in words with an icon;
color reinforces it. Preserve motion-off and reduced-transparency behavior.

The accompanying concept is **fictional example work**, not a screenshot of a
running agent. It explores work hierarchy, task selection and compact companion
placement. It is not production code or an approved final design.

## Delivery sequence

### Wave 1: make the existing interface dependable

Fix findings 1–3 and 8–10: truthful change reads, durable check observation,
readiness refresh, remembered scope/destination, shared labels and focus behavior.
These are bounded changes that improve the current layout immediately.
Also clarify current schedule execution policy and the batch-only spend label;
pinning schedule execution identity follows in Wave 4.

Reuse a pure shared session identity helper and a pure navigation transition
model. Use shared tests for names/routes/state transitions; targeted renderer
probes cover async reads and focus. Keep UI code out of provider selection logic.

### Wave 2: give attention and launch a clear shape

Build Home from local ranked attention plus continuation records. Move the
companion scene to deliberate use; implement the task-first launcher and draft
retention. Introduce the approved navigation shell using the same route model.
No automatic launches, assistant calls or background semantic summaries.

### Wave 3: connect session, review and history

Extract the transcript reader from Settings into a reusable read-only surface.
Add main-side bounded project-filtered pagination. Add a session review model that
composes existing session, baseline, change and check evidence. Preserve all IDs
and keep nullable/unknown data explicit. New persistent relationships are additive.

### Wave 4: make unattended work reviewable before it runs

Add execution profile selection/preview to Schedules with capability validation
in main and a review path for existing schedules. Carry identity and explicit
failure recovery into Runs. Improve knowledge review around effect, target and
undo without changing consent or auto-promotion boundaries.

## How to establish whether the improvement is real

Use the same authored fixture and same window sizes before and after. Record task
time, wrong destinations, backtracks and accidental side effects. Distinguish
automation checks from observations of a person using the app.

| Task | Baseline evidence | Acceptance target |
| --- | --- | --- |
| Find the most urgent of 12 sessions across 4 projects | Source shows inconsistent Mission ranking | One ranked list, exact task identified, no hidden uncategorized overflow |
| Return to project A's selected change after checking Fleet | Current transition clears scope/returns to first tab | One area activation restores project, destination and selection |
| Find a renamed session | Palette omits display title | Unique title resolves to the intended session |
| Inspect failed change read | Current UI drops `unreadable` | Failure explicit; no false clean-state claim |
| Leave and return during checks | Run history has no completion observation | Completion appears without reload or rerun |
| First launch after folder selection | Checklist snapshot is not invalidated | Next action updates immediately and is visible |
| Read a previous conversation | Recent invokes resume; archive reader is in Settings | Read-only opening, then one explicit exact Resume action |
| Review an ordinary finished session | Evidence spread over session/goal/Git surfaces | Changes and relevant checks within two actions |
| Save an unattended task | Provider chosen later by registry order | Named execution identity reviewed and persisted |

Measure human task times before assigning a multiplier. A credible gain would
combine fewer backtracks, fewer mistaken decisions and lower recovery effort,
not just a faster screenshot or a smaller number of pixels.

## Implementation verification contract

Every shipped UI slice needs before/after captures in both themes, current source
hashes, interaction checks at 1440×900, 1280×800, 960×560 and a wider workspace,
keyboard focus review, reduced-motion checks, and fresh `npm test` plus
`git diff --check`. Use the existing style gate; baselines only ratchet down.

Keep terminal mounts, drafts, exact conversation handles and live processes
stable during navigation. Never quit the user's live app to install a visual
change. Report source changes, tested build, staged install and running version
as separate facts.

Design approval remains pending. The next decision is whether to implement the
recommended work-centered desktop, beginning with Wave 1, or retain the current
shell and take the repair-only path.
