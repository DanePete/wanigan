/**
 * The script launcher's readers, against the shapes real projects write — and
 * the ones that must not become a runnable entry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandFor, justRecipes, makeTargets, orderScripts, packageManagerFor, packageScripts, runnableName } from './project-scripts.ts';

test('package.json scripts are read in file order, and a broken file says so', () => {
  const r = packageScripts(JSON.stringify({ name: 'app', scripts: { test: 'node --test', 'lint:fix': 'eslint . --fix', weird: 42 } }));
  assert.deepEqual(r.scripts.map((s) => [s.name, s.body]), [['test', 'node --test'], ['lint:fix', 'eslint . --fix']]);
  assert.equal(r.problem, null);
  assert.deepEqual(packageScripts('{"name":"no-scripts"}'), { scripts: [], problem: null });
  assert.match(packageScripts('{ "scripts": ').problem ?? '', /not valid JSON/);
  assert.match(packageScripts('{"scripts": []}').problem ?? '', /not an object/);
});

test('Makefile targets are the explicit rules, with their ## descriptions', () => {
  const text = [
    '.PHONY: test build',
    'CC := clang',
    'PREFIX ?= /usr/local',
    'OBJ = a.o',
    '',
    '## Run the unit tests',
    'test: build',
    '\t./run-tests --fast',
    '',
    'build lint: deps ## Compile everything',
    '\t$(CC) -o app main.c',
    '%.o: %.c',
    '\t$(CC) -c $<',
    'release: CFLAGS += -O2',
    'deploy::',
    '\t./deploy.sh',
    'define HELP',
    'fake: target inside define',
    'endef',
    'ifeq ($(OS),Darwin)',
    'mac-only:',
    '\techo mac',
    'endif',
    '# a comment: with a colon',
    '$(OUT): src',
  ].join('\n');
  const targets = makeTargets(text);
  assert.deepEqual(targets.map((t) => t.name), ['test', 'build', 'lint', 'deploy', 'mac-only']);
  assert.equal(targets[0].doc, 'Run the unit tests');
  assert.equal(targets[0].body, './run-tests --fast');
  assert.equal(targets[1].doc, 'Compile everything');
  assert.equal(targets.find((t) => t.name === 'deploy')?.body, './deploy.sh');
});

test('justfile recipes are the public ones, parameters shown, private and settings left out', () => {
  const text = [
    'set shell := ["bash", "-cu"]',
    'alias t := test',
    'version := "1.2.3"',
    'export RUST_BACKTRACE := "1"',
    '',
    '# Run every test',
    'test *args:',
    '    cargo test {{args}}',
    '',
    '_helper:',
    '    echo private',
    '',
    '[private]',
    'hidden:',
    '    echo hidden',
    '',
    '[doc("Build the release binary")]',
    '@build target="release": test',
    '    cargo build --{{target}}',
    '',
    'default:',
    '  just --list',
  ].join('\n');
  const recipes = justRecipes(text);
  assert.deepEqual(recipes.map((r) => r.name), ['test', 'build', 'default']);
  assert.equal(recipes[0].doc, 'Run every test');
  assert.match(recipes[0].body, /parameters: \*args/);
  assert.equal(recipes[1].doc, 'Build the release binary');
  assert.match(recipes[1].body, /cargo build/);
});

test('each source runs through its own tool, with the package manager the lockfile names', () => {
  assert.equal(packageManagerFor(['package.json', 'pnpm-lock.yaml']), 'pnpm');
  assert.equal(packageManagerFor(['yarn.lock']), 'yarn');
  assert.equal(packageManagerFor(['bun.lock']), 'bun');
  assert.equal(packageManagerFor(['package-lock.json']), 'npm');
  assert.equal(packageManagerFor([]), 'npm');
  assert.equal(commandFor({ source: 'package.json', name: 'test:unit' }, 'pnpm'), 'pnpm run test:unit');
  assert.equal(commandFor({ source: 'Makefile', name: 'build' }, 'npm'), 'make build');
  assert.equal(commandFor({ source: 'justfile', name: 'test' }, 'npm'), 'just test');
});

test('a name that is not one plain shell word is listed but never becomes a command', () => {
  for (const name of ['test; rm -rf ~', 'a b', '$(whoami)', '`id`', '-rf', '', 'x'.repeat(200), "it's"]) {
    assert.equal(runnableName(name), false, name);
    assert.equal(commandFor({ source: 'package.json', name }, 'npm'), null, name);
  }
  assert.equal(runnableName('lint:fix'), true);
  assert.equal(runnableName('@scope/build'), false, 'a leading @ is not a plain word');
});

test('favourites come first in the order they were starred', () => {
  const scripts = [
    { source: 'package.json' as const, name: 'dev' },
    { source: 'package.json' as const, name: 'test' },
    { source: 'Makefile' as const, name: 'test' },
    { source: 'justfile' as const, name: 'lint' },
  ];
  const ordered = orderScripts(scripts, [{ source: 'Makefile', name: 'test' }, { source: 'package.json', name: 'dev' }]);
  assert.deepEqual(ordered.map((s) => `${s.source}:${s.name}:${s.favourite}`),
    ['Makefile:test:true', 'package.json:dev:true', 'package.json:test:false', 'justfile:lint:false']);
});
