import Anthropic from '@anthropic-ai/sdk';
import { getKey, getWorkspaceId } from '../keys';

export function isMock(): boolean {
  return process.env.FOREMAN_MOCK === '1';
}

let _client: Anthropic | null = null;
let _forKey: string | null = null;
let _forWorkspace: string | null = null;

export function client(): Anthropic {
  const key = getKey();
  if (!key && !isMock()) {
    throw new Error('No API key. Add one in Settings — Foreman stores it in your OS keychain.');
  }
  const workspaceId = getWorkspaceId();
  // Rebuild the client if either credential changed under us.
  if (_client && _forKey === key && _forWorkspace === workspaceId) return _client;
  _client = new Anthropic({
    apiKey: key || 'mock',
    maxRetries: 4,
    // Identity-linked keys require this on every request; plain keys ignore it.
    ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {}),
  });
  _forKey = key;
  _forWorkspace = workspaceId;
  return _client;
}

export const EXTENDED_OUTPUT_BETA = 'output-300k-2026-03-24';

export const BATCH_FORBIDDEN_PARAMS = [
  'stream', 'speed', 'store', 'previous_thread_event_id', 'cache_hint', 'context_hint',
] as const;

export function stripForbidden(params: Record<string, unknown>): { params: Record<string, unknown>; stripped: string[] } {
  const stripped: string[] = [];
  const out = { ...params };
  for (const k of BATCH_FORBIDDEN_PARAMS) {
    if (k in out) { delete out[k]; stripped.push(k); }
  }
  if (out.max_tokens === 0) { out.max_tokens = 1; stripped.push('max_tokens:0'); }
  return { params: out, stripped };
}
