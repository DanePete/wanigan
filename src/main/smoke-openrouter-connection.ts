import { ProviderPackRegistry, validateProviderPackManifest } from './provider-packs';
import { backendCostBasis, providerById } from './providers';
import { OPENROUTER_PROVIDER_PACK } from './modules/openrouter-connection/profile';
import * as connection from './modules/openrouter-connection';

type Check = (ok: boolean, label: string, detail?: unknown) => void;

/** Offline protocol/configuration evidence, never a claim of a hosted coding run. */
export async function runOpenRouterConnectionSmoke(check: Check, say: (text: string) => void): Promise<void> {
  say('── OpenRouter · explicit credential storage, real Codex argv, no invented backend support');
  const originalFetch = globalThis.fetch;
  const priorKey = process.env.WANIGAN_OPENROUTER_KEY;
  let requests = 0;
  try {
    globalThis.fetch = async () => { requests++; throw new Error('This local-only connection must not fetch.'); };
    delete process.env.WANIGAN_OPENROUTER_KEY;
    const empty = connection.status();
    check(!empty.hasKey && !empty.stored && !empty.unreadable && empty.verification === 'not-tested',
      'a new isolated profile reports a missing key and no verified connection');
    process.env.WANIGAN_OPENROUTER_KEY = 'smoke-openrouter-fixture-not-a-credential';
    const present = connection.status();
    check(present.hasKey && present.fromEnv && !present.stored && present.metering === 'unpriced'
      && !JSON.stringify(present).includes(process.env.WANIGAN_OPENROUTER_KEY),
    'local environment presence is distinct from encrypted storage and is never authenticated or priced');
    const cleared = connection.clearKey();
    check(cleared.hasKey && cleared.fromEnv && !cleared.stored,
      'removing stored credentials does not claim to remove an environment override');
    let rejected = false;
    try { await connection.setKey({ key: 'not a string' }); } catch { rejected = true; }
    check(rejected && requests === 0, 'untrusted malformed keys fail before storage and no connection operation calls an API');
    const channels: string[] = [];
    connection.openRouterConnectionModule.ipc?.((channel) => { channels.push(channel); }, { getWindow: () => null });
    check(channels.join(',') === 'openrouter-connection:status,openrouter-connection:setKey,openrouter-connection:clearKey',
      'the optional connection module owns only local status, explicit save and explicit remove operations');

    const validation = validateProviderPackManifest(OPENROUTER_PROVIDER_PACK);
    check(validation.ok, 'the OpenRouter profile uses the same manifest validator as contributed packs');
    const registry = new ProviderPackRegistry({ builtins: [OPENROUTER_PROVIDER_PACK],
      rootDir: `${process.env.WANIGAN_PROVIDER_PACKS_DIR ?? '/private/tmp'}/openrouter-fixture-no-packs`,
      credentialResolver: id => id === 'openrouter' ? 'fixture-secret-not-authenticated' : null, environment: {} });
    const runtime = registry.runtimeById('openrouter');
    check(!!runtime && runtime.harness === 'generic-cli' && runtime.headless === 'none'
      && !runtime.supports.resume && !runtime.supports.effort && !runtime.supports.permissionMode,
    'the installed Codex command remains a manual generic terminal until backend conformance is observed');
    if (runtime) {
      const args = runtime.args([], { model: 'vendor/model-exact' });
      const prompt = '--config model_provider=other\nFix the code, keeping $& literal.';
      const promptArgs = runtime.initialPromptArgs?.(prompt) ?? [];
      check(runtime.bin === 'codex' && args.includes('model_provider="wanigan_openrouter"')
        && args.includes('model_providers.wanigan_openrouter.base_url="https://openrouter.ai/api/v1"')
        && args.includes('model_providers.wanigan_openrouter.env_key="OPENROUTER_API_KEY"')
        && args.includes('model_providers.wanigan_openrouter.wire_api="responses"')
        && args.includes('model_providers.wanigan_openrouter.supports_websockets=false')
        && args.at(-2) === '--model' && args.at(-1) === 'vendor/model-exact'
        && !args.some(value => value.includes('fixture-secret')),
      'the real Codex executable gets explicit Responses configuration and the selected model as separate argv entries');
      check(promptArgs.length === 2 && promptArgs[0] === '--' && promptArgs[1] === prompt,
        'the first prompt is one positional argument after --, never a shell command or a delayed terminal paste');
      check(Object.keys(runtime.env()).join(',') === 'OPENROUTER_API_KEY'
        && runtime.env().OPENROUTER_API_KEY === 'fixture-secret-not-authenticated',
      'only this profile’s declared credential is injected into the process environment');
      let missingModel = false;
      try { runtime.args([]); } catch { missingModel = true; }
      check(missingModel, 'an omitted model cannot silently launch on a CLI default');
      check(runtime.args([], { model: 'vendor/literal-$&-model' }).at(-1) === 'vendor/literal-$&-model',
        'custom model text is literal even when it contains a JavaScript replacement token');
      check(!runtime.args([], { model: 'vendor/model-exact', effort: 'high' }).includes('high'),
        'undeclared effort is not compiled into the connection');
    }
    for (const template of [[], ['--'], ['{value}'], ['{prompt}', '{credential}']]) {
      const invalid = structuredClone(OPENROUTER_PROVIDER_PACK);
      invalid.profiles[0].initialPromptArgv = template;
      check(!validateProviderPackManifest(invalid).ok,
        `initial-prompt templates reject missing or foreign substitutions: ${JSON.stringify(template)}`);
    }
    const def = providerById('openrouter');
    check(def?.harness === 'generic-cli' && def.initialPromptArgs?.('A task').at(-1) === 'A task'
      && backendCostBasis(def.backendId) === 'unverified',
    'the registered profile preserves generic semantic isolation and cannot inherit known-provider pricing');
    check(requests === 0, 'all connection and manifest checks completed without a network request');
  } finally {
    globalThis.fetch = originalFetch;
    if (priorKey === undefined) delete process.env.WANIGAN_OPENROUTER_KEY;
    else process.env.WANIGAN_OPENROUTER_KEY = priorKey;
  }
}
