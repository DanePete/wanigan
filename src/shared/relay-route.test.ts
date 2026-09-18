/**
 * The routing contract: a relay stage may only run on a model and an effort its
 * profile actually declares. The test that matters most is the one that proves
 * a suggestion naming an undeclared effort comes back as the profile's default
 * rather than as the nearest declared level — clamping would read as a working
 * router right up until it billed a stage for a decision nobody made.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MIN_CONFIDENCE,
  chooseStage,
  type RouteCandidate, type RouteDefaults, type StageSuggestion,
} from './relay-route.ts';

/**
 * Three rows in the shape `launch-choices.ts` produces: one with an ordered
 * effort ladder, one that declares no levels at all, and one whose ladder has
 * holes in it, so "not declared" and "not adjacent" are different failures.
 */
const CANDIDATES: readonly RouteCandidate[] = [
  { model: 'gpt-5.1-codex', label: 'Codex 5.1', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { model: 'opus', label: 'Opus', efforts: null },
  { model: 'sonnet', label: 'Sonnet', efforts: ['low', 'high'] },
];
const DEFAULTS: RouteDefaults = { model: 'gpt-5.1-codex', effort: 'low' };

const suggest = (over: Partial<StageSuggestion>): StageSuggestion => ({
  model: 'sonnet', effort: 'high', distribution: { sonnet: 0.9, opus: 0.1 }, confidence: 0.95, ...over,
});

test('an operator’s own choice outranks a suggestion that cleared every gate', () => {
  const route = chooseStage('plan', CANDIDATES, DEFAULTS, suggest({ model: 'opus', effort: null, confidence: 1 }), {
    operator: { model: 'sonnet', effort: 'high' },
  });
  assert.equal(route.model, 'sonnet');
  assert.equal(route.effort, 'high');
  assert.equal(route.source, 'operator');
  // Confidence belongs to a suggestion that was taken, and none was.
  assert.equal(route.confidence, null);
  assert.match(route.reason, /because you chose/);
});

test('an operator naming a model alone keeps the profile’s default effort where that model declares it', () => {
  const route = chooseStage('implement', CANDIDATES, DEFAULTS, null, { operator: { model: 'sonnet' } });
  assert.equal(route.model, 'sonnet');
  assert.equal(route.effort, 'low');
  assert.equal(route.source, 'operator');
});

test('an operator value the profile does not declare is refused, not clamped, and the reason says which one', () => {
  const unknownModel = chooseStage('plan', CANDIDATES, DEFAULTS, null, { operator: { model: 'gpt-9', effort: 'high' } });
  assert.equal(unknownModel.source, 'profile-default');
  assert.equal(unknownModel.model, 'gpt-5.1-codex');
  assert.equal(unknownModel.effort, 'low');
  assert.match(unknownModel.reason, /“gpt-9”, which this profile does not declare/);
  assert.match(unknownModel.reason, /refused rather than changed/);

  // 'medium' is a real level on another model's ladder and not on Sonnet's.
  const unknownEffort = chooseStage('plan', CANDIDATES, DEFAULTS, null, { operator: { model: 'sonnet', effort: 'medium' } });
  assert.equal(unknownEffort.source, 'profile-default');
  assert.equal(unknownEffort.effort, 'low');
  assert.match(unknownEffort.reason, /“medium”, which this profile does not declare for Sonnet/);
  assert.match(unknownEffort.reason, /refused rather than moved to a level it does declare/);
});

test('a suggestion below the threshold is dropped, and so is one whose confidence is not a probability', () => {
  const shy = chooseStage('review', CANDIDATES, DEFAULTS, suggest({ confidence: 0.79 }));
  assert.equal(shy.source, 'profile-default');
  assert.equal(shy.model, 'gpt-5.1-codex');
  assert.equal(shy.confidence, null);
  assert.match(shy.reason, /0\.79, is below the 0\.80 this stage requires/);

  // The same suggestion clears a threshold the caller lowered for this stage.
  const lowered = chooseStage('review', CANDIDATES, DEFAULTS, suggest({ confidence: 0.79 }), { minConfidence: 0.5 });
  assert.equal(lowered.source, 'suggested');

  for (const confidence of [1.5, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const route = chooseStage('review', CANDIDATES, DEFAULTS, suggest({ confidence }));
    assert.equal(route.source, 'profile-default', `confidence ${confidence} must not route a stage`);
    assert.match(route.reason, /not a probability between 0 and 1/);
  }

  // An unusable threshold fails closed rather than admitting everything.
  const nanBar = chooseStage('review', CANDIDATES, DEFAULTS, suggest({ confidence: 1 }), { minConfidence: Number.NaN });
  assert.equal(nanBar.source, 'profile-default');
});

test('a suggestion naming a model this profile does not declare is dropped', () => {
  const route = chooseStage('plan', CANDIDATES, DEFAULTS, suggest({ model: 'gpt-9', effort: null }));
  assert.equal(route.source, 'profile-default');
  assert.equal(route.model, 'gpt-5.1-codex');
  assert.match(route.reason, /“gpt-9” was discarded because this profile does not declare it/);

  const nameless = chooseStage('plan', CANDIDATES, DEFAULTS, suggest({ model: null, effort: null }));
  assert.equal(nameless.source, 'profile-default');
  assert.match(nameless.reason, /named no model/);
});

test('a suggestion naming an effort the model does not declare is dropped whole and never moved to the nearest level', () => {
  // 'highest' sits between 'high' and 'xhigh' on Codex's ladder. A clamping
  // router returns one of those; this one returns what the profile already said.
  const route = chooseStage('implement', CANDIDATES, DEFAULTS, suggest({ model: 'gpt-5.1-codex', effort: 'highest', confidence: 0.99 }));
  assert.equal(route.source, 'profile-default');
  assert.equal(route.effort, 'low', 'the profile’s declared default, not a neighbour of the suggested level');
  assert.notEqual(route.effort, 'high');
  assert.notEqual(route.effort, 'xhigh');
  // The model was declared and still did not survive: admitted whole, or not at all.
  assert.equal(route.model, 'gpt-5.1-codex');
  assert.equal(route.confidence, null);
  assert.match(route.reason, /not moved to a level that is declared/);
});

test('a suggestion that clears every gate is taken and carries its own confidence', () => {
  const route = chooseStage('plan', CANDIDATES, DEFAULTS, suggest({ model: 'sonnet', effort: 'high', confidence: 0.83 }));
  assert.equal(route.model, 'sonnet');
  assert.equal(route.effort, 'high');
  assert.equal(route.source, 'suggested');
  assert.equal(route.confidence, 0.83);
  assert.match(route.reason, /confidence 0\.83, at or above the 0\.80/);
  assert.equal(DEFAULT_MIN_CONFIDENCE, 0.8);
});

test('a default the profile no longer declares falls back to the first candidate and names the default it lost', () => {
  const route = chooseStage('verify', CANDIDATES, { model: 'retired-model', effort: 'high' }, null);
  assert.equal(route.model, 'gpt-5.1-codex');
  assert.equal(route.effort, 'high');
  assert.equal(route.source, 'profile-default');
  assert.match(route.reason, /the first model this profile declares/);
  assert.match(route.reason, /“retired-model” is not one of them/);

  const nameless = chooseStage('verify', CANDIDATES, { model: null, effort: null }, null);
  assert.equal(nameless.model, 'gpt-5.1-codex');
  assert.match(nameless.reason, /names no default of its own/);
});

test('a profile with no candidates chooses nothing and does not throw', () => {
  const bare = chooseStage('plan', [], DEFAULTS, null);
  assert.deepEqual(
    { model: bare.model, effort: bare.effort, source: bare.source, confidence: bare.confidence },
    { model: null, effort: null, source: 'profile-default', confidence: null },
  );
  assert.match(bare.reason, /nothing to choose from/);

  // An operator choice and a suggestion made against an empty profile are both
  // still reported as refused; "nothing to choose from" does not cover them.
  const asked = chooseStage('plan', [], DEFAULTS, suggest({}), { operator: { model: 'sonnet' } });
  assert.equal(asked.model, null);
  assert.match(asked.reason, /you chose the model “sonnet”/i);
  assert.match(asked.reason, /nothing to choose from/);
});

test('a model that declares no effort levels never comes back with an effort', () => {
  const byDefault = chooseStage('plan', CANDIDATES, { model: 'opus', effort: 'high' }, null);
  assert.equal(byDefault.model, 'opus');
  assert.equal(byDefault.effort, null);
  assert.match(byDefault.reason, /“high” is not a level this profile declares for Opus/);

  const byOperator = chooseStage('plan', CANDIDATES, { model: 'opus', effort: 'high' }, null, { operator: { model: 'opus' } });
  assert.equal(byOperator.effort, null);

  const bySuggestion = chooseStage('plan', CANDIDATES, DEFAULTS, suggest({ model: 'opus', effort: null, confidence: 0.9 }));
  assert.equal(bySuggestion.source, 'suggested');
  assert.equal(bySuggestion.effort, null);

  // An effort offered for a model that declares none is outside the declared
  // set exactly as a wrong level would be, so the whole suggestion goes.
  const refused = chooseStage('plan', CANDIDATES, DEFAULTS, suggest({ model: 'opus', effort: 'high', confidence: 0.9 }));
  assert.equal(refused.source, 'profile-default');
  assert.equal(refused.model, 'gpt-5.1-codex');

  // An empty ladder declares no levels either.
  const empty = chooseStage('plan', [{ model: 'm', label: 'M', efforts: [] }], { model: 'm', effort: 'low' }, null);
  assert.equal(empty.effort, null);
});

test('every route explains itself in one complete sentence, whatever it was handed', () => {
  const hostile: RouteCandidate[] = [{ model: 'x', label: 'Ex\nploit'.repeat(20), efforts: ['low'] }];
  const routes = [
    chooseStage('plan', CANDIDATES, DEFAULTS, null),
    chooseStage('implement', CANDIDATES, DEFAULTS, suggest({})),
    chooseStage('verify', CANDIDATES, DEFAULTS, suggest({ confidence: 0.1 })),
    chooseStage('review', CANDIDATES, DEFAULTS, suggest({ model: 'nope' })),
    chooseStage('plan', CANDIDATES, DEFAULTS, null, { operator: { model: 'opus' } }),
    chooseStage('plan', CANDIDATES, DEFAULTS, null, { operator: { model: 'nope' } }),
    chooseStage('plan', CANDIDATES, DEFAULTS, null, { operator: { effort: 'nope' } }),
    chooseStage('plan', [], DEFAULTS, null),
    chooseStage('plan', hostile, { model: 'x', effort: 'low' }, suggest({ model: '', effort: '  ' })),
  ];
  for (const route of routes) {
    assert.ok(route.reason.length > 20, `not a sentence: ${JSON.stringify(route.reason)}`);
    assert.match(route.reason, /^The [a-z]+ stage|^You chose|^A suggestion/);
    assert.ok(route.reason.endsWith('.'), `unterminated: ${JSON.stringify(route.reason)}`);
    // One line, and nothing from an untrusted name can break it.
    assert.ok(!/[\n\r]/.test(route.reason), 'a reason is one line');
    assert.ok(!/\p{C}/u.test(route.reason), 'a reason carries no control characters');
    assert.ok(route.reason.length < 800, 'a reason stays a summary');
  }
});

test('the phase is named in the reason, so a route proof says which stage it belongs to', () => {
  for (const phase of ['plan', 'implement', 'verify', 'review'] as const) {
    assert.match(chooseStage(phase, CANDIDATES, DEFAULTS, null).reason, new RegExp(`The ${phase} stage`));
  }
});
