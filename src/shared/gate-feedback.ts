import type { AttentionKind, SessionStatus } from './types.ts';

/**
 * What of a failed review gate goes back to the agent that caused it, and when
 * Wanigan is allowed to send it.
 *
 * A goal can opt in to having its gate run each time an agent stops, and
 * separately to having a failure typed back into that agent's session. The
 * second one starts another agent turn, which spends tokens, so it is capped
 * per task and refused whenever the session is not plainly waiting at the
 * prompt it stopped at. Everything that decides it is here, where it can be
 * tested without a terminal.
 */

/** Automatic hand-backs a task gets before failures wait for the operator. */
export const HANDBACK_LIMIT = 2;
/** Lines of gate output a hand-back carries at most. */
export const EXCERPT_MAX_LINES = 60;
/** Characters of gate output a hand-back carries at most. */
export const EXCERPT_MAX_CHARS = 4_000;
const LINE_MAX_CHARS = 300;
/** Lines kept from the end when nothing in the output looks like an error. */
const TAIL_LINES = 40;

// CSI, OSC and two-byte escape sequences, removed whole so nothing of a colour
// code survives as stray text.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * Text that is safe to type into a terminal as content.
 *
 * Gate output is arbitrary bytes from the project's own commands. Pasted
 * unfiltered, an ESC inside it could close the bracketed paste early
 * (`ESC [201~`), and whatever followed would reach the agent's prompt as
 * keystrokes rather than as text. So every control character goes except
 * newline and tab, and carriage returns become newlines.
 */
export function terminalSafe(text: string): string {
  return text.replace(ANSI, '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

/** Lines that usually carry the reason a check failed, across common toolchains. */
const SIGNAL = /\b(error|errors|failed|failing|failure|fail|fatal|panic|exception|traceback|assertion|expected|received|not ok|cannot|undefined reference)\b|ERR!|✗|✖|\bTS\d{4}\b|^\s*FAIL\b|^\s*at\s.+:\d+/i;

export type FailureExcerpt = {
  text: string;
  /** Lines in the excerpt, not counting gap markers. */
  shownLines: number;
  totalLines: number;
  /** Whether lines that matched were left out to fit the limits. */
  cut: boolean;
  /** Whether the excerpt is the matched lines or, with none, the output's end. */
  from: 'signals' | 'tail';
};

/**
 * The lines of a failed command's output worth handing back.
 *
 * Only what looks like an error, with a line of context before and two after,
 * because a whole test log would bury the failure and spend the agent's
 * context on passing tests. With no line that looks like one, the end of the
 * output is kept instead: that is where most runners print their summary.
 */
export function failureExcerpt(output: string): FailureExcerpt {
  const lines = terminalSafe(output).split('\n').map((line) => line.length > LINE_MAX_CHARS ? `${line.slice(0, LINE_MAX_CHARS - 1)}…` : line);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const total = lines.length;
  const hits = lines.flatMap((line, index) => SIGNAL.test(line) ? [index] : []);
  if (!hits.length) {
    const tail = lines.slice(-TAIL_LINES);
    return fit(tail.map((line) => ({ line, gap: false })), total, 'tail', total > tail.length);
  }
  const keep = new Set<number>();
  for (const at of hits) for (let index = Math.max(0, at - 1); index <= Math.min(total - 1, at + 2); index++) keep.add(index);
  const rows: { line: string; gap: boolean }[] = [];
  let previous = -1;
  for (const index of [...keep].sort((a, b) => a - b)) {
    if (previous >= 0 && index > previous + 1) rows.push({ line: '…', gap: true });
    rows.push({ line: lines[index], gap: false });
    previous = index;
  }
  return fit(rows, total, 'signals', false);
}

function fit(rows: { line: string; gap: boolean }[], total: number, from: FailureExcerpt['from'], alreadyCut: boolean): FailureExcerpt {
  const kept: string[] = [];
  let chars = 0; let shown = 0; let cut = alreadyCut;
  for (const row of rows) {
    if (!row.gap && shown >= EXCERPT_MAX_LINES) { cut = true; break; }
    if (chars + row.line.length + 1 > EXCERPT_MAX_CHARS) { cut = true; break; }
    kept.push(row.line); chars += row.line.length + 1;
    if (!row.gap) shown++;
  }
  while (kept.length && kept[kept.length - 1] === '…') kept.pop();
  return { text: kept.join('\n'), shownLines: shown, totalLines: total, cut, from };
}

/** The message typed into the session. Plain text; no instruction is hidden in it. */
export function handBackPrompt(input: {
  command: string; exitCode: number | null; excerpt: FailureExcerpt; attempt: number;
}): string {
  const command = terminalSafe(input.command).replace(/\s+/g, ' ').trim();
  const ended = input.exitCode === null ? 'was stopped before it exited' : `exited with code ${input.exitCode}`;
  const which = input.excerpt.from === 'signals'
    ? 'These are the lines of its output that look like errors'
    : 'Nothing in its output looked like an error line, so this is the end of it';
  const last = input.attempt >= HANDBACK_LIMIT;
  return [
    'Wanigan ran this goal’s review gate after you stopped, and it failed.',
    `\`${command}\` ${ended}. ${which}${input.excerpt.cut ? ', cut to fit' : ''}:`,
    input.excerpt.text,
    'Fix what the gate reports. Do not weaken, skip or delete a test to make it pass. '
      + 'When you stop, Wanigan runs the gate again.',
    `This is hand-back ${input.attempt} of ${HANDBACK_LIMIT} for this task. `
      + (last ? 'It is the last one: a later failure waits for the operator.' : 'After the last one, a failure waits for the operator.'),
  ].join('\n\n');
}

/**
 * The bytes a hand-back writes: one bracketed paste, then Enter as a separate
 * write. The same framing the Composer uses for a multi-line send, so the
 * agent's prompt reads interior newlines as text rather than as submits.
 */
export function pasteFrames(text: string): [string, string] {
  return [`\x1b[200~${terminalSafe(text)}\x1b[201~`, '\r'];
}

export type HandBackRefusal = 'off' | 'halted' | 'limit' | 'cap' | 'session-gone' | 'moved-on';
export type HandBackVerdict =
  | { send: true; attempt: number }
  | { send: false; reason: HandBackRefusal; sentence: string };

/**
 * Whether a failed gate may be typed back into the session that stopped.
 *
 * "Moved on" is the refusal that protects the operator: the gate can take
 * minutes, and in that time the person may have typed a new prompt or the
 * agent may be showing a permission question. Text followed by Enter typed
 * over a permission question answers it. So the session has to still be in
 * exactly the state the triggering Stop left it in, which is what the
 * attention transition id names.
 */
export function handBackVerdict(input: {
  enabled: boolean;
  halted: boolean;
  returnsSoFar: number;
  budgetUsd: number | null;
  spendUsd: number;
  sessionStatus: SessionStatus | null;
  attention: { kind: AttentionKind; transitionId: string } | null;
  stopEventId: number;
}): HandBackVerdict {
  const no = (reason: HandBackRefusal, sentence: string): HandBackVerdict => ({ send: false, reason, sentence });
  if (!input.enabled) return no('off', 'Hand-back is off for this goal, so the failure waits here for you.');
  if (input.halted) return no('halted', 'Wanigan is halted, so nothing was sent to the agent.');
  if (input.returnsSoFar >= HANDBACK_LIMIT) {
    return no('limit', `This task has already had ${HANDBACK_LIMIT} failures handed back since it started, so this one waits for you.`);
  }
  if (input.budgetUsd !== null && input.spendUsd >= input.budgetUsd) {
    return no('cap', 'This goal’s reported spend has reached its cap, so Wanigan did not start another agent turn.');
  }
  if (input.sessionStatus !== 'running') return no('session-gone', 'The session is no longer running, so there was nobody to hand the failure to.');
  if (!input.attention || input.attention.kind !== 'finished' || input.attention.transitionId !== `event:${input.stopEventId}`) {
    return no('moved-on', 'The session moved on after it stopped, so the failure was not typed over whatever it is doing now.');
  }
  return { send: true, attempt: input.returnsSoFar + 1 };
}
