// An "ephemeral" terminal (the MCP add terminal, where the owner types an API
// key) promises to keep no record once it closes, and search skips it only
// while it is live. If the core dies before the exit is recorded (a crash, a
// force quit), the scrollback stays on disk, the next core does not know the
// session was ephemeral, and "Search what agents said" returns the key.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CoreClient } from '../client/client.ts';
import { Core, type CoreOptions } from './core.ts';
import { CLI, launcher, testCore, waitFor } from './test-support.ts';

test('a key typed into an ephemeral terminal is never found by search, even after a crash', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wg-eph-')));
  const projectDir = join(dir, 'site');
  mkdirSync(projectDir);
  mkdirSync(join(dir, 'home', '.claude'), { recursive: true });
  const options: CoreOptions = {
    dataDir: join(dir, 'data'), launcher, cli: { runtime: process.execPath, entry: CLI }, codexHookProbe: null,
    accounts: { home: join(dir, 'home'), prober: async () => ({ signedIn: 'unknown', identity: null, plan: null }), usageReader: async () => ({ state: 'unreadable', windows: [], checkedAt: 0, note: 'test' }) },
  };
  try {
    const a = new Core(options);
    await a.start();
    const projectId = a.board.addProject({ path: projectDir }).id;
    const s = await a.sessions.start({ projectId, provider: 'shell', title: 'Add an MCP server', ephemeral: true });
    a.sessions.input(s.id, 'echo sk-SECRET-12345\n');
    await waitFor('echoed', () => a.sessions.replay(s.id).replay.includes('sk-SECRET-12345'));
    // The core dies before the shell's exit is recorded.
    (a.sessions as unknown as { closed: boolean }).closed = true;
    await a.stop();

    const b = new Core(options);
    await b.start();
    const owner = await CoreClient.connect(b.paths.socket, readFileSync(b.paths.ownerToken, 'utf8'));
    const found = await owner.call('sessions.search', { query: 'sk-SECRET' });
    owner.close();
    await b.stop();
    assert.deepEqual(found.hits.map((h) => h.snippet.match), [], 'the key was found in the ephemeral terminal');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('a sensitive terminal keeps its live replay in memory and never creates a disk record', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const session = await t.core.sessions.start({ projectId: project.id, provider: 'shell', ephemeral: true });
    t.core.sessions.input(session.id, 'echo private-sign-in-output\n');
    await waitFor('live replay', () => t.core.sessions.replay(session.id).replay.includes('private-sign-in-output'));
    assert.equal(existsSync(join(t.core.paths.dataDir, 'scrollback', `${session.id}.log`)), false,
      'a crash must not leave sensitive output behind for a later startup to clean');
  } finally {
    await t.close();
  }
});


test('recovery removes sign-in records left by an older core without needing a session row', async () => {
  const t = await testCore();
  try {
    const log = join(t.core.paths.dataDir, 'scrollback', 'signin-12345678-1234-1234-1234-123456789012.log');
    writeFileSync(log, 'old private sign-in output');
    t.core.sessions.recover();
    assert.equal(existsSync(log), false, 'utility terminals have no session row to drive cleanup');
  } finally {
    await t.close();
  }
});
