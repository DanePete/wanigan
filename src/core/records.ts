// Row shapes as SQLite returns them, and their mapping to the shared model.
import type {
  Activity, AiReview, Card, CardStatus, CardType, Comment, Criterion, Decision, Evidence, EvidenceKind,
  PermissionAsk, Priority, Project, Provider, Session, SessionEvent, SessionState,
} from '../shared/model.ts';
import { LIVE_STATES } from '../shared/model.ts';

/** The live session states as an SQL list, for `state IN (…)`. */
export const LIVE_SQL = [...LIVE_STATES].map((s) => `'${s}'`).join(',');

export interface ProjectRow {
  id: string; key: string; name: string; path: string; next_seq: number; created_at: number; archived_at: number | null;
  paused_at: number | null; paused_by: string | null; isolate: number; jev: string; setup_command: string | null;
  local_model: string | null;
}
export const toProject = (r: ProjectRow): Project => ({
  id: r.id, key: r.key, name: r.name, path: r.path, createdAt: r.created_at, archivedAt: r.archived_at,
});

export interface CardRow {
  id: string; project_id: string; seq: number; key: string; type: string; title: string; body: string;
  status: string; priority: number; reopened: number; sent_back: number; rank: number; created_by: string;
  created_at: number; updated_at: number; claim_session: string | null; claim_expires: number | null; claim_note: string | null;
  worktree_path: string | null; worktree_branch: string | null; worktree_base: string | null; pr_url: string | null;
  status_at: number | null;
}
export const toCard = (r: CardRow): Card => ({
  id: r.id,
  projectId: r.project_id,
  key: r.key,
  type: r.type as CardType,
  title: r.title,
  body: r.body,
  status: r.status as CardStatus,
  priority: r.priority as Priority,
  reopened: r.reopened === 1,
  sentBack: r.sent_back === 1,
  rank: r.rank,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  statusAt: r.status_at ?? r.updated_at,
  claim: r.claim_session && r.claim_expires !== null
    ? { sessionId: r.claim_session, expiresAt: r.claim_expires, note: r.claim_note }
    : null,
  worktree: r.worktree_path && r.worktree_branch && r.worktree_base
    ? { path: r.worktree_path, branch: r.worktree_branch, base: r.worktree_base }
    : null,
  pullRequest: r.pr_url,
});

export interface CriterionRow { id: string; card_id: string; text: string; done: number; position: number }
export const toCriterion = (r: CriterionRow): Criterion => ({
  id: r.id, cardId: r.card_id, text: r.text, done: r.done === 1, position: r.position,
});

export interface CommentRow {
  id: string; card_id: string; author: string; body: string; kind: string; resolved_at: number | null; created_at: number;
}
export const toComment = (r: CommentRow): Comment => ({
  id: r.id, cardId: r.card_id, author: r.author, body: r.body,
  kind: r.kind === 'question' ? 'question' : 'comment', resolved: r.resolved_at !== null, createdAt: r.created_at,
});

export interface EvidenceRow {
  id: string; card_id: string; kind: string; value: string; existed: number | null; added_by: string; created_at: number;
}
export const toEvidence = (r: EvidenceRow): Evidence => ({
  id: r.id,
  cardId: r.card_id,
  kind: r.kind as EvidenceKind,
  value: r.value,
  existed: r.existed === null ? null : r.existed === 1,
  addedBy: r.added_by,
  createdAt: r.created_at,
});

export interface SessionRow {
  id: string; project_id: string; card_id: string | null; provider: string; title: string; state: string;
  activity: string | null; pid: number | null; exit_code: number | null; conversation_id: string | null;
  token_hash: string; started_at: number; ended_at: number | null; last_event_at: number | null;
  asking_since: number | null; seen_at: number | null; account_id: string | null; cwd: string | null;
  limit_since: number | null; limit_resets_at: number | null; model: string | null; effort: string | null; remote: number | null;
  /** JSON list of PermissionAsk while a permission request is open. */
  asking: string | null;
  /** 1 for a terminal a key may be typed into: its output is never kept or searched. */
  ephemeral: number | null;
  transcript_path: string | null;
  /** 1 once the agent's own hooks have reported through the relay. */
  relayed?: number | null;
  card_key?: string | null;
}

/** The open permission requests a session's `asking` column holds; empty when none or unreadable. */
export function toAsks(json: string | null): PermissionAsk[] {
  if (!json) return [];
  try {
    const list: unknown = JSON.parse(json);
    return Array.isArray(list) ? list.filter((a): a is PermissionAsk => !!a && typeof a === 'object' && typeof a.text === 'string' && typeof a.tool === 'string') : [];
  } catch {
    return [];
  }
}

/** Session columns plus its card's key. Use with `FROM sessions s`. */
export const SESSION_COLUMNS = 's.*, (SELECT key FROM cards c WHERE c.id = s.card_id) AS card_key';
export const toSession = (r: SessionRow): Session => ({
  id: r.id,
  projectId: r.project_id,
  cardId: r.card_id,
  cardKey: r.card_key ?? null,
  provider: r.provider as Provider,
  accountId: r.account_id,
  title: r.title,
  state: r.state as SessionState,
  activity: r.activity,
  pid: r.pid,
  exitCode: r.exit_code,
  conversationId: r.conversation_id,
  transcriptPath: r.transcript_path ?? null,
  model: r.model ?? null,
  effort: r.effort ?? null,
  cwd: r.cwd,
  remote: r.remote === 1,
  relayed: r.relayed === 1,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  lastEventAt: r.last_event_at,
  limit: r.state === 'limited' ? { since: r.limit_since ?? r.last_event_at ?? r.started_at, resetsAt: r.limit_resets_at } : null,
  ...(r.state === 'permission' && r.asking ? { asks: toAsks(r.asking) } : {}),
});

export interface SessionEventRow { id: number; session_id: string; at: number; event: string; tool: string | null; summary: string | null; path: string | null }
export const toSessionEvent = (r: SessionEventRow): SessionEvent => ({
  id: r.id, sessionId: r.session_id, at: r.at, event: r.event, tool: r.tool, summary: r.summary, path: r.path ?? null,
});

export interface ActivityRow {
  id: number; project_id: string | null; card_id: string | null; session_id: string | null;
  actor: string; verb: string; detail: string | null; at: number;
}
export const toActivity = (r: ActivityRow): Activity => ({
  id: r.id, projectId: r.project_id, cardId: r.card_id, sessionId: r.session_id,
  actor: r.actor, verb: r.verb, detail: r.detail, at: r.at,
});

export interface DecisionRow {
  id: string; project_id: string; title: string; body: string; created_at: number; updated_at: number; removed_at: number | null;
}
export const toDecision = (r: DecisionRow): Decision => ({
  id: r.id, projectId: r.project_id, title: r.title, body: r.body, createdAt: r.created_at, updatedAt: r.updated_at,
});

export interface AiReviewRow {
  id: string; card_id: string; project_id: string; account_id: string | null; state: string;
  started_at: number; finished_at: number | null; result_json: string | null; cost_usd: number | null; error: string | null;
}
/** A stored JSON column, or null when it cannot be read: one bad row must not break the view that shows it. */
function parsed<T>(json: string | null): T | null {
  if (!json) return null;
  try { return JSON.parse(json) as T; } catch { return null; }
}

export const toAiReview = (r: AiReviewRow): AiReview => ({
  id: r.id, cardId: r.card_id, accountId: r.account_id,
  state: r.state === 'done' || r.state === 'failed' ? r.state : 'running',
  startedAt: r.started_at, finishedAt: r.finished_at,
  result: parsed<AiReview['result']>(r.result_json),
  costUsd: r.cost_usd, error: r.error,
});
