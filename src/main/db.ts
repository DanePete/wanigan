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
  migratePhases(d);
}

/** Idempotent ALTER TABLE — SQLite has no "ADD COLUMN IF NOT EXISTS". */
function addColumn(d: Database.Database, table: string, column: string, decl: string) {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

/**
 * Everything phases 1-20 store. Kept in one migration so a feature module
 * never has to reach for CREATE TABLE at call time — the schema is the
 * contract, and it exists before any of them run.
 */
function migratePhases(d: Database.Database) {
  d.exec(`
    -- P1 · telemetry ---------------------------------------------------
    -- Counters arrive as deltas on a 10s interval; one row per session per
    -- metric keeps the running total cheap to read.
    CREATE TABLE IF NOT EXISTS session_metrics (
      session_id TEXT NOT NULL,
      metric     TEXT NOT NULL,
      attrs      TEXT NOT NULL DEFAULT '',
      value      REAL NOT NULL DEFAULT 0,
      last_at    INTEGER NOT NULL,
      PRIMARY KEY (session_id, metric, attrs)
    );

    CREATE TABLE IF NOT EXISTS session_api_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      at          INTEGER NOT NULL,
      kind        TEXT NOT NULL,
      model       TEXT,
      cost_usd    REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER,
      in_tokens   INTEGER NOT NULL DEFAULT 0,
      out_tokens  INTEGER NOT NULL DEFAULT 0,
      cache_read  INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0,
      effort      TEXT,
      detail      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_api_events_session ON session_api_events(session_id, at DESC);
    CREATE INDEX IF NOT EXISTS idx_api_events_at      ON session_api_events(at DESC);

    -- P2 · hook bus ----------------------------------------------------
    CREATE TABLE IF NOT EXISTS session_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      at          INTEGER NOT NULL,
      event       TEXT NOT NULL,
      tool_name   TEXT,
      summary     TEXT,
      duration_ms INTEGER,
      ok          INTEGER,
      paths_json  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_session_events ON session_events(session_id, at DESC);
    CREATE INDEX IF NOT EXISTS idx_session_events_at ON session_events(at DESC);

    -- P4 · transcript archive ------------------------------------------
    CREATE TABLE IF NOT EXISTS transcripts (
      session_id  TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      bytes       INTEGER NOT NULL DEFAULT 0,
      turns       INTEGER NOT NULL DEFAULT 0,
      parsed      INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER NOT NULL,
      note        TEXT
    );

    -- Search is over text only; the raw file on disk stays the record of truth.
    CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
      session_id UNINDEXED, role UNINDEXED, at UNINDEXED, text
    );

    -- P9 · worktrees ---------------------------------------------------
    CREATE TABLE IF NOT EXISTS worktrees (
      path       TEXT PRIMARY KEY,
      repo_root  TEXT NOT NULL,
      branch     TEXT,
      session_id TEXT,
      created_at INTEGER NOT NULL,
      removed_at INTEGER
    );

    -- P10 · headless fan-out -------------------------------------------
    CREATE TABLE IF NOT EXISTS headless_rows (
      run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      project_id    TEXT NOT NULL,
      project_name  TEXT NOT NULL,
      project_path  TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      cost_usd      REAL NOT NULL DEFAULT 0,
      duration_ms   INTEGER,
      exit_code     INTEGER,
      output        TEXT,
      error         TEXT,
      files_changed INTEGER NOT NULL DEFAULT 0,
      worktree      TEXT,
      started_at    INTEGER,
      ended_at      INTEGER,
      PRIMARY KEY (run_id, project_id)
    );

    -- P11 · dispatcher --------------------------------------------------
    CREATE TABLE IF NOT EXISTS queue (
      id             TEXT PRIMARY KEY,
      kind           TEXT NOT NULL,
      state          TEXT NOT NULL DEFAULT 'waiting',
      priority       INTEGER NOT NULL DEFAULT 100,
      label          TEXT NOT NULL,
      payload_json   TEXT NOT NULL,
      blocked_by     TEXT,
      attempts       INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      created_at     INTEGER NOT NULL,
      started_at     INTEGER,
      ended_at       INTEGER,
      error          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_queue_ready ON queue(state, priority, created_at);

    -- P12 · MCP ---------------------------------------------------------
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id         TEXT PRIMARY KEY,
      project_id TEXT,
      name       TEXT NOT NULL,
      transport  TEXT NOT NULL,
      command    TEXT,
      args       TEXT,
      url        TEXT,
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mcp_status (
      id         TEXT PRIMARY KEY,
      connected  INTEGER NOT NULL DEFAULT 0,
      last_at    INTEGER,
      last_error TEXT,
      tool_calls INTEGER NOT NULL DEFAULT 0
    );

    -- P13 · uploaded rows ----------------------------------------------
    -- Keyed by content hash so a re-run of the same audit re-uses the upload.
    CREATE TABLE IF NOT EXISTS uploads (
      hash        TEXT PRIMARY KEY,
      file_id     TEXT NOT NULL,
      path        TEXT NOT NULL,
      bytes       INTEGER NOT NULL,
      media_type  TEXT NOT NULL,
      uploaded_at INTEGER NOT NULL,
      last_used_at INTEGER
    );

    -- P17 · evals -------------------------------------------------------
    CREATE TABLE IF NOT EXISTS eval_pairs (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      run_a      TEXT NOT NULL,
      run_b      TEXT NOT NULL,
      variable   TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS eval_scores (
      pair_id   TEXT NOT NULL,
      custom_id TEXT NOT NULL,
      score     REAL,
      winner    TEXT,
      rationale TEXT,
      judge_run TEXT,
      PRIMARY KEY (pair_id, custom_id)
    );
    CREATE TABLE IF NOT EXISTS golden_sets (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      rows_json     TEXT NOT NULL,
      row_count     INTEGER NOT NULL DEFAULT 0,
      source_run_id TEXT,
      created_at    INTEGER NOT NULL
    );

    -- P18 · budgets -----------------------------------------------------
    CREATE TABLE IF NOT EXISTS budgets (
      scope_id    TEXT PRIMARY KEY,
      monthly_usd REAL NOT NULL DEFAULT 0,
      warn_at     REAL NOT NULL DEFAULT 0.8
    );

    -- P19 · policy ledger -----------------------------------------------
    -- Append-only on purpose: a record you can edit is not a record.
    CREATE TABLE IF NOT EXISTS policy_ledger (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      at         INTEGER NOT NULL,
      session_id TEXT,
      project_id TEXT,
      trust      TEXT NOT NULL,
      tool_name  TEXT NOT NULL,
      summary    TEXT NOT NULL,
      decision   TEXT NOT NULL,
      rule       TEXT NOT NULL,
      reason     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_at ON policy_ledger(at DESC);

    -- P25 · durable schedules ------------------------------------------
    -- Claude Code's own /loop is session-scoped and expires after seven days,
    -- which is the right call for something that only fires while a terminal
    -- is open. Foreman's whole reason to hold this is that it is not a
    -- session: these survive a quit, and they do not expire.
    CREATE TABLE IF NOT EXISTS schedules (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      cron         TEXT NOT NULL,
      kind         TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      project_id   TEXT,
      enabled      INTEGER NOT NULL DEFAULT 1,
      created_at   INTEGER NOT NULL,
      next_at      INTEGER,
      last_at      INTEGER,
      last_status  TEXT,
      last_detail  TEXT,
      runs         INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_at);

    CREATE TABLE IF NOT EXISTS schedule_runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id TEXT NOT NULL,
      at          INTEGER NOT NULL,
      status      TEXT NOT NULL,
      detail      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_schedule_runs ON schedule_runs(schedule_id, at DESC);

    CREATE TABLE IF NOT EXISTS project_trust (
      project_id TEXT PRIMARY KEY,
      trust      TEXT NOT NULL,
      set_at     INTEGER NOT NULL
    );
  `);

  // Runs carry batches, headless fan-outs, evals and judge passes. One table,
  // so Insights and budgets never need a special case per surface.
  addColumn(d, 'runs', 'kind', "TEXT NOT NULL DEFAULT 'batch'");
  addColumn(d, 'runs', 'eval_pair_id', 'TEXT');
  // A session can run in its own worktree; the code panel scopes to it.
  addColumn(d, 'session_log', 'worktree', 'TEXT');
  addColumn(d, 'session_log', 'trust', 'TEXT');
  d.exec("CREATE INDEX IF NOT EXISTS idx_runs_kind ON runs(kind, created_at DESC)");
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
