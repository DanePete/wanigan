# UI deep-dive evidence

This collection records the September 10 Mission room and Review pass.
The [research](../../research/2026-09-10-desktop-ui-primary-sources.md) covers the
full interface; the [audit](../../research/2026-09-10-ui-design-audit.md) separates
implemented changes from later design work.

## Compare the affected views

| View | Dark before | Dark after | Light before | Light after |
| --- | --- | --- | --- | --- |
| Mission room | [Before](before/dark/mission.png) | [After](after/dark/mission.png) | [Before](before/light/mission.png) | [After](after/light/mission.png) |
| Review, formerly Control | [Before](before/dark/control.png) | [After](after/dark/control.png) | [Before](before/light/control.png) | [After](after/light/control.png) |
| Board link naming | [Before](before/dark/board.png) | [After](after/dark/board.png) | [Before](before/light/board.png) | [After](after/light/board.png) |
| Scout link naming | [Before](before/dark/scout.png) | [After](after/dark/scout.png) | [Before](before/light/scout.png) | [After](after/light/scout.png) |
| Settings link naming | [Before](before/dark/settings.png) | [After](after/dark/settings.png) | [Before](before/light/settings.png) | [After](after/light/settings.png) |

The final three views have wording changes where they refer to Review. Their
structural redesign remains future work; their initial screenshots may not show
the particular link below the fold.

| Interaction | Dark | Light |
| --- | --- | --- |
| Companion appearance and play | [Open popover](after/dark/companion-controls.png) | [Open popover](after/light/companion-controls.png) |
| New goal | [Creation sheet](after/dark/overlay-new-goal.png) | [Creation sheet](after/light/overlay-new-goal.png) |
| Fire temperament | [Live render](after/companion-ember-dark.png) | [Live render](after/companion-ember-light.png) |

[Narrow Review](after/narrow/control.png) and
[narrow Mission room](after/narrow/mission.png) use a 960×760 window. The
narrow Review capture includes a second goal created by the UI verification.

## Scope and provenance

The before images are copies of the preceding real-main captures in
`../mission-room/real/`. After images come from the built Electron renderer,
real main process, and real preload API, launched with a separate temporary
profile. The screenshot script registers the actual repository and deliberately
creates local test goals and a learning candidate. These are test records,
not claims about the operator’s installed application. No model request or
agent session is launched by the verification.

The harness uses `scripts/electron-harness.mjs` to attach Playwright through its
documented test bootstrap before loading the application’s main process. This
verifies the real IPC and renderer behavior, not the normal production startup
handshake. The temporary test application closes after capture. It does not
quit, replace, install over, or modify the installed Wanigan application.

## Verified result

The final run, recorded at `2026-09-10T11:06:01.311Z`, captured all 17 destinations
in both themes plus overlays and six narrow views. It reported no page errors.
[Machine-readable results](after/verification.json) and the
[runtime log](after/runtime-log.txt) contain the recorded checks.

At 1440×900, in both themes, the Mission stage measured **421 CSS pixels** high.
The single-project shelf ended at y=648, inside the workspace’s y=824 boundary.
These are measurements of the captured one-project state, not a promise that
arbitrarily many projects or long conversations fit without scrolling.

The real UI verification passed these behaviors:

- Composer focus gives the companion an intentional gaze; explicit spin rotates
  the globe; temperament is retained; hiding the native window stops new GPU
  submissions and showing it resumes them.
- The companion popover fits within the window and closes with Escape.
- The selected goal appears beside its list and within the first half of the
  viewport. The creation sheet focuses Title, restores focus on Escape, and retains its draft
  on reopening. Initial/return focus and draft retention were exercised; a full
  screen-reader audit was not performed.
- A negative budget is rejected by the main process and displayed inside the
  sheet. Correcting it permits one goal to be created and selected. The count
  of running agent sessions remains zero.

The required `npm test` run passed all five stages, including **1,498 smoke
checks with zero failures**. `git diff --check` passed. The GPU solver and optical
pipeline were not changed in this pass; previous physical-field benchmarks are
in [the orb evidence](../mission-room/README.md), while this pass reran its
main/preload interaction checks.

## Reproduce

Use Node 22.23.2 from `.nvmrc`, then:

```sh
npm test
node scripts/shots.mjs --out docs/visuals/ui-deep-dive/after --light
git diff --check
```

`npm test` includes the build used by the screenshot runner. The final real UI
run exercises local creation only; it does not send a companion question,
launch an agent, arm autopilot, or run a project task.


## Populated and compact checks

The [two-project capture](fixtures/dark/mission.png) uses explicitly synthetic
bridge data in the real Electron renderer. Its fixtures verify project, Git,
and Context scope, motion off, all destination routes, and compact dock labels.
These are presentation checks; the real IPC creation flow is verified separately
above. [Fixture results](fixtures/verification.json) retain that distinction.

The compact layout is captured separately in
[dark](fixtures/mission-720-dark.png) and
[light](fixtures/mission-720-light.png) at 720×850. Its scene lighting changes
from horizontal to vertical to follow the stacked layout. The companion
popover fits within the viewport and dismisses with Escape in both themes.
[Compact results](fixtures/compact-verification.json) record this targeted pass.

```sh
node scripts/probe-mission-room.mjs docs/visuals/ui-deep-dive/fixtures
node scripts/probe-mission-room.mjs docs/visuals/ui-deep-dive/fixtures --compact-only
```
