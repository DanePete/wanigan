import type { WaniganModule } from '../module-registry';
import * as usage from '../usage';
import * as otel from '../otel';
import * as statusline from '../statusline';
import { migrateUsage } from './usage-storage';
import { useBankedReset } from './usage-limits';
import { inspectRecoveryOwner } from '../recovery-inspection';
import { directRequestConsumption, directRequestDaily } from './usage-direct-requests';
import { migrateUsageDirectRequests, migrateUsagePaidOperations, migrateUsagePaidSettlements } from './usage-paid-operations';

/** Usage owns the existing telemetry and consumption channels. The evidence
 * collector and database remain the source of truth; these reads cannot be
 * replaced by a third-party module that changes what recorded usage means. */
export const usageModule: WaniganModule = {
  id: 'usage',
  label: 'Usage',
  required: { reason: 'Exposes recorded session evidence and provider usage readings across the app.' },
  migrate: d => { migrateUsage(d); migrateUsagePaidOperations(d); migrateUsagePaidSettlements(d); migrateUsageDirectRequests(d); },
  recovery: { inspect: d => inspectRecoveryOwner(d, 'usage') },
  // Usage's own ledger for callers that keep none, shown beside every other module's.
  usage: { consumption: directRequestConsumption, daily: directRequestDaily },
  ipc(handle) {
    // ══ phase 1 · telemetry ═════════════════════════════════════════════
    /*
     * Limits somebody's own visit to Usage already established. Never probes:
     * a surface on a poll must not spend an account probe, which is why this
     * exists rather than a cheaper-looking usage:snapshot call.
     */
    handle('usage:known', () => usage.knownLimits());
    handle('usage:session', (id: string) => otel.usageFor(id));
    handle('usage:many', (ids: string[]) => otel.usageForMany(ids));
    handle('usage:events', (id: string, limit?: number) => otel.apiEvents(id, limit));
    handle('usage:throughput', (id: string, buckets?: number) => otel.throughput(id, buckets));
    handle('usage:collector', () => ({ port: otel.collectorPort() }));
    /*
     * What sessions' status lines and beta traces reported. Local reads only:
     * neither starts a CLI process, so both are safe on a poll. A session id is
     * checked for shape before it reaches a query, since it arrives from the
     * renderer.
     */
    const observedSessionId = (id: unknown): string => {
      if (typeof id !== 'string' || !id || id.length > 200) throw new Error('A session id is required.');
      return id;
    };
    handle('usage:observed', () => statusline.observedLimits());
    handle('usage:statusLine', (id: string) => statusline.sessionStatusLine(observedSessionId(id)));
    handle('usage:traces', (id: string) => otel.sessionTraces(observedSessionId(id)));

    handle('usage:snapshot', (input?: { days?: number; force?: boolean }) => usage.snapshot(input));
    /*
     * The one write on this screen. It spends an asset the person holds, so it
     * runs only from a press behind a confirmation, and both ids are checked
     * for shape here because they arrive from the renderer.
     */
    const opaqueId = (value: unknown, what: string): string => {
      if (typeof value !== 'string' || !value || value.length > 200) throw new Error(`${what} is required.`);
      return value;
    };
    handle('usage:useBankedReset', (accountId: unknown, creditId?: unknown) =>
      useBankedReset(opaqueId(accountId, 'An account id'), creditId == null ? null : opaqueId(creditId, 'A reset id')));
    handle('usage:burn', (force?: boolean) => usage.burnWindows(force === true));
  },
};
