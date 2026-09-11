/**
 * The name a past conversation wears, and the three ways it can be wrong.
 *
 * The happy path is the least interesting part. What this guards is that the
 * feature cannot become a worse version of the problem it fixes: an injected
 * instruction file would put the *same* name on every conversation in a
 * repository, which is exactly the "four identical rows" complaint that
 * prompted this. A row with nothing to read must stay null rather than receive
 * something invented. And `source` must never claim the agent authored a title
 * that was really just the opening prompt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INJECTED, TITLE_MAX_CHARS, tidyTitle, titleFromTranscriptText } from './session-title.ts';

const jsonl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n');
const claudeUser = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
const claudeBlocks = (text: string) => ({ type: 'user', message: { content: [{ type: 'text', text }] } });
const codexUser = (text: string) => ({
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
});

test("the agent's own title wins over the opening prompt", () => {
  const read = titleFromTranscriptText(jsonl(
    claudeUser('i just bought deadnorth.io to be my new portfolio and llc domain'),
    { type: 'ai-title', aiTitle: 'Set up deadnorth.io portfolio and LLC domain' },
  ));
  assert.deepEqual(read, { title: 'Set up deadnorth.io portfolio and LLC domain', source: 'agent' });
});

test('the newest title in hand is the one the agent still stands behind', () => {
  const read = titleFromTranscriptText(jsonl(
    { type: 'ai-title', aiTitle: 'Looking at a test failure' },
    { type: 'ai-title', aiTitle: 'Rewrite the release workflow' },
  ));
  assert.equal(read?.title, 'Rewrite the release workflow');
});

test('with no title the first real prompt stands in, and says so', () => {
  for (const shape of [claudeUser, claudeBlocks, codexUser]) {
    const read = titleFromTranscriptText(jsonl(shape('fix the failing packaging test'), shape('and now the other one')));
    assert.deepEqual(read, { title: 'fix the failing packaging test', source: 'prompt' },
      `shape ${shape.name} should yield the first prompt`);
  }
});

test('text the CLI injected is never mistaken for what the person typed', () => {
  // This is the failure that would matter most: Codex replays AGENTS.md into
  // every rollout in a repository, so accepting it would put one identical
  // name on every conversation there — the original complaint, restated.
  for (const marker of INJECTED) {
    const read = titleFromTranscriptText(jsonl(codexUser(`${marker} blah\nmore text`), codexUser('the actual question')));
    assert.deepEqual(read, { title: 'the actual question', source: 'prompt' }, `marker ${marker} must be skipped`);
  }
});

test('a conversation with nothing to read keeps its null', () => {
  assert.equal(titleFromTranscriptText(''), null);
  assert.equal(titleFromTranscriptText(jsonl({ type: 'assistant', message: { content: 'hello' } })), null);
  // Whitespace and empty strings are not names.
  assert.equal(titleFromTranscriptText(jsonl(claudeUser('   \n  '))), null);
  assert.equal(titleFromTranscriptText(jsonl({ type: 'ai-title', aiTitle: '  ' }, claudeUser('a real prompt')))?.source, 'prompt');
});

test('a truncated or corrupt line is skipped, not treated as the end', () => {
  // The caller passes a bounded head of a file that may be being appended to,
  // so the last line is routinely half-written.
  const text = `${jsonl(claudeUser('the real prompt'))}\n{"type":"ai-ti`;
  assert.equal(titleFromTranscriptText(text)?.title, 'the real prompt');
  assert.equal(titleFromTranscriptText('not json at all\n[]\nnull')?.title, undefined);
});

test('a name is one bounded line, never a pasted diff', () => {
  assert.equal(tidyTitle('first line\nsecond line'), 'first line');
  assert.equal(tidyTitle('  spaced   out  \t words '), 'spaced out words');
  const long = tidyTitle('x'.repeat(400))!;
  assert.equal(long.length, TITLE_MAX_CHARS);
  assert.ok(long.endsWith('…'), 'a trimmed name says it was trimmed');
  assert.equal(tidyTitle(42), null);
  assert.equal(tidyTitle(null), null);
});
