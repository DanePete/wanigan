/**
 * The fluid module's one door: mount the companion's solver against the rig
 * on a canvas, and hand back the handful of verbs the sluice needs.
 *
 * The view owns the animation frame and calls `tick` from it — only in the
 * fluid tier. In the still tier `tick` is simply never called, so nothing
 * here needs to know what motion setting the operator chose; and in the
 * simple tier this module is never mounted at all. `fluidAvailable()` is the
 * capability probe the tier decision reads (`fluidTier` in relay-rig.ts): a
 * device without WebGL2 float render targets gets the rail's own animated
 * level, never a broken canvas.
 *
 * Time is a bank of fixed 1/120 s substeps, exactly as the vendored solver
 * runs: as many as real time has accrued, capped per frame so a slow frame
 * slows the water rather than exploding it.
 */
import type { RigLayout } from '@shared/relay-rig';
import { FIXED_DT, FluidSolver, MAX_SUBSTEPS_PER_FRAME, type SolverParams, type SolverStats } from './solver';
import { createFluidRenderer, fluidAvailableIn, type FluidTheme } from './render';

export type FluidMount = {
  /** Open or shut basin `i`'s gate. Open stays open: a drained basin holds nothing. */
  setGate(i: number, open: boolean): void;
  /** One completed tool call disturbs the water in basin `i` — the runtime's own ray, aimed at that basin. */
  impulse(basin: number, seed: number): void;
  countInBasin(i: number): number;
  /** Advance the bank and draw. Call once per animation frame, only in the fluid tier. */
  tick(now: number, theme: FluidTheme): void;
  stats(): SolverStats;
  reset(): void;
  dispose(): void;
};

let probed: boolean | null = null;

/** Whether this window can run the fluid at all. Probed once; a lost context later is handled by the mount. */
export function fluidAvailable(): boolean {
  if (probed !== null) return probed;
  try {
    const canvas = document.createElement('canvas');
    probed = fluidAvailableIn(canvas);
  } catch {
    probed = false;
  }
  return probed;
}

/** Where the runtime fires its typing ray, translated onto a basin: from in front of the slab, straight in. */
const RAY_Z = 2.0;
const RAY_RADIUS = 0.32;
const RAY_SPEED_LIMIT = 3;
const RAY_LIFT = 0.15;

export function mountFluid(
  canvas: HTMLCanvasElement,
  rig: RigLayout,
  opts: Partial<Pick<SolverParams, 'spacing' | 'fill'>> & { initialBasin?: number } = {},
): FluidMount | null {
  const { initialBasin = 0, ...params } = opts;
  const solver = new FluidSolver(rig, params, initialBasin);
  const renderer = createFluidRenderer(canvas, solver.params.spacing);
  if (!renderer) return null;

  let bank = 0;
  let last: number | null = null;
  let disposed = false;

  const fit = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(2, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(2, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    renderer.resize(w, h);
  };

  // Targets are allocated on the first resize, so a renderer that builds fine
  // can still fail here. Asking now means the caller gets the same `null` it
  // already handles, rather than a mount that can only draw nothing.
  fit();
  if (renderer.failed()) {
    renderer.dispose();
    return null;
  }

  return {
    setGate: (i, open) => solver.setGate(i, open),
    impulse: (basin, seed) => {
      const b = rig.basins[basin];
      if (!b) return;
      const x = 0.5 + (Math.abs(seed) % 3) * 0.7;
      const y = b.drain + rig.funnelDrop + RAY_LIFT;
      solver.applyRayImpulse(
        [x, y, RAY_Z],
        [0, 0, -1],
        [seed % 2 ? 0.25 : -0.25, 0.9, 0],
        RAY_RADIUS,
        RAY_SPEED_LIMIT,
      );
    },
    countInBasin: (i) => solver.countInBasin(i),
    tick: (now, theme) => {
      if (disposed) return;
      const dt = last === null ? 0 : Math.min(0.05, (now - last) / 1000);
      last = now;
      bank += dt;
      let steps = 0;
      while (bank >= FIXED_DT && steps < MAX_SUBSTEPS_PER_FRAME) {
        solver.substep(FIXED_DT);
        bank -= FIXED_DT;
        steps++;
      }
      // A frame that could not keep up does not carry its debt forward: the
      // water runs slow, it does not later run fast to catch up.
      if (bank > FIXED_DT) bank = FIXED_DT;
      fit();
      // A resize to a new size can fail where the first one did not. Stopping
      // leaves the canvas cleared and the CSS rail beneath it visible, which
      // is the honest picture; continuing would composite from targets that
      // were never drawn into.
      if (renderer.failed()) {
        disposed = true;
        renderer.dispose();
        // The buffer of a lost context keeps its last pixels, and on this rail
        // that is a block of colour sitting over the SVG. Hiding the canvas is
        // what the CSS already does for every tier below this one, so the rail
        // simply becomes the one a machine without the fluid would have had.
        canvas.hidden = true;
        return;
      }
      const positions = solver.positions;
      renderer.draw(positions, positions.length / 3, rig, theme);
    },
    stats: () => solver.stats(),
    reset: () => { solver.reset(); bank = 0; last = null; },
    dispose: () => { disposed = true; renderer.dispose(); },
  };
}
