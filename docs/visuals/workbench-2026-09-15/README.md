# Desktop workbench implementation evidence

The desktop now starts with work needing attention, keeps navigation and project
context stable, retains launch drafts, and separates reading a saved conversation
from resuming it. Ordinary sessions can open changes and recorded checks together.
Schedules disclose and pin the chosen agent profile.

The approved direction is recorded in the
[implementation checklist](../../superpowers/specs/2026-09-15-workbench-design.md)
and the original [deep dive](../../research/2026-09-15-desktop-ux-deep-dive.md).

## Before and after

Each pair links to dark and light captures. The original app baseline is in
`../ux-audit-2026-09-15/current/`; focused fixtures below reproduce states a fresh
profile cannot naturally show without running agents.

| Workflow | Before | After |
| --- | --- | --- |
| Home, real app | [dark](../ux-audit-2026-09-15/current/dark/mission.png), [light](../ux-audit-2026-09-15/current/light/mission.png) | [dark](real-app/dark/mission.png), [light](real-app/light/mission.png) |
| Home with attention | Original Home above did not display local named attention | [dark](home/home-attention-wide-dark.png), [light](home/home-attention-wide-light.png) |
| Navigation and Sessions | [dark](../ux-audit-2026-09-15/current/dark/sessions.png), [light](../ux-audit-2026-09-15/current/light/sessions.png) | [dark](history/after/sessions-dark.png), [light](history/after/sessions-light.png) |
| Task-first launch | [dark](../ux-audit-2026-09-15/current/dark/overlay-new-session.png), [light](../ux-audit-2026-09-15/current/light/overlay-new-session.png) | [dark](home/launch-task-first-wide-dark.png), [light](home/launch-task-first-wide-light.png) |
| Unreadable changes | [dark](evidence/before/changes-unavailable-dark.png), [light](evidence/before/changes-unavailable-light.png) | [dark](evidence/after/changes-unavailable-dark.png), [light](evidence/after/changes-unavailable-light.png) |
| Returning to active checks | [dark](evidence/before/review-completed-dark.png), [light](evidence/before/review-completed-light.png) | [dark](evidence/after/review-completed-dark.png), [light](evidence/after/review-completed-light.png) |
| Recent conversation | [dark](history/before/recent-open-dark.png), [light](history/before/recent-open-light.png) | [dark](history/after/conversation-reader-dark.png), [light](history/after/conversation-reader-light.png) |
| Ordinary session review | No combined review destination | [dark](history/after/ordinary-session-review-dark.png), [light](history/after/ordinary-session-review-light.png) |
| Schedule execution | [dark](../ux-audit-2026-09-15/implementation/schedules/before/selected-dark.png), [light](../ux-audit-2026-09-15/implementation/schedules/before/selected-light.png) | [dark](../ux-audit-2026-09-15/implementation/schedules/after/selected-dark.png), [light](../ux-audit-2026-09-15/implementation/schedules/after/selected-light.png) |

## Verification and provenance

The final `npm test` run passed all eight stages: typecheck, 66 shared tests,
renderer style, dead code, lint, package hooks, local install, and 1,625 offline
main-process assertions. `git diff --check` passed. The
[test log](repository-test.log) and [source/build manifest](source-manifest.json)
identify the verified tree. The five focused renderer probes passed 45 grouped
checks; the real main/preload sweep passed 11 checks with zero renderer errors.

- `scripts/shots.mjs` uses real main/preload in a temporary Electron profile.
  Its [result](real-app/verification.json) covers all 17 destinations in both
  themes, compact captures and 11 interaction checks. It creates only local
  review records, with an assertion that creation launches no agent.
- `scripts/probe-workbench-home.mjs` uses a synthetic bridge for ranked attention,
  stale reads, keyboard focus, per-project drafts, delayed/failed launch responses,
  and first-run readiness. [Results](home/verification.json).
- `scripts/probe-workbench-navigation.mjs` verifies project/route return, terminal
  retention and shortcut ownership, display-title search, and compact dialog
  focus/Escape. [Results](navigation/verification.json).
- `scripts/probe-workbench-evidence.mjs` verifies loading, unavailable, stale and
  unattributed change reads; async scope isolation; and durable review polling.
  [Before](evidence/before/verification.json), [after](evidence/after/verification.json).
- `scripts/probe-session-history.mjs` verifies read-only Recent, long and older
  archive access, explicit exact resume, honest review scope, and compact terminal
  space. [Before](history/before/verification.json), [after](history/after/verification.json).
- `scripts/probe-schedule-execution.mjs` verifies explicit profile selection,
  legacy review, unavailable/changed profiles, batch semantics and deliberate
  background scheduling. [Results](../ux-audit-2026-09-15/implementation/schedules/after/verification.json).

Fixture screenshots are visibly labeled. They do not establish real provider,
PTY, Git or scheduler behavior. The required repository suite separately exercises
shared contracts, packaging and the offline main process, including project
filtering before the Recent limit and schedule fingerprint validation.

The `home/before/` reports preserve three regression failures found during
implementation: terminal autofocus escaping the launch dialog, in-flight launch
completion erasing newer drafts, and an unassigned draft disappearing when its
first project was selected. `diagnostics/` retains intermediate captures; current
verification JSON files identify the final results.

The active installed application was not replaced or restarted. Existing user
permission-control changes were retained. No live session was interrupted and no
production agent/model call was made by the UI probes. Launch drafts are held
in memory for this window, not saved across an application quit.

The changes improve concrete workflows; no measured claim of tenfold productivity
is made. Project checks still run in the project checkout, and the session review
screen explicitly states when that differs from an isolated session worktree.
