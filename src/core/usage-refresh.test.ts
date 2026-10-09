// Reading what each account has left, again and again: a read with nothing
// due must not stand in for every read after it. Found by the UI crawl
// (scripts/ui-crawl.mjs): with every reading fresh, Accounts › Check again
// chained itself forever and the core ran out of memory.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { USAGE_STALE_MS } from './accounts.ts';
import { testCore } from './test-support.ts';

test('a limits read with nothing due leaves the next one free to read, and Check again still reads', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wg-usage-')));
  mkdirSync(join(home, '.claude'));
  let clock = Date.UTC(2026, 9, 7, 15, 0);
  let reads = 0;
  const t = await testCore({
    now: () => clock,
    accounts: {
      home,
      prober: async () => ({ signedIn: 'yes', identity: 'you@example.com', plan: null }),
      usageReader: async () => { reads++; return { state: 'ok', windows: [], checkedAt: clock, note: null }; },
    },
  });
  try {
    const { owner } = t;
    await owner.call('accounts.refresh', {});
    await owner.call('accounts.refreshUsage', {});
    const accounts = reads;
    assert.ok(accounts > 0, 'the signed-in accounts are read');

    await owner.call('accounts.refreshUsage', {});
    assert.equal(reads, accounts, 'nothing is due: a fresh reading is not read again');

    clock += USAGE_STALE_MS + 1;
    await owner.call('accounts.refreshUsage', {});
    assert.equal(reads, 2 * accounts, 'once the readings are stale, they are read again');

    await owner.call('accounts.refreshUsage', {});
    await owner.call('accounts.refreshUsage', { force: true });
    assert.equal(reads, 3 * accounts, 'Check again reads at once, after a read that had nothing due');
  } finally {
    await t.close();
    rmSync(home, { recursive: true, force: true });
  }
});
