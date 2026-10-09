-- Synthetic schema 11 fixture; no owner database or records were read.
-- SQL is the first 11 entries frozen from published 2.0.0-alpha.15.
-- Commit 8c1b7ad145780d92d99c6ef00d476c962ccf96ce; src/core/db.ts SHA256 e44fc2d0b74cbd19f30cd9832d50e6395b54885d386880039c4d4c5572facc47.
-- Do not regenerate this fixture from the current MIGRATIONS array.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta (key, value) VALUES ('store', 'wanigan-2'), ('schema', '11');

-- Frozen migration 1

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

-- Frozen migration 2

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

-- Frozen migration 3

  ALTER TABLE cards ADD COLUMN worktree_path TEXT;
  ALTER TABLE cards ADD COLUMN worktree_branch TEXT;
  ALTER TABLE cards ADD COLUMN worktree_base TEXT;
  ALTER TABLE sessions ADD COLUMN cwd TEXT;
  ALTER TABLE projects ADD COLUMN isolate INTEGER NOT NULL DEFAULT 0;

-- Frozen migration 4

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

-- Frozen migration 5

  ALTER TABLE session_events ADD COLUMN path TEXT;
  CREATE INDEX session_events_by_path ON session_events (path, at);

-- Frozen migration 6

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

-- Frozen migration 7

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

-- Frozen migration 8

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

-- Frozen migration 9

  ALTER TABLE sessions ADD COLUMN limit_since INTEGER;
  ALTER TABLE sessions ADD COLUMN limit_resets_at INTEGER;

-- Frozen migration 10

  ALTER TABLE projects ADD COLUMN setup_command TEXT;

-- Frozen migration 11

  ALTER TABLE cards ADD COLUMN pr_url TEXT;
