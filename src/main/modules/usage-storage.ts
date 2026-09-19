import type Database from 'better-sqlite3';

/**
 * Schema owned by the required Usage module. Named steps preserve db.ts's
 * historical bootstrap order without importing telemetry runtime into the
 * database migration. This file deliberately imports no runtime or database.
 */
function migrateTelemetry(d: Database.Database): void {
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

  `);
}

/**
 * What the CLI reports about itself beyond cost and tool events: its status
 * line's limit and cache readings, its beta per-prompt trace spans, and the
 * attribution its cost and token metrics carry. Four new tables and nothing
 * altered, so an install that never runs these features has four empty tables
 * and every existing reader is untouched.
 */
function migrateObservedTelemetry(d: Database.Database) {
  d.exec(`
    -- One row per distinct status line reading. A reading identical to the
    -- session's previous one only moves last_seen_at, so an idle session that
    -- refreshes its status line every few seconds writes no rows. A redraw is
    -- not a new reading of the provider, so the forecast reads observed_at only.
    CREATE TABLE IF NOT EXISTS status_observations (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id            TEXT NOT NULL,
      account_id            TEXT,
      observed_at           INTEGER NOT NULL,
      last_seen_at          INTEGER NOT NULL,
      cli_version           TEXT,
      reading_key           TEXT NOT NULL,
      -- A window the CLI did not send is NULL in both columns, never 0.
      five_hour_pct         REAL,
      five_hour_resets_at   INTEGER,
      seven_day_pct         REAL,
      seven_day_resets_at   INTEGER,
      spend_limit_pct       REAL,
      spend_limit_resets_at INTEGER,
      effort                TEXT,
      pr_number             INTEGER,
      pr_url                TEXT,
      pr_review_state       TEXT,
      prompt_id             TEXT,
      cache_json            TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_status_obs_session ON status_observations(session_id, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_status_obs_account ON status_observations(account_id, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_status_obs_seen ON status_observations(last_seen_at);

    -- Per-prompt trace spans, attributes already stripped of anything that is
    -- conversation text. An exporter re-sends what it did not get a 2xx for, so
    -- a span is its own identity and a retry is ignored rather than doubled.
    CREATE TABLE IF NOT EXISTS session_spans (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id     TEXT NOT NULL,
      trace_id       TEXT NOT NULL,
      span_id        TEXT NOT NULL,
      parent_span_id TEXT,
      name           TEXT NOT NULL,
      start_at       INTEGER NOT NULL,
      end_at         INTEGER,
      status         TEXT NOT NULL DEFAULT 'unset',
      attrs_json     TEXT,
      received_at    INTEGER NOT NULL,
      UNIQUE (session_id, trace_id, span_id)
    );
    CREATE INDEX IF NOT EXISTS idx_session_spans ON session_spans(session_id, start_at);
    -- Retention deletes by age; this keeps that a range scan.
    CREATE INDEX IF NOT EXISTS idx_session_spans_start ON session_spans(start_at);

    -- Sessions launched with the trace exporter on. A session that asked and
    -- exported nothing for a turn is told apart from one that never asked.
    CREATE TABLE IF NOT EXISTS session_trace_requests (
      session_id   TEXT PRIMARY KEY,
      requested_at INTEGER NOT NULL
    );

    -- Cost and token metrics by the attribution the CLI attaches to them,
    -- bucketed by local day so a window is exact to the day. Kept beside
    -- session_metrics rather than in it: adding these attributes to that
    -- table's key would split every existing running total across new rows.
    CREATE TABLE IF NOT EXISTS session_spend_sources (
      session_id   TEXT NOT NULL,
      day          TEXT NOT NULL,
      metric       TEXT NOT NULL,
      token_type   TEXT NOT NULL DEFAULT '',
      query_source TEXT NOT NULL DEFAULT '',
      agent_name   TEXT NOT NULL DEFAULT '',
      skill_name   TEXT NOT NULL DEFAULT '',
      plugin_name  TEXT NOT NULL DEFAULT '',
      mcp_server   TEXT NOT NULL DEFAULT '',
      effort       TEXT NOT NULL DEFAULT '',
      speed        TEXT NOT NULL DEFAULT '',
      model        TEXT NOT NULL DEFAULT '',
      value        REAL NOT NULL DEFAULT 0,
      last_at      INTEGER NOT NULL,
      PRIMARY KEY (session_id, day, metric, token_type, query_source, agent_name, skill_name,
                   plugin_name, mcp_server, effort, speed, model)
    );
    CREATE INDEX IF NOT EXISTS idx_spend_sources_day ON session_spend_sources(day);
  `);
}

export const usageSchema = {
  base: migrateTelemetry,
  observed: migrateObservedTelemetry,
};

export function migrateUsage(d: Database.Database): void {
  usageSchema.base(d);
  usageSchema.observed(d);
}
