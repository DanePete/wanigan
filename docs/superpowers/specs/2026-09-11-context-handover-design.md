# Carrying a conversation into a fresh one

Approved direction, selected by the user on September 11, 2026: when a
conversation fills its context window, Wanigan says so where the companion
already stands, and offers to carry the work into a new session seeded with a
handover note the agent writes. Desktop, iPad and the paired phone.

## What already exists

Almost all of the measurement. `transcripts.claudeContextUsage` reports tokens,
window and percent, and records whether the window was reported by the CLI or
assumed from a model id. `useContextStory` polls it every five seconds for the
selected session, marks a reading stale past two minutes, and marks a
conversation match unconfirmed when the transcript is a lifetime fallback rather
than an exact lookup. `contextPressure` in `shared/orb-story.ts` turns that into
the crowding the orb already performs from about seventy percent, and refuses to
perform at all on an estimated window, a stale reading or a future timestamp.

`CompanionPresence` is mounted on every view except Mission room and is already
handed that story; it already reads the context note to a screen reader.
`Stop` arrives on the renderer's session-event stream. `transcriptPathFor`
resolves the CLI's own live transcript for a conversation and `parseTranscript`
turns it into typed turns — the pair the context reader already uses, and the
only pair that works while a session is still running. Sessions launch with
`initialPrompt`, which is typed into the session once it is ready.

So this adds a threshold, a visible message, and one orchestration. It adds no
new measurement, and it must not contradict the measurement that is there.

## What the prompt may say

`contextHandover(reading, now)` is a new pure function beside `contextPressure`,
and it inherits every refusal that one makes. An estimated window produces
nothing: the orb already refuses to perform on one, smoke14 pins that as "an
assumed window cannot trigger a pressure performance", and a sentence claiming
eighty-six percent of a window nobody measured would be exactly the guess this
project's estimate grammar exists to prevent. A stale reading produces nothing.
A reading from the future produces nothing.

Past those, it suggests at **0.85** and falls silent again below **0.78**. Two
numbers rather than one, because a single threshold at the boundary flickers a
message on and off while a turn streams. The orb keeps its own curve from 0.70;
crowding earlier than the sentence is the point, since the ambient signal is
free and the sentence costs attention.

The bubble states the percentage it read. When the conversation match is
unconfirmed it says so in the same breath, because a percentage attributed to
the wrong conversation is worse than no percentage.

## The surface

The bubble belongs to the companion, not to a toast or a modal. Bottom left on
every working view, on the large orb in Mission room, and in the phone's session
view. It is dismissible, and a dismissal is remembered against the conversation
until a completed compaction resets it — so it asks once per conversation rather
than once per reading.

It is never modal and never steals focus. A conversation at ninety percent is
still working, and an operator who wants to finish the turn must be able to.

## The flow

One click, then four steps Wanigan already has the parts for:

1. Send a handover prompt to the running session, through the same bounded PTY
   write everything else uses.
2. Wait for that session's `Stop` event on the existing stream.
3. Read the last assistant turn from the CLI's own live transcript, resolved by
   `transcriptPathFor(projectPath, conversationId)` and parsed by the same
   `parseTranscript` the archive reader uses. Not `transcriptFor`: that reads
   the `transcripts` table, which `archiveSession` fills when a session *exits*,
   so for a live session it answers "No transcript was archived for this
   session." The conversation being handed over is by definition still running.
4. Create a session with the same project, provider and account, and that text
   as `initialPrompt`, then focus it.

The old session is never killed, never interrupted and never modified beyond the
one prompt. Filling a context window is not an error, and the conversation
remains the record of how the work got here.

Three failures are foreseeable and each gets said rather than hidden. The turn
can error, in which case nothing is created and the bubble says the handover
turn failed. The last assistant turn can be empty or absent, in which case
Wanigan offers to start the fresh session blank instead of seeding it with
nothing and calling that a handover. And the transcript may be unreadable, which
is a different sentence from an empty one — Wanigan could not read it, rather
than there was nothing there.

## Three surfaces, and what each can honestly do

Desktop and iPad Safari run the same renderer and get the same bubble; the iPad
case needs the bubble to sit above the dock rather than behind it, and to be
reachable by touch without hover.

The paired phone gets the same message in its session view. Paired control
already permits exactly the two actions this needs — README states its bounded
set as "launch a session, send one next instruction, or interrupt" — so the
handover is within what a paired device may already do, and needs no new
capability and no widening of that boundary.

A read-only paired device shows the message and no button. That pairing cannot
act by design, and a button that cannot work is worse than none; the message
says the action is available on the Mac.

Codex gets nothing, and the absence is stated rather than silent. The reading is
`ClaudeContextUsage`, Codex does not report a window to Wanigan, and
`kind: 'unsupported'` already exists to say so. Inventing a percentage for a
provider that reports none would be the same lie as inventing one from an
assumed window.

## Where the code goes

`src/shared/context-handover.ts` holds the threshold, the hysteresis and the
message text as pure functions of a reading — testable in a tenth of a second,
beside the `contextPressure` rules it inherits.

`src/main/handover.ts` owns both privileged halves: `handover:begin` writes the
prompt to the PTY, and `handover:finish` reads the note and creates the session.
The renderer only times the gap, because it already receives `Stop` on the
session-event stream and main has no listener of its own there. What matters is
preserved by the split: the renderer never supplies the note. It names a
session, and main reads the text out of that session's own transcript, so a
renderer cannot launch a session carrying a blob it composed.

`CompanionPresence` and Mission room's orb render the bubble from the shared
function. Rules go in the existing sheets, with no colour or size literal.

## Verification

The pure half in the fast lane: the full cross-product of ratio, estimated,
stale and future timestamps, asserting silence everywhere `contextPressure` is
silent, the hysteresis band, and that no message ever quotes a percentage from
an estimated window.

Smoke for the orchestration against the mock runner: a handover that produces a
note creates a session carrying it; a failed turn creates nothing; an empty
reply offers a blank start rather than seeding an empty prompt; the source
session is still running afterwards in every case.

A runtime probe for the bubble at both orb sizes and at a narrow width, because
every visual defect this session found was found by running the app rather than
reading it.

## Out of scope

Auto-starting anything without a click. Killing or interrupting the old session.
Compaction — `/compact` is already a button in the composer, and is a different
answer to the same pressure. Codex context, until Codex reports a window.
