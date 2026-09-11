import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { SessionGoal } from '../shared/goal-journey';
import { db } from './db';
import { halted, refuseIfHalted } from './halt';
import { headSync } from './git';
import { listProjects, projectById } from './store';
import { createSession, killSession, listSessions } from './sessions';
import * as review from './review';
import * as otel from './otel';
import { listGoalTrace, recordGoalTrace } from './goal-trace';
import { enqueue } from './queue';
import type {
  BoardCard,
  ControlEvent, DocketCheckpoint, DocketClaim, DocketDetail, DocketNode,
  DocketAutopilot, DocketNodeKind, DocketNodeStatus, DocketPlanNode, DocketProof, DocketRisk, DocketStatus,
  GoalCapsule, GoalResumeReceipt, GoalTraceEvent,
  McpTaskCancelReceipt, McpTaskRecord, ModelOutcome, WorkDocket,
} from '../shared/types';
// Aliased at the import so the graph rules below still read in this module's
// own vocabulary: these are the shared declarations, and the renderer's plan
// editor seeds from the same four phases rather than from a second copy.
import {
  DEFAULT_DOCKET_PLAN as DEFAULT_PLAN,
  DOCKET_NODE_KINDS as NODE_KINDS,
  MAX_DOCKET_NODE_DEPENDENCIES as MAX_NODE_DEPENDENCIES,
  MAX_DOCKET_PLAN_NODES as MAX_PLAN_NODES,
} from '../shared/types';

type DocketRow = {
  id: string; project_id: string; title: string; objective: string; acceptance_json: string;
  risk: string; budget_usd: number | null; base_commit: string | null; status: string;
  created_at: number; updated_at: number;
  autopilot: number; autopilot_provider: string | null; autopilot_model: string | null;
};
type NodeRow = {
  id: string; docket_id: string; kind: string; title: string; instructions: string; depends_json: string;
  status: string; provider_id: string | null; model: string | null; session_id: string | null;
  worktree: string | null; started_at: number | null; ended_at: number | null; detail: string | null;
  claim_path: string | null; dispatch_state: string | null; defer_until: number | null;
};

const MAX_OBJECTIVE = 12_000;
const MAX_NOTE = 4_000;
const MAX_INSTRUCTIONS = 8_000;
const RISKS: DocketRisk[] = ['low', 'elevated', 'high'];

/**
 * The single prefix every automatic autopilot halt is written with.
 *
 * `haltAutopilot` writes it and `autopilotHalt` reads it back off, so the
 * reason a goal stopped itself survives a restart as evidence rather than as
 * a sentence some surface has to parse. Both sides naming this constant is the
 * point: a halt row and the field that reports it cannot drift apart.
 */
export const AUTOPILOT_HALT_PREFIX = 'Autopilot stopped: ';

const uid = (prefix: string) => `${prefix}_${randomUUID().slice(0, 12)}`;
const safeText = (value: unknown, label: string, max: number) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  const text = value.trim();
  if (text.length > max) throw new Error(`${label} is too long (maximum ${max.toLocaleString()} characters).`);
  return text;
};
const parseStrings = (value: string): string[] => {
  try {
    const raw = JSON.parse(value) as unknown;
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
  } catch { return []; }
};
const now = () => Date.now();

/**
 * The commit a goal or checkpoint was recorded against.
 *
 * This used to be its own `execFileSync` with no timeout and no hardened
 * environment: against a repo whose git decided it needed a credential, the
 * main process — and every PTY it pumps — stopped until someone quit the app.
 * git.ts owns both, so this is now one bounded call. A null still means "no
 * commit was recorded", which the caller stores as such rather than guessing.
 */
function gitHead(root: string): string | null {
  return root ? headSync(root) : null;
}

function mapDocket(row: DocketRow): WorkDocket {
  const project = projectById(row.project_id);
  return {
    id: row.id, projectId: row.project_id, projectName: project?.name ?? 'Removed project',
    title: row.title, objective: row.objective, acceptance: parseStrings(row.acceptance_json),
    risk: RISKS.includes(row.risk as DocketRisk) ? row.risk as DocketRisk : 'elevated',
    budgetUsd: row.budget_usd, baseCommit: row.base_commit,
    status: row.status as DocketStatus, createdAt: row.created_at, updatedAt: row.updated_at,
    autopilot: autopilotState(row),
  };
}

/**
 * What a goal has actually spent, and how much of that we can vouch for.
 *
 * The set is the union of the sessions its tasks point at right now and the
 * sessions `work_node_sessions` has recorded for them. It has to be a union
 * because `work_nodes.session_id` is a live pointer and `retryNode` nulls it:
 * read that column alone and a reopened task takes its spend back out of the
 * cap, so a goal could be dispatched again on the strength of money it had
 * already spent, and a goal whose tasks had all been reopened reported that no
 * session had been launched for it at all.
 *
 * Only reported provider cost is counted. A provider that reports nothing is
 * not treated as free — it moves `spendStatus` down so the surface, and the
 * budget refusal below, can say the cap covers part of the work rather than
 * implying it covers all of it. The status is decided over the same union the
 * dollars are summed over, so the two are never computed from different
 * populations. That is not a claim of completeness for older data: a task
 * reopened before `work_node_sessions` existed dropped its pointer with
 * nothing recorded, and this query cannot see the session it dropped.
 *
 * Usage is fetched for the whole set in one call. This runs once per row of
 * `listDockets`, and the set it reads only ever grows.
 */
function autopilotSpend(docketId: string): Pick<DocketAutopilot, 'spendUsd' | 'spendStatus'> {
  const sessions = (db().prepare(`SELECT session_id FROM work_nodes WHERE docket_id=? AND session_id IS NOT NULL
    UNION SELECT session_id FROM work_node_sessions WHERE docket_id=?`)
    .all(docketId, docketId) as { session_id: string }[]).map((row) => row.session_id);
  if (!sessions.length) return { spendUsd: 0, spendStatus: 'none' };
  const usage = otel.usageForMany(sessions);
  let spendUsd = 0; let reported = 0;
  for (const id of sessions) {
    const row = usage[id];
    if (row?.costStatus === 'reported') { spendUsd += row.costUsd; reported++; }
  }
  const spendStatus: DocketAutopilot['spendStatus'] = reported === sessions.length ? 'reported'
    : reported === 0 ? 'unreported' : 'partial';
  return { spendUsd, spendStatus };
}

/**
 * Remember that this task ran under this session, for as long as the task
 * exists.
 *
 * `work_nodes.session_id` answers "what is this task attached to now" and is
 * nulled on reopen; `work_resume_receipts` is keyed on `node_id` and is
 * overwritten by the next dispatch. Neither still names a session a task has
 * been reopened away from, which is what a spend cap has to keep counting.
 * This row is not rewritten by either event, and `autopilotSpend` reads it.
 * Idempotent on (node, session), so a caller never has to check first.
 */
function recordNodeSession(nodeId: string, docketId: string, sessionId: string): void {
  db().prepare(`INSERT INTO work_node_sessions (node_id,docket_id,session_id,at) VALUES (?,?,?,?)
    ON CONFLICT(node_id,session_id) DO NOTHING`).run(nodeId, docketId, sessionId, now());
}

/**
 * Why unattended dispatch last stopped itself, if it ever did.
 *
 * The reason is read back out of the proof `haltAutopilot` already writes
 * rather than kept in a second column, so there is exactly one durable account
 * of a halt and no way for a flag and its evidence to disagree. Review
 * decisions are also `kind='decision'`, so the prefix — not the kind — is what
 * separates a halt from an operator's approval; it contains no `%` or `_`, so
 * the LIKE pattern needs no escape clause. The prefix is sliced off here
 * because a surface should be handed a reason, not a string to parse.
 *
 * This runs once per row of `listDockets`, which is why it is a single indexed
 * seek: idx_work_proofs_docket covers (docket_id, created_at DESC).
 */
function autopilotHalt(docketId: string): Pick<DocketAutopilot, 'haltedReason' | 'haltedAt'> {
  const row = db().prepare(`SELECT summary, created_at FROM work_proofs
    WHERE docket_id=? AND kind='decision' AND summary LIKE ?
    ORDER BY created_at DESC LIMIT 1`)
    .get(docketId, `${AUTOPILOT_HALT_PREFIX}%`) as { summary: string; created_at: number } | undefined;
  if (!row) return { haltedReason: null, haltedAt: null };
  return { haltedReason: row.summary.slice(AUTOPILOT_HALT_PREFIX.length), haltedAt: row.created_at };
}

function autopilotState(row: DocketRow): DocketAutopilot {
  return {
    enabled: row.autopilot === 1,
    providerId: row.autopilot_provider,
    model: row.autopilot_model,
    budgetUsd: row.budget_usd,
    ...autopilotSpend(row.id),
    ...autopilotHalt(row.id),
  };
}

function rawNodes(docketId: string): NodeRow[] {
  return db().prepare('SELECT * FROM work_nodes WHERE docket_id=? ORDER BY rowid').all(docketId) as NodeRow[];
}

/** Dependencies are computed from durable rows each read; an app restart cannot
 * leave a transient "ready" cache lying about a task whose prerequisite failed. */
function mapNodes(rows: NodeRow[], at: number = Date.now()): DocketNode[] {
  const complete = new Set(rows.filter((row) => row.status === 'completed').map((row) => row.id));
  const failed = new Set(rows.filter((row) => ['failed', 'canceled'].includes(row.status)).map((row) => row.id));
  return rows.map((row) => {
    const dependsOn = parseStrings(row.depends_json);
    let status = row.status as DocketNodeStatus;
    if (status === 'pending') {
      status = dependsOn.some((id) => failed.has(id)) ? 'blocked'
        : dependsOn.every((id) => complete.has(id)) ? 'ready' : 'blocked';
      // A parked ticket is not ready, however satisfied its dependencies are.
      // Derived here rather than stored as a status of its own, for the reason
      // the comment above this function gives about 'ready': the date is the
      // durable fact and the state is read from it, so a deferral that has come
      // due needs no sweep to notice — the next read simply returns 'ready'.
      // Storing a 'deferred' status instead would mean a ticket parked to
      // Tuesday sits in that status forever unless something wakes it up.
      if (status === 'ready' && row.defer_until !== null && row.defer_until > at) status = 'pending';
    }
    return {
      id: row.id, docketId: row.docket_id, kind: NODE_KINDS.includes(row.kind as DocketNodeKind)
        ? row.kind as DocketNodeKind : 'implement',
      title: row.title, instructions: row.instructions, dependsOn, claimPath: row.claim_path, status,
      providerId: row.provider_id, model: row.model, sessionId: row.session_id,
      worktree: row.worktree, startedAt: row.started_at, endedAt: row.ended_at, detail: row.detail,
      queued: row.dispatch_state === 'queued',
      deferUntil: row.defer_until,
    };
  });
}

function docketRow(id: string): DocketRow {
  const row = db().prepare('SELECT * FROM work_dockets WHERE id=?').get(id) as DocketRow | undefined;
  if (!row) throw new Error('Goal not found.');
  return row;
}

function nodeRow(id: string): NodeRow {
  const row = db().prepare('SELECT * FROM work_nodes WHERE id=?').get(id) as NodeRow | undefined;
  if (!row) throw new Error('Goal task not found.');
  return row;
}

function touch(docketId: string): void {
  db().prepare('UPDATE work_dockets SET updated_at=? WHERE id=?').run(now(), docketId);
}

function setTaskStatus(nodeId: string, status: McpTaskRecord['status']): void {
  db().prepare('UPDATE mcp_task_records SET status=?, updated_at=? WHERE node_id=?').run(status, now(), nodeId);
}

/**
 * Releases every claim this task still holds, and reports how many moved.
 *
 * The count is what a surface needs to say something true about a release:
 * a task can hold none, and a task whose claims were already released holds
 * none either. Callers that only need the release still ignore the number.
 */
function releaseClaims(nodeId: string): number {
  return db().prepare('UPDATE work_claims SET released_at=? WHERE node_id=? AND released_at IS NULL')
    .run(now(), nodeId).changes;
}

function setDocketPhase(docketId: string): void {
  const raw = rawNodes(docketId);
  const nodes = mapNodes(raw);
  const row = docketRow(docketId);
  let status: DocketStatus = row.status as DocketStatus;
  // `blocked` in the presentation map also means an ordinary unmet dependency.
  // Only a stored failure/cancellation blocks the whole goal.
  if (raw.some((n) => n.status === 'failed' || n.status === 'canceled')) status = 'blocked';
  else if (nodes.some((n) => n.status === 'running')) status = 'executing';
  else if (nodes.find((n) => n.kind === 'review')?.status === 'completed') status = 'accepted';
  else if (nodes.find((n) => n.kind === 'review')?.status === 'ready') status = 'review';
  else if (nodes.some((n) => n.status === 'completed')) status = 'executing';
  db().prepare('UPDATE work_dockets SET status=?, updated_at=? WHERE id=?').run(status, now(), docketId);
}

function proofRows(docketId: string): DocketProof[] {
  return (db().prepare('SELECT * FROM work_proofs WHERE docket_id=? ORDER BY created_at DESC').all(docketId) as Array<{
    id: string; docket_id: string; node_id: string | null; kind: DocketProof['kind']; status: DocketProof['status']; summary: string; created_at: number;
  }>).map((row) => ({ id: row.id, docketId: row.docket_id, nodeId: row.node_id, kind: row.kind, status: row.status, summary: row.summary, createdAt: row.created_at }));
}

function claimRows(docketId: string): DocketClaim[] {
  return (db().prepare('SELECT * FROM work_claims WHERE docket_id=? ORDER BY created_at DESC').all(docketId) as Array<{
    id: string; docket_id: string; node_id: string; path: string; created_at: number; released_at: number | null;
  }>).map((row) => ({ id: row.id, docketId: row.docket_id, nodeId: row.node_id, path: row.path, createdAt: row.created_at, releasedAt: row.released_at }));
}

function checkpointRows(docketId: string): DocketCheckpoint[] {
  return (db().prepare('SELECT * FROM work_checkpoints WHERE docket_id=? ORDER BY created_at DESC').all(docketId) as Array<{
    id: string; docket_id: string; node_id: string | null; session_id: string | null; conversation_id: string | null;
    repo_commit: string | null; worktree: string | null; note: string; created_at: number;
  }>).map((row) => ({ id: row.id, docketId: row.docket_id, nodeId: row.node_id, sessionId: row.session_id,
    conversationId: row.conversation_id, repoCommit: row.repo_commit, worktree: row.worktree, note: row.note, createdAt: row.created_at }));
}

export function listDockets(projectId?: string | null, limit = 80): WorkDocket[] {
  const max = Math.max(1, Math.min(200, Math.round(limit)));
  const rows = projectId
    ? db().prepare('SELECT * FROM work_dockets WHERE project_id=? ORDER BY updated_at DESC LIMIT ?').all(projectId, max)
    : db().prepare('SELECT * FROM work_dockets ORDER BY updated_at DESC LIMIT ?').all(max);
  return (rows as DocketRow[]).map(mapDocket);
}

export function docket(id: string): DocketDetail {
  const base = mapDocket(docketRow(id));
  return { ...base, nodes: mapNodes(rawNodes(id)), claims: claimRows(id), proofs: proofRows(id), checkpoints: checkpointRows(id) };
}

/** Exact, bounded read; a same-project session is not necessarily goal work. */
export function sessionGoal(sessionId: string): SessionGoal | null {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200) throw new Error('A valid session ID is required.');
  const rows = db().prepare('SELECT id, docket_id FROM work_nodes WHERE session_id=? LIMIT 2').all(sessionId) as { id: string; docket_id: string }[];
  // Corrupt or ambiguous ownership must not offer a confident navigation link.
  if (rows.length !== 1) return null;
  const row = rows[0], goal = mapDocket(docketRow(row.docket_id));
  const node = mapNodes(rawNodes(goal.id)).find(item => item.id === row.id)!;
  return { goalId: goal.id, goalTitle: goal.title, goalStatus: goal.status,
    nodeId: node.id, nodeTitle: node.title, nodeKind: node.kind, nodeStatus: node.status };
}

type PlannedNode = { kind: DocketNodeKind; title: string; instructions: string; dependsOn: number[]; claimPath: string | null };

/**
 * Validate a proposed task graph before a single row is written.
 *
 * Three invariants, each here because breaking it produces a goal that looks
 * fine on the board and can never finish:
 *
 *  - **Acyclic.** `mapNodes` derives readiness from stored rows every read, so
 *    a cycle is not a crash — it is four tasks quietly waiting on each other
 *    until a person notices nothing has moved.
 *  - **Exactly one terminal review task, reachable from everything.** A goal
 *    reaches `accepted` through its review node. A graph without one can never
 *    be accepted; a graph whose review node does not depend on some branch
 *    would accept that branch's work without anyone having looked at it.
 *  - **No overlapping claims between tasks that can run at once.** Two nodes
 *    ordered by a dependency hand the path over and may share it safely, so
 *    this compares reachability rather than paths alone. Getting this wrong in
 *    the strict direction would forbid the ordinary implement-then-verify pair
 *    from naming the same directory.
 *
 * The errors name the offending task numbers, because a planner agent reads
 * them and has to be able to fix its own proposal.
 */
function buildPlan(raw: unknown): PlannedNode[] {
  if (!Array.isArray(raw)) throw new Error('A task graph must be an array of tasks.');
  if (!raw.length) throw new Error('A task graph needs at least one task.');
  if (raw.length > MAX_PLAN_NODES) {
    throw new Error(`A goal holds at most ${MAX_PLAN_NODES} tasks; this graph has ${raw.length}. Split the work across goals.`);
  }

  const nodes: PlannedNode[] = raw.map((entry, index) => {
    const value = entry as Partial<DocketPlanNode> | null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Task ${index + 1} is not a task object.`);
    if (!NODE_KINDS.includes(value.kind as DocketNodeKind)) {
      throw new Error(`Task ${index + 1} has kind "${String(value.kind)}"; use one of: ${NODE_KINDS.join(', ')}.`);
    }
    // Read as unknown[] deliberately. The declared type says number[], and the
    // whole job of this function is that what arrived is not yet known to be
    // what it was declared to be.
    const depends: unknown[] = Array.isArray(value.dependsOn) ? value.dependsOn : [];
    if (depends.length > MAX_NODE_DEPENDENCIES) {
      throw new Error(`Task ${index + 1} has ${depends.length} dependencies; the maximum is ${MAX_NODE_DEPENDENCIES}.`);
    }
    // `Number()` alone was too generous to be a validator here: it turns null,
    // false, '' and [] all into 0, so a malformed dependency list did not fail
    // the graph — it silently made every one of those entries a dependency on
    // task 1. Anything that is not already a number or a number written down
    // becomes NaN and is refused by name below.
    const dependsOn = [...new Set(depends.map((dep) => (
      typeof dep === 'number' || (typeof dep === 'string' && dep.trim() !== '') ? Number(dep) : NaN
    )))];
    for (const dep of dependsOn) {
      if (!Number.isInteger(dep) || dep < 0 || dep >= raw.length) {
        throw new Error(`Task ${index + 1} depends on a task that is not in this graph.`);
      }
      if (dep === index) throw new Error(`Task ${index + 1} cannot depend on itself.`);
    }
    // '' is a real value here — the root claim — so an empty string after
    // cleaning must not collapse back to "declared nothing".
    const rawClaim = value.claimPath;
    const claimPath = typeof rawClaim === 'string' && rawClaim.trim() ? cleanClaim(rawClaim) : null;
    return {
      kind: value.kind as DocketNodeKind,
      title: safeText(value.title, `Task ${index + 1} title`, 180),
      instructions: safeText(value.instructions, `Task ${index + 1} instructions`, MAX_INSTRUCTIONS),
      dependsOn, claimPath,
    };
  });

  const ancestors = nodes.map(() => new Set<number>());
  const visiting = new Set<number>();
  const done = new Set<number>();
  const walk = (index: number, trail: number[]): Set<number> => {
    if (visiting.has(index)) {
      const cycle = [...trail.slice(trail.indexOf(index)), index].map((i) => `task ${i + 1}`).join(' → ');
      throw new Error(`This task graph has a cycle (${cycle}); those tasks would wait on each other forever.`);
    }
    if (done.has(index)) return ancestors[index];
    visiting.add(index);
    for (const dep of nodes[index].dependsOn) {
      ancestors[index].add(dep);
      for (const older of walk(dep, [...trail, index])) ancestors[index].add(older);
    }
    visiting.delete(index); done.add(index);
    return ancestors[index];
  };
  for (let index = 0; index < nodes.length; index++) walk(index, []);

  const reviews = nodes.map((node, index) => (node.kind === 'review' ? index : -1)).filter((index) => index >= 0);
  if (reviews.length !== 1) {
    throw new Error(reviews.length === 0
      ? 'A goal needs one review task; the human decision is its final gate.'
      : `A goal needs exactly one review task; this graph has ${reviews.length}.`);
  }
  const terminal = reviews[0];
  const unreviewed = nodes
    .map((_, index) => index)
    .filter((index) => index !== terminal && !ancestors[terminal].has(index));
  if (unreviewed.length) {
    const names = unreviewed.map((index) => `task ${index + 1} ("${nodes[index].title}")`).join(', ');
    throw new Error(`The review task must depend on every other task, directly or through another. ${names} would be accepted without anyone reviewing it.`);
  }

  for (let a = 0; a < nodes.length; a++) {
    const left = nodes[a].claimPath;
    if (left === null) continue;
    for (let b = a + 1; b < nodes.length; b++) {
      const right = nodes[b].claimPath;
      if (right === null) continue;
      if (ancestors[a].has(b) || ancestors[b].has(a)) continue;
      if (overlaps(left, right)) {
        throw new Error(`Task ${a + 1} and task ${b + 1} can run at the same time and both claim "${left || '.'}" and "${right || '.'}". Order them with a dependency, or narrow one of the paths.`);
      }
    }
  }

  return nodes;
}

export function createDocket(input: {
  projectId: string; title: string; objective: string; acceptance?: string[]; risk?: DocketRisk; budgetUsd?: number | null;
  /** A proposed task graph. Omitted or empty keeps the standard four phases. */
  plan?: DocketPlanNode[];
}): DocketDetail {
  const project = projectById(input.projectId);
  if (!project) throw new Error('Choose a project before creating a goal.');
  const title = safeText(input.title, 'Title', 180);
  const objective = safeText(input.objective, 'Objective', MAX_OBJECTIVE);
  const acceptance = (input.acceptance ?? []).filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim()).filter(Boolean).slice(0, 16).map((v) => v.slice(0, 1_000));
  if (!acceptance.length) throw new Error('Add at least one acceptance check. It is the contract the final review must evaluate.');
  const risk = RISKS.includes(input.risk ?? 'elevated') ? input.risk ?? 'elevated' : 'elevated';
  const budgetUsd = input.budgetUsd === null || input.budgetUsd === undefined ? null : Number(input.budgetUsd);
  if (budgetUsd !== null && (!Number.isFinite(budgetUsd) || budgetUsd < 0 || budgetUsd > 100_000)) {
    throw new Error('Budget must be a number between 0 and 100,000 USD.');
  }
  // Validate the whole graph before opening a transaction: a rejected plan
  // must leave no goal behind, and validation is where untrusted planner
  // output is refused.
  const planned = buildPlan(input.plan?.length ? input.plan : DEFAULT_PLAN);
  const id = uid('doc'); const at = now();
  const nodeIds = planned.map(() => uid('node'));
  // Read before the transaction opens. Spawning git inside it holds SQLite's
  // write lock for as long as git takes, and git is the slow, external half.
  const baseCommit = gitHead(project.path);
  const insert = db().transaction(() => {
    db().prepare(`INSERT INTO work_dockets (id, project_id, title, objective, acceptance_json, risk, budget_usd, base_commit, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, project.id, title, objective, JSON.stringify(acceptance), risk, budgetUsd, baseCommit, 'draft', at, at);
    planned.forEach((node, index) => {
      db().prepare(`INSERT INTO work_nodes (id,docket_id,kind,title,instructions,depends_json,status,claim_path)
        VALUES (?,?,?,?,?,?,?,?)`).run(nodeIds[index], id, node.kind, node.title, node.instructions,
          JSON.stringify(node.dependsOn.map((dep) => nodeIds[dep])), 'pending', node.claimPath);
      db().prepare(`INSERT INTO mcp_task_records (id,docket_id,node_id,title,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?)`).run(uid('task'), id, nodeIds[index], node.title, 'input_required', at, at);
    });
  });
  insert();
  return docket(id);
}

function cleanClaim(raw: string): string {
  const value = safeText(raw, 'Claimed path', 1_000).replaceAll('\\', '/');
  if (path.posix.isAbsolute(value) || value.split('/').includes('..')) throw new Error('A claimed path must be relative to its project and cannot escape it.');
  // '.' and './' mean the whole project. Left as literal text they claimed
  // everything while overlapping nothing, so two agents could each hold the
  // entire repository and never see a conflict. Normalized to the root claim.
  const trimmed = value.replace(/^\.\//, '').replace(/\/+$/, '');
  return trimmed === '.' ? '' : trimmed;
}

/** '' is the project root: it contains, and therefore conflicts with, everything. */
function overlaps(a: string, b: string): boolean {
  if (a === '' || b === '') return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function claimPath(nodeId: string, rawPath: string): DocketClaim {
  const node = nodeRow(nodeId); const docketValue = docketRow(node.docket_id); const claimed = cleanClaim(rawPath);
  const live = db().prepare(`SELECT c.path, c.node_id FROM work_claims c
    JOIN work_dockets d ON d.id=c.docket_id WHERE d.project_id=? AND c.released_at IS NULL`).all(docketValue.project_id) as { path: string; node_id: string }[];
  const conflicting = live.find((entry) => entry.node_id !== node.id && overlaps(entry.path, claimed));
  if (conflicting) throw new Error(`"${claimed}" overlaps an active claim on "${conflicting.path}". Finish or release that task before parallel work touches the same area.`);
  const row: DocketClaim = { id: uid('claim'), docketId: node.docket_id, nodeId, path: claimed, createdAt: now(), releasedAt: null };
  db().prepare('INSERT INTO work_claims (id,docket_id,node_id,path,created_at) VALUES (?,?,?,?,?)')
    .run(row.id, row.docketId, row.nodeId, row.path, row.createdAt);
  touch(row.docketId); return row;
}

export function releaseClaim(id: string): boolean {
  const result = db().prepare('UPDATE work_claims SET released_at=? WHERE id=? AND released_at IS NULL').run(now(), id);
  return result.changes > 0;
}

function readyNode(id: string): DocketNode {
  const node = mapNodes(rawNodes(nodeRow(id).docket_id)).find((value) => value.id === id);
  if (!node) throw new Error('Goal task not found.');
  if (node.status !== 'ready') throw new Error(`This task is ${node.status}; complete its prerequisites before starting it.`);
  return node;
}

/**
 * The facts a node's agent cannot otherwise reach, read from the stored rows
 * at the moment of launch. The objective, instructions and acceptance checks
 * already travel in the first prompt; this adds the node's own id (which the
 * MCP checkpoint and claim tools take), its declared claim, its prerequisites
 * and every live claim held by another node in the same project. `canClaimLive`
 * is left false here — sessions.ts sets it from what the launch actually wired.
 */
export function goalCapsuleFor(nodeId: string): GoalCapsule {
  const node = nodeRow(nodeId); const parent = docketRow(node.docket_id);
  const nodes = mapNodes(rawNodes(parent.id));
  const byId = new Map(nodes.map((value) => [value.id, value]));
  const self = byId.get(nodeId);
  if (!self) throw new Error('Goal task not found.');
  // Project-wide, like the overlap check in claimPath(): a claim in another
  // goal of the same project is exactly what a parallel agent must not cross.
  const siblings = db().prepare(`SELECT c.path, c.node_id, n.title FROM work_claims c
    JOIN work_dockets d ON d.id=c.docket_id JOIN work_nodes n ON n.id=c.node_id
    WHERE d.project_id=? AND c.released_at IS NULL AND c.node_id!=? ORDER BY c.created_at`)
    .all(parent.project_id, nodeId) as { path: string; node_id: string; title: string }[];
  // What this task holds right now, not only what its plan declared: a path
  // taken later through Control (or by startNode) lives in work_claims, and a
  // capsule that reported "none declared" while the agent held src/ would be
  // telling it the opposite of the truth. The declared path remains the
  // fallback, so a node that has not started yet still names its intent.
  const held = db().prepare(
    'SELECT path FROM work_claims WHERE node_id=? AND released_at IS NULL ORDER BY created_at LIMIT 1',
  ).get(nodeId) as { path: string } | undefined;
  return {
    docketId: parent.id, docketTitle: parent.title,
    nodeId, nodeTitle: self.title, nodeKind: self.kind, claimPath: held?.path ?? self.claimPath,
    dependsOn: self.dependsOn.map((id) => {
      const dep = byId.get(id);
      return { nodeId: id, title: dep?.title ?? id, status: dep?.status ?? 'pending' };
    }),
    siblingClaims: siblings.map((row) => ({ nodeId: row.node_id, title: row.title, path: row.path })),
    canClaimLive: false,
    recordedAt: now(),
  };
}

export async function startNode(nodeId: string, input: { providerId: string; model?: string; effort?: string; permissionMode?: string }): Promise<DocketNode> {
  const node = readyNode(nodeId); const parent = docketRow(node.docketId);
  const project = projectById(parent.project_id);
  if (!project) throw new Error('This goal’s project no longer exists.');
  const providerId = safeText(input.providerId, 'Provider', 120);
  // Take the declared claim before anything is spawned. A conflict found after
  // the PTY is up has already cost tokens and left an agent editing a
  // directory another node owns; found here it costs one refused click.
  // A reopened node may still hold its own claim, which is not a conflict.
  let takenClaim: DocketClaim | null = null;
  if (node.claimPath !== null) {
    const held = db().prepare('SELECT id FROM work_claims WHERE node_id=? AND path=? AND released_at IS NULL')
      .get(nodeId, node.claimPath) as { id: string } | undefined;
    if (!held) takenClaim = claimPath(nodeId, node.claimPath);
  }
  const acceptance = parseStrings(parent.acceptance_json).map((value, index) => `${index + 1}. ${value}`).join('\n');
  const prompt = [
    `You are working on goal: ${parent.title}.`, `Objective:\n${parent.objective}`,
    `Your assigned phase: ${node.title}.`, `Phase instructions:\n${node.instructions}`,
    `Acceptance checks:\n${acceptance}`,
    node.kind === 'verify' || node.kind === 'review'
      ? 'You are working in the worktree the implementation task produced, so the change under review is already here. Report evidence and unresolved risks; do not claim a passed check you did not run.'
      : 'Work only in the isolated worktree Wanigan provided. Report evidence and unresolved risks; do not claim a passed check you did not run.',
  ].join('\n\n');
  // Built after this node's own claim is taken, so its sibling list is what the
  // agent will actually be running beside.
  const capsule = goalCapsuleFor(nodeId);
  // A verification or review task runs in the tree it is verifying. Cutting it
  // a fresh worktree from the base branch handed the agent a checkout without
  // the implementation in it and then asked it to check the implementation.
  const inheritedTree = (node.kind === 'verify' || node.kind === 'review')
    ? verificationTree(nodeRow(nodeId))
    : { kind: 'none' as const };
  const inherited = inheritedTree.kind === 'found' ? inheritedTree.path : null;
  let session: Awaited<ReturnType<typeof createSession>>;
  try {
    session = await createSession({ providerId, projectId: project.id, model: input.model?.trim() || undefined,
      effort: input.effort?.trim() || undefined, permissionMode: input.permissionMode?.trim() || (node.kind === 'implement' ? 'acceptEdits' : 'plan'),
      isolate: !inherited, initialPrompt: prompt, goalCapsule: capsule },
      inherited ? { useWorktree: inherited } : {});
  } catch (error) {
    if (takenClaim) releaseClaim(takenClaim.id);
    throw error;
  }
  // Readiness was checked before a multi-second await (worktree creation,
  // provider probe, PTY spawn). Two starts can both pass that check, and an
  // unconditional write would leave the loser's agent running, spending
  // tokens, attached to nothing. Claiming the row atomically decides it.
  const claimed = db().prepare(`UPDATE work_nodes SET status='running',provider_id=?,model=?,session_id=?,worktree=?,started_at=?,detail=NULL,dispatch_state=NULL
    WHERE id=? AND session_id IS NULL AND status!='running'`)
    .run(providerId, input.model?.trim() || null, session.id, session.worktree ?? null, now(), nodeId);
  if (claimed.changes === 0) {
    try { killSession(session.id); } catch { /* the duplicate is already gone */ }
    if (takenClaim) releaseClaim(takenClaim.id);
    throw new Error('This task was already started by another action; the duplicate session was stopped.');
  }
  // The durable half of the set `autopilotSpend` sums this goal's cap against.
  // The `work_nodes` column set above is nulled on reopen, and the receipt
  // below is keyed on `node_id` and overwritten by the next dispatch, so a
  // session the task no longer points at has to be recorded here to stay in
  // that sum.
  recordNodeSession(nodeId, parent.id, session.id);
  db().prepare(`INSERT INTO work_resume_receipts
    (node_id,docket_id,session_id,conversation_id,provider_id,model,base_commit,worktree,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(node_id) DO UPDATE SET session_id=excluded.session_id,conversation_id=excluded.conversation_id,
      provider_id=excluded.provider_id,model=excluded.model,base_commit=excluded.base_commit,worktree=excluded.worktree,updated_at=excluded.updated_at`)
    .run(nodeId, parent.id, session.id, session.conversationId, providerId, input.model?.trim() || null,
      parent.base_commit, session.worktree ?? null, now(), now());
  // How the capsule reached the agent is a work-trace fact, recorded once the
  // node row owns the session (recordGoalTrace resolves the node through it).
  // It is not a session briefing: nothing here came from the learning engine.
  const delivery = session.goalCapsule ?? null;
  const delivered = delivery !== null && delivery.channel !== 'none';
  recordGoalTrace({
    sessionId: session.id, source: 'launch', kind: 'goal_capsule',
    status: delivered ? 'recorded' : 'failed', toolName: null,
    summary: delivered
      ? `Goal capsule delivered via ${delivery.channel} at launch — a snapshot, not live: node ${capsule.nodeId}, `
        + `claim ${capsule.claimPath === null ? 'none declared' : capsule.claimPath || '(the whole project)'}, `
        + `${capsule.dependsOn.length} prerequisite(s), ${capsule.siblingClaims.length} sibling claim(s). `
        + (session.harnessId === 'codex'
          ? 'This harness cannot claim or release a path from inside the session.'
          : 'Claims and checkpoints go through Wanigan’s MCP tools.')
      : `Goal capsule not delivered: ${delivery?.reason ?? 'the launch reported no delivery channel.'}`,
    durationMs: null, costUsd: 0, inTokens: 0, outTokens: 0,
  });
  setTaskStatus(nodeId, 'working'); setDocketPhase(node.docketId);
  return mapNodes(rawNodes(node.docketId)).find((value) => value.id === nodeId)!;
}

export function checkpointNode(nodeId: string, rawNote: string): DocketCheckpoint {
  const node = nodeRow(nodeId); const parent = docketRow(node.docket_id); const note = safeText(rawNote, 'Checkpoint note', MAX_NOTE);
  const session = node.session_id ? db().prepare('SELECT conversation_id, worktree FROM session_log WHERE id=?').get(node.session_id) as {
    conversation_id: string | null; worktree: string | null;
  } | undefined : undefined;
  const worktree = node.worktree ?? session?.worktree ?? null;
  const project = projectById(parent.project_id);
  const row: DocketCheckpoint = { id: uid('checkpoint'), docketId: parent.id, nodeId, sessionId: node.session_id,
    conversationId: session?.conversation_id ?? null, repoCommit: gitHead(worktree ?? project?.path ?? ''), worktree, note, createdAt: now() };
  db().prepare(`INSERT INTO work_checkpoints (id,docket_id,node_id,session_id,conversation_id,repo_commit,worktree,note,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(row.id,row.docketId,row.nodeId,row.sessionId,row.conversationId,row.repoCommit,row.worktree,row.note,row.createdAt);
  touch(parent.id); return row;
}

/**
 * MCP receives a per-launch Wanigan session header, not an ambient ability to
 * mutate any Goal. Keep this check in Control rather than the transport so an
 * alternate transport cannot accidentally bypass the ownership rule.
 */
function requireNodeSession(nodeId: string, sessionId: string): void {
  const node = nodeRow(nodeId);
  if (!node.session_id || node.session_id !== sessionId) {
    throw new Error('This Goal task is not owned by the calling Wanigan session. Read its evidence, then ask the owning agent or operator to update it.');
  }
}

export function checkpointForSession(sessionId: string, nodeId: string, note: string): DocketCheckpoint {
  requireNodeSession(nodeId, sessionId);
  return checkpointNode(nodeId, note);
}

export function claimForSession(sessionId: string, nodeId: string, relPath: string): DocketClaim {
  requireNodeSession(nodeId, sessionId);
  return claimPath(nodeId, relPath);
}

/**
 * Refresh a receipt from the durable session row before presenting it. Codex
 * learns a new thread id only after its first prompt, so freezing the null from
 * launch would incorrectly leave an otherwise exact resume looking unsafe.
 */
export function resumeReceipts(docketId: string): GoalResumeReceipt[] {
  const rows = db().prepare(`SELECT r.*, l.conversation_id AS current_conversation_id
    FROM work_resume_receipts r LEFT JOIN session_log l ON l.id=r.session_id
    WHERE r.docket_id=? ORDER BY r.updated_at DESC`).all(docketId) as Array<{
      node_id: string; docket_id: string; session_id: string; conversation_id: string | null; current_conversation_id: string | null;
      provider_id: string; model: string | null; base_commit: string | null; worktree: string | null; created_at: number; updated_at: number;
    }>;
  const live = new Set(listSessions().filter((session) => session.status !== 'exited').map((session) => session.id));
  return rows.map((row) => {
    const conversationId = row.current_conversation_id ?? row.conversation_id;
    if (conversationId && conversationId !== row.conversation_id) {
      db().prepare('UPDATE work_resume_receipts SET conversation_id=?,updated_at=? WHERE node_id=?')
        .run(conversationId, now(), row.node_id);
    }
    const missingWorktree = !!row.worktree && !pathExists(row.worktree);
    const state: GoalResumeReceipt['state'] = live.has(row.session_id) ? 'writer_active'
      : !conversationId ? 'identity_pending' : missingWorktree ? 'worktree_missing' : 'exact';
    const detail = state === 'exact' ? 'Exact conversation identity is saved; no Wanigan writer is active.'
      : state === 'writer_active' ? 'This exact conversation already has an active Wanigan writer.'
        : state === 'identity_pending' ? 'The provider has not yet reported a durable conversation identity.'
          : 'The isolated worktree recorded for this task is no longer present.';
    return { nodeId: row.node_id, docketId: row.docket_id, sessionId: row.session_id, conversationId,
      providerId: row.provider_id, model: row.model, baseCommit: row.base_commit, worktree: row.worktree,
      createdAt: row.created_at, updatedAt: row.updated_at, state, detail };
  });
}

function pathExists(value: string): boolean {
  try { return !!value && fs.existsSync(value); } catch { return false; }
}

export function traces(docketId: string, limit?: number): GoalTraceEvent[] {
  // Ensure callers cannot enumerate a deleted Goal through trace ids.
  docketRow(docketId);
  return listGoalTrace(docketId, limit);
}

/**
 * The tree a verification is about.
 *
 * Every node starts in a worktree of its own, cut from the base branch, and no
 * node merges into another. So a verify node's own worktree contains the plan
 * and none of the implementation, and running the gate there recorded
 * "N review command(s) passed" about a tree that did not hold the change being
 * verified — which `completeNode` then let gate an approval.
 *
 * The tree that matters is the one the implementation was made in: the worktree
 * of the node this one depends on, walking back through the graph.
 *
 * Three answers, because three things are true in practice:
 *  - `found`   an implementation worktree exists and is on disk. Use it.
 *  - `gone`    one was recorded and is no longer there. Refuse: the change
 *              cannot be verified, and verifying the base branch instead would
 *              record a pass for work nobody looked at.
 *  - `none`    no prerequisite ever recorded a worktree, so the work happened
 *              in the project checkout — isolation off, or a goal whose
 *              implementation was completed by hand. Verify the project, and
 *              say in the proof that that is what was verified.
 */
type VerificationTree =
  | { kind: 'found'; path: string; from: NodeRow }
  | { kind: 'gone'; path: string; from: NodeRow }
  | { kind: 'none' };

function verificationTree(node: NodeRow): VerificationTree {
  // A node that ran in its own worktree and is not a verification of something
  // else is its own subject: an implement node re-running its gate is fine.
  if (node.kind !== 'verify' && node.kind !== 'review' && node.worktree) {
    return pathExists(node.worktree)
      ? { kind: 'found', path: node.worktree, from: node }
      : { kind: 'gone', path: node.worktree, from: node };
  }
  const rows = rawNodes(node.docket_id);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const seen = new Set<string>([node.id]);
  const queue = [...parseStrings(node.depends_json)];
  let missing: VerificationTree | null = null;
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const row = byId.get(id);
    if (!row) continue;
    if (row.kind === 'implement' && row.worktree) {
      if (pathExists(row.worktree)) return { kind: 'found', path: row.worktree, from: row };
      // Keep looking: a fan-out can hold more than one implementation, and a
      // live one outranks a vanished one. Remember this for the refusal.
      missing ??= { kind: 'gone', path: row.worktree, from: row };
    }
    queue.push(...parseStrings(row.depends_json));
  }
  return missing ?? { kind: 'none' };
}

export async function runProof(nodeId: string): Promise<DocketProof> {
  const node = nodeRow(nodeId); const parent = docketRow(node.docket_id); const project = projectById(parent.project_id);
  if (!project) throw new Error('Project not found.');
  const tree = verificationTree(node);
  if (tree.kind === 'gone') {
    throw new Error(
      `The worktree “${tree.from.title}” produced is no longer on disk (${tree.path}), so there is `
      + 'nothing here to verify. Running the gate anyway would test the base branch and record a '
      + 'pass for a change it never saw.',
    );
  }
  const cwd = tree.kind === 'found' ? tree.path : project.path;
  const run = await review.runAt(project.id, cwd);
  const passed = run.status === 'passed';
  // Which tree, named by the task that produced it — never by its path.
  //
  // A proof that does not say which working copy it ran in cannot be checked
  // afterwards, which is the whole job here. But `summary` is one of the few
  // fields that crosses to a paired phone (mobile/goals.ts sends it beside the
  // decision buttons), and a worktree path is exactly what that wire is not
  // allowed to carry. The path goes into detail_json, which stays on the Mac.
  const where = tree.kind === 'found'
    ? (tree.from.id === node.id ? '' : ` in the worktree from “${tree.from.title}”`)
    : " in this goal's project checkout";
  const summary = passed
    ? `${run.results.length} review command(s) passed${where}.`
    : `Review gate failed after ${run.results.length} command(s)${where}.`;
  const proof: DocketProof = { id: uid('proof'), docketId: parent.id, nodeId, kind: 'test', status: passed ? 'passed' : 'failed', summary, createdAt: now() };
  db().prepare(`INSERT INTO work_proofs (id,docket_id,node_id,kind,status,summary,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(proof.id, proof.docketId, proof.nodeId, proof.kind, proof.status, proof.summary,
      JSON.stringify({
        // Which working copy the commands actually ran in. Desktop-only: the
        // phone reads `summary`, and this is the field that names a path.
        cwd,
        treeFrom: tree.kind === 'found' ? tree.from.title : null,
        results: run.results.map((result) => ({ command: result.command, exitCode: result.exitCode, durationMs: result.durationMs })),
      }), proof.createdAt);
  touch(parent.id); return proof;
}

/**
 * The LATEST gate run decides. Accepting any historical pass meant a green run
 * from an hour and three commits ago outvoted the red one just recorded — the
 * proof would say "verified" about a tree that had since failed.
 */
function hasPassedProof(docketId: string, nodeId: string): boolean {
  const latest = db().prepare(`SELECT status FROM work_proofs
    WHERE docket_id=? AND node_id=? AND kind='test' ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(docketId, nodeId) as { status: string } | undefined;
  return latest?.status === 'passed';
}

function storeOutcome(node: NodeRow, accepted: boolean, testsPassed: boolean): void {
  if (!node.provider_id) return;
  const usage = node.session_id ? otel.usageFor(node.session_id) : null;
  const model = node.model || usage?.models[0] || 'provider-default';
  // Whether the figure was reported is stored beside it. Writing 0 for an
  // unreported cost and 0 for a genuinely free session made the two
  // indistinguishable one row later, and the router then read the unmetered
  // provider as the cheapest one.
  const reported = usage?.costStatus === 'reported';
  const effort = db().prepare('SELECT effort FROM session_log WHERE id=?')
    .get(node.session_id ?? '') as { effort: string | null } | undefined;
  db().prepare(`INSERT INTO work_model_outcomes (id,docket_id,node_id,provider_id,model,task_kind,accepted,tests_passed,cost_usd,cost_reported,effort,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET accepted=excluded.accepted,tests_passed=excluded.tests_passed,cost_usd=excluded.cost_usd,cost_reported=excluded.cost_reported,effort=excluded.effort`)
    .run(uid('outcome'), node.docket_id, node.id, node.provider_id, model, node.kind, accepted ? 1 : 0, testsPassed ? 1 : 0,
      reported ? usage!.costUsd : 0, reported ? 1 : 0, effort?.effort ?? null, now());
}

export function completeNode(nodeId: string, input: { detail?: string; decision?: 'approve' | 'request_changes' | 'reject' }): DocketNode {
  const node = nodeRow(nodeId); const parent = docketRow(node.docket_id); const current = mapNodes(rawNodes(parent.id)).find((value) => value.id === nodeId)!;
  if (!['running', 'ready'].includes(current.status)) throw new Error(`Only a ready or running task can be completed; this task is ${current.status}.`);
  const detail = input.detail?.trim() ? safeText(input.detail, 'Completion note', MAX_NOTE) : null;
  const decision = input.decision ?? 'approve';
  // A fanned-out goal can hold several verification tasks. Reading only the
  // first would let one green branch speak for a tree whose other branch failed
  // its gate, both in the approval check below and in the evidence stored for
  // the router — so the whole set decides.
  const verifyNodes = node.kind === 'review' ? mapNodes(rawNodes(parent.id)).filter((value) => value.kind === 'verify') : [];
  const testsPassed = node.kind === 'verify' ? hasPassedProof(parent.id, nodeId)
    : node.kind === 'review' ? verifyNodes.length > 0 && verifyNodes.every((value) => hasPassedProof(parent.id, value.id))
      : true;
  if (node.kind === 'verify' && !testsPassed) throw new Error('Run and pass the review gate before completing verification. A claim without command evidence is not proof.');
  if (node.kind === 'review' && decision === 'approve' && !testsPassed) {
    const unproven = verifyNodes.filter((value) => !hasPassedProof(parent.id, value.id));
    throw new Error(verifyNodes.length === 0
      ? 'Approval requires a passed verification proof, and this goal has no verification task.'
      : `Approval requires a passed verification proof for every verification task. Still unproven: ${unproven.map((value) => value.title).join(', ')}.`);
  }
  const failed = decision !== 'approve';
  db().prepare('UPDATE work_nodes SET status=?,ended_at=?,detail=? WHERE id=?')
    .run(failed ? 'failed' : 'completed', now(), detail, nodeId);
  releaseClaims(nodeId); setTaskStatus(nodeId, failed ? (decision === 'reject' ? 'cancelled' : 'failed') : 'completed');
  const proof: DocketProof = { id: uid('proof'), docketId: parent.id, nodeId, kind: node.kind === 'review' ? 'decision' : 'review',
    status: failed ? 'failed' : 'recorded', summary: node.kind === 'review' ? `Human decision: ${decision.replace('_', ' ')}.` : (detail ?? `${node.title} completed.`), createdAt: now() };
  db().prepare('INSERT INTO work_proofs (id,docket_id,node_id,kind,status,summary,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(proof.id, proof.docketId, proof.nodeId, proof.kind, proof.status, proof.summary, proof.createdAt);
  // The final decision is evidence about the work-producing agents, not just
  // about the reviewer. Persist one outcome per launched phase so the router
  // can compare implementation, verification and review models separately.
  if (node.kind === 'review') {
    for (const candidate of rawNodes(parent.id)) {
      if (candidate.provider_id) storeOutcome(candidate, decision === 'approve', testsPassed);
    }
  }
  // No interim row for plan/verify. It was written as accepted=0 expecting the
  // review pass above to overwrite it — but a goal that is abandoned before
  // review never reaches that loop, leaving those phases permanently recorded
  // as rejected work. An unreviewed phase has no verdict, and no verdict is
  // not a rejection; the router is better served by silence than by a guess.
  if (node.kind === 'review' && decision === 'reject') db().prepare("UPDATE work_dockets SET status='rejected',updated_at=? WHERE id=?").run(now(), parent.id);
  else setDocketPhase(parent.id);
  return mapNodes(rawNodes(parent.id)).find((value) => value.id === nodeId)!;
}

/**
 * What each provider and model has actually produced, per task kind.
 *
 * Two rules this query is built around. Money: only rows whose CLI reported a
 * cost are totalled, and the count of those rows travels with the total, so a
 * profile that reports nothing reads as "not reported" rather than as free.
 * Order: by acceptance *rate*, not by raw accepted count, which ranked whichever
 * profile happened to run most; a single sample is still shown and still says
 * it is one sample, and the renderer is the place that decides how much weight
 * one sample earns.
 */
/* ── the board ───────────────────────────────────────────────────────── */

/**
 * Every ticket in the app, flattened across goals, with enough context to be
 * read on a card.
 *
 * A goal is a contract with a task graph, and the Control view is the right
 * place to read one goal that way. It is the wrong place to answer the question
 * an operator actually has most mornings — "what is outstanding across
 * everything, and what am I doing about it today" — because that question spans
 * goals and projects, and the answer to it is a board rather than a graph.
 *
 * So this is a second reading of the same rows, not a second store. There is no
 * ticket table: a card *is* a work_node, its column *is* the status derived in
 * mapNodes, and moving one is the same call the Control view makes. Two tables
 * that both claimed to hold the tickets would disagree within a week, and the
 * one the operator was looking at would be the wrong one.
 */
export function boardCards(input: { projectId?: string | null; limit?: number } = {}): BoardCard[] {
  const limit = Math.max(1, Math.min(1_000, input.limit ?? 500));
  // The window is chosen in goals and only then read in rows, and that order is
  // the load-bearing part. `LIMIT` on the joined rows cuts wherever the count
  // runs out, which is the middle of a goal, and it cuts a goal's *tail* —
  // rows come back in plan order, so what falls off is the end of the graph.
  // The review task is the last node of every plan buildPlan will accept, so
  // the tickets a row limit silently drops are precisely the ones waiting on a
  // person, from a board whose whole claim is "every ticket across every goal".
  //
  // The partial group is also wrong on its own terms: mapNodes() derives
  // 'ready' from the completed rows *it was handed*, so a prerequisite on the
  // far side of the cut reads as unfinished and its ticket renders in Blocked —
  // the column this board reserves for work stopped on a failure. Backward
  // dependencies keep the built-in plans out of that, since a prefix carries
  // its own prerequisites, but buildPlan permits a forward one and a
  // hand-edited graph can have it. Whole goals in, or none of it.
  //
  // The window is a subquery rather than a list of ids read out and sent back:
  // a thousand-goal window is a thousand bound parameters, and SQLite has a
  // ceiling on those that this would sit right underneath.
  const rows = (input.projectId
    ? db().prepare(`SELECT n.*, d.title AS docket_title, d.project_id, d.risk, d.status AS docket_status
        FROM work_nodes n JOIN work_dockets d ON d.id = n.docket_id
        WHERE n.docket_id IN (
          SELECT id FROM work_dockets WHERE project_id = ? ORDER BY updated_at DESC, rowid LIMIT ?)
        ORDER BY d.updated_at DESC, d.rowid, n.rowid`).all(input.projectId, limit)
    : db().prepare(`SELECT n.*, d.title AS docket_title, d.project_id, d.risk, d.status AS docket_status
        FROM work_nodes n JOIN work_dockets d ON d.id = n.docket_id
        WHERE n.docket_id IN (
          SELECT id FROM work_dockets ORDER BY updated_at DESC, rowid LIMIT ?)
        ORDER BY d.updated_at DESC, d.rowid, n.rowid`).all(limit)) as (NodeRow & {
    docket_title: string; project_id: string; risk: string; docket_status: string;
  })[];

  // Status is derived per goal, not per row: 'ready' means every prerequisite
  // inside *that* goal completed, so the rows have to be grouped before they
  // can be mapped. Doing it row by row would mark every pending ticket blocked.
  const byDocket = new Map<string, (typeof rows)>();
  for (const row of rows) {
    const list = byDocket.get(row.docket_id) ?? [];
    list.push(row);
    byDocket.set(row.docket_id, list);
  }

  const projects = new Map(listProjects().map((project) => [project.id, project.name] as const));
  const cards: BoardCard[] = [];
  for (const [docketId, group] of byDocket) {
    // Counted between goals rather than inside one. A goal that straddles the
    // ceiling is taken whole — at most MAX_DOCKET_PLAN_NODES over — because the
    // alternative is the partial group this function exists to avoid.
    if (cards.length >= limit) break;
    const mapped = mapNodes(group);
    mapped.forEach((node, index) => {
      const row = group[index];
      cards.push({
        node,
        docketId,
        docketTitle: row.docket_title,
        projectId: row.project_id,
        projectName: projects.get(row.project_id) ?? 'Unknown project',
        risk: (RISKS as string[]).includes(row.risk) ? row.risk as DocketRisk : 'elevated',
      });
    });
  }
  return cards;
}

/**
 * Park a ticket until a date, or un-park it.
 *
 * Only a ticket that has not started. Deferring something already running would
 * either be a lie — the agent is still going — or a kill dressed up as a
 * calendar entry, and the operator has a Stop for that.
 */
export function deferNode(nodeId: string, until: number | null): DocketNode {
  const node = nodeRow(nodeId);
  if (['running', 'completed'].includes(node.status)) {
    throw new Error(`A ${node.status} task cannot be parked. Complete or stop it first.`);
  }
  if (until !== null) {
    if (!Number.isFinite(until)) throw new Error('A parked date must be a timestamp.');
    if (until <= Date.now()) throw new Error('Park a task for a future date; a past one would already be due.');
    // Two years. Past that it is not a plan, it is a way of deleting something
    // without admitting to it — and a board that quietly hides work forever is
    // the failure mode this column exists to prevent.
    if (until > Date.now() + 730 * 24 * 60 * 60_000) throw new Error('Park a task no more than two years out.');
  }
  db().prepare('UPDATE work_nodes SET defer_until=? WHERE id=?').run(until, nodeId);
  touch(node.docket_id);
  const found = mapNodes(rawNodes(node.docket_id)).find((row) => row.id === nodeId);
  if (!found) throw new Error('Task not found after parking it.');
  return found;
}

export function outcomes(projectId?: string | null): ModelOutcome[] {
  const where = projectId ? 'WHERE d.project_id=?' : '';
  const rows = db().prepare(`SELECT o.provider_id,o.model,o.task_kind,COUNT(*) samples,SUM(o.accepted) accepted,SUM(o.tests_passed) tests_passed,
      SUM(CASE WHEN o.cost_reported=1 THEN o.cost_usd ELSE 0 END) total_cost_usd,
      SUM(CASE WHEN o.cost_reported=1 THEN 1 ELSE 0 END) reported_samples
    FROM work_model_outcomes o JOIN work_dockets d ON d.id=o.docket_id ${where}
    GROUP BY o.provider_id,o.model,o.task_kind
    ORDER BY (CAST(SUM(o.accepted) AS REAL)/COUNT(*)) DESC,samples DESC,tests_passed DESC`).all(...(projectId ? [projectId] : [])) as Array<{
      provider_id: string; model: string; task_kind: DocketNodeKind; samples: number; accepted: number; tests_passed: number;
      total_cost_usd: number; reported_samples: number;
    }>;
  return rows.map((row) => ({ providerId: row.provider_id, model: row.model, taskKind: row.task_kind, samples: row.samples,
    accepted: row.accepted, testsPassed: row.tests_passed, totalCostUsd: row.total_cost_usd,
    reportedSamples: row.reported_samples,
    acceptedRate: row.samples ? row.accepted / row.samples : null, testPassRate: row.samples ? row.tests_passed / row.samples : null }));
}

export function listEvents(status: ControlEvent['status'] | 'all' = 'all', limit = 80): ControlEvent[] {
  const rows = status === 'all'
    ? db().prepare('SELECT * FROM control_events ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(200, limit)))
    : db().prepare('SELECT * FROM control_events WHERE status=? ORDER BY created_at DESC LIMIT ?').all(status, Math.max(1, Math.min(200, limit)));
  return (rows as Array<{ id: string; project_id: string | null; source: string; kind: string; summary: string; status: ControlEvent['status']; docket_id: string | null; created_at: number }>).map((row) => ({
    id: row.id, projectId: row.project_id, source: row.source, kind: row.kind, summary: row.summary, status: row.status, docketId: row.docket_id, createdAt: row.created_at,
  }));
}

/** Event ingress is deliberately local/IPC-only in this phase. Remote webhook
 * receivers need an identity and replay-threat model, not a hidden HTTP port. */
export function addEvent(input: { projectId?: string | null; source: string; kind: string; summary: string }): ControlEvent {
  if (input.projectId && !projectById(input.projectId)) throw new Error('Event project not found.');
  const row: ControlEvent = { id: uid('event'), projectId: input.projectId ?? null, source: safeText(input.source, 'Event source', 100),
    kind: safeText(input.kind, 'Event kind', 100), summary: safeText(input.summary, 'Event summary', 2_000), status: 'new', docketId: null, createdAt: now() };
  db().prepare('INSERT INTO control_events (id,project_id,source,kind,summary,status,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(row.id,row.projectId,row.source,row.kind,row.summary,row.status,row.createdAt);
  return row;
}

export function triageEvent(eventId: string, input: { title?: string; acceptance?: string[]; risk?: DocketRisk }): DocketDetail {
  const event = db().prepare('SELECT * FROM control_events WHERE id=?').get(eventId) as { project_id: string | null; summary: string; status: string } | undefined;
  if (!event) throw new Error('Event not found.');
  if (!event.project_id) throw new Error('Assign this event to a project before creating work.');
  if (event.status !== 'new') throw new Error('This event has already been triaged or dismissed.');
  // Claim the event BEFORE the goal exists. createDocket commits its own
  // transaction, so creating first and marking after leaves a window where a
  // crash — or a second click — produces a duplicate goal for one event.
  // Claiming first can at worst leave a triaged event with no goal, which is
  // visible and harmless next to duplicated work.
  const claimed = db().prepare("UPDATE control_events SET status='triaged' WHERE id=? AND status='new'").run(eventId);
  if (claimed.changes === 0) throw new Error('This event has already been triaged or dismissed.');
  let created: DocketDetail;
  try {
    created = createDocket({ projectId: event.project_id, title: input.title?.trim() || `Triage: ${event.summary.slice(0, 120)}`,
      objective: event.summary, acceptance: input.acceptance?.length ? input.acceptance : ['Identify the root cause or rule out the alert.', 'Record evidence and a human review decision.'], risk: input.risk ?? 'elevated' });
  } catch (error) {
    db().prepare("UPDATE control_events SET status='new' WHERE id=? AND status='triaged'").run(eventId);
    throw error;
  }
  db().prepare('UPDATE control_events SET docket_id=? WHERE id=?').run(created.id, eventId);
  return created;
}

export function dismissEvent(eventId: string): boolean {
  return db().prepare("UPDATE control_events SET status='dismissed' WHERE id=? AND status='new'").run(eventId).changes > 0;
}

export function mcpTasks(docketId?: string): McpTaskRecord[] {
  const rows = docketId
    ? db().prepare('SELECT * FROM mcp_task_records WHERE docket_id=? ORDER BY updated_at DESC').all(docketId)
    : db().prepare('SELECT * FROM mcp_task_records ORDER BY updated_at DESC LIMIT 200').all();
  return (rows as Array<{ id: string; docket_id: string; node_id: string; title: string; status: McpTaskRecord['status']; created_at: number; updated_at: number }>).map((row) => ({
    id: row.id, docketId: row.docket_id, nodeId: row.node_id, title: row.title, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
  }));
}

/**
 * Cancel one MCP task record, and report what that actually changed.
 *
 * There are four ways out of this function and a boolean told them apart from
 * nothing: an id that names no record, a record that had already closed, a
 * record marked cancelled over work that had already ended, and work really
 * stopped mid-run with its claims released. Control announced one sentence for
 * all four, so three of them were a guess dressed as a report. Each branch now
 * names itself, and the counts beside it are the rows this call moved.
 *
 * `sessionStopped` is read before the kill and never inferred from the stored
 * status. killSession is a silent no-op for a session this process no longer
 * holds — after a restart, or once the agent has exited — so a row still
 * reading 'running' is not evidence that anything was stopped.
 */
export function cancelMcpTask(taskId: string): McpTaskCancelReceipt {
  const task = db().prepare('SELECT node_id,docket_id,status FROM mcp_task_records WHERE id=?').get(taskId) as { node_id: string; docket_id: string; status: McpTaskRecord['status'] } | undefined;
  if (!task) return { outcome: 'not_found', recordStatus: null, nodeStatus: null, sessionStopped: false, claimsReleased: 0 };
  if (['completed', 'failed', 'cancelled'].includes(task.status)) {
    return { outcome: 'already_closed', recordStatus: task.status, nodeStatus: null, sessionStopped: false, claimsReleased: 0 };
  }
  db().prepare("UPDATE mcp_task_records SET status='cancelled',updated_at=? WHERE id=?").run(now(), taskId);
  const node = nodeRow(task.node_id);
  const nodeStatus = node.status as McpTaskCancelReceipt['nodeStatus'];
  if (!['pending', 'running'].includes(node.status)) {
    return { outcome: 'record_only', recordStatus: task.status, nodeStatus, sessionStopped: false, claimsReleased: 0 };
  }
  db().prepare("UPDATE work_nodes SET status='canceled',ended_at=? WHERE id=?").run(now(), node.id);
  // Cancelling the record while the agent keeps working is the worst of both:
  // its claims are released for someone else to take, and it goes on editing
  // the same worktree and spending tokens against a task nobody is watching.
  //
  // Observed before the kill, because after it there is nothing left to see:
  // a session already gone and a session this process never held look the same
  // to killSession, and both are worth telling the operator apart from a stop.
  const sessionStopped = node.session_id !== null
    && listSessions().some((session) => session.id === node.session_id && session.status !== 'exited');
  if (node.session_id) {
    try { killSession(node.session_id); } catch { /* already exited */ }
  }
  const claimsReleased = releaseClaims(node.id);
  setDocketPhase(task.docket_id);
  return { outcome: 'task_canceled', recordStatus: task.status, nodeStatus, sessionStopped, claimsReleased };
}

/**
 * Reopen a failed or canceled task so its goal can move again.
 *
 * Without this every non-approve decision was terminal: the node stayed
 * 'failed', mapNodes marked its dependents 'blocked', and the goal sat
 * 'blocked' forever with no action anywhere that could revive it — a review
 * asking for changes bricked the work it was reviewing.
 */
export function retryNode(nodeId: string): DocketNode {
  const node = nodeRow(nodeId);
  if (!['failed', 'canceled'].includes(node.status)) {
    throw new Error(`Only a failed or canceled task can be reopened; this task is ${node.status}.`);
  }
  if (node.session_id) {
    // Recorded before the statement below drops the pointer. Dispatch already
    // wrote this pair for anything started since work_node_sessions existed;
    // this call is what covers a task dispatched before it did.
    recordNodeSession(nodeId, node.docket_id, node.session_id);
    try { killSession(node.session_id); } catch { /* already exited */ }
  }
  db().prepare(`UPDATE work_nodes SET status='pending',session_id=NULL,started_at=NULL,ended_at=NULL,
    dispatch_state=NULL,detail=? WHERE id=?`).run(`Reopened after ${node.status}.`, nodeId);
  releaseClaims(nodeId);
  // The MCP task vocabulary has no 'pending': a reopened task is one waiting
  // to be started again, which is exactly what input_required means here.
  setTaskStatus(nodeId, 'input_required');
  setDocketPhase(node.docket_id);
  return mapNodes(rawNodes(node.docket_id)).find((value) => value.id === nodeId)!;
}

/* ── autopilot ───────────────────────────────────────────────────────── */

function clearDispatch(nodeId: string): void {
  db().prepare("UPDATE work_nodes SET dispatch_state=NULL WHERE id=? AND dispatch_state='queued'").run(nodeId);
}

/**
 * Stop dispatching this goal and say why, in its own evidence.
 *
 * A halt that only flips a flag leaves the operator looking at a stalled board
 * with no account of what happened, so the reason is written where the rest of
 * the goal's history already lives.
 */
function haltAutopilot(docketId: string, reason: string): void {
  db().prepare('UPDATE work_dockets SET autopilot=0,updated_at=? WHERE id=? AND autopilot=1').run(now(), docketId);
  db().prepare('INSERT INTO work_proofs (id,docket_id,node_id,kind,status,summary,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(uid('proof'), docketId, null, 'decision', 'recorded', `${AUTOPILOT_HALT_PREFIX}${reason}`, now());
}

/**
 * Turn unattended dispatch on or off for one goal.
 *
 * A budget is a precondition rather than an option. Autopilot starts real
 * sessions against a real provider with nobody at the keyboard, and the house
 * rule is that Wanigan does not silently spend tokens — an uncapped unattended
 * run is exactly that. The provider and model are frozen here so a later
 * change to the operator's default cannot redirect work already in flight.
 */
export function setAutopilot(docketId: string, input: { enabled: boolean; providerId?: string; model?: string | null }): DocketDetail {
  const row = docketRow(docketId);
  if (!input.enabled) {
    // Rows already handed to the queue are left alone: cancelling them here
    // would race a runner that may already be mid-launch. They check the flag
    // again before they start, which is the point that can safely refuse.
    db().prepare('UPDATE work_dockets SET autopilot=0,updated_at=? WHERE id=?').run(now(), docketId);
    return docket(docketId);
  }
  if (['accepted', 'rejected'].includes(row.status)) throw new Error('This goal is finished; autopilot has nothing left to dispatch.');
  if (row.budget_usd === null) {
    throw new Error('Set a budget on this goal before enabling autopilot. Unattended dispatch spends against a real provider with nobody watching, and Wanigan will not start an uncapped run.');
  }
  const providerId = safeText(input.providerId, 'Provider', 120);
  const model = input.model?.trim() || null;
  db().prepare('UPDATE work_dockets SET autopilot=1,autopilot_provider=?,autopilot_model=?,updated_at=? WHERE id=?')
    .run(providerId, model, now(), docketId);
  return docket(docketId);
}

/**
 * Give an existing goal a spend cap, or take one away.
 *
 * Without this a goal created without a budget could never arm autopilot at
 * all: `setAutopilot` requires a cap and nothing else could set one after the
 * insert, so the refusal above was unrecoverable rather than actionable.
 *
 * Removing a cap while autopilot is armed is refused instead of quietly
 * disarming for the operator. Disarming on their behalf would be a second,
 * unasked-for change to what the machine is doing, and the sweep would
 * otherwise find `budget_usd` null on its next tick and halt the run somewhere
 * the operator was not looking. Making them disarm first keeps the two
 * decisions — stop dispatching, change the cap — separately made and separately
 * visible. The bounds match createDocket's, because the same value read back
 * from a different screen has to mean the same thing.
 */
/**
 * Disarm every armed autopilot at once, and report how many.
 *
 * The halt's stop pass calls this. It disarms rather than pausing, and that is
 * deliberate: a pause implies Wanigan will resume the dispatch by itself when
 * the halt lifts, and resuming unattended work because somebody decided a
 * separate emergency was over is not a decision this app gets to make. The
 * count is what the halt panel shows, so the operator knows exactly how many
 * goals need arming again and can go and look at them.
 */
export function disarmAllAutopilots(): number {
  const changed = db().prepare('UPDATE work_dockets SET autopilot=0, updated_at=? WHERE autopilot=1')
    .run(now()).changes;
  return typeof changed === 'number' ? changed : 0;
}

export function setDocketBudget(docketId: string, budgetUsd: number | null): DocketDetail {
  const row = docketRow(docketId);
  // The declared type is not a guarantee: this arrives from the renderer, where
  // `Number([])` is 0 and would quietly install a zero-dollar cap. Anything
  // that is not already a number falls through to the range refusal below.
  const value = budgetUsd === null || budgetUsd === undefined ? null
    : typeof budgetUsd === 'number' ? budgetUsd : Number.NaN;
  if (value === null && row.autopilot === 1) {
    throw new Error('Disarm autopilot before removing this goal’s budget. An armed goal with no cap is the one thing Wanigan will not run.');
  }
  if (value !== null && (!Number.isFinite(value) || value < 0 || value > 100_000)) {
    throw new Error('Budget must be a number between 0 and 100,000 USD.');
  }
  db().prepare('UPDATE work_dockets SET budget_usd=?,updated_at=? WHERE id=?').run(value, now(), docketId);
  return docket(docketId);
}

/**
 * Hand every eligible ready task to the dispatcher. Called on a timer.
 *
 * This does not start anything itself. It writes queue rows, and the existing
 * dispatcher applies the slot limit, the durable claim and the lease — so an
 * autopilot task is recovered after a crash by exactly the same machinery that
 * recovers a headless run, and a second Wanigan process cannot double-start it.
 *
 * Two tasks are never dispatched. A `review` task is the human decision, and an
 * agent sent to it would let the goal approve its own work — the gate this
 * whole module exists to hold. And a goal whose reported spend has reached
 * its budget stops, rather than continuing on the strength of costs nobody
 * reported.
 */
export function sweepAutopilot(): number {
  // Left armed, not disarmed. The halt's own stop pass disarms autopilots and
  // records how many, so an operator can see what it turned off and decide
  // whether to arm them again; a sweep that quietly disarmed them on every tick
  // would make that record a lie about what the halt did.
  if (halted()) return 0;
  const dockets = db().prepare("SELECT * FROM work_dockets WHERE autopilot=1 AND status NOT IN ('accepted','rejected')")
    .all() as DocketRow[];
  let queued = 0;
  for (const row of dockets) {
    if (!row.autopilot_provider) {
      haltAutopilot(row.id, 'no provider is recorded for unattended dispatch.');
      continue;
    }
    if (row.budget_usd === null) {
      haltAutopilot(row.id, 'the goal no longer has a budget.');
      continue;
    }
    const spend = autopilotSpend(row.id);
    if (spend.spendUsd >= row.budget_usd) {
      haltAutopilot(row.id, `reported spend of $${spend.spendUsd.toFixed(2)} reached the $${row.budget_usd.toFixed(2)} budget.`);
      continue;
    }
    for (const node of mapNodes(rawNodes(row.id))) {
      if (node.status !== 'ready' || node.kind === 'review') continue;
      // The marker is claimed in the same statement that tests it, so two
      // ticks — or two processes on this database — cannot both enqueue it.
      const claimed = db().prepare(`UPDATE work_nodes SET dispatch_state='queued'
        WHERE id=? AND dispatch_state IS NULL AND status='pending' AND session_id IS NULL`).run(node.id);
      if (claimed.changes !== 1) continue;
      try {
        enqueue('node', `${row.title} · ${node.title}`, { nodeId: node.id });
        queued++;
      } catch (error) {
        clearDispatch(node.id);
        throw error;
      }
    }
  }
  return queued;
}

/**
 * Run one queued autopilot task.
 *
 * Everything about the goal can have changed between the sweep and the
 * dispatcher reaching this row: autopilot turned off, the task cancelled, a
 * prerequisite reopened. Each of those returns quietly rather than throwing,
 * because a throw here is retried five times with backoff against a task that
 * is no longer eligible, and five refusals are not more informative than one.
 * The task's own row in Control remains the record of what actually happened.
 */
export async function startQueuedNode(nodeId: string): Promise<void> {
  const node = nodeRow(nodeId);
  const parent = docketRow(node.docket_id);
  const mapped = mapNodes(rawNodes(node.docket_id)).find((value) => value.id === nodeId);
  if (parent.autopilot !== 1 || !parent.autopilot_provider || !mapped || mapped.status !== 'ready' || mapped.kind === 'review') {
    clearDispatch(nodeId);
    return;
  }
  try {
    await startNode(nodeId, { providerId: parent.autopilot_provider, model: parent.autopilot_model ?? undefined });
  } catch (error) {
    // A real launch failure — no provider, a taken claim, a dead worktree —
    // releases the marker so a later sweep can try again once it is fixed.
    clearDispatch(nodeId);
    throw error;
  }
}

/**
 * A live PTY cannot survive a quit, so a node left 'running' by a crash or a
 * shutdown describes an agent that no longer exists. Called at startup: the
 * row is reopened rather than silently believed, because a task that claims to
 * be running holds claims nobody can release.
 */
export function reconcileRunningNodes(): number {
  const running = db().prepare("SELECT id,session_id FROM work_nodes WHERE status='running'")
    .all() as { id: string; session_id: string | null }[];
  if (!running.length) return 0;
  const live = new Set(listSessions().map((session) => session.id));
  let reopened = 0;
  for (const node of running) {
    if (node.session_id && live.has(node.session_id)) continue;
    if (failRunningNode(node.id)) reopened++;
  }
  if (reopened) {
    for (const id of new Set(running.map((node) => nodeRow(node.id).docket_id))) {
      try { setDocketPhase(id); } catch { /* the goal may have been removed */ }
    }
  }
  return reopened;
}

/** One node, moved out of 'running' with its claims released. */
function failRunningNode(nodeId: string): boolean {
  const changed = db().prepare(`UPDATE work_nodes SET status='failed',ended_at=?,dispatch_state=NULL,detail=? WHERE id=? AND status='running'`)
    .run(now(), 'The session running this task ended before it was completed. Reopen it to continue.', nodeId);
  if (changed.changes === 0) return false;
  releaseClaims(nodeId);
  return true;
}

/**
 * A session ended; the task it was running is no longer running.
 *
 * This used to be reconciled at start-up only, so a task whose agent finished
 * or crashed kept reading 'running' — offering "Mark complete" and holding its
 * file claims against every sibling in the project — until Wanigan was
 * restarted, while the Safe recovery row for the same task said on the same
 * screen that no writer was active. Two statuses for one task is the defect;
 * the exit is the fact, so it is applied when the exit happens.
 *
 * Returns the docket id when something changed, so the caller can tell the
 * renderer which goal to re-read.
 */
export function onSessionExit(sessionId: string): string | null {
  const row = db().prepare("SELECT id,docket_id FROM work_nodes WHERE session_id=? AND status='running'")
    .get(sessionId) as { id: string; docket_id: string } | undefined;
  if (!row) return null;
  if (!failRunningNode(row.id)) return null;
  try { setDocketPhase(row.docket_id); } catch { /* the goal may have been removed */ }
  return row.docket_id;
}
