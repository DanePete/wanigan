import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { app } from 'electron';
import { db, dataDir, ensurePrivateDir, ensurePrivateFile } from './db';
import { transcriptsDir } from './transcripts';

/**
 * Backup and restore for the source of truth.
 *
 * Everything Wanigan claims to know lives in two places: `wanigan.db` and the
 * archived transcripts beside it. Goals, proofs, the policy ledger, the
 * knowledge record and every citation that makes a briefing checkable are rows
 * in that one file. Until this module existed the app could `forgetTranscript`
 * but never copy anything out, so a dead disk or a new laptop ended the record
 * permanently and nothing in the product ever said so.
 *
 * The copy is taken with `VACUUM INTO`, which is the only correct way to copy a
 * live SQLite database. Copying the bytes of a WAL database under a running app
 * captures a file whose committed pages are still in `-wal`, and the result
 * opens cleanly and is silently missing the most recent writes — the worst
 * possible failure for a backup, because it looks like it worked. `VACUUM INTO`
 * writes a consistent snapshot of the database as the connection sees it,
 * including committed WAL frames, without blocking writers for the duration.
 *
 * A backup is a directory rather than an archive: Wanigan has no archiver
 * dependency, and shelling out to `tar` to produce a file the user then cannot
 * inspect is worse than a folder they can open. The manifest carries a digest
 * for every file, so a restore can prove it is putting back what was taken.
 */

/** Bumped only if the layout below stops being readable by an older restore. */
const BACKUP_FORMAT = 'wanigan-backup';
const BACKUP_FORMAT_VERSION = 1;

const MANIFEST_NAME = 'wanigan-backup.json';
const DB_NAME = 'wanigan.db';
const TRANSCRIPTS_NAME = 'transcripts';

/** A manifest is Wanigan's own file; anything this size is not one. */
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

/**
 * What a backup deliberately does not carry. Said out loud, in the manifest and
 * in the report, because a user who thinks a backup is complete will not make a
 * second one — and the two omissions below are both unrecoverable by copying.
 */
const EXCLUDED = [
  'The API credential (apikey.bin). It is sealed by this machine’s keychain and would not decrypt anywhere else; re-enter the key after a restore.',
  'Staged attachments. They are the bulk of the data directory and every one of them is a copy of a file the user already has.',
  'MCP server trust and provider-pack trust. A grant to execute a local command is made on one machine, for one machine; restoring it silently would re-grant it.',
];

export type BackupFileEntry = { name: string; bytes: number; sha256: string };

type Manifest = {
  format: string;
  formatVersion: number;
  createdAt: number;
  appVersion: string;
  platform: string;
  database: BackupFileEntry;
  transcripts: { files: number; bytes: number; entries: BackupFileEntry[] };
  /** The newest recorded evidence in the copied database; see latestEvidenceAt. */
  latestEvidenceAt: number | null;
  excluded: string[];
};

export type BackupReport = {
  dir: string;
  manifestPath: string;
  createdAt: number;
  appVersion: string;
  database: { path: string; bytes: number; sha256: string };
  transcripts: { path: string; files: number; bytes: number };
  /** Observed total of the files written, manifest included. */
  totalBytes: number;
  latestEvidenceAt: number | null;
  excluded: string[];
  durationMs: number;
};

export type BackupProblem = { code: string; detail: string };

export type BackupInspection = {
  dir: string;
  createdAt: number | null;
  appVersion: string | null;
  database: { bytes: number; sha256: string } | null;
  transcripts: { files: number; bytes: number };
  latestEvidenceAt: number | null;
  /** The same measure taken over the database currently in place. */
  currentLatestEvidenceAt: number | null;
  /**
   * True when the database now in place carries evidence recorded after this
   * backup was taken, so restoring it would drop that work.
   */
  wouldDiscardNewer: boolean;
  /** Empty means the backup verified; anything here blocks a restore. */
  problems: BackupProblem[];
};

export type RestoreReport = {
  restoredFrom: string;
  createdAt: number;
  database: { bytes: number; sha256: string };
  transcripts: { files: number; bytes: number };
  /** Where the replaced database and transcripts were moved. Never deleted. */
  replacedDir: string;
  discardedNewer: boolean;
  /**
   * Always true. The database connection this process held was closed to swap
   * the file underneath it; every later db() call in this process will throw
   * until Wanigan restarts.
   */
  relaunchRequired: true;
};

/* ── how "newer" is decided ──────────────────────────────────────────── */

/**
 * Timestamp columns that only move forward as work happens. A file mtime would
 * be easier and would mean nothing: SQLite touches the database on any write,
 * including the housekeeping a launch does before the user has done anything.
 * These are records of things that happened, which is the question a restore
 * actually has to answer — "does the database I am about to replace contain
 * work this backup does not?"
 */
const EVIDENCE_CLOCKS: readonly (readonly [string, string])[] = [
  ['session_log', 'started_at'],
  ['session_log', 'ended_at'],
  ['session_events', 'at'],
  ['policy_ledger', 'at'],
  ['transcripts', 'archived_at'],
  ['runs', 'created_at'],
  ['learning_signals', 'created_at'],
  ['knowledge_versions', 'created_at'],
];

function hasColumn(d: Database.Database, table: string, column: string): boolean {
  // A backup can be older or newer than the running schema. A missing pair is a
  // schema difference, not a fault: it contributes no clock and is skipped.
  const rows = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((c) => c.name === column);
}

/** The newest recorded evidence in a database, or null if it holds none yet. */
function latestEvidenceAt(d: Database.Database): number | null {
  let latest: number | null = null;
  for (const [table, column] of EVIDENCE_CLOCKS) {
    if (!hasColumn(d, table, column)) continue;
    const row = d.prepare(`SELECT MAX(${column}) AS m FROM ${table}`).get() as { m: number | null };
    const value = Number(row?.m ?? 0);
    if (Number.isFinite(value) && value > 0 && (latest === null || value > latest)) latest = value;
  }
  return latest;
}

/* ── file helpers ────────────────────────────────────────────────────── */

/**
 * Digest in fixed-size reads. A single transcript here has been measured at
 * 10.9 MB and nothing bounds the largest one, so the whole file is deliberately
 * never held in memory at once.
 */
function digestFile(file: string): { sha256: string; bytes: number } {
  const hash = createHash('sha256');
  const buf = Buffer.allocUnsafe(1 << 20);
  const fd = fs.openSync(file, 'r');
  let bytes = 0;
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
      bytes += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: hash.digest('hex'), bytes };
}

function contained(base: string, full: string): boolean {
  return full === base || full.startsWith(base + path.sep);
}

/** Every entry in the transcripts directory that is a real file, sorted. */
function transcriptFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    // No transcripts directory is the normal state of a fresh install, not a
    // failure; anything else is worth surfacing.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries.filter((e) => e.isFile()).map((e) => e.name).sort();
}

/* ── taking a backup ─────────────────────────────────────────────────── */

/**
 * Copy the database and the archived transcripts into `destDir`.
 *
 * The destination must be empty or absent: writing into a directory that
 * already holds something means a half-overwritten backup if this fails, and a
 * manifest that no longer describes its neighbours if it succeeds.
 */
export function createBackup(destDir: string): BackupReport {
  const startedAt = Date.now();
  const dest = path.resolve(String(destDir ?? '').trim());
  if (!destDir || !path.isAbsolute(dest)) {
    throw new Error('Choose an absolute folder to write the backup into.');
  }

  const root = path.resolve(dataDir());
  if (contained(root, dest) || contained(dest, root)) {
    throw new Error(
      `${dest} is inside Wanigan’s own data folder (or contains it). A backup kept there dies with the ` +
      'thing it is backing up — choose an external disk or another folder.'
    );
  }

  const parent = path.dirname(dest);
  if (!fs.existsSync(parent)) throw new Error(`${parent} does not exist, so Wanigan cannot write a backup into it.`);
  if (fs.existsSync(dest)) {
    const existing = fs.readdirSync(dest);
    if (existing.length) {
      throw new Error(`${dest} is not empty. Pick a new folder so a failed backup cannot half-overwrite an older one.`);
    }
  }

  ensurePrivateDir(dest);
  const dbDest = path.join(dest, DB_NAME);
  const transcriptDest = path.join(dest, TRANSCRIPTS_NAME);

  const live = db();
  // VACUUM INTO refuses to overwrite, which is the behaviour we want: a
  // leftover file from an interrupted attempt fails loudly instead of being
  // appended to or trusted.
  live.prepare('VACUUM INTO ?').run(dbDest);
  ensurePrivateFile(dbDest);

  const dbEntry = digestFile(dbDest);

  // Read the clock from the copy, not from the live database: what the backup
  // can be said to contain is what is in the file that was written.
  const snapshot = new Database(dbDest, { readonly: true });
  let evidenceAt: number | null = null;
  try {
    const check = snapshot.pragma('integrity_check', { simple: true });
    if (check !== 'ok') {
      throw new Error(`The copied database did not pass SQLite’s integrity check (${String(check)}). The backup was not completed.`);
    }
    evidenceAt = latestEvidenceAt(snapshot);
  } finally {
    snapshot.close();
  }

  ensurePrivateDir(transcriptDest);
  const source = transcriptsDir();
  const entries: BackupFileEntry[] = [];
  let transcriptBytes = 0;
  for (const name of transcriptFiles(source)) {
    const to = path.join(transcriptDest, name);
    fs.copyFileSync(path.join(source, name), to, fs.constants.COPYFILE_EXCL);
    ensurePrivateFile(to);
    // Digest the copy rather than the original, so the manifest describes the
    // bytes that actually landed.
    const entry = digestFile(to);
    entries.push({ name, bytes: entry.bytes, sha256: entry.sha256 });
    transcriptBytes += entry.bytes;
  }

  const manifest: Manifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: startedAt,
    appVersion: app.getVersion(),
    platform: `${process.platform} ${os.release()}`,
    database: { name: DB_NAME, bytes: dbEntry.bytes, sha256: dbEntry.sha256 },
    transcripts: { files: entries.length, bytes: transcriptBytes, entries },
    latestEvidenceAt: evidenceAt,
    excluded: EXCLUDED,
  };

  const manifestPath = path.join(dest, MANIFEST_NAME);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  ensurePrivateFile(manifestPath);

  const manifestBytes = fs.statSync(manifestPath).size;
  return {
    dir: dest,
    manifestPath,
    createdAt: startedAt,
    appVersion: manifest.appVersion,
    database: { path: dbDest, bytes: dbEntry.bytes, sha256: dbEntry.sha256 },
    transcripts: { path: transcriptDest, files: entries.length, bytes: transcriptBytes },
    totalBytes: dbEntry.bytes + transcriptBytes + manifestBytes,
    latestEvidenceAt: evidenceAt,
    excluded: [...EXCLUDED],
    durationMs: Date.now() - startedAt,
  };
}

/* ── reading a backup before trusting it ─────────────────────────────── */

function readManifest(dir: string): { manifest: Manifest | null; problems: BackupProblem[] } {
  const problems: BackupProblem[] = [];
  const file = path.join(dir, MANIFEST_NAME);
  let raw: unknown;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) {
      problems.push({ code: 'manifest-unreadable', detail: `${MANIFEST_NAME} is not a readable manifest file.` });
      return { manifest: null, problems };
    }
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    const message = (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? `${dir} has no ${MANIFEST_NAME}, so it is not a Wanigan backup.`
      : `${MANIFEST_NAME} could not be read: ${error instanceof Error ? error.message : String(error)}`;
    problems.push({ code: 'manifest-unreadable', detail: message });
    return { manifest: null, problems };
  }

  const m = raw as Partial<Manifest>;
  if (!m || typeof m !== 'object' || m.format !== BACKUP_FORMAT) {
    problems.push({ code: 'not-a-backup', detail: `${dir} does not contain a Wanigan backup manifest.` });
    return { manifest: null, problems };
  }
  if (m.formatVersion !== BACKUP_FORMAT_VERSION) {
    problems.push({
      code: 'format-version',
      detail: `This backup uses format version ${String(m.formatVersion)}; this Wanigan reads version ${BACKUP_FORMAT_VERSION}.`,
    });
    return { manifest: null, problems };
  }
  const database = m.database;
  if (!database || typeof database.sha256 !== 'string' || typeof database.bytes !== 'number') {
    problems.push({ code: 'manifest-incomplete', detail: 'The manifest does not describe a database file.' });
    return { manifest: null, problems };
  }
  const transcripts = m.transcripts;
  const list = Array.isArray(transcripts?.entries) ? transcripts.entries : [];
  return {
    manifest: {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: typeof m.createdAt === 'number' ? m.createdAt : 0,
      appVersion: typeof m.appVersion === 'string' ? m.appVersion : 'unknown',
      platform: typeof m.platform === 'string' ? m.platform : 'unknown',
      database: { name: DB_NAME, bytes: database.bytes, sha256: database.sha256 },
      transcripts: {
        files: list.length,
        bytes: typeof transcripts?.bytes === 'number' ? transcripts.bytes : 0,
        entries: list.filter((e): e is BackupFileEntry =>
          !!e && typeof e.name === 'string' && typeof e.bytes === 'number' && typeof e.sha256 === 'string'),
      },
      latestEvidenceAt: typeof m.latestEvidenceAt === 'number' ? m.latestEvidenceAt : null,
      excluded: Array.isArray(m.excluded) ? m.excluded.filter((x): x is string => typeof x === 'string') : [],
    },
    problems,
  };
}

/**
 * Verify a backup and say what restoring it would cost, without changing
 * anything. Every problem found is reported; the first one is not thrown,
 * because a user deciding whether to restore wants the whole list.
 */
export function inspectBackup(dir: string): BackupInspection {
  const root = path.resolve(String(dir ?? '').trim());
  const { manifest, problems } = readManifest(root);

  const empty: BackupInspection = {
    dir: root,
    createdAt: manifest?.createdAt ?? null,
    appVersion: manifest?.appVersion ?? null,
    database: null,
    transcripts: { files: 0, bytes: 0 },
    latestEvidenceAt: manifest?.latestEvidenceAt ?? null,
    currentLatestEvidenceAt: null,
    wouldDiscardNewer: false,
    problems,
  };
  if (!manifest) return empty;

  const dbFile = path.join(root, DB_NAME);
  let dbDigest: { sha256: string; bytes: number } | null = null;
  try {
    dbDigest = digestFile(dbFile);
  } catch (error) {
    problems.push({
      code: 'database-missing',
      detail: `${DB_NAME} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  if (dbDigest && dbDigest.sha256 !== manifest.database.sha256) {
    problems.push({
      code: 'database-changed',
      detail: 'The database in this folder is not the one the manifest describes. It was edited, truncated or replaced after the backup was taken.',
    });
  }

  let backupEvidenceAt = manifest.latestEvidenceAt;
  if (dbDigest && !problems.some((p) => p.code === 'database-changed')) {
    try {
      const snapshot = new Database(dbFile, { readonly: true });
      try {
        const check = snapshot.pragma('integrity_check', { simple: true });
        if (check !== 'ok') {
          problems.push({ code: 'database-corrupt', detail: `SQLite reports this database as damaged (${String(check)}).` });
        } else {
          // Trust the file over the manifest for the clock: they agree unless
          // someone rewrote one of them, and the file is the thing being put
          // back.
          backupEvidenceAt = latestEvidenceAt(snapshot);
        }
      } finally {
        snapshot.close();
      }
    } catch (error) {
      problems.push({
        code: 'database-unopenable',
        detail: `SQLite could not open this database: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  let transcriptBytes = 0;
  let transcriptFilesFound = 0;
  for (const entry of manifest.transcripts.entries) {
    // The name is data from a file on disk and becomes a path segment.
    if (entry.name !== path.basename(entry.name) || entry.name === '.' || entry.name === '..') {
      problems.push({ code: 'transcript-name', detail: `"${entry.name}" is not a usable transcript file name.` });
      continue;
    }
    const file = path.join(root, TRANSCRIPTS_NAME, entry.name);
    try {
      const found = digestFile(file);
      transcriptFilesFound += 1;
      transcriptBytes += found.bytes;
      if (found.sha256 !== entry.sha256) {
        problems.push({ code: 'transcript-changed', detail: `${entry.name} does not match the digest recorded for it.` });
      }
    } catch {
      problems.push({ code: 'transcript-missing', detail: `${entry.name} is named in the manifest but is not in this folder.` });
    }
  }

  let currentEvidenceAt: number | null = null;
  try {
    currentEvidenceAt = latestEvidenceAt(db());
  } catch (error) {
    problems.push({
      code: 'current-database-unreadable',
      detail: `Wanigan could not read the database now in place, so it cannot tell whether restoring would discard newer work: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return {
    dir: root,
    createdAt: manifest.createdAt,
    appVersion: manifest.appVersion,
    database: dbDigest,
    transcripts: { files: transcriptFilesFound, bytes: transcriptBytes },
    latestEvidenceAt: backupEvidenceAt,
    currentLatestEvidenceAt: currentEvidenceAt,
    wouldDiscardNewer:
      currentEvidenceAt !== null && (backupEvidenceAt === null || currentEvidenceAt > backupEvidenceAt),
    problems,
  };
}

/* ── putting a backup back ───────────────────────────────────────────── */

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Undo a partial swap. Each move is independent, so each is undone on its own. */
function undo(moves: { from: string; to: string }[]): string[] {
  const failed: string[] = [];
  for (const move of moves.reverse()) {
    try {
      fs.rmSync(move.to, { recursive: true, force: true });
      fs.renameSync(move.from, move.to);
    } catch (error) {
      failed.push(`${move.to} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return failed;
}

/**
 * Replace the live database and transcripts with a verified backup.
 *
 * Three deliberate refusals. It will not run without `confirm`, because this
 * discards data and nothing here should be reachable by a stray call. It will
 * not run on a backup with any problem, because a restore that half-verifies is
 * a second way to lose everything. And it will not silently overwrite a
 * database holding evidence recorded after the backup was taken — that needs
 * `overwriteNewer`, set only by someone who has been shown both dates.
 *
 * Nothing is deleted. The replaced database and transcripts are moved into a
 * dated folder inside the data directory and left there; a restore is exactly
 * the moment when the thing you just replaced turns out to have mattered.
 *
 * The swap closes this process's database connection. Wanigan must relaunch
 * immediately afterwards — see `relaunchRequired`. Later db() calls in this
 * process throw rather than reading a file that has moved out from under them,
 * which is the failure a caller can see.
 */
export function restoreBackup(
  dir: string,
  opts: { confirm: boolean; overwriteNewer?: boolean }
): RestoreReport {
  if (!opts?.confirm) {
    throw new Error('Restoring replaces the database in place. Confirm it explicitly before calling this.');
  }

  const inspection = inspectBackup(dir);
  if (inspection.problems.length) {
    throw new Error(
      `This backup did not verify, so nothing was changed:\n- ${inspection.problems.map((p) => p.detail).join('\n- ')}`
    );
  }
  if (!inspection.database) throw new Error('This backup has no database to restore.');

  if (inspection.wouldDiscardNewer && !opts.overwriteNewer) {
    const backupAt = inspection.latestEvidenceAt ? new Date(inspection.latestEvidenceAt).toISOString() : 'nothing recorded';
    const currentAt = inspection.currentLatestEvidenceAt
      ? new Date(inspection.currentLatestEvidenceAt).toISOString()
      : 'nothing recorded';
    throw new Error(
      `The database in place records work up to ${currentAt}; this backup stops at ${backupAt}. ` +
      'Restoring would drop everything in between. Take a backup of the current database first, then confirm ' +
      'that you want to overwrite it anyway.'
    );
  }

  const root = path.resolve(dataDir());
  const source = path.resolve(String(dir).trim());
  const liveDb = path.join(root, DB_NAME);
  const liveTranscripts = path.resolve(transcriptsDir());

  // Stage a verified copy inside the data directory first. Both moves below are
  // then renames on one filesystem, which is the only form of "swap" that
  // cannot leave a half-written file in place of a database.
  const staging = path.join(root, `.restore-staging-${stamp()}`);
  if (fs.existsSync(staging)) throw new Error(`${staging} already exists; another restore may be in progress.`);
  ensurePrivateDir(staging);

  const replaced = path.join(root, `replaced-${stamp()}`);
  const moves: { from: string; to: string }[] = [];

  try {
    const stagedDb = path.join(staging, DB_NAME);
    fs.copyFileSync(path.join(source, DB_NAME), stagedDb, fs.constants.COPYFILE_EXCL);
    ensurePrivateFile(stagedDb);
    const stagedDigest = digestFile(stagedDb);
    if (stagedDigest.sha256 !== inspection.database.sha256) {
      throw new Error('The database changed while it was being copied. Nothing was replaced.');
    }

    const stagedTranscripts = path.join(staging, TRANSCRIPTS_NAME);
    ensurePrivateDir(stagedTranscripts);
    let transcriptFileCount = 0;
    let transcriptByteCount = 0;
    for (const name of transcriptFiles(path.join(source, TRANSCRIPTS_NAME))) {
      const to = path.join(stagedTranscripts, name);
      fs.copyFileSync(path.join(source, TRANSCRIPTS_NAME, name), to, fs.constants.COPYFILE_EXCL);
      ensurePrivateFile(to);
      transcriptFileCount += 1;
      transcriptByteCount += fs.statSync(to).size;
    }

    // Past this point the live files move. Close the connection first: renaming
    // a WAL database out from under an open handle leaves SQLite writing to an
    // inode nobody will read again, and can damage the file that replaces it.
    try {
      const live = db();
      if (live.open) {
        live.pragma('wal_checkpoint(TRUNCATE)');
        live.close();
      }
    } catch (error) {
      throw new Error(
        `Wanigan could not close its database before restoring, so nothing was replaced (${error instanceof Error ? error.message : String(error)}).`
      );
    }

    ensurePrivateDir(replaced);
    // -wal and -shm carry committed pages that are not in the main file yet.
    // Leaving either beside a restored database would corrupt it.
    for (const suffix of ['', '-wal', '-shm']) {
      const from = `${liveDb}${suffix}`;
      if (!fs.existsSync(from)) continue;
      const to = path.join(replaced, `${DB_NAME}${suffix}`);
      fs.renameSync(from, to);
      moves.push({ from: to, to: from });
    }
    if (fs.existsSync(liveTranscripts)) {
      const to = path.join(replaced, TRANSCRIPTS_NAME);
      fs.renameSync(liveTranscripts, to);
      moves.push({ from: to, to: liveTranscripts });
    }

    fs.renameSync(stagedDb, liveDb);
    fs.renameSync(stagedTranscripts, liveTranscripts);
    fs.rmSync(staging, { recursive: true, force: true });

    return {
      restoredFrom: source,
      createdAt: inspection.createdAt ?? 0,
      database: { bytes: stagedDigest.bytes, sha256: stagedDigest.sha256 },
      transcripts: { files: transcriptFileCount, bytes: transcriptByteCount },
      replacedDir: replaced,
      discardedNewer: inspection.wouldDiscardNewer,
      relaunchRequired: true,
    };
  } catch (error) {
    const stuck = undo(moves);
    try { fs.rmSync(staging, { recursive: true, force: true }); }
    catch { /* the staged copy is inert; the message below matters more */ }
    const detail = error instanceof Error ? error.message : String(error);
    if (stuck.length) {
      // The one case that cannot be papered over: say exactly where the
      // originals are rather than letting a half-swap look like a clean failure.
      throw new Error(
        `${detail}\n\nWanigan could not put everything back: ${stuck.join(', ')}. ` +
        `The previous database and transcripts are in ${replaced}. Do not launch Wanigan until they are moved back.`
      );
    }
    throw new Error(detail);
  }
}
