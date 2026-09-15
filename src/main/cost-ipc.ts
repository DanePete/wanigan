import { spendYield } from './spend-yield';

/**
 * IPC for the cost, quota and context surfaces, registered from index.ts's
 * registerIpc() through the same trusted-sender wrapper as every other channel.
 * Kept in its own file so the handlers and the validation of what a renderer
 * may pass sit next to each other rather than a few thousand lines apart.
 *
 * Every argument that arrives here is untrusted. Numbers are clamped, strings
 * are checked for shape, and a path is only accepted after the caller-supplied
 * `managedRoot` guard (index.ts's assertManagedRoot) has confined it.
 */

type Handle = <T>(channel: string, fn: (...args: never[]) => T | Promise<T>) => void;

export type CostIpcDeps = {
  liveSessionIds: () => ReadonlySet<string>;
};

function days(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(n) ? Math.max(1, Math.min(365, Math.floor(n))) : undefined;
}

export function registerCostIpc(handle: Handle, deps: CostIpcDeps): void {
  handle('cost:yield', (window: unknown) => spendYield(days(window), deps.liveSessionIds()));
}
