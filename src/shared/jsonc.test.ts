import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJsonc, stripJsonComments } from './jsonc.ts';

test('comments go, strings stay whole: a URL’s // and an escaped quote are not comments', () => {
  const text = '{\n  // the owner\'s\n  "url": "https://mcp.example.test/mcp", /* inline */ "q": "a \\" // b",\n  "n": 1 // trailing\n}\n';
  assert.deepEqual(parseJsonc(text), { url: 'https://mcp.example.test/mcp', q: 'a " // b', n: 1 });
  assert.equal(stripJsonComments('"/* not */"'), '"/* not */"');
});

test('what Gemini would refuse is refused: not an object, or broken', () => {
  assert.equal(parseJsonc('[1, 2]'), null);
  assert.equal(parseJsonc('{"a": 1,}'), null, 'no trailing commas, as strip-json-comments leaves them');
  assert.equal(parseJsonc('{"a": /* open'), null);
});
