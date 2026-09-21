import type { WaniganModule } from '../module-registry';
import { clearProviderKey, encryptionAvailable, getProviderKey, hasProviderKey, providerKeyFingerprint, setProviderKey } from '../keys';
import { providerPackRegistry } from '../providers';
import { OPENROUTER_PROFILE_ID, OPENROUTER_RESPONSES_BASE_URL, readOpenRouterKey, type OpenRouterConnectionStatus } from '../../shared/openrouter-connection';

/** No socket or executable probe: stored credentials are not proof of support. */
export function status(): OpenRouterConnectionStatus {
  const hasKey = getProviderKey(OPENROUTER_PROFILE_ID) !== null;
  const stored = hasProviderKey(OPENROUTER_PROFILE_ID);
  return {
    profileId: OPENROUTER_PROFILE_ID, hasKey, stored,
    fromEnv: Boolean(process.env.WANIGAN_OPENROUTER_KEY),
    unreadable: stored && !hasKey, encryptionAvailable: encryptionAvailable(),
    fingerprint: providerKeyFingerprint(OPENROUTER_PROFILE_ID),
    profileEnabled: providerPackRegistry.profileById(OPENROUTER_PROFILE_ID)?.enabled === true,
    endpoint: `${OPENROUTER_RESPONSES_BASE_URL}/responses`, verification: 'not-tested', metering: 'unpriced',
    detail: 'Manual connection using the installed Codex CLI. Saving a key makes no API request. '
      + 'Model/tool compatibility, upstream provider, token usage and billed cost have not been verified; '
      + 'automatic progress and semantic memory are unavailable. Codex may report unknown model metadata. '
      + 'Its own user and project configuration still applies.',
  };
}

export async function setKey(raw: unknown): Promise<OpenRouterConnectionStatus> {
  await setProviderKey(OPENROUTER_PROFILE_ID, readOpenRouterKey(raw));
  return status();
}

export function clearKey(): OpenRouterConnectionStatus {
  clearProviderKey(OPENROUTER_PROFILE_ID);
  return status();
}

export const openRouterConnectionModule: WaniganModule = {
  id: 'openrouter-connection', label: 'OpenRouter manual connection', required: null,
  ipc(handle) {
    handle('openrouter-connection:status', () => status());
    handle('openrouter-connection:setKey', (raw: unknown) => setKey(raw));
    handle('openrouter-connection:clearKey', () => clearKey());
  },
  egress: () => [{
    host: 'openrouter.ai', paths: ['/api/v1/responses'], by: 'agent',
    purpose: 'Manual Codex requests routed by OpenRouter to an upstream model provider.',
    when: 'An operator launches the experimental OpenRouter profile with a model and credential.',
    activeNow: null, overrideEnv: null,
  }],
};
