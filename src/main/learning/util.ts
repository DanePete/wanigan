import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { JsonObject } from './types';

export function learningId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(',')}}`;
}

export function parseObject(value: string | null | undefined): JsonObject {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    return {};
  }
}

export function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function nonEmpty(value: string, label: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  if (Buffer.byteLength(trimmed, 'utf8') > max) {
    throw new Error(`${label} is too large (maximum ${max.toLocaleString()} bytes).`);
  }
  return trimmed;
}

export function optionalText(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (Buffer.byteLength(trimmed, 'utf8') > max) throw new Error(`Value is too large (maximum ${max.toLocaleString()} bytes).`);
  return trimmed;
}

/** Directional estimate for previews only. Provider telemetry remains truth. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const bytes = Buffer.byteLength(text, 'utf8');
  const words = text.trim() ? text.trim().split(/\s+/u).length : 0;
  return Math.max(1, Math.ceil(Math.max(bytes / 4, words * 1.25)));
}

/** Convert a conservative path glob to a regex without importing a matcher. */
export function globMatches(pattern: string, candidate: string): boolean {
  const p = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
  const c = candidate.replaceAll('\\', '/').replace(/^\.\//, '');
  let out = '^';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '*') {
      if (p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') { i++; out += '(?:.*/)?'; }
        else out += '.*';
      } else out += '[^/]*';
    } else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  try { return new RegExp(`${out}$`).test(c); } catch { return false; }
}

export function scopeMatches(pathScope: string | null, candidatePath: string | null | undefined): boolean {
  if (!pathScope) return true;
  if (!candidatePath) return false;
  const rel = path.isAbsolute(candidatePath) ? candidatePath.replace(/^\/+/, '') : candidatePath;
  return pathScope.split(/[\n,]/).map((v) => v.trim()).filter(Boolean).some((glob) => globMatches(glob, rel));
}

export function ftsExpression(query: string, match: 'all' | 'any' = 'all'): string | null {
  const terms = query.normalize('NFKC').match(/[\p{L}\p{N}_./-]+/gu)?.slice(0, 12) ?? [];
  if (!terms.length) return null;
  // Quoting means FTS operators in user input remain text. The suffix is the
  // documented FTS5 prefix query and makes filenames useful while typing.
  return terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(match === 'any' ? ' OR ' : ' AND ');
}

export function uniqueStrings(values: readonly string[], max = 500): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))].slice(0, max);
}
