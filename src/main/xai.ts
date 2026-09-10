import { getProviderKey } from './keys';
import { XAI_DEFAULT, XAI_SMALL } from './providers';

/**
 * The Grok model list, fetched rather than hardcoded.
 *
 * Same treatment as Anthropic's catalog and Z.ai's: a stale table quietly
 * offers the wrong options, and xAI ships model ids faster than a release of
 * this app. The launch environment's fallbacks are the only hardcoded ids, and
 * they exist because a session must still start when the catalog is
 * unreachable.
 *
 * Note the two different hosts. xAI serves the Anthropic-compatible surface at
 * the root (`https://api.x.ai`) and the OpenAI-compatible one under `/v1`; the
 * catalog lives on the `/v1` side, so this file reads a different URL from the
 * one sessions post to. They are the same service.
 *
 * Pricing is not fetched and is not guessed. xAI bills API usage as
 * pay-as-you-go credits bought at console.x.ai, and — unlike a Claude or Codex
 * subscription — a Grok Pro plan grants none of it. Wanigan therefore reports
 * this backend's cost basis as unverified rather than reconciling it against a
 * plan that is not paying for these tokens.
 */

const MODELS_URL = process.env.WANIGAN_XAI_MODELS_URL || 'https://api.x.ai/v1/models';
const TTL_MS = 6 * 3600_000;

export type XaiModel = { id: string; label: string; source: 'api' | 'fallback' };

/** What we know shipped, newest first. Used only when the fetch cannot run. */
const FALLBACK: XaiModel[] = [
  { id: XAI_DEFAULT, label: 'Grok 4.6', source: 'fallback' },
  { id: 'grok-4.5', label: 'Grok 4.5', source: 'fallback' },
  { id: 'grok-4.3', label: 'Grok 4.3', source: 'fallback' },
  { id: XAI_SMALL, label: 'Grok Build 0.1', source: 'fallback' },
];

let cache: { at: number; models: XaiModel[]; note: string | null } | null = null;

function pretty(id: string): string {
  return id.replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function read(token: string): Promise<XaiModel[]> {
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
    // The catalog lists image, video and voice models alongside the text ones.
    // A session launched against those fails at the first turn, so they are not
    // offered as a choice here.
    const text = ids.filter((id) => !/imagine|voice|image|video|embed/i.test(id));
    if (!text.length) throw new Error('the catalog returned no text models');
    return text.map((id) => ({ id, label: pretty(id), source: 'api' as const }));
  } finally { clearTimeout(timer); }
}

export async function xaiModels(force = false): Promise<{ models: XaiModel[]; note: string | null; fetchedAt: number | null }> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return { models: cache.models, note: cache.note, fetchedAt: cache.at };
  const key = getProviderKey('xai');
  if (!key) return { models: FALLBACK, fetchedAt: null, note: 'No xAI key yet, so this is Wanigan’s local fallback list.' };
  try {
    const models = await read(key);
    cache = { at: Date.now(), models, note: null };
    return { models, note: null, fetchedAt: cache.at };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const note = `Could not read xAI’s model catalog (${detail}), so this is Wanigan’s local fallback list.`;
    cache = { at: Date.now(), models: FALLBACK, note };
    return { models: FALLBACK, note, fetchedAt: null };
  }
}

/** Validate before a credential is persisted, against the same catalog sessions use. */
export async function verifyXaiKey(key = getProviderKey('xai')): Promise<{ ok: boolean; detail: string; models: XaiModel[] }> {
  const token = key?.trim();
  if (!token) return { ok: false, detail: 'No xAI API key is set.', models: [] };
  try {
    const models = await read(token);
    cache = { at: Date.now(), models, note: null };
    return { ok: true, detail: `${models.length} Grok model${models.length === 1 ? '' : 's'} available.`, models };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `xAI rejected the key or could not be reached (${detail}).`, models: [] };
  }
}
