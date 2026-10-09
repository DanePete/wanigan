// Alternate account-folder names are discovered without touching their files.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { testCore } from './test-support.ts';

test('account discovery accepts both separators, preserves suffix labels and is idempotent', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wg-account-names-')));
  const fixtures = [
    { name: '.claude-max5_you_example_com', provider: 'claude', file: 'settings.json', label: 'max5 you example com' },
    { name: '.claude_client-work', provider: 'claude', file: '.claude.json', label: 'client work' },
    { name: '.codex-work_team', provider: 'codex', file: 'config.toml', label: 'work team' },
    { name: '.codex_研发', provider: 'codex', file: 'history.jsonl', label: '研发' },
  ];
  for (const fixture of fixtures) {
    mkdirSync(join(home, fixture.name));
    writeFileSync(join(home, fixture.name, fixture.file), 'fixture contents stay unchanged\n');
  }
  // A lookalike prefix, empty suffix or folder without account markers is not an account.
  for (const name of ['.claudex_work', '.codex-', '.claude_empty']) mkdirSync(join(home, name));
  writeFileSync(join(home, '.claudex_work', 'settings.json'), '{}');
  writeFileSync(join(home, '.codex-', 'config.toml'), '');
  const names = readdirSync(home).sort();
  const probed: string[] = [];
  const t = await testCore({ accounts: {
    home,
    prober: async (_provider, dir) => { if (dir) probed.push(dir); return { signedIn: 'unknown', identity: null, plan: null }; },
    usageReader: async () => ({ state: 'unreadable', windows: [], checkedAt: 0, note: 'fixture' }),
  } });
  try {
    await t.owner.call('accounts.refresh', {});
    const accounts = await t.owner.call('accounts.list', {});
    const discovered = accounts.filter(account => account.configDir !== null);
    assert.deepEqual(discovered.map(account => [account.provider, account.configDir, account.label]).sort(),
      fixtures.map(fixture => [fixture.provider, join(home, fixture.name), fixture.label]).sort());
    assert.equal(accounts.filter(account => account.configDir === null).length, 2, 'each provider retains its ordinary default account');
    assert.deepEqual([...new Set(probed)].sort(), fixtures.map(fixture => join(home, fixture.name)).sort());
    const ids = accounts.map(account => [account.provider, account.configDir, account.id]).sort();
    t.core.accounts.discover();
    assert.deepEqual((await t.owner.call('accounts.list', {})).map(account => [account.provider, account.configDir, account.id]).sort(), ids);
    assert.deepEqual(readdirSync(home).sort(), names, 'discovery creates no account folders');
    for (const fixture of fixtures) assert.equal(readFileSync(join(home, fixture.name, fixture.file), 'utf8'), 'fixture contents stay unchanged\n');
  } finally { await t.close(); rmSync(home, { recursive: true, force: true }); }
});
