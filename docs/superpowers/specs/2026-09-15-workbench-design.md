# Work-centered desktop implementation

Approved September 15, 2026 by the user's “continue” response to the proposed
direction. The evidence and alternatives are in
[the desktop deep dive](../../research/2026-09-15-desktop-ux-deep-dive.md).

## Outcome

Home leads with locally observed work needing attention and a selected task's
next action. A stable navigation rail groups the existing routes and preserves
the last destination and project. Sessions gain a read-first return path and a
review path. Setup, verification and change evidence report their real state.
Unattended schedules disclose and preserve their execution profile.

The companion remains available through an explicit Home action, with its large
scene and controls intact. Local task titles and attention details do not expand
the data sent to its model. All model calls and launches remain deliberate.

## Ordered implementation checklist

- [x] Evidence: preserve typed unreadable/attributed change results, reject stale
      cross-project responses, show loading/failure/stale states and safe retry.
- [x] Verification: observe active durable review runs after navigation without
      resetting the editable command recipe or rerunning commands.
- [x] Navigation: stable six-area rail plus Settings, remembered area destination
      and project, one label/alias vocabulary, display-title search, compact
      dialog focus/Escape behavior and unchanged terminal keyboard ownership.
- [x] Home: local ordered attention, named sessions, task inspector, explicit
      observed/unknown states, first-run setup above the fold, continuation links,
      compact companion with deliberate access to the full scene.
- [x] Setup: invalidate readiness when projects/sessions change and when returning
      from external setup; preserve canceled/error states.
- [x] Launch: lead with task, retain unfinished per-project prompt, keep resolved
      permissions/account/worktree summary visible and clear draft after success.
- [x] Return/review: read-only conversation inspection and explicit exact resume;
      ordinary sessions reach changes/checks without requiring goal creation.
- [x] Scheduling: explicit provider identity for newly created or reviewed
      headless schedules; preserved honest legacy behavior; clear batch-only
      spending label and execution-readiness text.
- [x] Verify all changed workflows with isolated fixtures, both themes, compact
      and wide sizes; run `npm test` and `git diff --check`; record source/build
      identity and before/after evidence.

## Boundaries and state

Reuse existing SQLite records, route IDs, shared primitives, semantic tokens,
typed preload calls, and exact conversation IDs. UI state stores contain only
navigation/selection/draft presentation state. Main validates all privileged
inputs. Schedule identity uses the existing JSON payload compatibly. No user
configuration is written to repositories and no live Wanigan process is stopped.

Reading a previous conversation, selecting work or opening a review must start
zero processes and issue zero model calls. A finished turn is not accepted work.
Missing attribution or failed reads cannot count as a clean change set. Tests
from another checkout must not be presented as proof of a session's changes.

## Verification

Use the current-build baseline in `docs/visuals/ux-audit-2026-09-15`. Add focused
probes that assert the previously reproduced symptoms, run them before and after
fixes, and retain explicit fixture provenance. Test stale async responses,
navigation during active checks, project switching with drafts, long session
names, empty/error states, and compact focus behavior. The full required eight
test stages remain the final handoff gate.

The referenced writing-plans skill was not available in the installed skill
directories; this checklist records the implementation sequence directly. This
does not introduce another approval gate after the user's approved direction.

Verified implementation and before/after captures: [evidence index](../../visuals/workbench-2026-09-15/README.md). The full eight-stage repository suite passed with 66 shared tests and 1,625 smoke assertions.
