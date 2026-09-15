/**
 * Holding an unattended call for a person, instead of refusing it.
 *
 * An 'ask' on a headless run has nobody to answer it, so Wanigan denies it
 * (policy.ts nobodyToAsk). Claude Code has a better answer for print mode: a
 * PreToolUse hook may return `permissionDecision: "defer"`. The run then ends
 * with `terminal_reason: "tool_deferred"` and a `deferred_tool_use` record
 * ({ id, name, input }). Once someone has answered, `claude -p --resume <id>`
 * with no prompt re-emits that exact call through PreToolUse, where the answer
 * is given.
 *
 * Every constraint below was read out of the 2.1.271 binary, not the docs:
 *  - Print mode only. An interactive session logs the defer and ignores it.
 *  - One call at a time. When the model asked for several tools in one batch,
 *    the CLI ignores the defer ("siblings would be orphaned on resume") and the
 *    call goes through the CLI's own permission rules instead, which may allow
 *    it. That is why holding is opted into per run and never the default: a
 *    plain deny cannot be ignored that way.
 *  - `--resume` does not restore the permission mode; it must be passed again,
 *    and a mismatch is only a warning in the CLI, so Wanigan refuses it itself.
 *  - Resuming with an empty prompt works only while the marker is there.
 *    Otherwise the CLI says "No deferred tool marker found in the resumed
 *    session".
 *
 * No changelog entry dates the feature, so the floor is the binary it was
 * verified in. Older CLIs keep today's denial.
 */

export const DEFER_SINCE = '2.1.271';

function parts(version: string | null | undefined): [number, number, number] | null {
  const match = typeof version === 'string' ? /(\d+)\.(\d+)\.(\d+)/.exec(version) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Whether a probed `claude --version` line is at or past the release defer was verified in. */
export function cliSupportsDefer(version: string | null | undefined): boolean {
  const have = parts(version);
  const want = parts(DEFER_SINCE)!;
  if (!have) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== want[i]) return have[i] > want[i];
  }
  return true;
}

export type DeferredToolUse = { id: string; name: string; input: Record<string, unknown> };

export type DeferredOutcome = {
  /** Why the query loop ended, as the CLI named it; null when it named nothing. */
  terminalReason: string | null;
  /** The CLI conversation to resume. */
  sessionId: string | null;
  deferred: DeferredToolUse | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * The deferral facts in a print-mode result object. A shape it does not
 * recognise answers nulls: a run is held only when the CLI said so in exactly
 * these fields, never on a guess.
 */
export function readDeferredOutcome(result: unknown): DeferredOutcome {
  if (!isRecord(result)) return { terminalReason: null, sessionId: null, deferred: null };
  const terminalReason = text(result.terminal_reason) ?? (text(result.stop_reason) === 'tool_deferred' ? 'tool_deferred' : null);
  const record = result.deferred_tool_use;
  const deferred = isRecord(record) && text(record.id) && text(record.name)
    ? { id: text(record.id)!, name: text(record.name)!, input: isRecord(record.input) ? record.input : {} }
    : null;
  return { terminalReason, sessionId: text(result.session_id), deferred };
}

export const HELD_INPUT_MAX = 600;

/**
 * One line a person can decide on. The command for a shell call, the path for
 * a file tool, the URL for a fetch, and otherwise the input as JSON. Always
 * bounded, because it is the agent's text and it is shown and stored. The
 * caller redacts credentials before this line reaches a screen or the database.
 */
export function heldCallSummary(name: string, input: Record<string, unknown>): string {
  const pick = (...keys: string[]) => keys.map((key) => text(input[key])).find((value) => value !== null) ?? null;
  const direct = name === 'Bash' ? pick('command')
    : ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Read'].includes(name) ? pick('file_path', 'notebook_path', 'path')
      : name === 'WebFetch' ? pick('url')
        : null;
  let line = direct ?? (() => { try { return JSON.stringify(input); } catch { return '(input could not be shown)'; } })();
  line = line.replace(/\s+/g, ' ').trim();
  return line.length > HELD_INPUT_MAX ? `${line.slice(0, HELD_INPUT_MAX - 1)}…` : line;
}
