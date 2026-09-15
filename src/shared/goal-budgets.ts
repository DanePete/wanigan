/**
 * Goal loop budgets that hand the work back to a person.
 *
 * A goal's implement → verify → review graph can go round: a reviewer asks for
 * changes, the implementation is reopened, autopilot dispatches it again. With
 * nobody watching, "again" has no natural end, and each round spends. The
 * pattern here is Gemini CLI's PR generator (e-google.md §C8: "a strict turn
 * budget (maximum 3 turns)", "patches exceeding 500 lines are routed to
 * NEEDS_HUMAN"): optional per-goal limits, and when one is exceeded the task is
 * held with a named reason instead of dispatched.
 *
 * Two limits, each optional and each measured rather than estimated:
 *   · rounds — how many times an implementation task of the goal has been
 *     dispatched. A person sets it; 3 is offered when they turn it on.
 *   · changed lines — lines added plus removed in the implementation worktree,
 *     by `git diff --numstat` against the commit the goal was created on, plus
 *     the lines of untracked files. A binary file counts no lines, and says so.
 *
 * What holds is a reason code the Board and Control print as written, never a
 * score: `needs-human: attempts` or `needs-human: diff size`.
 */

export const DEFAULT_MAX_ROUNDS = 3;
export const MAX_ROUNDS_LIMIT = 50;
export const MAX_LINES_LIMIT = 1_000_000;

export type HoldReason = 'needs-human: attempts' | 'needs-human: diff size';
export const HOLD_REASONS: readonly HoldReason[] = ['needs-human: attempts', 'needs-human: diff size'];

export type GoalLoopBudgets = {
  /** Implementation dispatches allowed; null means no limit. */
  maxRounds: number | null;
  /** Changed lines allowed in the implementation worktree; null means no limit. */
  maxChangedLines: number | null;
};

export type GoalHold = {
  reason: HoldReason;
  /** The observed numbers behind the hold, as a sentence. */
  detail: string;
  at: number;
};

/** What was measured for a goal when a dispatch was considered. */
export type LoopMeasure = {
  /** Implementation dispatches recorded so far. */
  implementRounds: number;
  /** Null when there is no implementation worktree to measure, or git could not answer. */
  changedLines: number | null;
  /** Binary files in the diff, which count no lines. */
  binaryFiles?: number;
};

/**
 * Read a budget pair from untrusted input. A value that is not a whole number
 * in range is refused rather than clamped: a limit the operator did not type is
 * not a limit they set.
 */
export function parseLoopBudgets(input: unknown): GoalLoopBudgets {
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const whole = (value: unknown, max: number, label: string): number | null => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
      throw new Error(`${label} must be a whole number from 1 to ${max.toLocaleString('en-US')}, or no limit.`);
    }
    return value;
  };
  return {
    maxRounds: whole(raw.maxRounds, MAX_ROUNDS_LIMIT, 'The rounds limit'),
    maxChangedLines: whole(raw.maxChangedLines, MAX_LINES_LIMIT, 'The changed-lines limit'),
  };
}

export type DispatchVerdict = { hold: null } | { hold: HoldReason; detail: string };

/**
 * Whether one task may be dispatched under its goal's budgets.
 *
 * Rounds are asked of implementation tasks only: dispatching a verify task
 * does not start another round, it checks the one that ran. Diff size is asked
 * of every task once there is a worktree to measure, because a verify or review
 * dispatched over an oversized change spends on work a person should look at
 * first. Attempts are checked before diff size, so a goal over both limits is
 * held for the one that a larger line limit would not fix.
 */
export function dispatchVerdict(kind: 'plan' | 'implement' | 'verify' | 'review', budgets: GoalLoopBudgets, measure: LoopMeasure): DispatchVerdict {
  if (kind === 'implement' && budgets.maxRounds !== null && measure.implementRounds >= budgets.maxRounds) {
    const n = measure.implementRounds;
    return {
      hold: 'needs-human: attempts',
      detail: `${n} implementation ${n === 1 ? 'round has' : 'rounds have'} run and this goal allows ${budgets.maxRounds}. Another round needs a person: review what the last one produced, then raise or remove the limit.`,
    };
  }
  if (budgets.maxChangedLines !== null && measure.changedLines !== null && measure.changedLines > budgets.maxChangedLines) {
    const binary = measure.binaryFiles ? ` ${measure.binaryFiles} binary ${measure.binaryFiles === 1 ? 'file is' : 'files are'} not counted.` : '';
    return {
      hold: 'needs-human: diff size',
      detail: `The implementation worktree has ${measure.changedLines.toLocaleString('en-US')} changed lines against the goal’s base, over this goal’s limit of ${budgets.maxChangedLines.toLocaleString('en-US')}.${binary} A person should look at the change before anything else is dispatched on it.`,
    };
  }
  return { hold: null };
}

/**
 * `git diff --numstat -z` totals: added plus removed per file, binary files
 * (`-\t-`) counted apart. Renames are not requested, so every record is
 * "added\tremoved\tpath\0".
 */
export function numstatTotals(out: string): { lines: number; files: number; binary: number } {
  let lines = 0; let files = 0; let binary = 0;
  for (const record of out.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(record);
    if (!m) continue;
    files++;
    if (m[1] === '-' || m[2] === '-') { binary++; continue; }
    lines += Number(m[1]) + Number(m[2]);
  }
  return { lines, files, binary };
}

export function isHoldReason(value: unknown): value is HoldReason {
  return typeof value === 'string' && (HOLD_REASONS as readonly string[]).includes(value);
}
