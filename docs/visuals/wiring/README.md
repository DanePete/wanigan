# Built, and now reachable

The September inventory found work that was finished in the main process and
could not be reached by a person. Each item below had a working, tested
function and no caller. `scripts/probe-wiring.mjs` renders the real renderer
with synthetic services (no real agent calls) and asserts what a reader sees.
Before is `feat/batch2-core` (`e259890`) built in a detached worktree; after
is this branch, with the same fixtures.

## Transcript recall, per project

`wanigan_recall_transcripts` was listed only to projects whose recall flag was
set, and nothing could set it. Settings › Connections now has one switch per
project under Wanigan's own MCP server. It says when the server is off, since
that makes the switch inert, and it says what the tool returns.

| | Dark | Light |
|---|---|---|
| Before | ![](before/recall-dark.png) | ![](before/recall-light.png) |
| After · platform switched on | ![](after/recall-dark.png) | ![](after/recall-light.png) |

## Attachment retention

The panel said "This screen cannot yet measure or reclaim it". It now previews
what a window would remove and why every other directory stays. Switching on
waits for a confirmation, and every pass is reported from what was measured.

| | Dark | Light |
|---|---|---|
| Before | ![](before/retention-dark.png) | ![](before/retention-light.png) |
| After · preview, nothing deleted | ![](after/retention-preview-dark.png) | ![](after/retention-preview-light.png) |
| After · confirmation | ![](after/retention-confirm-dark.png) | ![](after/retention-confirm-light.png) |
| After · on, with the measured pass | ![](after/retention-on-dark.png) | ![](after/retention-on-light.png) |

## A reached budget holds unattended work, and a person is told

Queued headless runs, scheduled batches and autopilot goal tasks now wait
while their project's budget, or the global one, is over. A session someone
starts is not held, and the launch dialog says the project is over.

| | Dark | Light |
|---|---|---|
| Before · launch dialog | ![](before/launch-budget-dark.png) | ![](before/launch-budget-light.png) |
| After · launch dialog | ![](after/launch-budget-dark.png) | ![](after/launch-budget-light.png) |
| Before · Insights | ![](before/insights-budget-dark.png) | ![](before/insights-budget-light.png) |
| After · Insights | ![](after/insights-budget-dark.png) | ![](after/insights-budget-light.png) |

## Contradictions in the knowledge library

Two selected items can be recorded as contradicting each other, with a
reason. Both leave every briefing until one is kept from either item's
Evidence, and the other is then retired with the reason.

| | Dark | Light |
|---|---|---|
| Before · two selected | ![](before/knowledge-select-dark.png) | ![](before/knowledge-select-light.png) |
| After · two selected | ![](after/knowledge-select-dark.png) | ![](after/knowledge-select-light.png) |
| After · recording it | ![](after/knowledge-record-dark.png) | ![](after/knowledge-record-light.png) |
| After · resolving it from Evidence | ![](after/knowledge-resolve-dark.png) | ![](after/knowledge-resolve-light.png) |

## Outcome evidence where the provider is chosen

Goal outcomes were stored for a router that never existed. The recorded
outcomes for the task kind now sit under "Provider for next task", as counts
Wanigan picks nothing from.

| | Dark | Light |
|---|---|---|
| Before | ![](before/control-outcomes-dark.png) | ![](before/control-outcomes-light.png) |
| After | ![](after/control-outcomes-dark.png) | ![](after/control-outcomes-light.png) |

## A finished run's turns, from Recent

The Turns tab and Timeline rendered only for live sessions. Each Recent row
now opens its run's turns, diffs and timeline without resuming it.

| | Dark | Light |
|---|---|---|
| Before · Recent | ![](before/recent-dark.png) | ![](before/recent-light.png) |
| After · Recent, row hovered | ![](after/recent-dark.png) | ![](after/recent-light.png) |
| After · the run's turn 2 | ![](after/past-turns-dark.png) | ![](after/past-turns-light.png) |

## What looking at them changed

The first capture found four things. All four are fixed in the commit that adds
these screenshots:

- the retention preview read "With a 30 days window";
- a finished run's Code panel offered to "follow" an agent that is not running;
- the retention panel stated the same pass twice;
- the outcome evidence sat outside the inset of the card it describes.

Not captured: the queued-session refusal and the interrupted-transcript
archive have no UI, and smoke20 covers both.
