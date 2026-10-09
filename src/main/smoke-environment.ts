// The real-app smoke must be safe to run from any shell. Its core, account
// discovery, child shells and git all use temporary state, never the caller's.
import { join } from 'node:path';

export function smokeEnvironment(dataDir: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = join(dataDir, 'home');
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: home,
    SHELL: '/bin/sh',
    ZDOTDIR: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    WANIGAN_DATA_DIR: dataDir,
    WANIGAN_TEST_ACCOUNTS_HOME: home,
    ...(inherited.TMPDIR ? { TMPDIR: inherited.TMPDIR } : {}),
    ...(inherited.LANG ? { LANG: inherited.LANG } : {}),
  };
}
