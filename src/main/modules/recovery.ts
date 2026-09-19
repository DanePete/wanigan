import type { WaniganModule } from '../module-registry';

export const recoveryModule: WaniganModule = {
  id: 'recovery', label: 'Recovery',
  required: { reason: 'Recovery owns evidence-backed release decisions and preserves uncertainty independently from checkout safety and billing liability.' },
  migrate(d) {
    d.exec(`CREATE TABLE IF NOT EXISTS recovery_resolutions (
      id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, module TEXT NOT NULL,
      at INTEGER NOT NULL, generation TEXT NOT NULL, decision TEXT NOT NULL,
      evidence_json TEXT NOT NULL, revision TEXT NOT NULL
    )`);
  },
  ipc(handle) {
    handle('recovery:inspect', async () => (await import('../recovery')).inspectRecovery());
    handle('recovery:preview', async (key: unknown) => (await import('../recovery')).previewRecovery(key));
    handle('recovery:apply', async (token: unknown) => (await import('../recovery')).applyRecovery(token));
  },
};
