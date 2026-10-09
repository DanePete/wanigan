// What the window may ask of the live view for a hosted environment or a
// comparison, checked in the main process before any window or session is
// made. No Electron here, so it is tested on its own.
import { COMPARE_WIDTHS, type CompareWidth } from '../shared/live-compare.ts';
import { liveUrl } from '../shared/live.ts';

/** A hosted environment's id as the window sends it; null for anything else. */
export function envId(raw: unknown): string | null {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : null;
}

/** A page of a hosted environment: https only (its certificate is always checked), no credentials. */
export function hostedPage(raw: unknown): string | null {
  const url = liveUrl(raw);
  return url && url.startsWith('https://') ? url : null;
}

export interface CompareRequest { projectId: string; url: string; env: string | null; width: CompareWidth; token: string | null; scan: boolean }

/** A comparison's picture as the window asked for it, or null: anything malformed is refused before a window is made. */
export function compareRequest(raw: unknown): CompareRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const projectId = typeof r.projectId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(r.projectId) ? r.projectId : null;
  const env = r.env === null || r.env === undefined ? null : envId(r.env);
  if (!projectId || (r.env !== null && r.env !== undefined && !env)) return null;
  const url = env ? hostedPage(r.url) : liveUrl(r.url);
  const width = (COMPARE_WIDTHS as readonly unknown[]).includes(r.width) ? r.width as CompareWidth : null;
  if (!url || !width) return null;
  // The helper's token belongs to the local site: a hosted environment is never sent it.
  const token = !env && typeof r.token === 'string' && /^[0-9a-f]{16,128}$/.test(r.token) ? r.token : null;
  return { projectId, url, env, width, token, scan: r.scan === true };
}
