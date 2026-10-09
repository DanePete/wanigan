# Particles4All fluid solver

Adapted from [matsuoka-601/Particles4All](https://github.com/matsuoka-601/Particles4All/tree/58d6fa6d2c50e3f58da5c7a6f9b885ce26c485f0), commit `58d6fa6d2c50e3f58da5c7a6f9b885ce26c485f0`, MIT (see LICENSE).

This is a real Position Based Fluids solver: neighbor search, density constraints,
position correction, XSPH viscosity and surface tension. Wanigan changes the scene
to a spherical cavity with equal-area boundary samples, seeds a volume of liquid,
projects corrected positions onto the cavity and removes outward contact velocity.
Mass and constraint calibration remain upstream. The outer box is only the hash
grid domain.

Only what the water scene runs is kept. The upstream rigid bodies, pouring, box
resizing, statistics readback and debug particle/box renderers are removed; every
solver kernel that remains is upstream's text, so its equations still compare
line for line.

`density.js` is the upstream scalar density reconstruction, adapted to write an
80³ `rgba16float` volume with the weighted particle velocity packed beside the
density. The runtime smooths it in three separable passes and traces the liquid
inside a separately refracting glass shell. No triangle mesh or upstream demo UI
is loaded. The runtime owns a dedicated GPU device; destroying it frees every
allocation here.

The source stays JavaScript behind a narrow typed adapter (`sim.d.ts`,
`density.d.ts`). The mist, bubbles, wakes and glass are Wanigan modules, not
features of this solver. No remote assets are fetched at runtime.
