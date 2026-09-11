# Orb materials: magnetic liquid, syrup, jelly, and floating objects

The later [plasma investigation and snow correction](2026-09-10-plasma-globe-physics.md)
supersede this note's original snow/plasma implementation direction.

Checked September 10, 2026. This is implementation research, not a claim that the proposed effects have shipped or been benchmarked. Recommendations below are engineering inferences; cited sources establish their physical and numerical foundations.

## Keep the existing simulation and optical path

The current [runtime](../../src/renderer/src/orb/runtime.ts) owns a WebGPU device, advances the vendored PBF liquid, reconstructs an `80³` density/velocity volume, and renders through refracting glass. [Sim](../../src/renderer/src/orb/vendor/sim.js) already contains particle rigid bodies, shape matching, XSPH smoothing, and surface tension. Its fixed substep is `1/120 s` at the current `substeps: 2`; it submits its own command buffer. New effects should share these coordinates, time accounting, and optical path. The existing world-to-orb conversion is `pOrb = pWorld - vec3(1.2)`.

Allocate only bounded populations and fields. Use persistent simulated position, velocity, deformation, or transported concentration; rendering noise can add detail but should not determine the whole motion. Keep GPU readback in diagnostics, and freeze both integration and state-changing controls when motion is off.

## Material choices

| Material | Practical first implementation | Fidelity boundary |
| --- | --- | --- |
| Magnetic liquid | Drive the existing liquid toward a bounded pointer-controlled magnetic target. Add a surface layer of interacting spike degrees of freedom with inertia, damping, attraction, and lateral repulsion; feed its displacement into rendered surface normals and silhouette. | This is a reduced magnetic sculpture unless the magnetic boundary problem and stress coupling are actually solved. Prescribed spike locations or a force toward the cursor do not reproduce the Rosensweig instability. |
| Honey / syrup | Increase neighbor-relative viscous relaxation while retaining normal gravity and fluid constraints. Add short-range, yielding elastic links only if long filaments are required. Render amber absorption through thickness. | Slowing the entire simulation changes gravity and every other timescale; it does not make water viscous. Adding permanent rest-shape springs produces a gel. No calibrated honey rheology is implied. |
| Jelly | Use a small tetrahedral core with compliant edge and volume constraints, gravity, glass collision, and pointer grabbing. Render its evolving surface or reconstruct a smooth volume from its current positions. | A coarse elastic solid supports squash, recoil, and wobble; it does not automatically support tearing, self-contact, or arbitrary topology changes. |
| Floating pearls | Activate small rigid sphere particle groups inside the existing PBF constraint loop. Render analytic spheres from their simulated centers; use varied density controls for distinct responses. | Read-only sampling of water velocity or height creates a tracer. Two-way coupling requires the objects also to alter water particles. Submergence is approximate at this resolution. |

The ferrofluid research solves magnetostatics from a surface point cloud and couples the result to a grid fluid solver; its published examples include normal-field and labyrinthine instabilities. That is the reference for a later faithful solver. [Author project](https://ferrofluid-simulation.github.io/) The released 3D code is a native Windows/C++ research pipeline with IoB and finite-difference magnetic backends; it is not a drop-in WebGPU library. Its MIT licensing does not remove porting and numerical-validation work. [Author code](https://github.com/ferrofluid-simulation/SimFerrofluid)

Clavet, Beaudoin, and Poulin separate particle viscosity from elasticity and plasticity: velocity impulses supply viscosity, springs supply elasticity, and evolving rest lengths supply plastic deformation. Use that separation when tuning syrup; cohesive water plus velocity damping alone does not establish viscoelastic behavior. [Publisher record and abstract](https://diglib.eg.org/items/7cad7994-b781-40ce-ad04-0bf61dc94279/full)

Matthias Müller's educational soft body stores tetrahedral volumes, edge rest lengths, positions, velocities, and inverse masses, then alternates integration and constraint correction. Its source includes grabbing and release velocity. [Ten Minute Physics](https://matthias-research.github.io/pages/tenMinutePhysics/index.html), [actual soft-body source](https://raw.githubusercontent.com/matthias-research/pages/master/tenMinutePhysics/10-softBodies.html) For GPU execution, use conflict-free constraint coloring or Jacobi gather/scatter; direct concurrent writes to shared vertices are not a translation of the sequential example. This is an implementation recommendation, not a property demonstrated by that browser example.

XPBD scales compliance by `1 / dt²` and tracks constraint multipliers, reducing stiffness dependence on iteration count; low iteration counts still introduce solver error. [XPBD paper](https://matthias-research.github.io/pages/publications/XPBD.pdf) Small substeps with fewer iterations are a useful starting point for responsive jelly, but must be benchmarked in this renderer. [Small Steps paper](https://matthias-research.github.io/pages/publications/smallsteps.pdf)

## Exact existing rigid-body contract

These details are observed in local [scene.js](../../src/renderer/src/orb/vendor/scene.js), [sim.js](../../src/renderer/src/orb/vendor/sim.js), [wgsl.js](../../src/renderer/src/orb/vendor/wgsl.js), and [density.js](../../src/renderer/src/orb/vendor/density.js):

- `bodies` accepts strings such as `sphere:0.6:0.62`: shape, density control, initial height fraction. `bodySize` is sphere radius, currently missing from the narrow TypeScript declaration. All bodies share this radius.
- `bodyCentre` contains one `vec4f(worldCenter.xyz, 0)` per body: **16 bytes each**. `bodyRot` contains three padded `vec4f` rows: **48 bytes each**. Rotate a local point with three row dot products, then add center. Pure spheres only need center; rotation can animate a patterned pearl material.
- At spacing `.055`, radii `.12`, `.14`, `.16`, and `.18` seed **33, 81, 93, and 147 particles**, respectively. Default radius `.288` seeds 619. These counts were recomputed directly from the local integer-lattice sampling rule. The conservative visible extent should include the sampled-particle envelope, not just the furthest particle center.
- Initial centers use `x = 1.2 - span/2 + index*step`, `y = 2.4*startY`, `z = 1.2`; `step = min(2.5*radius, .6)` and `span = step*(bodyCount-1)`.
- Spherical particle confinement is centered at `(1.2,1.2,1.2)`, with radius `1 - spacing/2 = .9725`. The final pass clamps every particle and removes outward velocity. Shape projection precedes this clamp, so the body-center buffer can describe a rigid sphere that protrudes beyond the final confined particle set. Constrain the rigid center using radius/extent during the solve so the rendered sphere and collision body agree.
- Density reconstruction already supports excluding body particles. Set `MeshParams.skipBodies` (`Int32Array` word **23**) to one; its current default is zero. Otherwise rigid particles contribute to the rendered water volume.
- `reset()` destroys and replaces GPU buffers. Recreate all bind groups holding particle buffers, including reconstruction and `ShellDrag`. A stable copied center buffer can keep the optics bind group intact; copy after the solver submission.
- Current density constraints use shared particle mass; `bodyResolve` scales center correction by inverse density control. This is not the full mass-weighted formulation in the research paper. Verify the desired float/sink result instead of interpreting the control as a calibrated material density.

Particles4All already demonstrates unified liquid/rigid interaction. [Upstream repository](https://github.com/matsuoka-601/Particles4All) Its reference paper explains mass-weighted buoyancy and explicitly warns that particle count and convergence affect apparent weight and immersion depth. [Unified Particle Physics, sections 7.1.1 and 11](https://matthias-research.github.io/pages/publications/flex.pdf)

## Acceptance checks before calling these physical effects

1. **Magnetic:** with the same initial state, moving the target changes simulated positions; releasing it leaves finite inertia and then relaxation. Spike state must freeze with motion off. Record target-off versus target-on particle displacement, not only a changed screenshot.
2. **Syrup:** compare identical nudges over identical elapsed simulation time. Neighbor-relative velocities should dissipate more strongly than water while a freely falling isolated sample retains gravity. If links exist, stretch/release tests distinguish elastic recoil, yielding, and permanent gel behavior.
3. **Jelly:** grab, squash against glass, release, and settle. Measure volume error, maximum edge strain, finite velocities, and wall clearance at both `1/60` and `1/30` frame cadence. Do not infer volume preservation from a visually similar silhouette.
4. **Pearls:** compare water displacement with and without an otherwise identical sphere impact; compare sphere motion with and without water. Test float/sink ordering, rigid shape error, pair separation, wall extent, and finite state after repeated shakes. Both directions must have measured influence.
5. **Integration:** compare large and miniature companions, both themes, reduced motion, hidden-window behavior, context disposal, and rapid material switches. Record GPU completion timing at fixed pixel size and all active particle/volume counts. Preserve the existing water/rain regression checks; a pretty frame cannot detect detached coupling.

No dependencies or external tools were installed for this note, and no product source was changed.
