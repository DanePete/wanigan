/**
 * PR body from recorded evidence. The subject is honesty of absence: a body
 * with no recorded checks says so rather than omitting the heading, and an
 * acceptance check is listed as written, never ticked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrBody, PR_BODY_FOOTER, type PrEvidence } from './pr-body.ts';

const full: PrEvidence = {
  goal: { title: 'Make checkout retries safe', acceptance: ['A retried checkout charges once.', 'The regression test fails before the fix.'] },
  turns: 4,
  files: [
    { path: 'src/checkout.ts', added: 12, removed: 3 },
    { path: 'src/checkout.test.ts', added: 40, removed: 0 },
    { path: 'docs/flow.png', added: null, removed: null },
  ],
  checks: [
    { command: 'npm test', exitCode: 0, durationMs: 12_340, where: 'goal verification' },
    { command: 'npm run lint', exitCode: 1, durationMs: 800, where: 'goal verification' },
    { command: 'npm run e2e', exitCode: null, durationMs: null, where: 'project review gate' },
  ],
  review: { approved: 2, rejected: 0, commented: 1, resolved: 1, files: 3 },
  dependencies: ['added `p-retry` 6.2.0 (package.json dependencies)'],
};

test('a full body lists the goal, the change, the checks with exit codes, the review and dependencies, and says where it came from', () => {
  assert.equal(buildPrBody(full), [
    '## Goal: Make checkout retries safe',
    '',
    'Acceptance checks, as written on the goal (not graded here):',
    '- A retried checkout charges once.',
    '- The regression test fails before the fix.',
    '',
    '## What changed',
    '- 4 turns recorded in the session',
    '- 3 files changed (+52 −3, 1 binary file not counted)',
    '  - `src/checkout.ts` +12 −3',
    '  - `src/checkout.test.ts` +40 −0',
    '  - `docs/flow.png` binary',
    '',
    '## Checks run',
    '- `npm test` → exit 0 in 12.3s (goal verification)',
    '- `npm run lint` → exit 1 in 800ms (goal verification)',
    '- `npm run e2e` → did not exit on its own (project review gate)',
    '',
    '## Review in Wanigan',
    '- 2 of 3 files approved, 0 rejected, 1 with a comment',
    '- 1 review note resolved (a rejection or comment on a file later approved)',
    '',
    '## Dependencies',
    '- added `p-retry` 6.2.0 (package.json dependencies)',
    '',
    '---',
    PR_BODY_FOOTER,
  ].join('\n'));
});

test('a session with no goal, no turns recorded, no checks and no review still says what it knows and what it does not', () => {
  const body = buildPrBody({ goal: null, turns: null, files: [], checks: [], review: null, dependencies: [] });
  assert.equal(body, [
    '## What changed',
    '- 0 files changed (+0 −0)',
    '',
    '## Checks run',
    '- No review-gate command is recorded for this work.',
    '',
    '---',
    "Written from Wanigan's recorded evidence.",
  ].join('\n'));
});

test('long file lists are capped with a count of the rest', () => {
  const files = Array.from({ length: 33 }, (_, i) => ({ path: `f${i}.ts`, added: 1, removed: 0 }));
  const body = buildPrBody({ ...full, goal: null, files });
  assert.match(body, /- 33 files changed \(\+33 −0\)/);
  assert.match(body, /  - and 3 more files/);
  assert.doesNotMatch(body, /f30\.ts/);
});
