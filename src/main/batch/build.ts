import type { RunConfig } from '../../shared/types';
import { customIdFor, render, missingSlots, type Row } from './template';
import { modelFor } from './pricing';

/** Hard caps from the Batches API. */
export const MAX_REQUESTS_PER_BATCH = 100_000;
export const MAX_BATCH_BYTES = 256 * 1024 * 1024;
/** Leave headroom so JSON framing overhead can't push a chunk over the wire limit. */
const BYTE_BUDGET = Math.floor(MAX_BATCH_BYTES * 0.92);

export type BuiltRequest = {
  custom_id: string;
  params: Record<string, unknown>;
  /** Bookkeeping, not sent to the API. */
  rowIndex: number;
  row: Row;
  rendered: string;
  bytes: number;
};

export type BuildResult = {
  requests: BuiltRequest[];
  chunks: BuiltRequest[][];
  warnings: string[];
  errors: string[];
};

export function buildRequests(cfg: RunConfig, rows: Row[], columns: string[]): BuildResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const model = modelFor(cfg.model);

  if (!rows.length) errors.push('Dataset is empty — nothing to submit.');

  const missing = missingSlots(cfg.userTemplate, columns);
  if (missing.length) {
    errors.push(`Template references column(s) the dataset does not have: ${missing.join(', ')}`);
  }

  if (cfg.maxTokens < 1) errors.push('max_tokens must be at least 1 (max_tokens: 0 is not supported in a batch).');
  const cap = cfg.extendedOutput ? 300_000 : model.maxTokens;
  if (cfg.maxTokens > cap) {
    errors.push(`max_tokens ${cfg.maxTokens.toLocaleString()} exceeds the ${cap.toLocaleString()} cap for ${model.label}${cfg.extendedOutput ? ' with extended output' : ''}.`);
  }
  if (cfg.extendedOutput && !model.extendedOutput) {
    errors.push(`${model.label} does not support the extended-output beta.`);
  }

  const system = buildSystem(cfg);
  if (cfg.system.some((b) => b.cache) && rows.length < 2) {
    warnings.push('Prompt caching is on but the batch has fewer than 2 requests — there is nothing to hit the cache.');
  }

  const seen = new Set<string>();
  const requests: BuiltRequest[] = rows.map((row, i) => {
    let custom_id = customIdFor(i, row, cfg.keyColumn);
    if (seen.has(custom_id)) custom_id = `${custom_id.slice(0, 58)}-${i}`.slice(0, 64);
    seen.add(custom_id);

    const rendered = render(cfg.userTemplate, row);
    const params: Record<string, unknown> = {
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      messages: [{ role: 'user', content: rendered }],
    };
    if (system.length) params.system = system;
    if (typeof cfg.temperature === 'number') params.temperature = cfg.temperature;
    // output_config carries both structured output and effort. `output_format`
    // is the deprecated spelling and the Python SDK 1.x rejects it outright.
    const outputConfig: Record<string, unknown> = {};
    if (cfg.effort) outputConfig.effort = cfg.effort;
    if (cfg.schemaJson?.trim()) {
      try {
        outputConfig.format = { type: 'json_schema', schema: JSON.parse(cfg.schemaJson) };
      } catch {
        if (i === 0) errors.push('Structured output schema is not valid JSON.');
      }
    }
    if (Object.keys(outputConfig).length) params.output_config = outputConfig;

    if (cfg.thinking === 'adaptive') {
      params.thinking = { type: 'adaptive', display: cfg.thinkingDisplay ?? 'omitted' };
    }

    const bytes = Buffer.byteLength(JSON.stringify({ custom_id, params }), 'utf8');
    return { custom_id, params, rowIndex: i, row, rendered, bytes };
  });

  if (cfg.schemaJson?.trim()) {
    try {
      const schema = JSON.parse(cfg.schemaJson) as Record<string, unknown>;
      // The API rejects object schemas that omit these, and the failure only
      // surfaces when the whole batch ends.
      if (schema.type === 'object') {
        if (schema.additionalProperties !== false) {
          errors.push('Structured output schema must set "additionalProperties": false on every object.');
        }
        if (!Array.isArray(schema.required)) {
          errors.push('Structured output schema must list "required" fields.');
        }
      }
      for (const kw of ['minimum', 'maximum', 'multipleOf', 'pattern']) {
        if (JSON.stringify(schema).includes(`"${kw}"`)) {
          warnings.push(`Schema uses "${kw}", which structured outputs does not support — it will be ignored or rejected.`);
        }
      }
    } catch { /* the parse error is already reported per-row */ }
  }

  if (cfg.effort && !cfg.system.every((b) => !b.cache)) {
    warnings.push('Effort is part of the rendered prompt, so it must stay constant across the run for the cache to hit — it is set once here, which is correct.');
  }

  const empties = requests.filter((r) => !r.rendered.trim()).length;
  if (empties) warnings.push(`${empties} row(s) render to an empty prompt — check for blank source columns.`);

  const chunks = chunk(requests, warnings);
  return { requests, chunks, warnings, errors };
}

/**
 * System blocks. Cached blocks must be byte-identical across every request in
 * the batch or the cache never hits — which is why the cached text lives in the
 * run config, not in the per-row template.
 */
function buildSystem(cfg: RunConfig) {
  return cfg.system
    .filter((b) => b.text.trim())
    .map((b) =>
      b.cache
        ? { type: 'text', text: b.text, cache_control: { type: 'ephemeral', ttl: cfg.cacheTtl } }
        : { type: 'text', text: b.text }
    );
}

function chunk(requests: BuiltRequest[], warnings: string[]): BuiltRequest[][] {
  const out: BuiltRequest[][] = [];
  let cur: BuiltRequest[] = [];
  let bytes = 0;

  for (const r of requests) {
    if (r.bytes > BYTE_BUDGET) {
      warnings.push(`Row ${r.rowIndex} alone is ${(r.bytes / 1e6).toFixed(1)} MB and cannot fit in any batch — it will be skipped.`);
      continue;
    }
    if (cur.length >= MAX_REQUESTS_PER_BATCH || bytes + r.bytes > BYTE_BUDGET) {
      out.push(cur); cur = []; bytes = 0;
    }
    cur.push(r); bytes += r.bytes;
  }
  if (cur.length) out.push(cur);
  if (out.length > 1) {
    warnings.push(`Dataset exceeds one batch — splitting into ${out.length} batches (caps: 100,000 requests / 256 MB each).`);
  }
  return out;
}
