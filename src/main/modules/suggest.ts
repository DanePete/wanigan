import type { WaniganModule } from '../module-registry';
import { createHash } from 'node:crypto';
import { refuseIfHalted } from '../halt';
import { clearProviderKey, getProviderKey, hasProviderKey, providerKeyFingerprint, setProviderKey } from '../keys';
import { getSetting, setSetting } from '../settings';
import { db } from '../db';
import { migrateSuggestUsage, recordSuggestUsage, suggestConsumption, suggestDaily } from '../suggest-usage';
import type { RelayPhase } from '../../shared/relay';
import type { RelayRoutingPreference } from '../../shared/relay-routing';
import {
  NO_SUGGESTER, SUGGESTER_CAPABILITIES,
  NO_RELAY_PLAN, readRelayPlan, relayPlanRequest,
  type RelayPlanReading, type StageAsk, type SuggesterCapability, type SystemOneRequest,
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
 * A credential that can actually be used, which is not the same as one on disk.
 *
 * `hasProviderKey` answers whether the file exists. `getProviderKey` answers
 * whether it decrypted. Those come apart: the blob is sealed by the OS keychain
 * under this application's identity, so a keychain entry that is revoked,
 * denied or left behind by a migration leaves the file in place and unreadable.
 *
 * Observed, not imagined — running this module against a copy of a real profile
 * reported `hasKey: true` and, one call later, "No TypeSafe credential is
 * stored". Every gate here asked the first question and every call asked the
 * second, so the panel showed a key installed while nothing worked. Everything
 * that decides whether the suggester can run now asks the question that
 * matters.
 */
const credentialed = (): boolean => getProviderKey(PROVIDER) !== null;

/** A file that exists and will not decrypt. A different fact from having no key. */
const unreadableCredential = (): boolean => hasProviderKey(PROVIDER) && !credentialed();

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
  return credentialed() ? stored() : NO_SUGGESTER;
}

/** Main-only receipt binding; the shortened display fingerprint is not an identity. */
export function decisionContext(): string {
  const key = getProviderKey(PROVIDER);
  return createHash('sha256').update(JSON.stringify({ endpoint: ENDPOINT, enabled: enabled(), key })).digest('hex');
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
  /** A credential that decrypts. A file that will not read is not a key. */
  hasKey: boolean;
  /**
   * There is a stored credential and this Mac cannot read it.
   *
   * Distinct from having none, and the only one of the two a person can act on
   * differently: the fix is to paste the key again, not to go and find one.
   */
  unreadable: boolean;
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
    hasKey: credentialed(),
    unreadable: unreadableCredential(),
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
 * Ordinary transport failures return no suggestion. A halted Wanigan and a
 * failed local usage write throw: the former is the fleet-wide latch, and the
 * latter must not pretend a billed call never reached the service.
 */
async function ask(request: SystemOneRequest, keyOverride?: string): Promise<AskOutcome> {
  refuseIfHalted('ask for a routing suggestion');
  const key = keyOverride ?? getProviderKey(PROVIDER);
  if (!key) return { ok: false, reason: 'No TypeSafe credential is stored.' };

  // Complete local schema initialization before making a call that may cost
  // money. A migration failure must not first be discovered while recording it.
  db();
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError'
      ? `The suggester did not answer within ${TIMEOUT_MS / 1000}s.`
      : 'The suggester could not be reached.';
    return { ok: false, reason };
  }
  const ms = Date.now() - started;
  if (!response.ok) {
    // The status, not the body. An error body from a service in early access
    // is text nobody has validated, and it would be shown beside a route.
    return { ok: false, reason: `The suggester answered ${response.status}.` };
  }
  // The service answered successfully even when its body cannot be read.
  // Preserve that call as unmetered; each preview, relay and key check reaches
  // this one ledger write, regardless of how many questions it contained.
  let body: unknown = null;
  let readable = true;
  try { body = await response.json(); } catch { readable = false; }
  const { inputTokens } = recordSuggestUsage({
    at: started, requestedModel: request.model, body, inputPerMTok: SUGGEST_RATES.inputPerMTok,
  });
  if (!readable) return { ok: false, reason: 'The suggester answered, but its response could not be read.' };
  return { ok: true, body, ms, inputTokens };
}

/**
 * Every question a relay needs, in one call.
 *
 * One request for the whole relay rather than one per stage: the pipeline
 * choice and every stage's model, model-specific effort and task evidence ride
 * together. Questions are independent; only the selected model's effort answer
 * is consumed. More questions add metered input, without another round trip.
 *
 * Nothing is the honest and common answer: no credential, both capabilities
 * off, halted, timed out, rate limited, or an answer that did not clear its
 * gate. Every one of those returns an empty reading, and the relay then runs
 * exactly the stages it declared on the profile's own defaults.
 */
export async function suggestRelayPlan(
  intent: string,
  requested: readonly RelayPhase[],
  stages: readonly StageAsk[],
  preference: RelayRoutingPreference = 'cost',
): Promise<RelayPlanReading> {
  const request = relayPlanRequest(intent, requested, stages, enabled(), preference);
  if (!request) return NO_RELAY_PLAN;
  const outcome = await ask(request);
  if (!outcome.ok) return NO_RELAY_PLAN;
  return readRelayPlan(outcome.body, requested, stages);
}

/**
 * Verify a stored key, or prove a candidate one before it is written.
 *
 * Every other provider here is verified against a catalogue endpoint. TypeSafe
 * has none — `/v1/systemone` is the only route — so verification is a real
 * evaluation, and it is deliberately the smallest one that can exist: a single
 * `noul` over a fixed six-word state that contains nothing about this machine,
 * this repository or this operator.
 */
export async function verify(keyOverride?: string): Promise<{ ok: boolean; detail: string }> {
  if (!keyOverride && !credentialed()) {
    return {
      ok: false,
      detail: unreadableCredential()
        ? 'A TypeSafe credential is stored but this Mac cannot read it. Paste the key again to replace it.'
        : 'No TypeSafe credential is stored.',
    };
  }
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
  migrate: migrateSuggestUsage,
  usage: { consumption: suggestConsumption, daily: suggestDaily },
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
  },
};
