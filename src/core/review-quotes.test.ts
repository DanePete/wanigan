// An AI review's quotes are checked against the real files. The card's own
// evidence is part of the work under review, wherever the agent kept it:
// Claude Code writes test output to its scratchpad, outside the project, and a
// verbatim quote from it was reported as "not in the file" and the pass
// downgraded (found in the real-app scenario run, 7 October 2026).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { testCore, waitFor } from './test-support.ts';

const LINE = 'ok 3 - subtotal multiplies each price by its quantity';

test('a quote from the card’s own evidence counts wherever it lies; one from any other outside file does not', async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'wg-review-quotes-')));
  const evidence = join(scratch, 'test-output.txt');
  const elsewhere = join(scratch, 'notes.txt');
  writeFileSync(evidence, `TAP version 13\n# Subtest: subtotal\n${LINE}\n1..4\n`);
  writeFileSync(elsewhere, `${LINE}\n`);
  const reviewer = join(scratch, 'reviewer.sh');
  writeFileSync(reviewer, '#!/bin/sh\ncat "$WG_REVIEW_ANSWER"\n', { mode: 0o755 });
  const answer = (file: string): string => {
    const path = join(scratch, `answer-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify({
      result: '', total_cost_usd: 0.01,
      structured_output: { verdict: 'pass', summary: 'The tests pass.', check: [], criteria: [{ criterion: 'npm test passes', met: true, proof: 'The output says so.', file, quote: LINE }] },
    }));
    return path;
  };

  const t = await testCore({ claudeBinary: reviewer });
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'bug', title: 'Cart subtotal ignores quantity' });
    await t.owner.call('criteria.add', { cardId: card.id, text: 'npm test passes' });
    await t.owner.call('cards.evidence', { id: card.id, evidence: { kind: 'file', value: evidence } });
    const review = async (file: string) => {
      process.env.WG_REVIEW_ANSWER = answer(file);
      const started = await t.owner.call('cards.aiReview', { id: card.id });
      return waitFor('the review', async () => (await t.owner.call('cards.get', { id: card.id })).reviews.find((r) => r.id === started.id && r.state !== 'running'));
    };

    const offered = await review(evidence);
    assert.equal(offered.result?.criteria[0]?.quoteFound, true, 'the quote is in the evidence file the agent offered');
    assert.equal(offered.result?.verdict, 'pass');
    assert.deepEqual(offered.result?.notes, []);

    const other = await review(elsewhere);
    assert.equal(other.result?.criteria[0]?.quoteFound, false, 'a file outside the project that is not evidence proves nothing');
    assert.equal(other.result?.verdict, 'unsure');
  } finally {
    delete process.env.WG_REVIEW_ANSWER;
    await t.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});


test('a quote naming a FIFO is refused without blocking the core', async () => {
  const t = await testCore();
  try {
    const fifo = join(t.projectDir, 'test-output');
    execFileSync('/usr/bin/mkfifo', [fifo]);
    const script = `
      import { check } from ${JSON.stringify(new URL('./review.ts', import.meta.url).href)};
      const answer = check({ verdict: 'pass', criteria: [{ criterion: 'Done', met: true, file: 'test-output', quote: 'ok' }] },
        { criteria: [], evidence: [] }, ${JSON.stringify(t.projectDir)});
      if (answer.verdict !== 'unsure' || answer.criteria[0].quoteFound !== false) process.exit(1);
    `;
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 2_000, stdio: 'pipe',
    }), 'checking an agent-provided path must not wait for a FIFO writer');
    assert.equal((await t.owner.call('core.hello', {})).role, 'owner');
  } finally {
    await t.close();
  }
});
