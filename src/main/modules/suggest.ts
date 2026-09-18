import type { WaniganModule } from '../module-registry';
import { refuseIfHalted } from '../halt';
import { clearProviderKey, getProviderKey, hasProviderKey, providerKeyFingerprint, setProviderKey } from '../keys';
import { getSetting, setSetting } from '../settings';
import type { RelayPhase } from '../../shared/relay';
import type { RouteCandidate } from '../../shared/relay-route';
import {
  NO_SUGGESTER, SUGGESTER_CAPABILITIES,
  readPipeline, readSuggestion, readTry, relayRequest, stageRequest, tryRequest,
  type PipelineReading, type StageReading, type SuggesterCapability, type SystemOneRequest,
  type TryReading,
} from '../../shared/suggest-questions';

/**
 * The suggester: Wanigan's one client of a System One model.
 *
 * It is a module and not a feature wired into `index.ts`, and it is *not*
 * required. Nothing in the trust kernel depends on it — sessions launch,
 * evidence records and reviews gate exactly the same with it gone — so
 * `required` is `null` and each capability states what switching it off costs.
 * A build where this never succeeds behaves like the build before it existed,
 * which is the property the whole design is arranged around rather than a
 * fallback bolted on afterwards.
 *
 * **Off is the default and the common case.** This talks to a third-party
 * service in early access that most installs will never have configured, so
 * `enabled()` returns nothing until a person turns a capability on *and* a
 * credential exists. `ask()` refuses before it builds a request, the pure
 * builders refuse again on their own, and both refusals are silent and free.
 * There is no path here that spends money without a stored key and an explicit
 * switch, which is what `AGENTS.md` means by not silently spending tokens.
 *
 * The provider id is `typesafe` and it is opaque, as every provider id here is.
 * Nothing routes on it: the capability list decides what may be asked, and the
 * pure module decides what the question looks like.
 */

const PROVIDER = 'typesafe';
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const SUGGEST_HOST = 'api.typesafe.ai';
export const SUGGEST_PATH = '/v1/systemone';

/** Which capabilities are switched on. Stored as ids, defaulting to none. */
const SETTING_KEY = 'suggest.enabled';

/**
 * Longest a call may run before it is abandoned.
 *
 * The vendor documents 70–500 ms end to end. Five seconds is not a latency
 * budget, it is the point past which something is wrong and the profile
 * default is a better answer than continuing to wait — a stage does not get to
 * block on an optional opinion.
 */
const TIMEOUT_MS = 5000;

/**
 * Wanigan's own rate table, in USD per million tokens.
 *
 * Source: docs.typesafe.ai/models. Output is free because there is no
 * autoregressive decoding to meter. `history` is empty and stays empty until a
 * rate change is verified against a published schedule, which is the same rule
 * `batch/pricing.ts` states at length: editing a rate in place silently
 * rewrites every cost already on record.
 *
 * Anything computed from this is arithmetic and is labelled as arithmetic. It
 * is never a reported cost, and here it cannot become one even in principle —
 * the vendor says early pricing may be subsidised, and there is no invoice line
 * to reconcile against.
 */
export const SUGGEST_RATES = {
  inputPerMTok: 0.042,
  outputPerMTok: 0,
  history: [] as { until: number; inputPerMTok: number; outputPerMTok: number }[],
};

/** What a call cost by Wanigan's own arithmetic. Never presented as a bill. */
export function estimatedUsd(inputTokens: number): number {
  if (!Number.isFinite(inputTokens) || inputTokens < 0) return 0;
  return (inputTokens / 1_000_000) * SUGGEST_RATES.inputPerMTok;
}

const KNOWN = new Set<string>(SUGGESTER_CAPABILITIES.map((capability) => capability.id));

/**
 * The capabilities actually in force.
 *
 * A stored id this build no longer knows is dropped rather than honoured, and
 * every capability is dropped when no credential exists — a switch left on by
 * someone who later removed their key must not keep a call path alive. So the
 * credential is checked here, once, rather than at each call site where one
 * could be forgotten.
 */
export function enabled(): readonly SuggesterCapability[] {
  return hasProviderKey(PROVIDER) ? stored() : NO_SUGGESTER;
}

/**
 * The switches as a person left them, whether or not they are in force.
 *
 * Distinct from `enabled()` on purpose. A switch turned on with no credential
 * is a real thing a person did, and a panel that redrew it as off would be
 * telling them their setting had not saved. So the setting is reported as
 * stored, `enabled()` reports what is actually in force, and the difference
 * between the two is a sentence the UI can show rather than a discrepancy the
 * operator has to work out.
 */
export function stored(): readonly SuggesterCapability[] {
  const raw = getSetting(SETTING_KEY, '');
  if (!raw) return NO_SUGGESTER;
  const ids = raw.split(',').map((id) => id.trim()).filter((id) => KNOWN.has(id));
  return [...new Set(ids)] as readonly SuggesterCapability[];
}

/** Turn capabilities on or off. The input is renderer text and is filtered, never trusted. */
export function setEnabled(ids: unknown): SuggestStatus {
  const list = Array.isArray(ids) ? ids : [];
  const kept = [...new Set(list.filter((id): id is string => typeof id === 'string' && KNOWN.has(id)))];
  setSetting(SETTING_KEY, kept.join(','));
  // The whole status, so a panel never has to guess whether what it just
  // stored is also in force.
  return status();
}

export type SuggestStatus = {
  hasKey: boolean;
  /** Enough of the key to recognise it, never the key. */
  fingerprint: string | null;
  /** In force: switched on *and* credentialed. */
  enabled: readonly SuggesterCapability[];
  /** As switched, whether or not a credential makes them count. */
  stored: readonly SuggesterCapability[];
  capabilities: typeof SUGGESTER_CAPABILITIES;
  host: string;
  /** Wanigan's arithmetic for a typical call, so a settings panel can say so honestly. */
  estimatedUsdPerCall: number;
};

export function status(): SuggestStatus {
  return {
    hasKey: hasProviderKey(PROVIDER),
    fingerprint: providerKeyFingerprint(PROVIDER),
    enabled: enabled(),
    stored: stored(),
    capabilities: SUGGESTER_CAPABILITIES,
    host: SUGGEST_HOST,
    estimatedUsdPerCall: estimatedUsd(800),
  };
}

export type AskOutcome =
  | { ok: true; body: unknown; ms: number; inputTokens: number | null }
  | { ok: false; reason: string };

/**
 * One request, one attempt.
 *
 * **It does not retry.** A 429 or a 529 returns the profile default, and that
 * is deliberate: this is an optional opinion on a stage that is going to run
 * anyway, and a backoff loop would turn a rate limit into money spent several
 * times over for an answer nobody is waiting on. The vendor's own rate limits
 * are documented as adjusting dynamically without notice, which is an argument
 * for failing quietly rather than for trying harder.
 *
 * It never throws for an ordinary failure. A halted Wanigan is the one
 * exception, because `refuseIfHalted` is the fleet-wide latch and a module that
 * swallowed it would be a module that kept making network calls after the
 * operator pulled the handle.
 */
async function ask(request: SystemOneRequest, keyOverride?: string): Promise<AskOutcome> {
  refuseIfHalted('ask for a routing suggestion');
  const key = keyOverride ?? getProviderKey(PROVIDER);
  if (!key) return { ok: false, reason: 'No TypeSafe credential is stored.' };

  const started = Date.now();
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Date.now() - started;
    if (!response.ok) {
      // The status, not the body. An error body from a service in early access
      // is text nobody has validated, and it would be shown beside a route.
      return { ok: false, reason: `The suggester answered ${response.status}.` };
    }
    const body: unknown = await response.json();
    const usage = (body as { usage?: { input_tokens?: unknown } } | null)?.usage;
    const inputTokens = typeof usage?.input_tokens === 'number' && Number.isFinite(usage.input_tokens)
      ? usage.input_tokens
      : null;
    return { ok: true, body, ms, inputTokens };
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError'
      ? `The suggester did not answer within ${TIMEOUT_MS / 1000}s.`
      : 'The suggester could not be reached.';
    return { ok: false, reason };
  }
}

/** The empty reading, which is what every refusal and every failure returns. */
const NO_READING: StageReading = { suggestion: null, deliberation: null, needsContext: null, usage: null };

/**
 * A model and effort opinion for one stage, or nothing.
 *
 * Nothing is the honest and common answer: no credential, capability off,
 * halted, timed out, rate limited, or an answer that did not clear its gate.
 * The router turns every one of those into the profile's own default.
 */
export async function suggestRoute(
  phase: RelayPhase,
  intent: string,
  candidates: readonly RouteCandidate[],
  descriptions?: Readonly<Record<string, string>>,
): Promise<StageReading> {
  const request = stageRequest(phase, intent, candidates, { enabled: enabled(), descriptions });
  if (!request) return NO_READING;
  const outcome = await ask(request);
  if (!outcome.ok) return NO_READING;
  return readSuggestion(outcome.body, candidates);
}

/**
 * A proposal for which stages to run, or nothing.
 *
 * Nothing means the docket runs exactly the stages it declared, which is what
 * `phasesFor()` returns for a null reading. No answer from here can add a stage
 * or remove one that checks the work; that is fixed in the pure module by
 * `UNSKIPPABLE` and cannot be loosened from this side.
 */
export async function suggestPipeline(
  intent: string,
  requested: readonly RelayPhase[],
): Promise<PipelineReading> {
  const request = relayRequest(intent, requested, enabled());
  if (!request) return null;
  const outcome = await ask(request);
  if (!outcome.ok) return null;
  return readPipeline(outcome.body, requested);
}

/**
 * Verify a stored key by making one minimal real call.
 *
 * Every other provider here is verified against a catalogue endpoint. TypeSafe
 * has none — `/v1/systemone` is the only route — so verification is a real
 * evaluation, and it is deliberately the smallest one that can exist: a single
 * `noul` over a fixed six-word state that contains nothing about this machine,
 * this repository or this operator.
 */
export async function verify(keyOverride?: string): Promise<{ ok: boolean; detail: string }> {
  if (!keyOverride && !hasProviderKey(PROVIDER)) return { ok: false, detail: 'No TypeSafe credential is stored.' };
  const outcome = await ask({
    model: 'jev-latest',
    state: { check: 'a connectivity check with no content' },
    questions: {
      reachable: { type: 'noul', instructions: 'Is this text written in English?' },
    },
  }, keyOverride);
  if (!outcome.ok) return { ok: false, detail: outcome.reason };
  const tokens = outcome.inputTokens;
  const cost = tokens === null ? 'an unpriced call' : `about $${estimatedUsd(tokens).toFixed(7)} by Wanigan's own arithmetic`;
  return { ok: true, detail: `Answered in ${outcome.ms}ms, ${cost}.` };
}

export type TryOutcome =
  | ({ ok: true; ms: number; estimatedUsd: number } & TryReading)
  | { ok: false; reason: string };

/** Every stage a relay can declare, which is what a preview should consider. */
const ALL_PHASES: readonly RelayPhase[] = ['plan', 'estimate', 'implement', 'verify', 'review'];

/**
 * What the suggester would say about one description, without acting on it.
 *
 * The honest counterpart to "a suggestion is a guess, shown as a guess": before
 * trusting one, you can see one. It runs the real questions and reports the
 * real confidences **ungated**, including answers that fall below the
 * thresholds — those are precisely the cases worth looking at when deciding
 * whether 0.8 is the right bar, and a preview that hid them would be
 * demonstrating the gate rather than the model.
 *
 * Not gated on a capability, because the point is to look before switching one
 * on. Gated on a credential and on an explicit press, because it spends.
 */
export async function tryIntent(raw: unknown): Promise<TryOutcome> {
  const intent = typeof raw === 'string' ? raw.trim() : '';
  if (!intent) return { ok: false, reason: 'Describe a task first.' };
  if (!hasProviderKey(PROVIDER)) return { ok: false, reason: 'No TypeSafe credential is stored.' };
  const request = tryRequest(intent, ALL_PHASES);
  if (!request) return { ok: false, reason: 'Describe a task first.' };
  const outcome = await ask(request);
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  const reading = readTry(outcome.body, ALL_PHASES);
  return {
    ok: true,
    ms: outcome.ms,
    estimatedUsd: estimatedUsd(reading.usage?.inputTokens ?? outcome.inputTokens ?? 0),
    ...reading,
  };
}

/**
 * Store a credential, but only one that has been proven first.
 *
 * The id is the literal `PROVIDER` and never renderer text. Every other
 * credential here is named by the caller and validated against the packs that
 * declare it (`managedProviderCredentialId`), which is right for a session
 * backend and wrong for this: TypeSafe is not something a session runs on, so
 * it is not a managed provider id and the renderer has no business naming a
 * credential slot at all. It sends a key; this module decides where it goes.
 *
 * The key is proven with a real call *before* it is written, so a typo does not
 * become a stored credential that silently fails every suggestion afterwards.
 * That call costs a fraction of a cent and happens only when a person presses
 * save, which is the deliberate action `AGENTS.md` asks for before an external
 * side effect.
 */
export async function setKey(raw: unknown): Promise<{ ok: boolean; detail: string; fingerprint: string | null }> {
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key) return { ok: false, detail: 'That key is empty.', fingerprint: null };
  if (key.length > 500) return { ok: false, detail: 'That does not look like an API key.', fingerprint: null };
  const proven = await verify(key);
  if (!proven.ok) return { ok: false, detail: proven.detail, fingerprint: null };
  await setProviderKey(PROVIDER, key);
  return { ok: true, detail: proven.detail, fingerprint: providerKeyFingerprint(PROVIDER) };
}

/**
 * Forget the credential.
 *
 * The capability switches are left exactly as they were. Turning a switch off
 * is a separate decision from removing a key, and silently clearing them here
 * would mean a person who re-pasted their key found the suggester off for
 * reasons nothing told them about. `enabled()` already returns nothing while no
 * credential exists, so leaving them set costs nothing and surprises nobody.
 */
export function clearKey(): boolean {
  clearProviderKey(PROVIDER);
  return true;
}

export const suggestModule: WaniganModule = {
  id: 'suggest',
  label: 'Routing suggester',
  /**
   * Removable, and most installs will never install it in the first place. It
   * proposes; it never decides. Switching it off costs the suggestion and
   * nothing else — every stage runs on its profile's declared default, which
   * is the behaviour of every build before this module existed.
   */
  required: null,
  ipc(handle) {
    handle('suggest:status', () => status());
    handle('suggest:setEnabled', (ids: unknown) => setEnabled(ids));
    // A real call that spends money, so it is never implicit: it happens on an
    // explicit press and reports what it cost.
    handle('suggest:verify', () => verify());
    // The key crosses this boundary once and is never read back out: `status`
    // returns a fingerprint, and there is no channel that returns the key.
    handle('suggest:setKey', (key: unknown) => setKey(key));
    handle('suggest:clearKey', () => clearKey());
    // Spends, so it is a press and never a render. Untrusted renderer text.
    handle('suggest:try', (intent: unknown) => tryIntent(intent));
  },
};
