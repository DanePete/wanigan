'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { signLocalMacAppIfNeeded } = require('./sign-local-macos-app.cjs');
const { synchronizeElectronAsarIntegrity } = require('./macos-asar-integrity.cjs');

/**
 * electron-builder runs @electron/rebuild without force. Its `.forge-meta`
 * cache key contains only `<arch>--<Electron ABI>`, while node-pty's macOS
 * binding.gyp emits both `pty.node` and the executable `spawn-helper`.
 *
 * A cancelled or older partial build can therefore leave a valid-looking
 * marker beside an incomplete Release directory. Removing only the marker
 * makes electron-builder rebuild node-pty for the current target; its normal
 * build then emits both files, rather than letting a stale cache ship a
 * terminal that cannot launch a child process.
 *
 * @param {{ appDir: string, platform: { nodeName?: string } | string }} context
 * @returns {Promise<true>}
 */
async function beforeBuild(context) {
  const platform = typeof context.platform === 'string' ? context.platform : context.platform?.nodeName;
  if (platform !== 'darwin') return true;

  const marker = path.join(
    context.appDir,
    'node_modules',
    'node-pty',
    'build',
    'Release',
    '.forge-meta'
  );

  try {
    await fs.unlink(marker);
    console.log('  • invalidated node-pty native rebuild cache to include spawn-helper');
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }

  return true;
}

/**
 * Keep a missing helper from becoming a release artifact. This runs after the
 * app files have been copied and unpacked, but before electron-builder signs
 * and archives the app, so a failure is both actionable and safe.
 *
 * @param {{
 *   appOutDir: string,
 *   electronPlatformName: string,
 *   packager: { appInfo: { productFilename: string } }
 * }} context
 * @returns {Promise<void>}
 */
async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const helper = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
    'build',
    'Release',
    'spawn-helper'
  );

  let stat;
  try {
    stat = await fs.stat(helper);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`node-pty spawn-helper is missing from the packaged app: ${helper}`);
    }
    throw error;
  }

  if (!stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new Error(`node-pty spawn-helper is not executable in the packaged app: ${helper}`);
  }

  // Electron's fuse can verify this archive before Node starts. Keep the
  // embedded checksum current before any ad-hoc or Developer ID signature
  // seals Info.plist; otherwise a package can pass codesign yet fail once the
  // integrity fuse is enabled.
  if (process.platform === 'darwin') {
    await synchronizeElectronAsarIntegrity(path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`));
  }

  // electron-builder skips its signing phase when this Mac has no valid
  // identity. Seal that local app before artifacts are made; the helper itself
  // decides whether a configured/available Developer ID signer should retain
  // full control of the normal signing and notarization flow.
  await signLocalMacAppIfNeeded(context);
}

exports.beforeBuild = beforeBuild;
exports.afterPack = afterPack;
