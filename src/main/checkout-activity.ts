import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from './db';

export type CheckoutActivityKind = 'session' | 'headless' | 'review' | 'worktree' | 'restore';
const OWNER = `checkout-${process.pid}-${randomUUID()}`;

type Activity = { id: string; cwd: string; kind: string; operation_id: string };

function canonical(cwd: string): string {
  return fs.realpathSync.native(cwd);
}

function overlaps(a: string, b: string): boolean {
  const beneath = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  };
  return beneath(a, b) || beneath(b, a);
}

/** Existing evidence without a new ownership receipt is still a possible writer. */
function legacyWriters(): Activity[] {
  const d = db();
  const present = (table: string) => Boolean(d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  const writers: Activity[] = [];
  if (present('session_log')) writers.push(...d.prepare(`SELECT id,COALESCE(worktree,project_path) AS cwd,
    'session' AS kind,id AS operation_id FROM session_log WHERE ended_at IS NULL`).all() as Activity[]);
  if (present('headless_rows')) {
    const columns = d.prepare('PRAGMA table_info(headless_rows)').all() as { name: string }[];
    const unresolved = columns.some(c => c.name === 'recovery_unresolved') ? ' OR recovery_unresolved=1' : '';
    writers.push(...d.prepare(`SELECT run_id || ':' || project_id AS id,
      COALESCE(worktree,project_path) AS cwd,'headless' AS kind,run_id AS operation_id
      FROM headless_rows WHERE status='running'${unresolved}`).all() as Activity[]);
  }
  if (present('review_runs')) writers.push(...d.prepare(`SELECT r.id,
    COALESCE(json_extract(CASE WHEN json_valid(r.evidence_json) THEN r.evidence_json ELSE '{}' END,'$.before.cwd'),p.path,'') AS cwd,
    'review' AS kind,r.id AS operation_id FROM review_runs r LEFT JOIN projects p ON p.id=r.project_id
    WHERE r.status='running'`).all() as Activity[]);
  if (present('review_checkout_owners')) writers.push(...d.prepare(`SELECT run_id AS id,cwd,
    'review' AS kind,run_id AS operation_id FROM review_checkout_owners`).all() as Activity[]);
  if (present('worktree_command_runs')) {
    const columns = d.prepare('PRAGMA table_info(worktree_command_runs)').all() as { name: string }[];
    const unresolved = columns.some(c => c.name === 'recovery_unresolved') ? ' OR recovery_unresolved=1' : '';
    writers.push(...d.prepare(`SELECT id,worktree AS cwd,'worktree' AS kind,id AS operation_id
      FROM worktree_command_runs WHERE status='running'${unresolved}`).all() as Activity[]);
  }
  return writers;
}

/** Called inside acquisition's IMMEDIATE transaction to exclude other app/daemon owners. */
function assertAvailable(cwd: string, kind: CheckoutActivityKind): void {
  const rows = db().prepare('SELECT id,cwd,kind,operation_id FROM checkout_activity').all() as Activity[];
  if (kind === 'restore') rows.push(...legacyWriters());
  const conflict = rows.find(row => {
    if (kind !== 'restore' && row.kind !== 'restore') return false;
    if (!row.cwd) return true; // An unattributed old writer cannot prove any checkout idle.
    let other = row.cwd;
    try { other = canonical(other); } catch { /* Preserve the recorded path of an unresolved owner. */ }
    return overlaps(cwd, other);
  });
  if (conflict) throw new Error(`This checkout has active or unreconciled ${conflict.kind} work (${conflict.operation_id}). `
    + 'Wait for its owner to finish and reconcile it before restoring or starting work during a restore.');
}

export function assertCheckoutAvailable(cwd: string, kind: CheckoutActivityKind): void {
  assertAvailable(canonical(cwd), kind);
}

/**
 * Writers may coexist as before, but restoration is exclusive in either
 * direction. A clock/owner restart cannot erase a claim: only the live owner
 * receives its release capability. Call it after confirmed process exit and
 * checkout cleanup, never merely because a kill signal or lease expired.
 */
export function acquireCheckoutActivity(cwd: string, kind: CheckoutActivityKind, operationId: string): () => void {
  const root = canonical(cwd);
  const id = randomUUID();
  const d = db();
  d.transaction(() => {
    assertAvailable(root, kind);
    d.prepare(`INSERT INTO checkout_activity(id,cwd,kind,operation_id,owner_id,created_at)
      VALUES(?,?,?,?,?,?)`).run(id, root, kind, operationId, OWNER, Date.now());
  }).immediate();
  let released = false;
  return () => {
    if (released) return;
    d.prepare('DELETE FROM checkout_activity WHERE id=? AND owner_id=?').run(id, OWNER);
    released = true;
  };
}
