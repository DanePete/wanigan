import type { ClaudeContextUsage, ProviderId, ProviderInfo, Session, SessionUsage } from './types';

/**
 * The compact status control in the application header is about the session
 * the operator is looking at, never about whichever CLI happens to be
 * installed.  Keep this resolver shared and deliberately small: renderer
 * presentation can evolve without teaching it to guess an account limit for a
 * provider that has not exposed one.
 */
export type SelectedProviderStatus = {
  /** Changes whenever selection moves, including between two sessions on one provider. */
  key: string;
  providerId: string;
  /** Prefer the frozen launch profile, so history survives a pack rename. */
  label: string;
  /** Codex is currently the only provider with a trustworthy account-limit reader. */
  usesCodexAccountLimits: boolean;
  /** Claude-harness sessions have a transcript whose usage records measure context. */
  usesClaudeContextMeter: boolean;
};

function humanizeProviderId(id: string): string {
  return id
    .split(/[-_./]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ') || 'Provider';
}

/**
 * Whether this session runs the reviewed Claude Code harness — the one that
 * writes a readable transcript and understands /compact. The id list covers
 * only legacy rows from before harnessId was recorded; the main process gates
 * again with its own provider registry before reading anything.
 */
export function runsClaudeHarness(session: Pick<Session, 'harnessId' | 'providerId'>): boolean {
  return session.harnessId
    ? session.harnessId === 'claude-code'
    : ['claude', 'glm', 'deepseek'].includes(session.providerId);
}

/**
 * The accent a provider is drawn in, as a token name from index.css — never a
 * literal colour, so light and dark each keep their own value for one provider.
 *
 * This table used to be copied into Sessions, Fleet and NewSessionDialog, and
 * the three copies had already drifted apart: only the dialog knew DeepSeek's
 * colour, so a running DeepSeek session drew a rail dot in nothing at all.
 * Nothing complained: those lookups were typed `Record<string, string>`, which
 * calls a miss a `string` rather than `undefined`, React drops an undefined
 * background, and `.session-item .dot` paints none of its own.
 */
const PROVIDER_TINT = new Map<string, string>([
  ['claude', 'var(--claude)'],
  ['codex', 'var(--codex)'],
  ['glm', 'var(--glm)'],
  ['deepseek', 'var(--series-4)'],
  // A series token rather than a new brand one: adding a colour would mean
  // editing index.css for both themes, and the point of this table is that a
  // provider without an entry silently draws no dot at all.
  ['xai', 'var(--series-3)'],
]);

/**
 * A provider id is an opaque string — an installed pack coins ids no build of
 * Wanigan has heard of — so an unknown id is expected, not an error. Answer the
 * neutral accent for it: a profile drawn in the house colour still reads as a
 * provider, where an unset colour reads as a missing session.
 *
 * A Map, not an object literal, because the ids reaching here come from local
 * pack manifests and manifests are untrusted data. A plain object answers
 * `providerTint('toString')` with an inherited Object.prototype function, which
 * React would then hand to a `background` or `color` as a style value; a Map
 * has no inherited keys, so every id this table does not list falls through to
 * the accent.
 */
export function providerTint(providerId: ProviderId): string {
  return PROVIDER_TINT.get(providerId) ?? 'var(--accent)';
}

/** Return null until there is an actual selected session; never default to Codex. */
export function selectedProviderStatus(
  session: Session | null,
  providers: readonly ProviderInfo[],
): SelectedProviderStatus | null {
  if (!session) return null;
  const registered = providers.find((provider) => provider.id === session.providerId);
  const frozenLabel = session.providerProfile?.label?.trim();
  const label = frozenLabel || registered?.label?.trim() || humanizeProviderId(session.providerId);

  return {
    key: `${session.id}:${session.providerId}`,
    providerId: session.providerId,
    label,
    // Most alternative profiles use the Claude Code harness, so harness alone
    // must never make them look like Claude. A Codex-harness profile does use
    // Codex's own account reader, while its visible label stays profile-owned.
    usesCodexAccountLimits: session.providerId === 'codex' || session.harnessId === 'codex',
    // The meter follows the harness that writes the transcript.
    usesClaudeContextMeter: runsClaudeHarness(session),
  };
}

function compactCount(value: number): string {
  const count = Math.max(0, Math.round(value));
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
}

/**
 * This is session telemetry, not an account quota.  In particular it carries
 * no remaining-percent or reset promise, which prevents a Claude/GLM/DeepSeek
 * session from inheriting a stale Codex plan number in the header.
 */
export function selectedSessionTelemetry(
  usage: SessionUsage | null | undefined,
  sessionStatus: Session['status'],
): string {
  const totalTokens = (usage?.inTokens ?? 0) + (usage?.outTokens ?? 0)
    + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
  if (totalTokens > 0) return `${compactCount(totalTokens)} tokens`;
  if ((usage?.requests ?? 0) > 0) {
    const requests = usage?.requests ?? 0;
    return `${compactCount(requests)} request${requests === 1 ? '' : 's'}`;
  }
  if (sessionStatus === 'starting') return 'starting';
  if (sessionStatus === 'exited') return 'ended';
  return 'live';
}

/** The badge text for a measured context, or null when there is nothing measured. */
export function claudeContextLabel(usage: ClaudeContextUsage | null | undefined): string | null {
  if (!usage || usage.kind !== 'ok') return null;
  const tokens = compactCount(usage.tokens);
  return usage.percent !== null && usage.window !== null
    ? `ctx ${usage.percent}% · ${tokens}/${compactCount(usage.window)}`
    : `ctx ${tokens}`;
}
