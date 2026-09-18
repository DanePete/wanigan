import type { RelayPhase } from './relay.ts';
import type { RouteCandidate, StageSuggestion } from './relay-route.ts';

/**
 * The questions Wanigan asks a System One model about one relay stage, and the
 * arithmetic that turns its answers back into a `StageSuggestion`.
 *
 * Pure by construction: it builds a request body and reads a response body, and
 * never performs either. The transport, the credential, the egress row and the
 * halt check live in the module that owns them; this file is what can be tested
 * in `test:shared` in under a second, which matters here more than usual
 * because the ladder arithmetic below is the one place a bug launches a stage at
 * an effort nobody chose.
 *
 * Three things about this model shape the file, and all three are documented
 * weaknesses rather than guesses (docs.typesafe.ai/model-jaggedness/jev-1.13):
 *
 *  - It "does not count reliably" and "is not a calculator", so every number
 *    here is computed in TypeScript. Nothing is ever asked to compare, count or
 *    measure; it is asked what a situation resembles.
 *  - "Accuracy falls as the state grows with content unrelated to the
 *    decision", so the state is bounded and carries only the stage, the
 *    operator's own words and the candidate labels.
 *  - It "does not treat [state] as hostile by default". That is the boundary
 *    this file exists inside: repository content, diffs, file paths and agent
 *    output must never reach `state`, because a suggester an attacker can steer
 *    by committing a file is a suggester steering how the operator's tokens get
 *    spent. `stageRequest` takes an intent string and a candidate list and has
 *    no parameter through which anything else could arrive.
 */

/** Longest run of operator intent that reaches the model. */
const INTENT_MAX = 2000;
/** Longest model label. Labels come from provider manifests, which are untrusted. */
const LABEL_MAX = 80;

/**
 * What a suggester may be asked to do. Each one is switched on by itself.
 *
 * Two, because they are two different bargains and a person may want one
 * without the other. `route` spends a call to pick a model for a stage that was
 * going to run regardless; `pipeline` spends one to propose that a stage not
 * run at all. Bundling them behind a single "use the suggester" switch would
 * mean turning off a model preference to stop a docket being narrowed.
 *
 * Declared as data so a settings surface enumerates switches rather than
 * hardcoding two checkboxes, and so the same list can be what an extension
 * eventually says it provides.
 */
export type SuggesterCapability = 'route' | 'pipeline';

export const SUGGESTER_CAPABILITIES: readonly {
  id: SuggesterCapability; label: string; describe: string; withoutIt: string;
}[] = [
  {
    id: 'route',
    label: 'Suggest a model for each stage',
    describe: 'Asks which of the models this profile declares best fits the stage, and how much deliberation the work needs.',
    withoutIt: 'Every stage runs on the profile’s own default model and effort.',
  },
  {
    id: 'pipeline',
    label: 'Suggest which stages to run',
    describe: 'Asks whether work this well-specified still needs a planning or estimating stage before it is written.',
    withoutIt: 'Every stage the docket declares is run.',
  },
];

/**
 * No suggester at all, which is what a Wanigan with no TypeSafe credential has
 * and what every caller gets by leaving the option out.
 *
 * The default is off rather than on, and that is the whole posture: this is a
 * third-party service in early access that most installs will never have
 * configured, so the code path that exists for everyone is the one where none
 * of this is asked. Every builder below returns `null` here, `phasesFor`
 * returns the docket untouched, and the relay behaves exactly as it did before
 * any of this was written.
 */
export const NO_SUGGESTER: readonly SuggesterCapability[] = [];

const offers = (enabled: readonly SuggesterCapability[] | undefined, want: SuggesterCapability): boolean =>
  Array.isArray(enabled) && enabled.includes(want);

/**
 * How concentrated the deliberation answer must be before it names an effort.
 *
 * **This number is not calibrated.** The published guidance gives 0.5 as a
 * review floor and 0.9 for acting automatically on something consequential, and
 * says in both places that the threshold has to be evaluated on your own data.
 * 0.8 matches `DEFAULT_MIN_CONFIDENCE` so the two gates start level and their
 * difference is visible when one is moved. It is a parameter rather than a
 * constant precisely so the calibration probe can sweep it.
 */
export const DEFAULT_MIN_EFFORT_CONFIDENCE = 0.8;

/**
 * How concentrated a pipeline answer must be before it narrows a docket.
 *
 * Held at the same uncalibrated 0.8 as the other two gates, and separate from
 * them so calibration can move one without moving the rest. Its stakes sit
 * between the other two: a wrong pipeline runs the work with less preparation
 * than it deserved, which costs a worse implementation rather than a wrong
 * model, and `UNSKIPPABLE` means it can never cost a missing check.
 */
export const DEFAULT_MIN_PIPELINE_CONFIDENCE = 0.8;

/**
 * The deliberation ladder, low to high.
 *
 * Deliberately *model-independent*. The obvious design asks for effort directly,
 * but `score` takes one fixed ordered array per question while every candidate
 * declares its own ladder — four levels for one model, two for another, none at
 * all for a third — so no single effort question can cover them. Asking instead
 * how much deliberation the work needs is one coherent dimension that does not
 * depend on who answers it, and `effortFromScore` maps the result onto whichever
 * ladder the chosen model turns out to declare.
 *
 * Each level describes a concrete situation and stands on its own, because
 * levels are evaluated independently with no knowledge of their neighbours or
 * their position. "Medium effort" and "harder than the last one" are exactly
 * the phrasings that fail here.
 */
export const DELIBERATION_LEVELS: readonly string[] = [
  'A mechanical change whose shape is fully determined by the instruction.',
  'A change with one obvious approach and a few details left to the writer.',
  'A change requiring a choice among several defensible approaches.',
  'A change whose approach is not yet known and must be worked out first.',
];

/** What each relay stage is, in the one sentence the model gets to read. */
const PHASE_MEANING: Record<RelayPhase, string> = {
  plan: 'proposing an approach before any code is written',
  estimate: 'judging the size and risk of the proposed work',
  implement: 'writing the code',
  verify: 'running and checking that the work behaves as intended',
  review: 'reading the finished change for correctness and fit',
};

export type SystemOneQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: readonly string[] }
  | { type: 'noul'; instructions: string };

export type SystemOneRequest = {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, SystemOneQuestion>;
};

/** One line of text fit to cross a network boundary and be read back. */
function bounded(value: string, max: number): string {
  const flat = value.replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The three questions, in one request.
 *
 * They are independent on purpose. Questions in a single call are evaluated in
 * parallel and cannot see one another's answers, so a design needing two of
 * them to chain would need two round trips; none of these do. `needs_context`
 * is a `noul`, which returns a bare probability and *no* confidence, so it can
 * only ever colour the reason line — it can never gate a route.
 *
 * `descriptions` is how a profile says what a model is actually good at. Without
 * it the label is all the model sees, and a row described only by its name is a
 * row chosen on name recognition. It is optional because no profile declares
 * one yet; that is a gap in the profile schema, not a reason to invent prose
 * about somebody else's model here.
 */
export type StageRequestOptions = {
  /** Omitted or without `route`, nothing is asked and nothing is billed. */
  enabled?: readonly SuggesterCapability[];
  descriptions?: Readonly<Record<string, string>>;
};

export function stageRequest(
  phase: RelayPhase,
  intent: string,
  candidates: readonly RouteCandidate[],
  opts?: StageRequestOptions,
): SystemOneRequest | null {
  if (!offers(opts?.enabled, 'route')) return null;
  const criteria: Record<string, string | null> = {};
  for (const row of candidates) {
    const described = opts?.descriptions?.[row.model];
    criteria[row.model] = described ? bounded(described, LABEL_MAX * 2) : bounded(row.label, LABEL_MAX);
  }
  return {
    model: 'jev-latest',
    state: {
      stage: String(phase),
      stage_meaning: PHASE_MEANING[phase] ?? String(phase),
      operator_intent: bounded(intent, INTENT_MAX),
      // The candidates are NOT here. They are the answer space, and they live
      // in the choice's criteria where that is what they mean. Restating them
      // as state cost tokens twice, defeated prefix caching across turns, and
      // put content unrelated to every other question in front of the model —
      // which the jaggedness page names as a direct accuracy cost.
    },
    questions: {
      // Question ids are not sent to the model, so each one restates its whole
      // meaning. A question relying on being called `model` means nothing.
      model: {
        type: 'choice',
        instructions: 'Which of these models is the best fit for the described stage of work?',
        criteria,
      },
      deliberation: {
        type: 'score',
        instructions: 'How much deliberation does this stage of work require?',
        criteria: DELIBERATION_LEVELS,
      },
      needs_context: {
        type: 'noul',
        instructions: 'Does this stage require understanding code that the instruction does not itself contain?',
      },
    },
  };
}

/**
 * A deliberation score placed on one model's declared effort ladder.
 *
 * The score is a probability-weighted position across `DELIBERATION_LEVELS`,
 * so it is a float in `[0, levels - 1]` and routinely lands between levels.
 * Normalising it and rounding onto the ladder cannot leave the declared set,
 * which is the contract the router exists to keep — and it is rounding rather
 * than clamping, because there is nowhere outside the ladder to clamp from.
 *
 * A model declaring no levels, or one level, has nothing to place: null and the
 * single level respectively. A score that is not a finite number in range is a
 * suggester malfunctioning rather than a quiet 0, so it names no effort at all.
 */
export function effortFromScore(score: number, efforts: readonly string[] | null | undefined): string | null {
  if (!efforts || efforts.length === 0) return null;
  const top = DELIBERATION_LEVELS.length - 1;
  if (!Number.isFinite(score) || score < 0 || score > top) return null;
  if (efforts.length === 1) return efforts[0];
  const index = Math.round((score / top) * (efforts.length - 1));
  return efforts[Math.min(efforts.length - 1, Math.max(0, index))] ?? null;
}

/** The evidence a route proof keeps, beside the suggestion the router acted on. */
export type StageReading = {
  /** Null when the response named no model this profile declares. */
  suggestion: StageSuggestion | null;
  /**
   * The deliberation answer as given, kept whole even when its confidence was
   * too low to name an effort. A dropped judgment is evidence that the model
   * was asked and could not tell, which is a different fact from not asking.
   */
  deliberation: { score: number; confidence: number; distribution: Record<string, number> } | null;
  /** The bare probability from the `noul`. It has no confidence and gates nothing. */
  needsContext: number | null;
  usage: { inputTokens: number; outputTokens: number } | null;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const probability = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;

/** Every finite non-negative number on an object, and nothing else. */
function distribution(value: unknown): Record<string, number> {
  if (!isObject(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) out[key] = raw;
  }
  return out;
}

export type Deliberation = { score: number; confidence: number; distribution: Record<string, number> };

/**
 * The deliberation answer, or nothing.
 *
 * One reader for the production path and the try panel both, so what an
 * operator is shown when they test an intent cannot drift from what the router
 * would actually have acted on.
 */
function readDeliberation(answers: Record<string, unknown>, id = 'deliberation'): Deliberation | null {
  const raw = isObject(answers[id]) ? answers[id] as Record<string, unknown> : null;
  const confidence = raw ? probability(raw.confidence) : null;
  if (!raw || confidence === null) return null;
  if (typeof raw.score !== 'number' || !Number.isFinite(raw.score)) return null;
  return { score: raw.score, confidence, distribution: distribution(raw.probabilities) };
}

/**
 * A response body turned into a suggestion, treating every field as untrusted.
 *
 * It arrives over the network from a service in early access whose rate limits
 * are documented as "adjusting dynamically", so a missing field, a wrong type
 * and a whole malformed body are ordinary inputs rather than exceptional ones.
 * Nothing here throws: an unreadable answer yields a null suggestion, and the
 * router already returns the profile's default when handed one.
 *
 * The two confidences are gated separately, and this is where the design that
 * looked like it needed a second confidence on `StageSuggestion` resolves
 * instead. A model choice below the bar drops the suggestion, because there is
 * no suggestion without a model. A *deliberation* answer below the bar drops
 * only the effort, which the router already reads as "nobody named one" and
 * answers with the profile's own default. So the common case — a confident
 * model pick with a vague read on how hard the work is — keeps the useful half
 * without the router ever composing a value nobody proposed.
 */
export function readSuggestion(
  body: unknown,
  candidates: readonly RouteCandidate[],
  minEffortConfidence: number = DEFAULT_MIN_EFFORT_CONFIDENCE,
): StageReading {
  const empty: StageReading = { suggestion: null, deliberation: null, needsContext: null, usage: null };
  if (!isObject(body)) return empty;
  const answers = isObject(body.answers) ? body.answers : null;
  if (!answers) return empty;

  const usageRaw = isObject(body.usage) ? body.usage : null;
  const usage = usageRaw && typeof usageRaw.input_tokens === 'number' && typeof usageRaw.output_tokens === 'number'
    ? { inputTokens: usageRaw.input_tokens, outputTokens: usageRaw.output_tokens }
    : null;

  const noul = isObject(answers.needs_context) ? probability(answers.needs_context.noul) : null;

  const deliberation = readDeliberation(answers);

  const choiceRaw = isObject(answers.model) ? answers.model : null;
  const chosen = choiceRaw && typeof choiceRaw.choice === 'string' ? choiceRaw.choice : null;
  const choiceConfidence = choiceRaw ? probability(choiceRaw.confidence) : null;
  const row = chosen ? candidates.find((candidate) => candidate.model === chosen) ?? null : null;

  if (!row || choiceConfidence === null) {
    return { suggestion: null, deliberation, needsContext: noul, usage };
  }

  // The effort is named only when the deliberation answer was concentrated
  // enough to mean something. Written as a negated `>=` so an unusable
  // threshold fails closed, the same way the router's own gate is.
  const effort = deliberation && Number.isFinite(minEffortConfidence) && deliberation.confidence >= minEffortConfidence
    ? effortFromScore(deliberation.score, row.efforts)
    : null;

  return {
    suggestion: {
      model: row.model,
      effort,
      distribution: distribution(choiceRaw?.probabilities),
      confidence: choiceConfidence,
    },
    deliberation,
    needsContext: noul,
    usage,
  };
}

/* ── which stages run at all ──────────────────────────────────────────── */

/**
 * Stages a suggester may never propose skipping.
 *
 * `implement` is the work, and `verify` and `review` are the two things that
 * check it. Dropping a check is invisible, and it is how a relay ships a bug
 * while reporting green nodes.
 *
 * `estimate` is here for a different reason, learned from a real relay that
 * was narrowed to `direct` and went straight to building with no price on it.
 * Relay's promise is that the forecast prices the work and you decide before
 * anything is built; skipping the estimate takes the number out of that
 * decision. And it buys nothing — the estimate is Wanigan's own arithmetic
 * over recorded history, with no agent, no provider call and no spend. A stage
 * that costs nothing to run is never worth proposing away.
 *
 * So the legal move set is narrowing the front of the pipeline to the planning
 * phase and nothing else, which means no answer this model can give, however
 * confident and however wrong, can remove a gate or a price.
 */
export const UNSKIPPABLE: readonly RelayPhase[] = ['estimate', 'implement', 'verify', 'review'];

/** A coherent pipeline a suggester may propose, and the situation it is for. */
export type Pipeline = { id: string; phases: readonly RelayPhase[]; criterion: string };

/**
 * The pipelines on offer, longest first.
 *
 * A `choice` rather than one `noul` per stage, and that is the topology
 * talking rather than a preference. Stages have dependency edges — there is no
 * verifying what was never implemented — so the stages are not independent
 * labels, and independent `noul`s would happily return a pipeline that
 * verifies nothing and reviews it. A choice over whole pipelines can only
 * return one that holds together.
 *
 * Each criterion describes a concrete situation and never names the pipeline's
 * length or compares it to its neighbours, for the same reason the deliberation
 * levels do not: options are read on their own.
 */
export const PIPELINES: readonly Pipeline[] = [
  {
    id: 'full',
    phases: ['plan', 'estimate', 'implement', 'verify', 'review'],
    criterion: 'The instruction describes an outcome, and both the approach and the amount of work involved still have to be worked out before any code is written.',
  },
  {
    id: 'direct',
    phases: ['estimate', 'implement', 'verify', 'review'],
    criterion: 'The instruction already says what to change, and writing it can begin immediately.',
  },
];

/** The pipelines that fit inside what this docket actually asked for. */
function applicable(requested: readonly RelayPhase[]): readonly Pipeline[] {
  const asked = new Set<RelayPhase>(requested);
  return PIPELINES.filter((pipeline) => pipeline.phases.every((phase) => asked.has(phase)));
}

/**
 * The relay-scoped question: which stages are worth running for this work.
 *
 * Asked once when a docket is created, and separately from the per-stage
 * routing calls, because its answer decides which stages there are to route.
 * That is the documented justification for a second request — an earlier answer
 * determining the next options — and it is the only place this design spends
 * one.
 *
 * Returns null when there is nothing to ask. A profile whose docket declares
 * only `implement` admits exactly one pipeline, and a choice with one option is
 * not a question; asking it anyway would bill for a foregone conclusion and
 * return a confidence of 1 that meant nothing.
 */
export function relayRequest(
  intent: string,
  requested: readonly RelayPhase[],
  enabled?: readonly SuggesterCapability[],
): SystemOneRequest | null {
  if (!offers(enabled, 'pipeline')) return null;
  const options = applicable(requested);
  if (options.length < 2) return null;
  const criteria: Record<string, string | null> = {};
  for (const pipeline of options) criteria[pipeline.id] = pipeline.criterion;
  return {
    model: 'jev-latest',
    state: {
      // The operator's own words and nothing else. There is no repository here
      // for the same reason there is none in `stageRequest`.
      operator_intent: bounded(intent, INTENT_MAX),
    },
    questions: {
      pipeline: {
        type: 'choice',
        instructions: 'Which of these describes the work this instruction asks for?',
        criteria,
      },
    },
  };
}

/** A proposed pipeline, or nothing — and it is always a subset of what was asked for. */
export type PipelineReading = {
  phases: readonly RelayPhase[];
  pipeline: string;
  confidence: number;
  distribution: Record<string, number>;
} | null;

/**
 * A pipeline answer read back, narrowing only.
 *
 * Applicability is recomputed from `requested` rather than trusted from the
 * response, so a body naming a pipeline this docket never offered is discarded
 * rather than honoured. The result is then intersected with `requested` a
 * second time, which is belt and braces on purpose: this is the one function
 * whose bug removes a stage that was going to check the work.
 */
export function readPipeline(
  body: unknown,
  requested: readonly RelayPhase[],
  minConfidence: number = DEFAULT_MIN_PIPELINE_CONFIDENCE,
): PipelineReading {
  if (!isObject(body)) return null;
  const answers = isObject(body.answers) ? body.answers : null;
  const raw = answers && isObject(answers.pipeline) ? answers.pipeline : null;
  if (!raw) return null;

  const confidence = probability(raw.confidence);
  const chosen = typeof raw.choice === 'string' ? raw.choice : null;
  if (confidence === null || chosen === null) return null;
  // Negated `>=` so an unusable threshold fails closed, as every other gate here is.
  if (!(Number.isFinite(minConfidence) && confidence >= minConfidence)) return null;

  const pipeline = applicable(requested).find((option) => option.id === chosen);
  if (!pipeline) return null;

  const asked = new Set<RelayPhase>(requested);
  const phases = pipeline.phases.filter((phase) => asked.has(phase));
  return { phases, pipeline: pipeline.id, confidence, distribution: distribution(raw.probabilities) };
}

/**
 * The stages a docket actually runs.
 *
 * Total, and the identity case is the one that matters: no suggester, a
 * declined answer, an unconvinced one, a 429, a malformed body and a Wanigan
 * that has never heard of TypeSafe all arrive here as `null`, and all of them
 * run exactly the stages the docket declared. Narrowing is the exception that
 * has to earn its way in, which is why this function exists rather than a
 * `reading?.phases ?? requested` written at each call site — there is one
 * place to read, and one place a bug could be.
 */
export function phasesFor(
  requested: readonly RelayPhase[],
  reading: PipelineReading,
): readonly RelayPhase[] {
  return reading ? reading.phases : requested;
}

/* ── one call for a whole relay ───────────────────────────────────────── */

/** One stage's answer space: which models it may run on, and how they are described. */
export type StageAsk = {
  phase: RelayPhase;
  candidates: readonly RouteCandidate[];
  descriptions?: Readonly<Record<string, string>>;
};

const stageQuestionIds = (phase: RelayPhase) => ({
  model: `model_${phase}`,
  deliberation: `deliberation_${phase}`,
  needsContext: `needs_context_${phase}`,
});

/**
 * Every question a whole relay needs, in one request.
 *
 * A relay used to cost one call for the pipeline plus one per stage — four
 * round trips for three stages, each re-sending the same intent. Questions in
 * a call are evaluated in parallel and independently, so batching is measured
 * at 12.2x cheaper and 10x faster with no change in the answers
 * (docs.typesafe.ai/cookbooks/parallel_questions).
 *
 * The per-stage questions are *speculative*: they are asked for every stage
 * before the pipeline answer says which stages survive, and code consumes only
 * the ones it kept. That is the documented fan-out pattern, and it is free in
 * latency — a question about a stage that gets narrowed away rides along on a
 * call that was already being made.
 *
 * Because one state serves every question, no question may lean on it to say
 * which stage it means. Each one names its own stage in its instructions, which
 * it had to do anyway: question ids are not sent to the model.
 */
export function relayPlanRequest(
  intent: string,
  requested: readonly RelayPhase[],
  stages: readonly StageAsk[],
  enabled: readonly SuggesterCapability[] | undefined,
): SystemOneRequest | null {
  const text = bounded(intent, INTENT_MAX);
  if (!text) return null;
  const questions: Record<string, SystemOneQuestion> = {};

  if (offers(enabled, 'pipeline')) {
    const options = applicable(requested);
    if (options.length >= 2) {
      const criteria: Record<string, string | null> = {};
      for (const pipeline of options) criteria[pipeline.id] = pipeline.criterion;
      questions.pipeline = {
        type: 'choice',
        instructions: 'Which of these describes the work this instruction asks for?',
        criteria,
      };
    }
  }

  if (offers(enabled, 'route')) {
    for (const stage of stages) {
      const meaning = PHASE_MEANING[stage.phase] ?? String(stage.phase);
      const ids = stageQuestionIds(stage.phase);
      if (stage.candidates.length > 0) {
        const criteria: Record<string, string | null> = {};
        for (const row of stage.candidates) {
          const described = stage.descriptions?.[row.model];
          criteria[row.model] = described ? bounded(described, LABEL_MAX * 2) : bounded(row.label, LABEL_MAX);
        }
        questions[ids.model] = {
          type: 'choice',
          instructions: `Which of these models is the best fit for the ${stage.phase} stage of this work — ${meaning}?`,
          criteria,
        };
      }
      questions[ids.deliberation] = {
        type: 'score',
        instructions: `How much deliberation does the ${stage.phase} stage of this work — ${meaning} — require?`,
        criteria: DELIBERATION_LEVELS,
      };
      questions[ids.needsContext] = {
        type: 'noul',
        instructions: `Does the ${stage.phase} stage of this work require understanding code that the instruction does not itself contain?`,
      };
    }
  }

  if (Object.keys(questions).length === 0) return null;
  // The operator's own words, and nothing else. No repository content, no
  // candidate list: the candidates are the answer space, not context.
  return { model: 'jev-latest', state: { operator_intent: text }, questions };
}

export type RelayPlanReading = {
  pipeline: PipelineReading;
  stages: Partial<Record<RelayPhase, StageReading>>;
  usage: { inputTokens: number; outputTokens: number } | null;
};

/** The empty reading: what a refusal, a failure and a body nobody could parse all return. */
export const NO_RELAY_PLAN: RelayPlanReading = { pipeline: null, stages: {}, usage: null };

/**
 * One batched answer read back into per-stage suggestions.
 *
 * The same gating as the single-stage reader, applied per stage: a model choice
 * below the bar drops that stage's suggestion, and a deliberation answer below
 * the bar drops only the effort — which the router reads as "nobody named one"
 * and answers with the profile's default.
 */
export function readRelayPlan(
  body: unknown,
  requested: readonly RelayPhase[],
  stages: readonly StageAsk[],
  minEffortConfidence: number = DEFAULT_MIN_EFFORT_CONFIDENCE,
): RelayPlanReading {
  if (!isObject(body)) return NO_RELAY_PLAN;
  const answers = isObject(body.answers) ? body.answers : null;
  if (!answers) return NO_RELAY_PLAN;

  const usageRaw = isObject(body.usage) ? body.usage : null;
  const usage = usageRaw && typeof usageRaw.input_tokens === 'number' && typeof usageRaw.output_tokens === 'number'
    ? { inputTokens: usageRaw.input_tokens, outputTokens: usageRaw.output_tokens }
    : null;

  const out: Partial<Record<RelayPhase, StageReading>> = {};
  for (const stage of stages) {
    const ids = stageQuestionIds(stage.phase);
    const deliberation = readDeliberation(answers, ids.deliberation);
    const noul = isObject(answers[ids.needsContext])
      ? probability((answers[ids.needsContext] as Record<string, unknown>).noul) : null;

    const choiceRaw = isObject(answers[ids.model]) ? answers[ids.model] as Record<string, unknown> : null;
    const chosen = choiceRaw && typeof choiceRaw.choice === 'string' ? choiceRaw.choice : null;
    const choiceConfidence = choiceRaw ? probability(choiceRaw.confidence) : null;
    const row = chosen ? stage.candidates.find((candidate) => candidate.model === chosen) ?? null : null;

    if (!row || choiceConfidence === null) {
      out[stage.phase] = { suggestion: null, deliberation, needsContext: noul, usage: null };
      continue;
    }
    const effort = deliberation && Number.isFinite(minEffortConfidence) && deliberation.confidence >= minEffortConfidence
      ? effortFromScore(deliberation.score, row.efforts)
      : null;
    out[stage.phase] = {
      suggestion: { model: row.model, effort, distribution: distribution(choiceRaw?.probabilities), confidence: choiceConfidence },
      deliberation,
      needsContext: noul,
      // Usage belongs to the call, not to any one stage of it.
      usage: null,
    };
  }

  return { pipeline: readPipeline(body, requested, DEFAULT_MIN_PIPELINE_CONFIDENCE), stages: out, usage };
}
