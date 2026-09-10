# Intentional gaze, blinking and globe turns

Research and implementation notes, 2026-09-10. The user asked for purposeful eye
movement, blinking, and a globe that can spin, then rejected the first flame as
too small. This extends the approved Mission room and its existing physical orb.

## What informed the movement

Disney Research separates attention selection from movement execution. Its
character uses distinct glance, engage and acknowledgment behavior, with fast
eye movements followed by slower head movement. Its attention model also reduces
repeated responses to the same stimulus. Wanigan borrows those architectural
ideas, replacing camera/person detection with explicit UI events and observed
session transitions. There is no camera tracking or user emotion inference.
[Disney publication](https://la.disneyresearch.com/publication/realistic-and-interactive-robot-gaze/),
[primary paper](https://la.disneyresearch.com/wp-content/uploads/root.pdf).

A 2026 virtual-character study investigates saccadic undershooting and corrective
movements. It reports a tendency toward undershooting larger target shifts in
its five-person eye-tracking dataset. This motivates a subtle initial undershoot
and correction in Wanigan; it does not establish ideal values for a stylized
orb. The implemented timing and amplitude remain art-direction choices.
[2026 study](https://www.frontiersin.org/journals/virtual-reality/articles/10.3389/frvir.2026.1806316/full).

Earlier eye–head animation research explicitly links gaze shifts to blink
probability and amplitude. Wanigan uses a blink for larger shifts and a single
answer acknowledgment, alongside irregularly spaced resting blinks. The lid
closes faster than it reopens instead of continuously pulsing eye scale.
[Primary publication](https://www.sciencedirect.com/science/article/pii/S0097849310001408).

Apple's ELEGNT work explores expressive movement for a non-anthropomorphic
object. The useful parallel is coordinated gaze and body motion that conveys
attention without requiring a human face. This research concerns a physical
robot and does not prove a productivity benefit for Wanigan.
[Apple research](https://machinelearning.apple.com/research/elegnt-expressive-functional-movement).

## Implemented behavior

- Composer focus selects the composer as a gaze target, using its actual layout
  position. A pending explicit companion request selects the overview. A newly
  answered request gets one acknowledgment; polling the same records does not
  repeatedly trigger it.
- New recorded permission, error or finished states invite a glance toward the
  visible overview. Initial history hydration and changing project scope set a
  baseline rather than pretending a new session event occurred.
- Incidental pointer movement has a dead zone and a minimum fixation interval.
  Small movements within that region do not continuously drag the eyes around.
  Tiny saccades stay close to the held target. Rest occasionally glances toward
  the overview and returns to the operator.
- Exact damped springs retain position and velocity when retargeted. Eyes move
  faster than globe orientation, which moves faster than the fluid response.
  Request duration and session counts never increase apparent progress.
- Double-clicking the globe or selecting **Give him a spin** triggers one turn
  with an anticipatory glance. Repeated clicks cannot queue unlimited turns.
  Orientation rotates eye geometry in 3D. Bounded tangential vessel friction
  transfers momentum into nearby liquid particles and gas. Gravity and particle
  positions remain in world coordinates; the liquid is not rotated as a picture.
- The flame has a broad fuel bed with several fuel-rich tongues, transported
  heat, temperature buoyancy, fuel consumption and cooling. A bounded stirring
  force seeds visible eddies. Embers carry inertia, cool and extinguish on water
  contact. Flame emission is integrated along refracted rays inside the glass.
- Motion off freezes gaze, orientation, fluid, heat and embers. A typed native
  visibility bridge also stops rendering when the actual window is hidden or
  minimized, even if an automation environment reports the document as visible.

This remains a supplied, incompressible flame with normalized temperature and
one-way liquid coupling. It does not simulate oxygen depletion, combustion
expansion, boiling, complete radiative heat transfer or a sealed thermodynamic
system. Warm water illumination and the thermal color palette are rendering
approximations driven by the simulated field.

## Verification entry points

`node scripts/probe-orb-expression.mjs` checks spring frame-rate agreement,
velocity continuity, fixation, intent priority, blinking, bounded engagement,
freeze semantics and completion of a single spin. It makes no model call.

After `npm run build`, `node scripts/probe-orb.mjs` runs the actual production
WGSL in an isolated Electron/WebGPU canvas. It measures particle containment,
water angular momentum, pressure projection, ignition, fuel depletion,
source-off cooling, ember bounds and complete pause behavior. It records actual
water and flame videos. See the [evidence index](../visuals/mission-room/README.md)
for the final run, scope and remaining visual limitations.

`node scripts/shots.mjs --out docs/visuals/mission-room/real --light` loads the
full main, preload and renderer with temporary user data, checks native hide and
resume, gaze focus, spin and temperament persistence, then captures every view.
The test harness attaches its debugger before loading the production main
module to work around an Electron 44 debugging-handshake hang. This is a test
bootstrap, not a production startup change. Its project/review records are
explicit test seeds, with no launched coding-agent session or paid API request.
