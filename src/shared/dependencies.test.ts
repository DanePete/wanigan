/**
 * Dependency readers. Each format gets its populated case, its empty case and
 * its malformed case, because a reader that returns [] for a file it could not
 * read reports "no new dependencies" about a diff that added three.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeDepChange, diffDependencies, isInstallCommand, manifestKind, readManifest, type DepEntry, type ManifestKind } from './dependencies.ts';

const read = (kind: ManifestKind, text: string | null): DepEntry[] => {
  const r = readManifest(kind, text);
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  return r.ok ? r.entries : [];
};
const names = (entries: DepEntry[]) => entries.map((e) => `${e.section}:${e.name}@${e.version}`);

test('manifest kinds come from the file name, at any depth', () => {
  assert.equal(manifestKind('packages/web/package.json'), 'package.json');
  assert.equal(manifestKind('requirements-dev.txt'), 'requirements.txt');
  assert.equal(manifestKind('requirements.txt'), 'requirements.txt');
  assert.equal(manifestKind('Gemfile'), 'Gemfile');
  assert.equal(manifestKind('Gemfile.lock'), null);
  assert.equal(manifestKind('src/package.ts'), null);
});

test('every reader treats an absent or empty side as an empty manifest', () => {
  const kinds: ManifestKind[] = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'composer.json', 'Gemfile'];
  for (const kind of kinds) {
    assert.deepEqual(readManifest(kind, null), { ok: true, entries: [], note: null }, kind);
    assert.deepEqual(readManifest(kind, '  \n'), { ok: true, entries: [], note: null }, kind);
  }
});

test('malformed JSON, a pnpm lock without its version line and a go.mod without a module are refused with a reason', () => {
  for (const [kind, text] of [['package.json', '{"dependencies": {'], ['composer.json', '[1,2]'], ['package-lock.json', 'nope'],
    ['pnpm-lock.yaml', 'importers:\n  .:\n'], ['go.mod', 'require x v1']] as [ManifestKind, string][]) {
    const r = readManifest(kind, text);
    assert.equal(r.ok, false, kind);
  }
});

test('package.json: the four dependency sections, and a diff that adds, upgrades, downgrades and removes', () => {
  const before = read('package.json', JSON.stringify({ dependencies: { react: '^18.2.0', lodash: '4.17.21', moment: '2.29.0' }, devDependencies: { vitest: '^2.0.0' } }));
  const after = read('package.json', JSON.stringify({ dependencies: { react: '^19.0.0', lodash: '4.17.20', 'left-pad': '1.3.0' }, devDependencies: { vitest: '^2.0.0' }, peerDependencies: { vue: '*' } }));
  const changes = diffDependencies(before, after);
  assert.deepEqual(changes.map((c) => [c.change, c.section, c.name, c.before, c.after]), [
    ['added', 'dependencies', 'left-pad', null, '1.3.0'],
    ['added', 'peerDependencies', 'vue', null, '*'],
    ['upgraded', 'dependencies', 'react', '^18.2.0', '^19.0.0'],
    ['downgraded', 'dependencies', 'lodash', '4.17.21', '4.17.20'],
    ['removed', 'dependencies', 'moment', '2.29.0', null],
  ]);
  assert.equal(describeDepChange(changes[0], 'package.json'), 'added `left-pad` 1.3.0 (package.json dependencies)');
  assert.equal(describeDepChange(changes[2], 'package.json'), 'upgraded `react` ^18.2.0 → ^19.0.0 (package.json dependencies)');
});

test('package-lock.json: top-level packages only, in both lockfile shapes', () => {
  const v3 = read('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {
    '': { name: 'app' }, 'node_modules/react': { version: '19.0.0' }, 'node_modules/@types/node': { version: '22.0.0', dev: true },
    'node_modules/react/node_modules/loose-envify': { version: '1.4.0' },
  } }));
  assert.deepEqual(names(v3), ['installed:react@19.0.0', 'installed (dev):@types/node@22.0.0']);
  const v1 = read('package-lock.json', JSON.stringify({ lockfileVersion: 1, dependencies: { react: { version: '16.0.0' } } }));
  assert.deepEqual(names(v1), ['installed:react@16.0.0']);
});

test('pnpm-lock.yaml: the root importer in version 9, and top-level sections in version 5', () => {
  const v9 = [
    "lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    dependencies:', "      '@babel/core':", '        specifier: ^7.25.0',
    '        version: 7.25.2(supports-color@9.0.0)', '      react:', '        specifier: ^19.0.0', '        version: 19.0.0',
    '    devDependencies:', '      vitest:', '        specifier: ^2.1.0', '        version: 2.1.1', '', '  packages/web:',
    '    dependencies:', '      vue:', '        specifier: ^3', '        version: 3.5.0', '', 'packages:', '', '  react@19.0.0:', '    resolution: {}',
  ].join('\n');
  assert.deepEqual(names(read('pnpm-lock.yaml', v9)), ['dependencies:@babel/core@7.25.2', 'dependencies:react@19.0.0', 'devDependencies:vitest@2.1.1']);
  const v5 = ['lockfileVersion: 5.4', '', 'specifiers:', '  react: ^17', '', 'dependencies:', '  react: 17.0.2', '', 'packages:', '', '  /react/17.0.2:', '    dev: false'].join('\n');
  assert.deepEqual(names(read('pnpm-lock.yaml', v5)), ['dependencies:react@17.0.2']);
});

test('yarn.lock: classic and berry headers, and it says it lists every resolved package', () => {
  const classic = ['# yarn lockfile v1', '', '"@babel/core@^7.0.0", "@babel/core@^7.1.0":', '  version "7.25.2"', '  resolved "https://x"', '', 'left-pad@1.3.0:', '  version "1.3.0"', ''].join('\n');
  const r = readManifest('yarn.lock', classic);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(names(r.entries), ['resolved:@babel/core@7.25.2', 'resolved:left-pad@1.3.0']);
    assert.match(r.note ?? '', /not only direct dependencies/);
  }
  const berry = ['__metadata:', '  version: 8', '', '"react@npm:^19.0.0":', '  version: 19.0.0', '  resolution: "react@npm:19.0.0"', ''].join('\n');
  assert.deepEqual(names(read('yarn.lock', berry)), ['resolved:react@19.0.0']);
});

test('pyproject.toml: PEP 621 arrays across lines, optional groups, and poetry tables', () => {
  const text = [
    '[project]', 'name = "app"', 'dependencies = [', '  "requests[socks]>=2.31",', "  'Django_Rest~=3.15 ; python_version>\"3.10\"',", ']',
    '[project.optional-dependencies]', 'test = ["pytest>=8"]',
    '[tool.poetry.dependencies]', 'python = "^3.12"', 'httpx = "^0.27"', 'rich = { version = "^13.7", optional = true }',
    '[tool.poetry.group.dev.dependencies]', 'ruff = "0.6.0"',
  ].join('\n');
  assert.deepEqual(names(read('pyproject.toml', text)), [
    'project.dependencies:requests@>=2.31', 'project.dependencies:django-rest@~=3.15',
    'project.optional-dependencies.test:pytest@>=8',
    'tool.poetry.dependencies:httpx@^0.27', 'tool.poetry.dependencies:rich@^13.7',
    'tool.poetry.group.dev.dependencies:ruff@0.6.0',
  ]);
});

test('requirements.txt: pins and ranges, with options and URLs counted as not read', () => {
  const r = readManifest('requirements.txt', ['# pinned', 'flask==3.0.3', 'numpy>=2  # math', '-r base.txt', '-e git+https://x/y.git#egg=y', 'uvicorn'].join('\n'));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(names(r.entries), ['requirements:flask@==3.0.3', 'requirements:numpy@>=2', 'requirements:uvicorn@null']);
    assert.equal(r.note, '2 lines (options, includes or URLs) not read as packages.');
  }
});

test('go.mod: single and block requires, with indirect marked', () => {
  const text = ['module example.com/app', '', 'go 1.23', '', 'require github.com/a/b v1.2.3', '', 'require (', '\tgithub.com/c/d v0.4.0', '\tgolang.org/x/text v0.16.0 // indirect', ')'].join('\n');
  assert.deepEqual(names(read('go.mod', text)), ['require:github.com/a/b@v1.2.3', 'require:github.com/c/d@v0.4.0', 'require (indirect):golang.org/x/text@v0.16.0']);
});

test('Cargo.toml: plain, inline-table, workspace and target-specific dependencies', () => {
  const text = ['[package]', 'name = "app"', '[dependencies]', 'serde = { version = "1.0", features = ["derive"] }', 'anyhow = "1"', 'tokio.workspace = true',
    '[dev-dependencies]', 'insta = "1.39"', "[target.'cfg(unix)'.dependencies]", 'nix = "0.29"'].join('\n');
  assert.deepEqual(names(read('Cargo.toml', text)), ['dependencies:serde@1.0', 'dependencies:anyhow@1', 'dependencies:tokio@workspace', 'dev-dependencies:insta@1.39', 'dependencies:nix@0.29']);
});

test('composer.json and Gemfile', () => {
  assert.deepEqual(names(read('composer.json', JSON.stringify({ require: { php: '^8.3', 'drupal/core': '^11' }, 'require-dev': { 'phpunit/phpunit': '^11' } }))),
    ['require:php@^8.3', 'require:drupal/core@^11', 'require-dev:phpunit/phpunit@^11']);
  const gemfile = ["source 'https://rubygems.org'", "gem 'rails', '~> 7.2'", 'gem "pg"', 'group :development, :test do', "  gem 'rspec-rails'", 'end'].join('\n');
  assert.deepEqual(names(read('Gemfile', gemfile)), ['gems:rails@~> 7.2', 'gems:pg@null', 'group development, test:rspec-rails@null']);
});

test('install commands are recognised by shape, and a test run is not one', () => {
  for (const c of ['npm install left-pad', 'npm i', 'cd web && pnpm add zod', 'yarn', 'yarn add react', 'pip install requests', 'python -m pip install -r requirements.txt',
    'uv add httpx', 'poetry add rich', 'go get github.com/a/b', 'cargo add serde', 'composer require drupal/token', 'bundle install', 'bundle', 'gem install rails', 'npm ci']) {
    assert.equal(isInstallCommand(c), true, c);
  }
  for (const c of ['npm test', 'yarn test', 'pnpm run build', 'go test ./...', 'cargo test', 'bundle exec rspec', 'grep install README.md', 'npm run lint']) {
    assert.equal(isInstallCommand(c), false, c);
  }
});
