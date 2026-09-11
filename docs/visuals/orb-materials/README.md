# Materials inside Wanigan

This directory records the preceding materials build. Snow and plasma were
subsequently replaced; see the [snow/plasma revision](../orb-snow-plasma/README.md)
for current behavior and its separate verification evidence.

The user approved all seven material ideas, deeper lava behavior and a fire
rework. During visual review they rejected fire above water. Fire now has its
own dry chamber: its fuel source sits near the base, and the gas solver ignores
the inactive water obstacle. Dry modes also omit the blue studio-floor
reflection that could be mistaken for a liquid surface.
Switching back to water also excludes residual fire emission and fire lighting.

Open **Wanigan → Make him yours** to choose a material. The same choice, solver
and optical detail carry into the small desktop companion. **Drop some ink**
selects Ink blooms as well as emitting dye, so the action always has a visible
result. **Shake the globe**, dragging and the existing keyboard actions apply
bounded impulses. Appearance controls do not launch sessions or model calls.

| Choice | Simulation and interaction |
| --- | --- |
| Water & mist | Existing PBF water, volumetric mist, bubbles and impact-driven rain ripples. |
| Ember & flame | Transported fuel, heat and soot; pressure-projected buoyant gas; staggered hot embers. No rendered water in this mode. |
| Lava lamp | Four larger wax parcels and four smaller satellite parcels (64 particles), local heating/cooling and heat exchange. Finite-range cohesion lets necks form and separate. |
| Ferrofluid | A 128² moving free surface responds to a patterned magnetic pressure, gravity, surface smoothing and damping. Area-balanced pressure depresses the surrounding pool as peaks rise. An 80³ volume reconstructs the surface. |
| Ink blooms | A 64³ dye field follows actual reconstructed water velocity. Bounded dye-dependent buoyancy feeds back into the water pressure solve. A new answer produces a green bloom. |
| Jelly core | A 64-particle elastic rest network deforms under handling, gravity and vessel contact. The reconstructed translucent body refracts light. |
| Honey | Cohesive particles with strong neighbor viscosity, wall adhesion and drag form a slow, translucent amber material. |
| Snow globe | 192 flakes follow fluid drag, gravity and contact with the vessel. A shake lifts them; they gradually settle. |
| Plasma globe | Eight damped filament chains, 16 nodes each, respond to a pointer electrode. Their radiance is evaluated from the actual segments, avoiding a coarse voxel silhouette. |
| Floating pearls | Three rigid spheres participate in the existing PBF constraint solve. Light and dense spheres exchange displacement with water. Their visible centers come from the final rigid-particle positions. |

Entering or leaving Floating pearls rebuilds the decorative fluid scene and its
buffer bindings. The rigid particles are excluded from liquid reconstruction,
and the sphere envelopes are kept inside the vessel. This never changes agent
sessions or project records.

## Visual evidence

All captures use real Electron and WebGPU. UI data is explicitly synthetic.
The isolated physics harness does not start Wanigan's main process or an agent.

| View | Dark before | Dark after | Light before | Light after |
| --- | --- | --- | --- | --- |
| Mission room | [Before](before/mission-dark.png) | [After](after/mission-dark.png) | [Before](before/mission-light.png) | [After](after/mission-light.png) |
| Material picker | [Before](before/play-dark.png) | [After](after/play-dark.png) | [Before](before/play-light.png) | [After](after/play-light.png) |

The [GPU report](physics/verification.json) records actual material movement,
magnetic release, ink-to-water momentum transfer, snow settling, electrode
tracking, pearl buoyancy, containment, pause behavior and the built renderer's
digest. Its fire-to-water check holds the water and view fixed, removes only the
old heat field, and compares the rendered pixels. The [UI report](after/ui-verification.json) covers all ten choices,
viewport bounds, persistence, handling, real-event boundaries through fixtures,
and no automatic model calls.

The existing [water/fire regression](water-fire-regression.json) and
[water play regression](water-play-regression.json) also pass. The sustained
flame check retains the existing speed bound: measured maximum `0.677`, below
`0.8`, with finite nonnegative thermal fields and a working pressure projection.

The required `npm test` suite completed with **1,509 passing assertions and no
failures**. Both macOS packages were built and [verified](package-verification.json):
all 22 built output files match their archived bytes, and both bundles pass the
signature, integrity, fuse and executable-helper checks. These are local builds;
installation is a separate step because a full quit ends live agent terminals.
After explicit user approval, the verified arm64 bundle was installed into
`/Applications/Wanigan.app` and relaunched. Its installed archive matches the
verified package, and the actual Mission room window reopened.

The [standalone native probe](real/verification.json) passed with the real main
process and preload: the small companion ran at about 17 frames per second,
hiding stopped GPU submissions, showing resumed them, and Motion Off froze
rendering. An earlier combined-run hide-event check timed out; subsequent
isolated and instrumented runs passed without changing visibility code. The
timeout's cause was not established, so this is not a claimed visibility fix.

Short captures of the running GPU simulation: [ferrofluid](physics/ferro.webm),
[plasma](physics/plasma.webm), [jelly](physics/jelly.webm),
[honey](physics/honey.webm), [ink](physics/ink.webm),
[snow](physics/snow.webm), [pearls](physics/pearls.webm),
[lava](physics/lava.webm) and [fire](physics/fire.webm).

```sh
source "$HOME/.nvm/nvm.sh" && nvm use
npm test
node scripts/probe-orb-expression.mjs
npm run build
node scripts/probe-orb-materials.mjs docs/visuals/orb-materials/physics --record
node scripts/probe-orb-materials-ui.mjs
node scripts/probe-orb.mjs /private/tmp/wanigan-materials-regression
node scripts/probe-orb-play.mjs /private/tmp/wanigan-materials-play
node scripts/probe-companion-presence-real.mjs docs/visuals/orb-materials/real
git diff --check
```

## Fidelity

These are bounded interactive graphics simulations. Ferrofluid uses a prescribed
magnetic pressure pattern and a height field rather than solving the complete
magnetostatic free-surface problem; it cannot form overhangs. Its pressure
balance controls area-averaged height drift, not exact 3D mass conservation. Honey is a reduced viscous particle model,
not a measured constitutive law. Snow is one-way coupled to water. Plasma is a
responsive filament model, not a scientific electrical discharge solver. Wax
parcels and rigid pearl density control are approximate. These limits and the
primary references are described in the [physics research note](../../research/2026-09-10-orb-material-physics.md).

No recorded animation is used inside the product. Motion Off freezes the
simulation, and native hiding stops GPU submissions. The mobile interface is
outside this desktop change.
