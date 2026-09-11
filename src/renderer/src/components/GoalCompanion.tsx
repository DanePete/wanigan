import { useEffect, useRef, useState } from 'react';
import type { DocketDetail } from '@shared/types';
import { goalGuidance } from '@shared/goal-journey';
import Orb from './Orb';
import { readTemperament } from '../orb/expression';

/** Keyed by goal: opening an old accepted record never replays a celebration. */
export default function GoalCompanion({ goal, unavailable, busy, onTask, onSession }: {
  goal: DocketDetail; unavailable: boolean; busy: boolean;
  onTask: (id: string) => void; onSession: (id: string) => void;
}) {
  const guidance = goalGuidance(goal);
  const previous = useRef<string | null>(null);
  const [completion, setCompletion] = useState(0);
  const [temperament] = useState(readTemperament);
  const [nudged, setNudged] = useState(false);
  useEffect(() => { setNudged(false); }, [guidance.phase]);
  useEffect(() => {
    if (!nudged) return;
    const timer = window.setTimeout(() => setNudged(false), 6000);
    return () => window.clearTimeout(timer);
  }, [nudged]);
  useEffect(() => {
    if (unavailable) { previous.current = null; return; }
    if (previous.current !== null && previous.current !== 'accepted' && goal.status === 'accepted') setCompletion(value => value + 1);
    previous.current = goal.status;
  }, [goal.status, unavailable]);
  const signal = unavailable ? 'unavailable' : guidance.phase === 'accepted' ? 'finished' : guidance.phase === 'blocked' ? 'error' : guidance.phase === 'review' ? 'permission' : guidance.phase === 'working' ? 'working' : 'quiet';
  return <aside className="goal-companion" aria-label="With Wanigan" data-phase={unavailable ? 'unavailable' : guidance.phase} data-completions={completion}>
    <Orb compact temperament={temperament} signal={signal} completionEvent={completion}
      label="Give Wanigan a nudge" onActivate={() => setNudged(value => !value)} />
    <div className="goal-companion-copy">
      <strong>{unavailable ? 'Waiting for a fresh read.' : nudged ? 'Supervising. Very seriously.' : guidance.title}</strong>
      <p>{unavailable ? 'Refresh the goal to read its next step.' : guidance.note}</p>
      {!unavailable && guidance.action && <button type="button" className="goal-companion-action" disabled={busy}
        onClick={() => guidance.sessionId ? onSession(guidance.sessionId) : guidance.nodeId && onTask(guidance.nodeId)}>{guidance.action}<span aria-hidden="true"> ↗</span></button>}
    </div>
  </aside>;
}
