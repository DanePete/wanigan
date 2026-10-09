// Which live sessions Running's Watch layout shows. Pure, so the rule is tested
// in milliseconds rather than by looking at a screenshot.
import { rankNeeds } from './attention.ts';
import { LIVE_STATES, type Need, type NeedKind, type Session } from './model.ts';

/** Four terminals is as many as one person can watch at once. */
export const WATCH_MAX = 4;

export interface WatchPick {
  /** What to show, in the order to show it. */
  shown: Session[];
  /** Live sessions running and not shown. */
  more: number;
  /** The owner chose these, rather than Wanigan. */
  pinned: boolean;
}

/** Each session's most urgent need, by Needs you's own ranking. */
export function topNeeds(needs: readonly Need[]): Map<string, NeedKind> {
  const top = new Map<string, NeedKind>();
  for (const n of rankNeeds([...needs])) if (n.sessionId && !top.has(n.sessionId)) top.set(n.sessionId, n.kind);
  return top;
}

/**
 * Pinned sessions that are still live, in the order they were pinned. With
 * none, the sessions that most need the owner (the ranking Needs you uses),
 * then the most recently active.
 *
 * Shown in the order they started, not the order they rank: a tile that moved
 * whenever another session's need changed would be hard to watch, and would
 * drop the keys of whoever was typing into it. For the same reason `keep`, the
 * session being typed into, stays on screen even when others outrank it.
 */
export function pickWatched(sessions: readonly Session[], needs: readonly Need[], pins: readonly string[],
  keep: string | null = null, max = WATCH_MAX): WatchPick {
  const live = sessions.filter((s) => LIVE_STATES.has(s.state));
  const byId = new Map(live.map((s) => [s.id, s]));
  const pinned = [...new Set(pins)].flatMap((id) => byId.get(id) ?? []).slice(0, max);
  if (pinned.length) return { shown: pinned, more: live.length - pinned.length, pinned: true };

  const top = topNeeds(needs);
  const rank = [...top.keys()];
  const order = (s: Session): number => (top.has(s.id) ? rank.indexOf(s.id) : rank.length);
  const recent = (s: Session): number => s.lastEventAt ?? s.startedAt;
  let chosen = [...live].sort((a, b) => order(a) - order(b) || recent(b) - recent(a)).slice(0, max);
  const kept = keep ? byId.get(keep) : undefined;
  if (kept && !chosen.includes(kept)) chosen = [...chosen.slice(0, max - 1), kept];
  const shown = chosen.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  return { shown, more: live.length - shown.length, pinned: false };
}
