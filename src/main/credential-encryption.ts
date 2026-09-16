import { safeStorage } from 'electron';

/**
 * Electron's async Linux encryptor can report available while its selected
 * provider is the POSIX fallback, whose v10 key is public. Test the actual
 * encryptor, not getSelectedStorageBackend(), which describes the sync API.
 * macOS also uses v10, but derives its key from Keychain: this refusal is
 * deliberately Linux-only.
 */
export async function credentialEncryptionAvailable(): Promise<boolean> {
  if (!await safeStorage.isAsyncEncryptionAvailable()) return false;
  if (process.platform !== 'linux') return true;
  try {
    await encryptCredential('Wanigan credential encryption availability');
    return true;
  } catch {
    return false;
  }
}

/** Never persist a credential encrypted with Linux's public fallback key. */
export async function encryptCredential(plaintext: string): Promise<Buffer> {
  const encrypted = await safeStorage.encryptStringAsync(plaintext);
  if (process.platform === 'linux' && encrypted.subarray(0, 3).toString('ascii') === 'v10') {
    throw new Error('A secure OS credential store is unavailable. Wanigan will not save credentials with the Linux fallback key.');
  }
  return encrypted;
}
