# Wanigan’s physical personality

Wanigan should feel like one recognizable character whose interior has weight,
momentum and a life of its own. The strongest next step is a choice between
**water and mist** and **embers and flame**, sharing the same glass vessel, eyes,
lighting and response language. Most of the personality should come from how
he notices something, reacts and settles afterward. Changing colors alone will
not accomplish that.

The current implementation contains live particle-based water, a three-dimensional
gas field, buoyant bubble tracers and refracting glass. **Fire and the richer
expression controller described here are proposed work, not implemented features.**
The [live water recording](../visuals/mission-room/physics/live-fluid.webm) and
[numerical evidence](../visuals/mission-room/physics/verification.json) show the
existing foundation. The visual target remains the
[approved Mission room concept](../visuals/mission-room/concept/approved-b.png).

The supporting investigations cover [fire and thermal physics](2026-09-10-orb-fire-physics.md),
[expression and alternative materials](2026-09-10-orb-expression-physics.md), and
[authoring tools and MCPs](2026-09-10-orb-tools-pipeline.md). They contain source
revisions, licenses, equations, proposed limits and verification details. Current
tool availability was checked in September 2026; proposed emotional readings
and timing values are design judgments to evaluate in the application.

## A character with several material temperaments

Material and activity should be independent. A fire character can be relaxed,
curious or playful. Water can become lively. An error should not automatically
turn him into a fireball, and a busy project should not generate an endless storm.
This keeps a selected personality consistent while the app’s words and source
links explain what actually needs attention.

| Temperament | What it could look and feel like | What makes it physical | Recommendation |
| --- | --- | --- | --- |
| **Water and mist** | Clear blue liquid, small bubbles, a silver curl of vapor; responsive weight and gentle recovery. | Existing particle water, gravity, viscosity, contact, surface tension and evolving gas velocity. | Finish the core material and expression first. |
| **Ember and flame** | A small amber core, translucent rising tongues, occasional cooling embers; warm and lively even at rest. | Transported heat and fuel, buoyancy, bounded burning, cooling, particle inertia. | Build as the first alternate temperament. |
| **Cloud** | Wisps gather toward a glance, separate around the eyes, then unfold into a soft curl. | Existing gas flow with different source shapes and optical density. | High reuse; a good third appearance after fire. |
| **Mercury / magnetic** | Dark reflective liquid gathers into a cohesive form and reaches toward a finger. | True ferrofluid requires magnetic forces coupled to fluid and surface behavior. | Promising later prototype; a spring-driven metaball is a different, simpler style. |
| **Charged** | A few delicate filaments connect to a touched point; bright particles trail and fade. | Particle dynamics in a prescribed field are tractable; full electrical breakdown or plasma is a larger model. | Use as an explicit playful accent or later temperament. |
| **Frost / condensation** | Tiny droplets gather on the shell or a faint crystalline pattern grows and retreats. | Condensation and ice require mass transfer or growth models; a roughness mask is only an optical effect. | Later material detail; keep the eyes and interior readable. |

The taxonomy matters because visually similar effects can have very different
causes. [Curl noise](https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph2007-curlnoise.pdf)
can prescribe attractive flow without solving momentum. A
[ferrofluid research solver](https://ferrofluid-simulation.github.io/)
adds magnetic coupling. Neither is obtained simply by renaming the current
gas shader. The detailed [alternatives report](2026-09-10-orb-expression-physics.md)
also evaluates reaction–diffusion, snow, granular material and boids; these are
interesting future characters, but less direct routes to the chosen glass orb.

## The moments that give him personality

The most useful Apple reference is expressive movement itself. Apple’s ELEGNT
research compared functional and expressive movement in a lamp-like robot.
Its small video study found benefits particularly in social scenarios, while
also finding objections to unnecessary movement and gestures that suggested
capabilities the robot did not have. This supports contextual expression; it
does not prove that a screen orb improves coding productivity.
[ELEGNT paper](https://arxiv.org/html/2501.12493v1).

The proposed Wanigan vocabulary is simple enough to remain recognizable:

| Moment | Proposed choreography |
| --- | --- |
| **He notices you** | Eyes turn toward the composer or direct interaction first. The plume leans a beat later. A small asymmetry in eye aperture makes the glance curious. |
| **You ask something** | Gaze anchors near the conversation. Mist gathers into a coherent curl, or the flame becomes slightly taller and more organized. Activity stays bounded throughout the request. |
| **An answer arrives** | One small blink or nod, a gentle unfurl of the plume, then a return toward you. The answer appears immediately; animation never delays it. |
| **Something needs attention** | He glances toward the actual project/session link, holds briefly, then looks back. The text names permission, error or a finished turn. |
| **You poke or stir him** | A stronger local impulse disturbs water or fire. The eyes react, particles overshoot, material rebounds from the vessel and gradually settles. |
| **He is simply present** | A stable, low-energy interior and occasional deliberate small gaze changes. A warm ember can remain alive without constant eruptions. |

The important detail is **follow-through**: the eyes stop before the fluid does.
An interaction leaves momentum that belongs to that interaction. Independent
blinking, pulsing, bobbing and swirling loops would be much less convincing than
a coordinated response with a beginning, a hold and a recovery.

Use continuous spring state for gaze and pose. Apple’s spring guidance explains
how retaining position and velocity makes interrupted and retargeted animation
continuous. A spring can settle without conspicuous bouncing; it is a movement
mechanism rather than a complete personality system.
[Animate with springs](https://developer.apple.com/videos/play/wwdc2023/10158/).

Start by testing gaze responses around 100–220 ms, a small overlapping pose
response over 180–350 ms, and material follow-through over 400–1200 ms. These are
tuning ranges, not established perceptual thresholds. Water can keep settling
afterward. Motion intensity should not grow with elapsed waiting time or raw
session count, which would visually imply progress or urgency that has not been
measured. Research on motion timing shows that timing alone can affect perceived
confidence and weight, so these choices carry meaning.
[Expressive Robot Motion Timing](https://arxiv.org/abs/1802.01536).

## How fire can work inside the existing renderer

The most convincing first fire mode is a small supplied flame with persistent
state. Add separately transported **fuel, temperature, soot and reaction** to the
gas system. Heat makes the flow rise; local burning consumes fuel and produces
heat and soot; cooling leaves a darker trailing plume. Stopping the source lets
the material already present continue to rise, cool and disappear.

There are useful current implementations to study. Three.js’s official volumetric
fire example has evolving flow, temperature and density, but does not include a
fuel/oxygen combustion system. The experimental luma.gl implementation includes
fuel consumption and heat production. Both have inspectable MIT source. The
luma.gl finding refers to an inspected experimental source revision, not a claim
that a stable released package is ready to drop into Wanigan.
[Three.js source](https://github.com/mrdoob/three.js/blob/r185/examples/webgpu_volume_fire.html),
[luma.gl source](https://github.com/visgl/luma.gl/blob/ef850d80319a013ba5b529e225e5b35305cf1f13/modules/experimental/src/rendering/volumetric-fire-simulation-shaders.ts).

Integrate flame emission along the existing refracted camera rays. This lets the
water, shell and smoke alter what is seen. A separate orange overlay would bypass
those relationships. Use a blackbody-derived color table for warm thermal light,
with intensity preserved separately and tone mapping at the end. Arbitrary violet
or cyan belongs to a stylized energy appearance rather than a claim about hotter
blackbody radiation. [PBRT light emission](https://www.pbr-book.org/3ed-2018/Light_Sources/Light_Emission),
[volume transmittance](https://www.pbr-book.org/4ed/Volume_Scattering/Transmittance).

Embers add a particularly useful layer of personality. They should carry their
own position, velocity, temperature and lifetime. Drag pulls them toward the gas
flow, but inertia lets them overshoot a turn; gravity becomes visible as the
updraft weakens. Contact with water can extinguish them under an explicit
one-way cooling approximation. They should remain a small population rendered
through the same vessel, with a few readable trajectories rather than a shower
of undifferentiated particles.

Keep the first coupling one way: water influences the gas boundary and ember
contacts; the fire does not change the liquid solver. Water-plus-fire is an
art-directed supplied scene, not a thermodynamically sealed chamber. Finite fuel
and oxygen that eventually extinguish the flame would make a useful separate
interaction experiment. Boiling, evaporation, combustion expansion and true
plasma require additional models and should not be implied by the first mode.
The [thermal report](2026-09-10-orb-fire-physics.md) explains the boundary and
conservation choices in detail.

At 64³, three additional RGBA16F scalar textures contain 6 MiB of logical data,
before driver overhead. That gives a useful allocation starting point, not a
performance guarantee. The current isolated water/gas scene measured approximately
10 ms per frame on the M2 Pro; a fire mode still needs its own sustained benchmark
and a test alongside active terminals.

## Tools worth using

| Tool | Best role for Wanigan | Runtime consequence |
| --- | --- | --- |
| **Blender + Python / Blender MCP** | Build a controlled glass, eye, camera and lighting reference; render it; export static assets and measured material parameters. | Keep the live fluid equations in WebGPU. A Blender cache or procedural material does not become an Electron solver. |
| **Three.js / luma.gl source** | Inspect thermal flow, reaction, rendering and GPU orchestration. | Adapt narrow algorithms with retained notices; avoid embedding a second engine solely for one effect. |
| **Houdini Pyro** | Higher-end fire/liquid reference simulation and field inspection. | Useful authoring, but exporting a cache does not export an interactive solver. |
| **EmberGen** | Rapid fire look development on a verified supported machine. | Public Apple Silicon application availability was not established conclusively; exported VDB/flipbooks remain authored results. |
| **Unity 6.6 / Unreal 5.8 MCP** | Serious alternative authoring/runtime experiments if they demonstrate a clear quality or workflow benefit. | Both are substantial engine choices; MCP is an editor bridge, not a fluid-runtime export format. |

Blender MCP is a real third-party bridge, and Blender’s own Python API is enough
to construct and render the reference without it. Current upstream telemetry and
execution behavior merit inspecting the pinned addon/server together; the tools
report records the specific disable paths and capabilities. No MCP, tool license
or hosted generation service was installed or purchased during this investigation.
[Blender Python API](https://docs.blender.org/api/current/),
[Blender MCP](https://github.com/ahujasid/blender-mcp).

Two 2026 developments change older advice: Unity 6.6’s September release makes
WebGPU production-supported, including compute and VFX Graph, and Unreal 5.8 has
official editor MCP documentation. These make the tools credible alternatives;
they do not make a migration automatically worthwhile for a working custom WGSL
renderer. [Unity announcement](https://discussions.unity.com/t/unity-6-6-is-now-available/1735357),
[Unreal MCP](https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor).

## Implementation update — September 10

Water/mist and ember/flame temperaments, transported thermal state, fuel reaction,
inertial embers, intentional gaze, blink choreography, vessel spin and native
visibility pause are now implemented. The user rejected the first candle-sized
flame; the current source has three separately heated roots across the chamber.
A small HDR camera pass preserves luminous flame and reflected-light highlights.
See the [gaze/spin implementation notes](2026-09-10-orb-gaze-and-spin.md) and
[recorded evidence](../visuals/mission-room/README.md). The roadmap below records
the original acceptance criteria, not a claim that these remain research-only.
Photographic material fidelity still falls short of the approved concept.

## Implementation and acceptance

First, establish a repeatable reference scene with the same camera, shell,
eyes, water level and lights as the live renderer. This addresses the current
gap between a mathematically real simulation and the cinematic material quality
of the selected concept. Then build the spring-driven gaze and one complete
notice/respond/recover interaction. Add thermal state and a small flame, verify
cooling and source shutoff, and only then add fuel exhaustion and inertial embers.

Connect expressions to observed transitions through a deterministic controller.
The controller chooses bounded forces, source targets and eye poses; an answer
model should not emit arbitrary shader values. Composer focus, an explicit
nudge, a pending request, an answer arriving and an actual attention transition
are useful inputs. A running process alone does not establish useful progress,
and a finished turn does not establish that a change passed review.

Preserve the field and its velocity while changing expression. Do not reseed
the water and smoke every time a poll returns. Material selection should change
sources and optics continuously where the state representations allow it.
Motion off should freeze eyes, material, embers and illumination together, while
text updates remain immediate. This follows the existing app’s motion contract
and Apple’s guidance on purposeful, optional animation.
[Apple motion guidance](https://developer.apple.com/design/human-interface-guidelines/motion).

Acceptance needs both physics and appearance. Show input ending while the
material continues, fuel exhausting, temperature cooling, embers contacting water,
and the character remaining readable in both themes. Record finite fields,
bounded concentrations, pressure behavior, pause/resume and frame cost. Compare
the live frame with the controlled reference at the actual app size. Passing
numerical checks is necessary; it does not substitute for a convincing character.

## Research references

- [Fire and thermal physics](2026-09-10-orb-fire-physics.md): 27 primary-source references, reduced combustion, optics, embers, coupling, bounds and tests.
- [Expression and alternative physics](2026-09-10-orb-expression-physics.md): perception evidence, material taxonomy, springs, state mapping and motion guidance.
- [Authoring and MCP pipeline](2026-09-10-orb-tools-pipeline.md): current tool availability, source inspection, licenses, export boundaries and proposed workflow.
- [Existing liquid and gas foundation](2026-09-09-realtime-orb-physics.md): solver comparison, pinned provenance and measured Electron evidence.
