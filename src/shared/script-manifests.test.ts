/**
 * One reader, two surfaces. The script launcher lists what a project declares
 * and the approval explainer resolves what an alias runs; both read the files
 * through script-manifests.ts, and these tests hold them to the same answer on
 * the same fixtures — including the lines each used to get wrong on its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJustfile, readMakefile, readPackageScripts, recipeCommand } from './script-manifests.ts';
import { justRecipes, makeTargets, packageScripts } from './project-scripts.ts';
import { explainCommand, type ManifestFiles } from './script-explain.ts';

const CWD = '/work/app';
const files = (name: string, text: string): ManifestFiles => ({ now: { [`${CWD}/${name}`]: text }, launch: null, launchCommit: null });
const explain = (command: string, name: string, text: string) => explainCommand(command, CWD, files(name, text))!.scripts[0];

const MAKEFILE = [
  '.PHONY: test build',
  'CC := clang',
  'A :::= b',
  '',
  '## Run the unit tests',
  'test: build',
  '\t@./run-tests --fast',
  '',
  '\t-echo after a blank line',
  'build lint: deps ## Compile everything',
  '\t$(CC) -o app main.c',
  'deps:',
  '\tnpm ci',
  '%.o: %.c',
  '\t$(CC) -c $<',
  'release: CFLAGS += -O2',
  'deploy::',
  '\t./deploy.sh',
  'define HELP',
  'fake: target inside define',
  '\techo never a recipe',
  'endef',
  'override-config:',
  '\tcp config.example config',
  'mac-only:',
  'ifeq ($(OS),Darwin)',
  '\techo mac',
  'else',
  '\techo other',
  'endif',
  '$(OUT): src',
  'inline: ; echo "# not a comment"',
].join('\n');

const JUSTFILE = [
  'set shell := ["bash", "-cu"]',
  'alias t := test',
  'version := "1.2.3"',
  '',
  '# Run every test',
  'test *args:',
  '    cargo test {{args}}',
  '',
  '    cargo test --doc',
  '',
  '_helper:',
  '    echo private',
  '',
  '[private]',
  'hidden: _helper',
  '    echo hidden',
  '',
  '[doc("Build the release binary")]',
  '@build target="release:fast": test',
  '    @cargo build --{{target}}',
].join('\n');

test('every Makefile target the launcher lists is one the explainer resolves, with the same recipe lines', () => {
  const listed = makeTargets(MAKEFILE);
  assert.deepEqual(listed.map((t) => t.name), ['test', 'build', 'lint', 'deps', 'deploy', 'override-config', 'mac-only', 'inline']);
  for (const target of listed) {
    const s = explain(`make ${target.name}`, 'Makefile', MAKEFILE);
    assert.equal(s.found, true, target.name);
    const own = s.steps.filter((x) => x.depth === 0).map((x) => x.command);
    assert.deepEqual(target.body.split('\n').filter(Boolean).map((l) => recipeCommand(l, 'make')), own.slice(0, 3), target.name);
  }
});

test('a line neither surface should offer is refused by both: a define body, a target-specific variable, a pattern rule', () => {
  const listed = new Set(makeTargets(MAKEFILE).map((t) => t.name));
  for (const name of ['fake', 'release']) {
    assert.equal(listed.has(name), false, name);
    assert.equal(explain(`make ${name}`, 'Makefile', MAKEFILE).found, false, name);
  }
  // A pattern rule is followed by the explainer when a prerequisite names it,
  // and never offered by the launcher: nobody types `make %.o`.
  assert.equal(listed.has('%.o'), false);
  assert.ok(readMakefile(MAKEFILE).rules.some((r) => r.targets.includes('%.o')));
  assert.equal(readMakefile(MAKEFILE).vars.A, 'b', ':::= is an assignment, not a rule named A');
});

test('recipe lines survive blank lines and conditionals, and a comment is stripped only from prerequisites', () => {
  const mk = readMakefile(MAKEFILE);
  const rule = (name: string) => mk.rules.find((r) => r.targets.includes(name))!;
  assert.deepEqual(rule('test').recipe, ['@./run-tests --fast', '-echo after a blank line']);
  assert.deepEqual(rule('mac-only').recipe, ['echo mac', 'echo other'], 'both branches are kept and neither is claimed to be the one that runs');
  assert.deepEqual(rule('build').prereqs, ['deps']);
  assert.equal(rule('build').doc, 'Compile everything');
  assert.deepEqual(rule('inline').recipe, ['echo "# not a comment"']);
  assert.equal(makeTargets(MAKEFILE).find((t) => t.name === 'test')?.doc, 'Run the unit tests');
});

test('every public just recipe the launcher lists resolves in the explainer; private ones resolve but are not listed', () => {
  const listed = justRecipes(JUSTFILE);
  assert.deepEqual(listed.map((r) => r.name), ['test', 'build']);
  for (const recipe of listed) {
    const s = explain(`just ${recipe.name}`, 'justfile', JUSTFILE);
    assert.equal(s.found, true, recipe.name);
    const own = s.steps.filter((x) => x.depth === 0).map((x) => x.command);
    const bodyLines = recipe.body.split('\n').filter((l) => !l.startsWith('(parameters:'));
    assert.deepEqual(bodyLines.map((l) => recipeCommand(l, 'just')), own.slice(0, 3), recipe.name);
  }
  for (const hidden of ['_helper', 'hidden']) {
    assert.equal(explain(`just ${hidden}`, 'justfile', JUSTFILE).found, true, `${hidden} is runnable, so an approval still explains it`);
  }
  const build = readJustfile(JUSTFILE).recipes.find((r) => r.name === 'build')!;
  assert.equal(build.params, 'target="release:fast"', 'a colon inside a quoted default does not end the parameter list');
  assert.deepEqual(build.deps, ['test']);
  assert.equal(listed[1].doc, 'Build the release binary');
  assert.deepEqual(readJustfile(JUSTFILE).recipes.find((r) => r.name === 'test')!.body, ['cargo test {{args}}', 'cargo test --doc']);
});

test('package.json: the listed scripts are the resolvable ones, and the three unreadable shapes read the same on both surfaces', () => {
  const manifest = JSON.stringify({ scripts: { build: 'tsc -b', 'lint:fix': 'eslint . --fix', weird: 42 } });
  const listed = packageScripts(manifest).scripts;
  assert.deepEqual(listed.map((s) => s.name), ['build', 'lint:fix']);
  for (const script of listed) {
    const s = explain(`npm run ${script.name}`, 'package.json', manifest);
    assert.equal(s.found, true);
    assert.equal(s.steps[0].command, script.body);
  }
  assert.equal(explain('npm run weird', 'package.json', manifest).found, false, 'a non-string body is not a script on either surface');

  // An array of scripts used to become scripts named "0" and "1" in the explainer.
  const arrayScripts = JSON.stringify({ scripts: ['tsc'] });
  assert.match(packageScripts(arrayScripts).problem ?? '', /"scripts" is not an object/);
  assert.equal(explain('npm run 0', 'package.json', arrayScripts).found, false);
  assert.deepEqual(readPackageScripts(arrayScripts), { ok: false, problem: 'scripts-not-an-object' });

  const notObject = '[1, 2]';
  assert.match(packageScripts(notObject).problem ?? '', /not a JSON object/);
  assert.ok(explain('npm run build', 'package.json', notObject).notes.some((n) => /is not a JSON object/.test(n)));
  assert.ok(explain('npm run build', 'package.json', '{ nope').notes.some((n) => /not valid JSON/.test(n)));
  assert.match(packageScripts('{ nope').problem ?? '', /not valid JSON/);
});
