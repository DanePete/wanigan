// `npm run core:stop`: stop Wanigan's core for the default data folder, or for
// WANIGAN_DATA_DIR. The core ends its live sessions as it stops, as a quit
// never does. Run under Electron's Node (scripts/run-electron-node.mjs).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stopCore } from '../src/main/core-process.ts';

// Where Electron's app.getPath('appData') puts "Wanigan 2" on each platform.
const appData = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
  : process.platform === 'win32' ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
    : (process.env.XDG_CONFIG_HOME || join(homedir(), '.config'));
const dataDir = process.env.WANIGAN_DATA_DIR || join(appData, 'Wanigan 2');

try {
  const pid = await stopCore(dataDir);
  console.log(pid ? `Stopped Wanigan’s core (pid ${pid}) for ${dataDir}.` : `No core is running for ${dataDir}.`);
} catch (error) {
  console.error(`Could not stop Wanigan’s core for ${dataDir}: ${(error as Error).message}`);
  process.exit(1);
}
