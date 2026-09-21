import type Database from 'better-sqlite3';

/**
 * Schema owned by the required Sessions, Worktrees and Checkpoints modules.
 * Named steps preserve the historical db.ts migration order exactly. Runtime
 * modules import this file; it deliberately imports no runtime or database.
 */
function addColumn(d: Database.Database, table: string, column: string, decl: string) {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((entry) => entry.name === column)) return;
  d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

/** Durable pin/settle flags; forgetting is a separate, destructive operation. */
function migrateConversationFlags(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS conversation_flags (
      key        TEXT PRIMARY KEY,
      pinned_at  INTEGER,
      settled_at INTEGER
    );
  `);
}

/** Operator-owned dependency policy, setup/teardown commands and execution evidence. */
function migrateWorktreeBootstrap(d: Database.Database) {
  d.exec(`
    -- How gitignored dependency folders reach a new worktree: link, clone or
    -- skip. The same shape as project_trust — one choice per project — with
    -- the cascade project_accounts has, so a removed project leaves no row
    -- behind for a re-added one to inherit.
    CREATE TABLE IF NOT EXISTS project_worktree_deps (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      mode       TEXT NOT NULL,
      set_at     INTEGER NOT NULL
    );

    -- Command text the operator approved in a native dialog, run through the
    -- login shell in every worktree Wanigan makes for the project. The shape of
    -- review_recipes, for the same kind of text.
    CREATE TABLE IF NOT EXISTS worktree_commands (
      project_id    TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      setup_json    TEXT NOT NULL DEFAULT '[]',
      teardown_json TEXT NOT NULL DEFAULT '[]',
      updated_at    INTEGER NOT NULL
    );

    -- One row per phase that ran, written before its first command starts and
    -- updated as each one finishes. No cascade: evidence of what ran in a
    -- worktree outlives the project it ran for, as review_runs does.
    CREATE TABLE IF NOT EXISTS worktree_command_runs (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL,
      worktree     TEXT NOT NULL,
      phase        TEXT NOT NULL,
      started_at   INTEGER NOT NULL,
      ended_at     INTEGER,
      status       TEXT NOT NULL,
      planned      INTEGER NOT NULL DEFAULT 0,
      results_json TEXT NOT NULL DEFAULT '[]',
      env_json     TEXT,
      note         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_worktree_command_runs_tree
      ON worktree_command_runs(worktree, phase, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_worktree_command_runs_project
      ON worktree_command_runs(project_id, started_at DESC);
  `);
  // The project a worktree was made for, so its teardown finds the same
  // commands its setup ran even when the repository is registered under a
  // path that is not its root.
  addColumn(d, 'worktrees', 'project_id', 'TEXT');
  addColumn(d, 'worktree_command_runs', 'recovery_unresolved', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(d, 'worktree_command_runs', 'owner_id', 'TEXT');
  addColumn(d, 'worktree_command_runs', 'owner_pid', 'INTEGER');
  // The first port of the worktree's ten-port block, fixed at creation. Setup,
  // the launch and teardown must all see one block; probing again later would
  // skip the block the worktree's own dev server is listening on.
  addColumn(d, 'worktrees', 'port_base', 'INTEGER');
  // What creation put in the worktree — dependency folders, include copies,
  // the port block — as the JSON the Git view shows beside the branch.
  addColumn(d, 'worktrees', 'bootstrap_json', 'TEXT');
}

/** Durable per-turn references to hidden Git checkpoint commits. */
export function migrateCheckpoints(d: Database.Database) {
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

export const sessionSchema = {
  base(d: Database.Database): void {
    d.exec(`
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

    -- Cooperative exclusion shared by Sessions, Headless, Review and restore.
    -- No expiry: an absent owner is not evidence that its child stopped.
    CREATE TABLE IF NOT EXISTS checkout_activity (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      kind TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_checkout_activity_cwd ON checkout_activity(cwd);

    `);
  },
  details(d: Database.Database): void {
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
  },
  providerIdentity(d: Database.Database): void {
    // A session keeps the exact profile it launched with. Provider packs can be
    // disabled or upgraded while the PTY is alive without changing history's
    // meaning or the resume path of an existing conversation.
    addColumn(d, 'session_log', 'provider_pack_id', 'TEXT');
    addColumn(d, 'session_log', 'provider_pack_version', 'TEXT');
    addColumn(d, 'session_log', 'provider_profile_json', 'TEXT');
    addColumn(d, 'session_log', 'backend_id', 'TEXT');
    addColumn(d, 'session_log', 'harness_id', 'TEXT');
  },
  accountIdentity(d: Database.Database): void {
    // Which account a session actually launched under. Without this, a restart
    // leaves Wanigan reading the default account's directory for a transcript
    // that was written into another one, and honestly reporting nothing.
    addColumn(d, 'session_log', 'account_id', 'TEXT');
  },
  codexHooks(d: Database.Database): void {
    addColumn(d, 'session_log', 'codex_hooks_json', 'TEXT');
  },
  conversationFlags: migrateConversationFlags,
};

export function migrateSessions(d: Database.Database): void {
  sessionSchema.base(d);
  sessionSchema.details(d);
  sessionSchema.providerIdentity(d);
  sessionSchema.accountIdentity(d);
  sessionSchema.conversationFlags(d);
  sessionSchema.codexHooks(d);
}

export const worktreeSchema = {
  base(d: Database.Database): void {
    d.exec(`
    -- P9 · worktrees ---------------------------------------------------
    CREATE TABLE IF NOT EXISTS worktrees (
      path       TEXT PRIMARY KEY,
      repo_root  TEXT NOT NULL,
      branch     TEXT,
      session_id TEXT,
      created_at INTEGER NOT NULL,
      removed_at INTEGER
    );

    `);
  },
  links(d: Database.Database): void {
    addColumn(d, 'worktrees', 'linked_json', 'TEXT');
  },
  bootstrap: migrateWorktreeBootstrap,
};

export function migrateWorktrees(d: Database.Database): void {
  worktreeSchema.base(d);
  worktreeSchema.links(d);
  worktreeSchema.bootstrap(d);
}
