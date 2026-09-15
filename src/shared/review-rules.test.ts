/**
 * Collecting `Code Review Rules` sections, scoped to the changed paths.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateRuleFiles, formatScopedRules, parseReviewRules, scopedRules } from './review-rules.ts';

const ROOT_AGENTS = [
  '# Repo guide',
  '',
  'Use Node 22.',
  '',
  '## Code Review Rules',
  '',
  '- Every migration is additive: never drop or rename a column.',
  '  Add a new column and backfill instead.',
  '- Renderer input is untrusted until main validates it.',
  '',
  '```md',
  '## Code Review Rules',
  '- this is an example inside a fence',
  '```',
  '',
  '### Why',
  'Because users keep their data.',
  '',
  '## Testing',
  '- run npm test',
].join('\n');

test('a rules section: list items with continuations, subsections kept, fences and later sections ignored', () => {
  const sections = parseReviewRules(ROOT_AGENTS);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].heading, 'Code Review Rules');
  assert.equal(sections[0].line, 5);
  assert.deepEqual(sections[0].rules, [
    'Every migration is additive: never drop or rename a column. Add a new column and backfill instead.',
    'Renderer input is untrusted until main validates it.',
    'Because users keep their data.',
  ]);
});

test('the heading is case-insensitive and a section of paragraphs is rules too; none is none', () => {
  assert.deepEqual(parseReviewRules('### code review RULES\nPayments code never logs a card number.\n\nRetries are idempotent.\n').map((s) => s.rules), [[
    'Payments code never logs a card number.', 'Retries are idempotent.',
  ]]);
  assert.deepEqual(parseReviewRules('# Guide\nNothing about review.\n'), []);
  assert.deepEqual(parseReviewRules('## Code Review Rules\n\n## Next\n- x\n'), []);
});

test('candidate files: AGENTS.md and CLAUDE.md on the path from the root to each changed file', () => {
  assert.deepEqual(candidateRuleFiles(['packages/api/src/pay.ts', 'README.md']), [
    'AGENTS.md', 'CLAUDE.md', 'packages/AGENTS.md', 'packages/CLAUDE.md', 'packages/api/AGENTS.md', 'packages/api/CLAUDE.md',
    'packages/api/src/AGENTS.md', 'packages/api/src/CLAUDE.md',
  ]);
});

test('scoping: a nested file’s rules apply only when a changed path is under it, cited by file and heading', () => {
  const files = [
    { path: 'AGENTS.md', text: ROOT_AGENTS },
    { path: 'packages/api/AGENTS.md', text: '## Code Review Rules\n- API errors are typed; never throw a string.\n' },
    { path: 'packages/web/CLAUDE.md', text: '## Code Review Rules\n- No inline styles.\n' },
  ];
  const rules = scopedRules(files, ['packages/api/src/pay.ts', 'docs/x.md']);
  assert.deepEqual(rules.map((r) => [r.file, r.scope, r.covers]), [
    ['AGENTS.md', '', ['packages/api/src/pay.ts', 'docs/x.md']],
    ['packages/api/AGENTS.md', 'packages/api', ['packages/api/src/pay.ts']],
  ]);
  const text = formatScopedRules(rules);
  assert.match(text, /^Code review rules that cover these changes — cite the rule a finding relies on:/);
  assert.match(text, /From `packages\/api\/AGENTS.md` › Code Review Rules \(covers 1 changed file under packages\/api\/\):\n- API errors are typed; never throw a string\./);
  assert.ok(!text.includes('No inline styles'));
  assert.equal(formatScopedRules([]), '');
});
