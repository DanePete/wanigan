import { db } from './db';
import { nodeProjectId } from './control';
import { budgetBreachesFor } from './spend';
import type { QueueKind } from '../shared/types';

/**
 * A monthly budget stops work nobody is watching start.
 *
 * spend.ts computed which budgets a piece of work would breach, and wrote
 * budgetBreachesFor for the refusal, but nothing called it, so every cap in
 * Insights was a warning: a schedule or an armed goal kept starting paid runs
 * after the month's spend had passed the number the operator set.
 *
 * Three rules, each a decision:
 *  - Only work that starts with nobody watching: headless runs, batch
 *    re-submissions and autopilot goal tasks, the lanes the queue dispatches.
 *    A session someone opens in front of them is told, never held; they are
 *    the one deciding to spend.
 *  - Only a cap already reached. The warning line is for a person to read,
 *    and the run-rate projection is arithmetic about days that have not
 *    happened, which is no reason on its own to stop work.
 *  - The project's budget and the global one, because a project under its own
 *    cap can still be the work that takes the account over the global one.
 *
 * A held row waits rather than fails, with the breach sentence as its reason,
 * so raising the budget or the month turning lets it start with nothing to
 * re-create.
 */

const HELD_KINDS: ReadonlySet<QueueKind> = new Set<QueueKind>(['headless', 'batch', 'node']);

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The project a queued item spends against, or null when it names none. */
export function queueProjectOf(kind: QueueKind, payload: unknown): string | null {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  if (kind === 'node') {
    const nodeId = text(p.nodeId);
    return nodeId ? nodeProjectId(nodeId) : null;
  }
  const named = text(p.projectId);
  if (named) return named;
  // A batch re-submission names its run, and the run knows its project even
  // when the schedule that fired it was created without one.
  const runId = kind === 'batch' ? text(p.runId) : null;
  if (!runId) return null;
  const row = db().prepare('SELECT project_id FROM runs WHERE id = ?').get(runId) as { project_id: string | null } | undefined;
  return row?.project_id ?? null;
}

export function budgetHold(kind: QueueKind, payload: unknown): string | null {
  if (!HELD_KINDS.has(kind)) return null;
  const over = budgetBreachesFor(queueProjectOf(kind, payload)).find((breach) => breach.reason === 'over-budget');
  return over
    ? `Held by a monthly budget. ${over.summary} It starts once the budget is raised in Insights, or when the month turns.`
    : null;
}
