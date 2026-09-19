import type Database from 'better-sqlite3';

/** Queue and Headless own these schemas. Named steps preserve legacy bootstrap order. */
function addColumn(d: Database.Database, table: string, column: string, decl: string): void {
  const columns = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((entry) => entry.name === column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

export const queueSchema = {
  base(d: Database.Database): void {
    d.exec(`
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
    `);
  },
  leases(d: Database.Database): void {
    addColumn(d, 'queue', 'lease_owner', 'TEXT');
    addColumn(d, 'queue', 'lease_expires_at', 'INTEGER');
    // This must follow the additive columns above. `CREATE TABLE IF NOT
    // EXISTS` leaves a pre-lease queue untouched, and attempting this index
    // first makes SQLite abort the entire migration with "no such column".
    d.exec('CREATE INDEX IF NOT EXISTS idx_queue_lease ON queue(state, lease_expires_at)');
  },
};

export const headlessSchema = {
  base(d: Database.Database): void {
    d.exec(`
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
    `);
  },
  details(d: Database.Database): void {
    // The same fact for a fan-out row. headless.ts writes it when the row
    // finishes; nothing reads it back — ROW_COLUMNS does not list it and no
    // other query names it — so this is a recorded fact with no reader yet.
    // It is not what matches a reported context window: transcripts.ts banks the
    // per-model windows the CLI named into the `settings` table, keyed by model,
    // backend and account, and looks them up again against the account frozen
    // onto `session_log`.
    addColumn(d, 'headless_rows', 'account_id', 'TEXT');
    // Whether the CLI named a cost at all, which `cost_usd` alone cannot say: a
    // run that reported nothing and a run that genuinely reported $0.00 both
    // land as 0, and the Runs total claimed to be "CLI-reported; never
    // estimated" over the sum of both. Nullable on purpose — a row written
    // before this column existed reads as unknown, never as reported.
    addColumn(d, 'headless_rows', 'cost_reported', 'INTEGER');
    // The call a row stopped on for a person's answer, and the answer: JSON,
    // bounded and redacted before it is written (headless.ts). Null for every
    // row that never held a call, including all rows from before the column.
    addColumn(d, 'headless_rows', 'held_json', 'TEXT');
    // The commit the agent started from, read in the directory it ran in after
    // any worktree was cut. It was computed for the changed-file count and then
    // thrown away, so a finished row could not say which tree produced it; an
    // attempt pinned to a commit is refused when this is not that commit. Null
    // for rows from before the column and rows that never reached a spawn.
    addColumn(d, 'headless_rows', 'base_head', 'TEXT');
  },
};

export function migrateQueue(d: Database.Database): void {
  queueSchema.base(d);
  queueSchema.leases(d);
}

export function migrateHeadless(d: Database.Database): void {
  headlessSchema.base(d);
  headlessSchema.details(d);
}
