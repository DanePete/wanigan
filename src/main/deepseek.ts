import { getProviderKey } from './keys';
import { DEEPSEEK_DEFAULT, DEEPSEEK_SMALL } from './providers';

/** DeepSeek exposes both OpenAI and Anthropic-compatible API surfaces. */
const MODELS_URL = process.env.WANIGAN_DEEPSEEK_MODELS_URL || 'https://api.deepseek.com/models';
const TTL_MS = 6 * 3600_000;

export type DeepSeekModel = { id: string; label: string; source: 'api' | 'fallback' };
const FALLBACK: DeepSeekModel[] = [
  { id: DEEPSEEK_DEFAULT, label: 'DeepSeek V4 Pro', source: 'fallback' },
  { id: DEEPSEEK_SMALL, label: 'DeepSeek V4 Flash', source: 'fallback' },
];
let cache: { at: number; models: DeepSeekModel[]; note: string | null } | null = null;

function pretty(id: string): string {
  return id.replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function read(token: string): Promise<DeepSeekModel[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12_000);
  try {
    const response = await fetch(MODELS_URL, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, signal: ctl.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json() as { data?: Array<{ id?: unknown }> };
    const ids = (body.data ?? []).map((item) => typeof item.id === 'string' ? item.id.trim() : '').filter(Boolean);
    if (!ids.length) throw new Error('the catalog returned no models');
    return ids.map((id) => ({ id, label: pretty(id), source: 'api' as const }));
  } finally { clearTimeout(timer); }
}

export async function deepseekModels(force = false): Promise<{ models: DeepSeekModel[]; note: string | null; fetchedAt: number | null }> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return { models: cache.models, note: cache.note, fetchedAt: cache.at };
  const key = getProviderKey('deepseek');
  if (!key) return { models: FALLBACK, fetchedAt: null, note: 'No DeepSeek key yet, so this is Wanigan’s local fallback list.' };
  try {
    const models = await read(key);
    cache = { at: Date.now(), models, note: null };
    return { models, note: null, fetchedAt: cache.at };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const note = `Could not read DeepSeek’s model catalog (${detail}), so this is Wanigan’s local fallback list.`;
    cache = { at: Date.now(), models: FALLBACK, note };
    return { models: FALLBACK, note, fetchedAt: null };
  }
}

/** Validate before a credential is persisted, against the same account catalog sessions use. */
export async function verifyDeepSeekKey(key = getProviderKey('deepseek')): Promise<{ ok: boolean; detail: string; models: DeepSeekModel[] }> {
  const token = key?.trim();
  if (!token) return { ok: false, detail: 'No DeepSeek API key is set.', models: [] };
  try {
    const models = await read(token);
    cache = { at: Date.now(), models, note: null };
    return { ok: true, detail: `${models.length} DeepSeek model${models.length === 1 ? '' : 's'} available.`, models };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `DeepSeek rejected the key or could not be reached (${detail}).`, models: [] };
  }
}
