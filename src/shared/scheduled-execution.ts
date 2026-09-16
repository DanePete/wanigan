import type { ProviderInfo } from './types';

/** The scheduler and its preview use the same bounds. A dollar limit only
 * applies when the selected headless protocol actually supports one. */
export const SCHEDULED_BUDGET_USD = 2;
export const SCHEDULED_TIMEOUT_MS = 15 * 60_000;

type Selection = { providerId: string; providerProfileFingerprint: string };
type Execution = {
  state: 'legacy' | 'unread' | 'available' | 'blocked';
  label: string;
  detail: string;
  provider: ProviderInfo | null;
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const identity = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

/** Save-time contract. Legacy absence is permitted only on reads and fires,
 * never on a new schedule or an edit that the operator is reviewing now. */
export function requireScheduledExecution(payload: unknown): Selection {
  const p = record(payload);
  if ((p.executionVersion !== undefined && p.executionVersion !== 1)
    || !identity(p.providerId) || !identity(p.providerProfileFingerprint)) {
    throw new Error('Choose an agent for this schedule and review its execution settings before saving.');
  }
  return { providerId: p.providerId, providerProfileFingerprint: p.providerProfileFingerprint };
}

export function validateScheduledExecution(payload: unknown, providers: readonly ProviderInfo[]): ProviderInfo {
  const selected = requireScheduledExecution(payload);
  const provider = providers.find(row => row.id === selected.providerId);
  if (!provider || !provider.path) {
    throw new Error('The selected agent is disabled or not installed. Restore it or choose another agent.');
  }
  if (provider.profileFingerprint !== selected.providerProfileFingerprint) {
    throw new Error('The selected agent profile changed. Review and select its current configuration before saving.');
  }
  if (!provider.capabilities.headlessJson) {
    throw new Error('The selected agent does not support unattended runs. Choose an agent with verified unattended support.');
  }
  if (provider.launchFields?.some(field => field.required && field.id !== 'permissionMode' && field.defaultValue === undefined)) {
    throw new Error('This agent requires launch options that Schedules cannot supply. Choose a profile with saved defaults or use Runs.');
  }
  return provider;
}

/** A missing catalogue is unknown, not a missing agent. A malformed new record
 * is blocked, not reinterpreted as permission to pick the current default. */
export function executionForSchedule(payload: unknown, providers: readonly ProviderInfo[] | null): Execution {
  const p = record(payload);
  const name = identity(p.providerLabel) ? p.providerLabel : identity(p.providerId) ? p.providerId : 'Agent unavailable';
  if (p.executionVersion === undefined && p.providerProfileFingerprint === undefined) {
    return { state: 'legacy', label: identity(p.providerId) ? name : 'Provider chosen at run time',
      detail: 'This older schedule has no reviewed profile identity. Review its agent to keep future runs on that configuration.', provider: null };
  }
  try {
    requireScheduledExecution(payload);
    if (providers === null) return { state: 'unread', label: name, detail: 'Agent availability has not been read. Refresh to check it.', provider: null };
    const provider = validateScheduledExecution(payload, providers);
    return { state: 'available', label: provider.label,
      detail: 'Installed with unattended support. Sign-in and project access are checked when the run starts.', provider };
  } catch (error) {
    return { state: 'blocked', label: name, detail: error instanceof Error ? error.message : String(error), provider: null };
  }
}
