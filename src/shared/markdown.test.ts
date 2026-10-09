import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { inline, parseMarkdown } from './markdown.ts';
import { firstProse, frontmatterText, parseFrontmatter } from './skills.ts';

test('frontmatter: scalars, quotes, wrapped and block values, lists', () => {
  const { data, body } = parseFrontmatter([
    '---',
    'name: "tdd"',
    'description: Test-driven development. Use when the user wants',
    '  to build features test-first.',
    'summary: >',
    '  One line',
    '  and another.',
    'allowed-tools:',
    '  - Read',
    '  - Bash(git diff, git log)',
    "note: 'it''s fine'",
    '---',
    '',
    '# TDD',
  ].join('\n'));
  assert.equal(data.name, 'tdd');
  assert.equal(data.description, 'Test-driven development. Use when the user wants to build features test-first.');
  assert.equal(data.summary, 'One line and another.');
  assert.deepEqual(data['allowed-tools'], ['Read', 'Bash(git diff, git log)']);
  assert.equal(data.note, "it's fine");
  assert.equal(body, '\n# TDD');
  assert.equal(frontmatterText(data, 'missing'), '');
  assert.deepEqual(parseFrontmatter('# no frontmatter').data, {});
  assert.equal(firstProse('# Title\n\n```\ncode\n```\n\nThe first sentence.'), 'The first sentence.');
});

test('markdown: blocks a SKILL.md uses', () => {
  const blocks = parseMarkdown([
    '# Title',
    '',
    'A paragraph that',
    'wraps.',
    '',
    '- one',
    '  - nested',
    '- [x] done',
    '',
    '1. first',
    '2. second',
    '',
    '```sh',
    'npm test',
    '```',
    '',
    '> quoted',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '---',
  ].join('\n'));
  assert.deepEqual(blocks.map((b) => b.t), ['heading', 'paragraph', 'list', 'list', 'code', 'quote', 'table', 'rule']);
  assert.deepEqual(blocks[1], { t: 'paragraph', v: [{ t: 'text', v: 'A paragraph that wraps.' }] });
  const list = blocks[2] as Extract<(typeof blocks)[number], { t: 'list' }>;
  assert.deepEqual(list.items.map((i) => [i.depth, i.task]), [[0, null], [1, null], [0, true]]);
  assert.equal((blocks[3] as { ordered: boolean }).ordered, true);
  assert.deepEqual(blocks[4], { t: 'code', lang: 'sh', v: 'npm test' });
});

test('markdown: HTML in a file stays text', () => {
  const blocks = parseMarkdown('<script>alert(1)</script>\n\n```html\n<img src=x onerror=alert(1)>\n```');
  assert.deepEqual(blocks[0], { t: 'paragraph', v: [{ t: 'text', v: '<script>alert(1)</script>' }] });
  assert.deepEqual(blocks[1], { t: 'code', lang: 'html', v: '<img src=x onerror=alert(1)>' });
});

test('markdown: inline code, emphasis and links; snake_case is not emphasis', () => {
  assert.deepEqual(inline('Run `npm test` **now**, see [docs](https://x.dev) and *why*.'), [
    { t: 'text', v: 'Run ' }, { t: 'code', v: 'npm test' }, { t: 'text', v: ' ' },
    { t: 'strong', v: [{ t: 'text', v: 'now' }] }, { t: 'text', v: ', see ' },
    { t: 'link', v: [{ t: 'text', v: 'docs' }], href: 'https://x.dev' }, { t: 'text', v: ' and ' },
    { t: 'em', v: [{ t: 'text', v: 'why' }] }, { t: 'text', v: '.' },
  ]);
  assert.deepEqual(inline('set max_output_tokens and file_path'), [{ t: 'text', v: 'set max_output_tokens and file_path' }]);
});

test('headings lose only a closing run of #s, and hostile text is read fast', () => {
  const titles = (src: string) => parseMarkdown(src).filter((b) => b.t === 'heading').map((b) => (b.v as { v?: string }[]).map((x) => x.v ?? '').join(''));
  assert.deepEqual(titles('## Title ##'), ['Title']);
  assert.deepEqual(titles('# C#'), ['C#'], 'a # inside the title is kept');
  assert.deepEqual(titles('#   ###'), ['']);
  assert.deepEqual(titles('#no-space'), [], 'not a heading');
  // A skill's text is written by whoever wrote the skill: 4,000 spaces in a heading took 13 seconds.
  const started = performance.now();
  parseMarkdown(`# a${' '.repeat(20_000)}#b`);
  parseMarkdown('['.repeat(20_000));
  parseMarkdown('[a]('.repeat(5_000));
  parseMarkdown('`'.repeat(20_000));
  assert.ok(performance.now() - started < 1_000, `took ${Math.round(performance.now() - started)} ms`);
});


test('deeply nested quotes keep their text without overflowing the parser or renderer stack', () => {
  let blocks = parseMarkdown('>'.repeat(10_000) + ' visible words');
  let depth = 0;
  while (blocks[0]?.t === 'quote') { depth++; blocks = blocks[0].v; }
  assert.ok(depth <= 32, 'formatting depth is bounded');
  assert.match(JSON.stringify(blocks), /visible words/);
  assert.match(JSON.stringify(blocks), />{100}/, 'the remaining quote markers stay visible as text');
});

test('inline code closes only with a backtick run of the same length', () => {
  assert.deepEqual(inline('a ``b```c'), [{ t: 'text', v: 'a ``b```c' }]);
  assert.deepEqual(inline('a ``b`c`` d'), [{ t: 'text', v: 'a ' }, { t: 'code', v: 'b`c' }, { t: 'text', v: ' d' }]);
});

for (const kind of ['unmatched inline backticks', 'wrapped list lines', 'malformed table divider']) {
  test(`markdown stays fast with ${kind} below the skill file limit`, () => {
    const script = `
      import { parseMarkdown } from ${JSON.stringify(new URL('./markdown.ts', import.meta.url).href)};
      const source = ${JSON.stringify(kind)} === 'unmatched inline backticks'
        ? 'prefix ' + String.fromCharCode(96).repeat(400_000)
        : ${JSON.stringify(kind)} === 'malformed table divider'
          ? 'words | heading\\n' + ' '.repeat(160_000) + 'x'
          : '- start\\n' + '  words\\n'.repeat(60_000);
      const result = parseMarkdown(source);
      if (!JSON.stringify(result).includes(${JSON.stringify(kind)} === 'unmatched inline backticks' ? 'prefix' : 'words')) process.exit(1);
    `;
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 3_000, stdio: 'pipe',
    }), 'agent-written Markdown must not stall the window');
  });
}
