/**
 * Rollout format detection. The magic numbers are the codecs' published frame
 * headers (zstd RFC 8878 §3.1.1, gzip RFC 1952, xz, bzip2, lz4 frame format);
 * the JSONL fixtures are the first bytes of a Codex 0.154.0 rollout
 * (`{"timestamp":...,"type":"session_meta",...}`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRollout, isRolloutName, tallyJsonLines, unparsedSentence, unreadableSentence } from './rollout-format.ts';

const bytes = (...values: number[]) => Uint8Array.from(values);
const utf8 = (text: string) => new TextEncoder().encode(text);

test('a plain rollout is JSONL, BOM and leading whitespace allowed', () => {
  assert.deepEqual(classifyRollout('rollout-2026-09-14T22-04-49-x.jsonl', utf8('{"timestamp":"2026')), { kind: 'jsonl' });
  assert.deepEqual(classifyRollout('rollout-a.jsonl', bytes(0xef, 0xbb, 0xbf, 0x7b)), { kind: 'jsonl' });
  assert.deepEqual(classifyRollout('rollout-a.jsonl', utf8('\n  {')), { kind: 'jsonl' });
});

test('compressed rollouts are recognised by magic even under a .jsonl name', () => {
  assert.deepEqual(classifyRollout('rollout-a.jsonl', bytes(0x28, 0xb5, 0x2f, 0xfd, 0x00)), { kind: 'compressed', codec: 'zstd', by: 'magic' });
  assert.deepEqual(classifyRollout('rollout-a.jsonl', bytes(0x1f, 0x8b, 0x08)), { kind: 'compressed', codec: 'gzip', by: 'magic' });
  assert.deepEqual(classifyRollout('rollout-a.jsonl', bytes(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)), { kind: 'compressed', codec: 'xz', by: 'magic' });
  assert.deepEqual(classifyRollout('rollout-a.jsonl', bytes(0x42, 0x5a, 0x68, 0x39)), { kind: 'compressed', codec: 'bzip2', by: 'magic' });
});

test('and by extension when the bytes are not in hand or not recognised', () => {
  assert.deepEqual(classifyRollout('rollout-a.jsonl.zst', bytes()), { kind: 'compressed', codec: 'zstd', by: 'extension' });
  assert.deepEqual(classifyRollout('rollout-a.jsonl.gz', utf8('garbage')), { kind: 'compressed', codec: 'gzip', by: 'extension' });
  assert.deepEqual(classifyRollout('rollout-a.jsonl.br', utf8('x')), { kind: 'compressed', codec: 'unknown', by: 'extension' });
});

test('an empty file is empty, and non-JSON bytes under .jsonl are binary, never JSONL', () => {
  assert.deepEqual(classifyRollout('rollout-a.jsonl', bytes()), { kind: 'empty' });
  assert.deepEqual(classifyRollout('rollout-a.jsonl', bytes(0x00, 0x01, 0x02)), { kind: 'binary' });
});

test('rollout names include compressed spellings and exclude everything else', () => {
  assert.equal(isRolloutName('rollout-2026-09-14T22-04-49-01a0a306.jsonl'), true);
  assert.equal(isRolloutName('rollout-2026-09-14T22-04-49-01a0a306.jsonl.zst'), true);
  assert.equal(isRolloutName('history.jsonl'), false);
  assert.equal(isRolloutName('rollout-x.json'), false);
});

test('line tallies count unparsed records and leave a writer’s partial tail alone', () => {
  assert.deepEqual(tallyJsonLines('{"a":1}\n{"b":2}\n'), { parsed: 2, unparsed: 0, partialTail: false });
  assert.deepEqual(tallyJsonLines('{"a":1}\nnot json\n{"b":2}\n'), { parsed: 2, unparsed: 1, partialTail: false });
  assert.deepEqual(tallyJsonLines('{"a":1}\n{"b":'), { parsed: 1, unparsed: 0, partialTail: true });
  assert.deepEqual(tallyJsonLines('{"a":1}\n{"b":2}'), { parsed: 2, unparsed: 0, partialTail: true });
  // A tail window cut mid-record: the first fragment is the window's doing.
  assert.deepEqual(tallyJsonLines('":1}\n{"b":2}\n', true), { parsed: 1, unparsed: 0, partialTail: false });
  assert.deepEqual(tallyJsonLines(''), { parsed: 0, unparsed: 0, partialTail: false });
  assert.deepEqual(tallyJsonLines('\n\n'), { parsed: 0, unparsed: 0, partialTail: false });
});

test('the sentences say nothing at zero and count correctly above it', () => {
  assert.equal(unreadableSentence(0), null);
  assert.equal(unreadableSentence(1), '1 Codex session is stored in a format this version of Wanigan cannot read (compressed rollouts).');
  assert.equal(unreadableSentence(3), '3 Codex sessions are stored in a format this version of Wanigan cannot read (compressed rollouts).');
  assert.equal(unparsedSentence(0, 0), null);
  assert.equal(unparsedSentence(2, 1), 'The Codex reader could not parse 2 lines in 1 rollout file.');
});
