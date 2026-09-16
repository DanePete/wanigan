import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { db, dataDir } from './db';
import * as backup from './backup';
import * as attachments from './attachments';
import { copyVerifiedBackupFiles, snapshotBackupFiles, verifyBackupFiles } from './backup-files';

type Check = (ok: boolean, label: string, detail?: unknown) => void;

/** Must run last: a successful real restore closes the main database connection. */
export function runAuditBackupSmoke(check: Check, say: (text: string) => void): void {
  say('── audit repairs · artifact backup, restoration and manual retention');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-backup-regression-'));
  const root = dataDir();
  const sessionIds = ['audit-retention-unused', 'audit-retention-generated', 'audit-retention-referenced', 'audit-retention-live', 'audit-retention-changed'];
  const old = Date.now() - 90 * 86400000;
  const refused = (action: () => unknown): boolean => { try { action(); return false; } catch { return true; } };
  for (const id of sessionIds) {
    db().prepare("INSERT INTO session_log (id,provider_id,project_id,project_path,project_name,started_at,ended_at) VALUES (?,'codex',NULL,?,?,?,?)")
      .run(id, temporary, 'Backup regression', old - 1000, id.endsWith('-live') ? null : old);
    const attachment = attachments.attachBufferToSession(id, Buffer.from('unused staged text'), 'input.txt');
    // Model a file staged before the ended session, with its original mtime.
    db().prepare('UPDATE attachments SET added_at=? WHERE id=?').run(old - 100, attachment.id);
    fs.utimesSync(attachment.storedPath, new Date(old - 100), new Date(old - 100));
    if (id.endsWith('-referenced')) attachments.markAttachmentsReferenced([attachment.id]);
    if (id.endsWith('-generated')) fs.writeFileSync(path.join(attachments.attachmentsDir(id), 'only-report.md'), 'only generated copy');
    if (id.endsWith('-changed')) fs.writeFileSync(attachment.storedPath, 'agent rewrote this input into a report');
  }
  attachments.setAttachmentRetention(30);
  const plan = attachments.planAttachmentReclaim();
  check(plan.candidates.some(item => item.sessionId === sessionIds[0]), 'retention previews inert, unused staged files');
  check(sessionIds.slice(1).every(id => !plan.candidates.some(item => item.sessionId === id)),
    'retention protects generated, referenced, changed and live session files');
  const noSelection = attachments.reclaimAttachments({ sessionIds: [] });
  check(noSelection.filesRemoved === 0 && fs.existsSync(attachments.attachmentsDir(sessionIds[0])), 'an empty cleanup selection removes nothing');
  const approved = plan.candidates.filter(item => item.sessionId === sessionIds[0]).map(item => ({ sessionId: item.sessionId, fingerprint: item.fingerprint }));
  const changedFile = attachments.sessionAttachments(sessionIds[0])[0];
  fs.utimesSync(changedFile.storedPath, new Date(), new Date());
  const changedReceipt = attachments.reclaimAttachments({ sessionIds: [sessionIds[0]], approved });
  check(changedReceipt.filesRemoved === 0 && changedReceipt.skipped.some(item => item.reason === 'changed-since-preview'),
    'a file identity change after confirmation requires another preview');
  const cleaned = attachments.reclaimAttachments({ sessionIds: [sessionIds[0]] });
  check(cleaned.filesRemoved === 1 && !fs.existsSync(attachments.attachmentsDir(sessionIds[0])), 'manual cleanup removes only selected eligible files');
  check(sessionIds.slice(1).every(id => fs.existsSync(attachments.attachmentsDir(id))), 'manual cleanup keeps every protected directory');
  const legacyFile = attachments.sessionAttachments(sessionIds[4])[0];
  db().prepare('UPDATE attachments SET content_sha256=NULL WHERE id=?').run(legacyFile.id);
  check(!attachments.planAttachmentReclaim().candidates.some(item => item.sessionId === sessionIds[4]),
    'legacy staged files with no original content hash are conservatively kept');
  attachments.setAttachmentRetention(0);
  check(attachments.reclaimAttachments().filesRemoved === 0, 'disabled retention never deletes files');

  const source = path.join(temporary, 'source'); const target = path.join(temporary, 'copied');
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(source, 'nested', 'report.md'), 'nested generated report');
  const entries = snapshotBackupFiles(source, target);
  verifyBackupFiles(target, entries);
  check(entries.length === 1 && entries[0].name === 'nested/report.md', 'artifact inventory preserves nested generated files');
  check(refused(() => verifyBackupFiles(target, [{ ...entries[0], name: '../outside' }])), 'restore inventory refuses parent traversal');
  check(refused(() => verifyBackupFiles(target, [entries[0], entries[0]])), 'restore inventory refuses duplicate names');
  fs.writeFileSync(path.join(target, 'nested', 'report.md'), 'altered');
  check(refused(() => copyVerifiedBackupFiles(target, path.join(temporary, 'stage'), entries)), 'restore refuses altered artifact bytes before replacing anything');
  fs.symlinkSync(path.join(source, 'nested', 'report.md'), path.join(source, 'linked'));
  check(refused(() => snapshotBackupFiles(source, path.join(temporary, 'linked-backup'))), 'artifact backup refuses symlinks instead of copying outside content');

  const artifact = path.join(attachments.attachmentsDir(sessionIds[1]), 'only-report.md');
  const relocated = attachments.sessionAttachments(sessionIds[1])[0];
  db().prepare('UPDATE attachments SET stored_path=? WHERE id=?').run(`/old-machine/attachments/${sessionIds[1]}/${path.basename(relocated.storedPath)}`, relocated.id);
  const made = backup.createBackup(path.join(temporary, 'backup'));
  const checked = backup.inspectBackup(made.dir);
  check(made.attachments.files > 0 && checked.problems.length === 0 && checked.attachments !== null,
    'v2 backup includes and verifies session artifacts', checked.problems);
  check(fs.readFileSync(path.join(made.dir, 'attachments', sessionIds[1], 'only-report.md'), 'utf8') === 'only generated copy',
    'the sole generated output is present in the backup');
  const manifestFile = path.join(made.dir, 'wanigan-backup.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Record<string, unknown>;
  const legacy: Record<string, unknown> = { ...manifest, formatVersion: 1 }; delete legacy.attachments;
  fs.writeFileSync(manifestFile, JSON.stringify(legacy));
  const legacyCheck = backup.inspectBackup(made.dir);
  check(legacyCheck.problems.length === 0 && legacyCheck.attachments === null, 'v1 backups remain readable and disclose absent artifacts');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));

  const clock = Math.max(Date.now(), made.latestEvidenceAt ?? 0) + 10;
  const projectId = (db().prepare('SELECT id FROM projects LIMIT 1').get() as { id: string }).id;
  db().prepare('INSERT INTO review_runs (id,project_id,started_at,ended_at,status,results_json) VALUES (?,?,?,?,?,?)')
    .run('audit-backup-review', projectId, clock, clock + 1, 'passed', '[]');
  check(backup.inspectBackup(made.dir).wouldDiscardNewer, 'standalone review evidence advances backup loss detection without a learning signal');
  check(refused(() => backup.restoreBackup(made.dir, { confirm: true })), 'new review evidence requires explicit overwrite consent');
  db().prepare('DELETE FROM review_runs WHERE id=?').run('audit-backup-review');
  db().prepare('INSERT INTO review_recipes (project_id,commands_json,updated_at) VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET updated_at=excluded.updated_at')
    .run(projectId, '["true"]', clock + 2);
  check(backup.inspectBackup(made.dir).wouldDiscardNewer, 'recipe changes also advance backup loss detection');

  fs.writeFileSync(artifact, 'newer local output retained in replaced folder');
  const restored = backup.restoreBackup(made.dir, { confirm: true, overwriteNewer: true });
  check(fs.readFileSync(artifact, 'utf8') === 'only generated copy', 'real restore reinstates generated artifacts');
  check(fs.readFileSync(path.join(restored.replacedDir, 'attachments', sessionIds[1], 'only-report.md'), 'utf8') === 'newer local output retained in replaced folder',
    'real restore preserves replaced artifacts for recovery');
  check(restored.relaunchRequired && fs.existsSync(path.join(root, 'wanigan.db')), 'artifact restore retains the database swap and relaunch contract');
  const restoredDb = new Database(path.join(root, 'wanigan.db'), { readonly: true });
  try {
    const row = restoredDb.prepare('SELECT stored_path FROM attachments WHERE id=?').get(relocated.id) as { stored_path: string };
    check(row.stored_path === relocated.storedPath, 'restore rebases structured attachment paths onto the destination machine');
  } finally { restoredDb.close(); }
  fs.rmSync(temporary, { recursive: true, force: true });
}
