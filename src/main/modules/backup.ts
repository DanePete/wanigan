import { app, dialog } from 'electron';
import path from 'node:path';
import type { BackupCheck, BackupRestoreSummary, BackupSummary } from '../../shared/types';
import type { WaniganModule } from '../module-registry';
import * as backup from '../backup';
import * as headless from '../headless';
import { listSessions } from '../sessions';

/** Where the backup save dialog opens. Documents is only a starting point — the
 *  user picks the folder, and backup.ts refuses one inside the data directory. */
function defaultBackupParent(): string {
  try { return app.getPath('documents'); }
  catch { return app.getPath('home'); }
}

/** Sortable and unambiguous in a folder listing, which is where this is read. */
function backupStamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** Backup replaces the canonical evidence record and therefore cannot be disabled. */
export const backupModule: WaniganModule = {
  id: 'backup',
  label: 'Backup',
  required: {
    reason: 'Backup owns replacement of the canonical evidence database, verified artifacts and retained originals.',
  },
  ipc(handle, context) {
    // Goals, proofs, the policy ledger, the knowledge record and every citation
    // that makes a briefing checkable are rows in one SQLite file. The app could
    // forget a transcript but never copy anything out, so a dead disk ended the
    // record permanently and nothing ever said so.
    handle('backup:create', async (): Promise<BackupSummary | null> => {
      const win = context.getWindow();
      if (!win) return null;
      const res = await dialog.showSaveDialog(win, {
        title: 'Back up Wanigan’s record',
        defaultPath: path.join(defaultBackupParent(), `wanigan-backup-${backupStamp()}`),
        buttonLabel: 'Back up',
        properties: ['createDirectory'],
      });
      if (res.canceled || !res.filePath) return null;
      return backup.createBackup(res.filePath);
    });
    // Read-only: verify a backup and say what restoring it would cost, so the
    // decision is made against the dates rather than against a folder name.
    handle('backup:inspect', async (): Promise<BackupCheck | null> => {
      const win = context.getWindow();
      if (!win) return null;
      const res = await dialog.showOpenDialog(win, {
        title: 'Check a Wanigan backup',
        properties: ['openDirectory'],
        buttonLabel: 'Check this backup',
      });
      if (res.canceled || !res.filePaths[0]) return null;
      return backup.inspectBackup(res.filePaths[0]);
    });
    handle('backup:restore', async (): Promise<BackupRestoreSummary | null> => {
      const w = context.getWindow();
      if (!w || w.isDestroyed()) return null;
      const relaunch = context.relaunchAfterRestore;
      if (!relaunch) throw new Error('This host cannot restart Wanigan after restoring its database.');

      // A restore swaps the database file out from under this process. Anything
      // still writing to it — a PTY recording events, a headless row banking a
      // cost — would start throwing mid-run against a file that has moved.
      const live = listSessions().filter((s) => s.status === 'starting' || s.status === 'running').length;
      const headlessLive = headless.liveHeadlessCount();
      if (live || headlessLive) {
        throw new Error(
          `${live + headlessLive} agent${live + headlessLive === 1 ? ' is' : 's are'} still running, and a restore `
          + 'replaces the database they are writing to. Stop them first, then restore.'
        );
      }

      const picked = await dialog.showOpenDialog(w, {
        title: 'Restore a Wanigan backup',
        properties: ['openDirectory'],
        buttonLabel: 'Choose this backup',
      });
      if (picked.canceled || !picked.filePaths[0]) return null;

      const check = backup.inspectBackup(picked.filePaths[0]);
      if (check.problems.length) {
        throw new Error(
          `This backup did not verify, so nothing was changed:\n- ${check.problems.map((p) => p.detail).join('\n- ')}`
        );
      }

      // Name what is being replaced, not "are you sure": the only fact that
      // decides this is whether the database in place holds work the backup does
      // not, and that is the sentence a person can actually act on.
      const takenAt = check.createdAt ? new Date(check.createdAt).toLocaleString() : 'an unrecorded date';
      const backupEvidence = check.latestEvidenceAt
        ? new Date(check.latestEvidenceAt).toLocaleString()
        : 'nothing recorded';
      const currentEvidence = check.currentLatestEvidenceAt
        ? new Date(check.currentLatestEvidenceAt).toLocaleString()
        : 'nothing recorded';
      const answer = await dialog.showMessageBox(w, {
        type: 'warning',
        buttons: ['Cancel', 'Replace the database'],
        defaultId: 0,
        cancelId: 0,
        title: 'Replace Wanigan’s record with this backup?',
        message: `The database Wanigan is using now and its ${check.transcripts.files} archived transcript`
          + `${check.transcripts.files === 1 ? '' : 's'} will be replaced by the backup taken ${takenAt}.`,
        detail: `That backup records work up to ${backupEvidence}. The database in place records work up to `
          + `${currentEvidence}.${check.wouldDiscardNewer ? ' Everything in between will be dropped.' : ''}\n\n`
          + 'Nothing is deleted: the replaced database and transcripts are moved into a dated folder inside '
          + 'Wanigan’s data directory. The API credential and provider/MCP trust grants are not restored — '
          + 'those are made on one machine, for one machine. Wanigan must restart immediately afterwards.',
      });
      if (answer.response !== 1) return null;

      const report = backup.restoreBackup(picked.filePaths[0], {
        confirm: true,
        // The dialog above showed both dates, which is the whole precondition
        // this flag exists to enforce.
        overwriteNewer: check.wouldDiscardNewer,
      });

      // The connection this process held is closed and every later db() call
      // throws. Say so and relaunch, rather than leaving a window whose every
      // control now fails against a file that has moved.
      setTimeout(() => {
        void dialog.showMessageBox({
          type: 'info',
          buttons: ['Restart Wanigan'],
          defaultId: 0,
          title: 'Backup restored',
          message: 'Wanigan will restart to open the restored database.',
          detail: `The database that was in place was moved to ${report.replacedDir} and not deleted.`,
        }).finally(relaunch);
      }, 0);

      return report;
    });
  },
};
