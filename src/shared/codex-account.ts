/**
 * The parse seam for the Codex app-server's account reads, pinned to the shapes
 * the installed CLI generates offline (`codex app-server generate-ts`, checked
 * against codex-cli 0.155.1). Pure, so its contract runs in the fast suite.
 *
 * Every field is optional at this seam. The protocol carries no version number,
 * so a renamed field must become an explicit unknown here, never a zero.
 */
export type CodexLimitWindow = {
  /** As reported. The wire type is an integer; nothing here adds precision. */
  usedPercent: number;
  remainingPercent: number;
  /** Unix milliseconds, or null when Codex did not provide a reset time. */
  resetsAt: number | null;
  windowMinutes: number | null;
};

/** One metered limit as the backend named it. `normalModelSlug` is the only
 * provider-stated link from a bucket to a model; nothing is inferred from a label. */
export type CodexLimitBucket = {
  limitId: string | null;
  limitName: string | null;
  normalModelSlug: string | null;
  plan: string | null;
  primary: CodexLimitWindow | null;
  secondary: CodexLimitWindow | null;
  spendControlReached: boolean | null;
  reachedType: string | null;
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
};

export type CodexRateLimits = {
  /** The historical single-bucket view, kept for readers that show one. */
  plan: string | null;
  primary: CodexLimitWindow | null;
  secondary: CodexLimitWindow | null;
  spendControlReached: boolean | null;
  /** Every bucket reported, keyed view first and the single view as fallback. */
  buckets: CodexLimitBucket[];
  /** The backend's own verdict. null is unavailable, and is never read as true:
   * the protocol forbids inferring recovery from percentages or reset times. */
  ordinaryUsageAllowed: boolean | null;
  /** Ordinary account metadata, not a credential. The one login signal that
   * still works when credentials live in the OS keyring. */
  backendAccountId: string | null;
};

export type CodexAccountRead = {
  authState: 'signed-in' | 'signed-out' | 'unknown';
  /** false means this configuration needs no OpenAI login, so a null account
   * is not a signed-out person. null when the field was absent. */
  requiresOpenaiAuth: boolean | null;
  type: string | null;
  email: string | null;
  plan: string | null;
};

export type CodexModel = {
  id: string;
  label: string;
  description: string | null;
  reasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  isDefault: boolean;
};

type Raw = Record<string, unknown>;
const object = (value: unknown): Raw | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : null;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const flag = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

export function codexWindow(value: unknown): CodexLimitWindow | null {
  const raw = object(value);
  const used = finite(raw?.usedPercent);
  if (!raw || used === null) return null;
  const clamped = Math.max(0, Math.min(100, used));
  const seconds = finite(raw.resetsAt);
  return { usedPercent: clamped, remainingPercent: 100 - clamped,
    resetsAt: seconds === null ? null : seconds * 1000, windowMinutes: finite(raw.windowDurationMins) };
}

function bucket(value: unknown): CodexLimitBucket | null {
  const raw = object(value);
  if (!raw) return null;
  const credits = object(raw.credits);
  return {
    limitId: text(raw.limitId), limitName: text(raw.limitName), normalModelSlug: text(raw.normalModelSlug),
    plan: text(raw.planType), primary: codexWindow(raw.primary), secondary: codexWindow(raw.secondary),
    spendControlReached: flag(raw.spendControlReached), reachedType: text(raw.rateLimitReachedType),
    credits: credits && typeof credits.hasCredits === 'boolean' && typeof credits.unlimited === 'boolean'
      ? { hasCredits: credits.hasCredits, unlimited: credits.unlimited, balance: text(credits.balance) } : null,
  };
}

export function codexRateLimits(result: unknown): CodexRateLimits {
  const raw = object(result) ?? {};
  const single = bucket(raw.rateLimits);
  const keyed = object(raw.rateLimitsByLimitId);
  const buckets = keyed
    ? Object.keys(keyed).sort().flatMap((id) => { const row = bucket(keyed[id]); return row ? [{ ...row, limitId: row.limitId ?? id }] : []; })
    : single ? [single] : [];
  return {
    plan: single?.plan ?? null, primary: single?.primary ?? null, secondary: single?.secondary ?? null,
    spendControlReached: single?.spendControlReached ?? null, buckets,
    ordinaryUsageAllowed: flag(raw.ordinaryUsageAllowed), backendAccountId: text(raw.accountId),
  };
}

export function codexAccount(result: unknown): CodexAccountRead {
  const raw = object(result);
  const unknown: CodexAccountRead = { authState: 'unknown', requiresOpenaiAuth: flag(raw?.requiresOpenaiAuth), type: null, email: null, plan: null };
  if (!raw || !('account' in raw)) return unknown;
  if (raw.account === null) return { ...unknown, authState: 'signed-out' };
  const account = object(raw.account);
  const type = text(account?.type);
  if (!account || !type) return unknown;
  return { ...unknown, authState: 'signed-in', type, email: text(account.email), plan: text(account.planType) };
}

export function codexModelPage(result: unknown): { models: CodexModel[]; nextCursor: string | null } {
  const raw = object(result) ?? {};
  const models = (Array.isArray(raw.data) ? raw.data : []).flatMap((value): CodexModel[] => {
    const m = object(value); const id = text(m?.id);
    if (!m || !id) return [];
    return [{
      id, label: text(m.displayName) ?? id, description: text(m.description),
      reasoningEfforts: (Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : [])
        .flatMap((effort) => { const name = text(effort) ?? text(object(effort)?.reasoningEffort); return name ? [name] : []; }),
      defaultReasoningEffort: text(m.defaultReasoningEffort), isDefault: m.isDefault === true,
    }];
  });
  return { models, nextCursor: text(raw.nextCursor) };
}

/** A passed reset makes a window stale. It never makes it recovered. */
export function codexWindowStale(window: CodexLimitWindow | null, now: number): boolean {
  return window?.resetsAt != null && window.resetsAt <= now;
}

/** Two readings describe one login only when nothing the backend reported
 * about the person differs. An absent field on either side proves nothing. */
export function codexLoginChanged(
  before: { backendAccountId: string | null; email: string | null; plan: string | null },
  after: { backendAccountId: string | null; email: string | null; plan: string | null },
): boolean {
  return (['backendAccountId', 'email', 'plan'] as const)
    .some((field) => before[field] !== null && after[field] !== null && before[field] !== after[field]);
}
