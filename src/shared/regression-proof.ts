/**
 * Fails before, passes after: the pair of runs that makes a test evidence of a
 * fix rather than evidence that the suite is green.
 *
 * A test that passes at head says the code does what the test checks. It says
 * nothing about whether the change under review is what made it pass — a test
 * that also passed before the change is not a regression proof, however green
 * it is. Running the same command at the implementation's base commit and at
 * its head, and recording both, is the difference. When the run before cannot
 * happen, or cannot be trusted to have exercised the code, that is recorded in
 * words as a proof gap instead of being scored as a failure.
 *
 * There is no model call anywhere in this. The classification is exit codes
 * and, for the "could not run" case, a short list of output shapes that mean
 * the environment was missing rather than the test failing.
 */

export type ProofRun = {
  /** git's revision the command ran against. */
  commit: string | null;
  /** Null when there was no exit status: never started, killed, timed out. */
  exitCode: number | null;
  durationMs: number;
  /** The last part of combined output, capped. */
  outputTail: string;
  /** Why this run did not happen at all, when it did not. */
  notRun: string | null;
};

export type ProofVerdict = 'proved' | 'not-a-regression-proof' | 'still-failing' | 'could-not-run-before' | 'could-not-run-after';

export const PROOF_VERDICT_LABEL: Record<ProofVerdict, string> = {
  'proved': 'proved: fails before, passes after',
  'not-a-regression-proof': 'not a regression proof: it passes before the change too',
  'still-failing': 'still failing after the change',
  'could-not-run-before': 'could not run before',
  'could-not-run-after': 'could not run after',
};

export const MAX_PROOF_COMMAND_CHARS = 2_000;
export const OUTPUT_TAIL_CHARS = 4_000;

/**
 * Output that says the command never reached the code under test: a missing
 * command, module or file. A run like that "fails before" for a reason that
 * has nothing to do with the change, and calling the pair "proved" would be the
 * exact overstatement this record exists to prevent.
 */
const ENVIRONMENT_FAILURE: { re: RegExp; why: string }[] = [
  // The shell's own words, not a test's: a test that fails on a missing file
  // may be exactly the bug being fixed, so only a line the shell printed counts.
  { re: /command not found|^(?:\S*\/)?(?:ba|z|da|k|)sh: .*no such file or directory/im, why: 'the output says the shell could not find a command or script' },
  { re: /Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/, why: 'the output says a Node module was missing' },
  { re: /ModuleNotFoundError|No module named/, why: 'the output says a Python module was missing' },
  { re: /Missing script: /, why: 'the output says the npm script does not exist at that commit' },
  { re: /cannot find package|no required module provides package/i, why: 'the output says a Go package was missing' },
];

/** Why a finished run should not count as having run the tests, or null when it did. */
export function couldNotRun(run: ProofRun): string | null {
  if (run.notRun) return run.notRun;
  if (run.exitCode === null) return 'the command did not exit on its own (it was killed or timed out)';
  if (run.exitCode === 126 || run.exitCode === 127) return `the shell exited ${run.exitCode}, which means the command could not be executed`;
  if (run.exitCode !== 0) {
    const hit = ENVIRONMENT_FAILURE.find((e) => e.re.test(run.outputTail));
    if (hit) return hit.why;
  }
  return null;
}

export function classifyProof(before: ProofRun, after: ProofRun): { verdict: ProofVerdict; because: string } {
  const beforeGap = couldNotRun(before);
  if (beforeGap) return { verdict: 'could-not-run-before', because: `At the base commit ${beforeGap}.` };
  const afterGap = couldNotRun(after);
  if (afterGap) return { verdict: 'could-not-run-after', because: `At head ${afterGap}.` };
  if (before.exitCode === 0) {
    return { verdict: 'not-a-regression-proof', because: 'The command exited 0 at the base commit as well as at head, so it does not show that this change made it pass.' };
  }
  if (after.exitCode !== 0) {
    return { verdict: 'still-failing', because: `The command exited ${before.exitCode} at the base commit and ${after.exitCode} at head.` };
  }
  return { verdict: 'proved', because: `The command exited ${before.exitCode} at the base commit and 0 at head.` };
}

/** The last `max` characters, cut at a line start where one is near. */
export function outputTail(text: string, max = OUTPUT_TAIL_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  const nl = cut.indexOf('\n');
  return nl >= 0 && nl < 200 ? cut.slice(nl + 1) : cut;
}

/** A proof command from the renderer, checked before it reaches a consent dialog. */
export function validateProofCommand(raw: unknown): { ok: true; command: string } | { ok: false; reason: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'Name one test command.' };
  const command = raw.trim();
  if (command.length > MAX_PROOF_COMMAND_CHARS) return { ok: false, reason: `Keep the command under ${MAX_PROOF_COMMAND_CHARS.toLocaleString('en-US')} characters.` };
  if (/[\x00\r]/.test(command)) return { ok: false, reason: 'The command contains a character a shell line cannot carry.' };
  if (command.includes('\n')) return { ok: false, reason: 'Name one command on one line; a regression proof runs a single test.' };
  return { ok: true, command };
}
