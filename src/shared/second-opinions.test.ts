/**
 * Second opinions, the pure half: the payload a person consents to, the reply a
 * model sends back, and the checks that stand between the two.
 *
 * PATCH is shaped exactly as `git diff` prints it: a modified file with a hunk
 * starting at line 10, a new file, and a deleted file. The line numbers matter —
 * a finding or a decision is only as good as the lines it points at.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPINION_LIMITS, REVIEW_SCHEMA, DECISIONS_SCHEMA, adjudicationCounts, buildDecisionsPayload, buildReviewPayload, capDiff, capMessages,
  checkDecisions, costLabel, decisionNote, droppedSentence, extractJsonObject, findingNote, indexDiff, ledgerTotals, locate,
  meteringFrom, normalizeDiffPath, parseTouch, readDecisionsReply, readReviewReply, validAdjudication, validBudget,
  type StoredDecision, type StoredFinding,
} from './second-opinions.ts';
import { formatReviewSubmission } from './review-marks.ts';

const PATCH = [
  'diff --git a/src/cart.ts b/src/cart.ts',
  'index 1111111..2222222 100644',
  '--- a/src/cart.ts',
  '+++ b/src/cart.ts',
  '@@ -10,4 +10,6 @@ export function total(items: Item[]) {',
  '   let sum = 0;',
  '-  for (const i of items) sum += i.price;',
  '+  for (const i of items) sum += i.price * i.qty;',
  '+  if (sum > 1000) sum *= 0.9;',
  '+  return Math.round(sum);',
  '   // end',
  ' }',
  'diff --git a/src/retry.ts b/src/retry.ts',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/src/retry.ts',
  '@@ -0,0 +1,3 @@',
  '+export async function retry(fn: () => Promise<void>) {',
  '+  for (let i = 0; i < 5; i++) { try { return await fn(); } catch { /* again */ } }',
  '+}',
  'diff --git a/src/old.ts b/src/old.ts',
  'deleted file mode 100644',
  'index 4444444..0000000',
  '--- a/src/old.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-export const legacy = true;',
  '-export const gone = 1;',
  '',
].join('\n');

const FILES = [
  { path: 'src/cart.ts', status: 'M', added: 3, removed: 1 },
  { path: 'src/retry.ts', status: 'A', added: 3, removed: 0 },
  { path: 'src/old.ts', status: 'D', added: 0, removed: 2 },
];

const ANCHOR = "this session's changes against 1a2b3c4d, the commit it started from";

/* ── the payload ─────────────────────────────────────────────────────── */

test('a diff under the cap is sent whole, and its byte count is the count the dialog states', () => {
  const capped = capDiff(PATCH);
  assert.equal(capped.truncated, false);
  assert.equal(capped.text, PATCH);
  assert.equal(capped.bytes, new TextEncoder().encode(PATCH).length);
  assert.equal(capped.sentBytes, capped.bytes);
});

test('a diff over the cap is cut at a whole line, and says how much was left out', () => {
  const capped = capDiff(PATCH, 200);
  assert.equal(capped.truncated, true);
  assert.ok(capped.sentBytes <= 200, `sent ${capped.sentBytes}`);
  assert.ok(capped.text.endsWith('\n'));
  assert.ok(PATCH.startsWith(capped.text), 'the cut keeps a prefix of the diff, never a spliced middle');
  // Multi-byte text counts in bytes, not characters.
  const wide = capDiff('é'.repeat(300), 100);
  assert.equal(wide.truncated, true);
  assert.equal(wide.text, '', 'a single line longer than the cap is not split mid-character');
});

test('the review prompt carries the anchor, the file list, the checks and the diff between markers — and nothing it was not given', () => {
  const payload = buildReviewPayload({ anchor: ANCHOR, files: FILES, patch: PATCH, checks: ['A retried checkout charges once.', '  '], reviewRules: null });
  assert.match(payload.prompt, /Diff: this session's changes against 1a2b3c4d/);
  assert.match(payload.prompt, /## Changed files \(3\)\n- M src\/cart\.ts \(\+3 −1\)/);
  assert.match(payload.prompt, /## Acceptance checks\n1\. A retried checkout charges once\./);
  assert.match(payload.prompt, /===== BEGIN DIFF =====\ndiff --git a\/src\/cart\.ts/);
  assert.match(payload.prompt, /-export const gone = 1;\n===== END DIFF =====/);
  assert.doesNotMatch(payload.prompt, /Code review rules/, 'no rules section when no collector supplied any');
  assert.equal(payload.checksSent.length, 1, 'a blank check is not sent');
  assert.equal(payload.reviewRulesSent, null);
  assert.equal(payload.diff.truncated, false);
  assert.match(payload.prompt, /"verdict": "approve" \| "needs-attention"/);
});

test('a review prompt over the cap says, inside the prompt, how many bytes were sent of how many', () => {
  const big = PATCH + `diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n@@ -1,1 +1,1 @@\n${'+x'.repeat(10).concat('\n').repeat(OPINION_LIMITS.diffBytes / 10)}`;
  const payload = buildReviewPayload({ anchor: ANCHOR, files: FILES, patch: big, checks: [], reviewRules: null });
  assert.equal(payload.diff.truncated, true);
  assert.match(payload.prompt, new RegExp(`## Diff \\(the first ${payload.diff.sentBytes.toLocaleString('en-US')} of ${payload.diff.bytes.toLocaleString('en-US')} bytes; the rest was not sent\\)`));
});

test('the file list is capped, and the prompt counts what it left out', () => {
  const many = Array.from({ length: OPINION_LIMITS.fileList + 7 }, (_, i) => ({ path: `f${i}.ts`, status: 'M', added: 1, removed: 0 }));
  const payload = buildReviewPayload({ anchor: ANCHOR, files: many, patch: PATCH, checks: [], reviewRules: ['Never log a token.'] });
  assert.equal(payload.filesListed, OPINION_LIMITS.fileList);
  assert.equal(payload.filesOmitted, 7);
  assert.match(payload.prompt, /… and 7 more, not listed\./);
  assert.match(payload.prompt, /## Code review rules for this scope\n- Never log a token\./);
});

test('operator messages keep the most recent that fit, in order, and count the rest', () => {
  const msgs = Array.from({ length: OPINION_LIMITS.messages + 5 }, (_, i) => `message ${i}`);
  const capped = capMessages(msgs);
  assert.equal(capped.kept.length, OPINION_LIMITS.messages);
  assert.equal(capped.omitted, 5);
  assert.equal(capped.kept.at(-1), `message ${OPINION_LIMITS.messages + 4}`);
  assert.equal(capped.kept[0], 'message 5');
  const long = capMessages(Array.from({ length: 30 }, () => 'y'.repeat(OPINION_LIMITS.messageChars + 50)));
  assert.ok(long.chars <= OPINION_LIMITS.messagesTotalChars);
  assert.ok(long.kept.every((m) => m.length <= OPINION_LIMITS.messageChars));
  assert.equal(long.kept.length + long.omitted, 30);
});

test('the decisions prompt carries the messages, the goal and plan, and the diff', () => {
  const payload = buildDecisionsPayload({
    anchor: ANCHOR, files: FILES, patch: PATCH,
    messages: ['Make the total respect quantity.'],
    goal: { title: 'Fix totals', objective: 'Totals are correct.', checks: ['qty is multiplied'], plan: ['Change total()', ''] },
  });
  assert.match(payload.prompt, /## The operator's messages \(1\)\n--- message 1 ---\nMake the total respect quantity\./);
  assert.match(payload.prompt, /## Goal\nTitle: Fix totals\nObjective: Totals are correct\.\nAcceptance checks:\n1\. qty is multiplied/);
  assert.match(payload.prompt, /## Plan\n- Change total\(\)/);
  assert.equal(payload.planItemsSent, 1);
  assert.equal(payload.goalSent, true);
  assert.match(payload.prompt, /===== BEGIN DIFF =====/);
  const bare = buildDecisionsPayload({ anchor: ANCHOR, files: FILES, patch: PATCH, messages: [], goal: null });
  assert.match(bare.prompt, /## The operator's messages \(0\)\n\(none recorded\)/);
  assert.doesNotMatch(bare.prompt, /## Goal/);
});

test('both schemas require every property and allow no others, which is what a strict schema reader demands', () => {
  assert.deepEqual([...REVIEW_SCHEMA.required], ['verdict', 'findings']);
  assert.equal(REVIEW_SCHEMA.additionalProperties, false);
  assert.deepEqual([...REVIEW_SCHEMA.properties.findings.items.required].sort(), Object.keys(REVIEW_SCHEMA.properties.findings.items.properties).sort());
  assert.deepEqual([...DECISIONS_SCHEMA.properties.entries.items.required].sort(), Object.keys(DECISIONS_SCHEMA.properties.entries.items.properties).sort());
});

/* ── reading a review reply ──────────────────────────────────────────── */

const GOOD = {
  verdict: 'needs-attention',
  findings: [
    { file: 'src/cart.ts', line_start: 12, line_end: 13, severity: 'high', title: 'Discount applied before rounding', body: 'Round first.', confidence: 0.8 },
    { file: 'b/src/retry.ts', line_start: null, line_end: null, severity: 'medium', title: 'Swallows every error', body: 'The last error is lost.', confidence: 0.6, recommendation: 'ignored' },
  ],
};

test('a well-formed reply is read, paths are normalised, and extra keys are dropped', () => {
  const read = readReviewReply({ text: JSON.stringify(GOOD) });
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.verdict, 'needs-attention');
  assert.equal(read.findings.length, 2);
  assert.equal(read.findings[1].file, 'src/retry.ts');
  assert.equal(read.findings[1].lineStart, null);
  assert.equal('recommendation' in read.findings[1], false);
});

test('a structured output from the schema flag wins over the text', () => {
  const read = readReviewReply({ structured: { verdict: 'approve', findings: [] }, text: 'not json at all' });
  assert.deepEqual(read, { ok: true, verdict: 'approve', findings: [], omitted: 0 });
});

test('extra prose and a code fence around the JSON are tolerated', () => {
  const text = `Here is my review:\n\n\`\`\`json\n${JSON.stringify(GOOD, null, 2)}\n\`\`\`\nLet me know if you need more.`;
  const read = readReviewReply({ text });
  assert.equal(read.ok, true);
});

test('empty findings with an approve verdict is a complete, readable review', () => {
  const read = readReviewReply({ text: '{"verdict":"approve","findings":[]}' });
  assert.equal(read.ok, true);
  if (read.ok) assert.equal(read.findings.length, 0);
});

test('malformed replies are unreadable, each with a reason a person can act on', () => {
  const cases: [string, RegExp][] = [
    ['', /empty/],
    ['I found no issues.', /no JSON object/],
    ['{"verdict": "approve", "findings": [}', /could not be parsed/],
    ['{"verdict":"lgtm","findings":[]}', /verdict/],
    ['{"verdict":"approve"}', /findings list/],
    ['[{"verdict":"approve","findings":[]}]', /could not be parsed|not a JSON object/],
    ['{"verdict":"approve","findings":[{"file":"/etc/passwd","line_start":1,"line_end":1,"severity":"low","title":"t","body":"b","confidence":0.5}]}', /Finding 1 names no repository-relative file/],
    ['{"verdict":"approve","findings":[{"file":"../x","line_start":1,"line_end":1,"severity":"low","title":"t","body":"b","confidence":0.5}]}', /repository-relative/],
    ['{"verdict":"approve","findings":[{"file":"a.ts","line_start":0,"line_end":1,"severity":"low","title":"t","body":"b","confidence":0.5}]}', /positive whole number/],
    ['{"verdict":"approve","findings":[{"file":"a.ts","line_start":3,"line_end":null,"severity":"low","title":"t","body":"b","confidence":0.5}]}', /one end/],
    ['{"verdict":"approve","findings":[{"file":"a.ts","line_start":9,"line_end":3,"severity":"low","title":"t","body":"b","confidence":0.5}]}', /ends before it starts/],
    ['{"verdict":"approve","findings":[{"file":"a.ts","line_start":1,"line_end":1,"severity":"blocker","title":"t","body":"b","confidence":0.5}]}', /severity/],
    ['{"verdict":"approve","findings":[{"file":"a.ts","line_start":1,"line_end":1,"severity":"low","title":"  ","body":"b","confidence":0.5}]}', /no title/],
    ['{"verdict":"approve","findings":[{"file":"a.ts","line_start":1,"line_end":1,"severity":"low","title":"t","confidence":0.5}]}', /no body/],
    ['{"verdict":"approve","findings":[{"file":"a.ts","line_start":1,"line_end":1,"severity":"low","title":"t","body":"b","confidence":85}]}', /confidence/],
    ['{"verdict":"approve","findings":["a.ts:3 is wrong"]}', /Finding 1 is not an object/],
    ['{"a": 1} and then {"b": 2}', /could not be parsed/],
  ];
  for (const [text, reason] of cases) {
    const read = readReviewReply({ text });
    assert.equal(read.ok, false, `expected unreadable: ${text}`);
    if (!read.ok) assert.match(read.reason, reason, text);
  }
});

test('a reply with more findings than the limit keeps the first ones and counts the rest', () => {
  const one = GOOD.findings[0];
  const read = readReviewReply({ structured: { verdict: 'needs-attention', findings: Array.from({ length: OPINION_LIMITS.findings + 3 }, () => one) } });
  assert.equal(read.ok, true);
  if (read.ok) { assert.equal(read.findings.length, OPINION_LIMITS.findings); assert.equal(read.omitted, 3); }
});

test('extractJsonObject finds one object and refuses when there is none', () => {
  assert.deepEqual(extractJsonObject('x {"a":1} y'), { ok: true, value: { a: 1 } });
  assert.equal(extractJsonObject('}{').ok, false);
});

test('normalizeDiffPath accepts the spellings a model uses and refuses paths that leave the repository', () => {
  assert.equal(normalizeDiffPath('a/src/x.ts'), 'src/x.ts');
  assert.equal(normalizeDiffPath('./src/x.ts'), 'src/x.ts');
  assert.equal(normalizeDiffPath('`src/x.ts`'), 'src/x.ts');
  assert.equal(normalizeDiffPath('/Users/me/x.ts'), null);
  assert.equal(normalizeDiffPath('C:\\x.ts'), null);
  assert.equal(normalizeDiffPath('src/../../x'), null);
  assert.equal(normalizeDiffPath(''), null);
  assert.equal(normalizeDiffPath(42), null);
});

/* ── locations against the diff ──────────────────────────────────────── */

test('locate says whether lines are in the diff, only the file is, or neither', () => {
  const index = indexDiff(PATCH);
  assert.equal(locate(index, 'src/cart.ts', 12, 14), 'lines-in-diff', 'added lines 11–14 are on the new side');
  assert.equal(locate(index, 'src/cart.ts', 10, 15), 'lines-in-diff', 'context lines count, since the reviewer was shown them');
  assert.equal(locate(index, 'src/cart.ts', 40, 42), 'file-in-diff', 'lines outside every hunk are not in the diff, though the file is');
  assert.equal(locate(index, 'src/cart.ts', 14, 30), 'file-in-diff', 'a range running past the hunk points partly at code nobody sent');
  assert.equal(locate(index, 'src/cart.ts', null, null), 'file-in-diff');
  assert.equal(locate(index, 'src/old.ts', 2, 2), 'lines-in-diff', 'a deleted file\'s lines are on the old side');
  assert.equal(locate(index, 'src/payments.ts', 1, 1), 'not-in-diff');
});

test('parseTouch reads path, path:line and path:start-end, and refuses nonsense', () => {
  assert.deepEqual(parseTouch('src/cart.ts'), { file: 'src/cart.ts', lineStart: null, lineEnd: null, raw: 'src/cart.ts' });
  assert.deepEqual(parseTouch(' src/cart.ts:12 '), { file: 'src/cart.ts', lineStart: 12, lineEnd: 12, raw: 'src/cart.ts:12' });
  assert.deepEqual(parseTouch('src/cart.ts:12-14'), { file: 'src/cart.ts', lineStart: 12, lineEnd: 14, raw: 'src/cart.ts:12-14' });
  assert.equal(parseTouch('src/cart.ts:14-12'), null);
  assert.equal(parseTouch('src/cart.ts:0'), null);
  assert.equal(parseTouch('/etc/hosts:1'), null);
});

/* ── decisions ────────────────────────────────────────────────────────── */

test('decisions: touches outside the diff are removed, and an entry citing nothing real is dropped and counted', () => {
  const read = readDecisionsReply({ text: JSON.stringify({ entries: [
    { decision: 'A 10% discount over 1000', why_it_matters: 'Pricing policy nobody asked for.', touches: ['src/cart.ts:12', 'src/cart.ts:99'], risk: 'high' },
    { decision: 'Retries five times', why_it_matters: 'Hides failures.', touches: ['src/retry.ts:2'], risk: 'medium' },
    { decision: 'Uses a queue', why_it_matters: 'Invented.', touches: ['src/queue.ts:4'], risk: 'low' },
    { decision: 'Cites nothing', why_it_matters: '', touches: [], risk: 'low' },
    { decision: 'Range across a gap', why_it_matters: 'x', touches: ['src/cart.ts:14-40'], risk: 'low' },
  ] }) });
  assert.equal(read.ok, true);
  if (!read.ok) return;
  const checked = checkDecisions(read.entries, indexDiff(PATCH));
  assert.equal(checked.kept.length, 2);
  assert.equal(checked.dropped, 3);
  assert.equal(checked.unrealTouches, 1, 'the one fake touch on a kept entry is counted');
  assert.deepEqual(checked.kept[0].touches.map((t) => t.raw), ['src/cart.ts:12']);
  assert.equal(checked.kept[0].unrealTouches, 1);
  assert.equal(droppedSentence(checked.dropped), "3 entries cited code that isn't in the diff and were dropped.");
  assert.equal(droppedSentence(1), "1 entry cited code that isn't in the diff and was dropped.");
  assert.equal(droppedSentence(0), null);
});

test('decisions: a whole-file touch counts when the file changed, and duplicates collapse', () => {
  const checked = checkDecisions([{ decision: 'd', whyItMatters: 'w', risk: 'low', touches: ['src/retry.ts', 'b/src/retry.ts', 'src/nope.ts'] }], indexDiff(PATCH));
  assert.equal(checked.kept.length, 1);
  assert.equal(checked.kept[0].touches.length, 1);
  assert.equal(checked.kept[0].unrealTouches, 1);
});

test('decisions: malformed replies are unreadable, empty entries are a complete answer', () => {
  assert.deepEqual(readDecisionsReply({ text: 'Sure: {"entries": []}' }), { ok: true, entries: [], omitted: 0 });
  const bad: [string, RegExp][] = [
    ['{"decisions": []}', /entries list/],
    ['{"entries":[{"decision":"","why_it_matters":"w","touches":[],"risk":"low"}]}', /states no decision/],
    ['{"entries":[{"decision":"d","touches":[],"risk":"low"}]}', /why it matters/],
    ['{"entries":[{"decision":"d","why_it_matters":"w","touches":"src/a.ts","risk":"low"}]}', /touches is not a list/],
    ['{"entries":[{"decision":"d","why_it_matters":"w","touches":[3],"risk":"low"}]}', /touches is not a list/],
    ['{"entries":[{"decision":"d","why_it_matters":"w","touches":[],"risk":"severe"}]}', /risk/],
    ['nothing here', /no JSON object/],
  ];
  for (const [text, reason] of bad) {
    const read = readDecisionsReply({ text });
    assert.equal(read.ok, false, text);
    if (!read.ok) assert.match(read.reason, reason, text);
  }
});

/* ── into the review message ─────────────────────────────────────────── */

const finding = (over: Partial<StoredFinding>): StoredFinding => ({
  id: 'f1', file: 'src/cart.ts', lineStart: 12, lineEnd: 13, severity: 'high', title: 'Discount before rounding', body: 'Round first.', confidence: 0.8,
  adjudication: 'confirmed', ...over,
});

test('a confirmed finding becomes a note anchored to its lines, quoting them and citing the reviewer', () => {
  const index = indexDiff(PATCH);
  const note = findingNote(finding({}), index, 'Codex');
  assert.ok(note);
  assert.equal(note.file, 'src/cart.ts');
  assert.equal(note.newStart, 12);
  assert.equal(note.newEnd, 13);
  assert.deepEqual(note.quote, ['+  if (sum > 1000) sum *= 0.9;', '+  return Math.round(sum);']);
  assert.match(note.body, /^Discount before rounding \(high\)\nRound first\.\n— second review by Codex, confirmed by the operator\.$/);
});

test('only a confirmed finding becomes a note, and one on a file outside the diff cannot be anchored', () => {
  const index = indexDiff(PATCH);
  assert.equal(findingNote(finding({ adjudication: 'refuted' }), index, 'Codex'), null);
  assert.equal(findingNote(finding({ adjudication: 'unsure' }), index, 'Codex'), null);
  assert.equal(findingNote(finding({ adjudication: 'unjudged' }), index, 'Codex'), null);
  assert.equal(findingNote(finding({ file: 'src/payments.ts' }), index, 'Codex'), null);
});

test('a finding on lines outside the hunks, or on a whole file, still reads correctly in the review message', () => {
  const index = indexDiff(PATCH);
  const outside = findingNote(finding({ lineStart: 40, lineEnd: 44 }), index, 'Claude Code');
  const whole = findingNote(finding({ id: 'f2', file: 'src/retry.ts', lineStart: null, lineEnd: null }), index, 'Claude Code');
  assert.ok(outside && whole);
  const message = formatReviewSubmission({ anchor: ANCHOR, files: [], marks: [], lineNotes: [outside, whole] });
  assert.equal(message.ok, true);
  if (!message.ok) return;
  assert.match(message.text, /1\. `src\/cart\.ts`, lines 40–44:\n {3}Discount before rounding \(high\)/);
  assert.match(message.text, /2\. `src\/retry\.ts`, the file as a whole:\n {3}Discount before rounding/);
  assert.doesNotMatch(message.text, /```diff\n {3}```/, 'no empty quote fence');
  assert.match(message.text, /second review by Claude Code, confirmed by the operator/);
});

test('a checked decision becomes a note on its first real touch, naming the others', () => {
  const index = indexDiff(PATCH);
  const entry: StoredDecision = {
    id: 'd1', decision: 'A 10% discount over 1000', whyItMatters: 'Pricing policy.', risk: 'high', unrealTouches: 0,
    touches: [{ file: 'src/cart.ts', lineStart: 12, lineEnd: 12, raw: 'src/cart.ts:12' }, { file: 'src/retry.ts', lineStart: null, lineEnd: null, raw: 'src/retry.ts' }],
  };
  const note = decisionNote(entry, index, 'Claude Code');
  assert.ok(note);
  assert.equal(note.newStart, 12);
  assert.deepEqual(note.quote, ['+  if (sum > 1000) sum *= 0.9;']);
  assert.match(note.body, /^A decision nobody asked for \(high risk\): A 10% discount over 1000\nWhy it matters: Pricing policy\.\nAlso touches: src\/retry\.ts\n/);
  assert.equal(decisionNote({ ...entry, touches: [{ file: 'src/gone.ts', lineStart: null, lineEnd: null, raw: 'src/gone.ts' }] }, index, 'x'), null);
});

/* ── metering, cost and the ledger ───────────────────────────────────── */

test('metering is read from recorded runs: unproven, priced, unpriced, unmetered', () => {
  assert.equal(meteringFrom({ completed: 0, priced: 0, withUsage: 0 }), 'unproven');
  assert.equal(meteringFrom({ completed: 3, priced: 1, withUsage: 3 }), 'priced');
  assert.equal(meteringFrom({ completed: 2, priced: 0, withUsage: 2 }), 'unpriced');
  assert.equal(meteringFrom({ completed: 2, priced: 0, withUsage: 0 }), 'unmetered');
});

test('a cost is the recorded figure or "unpriced", never a guess', () => {
  assert.equal(costLabel(0.1234, true), '$0.12');
  assert.equal(costLabel(0.004, true), '<$0.01');
  assert.equal(costLabel(0, true), '$0.00', 'a priced zero is a price');
  assert.equal(costLabel(0, false), 'unpriced');
  assert.equal(costLabel(null, null), 'unpriced');
  assert.match(costLabel(0.5, true, 'unverified'), /^\$0\.50 as the CLI priced it/);
});

test('ledger totals sum recorded dollars only, count unpriced runs apart, and skip runs still going', () => {
  const totals = ledgerTotals([
    { costUsd: 0.25, costReported: true, status: 'done' },
    { costUsd: 0, costReported: false, status: 'done' },
    { costUsd: null, costReported: null, status: 'failed' },
    { costUsd: 9, costReported: true, status: 'running' },
  ]);
  assert.deepEqual(totals, { pricedUsd: 0.25, pricedRuns: 1, unpricedRuns: 2 });
  assert.deepEqual(adjudicationCounts([{ adjudication: 'confirmed' }, { adjudication: 'refuted' }, { adjudication: 'confirmed' }, { adjudication: 'unjudged' }]),
    { confirmed: 2, refuted: 1, unsure: 0, unjudged: 1 });
});

test('a spending cap outside the range is refused rather than clamped', () => {
  assert.deepEqual(validBudget(1), { ok: true, usd: 1 });
  assert.deepEqual(validBudget(0.456), { ok: true, usd: 0.46 });
  assert.equal(validBudget(0).ok, false);
  assert.equal(validBudget(500).ok, false);
  assert.equal(validBudget('1').ok, false);
  assert.equal(validBudget(Number.NaN).ok, false);
  assert.equal(validAdjudication('confirmed'), true);
  assert.equal(validAdjudication('approved'), false);
});

test('a finding\'s lines are new-side lines: a removed line whose old number falls in the range is not quoted', () => {
  const patch = [
    'diff --git a/src/cart.ts b/src/cart.ts', '--- a/src/cart.ts', '+++ b/src/cart.ts', '@@ -1,5 +1,6 @@',
    ' export function total(items) {', '   let sum = 0;', '-  for (const i of items) sum += i.price;', '+  for (const i of items) sum += i.price * i.qty;',
    '-  return sum;', '+  if (sum > 1000) sum *= 0.9;', '+  return Math.round(sum);', ' }', '',
  ].join('\n');
  const note = findingNote(finding({ lineStart: 4, lineEnd: 5 }), indexDiff(patch), 'Codex');
  assert.ok(note);
  assert.deepEqual(note.quote, ['+  if (sum > 1000) sum *= 0.9;', '+  return Math.round(sum);']);
  assert.equal(note.oldStart, null);
  const gone = findingNote(finding({ file: 'src/old.ts', lineStart: 1, lineEnd: 2 }), indexDiff(PATCH), 'Codex');
  assert.deepEqual(gone?.quote, ['-export const legacy = true;', '-export const gone = 1;'], 'a deleted file is quoted from its old side');
});
