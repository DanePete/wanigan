import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';
import config from '../../electron.vite.config.ts';

test('the README dev server serves the bundled fonts without exposing files outside the repository', async () => {
  const renderer = config.renderer ?? {};
  const server = await createServer({
    ...renderer, configFile: false, logLevel: 'silent',
    server: { ...renderer.server, host: '127.0.0.1', port: 0 },
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const font = resolve('node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2');
    const response = await fetch(`${base}/@fs${font}`);
    assert.equal(response.status, 200, 'font files imported from node_modules are served');
    assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString(), 'wOF2');
    const outside = await fetch(`${base}/@fs/etc/hosts`);
    assert.equal(outside.status, 403, 'the dev filesystem boundary stays enabled');
  } finally { await server.close(); }
});
