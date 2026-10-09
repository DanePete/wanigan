// Actual owner push RPCs and stored subscriptions, with only an injected push
// service. All devices, keys, cores and homes belong to the temporary fixture.
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { testCore } from '../test-support.ts';
import type { PushTarget } from './devices.ts';
import { Tailscale } from './tailscale.ts';

function receiver() {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth };
}
const keys = (phone: ReturnType<typeof receiver>) => ({ p256dh: phone.ecdh.getPublicKey().toString('base64url'), auth: phone.auth.toString('base64url') });
const hmac = (key: Buffer, body: Buffer) => createHmac('sha256', key).update(body).digest();
/** Recipient-side RFC8291 decoding proves the following send uses the new keys. */
function receive(body: Buffer, phone: ReturnType<typeof receiver>): unknown {
  const salt = body.subarray(0, 16), serverKey = body.subarray(21, 21 + body.readUInt8(20));
  const record = body.subarray(21 + body.readUInt8(20));
  const shared = phone.ecdh.computeSecret(serverKey);
  const ikm = hmac(hmac(phone.auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), phone.ecdh.getPublicKey(), serverKey, Buffer.from([1])])).subarray(0, 32);
  const prk = hmac(salt, ikm);
  const key = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const decipher = createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([decipher.update(record.subarray(0, -16)), decipher.final()]);
  assert.equal(plain.at(-1), 2);
  return JSON.parse(plain.subarray(0, -1).toString('utf8'));
}

for (const status of [404, 410]) {
  for (const change of ['endpoint', 'public-key', 'auth', 'unchanged', 'forgotten'] as const) {
    test(`late push ${status} after ${change} change only clears the dispatched subscription`, async () => {
      let release!: () => void, entered!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      const requests: { url: string; body: Buffer }[] = [];
      const t = await testCore({ phone: { port: 0, pushFetch: async (url, init) => {
        requests.push({ url, body: Buffer.from(init.body) });
        if (requests.length === 1) { entered(); await held; return { status }; }
        return { status: 201 };
      }, tailscale: new Tailscale({ bin: null }) } });
      let pending: Promise<{ sent: number }> | undefined;
      try {
        const first = receiver(), fresh = receiver();
        const old = { endpoint: 'https://push.fixture.invalid/old', ...keys(first) };
        const { device } = t.core.phone.devices.pair(t.core.phone.devices.newCode().code, 'Subscription fixture');
        const { device: other } = t.core.phone.devices.pair(t.core.phone.devices.newCode().code, 'Unrelated fixture');
        const row = (id: string) => t.core.db.prepare('SELECT * FROM phone_devices WHERE id = ?').get(id);
        t.core.phone.subscribe(device.id, old);
        pending = t.owner.call('phone.testPush', {});
        await started;
        assert.equal(requests[0]!.url, old.endpoint);
        assert.equal((receive(requests[0]!.body, first) as { body: string }).body, 'Notifications reach this phone.');
        // Same subscription fields on another device must not match cleanup.
        // Add it after dispatch so this test's first send still has one target.
        t.core.phone.subscribe(other.id, old);
        const otherBefore = row(other.id);
        const replacement = { ...old };
        let recipient = first;
        if (change === 'endpoint') replacement.endpoint = 'https://push.fixture.invalid/new';
        if (change === 'public-key') { replacement.p256dh = keys(fresh).p256dh; recipient = { ecdh: fresh.ecdh, auth: first.auth }; }
        if (change === 'auth') { replacement.auth = keys(fresh).auth; recipient = { ecdh: first.ecdh, auth: fresh.auth }; }
        if (change === 'forgotten') await t.owner.call('phone.forget', { id: device.id });
        else if (change !== 'unchanged') t.core.phone.subscribe(device.id, replacement);
        const beforeCompletion = row(device.id);
        release();
        assert.deepEqual(await pending, { sent: 0 });
        assert.deepEqual(row(other.id), otherBefore, 'a different device is never changed');
        t.core.phone.subscribe(other.id, {}); // keep the following send focused on the disputed target
        if (change === 'forgotten') {
          assert.equal(row(device.id), undefined, 'late cleanup cannot recreate a forgotten device');
          assert.deepEqual(t.core.phone.devices.pushTargets(), []);
          assert.deepEqual(await t.owner.call('phone.testPush', {}), { sent: 0 });
          assert.equal(requests.length, 1);
        } else {
          if (change === 'unchanged') {
            assert.deepEqual(row(device.id), { ...beforeCompletion as object, push_endpoint: null, push_p256dh: null, push_auth: null });
            assert.deepEqual(t.core.phone.devices.pushTargets(), []);
            t.core.phone.subscribe(device.id, replacement); // explicit recovery after genuine expiry
          } else {
            assert.deepEqual(row(device.id), beforeCompletion, 'stale completion preserves every replacement row byte');
            const target: PushTarget = { deviceId: device.id, ...replacement };
            assert.deepEqual(t.core.phone.devices.pushTargets(), [target]);
          }
          assert.deepEqual(await t.owner.call('phone.testPush', {}), { sent: 1 });
          assert.equal(requests.length, 2);
          assert.equal(requests[1]!.url, replacement.endpoint);
          assert.equal((receive(requests[1]!.body, recipient) as { body: string }).body, 'Notifications reach this phone.', 'the retained/recovered target can actually decrypt the following send');
          assert.deepEqual(t.core.phone.devices.pushTargets(), [{ deviceId: device.id, ...replacement }]);
        }
        assert.deepEqual(await t.owner.call('sessions.list', {}), []);
        await t.owner.call('core.hello', {});
      } finally {
        release(); await pending;
        await t.close();
      }
    });
  }
}
