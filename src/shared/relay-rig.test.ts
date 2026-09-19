/**
 * The rig's contract: the same apparatus every time, a floor with no seam at
 * the drain edge, a seed lattice that never starts inside a wall, boundary
 * samples that actually sit on a surface, and a tier decision that never
 * guesses. The 1,460-particle / 4,452-sample counts pinned below are not
 * arbitrary: they are the verified demo's own numbers at the default rig and
 * spacing, so a change to the geometry that nobody meant to make fails here
 * first rather than showing up as a solver whose stats no longer match.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BASIN_COUNT, DEFAULT_FILL, DEFAULT_SPACING,
  rigLayout, floorY, basinOf, seedWater, boundarySamples, fluidTier,
  type FluidSetting, type MotionSetting, type FluidTier,
} from './relay-rig.ts';

test('a rig needs at least one basin, and refuses a fractional or negative count rather than guessing one', () => {
  assert.throws(() => rigLayout(0), RangeError);
  assert.throws(() => rigLayout(-1), RangeError);
  assert.throws(() => rigLayout(1.5), RangeError);
  assert.doesNotThrow(() => rigLayout(1));
});

test('layout invariants: drains descend, every pipe connects the basin above it to the one below, and the rig never reaches below the world floor', () => {
  for (const nBasins of [1, 2, DEFAULT_BASIN_COUNT, 8]) {
    const rig = rigLayout(nBasins);
    assert.equal(rig.basins.length, nBasins);
    assert.equal(rig.pipes.length, nBasins);
    assert.ok(rig.width > 0 && rig.height > 0 && rig.depth > 0);

    for (let i = 0; i < nBasins; i++) {
      // Every pipe starts exactly at its own basin's drain.
      assert.equal(rig.pipes[i].top, rig.basins[i].drain);
      if (i < nBasins - 1) {
        // Descending: basin i sits strictly above basin i+1, and the pipe
        // between them lands exactly on the rim below.
        assert.ok(rig.basins[i].drain > rig.basins[i + 1].drain);
        assert.equal(rig.pipes[i].bottom, rig.basins[i + 1].top);
      } else {
        // The last pipe ends inside the rig's own foot clearance, above 0.
        assert.ok(rig.pipes[i].bottom >= 0);
        assert.ok(rig.pipes[i].bottom < rig.footClearance);
      }
      // A basin's drain is always below its own top.
      assert.ok(rig.basins[i].drain < rig.basins[i].top);
    }
  }
});

test('floorY has no seam at the drain edge: flat across the gate, then rising continuously into the funnel', () => {
  const rig = rigLayout();
  const half = rig.drainWidth / 2;

  // Flat across the whole gate width, including its centre and its edges.
  assert.equal(floorY(rig, 0, rig.centerX), rig.basins[0].drain);
  assert.equal(floorY(rig, 0, rig.centerX - half), rig.basins[0].drain);
  assert.equal(floorY(rig, 0, rig.centerX + half), rig.basins[0].drain);

  // Just past the edge the floor has started climbing, and the climb is
  // continuous: a step of size h in x moves the floor by slope*h, with no
  // jump at the boundary itself.
  const delta = 1e-4;
  const atEdge = floorY(rig, 0, rig.centerX + half);
  const pastEdge = floorY(rig, 0, rig.centerX + half + delta);
  assert.ok(pastEdge > atEdge);
  assert.ok(Math.abs((pastEdge - atEdge) - rig.funnelSlope * delta) < 1e-9);

  // Symmetric on the other side.
  const pastEdgeLeft = floorY(rig, 0, rig.centerX - half - delta);
  assert.ok(Math.abs(pastEdgeLeft - pastEdge) < 1e-9);

  // basinOf agrees with the same drain the floor is measured from.
  assert.equal(basinOf(rig, rig.basins[0].drain), 0);
  assert.equal(basinOf(rig, rig.basins[0].top - 1e-6), 0);
  assert.equal(basinOf(rig, rig.basins[0].top), null);
});

test('the seed lattice sits entirely inside basin 0, above the floor and inside the walls', () => {
  const rig = rigLayout();
  const seed = seedWater(rig, DEFAULT_SPACING, DEFAULT_FILL);
  const n = seed.length / 3;
  assert.ok(n > 0);
  // Pinned to the verified demo's own count at these exact constants.
  assert.equal(n, 1460);

  for (let i = 0; i < n; i++) {
    const x = seed[i * 3], y = seed[i * 3 + 1], z = seed[i * 3 + 2];
    assert.ok(x > 0 && x < rig.width, `x ${x} inside the walls`);
    assert.ok(z > 0 && z < rig.depth, `z ${z} inside the slab`);
    assert.ok(y >= floorY(rig, 0, x), `y ${y} above the floor at x ${x}`);
    assert.equal(basinOf(rig, y), 0, `y ${y} reads as basin 0`);
  }
});

test('opening an existing relay seeds only its recorded current basin, including a narrowed three-stage relay', () => {
  for (const count of [3, 5]) {
    const rig = rigLayout(count);
    for (let current = 0; current < count; current++) {
      const seed = seedWater(rig, DEFAULT_SPACING, DEFAULT_FILL, current);
      assert.equal(seed.length / 3, 1460, 'changing the current phase preserves the body of water');
      for (let i = 0; i < seed.length; i += 3) {
        assert.equal(basinOf(rig, seed[i + 1]), current, 'opening a relay never replays earlier phases');
        assert.ok(seed[i + 1] >= floorY(rig, current, seed[i]), 'the baseline stays above its own funnel');
      }
    }
    for (const invalid of [-1, count, 0.5]) {
      assert.throws(() => seedWater(rig, DEFAULT_SPACING, DEFAULT_FILL, invalid), RangeError);
    }
  }
});

test('boundary samples all lie on a real surface, and every gate has samples of its own', () => {
  const rig = rigLayout();
  const { positions, gate } = boundarySamples(rig, DEFAULT_SPACING);
  const n = positions.length / 3;
  assert.equal(n, gate.length);
  // Pinned to the verified demo's own count at these exact constants.
  assert.equal(n, 4452);

  const half = rig.drainWidth / 2;
  const eps = 1e-6;
  const lowestPoint = rig.pipes[rig.basinCount - 1].bottom;

  const seenGate = new Set<number>();
  for (let k = 0; k < n; k++) {
    const x = positions[k * 3], y = positions[k * 3 + 1], z = positions[k * 3 + 2];
    assert.ok(x >= -eps && x <= rig.width + eps, `x ${x} inside the rig`);
    assert.ok(z >= -eps && z <= rig.depth + eps, `z ${z} inside the slab`);
    assert.ok(y >= lowestPoint - eps && y <= rig.basins[0].top + eps, `y ${y} inside the rig`);

    const g = gate[k];
    if (g >= 0) {
      seenGate.add(g);
      // A gate sample is on the flat gate floor: its own basin's drain
      // height, and inside the drain width, never on a wall or a funnel.
      assert.ok(Math.abs(y - rig.basins[g].drain) < eps, `gate sample y ${y} on basin ${g}'s drain`);
      assert.ok(x >= rig.centerX - half - eps && x <= rig.centerX + half + eps, `gate sample x ${x} inside the drain`);
    }
  }

  for (let i = 0; i < rig.basinCount; i++) {
    assert.ok(seenGate.has(i), `basin ${i} has at least one gate sample`);
  }
});

test('fluidTier, exhaustively over every setting × motion × reduced-motion × webgl2 combination', () => {
  const settings: readonly FluidSetting[] = ['auto', 'on', 'off'];
  const motions: readonly MotionSetting[] = ['auto', 'full', 'off'];
  const bools = [true, false];

  // Written independently of fluidTier's own implementation, from the rule
  // stated in the design doc: motion suppression wins outright ('full'
  // survives the OS's reduced-motion request, 'off' never does); short of
  // that, the operator's own 'off' setting is honoured regardless of
  // capability; otherwise the tier follows WebGL2 support alone.
  function expected(setting: FluidSetting, motion: MotionSetting, reducedMotion: boolean, webgl2: boolean): FluidTier {
    if (motion === 'off') return 'still';
    if (motion === 'auto' && reducedMotion) return 'still';
    // motion === 'full' never goes still, regardless of reducedMotion.
    if (setting === 'off') return 'simple';
    return webgl2 ? 'fluid' : 'simple';
  }

  let checked = 0;
  for (const setting of settings) {
    for (const motion of motions) {
      for (const reducedMotion of bools) {
        for (const webgl2 of bools) {
          const want = expected(setting, motion, reducedMotion, webgl2);
          const got = fluidTier({ setting, motion, reducedMotion, webgl2 });
          assert.equal(got, want, `setting=${setting} motion=${motion} reducedMotion=${reducedMotion} webgl2=${webgl2}`);
          checked++;
        }
      }
    }
  }
  assert.equal(checked, 3 * 3 * 2 * 2);

  // Spot checks naming the specific rules, so a future reader sees the intent
  // without re-deriving it from the loop above.
  assert.equal(fluidTier({ setting: 'on', webgl2: true, motion: 'off', reducedMotion: false }), 'still');
  assert.equal(fluidTier({ setting: 'on', webgl2: true, motion: 'full', reducedMotion: true }), 'fluid');
  assert.equal(fluidTier({ setting: 'off', webgl2: true, motion: 'auto', reducedMotion: false }), 'simple');
  assert.equal(fluidTier({ setting: 'auto', webgl2: false, motion: 'auto', reducedMotion: false }), 'simple');
  assert.equal(fluidTier({ setting: 'auto', webgl2: true, motion: 'auto', reducedMotion: false }), 'fluid');
});
