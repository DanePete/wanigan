import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CoreClient } from './client.ts';

async function peer(reply: string, check: (path: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'wg-client-'));
  const path = join(dir, 'core.sock');
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('data', () => socket.end(reply));
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  try { await check(path); } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a null protocol reply refuses the connection without crashing the app process', () => {
  // Before the guard this escaped the socket callback as an uncaught TypeError.
  const script = `
    import assert from 'node:assert/strict';
    import { mkdtempSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { createServer } from 'node:net';
    import { CoreClient } from ${JSON.stringify(new URL('./client.ts', import.meta.url).href)};
    const dir = mkdtempSync(join(tmpdir(), 'wg-client-null-'));
    const path = join(dir, 'core.sock');
    const server = createServer(socket => socket.once('data', () => socket.end('null\\n')));
    await new Promise(resolve => server.listen(path, resolve));
    try { await assert.rejects(CoreClient.connect(path, 'test-only'), /unreadable/); }
    finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
  `;
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 3_000, stdio: 'pipe',
  }));
});

test('the handshake requires a real ready flag and an owner or session role', async () => {
  for (const reply of [{ ready: true, role: 'admin' }, { ready: 'yes', role: 'owner' }, { ready: true }]) {
    await peer(`${JSON.stringify(reply)}\n`, async (path) => {
      await assert.rejects(CoreClient.connect(path, 'test-only').then((client) => { client.close(); return client; }), /unreadable/);
    });
  }
});

test('a peer that closes during the handshake fails immediately as closed, not as a timeout', async () => {
  await peer('', async (path) => {
    await assert.rejects(CoreClient.connect(path, 'test-only', 200), /connection.*closed/i);
  });
});

test('an oversized unfinished handshake is refused before buffering arbitrary peer output', async () => {
  await peer('x'.repeat(8_192), async (path) => {
    await assert.rejects(CoreClient.connect(path, 'test-only'), /too large/i);
  });
});

for (const phase of ['handshake', 'request']) {
  test(`malformed error fields during ${phase} reject without crashing the client process`, () => {
    const script = `
      import assert from 'node:assert/strict';
      import { mkdtempSync, rmSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { createServer } from 'node:net';
      import { CoreClient } from ${JSON.stringify(new URL('./client.ts', import.meta.url).href)};
      const dir = mkdtempSync(join(tmpdir(), 'wg-client-error-'));
      const path = join(dir, 'core.sock');
      const error = { code: 'invalid', message: { toString: 0 } };
      const server = createServer(socket => socket.once('data', () => {
        if (${JSON.stringify(phase)} === 'handshake') socket.end(JSON.stringify({ error }) + '\\n');
        else {
          socket.write(JSON.stringify({ ready: true, role: 'owner' }) + '\\n');
          socket.once('data', data => socket.end(JSON.stringify({ id: JSON.parse(data).id, error }) + '\\n'));
        }
      }));
      await new Promise(resolve => server.listen(path, resolve));
      try {
        if (${JSON.stringify(phase)} === 'handshake') await assert.rejects(CoreClient.connect(path, 'test-only'), /unreadable/);
        else {
          const client = await CoreClient.connect(path, 'test-only');
          try { await assert.rejects(client.call('core.hello', {}), /unreadable/); }
          finally { client.close(); }
        }
      } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
    `;
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 3_000, stdio: 'pipe',
    }));
  });
}
