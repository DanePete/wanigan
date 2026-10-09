// Notifications to phones. The encryption is proved the only way that means
// anything: a phone's side of RFC 8291, written here independently, decrypts
// what Wanigan sends. Sending is checked against a stand-in push service.
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Need } from '../../shared/model.ts';
import { encryptPushPayload, generateVapidKeys, vapidAuthorization } from './webpush-crypto.ts';
import { PhonePush } from './push.ts';
import type { PhoneDevices, PushTarget } from './devices.ts';

const hmac = (key: Buffer, data: Buffer): Buffer => createHmac('sha256', key).update(data).digest();

/** A phone's side: decrypt one aes128gcm record (RFC 8188 framing, RFC 8291 keys). */
function phoneDecrypts(body: Buffer, phone: { ecdh: ReturnType<typeof createECDH>; auth: Buffer }): string {
  const salt = body.subarray(0, 16);
  const keyLength = body.readUInt8(20);
  const serverKey = body.subarray(21, 21 + keyLength);
  const record = body.subarray(21 + keyLength);
  const shared = phone.ecdh.computeSecret(serverKey);
  const ikm = hmac(hmac(phone.auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), phone.ecdh.getPublicKey(), serverKey, Buffer.from([1])])).subarray(0, 32);
  const prk = hmac(salt, ikm);
  const key = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const decipher = createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  assert.equal(padded.at(-1), 2, 'the last record’s delimiter');
  return padded.subarray(0, -1).toString('utf8');
}

function aPhone() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
}

test('a phone decrypts what Wanigan encrypts to it, and nobody else can', () => {
  const phone = aPhone();
  const body = encryptPushPayload(Buffer.from('{"title":"Needs you","body":"NS-3 asks to run npm test"}'), phone.keys);
  assert.equal(phoneDecrypts(body, phone), '{"title":"Needs you","body":"NS-3 asks to run npm test"}');
  const stranger = aPhone();
  assert.throws(() => phoneDecrypts(body, stranger), 'another phone’s keys cannot read it');
});

test('the VAPID token is a valid ES256 signature for the push service it is sent to', () => {
  const keys = generateVapidKeys();
  const header = vapidAuthorization(keys, 'https://web.push.apple.com/abc', 'https://github.com/DanePete/wanigan', 3600, Date.UTC(2026, 9, 8));
  const [, jwt = '', k = ''] = /^vapid t=([^,]+), k=(.+)$/.exec(header) ?? [];
  assert.equal(k, keys.publicKey);
  const [h = '', c = '', s = ''] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as { aud: string; sub: string; exp: number };
  assert.deepEqual([claims.aud, claims.sub, claims.exp], ['https://web.push.apple.com', 'https://github.com/DanePete/wanigan', Date.UTC(2026, 9, 8) / 1000 + 3600]);
  const point = Buffer.from(keys.publicKey, 'base64url');
  const pub = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') } });
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});

function harness(status = 201) {
  const phone = aPhone();
  const sent: { url: string; headers: Record<string, string>; text: string }[] = [];
  let forgotten: string | null = null;
  const target: PushTarget = { deviceId: 'd1', endpoint: 'https://web.push.apple.com/abc', ...phone.keys };
  const devices = { pushTargets: () => (forgotten ? [] : [target]), clearPush: (target: PushTarget) => { forgotten = target.deviceId; } } as unknown as PhoneDevices;
  const push = new PhonePush({
    keysFile: join(mkdtempSync(join(tmpdir(), 'wg-push-')), 'phone-push.json'),
    devices,
    fetch: async (url, init) => { sent.push({ url, headers: init.headers, text: phoneDecrypts(init.body, phone) }); return { status }; },
  });
  return { push, sent, forgotten: () => forgotten };
}

const need = (kind: Need['kind'], since: number, title = 'NS-3 Checkout'): Need => ({ kind, projectId: 'p', projectKey: 'NS', cardId: 'c', cardKey: 'NS-3', sessionId: 's', title, detail: 'npm test', since } as Need);

test('a phone is told what newly needs the owner, in the Mac’s words, once; old news at start is not sent', async () => {
  const { push, sent } = harness();
  await push.announce([need('permission', 1)], true);
  assert.equal(sent.length, 0, 'what was open when the core started is not news');
  await push.announce([need('permission', 1), need('failed', 2)]);
  assert.equal(sent.length, 1);
  const message = JSON.parse(sent[0]!.text) as { title: string; body: string; tag: string };
  assert.match(message.title + message.body, /NS-3|Checkout|failed/i);
  assert.deepEqual([sent[0]!.headers['Content-Encoding'], sent[0]!.headers.Urgency], ['aes128gcm', 'high']);
  assert.match(sent[0]!.headers.Authorization ?? '', /^vapid t=/);
  await push.announce([need('permission', 1), need('failed', 2)]);
  assert.equal(sent.length, 1, 'never twice');
  await push.announce([need('waiting', 3)]);
  assert.equal(sent.length, 1, 'only kinds that alert on the Mac alert a phone');
});

test('a test notification reaches each phone, and one the push service says is gone is forgotten', async () => {
  const ok = harness();
  assert.equal(await ok.push.test(), 1);
  assert.equal(JSON.parse(ok.sent[0]!.text).body, 'Notifications reach this phone.');
  const gone = harness(410);
  assert.equal(await gone.push.test(), 0);
  assert.equal(gone.forgotten(), 'd1');
});
