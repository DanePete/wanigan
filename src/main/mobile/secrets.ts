import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import { getSetting, setSetting } from '../settings';
import { generateVapidKeys, vapidKeysValid } from './webpush-crypto';
import type { VapidKeys } from './webpush-crypto';

/**
 * The phone monitor's credentials: the bearer token a paired device sends, the
 * secret ntfy topic notifications are published to, and — since Web Push — the
 * VAPID keypair that identifies this Mac to a push service plus the per-device
 * subscriptions it sends to. They live in one OS-encrypted file rather than the
 * settings table, and this module is the only place that reads or replaces them.
 *
 * A subscription belongs here and not in SQLite for the same reason the topic
 * was moved out of the settings table below: an endpoint with its `p256dh` and
 * `auth` is a sending credential — anyone holding one can put a notification on
 * that device's lock screen — and a credential does not go in a table of
 * feature flags.
 */

const TOKEN_BYTES = 32;
const TOPIC_BYTES = 24;
const PAIR_CODE_MS = 10 * 60_000;

/**
 * How many devices may hold a subscription at once.
 *
 * A cap rather than no cap because this list is appended to by a paired device
 * over HTTP: a phone that reinstalls the app, or a browser that rotates its
 * subscription, arrives as a new row, and an uncapped list grows for the life
 * of the install. Eight is more devices than an operator has and small enough
 * that a fan-out never becomes a reason a hook handler waits.
 */
export const MAX_PUSH_DEVICES = 8;

// The short-lived development format kept both credentials in the settings
// table. These two row names are named here rather than imported from ./config
// so the credential store stays below configuration: see the note there.
const LEGACY_TOKEN_KEY = 'mobile_token';
const LEGACY_TOPIC_KEY = 'mobile_push_topic';

/**
 * One device's Web Push subscription, as the browser handed it over, plus what
 * the last publish to it did.
 *
 * `endpoint` names a push service host, which is why it never crosses back to
 * a phone: it is both the address a notification is delivered to and, together
 * with the two keys, the capability to deliver one. The phone is told whether
 * this device is subscribed, never with what.
 */
export type MobilePushDevice = {
  /** Wanigan's own id for the row, so one device can be forgotten by name. */
  id: string;
  /**
   * A stable id the device generates once and keeps, so a row survives its
   * endpoint changing.
   *
   * This exists because Safari rotates a Home Screen app's push endpoint on its
   * own — reports of iOS subscriptions going inactive after a week or two, and
   * of getSubscription() returning null after a restart and then handing back a
   * completely different subscription, are common. Keyed on the endpoint alone,
   * one iPhone became a new row every time that happened: the list filled with
   * rows for a single phone, all but the newest dead, and the cap started
   * evicting other people's devices to make room for them.
   *
   * Absent on a row written before this existed, which is why it is optional
   * and why the endpoint is still a fallback key.
   */
  clientId?: string;
  /** What the operator sees in Settings. Supplied by the device, bounded here. */
  label: string;
  endpoint: string;
  /** The device's P-256 public point, base64url. */
  p256dh: string;
  /** The device's 16-byte auth secret, base64url. */
  auth: string;
  createdAt: number;
  lastAt: number | null;
  lastOk: boolean | null;
  lastError: string | null;
};

export type MobileSecrets = {
  token: string;
  topic: string;
  /**
   * Absent in a file written before Web Push existed, and generated on first
   * use rather than at read time — see `ensureVapidKeys`.
   */
  vapid?: VapidKeys;
  devices?: MobilePushDevice[];
};
let memorySecrets: MobileSecrets | null = null;
let secretsError: string | null = null;

/**
 * Why the credential state is unusable, or null when it is fine. Callers read
 * it through a function because the value changes as a side effect of reading
 * the credentials, and a copied snapshot would report a stale reason.
 */
export function secretsIssue(): string | null {
  return secretsError;
}

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function generateTopic(): string {
  return `wanigan-${randomBytes(TOPIC_BYTES).toString('base64url')}`;
}

export function tokenLooksStrong(value: string): boolean {
  return /^[A-Za-z0-9_-]{40,128}$/.test(value);
}

export function topicLooksStrong(value: string): boolean {
  return /^wanigan-[A-Za-z0-9_-]{30,120}$/.test(value);
}

/**
 * A push endpoint Wanigan is willing to POST to.
 *
 * The value arrives from a paired browser and is then used as a URL this
 * process opens by itself, so it is checked here rather than at the socket:
 * HTTPS only, no credentials in the authority, and no `file:`/`http:` variant
 * that would turn a stored subscription into a request at something local.
 * Which host it names is deliberately not constrained — the endpoint is chosen
 * by the browser's own push service, and an allow-list written today would
 * break every Firefox or Chrome install the moment one changed.
 */
export function pushEndpointValid(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2_000) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && !url.username && !url.password && url.hostname.includes('.');
}

function deviceValid(value: unknown): value is MobilePushDevice {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<MobilePushDevice>;
  return typeof row.id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(row.id)
    && typeof row.label === 'string'
    && pushEndpointValid(row.endpoint)
    && typeof row.p256dh === 'string' && /^[A-Za-z0-9_-]{80,120}={0,2}$/.test(row.p256dh)
    && typeof row.auth === 'string' && /^[A-Za-z0-9_-]{16,32}={0,2}$/.test(row.auth)
    && (row.clientId === undefined || (typeof row.clientId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(row.clientId)))
    && typeof row.createdAt === 'number' && Number.isFinite(row.createdAt);
}

/**
 * Keep the rows that are still usable and drop the rest.
 *
 * Deliberately lenient, and deliberately different from how the token and topic
 * below are treated. An unreadable pairing token means the credential store is
 * broken and monitoring must pause; an unreadable device row means one phone
 * cannot be pushed to, and pausing the whole feature over it would take the
 * other devices down with it. Dropping is also safe in the direction that
 * matters — a discarded subscription costs one re-subscribe tap.
 */
function sanitiseDevices(value: unknown): MobilePushDevice[] {
  if (!Array.isArray(value)) return [];
  const out: MobilePushDevice[] = [];
  for (const row of value) {
    // De-duplicated by client id first and endpoint second, in that order: two
    // rows for one phone whose endpoint rotated are one device, and the newer
    // row is the one that can still be delivered to.
    if (!deviceValid(row)) continue;
    if (out.some((kept) => (row.clientId && kept.clientId === row.clientId) || kept.endpoint === row.endpoint)) continue;
    out.push({
      id: row.id,
      ...(row.clientId ? { clientId: row.clientId } : {}),
      label: row.label.slice(0, 60),
      endpoint: row.endpoint,
      p256dh: row.p256dh,
      auth: row.auth,
      createdAt: row.createdAt,
      lastAt: typeof row.lastAt === 'number' && Number.isFinite(row.lastAt) ? row.lastAt : null,
      lastOk: typeof row.lastOk === 'boolean' ? row.lastOk : null,
      lastError: typeof row.lastError === 'string' ? row.lastError.slice(0, 300) : null,
    });
    if (out.length >= MAX_PUSH_DEVICES) break;
  }
  return out;
}

export function secretsFile(): string {
  return path.join(app.getPath('userData'), 'mobile-secrets.bin');
}

export function persistSecrets(value: MobileSecrets): void {
  // Smoke runs must be hermetic: probing the real macOS keychain from a
  // temporary Electron profile can block on Keychain UI and never exercises
  // the production encrypted-file path. Test secrets live only in memory.
  if (process.env.WANIGAN_SMOKE === '1') {
    memorySecrets = { ...value };
    secretsError = null;
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS credential encryption is unavailable.');
  }

  // Encrypt and durably replace the file before changing runtime state. If the
  // keychain or disk write fails, existing paired phones keep using the prior
  // in-memory secret and Settings receives the failure instead of a false
  // success followed by a mysteriously revoked token.
  const file = secretsFile();
  const next = `${file}.next-${process.pid}-${randomBytes(6).toString('hex')}`;
  const encrypted = safeStorage.encryptString(JSON.stringify(value));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fd: number | null = null;
  try {
    fd = fs.openSync(next, 'wx', 0o600);
    fs.writeFileSync(fd, encrypted);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    try { fs.chmodSync(next, 0o600); } catch { /* best effort on odd filesystems */ }
    fs.renameSync(next, file);
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* best effort */ }
    try { fs.rmSync(next, { force: true }); } catch { /* rename already consumed it */ }
  }
  memorySecrets = { ...value };
  secretsError = null;
}

export function mobileSecrets(): MobileSecrets {
  if (process.env.WANIGAN_SMOKE === '1') {
    memorySecrets ??= { token: generateToken(), topic: generateTopic() };
    secretsError = null;
    return memorySecrets;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    secretsError = 'OS credential encryption is unavailable, so phone monitoring is paused.';
    memorySecrets ??= { token: generateToken(), topic: generateTopic() };
    return memorySecrets;
  }
  if (memorySecrets && !secretsError) return memorySecrets;

  const file = secretsFile();
  if (fs.existsSync(file)) {
    try {
      const decoded = JSON.parse(safeStorage.decryptString(fs.readFileSync(file))) as Partial<MobileSecrets>;
      if (!tokenLooksStrong(decoded.token ?? '') || !topicLooksStrong(decoded.topic ?? '')) {
        throw new Error('The decrypted credential shape is invalid.');
      }
      // The two Web Push fields are read leniently and are absent entirely in a
      // file written before this feature existed. Neither may reach the throw
      // above: a missing VAPID keypair is a feature that has not been used yet,
      // not a corrupt credential store, and treating it as one would pause
      // phone monitoring for every operator on their first launch after update.
      memorySecrets = {
        token: decoded.token!,
        topic: decoded.topic!,
        ...(vapidKeysValid(decoded.vapid) ? { vapid: decoded.vapid } : {}),
        devices: sanitiseDevices(decoded.devices),
      };
      secretsError = null;
      return memorySecrets;
    } catch {
      // Never silently replace an unreadable credential while monitoring is
      // configured: doing so breaks every pairing and subscription while the
      // UI continues to claim the old setup is active.
      secretsError = 'Wanigan could not decrypt its phone-monitor credentials. Phone monitoring is paused.';
      memorySecrets ??= { token: generateToken(), topic: generateTopic() };
      return memorySecrets;
    }
  }

  // Migrate the short-lived development format that put these values in the
  // settings table. Empty the legacy rows after the encrypted blob is written,
  // so the pairing credential and ntfy subscription secret are not left in
  // plaintext beside otherwise harmless feature flags.
  const legacyToken = getSetting(LEGACY_TOKEN_KEY, '').trim();
  const legacyTopic = getSetting(LEGACY_TOPIC_KEY, '').trim();
  const next = {
    token: tokenLooksStrong(legacyToken) ? legacyToken : generateToken(),
    topic: topicLooksStrong(legacyTopic) ? legacyTopic : generateTopic(),
  };
  try {
    persistSecrets(next);
    setSetting(LEGACY_TOKEN_KEY, '');
    setSetting(LEGACY_TOPIC_KEY, '');
  } catch {
    secretsError = 'Wanigan could not persist encrypted phone-monitor credentials. Phone monitoring is paused.';
    memorySecrets ??= next;
  }
  return memorySecrets ?? next;
}

export function mobileCredentialsReady(): boolean {
  mobileSecrets();
  return process.env.WANIGAN_SMOKE === '1'
    || (safeStorage.isEncryptionAvailable() && secretsError === null);
}

export function ensureMobileToken(): string {
  return mobileSecrets().token;
}

export function pairingCode(token: string, slot = Math.floor(Date.now() / PAIR_CODE_MS)): string {
  return createHmac('sha256', token).update(`wanigan-mobile-pair:${slot}`).digest('hex').slice(0, 10).toUpperCase();
}

export function pairingCodeValid(value: string): boolean {
  const given = value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (!/^[A-F0-9]{10}$/.test(given)) return false;
  const token = ensureMobileToken();
  return [0, -1].some((offset) => {
    const expected = Buffer.from(pairingCode(token, Math.floor(Date.now() / PAIR_CODE_MS) + offset));
    const candidate = Buffer.from(given);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
}

export function ensurePushTopic(): string {
  return mobileSecrets().topic;
}

/* ── Web Push ────────────────────────────────────────────────────────── */

/**
 * This Mac's VAPID keypair, generated and written down the first time anything
 * needs it.
 *
 * Generated lazily rather than beside the token, because the public half is
 * baked into every subscription a device creates: a keypair regenerated on a
 * read that failed to persist would silently invalidate every phone already
 * subscribed. So it is written before it is returned, and a failure to write
 * is raised rather than swallowed — a caller that cannot store the key must not
 * hand out subscriptions against it.
 */
export function ensureVapidKeys(): VapidKeys {
  const secrets = mobileSecrets();
  if (secrets.vapid && vapidKeysValid(secrets.vapid)) return secrets.vapid;
  const vapid = generateVapidKeys();
  persistSecrets({ ...secrets, vapid });
  return vapid;
}

/** Every subscription currently stored. A copy: callers must not mutate it. */
export function pushDevices(): MobilePushDevice[] {
  return (mobileSecrets().devices ?? []).map((device) => ({ ...device }));
}

/** Replace the device list wholesale, capped and de-duplicated by endpoint. */
export function savePushDevices(next: readonly MobilePushDevice[]): MobilePushDevice[] {
  const secrets = mobileSecrets();
  const devices = sanitiseDevices(next.slice(-MAX_PUSH_DEVICES));
  persistSecrets({ ...secrets, devices });
  return devices.map((device) => ({ ...device }));
}

/**
 * A new keypair, and therefore no subscriptions.
 *
 * The two go together and cannot be separated: a subscription is bound to the
 * application server key it was created with, so every stored device stops
 * being deliverable the instant the key changes. Clearing them here is what
 * keeps Settings from listing devices that will never receive another alert.
 */
export function rotateVapidKeys(): VapidKeys {
  const secrets = mobileSecrets();
  const vapid = generateVapidKeys();
  persistSecrets({ ...secrets, vapid, devices: [] });
  return vapid;
}
