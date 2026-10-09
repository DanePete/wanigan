import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanCodex as scan } from './codex.ts';

const scanCodex = (pending: string, chunk: string) => {
  const r = scan(pending, chunk);
  return { pending: r.pending, signals: r.signals.map((s) => s.kind) };
};

const turn = '\x1b]9;Agent turn complete\x07';
const ask = '\x1b]9;Approval requested: run `pnpm test`\x1b\\';

test('turn-complete and approval notifications are recognised', () => {
  assert.deepEqual(scanCodex('', `output ${turn} more ${ask}`).signals, ['finished', 'permission']);
});

test('a sequence split across chunks is still read once', () => {
  const whole = `hello ${turn} bye`;
  for (let cut = 1; cut < whole.length; cut++) {
    const first = scanCodex('', whole.slice(0, cut));
    const second = scanCodex(first.pending, whole.slice(cut));
    assert.deepEqual([...first.signals, ...second.signals], ['finished'], `cut at ${cut}`);
  }
});

test('ordinary output is not held or reported', () => {
  const r = scanCodex('', 'plain text with \x1b[32mcolour\x1b[0m and no notification');
  assert.deepEqual(r, { pending: '', signals: [] });
});

test('an unterminated sequence is held, but never more than a bound', () => {
  const r = scanCodex('', `\x1b]9;${'x'.repeat(10_000)}`);
  assert.ok(r.pending.length <= 2048);
  assert.deepEqual(r.signals, []);
});

test('reworded approval messages still count as approval, and say what is asked', () => {
  assert.deepEqual(scan('', '\x1b]9;Codex wants to edit src/app.ts\x07').signals, [{ kind: 'permission', text: 'Codex wants to edit src/app.ts' }]);
});
