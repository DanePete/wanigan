# Launch pins, account carries, requested changes

Four changes on `feat/batch2-core` that share one probe
(`scripts/probe-core-batch.mjs`). Before is `feat/advanced-gaps` built in a
detached worktree; after is this branch; same synthetic fixtures, no real agent
calls.

## A repository's executable configuration is pinned

An agent CLI started in a repository runs some of that repository's own
configuration first: hooks, MCP server commands, helper commands, environment
overrides, permission defaults, git hooks and git config drivers. A commit, a
pull, or an agent working there can change any of it, and most of the agent-CLI
CVEs this year were that class.

Wanigan now reads those items — only what the repository controls, never the
user's own `~/.claude` — fingerprints each over its full value before anything
is redacted for display, and keeps the digests a launch was let through with.
The first launch pins the configuration and says it was pinned without review.
After that, a launch whose digest matches no pin is asked about:

- **New session dialog.** Each added, changed and removed item, with what it now
  runs; launch stays disabled until "I have read these changes" is ticked, and
  that exact digest travels with the launch. Main recomputes it and launches only
  on a match.
- **Context · Settings & hooks.** What the repository runs, whether its pin was
  reviewed or only taken at first launch, the change when it has moved, and
  "Accept this configuration", which records that it was read — not that it is
  safe.
- **Headless runs** are blocked on a change: there is nobody to read it.
- **Resume, a paired phone, any other launch** is refused with the reason, and
  pointed at the dialog or Context.

Smoke checks it against real repositories, including a hook command edited to
`curl … | sh`, a git hook written into `.git/hooks`, and `core.fsmonitor` set —
which also caught git answering `--worktree` exactly like `--local` and listing
every key twice.

| | Dark | Light |
|---|---|---|
| Before · launch dialog | ![](before/launch-dark.png) | ![](before/launch-light.png) |
| After · a changed configuration, itemised | ![](after/launch-review-dark.png) | ![](after/launch-review-light.png) |
| Before · Context settings | ![](before/context-config-dark.png) | ![](before/context-config-light.png) |
| After · Context, changed | ![](after/context-changed-dark.png) | ![](after/context-changed-light.png) |
| After · Context, accepted | ![](after/context-accepted-dark.png) | ![](after/context-accepted-light.png) |

## Continuing a running Codex conversation on another account

The resume after a handoff used to be refused. It is now allowed when the
conversation is readable from that account's home, and a running session is ended
first, only on a second press, because Codex cannot write one conversation from two
processes. The first press ends nothing and says why.

| | Dark | Light |
|---|---|---|
| Before | ![](before/handoff-dark.png) | ![](before/handoff-light.png) |
| After · first press | ![](after/handoff-dark.png) | ![](after/handoff-light.png) |

## Why a session needs you

Every attention verdict now carries its reason: the rule that decided it, the
recorded event it read, and the threshold in words. Fleet's inspector shows it
under the verdict; the queue chip carries it in its accessible description. A
verdict assembled without the evidence, such as the phone's fallback row, leaves
it out rather than inventing one — and the phone snapshot copies only kind, label
and time, so none of it crosses to a device.

| | Dark | Light |
|---|---|---|
| Before | ![](before/fleet-reason-dark.png) | ![](before/fleet-reason-light.png) |
| After | ![](after/fleet-reason-dark.png) | ![](after/fleet-reason-light.png) |

## Reopening a review that asked for changes

The hint now says what reopening does: implementation and verification go back,
the note reaches the next implementation session, and verification needs a new
gate run.

| | Dark | Light |
|---|---|---|
| Before | ![](before/control-reopen-dark.png) | ![](before/control-reopen-light.png) |
| After | ![](after/control-reopen-dark.png) | ![](after/control-reopen-light.png) |

Not captured: the handover bubble's "on that account" line, which needs a live
context-pressure reading to appear; its behaviour is covered in smoke13.
