# Review workspace · desktop redesign

Review now places a selected task beside the evidence needed to assess it. A
searchable goal directory leads into the objective, recorded task counts,
reported spending, and a keyboard-accessible task journey. The default selection
prefers a ready human Review task, then a failed, canceled, running, or ready
task. It never starts work merely because a task is selected.

Acceptance checks sit above goal-wide evidence. Proof records name the task
that produced them, and their attribution links open that task. Handoffs collects
checkpoints, recorded recovery identities, and active file claims; Activity shows
recent operational signals. The counts describe recorded tasks and evidence,
not an estimated percentage of the goal. Spending retains its partial or
unreported qualification.

The selected task keeps its existing actions: isolated launch, review gate,
checkpoint, path claim, completion, approval, requested changes, rejection, and
retry. Session links now open the recorded session directly. Completed tasks
retain evidence without a row of disabled editing fields. Review notes open on
request and remain associated with their task. The initial 1440 × 1000 fixture
shows Approve and the acceptance checks together without scrolling.

Goals, filters, task selection, notes, claim drafts, and the selected evidence
area are remembered during navigation. Goal creation keeps its draft when its
sheet is closed; successful creation updates the goal hash so returning from
another page retains the new selection. Request revisions discard late goal
reads, and a selected goal's content clears immediately when another is chosen.
An action finishing after navigation refreshes only its own still-selected goal.
A failed refresh disables task decisions and autopilot actions until evidence
can be read again.

Execution and spending remain available beneath the task. Arming autopilot
still needs its existing explicit confirmation, provider choice, and spend cap;
disarming does not claim to stop a running session. Queued tasks do not offer a
second launch. Canceling a live task retains its stop confirmation and reports
the main process's receipt. The event inbox and model outcomes remain under
Events & model evidence, with the event's project now visible in the form.

All presentation uses the shared frame, status primitives, controls, and tokens.
The surface stylesheet has no literal font sizes, reducing its style allowance
from eleven to zero. Goal, task, sheet, and evidence transitions follow the
existing motion setting: Off disables them, Auto respects the OS preference,
and Full remains the deliberate override. The existing companion is unchanged.

## Screenshots

| View | Dark | Light |
| --- | --- | --- |
| Before · Review | [Dark](before/review-dark.png) | [Light](before/review-light.png) |
| After · Review | [Dark](after/review-dark.png) | [Light](after/review-light.png) |
| Decision and proof | [Dark](after/decision-dark.png) | [Light](after/decision-light.png) |
| Blocked task | [Dark](after/blocked-dark.png) | [Light](after/blocked-light.png) |
| Handoffs | [Dark](after/handoffs-dark.png) | [Light](after/handoffs-light.png) |
| Activity | [Dark](after/activity-dark.png) | [Light](after/activity-light.png) |
| Execution and spending | [Dark](after/execution-dark.png) | [Light](after/execution-light.png) |
| Events and outcomes | [Dark](after/events-dark.png) | [Light](after/events-light.png) |
| Before · New goal | [Dark](before/new-goal-dark.png) | [Light](before/new-goal-light.png) |
| After · New goal | [Dark](after/new-goal-dark.png) | [Light](after/new-goal-light.png) |
| Task graph editor | [Dark](after/task-graph-dark.png) | [Light](after/task-graph-light.png) |
| Empty goals | [Dark](after/empty-dark.png) | [Light](after/empty-light.png) |
| Unavailable goals | [Dark](after/unavailable-dark.png) | [Light](after/unavailable-light.png) |
| Narrow desktop | [Dark](after/review-narrow-dark.png) | [Light](after/review-narrow-light.png) |
| Narrow evidence | [Dark](after/evidence-narrow-dark.png) | [Light](after/evidence-narrow-light.png) |
| Narrow new goal | [Dark](after/new-goal-narrow-dark.png) | [Light](after/new-goal-narrow-light.png) |

Captures use the actual renderer in isolated Electron, with synthetic records
and recording services. Regular captures use a 1440 × 1000 window and narrow
captures use 820 × 960. These are UI evidence, not production session outcomes.
The probe never launches a real agent, writes project files, or spends tokens.

## Verification

`node scripts/probe-review-workspace.mjs` covers first-screen decisions,
keyboard and attribution navigation, scoped filters, draft and selection
retention, delayed reads and actions, queued launch protection, typed task
operations, failures and retries, autopilot and live-cancellation confirmation,
event scope, partial cost reporting, creation, motion preferences, narrow
layout, and empty/unavailable states. [Results](after/verification.json) include
renderer errors and measured widths.

The obsolete smoke assertion that pinned the former prerequisite sentence's
private JSX was retired. The renderer probe checks the replacement prerequisite
navigation, status and focus directly; the main-process graph validation and
execution checks remain in the required suite.

The final required `npm test` passed all five stages, including **1,559 offline
smoke assertions** with no failures. The renderer probe passed **11 interaction
groups**, with no renderer errors and no horizontal page overflow at the narrow
desktop size. `git diff --check` passed. Screenshots were visually inspected in
both themes, including decisions, evidence, the graph editor, event/model
records, and unavailable states.

Both Mac architectures passed strict sealed ad-hoc signature, hardened-fuse,
ASAR-integrity, and executable PTY-helper verification, with the same renderer
hash. The graceful local installer replaced the arm64 app and reopened it as
PID 358. The installed archive matches the verified package; hashes are in
[build verification](build-verification.json).

Native inspection confirmed the new Review heading, search, project filter,
empty-goal state, and New goal sheet in `/Applications/Wanigan.app`. The sheet
focused Title, named every field, and disabled Create while required inputs were
missing. It was closed without creating a record, and the app was left on
Review. The live database currently has no goals; populated captures therefore
use the isolated fixtures described above. Before installation the installed
process had only Electron helper descendants and no agent process beneath it.
