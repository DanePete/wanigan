import type { ProviderInfo, Session, SessionUsage } from './types';

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
};

function humanizeProviderId(id: string): string {
  return id
    .split(/[-_./]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ') || 'Provider';
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
