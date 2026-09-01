import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

let _db: Database.Database | null = null;

/** App data holds prompts, transcript indexes, result payloads, and credentials.
 * Keep every Wanigan-owned directory private even when it already existed with a
 * permissive umask or was carried forward from an older install. */
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export function ensurePrivateDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  // mkdir's mode applies only to a new leaf and is filtered by umask. Existing
  // directories retain their previous mode, so correct both cases explicitly.
  fs.chmodSync(dir, PRIVATE_DIR_MODE);
  return dir;
}

export function ensurePrivateFile(file: string): string {
  // writeFile/createWriteStream's mode only applies when creating a file. A
  // rerun must not leave an older, wider file readable by another local user.
  fs.chmodSync(file, PRIVATE_FILE_MODE);
  return file;
}

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
  const root = ensurePrivateDir(dataDir());
  ensurePrivateDir(resultsDir());
  const file = path.join(root, 'wanigan.db');
  let d: Database.Database;
  try {
    d = new Database(file);
    ensurePrivateFile(file);
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_DLOPEN_FAILED') {
      throw new Error(
        'better-sqlite3 was built for a different Node/Electron ABI. Run "npm run rebuild".'
      );
    }
    throw e;
  }
  // Wanigan's attended app, launchd scheduler and CLI can open the same file
  // at the same time. Let a short schema/write lock settle instead of failing
  // a whole process with SQLITE_BUSY on startup.
  d.pragma('busy_timeout = 10000');
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  migrateSchema(d);
  // SQLite's journal files carry the same rows as the primary database. The
  // private userData root is the durable boundary; tightening sidecars too
  // avoids relying on it if an older install had inherited broad permissions.
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${file}${suffix}`;
    if (fs.existsSync(candidate)) ensurePrivateFile(candidate);
  }
  _db = d;
  return d;
}

/**
 * Upgrade a Wanigan-owned connection in one atomic transaction.
 *
 * This is exported so the smoke suite can open a deliberately old schema and
 * prove that an upgrade remains safe before a released build ever sees it.
 */
export function migrateSchema(d: Database.Database) {
  // `addColumn()` is necessarily a read-then-write operation because SQLite
  // lacks ADD COLUMN IF NOT EXISTS.  A deferred transaction lets two Wanigan
  // processes both read "missing" before either alters the table.  Taking the
  // write reservation first makes migrations one ordered, all-or-nothing
  // operation across the desktop app, daemon and CLI.
  d.exec('BEGIN IMMEDIATE');
  try {
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
    d.exec('COMMIT');
  } catch (error) {
    try { d.exec('ROLLBACK'); } catch { /* the BEGIN itself may have failed */ }
    throw error;
  }
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
    -- Spend and cache totals sum one metric across every session. The primary
    -- key leads with session_id, so a metric-only filter has nothing to seek on
    -- and reads the whole table. Carrying attrs and value answers those sums
    -- from the index alone, without a temp b-tree per group.
    CREATE INDEX IF NOT EXISTS idx_session_metrics_metric
      ON session_metrics(metric, attrs, value);

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
    -- The effort breakdowns filter kind='request', with and without a time
    -- window, and neither index above leads with kind. Carrying effort and
    -- cost_usd is what makes this worth having: most rows in this table are
    -- requests, so an index on kind alone still fetches nearly every row from
    -- the table and measures slower than the scan it replaces.
    CREATE INDEX IF NOT EXISTS idx_api_events_kind
      ON session_api_events(kind, at DESC, effort, cost_usd);

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
    -- This also bounds the prune: a DESC index still serves an at < ? range, so
    -- deleting past an age cutoff visits only the rows it removes.
    CREATE INDEX IF NOT EXISTS idx_session_events_at ON session_events(at DESC);
    -- serverStatuses() asks this table for every mcp__ tool call each time
    -- Settings opens. GLOB is case-sensitive, so SQLite can use an index for the
    -- prefix; without one it is a full scan of a table that grows with every
    -- tool call.
    CREATE INDEX IF NOT EXISTS idx_session_events_tool ON session_events(tool_name);
    -- That aggregate also reads event, at and ok for every matched row, so the
    -- name-only index still sends it to the table once per call. Carrying the
    -- other three columns keeps the whole read inside the index. The narrow
    -- index above is deliberately left in place: this migration is additive,
    -- and SQLite picks whichever of the two is cheaper for a given query.
    CREATE INDEX IF NOT EXISTS idx_session_events_tool_usage
      ON session_events(tool_name, event, at, ok);

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
      error          TEXT,
      -- A durable owner is essential because the UI and daemon are separate
      -- processes.  A local in-memory map cannot tell a live daemon worker
      -- from a crashed one.
      lease_owner    TEXT,
      lease_expires_at INTEGER
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
    -- There was an mcp_status table here (connected, last_at, last_error,
    -- tool_calls) and nothing ever wrote a row into it: Wanigan hands an MCP
    -- config to the CLI, which spawns the servers inside the session's own
    -- process tree and reports nothing back. A permanently empty table is an
    -- invitation to the next reader to believe it means something, so new
    -- installs no longer get one. It is deliberately NOT dropped for existing
    -- installs — a migration that destroys rows is a migration nobody can trust
    -- the next time one of these needs to run, and an empty table costs a page.
    -- Server use is now derived from session_events; see mcp/registry.ts.

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
    -- ledgerSummary() counts every row grouped by decision and takes MIN(at)
    -- per group, over a table that is append-only by design and so never gets
    -- smaller. at is in the index for the same reason as above: on decision
    -- alone SQLite walks the index and then still reads every row for the
    -- minimum, which measures slower than the scan it replaced.
    CREATE INDEX IF NOT EXISTS idx_ledger_decision ON policy_ledger(decision, at);

    -- P25 · durable schedules ------------------------------------------
    -- Claude Code's own /loop is session-scoped and expires after seven days,
    -- which is the right call for something that only fires while a terminal
    -- is open. Wanigan's whole reason to hold this is that it is not a
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

    -- A review recipe is operator-owned commands plus the immutable evidence
    -- from each execution. Agents may suggest commands; only this surface runs
    -- the configured gate and records its result.
    CREATE TABLE IF NOT EXISTS review_recipes (
      project_id TEXT PRIMARY KEY,
      commands_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS review_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT NOT NULL,
      results_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_runs_project ON review_runs(project_id, started_at DESC);
  `);

  // Runs carry batches, headless fan-outs, evals and judge passes. One table,
  // so Insights and budgets never need a special case per surface.
  addColumn(d, 'runs', 'kind', "TEXT NOT NULL DEFAULT 'batch'");
  addColumn(d, 'runs', 'eval_pair_id', 'TEXT');
  // A session can run in its own worktree; the code panel scopes to it.
  addColumn(d, 'worktrees', 'linked_json', 'TEXT');
  addColumn(d, 'session_log', 'worktree', 'TEXT');
  addColumn(d, 'session_log', 'trust', 'TEXT');
  // The binary that actually ran, resolved path and all. provider_id stopped
  // being able to answer "which CLI produced this" the moment claude and glm
  // became two ids on one program, and a reader six months from now has only
  // this row: without it a glm transcript and a claude transcript are
  // indistinguishable from a codex one that never wrote a file at all.
  addColumn(d, 'session_log', 'bin', 'TEXT');
  addColumn(d, 'session_log', 'capabilities_json', 'TEXT');
  // Foreign sessions are observed, never recorded. Nothing writes a row with a
  // non-default value yet — observed.ts inserts nothing at all — so this is a
  // precondition rather than a dependency: the next person cannot write a row
  // from outside Wanigan without declaring it foreign, and history, spend and
  // resume exclude it by the shape of the query rather than by remembering.
  addColumn(d, 'session_log', 'origin', "TEXT NOT NULL DEFAULT 'wanigan'");
  // Revert measures a session's work against the HEAD and dirty paths observed
  // when it started. Keeping that baseline only in memory loses it at exactly
  // the moment an operator reaches for undo — after a restart — and a revert
  // without one cannot tell this agent's edits from work that was already there.
  addColumn(d, 'session_log', 'baseline_head', 'TEXT');
  addColumn(d, 'session_log', 'baseline_dirty_json', 'TEXT');
  // What the operator actually asked for at launch. It seeds the briefing query
  // and is typed into the PTY, and after that only the scrollback holds it — so
  // a session's own row cannot say what the session was started to do, which is
  // the first question anyone asks of a finished one. The writer must pass this
  // through redactCredentials() from ./redact and bound its length before it
  // lands: a launch prompt is exactly where a pasted key ends up, and this row
  // outlives the terminal that showed it.
  addColumn(d, 'session_log', 'initial_prompt', 'TEXT');
  // The display name: derived from the redacted launch prompt when one was
  // given, or set by a rename. Never derived from conversation content.
  addColumn(d, 'session_log', 'title', 'TEXT');
  // A fire and the run it dispatched were linked only by a prefix of the run's
  // name, which is a display string a rename breaks. headless.ts writes the
  // terminal outcome back onto the fire, and that write needs an id an operator
  // cannot edit out from under it. Nullable: a fire can be spent on work that
  // creates no run row, and every row written before this column existed has no
  // answer to give.
  addColumn(d, 'schedule_runs', 'run_id', 'TEXT');
  addColumn(d, 'queue', 'lease_owner', 'TEXT');
  addColumn(d, 'queue', 'lease_expires_at', 'INTEGER');
  // This must follow the additive columns above. `CREATE TABLE IF NOT
  // EXISTS` leaves a pre-lease queue untouched, and attempting this index
  // first makes SQLite abort the entire migration with "no such column".
  d.exec('CREATE INDEX IF NOT EXISTS idx_queue_lease ON queue(state, lease_expires_at)');
  d.exec("CREATE INDEX IF NOT EXISTS idx_runs_kind ON runs(kind, created_at DESC)");
  // Ordered after the ALTER above for the same reason as the queue index. The
  // read is "which fire does this run answer for", once per run that finishes,
  // so this is not a tight loop — but schedule_runs only accumulates and no
  // existing index starts at run_id, which leaves a full scan that grows with
  // every fire ever dispatched. Partial because a fire that produced no run has
  // nothing to find here, and SQLite leaves NULLs out of a partial index.
  d.exec(
    'CREATE INDEX IF NOT EXISTS idx_schedule_runs_run ON schedule_runs(run_id) '
    + 'WHERE run_id IS NOT NULL'
  );
  migrateLearning(d);
  migrateControl(d);
  migrateImprovementScout(d);
  migrateCheckpoints(d);
  migrateConversationFlags(d);
}

/**
 * Pin/settle lifecycle for Recent conversations, keyed by the same
 * harness-scoped conversation key Recent groups by. Forgetting stays the only
 * destructive act — these flags reorder and shelve, never delete.
 */
function migrateConversationFlags(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS conversation_flags (
      key        TEXT PRIMARY KEY,
      pinned_at  INTEGER,
      settled_at INTEGER
    );
  `);
}

/**
 * Per-turn workspace checkpoints. Each row names a hidden git commit kept
 * alive by refs/wanigan/checkpoints/<session>; the table is the map from a
 * session's turns to those commits. Rows outlive the session so diffs and
 * reverts still work after a restart, and the migration is additive so
 * removing the feature can never cost existing history.
 */
function migrateCheckpoints(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS session_checkpoints (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL,
      turn          INTEGER NOT NULL,
      kind          TEXT NOT NULL,
      at            INTEGER NOT NULL,
      repo_root     TEXT NOT NULL,
      commit_hash   TEXT,
      tree_hash     TEXT,
      files_changed INTEGER,
      status        TEXT NOT NULL DEFAULT 'ok',
      detail        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_session_checkpoints
      ON session_checkpoints(session_id, turn, at);
  `);
}

/**
 * Wanigan Compound's provider-neutral learning store.
 *
 * The raw provider transcript remains in the provider-owned/archive location.
 * These tables hold bounded operational signals, canonical knowledge,
 * provenance, and the exact reversible projection that was offered or applied.
 * Keeping this migration additive is important: uninstalling a provider pack
 * must never erase the knowledge or evidence produced while it was installed.
 */
function migrateLearning(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS learning_signals (
      id                TEXT PRIMARY KEY,
      kind              TEXT NOT NULL,
      provider_id       TEXT,
      backend_id        TEXT,
      session_id        TEXT,
      task_hash         TEXT,
      project_id        TEXT,
      project_path      TEXT,
      path_scope        TEXT,
      summary           TEXT NOT NULL,
      detail_json       TEXT NOT NULL DEFAULT '{}',
      content_hash      TEXT NOT NULL UNIQUE,
      semantic_eligible INTEGER NOT NULL DEFAULT 0,
      created_at        INTEGER NOT NULL,
      processed_at      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_learning_signals_project
      ON learning_signals(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_learning_signals_provider_processed
      ON learning_signals(provider_id, processed_at, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_learning_signals_task
      ON learning_signals(task_hash, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_learning_signals_session
      ON learning_signals(session_id, created_at DESC);
    -- The consolidator claims the oldest unprocessed signals on a five-minute
    -- interval. The provider index cannot serve a query that names no provider,
    -- so that read is a full scan plus a temp b-tree for the sort, on a table
    -- that only accumulates. A partial index keeps the work proportional to the
    -- backlog rather than to the history.
    CREATE INDEX IF NOT EXISTS idx_learning_signals_unprocessed
      ON learning_signals(created_at) WHERE processed_at IS NULL;

    CREATE TABLE IF NOT EXISTS knowledge_items (
      id                TEXT PRIMARY KEY,
      kind              TEXT NOT NULL,
      scope             TEXT NOT NULL,
      project_id        TEXT,
      path_scope        TEXT,
      title             TEXT NOT NULL,
      canonical_text    TEXT NOT NULL,
      status            TEXT NOT NULL,
      confidence        REAL NOT NULL DEFAULT 0,
      source_count      INTEGER NOT NULL DEFAULT 0,
      current_version   INTEGER NOT NULL DEFAULT 1,
      content_hash      TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      last_validated_at INTEGER,
      expires_at        INTEGER,
      superseded_by     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_items_scope_status
      ON knowledge_items(scope, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_items_project
      ON knowledge_items(project_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS knowledge_versions (
      id                  TEXT PRIMARY KEY,
      item_id             TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
      version             INTEGER NOT NULL,
      canonical_text      TEXT NOT NULL,
      metadata_json       TEXT NOT NULL DEFAULT '{}',
      content_hash        TEXT NOT NULL,
      created_by          TEXT NOT NULL,
      previous_version_id TEXT,
      created_at          INTEGER NOT NULL,
      UNIQUE(item_id, version)
    );

    CREATE TABLE IF NOT EXISTS knowledge_candidates (
      id                    TEXT PRIMARY KEY,
      item_id               TEXT,
      target_kind           TEXT NOT NULL,
      scope                 TEXT NOT NULL,
      provider_id           TEXT,
      project_id            TEXT,
      path_scope            TEXT,
      title                 TEXT NOT NULL,
      proposed_text         TEXT NOT NULL,
      rationale             TEXT NOT NULL,
      confidence            REAL NOT NULL DEFAULT 0,
      status                TEXT NOT NULL,
      evidence_count        INTEGER NOT NULL DEFAULT 0,
      task_count            INTEGER NOT NULL DEFAULT 0,
      estimated_token_delta INTEGER NOT NULL DEFAULT 0,
      conflicts_json        TEXT NOT NULL DEFAULT '[]',
      signal_ids_json       TEXT NOT NULL DEFAULT '[]',
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      reviewed_at           INTEGER,
      reviewer_note         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_candidates_status
      ON knowledge_candidates(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_candidates_project
      ON knowledge_candidates(project_id, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS knowledge_evidence (
      id           TEXT PRIMARY KEY,
      item_id      TEXT,
      version_id   TEXT,
      candidate_id TEXT,
      signal_id    TEXT,
      source_type  TEXT NOT NULL,
      source_id    TEXT,
      citation     TEXT NOT NULL,
      content_hash TEXT,
      weight       REAL NOT NULL DEFAULT 1,
      observed_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_evidence_item
      ON knowledge_evidence(item_id, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_evidence_candidate
      ON knowledge_evidence(candidate_id, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_evidence_signal
      ON knowledge_evidence(signal_id);

    CREATE TABLE IF NOT EXISTS knowledge_relations (
      from_item_id TEXT NOT NULL,
      to_item_id   TEXT NOT NULL,
      relation     TEXT NOT NULL,
      confidence   REAL NOT NULL DEFAULT 0,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      created_at   INTEGER NOT NULL,
      resolved_at  INTEGER,
      PRIMARY KEY(from_item_id, to_item_id, relation)
    );

    CREATE TABLE IF NOT EXISTS knowledge_projections (
      id               TEXT PRIMARY KEY,
      candidate_id     TEXT,
      item_id          TEXT,
      version_id       TEXT,
      provider_id      TEXT NOT NULL,
      adapter_id       TEXT NOT NULL,
      scope            TEXT NOT NULL,
      project_id       TEXT,
      target_path      TEXT NOT NULL,
      target_format    TEXT NOT NULL,
      proposed_content TEXT NOT NULL,
      base_hash        TEXT,
      applied_hash     TEXT,
      previous_content TEXT,
      status           TEXT NOT NULL,
      error            TEXT,
      created_at       INTEGER NOT NULL,
      applied_at       INTEGER,
      undone_at        INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_projections_candidate
      ON knowledge_projections(candidate_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_projections_item
      ON knowledge_projections(item_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_projections_status
      ON knowledge_projections(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS learning_experiments (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      project_id          TEXT,
      item_id             TEXT,
      candidate_id        TEXT,
      baseline_version_id TEXT,
      candidate_version_id TEXT,
      provider_id         TEXT,
      model               TEXT,
      effort              TEXT,
      commit_hash         TEXT,
      config_json         TEXT NOT NULL DEFAULT '{}',
      status              TEXT NOT NULL,
      outcome_json        TEXT,
      created_at          INTEGER NOT NULL,
      started_at          INTEGER,
      ended_at            INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_learning_experiments_status_project
      ON learning_experiments(status, project_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS artifact_metrics (
      id             TEXT PRIMARY KEY,
      item_id        TEXT,
      version_id     TEXT,
      projection_id  TEXT,
      session_id     TEXT,
      provider_id    TEXT,
      metric         TEXT NOT NULL,
      value          REAL NOT NULL,
      evidence_level TEXT NOT NULL,
      attrs_json     TEXT NOT NULL DEFAULT '{}',
      at             INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifact_metrics_item_metric_at
      ON artifact_metrics(item_id, metric, at DESC);
    CREATE INDEX IF NOT EXISTS idx_artifact_metrics_provider
      ON artifact_metrics(provider_id, metric, at DESC);
    CREATE INDEX IF NOT EXISTS idx_artifact_metrics_session
      ON artifact_metrics(session_id, metric, at DESC);

    CREATE TABLE IF NOT EXISTS session_briefings (
      session_id       TEXT NOT NULL,
      at               INTEGER NOT NULL,
      delivery         TEXT NOT NULL,
      provider_id      TEXT,
      project_id       TEXT,
      entries_json     TEXT NOT NULL DEFAULT '[]',
      estimated_tokens INTEGER NOT NULL DEFAULT 0,
      max_tokens       INTEGER NOT NULL DEFAULT 0,
      omitted_stale    INTEGER NOT NULL DEFAULT 0,
      omitted_budget   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(session_id, at)
    );
    CREATE INDEX IF NOT EXISTS idx_session_briefings_at
      ON session_briefings(at DESC);

    CREATE TABLE IF NOT EXISTS consolidation_runs (
      id           TEXT PRIMARY KEY,
      at           INTEGER NOT NULL,
      trigger      TEXT NOT NULL,
      processed    INTEGER NOT NULL,
      candidates   INTEGER NOT NULL,
      auto_applied INTEGER NOT NULL,
      duration_ms  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_consolidation_runs_at
      ON consolidation_runs(at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      item_id UNINDEXED, title, canonical_text, path_scope
    );
  `);

  // A session keeps the exact profile it launched with. Provider packs can be
  // disabled or upgraded while the PTY is alive without changing history's
  // meaning or the resume path of an existing conversation.
  addColumn(d, 'session_log', 'provider_pack_id', 'TEXT');
  addColumn(d, 'session_log', 'provider_pack_version', 'TEXT');
  addColumn(d, 'session_log', 'provider_profile_json', 'TEXT');
  addColumn(d, 'session_log', 'backend_id', 'TEXT');
  addColumn(d, 'session_log', 'harness_id', 'TEXT');
  // The roots a projection was granted at preview time, so undo can verify the
  // same containment even after the provider profile or project is gone.
  // Reversibility must not depend on the thing being reversed still existing.
  addColumn(d, 'knowledge_projections', 'allowed_roots_json', 'TEXT');
  // Without this, evidence_level='causal' is only the caller's word for it. A
  // metric that names the controlled experiment it came from can be checked
  // against that run; one that names nothing is an estimate wearing a stronger
  // label. Nullable because most metrics are honestly observational.
  addColumn(d, 'artifact_metrics', 'experiment_id', 'TEXT');
}

/**
 * P30 · Durable agent control plane.
 *
 * A terminal is an execution detail, not the record of a piece of work. These
 * rows preserve the human contract (objective, acceptance, evidence and
 * decision) across a terminal exit, provider swap, app restart, or a handoff
 * to a second agent. Prompts and terminal output deliberately stay out of the
 * coordination tables; their owning session/transcript remains the source.
 */
function migrateControl(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS work_dockets (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title           TEXT NOT NULL,
      objective       TEXT NOT NULL,
      acceptance_json TEXT NOT NULL DEFAULT '[]',
      risk            TEXT NOT NULL DEFAULT 'elevated',
      budget_usd      REAL,
      base_commit     TEXT,
      status          TEXT NOT NULL DEFAULT 'draft',
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_dockets_project_updated
      ON work_dockets(project_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_work_dockets_status_updated
      ON work_dockets(status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS work_nodes (
      id              TEXT PRIMARY KEY,
      docket_id       TEXT NOT NULL REFERENCES work_dockets(id) ON DELETE CASCADE,
      kind            TEXT NOT NULL,
      title           TEXT NOT NULL,
      instructions    TEXT NOT NULL,
      depends_json    TEXT NOT NULL DEFAULT '[]',
      status          TEXT NOT NULL DEFAULT 'pending',
      provider_id     TEXT,
      model           TEXT,
      session_id      TEXT,
      worktree        TEXT,
      started_at      INTEGER,
      ended_at        INTEGER,
      detail          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_work_nodes_docket ON work_nodes(docket_id, id);
    CREATE INDEX IF NOT EXISTS idx_work_nodes_session ON work_nodes(session_id);

    CREATE TABLE IF NOT EXISTS work_claims (
      id          TEXT PRIMARY KEY,
      docket_id   TEXT NOT NULL REFERENCES work_dockets(id) ON DELETE CASCADE,
      node_id     TEXT NOT NULL REFERENCES work_nodes(id) ON DELETE CASCADE,
      path        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      released_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_work_claims_open ON work_claims(path) WHERE released_at IS NULL;

    CREATE TABLE IF NOT EXISTS work_proofs (
      id           TEXT PRIMARY KEY,
      docket_id    TEXT NOT NULL REFERENCES work_dockets(id) ON DELETE CASCADE,
      node_id      TEXT REFERENCES work_nodes(id) ON DELETE SET NULL,
      kind         TEXT NOT NULL,
      status       TEXT NOT NULL,
      summary      TEXT NOT NULL,
      detail_json  TEXT NOT NULL DEFAULT '{}',
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_proofs_docket ON work_proofs(docket_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS work_checkpoints (
      id              TEXT PRIMARY KEY,
      docket_id       TEXT NOT NULL REFERENCES work_dockets(id) ON DELETE CASCADE,
      node_id         TEXT REFERENCES work_nodes(id) ON DELETE SET NULL,
      session_id      TEXT,
      conversation_id TEXT,
      repo_commit     TEXT,
      worktree        TEXT,
      note            TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_checkpoints_docket ON work_checkpoints(docket_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS work_model_outcomes (
      id            TEXT PRIMARY KEY,
      docket_id     TEXT NOT NULL REFERENCES work_dockets(id) ON DELETE CASCADE,
      node_id       TEXT NOT NULL REFERENCES work_nodes(id) ON DELETE CASCADE,
      provider_id   TEXT NOT NULL,
      model         TEXT NOT NULL,
      task_kind     TEXT NOT NULL,
      accepted      INTEGER NOT NULL DEFAULT 0,
      tests_passed  INTEGER NOT NULL DEFAULT 0,
      cost_usd      REAL NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      UNIQUE(node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_work_model_outcomes_route
      ON work_model_outcomes(provider_id, model, task_kind, created_at DESC);

    CREATE TABLE IF NOT EXISTS control_events (
      id          TEXT PRIMARY KEY,
      project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
      source      TEXT NOT NULL,
      kind        TEXT NOT NULL,
      summary     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'new',
      docket_id   TEXT REFERENCES work_dockets(id) ON DELETE SET NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_control_events_status ON control_events(status, created_at DESC);

    -- This mirrors the safe, server-owned task lifecycle from the current MCP
    -- Tasks extension. It is an adapter boundary, not a claim that Wanigan
    -- implements every experimental wire version.
    CREATE TABLE IF NOT EXISTS mcp_task_records (
      id          TEXT PRIMARY KEY,
      docket_id   TEXT NOT NULL REFERENCES work_dockets(id) ON DELETE CASCADE,
      node_id     TEXT NOT NULL REFERENCES work_nodes(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'working',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      UNIQUE(node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_task_records_status ON mcp_task_records(status, updated_at DESC);

    -- Recovery facts identify the exact conversation and worktree a Goal task
    -- owns. They exclude prompts and terminal output.
    CREATE TABLE IF NOT EXISTS work_resume_receipts (
      node_id         TEXT PRIMARY KEY REFERENCES work_nodes(id) ON DELETE CASCADE,
      docket_id       TEXT NOT NULL REFERENCES work_dockets(id) ON DELETE CASCADE,
      session_id      TEXT NOT NULL,
      conversation_id TEXT,
      provider_id     TEXT NOT NULL,
      model           TEXT,
      base_commit     TEXT,
      worktree        TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_resume_receipts_docket ON work_resume_receipts(docket_id, updated_at DESC);

    -- Provider-neutral, content-free operational evidence. The terminal and
    -- provider retain any prompt or response content; Control records only
    -- linkage, timing, spend, token totals and safe summaries.
    CREATE TABLE IF NOT EXISTS work_trace_events (
      id           TEXT PRIMARY KEY,
      docket_id    TEXT NOT NULL REFERENCES work_dockets(id) ON DELETE CASCADE,
      node_id      TEXT NOT NULL REFERENCES work_nodes(id) ON DELETE CASCADE,
      session_id   TEXT NOT NULL,
      source       TEXT NOT NULL,
      kind         TEXT NOT NULL,
      status       TEXT NOT NULL,
      tool_name    TEXT,
      summary      TEXT,
      duration_ms  INTEGER,
      cost_usd     REAL NOT NULL DEFAULT 0,
      in_tokens    INTEGER NOT NULL DEFAULT 0,
      out_tokens   INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_trace_events_docket ON work_trace_events(docket_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_work_trace_events_session ON work_trace_events(session_id, created_at DESC);
  `);
}

/**
 * AI Improvement Scout is intentionally an evidence inbox, not a self-editing
 * updater. Its source registry is local and allow-listed; fetched excerpts and
 * deterministic proposals stay in this database until a person explicitly
 * turns one into a Control Goal.
 */
function migrateImprovementScout(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS improvement_scout_sources (
      id              TEXT PRIMARY KEY,
      label           TEXT NOT NULL,
      description     TEXT NOT NULL,
      url             TEXT NOT NULL UNIQUE,
      publisher       TEXT NOT NULL,
      kind            TEXT NOT NULL,
      official        INTEGER NOT NULL DEFAULT 1,
      enabled         INTEGER NOT NULL DEFAULT 1,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      last_checked_at INTEGER,
      last_status     TEXT,
      last_detail     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_improvement_scout_sources_enabled
      ON improvement_scout_sources(enabled, id);

    CREATE TABLE IF NOT EXISTS improvement_scout_runs (
      id                TEXT PRIMARY KEY,
      mode              TEXT NOT NULL,
      status            TEXT NOT NULL,
      network_allowed   INTEGER NOT NULL DEFAULT 0,
      source_count      INTEGER NOT NULL DEFAULT 0,
      evidence_count    INTEGER NOT NULL DEFAULT 0,
      suggestion_count  INTEGER NOT NULL DEFAULT 0,
      analysis_method   TEXT NOT NULL,
      inventory_json    TEXT NOT NULL DEFAULT '{}',
      started_at        INTEGER NOT NULL,
      ended_at          INTEGER,
      detail            TEXT,
      error             TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_improvement_scout_runs_recent
      ON improvement_scout_runs(started_at DESC);
    -- The attended app and its optional launchd daemon share this database.
    -- One durable running row is the cross-process claim that stops them both
    -- from fetching the same weekly sources at once.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_improvement_scout_one_running
      ON improvement_scout_runs(status) WHERE status='running';

    CREATE TABLE IF NOT EXISTS improvement_scout_suggestions (
      id                TEXT PRIMARY KEY,
      fingerprint       TEXT NOT NULL UNIQUE,
      run_id            TEXT REFERENCES improvement_scout_runs(id) ON DELETE SET NULL,
      status            TEXT NOT NULL DEFAULT 'new',
      category          TEXT NOT NULL,
      title             TEXT NOT NULL,
      summary           TEXT NOT NULL,
      why_now           TEXT NOT NULL,
      recommendation    TEXT NOT NULL,
      score             INTEGER NOT NULL DEFAULT 0,
      confidence        REAL NOT NULL DEFAULT 0,
      effort            TEXT NOT NULL,
      risk              TEXT NOT NULL,
      analysis_method   TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      reviewed_at       INTEGER,
      note              TEXT,
      docket_id         TEXT REFERENCES work_dockets(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_improvement_scout_suggestions_status
      ON improvement_scout_suggestions(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_improvement_scout_suggestions_run
      ON improvement_scout_suggestions(run_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS improvement_scout_evidence (
      id                TEXT PRIMARY KEY,
      run_id            TEXT NOT NULL REFERENCES improvement_scout_runs(id) ON DELETE CASCADE,
      suggestion_id     TEXT REFERENCES improvement_scout_suggestions(id) ON DELETE SET NULL,
      source_id         TEXT NOT NULL REFERENCES improvement_scout_sources(id) ON DELETE RESTRICT,
      source_title      TEXT NOT NULL,
      source_url        TEXT NOT NULL,
      publisher         TEXT NOT NULL,
      excerpt           TEXT NOT NULL,
      content_hash      TEXT NOT NULL,
      published_at      INTEGER,
      retrieved_at      INTEGER NOT NULL,
      UNIQUE(run_id, source_id, content_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_improvement_scout_evidence_suggestion
      ON improvement_scout_evidence(suggestion_id, retrieved_at DESC);
    CREATE INDEX IF NOT EXISTS idx_improvement_scout_evidence_run
      ON improvement_scout_evidence(run_id, retrieved_at DESC);

    -- One official document can support more than one capability gap. Keeping
    -- that cardinality in a join table avoids silently moving the evidence to
    -- whichever deterministic rule happened to run last.
    CREATE TABLE IF NOT EXISTS improvement_scout_suggestion_evidence (
      suggestion_id TEXT NOT NULL REFERENCES improvement_scout_suggestions(id) ON DELETE CASCADE,
      evidence_id   TEXT NOT NULL REFERENCES improvement_scout_evidence(id) ON DELETE CASCADE,
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (suggestion_id, evidence_id)
    );
    CREATE INDEX IF NOT EXISTS idx_improvement_scout_suggestion_evidence_evidence
      ON improvement_scout_suggestion_evidence(evidence_id, created_at DESC);
  `);

  // The first Scout build stored a single nullable suggestion_id directly on
  // evidence. Preserve every existing relation while upgrades gain the
  // many-to-many link; an old row can never be made less attributable by a
  // schema upgrade.
  d.exec(`
    INSERT OR IGNORE INTO improvement_scout_suggestion_evidence (suggestion_id,evidence_id,created_at)
    SELECT suggestion_id,id,retrieved_at
      FROM improvement_scout_evidence
     WHERE suggestion_id IS NOT NULL
  `);

  // Seed only absent rows. A later build can improve its copy or add a source,
  // but it must never silently re-enable a source the operator turned off.
  const at = Date.now();
  const seed = d.prepare(`
    INSERT OR IGNORE INTO improvement_scout_sources
      (id,label,description,url,publisher,kind,official,enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `);
  const sources: Array<[string, string, string, string, string, string]> = [
    ['openai-release-notes', 'OpenAI developer changelog', 'Official OpenAI developer and product capability changes.', 'https://learn.chatgpt.com/docs/changelog', 'OpenAI', 'changelog'],
    ['claude-code-changelog', 'Claude Code changelog', 'Official Claude Code changes and developer-workflow additions.', 'https://code.claude.com/docs/en/changelog', 'Anthropic', 'changelog'],
    ['anthropic-platform-release-notes', 'Anthropic Platform release notes', 'Official API and platform changes relevant to agent integrations.', 'https://platform.claude.com/docs/en/release-notes/overview', 'Anthropic', 'release-notes'],
    ['github-changelog', 'GitHub changelog', 'Official GitHub platform and MCP ecosystem announcements.', 'https://github.blog/changelog/', 'GitHub', 'changelog'],
    ['github-releases-rest-docs', 'GitHub Releases REST API', 'Official release-discovery API reference and change context.', 'https://docs.github.com/en/rest/releases', 'GitHub', 'documentation'],
  ];
  for (const source of sources) seed.run(...source, 1, 1, at, at);
  // URLs are code-owned security policy rather than an operator preference.
  // Refresh those fields on upgrade while preserving the user's enabled flag,
  // evidence history and last-check status.
  const refresh = d.prepare(`UPDATE improvement_scout_sources
    SET label=?,description=?,url=?,publisher=?,kind=?,official=1,updated_at=? WHERE id=?`);
  for (const [id, label, description, url, publisher, kind] of sources) {
    refresh.run(label, description, url, publisher, kind, at, id);
  }
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
