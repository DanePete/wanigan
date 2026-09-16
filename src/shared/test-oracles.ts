/**
 * How much a passing gate can be taken to prove about the change it ran on.
 *
 * A green review gate says the commands exited 0. It does not say the tests
 * would have caught the bug. The September research found two ways agent work
 * weakens that link: 80.2% of test-file patches in agent pull requests carried
 * weak or no explicit oracle (arXiv 2606.18168), and tests from an agent on
 * the same base model lowered the solve rate when used to judge its patches,
 * because "when the same trajectory writes both the patch and the test, their
 * errors can agree" (arXiv 2609.09133). Two shapes are cheap to see from a
 * diff and are flagged here:
 *
 *  - tests edited alongside the code: the gate may be checking the change
 *    against expectations the same change just rewrote;
 *  - a test file whose added lines hold no assertion: it runs, and proves
 *    only that it runs.
 *
 * Both are heuristics over file paths and added lines, labelled as that
 * wherever they appear. A flag never fails a gate or blocks a decision. It is
 * a reason for the reviewer to look closer, never a verdict.
 */

import type { OracleFlag, OracleReading } from './types.ts';

export type { OracleFlag, OracleReading };

export type ChangedFile = { path: string; addedLines: string[] };

const TEST_PATH = /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb|exs?)$|(^|\/)test_[^/]+\.py$|Tests?\.(swift|kt|java|cs)$/;
const CODE_EXT = /\.(c|cc|cpp|cs|cts|cjs|go|h|hpp|java|js|jsx|kt|mjs|mts|php|py|rb|rs|swift|ts|tsx|vue|svelte|ex|exs|scala)$/;

/**
 * Words and calls that make a test line an assertion, across the frameworks
 * this app's users write in. Deliberately generous: a miss here would raise a
 * false "no assertion" flag, which is the worse error for a heuristic that
 * points a reviewer at a file.
 */
const ASSERTION = /\b(assert\w*|expect\w*|should|must|require\.\w+|check|verify|toBe|toEqual|toMatch|toThrow|toHave\w*|equal|deepEqual|strictEqual|ok|throws|rejects|fail|XCTAssert\w*|XCTFail|assertThat|t\.(is|not|true|false|deepEqual|throws|Error|Errorf|Fatal|Fatalf|Fail|FailNow)|self\.assert\w*|pytest\.raises|refute\w*|panic)\b/;

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path.replace(/\\/g, '/'));
}

export function isCodePath(path: string): boolean {
  const normal = path.replace(/\\/g, '/');
  return CODE_EXT.test(normal) && !isTestPath(normal);
}

export function readOracles(changed: readonly ChangedFile[]): OracleReading {
  const tests = changed.filter((file) => isTestPath(file.path) && CODE_EXT.test(file.path.replace(/\\/g, '/')));
  const code = changed.filter((file) => isCodePath(file.path));
  const flags: OracleFlag[] = [];
  if (tests.length && code.length) flags.push({ kind: 'tests-edited-with-code', testFiles: tests.length, codeFiles: code.length });
  for (const test of tests) {
    const added = test.addedLines.filter((line) => line.trim() && !/^\s*(\/\/|#|\*|\/\*)/.test(line));
    if (added.length && !added.some((line) => ASSERTION.test(line))) flags.push({ kind: 'test-without-assertion', path: test.path });
  }
  return { testFiles: tests.length, codeFiles: code.length, flags };
}

/** One line per flag, for a reviewer. */
export function oracleSentence(flag: OracleFlag): string {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  return flag.kind === 'tests-edited-with-code'
    ? `Tests changed in the same change as the code (${plural(flag.testFiles, 'test file')}, ${plural(flag.codeFiles, 'code file')}), so this pass may be checking the code against expectations the change itself rewrote.`
    : `${flag.path} gained test lines with no assertion Wanigan recognises, so it may prove only that it runs.`;
}

/** Split `git diff --unified=0` output into the added lines of each file. */
export function changedFilesFromDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: ChangedFile | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) { current = null; continue; }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).replace(/\t.*$/, '');
      if (target === '/dev/null') { current = null; continue; }
      current = { path: target.replace(/^b\//, ''), addedLines: [] };
      files.push(current);
      continue;
    }
    if (line.startsWith('--- ')) continue;
    if (current && line.startsWith('+')) current.addedLines.push(line.slice(1));
  }
  return files;
}
