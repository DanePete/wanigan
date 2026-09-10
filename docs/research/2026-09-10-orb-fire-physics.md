# Fire and thermal physics for the Wanigan orb

## Recommendation

Extend the existing WebGPU gas solver with separate thermal and combustion state, and render its emission through the existing glass and liquid optics. This is the shortest route to a responsive flame whose motion, exhaustion, and cooling depend on previous simulation state. It preserves the working liquid solver and avoids embedding a second rendering engine.

The useful distinction is between **transported heat**, **fuel-consuming fire**, and **a resolved combustion front**. They are different implementation levels. A flame-colored gas volume can have real fluid motion without simulating combustion. A fuel-consuming volume can have real reaction state without resolving flame chemistry or a moving thin reaction interface. None of these should be described as an engineering fire model.

For the first fire experiment, use a small, bounded fuel-and-heat source above the liquid, temperature-driven buoyancy, fuel consumption, soot production, cooling, and emission based on temperature. Keep liquid-to-gas coupling one way. Add a small population of inertial glowing particles after the volume is stable. Defer pressure expansion, boiling, two-way phase coupling, and plasma dynamics.

This assessment reflects source availability checked on September 10, 2026 UTC. The proposed parameter ranges and scene behaviors below are engineering starting points, not measured performance or calibrated material properties.

## Existing implementation and the missing state

The inspected working tree already contains an appropriate foundation:

| Surface | Observed implementation | Thermal implication |
|---|---|---|
| Liquid | Real Position Based Fluids, derived from Particles4All at `58d6fa6d2c50e3f58da5c7a6f9b885ce26c485f0`; neighbor search, density constraints, viscosity, surface tension, and spherical containment. | Preserve this solver while testing fire. |
| Reconstructed liquid | `runtime.ts` reconstructs density and weighted velocity into an `80³` volume. | Gas can obtain both the liquid boundary and its motion without CPU readback. |
| Gas | `gas.ts` uses a `64³` collocated grid, semi-Lagrangian velocity transport, limited MacCormack correction for dye, confinement, and 24 Jacobi pressure iterations. | Transport and projection already exist. No fuel, oxygen, or thermal energy field exists in this snapshot. |
| Current plume | The fourth velocity-texture component contains dye. Its value drives upward forcing; an emitter and bounded stirring force replenish motion. | This is a dye-driven flow, not temperature or combustion. |
| Boundary | `open()` excludes the spherical wall and liquid above a density threshold. Projection removes velocity toward blocked cells. | This represents an obstacle, but does not yet impose a moving liquid boundary velocity. |
| Optics | `optics.ts` bends rays at glass and water interfaces, absorbs light in water, and integrates gas attenuation and approximate light visibility. | Add emitted radiance within this same ray path; a screen overlay would bypass the optical model. |

These observations are from [gas.ts](../../src/renderer/src/orb/gas.ts), [runtime.ts](../../src/renderer/src/orb/runtime.ts), [optics.ts](../../src/renderer/src/orb/optics.ts), and the [vendor provenance](../../src/renderer/src/orb/vendor/README.md). The implementation was being developed concurrently; these are snapshot descriptions, not assertions about every later revision.

The isolated M2 Pro result supplied with the implementation context was approximately 10 ms per frame with 8,144 liquid particles. It is a baseline report, not a fire benchmark. The [probe](../../scripts/probe-orb.mjs) explicitly distinguishes isolated Electron rendering with GPU completion from whole-application frame rate. Added thermal passes, embers, and emission have not been benchmarked here.

## What qualifies as simulated fire

| Level | Persistent state and evolution | Honest description |
|---|---|---|
| Animated material | Time, noise, UV movement, or an image sequence determines pixels. | Procedural flame effect or cached animation. |
| Thermal fluid | Velocity and pressure evolve; transported temperature changes buoyancy; density changes visibility. | Real fluid simulation with a thermal fire appearance. |
| Reduced combustion | Transported fuel is consumed; reaction adds heat and soot; fuel exhaustion and cooling change subsequent behavior. | Real fluid simulation with a simplified combustion model. |
| Thin flame or reacting-flow model | A reaction interface or species/mixing model determines burning, expansion, and heat transport. | A more detailed combustion simulation, with its particular approximations stated. |

An animated noise field can supply a force or unresolved rendering detail to a real solver. The decisive test is whether independently stored state is advanced by transport and reaction. Disabling rendering detail must leave the plume's mass distribution and dynamics intact. Conversely, ray marching a procedural field establishes three-dimensional rendering, not fluid dynamics.

The classic GPU Gems treatment advects a reaction-age coordinate and maps it to flame colors. That supplies a useful lifetime model but is not a chemical reaction solver. Its thermal buoyancy and volume-rendering discussion remain relevant to a compact GPU implementation. [^1]

Nguyen, Fedkiw, and Jensen's SIGGRAPH 2002 model goes further: it tracks a thin interface between fuel and products, couples their flows through expansion, and distinguishes the blue reaction region from hot-soot radiation. This is a meaningful reference for a later flame-front experiment; its coupled solver should not be reduced to a claim that adding one scalar reproduces the paper. [^2]

## A bounded combustion model for this renderer

### State and units

Use a separate scalar texture rather than overloading the existing dye component with every meaning. A practical first layout is `rgba16float = (fuel, temperatureExcess, soot, reactionRate)`, with ping-pong storage and a temporary advection texture. Preserve a separate velocity field. If an oxygen-limited mode is implemented, allocate oxygen independently or redesign the scalar packing; reaction rate can be recomputed or temporarily stored.

For the initial visual solver, define temperature excess as a normalized proxy, `theta = 0` at ambient conditions. Define distance in gas-domain widths and time in seconds. Do not expose proxy values as Celsius or measured thermal energy. A later calibrated model would need fuel properties, heat capacity, density, dimensional source rates, and a consistent length scale.

The following equations are a proposed reduced model, rather than a transcription of any one source:

```text
D_t F     = fuelSource - R
D_t theta = heatSource + heatYield * R - cooling(theta) + kappa * laplacian(theta)
D_t S     = sootYield * R - sootRemoval

forceBuoyant = up * (betaTemperature * theta - betaSoot * S)
```

`D_t` includes transport by the gas velocity. Soot and heat have different removal rates: a spent flame should leave a cooler plume for a while. Turning off the emitter should stop new material entering, not erase existing cells.

Use a bounded integrated reaction update. With ignition factor `a = smoothstep(thetaIgnite, thetaIgnite + ignitionWidth, theta)` and rate `k`, a useful first-order reaction law can be integrated locally as:

```text
burn = F * (1 - exp(-k * a * dt))
F -= burn
theta += heatYield * burn
S += sootYield * burn
reactionRate = burn / dt
```

This integration cannot consume more fuel than exists when `F`, `k`, `a`, and `dt` are nonnegative. Temperature and soot still require explicit bounds and diagnostics. Transport is not perfectly conservative, so a stable reaction update alone does not establish total mass conservation.

The inspected luma.gl WGSL provides a close practical comparison: it transports density, temperature, fuel, and age, uses a smooth ignition threshold, caps consumed fuel, adds heat and smoke, then dissipates channels. It does not transport oxygen. Its artificial fuel dissipation and scalar caps are further reasons to call it a visual-effects solver. [^3]

NVIDIA Flow's `combustSimulate()` independently demonstrates a normalized temperature threshold, bounded burn, fuel reduction, heat and smoke yields, and approximate cooling. Its `combustVelocity()` derives buoyancy and an expansion term from that state. The inspected source explicitly treats cooling as damping rather than a solved heat equation. [^4]

### Oxygen and the sealed-vessel question

A sealed glass sphere cannot support an indefinitely replenished flame without a source of fuel and oxidizer. The product must choose a model deliberately:

1. **Recommended first appearance: supplied flame.** The visible glass is an optical vessel around a deliberately sustained visual burner. Fuel injection and an assumed oxidizer reservoir are documented model assumptions. Do not describe this as sealed combustion.
2. **Finite chamber experiment.** Transport normalized oxygen `O`, cap `burn` by `O / oxygenPerFuel`, and reduce oxygen by the corresponding amount. With no inlet, the flame eventually extinguishes. This is a compelling finite interaction but adds state and testing.
3. **Thermal glow mode.** Inject heat into a nonreacting visible medium and call the result thermal or luminous vapor. This allows continuous warmth without claiming combustion.

An oxygen field by itself is not accurate chemistry. Mixing, heat loss, and extinction conditions also matter. NIST's FDS combustion documentation treats ignition and extinction through explicit modeling choices, including oxygen availability and temperature criteria. FDS is a reference for the omitted physics, not a realistic dependency for this decorative renderer. [^5]

### Transport, diffusion, and the flame front

Apply limited higher-order transport separately to fuel, temperature, and soot, using the same velocity and obstacle rules. Clamp interpolated scalars to valid ranges and use first-order transport near invalid departure samples. The present dye limiter is useful infrastructure, but independently advecting scalars does not guarantee species conservation or an exact flame speed.

A source can ignite its own emitted fuel immediately. Propagating fire into nearby cold fuel requires a heat-transfer or front model. Numerical diffusion from interpolation should not be presented as calibrated flame propagation. A small explicit thermal-diffusion pass is a tractable experiment; on a uniform three-dimensional grid its standard six-neighbor update requires `kappa * dt / h² <= 1/6` for nonnegative diffusion weights. Enforce that relationship rather than allowing a decorative control to violate it.

For a later thin-front experiment, a signed-distance field could track the fuel/product boundary, with normal propagation speed in addition to advection. That is a separate undertaking: front reinitialization, consistent pressure/velocity conditions, and geometric quality would need new validation. At `64³`, a flame only a few cells wide will remain a coarse approximation regardless of ray-march sample count.

### Projection and expansion

Keep zero target divergence for the first thermal mode. Heat changes buoyancy and motion, but this approximation omits volume expansion. Flame fullness can initially come from the source shape and transported vortices, with that omission stated.

Do not simply add positive divergence wherever fuel burns inside the current fully closed boundary. By the divergence theorem, integrated volume expansion must match boundary flux; a no-flow closed volume cannot accommodate a positive net source in a constant-density incompressible model. An expansion mode needs open outflow, a compressible/background-pressure treatment, or another explicitly stated approximation. Subtracting the mean source can make a numerical system compatible while introducing compensating contraction; that is not conservation of a physically modeled sealed flame.

Keep pressure iterations a quality parameter, not an emotional control. Confinement can restore small rolling structures lost to grid dissipation, but it supplies modeled small-scale energy rather than resolved turbulence. The original smoke paper establishes this role and also provides a reference for moving-object interaction. [^6]

## Heat, light, smoke, and embers

### Temperature-based emission

For a warm flame, the useful optical progression is a bright reaction region, luminous hot products, and a trailing nonemissive smoke plume. Store the quantities that control those regions separately. Making all dye orange cannot reproduce the transition from burning to spent smoke.

Planck's law supplies the spectral distribution for a blackbody at a Kelvin temperature. Its intensity and color both change with temperature; normalizing every temperature to equal brightness discards part of the model. PBRT provides a concrete implementation and distinguishes normalized spectra from emitted power. [^7]

For this renderer, precompute a small one-dimensional **linear RGB lookup table** from blackbody spectra and color-matching functions. Map the normalized simulation temperature into a declared artistic Kelvin interval only where the gas emits, retain a separate intensity scale, and tone-map after glass, water, smoke, and emission have been combined. A blackbody color table is static radiometric data; it does not replace the live simulation with cached animation. PBRT's spectral representation is a reference for the table construction, not a reason to embed a path tracer. [^8]

Do not call arbitrary cyan, purple, or saturated blue a hotter blackbody flame. A blue reaction core can be approximated by a narrow contribution tied to reaction rate, but that is a proxy for chemistry rather than simulated radical populations. A freely chosen palette remains appropriate for a fantasy energy mode if labeled accordingly.

Within each existing gas ray segment, integrate emitted radiance using the current throughput. For locally constant extinction `sigmaT` and volumetric source `j` over length `ds`, use:

```text
a = exp(-sigmaT * ds)
radiance += throughput * j * (1 - a) / sigmaT
throughput *= a
```

Use the `j * ds` limit when extinction approaches zero. This avoids making brightness depend arbitrarily on ray-march step count. PBRT derives the exponential transmittance relation and its segment composition. [^9]

Self-lighting is additional work. First let the flame be visible through the existing refracted ray and attenuated by smoke. Then test a coarse emissive-volume reduction or a few temporally smoothed light samples to illuminate water and nearby smoke. An emission term alone does not implement reflected firelight, caustics, or multiple scattering.

### Cooling

Start with `theta *= exp(-coolingRate * dt)`. This is predictable, bounded relaxation toward an ambient reservoir. It is not conduction, radiative heat transfer, or conservation of the combined gas-plus-vessel energy.

A nonlinear cooling experiment can make hot regions fade rapidly and cooler remnants persist. If it claims radiative loss, use absolute Kelvin temperatures and the difference between emitted and environmental radiation, along with the required thermal capacity and geometric factors. Applying `theta⁴` to an arbitrary color-control value is only an artistic cooling curve. With a stiff loss term, use a bounded or analytic update rather than allowing large frame deltas to overshoot ambient.

### Embers and sparks

Embers should be small simulated solids, not bright smoke cells. Store position, velocity, temperature, size, and remaining lifetime. A minimal one-way model samples gas velocity and temperature, applies gravity and drag toward the local flow, and cools each particle. Seed a bounded number from regions of high reaction activity, using a repeatable random seed for diagnostics.

For linear drag, the gas-following part can use an exponential relaxation toward sampled gas velocity. A finite response time gives embers inertia: they overshoot turns, fall when the updraft weakens, and are distinguishable from massless flow tracers. Collide with the sphere; extinguish or cool rapidly upon entering liquid. Those collisions must happen in simulation coordinates before rendering.

Begin with analytic glowing points or short motion segments, rendered through the same volume and shell where practical. A shader can draw a particle without a sprite asset; its geometry need not pretend that a sampled image is the source of the motion. Embers should produce a brief accent, not an unbounded secondary simulation or an always-on bloom cloud.

## One-way coupling to the liquid

The recommended boundary is **liquid influences gas and embers; gas and embers do not change liquid**. This is a deliberate approximation that protects the established liquid solver while introducing thermal behavior.

1. Advance the PBF liquid and reconstruct its density/velocity volume.
2. Derive the gas obstacle from that density using a consistent threshold and boundary sampling policy.
3. Where a moving liquid surface is used as a boundary, match the gas normal velocity to the reconstructed liquid normal velocity. Convert units: the liquid world-space diameter and normalized gas-domain width are not interchangeable.
4. Add an explicitly modeled cooling reservoir near liquid contact, or extinguish fuel there. This is quenching behavior without solving water heat uptake.
5. Update gas, reaction state, and embers, then render all media along the optical path.

Newly submerged cells must not retain hidden fuel that reappears when water moves away. Newly exposed gas cells need a defined ambient initialization or bounded extrapolation. Small moving boundaries can also cause source and pressure discontinuities; test a moving liquid surface before increasing reaction strength.

Do not generate steam while claiming evaporation unless the water loses corresponding mass and energy. A decorative white plume can be a separate mode, but phase change would require thermal state, latent heat, mass transfer, and appropriate vapor/condensation rendering. Do not call contact cooling a physically coupled boiling simulation.

## Expressive scenes and bounded control

Use state changes to alter sources and forces, then let the solver carry the transition. Avoid replacing the field with a new preset on every status change. Familiarity comes from consistent response time and recurring motion, while the actual flow keeps individual events from looking identical.

The following scenes are proposals. An emotion-like appearance is presentation; it must not assert subjective feelings or an unobserved confidence level.

| Scene | Proposed physical behavior | Operational trigger or interaction |
|---|---|---|
| Rest | Liquid settles; a low thermal plume or a few cooling embers remain. | No active work, with motion enabled. |
| Listening | A brief directional impulse leans the plume toward the interaction, then relaxes. | Deliberate local interaction or a known listening state. |
| Working | A narrow supplied flame strengthens gradually; vortices remain small enough to preserve the face. | Observed active work, without treating flame size as percentage completion. |
| Sustained effort | A broader source and modestly greater buoyancy create a fuller flame. | Explicit presentation preference or a known sustained activity interval. |
| Completion | A finite fuel pulse produces a brief flourish, followed by cooling and a small ember release. | A recorded successful completion event. |
| Waiting for input | The source tapers to a small steady flame; agitation drops. | A real pending-input or approval state. |
| Recoverable error | One bounded lateral disturbance followed by a visibly quieter state. | A recorded error; avoid an indefinitely frantic fire. |
| Finite chamber | A seeded fire consumes its available fuel/oxygen and dies out. | An explicit interactive demonstration mode. |

Use a low-pass controller for source targets, approximately 0.4–1.5 seconds initially, with faster onset only for a brief acknowledged event. Interruption should remove the source smoothly while leaving already injected heat and momentum to decay. A pause freezes the current simulation state; resume must not integrate the entire elapsed wall-clock interval.

Proposed normalized bounds for a `64³`, width-1 domain:

| Control | Starting range or rule | Reason |
|---|---|---|
| Simulation step | Fixed `1/60 s`; at most two catch-up steps per displayed frame. | Bounded work and reproducible comparison. |
| Maximum gas speed | Start at `0.75` domain widths/s; verify after forces and projection. | At 60 Hz this travels approximately `0.8` cells per step. A bound is a guard, not proof of accuracy. |
| Fuel source radius | 2–4 cells, always in open gas. | Gives the grid a source it can resolve. |
| Fuel source rate | 0–1.2 normalized fuel units/s at source center. | Small range for the first parameter sweep. |
| Reaction coefficient | 1–4 per second. | Short but observable exhaustion with the integrated update above. |
| Ignition | `thetaIgnite = 0.2–0.35`, transition width `0.05–0.1`. | Prevents abrupt branch flicker at a single threshold. |
| Temperature/soot/fuel bounds | Establish explicit nonnegative caps; initial candidates `theta <= 2`, `S <= 2`, `F <= 1`. | Count every clamp event; reduce source strength if clamps dominate. |
| Heat yield | 0.4–1.2 temperature-proxy units per consumed fuel unit. | Test against reaction and cooling together. |
| Temperature relaxation | 0.6–2.0 per second. | Approximate e-folding lifetimes of 0.5–1.7 seconds. |
| Soot removal | 0.15–0.5 per second. | Allows smoke to outlast visible combustion. |
| Buoyant acceleration | 0–0.35 domain widths/s² per unit `theta`; low soot weight initially. | Limits runaway upward forcing in a small chamber. |
| Confinement | Sweep from zero to the existing coefficient before increasing it. | Establish how much structure is physical transport versus added energy. |
| Thermal diffusion | Enforce `kappa * dt / h² <= 1/6`. | Stability condition for the proposed explicit six-neighbor update. |
| Embers | 0–256 active; 0.3–2.0-second lifetime. | Proposed capacity, not a measured cost. |
| Pressure iterations | Start at the existing 24; change only with residual evidence. | Keep appearance controls independent from numerical convergence. |

No mode should expose arbitrary unbounded numerical coefficients. Visual variation can come from source position, duration, radius, and modest momentum changes while keeping solver limits fixed. For reduced motion, retain a settled rendered scene or freeze a real state with an honest static-mode indication rather than playing a hidden animation.

## Current source and tool landscape

| Candidate | Verified capability and availability | License and fit |
|---|---|---|
| **Custom WGSL extension** | Existing solver, boundary volume, device ownership, and glass compositor already share GPU resources. | Best fit. Additional thermal behavior still needs implementation and validation. |
| **Three.js volumetric fire example, r185** | Actual 3D velocity/pressure simulation, advected temperature/density, cooling, buoyancy, and injected curl noise; includes procedural shading detail. Source has no fuel-consumption or oxygen field. [^10] | MIT engine/example source. Useful thermal-flow and rendering reference; replacing the current runtime is unnecessary. [^11] |
| **luma.gl `VolumetricFireSimulation`** | Experimental WebGPU dense-grid solver documented and present in inspected master snapshot `ef850d80319a013ba5b529e225e5b35305cf1f13`. Public velocity/combustion textures and application-owned stepping are useful seams. No WebGL, moving-solid implementation, or general chemistry guarantee. Published package/version availability was not established. [^12] | MIT, including explicit SPDX in the inspected solver files. Strong reduced-combustion code reference; its `Device`, `Computation`, and command-graph abstractions would add integration work. [^13] |
| **NVIDIA Flow in PhysX** | Source snapshot `4f2103c3a9052906296defb12166753450ef787c`; native sparse-grid architecture and HLSL combustion kernels. The README lists Windows, Linux, and Linux ARM64, not macOS/WebGPU. [^14] | Inspected kernel and repository identify BSD-3-Clause. Good equations/control reference; no ready Electron/M2 runtime integration. [^15] |
| **`diluuuu10/fire3d-3`** | Inspected snapshot `d858266f0466b39f0d8e196d6c59a2910f219bc8` has WGSL fuel consumption, ignition, heat/soot yields, buoyancy, and cooling. It is more than its screenshot. [^16] | No license file in the complete inspected tree and no license field in `package.json`; do not treat public visibility as a reuse grant. The normalized fourth-power cooling is not calibrated thermodynamics. |
| **Babylon.js** | WebGPU and compute infrastructure are available. Its inspected `FireProceduralTexture` is a time-driven 2D noise/color shader, not a fluid or combustion solver. [^17][^18] | Apache-2.0 engine repository. A capable alternative engine, but this fire texture does not advance the present task. [^19] |
| **Unity 6.6 / VFX Graph** | Unity's September 1, 2026 announcement makes production WebGPU, compute shaders, and VFX Graph available to web builds. Older blanket claims that VFX Graph cannot run on the web are outdated. VFX Graph capability alone does not establish a combustion solver. [^20] | Unity Graphics source uses the Unity Companion License for Unity-dependent projects. A Unity runtime would be a large architectural change; do not assume its shaders are permissive standalone WGSL donors. [^21] |
| **Unreal Niagara Fluids** | Official gas documentation describes density, temperature, velocity, buoyancy, confinement, pressure iterations, boundaries, and blackbody/curve rendering. It is a genuine fluid system; its documented controls do not establish detailed chemistry. [^22] | Unreal Engine EULA governs the engine. Useful visual/debugging reference, not an npm/WebGPU integration. [^23] |
| **EmberGen** | A real interactive GPU simulation authoring tool with image-sequence, flipbook, and VDB export workflows. [^24] | Commercial licensed product. Useful for visual reference if already available; importing its baked output would not supply the requested live reactive orb. |

Three.js also has a separate `webgpu_tsl_vfx_flames` example. Its inspected code uses sprite materials, UV transforms, time, and noise textures. The shared word “fire” and the use of WebGPU do not make it equivalent to `webgpu_volume_fire`. [^25]

Niagara's own flipbook documentation explicitly distinguishes the 3D simulation from its baked 2D frames. Exporting a physically generated asset can be a valid production optimization, but it cannot react to a new force by recomputing its original fluid evolution. The same distinction applies to cached particle or VDB sequences. [^26]

## Other materials and energetic effects

**Hot soot and embers** offer the strongest next variation because they reuse the thermal volume and add only a bounded particle population. They provide visible histories: ignition, rise, cooling, settling, and extinction. Their attraction is not just a different palette.

**Luminous vapor** can use the transported gas field with nonthermal emission driven by a bounded excitation scalar. It is an honest stylized energy material if described that way. It avoids claiming that purple light is a blackbody temperature or that an unmodeled electrical field is producing it.

**Charged tracers or sparks** can be integrated under an explicit prescribed electric/magnetic field with drag and collisions. That would simulate particle trajectories in an external field, not a self-consistent plasma. A true plasma solver introduces charge/species transport, fields, and electron energy; the 2025 Vidyut3d research describes precisely that broader coupled problem. It is not a drop-in replacement for smoke advection. [^27]

**Molten material or a lava lamp** requires another explicit scope choice. Emissive, more viscous PBF liquid is a feasible visual experiment. Claiming a lava lamp would additionally require temperature-dependent density, immiscible phases, heat sources/sinks, and appropriate interfacial behavior. Changing the color and viscosity of the existing water is not evidence that those mechanisms exist.

**Ferrofluid spikes, lightning branches, and crackling arcs** need their own force/interface or discharge models to deserve physical names. They should be separate research prototypes rather than parameter presets falsely attributed to the gas solver. For the current orb, thermal fluid plus real embers offers more verified reuse and a much smaller validation surface.

## Performance and verification

At `64³`, one `rgba16float` texture contains `262,144 * 8 = 2,097,152` logical bytes, exactly 2 MiB. Three additional scalar textures therefore add 6 MiB before alignment and driver overhead. A hypothetical `96³` texture is 6.75 MiB; the grid has 3.375 times as many cells. These are allocation calculations, not speed predictions.

Three extra full-volume scalar/reaction passes visit approximately 0.79 million cells per step, before texture-read multiplicity. The current 24 pressure sweeps already visit approximately 6.29 million cells per step. This suggests that a packed reaction update may be a manageable increment, but it does not establish a millisecond budget: trilinear sampling, extra bindings, dependency scheduling, rendering, and thermal throttling all matter.

The present optical shader can take up to 160 volume steps and additional shadow samples. Emission may be inexpensive if added to an already sampled gas segment, while self-lighting or double-resolution rendering may be much more expensive. Keep grid quality, ray-march quality, shadow sampling, and ember capacity independently measurable.

A bounded prototype should produce the following evidence before product integration:

1. **State truth.** Diagnostic slices show fuel, temperature, soot, reaction, and optional oxygen separately. Turning off noise/detail preserves transport; turning off reaction stops heat generation from fuel; stopping injection leaves material that continues evolving.
2. **Reaction tests.** With transport disabled, fuel never goes negative, cold fuel remains unburned, hot fuel depletes, and fuel exhaustion ends reaction. In oxygen mode, consumption respects the specified ratio and no source-free oxygen appears.
3. **Thermal tests.** Source-free cells cool monotonically toward ambient. Half-step comparisons bound time-step sensitivity. Diffusion broadens a hot spot without inventing a new maximum when its stability bound holds.
4. **Transport tests.** Record scalar totals and extrema during source-free advection, identifying numerical loss instead of claiming conservation. Show that the limiter prevents new negative concentrations and severe overshoots.
5. **Pressure and boundaries.** Record RMS/max divergence before and after projection, pressure residual, maximum speed, and invalid values. Check masks near the shell, stationary water, moving water, newly exposed cells, and the maximum allowed interaction impulse.
6. **Coupling boundary.** With identical liquid initial state and inputs, enabling gas combustion must leave liquid evolution unchanged in the one-way model. Embers must remain inside the vessel and extinguish consistently on liquid entry.
7. **Optical tests.** Change ray-step size and check integrated flame brightness against a constant-volume reference. Inspect flame attenuation through smoke, glass and liquid refraction, HDR highlights, facial visibility, and both app themes. Record before/after screenshots and a real interaction video.
8. **Performance.** Measure liquid, reconstruction, gas transport, projection, reaction, embers, and optics separately where timestamp queries are supported. Record warm-up, median/p95 frame times, backing resolution, adapter, power mode, source hash, and sustained operation. Include active terminal sessions; isolated completion timing is insufficient.
9. **Lifecycle.** Test hidden/offscreen suspension, reduced motion, theme changes, pause/resume without catch-up bursts, device loss, repeated mount/unmount, and resource cleanup. No per-frame CPU readback belongs in ordinary presentation.

The first decision point is whether a small thermal flame stays numerically stable and visually legible through the existing vessel at an acceptable whole-app cost. If it does, add fuel exhaustion and then embers. Thin fronts, expansion, oxygen-limited behavior, and phase change should each have a separate experiment with its own evidence rather than being bundled into an untestable “realistic fire” claim.

## Sources

All links below are primary research, official documentation, or the relevant project's own source. Repository snapshots are pinned where inspected; a live documentation page is not proof of a particular released npm package.

[^1]: Crane, Llamas, Tariq. [GPU Gems 3, Chapter 30: Real-Time Simulation and Rendering of 3D Fluids](https://developer.nvidia.com/gpugems/gpugems3/part-v-physics-simulation/chapter-30-real-time-simulation-and-rendering-3d-fluids), 2007. Reaction coordinates, thermal buoyancy, fluid rendering.
[^2]: Nguyen, Fedkiw, Jensen. [Physically Based Modeling and Animation of Fire](https://graphics.stanford.edu/~henrik/papers/fire/fire.pdf), SIGGRAPH 2002. Full paper inspected; thin-front model, fuel/products, blue core, expansion. [Author project page](https://graphics.stanford.edu/papers/fire-sg02/).
[^3]: vis.gl contributors. [Volumetric fire WGSL](https://github.com/visgl/luma.gl/blob/ef850d80319a013ba5b529e225e5b35305cf1f13/modules/experimental/src/rendering/volumetric-fire-simulation-shaders.ts), snapshot inspected September 2026; especially the combustion-advection kernel around lines 805–909.
[^4]: NVIDIA. [Flow `AdvectionCommon.hlsli`](https://github.com/NVIDIA-Omniverse/PhysX/blob/4f2103c3a9052906296defb12166753450ef787c/flow/source/nvflow/shaders/AdvectionCommon.hlsli), functions `combustSimulate` and `combustVelocity`, September 2026 snapshot. [Official controls](https://docs.omniverse.nvidia.com/kit/docs/flow/latest/settings.html).
[^5]: NIST / FDS developers. [FDS Technical Reference Guide combustion chapter source](https://github.com/firemodels/fds/blob/master/Manuals/FDS_Technical_Reference_Guide/Combustion_Chapter.tex), current source; [official manuals](https://pages.nist.gov/fds/manuals.html).
[^6]: Fedkiw, Stam, Jensen. [Visual Simulation of Smoke](https://graphics.stanford.edu/papers/smoke/), SIGGRAPH 2001. Coarse-grid dynamics, confinement, moving obstacles.
[^7]: Pharr, Jakob, Humphreys. [PBRT: Light Emission](https://www.pbr-book.org/3ed-2018/Light_Sources/Light_Emission), third edition, 2018. Planck law, normalized spectra, emission intensity.
[^8]: Pharr, Jakob, Humphreys. [PBRT: Representing Spectral Distributions](https://www.pbr-book.org/4ed/Radiometry%2C_Spectra%2C_and_Color/Representing_Spectral_Distributions), fourth edition. Blackbody implementation and spectral data.
[^9]: Pharr, Jakob, Humphreys. [PBRT: Transmittance](https://www.pbr-book.org/4ed/Volume_Scattering/Transmittance), fourth edition. Extinction integration and transmittance composition.
[^10]: Three.js authors. [r185 volumetric fire source](https://github.com/mrdoob/three.js/blob/r185/examples/webgpu_volume_fire.html); [current official demo](https://threejs.org/examples/webgpu_volume_fire.html). Temperature/density simulation distinguished from combustion.
[^11]: Three.js authors. [MIT license](https://github.com/mrdoob/three.js/blob/r185/LICENSE).
[^12]: vis.gl contributors. [VolumetricFireSimulation documentation](https://luma.gl/docs/api-reference/experimental/volumetric-fire-simulation); [pinned orchestration source](https://github.com/visgl/luma.gl/blob/ef850d80319a013ba5b529e225e5b35305cf1f13/modules/experimental/src/rendering/volumetric-fire-simulation.ts). Experimental scope, fields, command ownership.
[^13]: vis.gl contributors. [Pinned MIT license and attributions](https://github.com/visgl/luma.gl/blob/ef850d80319a013ba5b529e225e5b35305cf1f13/LICENSE).
[^14]: NVIDIA. [Flow README](https://github.com/NVIDIA-Omniverse/PhysX/blob/4f2103c3a9052906296defb12166753450ef787c/flow/README.md). Supported native platforms.
[^15]: NVIDIA. [PhysX BSD-3-Clause license](https://github.com/NVIDIA-Omniverse/PhysX/blob/4f2103c3a9052906296defb12166753450ef787c/LICENSE.md); the inspected Flow shader also carries its own BSD-3-Clause header.
[^16]: diluuuu10. [Fire force/combustion shader source](https://github.com/diluuuu10/fire3d-3/blob/d858266f0466b39f0d8e196d6c59a2910f219bc8/src/shaders/force.js); [package manifest](https://github.com/diluuuu10/fire3d-3/blob/d858266f0466b39f0d8e196d6c59a2910f219bc8/package.json); [complete repository tree API](https://api.github.com/repos/diluuuu10/fire3d-3/git/trees/d858266f0466b39f0d8e196d6c59a2910f219bc8?recursive=1). No reuse license found in this snapshot.
[^17]: Babylon.js authors. [WebGPU support documentation source](https://github.com/BabylonJS/Documentation/blob/master/content/setup/support/webGPU.md). Engine capability, not fire-solver evidence.
[^18]: Babylon.js authors. [Fire procedural fragment shader](https://github.com/BabylonJS/Babylon.js/blob/master/packages/dev/proceduralTextures/src/fire/fireProceduralTexture.fragment.fx). Time-driven 2D noise and colors.
[^19]: Babylon.js authors. [Repository license](https://github.com/BabylonJS/Babylon.js/blob/master/license.md), Apache-2.0.
[^20]: Unity. [Unity 6.6 is now available](https://discussions.unity.com/t/unity-6-6-is-now-available/1735357), September 1, 2026; official announcement, “WebGPU is production ready” section.
[^21]: Unity. [Graphics repository license](https://github.com/Unity-Technologies/Graphics/blob/master/LICENSE.md), Unity Companion License for Unity-dependent projects.
[^22]: Epic Games. [Niagara Fluids Reference](https://dev.epicgames.com/documentation/en-us/unreal-engine/niagara-fluids-reference-in-unreal-engine), current Unreal documentation. Gas state, controls, boundaries, rendering.
[^23]: Epic Games. [Unreal Engine EULA](https://www.unrealengine.com/eula/unreal), current published license; no standalone permissive reuse asserted.
[^24]: JangaFX. [EmberGen product](https://jangafx.com/software/embergen) and [official getting-started/export documentation](https://docs.jangafx.com/embergen/pages/getting_started.html), current pages. Interactive authoring and exported data are distinct.
[^25]: Three.js authors. [r185 VFX flames source](https://github.com/mrdoob/three.js/blob/r185/examples/webgpu_tsl_vfx_flames.html). Sprite materials and procedural texture motion.
[^26]: Epic Games. [Niagara Flipbook Baker Quick Start Guide](https://dev.epicgames.com/documentation/unreal-engine/niagara-flipbook-baker-quick-start-guide-in-unreal-engine?lang=en-US). Baking a 3D effect into 2D frames.
[^27]: Vidyut3d authors. [Vidyut3d: a GPU accelerated fluid solver for non-equilibrium plasmas on adaptive grids](https://arxiv.org/abs/2507.08200), 2025. Coupled species, electrostatic fields, and electron-energy dynamics.
