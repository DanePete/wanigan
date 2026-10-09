// Tailscale through a stand-in for its CLI that keeps its state in files and
// records every call, in the shapes Tailscale 1.102 prints (read on this Mac).
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { serveCommand } from '../../shared/phone.ts';
import { Tailscale } from './tailscale.ts';

const CLI = `#!/bin/sh
S="$(dirname "$0")"
echo "$*" >> "$S/calls"
case "$1 $2" in
  "status --json") cat "$S/status.json" ;;
  "serve status") cat "$S/serve.json" ;;
  "serve --bg") printf '{"Web":{"mac.tail1.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:47831"},"/wanigan":{"Proxy":"http://127.0.0.1:47832"}}}}}' > "$S/serve.json" ;;
  "serve --https=443") printf '{"Web":{"mac.tail1.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:47831"}}}}}' > "$S/serve.json" ;;
esac
`;

function standIn(status: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'wg-ts-'));
  const bin = join(dir, 'tailscale');
  writeFileSync(bin, CLI);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, 'status.json'), JSON.stringify(status));
  writeFileSync(join(dir, 'serve.json'), JSON.stringify({ Web: { 'mac.tail1.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:47831' } } } } }));
  return { bin, calls: (): string[] => (existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n') : []) };
}

const RUNNING = { BackendState: 'Running', Self: { DNSName: 'mac.tail1.ts.net.' }, CertDomains: ['mac.tail1.ts.net'] };

test('Tailscale’s state: missing, stopped, without HTTPS, or ready with Wanigan served or not', async () => {
  assert.deepEqual(await new Tailscale({ bin: null }).state(47_832), { state: 'missing' });
  assert.deepEqual(await new Tailscale({ bin: standIn({ BackendState: 'NeedsLogin' }).bin }).state(47_832), { state: 'stopped' });
  assert.deepEqual(await new Tailscale({ bin: standIn({ ...RUNNING, CertDomains: null }).bin }).state(47_832), { state: 'no-https', dnsName: 'mac.tail1.ts.net' });
  assert.deepEqual(await new Tailscale({ bin: standIn(RUNNING).bin }).state(47_832), { state: 'ready', dnsName: 'mac.tail1.ts.net', serving: false });
});

test('Wanigan adds and removes only its own mount, and leaves what else is served alone', async () => {
  const cli = standIn(RUNNING);
  const ts = new Tailscale({ bin: cli.bin });
  await ts.serve(47_832);
  assert.deepEqual(await ts.state(47_832), { state: 'ready', dnsName: 'mac.tail1.ts.net', serving: true });
  await ts.unserve();
  assert.deepEqual(await ts.state(47_832), { state: 'ready', dnsName: 'mac.tail1.ts.net', serving: false });
  assert.deepEqual(cli.calls().filter((c) => c.startsWith('serve --')), [
    'serve --bg --https=443 --set-path=/wanigan http://127.0.0.1:47832',
    'serve --https=443 --set-path=/wanigan off',
  ], 'never `serve reset`, never the root');
  assert.equal(`tailscale ${serveCommand(47_832).join(' ')}`, 'tailscale serve --bg --https=443 --set-path=/wanigan http://127.0.0.1:47832', 'what the owner is shown is what runs');
});

test('serving without Tailscale says how to get it', async () => {
  await assert.rejects(new Tailscale({ bin: null }).serve(47_832), /Tailscale is not installed on this Mac\. Install it from tailscale\.com/);
});
