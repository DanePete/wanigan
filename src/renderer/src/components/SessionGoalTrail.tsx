import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionGoal } from '@shared/goal-journey';
import { Mark, markOf } from './bits';

export default function SessionGoalTrail({ sessionId, onOpen }: { sessionId: string; onOpen: (goalId: string, nodeId?: string) => void }) {
  const [goal, setGoal] = useState<SessionGoal | null>(null);
  const [failed, setFailed] = useState(false);
  const [reading, setReading] = useState(true);
  const sequence = useRef(0);
  const read = useCallback(async () => {
    const request = ++sequence.current;
    setReading(true);
    try {
      const value = await window.wanigan.control.sessionGoal(sessionId);
      if (request === sequence.current) { setGoal(value); setFailed(false); }
    } catch { if (request === sequence.current) { setGoal(null); setFailed(true); } }
    finally { if (request === sequence.current) setReading(false); }
  }, [sessionId]);
  useEffect(() => {
    void read();
    const offQueue = window.wanigan.on.queueChanged(() => void read());
    const offExit = window.wanigan.on.exit(event => { if (event.sessionId === sessionId) void read(); });
    return () => { sequence.current++; offQueue(); offExit(); };
  }, [read, sessionId]);
  if (failed) return <div className="session-goal-trail"><span>Goal link unavailable</span><button className="btn btn-sm" disabled={reading} onClick={() => void read()}>Retry goal link</button></div>;
  if (!goal) return null;
  return <nav className="session-goal-trail" aria-label="This session’s goal" aria-busy={reading}>
    <button type="button" className="session-goal-link" onClick={() => onOpen(goal.goalId, goal.nodeId)} title={`${goal.goalTitle} · ${goal.nodeTitle}`}>
      <span className="session-goal-label">Back to goal</span><strong>{goal.goalTitle}</strong><span aria-hidden="true">/</span><span>{goal.nodeTitle}</span><span aria-hidden="true">↗</span>
    </button>
    <Mark {...markOf(goal.nodeStatus)} />
  </nav>;
}
