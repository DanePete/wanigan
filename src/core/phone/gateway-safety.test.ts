// The real core's Phone HTTP parser, with the production rejection-logging
// policy modeled in an isolated child. No installed tools or real accounts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

test('a malformed HTTP target is refused without an unhandled rejection, and Phone and owner requests still work', () => {
  const root = mkdtempSync('/tmp/wg-phone-url-');
  const home = join(root, 'home'); const temporary = join(root, 'tmp');
  mkdirSync(home); mkdirSync(temporary);
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import { request } from 'node:http';
      import { testCore } from ${JSON.stringify(new URL('../test-support.ts', import.meta.url).href)};
      const unhandled = [];
      // Production index.ts records rather than exits on this event. A bare
      // child without that listener would overstate the production consequence.
      process.on('unhandledRejection', error => unhandled.push(error?.code ?? String(error)));
      const t = await testCore();
      const http = (port, path, host = '127.0.0.1') => new Promise(resolve => {
        const req = request({ hostname: '127.0.0.1', port, path, headers: { Host: host } }, res => {
          let body = ''; res.on('data', data => { body += data; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', error => resolve({ error: error.code }));
        req.setTimeout(500, () => { resolve({ timedOut: true }); req.destroy(); });
        req.end();
      });
      try {
        await t.owner.call('phone.enable', {});
        const port = t.core.phone.listeningPort;
        const malformed = await http(port, '//[');
        const api = await http(port, '/wanigan/api/rpc');
        const forbidden = await http(port, '/api/rpc', 'elsewhere.example');
        const missing = await http(port, '/wanigan/%E0%A4%A');
        const projects = await t.owner.call('projects.list', {});
        console.log(JSON.stringify({ malformed, api, forbidden, missing, unhandled, projects, listening: t.core.phone.listeningPort === port }));
      } finally { await t.close(); }
    `], {
      env: { HOME: home, TMPDIR: temporary, SHELL: '/bin/sh', PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    const result = JSON.parse(child.stdout) as {
      malformed: { status?: number; body?: string }; api: { status: number }; forbidden: { status: number };
      missing: { status: number }; unhandled: string[]; projects: unknown[]; listening: boolean;
    };
    assert.equal(result.malformed.status, 400, JSON.stringify(result));
    assert.equal(JSON.parse(result.malformed.body!).error.code, 'invalid');
    assert.deepEqual(result.unhandled, []);
    assert.equal(result.api.status, 401);
    assert.equal(result.forbidden.status, 403);
    assert.equal(result.missing.status, 404);
    assert.deepEqual(result.projects, []);
    assert.equal(result.listening, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
