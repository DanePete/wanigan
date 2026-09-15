/**
 * The popped-out code rail, the pure half: how its window is addressed, and
 * the only channels it may call.
 *
 * The second window loads the same renderer with the same preload and the same
 * hardening as the main window, so everything that distinguishes it from the
 * main window has to be decided somewhere a renderer cannot argue with. Two
 * things are decided here. The query string names the view and the session;
 * main builds it and the renderer only reads it. And the channel list is the
 * whole of what that window can ask main for: the code panel's own reads, its
 * checkpoint and revert flows (each of which already asks the operator before
 * it changes a file), and the one read that tells it which session it shows.
 * No PTY write, no launch, no settings, no credential, no shell.
 */

export const CODE_RAIL_VIEW = 'code-rail';

/** The query main puts on the renderer URL for a code rail window. */
export function codeRailQuery(sessionId: string): string {
  return `view=${CODE_RAIL_VIEW}&session=${encodeURIComponent(sessionId)}`;
}

/** The session a renderer URL's query asks for, or null when it is not a code rail window. */
export function codeRailSessionFromQuery(search: string): string | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  if (params.get('view') !== CODE_RAIL_VIEW) return null;
  const id = params.get('session');
  return id && id.length <= 200 && /^[A-Za-z0-9_:.-]+$/.test(id) ? id : null;
}

export const CODE_RAIL_CHANNELS: ReadonlySet<string> = new Set([
  'ux:railSession',
  'code:editors', 'code:open', 'code:changes', 'code:diff', 'code:list', 'code:read',
  'sessions:baseline',
  'checkpoints:list', 'checkpoints:diff', 'checkpoints:revertPlan', 'checkpoints:revert',
  'revert:plan', 'revert:file', 'revert:all',
]);

export function codeRailMayCall(channel: string): boolean {
  return CODE_RAIL_CHANNELS.has(channel);
}
