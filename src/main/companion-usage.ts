import type { UsageSnapshot } from '../shared/types';

const numberOrNull = (value: number | null): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const text = (value: string | null) => value === null ? null : value.slice(0, 120);
const MAX_ACCOUNTS = 16, MAX_MODELS = 40, MAX_WINDOWS = 8;

/** An explicit numeric projection of Usage, never a spread of identity or
 * provider-authored prose. Account-wide quota is not project consumption. */
export function companionUsage(snapshot: UsageSnapshot, now = Date.now()) {
  return {
    state: 'available' as const, readAt: now, scope: 'all-accounts' as const, days: snapshot.days,
    coverage: 'Recorded consumption covers agent request telemetry collected by Wanigan across all projects. It is not a complete provider bill, does not include this companion API conversation, and cannot determine subscription quota.',
    accountsTruncated: snapshot.limits.length > MAX_ACCOUNTS,
    modelsTruncated: snapshot.consumption.length > MAX_MODELS,
    limits: snapshot.limits.slice(0, MAX_ACCOUNTS).map(account => {
      const fetchedAt = numberOrNull(account.fetchedAt);
      // Same ten-minute stale threshold displayed by the Usage view.
      const stale = account.state !== 'ok' || fetchedAt === null || now - fetchedAt > 10 * 60_000;
      return {
        accountId: account.accountId, accountLabel: text(account.accountLabel), harness: text(account.harness),
        state: account.state, fetchedAt, stale, plan: text(account.plan),
        windowsTruncated: account.windows.length > MAX_WINDOWS,
        windows: account.windows.slice(0, MAX_WINDOWS).map(window => ({
          kind: text(window.kind), scope: text(window.scope),
          usedPercent: window.usedPercent <= 100 ? numberOrNull(window.usedPercent) : null,
          resetsAt: numberOrNull(window.resetsAt),
          stale: stale || (window.resetsAt !== null && window.resetsAt <= now),
        })),
      };
    }),
    consumption: snapshot.consumption.slice(0, MAX_MODELS).map(row => ({
      accountId: row.accountId, accountLabel: text(row.accountLabel), harness: text(row.harness), model: text(row.model),
      requests: numberOrNull(row.requests), inTokens: numberOrNull(row.inTokens), outTokens: numberOrNull(row.outTokens),
      cacheRead: numberOrNull(row.cacheRead), costStatus: row.costStatus,
      costUsd: row.costStatus === 'unreported' ? null : numberOrNull(row.costUsd),
    })),
  };
}
