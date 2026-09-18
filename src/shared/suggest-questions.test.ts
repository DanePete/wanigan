/**
 * The suggester contract, in two halves.
 *
 * What leaves this machine: a request carrying the stage, the operator's own
 * words and the candidate labels, and demonstrably nothing else — the model is
 * documented as not treating its state as hostile, so what may enter the state
 * is a security boundary rather than a tidiness preference.
 *
 * What comes back: arithmetic that cannot leave a profile's declared effort
 * ladder, and a reader that treats every field of an early-access API's
 * response as untrusted. The test that matters most is the property one — over
 * every score the model can return, on every ladder shape a profile can
 * declare, the answer is always a level that profile actually named.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EFFORT_LEVELS } from './types.ts';
import type { RelayPhase } from './relay.ts';
import type { RouteCandidate } from './relay-route.ts';
import {
  DELIBERATION_LEVELS, DEFAULT_MIN_EFFORT_CONFIDENCE, DEFAULT_MIN_PIPELINE_CONFIDENCE,
  PIPELINES, UNSKIPPABLE,
  NO_SUGGESTER, SUGGESTER_CAPABILITIES,
  NO_RELAY_PLAN,
  effortFromScore, phasesFor, readPipeline, readRelayPlan, readSuggestion,
  relayPlanRequest, relayRequest, stageRequest,
  type StageAsk,
} from './suggest-questions.ts';

/** The same three shapes the router's own fixture uses. */
const CANDIDATES: readonly RouteCandidate[] = [
  { model: 'gpt-5.1-codex', label: 'Codex 5.1', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { model: 'opus', label: 'Opus', efforts: null },
  { model: 'sonnet', label: 'Sonnet', efforts: ['low', 'high'] },
];

const TOP = DELIBERATION_LEVELS.length - 1;

/** Each capability is off unless a caller switches it on, so every test says which it wants. */
const ROUTE = { enabled: ['route'] } as const;
const PIPELINE = ['pipeline'] as const;

/** A well-formed response body, overridable a field at a time. */
const body = (over: Record<string, unknown> = {}) => ({
  model: 'jev-latest',
  answers: {
    model: { type: 'choice', choice: 'sonnet', probabilities: { sonnet: 0.9, opus: 0.1 }, confidence: 0.91 },
    deliberation: { type: 'score', score: 3, probabilities: { '3': 0.95, '2': 0.05 }, confidence: 0.93 },
    needs_context: { type: 'noul', noul: 0.77 },
    ...over,
  },
  usage: { input_tokens: 312, output_tokens: 0 },
});

test('the request asks three independent questions and restates each one’s whole meaning', () => {
  const request = stageRequest('implement', 'add a retry to the uploader', CANDIDATES, ROUTE);
  assert.ok(request);
  assert.equal(request.model, 'jev-latest');
  assert.deepEqual(Object.keys(request.questions).sort(), ['deliberation', 'model', 'needs_context']);
  assert.equal(request.questions.model.type, 'choice');
  assert.equal(request.questions.deliberation.type, 'score');
  assert.equal(request.questions.needs_context.type, 'noul');

  // Ids are not sent to the model, so no question may depend on its own name.
  for (const [id, question] of Object.entries(request.questions)) {
    assert.ok(question.instructions.length > 25, `${id} leans on its id for meaning`);
    assert.ok(question.instructions.trim().endsWith('?'), `${id} is not phrased as a question`);
  }

  // Every candidate is offered, keyed by the id the router will match back.
  const choice = request.questions.model;
  assert.equal(choice.type, 'choice');
  if (choice.type === 'choice') {
    assert.deepEqual(Object.keys(choice.criteria).sort(), ['gpt-5.1-codex', 'opus', 'sonnet']);
  }
});

test('score levels describe concrete situations rather than degrees, because each is read alone', () => {
  assert.ok(DELIBERATION_LEVELS.length >= 2 && DELIBERATION_LEVELS.length <= 10, 'outside the 2–10 the API accepts');
  for (const level of DELIBERATION_LEVELS) {
    assert.ok(level.length > 30, `not a described situation: ${level}`);
    assert.ok(level.trim().endsWith('.'), `not a sentence: ${level}`);
    // The phrasings the documentation names as failure modes: naming the
    // position, or describing a level relative to its neighbours.
    assert.doesNotMatch(level, /\b(low|medium|high|moderate|level \d|worse|better|more than|less than)\b/i, level);
  }
});

test('the state is the stage and the operator’s words; candidates live only in the criteria', () => {
  const request = stageRequest('review', 'tidy the parser', CANDIDATES, ROUTE);
  assert.ok(request);
  assert.deepEqual(Object.keys(request.state).sort(), ['operator_intent', 'stage', 'stage_meaning']);

  // The candidates are the answer space, not context. Restating them as state
  // paid for the tokens twice, defeated prefix caching across turns, and put
  // content unrelated to every other question in front of the model.
  const serialized = JSON.stringify(request.state);
  for (const row of CANDIDATES) {
    assert.ok(!serialized.includes(row.model), `state repeated the candidate ${row.model}`);
  }
  const choice = request.questions.model;
  if (choice.type === 'choice') {
    assert.deepEqual(Object.keys(choice.criteria).sort(), CANDIDATES.map((row) => row.model).sort());
  }

  // There is no parameter through which a diff, a path or agent output could
  // arrive, so the whole serialized state is searchable for what must not be in it.
  for (const leak of ['/Users/', 'diff --git', '.ts:', 'node_modules']) {
    assert.ok(!serialized.includes(leak), `state carried ${leak}`);
  }
});

test('operator intent and manifest labels are bounded and flattened before they cross the wire', () => {
  const nul = String.fromCharCode(0);
  const request = stageRequest('plan', `${'x'.repeat(9000)}\n${nul}drop`, [
    { model: 'm', label: `Ex\nploit${'!'.repeat(400)}`, efforts: ['low'] },
  ], ROUTE);
  assert.ok(request);
  const intent = request.state.operator_intent as string;
  assert.ok(intent.length <= 2000, `intent ran to ${intent.length}`);
  assert.ok(!/[\n\r]/.test(intent) && !/\p{C}/u.test(intent), 'intent kept control characters');

  // A manifest label is bounded where it is actually sent: the criteria.
  const choice = request.questions.model;
  assert.equal(choice.type, 'choice');
  if (choice.type === 'choice') {
    const label = String(Object.values(choice.criteria)[0]);
    assert.ok(label.length <= 80 && !/\p{C}/u.test(label), 'a manifest label was not bounded');
  }
});

test('a deliberation score lands on the ladder the chosen model actually declares', () => {
  const codex = CANDIDATES[0].efforts;
  assert.equal(effortFromScore(0, codex), 'low');
  assert.equal(effortFromScore(1, codex), 'medium');
  assert.equal(effortFromScore(2, codex), 'high');
  assert.equal(effortFromScore(TOP, codex), 'xhigh');

  // A two-level ladder is not a four-level one with gaps: the same score lands
  // in a different place, which is the whole reason this is done in code.
  const sonnet = CANDIDATES[2].efforts;
  assert.equal(effortFromScore(0, sonnet), 'low');
  assert.equal(effortFromScore(1, sonnet), 'low');
  assert.equal(effortFromScore(TOP, sonnet), 'high');

  // A model declaring no levels has nothing to place, and one level has no choice.
  assert.equal(effortFromScore(2, null), null);
  assert.equal(effortFromScore(2, []), null);
  assert.equal(effortFromScore(2, ['max']), 'max');
});

test('no score on any ladder ever yields a level that profile did not declare', () => {
  // Every prefix of the real effort vocabulary, which is every ladder shape a
  // profile can declare, against the whole range the API can return.
  for (let width = 1; width <= EFFORT_LEVELS.length; width += 1) {
    const ladder = EFFORT_LEVELS.slice(0, width);
    for (let step = 0; step <= 300; step += 1) {
      const score = (step / 300) * TOP;
      const effort = effortFromScore(score, ladder);
      assert.ok(effort !== null, `score ${score} named nothing on a ladder of ${width}`);
      assert.ok(ladder.includes(effort as typeof ladder[number]), `score ${score} produced “${effort}”, outside ${ladder.join(', ')}`);
    }
  }
});

test('a score that is not a position on the ladder names no effort rather than a quiet zero', () => {
  const codex = CANDIDATES[0].efforts;
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -0.001, TOP + 0.001, 99]) {
    assert.equal(effortFromScore(bad, codex), null, `score ${bad} must not name a level`);
  }
});

test('a well-formed answer becomes a suggestion the router can act on, with its evidence beside it', () => {
  const reading = readSuggestion(body(), CANDIDATES);
  assert.deepEqual(reading.suggestion, {
    model: 'sonnet',
    effort: 'high',
    distribution: { sonnet: 0.9, opus: 0.1 },
    confidence: 0.91,
  });
  assert.deepEqual(reading.deliberation, { score: 3, confidence: 0.93, distribution: { '3': 0.95, '2': 0.05 } });
  assert.equal(reading.needsContext, 0.77);
  assert.deepEqual(reading.usage, { inputTokens: 312, outputTokens: 0 });
});

test('a vague read on how hard the work is drops the effort and keeps the model', () => {
  const shy = body({ deliberation: { type: 'score', score: 3, probabilities: {}, confidence: 0.4 } });
  const reading = readSuggestion(shy, CANDIDATES);

  // The half that was confident survives; the half that was not names nothing,
  // which the router already reads as "nobody named one".
  assert.equal(reading.suggestion?.model, 'sonnet');
  assert.equal(reading.suggestion?.effort, null);
  assert.equal(reading.suggestion?.confidence, 0.91);

  // And the judgment that was dropped is still evidence that it was asked.
  assert.equal(reading.deliberation?.confidence, 0.4);
  assert.equal(reading.deliberation?.score, 3);

  // The caller may set the bar where its own calibration puts it.
  const lowered = readSuggestion(shy, CANDIDATES, 0.3);
  assert.equal(lowered.suggestion?.effort, 'high');

  // An unusable threshold fails closed rather than admitting everything.
  assert.equal(readSuggestion(shy, CANDIDATES, Number.NaN).suggestion?.effort, null);
  assert.equal(DEFAULT_MIN_EFFORT_CONFIDENCE, 0.8);
});

test('a model this profile does not declare yields no suggestion, and the rest is still recorded', () => {
  const reading = readSuggestion(body({ model: { type: 'choice', choice: 'gpt-9', confidence: 0.99 } }), CANDIDATES);
  assert.equal(reading.suggestion, null);
  assert.equal(reading.deliberation?.score, 3, 'the deliberation answer was still given and is still evidence');
  assert.equal(reading.needsContext, 0.77);
});

test('a confidence that is not a probability yields no suggestion', () => {
  for (const confidence of [1.5, -0.1, Number.NaN, 'high', null, undefined]) {
    const reading = readSuggestion(body({ model: { type: 'choice', choice: 'sonnet', confidence } }), CANDIDATES);
    assert.equal(reading.suggestion, null, `confidence ${String(confidence)} must not route a stage`);
  }
});

test('the noul carries no confidence and gates nothing', () => {
  // A near-certain "needs unseen context" does not change the route; it is one
  // number on the proof. The primitive returns no confidence to gate with.
  const reading = readSuggestion(body({ needs_context: { type: 'noul', noul: 0.99 } }), CANDIDATES);
  assert.equal(reading.needsContext, 0.99);
  assert.equal(reading.suggestion?.model, 'sonnet');
  assert.equal(reading.suggestion?.effort, 'high');

  // A malformed one is absent rather than assumed either way.
  assert.equal(readSuggestion(body({ needs_context: { type: 'noul', noul: 7 } }), CANDIDATES).needsContext, null);
});

test('a malformed body is an ordinary input and never throws', () => {
  const junk: unknown[] = [
    null, undefined, 0, 'overloaded', [], {}, { answers: null }, { answers: [] }, { answers: {} },
    { answers: { model: 'sonnet' } },
    { answers: { model: { choice: 'sonnet', confidence: 0.9 } }, usage: 'lots' },
    { answers: { deliberation: { score: 'three', confidence: 0.9 } } },
    { answers: { model: { choice: 'sonnet', confidence: 0.9, probabilities: { sonnet: 'most' } } } },
  ];
  for (const value of junk) {
    const reading = readSuggestion(value, CANDIDATES);
    assert.ok(reading && typeof reading === 'object', `threw or returned nothing for ${JSON.stringify(value)}`);
    assert.ok(reading.suggestion === null || typeof reading.suggestion.model === 'string');
  }

  // A distribution keeps only the entries that are actually numbers.
  const partial = readSuggestion(
    { answers: { model: { choice: 'sonnet', confidence: 0.9, probabilities: { sonnet: 0.9, opus: 'some' } } } },
    CANDIDATES,
  );
  assert.deepEqual(partial.suggestion?.distribution, { sonnet: 0.9 });
  assert.equal(partial.suggestion?.effort, null, 'no deliberation answer means no effort');
});

/* ── which stages run at all ──────────────────────────────────────────── */

const ALL_PHASES: readonly RelayPhase[] = ['plan', 'estimate', 'implement', 'verify', 'review'];

/** A pipeline answer, overridable a field at a time. */
const pipelineBody = (over: Record<string, unknown> = {}) => ({
  answers: {
    pipeline: { type: 'choice', choice: 'direct', probabilities: { direct: 0.93, planned: 0.07 }, confidence: 0.93, ...over },
  },
});

/** Every subset of the five phases, which is every docket shape there can be. */
function subsets(): RelayPhase[][] {
  const out: RelayPhase[][] = [];
  for (let mask = 0; mask < (1 << ALL_PHASES.length); mask += 1) {
    out.push(ALL_PHASES.filter((_, i) => (mask & (1 << i)) !== 0));
  }
  return out;
}

test('no pipeline on offer skips the work or either stage that checks it', () => {
  assert.ok(PIPELINES.length >= 2, 'a choice needs options');
  for (const pipeline of PIPELINES) {
    for (const phase of UNSKIPPABLE) {
      assert.ok(pipeline.phases.includes(phase), `pipeline “${pipeline.id}” drops ${phase}`);
    }
    // A pipeline is a real ordering of real phases, not an arbitrary set.
    for (const phase of pipeline.phases) assert.ok(ALL_PHASES.includes(phase), `unknown phase ${phase}`);
    assert.equal(new Set(pipeline.phases).size, pipeline.phases.length, 'a phase appears twice');
  }
  // The ids are distinct, or a response could not name one unambiguously.
  assert.equal(new Set(PIPELINES.map((p) => p.id)).size, PIPELINES.length);
});

test('pipeline criteria describe situations and never name their own length', () => {
  for (const pipeline of PIPELINES) {
    assert.ok(pipeline.criterion.length > 40, `not a described situation: ${pipeline.id}`);
    assert.ok(pipeline.criterion.trim().endsWith('.'), `not a sentence: ${pipeline.id}`);
    assert.doesNotMatch(pipeline.criterion, /\b(full|shorter|longer|fewer|more stages|all five|three|skip)\b/i, pipeline.id);
  }
});

test('the relay question offers only pipelines this docket could actually run', () => {
  const request = relayRequest('rename a variable', ALL_PHASES, PIPELINE);
  assert.ok(request, 'five phases admit every pipeline');
  const choice = request.questions.pipeline;
  assert.equal(choice.type, 'choice');
  if (choice.type === 'choice') {
    assert.deepEqual(Object.keys(choice.criteria).sort(), ['direct', 'full', 'planned']);
  }

  // A docket with no estimate stage cannot be offered the pipeline that has one.
  const noEstimate = relayRequest('rename a variable', ['plan', 'implement', 'verify', 'review'], PIPELINE);
  assert.ok(noEstimate);
  const narrowed = noEstimate.questions.pipeline;
  if (narrowed.type === 'choice') assert.deepEqual(Object.keys(narrowed.criteria).sort(), ['direct', 'planned']);

  // Only the operator's own words reach it, bounded as everywhere else.
  assert.deepEqual(Object.keys(noEstimate.state), ['operator_intent']);
  const long = relayRequest('y'.repeat(9000), ALL_PHASES, PIPELINE);
  assert.ok((long?.state.operator_intent as string).length <= 2000);
});

test('a question with one answer is not asked', () => {
  // Exactly one pipeline fits, so there is nothing to decide and nothing to bill.
  assert.equal(relayRequest('x', ['implement', 'verify', 'review'], PIPELINE), null);
  // A docket missing a stage every pipeline needs admits none at all.
  assert.equal(relayRequest('x', ['plan', 'implement'], PIPELINE), null);
  assert.equal(relayRequest('x', [], PIPELINE), null);
});

test('a confident pipeline answer narrows the docket to that pipeline', () => {
  const reading = readPipeline(pipelineBody(), ALL_PHASES);
  assert.deepEqual(reading?.phases, ['implement', 'verify', 'review']);
  assert.equal(reading?.pipeline, 'direct');
  assert.equal(reading?.confidence, 0.93);
  assert.deepEqual(reading?.distribution, { direct: 0.93, planned: 0.07 });
});

test('an unconvinced pipeline answer changes nothing', () => {
  assert.equal(readPipeline(pipelineBody({ confidence: 0.6 }), ALL_PHASES), null);
  // The caller may set the bar where its own calibration puts it.
  assert.equal(readPipeline(pipelineBody({ confidence: 0.6 }), ALL_PHASES, 0.5)?.pipeline, 'direct');
  // An unusable threshold fails closed rather than admitting everything.
  assert.equal(readPipeline(pipelineBody(), ALL_PHASES, Number.NaN), null);
  assert.equal(DEFAULT_MIN_PIPELINE_CONFIDENCE, 0.8);
});

test('a pipeline this docket was never offered is discarded, not honoured', () => {
  // 'full' needs an estimate stage this docket does not have. Answering it
  // anyway would add a stage nobody asked for, which is the mirror of the
  // router's own rule about never widening a declared set.
  const reading = readPipeline(
    pipelineBody({ choice: 'full', confidence: 0.99 }),
    ['plan', 'implement', 'verify', 'review'],
  );
  assert.equal(reading, null);
  assert.equal(readPipeline(pipelineBody({ choice: 'turbo', confidence: 0.99 }), ALL_PHASES), null);
});

test('no answer, on any docket, ever adds a stage or removes one that checks the work', () => {
  const answers = [...PIPELINES.map((p) => p.id), 'turbo', '', '__proto__'];
  for (const requested of subsets()) {
    for (const choice of answers) {
      const reading = readPipeline(pipelineBody({ choice, confidence: 1 }), requested);
      if (reading === null) continue;
      for (const phase of reading.phases) {
        assert.ok(requested.includes(phase), `“${choice}” added ${phase} to [${requested.join(', ')}]`);
      }
      for (const phase of UNSKIPPABLE) {
        assert.ok(reading.phases.includes(phase), `“${choice}” removed ${phase} from [${requested.join(', ')}]`);
      }
      assert.ok(reading.phases.length > 0, 'a docket narrowed to nothing');
    }
  }
});

test('a malformed pipeline body is an ordinary input and never throws', () => {
  for (const value of [null, undefined, 0, 'overloaded', [], {}, { answers: {} }, { answers: { pipeline: 'direct' } },
    { answers: { pipeline: { choice: 'direct' } } }, { answers: { pipeline: { confidence: 0.9 } } },
    { answers: { pipeline: { choice: 7, confidence: 0.9 } } }]) {
    assert.equal(readPipeline(value, ALL_PHASES), null, `did not refuse ${JSON.stringify(value)}`);
  }
});

test('a Wanigan with no suggester asks nothing, is billed nothing, and runs every stage it declared', () => {
  // The default. No option passed at all is the shape most installs have,
  // because most installs have never heard of this service.
  assert.equal(stageRequest('implement', 'anything', CANDIDATES), null);
  assert.equal(relayRequest('anything', ALL_PHASES), null);

  // Explicitly nothing enabled, and a capability that is on but not this one:
  // each switch is its own, so one being on never implies the other.
  assert.equal(stageRequest('implement', 'x', CANDIDATES, { enabled: NO_SUGGESTER }), null);
  assert.equal(relayRequest('x', ALL_PHASES, NO_SUGGESTER), null);
  assert.equal(stageRequest('implement', 'x', CANDIDATES, { enabled: ['pipeline'] }), null);
  assert.equal(relayRequest('x', ALL_PHASES, ['route']), null);

  // And with one on, only that one answers.
  assert.ok(stageRequest('implement', 'x', CANDIDATES, { enabled: ['route'] }));
  assert.ok(relayRequest('x', ALL_PHASES, ['pipeline']));
});

test('without a pipeline answer a docket runs exactly the stages it declared', () => {
  // Every way this can fail arrives as null, and every one of them is the
  // docket untouched: no credential, a declined answer, a 429, a bad body.
  for (const requested of subsets()) {
    assert.deepEqual(phasesFor(requested, null), requested);
  }
  assert.deepEqual(phasesFor(ALL_PHASES, readPipeline(pipelineBody({ confidence: 0.1 }), ALL_PHASES)), ALL_PHASES);
  assert.deepEqual(phasesFor(ALL_PHASES, readPipeline('overloaded', ALL_PHASES)), ALL_PHASES);

  // And a narrowing that did clear every gate is the only thing that changes it.
  assert.deepEqual(phasesFor(ALL_PHASES, readPipeline(pipelineBody(), ALL_PHASES)), ['implement', 'verify', 'review']);
});

test('every capability is declared with what switching it off costs', () => {
  assert.deepEqual(SUGGESTER_CAPABILITIES.map((c) => c.id).sort(), ['pipeline', 'route']);
  for (const capability of SUGGESTER_CAPABILITIES) {
    assert.ok(capability.label.length > 8, capability.id);
    assert.ok(capability.describe.length > 40, `${capability.id} does not say what it asks`);
    // A switch whose off state is undescribed is a switch nobody can judge.
    assert.ok(capability.withoutIt.length > 20, `${capability.id} does not say what it costs to turn off`);
    assert.ok(capability.withoutIt.trim().endsWith('.'), capability.id);
  }
});

/* ── one call for a whole relay ───────────────────────────────────────── */

const ASKS: readonly StageAsk[] = [
  { phase: 'plan', candidates: CANDIDATES },
  { phase: 'implement', candidates: CANDIDATES },
  { phase: 'review', candidates: [CANDIDATES[2]] },
];
const BOTH = ['route', 'pipeline'] as const;

test('one request carries the pipeline question and every stage’s three, over one state', () => {
  const request = relayPlanRequest('add a retry', ALL_PHASES, ASKS, BOTH);
  assert.ok(request);
  assert.deepEqual(Object.keys(request.state), ['operator_intent']);
  assert.deepEqual(Object.keys(request.questions).sort(), [
    'deliberation_implement', 'deliberation_plan', 'deliberation_review',
    'model_implement', 'model_plan', 'model_review',
    'needs_context_implement', 'needs_context_plan', 'needs_context_review',
    'pipeline',
  ]);

  // One state serves every question, so no question may lean on it to say
  // which stage it means — and ids are not sent to the model either.
  for (const [id, question] of Object.entries(request.questions)) {
    if (id === 'pipeline') continue;
    const stage = id.slice(id.lastIndexOf('_') + 1);
    assert.ok(question.instructions.includes(stage), `${id} does not name its own stage`);
  }

  // Each stage is offered only the models it can actually run on.
  const review = request.questions.model_review;
  if (review.type === 'choice') assert.deepEqual(Object.keys(review.criteria), ['sonnet']);
});

test('each capability contributes only its own questions, and neither means no request', () => {
  const routeOnly = relayPlanRequest('x', ALL_PHASES, ASKS, ['route']);
  assert.ok(routeOnly);
  assert.ok(!('pipeline' in routeOnly.questions), 'route alone asked a pipeline question');

  const pipelineOnly = relayPlanRequest('x', ALL_PHASES, ASKS, ['pipeline']);
  assert.ok(pipelineOnly);
  assert.deepEqual(Object.keys(pipelineOnly.questions), ['pipeline']);

  assert.equal(relayPlanRequest('x', ALL_PHASES, ASKS, NO_SUGGESTER), null);
  assert.equal(relayPlanRequest('x', ALL_PHASES, ASKS, undefined), null);
  assert.equal(relayPlanRequest('   ', ALL_PHASES, ASKS, BOTH), null);
  // Nothing to ask about is not a question either.
  assert.equal(relayPlanRequest('x', ALL_PHASES, [], ['route']), null);
});

test('a batched answer is read back per stage, gated exactly as a single one is', () => {
  const reading = readRelayPlan({
    answers: {
      pipeline: { type: 'choice', choice: 'direct', probabilities: { direct: 0.9 }, confidence: 0.9 },
      model_plan: { type: 'choice', choice: 'sonnet', probabilities: { sonnet: 0.95 }, confidence: 0.95 },
      deliberation_plan: { type: 'score', score: 3, confidence: 0.9 },
      needs_context_plan: { type: 'noul', noul: 0.4 },
      // Confident model, unconvinced deliberation: the model survives, the
      // effort does not, and the router reads that as "nobody named one".
      model_implement: { type: 'choice', choice: 'gpt-5.1-codex', probabilities: {}, confidence: 0.88 },
      deliberation_implement: { type: 'score', score: 3, confidence: 0.2 },
      // A model this stage was never offered is discarded.
      model_review: { type: 'choice', choice: 'gpt-5.1-codex', confidence: 0.99 },
    },
    usage: { input_tokens: 900, output_tokens: 0 },
  }, ALL_PHASES, ASKS);

  assert.equal(reading.pipeline?.pipeline, 'direct');
  assert.equal(reading.stages.plan?.suggestion?.model, 'sonnet');
  assert.equal(reading.stages.plan?.suggestion?.effort, 'high');
  assert.equal(reading.stages.plan?.needsContext, 0.4);

  assert.equal(reading.stages.implement?.suggestion?.model, 'gpt-5.1-codex');
  assert.equal(reading.stages.implement?.suggestion?.effort, null);
  assert.equal(reading.stages.implement?.deliberation?.confidence, 0.2, 'the dropped judgment is still evidence');

  assert.equal(reading.stages.review?.suggestion, null);

  // Usage belongs to the call, not to any one stage of it.
  assert.deepEqual(reading.usage, { inputTokens: 900, outputTokens: 0 });
  for (const stage of Object.values(reading.stages)) assert.equal(stage.usage, null);
});

test('a batched body nobody can parse reads as nothing said, for every stage', () => {
  for (const junk of [null, 'overloaded', 0, [], {}, { answers: {} }, { answers: null }]) {
    const reading = readRelayPlan(junk, ALL_PHASES, ASKS);
    assert.equal(reading.pipeline, null, `pipeline survived ${JSON.stringify(junk)}`);
    for (const stage of Object.values(reading.stages)) {
      assert.equal(stage.suggestion, null);
    }
  }
  assert.deepEqual(readRelayPlan(null, ALL_PHASES, ASKS), NO_RELAY_PLAN);
});

test('a described model is offered by its description; an undescribed one falls back to its label', () => {
  // Without this the choice is name recognition: "Opus" against "Sonnet" with
  // nothing to tell them apart. A backend that describes its rows gets to say
  // so, and one that does not is not spoken for.
  const request = relayPlanRequest('add a retry', ALL_PHASES, [{
    phase: 'implement',
    candidates: CANDIDATES,
    descriptions: { sonnet: 'Fast and cheap; the default for ordinary edits.' },
  }], ['route']);
  assert.ok(request);
  const choice = request.questions.model_implement;
  assert.equal(choice.type, 'choice');
  if (choice.type === 'choice') {
    assert.equal(choice.criteria.sonnet, 'Fast and cheap; the default for ordinary edits.');
    assert.equal(choice.criteria.opus, 'Opus', 'an undescribed row is offered by its label');
  }
});
