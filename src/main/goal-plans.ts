import { createHash, randomUUID } from 'node:crypto';
import { db } from './db';
import { redactCredentials } from './redact';
import type { GoalPlan } from '../shared/types';

/**
 * The plan a goal's planning session produced, kept as that goal's evidence.
 *
 * A plan task ran in plan mode and its plan went nowhere: the implementation
 * task was launched with the goal's titles and statuses, never with what the
 * planner decided. Claude Code hands the plan to hooks on ExitPlanMode. Read
 * from the 2.1.271 binary: `tool_input.plan` is injected from the plan file
 * before PermissionRequest (the proposal shown to the person), and PostToolUse
 * carries `tool_response.plan` (the plan as it was accepted, edits included)
 * with `planWasEdited`.
 *
 * The approval itself stays in the CLI's own plan prompt in the terminal,
 * which is already a person deciding. Holding the hook open for an answer
 * elsewhere would stall the CLI inside a hook timeout. What changes is what
 * happens after: the accepted plan is recorded against the goal and handed to
 * the tasks that come after it.
 *
 * It is the agent's text, so it is labelled as that wherever it appears,
 * redacted, and bounded. Like every goal proof's detail_json, it stays on the
 * Mac; the phone sees only the one-line summary.
 */

export const PLAN_MAX_CHARS = 32_000;

type PlanSource = GoalPlan['state'];

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

/** The plan in an ExitPlanMode hook body, or null when this body carries none. */
export function planFromHook(event: string, toolName: string | null, input: Record<string, unknown>): {
  source: PlanSource; plan: string; planFilePath: string | null; edited: boolean;
} | null {
  if (toolName !== 'ExitPlanMode') return null;
  const toolInput = (input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}) as Record<string, unknown>;
  const response = (input.tool_response && typeof input.tool_response === 'object' ? input.tool_response : {}) as Record<string, unknown>;
  if (event === 'PermissionRequest') {
    const plan = text(toolInput.plan);
    return plan ? { source: 'proposed', plan, planFilePath: text(toolInput.planFilePath), edited: false } : null;
  }
  if (event === 'PostToolUse') {
    const plan = text(response.plan) ?? text(toolInput.plan);
    return plan
      ? { source: 'accepted', plan, planFilePath: text(response.filePath) ?? text(toolInput.planFilePath), edited: response.planWasEdited === true }
      : null;
  }
  return null;
}

/**
 * Record a plan for the goal task this session is running. A session that is
 * not goal work records nothing, and the same plan in the same state is not
 * written twice, since PermissionRequest can repeat while a person thinks.
 */
export function recordGoalPlan(sessionId: string, captured: NonNullable<ReturnType<typeof planFromHook>>, at = Date.now()): boolean {
  try {
    const node = db().prepare('SELECT id, docket_id, title FROM work_nodes WHERE session_id=?').get(sessionId) as
      { id: string; docket_id: string; title: string } | undefined;
    if (!node) return false;
    const redacted = redactCredentials(captured.plan);
    const truncated = redacted.length > PLAN_MAX_CHARS;
    const body = truncated ? redacted.slice(0, PLAN_MAX_CHARS) : redacted;
    const digest = createHash('sha256').update(body).digest('hex');
    const last = db().prepare(`SELECT detail_json FROM work_proofs WHERE docket_id=? AND node_id=? AND kind='plan' ORDER BY created_at DESC LIMIT 1`)
      .get(node.docket_id, node.id) as { detail_json: string } | undefined;
    if (last) {
      try {
        const prior = JSON.parse(last.detail_json) as { digest?: string; state?: string };
        if (prior.digest === digest && prior.state === captured.source) return false;
      } catch { /* an unreadable prior record does not stop a new one */ }
    }
    const lines = body.split('\n').length;
    db().prepare(`INSERT INTO work_proofs (id, docket_id, node_id, kind, status, summary, detail_json, created_at)
      VALUES (?, ?, ?, 'plan', 'recorded', ?, ?, ?)`).run(
      `proof_${randomUUID().slice(0, 12)}`, node.docket_id, node.id,
      `${captured.source === 'accepted' ? 'Plan accepted' : 'Plan proposed'} in ${node.title} (${lines} line${lines === 1 ? '' : 's'}${captured.edited ? ', edited before acceptance' : ''}), written by the agent.`,
      JSON.stringify({ state: captured.source, plan: body, truncated, edited: captured.edited, planFilePath: captured.planFilePath, digest }),
      at,
    );
    return true;
  } catch {
    return false;
  }
}

/** The goal's most recent accepted plan, else its most recent proposal, else null. */
export function latestGoalPlan(docketId: string): GoalPlan | null {
  const rows = db().prepare(`SELECT p.node_id, p.detail_json, p.created_at, n.title FROM work_proofs p
      LEFT JOIN work_nodes n ON n.id = p.node_id
     WHERE p.docket_id=? AND p.kind='plan' ORDER BY p.created_at DESC, p.rowid DESC LIMIT 20`)
    .all(docketId) as { node_id: string | null; detail_json: string; created_at: number; title: string | null }[];
  const plans = rows.flatMap((row): GoalPlan[] => {
    try {
      const detail = JSON.parse(row.detail_json) as { state?: PlanSource; plan?: string; truncated?: boolean; edited?: boolean; planFilePath?: string | null };
      if (!detail.plan || (detail.state !== 'accepted' && detail.state !== 'proposed')) return [];
      return [{
        docketId, nodeId: row.node_id ?? '', nodeTitle: row.title ?? 'a task no longer on this goal', state: detail.state,
        text: detail.plan, truncated: detail.truncated === true, edited: detail.edited === true,
        planFilePath: detail.planFilePath ?? null, capturedAt: row.created_at,
      }];
    } catch {
      return [];
    }
  });
  return plans.find((plan) => plan.state === 'accepted') ?? plans[0] ?? null;
}
