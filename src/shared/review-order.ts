/**
 * Review order and test alarms, from paths and diff text alone.
 *
 * Practitioners who review agent diffs converge on one habit: read the tests
 * first, then the schema, then the code. The tests say what the change claims
 * to do, and a schema change is the part that is hardest to take back. So the
 * default order here is tests, then schema and migrations, then everything
 * else, each group in path order.
 *
 * The alarms are the ways a diff can make tests pass without making the code
 * right: an assertion removed or loosened, a test skipped or focused, a
 * snapshot rewritten, a test file deleted. Each is a labelled fact with the
 * line that raised it. None is a verdict — a deleted test can be the right
 * change — and none is folded into a score.
 */
import { parseUnifiedDiff } from './review-notes.ts';

export type FileKind = 'test' | 'schema' | 'other';

const TEST_DIR = /(^|\/)(__tests__|__mocks__|tests?|specs?|e2e|cypress|playwright)\//i;
const TEST_FILE = [
  /\.(test|spec|cy|e2e)\.[cm]?[jt]sx?$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /_test\.(py|go|rb|exs?)$/i,
  /_spec\.rb$/i,
  /Tests?\.(java|kt|kts|cs|php|swift|scala)$/,
  /\.(snap)$/i,
];
const SNAPSHOT = /(^|\/)__snapshots__\/|\.snap$/i;
const SCHEMA_DIR = /(^|\/)(migrations?|migrate|alembic|schemas?|prisma|db\/migrate|database\/migrations|flyway|liquibase)\//i;
const SCHEMA_FILE = [
  /(^|\/)schema\.(prisma|graphql|gql|sql|rb|json|ts|py)$/i,
  /\.(sql|prisma|graphql|gql)$/i,
  /(^|\/)structure\.sql$/i,
];

export function fileKind(path: string): FileKind {
  if (TEST_DIR.test(path) || TEST_FILE.some((re) => re.test(path))) return 'test';
  if (SCHEMA_DIR.test(path) || SCHEMA_FILE.some((re) => re.test(path))) return 'schema';
  return 'other';
}

export const FILE_KIND_LABEL: Record<FileKind, string> = { test: 'test', schema: 'schema', other: 'code' };

export type ReviewOrderMode = 'review' | 'path';

const RANK: Record<FileKind, number> = { test: 0, schema: 1, other: 2 };

/** A new array: tests, then schema, then the rest, each in path order; or plain path order. */
export function orderForReview<T extends { path: string }>(files: readonly T[], mode: ReviewOrderMode = 'review'): T[] {
  return [...files].sort((a, b) => {
    if (mode === 'review') {
      const byKind = RANK[fileKind(a.path)] - RANK[fileKind(b.path)];
      if (byKind) return byKind;
    }
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

export type TestAlarmKind = 'assertions-removed' | 'skip-added' | 'only-added' | 'snapshot-rewritten' | 'test-deleted';

export type TestAlarm = {
  kind: TestAlarmKind;
  label: string;
  /** The new-side line for an added line, the old-side line for a removed one; null for a whole-file alarm. */
  line: number | null;
  /** The line that raised it, as it appears in the diff. */
  text: string | null;
};

/**
 * An assertion, in the spellings the common test runners use. Deliberately a
 * word match rather than a parse: a removed `expect(` is the signal, whatever
 * follows it.
 */
const ASSERTION = /\b(expect|assert[A-Za-z_]*|should|XCTAssert[A-Za-z]*|assertThat|t\.(Error|Errorf|Fatal|Fatalf|Fail|FailNow)|require\.[A-Z][A-Za-z]*|pytest\.raises|refute[A-Za-z_]*)\s*[.(!]/;
const SKIP = /(\b(describe|it|test|context|suite)\.skip\s*\(|\bx(it|describe|test)\s*\(|@pytest\.mark\.skip(if)?\b|\bpytest\.skip\s*\(|\bt\.Skip(f|Now)?\s*\(|@(Disabled|Ignore)\b|\bskip\s*\(\s*["'`]|\b(it|test)\.todo\s*\()/;
const ONLY = /(\b(describe|it|test|context|suite)\.only\s*\(|\bf(it|describe)\s*\()/;

/**
 * Alarms for one file's diff. `status` is git's name-status letter; `patch` is
 * that file's unified diff, which may be empty for a deleted binary.
 */
export function testAlarms(path: string, status: string, patch: string): TestAlarm[] {
  const alarms: TestAlarm[] = [];
  const kind = fileKind(path);
  if (kind !== 'test') return alarms;
  const snapshot = SNAPSHOT.test(path);
  if (status.startsWith('D')) {
    alarms.push(snapshot
      ? { kind: 'snapshot-rewritten', label: 'snapshot deleted', line: null, text: null }
      : { kind: 'test-deleted', label: 'test file deleted', line: null, text: null });
    return alarms;
  }
  const rows = parseUnifiedDiff(patch, path).filter((r) => r.kind === 'add' || r.kind === 'del');
  if (snapshot) {
    const removed = rows.filter((r) => r.kind === 'del');
    if (status.startsWith('M') && removed.length > 0) {
      alarms.push({ kind: 'snapshot-rewritten', label: `snapshot rewritten (${removed.length} line${removed.length === 1 ? '' : 's'} replaced)`, line: removed[0].oldLine, text: removed[0].text });
    }
    return alarms;
  }
  const added = rows.filter((r) => r.kind === 'add');
  const removed = rows.filter((r) => r.kind === 'del');
  const addedAsserts = added.filter((r) => ASSERTION.test(r.text.slice(1)));
  const removedAsserts = removed.filter((r) => ASSERTION.test(r.text.slice(1)));
  if (removedAsserts.length > addedAsserts.length) {
    const first = removedAsserts[0];
    alarms.push({
      kind: 'assertions-removed',
      label: `${removedAsserts.length} assertion line${removedAsserts.length === 1 ? '' : 's'} removed, ${addedAsserts.length} added`,
      line: first.oldLine, text: first.text,
    });
  }
  for (const row of added) {
    const body = row.text.slice(1);
    if (SKIP.test(body)) alarms.push({ kind: 'skip-added', label: 'test skipped', line: row.newLine, text: row.text });
    if (ONLY.test(body)) alarms.push({ kind: 'only-added', label: 'test focused with .only', line: row.newLine, text: row.text });
  }
  return alarms;
}

/** Split a multi-file patch into per-file patches, keyed by the new path (or old, for a deletion). */
export function splitPatchByFile(patch: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!patch) return out;
  const chunks = patch.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git '));
  for (const chunk of chunks) {
    const rows = parseUnifiedDiff(chunk);
    const named = rows.find((r) => r.kind === 'hunk' || r.file !== null);
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    const plus = /^\+\+\+ b\/(.+?)\t?$/m.exec(chunk);
    const minus = /^--- a\/(.+?)\t?$/m.exec(chunk);
    const file = plus?.[1] ?? minus?.[1] ?? header?.[2] ?? named?.file ?? null;
    if (file) out.set(file, (out.get(file) ?? '') + chunk);
  }
  return out;
}
