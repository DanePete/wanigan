import type Database from 'better-sqlite3';
import type { RelayCreateInput } from '../../shared/types';
import type { WaniganModule } from '../module-registry';
import * as relay from '../relay';

/**
 * Relay owns the staged workflow's marker and IPC namespace. The implementation
 * remains in ../relay.ts; Control still owns goals, session launches and their
 * evidence. Removing Relay costs its routing and forecast workflow, not those
 * trust boundaries, so this module is optional.
 */
function migrate(d: Database.Database) {
  // Whether the docket was created as a relay (src/main/relay.ts). A relay
  // hands a failed review back to its implementer on its own, up to a cap; an
  // ordinary goal must not start doing that because it happens to share the
  // table, so the flag is what the hand-back reads before it touches anything.
  // Existing rows default to 0, which is true of every goal written before
  // relays existed.
  const columns = d.prepare('PRAGMA table_info(work_dockets)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'relay')) {
    d.exec('ALTER TABLE work_dockets ADD COLUMN relay INTEGER NOT NULL DEFAULT 0');
  }
}

export const relayModule: WaniganModule = {
  id: 'relay',
  label: 'Relay',
  required: null,
  migrate,
  ipc(handle) {
    // None of these starts an agent. `relay:create` writes a docket and its
    // route proofs; the plan session is started through `control:start`, which
    // is already held until services are up. `relay:estimate` is a query over
    // this project's own history. Everything arriving here is validated in
    // relay.ts before a row is touched.
    handle('relay:create', (input: RelayCreateInput) => relay.createRelay(input));
    // Spends when the suggester is on, so it is a press and never a keystroke.
    handle('relay:preview', (input: unknown) => relay.previewRelay(input));
    handle('relay:read', (docketId: unknown) => relay.readRelay(docketId));
    handle('relay:forecast', (docketId: unknown) => relay.forecast(docketId));
    handle('relay:estimate', (docketId: unknown) => relay.estimate(docketId));
    handle('relay:list', (projectId: unknown, limit?: number) => relay.listRelays(projectId, limit));
  },
};
