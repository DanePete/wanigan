'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile: execFileCallback } = require('node:child_process');
const { promisify } = require('node:util');

const execFile = promisify(execFileCallback);

/**
 * electron-builder intentionally leaves a macOS app unsigned when neither a
 * certificate nor an explicit `mac.identity` is available. Electron's own
 * executable still carries its thin linker signature in that case, however,
 * so Finder sees an app bundle whose Info.plist and resources are not sealed.
 * On current macOS releases that can make a locally-built app appear to open
 * and immediately disappear.
 *
 * A Developer ID (or any explicitly configured signing source) must remain in
 * charge of normal release signing and notarization. This hook only provides a
 * local, no-certificate fallback: it seals the already-packed bundle with an
 * ad-hoc signature before electron-builder decides that there is no identity.
 */

const SIGNING_ENVIRONMENT_KEYS = ['CSC_LINK', 'CSC_NAME', 'CSC_KEYCHAIN'];

/** @param {Record<string, string | undefined>} environment */
function configuredSigningSource(environment) {
  return SIGNING_ENVIRONMENT_KEYS.find((key) => Object.hasOwn(environment, key)) || null;
}

/** @param {unknown} output */
function hasUsableSigningIdentity(output) {
  // `security find-identity` only prints numbered entries for valid
  // identities. Treat any such entry as owned by electron-builder so a local
  // fallback never pre-empts Developer ID, Mac Developer, or a custom signer.
  return /^\s*\d+\)\s+[0-9A-F]{40}\s+"[^"]+"\s*$/im.test(String(output));
}

/** @param {any} context */
function appPathForContext(context) {
  const appOutDir = context?.appOutDir;
  const productFilename = context?.packager?.appInfo?.productFilename;
  if (typeof appOutDir !== 'string' || typeof productFilename !== 'string' || !productFilename) {
    throw new Error('Cannot locate the packaged macOS app for local signing.');
  }
  return path.resolve(appOutDir, `${productFilename}.app`);
}

/** @param {any} context */
function explicitlyConfiguredIdentity(context) {
  const mac = context?.packager?.platformSpecificBuildOptions;
  if (mac && Object.hasOwn(mac, 'identity') && mac.identity !== undefined) return 'mac.identity';

  // cscLink is accepted at the root and mac configuration levels. It is
  // commonly a .p12 URL/base64 value that electron-builder imports *after*
  // afterPack, so checking the keychain alone would miss it.
  if (mac?.cscLink != null) return 'mac.cscLink';
  if (context?.packager?.config?.cscLink != null) return 'cscLink';
  return null;
}

/**
 * Verify the properties that distinguish a sealed bundle from Electron's
 * untouched thin executable signature. `codesign --verify` alone is not
 * enough: it reports the unsealed Electron executable as valid too.
 *
 * @param {string} metadata
 * @param {string | undefined} expectedIdentifier
 */
function assertSealedBundleSignature(metadata, expectedIdentifier) {
  if (expectedIdentifier && !metadata.includes(`Identifier=${expectedIdentifier}`)) {
    throw new Error(`Local ad-hoc signing did not bind the expected bundle identifier (${expectedIdentifier}).`);
  }
  if (/^Info\.plist=not bound$/m.test(metadata)) {
    throw new Error('Local ad-hoc signing did not bind the app Info.plist.');
  }
  const seal = metadata.match(/^Sealed Resources(?:=|\s+)(.+)$/m);
  if (!seal || /\bnone\b/i.test(seal[1])) {
    throw new Error('Local ad-hoc signing did not seal the app resources.');
  }
}

/**
 * Seal a locally built macOS app only when electron-builder has no signing
 * identity to use. Returns a structured result so the hook has isolated tests
 * without requiring a macOS keychain or a real .app bundle.
 *
 * @param {any} context electron-builder AfterPackContext
 * @param {{
 *   platform?: string,
 *   environment?: Record<string, string | undefined>,
 *   execute?: (file: string, args: string[]) => Promise<{ stdout?: string, stderr?: string }>,
 *   access?: (file: string) => Promise<void>,
 *   log?: (message: string) => void,
 * }} [options]
 */
async function signLocalMacAppIfNeeded(context, options = {}) {
  if (context?.electronPlatformName !== 'darwin') return { signed: false, reason: 'not-macos-target' };
  if ((options.platform || process.platform) !== 'darwin') return { signed: false, reason: 'not-macos-host' };

  const environment = options.environment || process.env;
  const configured = explicitlyConfiguredIdentity(context) || configuredSigningSource(environment);
  if (configured) return { signed: false, reason: `configured-${configured}` };

  const execute = options.execute || ((file, args) => execFile(file, args));
  const access = options.access || ((file) => fs.access(file));
  const log = options.log || console.log;

  let identities;
  try {
    identities = await execute('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  } catch (error) {
    // Do not overwrite a potentially usable signing setup if the keychain
    // cannot be inspected. electron-builder will surface that configuration
    // problem in its normal signing phase.
    log('  • skipped local ad-hoc signing because macOS signing identities could not be inspected');
    return { signed: false, reason: 'identity-inspection-failed', error };
  }

  // An explicit discovery opt-out tells electron-builder not to use a random
  // keychain identity. In that case this local fallback remains the safe
  // sealed result unless the caller also configured a concrete signer above.
  const autoDiscoveryDisabled = environment.CSC_IDENTITY_AUTO_DISCOVERY === 'false';
  if (!autoDiscoveryDisabled && hasUsableSigningIdentity(`${identities?.stdout || ''}\n${identities?.stderr || ''}`)) {
    return { signed: false, reason: 'identity-available' };
  }

  const appPath = appPathForContext(context);
  await access(appPath);
  log('  • sealing local macOS app with an ad-hoc signature (no signing identity available)');
  await execute('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath]);
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
  const display = await execute('/usr/bin/codesign', ['-dv', '--verbose=4', appPath]);
  assertSealedBundleSignature(
    `${display?.stdout || ''}\n${display?.stderr || ''}`,
    context?.packager?.appInfo?.id,
  );
  return { signed: true, reason: 'no-identity' };
}

exports.appPathForContext = appPathForContext;
exports.assertSealedBundleSignature = assertSealedBundleSignature;
exports.hasUsableSigningIdentity = hasUsableSigningIdentity;
exports.signLocalMacAppIfNeeded = signLocalMacAppIfNeeded;
