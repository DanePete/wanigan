/**
 * Attempts, the part that needs no process: what a set of attempts may be,
 * and what its recorded outcomes can honestly be said to show.
 * src/main/attempts.ts launches the runs, grades the trees and hands the rows
 * here.
 *
 * What a set is. One task, run several times in one repository, each run in
 * its own worktree cut from the same pinned commit. Two readings share it.
 * Best of N is several attempts at one task, compared by a person who keeps
 * one. A paired bench is k repeats per arm, where an arm is a provider, a model
 * and an effort, and the question is how often each arm solves the task.
 *
 * Why the numbers here are careful. Only Wanigan records what each of these
 * runs cost, and nobody ships an automatic judge worth trusting, so the set
 * stays small and the verdict stays human. What this module adds is the
 * arithmetic a person should not have to do in their head, labelled so it
 * cannot be mistaken for more than it is:
 *
 *  - pass@k and pass^k answer different questions. At a 70% per-trial success
 *    rate pass@3 is 97.3% and pass^3 is 34.3%. "Will one of three tries work"
 *    and "will all three" are both fair questions; printing one under the
 *    other's name is not. Every figure carries the form it was computed in.
 *  - Cost per solved task divides only what a CLI reported, and says how many
 *    trials reported. A trial that reported nothing is not a free trial.
 *  - A lead over a handful of trials is usually noise. The same sqrt(n) rule
 *    the batch evals use decides whether one is named.
 *  - There is no composite score. Pass rates, cost and evidence stay separate
 *    columns, because a single number that blends them hides the trade a
 *    person is actually making.
 */

import type { EvidenceLevel, OracleReading } from './types.ts';

export type AttemptSetKind = 'best-of-n' | 'bench';

/** One arm as a person asks for it. Null model or effort means the provider's default. */
export type AttemptArmInput = { providerId: string; model: string | null; effort: string | null };

/** An arm as the set froze it at start. */
export type AttemptArm = AttemptArmInput & {
  /** The provider's name when the set started, for reading after it is renamed or removed. */
  label: string;
  /** The profile every attempt in this arm must launch under. */
  profileFingerprint: string;
  /**
   * Whether this provider's headless protocol hands the budget to the CLI.
   * Claude Code's print mode takes --max-budget-usd; Codex's exec mode takes
   * no budget flag at all, so its attempts are bounded by the timeout alone.
   */
  budgetFlag: boolean;
};

/**
 * The bounds a set is held to. Small on purpose: every attempt is a real agent
 * spending real money unattended, and every one is a tree somebody reads.
 * Twelve is already more than a person compares well by hand.
 */
export const ATTEMPT_LIMITS = {
  arms: 4,
  repeats: 10,
  attempts: 12,
  /** The prompt is stored once on the set and again in every attempt's run. */
  promptChars: 64_000,
  minTimeoutMs: 60_000,
  maxTimeoutMs: 4 * 60 * 60_000,
} as const;

export type AttemptSlot = { armIndex: number; repeatIndex: number };

export type AttemptPlan = {
  kind: AttemptSetKind;
  prompt: string;
  arms: AttemptArmInput[];
  repeats: number;
  budgetUsd: number;
  timeoutMs: number;
  /** One per attempt, in launch order. */
  slots: AttemptSlot[];
  /** attempts × budget. What the budget flags can hold the set to, before any arm that takes none. */
  ceilingUsd: number;
};

export type Planned = { ok: true; plan: AttemptPlan } | { ok: false; reason: string };

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const dollars = (n: number) => `$${n.toFixed(2)}`;
// Written as escapes: a control character in an id or a model name has no
// business reaching argv, and a raw one in this file would be invisible.
const CONTROL = /[\u0000-\u001f\u007f]/;

function optionalText(value: unknown, max: number, what: string): { ok: true; value: string | null } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, reason: `${what} must be text.` };
  const text = value.trim();
  if (!text) return { ok: true, value: null };
  if (text.length > max || CONTROL.test(text)) return { ok: false, reason: `${what} is not a name a provider accepts (at most ${max} printable characters).` };
  return { ok: true, value: text };
}

/**
 * Validate a request and expand it into attempt slots, or say why not.
 *
 * Every field arrives as unknown because the same function answers the form,
 * which wants a live reason beside a disabled button, and the main process,
 * which must not trust anything the renderer sent.
 */
export function planAttempts(input: {
  kind: unknown; prompt: unknown; arms: unknown; repeats: unknown; budgetUsd: unknown; timeoutMs: unknown;
}): Planned {
  const refuse = (reason: string): Planned => ({ ok: false, reason });
  const kind = input.kind;
  if (kind !== 'best-of-n' && kind !== 'bench') return refuse('Choose Best of N or Paired bench.');

  if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
    return refuse('An attempt set needs a task. Nobody is at the keyboard to type one afterwards.');
  }
  const prompt = input.prompt.trim();
  if (prompt.length > ATTEMPT_LIMITS.promptChars) {
    return refuse(`The task is ${prompt.length.toLocaleString('en-US')} characters; an attempt set takes at most ${ATTEMPT_LIMITS.promptChars.toLocaleString('en-US')}.`);
  }

  if (!Array.isArray(input.arms) || input.arms.length < 1) return refuse('Add at least one arm: a provider, a model and an effort.');
  if (input.arms.length > ATTEMPT_LIMITS.arms) {
    return refuse(`A set compares at most ${ATTEMPT_LIMITS.arms} arms; this one has ${input.arms.length}.`);
  }
  const arms: AttemptArmInput[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of input.arms.entries()) {
    const arm = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const providerId = typeof arm.providerId === 'string' ? arm.providerId.trim() : '';
    if (!providerId || providerId.length > 120 || CONTROL.test(providerId) || /\s/.test(providerId)) {
      return refuse(`Arm ${index + 1} names no provider.`);
    }
    const model = optionalText(arm.model, 200, `Arm ${index + 1}'s model`);
    if (!model.ok) return refuse(model.reason);
    const effort = optionalText(arm.effort, 64, `Arm ${index + 1}'s effort`);
    if (!effort.ok) return refuse(effort.reason);
    // Two identical arms are one arm counted twice: its repeats would be split
    // across two rows that can only ever differ by noise, and the lead rule
    // would be asked to call that noise a result.
    const key = JSON.stringify([providerId, model.value, effort.value]);
    if (seen.has(key)) {
      return refuse(`Arm ${index + 1} is the same provider, model and effort as an earlier arm. Raise the repeats instead of repeating the arm.`);
    }
    seen.add(key);
    arms.push({ providerId, model: model.value, effort: effort.value });
  }

  const repeats = input.repeats;
  if (typeof repeats !== 'number' || !Number.isInteger(repeats) || repeats < 1 || repeats > ATTEMPT_LIMITS.repeats) {
    return refuse(`Repeats is a whole number from 1 to ${ATTEMPT_LIMITS.repeats}.`);
  }
  const attempts = arms.length * repeats;
  if (attempts > ATTEMPT_LIMITS.attempts) {
    return refuse(`${arms.length} ${arms.length === 1 ? 'arm' : 'arms'} × ${repeats} repeats is ${attempts} attempts; a set runs at most ${ATTEMPT_LIMITS.attempts}. Every one is an unattended agent and a tree someone has to read.`);
  }
  if (attempts < 2) {
    return refuse('One attempt has nothing to be compared with. Raise the repeats or add an arm, or start a single headless run instead.');
  }

  const budget = input.budgetUsd;
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) {
    // The ceiling is named even though there is no figure for it yet: the
    // person reading this is deciding how much a set may spend, and the one
    // fact they need is what the number they type will be multiplied by.
    return refuse(`These ${attempts} attempts run with nobody at the keyboard, so each needs a budget above $0. The set's ceiling is ${attempts} × that budget; without one it has no ceiling at all.`);
  }

  const timeout = input.timeoutMs;
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < ATTEMPT_LIMITS.minTimeoutMs || timeout > ATTEMPT_LIMITS.maxTimeoutMs) {
    return refuse('Each attempt needs a timeout from 1 minute to 4 hours. Without one, a stuck agent runs until the app quits.');
  }

  // Interleaved by repeat, not grouped by arm. The queue starts attempts in this
  // order, so a set that is cancelled, halted or held by a budget part way
  // through has given every arm the same number of tries, and no arm has all
  // of its trials in the hour a provider was having a bad day.
  const slots: AttemptSlot[] = [];
  for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex++) {
    for (let armIndex = 0; armIndex < arms.length; armIndex++) slots.push({ armIndex, repeatIndex });
  }
  return { ok: true, plan: { kind, prompt, arms, repeats, budgetUsd: budget, timeoutMs: timeout, slots, ceilingUsd: attempts * budget } };
}

/**
 * The set's ceiling in words, including the part a budget cannot hold.
 *
 * `attempts × budget` is only a ceiling for the attempts whose CLI takes a
 * budget flag. Saying the product for a set that includes Codex arms would
 * promise a limit Wanigan never passes to them, so those attempts are named as
 * bounded by the timeout instead.
 */
export function ceilingWords(input: {
  budgetUsd: number; timeoutMs: number; repeats: number; arms: readonly { label: string; budgetFlag: boolean }[];
}): string {
  const minutes = `${Math.max(1, Math.round(input.timeoutMs / 60_000))}-minute`;
  const flagged = input.arms.filter((arm) => arm.budgetFlag).length * input.repeats;
  const unflaggedArms = input.arms.filter((arm) => !arm.budgetFlag);
  const unflagged = unflaggedArms.length * input.repeats;
  const names = [...new Set(unflaggedArms.map((arm) => arm.label))].join(' and ');
  const total = flagged + unflagged;
  if (!unflagged) {
    return `Up to ${dollars(flagged * input.budgetUsd)} across ${plural(total, 'attempt')}, ${dollars(input.budgetUsd)} each. Each CLI stops at its own budget flag.`;
  }
  if (!flagged) {
    return `${names} ${unflaggedArms.length === 1 ? 'takes' : 'take'} no budget flag, so these ${plural(total, 'attempt')} have no cost ceiling: each is bounded only by its ${minutes} timeout.`;
  }
  return `Up to ${dollars(flagged * input.budgetUsd)} across the ${plural(flagged, 'attempt')} whose CLI takes a budget flag, ${dollars(input.budgetUsd)} each. ` +
    `${names} ${unflaggedArms.length === 1 ? 'takes' : 'take'} no budget flag, so ${unflagged === 1 ? 'its attempt is' : `its ${unflagged} attempts are`} bounded by the ${minutes} timeout, not by cost.`;
}

/** "Claude Code · opus · high": the arm as a person would name it. */
export function armLabel(arm: { label: string; model: string | null; effort: string | null }): string {
  return [arm.label, arm.model, arm.effort].filter(Boolean).join(' · ');
}

/* ── pass@k and pass^k ─────────────────────────────────────────────────── */

/**
 * The two forms a figure can be computed in.
 *
 * `estimator` is what a bench can actually report: n trials were run and c
 * passed, and the combinatorial form is the unbiased estimate of the chance
 * that k trials drawn from those n include at least one pass (pass@k) or are
 * all passes (pass^k). `population` assumes a known per-trial rate p, which a
 * bench never has; it is here for the worked example that explains why the
 * two figures differ, and for the tests that pin both.
 */
export type PassForm = 'estimator' | 'population';

export const PASS_FORM_WORDS: Record<PassForm, string> = {
  estimator: 'unbiased estimator over the trials run',
  population: 'population form at a known per-trial rate',
};

const wholeCount = (v: number) => Number.isInteger(v) && v >= 0;

/**
 * 1 − C(n−c, k) / C(n, k): the chance that k of the n trials, drawn without
 * replacement, include a pass. Computed as a running product rather than from
 * factorials so it cannot overflow. Null for any input it is not defined on,
 * including k > n: with fewer trials than k there is no k to draw.
 */
export function passAtK(n: number, c: number, k: number): number | null {
  if (!wholeCount(n) || !wholeCount(c) || !Number.isInteger(k) || k < 1 || c > n || k > n) return null;
  if (n - c < k) return 1;
  let none = 1;
  for (let i = n - c + 1; i <= n; i++) none *= 1 - k / i;
  return 1 - none;
}

/** C(c, k) / C(n, k): the chance that k of the n trials, drawn without replacement, are all passes. */
export function passHatK(n: number, c: number, k: number): number | null {
  if (!wholeCount(n) || !wholeCount(c) || !Number.isInteger(k) || k < 1 || c > n || k > n) return null;
  if (c < k) return 0;
  let all = 1;
  for (let i = 0; i < k; i++) all *= (c - i) / (n - i);
  return all;
}

/** 1 − (1 − p)^k, for a per-trial success rate p that is known rather than estimated. */
export function passAtKPopulation(p: number, k: number): number | null {
  if (!Number.isFinite(p) || p < 0 || p > 1 || !Number.isInteger(k) || k < 1) return null;
  return 1 - (1 - p) ** k;
}

/** p^k, for a per-trial success rate p that is known rather than estimated. */
export function passHatKPopulation(p: number, k: number): number | null {
  if (!Number.isFinite(p) || p < 0 || p > 1 || !Number.isInteger(k) || k < 1) return null;
  return p ** k;
}

export type PassFigure = {
  k: number;
  /** Null when the figure cannot be computed; `reason` says why. Never 0 standing in for unknown. */
  value: number | null;
  form: PassForm;
  reason: string | null;
};

function estimate(which: 'at' | 'hat', n: number, c: number, k: number): PassFigure {
  const value = which === 'at' ? passAtK(n, c, k) : passHatK(n, c, k);
  const name = which === 'at' ? `pass@${k}` : `pass^${k}`;
  return {
    k, value, form: 'estimator',
    reason: value !== null ? null
      : n === 0 ? `${name} needs finished trials, and this arm has none yet.`
        : `${name} needs at least ${plural(k, 'finished trial')}, and this arm has ${n}.`,
  };
}

/* ── cost per solved task ──────────────────────────────────────────────── */

export type CostPerSolved = {
  /** Null when nothing was reported or nothing passed; `reason` says which. */
  usd: number | null;
  /** The sum of reported cost over every trial, failed trials included. */
  reportedUsd: number;
  /** n in "n of K reported". */
  reported: number;
  /** K in "n of K reported". */
  trials: number;
  passes: number;
  /** Some trial reported no cost, so the figure is a floor rather than a total. */
  floor: boolean;
  reason: string | null;
};

/**
 * Reported spend over every trial, divided by the trials that passed.
 *
 * Failed trials stay in the numerator because they were paid for: the cost of
 * solving a task once is everything spent getting there. The figure is never
 * computed from nothing reported, where the only honest answer is that there
 * is no figure, and never divided by zero passes, where there is no solved task
 * to put it against.
 */
export function costPerSolved(trials: readonly { costUsd: number | null; costReported: boolean | null; passed: boolean }[]): CostPerSolved {
  const counted = trials.filter((t) => t.costReported === true && typeof t.costUsd === 'number' && Number.isFinite(t.costUsd) && t.costUsd >= 0);
  const reportedUsd = counted.reduce((sum, t) => sum + (t.costUsd as number), 0);
  const passes = trials.filter((t) => t.passed).length;
  const base = { reportedUsd, reported: counted.length, trials: trials.length, passes, floor: counted.length < trials.length };
  if (!trials.length) return { ...base, usd: null, floor: false, reason: 'No trial has finished, so there is nothing to divide.' };
  if (!counted.length) return { ...base, usd: null, reason: 'No trial reported a cost, so there is no figure. That is not the same as costing nothing.' };
  if (!passes) {
    return { ...base, usd: null, reason: `No trial passed the gate, so the ${dollars(reportedUsd)} reported has no solved task to be divided by.` };
  }
  return {
    ...base,
    usd: reportedUsd / passes,
    reason: base.floor
      ? `A floor: ${plural(trials.length - counted.length, 'trial')} reported no cost, and what ${trials.length - counted.length === 1 ? 'it' : 'they'} spent is unknown.`
      : null,
  };
}

/* ── outcomes ──────────────────────────────────────────────────────────── */

/**
 * What an attempt ended as.
 *
 * `failed-to-start` is an errored run whose agent never spawned: a CLI that was
 * missing, a worktree that could not be cut at the pinned commit. It is kept
 * apart from `errored` because it says nothing about the arm, and counting it
 * as a failed trial would charge an arm for the machine it ran on.
 * `unrecorded` is a run whose record was gone before its outcome was read.
 */
export type AttemptStatus =
  | 'queued' | 'succeeded' | 'errored' | 'timeout' | 'blocked' | 'canceled' | 'failed-to-start' | 'unrecorded';

/** 'running' while the gate is in flight; the other four are its answers. */
export type AttemptGate = 'running' | 'passed' | 'failed' | 'not-run' | 'unavailable';

/**
 * The statuses that count as a trial: the agent ran, on its own, to an end.
 * Blocked and canceled attempts were stopped by a rule or a person, and a
 * trial someone ended is not a measurement of the arm.
 */
const TRIALS: ReadonlySet<AttemptStatus> = new Set<AttemptStatus>(['succeeded', 'errored', 'timeout']);

export function isTrialStatus(status: AttemptStatus): boolean {
  return TRIALS.has(status);
}

/**
 * The attempt status a headless row's outcome maps to, or null while the row
 * is still open. `agentRan` is whether the row's own finish write happened,
 * which is the only record of a spawned agent that a failure before spawn
 * cannot also produce.
 */
export function attemptStatusOf(row: { status: string; agentRan: boolean }): AttemptStatus | null {
  switch (row.status) {
    case 'pending': case 'running': case 'awaiting': return null;
    case 'succeeded': return 'succeeded';
    case 'timeout': return 'timeout';
    case 'errored': return row.agentRan ? 'errored' : 'failed-to-start';
    case 'blocked': return 'blocked';
    case 'canceled': return 'canceled';
    // A status a later build added. Reading it as any of the above would be a
    // claim about the run this build cannot make.
    default: return 'unrecorded';
  }
}

/* ── the report ────────────────────────────────────────────────────────── */

/** What an attempt's run was actually stored with, read back from its run record. */
export type AttemptLaunch = {
  providerId: string;
  profileFingerprint: string;
  model: string | null;
  effort: string | null;
  promptSha256: string;
};

/** Everything the report reads about one attempt. */
export type AttemptForReport = {
  armIndex: number;
  status: AttemptStatus;
  gate: AttemptGate | null;
  baseHead: string | null;
  launch: AttemptLaunch | null;
  costUsd: number | null;
  costReported: boolean | null;
  filesChanged: number | null;
};

export type AttemptSetForReport = {
  baseCommit: string;
  promptSha256: string;
  arms: readonly AttemptArm[];
  repeats: number;
};

/**
 * Reuses the learning register's word for evidence that shows an association
 * and not a cause. 'controlled' is narrower than that register's 'causal': it
 * says every control was verified held on every trial, and leaves whether a
 * difference is real to the lead rule, which is about sample size.
 */
export type AttemptEvidence = 'controlled' | Extract<EvidenceLevel, 'correlation'>;

export type AttemptEvidenceReading = { label: AttemptEvidence; reasons: string[] };

const short = (commit: string) => commit.slice(0, 7);
const normal = (v: string | null | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : null);

const counted = (attempt: AttemptForReport) =>
  isTrialStatus(attempt.status) && attempt.gate !== null && attempt.gate !== 'running';

/**
 * 'controlled' only when every finished trial shares the pinned commit, the
 * prompt, its arm's frozen profile, model and effort, and was gated. Each
 * condition is read from what the attempt recorded, not from what the set
 * asked for, so the label is a finding rather than a restatement of the form.
 */
export function evidenceOf(set: AttemptSetForReport, attempts: readonly AttemptForReport[]): AttemptEvidenceReading {
  const trials = attempts.filter(counted);
  if (!trials.length) {
    return { label: 'correlation', reasons: ['No attempt has finished as a trial yet, so nothing has been compared.'] };
  }
  const reasons: string[] = [];
  const say = (n: number, text: (n: number) => string) => { if (n) reasons.push(text(n)); };
  say(trials.filter((t) => t.baseHead !== set.baseCommit).length,
    (n) => `${plural(n, 'trial')} did not record starting at the pinned commit ${short(set.baseCommit)}.`);
  const launched = trials.filter((t) => t.launch !== null);
  say(trials.length - launched.length, (n) => `${plural(n, 'trial')} ${n === 1 ? 'has' : 'have'} no record of what ${n === 1 ? 'it' : 'they'} launched with.`);
  say(launched.filter((t) => t.launch!.promptSha256 !== set.promptSha256).length,
    (n) => `${plural(n, 'trial')} ran a prompt that differs from the set's.`);
  say(launched.filter((t) => {
    const arm = set.arms[t.armIndex];
    return !arm || t.launch!.providerId !== arm.providerId || t.launch!.profileFingerprint !== arm.profileFingerprint;
  }).length, (n) => `${plural(n, 'trial')} launched under a different provider profile than ${n === 1 ? 'its' : 'their'} arm froze.`);
  say(launched.filter((t) => {
    const arm = set.arms[t.armIndex];
    return !arm || normal(t.launch!.model) !== normal(arm.model) || normal(t.launch!.effort) !== normal(arm.effort);
  }).length, (n) => `${plural(n, 'trial')} ran a model or effort that differs from ${n === 1 ? 'its' : 'their'} arm.`);
  say(trials.filter((t) => t.gate === 'not-run').length,
    (n) => `${plural(n, 'trial')} ${n === 1 ? 'was' : 'were'} not gated, so ${n === 1 ? 'its' : 'their'} outcome is the agent's exit, not a test result.`);
  say(trials.filter((t) => t.gate === 'unavailable').length,
    (n) => `The gate could not run for ${plural(n, 'trial')}.`);
  if (reasons.length) return { label: 'correlation', reasons };
  return {
    label: 'controlled',
    reasons: [`All ${plural(trials.length, 'trial')} started at ${short(set.baseCommit)} with the same prompt, under ${trials.length === 1 ? 'its' : 'their'} arm's frozen profile, model and effort, and the review gate ran on every one.`],
  };
}

export type AttemptLead = {
  /** The arm named as leading, or null when none is. */
  armIndex: number | null;
  sentence: string;
  reason: string;
};

/**
 * Whether one arm can be said to lead, by the rule the batch evals use.
 *
 * A difference in passes between two arms over the same n paired trials is
 * named only when it exceeds sqrt(n), the rough scale of the noise at that
 * sample size. A 3-of-3 against 2-of-3 split is one trial going the other way.
 * Arms with different trial counts are not ranked at all: their counts are
 * over different denominators, and turning them into rates to rank them would
 * be inventing precision a handful of trials does not have.
 */
export function leadOf(arms: readonly { armIndex: number; label: string; trials: number; passes: number }[]): AttemptLead {
  const ran = arms.filter((arm) => arm.trials > 0);
  if (ran.length === 0) return { armIndex: null, sentence: 'No lead to name yet.', reason: 'No arm has a finished trial.' };
  if (ran.length === 1) {
    return {
      armIndex: null, sentence: 'No lead to name.',
      reason: arms.length === 1 ? 'This set has one arm, so there is nothing to compare it with.' : 'Only one arm has finished trials so far.',
    };
  }
  const ranked = [...ran].sort((a, b) => b.passes - a.passes || a.armIndex - b.armIndex);
  const [top, next] = ranked;
  if (top.trials !== next.trials) {
    return {
      armIndex: null, sentence: 'No clear difference can be named.',
      reason: `${top.label} and ${next.label} finished different numbers of trials (${top.trials} and ${next.trials}), so their pass counts are not compared.`,
    };
  }
  const n = top.trials;
  const lead = top.passes - next.passes;
  const scale = Math.sqrt(n);
  const root = `√${n} ≈ ${scale.toFixed(1)}`;
  if (lead === 0) {
    return { armIndex: null, sentence: 'No clear difference.', reason: `${top.label} and ${next.label} both passed ${top.passes} of ${n}.` };
  }
  if (lead > scale) {
    return {
      armIndex: top.armIndex,
      sentence: `${top.label} leads: ${top.passes} of ${n} passed, against ${next.passes} of ${n} for ${next.label}.`,
      reason: `A lead of ${lead} over ${plural(n, 'paired trial')} is more than ${root}, the scale of the noise at this sample size.`,
    };
  }
  return {
    armIndex: null, sentence: 'No clear difference.',
    reason: `${top.label} leads ${next.label} by ${lead} over ${plural(n, 'trial')}, which is not more than ${root}. Read it as noise at this sample size.`,
  };
}

export type ArmReport = {
  armIndex: number;
  label: string;
  /** n: finished trials, gate answered. */
  trials: number;
  /** c: trials whose gate passed. */
  passes: number;
  passAt1: PassFigure;
  passAtK: PassFigure;
  passHatK: PassFigure;
  cost: CostPerSolved;
};

export type AttemptReport = {
  /** The k pass@k and pass^k are read at: the repeats each arm was given. */
  k: number;
  arms: ArmReport[];
  evidence: AttemptEvidenceReading;
  lead: AttemptLead;
  /** Attempts still queued, running or being gated. */
  open: number;
  /** Finished attempts that are not trials, by status. */
  notTrials: { status: AttemptStatus; count: number }[];
  /** Things a reader should know before trusting a pass. */
  warnings: string[];
};

export function attemptReport(set: AttemptSetForReport, attempts: readonly AttemptForReport[]): AttemptReport {
  const k = set.repeats;
  const arms: ArmReport[] = set.arms.map((arm, armIndex) => {
    const trials = attempts.filter((a) => a.armIndex === armIndex && counted(a));
    const passes = trials.filter((t) => t.gate === 'passed').length;
    return {
      armIndex,
      label: armLabel(arm),
      trials: trials.length,
      passes,
      passAt1: estimate('at', trials.length, passes, 1),
      passAtK: estimate('at', trials.length, passes, k),
      passHatK: estimate('hat', trials.length, passes, k),
      cost: costPerSolved(trials.map((t) => ({ costUsd: t.costUsd, costReported: t.costReported, passed: t.gate === 'passed' }))),
    };
  });

  const open = attempts.filter((a) => a.status === 'queued' || (isTrialStatus(a.status) && (a.gate === null || a.gate === 'running'))).length;
  const tally = new Map<AttemptStatus, number>();
  for (const a of attempts) {
    if (a.status !== 'queued' && !isTrialStatus(a.status)) tally.set(a.status, (tally.get(a.status) ?? 0) + 1);
  }

  const warnings: string[] = [];
  const idle = attempts.filter((a) => counted(a) && a.gate === 'passed' && a.filesChanged === 0).length;
  if (idle) {
    warnings.push(`${plural(idle, 'attempt')} passed the gate without changing a file. The gate passes at the pinned commit on its own, so it may not be testing this task.`);
  }

  return {
    k,
    arms,
    evidence: evidenceOf(set, attempts),
    lead: leadOf(arms),
    open,
    notTrials: [...tally.entries()].map(([status, count]) => ({ status, count })),
    warnings,
  };
}

/* ── what crosses to the renderer ──────────────────────────────────────── */

export type AttemptOracle = { reading: OracleReading | null; note: string | null };

export type AttemptTokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type AttemptRow = {
  id: string;
  setId: string;
  armIndex: number;
  repeatIndex: number;
  headlessRunId: string | null;
  status: AttemptStatus;
  /** The run's own row status while the attempt is queued: pending, running or awaiting. */
  liveStatus: string | null;
  worktree: string | null;
  /** Whether that worktree is still on disk when this was read. */
  worktreeOnDisk: boolean;
  baseHead: string | null;
  exitCode: number | null;
  durationMs: number | null;
  costUsd: number | null;
  costReported: boolean | null;
  /** Null when the run reported no token counts at all. */
  tokens: AttemptTokens | null;
  filesChanged: number | null;
  gate: AttemptGate | null;
  gateNote: string | null;
  reviewRunId: string | null;
  tree: string | null;
  /** Null until recorded; `reading` null with a `note` when it could not be read. */
  oracle: AttemptOracle | null;
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
  launch: AttemptLaunch | null;
};

export type AttemptSetStatus = 'running' | 'finished' | 'failed';

export type AttemptSetSummary = {
  id: string;
  projectId: string;
  /** Null when the project has since been removed from Wanigan. */
  projectName: string | null;
  kind: AttemptSetKind;
  /** The first line of the task, bounded, for a list. */
  title: string;
  baseCommit: string;
  arms: AttemptArm[];
  repeats: number;
  budgetUsd: number;
  timeoutMs: number;
  status: AttemptSetStatus;
  attempts: number;
  open: number;
  passes: number;
  keptAttemptId: string | null;
  decidedAt: number | null;
  createdAt: number;
};

export type AttemptCleanupPlan = {
  allowed: boolean;
  /** Why the cleanup cannot run now, in words, when it cannot. */
  reason: string | null;
  /** The worktrees it would try to remove, listed before anything is removed. */
  worktrees: { attemptId: string; path: string }[];
};

export type AttemptSetDetail = AttemptSetSummary & {
  prompt: string;
  promptSha256: string;
  holdForApproval: boolean;
  rows: AttemptRow[];
  report: AttemptReport;
  cleanup: AttemptCleanupPlan;
};

export type AttemptStartInput = {
  kind: AttemptSetKind;
  projectId: string;
  prompt: string;
  arms: AttemptArmInput[];
  repeats: number;
  budgetUsd: number;
  timeoutMs: number;
  holdForApproval?: boolean;
};

export type AttemptCleanupOutcome = 'removed' | 'kept' | 'gone' | 'refused';

export type AttemptCleanupResult = {
  setId: string;
  results: { attemptId: string; path: string; outcome: AttemptCleanupOutcome; detail: string }[];
};
