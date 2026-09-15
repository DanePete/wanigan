import type Database from 'better-sqlite3';

/**
 * The review-depth tables (helper sweep P7), kept out of db.ts so the migration
 * that adds them is one call there. Everything is additive: new columns are
 * nullable, new tables are created only when absent, and an older build that
 * opens this database ignores all of it.
 *
 * Imports nothing from db.ts, for the same reason cost-schema.ts does not: that
 * module owns the connection, and reaching back for it closes an import loop.
 */
export function migrateDepthSchema(d: Database.Database): void {
  const addColumn = (table: string, column: string, decl: string) => {
    const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.some((c) => c.name === column)) return;
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  };

  // Goal loop budgets. Null means no limit was set, which is not the same as a
  // limit of zero and is never read as one.
  addColumn('work_dockets', 'max_rounds', 'INTEGER');
  addColumn('work_dockets', 'max_changed_lines', 'INTEGER');
  // A task handed back to a person: the reason code ("needs-human: attempts" or
  // "needs-human: diff size"), the observed numbers behind it, and when.
  addColumn('work_nodes', 'hold_reason', 'TEXT');
  addColumn('work_nodes', 'hold_detail', 'TEXT');
  addColumn('work_nodes', 'held_at', 'INTEGER');

  d.exec(`
    -- Did every ask get answered. One row per sent message that split into two
    -- or more asks, and one row per ask. The operator's own words, local only,
    -- and pruned on the hook-event retention window (see ask-items.ts).
    CREATE TABLE IF NOT EXISTS session_ask_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      sent_at    INTEGER NOT NULL,
      source     TEXT NOT NULL,
      item_count INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_ask_messages ON session_ask_messages(session_id, sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_session_ask_messages_at ON session_ask_messages(sent_at);

    CREATE TABLE IF NOT EXISTS session_ask_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id    INTEGER NOT NULL,
      session_id    TEXT NOT NULL,
      idx           INTEGER NOT NULL,
      text          TEXT NOT NULL,
      kind          TEXT NOT NULL,
      files_json    TEXT,
      commands_json TEXT,
      ticked_at     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_session_ask_items ON session_ask_items(message_id, idx);

    -- Paths a session referenced or read without an edit tool: Grep and Glob
    -- hits, paths named in a submitted prompt, and files a Bash cat/sed -n/head
    -- read. Paths only, derived from the hook body in memory; keyed on the
    -- timeline row they came from and pruned with it.
    CREATE TABLE IF NOT EXISTS session_file_refs (
      event_id   INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      at         INTEGER NOT NULL,
      kind       TEXT NOT NULL,
      path       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_file_refs ON session_file_refs(session_id, at);
    CREATE INDEX IF NOT EXISTS idx_session_file_refs_at ON session_file_refs(at);

    -- The instruction files (CLAUDE.md, AGENTS.md and their kin) a trusted
    -- launch saw, so the next launch can show what changed since. Separate from
    -- config_pins on purpose: instructions are not executable and by default
    -- never block a launch; this is the baseline a diff is drawn against.
    CREATE TABLE IF NOT EXISTS instruction_pins (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL,
      digest      TEXT NOT NULL,
      items_json  TEXT NOT NULL,
      texts_json  TEXT NOT NULL,
      how         TEXT NOT NULL,
      root        TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_instruction_pins_project ON instruction_pins(project_id, created_at DESC);

    -- A changed file the scratch classifier set aside and the operator said to
    -- count anyway. Per project and repository-relative path, so the choice
    -- holds for the next session that touches the same file.
    CREATE TABLE IF NOT EXISTS scratch_promotions (
      project_id  TEXT NOT NULL,
      path        TEXT NOT NULL,
      promoted_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, path)
    );
  `);
}
