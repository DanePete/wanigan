import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_LINE, START, hunkState, languageFor, tokenizeLine, type Lang, type State, type TokenKind } from './syntax.ts';

/** The coloured words of a line, as "text:kind", so a test reads like the line. */
function colours(lang: Lang, line: string, state: State = START): string[] {
  return tokenizeLine(lang, line, state).spans.map(([s, e, k]) => `${line.slice(s, e).trim()}:${k}`);
}

/** Each line's colours, carrying state from line to line. */
function lines(lang: Lang, src: string): { colours: string[]; state: State }[] {
  let state = START;
  return src.split('\n').map((line) => {
    const r = tokenizeLine(lang, line, state);
    state = r.state;
    return { colours: r.spans.map(([s, e, k]) => `${line.slice(s, e).trim()}:${k}`), state };
  });
}

const has = (list: string[], ...want: string[]): void => {
  for (const w of want) assert.ok(list.includes(w), `${w} not in ${JSON.stringify(list)}`);
};

test('a language is chosen by file name, and anything else stays plain', () => {
  const cases: [string, Lang | null][] = [
    ['web/modules/custom/shop/shop.module', 'php'], ['src/Controller/PayController.php', 'php'], ['shop.install', 'php'], ['northstar.theme', 'php'],
    ['templates/pay-button.html.twig', 'twig'], ['shop.routing.yml', 'yaml'], ['shop.info.yml', 'yaml'], ['config/sync/system.site.yaml', 'yaml'],
    ['js/pay.js', 'jsx'], ['src/App.tsx', 'jsx'], ['src/util.ts', 'ts'], ['css/pay.css', 'css'], ['scss/_pay.scss', 'scss'],
    ['composer.json', 'json'], ['composer.lock', 'json'], ['index.html', 'html'], ['README.md', 'markdown'], ['scripts/deploy.sh', 'shell'], ['.env', 'shell'],
    ['yarn.lock', null], ['logo.png', null], ['Makefile', null], ['LICENSE', null], ['.gitignore', null],
  ];
  for (const [path, lang] of cases) assert.equal(languageFor(path), lang, path);
});

test('PHP: variables, keywords, types, strings, numbers, constants and both comment kinds', () => {
  const c = colours('php', "  public function build(int $total, ?string $label = NULL): array { return ['#theme' => 'pay', 'n' => 0x1F, MAX_TOTAL]; } // done");
  has(c, 'public:keyword', 'function:keyword', 'int:keyword', '$total:variable', '$label:variable', 'NULL:number', "'#theme':string", '0x1F:number', 'MAX_TOTAL:number', '// done:comment');
  assert.ok(!c.some((x) => x.startsWith('build')), 'a function name is plain');
  has(colours('php', 'use Drupal\\Core\\Controller\\ControllerBase;'), 'use:keyword', 'Drupal:type', 'ControllerBase:type');
  has(colours('php', '$this->entityTypeManager->getStorage($type);'), '$this:variable', '$type:variable');
  has(colours('php', '# a shell-style comment'), '# a shell-style comment:comment');
  has(colours('php', "#[Route('/pay')]"), 'Route:type', "'/pay':string");
});

test('JavaScript and TypeScript: templates, regular expressions, and keywords only where they are keywords', () => {
  const c = colours('jsx', 'const label = `Pay ${formatMoney(total)} now`;');
  has(c, 'const:keyword', '`Pay:string', '${:punct', ')}:punct', 'now`:string');
  assert.ok(!c.some((x) => x.startsWith('formatMoney')), 'code inside ${} is code, not string');
  has(colours('jsx', 'const re = /pay\\s+[a-z/]+/gi;'), '/pay\\s+[a-z/]+/gi:string');
  assert.ok(!colours('jsx', 'const half = total / 2 / 3;').some((x) => x.endsWith(':string')), 'division is not a regular expression');
  has(colours('ts', 'export type Order = { id: string };'), 'export:keyword', 'type:keyword', 'Order:type', 'string:keyword');
  assert.ok(!colours('ts', 'map.get(type); card.type = x;').some((x) => x.endsWith(':keyword')), 'a property named like a keyword is not one');
  has(colours('jsx', 'if (ok) return null; else throw new Error(`x`);'), 'if:keyword', 'return:keyword', 'null:number', 'throw:keyword', 'new:keyword', 'Error:type');
});

test('JSX: tags and attributes, across lines, and a less-than is still a less-than', () => {
  const l = lines('jsx', [
    'return (',
    '  <button',
    '    className="pay" onClick={() => submit(total)}',
    '    aria-label={label}>',
    '    <Icon name="lock" aria-hidden="true" />',
    '  </button>',
    ');',
  ].join('\n'));
  has(l[1]!.colours, 'button:tag');
  assert.equal(l[1]!.state.in, 'tag', 'the tag runs on to the next line');
  has(l[2]!.colours, 'className:attr', '"pay":string', 'onClick:attr');
  has(l[3]!.colours, 'aria-label:attr');
  assert.equal(l[3]!.state.in, 'code');
  has(l[4]!.colours, 'Icon:tag', 'name:attr', '"lock":string');
  has(l[5]!.colours, 'button:tag');
  assert.ok(!colours('jsx', 'if (a < b && i <n) {}').some((x) => x.endsWith(':tag')), 'comparisons are not tags');
  assert.ok(!colours('ts', 'const xs = new Array<string>(); const y = <T>(v: T) => v;').some((x) => x.endsWith(':tag')), 'TypeScript has no JSX');
});

test('CSS and SCSS: properties, values, selectors, at-rules and variables', () => {
  has(colours('css', '.pay-button, a:hover { color: var(--water); padding: 4px 0.5rem; background: #fff !important; }'),
    '.pay-button:tag', 'a:tag', ':hover:attr', 'color:attr', '--water:variable', 'padding:attr', '4px:number', '0.5rem:number', '#fff:number', '!important:keyword');
  has(colours('scss', '@include breakpoint(md) { $gap: 12px; } // note'), '@include:keyword', '$gap:variable', '12px:number', '// note:comment');
  has(colours('css', '#main > .card { margin: -1px }'), '#main:tag', '.card:tag', 'margin:attr', '-1px:number');
  const l = lines('css', 'transition:\n  color 120ms,\n  background 0.2s;\n.next { }');
  has(l[1]!.colours, '120ms:number');
  assert.ok(!l[1]!.colours.includes('color:tag'), 'a value that wraps is still a value');
  has(l[3]!.colours, '.next:tag');
});

test('YAML: keys, strings, numbers, booleans, comments, anchors, flows and blocks', () => {
  has(colours('yaml', "  path: '/checkout/{order}/pay' # the route"), 'path:attr', "'/checkout/{order}/pay':string", '# the route:comment');
  has(colours('yaml', '    weight: 10'), 'weight:attr', '10:number');
  has(colours('yaml', '  enabled: true'), 'true:number');
  has(colours('yaml', '  _title: Pay now'), 'Pay now:string');
  has(colours('yaml', '  - &base two'), '-:punct', '&base:variable', 'two:string');
  has(colours('yaml', '  options: { no_cache: TRUE, tags: [a, b] }'), 'no_cache:attr', 'TRUE:number', 'tags:attr', 'a:string');
  const l = lines('yaml', 'description: |\n  A block\n  of text: still text\nnext: 1');
  assert.equal(l[0]!.state.in, 'scalar');
  assert.deepEqual(l[2]!.colours, ['of text: still text:string']);
  has(l[3]!.colours, 'next:attr', '1:number');
  assert.equal(l[3]!.state.in, 'code');
});

test('JSON: keys apart from values', () => {
  has(colours('json', '  "name": "northstar", "private": true, "n": -1.5e3, "x": null'), '"name":attr', '"northstar":string', 'true:number', '-1.5e3:number', 'null:number');
});

test('Twig and HTML: tags, attributes, Twig inside tags and attribute values, comments across lines', () => {
  const twig = colours('twig', '<button{{ attributes.addClass(\'pay\') }} type="submit" aria-label="{{ \'Pay\'|t }}">');
  has(twig, 'button:tag', '{{:punct', 'attributes:variable', "'pay':string", 'type:attr', '"submit":string', 'aria-label:attr', 't:type');
  has(colours('twig', '  {% if icon and not hidden %}{{ label|upper }}{% endif %}'), 'if:keyword', 'icon:variable', 'and:keyword', 'upper:type', 'endif:keyword');
  const l = lines('twig', '{# Shown\n   twice #}\n<p>{{ x }}</p>');
  assert.equal(l[0]!.state.in, 'comment');
  assert.deepEqual(l[1]!.colours, ['twice #}:comment']);
  has(l[2]!.colours, 'p:tag', 'x:variable');
  const html = lines('html', '<a href="/x" class="a\n  b">Link</a> <!-- a\n note -->');
  has(html[0]!.colours, 'a:tag', 'href:attr', '"/x":string');
  assert.equal(html[0]!.state.in, 'string', 'an attribute value runs on');
  has(html[1]!.colours, 'b":string', 'a:tag');
  assert.equal(html[1]!.state.in, 'comment');
  assert.ok(!colours('html', 'Plain words &amp; more').some((x) => !x.endsWith(':number')), 'text stays plain');
});

test('Markdown: headings, code, links, and fences across lines', () => {
  has(colours('markdown', '## Install it'), '## Install it:keyword');
  has(colours('markdown', 'Run `drush cr` then see [the docs](https://example.com).'), '`drush cr`:string', 'https://example.com:attr');
  const l = lines('markdown', '```php\n$x = "/* not a comment";\n```\n- after');
  assert.equal(l[1]!.state.in, 'fence');
  assert.deepEqual(l[1]!.colours, [], 'code in a fence stays plain');
  has(l[3]!.colours, '-:punct');
});

test('Shell: comments, variables inside strings, keywords, flags, heredocs and strings across lines', () => {
  has(colours('shell', 'export FOO="bar $HOME ${X:-y}" # tail'), 'export:keyword', 'FOO:variable', '$HOME:variable', '${X:-y}:variable', '# tail:comment');
  has(colours('shell', 'if [ -n "$1" ]; then git diff --stat; fi'), 'if:keyword', '-n:attr', '$1:variable', 'then:keyword', '--stat:attr', 'fi:keyword');
  const l = lines('shell', "cat <<EOF\nbody $x\nEOF\necho 'two\nlines' done");
  assert.equal(l[0]!.state.in, 'heredoc');
  assert.deepEqual(l[1]!.colours, ['body $x:string']);
  assert.equal(l[2]!.state.in, 'code');
  assert.equal(l[3]!.state.in, 'string');
  has(l[4]!.colours, "lines':string");
  assert.equal(l[4]!.state.in, 'code');
});

test('what spans lines is carried: block comments, PHP strings and heredocs, JavaScript templates', () => {
  const php = lines('php', "/**\n * Builds it.\n */\n$multi = 'one\ntwo';\n$h = <<<EOT\n  $x\n  EOT;\n$after = 1;");
  assert.equal(php[0]!.state.in, 'comment');
  assert.deepEqual(php[1]!.colours, ['* Builds it.:comment']);
  assert.equal(php[2]!.state.in, 'code');
  assert.equal(php[3]!.state.in, 'string');
  has(php[4]!.colours, "two':string");
  assert.equal(php[5]!.state.in, 'heredoc');
  assert.deepEqual(php[6]!.colours, ['$x:string'], 'a heredoc body is string, variables and all');
  has(php[8]!.colours, '$after:variable', '1:number');
  const js = lines('jsx', 'const s = `one\ntwo ${x}\nthree`; const y = 1;');
  assert.equal(js[0]!.state.in, 'string');
  assert.equal(js[1]!.state.in, 'string');
  has(js[2]!.colours, 'three`:string', 'const:keyword', '1:number');
  // A JavaScript string ends with its line unless the line says it goes on.
  assert.equal(lines('jsx', "const a = 'unclosed\nconst b = 2;")[1]!.colours.includes('const:keyword'), true);
});

test('a hunk that opens inside a comment starts inside it, judged by its opening lines', () => {
  const at = (lang: Lang, ...lines: string[]): string => hunkState(lang, lines).in;
  assert.equal(at('php', '   * @param string $label', '   */'), 'comment');
  assert.equal(at('jsx', '   */', 'export const x = 1;'), 'comment');
  assert.equal(at('css', 'a block comment', 'closing the note */', '.x {}'), 'comment', 'a close seen before any open');
  assert.equal(at('php', '  public function x() {', '  /**', '   * Doc.'), 'code', 'an open seen first');
  assert.equal(at('jsx', "const files = glob('src/**/*.ts');", 'x */'), 'code', 'a glob is not a comment');
  assert.equal(at('css', '* {', '  box-sizing: border-box;'), 'code', 'the universal selector is not a comment');
  assert.equal(at('yaml', '  * not yaml syntax'), 'code');
  assert.equal(at('twig', ' * Available variables:', ' * - label: its name.', ' */', '#}', '<button>'), 'comment', 'Twig’s {# … #} around a doc block');
  assert.equal(at('twig', '<p>{# a note #}</p>'), 'code');
  assert.equal(at('html', 'still a note', '-->', '<p>'), 'comment');
  assert.equal(at('php', ...Array.from({ length: 40 }, () => '$x = 1;'), ' */'), 'code', 'only the opening lines are read');
});

const LANGS: Lang[] = ['php', 'jsx', 'ts', 'css', 'scss', 'yaml', 'json', 'twig', 'html', 'markdown', 'shell'];

/** Spans are in order, inside the line, and never overlap. */
function wellFormed(line: string, spans: [number, number, TokenKind][], what: string): void {
  let end = 0;
  for (const [s, e] of spans) {
    assert.ok(s >= end && e > s && e <= line.length, `${what}: span [${s}, ${e}) after ${end} in a line of ${line.length}`);
    end = e;
  }
}

test('a line too long to colour is left plain, quickly, and keeps its state', () => {
  const minified = 'var a="x",b=/re/g;function f(){return a<b?`${a}`:"/*"}'.repeat(20_000);
  assert.ok(minified.length > 1_000_000);
  for (const lang of LANGS) {
    const started = performance.now();
    const state = { in: 'comment', close: '*/', n: 0 } as const;
    const r = tokenizeLine(lang, minified, state);
    assert.deepEqual(r.spans, []);
    assert.equal(r.state, state);
    assert.ok(performance.now() - started < 50, `${lang} took ${performance.now() - started}ms`);
  }
});

test('pathological lines just under the cap finish fast, in every language, with spans that make sense', () => {
  const nasty = ['"\\', "'", '`${', '/*', '*/', '<', '<<<', '{{', '{%', '{#', '#}', '-->', '<!--', '$', '${', '/', '[', '{', '}', '#', ':', '- ', '|', '\\', '<a ', '=', '`'];
  const started = performance.now();
  for (const lang of LANGS) {
    for (const piece of nasty) {
      const line = piece.repeat(Math.floor(MAX_LINE / piece.length));
      let state = START;
      for (let k = 0; k < 3; k++) {
        const r = tokenizeLine(lang, line, state);
        wellFormed(line, r.spans, `${lang} ${JSON.stringify(piece)}`);
        state = r.state;
      }
    }
  }
  assert.ok(performance.now() - started < 3000, `took ${Math.round(performance.now() - started)}ms`);
});

test('random lines never throw or hang, and state carries safely between them', () => {
  let seed = 7;
  const random = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const alphabet = ['a', 'Z', '$', '_', '0', '9', '.', ' ', '\t', '"', "'", '`', '\\', '/', '*', '#', '<', '>', '{', '}', '(', ')', '[', ']', '-', '|', ':', '!', '%', '&', '=', '?', '@', '~', ',', ';', 'é', '{{', '}}', '{%', '%}', '{#', '#}', '<!--', '-->', '${', '<<<EOT', 'EOT', '<?php', '```', '<<EOF'];
  for (const lang of LANGS) {
    let state = START;
    for (let n = 0; n < 400; n++) {
      let line = '';
      const len = Math.floor(random() * 60);
      for (let k = 0; k < len; k++) line += alphabet[Math.floor(random() * alphabet.length)];
      const r = tokenizeLine(lang, line, state);
      wellFormed(line, r.spans, `${lang} ${JSON.stringify(line)}`);
      state = r.state;
    }
  }
});
