import type http from 'node:http';
import { json, registerApiRoute } from './dispatch';
import { safeString } from './snapshot';
import type { MobileRecentSession } from '../../shared/types';

/**
 * Conversations you can pick back up, from a phone.
 *
 * The Agent screen has only ever shown what is in the running process: live
 * sessions and exited tabs somebody left open. Everything before the last
 * launch of Wanigan — which is most of what an operator has — was invisible
 * from a paired device, so an iPad could start new work and never continue any.
 *
 * Two boundaries are load-bearing here, and they are the reason this is a route
 * of its own rather than three more fields on /api/status.
 *
 * A past session row is the most path-laden record in the app: it carries the
 * project's absolute path, its worktree, and the agent's own conversation id.
 * The monitor's stated boundary excludes all three by name. So the wire shape is
 * built field by field from an allow-list rather than filtered from the row —
 * the same rule the fleet snapshot follows, and for the same reason: a filter
 * is one property rename away from carrying what it was written to remove.
 *
 * And resuming is not done by handing the phone a conversation id to send back.
 * The device names a session by Wanigan's own id, which it already sees on the
 * fleet snapshot, and the Mac resolves the conversation, the project and the
 * worktree locally. A paired device cannot name a conversation Wanigan did not
 * already offer it, and cannot learn one it was never shown.
 */

/** More than a phone will scroll, and enough that yesterday is always on it. */
const MAX_RECENT = 40;

/**
 * How long an answer is reused before the source is asked again.
 *
 * The phone registers this read with `ui.watch`, and the frame runs a watcher
 * on *every poll that came back* — roughly every three seconds while the Agent
 * screen is the screen on show. The source behind it is `pastSessions()`, which
 * says of itself that the row set stays unbounded and it "reads every execution
 * ever recorded". Uncached, leaving a phone on that screen ran a full-history
 * query five times a minute for a list that changes when a session ends.
 *
 * Fifteen seconds, because the thing being listed is the past. A conversation
 * that finished moments ago showing up a few seconds late is imperceptible; a
 * resumed one appears on the fleet snapshot immediately, which is a different
 * read on a different cadence.
 */
const CACHE_MS = 15_000;

let cached: { at: number; rows: MobileRecentSession[] } | null = null;

/** Dropped when the list is known to have changed — see `forgetRecentCache`. */
export function forgetRecentCache(): void {
  cached = null;
}

export type MobileRecentSource = () => MobileRecentSession[] | Promise<MobileRecentSession[]>;

let recentSource: MobileRecentSource | null = null;

/**
 * Registered by the desktop main process, like every other source on this
 * listener. With nothing registered the route answers an empty list rather than
 * failing: a build that has not wired it shows "nothing to resume", which is
 * true of it.
 */
export function configureMobileRecentSource(fn: MobileRecentSource | null): void {
  recentSource = fn;
  // A new source is a new answer. Keeping the old one would serve a list
  // assembled by a bridge that is no longer attached.
  cached = null;
}

/**
 * Rebuild one row from an allow-list.
 *
 * `live` is the field worth naming: it says the project directory still exists.
 * A conversation whose repository was moved or deleted cannot be resumed, and a
 * phone that offered a Resume button for it would produce a failure the
 * operator can do nothing about from where they are standing.
 */
function wireRow(row: MobileRecentSession): MobileRecentSession {
  const value = row as MobileRecentSession & Record<string, unknown>;
  return {
    id: safeString(value.id, 160),
    title: safeString(value.title, 200, 'Agent session'),
    projectName: safeString(value.projectName, 160, 'Unknown project'),
    providerId: safeString(value.providerId, 100, 'unknown'),
    model: value.model === null ? null : safeString(value.model, 120) || null,
    startedAt: typeof value.startedAt === 'number' && Number.isFinite(value.startedAt) ? value.startedAt : 0,
    endedAt: typeof value.endedAt === 'number' && Number.isFinite(value.endedAt) ? value.endedAt : null,
    exitCode: typeof value.exitCode === 'number' && Number.isFinite(value.exitCode) ? Math.trunc(value.exitCode) : null,
    turns: Math.max(0, Math.round(typeof value.turns === 'number' && Number.isFinite(value.turns) ? value.turns : 0)),
    live: value.live === true,
    pinned: value.pinned === true,
  };
}

async function serveRecent(res: http.ServerResponse): Promise<void> {
  const source = recentSource;
  if (!source) { json(res, 200, { sessions: [] }); return; }
  if (cached && Date.now() - cached.at < CACHE_MS) {
    json(res, 200, { sessions: cached.rows });
    return;
  }
  try {
    const rows = await Promise.resolve().then(source);
    const sessions = (Array.isArray(rows) ? rows : []).slice(0, MAX_RECENT).map(wireRow);
    cached = { at: Date.now(), rows: sessions };
    json(res, 200, { sessions });
  } catch {
    // Source errors can carry local paths or database detail. The phone needs
    // to know the read failed, not which local byte made it fail.
    json(res, 503, { error: 'Wanigan could not read recent conversations.' });
  }
}

// Monitor scope: this is a reading, not an action. Resuming one is a separate,
// control-scope call in ./control, because starting an agent is the thing the
// remote-control opt-in exists to gate.
registerApiRoute({
  path: '/api/recent',
  method: 'GET',
  scope: 'monitor',
  handler: (_req, res) => serveRecent(res),
});
