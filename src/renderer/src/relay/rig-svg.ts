import { DEFAULT_FILL, type RigLayout } from '@shared/relay-rig';

/**
 * The rig as SVG attributes: the one place world units become drawing units.
 *
 * `rigLayout` in `src/shared/relay-rig.ts` owns the geometry — basin tops and
 * drains, the funnel drop, the drain width, every pipe — and this module only
 * projects it. y is up in the world and down on the screen, so `sy` flips;
 * nothing else is invented here. The shapes are exactly the ones the verified
 * demo drew, so the fluid module's boundary (built from the same layout) and
 * the glass the operator sees can never disagree about where a wall is.
 *
 * Coordinates are SVG attributes, not styles: the style gate counts inline
 * style objects and this file writes none. The CSS-side numbers — the rig's
 * world size, a tag's offset — go out through `tagPlacement` and are written
 * on a ref with `setProperty` by the view.
 */

/** viewBox units per world unit. The on-screen size is `--rl-unit` in relay.css. */
export const SCALE = 100;

/** Drawing-unit offsets the demo settled: a hairline inset for the level so
 *  it sits inside the glass, and the gate's overhang past the drain edges. */
const LEVEL_INSET = 2;
const LEVEL_LIFT = 1;
const GATE_OVERHANG = 2;
const GATE_HALF_THICKNESS = 3;
const GATE_RADIUS = 2;
const STREAM_INSET = 3;
/** The return line runs this far below the last drain and this far outside the right wall. */
const RETURN_DROP = 10;
const RETURN_REACH = 14;
/** The return line re-enters this far above the receiving basin's rim, in world units. */
const RETURN_ENTRY = 0.2;

export type Rect = { x: number; y: number; width: number; height: number };

export type BasinShapes = {
  /** The open vessel with its funnel floor, closed for the glass fill. */
  vessel: string;
  /** The vessel's lit edge: walls and funnel, open across the drain. */
  wall: string;
  /** The Simple tier's water body, sitting on the funnel up to the seed fill. */
  level: string;
  /** The pipe walls below the drain. */
  pipeWall: string;
  gate: Rect & { rx: number };
  /** The pipe's glass, for every basin but the last (whose pipe ends at the foot). */
  pipe: Rect | null;
  /** The Simple tier's stream inside that pipe. */
  stream: Rect | null;
};

export type RigShapes = { viewBox: string; basins: BasinShapes[]; returnLine: string };

const round = (n: number): number => Math.round(n * 100) / 100;

/**
 * Every path and rect the rig needs, in viewBox units. `returnInto` is the
 * basin the hand-back's return line feeds — the implement basin, found by the
 * view from the docket rather than assumed to be the third.
 */
export function rigShapes(rig: RigLayout, returnInto: number): RigShapes {
  const sx = (x: number): number => round(x * SCALE);
  const sy = (y: number): number => round((rig.height - y) * SCALE);
  const half = rig.drainWidth / 2;
  const left = sx(0);
  const right = sx(rig.width);
  const drainLeft = sx(rig.centerX - half);
  const drainRight = sx(rig.centerX + half);
  const last = rig.basinCount - 1;

  const basins = rig.basins.map((basin, i): BasinShapes => {
    const yTop = sy(basin.top);
    const yFunnel = sy(basin.drain + rig.funnelDrop);
    const yDrain = sy(basin.drain);
    const yLevel = sy(basin.drain + rig.funnelDrop + DEFAULT_FILL);
    const yPipe = sy(rig.pipes[i].bottom);
    const feeds = i < last;
    return {
      vessel: `M${left},${yTop} L${left},${yFunnel} L${drainLeft},${yDrain} L${drainRight},${yDrain} L${right},${yFunnel} L${right},${yTop} Z`,
      wall: `M${left},${yTop} L${left},${yFunnel} L${drainLeft},${yDrain} M${drainRight},${yDrain} L${right},${yFunnel} L${right},${yTop}`,
      level: `M${left + LEVEL_INSET},${yLevel} L${left + LEVEL_INSET},${yFunnel} L${drainLeft},${yDrain - LEVEL_LIFT} L${drainRight},${yDrain - LEVEL_LIFT} L${right - LEVEL_INSET},${yFunnel} L${right - LEVEL_INSET},${yLevel} Z`,
      pipeWall: `M${drainLeft},${yDrain} L${drainLeft},${yPipe} M${drainRight},${yDrain} L${drainRight},${yPipe}`,
      gate: {
        x: drainLeft - GATE_OVERHANG, y: yDrain - GATE_HALF_THICKNESS,
        width: drainRight - drainLeft + 2 * GATE_OVERHANG, height: 2 * GATE_HALF_THICKNESS, rx: GATE_RADIUS,
      },
      pipe: feeds ? { x: drainLeft, y: yDrain, width: drainRight - drainLeft, height: round(yPipe - yDrain) } : null,
      stream: feeds
        ? { x: drainLeft + STREAM_INSET, y: yDrain, width: drainRight - drainLeft - 2 * STREAM_INSET, height: round(yPipe - yDrain) }
        : null,
    };
  });

  const into = Math.min(Math.max(0, returnInto), last);
  const x0 = sx(rig.centerX);
  const y0 = sy(rig.pipes[last].bottom);
  const xReturn = right + RETURN_REACH;
  const yEntry = sy(rig.basins[into].top + RETURN_ENTRY);
  const returnLine = `M${x0},${y0} L${x0},${y0 + RETURN_DROP} L${xReturn},${y0 + RETURN_DROP} L${xReturn},${yEntry} L${drainRight},${yEntry}`;

  return { viewBox: `0 0 ${sx(rig.width)} ${sy(0)}`, basins, returnLine };
}

/**
 * Where a basin's etched tag sits: its offset from the rig's top and the
 * vessel's own height, both in world units. relay.css multiplies each by
 * `--rl-unit`, so the tag lands on its vessel at every pixel scale and the
 * silt inside it settles on that vessel's floor.
 */
export function tagPlacement(rig: RigLayout, i: number): { y: number; h: number } {
  const basin = rig.basins[i];
  return { y: round(rig.height - basin.top), h: round(basin.top - basin.drain) };
}
