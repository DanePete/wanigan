# Board workspace · desktop redesign

Board now fills the available desktop workspace with six compact task lanes,
search, project scope, and state filters. A selected task opens a right-side
sheet for its instructions, prerequisites, recorded session, and existing task
actions. This continues the [desktop direction](../desktop-workspaces/README.md).

Waiting dependencies have a lane of their own. Blocked tasks and failures remain
together, with failure details visible on the task. Closed contains completed
and canceled work, preserving each task's actual label. Parked tasks retain their
return dates. The goal graph remains the only task store.

Start, Retry, parking, and returning a task use the existing typed Control APIs.
Queued tasks cannot race the dispatcher, and a parked task must return before
Start becomes available. Project changes discard results from earlier reads;
failed refreshes retain readable records while disabling mutations. An open
sheet follows the selected task's latest record and removes actions if that
record disappears. Task selection and filtering make no agent or model calls.

The sheet uses the shared modal focus trap, Escape handling, and opener focus
restoration. Following a prerequisite focuses its new title. Search, state
filters, and the selected launch provider survive navigation. Lanes scroll
independently; at a narrower desktop width, horizontal overflow stays inside
the board. Only a task moving between observed lanes receives an arrival
animation. Sheet entrance and press feedback respect Off and system Reduce
Motion; Full remains the existing explicit override.

## Screenshots

| View | Before | After |
| --- | --- | --- |
| Board | [Dark](before/board-dark.png), [light](before/board-light.png) | [Dark](after/board-dark.png), [light](after/board-light.png) |
| Selected task | — | [Dark](after/task-detail-dark.png), [light](after/task-detail-light.png) |
| Narrow desktop | — | [Dark](after/board-narrow-dark.png), [light](after/board-narrow-light.png) |
| Narrow task sheet | — | [Dark](after/task-detail-narrow-dark.png), [light](after/task-detail-narrow-light.png) |

These are captures of the actual renderer in isolated Electron with synthetic
tasks and services, at 1440 × 1000 and 820 × 960 window sizes. They demonstrate
layout and interaction, not real agent performance or production operations.
The miniature companion uses the existing 3D renderer and fixture attention
state; this pass does not change its appearance or physics.

## Verification

`node scripts/probe-board-workspace.mjs` checks actual renderer interactions
against recording fixtures and writes [verification.json](after/verification.json).
No live agents, model calls, repositories, or production preferences are used.

The final renderer run passed 12 behavior groups with no renderer errors. It
covered task identity, focus and session navigation, queued and parked actions,
provider routing, rejected launches, delayed project reads and actions, stale
and removed records, remembered filters, motion preferences, narrow layout, and
entering/leaving the existing planner without making a model call. At 820px,
the page had no horizontal overflow; all six lanes remained reachable inside
the independently scrolling board. Both themes were visually inspected.

The required `npm test` passed all five stages, including **1,541 offline smoke
assertions**, with no failures. `git diff --check` also passed.

Both Mac architectures passed strict sealed ad-hoc signature, archive-integrity,
hardened-fuse, and executable PTY-helper verification. The arm64 bundle was
installed into `/Applications/Wanigan.app` through the graceful local installer
and relaunched. Its archive matches the verified build; both architectures
contain the same renderer. [Build evidence](build-verification.json) records
their hashes.

Native accessibility and screenshot inspection confirmed Board's new heading,
search, project filter, six state filters, and empty state in the installed app.
There were no running Wanigan-started sessions before installation. The live
Board currently contains zero recorded tasks, so populated task and action
verification used the isolated fixtures above. The app was left on Board with
Every project selected. Native inspection made no model calls or task changes.
