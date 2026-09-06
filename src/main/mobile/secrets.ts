import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import { getSetting, setSetting } from '../settings';

/**
 * The phone monitor's two credentials: the bearer token a paired device sends
 * and the secret ntfy topic push notifications are published to. They live in
 * one OS-encrypted file rather than the settings table, and this module is the
 * only place that reads or replaces them.
 */

const TOKEN_BYTES = 32;
const TOPIC_BYTES = 24;
const PAIR_CODE_MS = 10 * 60_000;

// The short-lived development format kept both credentials in the settings
// table. These two row names are named here rather than imported from ./config
// so the credential store stays below configuration: see the note there.
const LEGACY_TOKEN_KEY = 'mobile_token';
const LEGACY_TOPIC_KEY = 'mobile_push_topic';

export type MobileSecrets = { token: string; topic: string };
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
      memorySecrets = { token: decoded.token!, topic: decoded.topic! };
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
