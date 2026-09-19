import Database from 'better-sqlite3';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { app } from 'electron';
import { migrateModules, migrateRequiredModule } from './module-registry';
import { controlModule } from './modules/control';
import { sessionSchema, worktreeSchema, migrateCheckpoints } from './modules/session-storage';
import { usageSchema } from './modules/usage-storage';
import { headlessSchema, queueSchema } from './modules/execution-storage';

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

    `);
    sessionSchema.base(d);
    d.exec(`
    CREATE INDEX IF NOT EXISTS idx_requests_run_status ON requests(run_id, status);
    CREATE INDEX IF NOT EXISTS idx_batches_run  ON batches(run_id);
    CREATE INDEX IF NOT EXISTS idx_batches_open ON batches(processing_status)
      WHERE processing_status != 'ended';
    CREATE INDEX IF NOT EXISTS idx_events_run   ON events(run_id, at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
    `);
    d.exec(`
      CREATE TABLE IF NOT EXISTS companion_turns (
        id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, question TEXT NOT NULL,
        answer TEXT, sources_json TEXT NOT NULL DEFAULT '[]', model TEXT NOT NULL,
        at INTEGER NOT NULL, status TEXT NOT NULL, error TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL
      );
      CREATE INDEX IF NOT EXISTS idx_companion_scope ON companion_turns(scope_key, at DESC);
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
  usageSchema.base(d);
  d.exec(`
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

  `);
  worktreeSchema.base(d);
  headlessSchema.base(d);
  queueSchema.base(d);
  d.exec(`
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

    -- Digests of a repository's executable configuration that a launch was let
    -- through with: hooks, MCP servers, helpers, env overrides, git hooks and
    -- drivers. 'first-use' records trust on first use, never a review; a launch
    -- whose digest matches no row is asked about (see config-pins.ts).
    CREATE TABLE IF NOT EXISTS config_pins (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL,
      digest      TEXT NOT NULL,
      items_json  TEXT NOT NULL,
      how         TEXT NOT NULL,
      root        TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_config_pins_project ON config_pins(project_id, created_at DESC);

    -- plugins · installable extensions ----------------------------------
    -- The manifest is stored whole, alongside the digest of the exact bytes it
    -- was read from. Both are needed and neither substitutes for the other: the
    -- manifest is what Wanigan acts on when the source directory is gone, and
    -- the digest is what trust is pinned to, so an edited plugin is a plugin
    -- that has to be approved again rather than one that quietly changed.
    CREATE TABLE IF NOT EXISTS plugins (
      id              TEXT PRIMARY KEY,
      label           TEXT NOT NULL,
      version         TEXT NOT NULL,
      origin          TEXT NOT NULL,
      source_path     TEXT,
      manifest_json   TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL,
      trusted_sha256  TEXT,
      enabled         INTEGER NOT NULL DEFAULT 0,
      installed_at    INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    -- What a plugin created, so uninstall removes exactly that and nothing
    -- else. Rows are kept after removal (removed_at) rather than deleted: a
    -- plugin that is reinstalled should not re-adopt a server the operator has
    -- since made their own, and the only way to know that is a record of what
    -- was handed over and when.
    CREATE TABLE IF NOT EXISTS plugin_artifacts (
      id          TEXT PRIMARY KEY,
      plugin_id   TEXT NOT NULL,
      kind        TEXT NOT NULL,
      ref         TEXT NOT NULL,
      project_id  TEXT,
      detail      TEXT,
      -- The artifact as the plugin declared it, hashed at install. An uninstall
      -- compares the live row against this: equal means Wanigan may remove it,
      -- different means a person edited it and it stays.
      fingerprint TEXT,
      created_at  INTEGER NOT NULL,
      removed_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_plugin_artifacts_plugin ON plugin_artifacts(plugin_id, removed_at);
  `);

  // Which plugin an MCP server came from, or NULL for one a person added
  // themselves. Additive, and NULL is the honest value for every server that
  // existed before plugins did — those were all added by hand.
  addColumn(d, 'mcp_servers', 'owner', 'TEXT');
  // The environment an extension declared for this server: destination names
  // and where each value comes from, never a value. Both columns are additive
  // and NULL on every row that existed before extensions did, which is the
  // honest reading — those were all added by hand and carry no environment.
  addColumn(d, 'mcp_servers', 'env', 'TEXT');

  // Runs carry batches, headless fan-outs, evals and judge passes. One table,
  // so Insights and budgets never need a special case per surface.
  addColumn(d, 'runs', 'kind', "TEXT NOT NULL DEFAULT 'batch'");
  addColumn(d, 'runs', 'eval_pair_id', 'TEXT');
  // A session can run in its own worktree; the code panel scopes to it.
  worktreeSchema.links(d);
  sessionSchema.details(d);
  // A fire and the run it dispatched were linked only by a prefix of the run's
  // name, which is a display string a rename breaks. headless.ts writes the
  // terminal outcome back onto the fire, and that write needs an id an operator
  // cannot edit out from under it. Nullable: a fire can be spent on work that
  // creates no run row, and every row written before this column existed has no
  // answer to give.
  addColumn(d, 'schedule_runs', 'run_id', 'TEXT');
  queueSchema.leases(d);
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
  // The policy ledger's hash chain (ledger-chain.ts). Additive: a row written
  // before these columns existed keeps NULL in both and is reported as before
  // the chain began, never as verified, because nothing was ever computed over
  // it that it could be checked against.
  addColumn(d, 'policy_ledger', 'prev_hash', 'TEXT');
  addColumn(d, 'policy_ledger', 'hash', 'TEXT');
  // One row: the last head signed, what it covered, and the public half of the
  // key that signed it. The key is kept beside the signature so a head signed on
  // another Mac is recognised as exactly that, rather than read as a forgery.
  d.exec(`
    CREATE TABLE IF NOT EXISTS policy_ledger_head (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      last_id    INTEGER NOT NULL,
      count      INTEGER NOT NULL,
      hash       TEXT NOT NULL,
      signed_at  INTEGER NOT NULL,
      signature  TEXT NOT NULL,
      public_key TEXT NOT NULL
    )
  `);
  migrateLearning(d);
  // Intake still extends Control's events in a legacy migration below. The
  // required module owns its schema, but must run at this original position
  // before that dependent ALTER and before runtime imports can open the DB.
  migrateRequiredModule(controlModule, d);
  migrateAccounts(d);
  migrateCheckpoints(d);
  sessionSchema.conversationFlags(d);
  migrateClaudeUsage(d);
  migrateAttempts(d);
  worktreeSchema.bootstrap(d);
  usageSchema.observed(d);
  migrateCodexHooks(d);
  migrateIntake(d);
  // Every registered module's schema, last and in registration order — inside
  // this same transaction, so a module's tables land or nothing does. Scout's
  // migration used to be a named call above; it is the first thing that
  // registers itself instead of being wired here by hand.
  migrateModules(d);
}

/**
 * Codex hook trust, and the first real event that proved it. See
 * codex-hooks.ts.
 *
 * One row per binary, version and hook definition, because trust is a fact
 * about all three: Codex hashes the definition, a different binary can hash
 * differently, and an upgrade in place is a new version. A restart reads the
 * answer here instead of starting Codex's app-server again. `first_event_at`
 * stays NULL until a real session delivers an event on that version, and it
 * is the only thing Settings may call "observed".
 *
 * The session column says what one launch did about hooks, and when its own
 * hooks took over from OSC 9, so the answer outlives the terminal.
 */
function migrateCodexHooks(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS codex_hook_trust (
      bin                 TEXT NOT NULL,
      version             TEXT NOT NULL,
      definition_sha256   TEXT NOT NULL,
      state               TEXT NOT NULL,
      reason              TEXT,
      detail              TEXT,
      hashes_json         TEXT,
      probed_at           INTEGER NOT NULL,
      first_event_at      INTEGER,
      first_event_session TEXT,
      PRIMARY KEY (bin, version, definition_sha256)
    );
  `);
  sessionSchema.codexHooks(d);
}

/**
 * Issue intake: GitHub facts read through gh on a press or an opt-in timer,
 * recorded as Control events. See intake.ts.
 *
 * The external key is what makes a poll safe to repeat. Every poll overlaps the
 * last one on purpose, so the same issue, comment and failed run arrive again
 * and again; the unique index refuses the second copy inside SQLite, where two
 * polls racing each other cannot both get past it. Partial, because every event
 * written before this column existed, and every one typed in by hand, has no
 * outside identity to be unique about. Ordered after the ALTER for the reason
 * the queue lease index gives.
 */
function migrateIntake(d: Database.Database) {
  addColumn(d, 'control_events', 'external_key', 'TEXT');
  d.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_control_events_external
      ON control_events(project_id, external_key) WHERE external_key IS NOT NULL;

    -- One row per poll, written when it fires and finished when it ends, so a
    -- poll that fired and never ran, or ran and never finished, is still a row
    -- someone can read. The partial unique index is the claim: one unfinished
    -- poll per project, across the app and anything else sharing this file.
    CREATE TABLE IF NOT EXISTS intake_polls (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      fired_by      TEXT NOT NULL,
      fired_at      INTEGER NOT NULL,
      ran_at        INTEGER,
      finished_at   INTEGER,
      outcome       TEXT,
      reason        TEXT,
      error         TEXT,
      repo          TEXT,
      since_at      INTEGER,
      until_at      INTEGER,
      lookback      INTEGER NOT NULL DEFAULT 0,
      interval_ms   INTEGER,
      gap_ms        INTEGER,
      facts_read    INTEGER NOT NULL DEFAULT 0,
      new_opened    INTEGER NOT NULL DEFAULT 0,
      new_labelled  INTEGER NOT NULL DEFAULT 0,
      new_commented INTEGER NOT NULL DEFAULT 0,
      new_ci_failed INTEGER NOT NULL DEFAULT 0,
      capped        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_intake_polls_project ON intake_polls(project_id, fired_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_intake_polls_one_running
      ON intake_polls(project_id) WHERE finished_at IS NULL;

    -- What intake knows about an event that control_events has no column for:
    -- the kind in GitHub's terms, the link out, GitHub's own time for the fact,
    -- and the poll that recorded it. Keyed by the event, so dismissing or
    -- triaging it in Control changes nothing here.
    CREATE TABLE IF NOT EXISTS intake_events (
      event_id    TEXT PRIMARY KEY REFERENCES control_events(id) ON DELETE CASCADE,
      poll_id     TEXT REFERENCES intake_polls(id) ON DELETE SET NULL,
      kind        TEXT NOT NULL,
      url         TEXT,
      happened_at INTEGER
    );
  `);
}

/**
 * Claude Code's own transcripts, folded into a meter. See claude-usage.ts for
 * why this is a second instrument rather than more rows in session_api_events.
 *
 * Two tables because the work has two halves that fail differently. The events
 * table is the answer; the files table is the bookmark that makes producing it
 * resumable over a corpus measured in gigabytes, and losing the bookmark costs
 * time but never correctness — the events fold on a request key, so re-reading
 * bytes already read changes nothing.
 */
function migrateClaudeUsage(d: Database.Database) {
  d.exec(`
    -- One row per API turn, keyed by the turn's own identity rather than by
    -- the line that carried it: Claude Code writes one line per content block
    -- and every one repeats the turn's cumulative usage, so the key is the only
    -- thing standing between this table and a total several times too large.
    CREATE TABLE IF NOT EXISTS claude_usage_events (
      request_key    TEXT PRIMARY KEY,
      at             INTEGER NOT NULL,
      model          TEXT NOT NULL,
      cwd            TEXT,
      session_id     TEXT,
      effort         TEXT,
      entrypoint     TEXT,
      sidechain      INTEGER NOT NULL DEFAULT 0,
      in_tokens      INTEGER NOT NULL DEFAULT 0,
      out_tokens     INTEGER NOT NULL DEFAULT 0,
      cache_read     INTEGER NOT NULL DEFAULT 0,
      cache_write_5m INTEGER NOT NULL DEFAULT 0,
      cache_write_1h INTEGER NOT NULL DEFAULT 0
    );
    -- Every read on this table is a window plus a group by model or day, and
    -- the primary key is a hash of a request id with no useful order. Carrying
    -- the token columns answers the daily rollups from the index alone.
    CREATE INDEX IF NOT EXISTS idx_claude_usage_at
      ON claude_usage_events(at, model, in_tokens, out_tokens, cache_read,
                             cache_write_5m, cache_write_1h);

    -- How far into each transcript the reader has got. byte_offset is a
    -- position in an append-only file, valid only while size and mtime still
    -- match what was observed when it was written.
    CREATE TABLE IF NOT EXISTS claude_usage_files (
      path        TEXT PRIMARY KEY,
      size        INTEGER NOT NULL,
      mtime_ms    REAL    NOT NULL,
      byte_offset INTEGER NOT NULL DEFAULT 0,
      scanned_at  INTEGER NOT NULL
    );
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
    -- The same pass now takes its work in whole cluster partitions rather than
    -- a row window, because a below-threshold cluster is left unprocessed on
    -- purpose and a window anchored at the head of the queue therefore stops
    -- moving. This index is the five stored columns a cluster key opens with,
    -- so both the grouped partition count and the per-partition read are
    -- served without touching the table.
    CREATE INDEX IF NOT EXISTS idx_learning_signals_unprocessed_partition
      ON learning_signals(kind, provider_id, backend_id, project_id, path_scope, created_at)
      WHERE processed_at IS NULL;

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

    /*
     * Every model-assisted phrasing call, whether it produced a claim or not.
     *
     * This is the metering ledger, so it is written before the switch that
     * spends against it is allowed on: cost_reported is 0 when the harness
     * returned no usage numbers, which is how a profile is proven unmetered
     * rather than assumed priced. Nothing here stores the phrasing itself --
     * that lands on the candidate, which carries its own provenance.
     */
    CREATE TABLE IF NOT EXISTS learning_model_runs (
      id            TEXT PRIMARY KEY,
      at            INTEGER NOT NULL,
      provider_id   TEXT NOT NULL,
      backend_id    TEXT,
      cluster_key   TEXT,
      status        TEXT NOT NULL,
      cost_usd      REAL NOT NULL DEFAULT 0,
      cost_reported INTEGER NOT NULL DEFAULT 0,
      in_tokens     INTEGER NOT NULL DEFAULT 0,
      out_tokens    INTEGER NOT NULL DEFAULT 0,
      duration_ms   INTEGER NOT NULL DEFAULT 0,
      error         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_learning_model_runs_at
      ON learning_model_runs(at DESC);
    CREATE INDEX IF NOT EXISTS idx_learning_model_runs_provider
      ON learning_model_runs(provider_id, at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      item_id UNINDEXED, title, canonical_text, path_scope
    );
  `);

  sessionSchema.providerIdentity(d);
  // The roots a projection was granted at preview time, so undo can verify the
  // same containment even after the provider profile or project is gone.
  // Reversibility must not depend on the thing being reversed still existing.
  addColumn(d, 'knowledge_projections', 'allowed_roots_json', 'TEXT');
  // Without this, evidence_level='causal' is only the caller's word for it. A
  // metric that names the controlled experiment it came from can be checked
  // against that run; one that names nothing is an estimate wearing a stronger
  // label. Nullable because most metrics are honestly observational.
  addColumn(d, 'artifact_metrics', 'experiment_id', 'TEXT');
  // The briefing builder has reported four held-back reasons since it learned
  // to distinguish them, but only two were persisted, so a session held for
  // the freshness-check quota read back as "nothing matched". Nullable: a row
  // recorded before these columns existed says "not recorded", never 0.
  addColumn(d, 'session_briefings', 'omitted_unsynthesized', 'INTEGER');
  addColumn(d, 'session_briefings', 'omitted_unverified', 'INTEGER');
  // Waking a snoozed candidate needs three facts the row never carried: the
  // deterministic cluster key a later observation can match without touching
  // a title a person may have edited, when it was first snoozed (a snoozed
  // candidate never auto-applies afterwards), and the wake reason as its own
  // column so automation never writes over the operator's reviewer_note.
  addColumn(d, 'knowledge_candidates', 'cluster_key', 'TEXT');
  addColumn(d, 'knowledge_candidates', 'snoozed_at', 'INTEGER');
  addColumn(d, 'knowledge_candidates', 'wake_json', 'TEXT');
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_candidates_cluster
      ON knowledge_candidates(cluster_key, status);
  `);
}

/**
 * P32 · One operator, several agent accounts.
 *
 * Claude Code keys its stored login — including the macOS Keychain entry — to
 * `CLAUDE_CONFIG_DIR`, so a session launched with a different directory reads a
 * different credential. That is the whole mechanism: an account here is a
 * labelled config directory for a harness, not a credential Wanigan holds.
 * Wanigan never sees the token and cannot perform the browser login.
 *
 * Rows are harness-scoped rather than Claude-specific because the same shape
 * already fits Codex (`CODEX_HOME`). Only the Claude Code mapping is wired
 * today; a harness with no mapping simply has no accounts.
 */
function migrateAccounts(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS agent_accounts (
      id          TEXT PRIMARY KEY,
      harness     TEXT NOT NULL,
      label       TEXT NOT NULL,
      config_dir  TEXT NOT NULL,
      -- 0 for a directory that existed before Wanigan knew about it, such as
      -- the operator's own ~/.claude. Wanigan may point sessions at it but
      -- must not offer to delete it.
      adopted     INTEGER NOT NULL DEFAULT 0,
      is_default  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      UNIQUE(harness, config_dir)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_accounts_harness ON agent_accounts(harness, created_at);

    -- A project's saved account, per harness. A row per pair rather than a
    -- column per harness, so adding Codex accounts later needs no migration.
    CREATE TABLE IF NOT EXISTS project_accounts (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      harness    TEXT NOT NULL,
      account_id TEXT NOT NULL REFERENCES agent_accounts(id) ON DELETE CASCADE,
      PRIMARY KEY (project_id, harness)
    );
  `);
  sessionSchema.accountIdentity(d);
  headlessSchema.details(d);
}

/**
 * Attempts: one task run several times from one pinned commit, and what each
 * run left behind. See src/shared/attempts.ts for the two readings.
 *
 * An attempt is a pointer to a real single-repository headless run, plus the
 * facts copied off it once it ends. The copy is deliberate: the run row is the
 * runner's record and the attempt is the comparison's, and a comparison has to
 * stay readable after the run list is pruned. Tokens are per attempt because
 * each attempt is its own run, and a run is where headless tokens are summed.
 *
 * No foreign key to projects. Removing a project must not delete the record of
 * what was spent comparing work in it, which is the same choice headless_rows
 * makes.
 */
function migrateAttempts(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS attempt_sets (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      kind            TEXT NOT NULL,
      prompt          TEXT NOT NULL,
      prompt_sha256   TEXT NOT NULL,
      base_commit     TEXT NOT NULL,
      arms_json       TEXT NOT NULL,
      repeats         INTEGER NOT NULL,
      budget_usd      REAL NOT NULL,
      timeout_ms      INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'running',
      kept_attempt_id TEXT,
      decided_at      INTEGER,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attempt_sets_created ON attempt_sets(created_at DESC);

    CREATE TABLE IF NOT EXISTS attempts (
      id              TEXT PRIMARY KEY,
      set_id          TEXT NOT NULL REFERENCES attempt_sets(id) ON DELETE CASCADE,
      arm_index       INTEGER NOT NULL,
      repeat_index    INTEGER NOT NULL,
      headless_run_id TEXT,
      worktree        TEXT,
      base_head       TEXT,
      status          TEXT NOT NULL DEFAULT 'queued',
      exit_code       INTEGER,
      duration_ms     INTEGER,
      cost_usd        REAL,
      cost_reported   INTEGER,
      in_tokens       INTEGER,
      out_tokens      INTEGER,
      cache_read      INTEGER,
      cache_write     INTEGER,
      files_changed   INTEGER,
      gate_status     TEXT,
      gate_note       TEXT,
      review_run_id   TEXT,
      tree            TEXT,
      oracle_json     TEXT,
      started_at      INTEGER,
      ended_at        INTEGER,
      UNIQUE (set_id, arm_index, repeat_index)
    );
    CREATE INDEX IF NOT EXISTS idx_attempts_set ON attempts(set_id, repeat_index, arm_index);
    CREATE INDEX IF NOT EXISTS idx_attempts_run ON attempts(headless_run_id) WHERE headless_run_id IS NOT NULL;
  `);
  // Why a run could not start or was refused, copied off its row: the run's
  // error is the only account of a pinned worktree that came out at the wrong
  // commit, and it has to outlive the run list.
  addColumn(d, 'attempts', 'error', 'TEXT');
  // What the run was actually stored with — provider, profile fingerprint,
  // model, effort and a hash of the prompt — so the evidence label compares
  // recorded facts against the arm, rather than restating what was asked for.
  addColumn(d, 'attempts', 'launch_json', 'TEXT');
  // When this process began gating the attempt. A gate left 'running' by a
  // process that died is closed as unavailable on the next start, the same
  // way an interrupted review run is, rather than read as still in flight.
  addColumn(d, 'attempts', 'gate_started_at', 'INTEGER');
  // Whether the set holds calls that need approval for the operator: copied to
  // every attempt's run, and shown on the set so a paused trial is explained.
  addColumn(d, 'attempt_sets', 'hold_for_approval', 'INTEGER NOT NULL DEFAULT 0');
}

export function logEvent(runId: string, level: 'info' | 'warn' | 'error', message: string) {
  db().prepare('INSERT INTO events (run_id, at, level, message) VALUES (?,?,?,?)')
    .run(runId, Date.now(), level, message);
}

export function newRunId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `run_${stamp}_${randomBytes(2).toString('hex')}`;
}
