'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { afterPack, beforeBuild } = require('./prepare-node-pty-build.cjs');
const {
  assertSealedBundleSignature,
  hasUsableSigningIdentity,
  signLocalMacAppIfNeeded,
} = require('./sign-local-macos-app.cjs');
const { assertElectronAsarIntegrity, synchronizeElectronAsarIntegrity } = require('./macos-asar-integrity.cjs');

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'wanigan-package-hook-'));
  const release = path.join(fixture, 'node_modules', 'node-pty', 'build', 'Release');
  const marker = path.join(release, '.forge-meta');
  const helper = path.join(release, 'spawn-helper');
  const addon = path.join(release, 'pty.node');

  try {
    await fs.mkdir(release, { recursive: true });
    await Promise.all([
      fs.writeFile(marker, 'arm64--149'),
      fs.writeFile(helper, 'helper'),
      fs.writeFile(addon, 'addon'),
    ]);

    await beforeBuild({ appDir: fixture, platform: { nodeName: 'darwin' } });
    assert.equal(await exists(marker), false, 'macOS packaging must invalidate node-pty cache metadata');
    assert.equal(await exists(helper), true, 'cache invalidation must not touch spawn-helper');
    assert.equal(await exists(addon), true, 'cache invalidation must not touch pty.node');

    await fs.writeFile(marker, 'x64--149');
    await beforeBuild({ appDir: fixture, platform: { nodeName: 'linux' } });
    assert.equal(await exists(marker), true, 'non-macOS packaging must leave node-pty metadata alone');

    const packagedHelper = path.join(
      fixture,
      'Wanigan.app',
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'node_modules',
      'node-pty',
      'build',
      'Release',
      'spawn-helper'
    );
    const packagedApp = path.join(fixture, 'Wanigan.app');
    const packagedAsar = path.join(packagedApp, 'Contents', 'Resources', 'app.asar');
    const packagedInfo = path.join(packagedApp, 'Contents', 'Info.plist');
    await fs.mkdir(path.dirname(packagedHelper), { recursive: true });
    await fs.writeFile(packagedHelper, 'helper');
    await fs.chmod(packagedHelper, 0o755);
    await fs.mkdir(path.dirname(packagedAsar), { recursive: true });
    await fs.writeFile(packagedAsar, 'fixture asar bytes');
    await fs.writeFile(packagedInfo, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>ElectronAsarIntegrity</key><dict><key>Resources/app.asar</key><dict><key>hash</key><string>${'0'.repeat(64)}</string></dict></dict></dict></plist>`);

    const afterPackContext = {
      appOutDir: fixture,
      electronPlatformName: 'darwin',
      // This fixture deliberately is not a real .app, so explicitly mirror a
      // caller that opted out of signing while exercising the node-pty guard.
      packager: {
        appInfo: { productFilename: 'Wanigan' },
        platformSpecificBuildOptions: { identity: null },
        config: {},
      },
    };
    await afterPack(afterPackContext);
    if (process.platform === 'darwin') {
      await assertElectronAsarIntegrity(packagedApp);
    }

    await fs.chmod(packagedHelper, 0o644);
    await assert.rejects(afterPack(afterPackContext), /not executable/);

    await fs.unlink(packagedHelper);
    await assert.rejects(afterPack(afterPackContext), /missing/);

    assert.equal(hasUsableSigningIdentity('  1) ABCDEF0123456789ABCDEF0123456789ABCDEF01 "Developer ID Application: Example (TEAMID)"'), true,
      'a valid keychain identity must preserve electron-builder signing');
    assert.equal(hasUsableSigningIdentity('     0 valid identities found'), false,
      'the no-identity keychain result must allow the local fallback');
    assert.doesNotThrow(() => assertSealedBundleSignature(
      'Identifier=io.deadnorth.wanigan\nInfo.plist entries=35\nSealed Resources version=2 rules=13 files=264',
      'io.deadnorth.wanigan',
    ));
    assert.throws(() => assertSealedBundleSignature(
      'Identifier=Electron\nInfo.plist=not bound\nSealed Resources=none',
      'io.deadnorth.wanigan',
    ), /bundle identifier/);

    const signingContext = {
      appOutDir: fixture,
      electronPlatformName: 'darwin',
      packager: {
        appInfo: { productFilename: 'Wanigan', id: 'io.deadnorth.wanigan' },
        platformSpecificBuildOptions: {},
        config: {},
      },
    };
    const signingCalls = [];
    const signed = await signLocalMacAppIfNeeded(signingContext, {
      platform: 'darwin',
      environment: {},
      access: async () => {},
      log: () => {},
      execute: async (file, args) => {
        signingCalls.push([file, args]);
        if (file === '/usr/bin/security') return { stdout: '     0 valid identities found\n' };
        if (args[0] === '-dv') {
          return { stderr: 'Identifier=io.deadnorth.wanigan\nInfo.plist entries=35\nSealed Resources version=2 rules=13 files=264\n' };
        }
        return {};
      },
    });
    assert.equal(signed.signed, true, 'no identity must produce a sealed local ad-hoc app');
    assert.deepEqual(signingCalls.slice(1), [
      ['/usr/bin/codesign', ['--force', '--deep', '--sign', '-', path.join(fixture, 'Wanigan.app')]],
      ['/usr/bin/codesign', ['--verify', '--deep', '--strict', path.join(fixture, 'Wanigan.app')]],
      ['/usr/bin/codesign', ['-dv', '--verbose=4', path.join(fixture, 'Wanigan.app')]],
    ], 'the fallback must sign, verify, then prove that the bundle is sealed');

    const configured = await signLocalMacAppIfNeeded(signingContext, {
      platform: 'darwin',
      environment: { CSC_LINK: 'certificate.p12' },
      execute: async () => { throw new Error('a configured credential must not be probed or replaced'); },
    });
    assert.equal(configured.signed, false);
    assert.match(configured.reason, /CSC_LINK/);

    const identityAvailable = await signLocalMacAppIfNeeded(signingContext, {
      platform: 'darwin',
      environment: {},
      execute: async () => ({ stdout: '  1) ABCDEF0123456789ABCDEF0123456789ABCDEF01 "Developer ID Application: Example (TEAMID)"\n' }),
    });
    assert.deepEqual(identityAvailable, { signed: false, reason: 'identity-available' });

    const discoveryOptOutCalls = [];
    const discoveryOptOut = await signLocalMacAppIfNeeded(signingContext, {
      platform: 'darwin',
      environment: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
      access: async () => {},
      log: () => {},
      execute: async (file, args) => {
        discoveryOptOutCalls.push([file, args]);
        if (file === '/usr/bin/security') {
          return { stdout: '  1) ABCDEF0123456789ABCDEF0123456789ABCDEF01 "Developer ID Application: Example (TEAMID)"\n' };
        }
        if (args[0] === '-dv') {
          return { stderr: 'Identifier=io.deadnorth.wanigan\nInfo.plist entries=35\nSealed Resources version=2 rules=13 files=264\n' };
        }
        return {};
      },
    });
    assert.equal(discoveryOptOut.signed, true,
      'disabling builder identity discovery must still leave a sealed local app');
    assert.equal(discoveryOptOutCalls.filter(([file]) => file === '/usr/bin/codesign').length, 3);

    const integrityBytes = Buffer.from('archive that must be hashed exactly');
    const expectedIntegrity = crypto.createHash('sha256').update(integrityBytes).digest('hex');
    let embeddedIntegrity = 'f'.repeat(64);
    const integrityCalls = [];
    const integrityOptions = {
      filesystem: { readFile: async (file) => { assert.match(file, /Resources\/app\.asar$/); return integrityBytes; } },
      execute: async (file, args) => {
        integrityCalls.push([file, args]);
        if (args[0] !== '-c') throw new Error(`Unexpected integrity command: ${file}`);
        if (args[1].startsWith('Set ')) {
          embeddedIntegrity = args[1].split(' ').at(-1);
          return {};
        }
        if (args[1].startsWith('Print ')) return { stdout: `${embeddedIntegrity}\n` };
        throw new Error(`Unexpected integrity plist command: ${args[1]}`);
      },
    };
    assert.equal(await synchronizeElectronAsarIntegrity('/fixture/Wanigan.app', integrityOptions), expectedIntegrity,
      'afterPack derives ElectronAsarIntegrity from the exact packed archive bytes');
    assert.equal(await assertElectronAsarIntegrity('/fixture/Wanigan.app', integrityOptions), expectedIntegrity,
      'release verification accepts a matching embedded Electron archive checksum');
    embeddedIntegrity = '0'.repeat(64);
    await assert.rejects(assertElectronAsarIntegrity('/fixture/Wanigan.app', integrityOptions), /does not match/,
      'release verification rejects a stale embedded Electron archive checksum');
    assert.equal(integrityCalls.filter(([, args]) => args[1].startsWith('Set ')).length, 1,
      'integrity repair happens once before the app signature is sealed');

    console.log('package hook checks passed');
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
