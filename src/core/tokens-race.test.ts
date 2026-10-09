// Two reads of one growing record at once (the session's tokens and its card's,
// asked together when a `sessions` event lands) both read the new lines into
// the one shared cache entry, so they are kept twice. For a Codex rollout a
// repeated running total reads as "the total went down, so it restarted", and
// the whole thread is counted again.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAX_FILES, Tokens } from './tokens.ts';

const THREAD = '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const line = (o: object): string => `${JSON.stringify(o)}\n`;
const total = (input: number, output: number) => line({
  type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output, total_tokens: input + output },
    last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1, total_tokens: 11 }, model_context_window: 1000,
  } },
});

test('two concurrent token reads of a grown Codex rollout count it once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-tok-'));
  try {
    const home = join(dir, 'codex');
    const rollout = join(home, 'sessions', '2026', '10', '07', `rollout-2026-10-07T00-00-00-${THREAD}.jsonl`);
    mkdirSync(join(rollout, '..'), { recursive: true });
    writeFileSync(rollout, line({ type: 'session_meta', payload: { id: THREAD } }) + total(100, 10));
    const accounts = { folder: () => home, list: () => [] } as never;
    const tokens = new Tokens(accounts);
    const session = { provider: 'codex', conversationId: THREAD, transcriptPath: rollout, accountId: null } as never;

    const first = await tokens.ofSession(session);
    assert.equal(first.usage?.input, 100);

    appendFileSync(rollout, total(250, 30) + total(400, 40));
    const sequentialExpectation = 400;
    const [a, b] = await Promise.all([tokens.ofSession(session), tokens.ofSession(session)]);
    const again = await tokens.ofSession(session);
    assert.equal(a.usage?.input, sequentialExpectation, 'first concurrent read');
    assert.equal(b.usage?.input, sequentialExpectation, 'second concurrent read');
    assert.equal(again.usage?.input, sequentialExpectation, 'every later read, from the poisoned cache');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a long-running core keeps at most MAX_FILES transcripts in memory, and one let go is read again correctly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-tok-'));
  try {
    const home = join(dir, 'codex');
    const tokens = new Tokens({ folder: () => home, list: () => [] } as never);
    const sessions = Array.from({ length: MAX_FILES + 20 }, (_, i) => {
      const thread = `0199aaaa-bbbb-7ccc-8ddd-${String(i).padStart(12, '0')}`;
      const rollout = join(home, 'sessions', '2026', '10', '07', `rollout-2026-10-07T00-00-00-${thread}.jsonl`);
      mkdirSync(join(rollout, '..'), { recursive: true });
      writeFileSync(rollout, line({ type: 'session_meta', payload: { id: thread } }) + total(100 + i, 10));
      return { provider: 'codex', conversationId: thread, transcriptPath: rollout, accountId: null } as never;
    });
    for (const s of sessions) await tokens.ofSession(s);
    assert.ok((tokens as unknown as { files: Map<string, unknown> }).files.size <= MAX_FILES);
    assert.equal((await tokens.ofSession(sessions[0] as never)).usage?.input, 100, 'the first, long since let go, counts the same');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
