import { safeStorage, app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The Claude Platform API key, encrypted at rest by the OS keychain.
 *
 * safeStorage delegates to Keychain on macOS, DPAPI on Windows, and libsecret
 * on Linux — the ciphertext on disk is useless without the logged-in user's
 * session. A plaintext .env file is readable by anything that can read the
 * user's home directory, which includes every npm postinstall script.
 */
function keyFile(): string {
  return path.join(app.getPath('userData'), 'apikey.bin');
}

export function hasKey(): boolean {
  return fs.existsSync(keyFile());
}

export function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

export function getKey(): string | null {
  // An explicit env var still wins, for CI and scripted runs.
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  if (!hasKey()) return null;
  try {
    return safeStorage.decryptString(fs.readFileSync(keyFile()));
  } catch {
    return null;
  }
}

export function setKey(key: string) {
  const trimmed = key.trim();
  if (!trimmed.startsWith('sk-ant-')) {
    throw new Error(
      'That does not look like a Claude Platform key — they start with "sk-ant-". ' +
      'A Claude Code OAuth token will not work here; the Batches API bills against a Platform account.'
    );
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS encryption is unavailable, so the key cannot be stored safely. Set ANTHROPIC_API_KEY instead.');
  }
  fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
  fs.writeFileSync(keyFile(), safeStorage.encryptString(trimmed), { mode: 0o600 });
}

export function clearKey() {
  try { fs.unlinkSync(keyFile()); } catch { /* already gone */ }
}

/** Never return the key itself to the renderer — only enough to recognise it. */
export function keyFingerprint(): string | null {
  const k = getKey();
  if (!k) return null;
  return `${k.slice(0, 14)}…${k.slice(-4)}`;
}

/** Verifies against the live API before we let the user believe it works. */
export async function verifyKey(key?: string): Promise<{ ok: boolean; detail: string; batches: boolean }> {
  const k = key ?? getKey();
  if (!k) return { ok: false, detail: 'No key set.', batches: false };
  const H = { 'x-api-key': k, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  try {
    const r = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: H });
    if (r.status === 401) return { ok: false, detail: 'Key rejected (401). Check it was copied whole.', batches: false };
    if (r.status === 403) return { ok: false, detail: 'Key is valid but lacks permission (403).', batches: false };
    if (!r.ok) return { ok: false, detail: `HTTP ${r.status} from /v1/models`, batches: false };
    const models = (await r.json()) as { data?: { id: string }[] };

    const b = await fetch('https://api.anthropic.com/v1/messages/batches?limit=1', { headers: H });
    return {
      ok: true,
      detail: `Authenticated. Newest model: ${models.data?.[0]?.id ?? 'unknown'}`,
      batches: b.ok,
    };
  } catch (e) {
    return { ok: false, detail: `Network error: ${e instanceof Error ? e.message : String(e)}`, batches: false };
  }
}
