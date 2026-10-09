// The breadcrumbs' symbol path, per language, read from the same parsers the
// editor highlights with. A `‸` in each sample is where the cursor is.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { jinja } from '@codemirror/lang-jinja';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { php } from '@codemirror/lang-php';
import { sass } from '@codemirror/lang-sass';
import { yaml } from '@codemirror/lang-yaml';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { symbolPath, symbolSiblings, topSymbols } from './symbols.ts';

function at(source: string, lang: Extension): { state: EditorState; pos: number } {
  const pos = source.indexOf('‸');
  assert.ok(pos >= 0, 'the sample marks the cursor');
  const state = EditorState.create({ doc: source.replace('‸', ''), extensions: [lang] });
  // The editor parses while it idles; a test parses the whole sample first, however cold the parser is.
  ensureSyntaxTree(state, state.doc.length, 10_000);
  return { state, pos };
}
const path = (source: string, lang: Extension): string[] => {
  const { state, pos } = at(source, lang);
  return symbolPath(state, pos).map((s) => `${s.kind} ${s.name}`);
};

test('PHP: namespace-free class, method and function, as Drupal writes them', () => {
  const src = `<?php\nnamespace Drupal\\acme\\Controller;\n\nclass PayController extends ControllerBase {\n  public function pay(int $total): array {\n    return ['#markup' => ‸$total];\n  }\n  private function sign(): string { return ''; }\n}\n\nfunction acme_theme() { return []; }\n`;
  assert.deepEqual(path(src, php()), ['class PayController', 'method pay']);
  const { state, pos } = at(src, php());
  const method = symbolPath(state, pos).at(-1)!;
  assert.deepEqual(symbolSiblings(state, method).map((s) => s.name), ['pay', 'sign']);
  assert.equal(state.doc.sliceString(method.select, method.select + 3), 'pay', 'a jump lands on the name');
  assert.deepEqual(topSymbols(state).map((s) => `${s.kind} ${s.name}`), ['class PayController', 'function acme_theme']);
});

test('Twig: the block, then the HTML elements inside it', () => {
  const src = `{% extends "page.html.twig" %}\n{% block content %}\n<div class="card card--wide">\n  <p id="lede">{% if x %}<b>‸hi</b>{% endif %}</p>\n</div>\n{% endblock %}\n{% block footer %}<footer></footer>{% endblock %}\n`;
  assert.deepEqual(path(src, jinja()), ['block content', 'element div.card', 'element p#lede', 'element b']);
  const { state, pos } = at(src, jinja());
  const block = symbolPath(state, pos)[0]!;
  assert.deepEqual(symbolSiblings(state, block).map((s) => s.name), ['content', 'footer']);
  assert.deepEqual(topSymbols(state).map((s) => s.name), ['content', 'footer']);
  const plain = at('{# A plain template #}\n<div class="pay"><span>‸Pay</span></div>\n<footer></footer>\n', jinja());
  assert.deepEqual(topSymbols(plain.state).map((s) => s.name), ['div.pay', 'footer'], 'with no blocks, its HTML is the outline');
  const macro = `{% macro icon(name) %}<i class="icon">‸{{ name }}</i>{% endmacro %}`;
  assert.deepEqual(path(macro, jinja()), ['macro icon', 'element i.icon']);
});

test('CSS: a rule inside its at-rule; Sass nesting', () => {
  const src = `.hero { color: navy; }\n@media (min-width: 40em) {\n  .hero > .title,\n  .lede { margin: ‸0; }\n}\n`;
  assert.deepEqual(path(src, css()), ['at-rule @media (min-width: 40em)', 'rule .hero > .title, .lede']);
  const { state, pos } = at(src, css());
  assert.deepEqual(topSymbols(state).map((s) => s.name), ['.hero', '@media (min-width: 40em)']);
  assert.deepEqual(symbolSiblings(state, symbolPath(state, pos)[0]!).map((s) => s.kind), ['rule', 'at-rule']);
  const scss = `.card {\n  color: red;\n  &:hover { color: ‸blue; }\n  .title { font-weight: 700; }\n}\n`;
  assert.deepEqual(path(scss, sass()), ['rule .card', 'rule &:hover']);
  const s = at(scss, sass());
  assert.deepEqual(symbolSiblings(s.state, symbolPath(s.state, s.pos)[1]!).map((x) => x.name), ['&:hover', '.title']);
});

test('JavaScript and TypeScript: functions, classes, methods, and functions kept in constants', () => {
  const src = `export function a() {}\nclass Cart {\n  total() {\n    const sum = (x: number) => ‸x;\n  }\n  get count() { return 1; }\n}\nconst pay = async () => {};\n`;
  assert.deepEqual(path(src, javascript({ typescript: true })), ['class Cart', 'method total', 'function sum']);
  const { state } = at(src, javascript({ typescript: true }));
  assert.deepEqual(topSymbols(state).map((s) => `${s.kind} ${s.name}`), ['function a', 'class Cart', 'function pay']);
  const behaviors = `Drupal.behaviors.payButton = {\n  attach(context) {\n    once('pay', '.pay', context).forEach((el) => ‸el);\n  },\n};\n`;
  assert.deepEqual(path(behaviors, javascript()), ['method attach']);
});

test('YAML: the key path, with list items by their place', () => {
  const src = `acme.pay:\n  path: '/pay'\n  defaults:\n    _controller: '‸\\Drupal\\acme\\Controller\\PayController::pay'\n  requirements:\n    _permission: 'access content'\n`;
  assert.deepEqual(path(src, yaml()), ['key acme.pay', 'key defaults', 'key _controller']);
  const { state, pos } = at(src, yaml());
  assert.deepEqual(symbolSiblings(state, symbolPath(state, pos)[1]!).map((s) => s.name), ['path', 'defaults', 'requirements']);
  const libs = `pay-button:\n  js:\n    js/pay.js: {}\n  dependencies:\n    - core/drupal\n    - ‸core/once\n`;
  assert.deepEqual(path(libs, yaml()), ['key pay-button', 'key dependencies', 'item [1]']);
});

test('Markdown: the headings above the cursor, each under the one before it', () => {
  const src = `# Acme theme\n\nIntro.\n\n## Building\n\n### Sass\n\nRun ‸it.\n\n## Deploying\n\nSetext\n------\n`;
  assert.deepEqual(path(src, markdown()), ['heading Acme theme', 'heading Building', 'heading Sass']);
  const { state, pos } = at(src, markdown());
  assert.deepEqual(symbolSiblings(state, symbolPath(state, pos)[1]!).map((s) => s.name), ['Building', 'Deploying', 'Setext']);
  assert.deepEqual(topSymbols(state).map((s) => s.name), ['Acme theme']);
});

test('JSON and HTML: keys and elements', () => {
  assert.deepEqual(path(`{"scripts": {"dev": "vite", "build": ‸"vite build"}}`, json()), ['key scripts', 'key build']);
  assert.deepEqual(path(`<main><section id="hero"><h1>Hi‸</h1></section></main>`, html()), ['element main', 'element section#hero', 'element h1']);
});

test('outside every symbol the path is empty, and a file with none lists none', () => {
  assert.deepEqual(path(`<?php\n‸\nfunction a() {}\n`, php()), []);
  const { state } = at('/* Nothing here yet. */‸\n', css());
  assert.deepEqual(topSymbols(state), []);
});
