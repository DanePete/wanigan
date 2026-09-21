/**
 * Launch Wanigan.
 *
 * Replaces scripts/launch.sh. Use this from a VS Code terminal in particular:
 * the environment scrubbing in scripts/runner.mjs is what keeps an inherited
 * ELECTRON_RUN_AS_NODE from killing the app before it reaches any of our code.
 */

import { assertNodeVersion, REPO, build, builtMtime, childEnv, electronBinary, newestSourceMtime, run } from './runner.mjs';

assertNodeVersion();

// Always build. A `[ -d out ] ||` guard looks like a cache but never rebuilds
// after the first time, so every later launch silently runs stale code and you
// debug a bug you already fixed.
if (await build({ quiet: false }) !== 0) process.exit(1);

if (builtMtime() < newestSourceMtime()) {
  process.stderr.write('Refusing to launch: out/ is older than src/ after a build.\n');
  process.exit(1);
}

process.exit(await run(electronBinary(), [REPO, ...process.argv.slice(2)], { env: childEnv() }));
