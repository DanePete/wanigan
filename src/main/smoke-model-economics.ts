import { db } from './db';
import { getSetting, setSetting } from './settings';
import { declaredBackendCatalogue } from './launch-choices';
import { forgetBackendCatalog } from './backend-catalog';
import { providerPackRegistry } from './providers';
import * as economics from './modules/model-economics';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
const MODEL = {
  id: 'fixture/economics', name: 'Economics fixture', context_length: 16_000,
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  supported_parameters: ['tools', 'reasoning_effort'], reasoning: { supported_efforts: ['low'] },
  pricing: { prompt: '0.000001', completion: '0.000002' },
};
const ENDPOINT = { tag: 'fixture-host/fp8', provider_name: 'Fixture host', quantization: 'fp8', status: 0,
  context_length: 16_000, max_completion_tokens: 4_000, supported_parameters: ['tools', 'reasoning_effort'],
  supports_tool_choice: { auto: true }, pricing: { prompt: '0.000001', completion: '0.000002' } };

/** Actual module transport/storage with public metadata fixtures; never inference. */
export async function runModelEconomicsSmoke(check: Check, say: (text: string) => void): Promise<void> {
  say('── economics · bounded public discovery, durable provenance, unknown prices and private catalogue identity');
  const d = db();
  economics.modelEconomicsModule.migrate?.(d);
  const originalFetch = globalThis.fetch;
  const originalProfiles = providerPackRegistry.listProfiles;
  const beforeSettings = [getSetting('model-economics.automatic-refresh', '0'), getSetting('model-economics.selected-models', '[]')];
  const beforeState = d.prepare('SELECT * FROM model_economics_state WHERE id=1').get() as Record<string, unknown>;
  const beforeIds = new Set((d.prepare('SELECT id FROM model_economics_snapshots').all() as { id: string }[]).map(row => row.id));
  const calls: { url: string; init?: RequestInit }[] = [];
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input); calls.push({ url, init });
      return new Response(JSON.stringify(url.endsWith('/endpoints')
        ? { data: { id: MODEL.id, endpoints: [ENDPOINT] } } : { data: [MODEL] }), { headers: { 'Content-Type': 'application/json' } });
    };
    economics.setSettings({ automaticRefresh: false });
    economics.status();
    check(calls.length === 0, 'reading economics status does not fetch or use a credential');
    const refreshed = await economics.refresh({ modelIds: [MODEL.id] });
    check(calls.length === 2 && calls.every(call => call.init?.method === 'GET'
      && call.init.redirect === 'error' && call.init.credentials === 'omit'
      && !new Headers(call.init.headers).has('authorization')), 'catalogue refresh only makes bounded credential-free metadata GETs');
    check(refreshed.catalogue?.rows.length === 1 && refreshed.endpoints.length === 1 && refreshed.endpointCoverage.fresh === 1,
      'model and endpoint snapshots are durable and independently dated');
    check(!!refreshed.catalogue?.contentHash && !!refreshed.endpoints[0].contentHash && !refreshed.stale,
      'every cached result carries response hash, timestamp and source URL');
    const quote = economics.quote({ workload: { inputTokens: 1_000, outputTokens: 500, cachedInputTokens: 0, cacheWriteTokens: 0, requests: 1 },
      requirements: { tools: true, effort: 'low', toolChoice: 'auto' } });
    check(quote[0]?.eligible && quote[0].estimateUsdDecimal === '0.002' && calls.length === 2,
      'a local explicit-workload quote consumes no network and is labelled separately from spend');
    const job = economics.modelEconomicsModule.maintenance?.()[0];
    await job?.run();
    check(calls.length === 2, 'disabled automatic refresh performs no network work');
    economics.setSettings({ automaticRefresh: true });
    await job?.run();
    check(calls.length === 2, 'fresh metadata does not refresh merely because the maintenance timer ran');
    d.prepare('UPDATE model_economics_state SET next_refresh_at=0 WHERE id=1').run();
    await job?.run();
    check(calls.length === 4 && (economics.status().nextRefreshAt ?? 0) > Date.now(),
      'enabled due refresh runs once and records the next daily refresh');
    const savedId = economics.status().catalogue?.id;
    globalThis.fetch = async () => new Response('{"error":"fixture"}', { status: 503 });
    const failed = await economics.refresh();
    check(failed.catalogue?.id === savedId && !!failed.lastError && !failed.refreshing,
      'failed refresh preserves the prior snapshot without relabelling its freshness');
    d.prepare('UPDATE model_economics_state SET lease_token=?,lease_until=? WHERE id=1').run('other-process', Date.now() + 60_000);
    globalThis.fetch = async () => { throw new Error('a competing refresh must not open a socket'); };
    check((await economics.refresh()).refreshing, 'a durable lease suppresses a competing app/daemon refresh');
    d.prepare('UPDATE model_economics_state SET lease_token=NULL,lease_until=NULL WHERE id=1').run();
    globalThis.fetch = async () => new Response('x', { headers: { 'Content-Length': '999999999' } });
    check((await economics.refresh()).lastError?.includes('size limit') === true, 'oversized catalogue response is refused before parsing');
    let invalid = false;
    try { await economics.refresh({ modelIds: ['https://evil.test'] }); } catch { invalid = true; }
    check(invalid, 'renderer cannot turn catalogue refresh into an arbitrary URL request');

    const template = originalProfiles.call(providerPackRegistry).find(profile => profile.backend.catalog);
    if (!template) throw new Error('The built-in catalogue fixture is missing.');
    const local = { ...template, source: 'local' as const, packId: 'smoke.economics',
      backend: { ...template.backend, catalog: { ...template.backend.catalog!, auth: { source: 'none' as const } } } };
    providerPackRegistry.listProfiles = () => [local];
    const qualified = `${local.packId}:${local.backend.id}`;
    forgetBackendCatalog(qualified);
    check(declaredBackendCatalogue(local.backend.id) === undefined,
      'a local catalogue cannot claim a built-in backend by spelling its unqualified id');
    const reader = declaredBackendCatalogue(qualified);
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'fixture-actual-model' }] }));
    const discovered = await reader?.();
    check(discovered?.source === 'live' && discovered.rows.some(row => row.value === 'fixture-actual-model'),
      'a local catalogue resolves through its qualified backend identity and the shared reader');
    forgetBackendCatalog(qualified);
  } finally {
    globalThis.fetch = originalFetch;
    providerPackRegistry.listProfiles = originalProfiles;
    setSetting('model-economics.automatic-refresh', beforeSettings[0]);
    setSetting('model-economics.selected-models', beforeSettings[1]);
    d.prepare('UPDATE model_economics_state SET last_attempt_at=?,last_error=?,next_refresh_at=?,lease_token=?,lease_until=? WHERE id=1')
      .run(beforeState.last_attempt_at, beforeState.last_error, beforeState.next_refresh_at, beforeState.lease_token, beforeState.lease_until);
    for (const row of d.prepare('SELECT id FROM model_economics_snapshots').all() as { id: string }[]) {
      if (!beforeIds.has(row.id)) d.prepare('DELETE FROM model_economics_snapshots WHERE id=?').run(row.id);
    }
  }
}
