import type Database from 'better-sqlite3';

/**
 * The advisory lookup's cache (helper sweep P11), kept out of db.ts so the
 * migration that adds it is one call there. Additive only: one new table,
 * created when absent, which an older build never reads.
 *
 * One row per question asked of one source about one exact package version.
 * `source` is 'osv' for the advisory list and 'registry' for a publish time.
 * Only an answer is stored — a timeout or a refusal is never cached, so a
 * failed check cannot come back later looking like a result. `result_json` is
 * what the source said, already reduced to the fields Wanigan reads (advisory
 * ids and their modified times; a publish time or why there was none), never
 * the registry document itself.
 *
 * Imports nothing from db.ts, for the same reason depth-schema.ts does not.
 */
export function migrateDependencyAdvisories(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS dependency_lookup_cache (
      source     TEXT NOT NULL,
      ecosystem  TEXT NOT NULL,
      name       TEXT NOT NULL,
      version    TEXT NOT NULL,
      checked_at INTEGER NOT NULL,
      result_json TEXT NOT NULL,
      PRIMARY KEY (source, ecosystem, name, version)
    );
  `);
}
