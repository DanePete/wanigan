# A small world inside Wanigan

Desktop implementation of the seven approved physics/personality additions.
The existing glass, studio lighting, eyes and water remain the character's
foundation. The small companion uses the same shaders and simulation detail.

| Behavior | What drives it |
| --- | --- |
| Bubble curiosity | A GPU fixation controller selects a live front-facing bubble, tracks its position, and releases it for typing, direct interaction or a request. |
| Glowing wakes | A persistent 48³ light tracer follows reconstructed liquid velocity and fades when stirring stops. |
| Thinking vortex | An actual pending companion request ramps a bounded rotational force up and down. The water retains momentum. |
| Grab, tilt and flick | Pointer capture preserves handling outside the vessel. Spring acceleration pushes the liquid; release preserves motion. |
| Celebrations | A new answered question or finished attention transition produces one water lift and bubble burst. Initial snapshots, repeated polls and unavailable reads do not replay it. |
| Internal weather | A short supplied cloud/rain cycle emits falling droplets, transfers their impacts into the water, throws secondary splash droplets and drains shell condensation. |
| Lava lamp | Four cohesive wax parcels, made from 48 heated particles, rise and cool. Smooth density reconstruction lets joining parcels form and separate necks. |

The rain correction follows the user's review: falling streaks alone were not
enough. Impacts now affect bulk particle velocities and a 96² damped wave
equation adds smaller free-surface ripples. Secondary droplets follow gravity,
return to the water, and produce smaller impacts. Surface waves deform the
water reconstruction and its optical normals; they are not ring sprites.

## Try it

Open **Wanigan → Make him yours** below the large character. Choose Water &
mist, Ember & flame or Lava lamp. The play actions are **Give him a spin**,
**Make a splash**, **Bubble burst** and **Little rainstorm**.

Grab and flick either character. With the character focused, arrow keys splash,
S spins, B makes bubbles, and R starts a shower. Dragging the small companion
does not activate its navigation action. Motion Off freezes the simulation and
absorbs incoming animation events; native hiding pauses GPU submissions.

## Evidence and provenance

All screenshots below come from Electron and the actual WebGPU renderer.
Project/session data in the UI harness is synthetic and labeled as such in the
verification reports. No real agent sessions or model calls are launched.
The isolated send test invokes a deliberately controlled fixture promise.

| View | Before | After |
| --- | --- | --- |
| Mission, dark | [Before](before/mission-dark.png) | [After](after/mission-dark.png) |
| Mission, light | [Before](before/mission-light.png) | [After](after/mission-light.png) |
| Play menu, dark | [Before](before/play-dark.png) | [After](after/play-dark.png) |
| Play menu, light | [Before](before/play-light.png) | [After](after/play-light.png) |
| Fleet companion, dark | [Before](before/fleet-dark.png) | [After](after/fleet-dark.png) |
| Fleet companion, light | [Before](before/fleet-light.png) | [After](after/fleet-light.png) |

Live captures: [rain and ripples](physics/rain-and-ripples.webm),
[lava lamp](physics/lava-lamp.webm). These are recordings of simulation output,
not assets played by the application.

The GPU harness checks fixation against a live bubble. Its
[report](physics/verification.json) records the renderer digest, wake decay,
controlled rain momentum transfer, splash population,
surface wave bounds/decay, wax movement/temperature, vortex momentum and timing.
The [UI report](after/ui-verification.json) covers mode persistence, captured
drag/release at both sizes, pending-request behavior, one-shot events, reduced
motion and the explicit-send boundary.

The [native app check](real/verification.json) uses the real main process and
preload in a fresh empty profile. It verifies that hiding the window stops GPU
submissions, showing it resumes, and the small companion renders at a bounded
idle cadence (about 17 frames/second in this run). The full repository suite
passed 1,509 assertions, with no failures, along with the expression checks.
The existing [water/fire stress test](water-fire-regression.json) also passes
against the same built runtime, including containment, pressure projection,
fire cooling, spinning-shell momentum transfer and pause behavior.

```sh
source "$HOME/.nvm/nvm.sh" && nvm use
npm test
node scripts/probe-orb-expression.mjs
node scripts/probe-orb-play.mjs
node scripts/probe-orb-play-ui.mjs
node scripts/probe-companion-presence-real.mjs docs/visuals/orb-play/real
git diff --check
```

## Scope of the physics

This is a reduced, interactive graphics simulation. Bubbles and condensation
use one-way tracer coupling. Rain is supplied rather than conserved through a
closed evaporation/condensation cycle. The fine wave field supplements the
bulk solver and does not simulate every capillary interaction. Wax uses
cohesive parcels and reconstructed density rather than a full multiphase fluid
solver. These limits are deliberate; no prerecorded animation substitutes for
the evolving fields. New effects stay on the GPU in production; inspection
readbacks are for the harness, alongside existing vendor solver diagnostics.

The app has been built locally. These test commands do not install or restart
the operator's Wanigan app. See the [approved implementation design](../../superpowers/specs/2026-09-10-orb-play-design.md).
