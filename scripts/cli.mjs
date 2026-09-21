/**
 * Wanigan's headless CLI.
 *
 * It runs the app binary with --cli and no window, because better-sqlite3 is
 * compiled against Electron's V8 ABI — a plain `node` script loading it fails
 * with ERR_DLOPEN_FAILED. See the header of src/main/cli.ts.
 *
 *   npm run cli -- runs
 *   npm run cli -- status run_20260827_181500_a1b2
 *
 * Replaces scripts/cli.sh.
 */

import { assertNodeVersion, REPO, build, builtMtime, childEnv, electronBinary, newestSourceMtime, run } from './runner.mjs';

assertNodeVersion();

// Build only when out/ is actually behind src/. This may run every few minutes
// from cron, where an unconditional rebuild would cost more than the poll it is
// there to do.
if (builtMtime() < newestSourceMtime() && await build() !== 0) process.exit(1);

// Everything after --cli is the user's command line; Electron's own switches
// sit in front of it and are ignored by the parser in src/main/cli.ts.
process.exit(await run(
  electronBinary(),
  [REPO, '--cli', ...process.argv.slice(2)],
  { env: childEnv() },
));
