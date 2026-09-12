'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { signLocalMacAppIfNeeded } = require('./sign-local-macos-app.cjs');
const { synchronizeElectronAsarIntegrity } = require('./macos-asar-integrity.cjs');
const { hardenElectronFuses } = require('./electron-fuses.cjs');

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
 * Keep macOS from offering build output as installed applications.
 *
 * A packaged `.app` under $HOME is a launchable application as far as Spotlight
 * is concerned, and `release/` being in .gitignore means nothing to it. Every
 * packaging run therefore adds two more "Wanigan" entries to Spotlight — and
 * feature-verification builds that copy their result back here for review add
 * two each and are never collected. That reached 21 bundles on one machine,
 * only one of which was the install in /Applications.
 *
 * `.metadata_never_index` at the output root is the documented way to tell
 * mdworker to skip a tree. Written here rather than in the npm scripts so it
 * covers every dist target, including a run that overrides the output
 * directory — the marker lands beside whatever `appOutDir` this build used.
 *
 * Best-effort on purpose: a release must not fail because a Spotlight hint
 * could not be written.
 *
 * @param {string} outRoot
 * @returns {Promise<void>}
 */
async function excludeOutputFromSpotlight(outRoot) {
  try {
    await fs.writeFile(path.join(outRoot, '.metadata_never_index'), '');
  } catch {
    /* an unindexed release is a convenience, never a release requirement */
  }
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
async function afterPack(context, options = {}) {
  if (context.electronPlatformName !== 'darwin') return;
  await (options.excludeOutputFromSpotlight || excludeOutputFromSpotlight)(path.dirname(context.appOutDir));

  const hostPlatform = options.hostPlatform || process.platform;
  // Flipping a macOS framework's fuses, synchronizing its Info.plist hash,
  // and sealing the result are release requirements, not optional niceties.
  // A non-macOS host cannot honestly verify all three, so fail closed rather
  // than creating a signed-looking Darwin artifact with default fuses.
  if (hostPlatform !== 'darwin') {
    throw new Error('Wanigan macOS releases must be built on macOS so Electron fuses and archive integrity can be verified.');
  }

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
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  // Flip the immutable Electron runtime fuses before Info.plist is sealed.
  // The read-back inside this helper makes a package fail rather than ship if
  // an Electron upgrade changes the fuse wire or a build step resets it.
  await (options.hardenElectronFuses || hardenElectronFuses)(appPath);
  await (options.synchronizeElectronAsarIntegrity || synchronizeElectronAsarIntegrity)(appPath);

  // electron-builder skips its signing phase when this Mac has no valid
  // identity. Seal that local app before artifacts are made; the helper itself
  // decides whether a configured/available Developer ID signer should retain
  // full control of the normal signing and notarization flow.
  await (options.signLocalMacAppIfNeeded || signLocalMacAppIfNeeded)(context);
}

exports.excludeOutputFromSpotlight = excludeOutputFromSpotlight;
exports.beforeBuild = beforeBuild;
exports.afterPack = afterPack;
