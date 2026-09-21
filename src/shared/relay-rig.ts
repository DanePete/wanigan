/**
 * The Sluice's apparatus: one rig, described as data rather than drawn.
 *
 * A relay's five basins share one glass vessel — open basins with funnel
 * floors, each floor pierced by a gated drain that feeds a pipe into the
 * basin below. This module is the geometry of that vessel and nothing else:
 * no DOM, no WebGL, no solver state. It answers "where is the floor at this
 * x" and "which basin is this y in" as pure functions of the layout, so the
 * fluid solver, the CSS fallback tier and their tests can all read the same
 * numbers instead of three copies drifting apart.
 *
 * The dimensions below are carried over unchanged from the verified demo
 * (`relay-sluice.html`) rather than invented here: five basins at these
 * constants seed exactly 1,460 fluid particles and 4,452 boundary samples at
 * spacing 0.06, which `relay-rig.test.ts` pins as a regression.
 */

// ─────────────────────────── geometry constants ────────────────────────────
// y is up; gravity is -y. Basin 0 is at the top. Every basin is an open
// vessel WIDTH wide with a funnel floor that drops FUNNEL_DROP from the walls
// to a drain DRAIN_WIDTH wide. Below every drain is a pipe PIPE_HEIGHT tall
// into the basin below. The whole rig is a slab DEPTH deep — a thin tank, so
// a section reads like a diagram while the solver underneath stays 3D.

/** World width of every basin, in world units. Independent of basin count. */
export const WIDTH = 2.4;
/** Height of the open water column above a basin's drain. */
export const BASIN_HEIGHT = 0.92;
/** Height of the pipe connecting one basin's drain to the next basin's rim. */
export const PIPE_HEIGHT = 0.45;
/** Width of the gated drain at the bottom of a basin's funnel. */
export const DRAIN_WIDTH = 0.34;
/** Depth of the slab (the solver's z extent). Thin on purpose: a section. */
export const DEPTH = 0.3;
/** How far the funnel floor drops from the side walls down to the drain. */
export const FUNNEL_DROP = 0.3;
/** Headroom above basin 0's rim, where the composer's intent lands. */
export const HEAD_CLEARANCE = 0.25;
/** Clearance below the last basin's drain, so the final pipe ends above 0. */
export const FOOT_CLEARANCE = 0.35;
/** How many basins a rig has when the caller does not say. */
export const DEFAULT_BASIN_COUNT = 5;
/** The verified demo's CPU spacing: the solver's own 0.055 nudged to 0.06 for
 *  a CPU budget. Resolution, not physics — see solver.ts. */
export const DEFAULT_SPACING = 0.06;
/** How high above the drain the seed lattice fills basin 0, in world units. */
export const DEFAULT_FILL = 0.3;

/**
 * Fraction of `FOOT_CLEARANCE` that the last pipe's water lands on. Not the
 * floor of the world (0): a little clearance below the landing point keeps a
 * particle that overshoots the last drain from being confined against the
 * rig's own outer boundary in the same frame it arrives.
 */
const FOOT_LANDING_FRACTION = 0.15;

/** Tolerance for "is this y inside this basin", matching the demo's own
 *  epsilon so a particle sitting exactly on a drain still counts as in. */
const BASIN_EPSILON = 1e-6;

/** Tolerance used only to keep a closed range's own edge inside a `<=` loop
 *  bound, so floating-point round-off never drops the last sample. */
const EPS = 1e-9;

// ─────────────────────────────── layout ─────────────────────────────────────

/** One basin's vertical extent. `top` already folds in `HEAD_CLEARANCE` for
 *  basin 0, so every consumer reads one number rather than special-casing it. */
export type Basin = { readonly top: number; readonly drain: number };

/** The pipe below one basin's drain, feeding the basin under it (or the
 *  rig's own foot, for the last one). */
export type Pipe = { readonly top: number; readonly bottom: number };

export type RigLayout = {
  readonly basinCount: number;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly centerX: number;
  readonly drainWidth: number;
  readonly funnelDrop: number;
  /** Rise in floor height per unit of horizontal distance from the drain. */
  readonly funnelSlope: number;
  readonly basinHeight: number;
  readonly pipeHeight: number;
  readonly headClearance: number;
  readonly footClearance: number;
  /** Basin 0 first, descending. */
  readonly basins: readonly Basin[];
  /** `pipes[i]` is the pipe below `basins[i]`'s drain. */
  readonly pipes: readonly Pipe[];
};

/**
 * The rig's geometry for a given number of basins. Pure arithmetic: calling
 * this twice with the same count returns the same numbers, which is what lets
 * the solver, the CSS fallback and every test share one apparatus.
 */
export function rigLayout(nBasins: number = DEFAULT_BASIN_COUNT): RigLayout {
  if (!Number.isInteger(nBasins) || nBasins < 1) {
    throw new RangeError(`rigLayout needs at least one basin, got ${String(nBasins)}`);
  }

  const width = WIDTH;
  const depth = DEPTH;
  const drainWidth = DRAIN_WIDTH;
  const funnelDrop = FUNNEL_DROP;
  const basinHeight = BASIN_HEIGHT;
  const pipeHeight = PIPE_HEIGHT;
  const headClearance = HEAD_CLEARANCE;
  const footClearance = FOOT_CLEARANCE;
  const centerX = width / 2;
  const funnelSlope = funnelDrop / ((width - drainWidth) / 2);
  const height = footClearance + nBasins * basinHeight + (nBasins - 1) * pipeHeight + headClearance;

  // The rim of basin i, before basin 0's extra headroom is folded in.
  const rim = (i: number): number => height - headClearance - i * (basinHeight + pipeHeight);

  const basins: Basin[] = [];
  for (let i = 0; i < nBasins; i++) {
    basins.push({ top: rim(i) + (i === 0 ? headClearance : 0), drain: rim(i) - basinHeight });
  }

  const pipes: Pipe[] = [];
  for (let i = 0; i < nBasins; i++) {
    const bottom = i < nBasins - 1 ? basins[i + 1].top : footClearance * FOOT_LANDING_FRACTION;
    pipes.push({ top: basins[i].drain, bottom });
  }

  return {
    basinCount: nBasins, width, height, depth, centerX, drainWidth, funnelDrop, funnelSlope,
    basinHeight, pipeHeight, headClearance, footClearance, basins, pipes,
  };
}

/**
 * The height of basin `i`'s funnel floor at horizontal position `x`.
 *
 * Flat across the drain itself (the gate floor), then rising at
 * `funnelSlope` on either side up to the walls. This is the one function the
 * solver's boundary confinement and the seed lattice both call, so the two
 * can never disagree about where the floor is.
 */
export function floorY(rig: RigLayout, i: number, x: number): number {
  const half = rig.drainWidth / 2;
  const t = Math.max(0, Math.abs(x - rig.centerX) - half);
  return rig.basins[i].drain + rig.funnelSlope * t;
}

/**
 * Which basin's open water column contains height `y`, or null when `y` is
 * in a pipe, in the headspace above every rim, or below the rig entirely.
 *
 * Matches the verified demo's `countInBasin` range exactly: `[drain, top)`,
 * with basin 0's `top` already carrying its headroom.
 */
export function basinOf(rig: RigLayout, y: number): number | null {
  for (let i = 0; i < rig.basinCount; i++) {
    const basin = rig.basins[i];
    if (y >= basin.drain - BASIN_EPSILON && y < basin.top) return i;
  }
  return null;
}

/**
 * The initial fluid lattice: a block of particles spaced `d` apart, filling
 * the selected basin from its drain up to `fill` above the funnel's deepest point, kept
 * clear of the sloped floor by one particle radius.
 *
 * Returned as one flat, interleaved `[x0,y0,z0, x1,y1,z1, ...]` array rather
 * than three parallel arrays: this is a seed the solver copies once at
 * construction, not a hot per-frame path, so the shape that is easiest to
 * hand to a `Float32Array` view wins over the shape the solver computes with
 * internally.
 */
export function seedWater(rig: RigLayout, d: number, fill: number, initialBasin = 0): Float32Array {
  if (!Number.isInteger(initialBasin) || initialBasin < 0 || initialBasin >= rig.basinCount) {
    throw new RangeError(`The initial basin must belong to this rig, got ${String(initialBasin)}`);
  }
  const r = d / 2;
  const drain0 = rig.basins[0].drain;
  // Translate the same lattice instead of replaying completed stages when a
  // view opens. Keeping its sampling origin preserves the particle count.
  const shift = rig.basins[initialBasin].drain - drain0;
  const points: number[] = [];
  for (let x = r + d / 2; x < rig.width - r; x += d) {
    for (let z = r; z < rig.depth - r + EPS; z += d) {
      for (let y = drain0 + r; y < drain0 + rig.funnelDrop + fill; y += d) {
        if (y >= floorY(rig, 0, x) + r) points.push(x, y + shift, z);
      }
    }
  }
  return Float32Array.from(points);
}

/**
 * Boundary samples on every wetted surface: side walls, funnel floors, gate
 * floors and pipe walls at spacing `d`; the front and back glass at `2d`
 * (sparser, because the solver's `psi` self-calibrates per sample and the
 * glass only needs to keep particles off the z faces, not resolve a floor).
 *
 * `gate[k]` names which basin's gate sample `k` belongs to — the one surface
 * that turns off when that basin's gate opens — or `-1` for every other
 * surface, which never does.
 */
export type BoundarySamples = { readonly positions: Float32Array; readonly gate: Int32Array };

export function boundarySamples(rig: RigLayout, d: number): BoundarySamples {
  const positions: number[] = [];
  const gate: number[] = [];

  const seg = (x0: number, y0: number, x1: number, y1: number, gateIndex: number, spacing: number): void => {
    const length = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.round(length / spacing));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      for (let z = 0; z <= rig.depth + EPS; z += spacing) {
        positions.push(x, y, z);
        gate.push(gateIndex);
      }
    }
  };

  const glass = (x0: number, y0: number, x1: number, y1: number, spacing: number): void => {
    for (let x = x0; x <= x1 + EPS; x += spacing) {
      for (let y = y0; y <= y1 + EPS; y += spacing) {
        positions.push(x, y, 0); gate.push(-1);
        positions.push(x, y, rig.depth); gate.push(-1);
      }
    }
  };

  const half = rig.drainWidth / 2;
  for (let i = 0; i < rig.basinCount; i++) {
    const basin = rig.basins[i];
    const pipe = rig.pipes[i];
    seg(0, basin.top, 0, basin.drain + rig.funnelDrop, -1, d);                          // left wall
    seg(rig.width, basin.top, rig.width, basin.drain + rig.funnelDrop, -1, d);           // right wall
    seg(0, basin.drain + rig.funnelDrop, rig.centerX - half, basin.drain, -1, d);        // left funnel
    seg(rig.width, basin.drain + rig.funnelDrop, rig.centerX + half, basin.drain, -1, d); // right funnel
    seg(rig.centerX - half, basin.drain, rig.centerX + half, basin.drain, i, d);          // the gate floor
    glass(0, basin.drain, rig.width, basin.top, 2 * d);
    seg(rig.centerX - half, pipe.top, rig.centerX - half, pipe.bottom, -1, d);            // pipe walls
    seg(rig.centerX + half, pipe.top, rig.centerX + half, pipe.bottom, -1, d);
    glass(rig.centerX - half, pipe.bottom, rig.centerX + half, pipe.top, 2 * d);
  }

  return { positions: Float32Array.from(positions), gate: Int32Array.from(gate) };
}

// ────────────────────────────── the tier decision ───────────────────────────

/** The operator's own setting for the fluid module, independent of whether
 *  the device can actually run it. */
export type FluidSetting = 'auto' | 'on' | 'off';
/** The app-wide motion setting: `data-motion` on the root. */
export type MotionSetting = 'auto' | 'full' | 'off';
export type FluidTier = 'fluid' | 'simple' | 'still';

export type TierInput = {
  readonly setting: FluidSetting;
  readonly webgl2: boolean;
  readonly motion: MotionSetting;
  readonly reducedMotion: boolean;
};

/**
 * Which of the sluice's three tiers a basin renders, decided from recorded
 * capability and setting rather than guessed.
 *
 * Motion suppression outranks everything else: a still basin is still
 * whether or not the fluid module could have run, because "every value, no
 * movement" is the rendering contract Motion off makes, not a fallback for
 * when the good renderer is unavailable. `'full'` is the one motion setting
 * that survives the OS's own reduced-motion request, matching every other
 * `--mo-*` token in `motion.css`.
 *
 * Short of that: the operator's own `'off'` setting is honoured even when
 * the device could run the real solver — uninstalling the module is a choice,
 * not a capability question — and otherwise the tier is `'fluid'` exactly
 * when WebGL2 is available, `'simple'` when it is not.
 */
export function fluidTier(input: TierInput): FluidTier {
  const motionSuppressed = input.motion === 'off' || (input.motion !== 'full' && input.reducedMotion);
  if (motionSuppressed) return 'still';
  if (input.setting === 'off') return 'simple';
  return input.webgl2 ? 'fluid' : 'simple';
}
