import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readTranscript } from './history-transcript.ts';

test('a long transcript line is scanned and copied only linearly across read chunks', () => {
  const root = mkdtempSync(join(tmpdir(), 'wg-history-linear-'));
  const file = join(root, 'transcript.jsonl');
  const content = 'a'.repeat(8 * 1024 * 1024) + '🌲';
  const raw = JSON.stringify({ type: 'user', message: { content } });
  writeFileSync(file, raw);
  const concat = Buffer.concat;
  const lastIndexOf = Buffer.prototype.lastIndexOf;
  let copied = 0, searched = 0;
  // Keep no call history: a broken reader otherwise retains every growing buffer.
  Buffer.concat = function (...args: Parameters<typeof Buffer.concat>) {
    copied += args[0].reduce((sum, b) => sum + b.length, 0);
    return concat(...args);
  };
  Buffer.prototype.lastIndexOf = function (...args: Parameters<typeof lastIndexOf>): number {
    if (args[0] === 0x0a) searched += typeof args[1] === 'number' ? args[1] + 1 : this.length;
    return lastIndexOf.apply(this, args);
  };
  try {
    const result = readTranscript(file, 'claude');
    assert.equal(result.truncated, false);
    assert.equal(result.turns[0]?.text, 'a'.repeat(11_999) + '…');
    assert.ok(result.turns.length > 0);
    assert.ok(result.turns.reduce((sum, turn) => sum + turn.text.length, 0) <= 300_000);
    assert.ok(copied <= Buffer.byteLength(raw) * 2, `${copied} bytes copied for ${Buffer.byteLength(raw)} input bytes`);
    assert.ok(searched <= Buffer.byteLength(raw) * 2, `${searched} bytes searched for ${Buffer.byteLength(raw)} input bytes`);
  } finally {
    Buffer.concat = concat;
    Buffer.prototype.lastIndexOf = lastIndexOf;
    rmSync(root, { recursive: true, force: true });
  }
});

test('reverse chunks preserve a Unicode character split across the read boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'wg-history-unicode-'));
  const file = join(root, 'transcript.jsonl');
  const prefix = '{"type":"user","message":{"content":"older 🌲 newer"},"padding":"';
  const tree = Buffer.byteLength(prefix.slice(0, prefix.indexOf('🌲')));
  const suffix = '"}';
  const padding = 1024 * 1024 + tree + 2 - Buffer.byteLength(prefix + suffix);
  const raw = prefix + 'x'.repeat(padding) + suffix;
  assert.equal(Buffer.byteLength(raw) - 1024 * 1024, tree + 2);
  writeFileSync(file, raw);
  try {
    const result = readTranscript(file, 'claude');
    assert.deepEqual(result.turns.map((turn) => turn.text), ['older 🌲 newer']);
    assert.equal(result.truncated, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('blank lines and optional trailing newline preserve transcript order', () => {
  const root = mkdtempSync(join(tmpdir(), 'wg-history-lines-'));
  const file = join(root, 'transcript.jsonl');
  const row = (content: string) => JSON.stringify({ type: 'user', message: { content } });
  try {
    for (const trailing of ['', '\n', '\n\n']) {
      writeFileSync(file, '\n' + [row('first'), '', row('x'.repeat(2 * 1024 * 1024)), row('last')].join('\n') + trailing);
      const result = readTranscript(file, 'claude');
      assert.deepEqual(result.turns.map((turn) => turn.text), ['first', 'x'.repeat(11_999) + '…', 'last']);
      assert.equal(result.truncated, false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the byte budget omits a cut oldest line while preserving complete newest lines', () => {
  const root = mkdtempSync(join(tmpdir(), 'wg-history-byte-budget-'));
  const file = join(root, 'transcript.jsonl');
  const fd = openSync(file, 'w');
  try {
    writeSync(fd, '{"type":"user","message":{"content":"outside budget"},"padding":"');
    const chunk = Buffer.alloc(1024 * 1024, 'x');
    for (let i = 0; i < 33; i++) writeSync(fd, chunk);
    writeSync(fd, '"}\n' + JSON.stringify({ type: 'user', message: { content: 'newest complete turn' } }) + '\n');
  } finally { closeSync(fd); }
  try {
    const result = readTranscript(file, 'claude');
    assert.deepEqual(result.turns.map((turn) => turn.text), ['newest complete turn']);
    assert.equal(result.truncated, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a turn clips before a split Unicode code point and preserves complete pairs and normal text', () => {
  const root = mkdtempSync(join(tmpdir(), 'wg-history-unicode-clip-'));
  const file = join(root, 'transcript.jsonl');
  const preview = (content: string): string => {
    writeFileSync(file, JSON.stringify({ type: 'user', message: { content } }));
    const text = readTranscript(file, 'claude').turns[0]?.text;
    assert.ok(text);
    assert.ok(text.length <= 12_000);
    assert.equal(Buffer.from(text).toString('utf8'), text, 'clipping must not produce an unpaired surrogate');
    return text;
  };
  try {
    const prefix = 'a'.repeat(11_998);
    for (const character of [String.fromCodePoint(0x10000), '🌲', String.fromCodePoint(0x10ffff)]) {
      assert.equal(preview(prefix + character + 'x'), prefix + '…');
      assert.equal(preview(prefix + character), prefix + character, 'a complete character at the limit is preserved');
    }
    assert.equal(preview('a'.repeat(11_997) + '🌲xx'), 'a'.repeat(11_997) + '🌲…', 'a complete pair before the ellipsis is preserved');
    assert.equal(preview('a'.repeat(12_001)), 'a'.repeat(11_999) + '…', 'ordinary clipping is unchanged');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the overall preview character budget never clips through a Unicode code point', () => {
  const root = mkdtempSync(join(tmpdir(), 'wg-history-unicode-budget-'));
  const file = join(root, 'transcript.jsonl');
  const oldest = 'a'.repeat(9_998) + '🌲x';
  const contents = [oldest, 'b'.repeat(2_000), ...Array.from({ length: 24 }, () => 'c'.repeat(12_000))];
  writeFileSync(file, contents.map(content => JSON.stringify({ type: 'user', message: { content } })).join('\n'));
  try {
    const result = readTranscript(file, 'claude');
    assert.equal(result.truncated, true);
    assert.equal(result.turns.length, 26);
    assert.ok(result.turns.reduce((sum, turn) => sum + turn.text.length, 0) <= 300_000);
    assert.equal(result.turns[0]?.text, 'a'.repeat(9_998) + '…');
    assert.deepEqual(result.turns.slice(1).map(turn => turn.text), contents.slice(1));
    for (const turn of result.turns) assert.equal(Buffer.from(turn.text).toString('utf8'), turn.text);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
