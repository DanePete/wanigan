/**
 * The resume chain check on synthetic transcripts: an intact chain, the parent
 * types 2.1.271 keeps as ordinary links, each kind of break, a compaction
 * boundary that is not a break, cycles and a partial trailing line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainWarning, checkTranscriptChain } from './transcript-chain.ts';

type Row = { uuid: string; parentUuid: string | null; type: string; isSidechain?: boolean; subtype?: string };
const jsonl = (rows: Row[]) => rows.map((r) => JSON.stringify({ sessionId: 'c', timestamp: '2026-09-14T00:00:00Z', ...r })).join('\n');

const chain = (n: number, prefix = 'm', start: string | null = null): Row[] => {
  const out: Row[] = [];
  let parent = start;
  for (let i = 0; i < n; i++) {
    const uuid = `${prefix}${i}`;
    out.push({ uuid, parentUuid: parent, type: i % 2 ? 'assistant' : 'user' });
    parent = uuid;
  }
  return out;
};

test('an intact chain skips nothing', () => {
  const r = checkTranscriptChain(jsonl(chain(6)));
  assert.deepEqual({ messages: r.messages, reached: r.reached, skipped: r.skipped, breaks: r.breaks.length }, { messages: 6, reached: 6, skipped: 0, breaks: 0 });
  assert.equal(chainWarning(r), null);
});

test('attachment and system parents are ordinary links, as they are in the 2.1.271 loader', () => {
  const rows: Row[] = [
    { uuid: 'u1', parentUuid: null, type: 'user' },
    { uuid: 'att', parentUuid: 'u1', type: 'attachment' },
    { uuid: 'a1', parentUuid: 'att', type: 'assistant' },
    { uuid: 'sys', parentUuid: 'a1', type: 'system', subtype: 'turn_duration' },
    { uuid: 'u2', parentUuid: 'sys', type: 'user' },
    { uuid: 'a2', parentUuid: 'u2', type: 'assistant' },
  ];
  const r = checkTranscriptChain(jsonl(rows));
  assert.equal(r.skipped, 0);
  assert.equal(r.reached, 4);
});

test('a parent that is a progress record is a break; what lies behind it may be skipped', () => {
  const rows: Row[] = [
    ...chain(4, 'old'),
    { uuid: 'p1', parentUuid: 'old3', type: 'progress' },
    { uuid: 'p2', parentUuid: 'p1', type: 'progress' },
    { uuid: 'n0', parentUuid: 'p2', type: 'user' },
    { uuid: 'n1', parentUuid: 'n0', type: 'assistant' },
  ];
  const r = checkTranscriptChain(jsonl(rows));
  assert.equal(r.reached, 2);
  assert.equal(r.reachable, 6, 'stepping through the progress records reaches the earlier four');
  assert.equal(r.skipped, 4);
  assert.deepEqual(r.breaks.map((b) => [b.uuid, b.kind, b.line]), [['n0', 'progress', 7]]);
  assert.equal(chainWarning(r), '4 messages may be skipped when this conversation resumes (broken message chain in the transcript)');
});

test('a missing parent and a sidechain parent are breaks too, and several are all reported', () => {
  const rows: Row[] = [
    ...chain(2, 'a'),
    { uuid: 'b0', parentUuid: 'gone-uuid', type: 'user' },
    { uuid: 'b1', parentUuid: 'b0', type: 'assistant' },
    { uuid: 'side0', parentUuid: 'b1', type: 'user', isSidechain: true },
    { uuid: 'side1', parentUuid: 'side0', type: 'assistant', isSidechain: true },
    { uuid: 'c0', parentUuid: 'side1', type: 'user' },
    { uuid: 'c1', parentUuid: 'c0', type: 'assistant' },
  ];
  const r = checkTranscriptChain(jsonl(rows));
  assert.equal(r.messages, 6, 'sidechain messages are the subagent\'s, not the conversation\'s');
  assert.equal(r.reached, 2);
  assert.equal(r.skipped, 4);
  assert.deepEqual(r.breaks.map((b) => b.kind), ['missing', 'sidechain']);
  assert.equal(chainWarning({ skipped: 1 }), '1 message may be skipped when this conversation resumes (broken message chain in the transcript)');
});

test('a compaction boundary has no parent by design and is not counted as lost history', () => {
  const rows: Row[] = [
    ...chain(4, 'pre'),
    { uuid: 'cb', parentUuid: null, type: 'system', subtype: 'compact_boundary' },
    { uuid: 'post0', parentUuid: 'cb', type: 'user' },
    { uuid: 'post1', parentUuid: 'post0', type: 'assistant' },
  ];
  const r = checkTranscriptChain(jsonl(rows));
  assert.equal(r.skipped, 0);
  assert.equal(r.breaks.length, 0);
  assert.equal(r.reached, 2);
});

test('cycles end the walk, unreadable lines are counted, and an empty file reports nothing', () => {
  const cyclic = checkTranscriptChain(jsonl([
    { uuid: 'x', parentUuid: 'y', type: 'user' },
    { uuid: 'y', parentUuid: 'x', type: 'assistant' },
  ]));
  assert.equal(cyclic.reached, 2);
  assert.equal(cyclic.skipped, 0);
  const partial = checkTranscriptChain(`${jsonl(chain(2))}\n{"uuid":"trunc`);
  assert.equal(partial.unreadableLines, 1);
  assert.equal(partial.skipped, 0);
  assert.deepEqual(checkTranscriptChain(''), { messages: 0, reached: 0, reachable: 0, skipped: 0, breaks: [], unreadableLines: 0 });
});
