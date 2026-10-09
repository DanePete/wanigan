import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HookReader, type HookRead } from './hook-reader.ts';

/** The previous per-chunk contract, including permissive malformed EOF fallback. */
function previous() {
  let raw = Buffer.alloc(0);
  let result: HookRead = { kind: 'pending' };
  return (chunk: Uint8Array, final = false): HookRead => {
    if (result.kind !== 'pending') return result;
    raw = Buffer.concat([raw, chunk]);
    const text = raw.toString('utf8');
    const newline = text.indexOf('\n');
    if (newline < 0) return result;
    const body = text.slice(newline + 1);
    if (!body.trim() && !final) return result;
    let input: unknown;
    try { input = body.trim() ? JSON.parse(body) : {}; } catch { if (!final) return result; input = {}; }
    return result = { kind: 'frame', frame: { header: text.slice(0, newline), input } };
  };
}

test('hook frames keep the old completion and malformed-body behavior at every byte split', () => {
  const bodies = [
    '{"text":"雪 {\\\"} [ ] \\\\ /","nested":[{},[1,null,true]]} \t\r\n',
    '["\\u0022",false,{"text":"\\/"}]', '"雪\\\\\\\"{}[]"',
    'true', 'false', 'null', '0', '-0', '-12.5e+40', '1E-2', '1e400',
    '', ' \r\n\t', '{', '{"x":', '[]{}', '{}\ntrailing', '[}', '{"x":1,}',
    '"\\q"', '"raw\nnewline"', '-', '+1', '01', '1.', '1e', '1e+', '1e 2',
    '\ufeff{}', '\u00a0', '\u00a0{}', 'undefined',
  ];
  for (const header of ['fixture PreToolUse', '', ' \tfixture\tPreToolUse ignored']) {
    for (const body of bodies) {
      const wire = Buffer.from(`${header}\n${body}`);
      for (let cut = 0; cut <= wire.length; cut++) {
        const reader = new HookReader(4096);
        const old = previous();
        for (const chunk of [wire.subarray(0, cut), wire.subarray(cut)]) {
          assert.deepEqual(reader.read(chunk), old(chunk), `${JSON.stringify(body)} at byte ${cut}`);
        }
        assert.deepEqual(reader.end(), old(new Uint8Array(), true));
      }
    }
  }
});

test('hook byte budget includes the header, accepts the exact boundary and rejects before retaining excess', () => {
  const wire = Buffer.from('fixture Stop\n{"text":"雪"}');
  const exact = new HookReader(wire.length);
  assert.deepEqual(exact.read(wire), { kind: 'frame', frame: { header: 'fixture Stop', input: { text: '雪' } } });
  const over = new HookReader(wire.length - 1);
  assert.deepEqual(over.read(wire.subarray(0, -1)), { kind: 'pending' });
  assert.deepEqual(over.read(wire.subarray(-1)), { kind: 'too-large' });
  assert.deepEqual(over.end(), { kind: 'too-large' });
  const hugeHeader = new HookReader(8);
  assert.deepEqual(hugeHeader.read(Buffer.from('123456789\n{}')), { kind: 'too-large' });
  const noHeader = new HookReader(20);
  assert.deepEqual(noHeader.read(Buffer.from('no newline')), { kind: 'pending' });
  assert.deepEqual(noHeader.end(), { kind: 'pending' });
});
