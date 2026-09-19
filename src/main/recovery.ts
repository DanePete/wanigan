import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { db } from './db';
import { modules } from './module-registry';
import { evidenceHash, inspectRecoveryOwner, inspectLegacyRemoteLiability, hasTable } from './recovery-inspection';
import { reviewRecoveryAdapter } from './review-recovery';
import type { RecoveryAdapter } from './recovery-contract';
import { storageStatus, assertStorageAdmission } from './storage-maintenance';
import { reconciliationRefusal, recoveryReceiptCurrent, type RecoveryObservation, type RecoveryPreview, type RecoveryInspection } from '../shared/recovery';

type Receipt = { preview: RecoveryPreview; revision: string };
const receipts = new Map<string, Receipt>();
const TTL = 5 * 60_000;

/** Recovery is called only after the canonical database migration boundary.
 * Missing safety tables are unreadable evidence, never an empty claim set.
 * Optional Suggest may genuinely never have been installed; if present, its
 * own reader validates every required column rather than assuming defaults. */
const REQUIRED_EVIDENCE_TABLES = [
  'projects', 'session_log', 'checkout_activity', 'queue', 'headless_rows',
  'worktree_command_runs', 'review_runs', 'review_checkout_owners',
  'review_recovery_evidence', 'session_metrics', 'session_api_events',
  'session_telemetry_coverage', 'session_telemetry_issues',
  'session_telemetry_receipts', 'runs', 'batches', 'events', 'learning_model_runs', 'recovery_resolutions',
  'companion_turns', 'interviews',
] as const;

function adapters(): Map<string, RecoveryAdapter> {
  // Direct service callers have the same required owners, even before the
  // host's module registration pass. Optional contributed adapters add to it.
  const owners = ['sessions', 'queue', 'headless', 'worktrees', 'suggest', 'usage'] as const;
  const all = new Map<string, RecoveryAdapter>(owners.map(owner => [owner, { inspect: d => inspectRecoveryOwner(d, owner) }]));
  all.set('review', { ...reviewRecoveryAdapter, inspect: d => hasTable(d, 'review_runs') ? reviewRecoveryAdapter.inspect(d) : [] });
  for (const module of modules()) if (module.recovery) all.set(module.id, module.recovery);
  return all;
}

function observations(d: Database.Database): RecoveryObservation[] {
  const missing = REQUIRED_EVIDENCE_TABLES.filter(table => !hasTable(d, table));
  if (missing.length) throw new Error(`Recovery evidence schema is incomplete: missing ${missing.join(', ')}.`);
  return [...[...adapters().values()].flatMap(adapter => adapter.inspect(d)), ...inspectLegacyRemoteLiability(d)]
    .sort((a, b) => a.key.localeCompare(b.key));
}

function checkoutIdentity(cwd: string | null): unknown {
  if (!cwd) return null;
  try {
    const real = fs.realpathSync.native(cwd);
    const stat = fs.statSync(real, { bigint: true });
    const link = fs.lstatSync(cwd, { bigint: true });
    return { real, device: String(stat.dev), inode: String(stat.ino), birth: String(stat.birthtimeNs),
      linkDevice: String(link.dev), linkInode: String(link.ino), directory: stat.isDirectory() };
  } catch { return { unavailable: true, cwd }; }
}

function revision(rows: RecoveryObservation[]): string {
  return evidenceHash(rows.map(row => [row, checkoutIdentity(row.cwd)]));
}

export function inspectRecovery(): RecoveryInspection {
  const storage = storageStatus();
  const base = {
    generation: storage.generation, storageMode: storage.mode,
    storageReason: storage.mode === 'maintenance'
      ? 'An unfinished restore holds storage closed. No automatic recovery or timeout can release this barrier. The journal identifies the retained files below.'
      : storage.automationHeld || storage.spendingHeld
      ? 'Restored history is open for inspection. Archived work and older spending totals cannot authorize automatic or paid work. Spending reconciliation is not supported in this phase.'
      : 'Current storage generation. Execution ownership and financial exposure remain separate checks.',
    ...(storage.operation ? { storageOperation: { id: storage.operation.id, phase: storage.operation.phase,
      sourceGeneration: storage.operation.source_generation, destinationGeneration: storage.operation.destination_generation,
      retainedDir: storage.operation.replaced_dir, stagingDir: storage.operation.staging_dir, detail: storage.operation.detail } } : {}),
  };
  try {
    const d = db();
    return { ...base, observations: observations(d),
      resolutions: d.prepare(`SELECT id,operation_id AS operationId,module,at,decision,generation
        FROM recovery_resolutions ORDER BY at DESC LIMIT 100`).all() as RecoveryInspection['resolutions'] };
  } catch (error) {
    return { ...base, observations: [], resolutions: [], unavailable: `Execution and billing evidence could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function previewRecovery(key: unknown): RecoveryPreview {
  if (typeof key !== 'string' || !key || key.length > 500) throw new Error('Choose a recorded recovery claim.');
  assertStorageAdmission();
  const d = db();
  return d.transaction(() => {
    const rows = observations(d);
    const observation = rows.find(row => row.key === key);
    if (!observation) throw new Error('That claim changed. Refresh Recovery.');
    const refusal = reconciliationRefusal(observation);
    if (refusal) throw new Error(refusal);
    if (observation.cwd) {
      const identity = checkoutIdentity(observation.cwd);
      if (!identity || typeof identity !== 'object' || !('directory' in identity) || identity.directory !== true) {
        throw new Error('The recorded checkout is not an available canonical directory; its identity cannot be reviewed.');
      }
    }
    const now = Date.now();
    for (const [token, receipt] of receipts) if (receipt.preview.expiresAt <= now || receipt.preview.observation.key === key) receipts.delete(token);
    if (receipts.size >= 100) throw new Error('Too many recovery previews. Wait for existing previews to expire.');
    const preview = { token: randomUUID(), expiresAt: now + TTL, generation: storageStatus().generation, observation,
      decision: 'Release only these validated execution claims. Preserve the original outcome and all billing evidence. No retry is scheduled.' };
    receipts.set(preview.token, { preview, revision: revision(rows) });
    // IPC serializes this value, but direct service callers must not receive
    // a mutable alias to the main-issued authority retained above either.
    return structuredClone(preview);
  }).immediate();
}

export function applyRecovery(token: unknown): { id: string; decision: string } {
  if (typeof token !== 'string' || token.length > 200) throw new Error('A current Recovery preview is required.');
  const receipt = receipts.get(token);
  receipts.delete(token); // Failed and successful applies both consume authority.
  if (!receipt) throw new Error('This Recovery preview was used, expired or belongs to another runtime. Inspect again.');
  assertStorageAdmission();
  const d = db();
  return d.transaction(() => {
    const rows = observations(d);
    if (!recoveryReceiptCurrent({ now: Date.now(), expiresAt: receipt.preview.expiresAt,
      generation: storageStatus().generation, expectedGeneration: receipt.preview.generation,
      revision: revision(rows), expectedRevision: receipt.revision })) {
      throw new Error('Recovery evidence, checkout identity or storage generation changed. Inspect again.');
    }
    const observation = rows.find(row => row.key === receipt.preview.observation.key);
    if (!observation || reconciliationRefusal(observation)) throw new Error('Completion evidence no longer permits this release.');
    const adapter = adapters().get(observation.module);
    if (!adapter?.reconcile) throw new Error('The owning module cannot reconcile this claim.');
    adapter.reconcile(d, observation);
    const id = randomUUID();
    d.prepare(`INSERT INTO recovery_resolutions(id,operation_id,module,at,generation,decision,evidence_json,revision)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, observation.operationId, observation.module, Date.now(), receipt.preview.generation,
      receipt.preview.decision, JSON.stringify(observation), receipt.revision);
    return { id, decision: receipt.preview.decision };
  }).immediate();
}

/** The first restore protocol refuses cross-generation execution/liability merging. */
export function assertRestoreSafe(d: Database.Database): void {
  const rows = observations(d);
  if (rows.length) throw new Error(`Restore refused: ${rows.length} execution or billing claim(s) remain. ${rows[0].source}: ${rows[0].reason} Inspect Recovery first.`);
}
