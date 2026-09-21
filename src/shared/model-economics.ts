/** Public price/capability declarations, never a claim of tested coding quality. */
export const MODEL_ECONOMICS_TTL_MS = 24 * 3600_000;
export const MODEL_ECONOMICS_MAX_MODELS = 2_000;
export const MODEL_ECONOMICS_MAX_ENDPOINTS = 200;
export const MODEL_ECONOMICS_MAX_SELECTED = 12;
export const MODEL_ECONOMICS_SOURCE = 'https://openrouter.ai/api/v1/models';

export type ModelEconomicsSettings = { automaticRefresh: boolean };
export type EconomicsRates = {
  /** Published decimal USD per token. Null means unreported or invalid. */
  input: string | null; output: string | null; cacheRead: string | null; cacheWrite: string | null;
  request: string | null;
  /** Conditional schedules/tiers are preserved but not guessed by this version. */
  conditional: boolean;
  conditionsJson: string | null;
};
export type EconomicsModel = {
  id: string; name: string; revision: string | null;
  contextTokens: number | null; maxOutputTokens: number | null;
  inputModalities: string[]; outputModalities: string[];
  supportedParameters: string[]; efforts: string[];
  reasoningMandatory: boolean | null; rates: EconomicsRates;
};
export type EconomicsEndpoint = {
  modelId: string; tag: string; provider: string; quantization: string | null;
  contextTokens: number | null; maxInputTokens: number | null; maxOutputTokens: number | null;
  status: number | null; supportedParameters: string[];
  toolChoice: Partial<Record<'auto' | 'none' | 'required' | 'function', boolean>>;
  rates: EconomicsRates;
};
export type EconomicsSnapshot<T> = {
  id: string; sourceUrl: string; fetchedAt: number; contentHash: string;
  rows: T[]; received: number; rejected: number; truncated: boolean;
};
export type EconomicsEndpointSnapshot = EconomicsSnapshot<EconomicsEndpoint> & { modelId: string };
export type ModelEconomicsStatus = {
  settings: ModelEconomicsSettings;
  selectedModelIds: string[];
  catalogue: EconomicsSnapshot<EconomicsModel> | null;
  endpoints: EconomicsEndpointSnapshot[];
  stale: boolean; refreshing: boolean; lastAttemptAt: number | null; lastError: string | null;
  nextRefreshAt: number | null;
  endpointCoverage: { models: number; fetched: number; fresh: number };
};
export type ModelEconomicsWorkload = {
  /** Total input, including disjoint cache-read and cache-write buckets. */
  inputTokens: number; cachedInputTokens: number; cacheWriteTokens: number;
  /** Total output, including reasoning; do not add reasoning tokens again. */
  outputTokens: number; requests: number;
};
export type ModelEconomicsQuoteInput = {
  workload: ModelEconomicsWorkload;
  requirements: { tools: boolean; effort: string | null; toolChoice: 'auto' | 'none' | 'required' | 'function' | null };
  modelIds?: string[]; endpointTags?: string[];
};
export type ModelEconomicsQuote = {
  modelId: string; name: string; revision: string | null; endpointTag: string | null;
  provider: string | null; quantization: string | null; effort: string | null;
  catalogueSnapshotId: string; endpointSnapshotId: string | null; sourceUrl: string; fetchedAt: number;
  eligible: boolean; reasons: string[]; stale: boolean;
  /** Token charges plus a request charge only where explicitly published. Not total spend. */
  estimateUsd: number | null; estimateUsdDecimal: string | null;
  rates: EconomicsRates; excludedCharges: string[];
};

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, max = 240): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/\p{C}/u.test(value) ? value : null;
const limit = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000 ? value : null;
const strings = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.slice(0, 100).flatMap(item => text(item, 80) ?? []))] : [];

export function validEconomicsModelId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 240
    && /^[a-zA-Z0-9][a-zA-Z0-9._:~-]*\/[a-zA-Z0-9][a-zA-Z0-9._:~-]*$/.test(value);
}

/** Exact base-ten arithmetic; preserve strings rather than rounding rates to cents. */
function decimal(value: unknown): { digits: bigint; scale: number; original: string } | null {
  if (typeof value !== 'string' || value.length > 80) return null;
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d{1,2}))?$/.exec(value);
  if (!match) return null;
  let scale = (match[2]?.length ?? 0) - Number(match[3] ?? 0);
  let digits = BigInt(match[1] + (match[2] ?? ''));
  if (scale < 0) { digits *= 10n ** BigInt(-scale); scale = 0; }
  if (scale > 30 || digits.toString().length > 40 || !Number.isFinite(Number(value))) return null;
  return { digits, scale, original: value };
}

function rates(value: unknown): EconomicsRates {
  const row = record(value) ?? {};
  const known = new Set(['prompt', 'completion', 'input_cache_read', 'input_cache_write', 'request', 'discount']);
  const conditional = Object.entries(row).some(([key, val]) => !known.has(key)
    && val !== undefined && val !== null && !(Array.isArray(val) && val.length === 0)
    && !(typeof val === 'string' && decimal(val)?.digits === 0n));
  const conditions = conditional ? JSON.stringify(row) : null;
  return {
    input: decimal(row.prompt)?.original ?? null, output: decimal(row.completion)?.original ?? null,
    cacheRead: decimal(row.input_cache_read)?.original ?? null, cacheWrite: decimal(row.input_cache_write)?.original ?? null,
    request: decimal(row.request)?.original ?? null, conditional,
    conditionsJson: conditions && conditions.length <= 24_000 ? conditions : conditional ? '{"omitted":"oversized conditions"}' : null,
  };
}

type Parsed<T> = Pick<EconomicsSnapshot<T>, 'rows' | 'received' | 'rejected' | 'truncated'>;

export function parseEconomicsModels(body: unknown): Parsed<EconomicsModel> {
  const items = record(body)?.data;
  if (!Array.isArray(items)) throw new Error('The public catalogue did not contain a model list.');
  const rows: EconomicsModel[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const item of items.slice(0, MODEL_ECONOMICS_MAX_MODELS)) {
    const row = record(item);
    if (!row || !validEconomicsModelId(row.id) || seen.has(row.id)) { rejected++; continue; }
    seen.add(row.id);
    const architecture = record(row.architecture); const top = record(row.top_provider); const reasoning = record(row.reasoning);
    rows.push({
      id: row.id, name: text(row.name) ?? row.id, revision: text(row.canonical_slug),
      contextTokens: limit(row.context_length), maxOutputTokens: limit(top?.max_completion_tokens),
      inputModalities: strings(architecture?.input_modalities), outputModalities: strings(architecture?.output_modalities),
      supportedParameters: strings(row.supported_parameters), efforts: strings(reasoning?.supported_efforts),
      reasoningMandatory: typeof reasoning?.mandatory === 'boolean' ? reasoning.mandatory : null,
      rates: rates(row.pricing),
    });
  }
  return { rows, received: items.length, rejected, truncated: items.length > MODEL_ECONOMICS_MAX_MODELS };
}

export function parseEconomicsEndpoints(body: unknown, modelId: string): Parsed<EconomicsEndpoint> {
  if (!validEconomicsModelId(modelId)) throw new Error('Invalid catalogue model id.');
  const data = record(record(body)?.data);
  const items = data?.endpoints;
  if (!Array.isArray(items)) throw new Error('The public catalogue did not contain an endpoint list.');
  if (data?.id !== undefined && data.id !== modelId) throw new Error('The endpoint catalogue returned a different model.');
  const rows: EconomicsEndpoint[] = []; const seen = new Set<string>(); let rejected = 0;
  for (const item of items.slice(0, MODEL_ECONOMICS_MAX_ENDPOINTS)) {
    const row = record(item); const tag = text(row?.tag, 160); const provider = text(row?.provider_name, 160);
    if (!row || !tag || !provider || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(tag) || seen.has(tag)) { rejected++; continue; }
    seen.add(tag);
    const rawChoices = record(row.supports_tool_choice);
    const toolChoice: EconomicsEndpoint['toolChoice'] = {};
    for (const key of ['auto', 'none', 'required', 'function'] as const) {
      if (typeof rawChoices?.[key] === 'boolean') toolChoice[key] = rawChoices[key];
    }
    rows.push({ modelId, tag, provider, quantization: text(row.quantization, 80),
      contextTokens: limit(row.context_length), maxInputTokens: limit(row.max_prompt_tokens),
      maxOutputTokens: limit(row.max_completion_tokens),
      status: typeof row.status === 'number' && Number.isInteger(row.status) ? row.status : null,
      supportedParameters: strings(row.supported_parameters), toolChoice, rates: rates(row.pricing) });
  }
  return { rows, received: items.length, rejected, truncated: items.length > MODEL_ECONOMICS_MAX_ENDPOINTS };
}

export function economicsEndpointUrl(modelId: string): string {
  if (!validEconomicsModelId(modelId)) throw new Error('Invalid catalogue model id.');
  return `${MODEL_ECONOMICS_SOURCE}/${modelId.split('/').map(encodeURIComponent).join('/')}/endpoints`;
}

export function readEconomicsSelection(value: unknown, max = MODEL_ECONOMICS_MAX_SELECTED): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || !value.every(validEconomicsModelId)) {
    throw new Error(`Select at most ${max} valid catalogue model ids.`);
  }
  return [...new Set(value)];
}

export function readEconomicsQuoteInput(value: unknown): ModelEconomicsQuoteInput {
  const row = record(value); const workload = record(row?.workload); const requirements = record(row?.requirements);
  if (!row || !workload || !requirements) throw new Error('A workload and capability requirements are required.');
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'requests']) {
    const count = workload[key];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 1_000_000_000) {
      throw new Error(`Invalid ${key} workload.`);
    }
  }
  const typed = workload as ModelEconomicsWorkload;
  if (typed.cachedInputTokens + typed.cacheWriteTokens > typed.inputTokens || typed.requests < 1) {
    throw new Error('Cache buckets must fit total input, and requests must be positive.');
  }
  if (typeof requirements.tools !== 'boolean'
    || !(requirements.effort === null || text(requirements.effort, 80))
    || !(requirements.toolChoice === null || ['auto', 'none', 'required', 'function'].includes(String(requirements.toolChoice)))) {
    throw new Error('Invalid capability requirements.');
  }
  const modelIds = row.modelIds === undefined ? undefined : readEconomicsSelection(row.modelIds, MODEL_ECONOMICS_MAX_MODELS);
  const endpointTags = row.endpointTags === undefined ? undefined : strings(row.endpointTags);
  if (row.endpointTags !== undefined && (!Array.isArray(row.endpointTags) || row.endpointTags.length > 100
    || endpointTags?.length !== row.endpointTags.length)) throw new Error('Invalid endpoint allowlist.');
  return { workload: { inputTokens: typed.inputTokens, outputTokens: typed.outputTokens, cachedInputTokens: typed.cachedInputTokens,
    cacheWriteTokens: typed.cacheWriteTokens, requests: typed.requests },
  requirements: requirements as ModelEconomicsQuoteInput['requirements'], modelIds, endpointTags };
}

function estimate(rates_: EconomicsRates, work: ModelEconomicsWorkload): { value: number; decimal: string } | null {
  if (rates_.conditional) return null;
  const components: [number, string | null][] = [
    [work.inputTokens - work.cachedInputTokens - work.cacheWriteTokens, rates_.input],
    [work.outputTokens, rates_.output], [work.cachedInputTokens, rates_.cacheRead], [work.cacheWriteTokens, rates_.cacheWrite],
  ];
  // Unreported non-token fees stay explicitly excluded in the returned quote.
  if (rates_.request !== null) components.push([work.requests, rates_.request]);
  const parsed = components.filter(([count]) => count > 0).map(([count, rate]) => ({ count, rate: decimal(rate) }));
  if (parsed.some(item => item.rate === null)) return null;
  const scale = Math.max(0, ...parsed.map(item => item.rate!.scale));
  const total = parsed.reduce((sum, item) => sum + BigInt(item.count) * item.rate!.digits * 10n ** BigInt(scale - item.rate!.scale), 0n);
  const digits = total.toString().padStart(scale + 1, '0');
  const rendered = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '') || '0' : digits;
  const value = Number(rendered);
  return Number.isFinite(value) ? { value, decimal: rendered } : null;
}

/** Model/endpoint admission only. The caller still owns tested harness support and consent. */
export function quoteEconomics(
  catalogue: EconomicsSnapshot<EconomicsModel> | null,
  endpointSnapshots: readonly EconomicsEndpointSnapshot[],
  raw: unknown, now: number,
): ModelEconomicsQuote[] {
  const input = readEconomicsQuoteInput(raw);
  if (!catalogue) return [];
  const fresh = (at: number) => Number.isFinite(at) && at <= now && now - at < MODEL_ECONOMICS_TTL_MS;
  const rows: ModelEconomicsQuote[] = [];
  for (const model of catalogue.rows) {
    if (input.modelIds && !input.modelIds.includes(model.id)) continue;
    const snapshot = endpointSnapshots.find(item => item.modelId === model.id);
    const endpoints = snapshot?.rows ?? [];
    for (const endpoint of endpoints.length ? endpoints : [null]) {
      if (input.endpointTags && (!endpoint || !input.endpointTags.includes(endpoint.tag))) continue;
      const reasons: string[] = [];
      const stale = !fresh(catalogue.fetchedAt) || (!!snapshot && !fresh(snapshot.fetchedAt));
      if (stale) reasons.push('Catalogue or endpoint prices are stale.');
      if (!endpoint) reasons.push('Endpoint capabilities and prices have not been fetched.');
      if (!model.inputModalities.includes('text') || !model.outputModalities.includes('text')) reasons.push('Text input/output is not declared.');
      if (endpoint) {
        if (endpoint.status !== 0) reasons.push('Endpoint availability is not declared healthy.');
        const { workload, requirements } = input;
        if (endpoint.contextTokens === null || workload.inputTokens + workload.outputTokens > endpoint.contextTokens) reasons.push('Context capacity is unknown or insufficient.');
        if (endpoint.maxInputTokens !== null && workload.inputTokens > endpoint.maxInputTokens) reasons.push('Input exceeds the endpoint prompt limit.');
        if (endpoint.maxOutputTokens === null || workload.outputTokens > endpoint.maxOutputTokens) reasons.push('Output capacity is unknown or insufficient.');
        if (requirements.tools && !endpoint.supportedParameters.includes('tools')) reasons.push('Tool use is not declared by the endpoint.');
        if (requirements.toolChoice !== null && endpoint.toolChoice[requirements.toolChoice] !== true) reasons.push('The requested tool-choice mode is not declared.');
        if (requirements.effort !== null && (!model.efforts.includes(requirements.effort)
          || !endpoint.supportedParameters.includes('reasoning_effort'))) reasons.push('The requested effort is not declared for this model and endpoint.');
      }
      const price = endpoint?.rates ?? model.rates;
      const quote = estimate(price, input.workload);
      if (price.conditional) reasons.push('Conditional or additional pricing requires an unsupported calculation.');
      else if (!quote) reasons.push('A required token price is unknown or invalid.');
      rows.push({ modelId: model.id, name: model.name, revision: model.revision, endpointTag: endpoint?.tag ?? null,
        provider: endpoint?.provider ?? null, quantization: endpoint?.quantization ?? null, effort: input.requirements.effort,
        catalogueSnapshotId: catalogue.id, endpointSnapshotId: snapshot?.id ?? null,
        sourceUrl: snapshot?.sourceUrl ?? catalogue.sourceUrl, fetchedAt: Math.min(catalogue.fetchedAt, snapshot?.fetchedAt ?? catalogue.fetchedAt),
        eligible: reasons.length === 0, reasons, stale, estimateUsd: quote?.value ?? null, estimateUsdDecimal: quote?.decimal ?? null,
        rates: price, excludedCharges: ['Platform fees, taxes and external tools', ...(price.request === null ? ['Unreported request charges'] : [])] });
    }
  }
  return rows.sort((a, b) => Number(b.eligible) - Number(a.eligible)
    || (a.estimateUsd ?? Infinity) - (b.estimateUsd ?? Infinity)
    || a.modelId.localeCompare(b.modelId) || (a.endpointTag ?? '').localeCompare(b.endpointTag ?? ''));
}
