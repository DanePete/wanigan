// Skills/MCP need roots, not account identity/usage or whole project summaries.
// Count/byte admission precedes JS values in the same SQLite read transaction.
import type { Account, AccountProvider } from '../shared/model.ts';
import { CoreError } from '../shared/protocol.ts';
import type { ConfigReadBudget } from './config-read.ts';
import type { DB } from './db.ts';

export type ConfigAccount = Pick<Account, 'id' | 'provider' | 'label' | 'configDir' | 'isDefault'>;
export interface ConfigProject { id: string; name: string; path: string; pausedAt: number | null }
interface AccountRow { id: string; provider: AccountProvider; label: string; config_dir: string | null; is_default: number }
interface ProjectRow { id: string; name: string; path: string; paused_at: number | null }
const ACCOUNT = 'SELECT id, provider, label, config_dir, is_default FROM accounts';
const PROJECT = 'SELECT id, name, path, paused_at FROM projects';

function rows<T>(db: DB, budget: ConfigReadBudget, sql: string, columns: readonly string[], params: string[] = []): T[] {
  return db.transaction(() => {
    // SQL and columns are fixed below. SQLite may still scan/sort to answer the
    // aggregate: this bounds admitted JS data, not SQL execution work.
    const size = columns.map((column) => `COALESCE(length(CAST(${column} AS BLOB)), 0)`).join(' + ');
    const cost = db.prepare(`SELECT count(*) AS items, COALESCE(sum(${size}), 0) AS bytes FROM (${sql})`).get(...params) as { items: number; bytes: number };
    budget.take('items', cost.items); budget.take('bytes', cost.bytes);
    return db.prepare(sql).all(...params) as T[];
  })();
}

function accounts(db: DB, budget: ConfigReadBudget, where: string, params: string[] = []): ConfigAccount[] {
  return rows<AccountRow>(db, budget, `${ACCOUNT} ${where}`, ['id', 'provider', 'label', 'config_dir'], params)
    .map((r) => ({ id: r.id, provider: r.provider, label: r.label, configDir: r.config_dir, isDefault: r.is_default === 1 }));
}

export function configAccounts(db: DB, budget: ConfigReadBudget): ConfigAccount[] {
  return accounts(db, budget, 'WHERE archived_at IS NULL ORDER BY provider, is_default DESC, label COLLATE NOCASE, rowid');
}

export function configAccount(db: DB, budget: ConfigReadBudget, id: string): ConfigAccount {
  const account = accounts(db, budget, 'WHERE id = ?', [id])[0];
  if (!account) throw new CoreError('not_found', 'No such account.');
  return account;
}

export function configProjects(db: DB, budget: ConfigReadBudget, id?: string, includeArchived = false): ConfigProject[] {
  const where = id ? `WHERE id = ?${includeArchived ? '' : ' AND archived_at IS NULL'}` : 'WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE, rowid';
  return rows<ProjectRow>(db, budget, `${PROJECT} ${where}`, ['id', 'name', 'path'], id ? [id] : [])
    .map((r) => ({ id: r.id, name: r.name, path: r.path, pausedAt: r.paused_at }));
}

/** Same project-choice then active-default precedence as Accounts.resolve. */
export function configProjectAccount(db: DB, budget: ConfigReadBudget, projectId: string, provider: AccountProvider): ConfigAccount | null {
  const chosen = accounts(db, budget,
    'WHERE id = (SELECT account_id FROM project_accounts WHERE project_id = ? AND provider = ?) AND archived_at IS NULL', [projectId, provider])[0];
  return chosen ?? accounts(db, budget, 'WHERE provider = ? AND is_default = 1 AND archived_at IS NULL LIMIT 1', [provider])[0] ?? null;
}
