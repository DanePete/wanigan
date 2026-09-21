/** Required Storage's host boundary. Stopping timers is not an acknowledgement
 * that legacy asynchronous callbacks have drained. Once a host starts services,
 * it must exit and reopen without them before it may replace its database. */
let servicesStarted = false;
let inspectionHeld = false;
const calls = new Map<symbol, string>();

export function storageMaintenanceStartup(): boolean {
  return process.argv.includes('--storage-maintenance');
}

export function markStorageRuntimeStarted(): void {
  if (storageMaintenanceStartup()) throw new Error('This startup is reserved for storage maintenance. Quit and open Wanigan normally to run services.');
  servicesStarted = true;
}

export function storageRuntimeStarted(): boolean { return servicesStarted; }
export function holdStorageRuntimeForInspection(): void { inspectionHeld = true; }
export function storageInspectionOnly(): boolean { return storageMaintenanceStartup() || inspectionHeld; }

/** The persisted mode stays `active` in a maintenance startup until a restore
 * really begins, so the side-effect boundary has to ask this host as well. IPC
 * allowlisting covers the normal UI; a direct service call never crosses it.
 * Recovery's own preview and apply pass no flag and remain available. */
export function assertStorageRuntimeSideEffects(input: { automatic?: boolean; paid?: boolean }): void {
  if (!storageInspectionOnly() || !(input.automatic || input.paid)) return;
  throw new Error(input.paid
    ? 'This Wanigan process is open only for storage maintenance or inspection. Paid work is held; quit and reopen normally to leave a maintenance startup.'
    : 'This Wanigan process is open only for storage maintenance or inspection. Automatic work is held.');
}

export function assertStorageRuntimeRestoreReady(): void {
  if (servicesStarted) throw new Error('Restore requires a fresh maintenance startup. Restart for restore from Settings → Backup; stopping timers cannot prove that earlier asynchronous work drained.');
  const pending = [...calls.values()].filter(channel => channel !== 'backup:restore');
  if (pending.length) throw new Error(`Restore must wait for ${pending.length} in-flight operation(s) to finish. Nothing was replaced.`);
}

// This is deliberately a small offline surface, not a name-based guess that
// every "get" or "status" operation is read-only. Several legacy reads probe
// installed executables, refresh network state or lazily change records.
const maintenanceChannels = new Set([
  'backup:create', 'backup:inspect', 'backup:restore',
  'recovery:inspect', 'recovery:preview', 'recovery:apply',
  'startup:status', 'startup:retry', 'settings:get', 'settings:all',
  'keymap:get', 'projects:list', 'sessions:list', 'sessions:liveCount',
  'companion:snapshot',
]);

/** The refusal a held host gives a channel, or null. The host asks this before
 * its started-services guard: a maintenance startup never starts services by
 * design, and "retry local services" is advice that cannot work there. */
export function storageIpcRefusal(channel: string): string | null {
  if (!storageInspectionOnly() || maintenanceChannels.has(channel)) return null;
  return inspectionHeld
    ? 'The restored database is open for inspection. Execution and spending remain held; restarting does not reconcile historical evidence.'
    : 'Wanigan is open for storage maintenance. Only Backup, Recovery and local inspection are available; quit and reopen normally to leave this mode.';
}

export async function storageIpcScope<T>(channel: string, operation: () => T | Promise<T>): Promise<T> {
  const refusal = storageIpcRefusal(channel);
  if (refusal) throw new Error(refusal);
  const token = Symbol(channel);
  calls.set(token, channel);
  try { return await operation(); }
  finally { calls.delete(token); }
}
