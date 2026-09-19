import type Database from 'better-sqlite3';
import type { RecoveryObservation } from '../shared/recovery';

/** A required owner inspects its own tables and applies an exact atomic release.
 * Recovery owns consent receipts, never another module's business history. */
export type RecoveryAdapter = {
  inspect: (d: Database.Database) => RecoveryObservation[];
  /** Called inside Recovery's IMMEDIATE transaction after receipt validation.
   * Throw if exact claims cannot be released. Never enqueue or settle billing. */
  reconcile?: (d: Database.Database, observation: RecoveryObservation) => void;
};
