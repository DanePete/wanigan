import type { DocketDetail, DocketNodeKind, DocketNodeStatus, DocketStatus } from './types';

/** A relationship read from work_nodes, never inferred from a project or title. */
export type SessionGoal = {
  goalId: string; goalTitle: string; goalStatus: DocketStatus;
  nodeId: string; nodeTitle: string; nodeKind: DocketNodeKind; nodeStatus: DocketNodeStatus;
};

export function goalLocation(goalId: string, nodeId?: string): string {
  const query = new URLSearchParams({ goal: goalId });
  if (nodeId) query.set('task', nodeId);
  return `#${query}`;
}

export type GoalGuidance = {
  phase: 'accepted' | 'rejected' | 'blocked' | 'review' | 'working' | 'ready' | 'waiting';
  title: string; note: string; action?: string; nodeId?: string; sessionId?: string;
};

/** Navigation advice only. It neither launches a task nor approves its work. */
export function goalGuidance(goal: Pick<DocketDetail, 'status' | 'nodes'>): GoalGuidance {
  if (goal.status === 'accepted') return { phase: 'accepted', title: 'A good place to land.', note: 'Your acceptance is recorded. The evidence stays with this goal.' };
  if (goal.status === 'rejected') return { phase: 'rejected', title: 'That one stays closed.', note: 'The rejection is recorded. You can still inspect every task and its evidence.' };
  const failed = goal.nodes.find(node => node.status === 'failed' || node.status === 'canceled');
  if (failed) return { phase: 'blocked', title: 'A loose thread.', note: failed.title, action: 'Inspect the blocker', nodeId: failed.id };
  const review = goal.nodes.find(node => node.kind === 'review' && node.status === 'ready' && !node.queued);
  if (review) return { phase: 'review', title: 'Your eye for the finish.', note: 'Read the proof against your acceptance checks.', action: 'Review the decision', nodeId: review.id };
  const running = goal.nodes.find(node => node.status === 'running');
  if (running) return { phase: 'working', title: 'Work is in motion.', note: running.title, action: running.sessionId ? 'Follow the session' : 'Inspect the task', nodeId: running.id, sessionId: running.sessionId ?? undefined };
  const queued = goal.nodes.find(node => node.queued);
  if (queued) return { phase: 'waiting', title: 'Already in the queue.', note: queued.title, action: 'Inspect the queued task', nodeId: queued.id };
  const ready = goal.nodes.find(node => node.status === 'ready');
  if (ready) return { phase: 'ready', title: 'One small beginning.', note: ready.title, action: 'Prepare this task', nodeId: ready.id };
  return { phase: 'waiting', title: 'Keeping the thread.', note: goal.nodes.length ? 'No task is ready to start. Check its prerequisites or scheduled date.' : 'No tasks are recorded for this goal.' };
}
