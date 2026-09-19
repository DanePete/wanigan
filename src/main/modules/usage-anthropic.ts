import Anthropic from '@anthropic-ai/sdk';
import { getKey, getWorkspaceId } from '../keys';

export function isMock(): boolean {
  return process.env.WANIGAN_MOCK === '1';
}

let _client: Anthropic | null = null;
let _forKey: string | null = null;
let _forWorkspace: string | null = null;

export function client(): Anthropic {
  const key = getKey();
  if (!key && !isMock()) {
    throw new Error('No API key. Add one in Settings — Wanigan stores it in your OS keychain.');
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


/**
 * The API reports an exhausted balance as a 400, which reads like a malformed
 * request. Name it for what it is.
 */
export function explainApiError(e: unknown): string {
  const err = e as { status?: number; message?: string; error?: { error?: { type?: string; message?: string } } };
  const msg = err.error?.error?.message ?? err.message ?? String(e);
  const low = msg.toLowerCase();

  if (low.includes('credit') || low.includes('insufficient') || low.includes('billing') || low.includes('quota')) {
    return `${msg}\n\nThis is a billing limit, not a bad request — add funds in the Console under Billing.`;
  }
  if (low.includes('anthropic-workspace-id')) {
    return 'This key is identity-linked and must name the workspace it acts in. Add the Workspace ID in Settings.';
  }
  if (err.status === 429) {
    return `${msg}\n\nRate limited. Batch throughput is shared across your organisation; the batch will retry on its own.`;
  }
  return msg;
}
