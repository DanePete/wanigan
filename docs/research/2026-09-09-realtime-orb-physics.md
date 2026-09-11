# Live 3D physics for the Wanigan companion

Researched 2026-09-09 against primary documentation and locally inspected upstream source. The visual target is [the approved B concept](../visuals/mission-room/concept/approved-b.png): a clear spherical vessel, substantial moving water, luminous vapor above it, small dark eyes, strong reflected light, and contact with the surrounding scene. The user explicitly rejected image sprites, warped rendered assets, flat waves, and animation presented as fluid physics.

The initial investigation established compute availability. The implementation evidence at the end records subsequent live-fluid tests; the earlier proposed budgets remain starting estimates, not measurements.

## Recommendation

Build a dedicated WebGPU renderer with **real particle-based liquid dynamics, a separate 3D gas solver, and a glass optical compositor**. Use **Particles4All's Position Based Fluids implementation as the water reference/base** and the current **Three.js volumetric-fire example as the gas algorithm reference**. Both have MIT source. A Three.js material alone does not supply fluid dynamics. Blender can establish geometry and lighting; it does not replace the in-app solver. [Particles4All](https://github.com/matsuoka-601/Particles4All), [Three.js gas source](https://github.com/mrdoob/three.js/blob/dev/examples/webgpu_volume_fire.html).

For the first executable proof, finish **one physically reactive water vessel with proper glass and lighting** before integrating gas, speech, or dashboard behavior. The acceptance demonstration is a pointer impulse, liquid overshoot, overturning surface/droplets, wall collision, and settling while the camera can move. The B mockup's cinematic quality also depends on lighting, reflections, thickness, and composition; a correct solver alone will not reproduce it.

## Source revisions inspected

All clones were read-only research under `/private/tmp/wanigan-*`; nothing upstream was executed or installed into the app.

| Source | Inspected commit | Date on commit | License read |
| --- | --- | --- | --- |
| [Particles4All](https://github.com/matsuoka-601/Particles4All) | `58d6fa6d2c50e3f58da5c7a6f9b885ce26c485f0` | 2026-08-24 | MIT, copyright 2026 matsuoka-601 |
| [Splash](https://github.com/matsuoka-601/Splash) | `3df5d621e6f153d7269037cbd8606bd83796f3fd` | 2025-04-23 | MIT, copyright 2025 matsuoka-601 |
| [WaterBall](https://github.com/matsuoka-601/WaterBall) | `94130dced92b083ece104ff8fbaf559949d86635` | 2025-02-22 | MIT, copyright 2025 matsuoka-601 |
| [WebGPU-Ocean](https://github.com/matsuoka-601/WebGPU-Ocean) | `3bd932778650b5e756ba2590969ed618313843ad` | 2025-06-09 | MIT, copyright 2025 matsuoka-601 |
| [Three.js](https://github.com/mrdoob/three.js) | `02198fbc4b89b52c3a218ca2921c70dbec74d360` | 2026-09-09 | MIT, copyright 2010–2026 three.js authors |
| [Original Babylon fluid project](https://github.com/Popov72/FluidRendering) | `a5ca5f57edea61550e7dfe856588396769f820e8` | 2023-01-22 | MIT; current Babylon engine is separately Apache-2.0 |

Retain upstream notices with any copied/adapted code. Particles4All identifies its bundled Quarry Cloudy panorama as CC0; that statement does not license unrelated downloaded scenery or models. [P4A license](https://github.com/matsuoka-601/Particles4All/blob/main/LICENSE), [environment attribution](https://github.com/matsuoka-601/Particles4All/blob/main/README.md), [Babylon engine license](https://github.com/BabylonJS/Babylon.js/blob/master/license.md).

## What the water candidates actually solve

| Candidate | Actual simulation | Rendering | Fit for a sealed orb |
| --- | --- | --- | --- |
| **Particles4All** | Position Based Fluids: neighborhood density constraints, iterative position correction, XSPH viscosity, optional cohesive/curvature surface tension. Rigid bodies can share the constraint loop. | Anisotropic kernels, narrow-range filtered screen-space water; also density-field ray tracing and mesh modes. | Best current quality foundation. Replace box boundaries with a spherical cavity and build glass composition. Avoid unused rigid/mesh features. |
| **Splash** | MLS-MPM: particle-to-grid mass/momentum, density-derived pressure and viscous stress, grid forces, grid-to-particle transfer. | Screen-space particle depth and thickness, narrow-range filter, reflection/refraction. | Strong simpler alternative. Add interior sphere grid/particle boundary and glass. No gas solver. |
| **WaterBall** | MLS-MPM, with central attraction and outward response when particles enter an inner sphere. | Screen-space fluid with bilateral depth smoothing. | Existing water is **outside/on a sphere**, not liquid inside a half-full vessel. Its radial boundary logic is useful reference, not the requested result. |
| **WebGPU-Ocean** | Both MLS-MPM and SPH implementations. SPH explicitly computes density, pressure/viscous forces, then integrates. | Earlier screen-space fluid with bilateral smoothing. | Educational baseline; Splash/P4A contain later surface-quality work. |
| **Three.js fluid-particles example** | Real MLS-MPM compute kernels. | Instanced icosahedral particle geometry with `MeshStandardNodeMaterial`; no continuous glassy water surface in this example. | Good TSL integration reference; renderer still needs substantial work. |

These conclusions come from the implementations, not the names: [P4A constraints](https://github.com/matsuoka-601/Particles4All/blob/main/src/wgsl.js), [Splash pressure/stress](https://github.com/matsuoka-601/Splash/blob/main/mls-mpm/p2g_2.wgsl), [WaterBall radial response](https://github.com/matsuoka-601/WaterBall/blob/main/mls-mpm/g2p.wgsl), [Ocean SPH](https://github.com/matsuoka-601/WebGPU-Ocean/tree/main/sph), [Three.js liquid example](https://github.com/mrdoob/three.js/blob/dev/examples/webgpu_compute_particles_fluid.html).

### Particles4All: exact seams to adapt

- `src/scene.js`: `buildScene()`, `fluidBlock()`, `boundaryParticles()`, `boundaryFor()`. Current wall samples form a rectangular shell. Each boundary particle receives a kernel-normalized `psi` used in density/gradient evaluation. Generate an evenly sampled spherical cavity instead and seed liquid only inside that cavity below the fill plane. Preserve density support at walls; merely clipping particle pictures to a circle is not confinement. [Source](https://github.com/matsuoka-601/Particles4All/blob/main/src/scene.js).
- `src/wgsl.js`: `predictWGSL` applies gravity and advances predicted positions. `lambdaWGSL` computes `C = rho/rho0 - 1` and its constraint multiplier for compressed particles. `deltaWGSL` computes neighbor and boundary corrections, currently ending with an axis-aligned clamp. Replace that final clamp with an interior sphere projection and consistent collision velocity treatment; keep the bounding grid as a conservative allocation region. `xsphWGSL`, `normalsWGSL`, and `tensionWGSL` are the viscosity and surface-tension passes. [Source](https://github.com/matsuoka-601/Particles4All/blob/main/src/wgsl.js).
- `src/sim.js`: `Sim.reset(params)`, `Sim.step(frameDt)`, `applyRayImpulse(origin, dir, impulse, radius, speedLimit)`, `livePos()`, `liveVel()`. `step()` already uses fixed substeps and a bounded catch-up bank. Keep the GPU buffers private to a renderer instance and input impulses bounded. Turn off pouring and rigid bodies for the companion. Add explicit teardown for all resources; the research demo is not a lifecycle-safe React component. [Source](https://github.com/matsuoka-601/Particles4All/blob/main/src/sim.js).
- `src/aniso_wgsl.js` and `src/mesh.js:buildAnisotropy()`: reconstruct smoothed positions and anisotropic particle kernels from neighborhoods. This is how a modest particle count can read as a continuous liquid. [Anisotropy](https://github.com/matsuoka-601/Particles4All/blob/main/src/aniso_wgsl.js), [orchestration](https://github.com/matsuoka-601/Particles4All/blob/main/src/mesh.js).
- `src/ssfr.js:FluidSSFR` + `src/ssfr_wgsl.js`: depth/thickness splats and separable narrow-range smoothing; `src/ssfr_composite_wgsl.js` reconstructs normals and applies Fresnel, absorption, reflected environment, and refraction. Useful initial water proof, but this compositor assumes a first visible water surface, not a nested glass vessel. [Passes](https://github.com/matsuoka-601/Particles4All/blob/main/src/ssfr.js), [compositor](https://github.com/matsuoka-601/Particles4All/blob/main/src/ssfr_composite_wgsl.js).
- `src/mesh_wgsl.js:meshDensityWGSL`, `src/ray_wgsl.js`, `src/ray.js`: build and traverse a 3D fluid density field. For the final orb, this is the more faithful rendering route: bend the camera ray at the analytic glass sphere, then intersect the actual fluid field along that bent ray. It supports interior optics that a single screen-space depth map cannot represent reliably. This proposed extension is not already supplied by the demo. [Density](https://github.com/matsuoka-601/Particles4All/blob/main/src/mesh_wgsl.js), [ray traversal](https://github.com/matsuoka-601/Particles4All/blob/main/src/ray_wgsl.js).

The P4A README links the underlying [unified particle paper](https://matthias-research.github.io/pages/publications/flex.pdf), [anisotropic reconstruction paper](https://cs.nyu.edu/~exact/doc/anisotropic.pdf), and [narrow-range filter paper](https://ttnghia.github.io/pdf/NarrowRangeFilter.pdf). The implementation is a real-time numerical approximation, not an engineering CFD validation.

Suggested first water parameters, to be tuned after measurement: a radius-1 cavity centered in a `[2.4, 2.4, 2.4]` grid domain, spacing `0.05`, support radius `h = 2 × spacing`, rest density `1000`, gravity `9.81`, two substeps, four constraint iterations, `cfmEpsilonRel=0.01`, `sCorrK=0.1`, `sCorrDq=0.3`, `xsphC=0.066`, `omega=1.03`, `sorAverage=false`, `surfaceTensionK=0.4`, `bodies=[]`, `pour=false`. The numerical tuning comes from the small preset, while cavity/spacing are proposed. Seed the lower cavity rather than filling an arbitrary particle-count prefix. Preserve `buildScene()`'s mass calibration and `denomRest` calculation: `uploadParams()` scales constraint softness and artificial-pressure correction with them. Apply outward contact-velocity removal in `finalizeWGSL` **after** viscosity/tension corrections. [Preset](https://github.com/matsuoka-601/Particles4All/blob/main/presets/small.ini), [scene calibration](https://github.com/matsuoka-601/Particles4All/blob/main/src/scene.js), [uniform scaling](https://github.com/matsuoka-601/Particles4All/blob/main/src/sim.js).

### Splash: smaller alternative

`mls-mpm/mls-mpm.ts:MLSMPMSimulator.execute()` runs `clearGrid → p2g_1 → p2g_2 → updateGrid → g2p → copyPosition`. `p2g_2.wgsl` computes density from neighboring grid masses, pressure from a Tait-style relation (exponent 1 here), and viscous stress; it is not independent ballistic particles. `updateGrid.wgsl` adds gravity/input force and currently blocks axis-aligned wall velocity. `g2p.wgsl` contains final particle integration/boundary handling. These two passes are the sphere-collision seam. [Driver](https://github.com/matsuoka-601/Splash/blob/main/mls-mpm/mls-mpm.ts), [grid](https://github.com/matsuoka-601/Splash/blob/main/mls-mpm/updateGrid.wgsl), [particle update](https://github.com/matsuoka-601/Splash/blob/main/mls-mpm/g2p.wgsl).

`render/fluidRender.ts`, `narrowRangeFilter.wgsl`, `thicknessMap.wgsl`, and `fluid.wgsl` supply the surface pipeline. Upstream defaults and reported huge particle demonstrations are not a Wanigan performance budget. [Renderer source](https://github.com/matsuoka-601/Splash/tree/main/render).

## Gas: use a separate three-dimensional solver

The official `examples/webgpu_volume_fire.html` has genuine 3D simulation, in addition to artistic turbulence/detail. `createComputePasses()` creates velocity advection, divergence, Jacobi pressure, pressure-gradient subtraction, dye/temperature advection, and source injection. `Storage3DTexture` fields are double-buffered. It also adds precomputed curl-noise forcing and detail noise; those additions should not be mistaken for the solver itself. [Official source](https://github.com/mrdoob/three.js/blob/dev/examples/webgpu_volume_fire.html).

The inspected example uses a **100 × 100 × 200** grid and **2 Jacobi iterations**, with comments suggesting more iterations. That is a demonstration choice, not proof of incompressibility or suitability for a desktop companion. Its gas is rendered through `VolumeNodeMaterial` with sampled density, absorption, light scattering, and emissive fire. For Wanigan, remove flame emission, use a wispy cooler density palette, impose a spherical solid mask in advection/projection, and sample the gas along the glass-refracted ray. Start at 48³ or 64³ and measure pressure convergence; these resolutions are proposals. [Compute stages and volume material](https://github.com/mrdoob/three.js/blob/dev/examples/webgpu_volume_fire.html).

Do not imply that two independent solvers form a physically coupled two-phase water/air system. A first implementation can use real liquid dynamics and real gas dynamics sharing the same vessel, with gas masked out below the liquid surface. Two-way transfer of momentum, trapped gas, and bubble pressure would be additional work. Decorative bubbles with buoyant trajectories must be described separately from the liquid solver.

## Glass, eyes, light, and alpha

P4A's `main.js` explicitly configures `alphaMode: 'opaque'`; its final fluid and ray shaders output alpha 1, including empty pixels. These must change for a compositor that sits naturally on the app. Set premultiplied output, clear transparent, and return zero outside the analytic outer sphere. Simply changing a CSS background or canvas opacity will not remove the upstream sky/floor. [Setup](https://github.com/matsuoka-601/Particles4All/blob/main/src/main.js), [fluid output](https://github.com/matsuoka-601/Particles4All/blob/main/src/ssfr_composite_wgsl.js), [WebGPU canvas configuration](https://developer.mozilla.org/en-US/docs/Web/API/GPUCanvasContext/configure).

The final render needs explicit interfaces: air → glass shell → interior air/water → exit shell, thickness-aware absorption, total internal reflection handling, and an environment map with softbox-like highlights. Keep physically distinct glass and water indices and shell thickness. The eyes should be small 3D objects within the scene, with eyelid/blink geometry and a bounded gaze rig; rendering them as ordinary HTML dots bypasses refraction and reveals the compositing trick. These are design requirements inferred from the approved image, not out-of-box features of P4A.

An alpha canvas cannot refract arbitrary live HTML behind it because those pixels are not automatically a shader texture. Use a deliberate in-canvas environment/background matching the companion stage; leave surrounding app pixels transparent. Actual refraction of the whole UI would need a separately supplied scene texture and is unnecessary for the approved composition.

## GPU cost and Electron integration

Chrome has supported WebGPU on macOS since Chrome 113; that establishes platform feasibility, not availability in every Electron process. Wanigan pinned Electron 44.0.0 when this was written (44.3.0 since 11 Sep 2026) and loads the production renderer with `loadFile()`. Test `isSecureContext`, `navigator.gpu`, `requestAdapter()`, `requestDevice()`, a compute dispatch, and readback in **that production loading mode**, not just a localhost Chrome demo. Keep hardware acceleration on and handle adapter/device failure honestly. [Chrome platform documentation](https://developer.chrome.com/docs/web-platform/webgpu/overview), local `package.json` and `src/main/index.ts`.

**Observed local compute proof, 2026-09-09:** the implementation task ran `/private/tmp/wanigan-gpu-probe.mjs` on this M2 Pro Mac using the repository's Electron 44 binary and an isolated temporary user-data directory. The script was inspected for this note: it loads the actual app, requests a low-power adapter, dispatches a WGSL kernel multiplying four stored floats by two, copies to a readback buffer, and maps the result. It exited 0 and reported:

```json
{"available":true,"secure":true,"origin":"file:","vendor":"apple","architecture":"metal-3","result":[2,4,6,8],"maxStorageBuffer":134217728}
```

This confirms WebGPU compute and readback in the app's existing `file:` loading mode without unsafe GPU switches. It does **not** establish the fluid solver's stability, render fidelity, frame rate, or suitability for every user's GPU. There is no reason from this probe to change the application origin.

If a custom app protocol is actually required, Electron supports standard/secure/fetch privileges, but changing the app origin affects storage and IPC trust checks. Do not preemptively change origins or disable security to make a demo run. No `enable-unsafe-webgpu`, ignored GPU blocklists, `webSecurity: false`, or unsandboxed renderer should become the product solution. [Electron protocol API](https://www.electronjs.org/docs/latest/api/protocol), [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security).

Avoid importing the P4A demo wholesale. Its `SurfaceMesh.configure()` allocates three density fields and, by default, storage for **3 million triangles (72 MB for its packed vertex buffer alone)**, even when a small orb needs no triangle mesh. Its current small preset uses 30,000 particles, two substeps, four constraint iterations, and screen-space scale 0.4. Separate anisotropy/density reconstruction from optional marching-mesh buffers. [Allocation source](https://github.com/matsuoka-601/Particles4All/blob/main/src/mesh.js), [small preset](https://github.com/matsuoka-601/Particles4All/blob/main/presets/small.ini).

Proposed starting experiment: 12–24k liquid particles, no rigid bodies/pouring, a 320–480 device-pixel render target, and a 64³ or 96³ density field. Keep the fluid step fixed and cap catch-up; reduce particle/field resolution according to **measured GPU milliseconds**, not CSS size alone. P4A already contains optional `timestamp-query` instrumentation with asynchronously mapped readback in `src/gputimer.js`; use it to separate simulation, surface reconstruction, glass, and volume cost. [Timing source](https://github.com/matsuoka-601/Particles4All/blob/main/src/gputimer.js).

Suspend GPU work when hidden, offscreen, or motion is off. Render a settled frame on resize/theme/state changes. Reuse one principal orb instance, dispose all textures/buffers/listeners, and handle device loss. Measure terminal responsiveness while the orb is active. Static/reduced operation is an explicit supported mode, not a fallback pretending to be live physics.

## Babylon and other alternatives

Babylon's fluid renderer is established screen-space rendering and was incorporated into Babylon 5.36.0. The original project's separate `FluidSimulator2/fluidSimulator.ts` is real CPU SPH with spatial hashing, density/pressure, viscosity, and adaptive stepping. Its glass example has a hollow sphere collision primitive and a refractive PBR material. This proves useful techniques, but the CPU solver and renderer are separate systems, and switching the whole orb to Babylon does not buy a ready GPU two-phase solver. Some included demonstrations play **precomputed particle files**; do not present those as live dynamics. [Original project](https://github.com/Popov72/FluidRendering), [SPH code](https://github.com/Popov72/FluidRendering/blob/master/src/scenes/FluidSimulator2/fluidSimulator.ts), [glass scene](https://github.com/Popov72/FluidRendering/blob/master/src/scenes/fluidSimulationDemoGlass.ts), [precomputed scene](https://github.com/Popov72/FluidRendering/blob/master/src/scenes/fluidSimulationDemoPrecomputeRendering.ts).

Three.js Compute Water is a height field. Rapier/Havok are useful rigid-body engines. Rive/Spline are useful authoring and expressive-animation tools. None of these labels is evidence of volumetric free-surface liquid and gas physics. The selected path needs a solver whose pressure/constraints and boundary conditions can be inspected and exercised. [Three.js height-field implementation](https://github.com/mrdoob/three.js/blob/dev/examples/webgpu_compute_water.html), [Babylon rigid-body documentation](https://doc.babylonjs.com/features/featuresDeepDive/physics/v2/rigidBodies).

### Where Blender MCP helps

`ahujasid/blender-mcp` is a third-party authoring bridge: an MCP server sends commands to a Blender addon, which manipulates scene objects/materials and executes Blender Python. That is useful for sculpting the shell/eyes, establishing lighting, inspecting a reference scene, and exporting suitable static assets. It does not expose a live liquid solver for an Electron canvas. Optional hosted model-generation integrations are separate services and are unnecessary for a spherical vessel. [Project capabilities and architecture](https://github.com/ahujasid/blender-mcp).

Blender itself has fluid simulation and cached/baked outcomes. A rendered movie, cached particle sequence, or exported static mesh can be physically generated yet still cannot react to a new pointer impulse in the shipped app. Use Blender as the material/lighting reference and asset authoring environment; retain the WebGPU simulation at runtime. [Blender fluid modifier](https://docs.blender.org/manual/en/latest/modeling/modifiers/physics/fluid.html), [fluid cache documentation](https://docs.blender.org/manual/en/4.4/physics/fluid/type/domain/cache.html).

## Acceptance evidence before calling it finished

1. A real Electron capture in both themes, at the B concept's viewing size, showing vessel depth, visible water thickness, believable reflections, 3D eyes, and coherent contact lighting.
2. An interaction recording: input ends, liquid continues, rebounds against the sphere, and settles. Rotate the camera to prove actual depth; show particle/density diagnostic mode as separate engineering evidence.
3. Numerical checks: finite positions/velocities, no particles escaping the cavity under worst bounded input, bounded density error, stable fixed-step behavior, and gas divergence before/after projection if gas ships.
4. GPU pass timing, memory allocation accounting, no simulation work when hidden/off, and unchanged terminal interaction responsiveness. Hardware and render resolution accompany every performance claim.
5. No requests to hosted assets or billed AI services for rendering; no unverified claims that the companion knows agent state. Session summaries and the physical character remain separate modules.

## Implemented runtime and measured evidence

The current renderer uses 8,144 liquid particles with spherical contact, an 80³
liquid reconstruction, a 64³ gas field, 32 buoyant bubble tracers and analytic
refracting glass. Gas velocity uses dissipative first-order transport; dye uses
a limited MacCormack correction to retain detail. Pressure projection follows
forces, including buoyancy and bounded vorticity confinement. MacCormack is used
for its correction/limiter principle, implemented locally in WGSL; no proprietary
shader is copied. [NVIDIA GPU Gems 3, chapter 30](https://developer.nvidia.com/gpugems/gpugems3/part-v-physics-simulation/chapter-30-real-time-simulation-and-rendering-3d-fluids).

The shell uses refractive index 1.46, liquid 1.333, separate ray crossings,
Beer attenuation and Fresnel reflection. Studio lighting is the locally bundled
CC0 [Studio Small 04, Greg Zaal / Poly Haven](https://polyhaven.com/a/studio_small_04).
The generated room backdrop is a textured plane in the optical scene. Neither
image contains a character or fluid animation. The volume and ray optics are
recomputed locally, and drag input changes liquid particle velocity.

The reproducible entry point is `node scripts/probe-orb.mjs` after a production
build. It uses an isolated Electron 44 window, no Wanigan main process, no user
profile, no agent launches and no model calls. The [current JSON evidence](../visuals/mission-room/physics/verification.json)
includes its renderer SHA-256, GPU-completion timings, containment, density,
pause invariance, impulse response, gas divergence and sustained-run checks.
The [recording](../visuals/mission-room/physics/live-fluid.webm) is captured from
the running GPU canvas, not generated video. The adjacent light/dark PNGs are
actual rendered frames.

The initial water/gas-only baseline measured 9.7 ms median and 11.1 ms p95
on the M2 Pro. The renderer now also includes thermal transport, fuel reaction,
embers, vessel drag and an HDR camera pass. Use the linked JSON for the current
water and fire timings, renderer hash, pressure measurements and source-off
cooling evidence. The probe also verifies that a spinning shell transfers angular
momentum into the water without rotating gravity, and that the completed spin
leaves finite, contained particles. These remain isolated one-device measurements.

The remaining fidelity limits are explicit: no anisotropic reconstruction yet,
no two-way gas/liquid/bubble coupling, no physically traced floor caustics, and
a coarse visual gas grid. The vessel is a real interactive simulation; numerical
stability does not establish a visual match to the cinematic concept.
