import type Database from 'better-sqlite3';
import type { WaniganModule } from '../module-registry';

/** Idempotent ALTER TABLE — SQLite has no "ADD COLUMN IF NOT EXISTS". */
function addColumn(d: Database.Database, table: string, column: string, decl: string) {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((entry) => entry.name === column)) return;
  d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

function migrate(d: Database.Database): void {
  d.exec(`
    -- A review recipe is operator-owned commands plus the immutable evidence
    -- from each execution. Agents may suggest commands; only this surface runs
    -- the configured gate and records its result.
    CREATE TABLE IF NOT EXISTS review_recipes (
      project_id TEXT PRIMARY KEY,
      commands_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS review_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT NOT NULL,
      results_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_runs_project ON review_runs(project_id, started_at DESC);
    -- A checkout claim survives its owner. Expiry is uncertainty, never
    -- permission to repeat commands whose descendants may still be running.
    CREATE TABLE IF NOT EXISTS review_checkout_owners (
      cwd TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL,
      owner_pid INTEGER,
      lease_expires_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'unresolved'))
    );
  `);
  // Existing command results remain historical evidence with no invented identity.
  addColumn(d, 'review_runs', 'session_id', 'TEXT');
  addColumn(d, 'review_runs', 'evidence_json', 'TEXT');
}

/**
 * Review owns the operator-approved verification recipe and the immutable
 * evidence produced by running it. Runtime imports remain behind handlers so
 * database bootstrap does not acquire a review -> db -> module cycle.
 */
export const reviewModule: WaniganModule = {
  id: 'review',
  label: 'Review',
  required: {
    reason: 'Review owns operator-approved verification commands and the checkout evidence used to decide whether work is verified.',
  },
  migrate,
  ipc(handle, context) {
    handle('review:recipe', async (projectId: string) => (await import('../review')).recipe(projectId));
    handle('review:saveRecipe', async (projectId: string, commands: string[]) =>
      (await import('../review')).saveRecipeWithConsent(context.getWindow(), projectId, commands));
    handle('review:history', async (projectId: string, limit?: number, sessionId?: string) =>
      (await import('../review')).historyWithFreshness(projectId, limit, sessionId));
    handle('review:run', async (projectId: string, sessionId?: string) => {
      const result = await (await import('../review')).run(projectId, sessionId);
      try { (await import('../learning-service')).observeReviewResult(result); }
      catch (error) { console.warn('[wanigan] review learning signal skipped:', error); }
      return result;
    });
  },
};
