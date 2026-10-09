// Resource admission through actual owner RPCs, with injected disk/LM Studio
// results and owned stand-in children. No real model or resource probe is used.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { LOCAL_MODULES, localModelValue } from '../shared/local-models.ts';
import type { LmsResult } from './local-models.ts';
import { testCore, waitFor } from './test-support.ts';

const MODULE = LOCAL_MODULES[0]!;
const VALUE = localModelValue('lmstudio', MODULE.key);

async function fixture(downloaded = false) {
  const control: { disk: number | Error; estimate: LmsResult; loaded: boolean } = {
    disk: 1e12, estimate: { code: 0, stdout: 'Estimate: This model may be loaded.', stderr: '' }, loaded: false,
  };
  const calls: string[][] = [];
  const children: ChildProcess[] = [];
  const t = await testCore({
    launcher: () => ({ file: '/bin/sh', args: ['-c', 'echo "owned local guard session"; exec cat'] }),
    local: {
    lmsBin: '/owned/stand-in/lms', fetchJson: async () => ({ models: [] }),
    freeBytes: () => { if (control.disk instanceof Error) throw control.disk; return control.disk; },
    runLms: async (_bin, args) => {
      calls.push(args);
      if (args.includes('--estimate-only')) return control.estimate;
      if (args[0] === 'load' && args.includes('--yes')) control.loaded = true;
      const stdout = args[0] === 'server' ? '{"running":true,"port":12345}'
        : args[0] === 'ls' ? JSON.stringify(downloaded ? [{ modelKey: MODULE.key, type: 'llm' }] : [])
          : args[0] === 'ps' ? JSON.stringify(control.loaded ? [{ modelKey: MODULE.key }] : []) : '[]';
      return { code: 0, stdout, stderr: '' };
    },
    spawnLms: (_bin, args) => {
      calls.push(args);
      const child = spawn('/bin/cat', [], { stdio: ['pipe', 'pipe', 'pipe'], env: {
        PATH: '/usr/bin:/bin', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      } });
      children.push(child); return child;
    },
  } });
  return { ...t, control, calls, children,
    async cleanup() {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
      }
      await t.close();
    },
  };
}

test('an unreadable free-space measurement refuses Get before a child starts and recovers after the measurement works', async () => {
  const t = await fixture();
  try {
    t.control.disk = new Error('Owned disk query failure');
    await assert.rejects(t.owner.call('local.download', { module: MODULE.id }), /could not check free disk space/);
    assert.equal(t.calls.some((args) => args[0] === 'get'), false);
    assert.equal(t.children.length, 0); assert.equal(t.core.local.busy, false);
    t.control.disk = 1e12;
    await t.owner.call('local.download', { module: MODULE.id });
    assert.equal(t.children.length, 1);
    const child = t.children[0]!; const closed = once(child, 'close');
    await t.owner.call('local.cancel', { module: MODULE.id }); await closed;
    assert.equal(child.signalCode, 'SIGTERM'); assert.equal(t.core.local.busy, false);
  } finally { await t.cleanup(); }
});

for (const [name, value] of [['NaN', NaN], ['Infinity', Infinity], ['negative', -1]] as const) {
  test(`an invalid ${name} free-space measurement cannot admit a download`, async () => {
    const t = await fixture();
    try {
      t.control.disk = value;
      await assert.rejects(t.owner.call('local.download', { module: MODULE.id }), /valid free disk space/);
      assert.equal(t.calls.some((args) => args[0] === 'get'), false);
      assert.equal(t.children.length, 0); assert.equal(t.core.local.busy, false);
    } finally { await t.cleanup(); }
  });
}

test('a failed memory estimate prevents forced loading, session rows and terminals; a healthy retry starts the stand-in', async () => {
  const t = await fixture(true);
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    t.control.estimate = { code: 17, stdout: '', stderr: 'Owned estimate command failed' };
    await assert.rejects(t.owner.call('sessions.start', { projectId: project.id, provider: 'claude', model: VALUE }), /could not estimate memory.*Owned estimate command failed/);
    assert.equal(t.calls.some((args) => args[0] === 'load' && args.includes('--yes')), false);
    assert.deepEqual(await t.owner.call('sessions.list', { projectId: project.id }), []);
    assert.equal(t.core.sessions.terminalCount, 0);
    t.control.estimate = { code: 0, stdout: 'Estimate: This model may be loaded.', stderr: '' };
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude', model: VALUE });
    assert.equal(t.calls.filter((args) => args[0] === 'load' && args.includes('--yes')).length, 1);
    assert.equal((await t.owner.call('sessions.list', { projectId: project.id }))[0]?.model, VALUE);
    assert.equal(t.core.sessions.terminalCount, 1);
    await waitFor('owned stand-in session output', async () => (await t.owner.call('sessions.watch', { id: session.id })).replay.includes('owned local guard session'));
  } finally { await t.cleanup(); }
});

test('the complete model plus ten GB headroom fits exactly; one byte less still refuses', async () => {
  const t = await fixture();
  try {
    t.control.disk = 27_189_999_999;
    await assert.rejects(t.owner.call('local.download', { module: MODULE.id }), /keeps 10\.0 GB spare/);
    assert.equal(t.children.length, 0); assert.equal(t.core.local.busy, false);
    t.control.disk = 27_190_000_000;
    await t.owner.call('local.download', { module: MODULE.id });
    assert.equal(t.children.length, 1);
    const child = t.children[0]!; const closed = once(child, 'close');
    await t.owner.call('local.cancel', { module: MODULE.id }); await closed;
    assert.equal(child.signalCode, 'SIGTERM'); assert.equal(t.core.local.busy, false);
  } finally { await t.cleanup(); }
});

for (const [name, stdout, stderr, message] of [
  ['whitespace stderr', 'Owned stdout failure', ' \n\t ', /Owned stdout failure/],
  ['empty diagnostic', ' \n ', '\t ', /exit 17/],
  ['long diagnostic', 'Estimate: This model may be loaded.', 'x'.repeat(700), /x{300}/],
] as const) {
  test(`a failed estimate with ${name} stays refused with a bounded useful error and creates no session`, async () => {
    const t = await fixture(true);
    try {
      const project = await t.owner.call('projects.add', { path: t.projectDir });
      t.control.estimate = { code: 17, stdout, stderr };
      await assert.rejects(t.owner.call('sessions.start', { projectId: project.id, provider: 'claude', model: VALUE }), (error: unknown) => {
        assert.ok(error instanceof Error); assert.match(error.message, /could not estimate memory/);
        assert.match(error.message, message); assert.ok(error.message.length < 500);
        assert.equal(error.message.includes('x'.repeat(301)), false); return true;
      });
      assert.equal(t.calls.some((args) => args[0] === 'load' && args.includes('--yes')), false);
      assert.deepEqual(await t.owner.call('sessions.list', { projectId: project.id }), []);
      assert.equal(t.core.sessions.terminalCount, 0);
    } finally { await t.cleanup(); }
  });
}
