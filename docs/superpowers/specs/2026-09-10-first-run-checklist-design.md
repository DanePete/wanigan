# Wanigan first-run checklist

Approved direction, selected by the user on September 10, 2026: a checklist
inside Mission room rather than a stepped wizard or a modal sheet, and detection
that never spawns an installer. This is the in-app half of onboarding. Shipping a
notarised DMG is the other half and is deliberately not specified here.

## Experience

A new operator opens Wanigan and Mission room greets them as it does today. Where
the empty state currently invites one action, it now carries three, in the order
each unblocks the next: an agent, a project, a first session. Each line states
what Wanigan observed rather than what it assumes, and the checklist disappears
once all three are satisfied.

The first line reports what the provider resolver found — the label, the resolved
path and the version it answered. A provider that did not resolve says so in the
words `providers.ts` already uses, offers the official install command as
one-click copy and a link to the vendor's instructions, and offers a Re-check
that probes again. Wanigan never runs an installer, never writes to a shell
profile and never modifies a PATH. Automating an install is a separate decision
with its own threat model, and a control that quietly ran `npm` or `curl` as the
operator would be the kind of hidden side effect the rest of this app refuses.

The second line counts registered projects and opens the main-process folder
picker. Registration stays exactly where it is: the renderer may ask, and
`projects:pick` decides.

The third line is a session that actually started. It is last because it is the
only unambiguous evidence that the whole path works, and it is satisfied from the
existing `session_log` record rather than a flag this feature invents.

## What the checklist may not claim

`accounts.ts` reports a stored login as `yes` or `unknown`, and its own comment is
the constraint this design is built around: `unknown` never means "not signed
in". On macOS the credential lives in the Keychain, keyed to the configuration
directory, and Wanigan neither holds it nor reads it. Absence of evidence is not
evidence of absence.

So sign-in renders as **signed in** or **can't tell from here**, and never as a
red cross. A checklist that printed "not signed in" over a working account would
send an operator to fix something that was never broken, and it would do it in
the one surface whose entire job is being trusted on first contact. The same rule
governs the version column: a provider that resolved but could not be probed
reports the path without a version rather than an invented one.

This is why the third item exists. Wanigan cannot prove a login from disk, but it
can observe a session that ran.

There is a second claim it may not make, found by the runtime probe below rather
than by review. GLM, DeepSeek and xAI are the reviewed Claude Code harness
pointed at an Anthropic-compatible endpoint: the same binary, the same
configuration directory, and an entirely different credential. Reading that
directory's stored login and reporting *them* as signed in is false, and the
first build of this surface did exactly that — five agents, all claiming a
sign-in, on a machine holding no Z.ai key at all. So a profile whose credential
is a pasted key is neither counted as an agent nor vouched for, and the decision
is routed through `accounts.appliesTo()` rather than an id list, because a local
pack coins ids no build of Wanigan has heard of. Those keys belong in Settings,
which is where this flow leaves them.

## Credentials

Adding an API key is not a step in this flow, because for the common path there
is no key to add. Claude Code and Codex authenticate themselves and Wanigan
inherits that login by spawning the CLI. Only GLM, DeepSeek and xAI need a
pasted credential, and only because they are the reviewed Claude Code harness
pointed at an Anthropic-compatible endpoint; the Anthropic Platform key is needed
for Batches and the companion and nothing else.

Tracing that flow turned up a defect rather than an inconvenience, and the fix
was approved as part of this work. A redirected profile with no stored key did
not fail — it launched. `compileProviderProfile` correctly declines to apply
half a redirection, returning an empty environment, which keeps the operator's
Anthropic credential away from another host. But an empty environment is
indistinguishable from an ordinary profile's, `agentEnv()` then strips the
ambient Anthropic names, and the shared `claude` binary falls back to its own
stored login. A GLM session ran as Claude Code, was displayed as GLM, and banked
its spend against a backend that never served the request. Every pre-existing
GLM and DeepSeek fixture in the suite supplied a key, so the path had no
coverage.

`createSession()` now refuses it, beside the existing slot and budget refusals —
local, cheap, and before any probe, worktree or injected file exists to roll
back. The refusal names the key, because an operator with several providers has
to know which one to paste. `missingCredentialIds()` reads the profile manifest
rather than the compiled environment, since the compiled form deliberately
cannot tell "no credential" from "nothing declared".

A key therefore appears at the moment it is required and not before. Selecting a
key-backed profile in the new-session dialog reveals the field for that provider
inline, verified through the existing checks in `keys.ts`, which already
distinguish an admin key, a 401, a 403 and an identity-linked key that must name
its workspace. Batches keeps its guard but stops routing the operator away: where
`App.tsx` currently sends them to Settings, it offers the same verified paste in
place. Settings remains the durable home for every credential; it stops being the
only door.

## Architecture

`src/main/preflight.ts` answers one question — what does this machine have —
and composes existing readers to do it. Provider resolution and the version probe
come from `providers.ts`; login evidence comes from `accounts.ts`; project and
session counts come from the database. It introduces no new probing, no new
filesystem scan and no new network call, and it is read-only.

`src/shared/preflight.ts` holds the record type and `checklistFrom()`, a pure
function from that record to the three items and their states. Pure and
closure-free for the same reason `routes.ts` and `palette.ts` are: the
main-process smoke suite can then hold the derivation to account directly,
including the states that must never render green.

One channel carries it. `preflight:read` is read-only and side-effect free, and
the Re-check button simply calls it again. A second re-probing channel was
specified and then dropped on reading the resolver: `which()` re-scans the
filesystem on every call, and the version cache is keyed on the resolved path
plus that file's size and mtime, so a CLI installed after launch resolves to a
key that has never been cached. The channel would have had nothing to
invalidate.

`SetupChecklist.tsx` renders the derived items. It adds no `*-card`, `*-head` or
`*-chip` family, composes from `bits.tsx`, and puts its rules in `mission.css`
with no colour, size or duration literal. Its Re-check control and every copy
button carry an accessible name.

## Integration and preservation

The checklist absorbs Mission room's `nothing-yet` empty state rather than
sitting above it; `bits.tsx` already describes that posture as first-run absence
where the title is the invitation, and two invitations stacked would be one too
many. Nothing about the existing route table, palette, dock or shortcut set
changes, and no destination is added.

Dismissal is remembered, re-openable from Settings, and never re-asserts itself.
An operator who dismissed the checklist and then removed their last project gets
their app back, not their onboarding back.

The trust boundary is unchanged. Preflight is privileged work in main, the
renderer reads it through a typed preload API, and the set of directories
Wanigan will act on is still seeded only by a person choosing a folder in the
main-process picker.

## Verification

Smoke covers `checklistFrom()` across the full cross-product of resolved,
unresolved, `yes`, `unknown`, versioned and unversioned inputs, and asserts three
things that are easy to regress: an unresolved provider never reads as ready, an
`unknown` login never renders as a failure, and a completed checklist never
re-appears. These are pure-function checks and need no window.

`scripts/probe-preflight.mjs` launches the built app cold against a throwaway
user-data directory, seeding nothing, and records what the first screen actually
says — the gap that let the existing shot script, which seeds a project before it
captures, never photograph a true first run. A screenshot is not proof a view
rendered, so the probe asserts the checklist's text, not only its pixels.

`npm test` stays five steps and must pass. The change ships with before and after
screenshots of Mission room in both themes.

## Implementation order

1. `src/shared/preflight.ts` — the record type and `checklistFrom()`, with its
   smoke checks written first, since every later piece reads from it.
2. `src/main/preflight.ts` — composition of the existing resolvers, plus the two
   IPC channels and the preload surface.
3. `SetupChecklist.tsx` and `mission.css` — the rendered checklist, replacing the
   Mission room empty state.
4. `scripts/probe-preflight.mjs` — the cold first-run probe, and the screenshots.
5. Contextual credentials — the inline field in the new-session dialog and the
   in-place paste in Batches.

## Out of scope

Spawning or automating an installer. A key step in the main flow. Windows and
Linux preflight, which have no packaged build to be first-run for. Distribution
itself: `electron-builder.yml` is already configured for a notarised DMG and zip
on both architectures, and cutting that release is a chore rather than a design.
