import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  economicsEndpointUrl, MODEL_ECONOMICS_TTL_MS, parseEconomicsEndpoints, parseEconomicsModels,
  quoteEconomics, readEconomicsQuoteInput, readEconomicsSelection,
  type EconomicsEndpointSnapshot, type EconomicsModel, type EconomicsSnapshot, type ModelEconomicsQuoteInput,
} from './model-economics.ts';

const NOW = 1_000_000_000;
const MODEL = {
  id: 'fixture/coder', name: 'Fixture coder', canonical_slug: 'fixture/coder-v1', context_length: 20_000,
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  top_provider: { max_completion_tokens: 8_000 }, supported_parameters: ['tools', 'reasoning_effort'],
  reasoning: { supported_efforts: ['low', 'high'] },
  pricing: { prompt: '0.000001', completion: '0.000003' },
};
const ENDPOINT = {
  tag: 'host/fp8', provider_name: 'Host', quantization: 'fp8', status: 0,
  context_length: 10_000, max_prompt_tokens: null, max_completion_tokens: 4_000,
  supported_parameters: ['tools', 'reasoning_effort'], supports_tool_choice: { auto: true, required: false },
  pricing: { prompt: '0.000002', completion: '0.000004', input_cache_read: '0.0000002', input_cache_write: '0.0000025' },
};
const INPUT: ModelEconomicsQuoteInput = {
  workload: { inputTokens: 1_000, cachedInputTokens: 500, cacheWriteTokens: 100, outputTokens: 200, requests: 1 },
  requirements: { tools: true, effort: 'low', toolChoice: 'auto' },
};
const models = (over: Record<string, unknown> = {}): EconomicsSnapshot<EconomicsModel> => ({
  id: 'models-hash', sourceUrl: 'https://openrouter.ai/api/v1/models', fetchedAt: NOW, contentHash: 'hash',
  ...parseEconomicsModels({ data: [{ ...MODEL, ...over }] }),
});
const endpoints = (over: Record<string, unknown> = {}): EconomicsEndpointSnapshot => ({
  id: 'endpoint-hash', modelId: MODEL.id, sourceUrl: economicsEndpointUrl(MODEL.id), fetchedAt: NOW, contentHash: 'hash2',
  ...parseEconomicsEndpoints({ data: { id: MODEL.id, endpoints: [{ ...ENDPOINT, ...over }] } }, MODEL.id),
});
const quote = (over: Record<string, unknown> = {}, input: ModelEconomicsQuoteInput = INPUT) =>
  quoteEconomics(models(), [endpoints(over)], input, NOW)[0];

test('quotes explicit disjoint cache buckets, preserves decimal precision, and uses endpoint rather than aggregate rates', () => {
  const row = quote();
  assert.equal(row.eligible, true);
  assert.equal(row.estimateUsdDecimal, '0.00195');
  assert.equal(row.estimateUsd, 0.00195);
  assert.equal(row.rates.input, ENDPOINT.pricing.prompt);
  assert.equal(row.endpointTag, 'host/fp8');
  assert.equal(row.quantization, 'fp8');
  assert.equal(row.catalogueSnapshotId, 'models-hash');
  assert.equal(row.endpointSnapshotId, 'endpoint-hash');
  assert.ok(row.excludedCharges.includes('Unreported request charges'));
});

test('unknown, negative, nondecimal and nonfinite prices never become zero', () => {
  for (const invalid of [undefined, null, -1, '-0.5', 'Infinity', 'NaN', '0x10', '', '1e99', {}, ' 0 ']) {
    const row = quote({ pricing: { ...ENDPOINT.pricing, prompt: invalid } });
    assert.equal(row.eligible, false, String(invalid));
    assert.equal(row.estimateUsd, null);
    assert.equal(row.rates.input, null);
  }
  const free = quote({ pricing: { prompt: '0', completion: '0', input_cache_read: '0', input_cache_write: '0' } });
  assert.equal(free.estimateUsdDecimal, '0');
  assert.equal(free.eligible, true, 'published zero is different from missing');
});

test('scientific decimal prices and documented request charges retain exact arithmetic', () => {
  const row = quote({ pricing: { prompt: '1e-7', completion: '2e-7', input_cache_read: '0', input_cache_write: '0', request: '0.001' } });
  assert.equal(row.estimateUsdDecimal, '0.00108');
  assert.ok(!row.excludedCharges.includes('Unreported request charges'));
});

test('missing cache rates matter only for the workload buckets being estimated', () => {
  assert.equal(quote({ pricing: MODEL.pricing }).estimateUsd, null);
  const uncached = { ...INPUT, workload: { ...INPUT.workload, cachedInputTokens: 0, cacheWriteTokens: 0 } };
  assert.equal(quote({ pricing: MODEL.pricing }, uncached).estimateUsdDecimal, '0.0016');
});

test('time overrides and unknown paid dimensions are preserved but excluded from numeric ranking', () => {
  for (const extra of [{ overrides: [{ utc_start: 100, prompt: '0.0005' }] }, { image: '0.05' }, { tiers: [{ above: 100_000 }] }]) {
    const row = quote({ pricing: { ...ENDPOINT.pricing, ...extra } });
    assert.equal(row.eligible, false);
    assert.equal(row.estimateUsd, null);
    assert.equal(row.rates.conditional, true);
    assert.ok(row.rates.conditionsJson);
  }
  assert.equal(quote({ pricing: { ...ENDPOINT.pricing, discount: 0.8, image: '0', overrides: [] } }).estimateUsdDecimal, '0.00195',
    'do not multiply a discount into the already returned rates');
});

test('model-only discovery cannot claim a usable endpoint', () => {
  const row = quoteEconomics(models(), [], INPUT, NOW)[0];
  assert.equal(row.eligible, false);
  assert.equal(row.endpointSnapshotId, null);
  assert.match(row.reasons.join(' '), /not been fetched/);
});

test('zero or absent capacity and nonhealthy endpoints do not mean unlimited or available', () => {
  for (const over of [{ context_length: 0 }, { context_length: 1_000 }, { max_completion_tokens: null }, { max_completion_tokens: 0 },
    { max_prompt_tokens: 999 }, { max_completion_tokens: 199 }, { status: null }, { status: 1 }]) {
    assert.equal(quote(over).eligible, false, JSON.stringify(over));
  }
});

test('tools, exact effort and exact tool-choice modes are independently required', () => {
  assert.equal(quote({ supported_parameters: ['reasoning_effort'] }).eligible, false);
  assert.equal(quote({ supported_parameters: ['tools'] }).eligible, false);
  assert.equal(quote({}, { ...INPUT, requirements: { ...INPUT.requirements, effort: 'medium' } }).eligible, false);
  assert.equal(quote({}, { ...INPUT, requirements: { ...INPUT.requirements, toolChoice: 'required' } }).eligible, false);
  const noEffort = { ...INPUT, requirements: { ...INPUT.requirements, effort: null } };
  assert.equal(quote({ supported_parameters: ['tools'] }, noEffort).eligible, true);
  assert.equal(quoteEconomics(models({ architecture: { input_modalities: ['image'], output_modalities: ['text'] } }), [endpoints()], INPUT, NOW)[0].eligible, false);
});

test('stale and future-dated snapshots remain visible but are not eligible', () => {
  for (const at of [NOW - MODEL_ECONOMICS_TTL_MS, NOW + 1]) {
    const row = quoteEconomics({ ...models(), fetchedAt: at }, [endpoints()], INPUT, NOW)[0];
    assert.equal(row.stale, true); assert.equal(row.eligible, false);
    const endpointRow = quoteEconomics(models(), [{ ...endpoints(), fetchedAt: at }], INPUT, NOW)[0];
    assert.equal(endpointRow.stale, true); assert.equal(endpointRow.eligible, false);
  }
});

test('allowlists are exact and an empty allowlist admits nothing', () => {
  assert.equal(quoteEconomics(models(), [endpoints()], { ...INPUT, modelIds: [] }, NOW).length, 0);
  assert.equal(quoteEconomics(models(), [endpoints()], { ...INPUT, endpointTags: ['host'] }, NOW).length, 0);
  assert.equal(quoteEconomics(models(), [endpoints()], { ...INPUT, endpointTags: ['host/fp8'] }, NOW).length, 1);
});

test('ranking uses the supplied workload, not a blended token price', () => {
  const expensiveInput = endpoints({ tag: 'host/input', pricing: { prompt: '0.00001', completion: '0.000001' } });
  const expensiveOutput = endpoints({ tag: 'host/output', pricing: { prompt: '0.000001', completion: '0.00001' } });
  const snapshot = { ...expensiveInput, rows: [...expensiveInput.rows, ...expensiveOutput.rows] };
  const work = { ...INPUT.workload, cachedInputTokens: 0, cacheWriteTokens: 0 };
  assert.equal(quoteEconomics(models(), [snapshot], { ...INPUT, workload: { ...work, inputTokens: 2_000, outputTokens: 100 } }, NOW)[0].endpointTag, 'host/output');
  assert.equal(quoteEconomics(models(), [snapshot], { ...INPUT, workload: { ...work, inputTokens: 100, outputTokens: 2_000 } }, NOW)[0].endpointTag, 'host/input');
});

test('model and endpoint response limits report truncation and malformed rows', () => {
  const result = parseEconomicsModels({ data: [MODEL, MODEL, { id: '../escape' }, ...Array.from({ length: 2_001 }, (_, i) => ({ ...MODEL, id: `fixture/m${i}` }))] });
  assert.equal(result.truncated, true); assert.equal(result.rejected, 2); assert.equal(result.rows.length, 1_998);
  const endpoint = parseEconomicsEndpoints({ data: { endpoints: [ENDPOINT, ENDPOINT, { tag: 'bad', provider_name: null }] } }, MODEL.id);
  assert.equal(endpoint.rows.length, 1); assert.equal(endpoint.rejected, 2);
  assert.throws(() => parseEconomicsModels({ data: {} }));
  assert.throws(() => parseEconomicsEndpoints({ data: { id: 'wrong/model', endpoints: [] } }, MODEL.id));
});

test('renderer cannot supply arbitrary URLs, excess selections or invalid workloads', () => {
  for (const id of ['https://evil.test', 'fixture/../../escape', 'fixture/%2Fsecret', 'fixture/model?key=value', 'fixture/model\n']) {
    assert.throws(() => economicsEndpointUrl(id));
    assert.throws(() => readEconomicsSelection([id]));
  }
  assert.throws(() => readEconomicsSelection(Array(13).fill(MODEL.id)));
  for (const workload of [{ ...INPUT.workload, inputTokens: -1 }, { ...INPUT.workload, inputTokens: 0.1 },
    { ...INPUT.workload, cachedInputTokens: 1_000 }, { ...INPUT.workload, requests: 0 }, { ...INPUT.workload, outputTokens: Infinity }]) {
    assert.throws(() => readEconomicsQuoteInput({ ...INPUT, workload }));
  }
  assert.throws(() => readEconomicsQuoteInput({ ...INPUT, requirements: { tools: true, effort: false, toolChoice: null } }));
  assert.throws(() => readEconomicsQuoteInput({ ...INPUT, endpointTags: 'host/fp8' }));
  assert.equal(economicsEndpointUrl('fixture/model:free'), 'https://openrouter.ai/api/v1/models/fixture/model%3Afree/endpoints');
});
