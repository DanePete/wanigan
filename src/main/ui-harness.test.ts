import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

for (const kind of ['ready', 'split address', 'timeout', 'oversized output', 'spawn error']) {
  test(`the UI gateway handles ${kind} without a leaked process or readiness timer`, () => {
    const script = `
      import assert from 'node:assert/strict';
      import { spawn } from 'node:child_process';
      import { once } from 'node:events';
      import { gatewayAddress } from ${JSON.stringify(new URL('../../scripts/ui-harness.mjs', import.meta.url).href)};
      const kind = ${JSON.stringify(kind)};
      const program = kind === 'split address' ? 'process.stdout.write("gateway http://127.0.0.1:"); setTimeout(() => console.log("1234"), 30); setInterval(() => {}, 1000)'
        : kind === 'ready' ? 'console.log("gateway http://127.0.0.1:1234"); setInterval(() => {}, 1000)'
        : kind === 'oversized output' ? 'console.log("x".repeat(128 * 1024) + "gateway http://127.0.0.1:1234"); setInterval(() => {}, 1000)'
          : 'setInterval(() => {}, 1000)';
      const child = spawn(kind === 'spawn error' ? '/does-not-exist/wanigan-test-gateway' : process.execPath,
        ['--input-type=module', '--eval', program], { stdio: ['ignore', 'pipe', 'ignore'] });
      try {
        if (kind === 'ready' || kind === 'split address') assert.equal(await gatewayAddress(child), 'http://127.0.0.1:1234');
        else {
          await assert.rejects(gatewayAddress(child, kind === 'timeout' ? 100 : 1000), kind === 'timeout' ? /did not start/ : kind === 'oversized output' ? /too much output/ : /ENOENT/);
          if (kind !== 'spawn error') assert.equal(child.killed, true, 'a refused gateway is stopped');
        }
      } finally { child.kill('SIGTERM'); }
      if (child.exitCode === null && child.signalCode === null && child.pid) await once(child, 'exit');
    `;
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 3_000, stdio: 'pipe',
    }));
  });
}


test('the UI gateway retains stderr and its job label when a child exits before readiness', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { gatewayAddress } from ${JSON.stringify(new URL('../../scripts/ui-harness.mjs', import.meta.url).href)};
    const child = spawn(process.execPath, ['--input-type=module', '--eval',
      'process.stdout.write("seeding owned fixture\\\\n"); process.stderr.write("distinctive-owned-startup-failure\\\\n"); process.exitCode = 1;'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    try {
      await assert.rejects(gatewayAddress(child, 1000, { label: 'History › resume / initial' }), (error) => {
        assert.match(error.message, /distinctive-owned-startup-failure/);
        assert.equal(error.gatewayStartup.label, 'History › resume / initial');
        assert.equal(error.gatewayStartup.code, 1);
        assert.equal(error.gatewayStartup.signal, null);
        assert.equal(error.gatewayStartup.pid, child.pid);
        assert.match(error.gatewayStartup.stdout, /seeding owned fixture/);
        assert.match(error.gatewayStartup.stderr, /distinctive-owned-startup-failure/);
        return true;
      });
    } finally { child.kill('SIGTERM'); await closed; }
  `;
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 3_000, stdio: 'pipe',
  }));
});


function gatewayFixture(body: string): void {
  const script = `
    import assert from 'node:assert/strict';
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { gatewayAddress } from ${JSON.stringify(new URL('../../scripts/ui-harness.mjs', import.meta.url).href)};
    ${body}
  `;
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 3_000, stdio: 'pipe',
  }));
}

test('the UI gateway records a signal exit before readiness', () => gatewayFixture(`
  const child = spawn(process.execPath, ['--eval', 'process.kill(process.pid, "SIGTERM")'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  await assert.rejects(gatewayAddress(child, 1000, { label: 'Keyboard', phase: 'initial' }), (error) => {
    assert.ok(error.gatewayStartup, 'startup diagnostic must be retained');
    assert.equal(error.gatewayStartup.code, null);
    assert.equal(error.gatewayStartup.signal, 'SIGTERM');
    assert.equal(error.gatewayStartup.label, 'Keyboard');
    return true;
  });
  await closed;
`));

test('the UI gateway bounds noisy stderr and preserves its last diagnostic', () => gatewayFixture(`
  const child = spawn(process.execPath, ['--eval',
    'process.stderr.write("x".repeat(256 * 1024) + "distinctive-tail", () => { process.exitCode = 1; })'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  await assert.rejects(gatewayAddress(child, 1000), (error) => {
    assert.ok(error.gatewayStartup, 'startup diagnostic must be retained');
    assert.equal(error.gatewayStartup.code, 1);
    assert.equal(error.gatewayStartup.stderrTruncated, true);
    assert.ok(Buffer.byteLength(error.gatewayStartup.stderr) <= 8192);
    assert.match(error.gatewayStartup.stderr, /distinctive-tail$/);
    return true;
  });
  await closed;
`));

test('the UI gateway retains bounded stdout when the existing output limit refuses startup', () => gatewayFixture(`
  const child = spawn(process.execPath, ['--eval', 'process.stdout.write("x".repeat(128 * 1024)); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  await assert.rejects(gatewayAddress(child, 1000), (error) => {
    assert.match(error.message, /too much output before starting/);
    assert.ok(error.gatewayStartup, 'startup diagnostic must be retained');
    assert.equal(error.gatewayStartup.stdoutTruncated, true);
    assert.ok(Buffer.byteLength(error.gatewayStartup.stdout) <= 8192);
    return true;
  });
  await closed;
`));

test('the UI gateway captures terminal stderr that arrives after the child exit', () => {
  const grandchild = 'setTimeout(()=>process.stderr.write("after-exit-tail"),40)';
  const program = `const {spawn}=require("node:child_process"); spawn(process.execPath,["--eval",${JSON.stringify(grandchild)}],{stdio:["ignore","ignore",2]}); process.exit(1)`;
  gatewayFixture(`
    const child = spawn(process.execPath, ['--eval', ${JSON.stringify(program)}], { stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    await assert.rejects(gatewayAddress(child, 1000), (error) => {
      assert.ok(error.gatewayStartup, 'startup diagnostic must be retained');
      assert.equal(error.gatewayStartup.code, 1);
      assert.match(error.gatewayStartup.stderr, /after-exit-tail/);
      return true;
    });
    await closed;
  `);
});

test('the UI gateway drains more than a pipe buffer of stderr after readiness', () => gatewayFixture(`
  const program = 'console.log("gateway http://127.0.0.1:1234"); setTimeout(()=>process.stderr.write("x".repeat(256 * 1024),()=>{process.exitCode=0}),20)';
  const child = spawn(process.execPath, ['--eval', program], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  assert.equal(await gatewayAddress(child, 1000), 'http://127.0.0.1:1234');
  assert.deepEqual(await closed, [0, null]);
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('error'), 0);
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stderr.listenerCount('data'), 0);
`));


test('the UI gateway refuses readiness that arrives after an observed child exit', () => {
  const grandchild = 'setTimeout(()=>console.log("gateway http://127.0.0.1:1234"),40)';
  const program = `const {spawn}=require("node:child_process"); spawn(process.execPath,["--eval",${JSON.stringify(grandchild)}],{stdio:["ignore",1,"ignore"]}); process.exit(1)`;
  gatewayFixture(`
    const child = spawn(process.execPath, ['--eval', ${JSON.stringify(program)}], { stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    try {
      await assert.rejects(gatewayAddress(child, 1000), (error) => {
        assert.equal(error.gatewayStartup.code, 1);
        assert.match(error.gatewayStartup.stdout, /gateway http:/);
        return true;
      });
    } finally { await closed; }
  `);
});
