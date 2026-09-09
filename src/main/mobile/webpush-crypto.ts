import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from 'node:crypto';

/**
 * Web Push, as the two RFCs actually specify it, and nothing else.
 *
 * Every function here is pure and takes no Electron, no database and no
 * settings — which is the point. This is the one part of the phone-alert path
 * that cannot be checked by reading it: an implementation with the HKDF info
 * strings transposed produces a body of exactly the right length, with the
 * right header, that every push service accepts and no device can decrypt. The
 * failure is a notification that silently never arrives, which is precisely the
 * failure the alert path exists to prevent.
 *
 * So the offline suite generates a subscription keypair, calls
 * `encryptPushPayload`, and decrypts the result back to the plaintext. That
 * test can only be written against functions that need nothing but bytes, and
 * that is why the RFC work lives in its own module rather than inside the
 * sender that has a credential store and a socket.
 *
 *   RFC 8291 — Message Encryption for Web Push (the aes128gcm body)
 *   RFC 8188 — Encrypted Content-Encoding for HTTP (the record framing)
 *   RFC 8292 — VAPID (the ES256 JWT that identifies this Mac to the service)
 */

/** One AES-128-GCM record holds the whole payload; Wanigan never sends two. */
export const RECORD_SIZE = 4_096;

/** 16-byte salt, 4-byte record size, 1-byte key length, then the 65-byte key. */
const HEADER_BYTES = 16 + 4 + 1 + 65;

/** GCM tag plus the one-byte record delimiter the plaintext is padded with. */
const RECORD_OVERHEAD = 16 + 1;

/**
 * The most plaintext that can be encrypted into a single record a push service
 * will accept. Services cap the request body at 4096 bytes, and the framing
 * above is charged against that budget, not added to it.
 */
export const MAX_PLAINTEXT_BYTES = RECORD_SIZE - HEADER_BYTES - RECORD_OVERHEAD;

/** A P-256 public point, uncompressed. Both peers' keys are this shape. */
const P256_PUBLIC_BYTES = 65;
/** A P-256 scalar. `createECDH` can return fewer, which is why pad32 exists. */
const P256_PRIVATE_BYTES = 32;
/** RFC 8291 §3.2: the subscription's authentication secret. */
const AUTH_SECRET_BYTES = 16;

export type VapidKeys = {
  /** Uncompressed P-256 point, base64url. This is the applicationServerKey. */
  publicKey: string;
  /** The 32-byte private scalar, base64url. Never leaves this machine. */
  privateKey: string;
};

export type PushSubscriptionKeys = {
  /** The device's uncompressed P-256 public point, base64url. */
  p256dh: string;
  /** The device's 16-byte authentication secret, base64url. */
  auth: string;
};

export function b64url(value: Buffer): string {
  return value.toString('base64url');
}

/**
 * Decode base64url with the length checked by the caller's expectation.
 *
 * Every input to this module that is not generated here came off the wire from
 * a phone. A `p256dh` of the wrong length is not a smaller key, it is a
 * different kind of value, and `computeSecret` reacts to one by throwing
 * something that reads like an internal error at a caller that has no idea a
 * device sent it. Named lengths turn all of that into one sentence at the edge.
 */
export function fromB64url(value: unknown, expectedBytes: number, label: string): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
    throw new Error(`${label} must be base64url text.`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== expectedBytes) {
    throw new Error(`${label} must decode to ${expectedBytes} bytes, not ${decoded.length}.`);
  }
  return decoded;
}

/**
 * Left-pad a scalar to 32 bytes.
 *
 * `ECDH#getPrivateKey()` returns the integer's minimal big-endian encoding, so
 * roughly one key in 256 comes back at 31 bytes or shorter. A JWK `d` of the
 * wrong length is rejected outright by `createPrivateKey`, which would make
 * this feature fail for a fraction of users at key generation and work for
 * everyone else — the worst distribution a bug can have.
 */
function pad32(scalar: Buffer): Buffer {
  if (scalar.length === P256_PRIVATE_BYTES) return scalar;
  if (scalar.length > P256_PRIVATE_BYTES) throw new Error('A P-256 private scalar cannot exceed 32 bytes.');
  return Buffer.concat([Buffer.alloc(P256_PRIVATE_BYTES - scalar.length), scalar]);
}

function hmacSha256(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/**
 * HKDF-Expand with a single-block output, which is all Web Push ever needs:
 * the longest value derived below is 32 bytes and SHA-256 gives 32 per block.
 * Written out rather than reached for through `crypto.hkdf` because the
 * one-block case is one line and the callback/promise form is not.
 */
function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  if (length > 32) throw new Error('This HKDF expansion covers one SHA-256 block only.');
  return hmacSha256(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
}

/** A fresh P-256 keypair, as raw base64url scalars and points. */
export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: b64url(ecdh.getPublicKey()),
    privateKey: b64url(pad32(ecdh.getPrivateKey())),
  };
}

/** Whether a stored pair is still the shape every function below assumes. */
export function vapidKeysValid(value: unknown): value is VapidKeys {
  if (!value || typeof value !== 'object') return false;
  const keys = value as Partial<VapidKeys>;
  try {
    fromB64url(keys.publicKey, P256_PUBLIC_BYTES, 'The VAPID public key');
    fromB64url(keys.privateKey, P256_PRIVATE_BYTES, 'The VAPID private key');
  } catch {
    return false;
  }
  // A public point that does not begin 0x04 is not the uncompressed encoding
  // `applicationServerKey` requires, and Safari refuses the subscription with
  // an error the operator can do nothing about.
  return Buffer.from(keys.publicKey!, 'base64url')[0] === 0x04;
}

/**
 * Rebuild the signing key from the raw scalar.
 *
 * Via JWK because that is the one import format that takes a bare P-256 scalar
 * without a DER or PEM wrapper being hand-assembled around it. The public
 * coordinates are required by the JWK form and are derived from the same key,
 * so a stored pair that does not agree with itself fails here rather than
 * producing a signature no push service will accept.
 */
function signingKey(keys: VapidKeys) {
  const publicPoint = fromB64url(keys.publicKey, P256_PUBLIC_BYTES, 'The VAPID public key');
  const scalar = fromB64url(keys.privateKey, P256_PRIVATE_BYTES, 'The VAPID private key');
  return createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: b64url(scalar),
      x: b64url(publicPoint.subarray(1, 33)),
      y: b64url(publicPoint.subarray(33, 65)),
    },
  });
}

/** The `aud` claim: scheme and host of the endpoint, and nothing after it. */
export function pushAudience(endpoint: string): string {
  return new URL(endpoint).origin;
}

/**
 * The VAPID Authorization header for one endpoint.
 *
 * `subject` is a contact the push service may use if this application server
 * misbehaves. Apple rejects a token without one. Wanigan sends its own project
 * URL rather than anything belonging to the operator: the alternative the spec
 * offers is a `mailto:`, and putting the user's email address on every push to
 * a third party to satisfy a field nobody reads is not a trade this app makes.
 */
export function vapidAuthorization(
  keys: VapidKeys,
  endpoint: string,
  subject: string,
  expiresInSeconds = 12 * 60 * 60,
  nowMs: number = Date.now(),
): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' }), 'utf8'));
  const claims = b64url(Buffer.from(JSON.stringify({
    aud: pushAudience(endpoint),
    // Services refuse a token valid for more than 24 hours. Twelve is inside
    // that with room for a Mac whose clock is wrong by a few hours.
    exp: Math.floor(nowMs / 1000) + Math.min(expiresInSeconds, 23 * 60 * 60),
    sub: subject,
  }), 'utf8'));
  const signingInput = Buffer.from(`${header}.${claims}`, 'utf8');
  // ieee-p1363 is r‖s. The DER encoding Node produces by default is the same
  // signature in a wrapper JWS does not permit, and every push service rejects
  // it — with a 401 that says nothing about which of the two encodings it got.
  const signature = sign('sha256', signingInput, { key: signingKey(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

/**
 * One aes128gcm record, encrypted to a single subscription.
 *
 * The output is the complete HTTP body: the RFC 8188 header (salt, record
 * size, and this message's ephemeral public key) followed by the single
 * encrypted record. The ephemeral keypair is generated per message and thrown
 * away with the stack frame, so two alerts to the same phone share no key
 * material and a recovered payload compromises nothing but itself.
 */
export function encryptPushPayload(
  plaintext: Buffer,
  keys: PushSubscriptionKeys,
  salt: Buffer = randomBytes(16),
): Buffer {
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new Error(`A push payload cannot exceed ${MAX_PLAINTEXT_BYTES} bytes.`);
  }
  if (salt.length !== 16) throw new Error('A push record salt must be 16 bytes.');

  const uaPublic = fromB64url(keys.p256dh, P256_PUBLIC_BYTES, "The device's push key");
  const authSecret = fromB64url(keys.auth, AUTH_SECRET_BYTES, "The device's push auth secret");

  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  // Throws on a point that is not on the curve, which is the check that keeps a
  // malicious subscription from steering the shared secret.
  const sharedSecret = ecdh.computeSecret(uaPublic);

  // RFC 8291 §3.4. The order of the two public keys in key_info is fixed and
  // not symmetric: user agent first, application server second. Swapping them
  // yields a key the device will never derive, and nothing observable fails.
  const authPrk = hmacSha256(authSecret, sharedSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = hkdfExpand(authPrk, keyInfo, 32);

  const prk = hmacSha256(salt, ikm);
  const contentKey = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  // 0x02 is the last-record delimiter. 0x01 marks a record with more to follow,
  // and a receiver that reads it waits for a second record that never comes.
  const padded = Buffer.concat([plaintext, Buffer.from([0x02])]);
  const cipher = createCipheriv('aes-128-gcm', contentKey, nonce);
  const body = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(P256_PUBLIC_BYTES, 20);
  return Buffer.concat([header, asPublic, body]);
}
