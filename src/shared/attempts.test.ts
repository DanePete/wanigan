/**
 * Attempts' pure half. The subject is "can it overstate". A set that slips past
 * its bounds spends unattended; a pass figure read in the wrong form, a cost
 * divided by nothing, or a lead named inside the noise each tell the operator
 * something the trials did not show.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attemptReport, attemptStatusOf, ceilingWords, costPerSolved, evidenceOf, leadOf,
  passAtK, passAtKPopulation, passHatK, passHatKPopulation, planAttempts,
  type AttemptArm, type AttemptForReport, type AttemptSetForReport,
} from './attempts.ts';

const near = (actual: number | null, expected: number, label?: string) => {
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${label ?? ''} expected ${expected}, got ${actual}`);
};

const good = {
  kind: 'bench', prompt: 'Fix the flaky retry test.', repeats: 3, budgetUsd: 2, timeoutMs: 15 * 60_000,
  arms: [{ providerId: 'claude', model: 'opus', effort: 'high' }, { providerId: 'codex', model: null, effort: null }],
};

const refusal = (over: Record<string, unknown>) => {
  const planned = planAttempts({ ...good, ...over } as Parameters<typeof planAttempts>[0]);
  assert.equal(planned.ok, false, `expected a refusal for ${JSON.stringify(over)}`);
  return planned.ok ? '' : planned.reason;
};

test('a valid request expands into interleaved slots with its ceiling', () => {
  const planned = planAttempts(good);
  assert.ok(planned.ok);
  assert.equal(planned.plan.slots.length, 6);
  assert.deepEqual(planned.plan.slots.slice(0, 4), [
    { armIndex: 0, repeatIndex: 0 }, { armIndex: 1, repeatIndex: 0 }, { armIndex: 0, repeatIndex: 1 }, { armIndex: 1, repeatIndex: 1 },
  ]);
  assert.equal(planned.plan.ceilingUsd, 12);
  assert.equal(planned.plan.arms[1].model, null, 'an empty model is the provider default, never an empty string');
});

test('the bounds on arms, repeats and attempts are refused with the numbers', () => {
  assert.match(refusal({ arms: [] }), /at least one arm/);
  assert.match(refusal({ arms: Array.from({ length: 5 }, (_, i) => ({ providerId: `p${i}` })) }), /at most 4 arms; this one has 5/);
  assert.match(refusal({ repeats: 0 }), /1 to 10/);
  assert.match(refusal({ repeats: 11 }), /1 to 10/);
  assert.match(refusal({ repeats: 2.5 }), /whole number/);
  assert.match(refusal({ repeats: 7 }), /14 attempts; a set runs at most 12/);
  assert.match(refusal({ arms: [good.arms[0]], repeats: 1 }), /One attempt has nothing to be compared with/);
});

test('a missing, zero or non-finite budget is refused and the refusal names the ceiling', () => {
  for (const budgetUsd of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '2']) {
    const reason = refusal({ budgetUsd });
    assert.match(reason, /6 attempts run with nobody at the keyboard/);
    assert.match(reason, /ceiling is 6 × that budget/);
  }
});

test('the other fields are refused by name', () => {
  assert.match(refusal({ kind: 'tournament' }), /Best of N or Paired bench/);
  assert.match(refusal({ prompt: '   ' }), /needs a task/);
  assert.match(refusal({ prompt: 'x'.repeat(64_001) }), /at most 64,000/);
  assert.match(refusal({ arms: [{ providerId: '' }, good.arms[1]] }), /Arm 1 names no provider/);
  assert.match(refusal({ arms: [good.arms[0], { providerId: 'codex', model: 'gpt\nrm -rf' }] }), /Arm 2's model is not a name/);
  assert.match(refusal({ arms: [good.arms[0], { ...good.arms[0], model: ' opus ' }] }), /same provider, model and effort as an earlier arm/);
  assert.match(refusal({ timeoutMs: 1_000 }), /1 minute to 4 hours/);
  assert.match(refusal({ timeoutMs: 5 * 60 * 60_000 }), /1 minute to 4 hours/);
});

test('the ceiling in words never promises a limit to an arm whose CLI takes no budget flag', () => {
  const claude = { label: 'Claude Code', budgetFlag: true };
  const codex = { label: 'Codex', budgetFlag: false };
  assert.equal(ceilingWords({ budgetUsd: 2, timeoutMs: 900_000, repeats: 3, arms: [claude] }),
    'Up to $6.00 across 3 attempts, $2.00 each. Each CLI stops at its own budget flag.');
  assert.equal(ceilingWords({ budgetUsd: 2, timeoutMs: 900_000, repeats: 3, arms: [codex] }),
    'Codex takes no budget flag, so these 3 attempts have no cost ceiling: each is bounded only by its 15-minute timeout.');
  assert.equal(ceilingWords({ budgetUsd: 2, timeoutMs: 900_000, repeats: 3, arms: [claude, codex] }),
    'Up to $6.00 across the 3 attempts whose CLI takes a budget flag, $2.00 each. Codex takes no budget flag, so its 3 attempts are bounded by the 15-minute timeout, not by cost.');
});

test('pass@k is the unbiased estimator: hand-computed vectors', () => {
  // 1 − C(3,3)/C(5,3) = 1 − 1/10
  near(passAtK(5, 2, 3), 0.9, 'n=5 c=2 k=3');
  // 1 − C(2,2)/C(5,2) = 1 − 1/10
  near(passAtK(5, 3, 2), 0.9, 'n=5 c=3 k=2');
  // 1 − C(3,3)/C(10,3) = 1 − 1/120
  near(passAtK(10, 7, 3), 119 / 120, 'n=10 c=7 k=3');
  // k = 1 is the plain pass rate.
  near(passAtK(4, 3, 1), 0.75, 'n=4 c=3 k=1');
});

test('pass^k is C(c,k)/C(n,k): hand-computed vectors', () => {
  near(passHatK(5, 2, 3), 0, 'fewer passes than k cannot all pass');
  near(passHatK(5, 3, 2), 3 / 10, 'C(3,2)/C(5,2)');
  near(passHatK(10, 7, 3), 35 / 120, 'C(7,3)/C(10,3)');
  near(passHatK(4, 3, 1), 0.75, 'k = 1 is the plain pass rate');
});

test('the estimators at the edges: k ≤ n, c = 0, c = n and k = n', () => {
  assert.equal(passAtK(2, 1, 3), null, 'k > n has no k trials to draw');
  assert.equal(passHatK(2, 1, 3), null);
  near(passAtK(5, 0, 3), 0, 'no passes');
  near(passHatK(5, 0, 3), 0);
  near(passAtK(5, 5, 3), 1, 'every trial passed');
  near(passHatK(5, 5, 3), 1);
  near(passAtK(3, 1, 3), 1, 'at k = n, pass@k is "any of them passed"');
  near(passHatK(3, 1, 3), 0, 'at k = n, pass^k is "all of them passed"');
  near(passAtK(3, 0, 3), 0);
  near(passHatK(3, 3, 3), 1);
  for (const bad of [[-1, 0, 1], [3, 4, 1], [3, 1, 0], [3, 1, 1.5], [3.5, 1, 1], [Number.NaN, 1, 1]]) {
    assert.equal(passAtK(bad[0], bad[1], bad[2]), null, `passAtK(${bad})`);
    assert.equal(passHatK(bad[0], bad[1], bad[2]), null, `passHatK(${bad})`);
  }
});

test('the population form at 70% and k = 3 is 97.3% and 34.3%, and differs from the estimator at the same rate', () => {
  near(passAtKPopulation(0.7, 3), 0.973);
  near(passHatKPopulation(0.7, 3), 0.343);
  // Seven of ten trials is the same 70%, and the estimator gives other numbers.
  // Which form a figure is in is part of the figure.
  assert.notEqual(Number(passAtK(10, 7, 3)!.toFixed(3)), 0.973);
  assert.notEqual(Number(passHatK(10, 7, 3)!.toFixed(3)), 0.343);
  assert.equal(passAtKPopulation(1.2, 3), null);
  assert.equal(passHatKPopulation(0.5, 0), null);
});

test('cost per solved task divides every reported cost, failures included, by the passes', () => {
  const cost = costPerSolved([
    { costUsd: 0.5, costReported: true, passed: true },
    { costUsd: 1.5, costReported: true, passed: false },
    { costUsd: 0, costReported: false, passed: true },
  ]);
  near(cost.usd, 1, '$2.00 reported over 2 passes');
  assert.equal(cost.reportedUsd, 2);
  assert.deepEqual([cost.reported, cost.trials, cost.passes, cost.floor], [2, 3, 2, true]);
  assert.match(cost.reason ?? '', /A floor: 1 trial reported no cost/);
});

test('cost per solved task is never computed from nothing reported, and never divided by zero passes', () => {
  const unreported = costPerSolved([
    { costUsd: 0, costReported: false, passed: true },
    { costUsd: 0, costReported: null, passed: true },
  ]);
  assert.equal(unreported.usd, null);
  assert.equal(unreported.reported, 0);
  assert.match(unreported.reason ?? '', /No trial reported a cost/);
  const unsolved = costPerSolved([{ costUsd: 3, costReported: true, passed: false }]);
  assert.equal(unsolved.usd, null);
  assert.match(unsolved.reason ?? '', /No trial passed the gate, so the \$3\.00 reported/);
  assert.equal(costPerSolved([]).usd, null);
  const nonsense = costPerSolved([{ costUsd: Number.NaN, costReported: true, passed: true }]);
  assert.equal(nonsense.usd, null, 'a reported cost that is not a number is not reported');
});

test('a headless row maps to an attempt status, and a failure before spawn is not a trial', () => {
  assert.equal(attemptStatusOf({ status: 'running', agentRan: false }), null);
  assert.equal(attemptStatusOf({ status: 'awaiting', agentRan: true }), null);
  assert.equal(attemptStatusOf({ status: 'errored', agentRan: true }), 'errored');
  assert.equal(attemptStatusOf({ status: 'errored', agentRan: false }), 'failed-to-start');
  assert.equal(attemptStatusOf({ status: 'canceled', agentRan: true }), 'canceled');
  assert.equal(attemptStatusOf({ status: 'throttled', agentRan: true }), 'unrecorded');
});

const COMMIT = 'a'.repeat(40);
const PROMPT = 'b'.repeat(64);
const arm = (providerId: string, model: string | null, over: Partial<AttemptArm> = {}): AttemptArm => ({
  providerId, model, effort: null, label: providerId === 'claude' ? 'Claude Code' : 'Codex',
  profileFingerprint: `fp-${providerId}`, budgetFlag: providerId === 'claude', ...over,
});
const SET: AttemptSetForReport = { baseCommit: COMMIT, promptSha256: PROMPT, repeats: 3, arms: [arm('claude', 'opus'), arm('codex', null)] };
const trial = (armIndex: number, gate: AttemptForReport['gate'], over: Partial<AttemptForReport> = {}): AttemptForReport => ({
  armIndex, status: 'succeeded', gate, baseHead: COMMIT,
  launch: { providerId: SET.arms[armIndex].providerId, profileFingerprint: SET.arms[armIndex].profileFingerprint, model: SET.arms[armIndex].model, effort: null, promptSha256: PROMPT },
  costUsd: 1, costReported: true, filesChanged: 2, ...over,
});

test('evidence is controlled only when every trial held every control and was gated', () => {
  const all = [trial(0, 'passed'), trial(0, 'failed'), trial(1, 'failed')];
  const controlled = evidenceOf(SET, all);
  assert.equal(controlled.label, 'controlled');
  assert.match(controlled.reasons[0], /All 3 trials started at aaaaaaa with the same prompt/);

  const broken = (over: Partial<AttemptForReport>) => evidenceOf(SET, [...all, trial(1, 'passed', over)]);
  assert.match(broken({ baseHead: 'c'.repeat(40) }).reasons.join(' '), /1 trial did not record starting at the pinned commit aaaaaaa/);
  assert.match(broken({ launch: null }).reasons.join(' '), /no record of what it launched with/);
  assert.match(broken({ launch: { ...trial(1, 'passed').launch!, promptSha256: 'd'.repeat(64) } }).reasons.join(' '), /prompt that differs/);
  assert.match(broken({ launch: { ...trial(1, 'passed').launch!, profileFingerprint: 'fp-other' } }).reasons.join(' '), /different provider profile/);
  assert.match(broken({ launch: { ...trial(1, 'passed').launch!, effort: 'high' } }).reasons.join(' '), /model or effort that differs/);
  assert.match(broken({ gate: 'not-run' }).reasons.join(' '), /1 trial was not gated/);
  assert.match(broken({ gate: 'unavailable' }).reasons.join(' '), /The gate could not run for 1 trial/);
  for (const over of [{ baseHead: null }, { gate: 'not-run' as const }, { gate: 'unavailable' as const }]) {
    assert.equal(broken(over).label, 'correlation');
  }
});

test('with no finished trial the evidence is not controlled by default', () => {
  const reading = evidenceOf(SET, [{ ...trial(0, null), status: 'queued' }, { ...trial(1, 'not-run'), status: 'canceled' }]);
  assert.equal(reading.label, 'correlation');
  assert.match(reading.reasons[0], /No attempt has finished as a trial yet/);
});

test('a lead is named only past sqrt(n) over equal trial counts', () => {
  const a = (passes: number, trials = 3) => ({ armIndex: 0, label: 'Claude Code · opus', trials, passes });
  const b = (passes: number, trials = 3) => ({ armIndex: 1, label: 'Codex', trials, passes });
  const decisive = leadOf([a(3), b(1)]);
  assert.equal(decisive.armIndex, 0);
  assert.match(decisive.reason, /A lead of 2 over 3 paired trials is more than √3 ≈ 1\.7/);
  const noise = leadOf([a(3), b(2)]);
  assert.equal(noise.armIndex, null);
  assert.match(noise.reason, /by 1 over 3 trials, which is not more than √3 ≈ 1\.7\. Read it as noise/);
  assert.match(leadOf([a(2), b(2)]).reason, /both passed 2 of 3/);
  assert.match(leadOf([a(3, 3), b(0, 2)]).reason, /different numbers of trials \(3 and 2\)/);
  assert.equal(leadOf([a(3, 3), b(0, 2)]).armIndex, null);
  assert.match(leadOf([a(3)]).reason, /one arm/);
  assert.match(leadOf([a(0, 0), b(0, 0)]).reason, /No arm has a finished trial/);
  // Ten trials: a lead of 3 is not past √10 ≈ 3.2, a lead of 4 is.
  assert.equal(leadOf([a(8, 10), b(5, 10)]).armIndex, null);
  assert.equal(leadOf([a(9, 10), b(5, 10)]).armIndex, 0);
});

test('a bench report reads per arm, labels each figure, and carries an arm with no passes as figures rather than blanks', () => {
  const attempts: AttemptForReport[] = [
    trial(0, 'passed', { costUsd: 0.4 }), trial(1, 'failed', { costUsd: null, costReported: false }),
    trial(0, 'passed', { costUsd: 0.6 }), trial(1, 'failed', { status: 'errored', costUsd: null, costReported: false }),
    trial(0, 'failed', { costUsd: 0.5 }), { ...trial(1, 'not-run'), status: 'canceled' },
  ];
  const report = attemptReport(SET, attempts);
  assert.equal(report.k, 3);
  const [claude, codex] = report.arms;
  assert.deepEqual([claude.trials, claude.passes], [3, 2]);
  near(claude.passAt1.value, 2 / 3);
  near(claude.passAtK.value, 1, 'two of three passed, so any-of-three is certain');
  near(claude.passHatK.value, 0, 'not all three passed');
  assert.deepEqual([claude.passAtK.form, claude.passHatK.form], ['estimator', 'estimator']);
  near(claude.cost.usd, 0.75, '$1.50 reported over 2 passes');
  assert.equal(`${claude.cost.reported} of ${claude.cost.trials} reported`, '3 of 3 reported');

  assert.deepEqual([codex.trials, codex.passes], [2, 0], 'the canceled attempt is not a trial');
  near(codex.passAt1.value, 0, 'no passes is a measured zero');
  assert.equal(codex.passAtK.value, null, 'pass@3 over two trials is not computable');
  assert.match(codex.passAtK.reason ?? '', /needs at least 3 finished trials, and this arm has 2/);
  assert.equal(codex.cost.usd, null);
  assert.match(codex.cost.reason ?? '', /No trial reported a cost/);

  assert.deepEqual(report.notTrials, [{ status: 'canceled', count: 1 }]);
  assert.equal(report.open, 0);
  assert.equal(report.lead.armIndex, null, 'unequal trial counts are not ranked');
  assert.equal(report.evidence.label, 'controlled', 'every counted trial held its controls and was gated');
  assert.doesNotMatch(JSON.stringify(report), /score|composite|rank/i, 'no composite score anywhere in the report');
});

test('open attempts and passes on unchanged trees are said out loud', () => {
  const report = attemptReport(SET, [
    { ...trial(0, null), status: 'queued' },
    trial(0, 'running'),
    trial(1, 'passed', { filesChanged: 0 }),
  ]);
  assert.equal(report.open, 2);
  assert.equal(report.arms[0].trials, 0, 'a trial whose gate is still running is not counted yet');
  assert.match(report.warnings.join(' '), /1 attempt passed the gate without changing a file/);
});
