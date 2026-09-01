import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { db } from './db';
import { headSync } from './git';
import { projectById } from './store';
import { createSession, killSession, listSessions } from './sessions';
import * as review from './review';
import * as otel from './otel';
import { listGoalTrace } from './goal-trace';
import type {
  ControlEvent, DocketCheckpoint, DocketClaim, DocketDetail, DocketNode,
  DocketNodeKind, DocketNodeStatus, DocketProof, DocketRisk, DocketStatus, GoalResumeReceipt, GoalTraceEvent,
  McpTaskRecord, ModelOutcome, WorkDocket,
} from '../shared/types';

type DocketRow = {
  id: string; project_id: string; title: string; objective: string; acceptance_json: string;
  risk: string; budget_usd: number | null; base_commit: string | null; status: string;
  created_at: number; updated_at: number;
};
type NodeRow = {
  id: string; docket_id: string; kind: string; title: string; instructions: string; depends_json: string;
  status: string; provider_id: string | null; model: string | null; session_id: string | null;
  worktree: string | null; started_at: number | null; ended_at: number | null; detail: string | null;
};

const MAX_OBJECTIVE = 12_000;
const MAX_NOTE = 4_000;
const NODE_KINDS: DocketNodeKind[] = ['plan', 'implement', 'verify', 'review'];
const RISKS: DocketRisk[] = ['low', 'elevated', 'high'];

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
 * The commit a docket or checkpoint was recorded against.
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
  };
}

function rawNodes(docketId: string): NodeRow[] {
  return db().prepare('SELECT * FROM work_nodes WHERE docket_id=? ORDER BY rowid').all(docketId) as NodeRow[];
}

/** Dependencies are computed from durable rows each read; an app restart cannot
 * leave a transient "ready" cache lying about a task whose prerequisite failed. */
function mapNodes(rows: NodeRow[]): DocketNode[] {
  const complete = new Set(rows.filter((row) => row.status === 'completed').map((row) => row.id));
  const failed = new Set(rows.filter((row) => ['failed', 'canceled'].includes(row.status)).map((row) => row.id));
  return rows.map((row) => {
    const dependsOn = parseStrings(row.depends_json);
    let status = row.status as DocketNodeStatus;
    if (status === 'pending') {
      status = dependsOn.some((id) => failed.has(id)) ? 'blocked'
        : dependsOn.every((id) => complete.has(id)) ? 'ready' : 'blocked';
    }
    return {
      id: row.id, docketId: row.docket_id, kind: NODE_KINDS.includes(row.kind as DocketNodeKind)
        ? row.kind as DocketNodeKind : 'implement',
      title: row.title, instructions: row.instructions, dependsOn, status,
      providerId: row.provider_id, model: row.model, sessionId: row.session_id,
      worktree: row.worktree, startedAt: row.started_at, endedAt: row.ended_at, detail: row.detail,
    };
  });
}

function docketRow(id: string): DocketRow {
  const row = db().prepare('SELECT * FROM work_dockets WHERE id=?').get(id) as DocketRow | undefined;
  if (!row) throw new Error('Docket not found.');
  return row;
}

function nodeRow(id: string): NodeRow {
  const row = db().prepare('SELECT * FROM work_nodes WHERE id=?').get(id) as NodeRow | undefined;
  if (!row) throw new Error('Docket task not found.');
  return row;
}

function touch(docketId: string): void {
  db().prepare('UPDATE work_dockets SET updated_at=? WHERE id=?').run(now(), docketId);
}

function setTaskStatus(nodeId: string, status: McpTaskRecord['status']): void {
  db().prepare('UPDATE mcp_task_records SET status=?, updated_at=? WHERE node_id=?').run(status, now(), nodeId);
}

function releaseClaims(nodeId: string): void {
  db().prepare('UPDATE work_claims SET released_at=? WHERE node_id=? AND released_at IS NULL').run(now(), nodeId);
}

function setDocketPhase(docketId: string): void {
  const raw = rawNodes(docketId);
  const nodes = mapNodes(raw);
  const row = docketRow(docketId);
  let status: DocketStatus = row.status as DocketStatus;
  // `blocked` in the presentation map also means an ordinary unmet dependency.
  // Only a stored failure/cancellation blocks the whole docket.
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

export function createDocket(input: {
  projectId: string; title: string; objective: string; acceptance?: string[]; risk?: DocketRisk; budgetUsd?: number | null;
}): DocketDetail {
  const project = projectById(input.projectId);
  if (!project) throw new Error('Choose a project before creating a docket.');
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
  const id = uid('doc'); const at = now();
  const plan = uid('node'); const implement = uid('node'); const verify = uid('node'); const reviewer = uid('node');
  // Read before the transaction opens. Spawning git inside it holds SQLite's
  // write lock for as long as git takes, and git is the slow, external half.
  const baseCommit = gitHead(project.path);
  const insert = db().transaction(() => {
    db().prepare(`INSERT INTO work_dockets (id, project_id, title, objective, acceptance_json, risk, budget_usd, base_commit, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, project.id, title, objective, JSON.stringify(acceptance), risk, budgetUsd, baseCommit, 'draft', at, at);
    const add = (nodeId: string, kind: DocketNodeKind, nodeTitle: string, instructions: string, depends: string[]) => {
      db().prepare(`INSERT INTO work_nodes (id,docket_id,kind,title,instructions,depends_json,status)
        VALUES (?,?,?,?,?,?,?)`).run(nodeId, id, kind, nodeTitle, instructions, JSON.stringify(depends), 'pending');
      db().prepare(`INSERT INTO mcp_task_records (id,docket_id,node_id,title,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?)`).run(uid('task'), id, nodeId, nodeTitle, 'input_required', at, at);
    };
    add(plan, 'plan', 'Plan and identify risks', 'Produce an implementation plan, identify affected areas, unknowns, and evidence needed for acceptance. Do not make changes until the plan is accepted.', []);
    add(implement, 'implement', 'Implement in an isolated worktree', 'Make the smallest changes that satisfy the accepted plan and the docket acceptance checks. Keep the worktree reviewable and report intentional trade-offs.', [plan]);
    add(verify, 'verify', 'Verify the change', 'Run the project review gate and targeted checks in the implementation worktree. Record failures as evidence; do not claim success without command results.', [implement]);
    add(reviewer, 'review', 'Independent review and decision', 'Review the diff, the acceptance checks, and the recorded evidence. Approve only with a passed verification proof; otherwise request changes or reject.', [verify]);
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
  if (!node) throw new Error('Docket task not found.');
  if (node.status !== 'ready') throw new Error(`This task is ${node.status}; complete its prerequisites before starting it.`);
  return node;
}

export async function startNode(nodeId: string, input: { providerId: string; model?: string; effort?: string; permissionMode?: string }): Promise<DocketNode> {
  const node = readyNode(nodeId); const parent = docketRow(node.docketId);
  const project = projectById(parent.project_id);
  if (!project) throw new Error('This docket’s project no longer exists.');
  const providerId = safeText(input.providerId, 'Provider', 120);
  const acceptance = parseStrings(parent.acceptance_json).map((value, index) => `${index + 1}. ${value}`).join('\n');
  const prompt = [
    `You are working on docket: ${parent.title}.`, `Objective:\n${parent.objective}`,
    `Your assigned phase: ${node.title}.`, `Phase instructions:\n${node.instructions}`,
    `Acceptance checks:\n${acceptance}`,
    'Work only in the isolated worktree Wanigan provided. Report evidence and unresolved risks; do not claim a passed check you did not run.',
  ].join('\n\n');
  const session = await createSession({ providerId, projectId: project.id, model: input.model?.trim() || undefined,
    effort: input.effort?.trim() || undefined, permissionMode: input.permissionMode?.trim() || (node.kind === 'implement' ? 'acceptEdits' : 'plan'),
    isolate: true, initialPrompt: prompt });
  // Readiness was checked before a multi-second await (worktree creation,
  // provider probe, PTY spawn). Two starts can both pass that check, and an
  // unconditional write would leave the loser's agent running, spending
  // tokens, attached to nothing. Claiming the row atomically decides it.
  const claimed = db().prepare(`UPDATE work_nodes SET status='running',provider_id=?,model=?,session_id=?,worktree=?,started_at=?,detail=NULL
    WHERE id=? AND session_id IS NULL AND status!='running'`)
    .run(providerId, input.model?.trim() || null, session.id, session.worktree ?? null, now(), nodeId);
  if (claimed.changes === 0) {
    try { killSession(session.id); } catch { /* the duplicate is already gone */ }
    throw new Error('This task was already started by another action; the duplicate session was stopped.');
  }
  db().prepare(`INSERT INTO work_resume_receipts
    (node_id,docket_id,session_id,conversation_id,provider_id,model,base_commit,worktree,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(node_id) DO UPDATE SET session_id=excluded.session_id,conversation_id=excluded.conversation_id,
      provider_id=excluded.provider_id,model=excluded.model,base_commit=excluded.base_commit,worktree=excluded.worktree,updated_at=excluded.updated_at`)
    .run(nodeId, parent.id, session.id, session.conversationId, providerId, input.model?.trim() || null,
      parent.base_commit, session.worktree ?? null, now(), now());
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

export async function runProof(nodeId: string): Promise<DocketProof> {
  const node = nodeRow(nodeId); const parent = docketRow(node.docket_id); const project = projectById(parent.project_id);
  if (!project) throw new Error('Project not found.');
  const run = await review.runAt(project.id, node.worktree ?? project.path);
  const passed = run.status === 'passed';
  const summary = passed ? `${run.results.length} review command(s) passed.` : `Review gate failed after ${run.results.length} command(s).`;
  const proof: DocketProof = { id: uid('proof'), docketId: parent.id, nodeId, kind: 'test', status: passed ? 'passed' : 'failed', summary, createdAt: now() };
  db().prepare(`INSERT INTO work_proofs (id,docket_id,node_id,kind,status,summary,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(proof.id, proof.docketId, proof.nodeId, proof.kind, proof.status, proof.summary,
      JSON.stringify(run.results.map((result) => ({ command: result.command, exitCode: result.exitCode, durationMs: result.durationMs }))), proof.createdAt);
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
  db().prepare(`INSERT INTO work_model_outcomes (id,docket_id,node_id,provider_id,model,task_kind,accepted,tests_passed,cost_usd,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET accepted=excluded.accepted,tests_passed=excluded.tests_passed,cost_usd=excluded.cost_usd`)
    .run(uid('outcome'), node.docket_id, node.id, node.provider_id, model, node.kind, accepted ? 1 : 0, testsPassed ? 1 : 0,
      usage?.costStatus === 'reported' ? usage.costUsd : 0, now());
}

export function completeNode(nodeId: string, input: { detail?: string; decision?: 'approve' | 'request_changes' | 'reject' }): DocketNode {
  const node = nodeRow(nodeId); const parent = docketRow(node.docket_id); const current = mapNodes(rawNodes(parent.id)).find((value) => value.id === nodeId)!;
  if (!['running', 'ready'].includes(current.status)) throw new Error(`Only a ready or running task can be completed; this task is ${current.status}.`);
  const detail = input.detail?.trim() ? safeText(input.detail, 'Completion note', MAX_NOTE) : null;
  const decision = input.decision ?? 'approve';
  const testsPassed = node.kind === 'verify' ? hasPassedProof(parent.id, nodeId) : true;
  if (node.kind === 'verify' && !testsPassed) throw new Error('Run and pass the review gate before completing verification. A claim without command evidence is not proof.');
  if (node.kind === 'review') {
    const verifyNode = mapNodes(rawNodes(parent.id)).find((value) => value.kind === 'verify');
    if (decision === 'approve' && (!verifyNode || !hasPassedProof(parent.id, verifyNode.id))) {
      throw new Error('Approval requires a passed verification proof. Record the review gate before accepting this docket.');
    }
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
  // review pass above to overwrite it — but a docket that is abandoned before
  // review never reaches that loop, leaving those phases permanently recorded
  // as rejected work. An unreviewed phase has no verdict, and no verdict is
  // not a rejection; the router is better served by silence than by a guess.
  if (node.kind === 'review' && decision === 'reject') db().prepare("UPDATE work_dockets SET status='rejected',updated_at=? WHERE id=?").run(now(), parent.id);
  else setDocketPhase(parent.id);
  return mapNodes(rawNodes(parent.id)).find((value) => value.id === nodeId)!;
}

export function outcomes(projectId?: string | null): ModelOutcome[] {
  const where = projectId ? 'WHERE d.project_id=?' : '';
  const rows = db().prepare(`SELECT o.provider_id,o.model,o.task_kind,COUNT(*) samples,SUM(o.accepted) accepted,SUM(o.tests_passed) tests_passed,SUM(o.cost_usd) total_cost_usd
    FROM work_model_outcomes o JOIN work_dockets d ON d.id=o.docket_id ${where}
    GROUP BY o.provider_id,o.model,o.task_kind ORDER BY accepted DESC,tests_passed DESC,samples DESC`).all(...(projectId ? [projectId] : [])) as Array<{
      provider_id: string; model: string; task_kind: DocketNodeKind; samples: number; accepted: number; tests_passed: number; total_cost_usd: number;
    }>;
  return rows.map((row) => ({ providerId: row.provider_id, model: row.model, taskKind: row.task_kind, samples: row.samples,
    accepted: row.accepted, testsPassed: row.tests_passed, totalCostUsd: row.total_cost_usd,
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
  // Claim the event BEFORE the docket exists. createDocket commits its own
  // transaction, so creating first and marking after leaves a window where a
  // crash — or a second click — produces a duplicate docket for one event.
  // Claiming first can at worst leave a triaged event with no docket, which is
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

export function cancelMcpTask(taskId: string): boolean {
  const task = db().prepare('SELECT node_id,docket_id,status FROM mcp_task_records WHERE id=?').get(taskId) as { node_id: string; docket_id: string; status: string } | undefined;
  if (!task || ['completed', 'failed', 'cancelled'].includes(task.status)) return false;
  db().prepare("UPDATE mcp_task_records SET status='cancelled',updated_at=? WHERE id=?").run(now(), taskId);
  const node = nodeRow(task.node_id);
  if (['pending', 'running'].includes(node.status)) {
    db().prepare("UPDATE work_nodes SET status='canceled',ended_at=? WHERE id=?").run(now(), node.id);
    // Cancelling the record while the agent keeps working is the worst of both:
    // its claims are released for someone else to take, and it goes on editing
    // the same worktree and spending tokens against a task nobody is watching.
    if (node.session_id) {
      try { killSession(node.session_id); } catch { /* already exited */ }
    }
    releaseClaims(node.id); setDocketPhase(task.docket_id);
  }
  return true;
}

/**
 * Reopen a failed or canceled task so its docket can move again.
 *
 * Without this every non-approve decision was terminal: the node stayed
 * 'failed', mapNodes marked its dependents 'blocked', and the docket sat
 * 'blocked' forever with no action anywhere that could revive it — a review
 * asking for changes bricked the work it was reviewing.
 */
export function retryNode(nodeId: string): DocketNode {
  const node = nodeRow(nodeId);
  if (!['failed', 'canceled'].includes(node.status)) {
    throw new Error(`Only a failed or canceled task can be reopened; this task is ${node.status}.`);
  }
  if (node.session_id) {
    try { killSession(node.session_id); } catch { /* already exited */ }
  }
  db().prepare(`UPDATE work_nodes SET status='pending',session_id=NULL,started_at=NULL,ended_at=NULL,
    detail=? WHERE id=?`).run(`Reopened after ${node.status}.`, nodeId);
  releaseClaims(nodeId);
  // The MCP task vocabulary has no 'pending': a reopened task is one waiting
  // to be started again, which is exactly what input_required means here.
  setTaskStatus(nodeId, 'input_required');
  setDocketPhase(node.docket_id);
  return mapNodes(rawNodes(node.docket_id)).find((value) => value.id === nodeId)!;
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
    db().prepare(`UPDATE work_nodes SET status='failed',ended_at=?,detail=? WHERE id=? AND status='running'`)
      .run(now(), 'The session running this task ended before it was completed. Reopen it to continue.', node.id);
    releaseClaims(node.id);
    reopened++;
  }
  if (reopened) {
    for (const id of new Set(running.map((node) => nodeRow(node.id).docket_id))) {
      try { setDocketPhase(id); } catch { /* the docket may have been removed */ }
    }
  }
  return reopened;
}
