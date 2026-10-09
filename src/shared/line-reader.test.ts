import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LineReader } from './line-reader.ts';

test('line limits apply across fragments and reset for each complete line', () => {
  const reader = new LineReader();
  const lines: string[] = [];
  const take = (line: string): boolean => { lines.push(line); return true; };
  assert.equal(reader.read('ab', () => 4, take), true);
  assert.equal(reader.read('cd\nx\n\nyz\n', () => 4, take), true);
  assert.deepEqual(lines, ['abcd', 'x', '', 'yz']);
  assert.equal(reader.read('abc', () => 4, take), true);
  assert.equal(reader.read('de', () => 4, take), false);
  assert.deepEqual(lines, ['abcd', 'x', '', 'yz'], 'an oversized incomplete line is never delivered');
});

test('a handshake can change the next line limit, and refusal stops remaining lines', () => {
  const reader = new LineReader();
  let limit = 2;
  const lines: string[] = [];
  assert.equal(reader.read('ok\nlarge\nignored\n', () => limit, (line) => {
    lines.push(line); limit = 5; return line !== 'large';
  }), true);
  assert.deepEqual(lines, ['ok', 'large']);
});

test('a heavily fragmented line is consumed once without repeatedly scanning earlier chunks', () => {
  let scanned = 0;
  const indexOf = String.prototype.indexOf;
  // Do not use mock.method here: its call history would retain every growing
  // receiver in a broken implementation and exhaust memory before the assertion.
  String.prototype.indexOf = function (search: string, from = 0): number {
    if (search === '\n') scanned += Math.max(0, this.length - from);
    return indexOf.call(this, search, from);
  };
  let received = '';
  try {
    const reader = new LineReader();
    const take = (line: string): boolean => { received = line; return true; };
    for (let i = 0; i < 100_000; i++) assert.equal(reader.read('x', () => 100_000, take), true);
    reader.read('\n', () => 100_000, take);
  } finally { String.prototype.indexOf = indexOf; }
  assert.equal(received.length, 100_000);
  assert.ok(scanned <= 100_001, `newline searches scanned ${scanned} characters for a 100001-character input`);
});
