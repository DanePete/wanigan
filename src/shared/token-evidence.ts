/** Unknown buckets remain null, including unsupported cache-write/reasoning meters. */
export type TokenCounts = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
};

export function unknownTokenCounts(): TokenCounts {
  return { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null };
}

export type CodexTokenPoint = { at: number; counts: TokenCounts };
export type CodexTokenHistory = { createdAt: number | null; points: CodexTokenPoint[] };
export type FrozenTokenEvidence = {
  source: 'otel' | 'codex-rollout' | 'unavailable';
  scope: 'session' | 'session-window-delta' | 'conversation-only' | 'unavailable';
  counts: TokenCounts;
  observedAt: number | null;
  conversationId: string | null;
  conversationTotals: TokenCounts | null;
  baselineAt: number | null;
};

function counter(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/** Parse an already bounded rollout tail. A missing prefix cannot establish a new thread. */
export function codexTokenHistory(text: string, completeFromStart: boolean, conversationId: string): CodexTokenHistory {
  const history: CodexTokenHistory = { createdAt: null, points: [] };
  for (const line of text.split('\n')) {
    try {
      const raw = JSON.parse(line) as { type?: string; timestamp?: string;
        payload?: { id?: string; type?: string; info?: { total_token_usage?: Record<string, unknown> } } };
      const at = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : NaN;
      if (!Number.isFinite(at)) continue;
      if (completeFromStart && raw.type === 'session_meta' && raw.payload?.id?.toLowerCase() === conversationId.toLowerCase()) {
        history.createdAt = history.createdAt === null ? at : Math.min(history.createdAt, at);
      }
      if (raw.payload?.type !== 'token_count') continue;
      const usage = raw.payload.info?.total_token_usage;
      if (!usage) continue;
      const input = counter(usage.input_tokens);
      const cache = counter(usage.cached_input_tokens);
      history.points.push({ at, counts: {
        inputTokens: input !== null && cache !== null && cache <= input ? input - cache : null,
        cacheReadTokens: cache !== null && (input === null || cache <= input) ? cache : null,
        outputTokens: counter(usage.output_tokens), cacheWriteTokens: null,
        reasoningTokens: counter(usage.reasoning_output_tokens),
      } });
    } catch { /* incomplete tail line, invalid JSON, or unrelated record */ }
  }
  history.points.sort((a, b) => a.at - b.at);
  return history;
}

/**
 * A cumulative thread total is not a session total. Attribute only observed
 * nondecreasing deltas with a baseline, and never across recorded overlapping
 * sessions. Counts from before a missing tail boundary stay conversation-only.
 */
export function codexSessionTokenEvidence(history: CodexTokenHistory, input: {
  conversationId: string; startedAt: number; endedAt: number | null; asOf: number; overlaps: boolean;
}): FrozenTokenEvidence {
  const through = Math.min(input.endedAt ?? input.asOf, input.asOf);
  const eligible = history.points.filter(point => point.at <= through);
  const end = eligible.at(-1);
  const evidence: FrozenTokenEvidence = {
    source: end ? 'codex-rollout' : 'unavailable', scope: end ? 'conversation-only' : 'unavailable',
    counts: unknownTokenCounts(), observedAt: end?.at ?? null,
    conversationId: input.conversationId, conversationTotals: end?.counts ?? null, baselineAt: null,
  };
  if (!end || end.at < input.startedAt || input.overlaps || !Number.isFinite(input.startedAt)) return evidence;
  const previous = eligible.filter(point => point.at < input.startedAt).at(-1);
  const newThread = history.createdAt !== null && history.createdAt >= input.startedAt && history.createdAt <= end.at;
  if (!previous && !newThread) return evidence;
  const baseline = previous?.counts ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: null, reasoningTokens: 0 };
  evidence.baselineAt = previous?.at ?? history.createdAt;
  for (const key of Object.keys(evidence.counts) as (keyof TokenCounts)[]) {
    const before = baseline[key]; const after = end.counts[key];
    // A reset/decrease makes the whole window unsafe: later increases cannot
    // repair a lost cumulative history for this bucket.
    const window = eligible.filter(point => point.at >= input.startedAt);
    let last = before;
    const monotonic = window.every(point => {
      const value = point.counts[key];
      if (last === null || value === null || value < last) return false;
      last = value; return true;
    });
    evidence.counts[key] = before !== null && after !== null && monotonic ? after - before : null;
  }
  evidence.scope = 'session-window-delta';
  return evidence;
}
