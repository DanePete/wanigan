import type { ProviderPackManifest } from '../../provider-packs';
import { OPENROUTER_PROFILE_ID, OPENROUTER_RESPONSES_BASE_URL } from '../../../shared/openrouter-connection';

/**
 * Real Codex positional prompt + documented custom Responses provider. Keep the
 * generic harness until backend/tool conformance and actual billing are observed.
 * https://openrouter.ai/docs/cookbook/coding-agents/codex-cli
 * https://learn.chatgpt.com/docs/config-file/config-reference
 */
export const OPENROUTER_PROVIDER_PACK: ProviderPackManifest = {
  schemaVersion: 1,
  id: 'wanigan.openrouter', label: 'OpenRouter', version: '1',
  description: 'Experimental manual Codex connection to OpenRouter. Backend compatibility and billed cost are unverified.',
  publisher: { id: 'wanigan', name: 'Wanigan' },
  profiles: [{
    id: OPENROUTER_PROFILE_ID, label: 'OpenRouter · experimental manual connection',
    harness: 'generic-cli', headless: 'none',
    backend: { id: 'openrouter-unverified', label: 'OpenRouter (unverified upstream)', baseUrl: OPENROUTER_RESPONSES_BASE_URL },
    command: {
      bin: 'codex', versionArgs: ['--version'], helpArgs: ['--help'],
      baseArgs: [
        '--config', 'model_provider="wanigan_openrouter"',
        '--config', 'model_providers.wanigan_openrouter.name="OpenRouter"',
        '--config', `model_providers.wanigan_openrouter.base_url="${OPENROUTER_RESPONSES_BASE_URL}"`,
        '--config', 'model_providers.wanigan_openrouter.env_key="OPENROUTER_API_KEY"',
        '--config', 'model_providers.wanigan_openrouter.wire_api="responses"',
        '--config', 'model_providers.wanigan_openrouter.supports_websockets=false',
        '--config', 'model_providers.wanigan_openrouter.request_max_retries=0',
        '--config', 'model_providers.wanigan_openrouter.stream_max_retries=0',
        '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request',
      ],
      editorExtensions: [{ prefix: 'openai.chatgpt-', executablePaths: [
        'bin/{arch}/codex', 'bin/macos-aarch64/codex', 'bin/macos-x86_64/codex',
        'bin/linux-x86_64/codex', 'bin/linux-aarch64/codex',
      ] }],
    },
    launchFields: [{ id: 'model', label: 'OpenRouter model ID', kind: 'text', required: true,
      placeholder: 'provider/model-id', argv: ['--model', '{value}'],
      description: 'Enter the exact model ID. Catalogue entries are price declarations, not verified Codex compatibility. Avoid automatic routing aliases.' }],
    initialPromptArgv: ['--', '{prompt}'],
    environment: { OPENROUTER_API_KEY: { source: 'credential', id: OPENROUTER_PROFILE_ID } },
    capabilities: {
      hooks: 'unsupported', telemetry: 'unsupported', mcp: 'unsupported', policy: 'unsupported',
      transcript: 'unsupported', 'resume.named': 'unsupported', 'headless.json': 'unsupported',
      'learning.semantic': 'unsupported', skills: 'unknown', 'instructions.project': 'unknown', 'memory.native': 'unknown',
    },
  }],
};
