import { getProviderKey } from './keys';
import { GLM_DEFAULT, GLM_SMALL } from './providers';

/**
 * The GLM model list, fetched rather than hardcoded.
 *
 * Wanigan already refuses to hardcode Anthropic's catalog — `GET /v1/models`
 * is the source of truth there, because a stale table quietly offers the wrong
 * options. Z.ai deserves the same treatment and needs it more: this file
 * shipped with `glm-4.6` as the default while the coding plan had already
 * moved through 4.7, 5.1, 5.2 and on to 5.3.
 *
 * Pricing is not fetched, and is not guessed either. A GLM coding plan is a
 * flat monthly fee rather than per-token billing, so a cost estimate here
 * would be a fiction — the Insights view says so rather than inventing one.
 */

const MODELS_URL = process.env.WANIGAN_GLM_MODELS_URL || 'https://api.z.ai/api/paas/v4/models';

export type GlmModel = { id: string; label: string; source: 'api' | 'fallback' };

/** What we know shipped, newest first. Used only when the fetch cannot run. */
const FALLBACK: GlmModel[] = [
  { id: 'glm-5.3', label: 'GLM 5.3', source: 'fallback' },
  { id: 'glm-5.3-flash', label: 'GLM 5.3 Flash', source: 'fallback' },
  { id: 'glm-5.2', label: 'GLM 5.2', source: 'fallback' },
  { id: 'glm-5-turbo', label: 'GLM 5 Turbo', source: 'fallback' },
  { id: 'glm-4.7', label: 'GLM 4.7', source: 'fallback' },
  { id: 'glm-4.5-air', label: 'GLM 4.5 Air', source: 'fallback' },
];

let cache: { at: number; models: GlmModel[]; note: string | null } | null = null;
const TTL_MS = 6 * 3600_000;

function pretty(id: string): string {
  return id
    .replace(/^glm-?/i, 'GLM ')
    .replace(/-/g, ' ')
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .trim();
}

export async function glmModels(force = false): Promise<{ models: GlmModel[]; note: string | null; fetchedAt: number | null }> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) {
    return { models: cache.models, note: cache.note, fetchedAt: cache.at };
  }
  const key = getProviderKey('glm');
  if (!key) {
    return {
      models: FALLBACK, fetchedAt: null,
      note: 'No Z.ai key yet, so this is Wanigan’s local list. Add the key in Settings and it will read the live catalog.',
    };
  }
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12_000);
    const r = await fetch(MODELS_URL, {
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = (await r.json()) as { data?: { id?: unknown }[] };
    const ids = (body.data ?? [])
      .map((m) => (typeof m.id === 'string' ? m.id : ''))
      .filter((id) => id && /glm/i.test(id));
    if (!ids.length) throw new Error('the catalog returned no GLM models');

    // Newest first, by the version number in the id.
    const models: GlmModel[] = ids
      .map((id) => ({ id, label: pretty(id), source: 'api' as const }))
      .sort((a, b) => {
        const v = (s: string) => Number((/(\d+(?:\.\d+)?)/.exec(s)?.[1]) ?? 0);
        return v(b.id) - v(a.id) || a.id.localeCompare(b.id);
      });
    cache = { at: Date.now(), models, note: null };
    return { models, note: null, fetchedAt: cache.at };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const note = `Could not read Z.ai's catalog (${detail}), so this is Wanigan's local list and may be behind.`;
    cache = { at: Date.now(), models: FALLBACK, note };
    return { models: FALLBACK, note, fetchedAt: null };
  }
}

/** The best available default, preferring what the API actually reports. */
export async function glmDefaults(): Promise<{ model: string; small: string }> {
  const { models } = await glmModels();
  const newest = models[0]?.id ?? GLM_DEFAULT;
  const flash = models.find((m) => /flash|air|turbo/i.test(m.id))?.id ?? GLM_SMALL;
  return { model: newest, small: flash };
}
