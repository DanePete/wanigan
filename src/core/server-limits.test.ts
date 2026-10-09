import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { test } from 'node:test';
import { CoreClient } from '../client/client.ts';
import { testCore, waitFor } from './test-support.ts';

test('idle socket connections are capped while an existing owner keeps working', async () => {
  const t = await testCore();
  const sockets: Socket[] = [];
  let closed = 0;
  try {
    // Connect sequentially so the kernel's listen backlog cannot masquerade as an app limit.
    for (let i = 0; i < 300; i++) {
      const socket = connect(t.core.paths.socket);
      sockets.push(socket);
      socket.on('close', () => closed++);
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(closed >= 45, `only 256 connections, including the owner, may remain; closed ${closed}`);
    await t.owner.call('core.hello', {});
  } finally { for (const socket of sockets) socket.destroy(); await t.close(); }
});

test('authentication has a deadline even when an unauthenticated peer keeps sending', async () => {
  const t = await testCore();
  const socket = connect(t.core.paths.socket);
  socket.on('error', () => {});
  const drip = setInterval(() => { if (!socket.destroyed) socket.write(' '); }, 50);
  try {
    await waitFor('unauthenticated connection to expire', () => socket.destroyed, 6_000);
    assert.equal(t.owner.isClosed, false, 'an already authenticated connection does not expire');
    await t.owner.call('core.hello', {});
  } finally { clearInterval(drip); socket.destroy(); await t.close(); }
});

test('multiple connections share a limit on active core requests', async () => {
  const t = await testCore();
  const clients: CoreClient[] = [];
  const hello = t.core.handlers['core.hello'];
  let entered = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const calls: Promise<string | null>[] = [];
  try {
    for (let i = 0; i < 5; i++) clients.push(await CoreClient.connect(t.core.paths.socket, readFileSync(t.core.paths.ownerToken, 'utf8')));
    t.core.handlers['core.hello'] = async (params, caller) => { entered++; await held; return hello(params, caller); };
    for (const client of clients) for (let i = 0; i < 120; i++) calls.push(client.call('core.hello', {}).then(() => null, (error: Error) => error.message));
    await waitFor('global request budget reached', () => entered >= 512);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(entered, 512);
    release();
    const outcomes = await Promise.all(calls);
    assert.equal(outcomes.filter(value => value === null).length, 512);
    assert.ok(outcomes.filter(value => value !== null).every(value => /too many.*requests/i.test(value)));
    await t.owner.call('core.hello', {});
  } finally { release(); await Promise.all(calls); for (const client of clients) client.close(); await t.close(); }
});

test('a stopped reader is disconnected before outgoing events accumulate without a bound', async () => {
  const t = await testCore();
  const socket = connect(t.core.paths.socket);
  socket.on('error', () => {});
  try {
    t.owner.close();
    await waitFor('original owner to close', () => t.core.server.ownerConnections === 0);
    const ready = new Promise<void>(resolve => socket.once('data', () => { socket.pause(); resolve(); }));
    socket.write(`${JSON.stringify({ token: readFileSync(t.core.paths.ownerToken, 'utf8') })}\n`);
    await ready;
    assert.equal(t.core.server.ownerConnections, 1);
    const data = 'x'.repeat(1024 * 1024);
    for (let seq = 0; seq < 80; seq++) t.core.bus.emit('pty.data', { sessionId: 'fixture', seq, data });
    await waitFor('stopped reader to be dropped', () => t.core.server.ownerConnections === 0, 1_000);
    const next = await CoreClient.connect(t.core.paths.socket, readFileSync(t.core.paths.ownerToken, 'utf8'));
    try { await next.call('core.hello', {}); } finally { next.close(); }
  } finally { socket.destroy(); await t.close(); }
});

test('hook connections expire while dripping input and release space for a new owner', async () => {
  const t = await testCore();
  const sockets: Socket[] = [];
  let drip: ReturnType<typeof setInterval> | undefined;
  try {
    for (let i = 0; i < 255; i++) {
      const socket = connect(t.core.paths.hookSocket);
      socket.on('error', () => {});
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    }
    drip = setInterval(() => { for (const socket of sockets) if (!socket.destroyed) socket.write(' '); }, 50);
    await waitFor('all unauthenticated hooks to expire despite input', () => sockets.every(socket => socket.destroyed), 6_000);
    await t.owner.call('core.hello', {});
    const next = await CoreClient.connect(t.core.paths.socket, readFileSync(t.core.paths.ownerToken, 'utf8'));
    try { await next.call('core.hello', {}); } finally { next.close(); }
  } finally { clearInterval(drip); for (const socket of sockets) socket.destroy(); await t.close(); }
});
