// Observe the real fixture's model-list path with child_process discovery/launch
// and global fetch blocked in a separate child. No installed CLI is launched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

for (const mode of ['default', 'undefined', 'supplied'] as const) {
  test(`testCore Codex model catalogues use ${mode === 'supplied' ? 'the supplied reader' : `the local default (${mode})`} without CLI discovery or real account access`, (context) => {
    const root = mkdtempSync('/tmp/wg-fixture-safe-'); const home = join(root, 'home'); const temporary = join(root, 'tmp');
    mkdirSync(home); mkdirSync(temporary);
    try {
      const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
        import assert from 'node:assert/strict';
        import childProcess from 'node:child_process';
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        import { join } from 'node:path';
        const attempted = []; const ownIdentity = [];
        for (const operation of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync']) {
          childProcess[operation] = (...args) => {
            // Core startup records its own process identity. Synthesize only
            // that exact request; even the owned child's ps is never executed.
            if (operation === 'execFileSync' && args[0] === '/bin/ps' && JSON.stringify(args[1]) === JSON.stringify(['-p', String(process.pid), '-o', 'lstart='])) {
              ownIdentity.push(process.pid); return 'fixture-owned-core-start';
            }
            attempted.push({ operation, command: String(args[0]) }); throw new Error('fixture blocked process discovery or launch');
          };
        }
        const accessed = [];
        const access = fs.accessSync;
        fs.accessSync = (path, ...rest) => { accessed.push(String(path)); return access(path, ...rest); };
        syncBuiltinESMExports();
        const requests = [];
        globalThis.fetch = async (url) => { requests.push(String(url)); throw new Error('fixture blocks every network request'); };
        const { testCore } = await import(${JSON.stringify(new URL('./test-support.ts', import.meta.url).href)});
        const home = process.env.HOME;
        const work = join(home, '.codex_work');
        for (const folder of ['.codex', '.codex_work']) { fs.mkdirSync(join(home, folder)); fs.writeFileSync(join(home, folder, 'config.toml'), '# fixture sentinel'); }
        const observedHomes = [];
        const mode = ${JSON.stringify(mode)}; const supplied = mode === 'supplied';
        const t = await testCore({ accounts: { home }, ...(supplied ? { codexModels: async (configDir) => {
          observedHomes.push(configDir);
          return [{ value: configDir === null ? 'fixture-default' : 'fixture-work', label: 'Local fixture model', detail: null,
            efforts: ['low'], defaultEffort: 'low', isDefault: true }];
        } } : mode === 'undefined' ? { codexModels: undefined } : {}) });
        try {
          const accounts = (await t.owner.call('accounts.list', {})).filter(a => a.provider === 'codex');
          assert.equal(accounts.length, 2);
          assert.deepEqual(accounts.map(a => t.core.accounts.folderOf(a)).sort(), [join(home, '.codex'), work].sort());
          const other = accounts.find(a => t.core.accounts.folderOf(a) === work);
          assert.ok(other);
          const first = await t.owner.call('sessions.models', { provider: 'codex' });
          const second = await t.owner.call('sessions.models', { provider: 'codex', accountId: other.id });
          console.log(JSON.stringify({ mode, attempted, accessed, requests, observedHomes, ownIdentity }));
          assert.deepEqual(attempted, [], 'catalogues must not reach process-based CLI discovery or launch');
          assert.deepEqual(accessed, [], 'catalogues must not search executable paths');
          assert.deepEqual([...new Set(requests)], ['http://127.0.0.1:9/api/tags'], 'only the already-disabled local-model seam is consulted, and no request is sent');
          assert.deepEqual(first.models.map(m => m.value), supplied ? ['fixture-default'] : []);
          assert.deepEqual(second.models.map(m => m.value), supplied ? ['fixture-work'] : []);
          assert.deepEqual(observedHomes, supplied ? [null, work] : []);
          assert.equal(first.source, 'live'); assert.equal(second.source, 'live');
          for (const folder of ['.codex', '.codex_work']) assert.equal(fs.readFileSync(join(home, folder, 'config.toml'), 'utf8'), '# fixture sentinel');
        } finally { await t.close(); }
      `], {
        env: { HOME: home, TMPDIR: temporary, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', ELECTRON_RUN_AS_NODE: '1' },
        timeout: 10_000, encoding: 'utf8',
      });
      assert.equal(child.error, undefined, child.error?.message);
      assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
      context.diagnostic(child.stdout.trim());
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
