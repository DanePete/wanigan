/**
 * Whether the next message into a Claude Code session will likely find its
 * prompt cache cold, and how big a re-read that is.
 *
 * The lifetime rules come from the 2.1.271 binary's own settings schema:
 * `promptCacheTtl` is "5m" or "1h"; unset means 1 hour on a Claude subscription
 * within its usage limits and 5 minutes on an API key, Bedrock, Vertex or
 * Foundry; and CLAUDE_CODE_PROMPT_CACHE_TTL takes precedence over the setting.
 *
 * Only a pinned value is a fact. Everything else is inferred, and the note says
 * which evidence the inference stood on: this session's own cache writes (a
 * 1-hour write is the cache tier actually in use), or the account's sign-in
 * method as Claude Code last reported it. With neither, the lifetime is
 * unknown and the note waits until an hour has passed, which is past both.
 *
 * It is a note. Nothing here blocks, delays or rewrites a send.
 */

export type CacheTtlBasis =
  | 'pinned-env' | 'pinned-setting' | 'observed-writes' | 'account-subscription' | 'account-api-key' | 'unknown';

export type CacheTtl = { minutes: number | null; basis: CacheTtlBasis };

export function parseTtl(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return v === '5m' ? 5 : v === '1h' ? 60 : null;
}

export function inferCacheTtl(input: {
  envTtl: string | null | undefined;
  settingTtl: unknown;
  /** Tokens written to each cache tier by this session's most recent cache-writing request. */
  recentWrite: { fiveMinute: number; oneHour: number } | null;
  /** Claude Code's `authMethod` for the account, e.g. "claude.ai"; null when never read. */
  authMethod: string | null;
  /** ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in the environment sessions inherit. */
  apiKeyInEnvironment: boolean;
}): CacheTtl {
  const env = parseTtl(input.envTtl);
  if (env !== null) return { minutes: env, basis: 'pinned-env' };
  const setting = parseTtl(input.settingTtl);
  if (setting !== null) return { minutes: setting, basis: 'pinned-setting' };
  if (input.recentWrite && input.recentWrite.oneHour + input.recentWrite.fiveMinute > 0) {
    return { minutes: input.recentWrite.oneHour > 0 ? 60 : 5, basis: 'observed-writes' };
  }
  if (input.apiKeyInEnvironment) return { minutes: 5, basis: 'account-api-key' };
  const method = (input.authMethod ?? '').toLowerCase();
  if (method === 'claude.ai' || method.includes('oauth') || method.includes('subscription')) return { minutes: 60, basis: 'account-subscription' };
  if (method.includes('api')) return { minutes: 5, basis: 'account-api-key' };
  return { minutes: null, basis: 'unknown' };
}

const BASIS: Record<CacheTtlBasis, string> = {
  'pinned-env': 'pinned by CLAUDE_CODE_PROMPT_CACHE_TTL',
  'pinned-setting': 'pinned by promptCacheTtl in settings',
  'observed-writes': 'inferred from this session’s cache writes',
  'account-subscription': 'inferred: subscription account',
  'account-api-key': 'inferred: API-key account',
  unknown: 'lifetime not known',
};

export function coldCacheNote(input: {
  now: number;
  lastTurnEndedAt: number | null;
  ttl: CacheTtl;
  contextTokens: number | null;
}): { idleMinutes: number; tokens: number | null; text: string } | null {
  if (input.lastTurnEndedAt === null || input.lastTurnEndedAt > input.now) return null;
  const idleMinutes = Math.floor((input.now - input.lastTurnEndedAt) / 60_000);
  const threshold = input.ttl.minutes ?? 60;
  if (idleMinutes < threshold) return null;
  const size = input.contextTokens && input.contextTokens > 0
    ? `~${input.contextTokens.toLocaleString('en-US')} tokens`
    : 'the whole conversation';
  const lifetime = input.ttl.minutes === null
    ? 'past either cache lifetime (5 min or 1 h)'
    : `cache lifetime ${input.ttl.minutes === 60 ? '1 h' : '5 min'}, ${BASIS[input.ttl.basis]}`;
  return {
    idleMinutes,
    tokens: input.contextTokens,
    text: `Idle ${idleMinutes} min: this message likely re-reads ${size} without cache (estimate; ${lifetime}).`,
  };
}
