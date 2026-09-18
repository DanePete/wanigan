/**
 * The estimate phase's one promise: a number only where enough comparable
 * history exists, labelled with the rung it came from and the N it was drawn
 * from, and no total that leaves a phase out. The test that matters most is
 * the one proving two runs at the exact route do not become a median — that
 * is a single run wearing a currency symbol, which is what the phase refuses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_HISTORY, forecastPhase, forecastTotals, median, type ForecastSample } from './relay-forecast.ts';

const ROUTE = { providerId: 'claude', model: 'opus', effort: 'high' };

const run = (over: Partial<ForecastSample> = {}): ForecastSample => ({
  providerId: 'claude', model: 'opus', effort: 'high', durationMs: 60_000, costUsd: 1, ...over,
});

test('MIN_HISTORY is three, the smallest sample whose median is a middle', () => {
  assert.equal(MIN_HISTORY, 3);
});

test('median takes the lower middle of an even count and refuses an empty list', () => {
  assert.equal(median([]), null);
  assert.equal(median([7]), 7);
  assert.equal(median([10, 2]), 2);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 400]), 2);
  assert.equal(median([1, Number.NaN, 3, Number.POSITIVE_INFINITY]), 1);
});

test('fewer than MIN_HISTORY comparable runs at every rung is no number at all', () => {
  const two = [run({ durationMs: 10 }), run({ durationMs: 20 })];
  assert.deepEqual(forecastPhase(ROUTE, two), { n: 0, nPriced: 0, basis: 'none', medianMs: null, medianUsd: null });
  assert.deepEqual(forecastPhase(ROUTE, []), { n: 0, nPriced: 0, basis: 'none', medianMs: null, medianUsd: null });
});

test('enough runs at the exact route answer at the exact rung with both medians', () => {
  const history = [run({ durationMs: 30_000, costUsd: 3 }), run({ durationMs: 10_000, costUsd: 1 }), run({ durationMs: 20_000, costUsd: 2 })];
  assert.deepEqual(forecastPhase(ROUTE, history), { n: 3, nPriced: 3, basis: 'exact', medianMs: 20_000, medianUsd: 2 });
});

test('the ladder falls one rung at a time and says which rung it landed on', () => {
  // Two exact runs, one more at another effort: three at the model rung.
  const model = [run(), run(), run({ effort: 'low', durationMs: 5_000 })];
  assert.equal(forecastPhase(ROUTE, model).basis, 'model');
  assert.equal(forecastPhase(ROUTE, model).n, 3);
  // Two at the model, one on another model: three at the provider rung.
  const provider = [run(), run(), run({ model: 'sonnet' })];
  assert.equal(forecastPhase(ROUTE, provider).basis, 'provider');
  // Another provider's runs are never comparable.
  const other = [run({ providerId: 'codex' }), run({ providerId: 'codex' }), run({ providerId: 'codex' })];
  assert.equal(forecastPhase(ROUTE, other).basis, 'none');
});

test('a route naming no model skips the model rungs rather than matching every model', () => {
  const history = [run({ model: 'a' }), run({ model: 'b' }), run({ model: 'c' })];
  const answer = forecastPhase({ providerId: 'claude', model: null, effort: null }, history);
  assert.equal(answer.basis, 'provider');
  assert.equal(answer.n, 3);
  assert.equal(forecastPhase({ providerId: null, model: null, effort: null }, history).basis, 'none');
});

test('a null effort on the route matches only runs that recorded no effort at the exact rung', () => {
  const unnamed = { providerId: 'claude', model: 'opus', effort: null };
  const history = [run({ effort: null }), run({ effort: null }), run({ effort: null }), run({ effort: 'max', durationMs: 999_999 })];
  const answer = forecastPhase(unnamed, history);
  assert.equal(answer.basis, 'exact');
  assert.equal(answer.n, 3);
  assert.equal(answer.medianMs, 60_000);
});

test('the cost median comes from the same rung and needs its own MIN_HISTORY of priced runs', () => {
  const history = [run({ costUsd: 5 }), run({ costUsd: null }), run({ costUsd: null })];
  const answer = forecastPhase(ROUTE, history);
  assert.equal(answer.basis, 'exact');
  assert.equal(answer.n, 3);
  assert.equal(answer.nPriced, 1);
  assert.equal(answer.medianMs, 60_000);
  assert.equal(answer.medianUsd, null, 'one priced run is not a median cost');
});

test('a total exists only when every phase has a number, and n is the weakest N', () => {
  const priced = { n: 5, basis: 'exact' as const, medianMs: 1_000, medianUsd: 2 };
  const timedOnly = { n: 3, basis: 'model' as const, medianMs: 500, medianUsd: null };
  const none = { n: 0, basis: 'none' as const, medianMs: null, medianUsd: null };
  assert.deepEqual(forecastTotals([priced, priced]), { totalMs: 2_000, totalUsd: 4, n: 5, priced: 2, phases: 2 });
  assert.deepEqual(forecastTotals([priced, timedOnly]), { totalMs: 1_500, totalUsd: null, n: 3, priced: 2, phases: 2 });
  assert.deepEqual(forecastTotals([priced, none]), { totalMs: null, totalUsd: null, n: 5, priced: 1, phases: 2 });
  assert.deepEqual(forecastTotals([]), { totalMs: null, totalUsd: null, n: 0, priced: 0, phases: 0 });
});
