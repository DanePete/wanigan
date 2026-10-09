import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAID_CAPS, findSaid, plainText, saidCutText, saidPattern, snippetAt } from './said.ts';

test('a terminal’s output reads as plain text', () => {
  // Colour, a window title, a hyperlink, a Codex notification, a private mode, a charset switch.
  const raw = '\x1b[38;5;174m✻\x1b[0m Claude Code\x1b]0;my title\x07 \x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ '
    + '\x1b]9;Agent turn complete\x07\x1b[?25l\x1b(Bdone\r\n';
  assert.equal(plainText(raw), '✻ Claude Code link done\n');
});

test('a cursor move keeps words apart: a new line for up, down and to a place, a space along the line', () => {
  assert.equal(plainText('ready\x1b[2;1Hnext'), 'ready\nnext');
  assert.equal(plainText('one\x1b[1Atwo\x1b[3Bthree'), 'one\ntwo\nthree');
  assert.equal(plainText('left\x1b[5Cright'), 'left right');
  assert.equal(plainText('a\x1b[2K\x1b[1Gb'), 'a b');
  assert.equal(plainText('x\ry\r\nz'), 'x\ny\nz');
});

test('box drawing, spinners and stray controls are not words', () => {
  assert.equal(plainText('╭──╮\n│ hi │\n⠋ working\x07\x08'), '    \n  hi  \n  working');
  // A sequence left open at the end of what was read swallows at most its own bounded length.
  assert.equal(plainText('kept\x1b]0;unfinished title'), 'kept');
  assert.equal(plainText('\x1b['), '');
});

test('a query matches its words in order, in any case, across any whitespace', () => {
  const p = saidPattern('  Pay   BUTTON ')!;
  assert.ok(p.test('the pay button has no name'));
  p.lastIndex = 0;
  assert.ok(p.test('the Pay\n  Button'));
  p.lastIndex = 0;
  assert.ok(!p.test('button pay'));
  assert.equal(saidPattern('   '), null);
  // Regular-expression characters are only characters.
  assert.ok(saidPattern('a.b (c)')!.test('a.b (c)'));
  assert.ok(!saidPattern('a.b')!.test('axb'));
});

test('matches come newest first, without the repeats a redraw makes, at most as many as asked', () => {
  const text = 'first: tests pass\nredraw: tests pass\nredraw: tests pass\nlast: TESTS PASS now\n';
  const found = findSaid(text, saidPattern('tests pass')!, 5);
  assert.deepEqual(found.map((f) => f.match), ['TESTS PASS', 'tests pass', 'tests pass']);
  assert.match(found[0]!.before, /last: $/);
  assert.equal(found.length, 3, 'the line drawn twice is one');
  assert.match(found[1]!.before, /redraw: $/);
  assert.match(found[2]!.before, /^first: $/);
  assert.equal(findSaid(text, saidPattern('tests pass')!, 1).length, 1);
  assert.deepEqual(findSaid(text, saidPattern('nowhere')!, 5), []);
});

test('a snippet is one line around the match, cut at word edges, and says where it was cut', () => {
  const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
  const text = `${words} NEEDLE ${words}`;
  const at = text.indexOf('NEEDLE');
  const s = snippetAt(text, at, at + 6);
  assert.equal(s.match, 'NEEDLE');
  assert.ok(s.before.startsWith('…word') && s.before.endsWith(' '), s.before);
  assert.ok(s.after.startsWith(' word0') && s.after.endsWith('…'), s.after);
  assert.ok(!/\s{2}|\n/.test(s.before + s.match + s.after));
  assert.ok(s.before.length <= 42 && s.after.length <= 112);
  const short = snippetAt('just NEEDLE here', 5, 11);
  assert.deepEqual(short, { before: 'just ', match: 'NEEDLE', after: ' here' });
});

test('a cut search says what was left out, and a whole one says nothing', () => {
  assert.equal(saidCutText([]), null);
  assert.match(saidCutText(['results'])!, /more matches than shown/);
  assert.match(saidCutText(['bytes'])!, /newest 1 MB/);
  assert.match(saidCutText(['bytes'], { ...SAID_CAPS, bytesPerFile: 4096 })!, /newest 4 KB/);
  assert.match(saidCutText(['time', 'sessions'])!, /200 most recent sessions.*stopped to stay quick/);
});
