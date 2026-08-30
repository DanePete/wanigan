'use strict';

// Fixture-only checks for the installer. This never calls the installer CLI,
// never invokes macOS tools, and never reads or changes /Applications.

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  APP_FILENAME,
  BUNDLE_IDENTIFIER,
  LAUNCH_STABILITY_MS,
  SPAWN_HELPER_RELATIVE_PATH,
  assertKnownInstalledWanigan,
  assertSignatureMetadata,
  assertVerifiedWaniganApp,
  installationPaths,
  launchAndVerifyInstalledWanigan,
  parseArguments,
  parseTargetProcessIds,
  privilegedCommand,
} = require('./install-local-macos.cjs');

const SEALED_METADATA = [
  `Identifier=${BUNDLE_IDENTIFIER}`,
  'Info.plist entries=32',
  'Sealed Resources version=2 rules=13 files=264',
].join('\n');

function fixtureExecutor(options = {}) {
  const identifier = options.identifier || BUNDLE_IDENTIFIER;
  const metadata = options.metadata || SEALED_METADATA;
  return async (file, args) => {
    if (file === '/usr/bin/plutil') {
      assert.equal(args[0], '-extract');
      return { stdout: `${identifier}\n` };
    }
    if (file === '/usr/bin/codesign' && args[0] === '--verify') return {};
    if (file === '/usr/bin/codesign' && args[0] === '-dv') return { stderr: metadata };
    throw new Error(`Unexpected fixture command: ${file} ${args.join(' ')}`);
  };
}

async function createFixtureBundle(root) {
  const app = path.join(root, APP_FILENAME);
  const info = path.join(app, 'Contents', 'Info.plist');
  const executable = path.join(app, 'Contents', 'MacOS', 'Wanigan');
  const helper = path.join(app, SPAWN_HELPER_RELATIVE_PATH);
  await fs.mkdir(path.dirname(info), { recursive: true });
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.mkdir(path.dirname(helper), { recursive: true });
  await fs.writeFile(info, '<?xml version="1.0"?><plist version="1.0"><dict/></plist>');
  await fs.writeFile(executable, '#!/bin/sh\nexit 0\n');
  await fs.writeFile(helper, '#!/bin/sh\nexit 0\n');
  await Promise.all([fs.chmod(executable, 0o755), fs.chmod(helper, 0o755)]);
  return { app, helper };
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wanigan-local-install-fixture-'));
  try {
    const { app, helper } = await createFixtureBundle(root);
    const verified = await assertVerifiedWaniganApp(app, { execute: fixtureExecutor() });
    assert.equal(verified.bundleIdentifier, BUNDLE_IDENTIFIER);
    assert.equal(verified.helper, helper);

    await fs.chmod(helper, 0o644);
    await assert.rejects(
      assertVerifiedWaniganApp(app, { execute: fixtureExecutor() }),
      /spawn-helper is not executable/,
      'a release missing the executable bit must never stage',
    );
    await fs.chmod(helper, 0o755);

    await assert.rejects(
      assertVerifiedWaniganApp(app, {
        execute: fixtureExecutor({ metadata: 'Identifier=Electron\nInfo.plist=not bound\nSealed Resources=none' }),
      }),
      /Code signature is not bound/,
      'an Electron-only thin signature must not pass as a sealed Wanigan app',
    );

    await assert.rejects(
      assertKnownInstalledWanigan(app, { execute: fixtureExecutor({ identifier: 'com.example.unrelated' }) }),
      /Refusing to replace/,
      'an unrelated bundle can never be overwritten at the target path',
    );

    assert.doesNotThrow(() => assertSignatureMetadata(SEALED_METADATA));
    assert.throws(
      () => assertSignatureMetadata(`Identifier=${BUNDLE_IDENTIFIER}\nInfo.plist=not bound\nSealed Resources=none`),
      /does not bind/,
    );

    const parsed = parseArguments(
      ['--source', '/tmp/Wanigan release/Wanigan.app', '--quit-timeout', '42', '--launch-timeout', '9'],
      { WANIGAN_APP_SOURCE: '/ignored/Wanigan.app' },
    );
    assert.equal(parsed.source, '/tmp/Wanigan release/Wanigan.app');
    assert.equal(parsed.quitTimeoutSeconds, 42);
    assert.equal(parsed.launchTimeoutSeconds, 9);
    assert.throws(() => parseArguments(['--unknown']), /Unknown option/);
    assert.throws(() => parseArguments(['--source', '/tmp/bad\nWanigan.app']), /line break/);
    assert.throws(() => parseArguments(['--quit-timeout', '0']), /between 0 and 300/);
    assert.throws(() => parseArguments(['--trash-dir', '/tmp/not-trash']), /must be a \.Trash directory/);

    const paths = installationPaths({
      applicationsDirectory: '/Applications',
      trashDirectory: '/Users/dane/.Trash',
      token: 'fixture-token',
      now: new Date('2026-08-30T12:00:00.000Z'),
    });
    assert.equal(paths.destination, '/Applications/Wanigan.app');
    assert.match(paths.stageRoot, /^\/Applications\/\.wanigan-install-/);
    assert.match(paths.backupApp, /^\/Applications\/\.wanigan-retired-/);
    assert.match(paths.trashApp, /^\/Users\/dane\/\.Trash\/Wanigan replaced /);
    assert.doesNotMatch(paths.trashApp, /previous/i);

    const exactExecutable = '/Applications/Wanigan.app/Contents/MacOS/Wanigan';
    assert.deepEqual(
      parseTargetProcessIds(`  201 ${exactExecutable}\n  202 /tmp/Wanigan.app/Contents/MacOS/Wanigan\n  201 ${exactExecutable} --type=renderer\n`, exactExecutable),
      [201],
      'only the exact installed bundle may receive a graceful Quit request',
    );

    const privileged = privilegedCommand({
      source: "/tmp/Wanigan's release/Wanigan.app",
      trashDirectory: '/Users/dane/.Trash',
    });
    assert.match(privileged, /--privileged-install/);
    assert.match(privileged, /Wanigan'\\''s release/);
    assert.match(privileged, /--trash-dir/);
    assert.doesNotMatch(privileged, /--launch/);

    const stableProcessTable = `  201 ${exactExecutable}\n`;
    let stablePolls = 0;
    const stableLaunch = await launchAndVerifyInstalledWanigan('/Applications/Wanigan.app', 1, {
      sleep: async (milliseconds) => { assert.equal(milliseconds, LAUNCH_STABILITY_MS); },
      execute: async (file, args) => {
        if (file === '/usr/bin/open') { assert.deepEqual(args, ['/Applications/Wanigan.app']); return {}; }
        if (file === '/bin/ps') { stablePolls += 1; return { stdout: stableProcessTable }; }
        throw new Error(`Unexpected stable-launch command: ${file} ${args.join(' ')}`);
      },
    });
    assert.deepEqual(stableLaunch, [201]);
    assert.equal(stablePolls, 2, 'a launch is observed both initially and after the full stability window');

    let exitPolls = 0;
    await assert.rejects(
      launchAndVerifyInstalledWanigan('/Applications/Wanigan.app', 1, {
        sleep: async (milliseconds) => { assert.equal(milliseconds, LAUNCH_STABILITY_MS); },
        execute: async (file, args) => {
          if (file === '/usr/bin/open') return {};
          if (file === '/bin/ps') {
            exitPolls += 1;
            return { stdout: exitPolls === 1 ? stableProcessTable : '' };
          }
          throw new Error(`Unexpected exiting-launch command: ${file} ${args.join(' ')}`);
        },
      }),
      /exited immediately/,
      'a process that vanishes during the stability window must fail the installer',
    );

    console.log('local macOS installer fixture checks passed');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
