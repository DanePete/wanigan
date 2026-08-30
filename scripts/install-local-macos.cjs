'use strict';

/**
 * Safely install a locally-built Wanigan.app into /Applications.
 *
 * This deliberately is not an auto-updater. It is the last, explicit step of
 * a local release workflow:
 *
 *   npm run dist:mac:arm64
 *   npm run install:mac:arm64
 *
 * Keeping the installer separate gives it room to reject a broken bundle
 * before it ever touches the running application. In particular, a package
 * that is missing node-pty's executable spawn-helper can look fine in Finder
 * and then make every new terminal fail at runtime.
 */

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile: execFileCallback } = require('node:child_process');
const { promisify } = require('node:util');

const execFile = promisify(execFileCallback);

const APP_NAME = 'Wanigan';
const APP_FILENAME = `${APP_NAME}.app`;
const BUNDLE_IDENTIFIER = 'io.deadnorth.wanigan';
const APPLICATIONS_DIRECTORY = '/Applications';
const DEFAULT_SOURCE = path.resolve(__dirname, '..', 'release', 'mac-arm64', APP_FILENAME);
const DEFAULT_QUIT_TIMEOUT_SECONDS = 20;
const DEFAULT_LAUNCH_TIMEOUT_SECONDS = 15;
const POLL_INTERVAL_MS = 250;
// LaunchServices can report a PID before Electron has finished initializing
// its first window. Keep watching long enough to reject the misleading
// “opens, then immediately disappears” failure that otherwise looks like a
// successful deploy in a script transcript.
const LAUNCH_STABILITY_MS = 3_000;
const SPAWN_HELPER_RELATIVE_PATH = path.join(
  'Contents',
  'Resources',
  'app.asar.unpacked',
  'node_modules',
  'node-pty',
  'build',
  'Release',
  'spawn-helper',
);

/** @typedef {{ stdout?: string, stderr?: string }} CommandResult */

function usage() {
  return `Usage: npm run install:mac:arm64 [-- --source /absolute/path/Wanigan.app]

Installs a verified arm64 Wanigan.app into /Applications. The installer checks
the bundle identifier, node-pty spawn-helper, and a strict sealed code
signature before staging anything. It asks a currently installed Wanigan to
quit, never sends a signal to force it down, and leaves the existing app alone
if it does not exit before the timeout.

Options:
  --source <path>          Source app bundle (default: ${DEFAULT_SOURCE})
  --quit-timeout <seconds> Time to wait for an existing app to quit (default: ${DEFAULT_QUIT_TIMEOUT_SECONDS})
  --launch-timeout <seconds> Time to wait for the new app process (default: ${DEFAULT_LAUNCH_TIMEOUT_SECONDS})
  --help                   Show this help

Environment:
  WANIGAN_APP_SOURCE       Alternative source app bundle path
`;
}

function installError(message, cause) {
  const error = new Error(message);
  if (cause) error.cause = cause;
  return error;
}

function requireMacOS() {
  if (process.platform !== 'darwin') {
    throw installError('Wanigan local installation only runs on macOS. The fixture test does not install an app.');
  }
}

function assertSafePathInput(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw installError(`${label} must be a non-empty path.`);
  }
  if (/\0|[\r\n]/.test(value)) {
    throw installError(`${label} cannot contain a null byte or a line break.`);
  }
  return value;
}

function assertTrashDirectory(value) {
  const resolved = path.resolve(assertSafePathInput(value, 'Trash path'));
  if (path.basename(resolved) !== '.Trash') {
    throw installError(`Trash path must be a .Trash directory, received ${resolved}.`);
  }
  return resolved;
}

function parsePositiveSeconds(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 300) {
    throw installError(`${label} must be a number of seconds between 0 and 300.`);
  }
  return number;
}

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [environment]
 */
function parseArguments(argv, environment = process.env) {
  const options = {
    source: environment.WANIGAN_APP_SOURCE || DEFAULT_SOURCE,
    quitTimeoutSeconds: DEFAULT_QUIT_TIMEOUT_SECONDS,
    launchTimeoutSeconds: DEFAULT_LAUNCH_TIMEOUT_SECONDS,
    trashDirectory: null,
    privilegedInstall: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--privileged-install') {
      options.privilegedInstall = true;
      continue;
    }
    if (argument === '--source' || argument === '--quit-timeout' || argument === '--launch-timeout' || argument === '--trash-dir') {
      const value = argv[index + 1];
      if (value == null || value.startsWith('--')) {
        throw installError(`${argument} requires a value.`);
      }
      index += 1;
      if (argument === '--source') options.source = value;
      if (argument === '--quit-timeout') options.quitTimeoutSeconds = parsePositiveSeconds(value, '--quit-timeout');
      if (argument === '--launch-timeout') options.launchTimeoutSeconds = parsePositiveSeconds(value, '--launch-timeout');
      if (argument === '--trash-dir') options.trashDirectory = value;
      continue;
    }
    throw installError(`Unknown option: ${argument}\n\n${usage()}`);
  }

  options.source = path.resolve(assertSafePathInput(options.source, 'Source app path'));
  if (options.trashDirectory != null) {
    options.trashDirectory = assertTrashDirectory(options.trashDirectory);
  }
  return options;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ')}"`;
}

function formatCommandFailure(error) {
  const details = [error?.stderr, error?.stdout, error?.message]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim())
    .join('\n');
  return details || 'No diagnostic was returned by macOS.';
}

async function lstatOrNull(file, filesystem = fs) {
  try {
    return await filesystem.lstat(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertRegularExecutable(file, label, filesystem = fs) {
  const stat = await lstatOrNull(file, filesystem);
  if (!stat) throw installError(`${label} is missing: ${file}`);
  if (stat.isSymbolicLink() || !stat.isFile()) throw installError(`${label} is not a regular file: ${file}`);
  if ((stat.mode & 0o111) === 0) throw installError(`${label} is not executable: ${file}`);
  return stat;
}

async function extractBundleIdentifier(appPath, execute = execFile) {
  const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
  try {
    const result = await execute('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlist]);
    return String(result?.stdout || '').trim();
  } catch (error) {
    throw installError(`Could not read CFBundleIdentifier from ${infoPlist}.\n${formatCommandFailure(error)}`, error);
  }
}

/**
 * Check the minimum identity of an already-installed target before moving it.
 * It intentionally does not require its signature or native helper to be
 * current: an older broken Wanigan is exactly what this installer is meant to
 * replace, but an unrelated directory at /Applications/Wanigan.app must not
 * be overwritten.
 */
async function assertKnownInstalledWanigan(appPath, options = {}) {
  const filesystem = options.filesystem || fs;
  const execute = options.execute || execFile;
  const root = await lstatOrNull(appPath, filesystem);
  if (!root) return false;
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw installError(`Refusing to replace ${appPath}: it is not a real app bundle directory.`);
  }
  if (path.basename(appPath) !== APP_FILENAME) {
    throw installError(`Refusing to replace an unexpected app path: ${appPath}`);
  }
  const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
  const infoStat = await lstatOrNull(infoPlist, filesystem);
  if (!infoStat || infoStat.isSymbolicLink() || !infoStat.isFile()) {
    throw installError(`Refusing to replace ${appPath}: it has no regular Info.plist.`);
  }
  const bundleIdentifier = await extractBundleIdentifier(appPath, execute);
  if (bundleIdentifier !== BUNDLE_IDENTIFIER) {
    throw installError(
      `Refusing to replace ${appPath}: its bundle identifier is ${bundleIdentifier || 'missing'}, not ${BUNDLE_IDENTIFIER}.`,
    );
  }
  return true;
}

function assertSignatureMetadata(metadata, expectedIdentifier = BUNDLE_IDENTIFIER) {
  const text = String(metadata || '');
  if (!text.includes(`Identifier=${expectedIdentifier}`)) {
    throw installError(`Code signature is not bound to ${expectedIdentifier}.`);
  }
  if (/^Info\.plist=not bound$/m.test(text)) {
    throw installError('Code signature does not bind the app Info.plist.');
  }
  const seal = text.match(/^Sealed Resources(?:=|\s+)(.+)$/m);
  if (!seal || /\bnone\b/i.test(seal[1])) {
    throw installError('Code signature does not seal the app resources.');
  }
}

async function verifyCodeSignature(appPath, execute = execFile) {
  try {
    await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  } catch (error) {
    throw installError(`Strict code-signature verification failed for ${appPath}.\n${formatCommandFailure(error)}`, error);
  }

  let display;
  try {
    display = await execute('/usr/bin/codesign', ['-dv', '--verbose=4', appPath]);
  } catch (error) {
    throw installError(`Could not inspect the code signature for ${appPath}.\n${formatCommandFailure(error)}`, error);
  }
  const metadata = `${display?.stdout || ''}\n${display?.stderr || ''}`;
  assertSignatureMetadata(metadata);
  return metadata;
}

/**
 * Validate every property required before a bundle is allowed into
 * /Applications. The result returns canonical paths only for diagnostics and
 * tests; callers still copy from the original, verified bundle path.
 */
async function assertVerifiedWaniganApp(appPath, options = {}) {
  const filesystem = options.filesystem || fs;
  const execute = options.execute || execFile;
  const resolvedPath = path.resolve(assertSafePathInput(appPath, 'App path'));
  if (path.basename(resolvedPath) !== APP_FILENAME) {
    throw installError(`Expected a ${APP_FILENAME} bundle, received ${resolvedPath}.`);
  }
  const root = await lstatOrNull(resolvedPath, filesystem);
  if (!root) throw installError(`Wanigan app bundle is missing: ${resolvedPath}`);
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw installError(`Wanigan app bundle must be a real directory, not a link: ${resolvedPath}`);
  }

  const infoPlist = path.join(resolvedPath, 'Contents', 'Info.plist');
  const executable = path.join(resolvedPath, 'Contents', 'MacOS', APP_NAME);
  const helper = path.join(resolvedPath, SPAWN_HELPER_RELATIVE_PATH);
  const infoStat = await lstatOrNull(infoPlist, filesystem);
  if (!infoStat || infoStat.isSymbolicLink() || !infoStat.isFile()) {
    throw installError(`Wanigan app bundle has no regular Info.plist: ${infoPlist}`);
  }
  await assertRegularExecutable(executable, 'Wanigan executable', filesystem);
  await assertRegularExecutable(helper, 'node-pty spawn-helper', filesystem);

  const bundleIdentifier = await extractBundleIdentifier(resolvedPath, execute);
  if (bundleIdentifier !== BUNDLE_IDENTIFIER) {
    throw installError(
      `Expected bundle identifier ${BUNDLE_IDENTIFIER}, received ${bundleIdentifier || 'none'} in ${resolvedPath}.`,
    );
  }
  const signatureMetadata = await verifyCodeSignature(resolvedPath, execute);
  return { appPath: resolvedPath, executable, helper, bundleIdentifier, signatureMetadata };
}

function targetExecutable(destination = path.join(APPLICATIONS_DIRECTORY, APP_FILENAME)) {
  return path.join(destination, 'Contents', 'MacOS', APP_NAME);
}

function parseTargetProcessIds(processTable, executablePath) {
  const ids = [];
  for (const line of String(processTable || '').split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (match && match[2].includes(executablePath)) ids.push(Number(match[1]));
  }
  return [...new Set(ids)];
}

async function runningTargetProcessIds(destination, execute = execFile) {
  const executable = targetExecutable(destination);
  try {
    const result = await execute('/bin/ps', ['-wwax', '-o', 'pid=,command=']);
    return parseTargetProcessIds(result?.stdout || '', executable);
  } catch (error) {
    throw installError(`Could not inspect the installed Wanigan process.\n${formatCommandFailure(error)}`, error);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForProcessState(destination, wantRunning, timeoutSeconds, options = {}) {
  const execute = options.execute || execFile;
  const sleep = options.sleep || delay;
  const now = options.now || Date.now;
  const deadline = now() + timeoutSeconds * 1000;
  let last = await runningTargetProcessIds(destination, execute);

  while (Boolean(last.length) !== wantRunning && now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    last = await runningTargetProcessIds(destination, execute);
  }
  return last;
}

/**
 * Use a Quit Apple event, never SIGTERM/SIGKILL. The exact installed bundle is
 * first matched in the process table, which prevents this from sending a quit
 * request when no /Applications/Wanigan.app process is actually present.
 */
async function gracefullyQuitInstalledWanigan(destination, timeoutSeconds, options = {}) {
  const execute = options.execute || execFile;
  const before = await runningTargetProcessIds(destination, execute);
  if (!before.length) return { wasRunning: false, processIds: [] };

  try {
    await execute('/usr/bin/osascript', [
      '-e',
      `tell application id "${BUNDLE_IDENTIFIER}" to quit`,
    ], { timeout: 5000 });
  } catch (error) {
    // An app can exit between the process check and the Apple event. Only fail
    // if it is still alive; otherwise it is already safe to continue.
    const remaining = await runningTargetProcessIds(destination, execute);
    if (remaining.length) {
      throw installError(
        `Wanigan is running (PID ${remaining.join(', ')}) and declined the graceful Quit request. No files were changed.\n${formatCommandFailure(error)}`,
        error,
      );
    }
    return { wasRunning: true, processIds: [] };
  }

  const remaining = await waitForProcessState(destination, false, timeoutSeconds, { execute });
  if (remaining.length) {
    throw installError(
      `Wanigan is still running after ${timeoutSeconds} seconds (PID ${remaining.join(', ')}). No files were changed; close it normally and run the installer again.`,
    );
  }
  return { wasRunning: true, processIds: [] };
}

async function assertNoInstalledWaniganProcess(destination, execute = execFile) {
  const processIds = await runningTargetProcessIds(destination, execute);
  if (processIds.length) {
    throw installError(
      `Wanigan is running (PID ${processIds.join(', ')}). The installer will not replace a live app; close it normally and try again.`,
    );
  }
}

function safeToken(value) {
  return String(value).replace(/[^A-Za-z0-9-]/g, '');
}

function installationPaths(options = {}) {
  const applicationsDirectory = options.applicationsDirectory || APPLICATIONS_DIRECTORY;
  const trashDirectory = assertTrashDirectory(options.trashDirectory || path.join(os.homedir(), '.Trash'));
  const token = safeToken(options.token || crypto.randomUUID());
  if (!token) throw installError('Could not create a safe installation staging token.');
  const stamp = (options.now || new Date()).toISOString().replace(/[:.]/g, '-');
  const stageRoot = path.join(applicationsDirectory, `.wanigan-install-${token}`);
  return {
    applicationsDirectory,
    trashDirectory,
    destination: path.join(applicationsDirectory, APP_FILENAME),
    stageRoot,
    stageApp: path.join(stageRoot, APP_FILENAME),
    backupApp: path.join(applicationsDirectory, `.wanigan-retired-${token}.app`),
    trashApp: path.join(trashDirectory, `${APP_NAME} replaced ${stamp}-${token}.app`),
  };
}

async function assertAbsent(file, filesystem = fs) {
  if (await lstatOrNull(file, filesystem)) {
    throw installError(`Refusing to use an existing installer path: ${file}`);
  }
}

async function ensureTrashDirectory(trashDirectory, filesystem = fs) {
  await filesystem.mkdir(trashDirectory, { recursive: true, mode: 0o700 });
  return trashDirectory;
}

async function canWriteDirectory(directory, filesystem = fs) {
  try {
    await filesystem.access(directory, fsSync.constants.W_OK | fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function moveBackupToTrash(backupApp, trashApp, options = {}) {
  const filesystem = options.filesystem || fs;
  const execute = options.execute || execFile;
  await assertAbsent(trashApp, filesystem);
  try {
    await filesystem.rename(backupApp, trashApp);
    return;
  } catch (error) {
    if (!error || error.code !== 'EXDEV') throw error;
  }

  // A home directory on a different volume is unusual but supported. Copy the
  // known old app first, check its identity in the Trash, then remove only the
  // temporary hidden backup. This avoids ever making a visible .previous app.
  await execute('/usr/bin/ditto', [backupApp, trashApp]);
  await assertKnownInstalledWanigan(trashApp, { filesystem, execute });
  await filesystem.rm(backupApp, { recursive: true, force: false });
}

async function rollbackPromotion(paths, options = {}) {
  const filesystem = options.filesystem || fs;
  const destinationPresent = await lstatOrNull(paths.destination, filesystem);
  if (destinationPresent) {
    const failedApp = path.join(paths.stageRoot, `failed-${APP_FILENAME}`);
    try {
      await filesystem.rename(paths.destination, failedApp);
    } catch (error) {
      throw installError(
        `The new app could not be validated after promotion and could not be moved back into its hidden staging directory. The old app remains at ${paths.backupApp}.\n${formatCommandFailure(error)}`,
        error,
      );
    }
  }
  try {
    await filesystem.rename(paths.backupApp, paths.destination);
  } catch (error) {
    throw installError(
      `The new app could not be validated after promotion and automatic rollback failed. The prior app is preserved at ${paths.backupApp}.\n${formatCommandFailure(error)}`,
      error,
    );
  }
}

async function removeUnverifiedNewInstall(paths, options = {}) {
  const filesystem = options.filesystem || fs;
  const failedApp = path.join(paths.stageRoot, `failed-${APP_FILENAME}`);
  try {
    await filesystem.rename(paths.destination, failedApp);
  } catch (error) {
    throw installError(
      `The new app failed final verification and could not be returned to its hidden staging directory. It remains at ${paths.destination}.\n${formatCommandFailure(error)}`,
      error,
    );
  }
}

/**
 * Stage and atomically promote a verified bundle. This routine never quits or
 * launches the app so it can safely run under the narrow administrator helper
 * if /Applications is not writable by the signed-in user.
 */
async function installVerifiedBundle(source, options = {}) {
  const filesystem = options.filesystem || fs;
  const execute = options.execute || execFile;
  const paths = options.paths || installationPaths({ trashDirectory: options.trashDirectory });
  let stageCreated = false;
  let backupCreated = false;
  let promoted = false;

  try {
    await assertVerifiedWaniganApp(source, { filesystem, execute });
    if (path.resolve(source) === path.resolve(paths.destination)) {
      throw installError('The source app is already /Applications/Wanigan.app; build or choose a separate release bundle first.');
    }
    await ensureTrashDirectory(paths.trashDirectory, filesystem);
    await assertAbsent(paths.stageRoot, filesystem);
    await assertAbsent(paths.backupApp, filesystem);
    await assertAbsent(paths.trashApp, filesystem);
    await assertKnownInstalledWanigan(paths.destination, { filesystem, execute });
    await assertNoInstalledWaniganProcess(paths.destination, execute);

    await filesystem.mkdir(paths.stageRoot, { mode: 0o700 });
    stageCreated = true;
    await execute('/usr/bin/ditto', [path.resolve(source), paths.stageApp]);
    await assertVerifiedWaniganApp(paths.stageApp, { filesystem, execute });

    // Check once more immediately before the first rename. A quit request is
    // made by the caller; this guard makes a launch race fail without a swap.
    await assertNoInstalledWaniganProcess(paths.destination, execute);
    const hasCurrentInstall = await assertKnownInstalledWanigan(paths.destination, { filesystem, execute });
    if (hasCurrentInstall) {
      await filesystem.rename(paths.destination, paths.backupApp);
      backupCreated = true;
    }

    try {
      // Both paths are inside /Applications, so this is a same-filesystem
      // rename: Finder never observes a half-copied Wanigan.app.
      await filesystem.rename(paths.stageApp, paths.destination);
      promoted = true;
    } catch (error) {
      if (backupCreated) {
        try {
          await filesystem.rename(paths.backupApp, paths.destination);
        } catch (rollbackError) {
          throw installError(
            `Could not promote the staged app and could not restore the prior bundle. The previous app is preserved at ${paths.backupApp}.\n${formatCommandFailure(rollbackError)}`,
            rollbackError,
          );
        }
      }
      throw installError(`Could not atomically promote the staged app.\n${formatCommandFailure(error)}`, error);
    }

    try {
      await assertVerifiedWaniganApp(paths.destination, { filesystem, execute });
    } catch (error) {
      if (backupCreated) {
        await rollbackPromotion(paths, { filesystem });
      } else {
        await removeUnverifiedNewInstall(paths, { filesystem });
      }
      throw installError(`The promoted app failed final verification. The prior app was restored when available.\n${error.message}`, error);
    }

    if (backupCreated) {
      try {
        await moveBackupToTrash(paths.backupApp, paths.trashApp, { filesystem, execute });
      } catch (error) {
        // The new app is valid and installed. Do not undo a successful atomic
        // promotion merely because a recovery copy could not enter Trash; the
        // old bundle stays hidden rather than becoming a Spotlight result.
        throw installError(
          `Wanigan was installed, but moving the prior bundle to Trash failed. It remains safely hidden at ${paths.backupApp}; no Spotlight-visible previous app was created.\n${formatCommandFailure(error)}`,
          error,
        );
      }
    }

    return { ...paths, backupCreated, promoted };
  } finally {
    // The only recursively removed location is a tokenized hidden staging
    // directory that this process just created. It never includes the active
    // app, the source bundle, or a prior bundle moved to Trash.
    if (stageCreated) {
      try {
        await filesystem.rm(paths.stageRoot, { recursive: true, force: true });
      } catch (error) {
        if (!promoted) throw error;
        console.warn(`Installed Wanigan, but could not remove hidden staging directory ${paths.stageRoot}: ${formatCommandFailure(error)}`);
      }
    }
  }
}

function privilegedCommand(options) {
  const script = path.resolve(__filename);
  const trashDirectory = assertTrashDirectory(options.trashDirectory || path.join(os.homedir(), '.Trash'));
  return [
    process.execPath,
    script,
    '--privileged-install',
    '--source', path.resolve(options.source),
    '--trash-dir', path.resolve(trashDirectory),
  ].map(shellQuote).join(' ');
}

async function runPrivilegedInstall(options, execute = execFile) {
  const command = privilegedCommand(options);
  console.log('Wanigan needs administrator authorization to update /Applications. macOS will ask only for this filesystem step.');
  try {
    const result = await execute('/usr/bin/osascript', [
      '-e',
      `do shell script ${appleScriptString(command)} with administrator privileges`,
    ]);
    if (result?.stdout?.trim()) console.log(result.stdout.trim());
  } catch (error) {
    throw installError(`Administrator authorization did not complete. The installed app was not replaced.\n${formatCommandFailure(error)}`, error);
  }
}

async function launchAndVerifyInstalledWanigan(destination, launchTimeoutSeconds, options = {}) {
  const execute = options.execute || execFile;
  const sleep = options.sleep || delay;
  console.log(`Launching ${destination}…`);
  try {
    // Passing the bundle path rather than -a Wanigan makes LaunchServices use
    // precisely the bundle we just verified and promoted.
    await execute('/usr/bin/open', ['-n', destination]);
  } catch (error) {
    throw installError(`Installed Wanigan but could not launch the exact /Applications bundle.\n${formatCommandFailure(error)}`, error);
  }
  const processIds = await waitForProcessState(destination, true, launchTimeoutSeconds, { execute });
  if (!processIds.length) {
    throw installError(
      `Installed Wanigan passed signature checks but did not appear in the process table within ${launchTimeoutSeconds} seconds. The bundle remains at ${destination}.`,
    );
  }
  // A second observation distinguishes a launch from an app that opens and
  // disappears before a person can see the failure. This is deliberately
  // longer than an Electron renderer/bootstrap turn, not merely one event
  // loop tick that could hide a launch-services failure.
  await sleep(LAUNCH_STABILITY_MS);
  const stillRunning = await runningTargetProcessIds(destination, execute);
  if (!stillRunning.length) {
    throw installError(`Wanigan launched and then exited immediately. The verified bundle remains at ${destination}.`);
  }
  return stillRunning;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  requireMacOS();

  const paths = installationPaths({ trashDirectory: options.trashDirectory || path.join(os.homedir(), '.Trash') });
  if (options.privilegedInstall) {
    // This mode is only called through the single osascript command above. It
    // has no code to quit or launch a GUI app as root.
    await installVerifiedBundle(options.source, { trashDirectory: paths.trashDirectory, paths });
    console.log(`Installed verified ${APP_FILENAME} at ${paths.destination}.`);
    return;
  }

  await assertVerifiedWaniganApp(options.source);
  await assertKnownInstalledWanigan(paths.destination);
  await gracefullyQuitInstalledWanigan(paths.destination, options.quitTimeoutSeconds);

  await ensureTrashDirectory(paths.trashDirectory);
  const canWriteApplications = await canWriteDirectory(APPLICATIONS_DIRECTORY);
  const canWriteTrash = await canWriteDirectory(paths.trashDirectory);
  if (canWriteApplications && canWriteTrash) {
    await installVerifiedBundle(options.source, { trashDirectory: paths.trashDirectory, paths });
  } else {
    // Quit happened in this signed-in user session. The privileged child only
    // stages/promotes after independently confirming that no target process
    // reappeared; this keeps GUI launch and Apple events out of the root shell.
    await runPrivilegedInstall({ source: options.source, trashDirectory: paths.trashDirectory });
  }

  await assertVerifiedWaniganApp(paths.destination);
  const processIds = await launchAndVerifyInstalledWanigan(paths.destination, options.launchTimeoutSeconds);
  console.log(`Installed and launched ${APP_FILENAME} (PID ${processIds.join(', ')}).`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Wanigan install failed: ${error.message}`);
    process.exitCode = 1;
  });
}

exports.APP_FILENAME = APP_FILENAME;
exports.APPLICATIONS_DIRECTORY = APPLICATIONS_DIRECTORY;
exports.BUNDLE_IDENTIFIER = BUNDLE_IDENTIFIER;
exports.DEFAULT_SOURCE = DEFAULT_SOURCE;
exports.LAUNCH_STABILITY_MS = LAUNCH_STABILITY_MS;
exports.SPAWN_HELPER_RELATIVE_PATH = SPAWN_HELPER_RELATIVE_PATH;
exports.appleScriptString = appleScriptString;
exports.assertTrashDirectory = assertTrashDirectory;
exports.assertKnownInstalledWanigan = assertKnownInstalledWanigan;
exports.assertSignatureMetadata = assertSignatureMetadata;
exports.assertVerifiedWaniganApp = assertVerifiedWaniganApp;
exports.gracefullyQuitInstalledWanigan = gracefullyQuitInstalledWanigan;
exports.installationPaths = installationPaths;
exports.launchAndVerifyInstalledWanigan = launchAndVerifyInstalledWanigan;
exports.parseArguments = parseArguments;
exports.parseTargetProcessIds = parseTargetProcessIds;
exports.privilegedCommand = privilegedCommand;
exports.shellQuote = shellQuote;
