import Database from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { completePromptImprovement, createPromptImproveService, promptImproveEgress, promptImproveModule, type PromptImproveCompletion } from './modules/prompt-improve';
import { migratePromptImproveUsage, promptImproveConsumption, promptImproveDaily } from './prompt-improve-usage';
import { moduleNeedsStartedServices, modules, registerModule } from './module-registry';
import { haltStopperNames } from './halt';
import type { PromptImproveRequest } from '../shared/prompt-improve';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Row = { status: string; model: string | null; input_tokens: number | null; output_tokens: number | null; estimated_cost_usd: number | null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function failure(action: Promise<unknown>): Promise<string> {
  try { await action; return ''; } catch (error) { return error instanceof Error ? error.message : String(error); }
}

/** Real SQLite and the shipped service/SDK builder; the transport never leaves this process. */
export async function runPromptImproveSmoke(check: Check, say: (text: string) => void): Promise<void> {
  say('── improve prompt · explicit calls, private drafts and cancellable suggestions');
  const d = new Database(':memory:');
  migratePromptImproveUsage(d);
  const request = (): PromptImproveRequest => ({ requestId: randomUUID(), draft: 'Fix login; preserve the current API.',
    purpose: 'session follow-up', maxLength: 1000, model: 'claude-haiku-4-5-20251001' });
  const reply = (): PromptImproveCompletion => ({ text: JSON.stringify({ prompt: 'Fix the login failure while preserving the current API.', questions: ['Which login failure should change?'] }),
    model: request().model, input: 100, output: 50, stopReason: 'end_turn' });
  const row = (id: string) => d.prepare('SELECT * FROM prompt_improve_usage WHERE request_id=?').get(id) as Row;
  const count = () => (d.prepare('SELECT COUNT(*) AS n FROM prompt_improve_usage').get() as { n: number }).n;
  let enabled = true;
  let available = true;
  let halted = false;
  let calls = 0;
  let pendingBeforeNetwork = true;
  let transport: (input: PromptImproveRequest, signal: AbortSignal) => Promise<PromptImproveCompletion> = async () => reply();
  const deps = {
    database: () => d, available: () => available, enabled: () => enabled, setEnabled: (value: boolean) => { enabled = value; },
    checkHalt: () => { if (halted) throw new Error('Halted before spending.'); },
    complete: (input: PromptImproveRequest, signal: AbortSignal) => {
      calls++;
      pendingBeforeNetwork &&= row(input.requestId)?.status === 'pending';
      return transport(input, signal);
    },
  };
  const service = createPromptImproveService(deps);
  try {
    if (!modules().some(module => module.id === promptImproveModule.id)) registerModule(promptImproveModule);
    const channels: string[] = [];
    promptImproveModule.ipc?.(channel => { channels.push(channel); });
    check(moduleNeedsStartedServices('prompt-improve:improve') && !moduleNeedsStartedServices('prompt-improve:status')
      && !moduleNeedsStartedServices('prompt-improve:cancel') && promptImproveModule.required === null
      && typeof promptImproveModule.egress === 'function' && haltStopperNames().includes('prompt-improve')
      && ['status', 'setEnabled', 'improve', 'cancel'].every(name => channels.includes(`prompt-improve:${name}`)),
    'the optional module owns its channels, generation startup guard, egress disclosure and global halt cancellation');
    available = false;
    check(!service.status().available && /API key/.test(service.status().reason ?? '')
      && !!(await failure(service.improve(request()))) && calls === 0 && count() === 0,
    'missing readable credentials refuse improvement before spending or writing a request');
    available = true;
    service.setEnabled(false);
    check(!service.status().enabled && !!(await failure(service.improve(request()))) && calls === 0 && count() === 0,
      'the optional module can be disabled without making a provider call');
    service.setEnabled(true);
    halted = true;
    check(/Halted/.test(await failure(service.improve(request()))) && calls === 0 && count() === 0,
      'the global halt is checked before a pending request can spend');
    halted = false;
    for (const patch of [{ draft: '' }, { requestId: 'not-an-id' }, { model: 'unoffered-model' }, { maxLength: 100_000 }]) {
      check(!!(await failure(service.improve({ ...request(), ...patch }))) && calls === 0 && count() === 0,
        'invalid renderer input cannot start a paid request', patch);
    }

    const first = request();
    const result = await service.improve(first);
    check(result.requestId === first.requestId && result.prompt.includes('preserving the current API')
      && result.questions.length === 1 && result.inputTokens === 100 && result.outputTokens === 50
      && result.estimatedCostUsd !== null && pendingBeforeNetwork && row(first.requestId).status === 'answered',
    'a suggestion returns its identity and questions only after a pending row and recorded meters');
    check(!JSON.stringify(d.prepare('SELECT * FROM prompt_improve_usage').all()).includes(first.draft)
      && !JSON.stringify(d.prepare('SELECT * FROM prompt_improve_usage').all()).includes(result.prompt),
    'the durable usage record contains neither the original draft nor the improved prompt');
    const beforeReuse = calls;
    check(!!(await failure(service.improve(first))) && calls === beforeReuse,
      'reusing an old request identity is refused instead of billing twice under one row');

    for (const broken of [
      { text: 'not JSON containing PRIVATE_DRAFT' }, { stopReason: 'max_tokens' }, { stopReason: 'refusal' },
      { text: JSON.stringify({ prompt: 'x'.repeat(1001), questions: [] }) },
    ]) {
      transport = async () => ({ ...reply(), ...broken });
      const input = request();
      const detail = await failure(service.improve(input));
      const recorded = row(input.requestId);
      check(!!detail && !detail.includes('PRIVATE_DRAFT') && recorded.status === 'failed'
        && recorded.input_tokens === 100 && recorded.output_tokens === 50 && recorded.estimated_cost_usd !== null,
      'unreadable, overlong, truncated and refused answers preserve returned usage without exposing their text', broken.stopReason ?? 'invalid answer');
    }
    transport = async () => { throw new Error('Provider echoed PRIVATE_DRAFT and sk-secret'); };
    const failed = request();
    const detail = await failure(service.improve(failed));
    check(!!detail && !/PRIVATE_DRAFT|sk-secret/.test(detail) && row(failed.requestId).status === 'failed'
      && row(failed.requestId).input_tokens === null && row(failed.requestId).estimated_cost_usd === null,
    'transport failures use local error copy and preserve unknown usage instead of reporting a free call');

    transport = async () => ({ ...reply(), model: 'future-unpriced-model' });
    const unknown = await service.improve(request());
    check(unknown.model === 'future-unpriced-model' && unknown.inputTokens === 100 && unknown.estimatedCostUsd === null,
      'a returned model with no known rate preserves its meters and remains unpriced');
    transport = async () => ({ ...reply(), input: -1 });
    const unmetered = await service.improve(request());
    check(unmetered.inputTokens === null && unmetered.outputTokens === 50 && unmetered.estimatedCostUsd === null,
      'invalid token counts stay unknown and cannot acquire default-model pricing');

    const oldResponse = deferred<PromptImproveCompletion>();
    transport = async () => oldResponse.promise;
    const old = request();
    const oldAnswer = failure(service.improve(old));
    await Promise.resolve();
    const beforeConcurrent = calls;
    check(!service.cancel(randomUUID()) && /Another prompt/.test(await failure(service.improve(request())))
      && calls === beforeConcurrent, 'only the active request identity can cancel and a second composer cannot double-spend');
    check(service.cancel(old.requestId) && /stopped/.test(await oldAnswer)
      && row(old.requestId).status === 'cancelled' && row(old.requestId).input_tokens === null,
    'cancellation releases the composer before an uncooperative transport replies');
    const freshResponse = deferred<PromptImproveCompletion>();
    transport = async () => freshResponse.promise;
    const fresh = request();
    const freshAnswer = service.improve(fresh);
    await Promise.resolve();
    oldResponse.resolve({ ...reply(), input: 321 });
    await new Promise<void>(resolve => setImmediate(resolve));
    check(row(old.requestId).status === 'cancelled' && row(old.requestId).input_tokens === 321
      && !service.cancel(old.requestId) && /Another prompt/.test(await failure(service.improve(request()))),
    'late cancellation usage belongs to the old row and cannot clear or cancel the newer active request');
    freshResponse.resolve(reply());
    check((await freshAnswer).requestId === fresh.requestId && row(fresh.requestId).status === 'answered',
      'a new request can complete after the cancelled request delivers its late meter');

    const disabledResponse = deferred<PromptImproveCompletion>();
    transport = async () => disabledResponse.promise;
    const disabledRequest = request();
    const disabling = failure(service.improve(disabledRequest));
    await Promise.resolve();
    service.setEnabled(false);
    check(/stopped/.test(await disabling) && row(disabledRequest.requestId).status === 'cancelled'
      && !service.status().enabled && service.cancelAll() === 0,
    'switching the optional module off cancels its active request and leaves drafts untouched');
    disabledResponse.resolve(reply());
    await new Promise<void>(resolve => setImmediate(resolve));
    service.setEnabled(true);

    const timedResponse = deferred<PromptImproveCompletion>();
    transport = async () => timedResponse.promise;
    const timed = createPromptImproveService({ ...deps, timeoutMs: 1 });
    const timedRequest = request();
    check(/timed out/.test(await failure(timed.improve(timedRequest))) && row(timedRequest.requestId).status === 'cancelled',
      'a bounded timeout releases a hung improvement without an automatic retry');
    timedResponse.resolve(reply());
    await new Promise<void>(resolve => setImmediate(resolve));

    const consumption = promptImproveConsumption(0, d);
    check(consumption.every(entry => entry.costStatus === 'unreported' && entry.costUsd === 0 && entry.source === 'service')
      && consumption.some(entry => (entry.estimatedCostUsd ?? 0) > 0 && (entry.unmeteredRequests ?? 0) > 0)
      && consumption.find(entry => entry.model === 'future-unpriced-model')?.estimatedCostUsd === undefined
      && promptImproveDaily(0, d).every(entry => entry.costUsd === 0 && entry.tokens > 0),
    'Usage exposes recorded tokens and frozen estimates separately from provider-reported bills');

    const missingSchema = new Database(':memory:');
    try {
      const before = calls;
      const unavailableLedger = createPromptImproveService({ ...deps, database: () => missingSchema });
      check(!!(await failure(unavailableLedger.improve(request()))) && calls === before,
        'a ledger that cannot create its pending row prevents the provider request');
    } finally { missingSchema.close(); }

    let sent: Record<string, unknown> = {};
    let options: Record<string, unknown> = {};
    const api = { messages: { create: async (body: Record<string, unknown>, settings: Record<string, unknown>) => {
      sent = body; options = settings;
      return { model: request().model, content: [{ type: 'text', text: reply().text }],
        usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'end_turn' };
    } } } as unknown as NonNullable<Parameters<typeof completePromptImprovement>[2]>;
    const sdkInput = request();
    const signal = new AbortController().signal;
    const completion = await completePromptImprovement(sdkInput, signal, api);
    const messages = sent.messages as { role: string; content: string }[];
    const payload = JSON.parse(messages[0].content) as Record<string, unknown>;
    check(!('tools' in sent) && !('tool_choice' in sent) && messages.length === 1 && messages[0].role === 'user'
      && Object.keys(payload).sort().join(',') === 'draft,maxLength,purpose' && payload.draft === sdkInput.draft
      && sent.max_tokens === 4096 && !!sent.output_config && options.maxRetries === 0
      && options.timeout === 60_000 && options.signal === signal && completion.input === 100,
    'the actual SDK request contains only the explicit draft, no tools or history, strict output, a timeout and no retries');

    let wireCalls = 0;
    let failingWire = false;
    let actualPayload: Record<string, unknown> = {};
    const offlineApi = new Anthropic({ apiKey: 'offline-prompt-fixture', fetch: async (_url: unknown, init?: RequestInit) => {
      wireCalls++;
      actualPayload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(JSON.stringify(failingWire ? { error: { type: 'api_error', message: 'offline failure' } }
        : { id: 'prompt-fixture', type: 'message', role: 'assistant', model: request().model,
          content: [{ type: 'text', text: reply().text }], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'end_turn' }),
      { status: failingWire ? 500 : 200, headers: { 'content-type': 'application/json' } });
    } });
    const throughSdk = await completePromptImprovement(request(), signal, offlineApi);
    const schema = actualPayload.output_config as { format?: { type?: string; schema?: { additionalProperties?: boolean; required?: string[] } } };
    check(throughSdk.input === 100 && wireCalls === 1 && !('tools' in actualPayload)
      && schema.format?.type === 'json_schema' && schema.format.schema?.additionalProperties === false
      && schema.format.schema.required?.join(',') === 'prompt,questions',
    'the installed SDK actually forwards the strict prompt schema and no-tool payload to its offline fetch');
    failingWire = true;
    check(!!(await failure(completePromptImprovement(request(), signal, offlineApi))) && wireCalls === 2,
      'a provider 500 is a single attempt and the installed SDK does not retry it');

    const disclosure = promptImproveEgress({ available: true }, 'https://private-user:private-password@proxy.example/anthropic');
    check(disclosure[0].host === 'proxy.example' && disclosure[0].paths[0] === '/anthropic/v1/messages'
      && disclosure[0].activeNow === true && disclosure[0].overrideEnv === 'ANTHROPIC_BASE_URL'
      && /press Generate suggestion/.test(disclosure[0].when) && /no session history/.test(disclosure[0].purpose)
      && !JSON.stringify(disclosure).includes('private-')
      && promptImproveEgress({ available: false }, 'https://api.anthropic.com')[0].activeNow === false,
    'egress names the configured endpoint and explicit draft disclosure, with key/enable gating and no URL credentials');
    check(!JSON.stringify(promptImproveEgress({ available: false }, 'invalid private-secret')).includes('private-secret'),
      'a malformed endpoint override cannot leak its raw value through the egress report');
  } catch (error) {
    check(false, 'prompt improvement smoke completed', String(error));
  } finally {
    service.cancelAll();
    d.close();
  }
}
