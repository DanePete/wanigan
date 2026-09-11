import type { Attention, Session } from './types';

export type PresenceSignal = 'quiet' | 'working' | 'permission' | 'error' | 'finished' | 'unavailable';
export type PresenceRead = 'loading' | 'ready' | 'unavailable';
export type CompanionPresenceState = {
  signal: PresenceSignal;
  label: string;
  needs: number;
  events: string[];
  errorEvents?:string[];
  finishedEvents?:string[];
};

/** A glance at observed session signals. An exit or running PID alone is
 * neither successful work nor proof of progress. Priority matches the queue. */
export function companionPresence(sessions: Pick<Session, 'id' | 'status'>[], attention: Attention[], read: PresenceRead): CompanionPresenceState {
  if (read !== 'ready') return { signal: 'unavailable', label: read === 'loading' ? 'Checking sessions' : 'Status unavailable', needs: 0, events: [] };
  const live = new Set(sessions.map(session => session.id));
  const rows = [...new Map(attention.filter(row => live.has(row.sessionId)).map(row => [row.sessionId, row])).values()];
  const waiting = rows.filter(row => ['permission', 'error', 'finished'].includes(row.kind));
  const events = waiting.map(row => `${row.sessionId}:${row.kind}:${row.transitionId ?? row.since}`).sort();
  const errorEvents=waiting.filter(row=>row.kind==='error').map(row=>`${row.sessionId}:${row.kind}:${row.transitionId??row.since}`).sort();
  const finishedEvents=waiting.filter(row=>row.kind==='finished').map(row=>`${row.sessionId}:${row.kind}:${row.transitionId??row.since}`).sort();
  for (const kind of ['permission', 'error', 'finished', 'working'] as const) {
    const count = rows.filter(row => row.kind === kind).length;
    if (!count) continue;
    const label = kind === 'permission' ? count === 1 ? 'Permission needed' : `${count} need permission`
      : kind === 'error' ? count === 1 ? 'A session needs help' : `${count} sessions need help`
      : kind === 'finished' ? count === 1
        ? sessions.find(session => session.id === rows.find(row => row.kind === kind)?.sessionId)?.status === 'exited' ? 'A session ended' : 'A turn finished'
        : `${count} to look over`
      : count === 1 ? 'An agent is working' : `${count} agents working`;
    return { signal: kind, label, needs: waiting.length, events, errorEvents, finishedEvents };
  }
  return { signal: 'quiet', label: 'Here with you', needs: 0, events, errorEvents, finishedEvents };
}

/** Classify the events themselves, even while a higher-priority signal stays on. */
export function presenceChanges(previous: CompanionPresenceState | null, current: CompanionPresenceState) {
  const none = { attention: false, completion: false, failure: false };
  if (!previous || previous.signal === 'unavailable' || current.signal === 'unavailable') return none;
  const fresh = current.events.filter(id => !previous.events.includes(id));
  const finishes = current.finishedEvents ?? (current.signal === 'finished' ? current.events : []);
  return { attention: fresh.some(id => !finishes.includes(id)), completion: fresh.some(id => finishes.includes(id)),
    failure: (current.errorEvents ?? []).some(id => !(previous.errorEvents ?? []).includes(id)) };
}
