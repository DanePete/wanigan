/**
 * Session anatomy: where a session's time and context went, computed from the
 * hook bus and recorded usage. Every value says whether it is observed (the
 * number is a recorded fact) or inferred (recorded timestamps, read as a
 * meaning they do not themselves state).
 *
 *  - Orientation: start to the first completed edit. Observed timestamps.
 *  - In edits and commands: the durations the hooks measured for completed
 *    Edit/Write/MultiEdit/NotebookEdit and Bash calls. Observed.
 *  - Waiting on the operator: a permission request until the event that
 *    settles it, plus a turn's Stop until the next prompt. The gaps are
 *    observed; that the operator is the reason for them is inferred.
 *  - Peak context: the largest input + cache read + cache write of any one
 *    recorded request. Observed.
 *  - Compactions and subagents: counted events. Observed — or "not recorded"
 *    when the session's CLI was not asked for that event at all.
 */

export type AnatomyEvent = { at: number; event: string; tool: string | null; durationMs: number | null };

export type Measure<T> =
  | { status: 'observed' | 'inferred'; value: T; note: string | null }
  | { status: 'not-recorded'; value: null; note: string };

export type SessionAnatomy = {
  orientationMs: Measure<number>;
  editsAndCommandsMs: Measure<number>;
  waitingMs: Measure<number>;
  peakContextTokens: Measure<number>;
  compactions: Measure<number>;
  subagents: Measure<number>;
  eventCount: number;
};

const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Events that settle a permission request — the same set the attention reader uses. */
const SETTLES = new Set(['PermissionResponse', 'PermissionDenied', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd']);

export function sessionAnatomy(input: {
  startedAt: number;
  endedAt: number | null;
  now: number;
  events: readonly AnatomyEvent[];
  /** input + cache read + cache write per recorded request. */
  requestContextTokens: readonly number[];
  /** Whether the session's hook file asked for these events (version-gated). */
  askedFor: { compaction: boolean; subagents: boolean };
}): SessionAnatomy {
  const events = [...input.events].sort((a, b) => a.at - b.at);
  const end = input.endedAt ?? input.now;

  const firstEdit = events.find((e) => e.event === 'PostToolUse' && e.tool !== null && EDITS.has(e.tool));
  const orientationMs: Measure<number> = events.length === 0
    ? { status: 'not-recorded', value: null, note: 'No hook events were recorded for this session.' }
    : firstEdit
      ? { status: 'observed', value: Math.max(0, firstEdit.at - input.startedAt), note: null }
      : { status: 'observed', value: Math.max(0, end - input.startedAt), note: 'No edit yet: the whole session so far.' };

  let working = 0;
  let unmeasured = 0;
  for (const e of events) {
    if (e.event !== 'PostToolUse' || !e.tool || !(EDITS.has(e.tool) || e.tool === 'Bash')) continue;
    if (typeof e.durationMs === 'number' && e.durationMs >= 0) working += e.durationMs;
    else unmeasured += 1;
  }
  const editsAndCommandsMs: Measure<number> = events.length === 0
    ? { status: 'not-recorded', value: null, note: 'No hook events were recorded for this session.' }
    : { status: 'observed', value: working, note: unmeasured ? `${unmeasured} calls carried no duration and are not counted.` : null };

  let waiting = 0;
  let open: number | null = null;
  let stoppedAt: number | null = null;
  for (const e of events) {
    if (open !== null && SETTLES.has(e.event)) { waiting += Math.max(0, e.at - open); open = null; }
    if (e.event === 'PermissionRequest' && open === null) open = e.at;
    if (e.event === 'UserPromptSubmit' && stoppedAt !== null) { waiting += Math.max(0, e.at - stoppedAt); stoppedAt = null; }
    if (e.event === 'Stop' || e.event === 'StopFailure') stoppedAt = e.at;
  }
  // A question still standing counts to now; a finished turn with no next
  // prompt is not waiting — the session may simply be done.
  if (open !== null && input.endedAt === null) waiting += Math.max(0, input.now - open);
  const waitingMs: Measure<number> = events.length === 0
    ? { status: 'not-recorded', value: null, note: 'No hook events were recorded for this session.' }
    : { status: 'inferred', value: waiting, note: 'Permission requests until settled, and a turn’s end until the next prompt.' };

  const peak = input.requestContextTokens.reduce((m, t) => Math.max(m, t), 0);
  const peakContextTokens: Measure<number> = input.requestContextTokens.length === 0
    ? { status: 'not-recorded', value: null, note: 'No request usage was recorded for this session.' }
    : { status: 'observed', value: peak, note: null };

  const count = (names: string[]) => events.filter((e) => names.includes(e.event)).length;
  const compactions: Measure<number> = input.askedFor.compaction || count(['PreCompact', 'PostCompact']) > 0
    ? { status: 'observed', value: Math.max(count(['PreCompact']), count(['PostCompact'])), note: null }
    : { status: 'not-recorded', value: null, note: 'This session’s CLI was not asked for compaction events.' };
  const subagents: Measure<number> = input.askedFor.subagents || count(['SubagentStart']) > 0
    ? { status: 'observed', value: count(['SubagentStart']), note: null }
    : { status: 'not-recorded', value: null, note: 'This session’s CLI was not asked for subagent events.' };

  return { orientationMs, editsAndCommandsMs, waitingMs, peakContextTokens, compactions, subagents, eventCount: events.length };
}
