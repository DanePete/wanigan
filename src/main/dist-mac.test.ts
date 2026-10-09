// Exercise the packaging command with owned executable stand-ins, never a real
// build, dependency rebuild, package, provider or installed app.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

type Outcome = number | 'signal' | 'missing';
interface Options { build?: Outcome; package?: Outcome; rebuild?: Outcome; customOutput?: boolean }
interface Call { stage: string; args: string[]; cwd: string; package: string }
const originalPackage = '{\n  "name": "owned-dist-fixture",\n  "version": "0.0.0",\n  "private": true\n}\n';
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

function packageFixture(options: Options = {}, temporaryRoot = tmpdir()) {
  const root = realpathSync(mkdtempSync(join(temporaryRoot, 'wanigan-dist-')));
  try {
    for (const path of ['scripts', 'node_modules/.bin', 'home', 'tmp']) mkdirSync(join(root, path), { recursive: true, mode: 0o700 });
    const script = join(root, 'scripts/dist-mac.mjs');
    copyFileSync(fileURLToPath(new URL('../../scripts/dist-mac.mjs', import.meta.url)), script);
    writeFileSync(join(root, 'package.json'), originalPackage);
    const stages = { 'electron-vite': options.build ?? 0, 'electron-builder': options.package ?? 0, 'electron-rebuild': options.rebuild ?? 0 };
    writeFileSync(join(root, 'stages.json'), JSON.stringify(stages));
    const runner = join(root, 'stand-in.cjs');
    writeFileSync(runner, `
const { appendFileSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const stage = process.argv[2];
const root = __dirname;
const outcome = JSON.parse(readFileSync(join(root, 'stages.json'), 'utf8'))[stage];
appendFileSync(join(root, 'calls.jsonl'), JSON.stringify({ stage, args: process.argv.slice(3), cwd: process.cwd(), package: readFileSync(join(root, 'package.json'), 'utf8') }) + '\\n');
if (stage === 'electron-vite') writeFileSync(join(root, 'package.json'), '{"rewritten":"build"}');
if (stage === 'electron-builder') {
  writeFileSync(join(root, 'package.json'), '{"rewritten":"package"}');
  const out = process.argv.find(arg => arg.startsWith('-c.directories.output=')).slice('-c.directories.output='.length);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'fixture-artifact'), 'owned fixture only');
}
if (outcome === 'signal') process.kill(process.pid, 'SIGTERM');
else process.exit(outcome);
`);
    for (const [stage, outcome] of Object.entries(stages)) if (outcome !== 'missing') {
      writeFileSync(join(root, 'node_modules/.bin', stage), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(runner)} ${quote(stage)} "$@"\n`, { mode: 0o700 });
    }
    const output = join(root, options.customOutput ? 'chosen-output' : 'release');
    const child = spawnSync(process.execPath, [script, ...(options.customOutput ? ['--out', output] : [])], {
      cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
      env: { HOME: join(root, 'home'), ZDOTDIR: join(root, 'home'), TMPDIR: join(root, 'tmp'), PATH: '/usr/bin:/bin',
        ELECTRON_RUN_AS_NODE: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    assert.equal(child.error, undefined); assert.equal(child.signal, null);
    const calls = readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Call);
    assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), originalPackage, 'source manifest survives every stage result');
    assert.ok(calls.every(call => call.cwd === root), 'commands run only in the fixture root');
    const restoration = calls.find(call => call.stage === 'electron-rebuild');
    if (restoration) assert.equal(restoration.package, originalPackage, 'source manifest restored before native restoration');
    return { status: child.status, stdout: child.stdout, stderr: child.stderr, calls, output,
      artifact: existsSync(join(output, 'fixture-artifact')), metadata: existsSync(join(output, '.metadata_never_index')) };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('packaging reports failed native restoration after a successful package and preserves source metadata', () => {
  const result = packageFixture({ rebuild: 17, customOutput: true });
  assert.deepEqual(result.calls.map(call => call.stage), ['electron-vite', 'electron-builder', 'electron-rebuild']);
  assert.deepEqual(result.calls[0]!.args, ['build']);
  assert.deepEqual(result.calls[1]!.args, ['--mac', '--arm64', '--publish', 'never', `-c.directories.output=${result.output}`]);
  assert.deepEqual(result.calls[2]!.args, ['-f', '-w', 'node-pty,better-sqlite3']);
  assert.ok(result.artifact); assert.ok(result.metadata);
  assert.equal(result.status, 17, 'a successful package cannot hide failed source-native restoration');
});

test('a successful package and restoration keep the default output and report success', () => {
  const result = packageFixture();
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls.map(call => call.stage), ['electron-vite', 'electron-builder', 'electron-rebuild']);
  assert.ok(result.output.endsWith('/release'));
  assert.ok(result.artifact); assert.ok(result.metadata);
  assert.doesNotMatch(result.stderr, /restoration failed/);
});

for (const rebuild of ['missing', 'signal'] as const) test(`a ${rebuild} native restoration cannot report packaging success`, () => {
  const result = packageFixture({ rebuild });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Native addon restoration failed/);
  assert.deepEqual(result.calls.map(call => call.stage), rebuild === 'missing'
    ? ['electron-vite', 'electron-builder'] : ['electron-vite', 'electron-builder', 'electron-rebuild']);
  assert.ok(result.artifact); assert.ok(result.metadata);
});

for (const rebuild of [0, 17]) test(`a package failure survives native restoration exit ${rebuild}`, () => {
  const result = packageFixture({ package: 9, rebuild });
  assert.equal(result.status, 9);
  assert.deepEqual(result.calls.map(call => call.stage), ['electron-vite', 'electron-builder', 'electron-rebuild']);
  assert.ok(result.artifact); assert.ok(result.metadata);
});

for (const rebuild of [0, 17]) test(`a build failure skips packaging but still restores the source before native restoration exit ${rebuild}`, () => {
  const result = packageFixture({ build: 8, rebuild });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.calls.map(call => call.stage), ['electron-vite', 'electron-rebuild']);
  assert.equal(result.artifact, false); assert.equal(result.metadata, false);
  assert.match(result.stderr, /Command failed/);
});

test('a missing packager still attempts restoration and remains a failure', () => {
  const result = packageFixture({ package: 'missing' });
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls.map(call => call.stage), ['electron-vite', 'electron-rebuild']);
  assert.equal(result.artifact, false); assert.equal(result.metadata, false);
});

// Temporary directories may be addressed through a symlink (for example macOS
// /var or /tmp). Exercise that spelling even when the runner's TMPDIR is canonical.
test('packaging fixture keeps commands inside its physical root through a temporary-directory alias', () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'wanigan-dist-alias-')));
  try {
    const physical = join(parent, 'physical');
    const alias = join(parent, 'alias');
    mkdirSync(physical); symlinkSync(physical, alias, 'dir');
    assert.notEqual(alias, realpathSync(alias));
    const result = packageFixture({}, alias);
    assert.equal(result.status, 0);
    assert.deepEqual(result.calls.map(call => call.stage), ['electron-vite', 'electron-builder', 'electron-rebuild']);
    assert.ok(result.calls.every(call => call.cwd.startsWith(physical + '/')));
    assert.equal(result.output, join(result.calls[0]!.cwd, 'release'));
    assert.deepEqual(result.calls[1]!.args, ['--mac', '--arm64', '--publish', 'never', `-c.directories.output=${result.output}`]);
    assert.ok(result.artifact); assert.ok(result.metadata);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
