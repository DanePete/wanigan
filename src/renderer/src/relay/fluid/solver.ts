/**
 * The Sluice's water, ported rather than reinvented.
 *
 * This is a faithful CPU port of Wanigan's vendored Position Based Fluids
 * solver (`src/renderer/src/orb/vendor/`, adapted from matsuoka-601's
 * Particles4All) at the companion's own constants, verified running in
 * `relay-sluice.html` before this port existed: 1,460 particles settling to
 * an average ρ/ρ₀ within a percent of 1 while water drains basin to basin
 * through a funnel and a pipe. The equations, constants and solve order are
 * copied from that verified source, not "improved" — every departure from a
 * textbook Position Based Fluids implementation here is one the vendor or the
 * demo already made, and this file exists to type it, not to rewrite it.
 *
 * Solve order per substep, exactly as verified: predict positions from
 * gravity, build both neighbour lists once, run [lambda, position-delta] for
 * `iterations` passes with the rig's confinement applied *inside* that loop
 * (a correction that leaves the rig is not a correction), recover velocity
 * from the position change, add XSPH viscosity, add surface tension (which
 * needs its own normals pass first), then finalize positions with the rig
 * confinement applied once more and any outward contact velocity removed so
 * a particle does not carry momentum back through the wall it just met.
 *
 * The time-bank/substep-count policy (fixed 1/120s, capped substeps per
 * frame) is deliberately not here: `index.ts` owns that, because how many
 * substeps a slow frame gets to catch up is a presentation policy, not a
 * physics constant. This class only ever advances by exactly the `dt` it is
 * given, exactly once per call, exactly like the verified demo's own
 * `substep(dt)`.
 */
import { floorY, seedWater, boundarySamples, type RigLayout } from '@shared/relay-rig';

/** One real-time physics step. The verified demo banks frame time against
 *  this and runs a capped number of these per frame; `index.ts` does the same. */
export const FIXED_DT = 1 / 120;

/** Substeps a single frame may catch up by. Past this the bank is clamped
 *  rather than let the solver fall further behind real time, because a
 *  solver "catching up" forever after a stall is a worse lie than a solver
 *  that quietly runs a little slow. */
export const MAX_SUBSTEPS_PER_FRAME = 4;

export type SolverParams = {
  /** Particle spacing. The companion's own liquid uses 0.055; the verified
   *  demo nudges this to 0.06 for a CPU budget — resolution, not physics. */
  spacing: number;
  restDensity: number;
  gravity: number;
  iterations: number;
  cfmEpsilonRel: number;
  sCorrK: number;
  sCorrDq: number;
  xsphC: number;
  omega: number;
  surfaceTensionK: number;
  /** How high above basin 0's drain the seed lattice fills, in world units. */
  fill: number;
};

/** The companion's own numbers, exactly as `docs/superpowers/specs/2026-09-17-relay-design.md`
 *  cites them and as `relay-sluice.html` ran them. A surface built on this
 *  fluid reads these values rather than restating them elsewhere. */
export const DEFAULT_SOLVER_PARAMS: SolverParams = {
  spacing: 0.06,
  restDensity: 1000,
  gravity: 9.81,
  iterations: 4,
  cfmEpsilonRel: 0.01,
  sCorrK: 0.1,
  sCorrDq: 0.3,
  xsphC: 0.066,
  omega: 1.03,
  surfaceTensionK: 0.4,
  fill: 0.3,
};

export type SolverStats = {
  /** Fluid particle count. */
  n: number;
  /** Boundary sample count. */
  boundary: number;
  /** The calibrated per-particle mass — see the comment in the constructor
   *  for why this is measured rather than assumed. */
  mass: number;
  /** The largest per-particle constraint-gradient denominator observed among
   *  interior particles at rest. See the `cfmEps` comment for what this
   *  calibrates. */
  denomRest: number;
  /** The CFM relaxation term actually used by the solver, i.e.
   *  `cfmEpsilonRel * denomRest`. */
  cfmEps: number;
  /** Mean of ρ/ρ₀ across all particles as of the last substep. 1.0 is exactly
   *  rest density; the verified demo settles within a percent of it. */
  avgRho: number;
};

type Grid = { readonly start: Int32Array; readonly idx: Int32Array };

/** Neighbour list caps. Generous relative to a spacing-0.06 lattice's actual
 *  neighbour counts, so a cap is never silently reached mid-run — see the
 *  vendored solver's own `MAXN`/`MAXB` for the same margin. */
const MAX_FLUID_NEIGHBOURS = 80;
const MAX_BOUNDARY_NEIGHBOURS = 64;

const F32 = (n: number): Float32Array => new Float32Array(n);

/**
 * The PBF solver over one rig, as a class over typed arrays rather than a
 * closure of module state — so a relay running two orbs' worth of history
 * (or a test constructing several rigs) never shares one solver's memory by
 * accident the way a module-level array would.
 */
export class FluidSolver {
  readonly rig: RigLayout;
  readonly params: SolverParams;

  // Kernel constants, derived once from `spacing` at construction.
  private readonly h: number;
  private readonly h2: number;
  private readonly poly6Coef: number;
  private readonly spikyGradCoef: number;
  private readonly cohesCoef: number;
  private readonly cohesTerm: number;
  /** Particle radius: half the spacing, used only for confinement margins. */
  private readonly r: number;

  private readonly n: number;
  private readonly initialSeed: Float32Array;
  private readonly px: Float32Array; private readonly py: Float32Array; private readonly pz: Float32Array;
  private readonly qx: Float32Array; private readonly qy: Float32Array; private readonly qz: Float32Array;
  private readonly vx: Float32Array; private readonly vy: Float32Array; private readonly vz: Float32Array;
  private readonly corrX: Float32Array; private readonly corrY: Float32Array; private readonly corrZ: Float32Array;
  private readonly nrmX: Float32Array; private readonly nrmY: Float32Array; private readonly nrmZ: Float32Array;
  private readonly rho: Float32Array;
  private readonly lam: Float32Array;
  /** AoS `[x0,y0,z0, x1,y1,z1, ...]` mirror of `px/py/pz`, refreshed at the
   *  end of every `substep()`. This is the shape a WebGL vertex buffer wants
   *  directly; keeping the physics in SoA (matching the vendored solver's own
   *  layout, for easy comparison against it) and mirroring to AoS only for
   *  the public surface costs one cheap pass a step. */
  private readonly posOut: Float32Array;

  private readonly boundaryCount: number;
  private readonly bx: Float32Array; private readonly by: Float32Array; private readonly bz: Float32Array;
  private readonly psi: Float32Array;
  /** Which basin's gate a boundary sample belongs to, or -1 for every other
   *  wetted surface (walls, funnels, glass, pipe walls). */
  private readonly bgate: Int32Array;
  /** Whether a boundary sample currently repels fluid. A gate sample goes
   *  inactive the moment its basin's gate opens; every other sample is
   *  always active. */
  private readonly bactive: Uint8Array;
  private readonly bGrid: Grid;

  /** Open/shut per basin. Closed at construction and after `reset()`,
   *  matching a relay that has not run yet. */
  private readonly gateOpen: Uint8Array;

  private readonly gridX: number;
  private readonly gridY: number;
  private readonly gridZ: number;

  private readonly nbr: Int32Array;
  private readonly nbrCount: Int32Array;
  private readonly bnb: Int32Array;
  private readonly bnbCount: Int32Array;

  private mass: number;
  private volume: number;
  private readonly invRestDensity: number;
  private denomRest: number;
  private cfmEps: number;
  private sCorrScaled: number;
  private sCorrWq: number;
  private avgRho: number;

  constructor(rig: RigLayout, params: Partial<SolverParams> = {}, initialBasin = 0) {
    this.rig = rig;
    this.params = { ...DEFAULT_SOLVER_PARAMS, ...params };
    const p = this.params;

    const d = p.spacing;
    this.h = 2 * d;
    this.h2 = this.h * this.h;
    this.poly6Coef = 315 / (64 * Math.PI * Math.pow(this.h, 9));
    this.spikyGradCoef = -45 / (Math.PI * Math.pow(this.h, 6));
    this.cohesCoef = 32 / (Math.PI * Math.pow(this.h, 9));
    this.cohesTerm = Math.pow(this.h, 6) / 64;
    this.r = 0.5 * d;
    this.invRestDensity = 1 / p.restDensity;

    // ── seed the fluid ────────────────────────────────────────────────────
    this.initialSeed = seedWater(rig, d, p.fill, initialBasin);
    this.n = this.initialSeed.length / 3;
    const n = this.n;
    this.px = F32(n); this.py = F32(n); this.pz = F32(n);
    this.qx = F32(n); this.qy = F32(n); this.qz = F32(n);
    this.vx = F32(n); this.vy = F32(n); this.vz = F32(n);
    this.corrX = F32(n); this.corrY = F32(n); this.corrZ = F32(n);
    this.nrmX = F32(n); this.nrmY = F32(n); this.nrmZ = F32(n);
    this.rho = F32(n); this.lam = F32(n);
    this.posOut = F32(n * 3);
    for (let i = 0; i < n; i++) {
      this.px[i] = this.initialSeed[i * 3]; this.py[i] = this.initialSeed[i * 3 + 1]; this.pz[i] = this.initialSeed[i * 3 + 2];
    }

    // ── sample the rig's own boundary ────────────────────────────────────
    const samples = boundarySamples(rig, d);
    this.boundaryCount = samples.positions.length / 3;
    const nb = this.boundaryCount;
    this.bx = F32(nb); this.by = F32(nb); this.bz = F32(nb);
    for (let k = 0; k < nb; k++) {
      this.bx[k] = samples.positions[k * 3]; this.by[k] = samples.positions[k * 3 + 1]; this.bz[k] = samples.positions[k * 3 + 2];
    }
    this.bgate = samples.gate;
    this.bactive = new Uint8Array(nb).fill(1);
    this.gateOpen = new Uint8Array(rig.basinCount);

    // ── the hash grid, sized to the rig rather than a fixed box ──────────
    this.gridX = Math.max(2, Math.ceil(rig.width / this.h));
    this.gridY = Math.max(2, Math.ceil(rig.height / this.h));
    this.gridZ = Math.max(1, Math.ceil(rig.depth / this.h));

    this.nbr = new Int32Array(n * MAX_FLUID_NEIGHBOURS);
    this.nbrCount = new Int32Array(n);
    this.bnb = new Int32Array(n * MAX_BOUNDARY_NEIGHBOURS);
    this.bnbCount = new Int32Array(n);

    // The boundary never moves, so its grid and its per-sample ψ (the
    // Akinci boundary density weight, calibrated so a resting fluid particle
    // pressed against the boundary reads the correct density from it) are
    // both computed once, here, rather than every substep.
    this.bGrid = this.buildGrid(this.bx, this.by, this.bz, nb);
    this.psi = F32(nb);
    {
      const found = new Int32Array(256);
      for (let k = 0; k < nb; k++) {
        let sum = 0;
        const count = this.neighbours(this.bGrid, this.bx, this.by, this.bz, this.bx[k], this.by[k], this.bz[k], found, 0, 256, null);
        for (let q = 0; q < count; q++) {
          const m = found[q];
          const dx = this.bx[k] - this.bx[m], dy = this.by[k] - this.by[m], dz = this.bz[k] - this.bz[m];
          sum += this.poly6(dx * dx + dy * dy + dz * dz);
        }
        this.psi[k] = sum > 0 ? p.restDensity / sum : 0;
      }
    }

    // ── mass calibration ─────────────────────────────────────────────────
    // A guessed mass of rho0*d^3 is exact only for an infinite, perfectly
    // aligned lattice; the seed lattice is neither infinite nor aligned to
    // the kernel's support, so that guess reads back as the wrong density
    // the moment it is measured. Measuring the densest actual particle in
    // the seed (the one with the fullest neighbourhood, closest to what an
    // interior particle of a real body of water would see) and rescaling
    // mass by rho0 / that reading corrects for exactly that discretisation
    // error, so the fluid settles at the density the solver's own
    // constraints assume is rest, not merely the density a formula guessed.
    const massGrid = this.buildGrid(this.px, this.py, this.pz, n);
    this.mass = p.restDensity * d * d * d;
    {
      const found = new Int32Array(MAX_FLUID_NEIGHBOURS);
      let maxRho = 0;
      for (let i = 0; i < n; i++) {
        const count = this.neighbours(massGrid, this.px, this.py, this.pz, this.px[i], this.py[i], this.pz[i], found, 0, MAX_FLUID_NEIGHBOURS, null);
        let rho = this.mass * this.poly6(0);
        for (let q = 0; q < count; q++) {
          const j = found[q];
          const dx = this.px[i] - this.px[j], dy = this.py[i] - this.py[j], dz = this.pz[i] - this.pz[j];
          rho += this.mass * this.poly6(dx * dx + dy * dy + dz * dz);
        }
        if (rho > maxRho) maxRho = rho;
      }
      if (maxRho > 0.5 * p.restDensity) this.mass *= p.restDensity / maxRho;
    }
    this.volume = this.mass / p.restDensity;

    // ── denomRest, and why cfmEps is relative to it ─────────────────────
    // The Lagrange multiplier for the density constraint divides by the sum
    // of squared constraint gradients; near the free surface that sum can be
    // small enough that the divide is unstable, which is exactly what the
    // CFM (constraint force mixing) epsilon in the denominator exists to
    // damp. A fixed absolute epsilon would need re-tuning every time the
    // spacing, mass or kernel changed, because "small" is relative to
    // whatever this configuration's gradients actually look like. So instead
    // `cfmEpsilonRel` (1%) is applied to `denomRest` — the largest gradient
    // sum measured among *interior* particles (density already at rest) in
    // the settled seed — which makes the epsilon self-scaling: the same
    // relative value stays correct across a change in resolution because it
    // is measured against this configuration's own numbers, not assumed.
    this.denomRest = 0;
    {
      const found = new Int32Array(MAX_FLUID_NEIGHBOURS);
      for (let i = 0; i < n; i++) {
        const count = this.neighbours(massGrid, this.px, this.py, this.pz, this.px[i], this.py[i], this.pz[i], found, 0, MAX_FLUID_NEIGHBOURS, null);
        let rho = this.mass * this.poly6(0);
        for (let q = 0; q < count; q++) {
          const j = found[q];
          const dx = this.px[i] - this.px[j], dy = this.py[i] - this.py[j], dz = this.pz[i] - this.pz[j];
          rho += this.mass * this.poly6(dx * dx + dy * dy + dz * dz);
        }
        if (rho < 0.99 * p.restDensity) continue;
        let gx = 0, gy = 0, gz = 0, sumGrad2 = 0;
        for (let q = 0; q < count; q++) {
          const j = found[q];
          if (j === i) continue;
          const dx = this.px[i] - this.px[j], dy = this.py[i] - this.py[j], dz = this.pz[i] - this.pz[j];
          const r2 = dx * dx + dy * dy + dz * dz;
          if (r2 < 1e-12) continue;
          const rr = Math.sqrt(r2), hr = this.h - rr;
          const s = this.volume * this.spikyGradCoef * hr * hr / rr;
          gx += s * dx; gy += s * dy; gz += s * dz; sumGrad2 += s * s * r2;
        }
        const den = gx * gx + gy * gy + gz * gz + sumGrad2;
        if (den > this.denomRest) this.denomRest = den;
      }
    }
    this.cfmEps = Math.max(1e-9, p.cfmEpsilonRel * this.denomRest);
    this.sCorrScaled = p.sCorrK / (this.denomRest * Math.max(1, p.iterations));
    {
      // sCorrWq normalises the tensile-instability correction (`s_corr`, the
      // PBF paper's artificial pressure term) against the kernel's own value
      // at a fixed reference separation `sCorrDq * h`, so `ratio` below reads
      // as 1 at that separation regardless of the kernel's absolute scale.
      // It is later raised to the 4th power (`ratio^2` squared again): a
      // sharper falloff than the density kernel's own cubic, so the
      // correction only meaningfully pushes particles that have moved
      // noticeably closer together than rest — the clumping s_corr exists to
      // break up — without perturbing neighbours at an ordinary separation.
      const rq = p.sCorrDq * this.h;
      const tq = this.h2 - rq * rq;
      const wq = this.poly6Coef * tq * tq * tq;
      this.sCorrWq = wq > 0 ? 1 / wq : 0;
    }

    this.avgRho = p.restDensity;
    this.syncPositionsOut();
  }

  private poly6(r2: number): number {
    return r2 < this.h2 ? this.poly6Coef * Math.pow(this.h2 - r2, 3) : 0;
  }

  private cellOf(x: number, y: number, z: number): number {
    const i = Math.min(this.gridX - 1, Math.max(0, (x / this.h) | 0));
    const j = Math.min(this.gridY - 1, Math.max(0, (y / this.h) | 0));
    const k = Math.min(this.gridZ - 1, Math.max(0, (z / this.h) | 0));
    return (k * this.gridY + j) * this.gridX + i;
  }

  private buildGrid(X: Float32Array, Y: Float32Array, Z: Float32Array, count: number): Grid {
    const cells = this.gridX * this.gridY * this.gridZ;
    const start = new Int32Array(cells + 1);
    const idx = new Int32Array(count);
    const cellCount = new Int32Array(cells);
    for (let i = 0; i < count; i++) cellCount[this.cellOf(X[i], Y[i], Z[i])]++;
    let sum = 0;
    for (let c = 0; c < cells; c++) { start[c] = sum; sum += cellCount[c]; }
    start[cells] = sum;
    const fill = start.slice();
    for (let i = 0; i < count; i++) {
      const cell = this.cellOf(X[i], Y[i], Z[i]);
      idx[fill[cell]++] = i;
    }
    return { start, idx };
  }

  /** 27-cell neighbour search within radius `h`. `active`, when given, skips
   *  boundary samples belonging to an open gate — the mechanism that makes a
   *  gate actually let water through rather than merely look open. */
  private neighbours(
    grid: Grid, X: Float32Array, Y: Float32Array, Z: Float32Array,
    x: number, y: number, z: number,
    out: Int32Array, base: number, max: number, active: Uint8Array | null,
  ): number {
    const ci = Math.min(this.gridX - 1, Math.max(0, (x / this.h) | 0));
    const cj = Math.min(this.gridY - 1, Math.max(0, (y / this.h) | 0));
    const ck = Math.min(this.gridZ - 1, Math.max(0, (z / this.h) | 0));
    let n = 0;
    for (let k = Math.max(0, ck - 1), ke = Math.min(this.gridZ - 1, ck + 1); k <= ke; k++) {
      for (let j = Math.max(0, cj - 1), je = Math.min(this.gridY - 1, cj + 1); j <= je; j++) {
        const row = (k * this.gridY + j) * this.gridX;
        const b = grid.start[row + Math.max(0, ci - 1)];
        const e = grid.start[row + Math.min(this.gridX - 1, ci + 1) + 1];
        for (let t = b; t < e; t++) {
          const m = grid.idx[t];
          if (active && !active[m]) continue;
          const dx = x - X[m], dy = y - Y[m], dz = z - Z[m];
          if (dx * dx + dy * dy + dz * dz >= this.h2) continue;
          if (n < max) out[base + n++] = m;
        }
      }
    }
    return n;
  }

  /**
   * Project `(x,y,z)` onto or inside the rig's own walls, funnels, gates and
   * pipes. Called both inside every constraint-projection iteration (so a
   * correction is never allowed to leave the rig even mid-solve) and once
   * more at finalize.
   *
   * Nothing can be below a shut gate. A particle that reaches the pipe span
   * beneath basin `i` while that gate is closed got there by tunnelling
   * through the gate floor within a single substep — the floor has no
   * thickness to catch a fast-enough particle mid-step — so rather than let
   * it keep falling into a pipe it was never allowed to enter, it is placed
   * back on top of the gate it should have been stopped by.
   */
  private confine(x: number, y: number, z: number, out: Float64Array): void {
    const rig = this.rig;
    const r = this.r;
    const ox = x, oy = y, oz = z;
    z = Math.min(rig.depth - r, Math.max(r, z));
    x = Math.min(rig.width - r, Math.max(r, x));
    y = Math.min(rig.height - r, y);

    let done = false;
    for (let i = 0; i < rig.basinCount && !done; i++) {
      const drain = rig.basins[i].drain;
      if (y >= drain) {
        const f = floorY(rig, i, x);
        const inHole = Math.abs(x - rig.centerX) < rig.drainWidth / 2 - r * 0.5;
        if (y < f + r && !(inHole && this.gateOpen[i])) {
          if (inHole || Math.abs(x - rig.centerX) < rig.drainWidth / 2) {
            y = f + r;
          } else {
            // Push out along the funnel's own normal, not straight up: a
            // slope pushed out vertically would slide the particle back down
            // the slope on the very next substep.
            const sign = x < rig.centerX ? -1 : 1;
            const nx = -sign * rig.funnelSlope, ny = 1;
            const nl = Math.hypot(nx, ny);
            const pen = ((f + r) - y) / nl;
            x += (nx / nl) * pen; y += (ny / nl) * pen;
            x = Math.min(rig.width - r, Math.max(r, x));
          }
        }
        done = true;
      } else if (y >= drain - rig.pipeHeight || i === rig.basinCount - 1) {
        x = Math.min(rig.centerX + rig.drainWidth / 2 - r, Math.max(rig.centerX - rig.drainWidth / 2 + r, x));
        if (!this.gateOpen[i]) {
          // The tunnelling rule: see this method's own doc comment.
          y = drain + r;
        } else if (i === rig.basinCount - 1) {
          y = Math.max(rig.pipes[i].bottom + r, y);
        }
        done = true;
      }
    }
    out[0] = x; out[1] = y; out[2] = z; out[3] = (x !== ox || y !== oy || z !== oz) ? 1 : 0;
  }

  /**
   * Push nearby particles along `direction` from `origin`, within `radius` of
   * the ray, by up to `impulse` — clamped so this can only ever raise a
   * particle's speed toward `limit`, never add unbounded energy to water that
   * is already moving fast. This is the same math the runtime's own
   * `nudge()`/nudge-impulse path uses, so a spill's arrival disturbs real
   * water rather than playing a canned splash.
   */
  applyRayImpulse(
    origin: readonly [number, number, number],
    direction: readonly [number, number, number],
    impulse: readonly [number, number, number],
    radius: number,
    limit: number,
  ): void {
    const [ox, oy, oz] = origin;
    let [dx, dy, dz] = direction;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    const [ix, iy, iz] = impulse;
    for (let i = 0; i < this.n; i++) {
      const tx = this.px[i] - ox, ty = this.py[i] - oy, tz = this.pz[i] - oz;
      const along = tx * dx + ty * dy + tz * dz;
      if (along <= 0) continue;
      const rx = tx - along * dx, ry = ty - along * dy, rz = tz - along * dz;
      const d2 = rx * rx + ry * ry + rz * rz;
      if (d2 >= radius * radius) continue;
      const w = (1 - Math.sqrt(d2) / radius) ** 2;
      let a = this.vx[i] + w * ix, b = this.vy[i] + w * iy, c = this.vz[i] + w * iz;
      const old = Math.hypot(this.vx[i], this.vy[i], this.vz[i]);
      const ns = Math.hypot(a, b, c);
      const allowed = Math.max(old, limit);
      if (ns > allowed) { const k = allowed / ns; a *= k; b *= k; c *= k; }
      this.vx[i] = a; this.vy[i] = b; this.vz[i] = c;
    }
  }

  /**
   * Open or shut basin `i`'s gate.
   *
   * A basin's gate is only ever meant to open once per relay: the sluice
   * choreography never calls this to close a gate that has finished
   * draining, because a basin with nothing left to hold back has nothing a
   * shut gate would protect — closing it would only trap whatever water is
   * still transiting as a puddle stranded on the hatch. This method does not
   * enforce that on its own; it is a caller discipline, kept here as a
   * comment because the reason belongs next to the mechanism it explains.
   */
  setGate(i: number, open: boolean): void {
    this.gateOpen[i] = open ? 1 : 0;
    for (let k = 0; k < this.boundaryCount; k++) {
      if (this.bgate[k] === i) this.bactive[k] = open ? 0 : 1;
    }
  }

  /** How many fluid particles currently sit in basin `i`'s open water column. */
  countInBasin(i: number): number {
    const basin = this.rig.basins[i];
    let count = 0;
    for (let k = 0; k < this.n; k++) {
      if (this.py[k] >= basin.drain - 1e-6 && this.py[k] < basin.top) count++;
    }
    return count;
  }

  /** Live, interleaved `[x0,y0,z0, x1,y1,z1, ...]` world-space positions,
   *  refreshed at the end of every `substep()`. */
  get positions(): Float32Array {
    return this.posOut;
  }

  stats(): SolverStats {
    return {
      n: this.n,
      boundary: this.boundaryCount,
      mass: this.mass,
      denomRest: this.denomRest,
      cfmEps: this.cfmEps,
      avgRho: this.avgRho,
    };
  }

  /** Reseed the fluid at its initial lattice, at rest, with every gate shut —
   *  a relay that has not run yet. */
  reset(): void {
    for (let i = 0; i < this.n; i++) {
      this.px[i] = this.initialSeed[i * 3]; this.py[i] = this.initialSeed[i * 3 + 1]; this.pz[i] = this.initialSeed[i * 3 + 2];
      this.vx[i] = 0; this.vy[i] = 0; this.vz[i] = 0;
    }
    this.gateOpen.fill(0);
    this.bactive.fill(1);
    this.avgRho = this.params.restDensity;
    this.syncPositionsOut();
  }

  private syncPositionsOut(): void {
    for (let i = 0; i < this.n; i++) {
      this.posOut[i * 3] = this.px[i];
      this.posOut[i * 3 + 1] = this.py[i];
      this.posOut[i * 3 + 2] = this.pz[i];
    }
  }

  /**
   * Advance the fluid by exactly `dt`. One call is one fixed-size Position
   * Based Fluids step: predict, build neighbour lists once, run
   * `iterations` rounds of [lambda, position-delta] with confinement applied
   * inside the loop, recover velocity, add XSPH viscosity and surface
   * tension, then finalize with confinement applied once more and outward
   * contact velocity removed.
   */
  substep(dt: number): void {
    const p = this.params;
    const n = this.n;
    const projected = new Float64Array(4);

    // ── predict ──────────────────────────────────────────────────────────
    for (let i = 0; i < n; i++) {
      this.vy[i] -= dt * p.gravity;
      this.qx[i] = this.px[i] + dt * this.vx[i];
      this.qy[i] = this.py[i] + dt * this.vy[i];
      this.qz[i] = this.pz[i] + dt * this.vz[i];
    }

    // ── neighbour lists, once per substep ──────────────────────────────────
    const fGrid = this.buildGrid(this.qx, this.qy, this.qz, n);
    for (let i = 0; i < n; i++) {
      this.nbrCount[i] = this.neighbours(fGrid, this.qx, this.qy, this.qz, this.qx[i], this.qy[i], this.qz[i], this.nbr, i * MAX_FLUID_NEIGHBOURS, MAX_FLUID_NEIGHBOURS, null);
      this.bnbCount[i] = this.neighbours(this.bGrid, this.bx, this.by, this.bz, this.qx[i], this.qy[i], this.qz[i], this.bnb, i * MAX_BOUNDARY_NEIGHBOURS, MAX_BOUNDARY_NEIGHBOURS, this.bactive);
    }

    // ── [lambda, delta] × iterations, confinement inside the loop ─────────
    for (let it = 0; it < p.iterations; it++) {
      for (let i = 0; i < n; i++) {
        let rho = this.mass * this.poly6(0);
        let gx = 0, gy = 0, gz = 0, sumGrad2 = 0;
        const b0 = i * MAX_FLUID_NEIGHBOURS, cN = this.nbrCount[i];
        for (let k = 0; k < cN; k++) {
          const j = this.nbr[b0 + k];
          if (j === i) continue;
          const dx = this.qx[i] - this.qx[j], dy = this.qy[i] - this.qy[j], dz = this.qz[i] - this.qz[j];
          const r2 = dx * dx + dy * dy + dz * dz;
          if (r2 >= this.h2) continue;
          rho += this.mass * this.poly6(r2);
          if (r2 < 1e-12) continue;
          const rr = Math.sqrt(r2), hr = this.h - rr;
          const s = this.volume * this.spikyGradCoef * hr * hr / rr;
          gx += s * dx; gy += s * dy; gz += s * dz; sumGrad2 += s * s * r2;
        }
        const c0 = i * MAX_BOUNDARY_NEIGHBOURS, cB = this.bnbCount[i];
        for (let k = 0; k < cB; k++) {
          const m = this.bnb[c0 + k];
          const dx = this.qx[i] - this.bx[m], dy = this.qy[i] - this.by[m], dz = this.qz[i] - this.bz[m];
          const r2 = dx * dx + dy * dy + dz * dz;
          if (r2 >= this.h2 || r2 < 1e-12) continue;
          rho += this.psi[m] * this.poly6(r2);
          const rr = Math.sqrt(r2), hr = this.h - rr;
          const s = this.psi[m] * this.invRestDensity * this.spikyGradCoef * hr * hr / rr;
          gx += s * dx; gy += s * dy; gz += s * dz;
        }
        this.rho[i] = rho;
        const c = rho * this.invRestDensity - 1;
        this.lam[i] = c > 0 ? -c / (gx * gx + gy * gy + gz * gz + sumGrad2 + this.cfmEps + 1e-12) : 0;
      }

      for (let i = 0; i < n; i++) {
        let dxAcc = 0, dyAcc = 0, dzAcc = 0;
        let bxAcc = 0, byAcc = 0, bzAcc = 0;
        const li = this.lam[i];
        const b0 = i * MAX_FLUID_NEIGHBOURS, cN = this.nbrCount[i];
        for (let k = 0; k < cN; k++) {
          const j = this.nbr[b0 + k];
          if (j === i) continue;
          const dx = this.qx[i] - this.qx[j], dy = this.qy[i] - this.qy[j], dz = this.qz[i] - this.qz[j];
          const r2 = dx * dx + dy * dy + dz * dz;
          if (r2 >= this.h2 || r2 < 1e-12) continue;
          const rr = Math.sqrt(r2), hr = this.h - rr;
          const s = this.spikyGradCoef * hr * hr / rr;
          // s_corr: see the constructor's comment on `sCorrWq` for the ^4 falloff.
          const t = this.h2 - r2;
          const ratio = this.poly6Coef * t * t * t * this.sCorrWq;
          const r2r = ratio * ratio;
          const w = (li + this.lam[j] - this.sCorrScaled * r2r * r2r) * s;
          dxAcc += w * dx; dyAcc += w * dy; dzAcc += w * dz;
        }
        const c0 = i * MAX_BOUNDARY_NEIGHBOURS, cB = this.bnbCount[i];
        for (let k = 0; k < cB; k++) {
          const m = this.bnb[c0 + k];
          const dx = this.qx[i] - this.bx[m], dy = this.qy[i] - this.by[m], dz = this.qz[i] - this.bz[m];
          const r2 = dx * dx + dy * dy + dz * dz;
          if (r2 >= this.h2 || r2 < 1e-12) continue;
          const rr = Math.sqrt(r2), hr = this.h - rr;
          const s = this.psi[m] * this.spikyGradCoef * hr * hr / rr;
          bxAcc += li * s * dx; byAcc += li * s * dy; bzAcc += li * s * dz;
        }
        this.confine(
          this.qx[i] + (dxAcc * this.volume + bxAcc * this.invRestDensity) * p.omega,
          this.qy[i] + (dyAcc * this.volume + byAcc * this.invRestDensity) * p.omega,
          this.qz[i] + (dzAcc * this.volume + bzAcc * this.invRestDensity) * p.omega,
          projected,
        );
        this.corrX[i] = projected[0]; this.corrY[i] = projected[1]; this.corrZ[i] = projected[2];
      }
      this.qx.set(this.corrX); this.qy.set(this.corrY); this.qz.set(this.corrZ);
    }

    // ── velFromPos ───────────────────────────────────────────────────────
    const invDt = 1 / dt;
    for (let i = 0; i < n; i++) {
      this.vx[i] = (this.qx[i] - this.px[i]) * invDt;
      this.vy[i] = (this.qy[i] - this.py[i]) * invDt;
      this.vz[i] = (this.qz[i] - this.pz[i]) * invDt;
    }

    // ── XSPH viscosity — corrX/Y/Z reused as the correction accumulator ───
    for (let i = 0; i < n; i++) {
      let ax = 0, ay = 0, az = 0;
      const b0 = i * MAX_FLUID_NEIGHBOURS, cN = this.nbrCount[i];
      for (let k = 0; k < cN; k++) {
        const j = this.nbr[b0 + k];
        if (j === i) continue;
        const dx = this.qx[i] - this.qx[j], dy = this.qy[i] - this.qy[j], dz = this.qz[i] - this.qz[j];
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 >= this.h2) continue;
        const f = this.mass * this.poly6(r2) / Math.max(this.rho[j], 0.5 * p.restDensity);
        ax += f * (this.vx[j] - this.vx[i]); ay += f * (this.vy[j] - this.vy[i]); az += f * (this.vz[j] - this.vz[i]);
      }
      this.corrX[i] = p.xsphC * ax; this.corrY[i] = p.xsphC * ay; this.corrZ[i] = p.xsphC * az;
    }

    // ── surface tension — needs its own normals pass first ────────────────
    if (p.surfaceTensionK > 0) {
      for (let i = 0; i < n; i++) {
        let ax = 0, ay = 0, az = 0;
        const b0 = i * MAX_FLUID_NEIGHBOURS, cN = this.nbrCount[i];
        for (let k = 0; k < cN; k++) {
          const j = this.nbr[b0 + k];
          if (j === i) continue;
          const dx = this.qx[i] - this.qx[j], dy = this.qy[i] - this.qy[j], dz = this.qz[i] - this.qz[j];
          const r2 = dx * dx + dy * dy + dz * dz;
          if (r2 >= this.h2 || r2 < 1e-12) continue;
          const rr = Math.sqrt(r2), hr = this.h - rr;
          const s = (this.mass / Math.max(this.rho[j], 0.5 * p.restDensity)) * this.spikyGradCoef * hr * hr / rr;
          ax += s * dx; ay += s * dy; az += s * dz;
        }
        this.nrmX[i] = this.h * ax; this.nrmY[i] = this.h * ay; this.nrmZ[i] = this.h * az;
      }
      for (let i = 0; i < n; i++) {
        let ax = 0, ay = 0, az = 0;
        const b0 = i * MAX_FLUID_NEIGHBOURS, cN = this.nbrCount[i];
        for (let k = 0; k < cN; k++) {
          const j = this.nbr[b0 + k];
          if (j === i) continue;
          const dx = this.qx[i] - this.qx[j], dy = this.qy[i] - this.qy[j], dz = this.qz[i] - this.qz[j];
          const r2 = dx * dx + dy * dy + dz * dz;
          if (r2 >= this.h2 || r2 < 1e-12) continue;
          const rr = Math.sqrt(r2), hr = this.h - rr;
          const kk = hr * hr * hr * rr * rr * rr;
          const cw = 2 * rr > this.h ? this.cohesCoef * kk : this.cohesCoef * (2 * kk - this.cohesTerm);
          const fc = -p.surfaceTensionK * this.mass * cw / rr;
          const K = 2 * p.restDensity / (this.rho[i] + this.rho[j]);
          ax += K * (fc * dx - p.surfaceTensionK * (this.nrmX[i] - this.nrmX[j]));
          ay += K * (fc * dy - p.surfaceTensionK * (this.nrmY[i] - this.nrmY[j]));
          az += K * (fc * dz - p.surfaceTensionK * (this.nrmZ[i] - this.nrmZ[j]));
        }
        this.corrX[i] += dt * ax; this.corrY[i] += dt * ay; this.corrZ[i] += dt * az;
      }
    }

    // ── finalize: confine once more, drop outward contact velocity ───────
    let rhoSum = 0;
    for (let i = 0; i < n; i++) {
      this.confine(this.qx[i], this.qy[i], this.qz[i], projected);
      let ux = this.vx[i] + this.corrX[i], uy = this.vy[i] + this.corrY[i], uz = this.vz[i] + this.corrZ[i];
      if (projected[3]) {
        // A contact this substep: remove only the velocity component driving
        // further into the wall the rig just pushed this particle out of, so
        // the particle keeps whatever tangential motion it had rather than
        // being stopped dead by every wall it grazes.
        const nx = projected[0] - this.qx[i], ny = projected[1] - this.qy[i], nz = projected[2] - this.qz[i];
        const len = Math.hypot(nx, ny, nz);
        if (len > 1e-9) {
          const a = nx / len, b = ny / len, c = nz / len;
          const dn = ux * a + uy * b + uz * c;
          if (dn < 0) { ux -= a * dn; uy -= b * dn; uz -= c * dn; }
        }
      }
      this.vx[i] = ux; this.vy[i] = uy; this.vz[i] = uz;
      this.px[i] = projected[0]; this.py[i] = projected[1]; this.pz[i] = projected[2];
      rhoSum += this.rho[i];
    }
    this.avgRho = rhoSum / n;
    this.syncPositionsOut();
  }
}
