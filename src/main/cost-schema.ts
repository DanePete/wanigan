import type Database from 'better-sqlite3';

/**
 * The cost, quota and context tables, kept out of db.ts so the migration that
 * adds them is one call there rather than a hundred lines interleaved with
 * every other feature's. Everything here is additive: new columns are nullable
 * and new tables are created only when absent, so an older row reads as "not
 * recorded" and never as a value somebody guessed.
 *
 * db.ts calls this inside its migration transaction. It deliberately imports
 * nothing from db.ts — that module owns the connection, and a schema helper
 * that reached back for it would close an import loop at load time.
 */
export function migrateCostSchema(d: Database.Database): void {
  const addColumn = (table: string, column: string, decl: string) => {
    const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.some((c) => c.name === column)) return;
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  };

  // What happened to a worktree's work, written at the moment Wanigan merged or
  // removed it. Rows from before these columns stay NULL: the removal happened,
  // but what it amounted to was never observed, and it is not reconstructed.
  addColumn('worktrees', 'outcome', 'TEXT');
  addColumn('worktrees', 'outcome_at', 'INTEGER');
  addColumn('worktrees', 'merge_sha', 'TEXT');
  addColumn('worktrees', 'merge_target', 'TEXT');
  addColumn('worktrees', 'outcome_commits', 'INTEGER');
  addColumn('worktrees', 'outcome_dirty', 'INTEGER');
  // The commit the worktree was cut from. Without it a clean removal cannot be
  // told apart from a branch someone already merged by hand.
  addColumn('worktrees', 'created_head', 'TEXT');
  addColumn('worktrees', 'reverted_by', 'TEXT');
  addColumn('worktrees', 'revert_checked_at', 'INTEGER');

  d.exec(`
    -- vcs.* attributes Claude Code attaches to its telemetry when
    -- OTEL_METRICS_INCLUDE_REPOSITORY is set. One row per distinct value, so a
    -- session that switched branches keeps both.
    CREATE TABLE IF NOT EXISTS session_vcs_attrs (
      session_id TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      first_at   INTEGER NOT NULL,
      last_at    INTEGER NOT NULL,
      PRIMARY KEY (session_id, key, value)
    );
    CREATE INDEX IF NOT EXISTS idx_worktrees_session ON worktrees(session_id);
  `);
}
