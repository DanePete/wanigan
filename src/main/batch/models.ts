import { db } from '../db';
import { getKey } from '../keys';
import { isMock } from './anthropic';
import { MODELS as FALLBACK } from './pricing';
import type { ModelInfo } from '../../shared/types';

/**
 * The model catalog comes from GET /v1/models, not a hardcoded table.
 *
 * The API returns max_input_tokens, max_tokens and a full capabilities object
 * (batch, effort levels, structured_outputs, thinking types, citations, pdf,
 * code_execution). Hardcoding any of that guarantees drift: a new model ships,
 * an effort level is added, and a stale table quietly offers the wrong options.
 * Pricing is the one thing the API does not return, so it stays local.
 */

const CACHE_TTL_MS = 24 * 3600_000;

function ensureTable() {
  db().exec(`
    CREATE TABLE IF NOT EXISTS model_cache (
      id           TEXT PRIMARY KEY,
      json         TEXT NOT NULL,
      fetched_at   INTEGER NOT NULL
    );
  `);
}

type ApiModel = {
  id: string;
  display_name: string;
  created_at: string;
  max_input_tokens: number | null;
  max_tokens: number | null;
  capabilities: {
    batch?: { supported: boolean };
    citations?: { supported: boolean };
    code_execution?: { supported: boolean };
    structured_outputs?: { supported: boolean };
    image_input?: { supported: boolean };
    pdf_input?: { supported: boolean };
    effort?: {
      supported: boolean;
      low?: { supported: boolean }; medium?: { supported: boolean };
      high?: { supported: boolean }; xhigh?: { supported: boolean } | null;
      max?: { supported: boolean };
    };
    thinking?: {
      supported: boolean;
      types?: { adaptive?: { supported: boolean }; enabled?: { supported: boolean } };
    };
  } | null;
};

function toModelInfo(m: ApiModel): ModelInfo {
  const price = FALLBACK.find((f) => f.id === m.id);
  const eff = m.capabilities?.effort;
  const efforts: string[] = [];
  if (eff?.supported) {
    for (const lvl of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const v = eff[lvl];
      if (v && v.supported) efforts.push(lvl);
    }
  }
  return {
    id: m.id,
    label: m.display_name || m.id,
    createdAt: m.created_at,
    maxInputTokens: m.max_input_tokens && m.max_input_tokens > 0 ? m.max_input_tokens : null,
    maxTokens: m.max_tokens && m.max_tokens > 0 ? m.max_tokens : (price?.maxTokens ?? 64_000),
    supportsBatch: m.capabilities?.batch?.supported ?? true,
    supportsStructuredOutputs: m.capabilities?.structured_outputs?.supported ?? false,
    supportsCitations: m.capabilities?.citations?.supported ?? false,
    efforts,
    thinkingAdaptive: m.capabilities?.thinking?.types?.adaptive?.supported ?? false,
    thinkingEnabled: m.capabilities?.thinking?.types?.enabled?.supported ?? false,
    // Pricing is not in the API response; batch rates are 50% of list.
    batchInput: price?.batchInput ?? null,
    batchOutput: price?.batchOutput ?? null,
    extendedOutput: price?.extendedOutput ?? false,
    pricingKnown: Boolean(price),
  };
}

/** Locally-known models, used before a fetch and when offline. */
function fallbackCatalog(): ModelInfo[] {
  return FALLBACK.map((m) => ({
    id: m.id, label: m.label, createdAt: null,
    maxInputTokens: null, maxTokens: m.maxTokens,
    supportsBatch: true, supportsStructuredOutputs: true, supportsCitations: false,
    efforts: [], thinkingAdaptive: false, thinkingEnabled: false,
    batchInput: m.batchInput, batchOutput: m.batchOutput,
    extendedOutput: m.extendedOutput, pricingKnown: true,
  }));
}

export function cachedModels(): { models: ModelInfo[]; fetchedAt: number | null; stale: boolean } {
  ensureTable();
  const rows = db().prepare('SELECT json, fetched_at FROM model_cache ORDER BY rowid').all() as
    { json: string; fetched_at: number }[];
  if (!rows.length) return { models: fallbackCatalog(), fetchedAt: null, stale: true };
  const fetchedAt = rows[0].fetched_at;
  return {
    models: rows.map((r) => JSON.parse(r.json) as ModelInfo),
    fetchedAt,
    stale: Date.now() - fetchedAt > CACHE_TTL_MS,
  };
}

export async function refreshModels(): Promise<{ models: ModelInfo[]; fetchedAt: number; source: string }> {
  ensureTable();
  const key = getKey();
  if (!key || isMock()) {
    const models = fallbackCatalog();
    return { models, fetchedAt: Date.now(), source: isMock() ? 'mock' : 'no key — local table' };
  }

  const all: ApiModel[] = [];
  let after: string | null = null;
  // The endpoint paginates; a workspace can see more than one page.
  for (let page = 0; page < 10; page++) {
    const url = new URL('https://api.anthropic.com/v1/models');
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after_id', after);
    const r = await fetch(url, {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
    if (!r.ok) throw new Error(`Models API returned HTTP ${r.status}`);
    const body = (await r.json()) as { data: ApiModel[]; has_more: boolean; last_id: string | null };
    all.push(...body.data);
    if (!body.has_more || !body.last_id) break;
    after = body.last_id;
  }

  const models = all.map(toModelInfo).filter((m) => m.supportsBatch);
  const now = Date.now();
  const d = db();
  d.exec('DELETE FROM model_cache');
  const ins = d.prepare('INSERT INTO model_cache (id, json, fetched_at) VALUES (?,?,?)');
  d.transaction((ms: ModelInfo[]) => { for (const m of ms) ins.run(m.id, JSON.stringify(m), now); })(models);

  return { models, fetchedAt: now, source: 'Models API' };
}

export function modelInfo(id: string): ModelInfo | undefined {
  return cachedModels().models.find((m) => m.id === id);
}
