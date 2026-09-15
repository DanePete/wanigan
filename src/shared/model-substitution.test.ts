import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findSubstitutions, modelsAgree, normalizeModelId, requestAt, substitutionSentence, switchIsRequest,
  type ReportedModel, type RequestedModel,
} from './model-substitution.ts';

test('ids normalise away spelling: case, provider prefix, context suffix, Bedrock version and date', () => {
  assert.equal(normalizeModelId('claude-sonnet-5-20260901'), 'claude-sonnet-5');
  assert.equal(normalizeModelId('Claude-Opus-5[1m]'), 'claude-opus-5');
  assert.equal(normalizeModelId('us.anthropic.claude-opus-5-v1:0'), 'claude-opus-5');
  assert.equal(normalizeModelId('anthropic/claude-haiku-4-5'), 'claude-haiku-4-5');
  assert.equal(normalizeModelId('gpt-5.5'), 'gpt-5.5');
});

test('an alias and a dated id of its family agree; a different family does not', () => {
  assert.equal(modelsAgree('sonnet', 'claude-sonnet-5-20260901'), true);
  assert.equal(modelsAgree('opus', 'claude-opus-5[1m]'), true);
  assert.equal(modelsAgree('fable', 'claude-fable-5-1'), true);
  assert.equal(modelsAgree('opusplan', 'claude-sonnet-5'), true);
  assert.equal(modelsAgree('opus', 'claude-sonnet-5'), false);
  assert.equal(modelsAgree('claude-fable-5-1', 'claude-fable-5-1-20260910'), true);
  assert.equal(modelsAgree('claude-opus-5', 'claude-opus-5-1'), false, 'a different version is a different model');
  assert.equal(modelsAgree('gpt-5.5', 'gpt-5.4'), false);
});

test('the CLI default is never compared, and synthetic turns are not models', () => {
  assert.equal(modelsAgree(null, 'claude-sonnet-5'), true);
  assert.equal(modelsAgree('', 'claude-sonnet-5'), true);
  assert.equal(modelsAgree('default', 'claude-haiku-4-5'), true);
  assert.equal(modelsAgree('opus', '<synthetic>'), true);
});

test('the request in force is the latest at or before the observation', () => {
  const requested: RequestedModel[] = [{ at: 100, model: 'opus', via: 'launch' }, { at: 500, model: 'haiku', via: 'wanigan' }];
  assert.equal(requestAt(requested, 50)?.model, 'opus', 'before the first request, the launch request stands');
  assert.equal(requestAt(requested, 499)?.model, 'opus');
  assert.equal(requestAt(requested, 500)?.model, 'haiku');
  assert.equal(requestAt([], 1), null);
});

test('substitutions group by pair, count, sum reported cost and keep their evidence sources', () => {
  const requested: RequestedModel[] = [{ at: 0, model: 'opus', via: 'launch' }, { at: 1000, model: 'sonnet', via: 'command' }];
  const reported: ReportedModel[] = [
    { at: 10, model: 'claude-opus-5', via: 'otel', costUsd: 0.2 },
    { at: 20, model: 'claude-sonnet-5', via: 'auto-switch', costUsd: null },
    { at: 30, model: 'claude-sonnet-5-20260901', via: 'otel', costUsd: 0.05 },
    { at: 40, model: 'claude-sonnet-5', via: 'transcript', costUsd: null },
    { at: 1100, model: 'claude-sonnet-5', via: 'otel', costUsd: 0.07 },
  ];
  const subs = findSubstitutions(requested, reported);
  assert.equal(subs.length, 1);
  assert.deepEqual({ ...subs[0], costUsd: Math.round((subs[0].costUsd ?? 0) * 100) / 100 },
    { requested: 'opus', reported: 'claude-sonnet-5', firstAt: 20, lastAt: 40, count: 3, costUsd: 0.05, via: ['auto-switch', 'otel', 'transcript'] });
  assert.equal(substitutionSentence(subs[0]), 'Requested opus, answered by claude-sonnet-5');
});

test('a session that asked for nothing in particular has no substitutions', () => {
  assert.deepEqual(findSubstitutions([{ at: 0, model: null, via: 'launch' }], [{ at: 1, model: 'claude-haiku-4-5', via: 'otel', costUsd: 1 }]), []);
  assert.deepEqual(findSubstitutions([], [{ at: 1, model: 'x', via: 'otel', costUsd: null }]), []);
});

test('only a person’s switch is a request; auto is the CLI’s own fallback', () => {
  for (const source of ['command', 'picker', 'sdk', 'resume']) assert.equal(switchIsRequest(source), true, source);
  assert.equal(switchIsRequest('auto'), false);
  assert.equal(switchIsRequest(null), false);
});
