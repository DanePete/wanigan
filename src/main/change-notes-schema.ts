import type Database from 'better-sqlite3';

/**
 * Agent change notes (helper sweep · P10): what a session wrote about its own
 * diff, and what the operator did with it. Additive tables only; a build
 * without them simply never reads them.
 *
 * Kept apart from review_marks and review_mark_events on purpose. Those hold
 * the operator's words, and no path that writes here has a statement that
 * names them — the smoke suite traces every SQL statement an MCP call prepares
 * to prove it.
 */
export function migrateChangeNotes(d: Database.Database): void {
  d.exec(`
    -- One note per row, keyed to the diff it was written on (session, checkout,
    -- base commit) like a review mark. anchor_key fingerprints the anchored
    -- lines, so a note whose lines read differently now is shown as stale;
    -- content_hash is the file's blob when the note was written. body and
    -- quote_json are redacted before they are stored.
    CREATE TABLE IF NOT EXISTS agent_change_notes (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      worktree      TEXT NOT NULL,
      base_commit   TEXT NOT NULL,
      path          TEXT NOT NULL,
      side          TEXT NOT NULL,
      start_line    INTEGER NOT NULL,
      end_line      INTEGER NOT NULL,
      body          TEXT NOT NULL,
      quote_json    TEXT NOT NULL,
      quote_omitted INTEGER NOT NULL,
      hunk_header   TEXT NOT NULL,
      anchor_key    TEXT NOT NULL,
      content_hash  TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      withdrawn_at  INTEGER,
      dismissed_at  INTEGER,
      quoted_at     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_agent_change_notes_session ON agent_change_notes(session_id, created_at);

    -- Every act on a note and who did it: the agent wrote or withdrew it, the
    -- operator dismissed it or quoted it into their own review note.
    CREATE TABLE IF NOT EXISTS agent_change_note_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id    TEXT NOT NULL,
      session_id TEXT NOT NULL,
      actor      TEXT NOT NULL,
      action     TEXT NOT NULL,
      at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_change_note_events ON agent_change_note_events(note_id, at);
  `);
}
