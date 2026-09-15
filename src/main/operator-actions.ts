import { db } from './db';

/**
 * Things an operator did from an attention surface that put words in front of
 * an agent, or started one on their behalf.
 *
 * The record is the action and its size, never the text: "a 42-character reply
 * went into the composer from a notification" is the fact worth keeping, and
 * the words themselves are the operator's to send or throw away. That the
 * draft was sent at all is the terminal's record, not this one's.
 */
export type OperatorAction =
  | 'denial-retry-drafted'
  | 'notification-reply-drafted'
  | 'notification-opened'
  | 'resume-at-reset-armed'
  | 'resume-at-reset-cancelled'
  | 'resume-at-reset-launched'
  | 'resume-at-reset-failed'
  | 'resume-forked'
  | 'session-snoozed'
  | 'tab-reopened';

const MAX_DETAIL = 240;

export function recordOperatorAction(sessionId: string | null, action: OperatorAction, detail: string | null = null): void {
  try {
    db().prepare('INSERT INTO operator_actions (session_id, at, action, detail) VALUES (?,?,?,?)')
      .run(sessionId, Date.now(), action, detail ? detail.slice(0, MAX_DETAIL) : null);
  } catch {
    // The record of an action is never a reason to refuse the action. A closed
    // database is a quit in progress.
  }
}

export function operatorActions(sessionId: string, limit = 50): { at: number; action: string; detail: string | null }[] {
  return db().prepare('SELECT at, action, detail FROM operator_actions WHERE session_id = ? ORDER BY at DESC, id DESC LIMIT ?')
    .all(sessionId, Math.max(1, Math.min(500, Math.trunc(limit) || 1))) as { at: number; action: string; detail: string | null }[];
}
