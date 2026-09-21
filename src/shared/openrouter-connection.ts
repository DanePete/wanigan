export const OPENROUTER_PROFILE_ID = 'openrouter' as const;
export const OPENROUTER_RESPONSES_BASE_URL = 'https://openrouter.ai/api/v1';

/** Local connection facts. A saved key is not an authenticated coding run. */
export type OpenRouterConnectionStatus = {
  profileId: typeof OPENROUTER_PROFILE_ID;
  hasKey: boolean; stored: boolean; fromEnv: boolean; unreadable: boolean;
  encryptionAvailable: boolean; fingerprint: string | null; profileEnabled: boolean;
  endpoint: string; verification: 'not-tested'; metering: 'unpriced'; detail: string;
};

/** Shape validation only; do not log the value or call a paid endpoint to save it. */
export function readOpenRouterKey(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4_096) {
    throw new Error('Enter an OpenRouter API key of at most 4,096 characters.');
  }
  const key = value.trim();
  if (key.length < 16 || /[\s\p{C}]/u.test(key)) {
    throw new Error('Enter an OpenRouter API key without spaces or control characters.');
  }
  return key;
}
