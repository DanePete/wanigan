# Particles4All fluid solver

Adapted from [matsuoka-601/Particles4All](https://github.com/matsuoka-601/Particles4All/tree/58d6fa6d2c50e3f58da5c7a6f9b885ce26c485f0), commit `58d6fa6d2c50e3f58da5c7a6f9b885ce26c485f0`, MIT (see LICENSE).

This is a real Position Based Fluids solver: neighbor search, density constraints,
position correction, XSPH viscosity and surface tension. Wanigan changes the scene
to a spherical cavity with equal-area boundary samples, seeds a volume of liquid,
projects corrected positions onto the cavity and removes outward contact velocity.
Mass and constraint calibration remain upstream. The outer box is only the hash
grid domain. There are no active rigid bodies or emitters in this scene.

`density.js` retains the upstream scalar density reconstruction and smoothing
source. Wanigan reconstructs an 80³ volume, packs weighted particle velocity beside
density, applies three separable smoothing passes, and traces the liquid inside
a separately refracting glass shell. No triangle mesh or upstream demo UI is loaded.
The runtime owns a dedicated GPU device; destroying it frees all vendor allocations.

The source is kept as JavaScript with a narrow typed adapter so upstream equations
remain easy to compare. Gas and glass are Wanigan modules, not features attributed
to this solver. No remote assets are fetched at runtime.

The separate gas module uses a 64³ collocated grid, first-order velocity advection,
limited MacCormack dye transport, buoyancy, vorticity confinement and 24 Jacobi
pressure iterations. The sphere and reconstructed water are obstacles. Its source
and dissipation are deliberate visual controls; it is not a sealed thermodynamic
model. Buoyant bubble tracers follow the liquid in one direction and do not change
its pressure. These are bounded interactive approximations, not multiphase CFD.
