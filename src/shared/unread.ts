/**
 * The unread badge: what raises it, and how a count reaches a list.
 *
 * The badge used to be counted in the Sessions view, from the `session:data`
 * subscription that view holds. That put the count in the one place that
 * cannot see the thing it is counting: App.tsx unmounts Sessions on every tab
 * change, so output that arrived while the operator was reading Git or Fleet
 * — the entire case a badge exists for — was never counted, and the number
 * survived leaving the view only because the list handler carried the old
 * value forward. `bumpUnread` sat in main with no caller, and
 * `sessions:markRead` zeroed a field nothing had raised.
 *
 * Main owns the number now. Both halves live here, in one file both processes
 * import, so the rule main applies and the rule the two views render cannot
 * drift apart the way two copies of a predicate always eventually do — and so
 * the offline smoke suite can hold the rule to account without a window.
 */
import type { Session, SessionStatus } from './types';

/**
 * Whether output from this session should raise its badge.
 *
 * Two conditions, and each one alone gets a different case wrong. A session
 * the operator is looking at must never raise its own badge — the output is
 * on screen as it arrives, and a count of it is a count of what was just
 * read. An exited session must not either: its last bytes land as it dies,
 * and a badge that appears on a session which has stopped forever invites the
 * operator to open a tab to find nothing new.
 *
 * `focusedSessionId` is null whenever the operator is on another tab, which
 * makes every running session eligible — deliberately, because that is the
 * case the badge is for.
 */
export function shouldBumpUnread(input: {
  sessionId: string;
  focusedSessionId: string | null;
  status: SessionStatus;
}): boolean {
  return input.status !== 'exited' && input.sessionId !== input.focusedSessionId;
}

/**
 * Fold the counts that moved into a session list.
 *
 * Narrow on purpose: main sends only the sessions whose count changed, so a
 * burst of PTY output costs one small record rather than a re-push of every
 * session row. A session absent from `counts` keeps the number it has.
 *
 * The array reference is returned unchanged when nothing moved. That identity
 * is load-bearing rather than tidy: the rail, the tab strip and every card in
 * Fleet re-render off this array, and a coalesced flush that happens to carry
 * a count nobody's list disagrees with must not repaint them.
 */
export function applyUnreadCounts(sessions: readonly Session[], counts: Record<string, number>): Session[] {
  let changed = false;
  const next = sessions.map((s) => {
    const count = counts[s.id];
    if (count === undefined || count === s.unread) return s;
    changed = true;
    return { ...s, unread: count };
  });
  // Nothing here mutates the input; the cast only hands the caller back the
  // array type it passed in, so React's setState can take the same reference.
  return changed ? next : (sessions as Session[]);
}
