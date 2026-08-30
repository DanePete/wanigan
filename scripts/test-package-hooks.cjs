'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { afterPack, beforeBuild } = require('./prepare-node-pty-build.cjs');

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
    await fs.mkdir(path.dirname(packagedHelper), { recursive: true });
    await fs.writeFile(packagedHelper, 'helper');
    await fs.chmod(packagedHelper, 0o755);

    const afterPackContext = {
      appOutDir: fixture,
      electronPlatformName: 'darwin',
      packager: { appInfo: { productFilename: 'Wanigan' } },
    };
    await afterPack(afterPackContext);

    await fs.chmod(packagedHelper, 0o644);
    await assert.rejects(afterPack(afterPackContext), /not executable/);

    await fs.unlink(packagedHelper);
    await assert.rejects(afterPack(afterPackContext), /missing/);

    console.log('package hook checks passed');
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
