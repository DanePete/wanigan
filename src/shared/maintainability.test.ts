/**
 * Maintainability drift heuristics on snippets shaped like real code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeLineDelta, driftFor, languageOf, longestFunction, newDuplicates, parseHunks, scanLines } from './maintainability.ts';

const TS = languageOf('src/checkout.ts')!;
const PY = languageOf('app/report.py')!;

test('languages: the brace family and Python, nothing else', () => {
  for (const p of ['a.ts', 'a.tsx', 'a.js', 'main.go', 'A.java', 'A.cs', 'lib.rs', 'x.php', 'x.module']) assert.equal(languageOf(p)?.family, 'brace', p);
  assert.equal(languageOf('report.py')?.family, 'python');
  assert.equal(languageOf('README.md'), null);
  assert.equal(languageOf('Makefile'), null);
});

test('line kinds: blank, comment-only and code, through block comments and strings', () => {
  const text = [
    '/**',
    ' * Checkout.',
    ' */',
    '',
    'const url = "https://example.com/a"; // not a comment start inside the string',
    'const re = "/* not a block */";',
    '  // just a comment',
    'export const x = 1; /* trailing */',
    'const tpl = `line one',
    '',
    'still the template`;',
  ].join('\n');
  assert.deepEqual(scanLines(text, TS).kinds, ['comment', 'comment', 'comment', 'blank', 'code', 'code', 'comment', 'code', 'code', 'blank', 'code']);
  const py = ['# header', 'def f():', '    """Docstring', '    more"""', '    return 1  # tail', ''].join('\n');
  assert.deepEqual(scanLines(py, PY).kinds, ['comment', 'code', 'code', 'code', 'code']);
});

test('code lines added and removed exclude blank and comment lines, read against each side', () => {
  const before = ['export function total(items) {', '  return items.length;', '}'].join('\n');
  const after = ['export function total(items) {', '  // count them', '', '  const n = items.length;', '  return n;', '}'].join('\n');
  const patch = [
    'diff --git a/src/total.ts b/src/total.ts',
    '@@ -2 +2,4 @@ export function total(items) {',
    '-  return items.length;',
    '+  // count them',
    '+',
    '+  const n = items.length;',
    '+  return n;',
  ].join('\n');
  const hunks = parseHunks(patch);
  assert.deepEqual(hunks, [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 4 }]);
  assert.deepEqual(codeLineDelta(hunks, scanLines(before, TS).kinds, scanLines(after, TS).kinds), { added: 2, removed: 1 });
  assert.deepEqual(parseHunks('@@ -0,0 +1 @@'), [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 }]);
});

test('longest function: TypeScript declarations, methods and arrows, not control blocks or classes', () => {
  const text = [
    'export class Cart {',
    '  private items: Item[] = [];',
    '',
    '  add(item: Item): void {',
    '    if (item.qty > 0) {',
    '      this.items.push(item);',
    '    }',
    '  }',
    '}',
    '',
    'export async function checkout(cart: Cart, key: string): Promise<Receipt> {',
    '  const existing = await payments.get(key);',
    '  if (existing) {',
    '    return existing;',
    '  }',
    '  for (const item of cart.items) {',
    '    reserve(item);',
    '  }',
    '  const s = "}";',
    '  return payments.create(cart);',
    '}',
    '',
    'export const retry = async (n: number) => {',
    '  return n + 1;',
    '};',
  ].join('\n');
  assert.deepEqual(longestFunction(text, TS), { name: 'checkout', line: 11, lines: 11 });
});

test('longest function: Go, Rust, Java, C# and PHP headers', () => {
  const go = ['package main', '', 'func (s *Server) Handle(w http.ResponseWriter, r *http.Request) {', '\tif r == nil {', '\t\treturn', '\t}', '\tw.Write(nil)', '}'].join('\n');
  assert.deepEqual(longestFunction(go, languageOf('main.go')!), { name: 'Handle', line: 3, lines: 6 });
  const rust = ["impl<'a> Parser<'a> {", "    pub fn parse(&mut self) -> Result<Ast, Error> {", '        let x = 1;', '        Ok(Ast::new(x))', '    }', '}'].join('\n');
  assert.deepEqual(longestFunction(rust, languageOf('lib.rs')!), { name: 'parse', line: 2, lines: 4 });
  const java = ['public class Totals {', '    public static int sum(List<Integer> xs)', '    {', '        int t = 0;', '        for (int x : xs) { t += x; }', '        return t;', '    }', '}'].join('\n');
  assert.deepEqual(longestFunction(java, languageOf('Totals.java')!), { name: 'sum', line: 2, lines: 6 });
  const cs = ['namespace Shop {', '  public sealed class Totals {', '    public async Task<int> SumAsync(IEnumerable<int> xs) {', '      var t = 0;', '      foreach (var x in xs) { t += x; }', '      return await Task.FromResult(t);', '    }', '  }', '}'].join('\n');
  assert.deepEqual(longestFunction(cs, languageOf('Totals.cs')!), { name: 'SumAsync', line: 3, lines: 5 });
  const php = ['<?php', 'function mymodule_form_alter(&$form, $form_state, $form_id) {', "  if ($form_id === 'x') {", "    $form['#access'] = FALSE;", '  }', '}'].join('\n');
  assert.deepEqual(longestFunction(php, languageOf('mymodule.module')!), { name: 'mymodule_form_alter', line: 2, lines: 5 });
});

test('longest function: Python by indentation, with comments and blank lines inside the body', () => {
  const py = [
    'import os',
    '',
    'def short():',
    '    return 1',
    '',
    'class Report:',
    '    def build(self, rows):',
    '        total = 0',
    '',
    '# a comment at column zero does not end the body',
    '        for row in rows:',
    '            total += row',
    '        return total',
    '',
    'def after():',
    '    pass',
  ].join('\n');
  assert.deepEqual(longestFunction(py, PY), { name: 'build', line: 7, lines: 7 });
});

test('duplicated blocks: new six-line copies are counted once per run, pre-existing ones are not', () => {
  const block = [
    'const response = await fetch(url, { headers });',
    'if (!response.ok) throw new Error(`status ${response.status}`);',
    'const body = await response.json();',
    'validateBody(body, schema);',
    'cache.set(url, body);',
    'metrics.increment("fetch.ok");',
    'return body;',
  ];
  const a = ['export async function one(url, headers) {', ...block.map((l) => `  ${l}`), '}'].join('\n');
  const bBefore = ['export async function two(url) {', '  return get(url);', '}'].join('\n');
  const bAfter = ['export async function two(url, headers) {', ...block.map((l) => `    ${l}`), '}'].join('\n');
  const blocks = newDuplicates([
    { path: 'src/one.ts', before: a, after: a },
    { path: 'src/two.ts', before: bBefore, after: bAfter },
  ]);
  assert.equal(blocks.length, 1);
  // Seven copied lines plus the closing brace both functions end on.
  assert.equal(blocks[0].lines, 8);
  assert.deepEqual(blocks[0].occurrences.map((o) => o.path).sort(), ['src/one.ts', 'src/two.ts']);
  // The same copy already present before the change is not new.
  assert.deepEqual(newDuplicates([{ path: 'src/one.ts', before: a, after: a }, { path: 'src/two.ts', before: bAfter, after: bAfter }]), []);
  // Six lines of closing braces are not duplication worth naming.
  const braces = ['    }', '  }', '}', '    }', '  }', '}'].join('\n');
  assert.deepEqual(newDuplicates([{ path: 'x.ts', before: '', after: `${braces}\n${braces}` }]), []);
});

test('the drift report keeps its three numbers apart and says what it skipped', () => {
  const before = 'export function a() {\n  return 1;\n}\n';
  const after = 'export function a() {\n  const x = 1;\n  const y = 2;\n  return x + y;\n}\n';
  const report = driftFor([
    { path: 'src/a.ts', before, after, hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 3 }] },
    { path: 'docs/a.md', before: 'x', after: 'y', hunks: [] },
    { path: 'src/new.py', before: null, after: 'def f():\n    return 2\n', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 }] },
  ]);
  assert.equal(report.analysed, 2);
  assert.deepEqual(report.skipped, [{ path: 'docs/a.md', reason: 'no heuristic for this language' }]);
  assert.equal(report.codeAdded, 5);
  assert.equal(report.codeRemoved, 1);
  assert.deepEqual(report.longestBefore, { name: 'a', line: 1, lines: 3, path: 'src/a.ts' });
  assert.deepEqual(report.longestAfter, { name: 'a', line: 1, lines: 5, path: 'src/a.ts' });
  assert.deepEqual(report.duplicatedBlocks, []);
});
