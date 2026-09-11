# Plan with Wanigan

New goal in Review and Plan a goal on the Board share a planning page. A large,
interactive companion sits beside the idea, the existing AI interview, the
editable proposal and the saved-goal receipt. Manual planning uses the same page.

Wanigan looks toward the focused field, sends small ripples through the water as
you type, acknowledges answers, turns a current during actual planning requests,
reacts to errors and spins after a confirmed save. Click, drag and double-click
retain his existing physical interactions. The page respects the chosen material,
Off and system Reduce Motion. The footer companion hides while the large one is
present.

Tasks appear as a compact sequence. Each task opens for instructions, kind,
prerequisites and claim path; existing graph validation and the final human review
remain intact. Both manually written and AI-proposed plans can be edited before
saving, including their execution budget. Planning spend remains separate and
uses the recorded interview figures.

No model call happens when opening or resuming the page. Only explicit planning
actions call the existing Claude interview API. Creating a goal does not launch
its tasks. Drafts, answers and pending request locks survive page navigation in
the same window; durable interview records remain in SQLite. Unsaved manual
text is session memory and does not survive an application restart.

## Captures

These are actual Electron/GPU captures with fictional projects and deterministic
bridge responses. No real provider calls or agent launches are used. Before
captures load the previously installed app archive; after captures load the
newly packaged app archive.

| View | Dark | Light |
| --- | --- | --- |
| Previous New goal | [Before](before/new-goal-dark.png) | [Before](before/new-goal-light.png) |
| Previous Plan a goal | [Before](before/plan-a-goal-dark.png) | [Before](before/plan-a-goal-light.png) |
| Shared planning table | [Idea](after/idea-dark.png) | [Idea](after/idea-light.png) |
| Thinking together | [Request](after/thinking-dark.png) | [Request](after/thinking-light.png) |
| Conversation | [Question](after/conversation-dark.png) | [Question](after/conversation-light.png) |
| Editable goal | [Plan](after/editable-plan-dark.png) | [Plan](after/editable-plan-light.png) |
| Task instructions | [Task](after/task-instructions-dark.png) | [Task](after/task-instructions-light.png) |
| AI proposal | [Proposal](after/proposed-plan-dark.png) | [Proposal](after/proposed-plan-light.png) |
| Save failure | [Error](after/save-error-dark.png) | [Error](after/save-error-light.png) |
| Confirmed save | [Receipt](after/saved-dark.png) | [Receipt](after/saved-light.png) |
| Narrow desktop | [960 px](after/idea-960-dark.png) | [960 px](after/idea-960-light.png) |
| Small window | [720 px](after/idea-720-dark.png) | [720 px](after/idea-720-light.png) |

## Verification

`npm test` passed all five required suites: typecheck, renderer style, package
hooks, local installation fixtures and **1,608 smoke assertions, zero failures**.
The interview smoke case verifies that an edited goal execution budget reaches
the created docket. See [the complete test log](npm-test.log).

The [packaged planning probe](after/verification.json) checks both entry points,
initial focus, intentional gaze, typing ripples, pending-request currents, saved
celebration, field and budget validation, task editing/add/remove, failed saves,
answer recovery, duplicate keyboard submissions, and navigation while a request
is pending. It verifies 960/720 layouts in both themes and stopped frame counts
with Off and system Reduce Motion. These tests use deterministic bridge fixtures,
not a paid model request.

The existing [Review](review-workspace-verification.json) and
[Board](board-workspace-verification.json) interaction suites also passed. The
[real main/preload capture run](real-main-verification.json) separately created a
goal through the typed IPC bridge, opened its selected record and verified that
no agent was launched. That run used a temporary profile and project, with dark
and narrow-window captures; the dedicated planning probe supplies both themes.
See [the real-main run log](real-main.log).

## Desktop builds

Apple silicon and Intel packages built successfully. Both contain the same
renderer and passed ad-hoc signature, ASAR integrity, hardened fuse and executable
PTY-helper verification. The GPU runtime hash is unchanged from the previously
verified physics build. See [package verification](build-verification.json) and
[the packaging log](package.log).

The application bundles are staged at:

- `release/goal-planning/mac-arm64/Wanigan.app`
- `release/goal-planning/mac/Wanigan.app`

Installation remains pending. The installed app was left open with its live
Claude session in `vincent`; restarting Wanigan would end that process.

Builds ran from an isolated copy to prevent another session's rebuild from
replacing renderer chunks during verification. The source and script files match
the working tree at handoff; [source hashes](source-manifest.json) identify the
verified snapshot. No commit or push was made for this change.
