# Wanigan · quietly mischievous

The accepted glass companion now has a small set of intentional mannerisms.
Play gives him a recoil, alternating head tilt, and a delayed wink. Conversation
interrupts play: he attends to the composer, tips his head, and gives a small
acknowledging nod. An attention transition produces a double-take toward the
work, back to the operator, then toward the work again. A newly observed finished
turn receives a warm nod and the existing brief material reaction. Neither the
gesture nor its label claims that the work passed review.

The small companion uses the same face geometry and gesture solver. Its lower
idle draw rate now advances expressions using elapsed time. Existing pointer
fixations, natural blinks, full spins, material choices, and physics controls
remain available. Gestures settle; repeated status polls do not replay them.
Off freezes motion, Auto follows the system preference, and events received
while paused are absorbed.

The vessel's roll and pitch feed bounded acceleration into the existing material
solvers. Water remains in world coordinates and reacts to that acceleration;
the face is attached to the glass. A wink closes one eye using the existing
analytic geometry rather than replacing the character with a sprite.

Mission room acknowledges input with “You have my attention” and a pending
question with “Let me take a look.” Its quiet overview asks “What shall we make?”
The main-owned companion instructions now call for dry warmth, clear answers,
and occasional understated playfulness when appropriate. They retain source
validation, uncertainty, operational-data boundaries, structured output, and
explicit metered sends. No automatic model call was added. The actual request
was checked with an offline transport; live generated wording was not evaluated.

## See it move

[Watch the actual renderer](physics/wanigan-personality.webm): play and wink,
conversation focus, an attention double-take, a completed-turn reaction, and a
full spin. These are controlled synthetic events in isolated Electron, not live
agent outcomes. All frames come from the shipped GPU scene.

## Screenshots

| View | Before dark | Before light | After dark | After light |
| --- | --- | --- | --- | --- |
| Mission room | [Dark](before/mission-dark.png) | [Light](before/mission-light.png) | [Dark](after/mission-dark.png) | [Light](after/mission-light.png) |
| Play controls | [Dark](before/play-dark.png) | [Light](before/play-light.png) | [Dark](after/play-dark.png) | [Light](after/play-light.png) |
| Miniature in Fleet | [Dark](before/fleet-dark.png) | [Light](before/fleet-light.png) | [Dark](after/fleet-dark.png) | [Light](after/fleet-light.png) |

| Expression | Dark detail | Light detail |
| --- | --- | --- |
| Playful wink | [Dark](after/wink-detail-dark.png) | [Light](after/wink-detail-light.png) |
| Listening | [Dark](after/listening-detail-dark.png) | [Light](after/listening-detail-light.png) |
| Thinking | [Dark](after/thinking-detail-dark.png) | [Light](after/thinking-detail-light.png) |
| Answer acknowledgment | [Dark](after/answer-detail-dark.png) | [Light](after/answer-detail-light.png) |
| Attention | [Dark](after/attention-detail-dark.png) | [Light](after/attention-detail-light.png) |
| Miniature finished turn | [Dark](after/mini-finished-detail-dark.png) | [Light](after/mini-finished-detail-light.png) |
| Miniature wink | [Dark](after/mini-wink-detail-dark.png) | [Light](after/mini-wink-detail-light.png) |

Before captures use the previous installed archive. Before and after use the
same synthetic project and setup fixture. Captures pause a live gesture for
inspection in each theme; the GPU and expression simulations do not advance
while paused.

## Verification

- `node scripts/probe-orb-expression.mjs`: existing motion checks plus visible
  wink and tilt, bounded finite forces, conversation priority, attention gaze
  sequence, completion baselines, paused events, and 18/30/60 Hz agreement.
- `node scripts/probe-orb-personality.mjs`: five interaction groups across both
  character sizes and themes, zero renderer/GPU errors, no incidental sends,
  duplicate-event suppression, and reduced-motion behavior.
  [Recorded results](after/ui-verification.json).
- `node scripts/probe-orb-personality-physics.mjs`: two equivalent GPU runs
  differing only in whether the gesture's acceleration reaches the water. Peak
  mean horizontal displacement differed by 0.0338 simulation units. All 8,144
  particles remained finite and contained; maximum radius was below 0.954 in a
  chamber bounded at 0.973. The subsequent expression/spin sequence also passed.
  [Recorded physics and runtime hash](physics/verification.json).
- `npm test`: all five required stages passed, including **1,565 smoke
  assertions**, zero failures. `git diff --check` passed. Both themes and the
  large and miniature expressions were visually inspected.

Both Mac builds passed strict sealed ad-hoc signature, hardened-fuse,
ASAR-integrity, and executable PTY-helper checks. Both contain the same renderer;
their GPU runtime hash matches the controlled physics test. The arm64 build was
installed and Wanigan reopened as PID 61350. The installed archive matches the
verified package. [Build verification](build-verification.json).

Native inspection confirmed the new quiet headline and the attentive pose and
caption when the conversation field receives focus. No production question was
sent. Wanigan was left open in the Mission room.
