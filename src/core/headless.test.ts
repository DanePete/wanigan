import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runHeadless, stopHeadless } from './headless.ts';
import { testCore, waitFor } from './test-support.ts';
import { shellQuote } from './hooks.ts';

const alive = (pid: number | undefined): boolean => { try { process.kill(pid as number, 0); return true; } catch { return false; } };

test('a headless run that ignores SIGTERM is killed at its deadline, and a stopping core takes every run with it', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wg-headless-')));
  // A claude that will not stop when asked: what an orphan spending the owner's plan looks like.
  const stubborn = join(dir, 'claude');
  writeFileSync(stubborn, '#!/bin/sh\ntrap "" TERM\nwhile :; do sleep 1; done\n');
  chmodSync(stubborn, 0o755);
  const options = { binary: stubborn, prompt: 'p', schema: {}, cwd: dir, account: null };
  try {
    const late = await runHeadless({ ...options, timeoutMs: 300 });
    const result = await late.done;
    assert.match(result.error ?? '', /took longer than 0 seconds and was stopped/);
    await waitFor('the stubborn run is gone', () => !alive(late.child.pid), 8_000);

    const running = await runHeadless({ ...options, timeoutMs: 60_000 });
    stopHeadless();
    await waitFor('stopHeadless ended it', () => !alive(running.child.pid), 8_000);
    await running.done;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('a read-only run disables custom settings, hooks and skills in its actual launch', async () => {
  const t = await testCore();
  try {
    const argv = join(t.dir, 'argv');
    const standIn = join(t.dir, 'claude');
    writeFileSync(standIn, `#!/bin/sh\nprintf '%s\\n' "$@" > ${shellQuote(argv)}\nprintf '%s\\n' '{"structured_output":{"ok":true}}'\n`, { mode: 0o755 });
    const run = await runHeadless({ binary: standIn, prompt: 'Read the project.', schema: {}, cwd: t.projectDir, account: null, timeoutMs: 5_000 });
    assert.equal((await run.done).error, null);
    const args = readFileSync(argv, 'utf8').split('\n');
    assert.ok(args.includes('--safe-mode'), 'project or plugin hooks and skills cannot execute during a read-only run');
    const sources = args.indexOf('--setting-sources');
    assert.ok(sources >= 0, 'project-written settings must not change the run');
    assert.equal(args[sources + 1], '');
  } finally {
    await t.close();
  }
});
