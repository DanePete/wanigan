// The core daemon's entry point. Started detached by the app (Electron's binary
// in Node mode), so it outlives the window. Exits on its own only when no session
// is live and no window has been connected for a while.
//
// A core that cannot start says why in core.failed.json, which the app reads:
// detached, its output reaches only core.out.log, where nobody looks.
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { buildOf, corePaths } from './paths.ts';

const IDLE_EXIT_MS = 10 * 60_000;
const DEMO_IDLE_EXIT_MS = 60_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dataDir = arg('--data-dir');
if (!dataDir) {
  process.stderr.write('usage: core --data-dir <dir> [--cli-entry <file>]\n');
  process.exit(2);
}
const paths = corePaths(dataDir);
const log = (line: string): void => {
  try { appendFileSync(paths.log, `[${new Date().toISOString()}] ${line}\n`); } catch { /* nowhere to report */ }
};
// Before anything else runs, so nothing that goes wrong is lost.
process.on('uncaughtException', (error) => log(`uncaught: ${error.stack ?? error}`));
process.on('unhandledRejection', (error) => log(`unhandled rejection: ${(error as Error)?.stack ?? error}`));

async function main(dataDir: string): Promise<void> {
  // One core per data directory. If one is already answering, this one leaves.
  if (await answering(paths.socket)) {
    log(`another core is already running; pid ${process.pid} exiting`);
    process.exit(0);
  }

  // Loaded here rather than imported above: a native module built for another
  // Node (SQLite, node-pty) fails as it loads, and that must be reported too.
  const [{ Core }, { demoOptions, seedDemo }] = await Promise.all([import('./core.ts'), import('./demo.ts')]);
  const cliEntry = arg('--cli-entry') ?? join(__dirname, 'cli.js');
  // The demo: its own data folder, sample projects and stand-in agents, never the real world.
  const demo = process.argv.includes('--demo');
  const world = join(dataDir, 'world');
  // Test-only: keep a test's core away from the owner's real home and real CLIs.
  const testHome = process.env.WANIGAN_TEST_ACCOUNTS_HOME;
  const core = new Core({
    onIdleStop: () => process.exit(0),
    dataDir, log, cli: { runtime: process.execPath, entry: cliEntry }, demo, build: buildOf(process.argv[1] ?? ''),
    // The phone page, built beside this file; a core run from source (the tests) has none. The demo's own
    // options replace this: the demo serves no phone.
    phone: { rendererDir: typeof __dirname === 'string' ? join(__dirname, '../renderer') : null },
    ...(demo ? demoOptions(world, { calm: process.env.WANIGAN_DEMO_SHOWCASE === '1' }) : testHome ? {
      jev: { envKey: null },
      accounts: { home: testHome, prober: async () => ({ signedIn: 'unknown' as const, identity: null, plan: null }), usageReader: async () => ({ state: 'unreadable' as const, windows: [], checkedAt: 0, note: 'test' }) },
    } : {}),
  });
  await core.start();
  if (demo && !core.board.listProjects(new Map()).length) await seedDemo(core, world, { calm: process.env.WANIGAN_DEMO_SHOWCASE === '1' });
  rmSync(paths.failed, { force: true });
  log(`core ${process.pid} listening on ${core.paths.socket}${demo ? ' (demo)' : ''}`);
  process.stdout.write(`ready ${core.paths.socket}\n`);

  const idle = setInterval(() => {
    // The demo's stand-in agents are not work worth keeping alive: it ends with its window.
    const quiet = demo
      ? core.server.ownerConnections === 0
      // With phone access on, a phone may start a session while the Mac app is closed: stay up for it.
      : core.sessions.liveIds().size === 0 && core.server.ownerConnections === 0 && !core.reviews.busy && !core.jev.busy && !core.chat.busy && !core.phone.enabled;
    if (quiet && Date.now() - core.server.idleSince > (demo ? DEMO_IDLE_EXIT_MS : IDLE_EXIT_MS)) {
      log('idle with no sessions and no window; exiting');
      clearInterval(idle);
      void core.stop().then(() => process.exit(0));
    }
  }, 30_000);

  const shutdown = (signal: string): void => {
    log(`received ${signal}; stopping sessions and exiting`);
    void core.stop().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

function answering(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

main(dataDir).catch((error: unknown) => {
  // A store it must refuse, a native module built for another Node, a socket it cannot take.
  const reason = error instanceof Error ? error.message : String(error);
  log(`could not start: ${(error as Error)?.stack ?? error}`);
  try {
    writeFileSync(paths.failed, `${JSON.stringify({ reason, at: Date.now(), pid: process.pid })}\n`, { mode: 0o600 });
  } catch { /* the log has it */ }
  process.stderr.write(`Wanigan’s core could not start: ${reason}\n`);
  process.exit(1);
});
