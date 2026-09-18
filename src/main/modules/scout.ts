import type Database from 'better-sqlite3';
import type { WaniganModule } from '../module-registry';
import * as scout from '../improvement-scout';
import { IMPROVEMENT_SCOUT_SCHEDULE_ID } from '../schedule';

/**
 * AI Improvement Scout as a module: the schema `db.ts` used to carry as
 * `migrateImprovementScout`, the eleven `scout:*` channels `index.ts` used to
 * register by hand, and the weekly schedule it wired beside a `queue.registerRunner`
 * call. All three moved here without changing; the behaviour lives in
 * `../improvement-scout.ts` exactly as before.
 *
 * Scout is removable. It reads the public web on a schedule — five official
 * changelogs today, whichever an installed extension declares tomorrow — and
 * an operator running private repositories may want none of that egress, ever.
 * Nothing in the trust kernel depends on it: sessions launch, evidence records
 * and reviews gate the same with it gone. So `required` is `null`, and the
 * reason a person might switch it off is stated rather than hidden.
 *
 * Scout's route is still hand-registered this pass. The renderer half of the
 * module seam is `src/shared/view-module.ts`, which is in progress in another
 * session; when it lands, the `scout` row in `src/shared/routes.ts` becomes a
 * declaration there, and this file stays the main-process half.
 */

/** Idempotent ALTER TABLE — SQLite has no "ADD COLUMN IF NOT EXISTS". The same
 * four lines as `db.ts`'s private helper; a module's schema is its own. */
function addColumn(d: Database.Database, table: string, column: string, decl: string) {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

/**
 * AI Improvement Scout is intentionally an evidence inbox, not a self-editing
 * updater. Its source registry is local and allow-listed; fetched excerpts and
 * deterministic proposals stay in this database until a person explicitly
 * turns one into a Control Goal.
 */
function migrate(d: Database.Database) {
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

  // Which extension declared a Scout source. NULL on the five rows that
  // predate extensions, which the built-in source extension adopts by id on
  // its first run rather than duplicating — the url column is UNIQUE, and a
  // second row for the same changelog would be refused by the schema before
  // it could be refused by anyone. Here, after the CREATE, rather than among
  // the other owner columns in migratePhases: an ADD COLUMN on a table that
  // does not exist yet is "no such table", and a fresh database has no
  // improvement_scout_sources until the statement above runs.
  addColumn(d, 'improvement_scout_sources', 'owner', 'TEXT');

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

  // The five shipped sources used to be seeded here — INSERT OR IGNORE'd on
  // every start, then refreshed by id so a build could correct a URL without
  // re-enabling a source the operator had turned off. They now live in the
  // built-in extension (src/main/extensions/builtin.ts), which the extension
  // installer applies at startup as rows in this table with `owner` set. The
  // seed left with them: two writers upserting the same five ids would each
  // overwrite the other's label and url every launch, and the installer's
  // fingerprint — which is how an uninstall tells "as declared" from "edited
  // by a person" — would never hold.
}

export const scoutModule: WaniganModule = {
  id: 'scout',
  label: 'AI Improvement Scout',
  required: null,
  migrate,
  ipc(handle) {
    handle('scout:overview', () => scout.overview());
    handle('scout:settings', () => scout.settings());
    handle('scout:setSettings', (patch: Partial<import('../../shared/types').ImprovementScoutSettings>) =>
      scout.updateSettings(patch));
    handle('scout:sources', () => scout.listSources());
    handle('scout:setSourceEnabled', (id: string, enabled: boolean) => scout.setSourceEnabled(id, enabled === true));
    handle('scout:runs', (limit?: number) => scout.listRuns(limit));
    handle('scout:suggestions', (filter?: Parameters<typeof scout.listSuggestions>[0]) => scout.listSuggestions(filter));
    handle('scout:suggestion', (id: string) => scout.suggestion(id));
    handle('scout:updateSuggestion', (id: string, patch: Parameters<typeof scout.updateSuggestion>[1]) =>
      scout.updateSuggestion(id, patch));
    // Scheduled mode belongs only to the durable queue runner declared in
    // `schedules` below. A renderer can explicitly ask for a visible manual
    // pass or a hard local-only preview, but cannot borrow the stored
    // unattended-network permission by forging a `scheduled` IPC payload.
    handle('scout:run', (input?: { mode?: 'manual' | 'preview'; allowNetwork?: boolean }) => {
      if (input?.mode !== undefined && input.mode !== 'manual' && input.mode !== 'preview') {
        throw new Error('Scout IPC supports manual research or a local preview. Weekly research runs only through its durable schedule.');
      }
      return scout.run({ mode: input?.mode ?? 'manual', allowNetwork: input?.allowNetwork === true });
    });
    handle('scout:createGoal', (id: string, input: { projectId: string }) => scout.createGoal(id, input));
  },
  schedules: () => [{
    id: IMPROVEMENT_SCOUT_SCHEDULE_ID,
    // The Scout is a fourth dispatcher lane rather than a loose timer. That
    // gives its weekly schedule the same durable lease and attended/launchd
    // cross-process behavior as every other scheduled task. The runner only
    // accepts Wanigan's fixed schedule payload; renderer text cannot name a URL.
    kind: 'scout',
    describe: 'Weekly online research against the enabled official Scout sources, only while the Scout, weekly research and its separate unattended-network permission are all on.',
    run: async (payload) => {
      const value = payload as { scout?: unknown; version?: unknown };
      if (value.scout !== true || value.version !== 1) {
        throw new Error('This Scout queue item is not a Wanigan weekly-research schedule. Remove it and re-enable the Scout schedule from its dashboard.');
      }
      // A queue item may have been claimed just before the operator disabled
      // weekly/network research. Do not make it fail/retry; it has no authority
      // to override the newer persisted preference.
      if (!scout.scheduledResearchAllowed()) return;
      await scout.runScheduled();
    },
    // Upsert a stable schedule id on both the attended app and launchd. It is
    // disabled by default and only arms after the operator permits unattended
    // allow-listed source requests in Scout settings.
    sync: () => scout.syncWeeklySchedule(),
  }],
};
