/**
 * The sluice's contract: a basin breathes only at a rate that was measured,
 * silts up the same way twice, and shows a level only where a denominator
 * exists. The tests that matter most are the ones that say no — no period from
 * too few events, no gauge on a plan basin, no pile without a bound — because
 * each of them is a place where an invented number would look exactly like a
 * measured one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CADENCE_MAX_MS, CADENCE_MIN_MS, CADENCE_MIN_SAMPLES, CADENCE_QUIET_MS,
  SEDIMENT_CAP, SEDIMENT_SEEDS,
  cadence, gauge, sediment, seedOf,
} from './relay.ts';

test('a basin with fewer than three recorded completions holds still rather than breathing at an invented rate', () => {
  assert.deepEqual(cadence([], 1_000), { kind: 'still', reason: 'too-few-samples' });
  assert.deepEqual(cadence([1_000], 1_000), { kind: 'still', reason: 'too-few-samples' });
  assert.deepEqual(cadence([1_000, 2_000], 2_000), { kind: 'still', reason: 'too-few-samples' });
  // One instant recorded three times is one observation, so it does not buy
  // its way past the minimum.
  assert.deepEqual(cadence([1_000, 1_000, 1_000], 1_000), { kind: 'still', reason: 'too-few-samples' });
  assert.equal(CADENCE_MIN_SAMPLES, 3);
  // Three distinct completions are enough, and that is the whole difference.
  assert.deepEqual(cadence([1_000, 2_000, 3_000], 3_000), { kind: 'swelling', periodMs: 1_000 });
});

test('a session whose last tool call is long past goes glass-flat, and says it went quiet rather than that it had no samples', () => {
  const stamps = [10_000, 11_000, 12_000];
  const last = 12_000;
  assert.deepEqual(cadence(stamps, last + CADENCE_QUIET_MS + 1), { kind: 'still', reason: 'quiet' });
  // At the threshold it is still breathing: the basin flattens after the wait,
  // not on it.
  assert.deepEqual(cadence(stamps, last + CADENCE_QUIET_MS), { kind: 'swelling', periodMs: 1_000 });
  // A clock that cannot be read is not evidence of a stall, so the measured
  // rate stands rather than a working basin being flattened on a bad number.
  assert.deepEqual(cadence(stamps, Number.NaN), { kind: 'swelling', periodMs: 1_000 });
});

test('the period is the median interval, so one four-minute tool call does not slow the whole basin down', () => {
  // Three brisk calls and then one long build: 1s, 1s, 1s, 240s.
  const stamps = [0, 1_000, 2_000, 3_000, 243_000];
  assert.deepEqual(cadence(stamps, 243_000), { kind: 'swelling', periodMs: 1_000 });
  // The mean of those gaps is 60.75s, which would have clamped to the slowest
  // breath and drawn a working agent as very nearly stopped.
  const gaps = [1_000, 1_000, 1_000, 240_000];
  const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  assert.ok(mean > CADENCE_MAX_MS, 'the mean of this session would have pinned the basin at its slowest');
});

test('a measured period is clamped at both ends, so a hammering agent never strobes and a slow one never looks stopped', () => {
  assert.deepEqual(cadence([0, 50, 100, 150], 150), { kind: 'swelling', periodMs: CADENCE_MIN_MS });
  assert.deepEqual(cadence([0, 30_000, 60_000, 90_000], 90_000), { kind: 'swelling', periodMs: CADENCE_MAX_MS });
  // Between the ends the measurement is passed through untouched.
  assert.deepEqual(cadence([0, 2_000, 4_000, 6_000], 6_000), { kind: 'swelling', periodMs: 2_000 });
  assert.ok(CADENCE_MIN_MS < CADENCE_MAX_MS && CADENCE_MAX_MS < CADENCE_QUIET_MS);
});

test('completions that arrive unsorted or repeated give the same cadence as if they had not', () => {
  const ordered = [10_000, 11_500, 13_000, 14_400];
  const expected = cadence(ordered, 14_400);
  assert.deepEqual(expected, { kind: 'swelling', periodMs: 1_500 });
  assert.deepEqual(cadence([13_000, 10_000, 14_400, 11_500], 14_400), expected);
  assert.deepEqual(cadence([14_400, 13_000, 11_500, 10_000], 14_400), expected);
  assert.deepEqual(cadence([11_500, 10_000, 13_000, 11_500, 14_400, 10_000], 14_400), expected);
  // A stray unusable timestamp is dropped, not allowed to poison the median.
  assert.deepEqual(cadence([...ordered, Number.NaN, Number.POSITIVE_INFINITY], 14_400), expected);
});

test('sediment drops one grain per completed call, stops at the cap, and hands the whole count over past it', () => {
  assert.deepEqual(sediment(0), { grains: 0, overflow: null });
  assert.deepEqual(sediment(1), { grains: 1, overflow: null });
  assert.deepEqual(sediment(17), { grains: 17, overflow: null });
  // At the cap the floor is full but nothing has been hidden yet, so there is
  // still no count to show.
  assert.deepEqual(sediment(SEDIMENT_CAP), { grains: SEDIMENT_CAP, overflow: null });
  assert.deepEqual(sediment(SEDIMENT_CAP + 1), { grains: SEDIMENT_CAP, overflow: SEDIMENT_CAP + 1 });
  // Past it the overflow is the full count, not the excess: 247 is the number
  // an operator wants, not 223.
  assert.deepEqual(sediment(247), { grains: SEDIMENT_CAP, overflow: 247 });
  // The cap is the count of slots `relay.css` hand-places, and a grain with no
  // slot stacks in a corner, so the number is checked and not merely referred
  // to. If the sheet grows, this line and that sheet move together.
  assert.equal(SEDIMENT_CAP, 24);
  // Every grain index a caller can be handed addresses a slot that exists.
  assert.ok(sediment(1e6).grains - 1 <= 23);
});

test('a sediment count that arrives missing, fractional or negative yields an empty floor instead of throwing', () => {
  for (const hostile of [-1, -1_000, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(sediment(hostile), { grains: 0, overflow: null }, `sediment(${hostile})`);
  }
  // A count of events is a whole number; a fractional one loses its fraction
  // rather than becoming a fractional grain.
  assert.deepEqual(sediment(7.9), { grains: 7, overflow: null });
  assert.deepEqual(sediment(SEDIMENT_CAP + 0.5), { grains: SEDIMENT_CAP, overflow: null });
});

test('a node picks the same silt scatter every time it is asked, so a screenshot of the rail is reproducible', () => {
  const id = 'node_a1b2c3';
  const first = seedOf(id);
  assert.equal(seedOf(id), first);
  assert.equal(seedOf(id), first);
  assert.equal(seedOf(['node', 'a1b2c3'].join('_')), first, 'the id is the whole input; nothing else is sampled');
  assert.ok(Number.isInteger(first) && first >= 0 && first < SEDIMENT_SEEDS);
});

test('node ids spread across every scatter the stylesheet provides instead of collapsing onto one', () => {
  const ids = Array.from({ length: 96 }, (_, index) => `node_a1b2c${index.toString(36)}`);
  const seeds = ids.map(seedOf);
  for (const seed of seeds) assert.ok(Number.isInteger(seed) && seed >= 0 && seed < SEDIMENT_SEEDS);
  assert.equal(new Set(seeds).size, SEDIMENT_SEEDS, 'every scatter in the sheet gets used');
  // No scatter may take more than a quarter of a sequential sample. Ids within
  // one docket differ only in their last characters, and an unmixed hash walks
  // them through the scatters in lockstep — a pattern, which reads as
  // deliberate and is worse than a repeat.
  const counts = new Map<number, number>();
  for (const seed of seeds) counts.set(seed, (counts.get(seed) ?? 0) + 1);
  for (const [seed, count] of counts) {
    assert.ok(count <= seeds.length / 4, `scatter ${seed} took ${count} of ${seeds.length} sequential ids`);
  }
  // Neighbouring ids do not march: consecutive seeds are not a run.
  const marching = seeds.slice(1).every((seed, index) => seed === (seeds[index] + 1) % SEDIMENT_SEEDS);
  assert.equal(marching, false);
});

test('a hostile node id still picks a legal scatter and never throws', () => {
  const nul = String.fromCharCode(0);
  const hostile = [
    '', ' ', nul, nul + nul + nul, 'node_a1b2c3', 'NODE_A1B2C3', 'ノード',
    '\u{1f6f6}\u{1fab5}', '../../etc/passwd', 'x'.repeat(100_000), 'node_a1b2c3\n',
  ];
  for (const id of hostile) {
    const seed = seedOf(id);
    assert.ok(
      Number.isInteger(seed) && seed >= 0 && seed < SEDIMENT_SEEDS,
      `seedOf(${JSON.stringify(id.slice(0, 20))}) = ${seed}`,
    );
  }
  // Case is part of an id, not normalised away; both answers are simply legal.
  assert.ok(Number.isInteger(seedOf('node_a1b2c3')) && Number.isInteger(seedOf('NODE_A1B2C3')));
});

test('the two counted-out stages get a gauge, and they are the only two', () => {
  // Gate steps passed over gate steps total, and tasks priced over tasks in
  // the plan: both totals are known before their stage starts.
  assert.deepEqual(gauge('verify', 3, 5), { value: 3, max: 5 });
  assert.deepEqual(gauge('estimate', 2, 7), { value: 2, max: 7 });
});

test('the plan, implement and review basins get no gauge even when a caller offers them plausible numbers', () => {
  // The negative is the contract. Every one of these calls is what a future
  // caller who wanted a progress bar on the implement basin would write, and
  // each of them has to keep coming back null.
  for (const phase of ['plan', 'implement', 'review'] as const) {
    assert.equal(gauge(phase, 3, 5), null, `${phase} has no step count to fill against`);
    assert.equal(gauge(phase, 5, 5), null, `${phase} is not full just because something finished`);
    assert.equal(gauge(phase, 0, 12), null, `${phase} is not at the start of a countdown`);
    assert.equal(gauge(phase, 41, 118), null, `${phase} cannot borrow a tool-call count as a denominator`);
    assert.equal(gauge(phase, 0, 0), null);
  }
});

test('a gauge with no recorded total is absent rather than empty, because an empty bar still promises an end', () => {
  for (const phase of ['estimate', 'verify'] as const) {
    assert.equal(gauge(phase, 0, 0), null);
    assert.equal(gauge(phase, 3, 0), null);
    assert.equal(gauge(phase, 1, -4), null);
    assert.equal(gauge(phase, 1, Number.NaN), null);
    assert.equal(gauge(phase, 1, Number.POSITIVE_INFINITY), null);
  }
});

test('a gauge clamps into its own total, so a miscount cannot overfill a basin', () => {
  for (const phase of ['estimate', 'verify'] as const) {
    assert.deepEqual(gauge(phase, 9, 5), { value: 5, max: 5 });
    assert.deepEqual(gauge(phase, -2, 5), { value: 0, max: 5 });
    assert.deepEqual(gauge(phase, 0, 5), { value: 0, max: 5 });
    // An unreadable count empties the basin rather than filling it: clamping a
    // nonsense reading up to the total would draw a full gauge, and a full
    // verify gauge says the gate passed.
    assert.deepEqual(gauge(phase, Number.NaN, 5), { value: 0, max: 5 });
    assert.deepEqual(gauge(phase, Number.POSITIVE_INFINITY, 5), { value: 0, max: 5 });
    assert.deepEqual(gauge(phase, Number.NEGATIVE_INFINITY, 5), { value: 0, max: 5 });
  }
});

test('every function survives an empty, absurd or non-finite reading without throwing', () => {
  const clock = 1_700_000_000_000;
  const hostileClocks = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, clock];
  const hostileLists: number[][] = [
    [], [Number.NaN], [Number.NaN, Number.NaN, Number.NaN],
    [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN],
    [-1, -2, -3], [0, 0, 0, 0],
    [Number.MAX_SAFE_INTEGER, 0, Number.MIN_SAFE_INTEGER],
    [Number.MAX_VALUE, -Number.MAX_VALUE, 0, 1],
    [clock, clock - 1, clock - 2, clock - 3],
    Array.from({ length: 10_000 }, (_, index) => clock + index * 7),
  ];
  for (const list of hostileLists) {
    for (const now of hostileClocks) {
      const measured = cadence(list, now);
      if (measured.kind === 'swelling') {
        assert.ok(Number.isInteger(measured.periodMs), 'a period is whole milliseconds');
        assert.ok(measured.periodMs >= CADENCE_MIN_MS && measured.periodMs <= CADENCE_MAX_MS);
      } else {
        assert.ok(measured.reason === 'too-few-samples' || measured.reason === 'quiet');
      }
    }
  }
  // A timestamp from the future — a skewed clock, a machine that slept — is
  // not a quiet session, and must not become a negative period either.
  assert.deepEqual(cadence([clock, clock + 1_000, clock + 2_000], clock - 999_999), { kind: 'swelling', periodMs: 1_000 });
  for (const count of [0, 1, SEDIMENT_CAP, 1e9, -1e9, Number.NaN]) {
    const pile = sediment(count);
    assert.ok(Number.isInteger(pile.grains) && pile.grains >= 0 && pile.grains <= SEDIMENT_CAP);
    assert.ok(pile.overflow === null || pile.overflow > SEDIMENT_CAP);
  }
  for (const phase of ['plan', 'estimate', 'implement', 'verify', 'review'] as const) {
    for (const passed of [Number.NaN, -1e9, 1e9]) {
      for (const total of [Number.NaN, 0, -1, 1e9]) {
        const level = gauge(phase, passed, total);
        if (level) assert.ok(level.value >= 0 && level.value <= level.max && level.max > 0);
      }
    }
  }
});
