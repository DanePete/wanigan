# Schedules workspace

Schedules now opens on an agenda and its selected record. Enabled schedules are
ordered by their next due time; paused schedules follow. Search and filters make
larger lists manageable. The reader brings cadence, future windows, repository
scope and recorded outcomes together, with a short reveal when selection changes.

New schedule and Edit open an inline composer beside the agenda. Cron previews
come from the existing main-process API. A new headless schedule defaults to one
project; running across every registered repository requires an explicit choice.
The batch picker accepts saved batch runs only and distinguishes the previous
recorded cost from an estimate. Saving a new schedule enables it.

Drafts and pending requests survive page navigation in the same window. Cancel
edit discards that edit; Back to schedules retains a new draft. Unsaved drafts do
not survive an app restart. Pending actions cannot be submitted twice, late
history and preview responses cannot replace the current selection, and failed
list reads leave cached records readable while disabling schedule mutations.

Queued, running, failed, unknown and unsupported legacy records retain their
distinct meanings. A manual tick reports queued occurrences rather than claiming
successful execution. Delete still needs confirmation. The background scheduler
and manual tick remain deliberate actions inside Scheduler settings. No provider
call or work launch occurs from viewing, searching or editing the page.

The existing scheduler, database and preload contract are unchanged. Both themes
use the shared design tokens; selection motion follows the existing motion
settings. The miniature companion retains the same GPU runtime.

## Captures

Actual Electron captures use fictional projects and deterministic schedule bridge
responses. Before captures load the previously staged planning build; after
captures load the newly packaged Apple silicon renderer. No real scheduled work
or background daemon is changed by these probes.

| View | Dark | Light |
| --- | --- | --- |
| Previous page | [Before](before/schedules-dark.png) | [Before](before/schedules-light.png) |
| Previous saved list | [Before](before/saved-schedules-dark.png) | [Before](before/saved-schedules-light.png) |
| Agenda and selected schedule | [After](after/agenda-dark.png) | [After](after/agenda-light.png) |
| Saved batch | [Batch](after/batch-dark.png) | [Batch](after/batch-light.png) |
| Unresolved repository scope | [Legacy](after/legacy-dark.png) | [Legacy](after/legacy-light.png) |
| Inline creation | [Create](after/create-dark.png) | [Create](after/create-light.png) |
| History failure | [History](after/history-error-dark.png) | [History](after/history-error-light.png) |
| Scheduler settings | [Settings](after/scheduler-settings-dark.png) | [Settings](after/scheduler-settings-light.png) |
| Narrow desktop | [960 px](after/agenda-960-dark.png) | [960 px](after/agenda-960-light.png) |
| Small window | [720 px](after/agenda-720-dark.png) | [720 px](after/agenda-720-light.png) |
| Confirmed empty list | [Empty](after/empty-dark.png) | [Empty](after/empty-light.png) |
| Unavailable list | [Error](after/read-error-dark.png) | [Error](after/read-error-light.png) |

## Verification

`npm test` passed all five required suites in the isolated build snapshot:
typecheck, renderer style, package hooks, local-install fixtures and **1,608 smoke
assertions, zero failures**. See [the test log](npm-test.log). The style baselines
for Schedules ratchet down to zero inline styles and zero literal font sizes.

The [packaged renderer probe](after/verification.json) covers selection, search,
batch filtering, explicit repository scope, draft persistence, pending requests
across navigation, failed saves, invalid cron, out-of-order history and preview
responses, pause locking, confirmed deletion, read failures, manual tick and
background setup. It checks both narrower widths for horizontal overflow and
verifies a zero-duration reader reveal with motion Off. Its mutations are fixtures;
the offline smoke suite supplies main-process scheduler coverage.

Both Apple silicon and Intel packages built and passed strict ad-hoc signature,
ASAR integrity, hardened Electron fuse and executable PTY-helper verification.
They contain the same renderer, and their GPU runtime hash matches the previous
verified build. See [package verification](build-verification.json) and
[the build log](package.log).

The bundles are staged at `release/schedules-workspace/mac-arm64/Wanigan.app`
and `release/schedules-workspace/mac/Wanigan.app`. They are **not installed**.
The existing app and its live Claude process were left running.

Builds and probes used an isolated source copy so concurrent rebuilds could not
replace renderer assets during capture. [Source hashes](source-manifest.json)
identify the tested snapshot and record contemporaneous working-tree differences
in unrelated test files. No commit or push was made.
