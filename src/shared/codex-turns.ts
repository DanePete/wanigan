// How a Codex turn ended, read from the thread's own rollout: the record Codex
// writes of every turn, in the account's CODEX_HOME. Pure, so it is tested
// without a core.
//
// Seen from codex-cli 0.155.1 itself, run against a stand-in model provider (no
// login, no model called), and read in its source at rust-v0.155.1
// (core/src/session/turn.rs, core/src/tasks/mod.rs, tui/src/chatwidget):
// - A turn that fails (the account's usage limit, a server error, a lost
//   connection) fires no Stop hook and no OSC 9 notification: Stop hooks run
//   only when a turn completes, and the TUI notifies only then. A turn
//   interrupted with Esc fires neither either. Without this, such a session
//   would read "working" until its next prompt.
// - The rollout records how each turn ended: an `event_msg` `task_complete`
//   naming the turn, with `error: { message, codex_error_info }` when it
//   failed, or `turn_aborted` with a `reason` ("interrupted"). The turn ids are
//   the ones its UserPromptSubmit hook named as `turn_id`.
// - A usage limit is `codex_error_info: "usage_limit_exceeded"` with Codex's
//   own words ("You’ve hit your usage limit. … or try again at 11:21 AM.",
//   limits.ts). The turn's `token_count` carries the account's windows as the
//   server sent them (`rate_limits.primary`/`secondary`: `used_percent`,
//   `resets_at` in seconds).
// The screen is never read for any of this: an agent can print anything.

export type CodexTurnEnd =
  | { kind: 'completed' }
  /** `info` is Codex's `codex_error_info` ("usage_limit_exceeded", "server_overloaded", …); `at` is when it ended, in ms. */
  | { kind: 'failed'; info: string | null; message: string; at: number | null }
  | { kind: 'aborted'; reason: string | null };

/** What one rollout line says about a turn: how it ended, or until when its account's full windows stay full. */
export type CodexRolloutFact = { end: CodexTurnEnd } | { fullUntil: number | null };

/** A rollout line longer than this is never a turn's end or a token count, and is not parsed. */
const MAX_LINE = 1024 * 1024;

/**
 * Read one rollout line for the turn `turnId`. Null for anything that says
 * nothing about it, including another turn's end. Lines are checked by
 * substring before any parse: a tool's output can make one megabytes long.
 */
export function codexRolloutLine(line: string, turnId: string): CodexRolloutFact | null {
  if (line.length > MAX_LINE || !line.includes('"event_msg"')) return null;
  const counted = line.includes('"token_count"');
  if (!counted && !(line.includes(turnId) && (line.includes('"task_complete"') || line.includes('"turn_aborted"')))) return null;
  let record: unknown;
  try { record = JSON.parse(line); } catch { return null; }
  const r = record && typeof record === 'object' ? record as { type?: unknown; payload?: unknown } : null;
  const p = r?.type === 'event_msg' && r.payload && typeof r.payload === 'object' ? r.payload as Record<string, unknown> : null;
  if (!p) return null;
  if (p.type === 'token_count') return { fullUntil: fullUntil(p.rate_limits) };
  if (p.turn_id !== turnId) return null;
  if (p.type === 'turn_aborted') return { end: { kind: 'aborted', reason: typeof p.reason === 'string' ? p.reason : null } };
  if (p.type !== 'task_complete') return null;
  const error = p.error && typeof p.error === 'object' ? p.error as { message?: unknown; codex_error_info?: unknown } : null;
  if (!error) return { end: { kind: 'completed' } };
  const info = error.codex_error_info;
  return {
    end: {
      kind: 'failed',
      // A unit variant is a string; one with fields is an object keyed by its name.
      info: typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] ?? null : null,
      message: typeof error.message === 'string' ? error.message.slice(0, 2000) : '',
      at: typeof p.completed_at === 'number' && Number.isFinite(p.completed_at) ? p.completed_at * 1000 : null,
    },
  };
}

/** When the windows a token count reports as full reset (the latest of them), or null when none is full. */
function fullUntil(limits: unknown): number | null {
  const l = limits && typeof limits === 'object' ? limits as { primary?: unknown; secondary?: unknown } : null;
  const resets = [l?.primary, l?.secondary].flatMap((w) => {
    const x = w && typeof w === 'object' ? w as { used_percent?: unknown; resets_at?: unknown } : null;
    return x && typeof x.used_percent === 'number' && x.used_percent >= 100 && typeof x.resets_at === 'number' && Number.isFinite(x.resets_at)
      ? [x.resets_at * 1000] : [];
  });
  return resets.length ? Math.max(...resets) : null;
}
