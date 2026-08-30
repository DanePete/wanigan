'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile: execFileCallback } = require('node:child_process');
const { promisify } = require('node:util');

const execFile = promisify(execFileCallback);
const APP_ASAR = path.join('Contents', 'Resources', 'app.asar');
const INFO_PLIST = path.join('Contents', 'Info.plist');
const PLIST_BUDDY = '/usr/libexec/PlistBuddy';
// `Resources/app.asar` contains both a slash and a dot, which PlistBuddy can
// address faithfully while plutil's dot-separated key paths cannot.
const ASAR_HASH_ENTRY = ':ElectronAsarIntegrity:Resources/app.asar:hash';

function appAsarPath(appPath) { return path.join(appPath, APP_ASAR); }
function infoPlistPath(appPath) { return path.join(appPath, INFO_PLIST); }

async function sha256File(file, filesystem = fs) {
  const bytes = await filesystem.readFile(file);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function commandDetail(error) {
  return [error?.stderr, error?.stdout, error?.message]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim())
    .join('\n') || 'No diagnostic was returned by macOS.';
}

async function embeddedAsarHash(appPath, execute = execFile) {
  try {
    const result = await execute(PLIST_BUDDY, ['-c', `Print ${ASAR_HASH_ENTRY}`, infoPlistPath(appPath)]);
    const hash = String(result?.stdout || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error(`ElectronAsarIntegrity hash is malformed: ${hash || 'missing'}.`);
    }
    return hash;
  } catch (error) {
    throw new Error(`Could not read ElectronAsarIntegrity from ${infoPlistPath(appPath)}.\n${commandDetail(error)}`);
  }
}

/** Keep Electron's embedded archive checksum in lockstep before code signing. */
async function synchronizeElectronAsarIntegrity(appPath, options = {}) {
  const filesystem = options.filesystem || fs;
  const execute = options.execute || execFile;
  const actual = await sha256File(appAsarPath(appPath), filesystem);
  try {
    await execute(PLIST_BUDDY, ['-c', `Set ${ASAR_HASH_ENTRY} ${actual}`, infoPlistPath(appPath)]);
  } catch (error) {
    throw new Error(`Could not update ElectronAsarIntegrity for ${appAsarPath(appPath)}.\n${commandDetail(error)}`);
  }
  const embedded = await embeddedAsarHash(appPath, execute);
  if (embedded !== actual) {
    throw new Error(`ElectronAsarIntegrity update did not persist for ${appAsarPath(appPath)}.`);
  }
  return actual;
}

/** Refuse a package whose signed Info.plist promises a different app.asar. */
async function assertElectronAsarIntegrity(appPath, options = {}) {
  const filesystem = options.filesystem || fs;
  const execute = options.execute || execFile;
  const [actual, embedded] = await Promise.all([
    sha256File(appAsarPath(appPath), filesystem),
    embeddedAsarHash(appPath, execute),
  ]);
  if (embedded !== actual) {
    throw new Error(
      `ElectronAsarIntegrity does not match ${appAsarPath(appPath)} (Info.plist ${embedded}, file ${actual}).`,
    );
  }
  return actual;
}

exports.APP_ASAR = APP_ASAR;
exports.ASAR_HASH_ENTRY = ASAR_HASH_ENTRY;
exports.assertElectronAsarIntegrity = assertElectronAsarIntegrity;
exports.embeddedAsarHash = embeddedAsarHash;
exports.sha256File = sha256File;
exports.synchronizeElectronAsarIntegrity = synchronizeElectronAsarIntegrity;
