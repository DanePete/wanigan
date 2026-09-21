# Improve prompt

Approved direction: an explicit Improve prompt action wherever a person writes
session or task instructions, with a preview, Use suggestion, and Keep original.
The operator approved implementation on 2026-09-19.

## Interaction

The action opens a shared dialog containing the original draft, the selected
model, and the disclosure that a Claude Platform API request uses the configured
API key and is billed separately from a CLI subscription. Opening the dialog
does not make a model call. Generate suggestion is the deliberate spending
action. Empty, disabled, read-only, or over-limit drafts cannot be submitted.

Only the entered draft and its input purpose are sent. No repository reads,
attachments, session history, or automatic context retrieval. The model preserves
the user's intent and constraints, improves clarity, and returns missing details
as separate clarification questions. It cannot execute tools or session actions.

The result is an editable proposed prompt, with questions and reported token
counts. Cost calculated from the recorded model and token counts is labelled an
estimate; missing usage or unknown pricing stays unknown. Use suggestion changes
only the original draft, and only if that field still has the same identity,
content, and editability. Cancel, errors, changing views, and late answers cannot
overwrite a draft. Sending or launching remains the composer's existing action.

## Shared extension point

First extract the existing prompt textareas into a shared PromptField host with
an empty action registry. Preserve attributes, refs, native event handlers,
draft storage, layout, and send behavior. Commit this conversion independently.
Then register the optional prompt-improvement action once. Existing renderer
view modules continue to own their views; new main-process behavior belongs to
the optional `prompt-improve` module, registered through the module registry.

Integrations: live session Composer; new-session first message; Relay intent;
Orb conversation question; goal idea, interview answer, objective, acceptance
criteria and task instructions; headless runs; attempts; and schedules. Resume
uses the normal session composer. Review notes already append to that composer.
Raw terminal input and batch template syntax are outside this change.

## Generation and evidence

Reuse Wanigan's existing Claude Platform Messages transport and model catalogue,
defaulting to Haiku 4.5. Do not reuse the companion service, which adds history,
or CLI launchers, whose tool restrictions differ by harness. The request has no
tools, has one attempt, and has bounded input, output, and duration. Main validates
the request, selected model, feature switch, credential availability, and halt
state before spending. It also enforces one request at a time and cancellation
by request identity. Disabling the feature or pulling Halt cancels its request.

An additive module-owned usage ledger records pending attempts before dispatch,
then status, model, and returned meters even for malformed, refused, truncated,
or cancelled responses. It stores no draft or generated content. The existing
module usage hooks aggregate these service calls into Usage. Unknown usage and
cost never become claims of free execution. Safe errors leave the original draft
intact. The shared typed preload API uses the existing sender-validation wrapper.

## Verification

Use pure shared tests for bounds and result parsing, real SQLite smoke tests
with a substituted transport for request/cancellation/metering behavior, and a
renderer probe for preview/apply/cancel/stale drafts and unsupported states.
Capture affected forms before and after in both themes. Fixtures are labelled
fictional; no test makes a paid call. Run Node 22.23.2, `npm test`, and
`git diff --check` before handoff.
