import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

let _db: Database.Database | null = null;

export function dataDir(): string {
  return app.getPath('userData');
}
export function resultsDir(): string {
  return path.join(dataDir(), 'results');
}

/**
 * One database for the whole app. Projects are shared between the Sessions and
 * Batches views — an agent session and a batch run target the same repo, so
 * there is exactly one project list, not two.
 */
export function db(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(resultsDir(), { recursive: true });
  let d: Database.Database;
  try {
    d = new Database(path.join(dataDir(), 'foreman.db'));
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_DLOPEN_FAILED') {
      throw new Error(
        'better-sqlite3 was built for a different Node/Electron ABI. Run "npm run rebuild".'
      );
    }
    throw e;
  }
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  migrate(d);
  _db = d;
  return d;
}

function migrate(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id       TEXT PRIMARY KEY,
      path     TEXT NOT NULL UNIQUE,
      name     TEXT NOT NULL,
      branch   TEXT,
      added_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      preset            TEXT,
      project_id        TEXT,
      model             TEXT NOT NULL,
      status            TEXT NOT NULL,
      config_json       TEXT NOT NULL,
      total_requests    INTEGER NOT NULL DEFAULT 0,
      est_input_tokens  INTEGER NOT NULL DEFAULT 0,
      est_output_tokens INTEGER NOT NULL DEFAULT 0,
      est_cost_usd      REAL    NOT NULL DEFAULT 0,
      in_tokens         INTEGER NOT NULL DEFAULT 0,
      out_tokens        INTEGER NOT NULL DEFAULT 0,
      cache_read        INTEGER NOT NULL DEFAULT 0,
      cache_write       INTEGER NOT NULL DEFAULT 0,
      cost_usd          REAL    NOT NULL DEFAULT 0,
      parent_run_id     TEXT,
      error             TEXT,
      created_at        INTEGER NOT NULL,
      submitted_at      INTEGER,
      ended_at          INTEGER
    );

    CREATE TABLE IF NOT EXISTS batches (
      id                  TEXT PRIMARY KEY,
      run_id              TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      chunk_index         INTEGER NOT NULL,
      processing_status   TEXT NOT NULL,
      request_count       INTEGER NOT NULL,
      counts_json         TEXT,
      results_url         TEXT,
      results_ingested_at INTEGER,
      created_at          INTEGER NOT NULL,
      expires_at          INTEGER,
      ended_at            INTEGER,
      cancel_initiated_at INTEGER,
      last_polled_at      INTEGER,
      poll_interval_ms    INTEGER NOT NULL DEFAULT 15000
    );

    CREATE TABLE IF NOT EXISTS requests (
      run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      custom_id     TEXT NOT NULL,
      batch_id      TEXT,
      row_index     INTEGER NOT NULL,
      row_json      TEXT NOT NULL,
      rendered      TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      output_text   TEXT,
      output_json   TEXT,
      stop_reason   TEXT,
      error_type    TEXT,
      error_message TEXT,
      in_tokens     INTEGER NOT NULL DEFAULT 0,
      out_tokens    INTEGER NOT NULL DEFAULT 0,
      cache_read    INTEGER NOT NULL DEFAULT 0,
      cache_write   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id, custom_id)
    );

    CREATE TABLE IF NOT EXISTS events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id  TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      at      INTEGER NOT NULL,
      level   TEXT NOT NULL,
      message TEXT NOT NULL
    );

    -- Sessions are killed on quit (an orphaned agent burns tokens unseen), so
    -- the record of them has to outlive the process to be resumable.
    CREATE TABLE IF NOT EXISTS session_log (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT,
      provider_id     TEXT NOT NULL,
      project_id      TEXT,
      project_path    TEXT NOT NULL,
      project_name    TEXT NOT NULL,
      model           TEXT,
      effort          TEXT,
      permission_mode TEXT,
      started_at      INTEGER NOT NULL,
      ended_at        INTEGER,
      exit_code       INTEGER,
      resumed_from    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_session_log_recent  ON session_log(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_session_log_project ON session_log(project_id, started_at DESC);

    CREATE INDEX IF NOT EXISTS idx_requests_run_status ON requests(run_id, status);
    CREATE INDEX IF NOT EXISTS idx_batches_run  ON batches(run_id);
    CREATE INDEX IF NOT EXISTS idx_batches_open ON batches(processing_status)
      WHERE processing_status != 'ended';
    CREATE INDEX IF NOT EXISTS idx_events_run   ON events(run_id, at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
  `);
}

export function logEvent(runId: string, level: 'info' | 'warn' | 'error', message: string) {
  db().prepare('INSERT INTO events (run_id, at, level, message) VALUES (?,?,?,?)')
    .run(runId, Date.now(), level, message);
}

export function newRunId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `run_${stamp}_${Math.random().toString(36).slice(2, 6)}`;
}
