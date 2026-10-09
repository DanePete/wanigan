import Database from 'better-sqlite3';

export type DB = Database.Database;

/**
 * Migrations are additive and run in order, once each. Never edit a shipped
 * entry: append a new one. The index in this list is the schema version.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE projects (
    id          TEXT PRIMARY KEY,
    key         TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    path        TEXT NOT NULL UNIQUE,
    next_seq    INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    archived_at INTEGER
  );

  CREATE TABLE cards (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES projects(id),
    seq           INTEGER NOT NULL,
    key           TEXT NOT NULL,
    type          TEXT NOT NULL,
    title         TEXT NOT NULL,
    body          TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL,
    priority      INTEGER NOT NULL DEFAULT 2,
    reopened      INTEGER NOT NULL DEFAULT 0,
    sent_back     INTEGER NOT NULL DEFAULT 0,
    rank          REAL NOT NULL,
    created_by    TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    claim_session TEXT,
    claim_expires INTEGER,
    claim_note    TEXT,
    UNIQUE (project_id, seq)
  );
  CREATE INDEX cards_by_project ON cards (project_id, status);

  CREATE TABLE criteria (
    id       TEXT PRIMARY KEY,
    card_id  TEXT NOT NULL REFERENCES cards(id),
    text     TEXT NOT NULL,
    done     INTEGER NOT NULL DEFAULT 0,
    position REAL NOT NULL
  );
  CREATE INDEX criteria_by_card ON criteria (card_id);

  CREATE TABLE comments (
    id          TEXT PRIMARY KEY,
    card_id     TEXT NOT NULL REFERENCES cards(id),
    author      TEXT NOT NULL,
    body        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'comment',
    resolved_at INTEGER,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX comments_by_card ON comments (card_id);

  CREATE TABLE evidence (
    id         TEXT PRIMARY KEY,
    card_id    TEXT NOT NULL REFERENCES cards(id),
    kind       TEXT NOT NULL,
    value      TEXT NOT NULL,
    existed    INTEGER,
    added_by   TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX evidence_by_card ON evidence (card_id);

  CREATE TABLE sessions (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id),
    card_id         TEXT REFERENCES cards(id),
    provider        TEXT NOT NULL,
    title           TEXT NOT NULL,
    state           TEXT NOT NULL,
    activity        TEXT,
    pid             INTEGER,
    exit_code       INTEGER,
    conversation_id TEXT,
    token_hash      TEXT NOT NULL UNIQUE,
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER,
    last_event_at   INTEGER,
    asking_since    INTEGER,
    seen_at         INTEGER
  );
  CREATE INDEX sessions_by_project ON sessions (project_id, started_at);

  CREATE TABLE session_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    at         INTEGER NOT NULL,
    event      TEXT NOT NULL,
    tool       TEXT,
    summary    TEXT
  );
  CREATE INDEX session_events_by_session ON session_events (session_id, id);

  CREATE TABLE queued_input (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL REFERENCES sessions(id),
    text         TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    delivered_at INTEGER
  );

  CREATE TABLE activity (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT,
    card_id    TEXT,
    session_id TEXT,
    actor      TEXT NOT NULL,
    verb       TEXT NOT NULL,
    detail     TEXT,
    at         INTEGER NOT NULL
  );
  CREATE INDEX activity_by_project ON activity (project_id, id);
  CREATE INDEX activity_by_card ON activity (card_id, id);

  CREATE TABLE decisions (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    removed_at INTEGER
  );
  `,
  `
  ALTER TABLE projects ADD COLUMN paused_at INTEGER;
  ALTER TABLE projects ADD COLUMN paused_by TEXT;
  ALTER TABLE sessions ADD COLUMN account_id TEXT;

  CREATE TABLE accounts (
    id          TEXT PRIMARY KEY,
    provider    TEXT NOT NULL,
    label       TEXT NOT NULL,
    config_dir  TEXT,
    is_default  INTEGER NOT NULL DEFAULT 0,
    discovered  INTEGER NOT NULL DEFAULT 0,
    signed_in   TEXT NOT NULL DEFAULT 'unknown',
    identity    TEXT,
    plan        TEXT,
    checked_at  INTEGER,
    created_at  INTEGER NOT NULL,
    archived_at INTEGER
  );
  CREATE UNIQUE INDEX accounts_by_dir ON accounts (provider, coalesce(config_dir, ''));

  CREATE TABLE project_accounts (
    project_id TEXT NOT NULL REFERENCES projects(id),
    provider   TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    PRIMARY KEY (project_id, provider)
  );
  `,
  `
  ALTER TABLE cards ADD COLUMN worktree_path TEXT;
  ALTER TABLE cards ADD COLUMN worktree_branch TEXT;
  ALTER TABLE cards ADD COLUMN worktree_base TEXT;
  ALTER TABLE sessions ADD COLUMN cwd TEXT;
  ALTER TABLE projects ADD COLUMN isolate INTEGER NOT NULL DEFAULT 0;
  `,
  `
  CREATE TABLE ai_reviews (
    id          TEXT PRIMARY KEY,
    card_id     TEXT NOT NULL REFERENCES cards(id),
    project_id  TEXT NOT NULL REFERENCES projects(id),
    account_id  TEXT,
    state       TEXT NOT NULL,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    result_json TEXT,
    cost_usd    REAL,
    error       TEXT
  );
  CREATE INDEX ai_reviews_by_card ON ai_reviews (card_id, started_at);
  `,
  `
  ALTER TABLE session_events ADD COLUMN path TEXT;
  CREATE INDEX session_events_by_path ON session_events (path, at);
  `,
  `
  ALTER TABLE projects ADD COLUMN jev TEXT NOT NULL DEFAULT 'read';
  CREATE TABLE jev_reads (
    card_id   TEXT PRIMARY KEY REFERENCES cards(id),
    at        INTEGER NOT NULL,
    read_json TEXT NOT NULL
  );
  CREATE TABLE jev_calls (
    id           INTEGER PRIMARY KEY,
    at           INTEGER NOT NULL,
    ok           INTEGER NOT NULL,
    latency_ms   INTEGER,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    model        TEXT,
    error        TEXT,
    purpose      TEXT NOT NULL
  );
  CREATE INDEX jev_calls_by_at ON jev_calls (at);
  `,
  `
  ALTER TABLE cards ADD COLUMN status_at INTEGER;
  UPDATE cards SET status_at = updated_at;
  -- When a card entered its column, kept by the database itself: every status
  -- change also stamps updated_at, so no code path can forget it.
  CREATE TRIGGER cards_status_at AFTER UPDATE OF status ON cards
    WHEN NEW.status IS NOT OLD.status
    BEGIN UPDATE cards SET status_at = NEW.updated_at WHERE id = NEW.id; END;
  CREATE TRIGGER cards_status_at_new AFTER INSERT ON cards
    WHEN NEW.status_at IS NULL
    BEGIN UPDATE cards SET status_at = NEW.created_at WHERE id = NEW.id; END;
  `,
  `
  CREATE TABLE chat_threads (
    id             TEXT PRIMARY KEY,
    project_id     TEXT REFERENCES projects(id),
    account_id     TEXT,
    claude_session TEXT,
    context_hash   TEXT,
    started_at     INTEGER NOT NULL
  );
  CREATE INDEX chat_threads_by_scope ON chat_threads (project_id, started_at);
  CREATE TABLE chat_turns (
    id          TEXT PRIMARY KEY,
    thread_id   TEXT NOT NULL REFERENCES chat_threads(id),
    question    TEXT NOT NULL,
    answer      TEXT,
    state       TEXT NOT NULL,
    error       TEXT,
    account_id  TEXT,
    continued   INTEGER NOT NULL DEFAULT 0,
    cost_usd    REAL,
    asked_at    INTEGER NOT NULL,
    answered_at INTEGER
  );
  CREATE INDEX chat_turns_by_thread ON chat_turns (thread_id, asked_at);
  `,
  `
  ALTER TABLE sessions ADD COLUMN limit_since INTEGER;
  ALTER TABLE sessions ADD COLUMN limit_resets_at INTEGER;
  `,
  `
  ALTER TABLE projects ADD COLUMN setup_command TEXT;
  `,
  `
  ALTER TABLE cards ADD COLUMN pr_url TEXT;
  `,
  `
  ALTER TABLE sessions ADD COLUMN model TEXT;
  ALTER TABLE sessions ADD COLUMN effort TEXT;
  `,
  `
  -- What an open permission request asks, exactly (JSON list of PermissionAsk); null when none is open.
  ALTER TABLE sessions ADD COLUMN asking TEXT;
  `,
  `
  ALTER TABLE sessions ADD COLUMN remote INTEGER NOT NULL DEFAULT 0;
  -- Files the owner gave an agent. A row waits in its composer (session or chat
  -- thread) until a message takes it: then queued_id or turn_id says which.
  CREATE TABLE attachments (
    id          TEXT PRIMARY KEY,
    session_id  TEXT REFERENCES sessions(id),
    thread_id   TEXT REFERENCES chat_threads(id),
    n           INTEGER NOT NULL,
    name        TEXT NOT NULL,
    path        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    sent_at     INTEGER,
    queued_id   INTEGER REFERENCES queued_input(id),
    turn_id     TEXT REFERENCES chat_turns(id)
  );
  CREATE INDEX attachments_by_session ON attachments (session_id, n);
  CREATE INDEX attachments_by_thread ON attachments (thread_id, n);
  CREATE INDEX attachments_by_message ON attachments (queued_id);
  CREATE INDEX attachments_by_turn ON attachments (turn_id);
  `,
  `
  -- Where the agent keeps this conversation (a Codex rollout), as its own hook said.
  ALTER TABLE sessions ADD COLUMN transcript_path TEXT;
  `,
  `
  -- A git snapshot of a session's folder per turn. The commits are referenced
  -- by nothing but this table: git may prune them, and then they are gone.
  CREATE TABLE checkpoints (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL REFERENCES sessions(id),
    kind         TEXT NOT NULL,
    turn         INTEGER NOT NULL,
    event_id     INTEGER,
    cwd          TEXT NOT NULL,
    commit_sha   TEXT,
    tree_sha     TEXT,
    head_sha     TEXT,
    before_sha   TEXT,
    not_captured TEXT,
    shared       INTEGER NOT NULL DEFAULT 0,
    files        INTEGER,
    additions    INTEGER,
    deletions    INTEGER,
    at           INTEGER NOT NULL
  );
  CREATE INDEX checkpoints_by_session ON checkpoints (session_id, id);
  `,
  `
  -- A terminal a key may be typed into: its output is deleted when it ends, and
  -- after a crash, and is never searched.
  ALTER TABLE sessions ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Whether the account's CLI was on the login shell's PATH when it was last
  -- checked. Null until then: not checked is not "not installed".
  ALTER TABLE accounts ADD COLUMN installed INTEGER;
  `,
  `
  -- The local model a project's new sessions start on ("local/lmstudio/<id>"),
  -- or null for the agent's own. A suggestion for the New session dialog only.
  ALTER TABLE projects ADD COLUMN local_model TEXT;
  `,
  `
  -- Phones paired to this Mac (Settings › Phone). Only a hash of each one's
  -- token is kept; a phone allowed to act may start and work in sessions.
  CREATE TABLE phone_devices (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    token_hash    TEXT NOT NULL UNIQUE,
    control       INTEGER NOT NULL DEFAULT 1,
    paired_at     INTEGER NOT NULL,
    last_seen_at  INTEGER,
    push_endpoint TEXT,
    push_p256dh   TEXT,
    push_auth     TEXT
  );
  `,
  `
  -- Older calls cannot distinguish a reported zero from absent or coerced usage.
  -- Keep those raw values, but only newly validated token counts are known.
  ALTER TABLE jev_calls ADD COLUMN usage_known INTEGER NOT NULL DEFAULT 0 CHECK (usage_known IN (0, 1));
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** The marker written into every Wanigan 2 store, checked before anything else is read. */
export const STORE_MARK = 'wanigan-2';

/** Ownership and schema changes share one write transaction: no new build may
 * migrate a store while another core still owns it. */
export function openDatabase(file: string, admit?: (db: DB) => void): DB {
  const db = new Database(file);
  try {
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    db.transaction(() => {
      // This is rolled back too if validation or admission refuses the store.
      db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      const current = schemaVersion(db);
      admit?.(db);
      const set = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      for (let v = current; v < MIGRATIONS.length; v++) {
        db.exec(MIGRATIONS[v] as string);
        set.run('schema', String(v + 1));
        set.run('store', STORE_MARK);
      }
    }).immediate();
    // Refusing a foreign store must not even change its journal mode.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function schemaVersion(db: DB): number {
  const get = (key: string): string | undefined =>
    (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  const mark = get('store');
  const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name != 'meta'").get() as { n: number };
  if (mark === undefined && tables.n > 0) {
    throw new Error('This database was not created by Wanigan 2. Refusing to open it.');
  }
  if (mark !== undefined && mark !== STORE_MARK) throw new Error(`Unrecognised store "${mark}". Refusing to open it.`);
  const raw = get('schema');
  const current = Number(raw ?? 0);
  if ((raw !== undefined && !/^(0|[1-9]\d*)$/.test(raw)) || !Number.isSafeInteger(current)) {
    throw new Error('This database has an invalid schema version. Refusing to open it.');
  }
  if (current > MIGRATIONS.length) {
    throw new Error(`This database is from a newer Wanigan (schema ${current}; this build knows ${MIGRATIONS.length}).`);
  }
  return current;
}
