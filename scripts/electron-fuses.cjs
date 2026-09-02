'use strict';

// @electron/fuses 2.x is ESM-only. Keep this hook CommonJS because
// electron-builder loads hooks through require(), and load the supported
// package lazily at the point where a macOS release is actually built.
let fusesModulePromise;

function loadFuses() {
  fusesModulePromise ||= import('@electron/fuses');
  return fusesModulePromise;
}

// @electron/fuses intentionally exposes this wire as ASCII "0"/"1" bytes,
// but does not export its internal FuseState enum as public API.
const FUSE_DISABLED = 48;
const FUSE_ENABLED = 49;

// These are the stable V1 wire positions published by @electron/fuses 2.x.
// Keeping the policy keyed by wire position means it remains inspectable by
// CommonJS packaging hooks. `strictlyRequireAllFuses` below makes an Electron
// upgrade fail closed if its wire ever gains another slot.
const FUSE_OPTION_NAMES = Object.freeze([
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
  'WasmTrapHandlers',
]);

/**
 * These are packaging-time controls, not runtime preferences.  A release must
 * either have every current V1 fuse configured here or fail to package: an
 * Electron upgrade must never quietly restore an unsafe default.
 *
 * `GrantFileProtocolExtraPrivileges` deliberately stays on. Wanigan's bundled
 * renderer is loaded from file:// and Electron documents this fuse as the
 * compatibility setting for that application shape. The renderer is still
 * sandboxed, origin-pinned and forbidden from navigating; relaxing that fuse
 * would break the local shell rather than reduce a reachable privilege.
 */
const FUSE_POLICY = Object.freeze({
  0: false, // RunAsNode
  1: true, // EnableCookieEncryption
  2: false, // EnableNodeOptionsEnvironmentVariable
  3: false, // EnableNodeCliInspectArguments
  4: true, // EnableEmbeddedAsarIntegrityValidation
  5: true, // OnlyLoadAppFromAsar
  // Off, and not as a relaxation: this is a build-shape switch, not a privilege
  // control. Enabling it tells the browser process to load
  // browser_v8_context_snapshot.<arch>.bin instead of the ordinary
  // v8_context_snapshot.<arch>.bin, and electron-builder ships only the latter.
  // With it on, every packaged build died before drawing a window —
  // "FATAL:gin/v8_initializer.cc: Error loading V8 startup snapshot file" —
  // which reads like a corrupt download rather than a fuse. Turn it on only
  // alongside a build that actually produces the browser-specific snapshot.
  6: false, // LoadBrowserProcessSpecificV8Snapshot
  7: true, // GrantFileProtocolExtraPrivileges
  8: true, // WasmTrapHandlers
});

function expectedState(enabled) {
  return enabled ? FUSE_ENABLED : FUSE_DISABLED;
}

function fuseName(option, fuses) {
  return fuses.FuseV1Options?.[option] || FUSE_OPTION_NAMES[option] || `fuse ${option}`;
}

/**
 * Verify the bytes in the packaged Electron framework rather than trusting a
 * build log. `@electron/fuses` returns byte values (ASCII 0/1), not booleans.
 */
async function assertHardenedElectronFuses(appPath, options = {}) {
  const fuses = options.fuses || await loadFuses();
  const read = options.getCurrentFuseWire || fuses.getCurrentFuseWire;
  const wire = await read(appPath);
  if (wire?.version !== fuses.FuseVersion.V1) {
    throw new Error(`Wanigan requires Electron fuse wire V${fuses.FuseVersion.V1}; packaged Electron reported ${String(wire?.version)}.`);
  }

  for (const [rawOption, enabled] of Object.entries(FUSE_POLICY)) {
    const option = Number(rawOption);
    const actual = Number(wire[option]);
    const expected = expectedState(enabled);
    if (actual !== expected) {
      throw new Error(
        `Electron fuse ${fuseName(option, fuses)} is ${actual === FUSE_ENABLED ? 'enabled' : actual === FUSE_DISABLED ? 'disabled' : `invalid (${actual})`}; expected ${enabled ? 'enabled' : 'disabled'}.`
      );
    }
  }
  return wire;
}

/**
 * Flip and immediately re-read every V1 fuse. On Apple Silicon the framework
 * executable changes, so the fuses package resets its thin ad-hoc signature;
 * the enclosing afterPack hook then synchronizes app.asar integrity and seals
 * the full bundle with either Developer ID or Wanigan's local ad-hoc fallback.
 */
async function hardenElectronFuses(appPath, options = {}) {
  const fuses = options.fuses || await loadFuses();
  const flip = options.flipFuses || fuses.flipFuses;
  await flip(appPath, {
    version: fuses.FuseVersion.V1,
    strictlyRequireAllFuses: true,
    resetAdHocDarwinSignature: process.platform === 'darwin',
    ...FUSE_POLICY,
  });
  return assertHardenedElectronFuses(appPath, { ...options, fuses });
}

exports.FUSE_POLICY = FUSE_POLICY;
exports.FUSE_DISABLED = FUSE_DISABLED;
exports.FUSE_ENABLED = FUSE_ENABLED;
exports.FUSE_OPTION_NAMES = FUSE_OPTION_NAMES;
exports.assertHardenedElectronFuses = assertHardenedElectronFuses;
exports.hardenElectronFuses = hardenElectronFuses;
