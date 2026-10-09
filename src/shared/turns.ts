// A session's hook events, read as turns: what the owner asked, what the agent
// did about it, how long it took and which files it touched. Pure, so the
// grouping is tested without a session.
import type { SessionEvent } from './model.ts';

export interface Turn {
  /** 1 for the first turn the hooks saw. Events before any prompt are turn 0. */
  n: number;
  startedAt: number;
  /** When the turn ended (Stop, StopFailure, or the owner interrupting it), or null while it is still going. */
  endedAt: number | null;
  failed: boolean;
  tools: number;
  /** Files the agent wrote, in the order it first touched them. */
  files: string[];
  /** The agent stopped to ask permission during this turn. */
  asked: boolean;
  events: SessionEvent[];
}

const STARTS = new Set(['UserPromptSubmit']);
const ENDS = new Set(['Stop', 'StopFailure', 'Interrupted']);

export function groupTurns(events: readonly SessionEvent[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  const open = (n: number, at: number): Turn => ({ n, startedAt: at, endedAt: null, failed: false, tools: 0, files: [], asked: false, events: [] });
  for (const e of events) {
    if (STARTS.has(e.event)) {
      // A new prompt ends whatever came before it, even without a Stop.
      if (current && current.endedAt === null) current.endedAt = e.at;
      current = open(turns.filter((t) => t.n > 0).length + 1, e.at);
      turns.push(current);
    } else if (!current) {
      // What follows a finished turn before the next prompt (an idle notice,
      // the owner undoing it) belongs to that turn. Only what comes before any
      // prompt is the session starting.
      current = turns.at(-1) ?? null;
      if (!current) {
        current = open(0, e.at);
        turns.push(current);
      }
    }
    current.events.push(e);
    if (e.event === 'PreToolUse') current.tools++;
    if (e.event === 'PermissionRequest' || (e.event === 'Notification' && /permission/i.test(e.summary ?? ''))) current.asked = true;
    if (e.path && !current.files.includes(e.path)) current.files.push(e.path);
    if (ENDS.has(e.event)) {
      current.endedAt = e.at;
      current.failed = e.event === 'StopFailure';
      current = null;
    }
  }
  return turns;
}

/** "1m 12s", "40s", "2h 5m". */
export function turnLength(from: number, to: number): string {
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ''}`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
