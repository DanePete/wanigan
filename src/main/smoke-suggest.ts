import { egressReport } from './egress';
import { getSetting, setSetting } from './settings';
import { clearKey, enabled, estimatedUsd, setEnabled, setKey, status, suggestRelayPlan, verify, SUGGEST_HOST, SUGGEST_PATH, SUGGEST_RATES } from './modules/suggest';
import { db } from './db';
import { consumption, daily } from './usage';
import type { RelayPhase } from '../shared/relay';
import type { RouteCandidate } from '../shared/relay-route';
import { phasesFor } from '../shared/suggest-questions';
import { previewRelay } from './relay';
import { DOCKET_NODE_KINDS } from '../shared/types';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

const CANDIDATES: readonly RouteCandidate[] = [
  { model: 'gpt-5.1-codex', label: 'Codex 5.1', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { model: 'sonnet', label: 'Sonnet', efforts: ['low', 'high'] },
];
const PHASES: readonly RelayPhase[] = ['plan', 'estimate', 'implement', 'verify', 'review'];

/**
 * The suggester in the real main process, with no credential — which is what
 * every install has until somebody deliberately changes it.
 *
 * The assertion that matters is the last one: with the setting switched fully
 * on and no key stored, nothing reaches the network. `fetch` is replaced for
 * the duration and the test fails if it is called even once. A module that
 * spends money on a service the operator never configured is the failure this
 * whole design is arranged to make impossible, so it is worth proving rather
 * than reasoning about.
 */
export async function runSuggestSmoke(check: Check, say: Say): Promise<void> {
  say('── suggester · declared, disclosed, and silent without a credential');

  const before = getSetting('suggest.enabled', '');
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (...args: Parameters<typeof realFetch>) => {
    calls += 1;
    return realFetch(...args);
  }) as typeof realFetch;

  try {
    const row = egressReport().hosts.find((host) => host.host === SUGGEST_HOST);
    check(!!row, 'the suggester declares its destination in the egress table rather than reaching an undisclosed host', row);
    check(row?.paths.join(',') === SUGGEST_PATH,
      'it names the one route this service has, not the host in general', row?.paths);
    check(row?.by === 'wanigan', 'the call is Wanigan’s own, not an agent’s', row?.by);
    check(row?.overrideEnv === null, 'no base-url override applies, so the endpoint cannot be redirected by environment', row?.overrideEnv);
    check(row?.activeNow === false, 'and it is inactive, because no credential is stored', row?.activeNow);

    // The "only when" column is what a person actually reads before trusting
    // this, so it has to name both what leaves and what does not.
    const when = row?.when ?? '';
    check(/credential/i.test(when) && /switched on/i.test(when),
      'the disclosure states both conditions: a stored credential and a switch', when);
    for (const absent of ['files', 'diffs', 'transcripts', 'agent output']) {
      check(when.includes(absent), `the disclosure says ${absent} do not leave this machine`, when);
    }

    const shown = status();
    check(shown.hasKey === false && shown.enabled.length === 0,
      'status reports no credential and nothing switched on', shown.enabled);
    check(shown.capabilities.length === 2 && shown.capabilities.every((c) => c.withoutIt.length > 20),
      'every capability is declared with what switching it off costs', shown.capabilities.map((c) => c.id));

    // Renderer text, filtered rather than trusted.
    setEnabled(['route', 'pipeline', 'exfiltrate', 7, null, 'route']);
    check(getSetting('suggest.enabled', '') === 'route,pipeline',
      'an unknown capability id is dropped rather than stored', getSetting('suggest.enabled', ''));

    // Both switches on, in storage, and still nothing in force: the credential
    // is checked at one place so a switch left on by someone who later removed
    // their key cannot revive a call path.
    check(enabled().length === 0,
      'a capability switched on with no credential stored is not in force', enabled());

    // One call for the whole relay, and with no credential it is no call at all.
    const plan = await suggestRelayPlan('add a retry to the uploader', PHASES, [
      { phase: 'plan', candidates: CANDIDATES },
      { phase: 'implement', candidates: CANDIDATES },
      { phase: 'review', candidates: CANDIDATES },
    ]);
    check(Object.keys(plan.stages).length === 0 && plan.usage === null,
      'asking for a whole relay plan without a credential yields nothing rather than throwing', plan);
    check(plan.pipeline === null, 'and proposes no narrowing', plan.pipeline);
    check(phasesFor(PHASES, plan.pipeline).join(',') === PHASES.join(','),
      'so the docket runs exactly the stages it declared', phasesFor(PHASES, plan.pipeline));

    check(calls === 0,
      'and no request was made at all: with both switches on and no key, nothing reaches the network', calls);

    // A key that cannot be a key is refused before anything is sent. Only the
    // refusals that short-circuit are exercised here: proving a plausible key
    // means a real billed call, which a test suite has no business making.
    for (const bad of ['', '   ', 123, null, undefined, {}, [], 'k'.repeat(501)]) {
      const stored = await setKey(bad);
      check(stored.ok === false && stored.fingerprint === null,
        `a credential of ${JSON.stringify(bad) ?? 'undefined'} is refused rather than stored`, stored);
    }
    check(calls === 0, 'and none of those refusals reached the network either', calls);

    // The claim the whole design rests on, asserted rather than believed: with
    // no suggester, the relay's own preview is the profile's defaults and every
    // declared stage runs. This is the path every install without a TypeSafe
    // credential takes on every relay it starts.
    const preview = await previewRelay({ intent: 'add a retry to the uploader', providerId: 'claude' });
    check(preview.asked === false, 'a preview with no suggester says plainly that nothing was asked', preview.asked);
    check(preview.pipeline === null, 'and proposes no narrowing', preview.pipeline);
    check(preview.phases.join(',') === DOCKET_NODE_KINDS.join(','),
      'so every declared stage would run', preview.phases);
    check(preview.estimatedUsd === 0, 'and it cost nothing, because nothing was asked', preview.estimatedUsd);
    const sources = Object.values(preview.routes).map((row) => row.route.source);
    check(sources.length > 0 && sources.every((source) => source === 'profile-default'),
      'every stage is the profile default, and none is labelled a suggestion', sources);
    check(Object.values(preview.routes).every((row) => row.deliberation === null),
      'and no deliberation was judged', Object.values(preview.routes).map((row) => row.deliberation));
    check(calls === 0, 'and the whole preview reached the network zero times', calls);
    check(status().hasKey === false && status().fingerprint === null,
      'nothing was stored by any of them', status());

    // There is no way back out. The key crosses the boundary once.
    const shape = Object.keys(status()).sort().join(',');
    check(shape === 'capabilities,enabled,estimatedUsdPerCall,fingerprint,hasKey,host,stored,unreadable',
      'status carries a fingerprint and no channel returns the key itself', shape);

    // No file at all is not the same as a file that will not decrypt, and only
    // the second is worth telling somebody to paste their key again over.
    check(status().unreadable === false,
      'with no credential stored at all, nothing is reported as unreadable', status().unreadable);

    // A switch a person turned on is reported as stored even though no
    // credential makes it count. Redrawing it as off would tell them their
    // setting had not saved, which is the one thing the panel must not do.
    const saved = status();
    check(saved.stored.length === 2 && saved.enabled.length === 0,
      'a switch turned on with no key reads as stored and not in force, which are different facts',
      { stored: saved.stored, enabled: saved.enabled });

    check(setEnabled([]).stored.length === 0, 'and switching both off stores nothing', status().stored);
    setEnabled(['route', 'pipeline']);

    check(clearKey() === true && enabled().length === 0,
      'clearing a credential that was never stored is harmless', enabled());

    // The cost shown beside the switch is arithmetic over a local rate table.
    check(Math.abs(estimatedUsd(1_000_000) - 0.042) < 1e-9,
      'a million input tokens prices at the published $0.042, by Wanigan\u2019s own arithmetic', estimatedUsd(1_000_000));
    check(estimatedUsd(-1) === 0 && estimatedUsd(Number.NaN) === 0,
      'and a usage figure that is not a count prices at nothing rather than NaN', estimatedUsd(Number.NaN));

    await runSuggestUsageSmoke(check, say);
  } finally {
    globalThis.fetch = realFetch;
    setSetting('suggest.enabled', before);
  }
}

/** Exercise the real request and Usage read with an offline response, without storing a key. */
async function runSuggestUsageSmoke(check: Check, say: Say): Promise<void> {
  say('── suggester usage · one call, observed meters, separately labelled arithmetic');
  const start = (db().prepare('SELECT COALESCE(MAX(id),0) AS id FROM suggest_usage').get() as { id: number }).id;
  const realFetch = globalThis.fetch;
  const originalRate = SUGGEST_RATES.inputPerMTok;
  let reply: unknown = { model: 'jev-smoke', usage: { input_tokens: 1200, output_tokens: 0 } };
  let responseStatus = 200;
  let rawBody: string | null = null;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(rawBody ?? JSON.stringify(reply), {
      status: responseStatus, headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof realFetch;
  const recorded = () => (db().prepare('SELECT COUNT(*) AS n FROM suggest_usage WHERE id > ?').get(start) as { n: number }).n;
  try {
    check((await verify('offline-fixture-key')).ok,
      'a successful fixture reaches the real ask path without saving a credential');
    const shown = consumption(7).find((row) => row.model === 'jev-smoke');
    check(calls === 1 && recorded() === 1 && shown?.requests === 1 && shown.inTokens === 1200 && shown.outTokens === 0,
      'Usage includes exactly one Jev request and its reported tokens', shown);
    check(shown?.accountLabel === 'TypeSafe' && shown.source === 'service' && shown.harness === null,
      'Jev is attributed to the TypeSafe API service, without inventing a session account', shown);
    check(shown?.costUsd === 0 && shown.costStatus === 'unreported' && shown.unmeteredRequests === 0
      && Math.abs((shown.estimatedCostUsd ?? -1) - 0.0000504) < 1e-12,
    'local price arithmetic is stored separately from reported spend', shown);
    check(daily(7).some((row) => row.model === 'jev-smoke' && row.tokens === 1200 && row.costUsd === 0 && row.source === 'service'),
      'the same recorded Jev tokens reach the daily Usage chart', daily(7));

    SUGGEST_RATES.inputPerMTok = originalRate * 2;
    check(consumption(7).find((row) => row.model === 'jev-smoke')?.estimatedCostUsd === shown?.estimatedCostUsd,
      'changing the current rate leaves the recorded estimate unchanged');
    SUGGEST_RATES.inputPerMTok = originalRate;

    reply = { usage: { input_tokens: 20 } };
    await verify('offline-fixture-key');
    reply = { answers: {} };
    await verify('offline-fixture-key');
    const partial = consumption(7).find((row) => row.model === 'jev-latest');
    check(partial?.requests === 2 && partial.inTokens === 20 && partial.unmeteredRequests === 2
      && Math.abs((partial.estimatedCostUsd ?? -1) - estimatedUsd(20)) < 1e-12,
    'missing meters retain the requested model, known tokens and a count of unmetered calls', partial);

    for (const usage of [
      { input_tokens: -1, output_tokens: '0' },
      { input_tokens: 1.5, output_tokens: -1 },
      { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: null },
    ]) {
      reply = { model: 'jev-invalid-smoke', usage };
      await verify('offline-fixture-key');
    }
    const invalid = consumption(7).find((row) => row.model === 'jev-invalid-smoke');
    check(invalid?.requests === 3 && invalid.inTokens === 0 && invalid.outTokens === 0
      && invalid.unmeteredRequests === 3 && invalid.estimatedCostUsd === undefined,
    'invalid token counts stay unknown instead of becoming spend or negative usage', invalid);
    check(!daily(7).some((row) => row.model === 'jev-invalid-smoke'),
      'a daily group with no observed meters is absent rather than a measured zero');

    reply = { model: 'jev-zero-smoke', usage: { input_tokens: 0, output_tokens: 0 } };
    await verify('offline-fixture-key');
    const zero = consumption(7).find((row) => row.model === 'jev-zero-smoke');
    check(zero?.inTokens === 0 && zero.unmeteredRequests === 0 && zero.estimatedCostUsd === 0,
      'reported zero meters remain distinct from missing meters', zero);

    rawBody = '';
    const beforeEmpty = recorded();
    const unreadable = await verify('offline-fixture-key');
    check(!unreadable.ok && unreadable.detail.includes('response could not be read') && recorded() === beforeEmpty + 1,
      'an unreadable successful response records one unmetered call without verifying the key');
    rawBody = null;
    const beforeRefusal = recorded();
    responseStatus = 429;
    check(!(await verify('offline-fixture-key')).ok && recorded() === beforeRefusal,
      'an HTTP refusal adds no phantom successful request');
    globalThis.fetch = (async () => { throw new Error('offline fixture failure'); }) as typeof realFetch;
    check(!(await verify('offline-fixture-key')).ok && recorded() === beforeRefusal,
      'a transport failure adds no phantom successful request');

    globalThis.fetch = (async () => new Response(JSON.stringify(reply), { status: 200 })) as typeof realFetch;
    db().exec(`CREATE TEMP TRIGGER suggest_usage_smoke_fail BEFORE INSERT ON suggest_usage
      BEGIN SELECT RAISE(ABORT, 'offline usage ledger failure'); END`);
    try {
      let failure: unknown = null;
      try { await verify('offline-fixture-key'); } catch (error) { failure = error; }
      check(failure instanceof Error && failure.message.includes('offline usage ledger failure'),
        'a local recording failure is surfaced instead of misreported as an unreachable service');
    } finally {
      db().exec('DROP TRIGGER suggest_usage_smoke_fail');
    }

    db().prepare('UPDATE suggest_usage SET at=? WHERE id>? AND model=?')
      .run(Date.now() - 100 * 86_400_000, start, 'jev-smoke');
    check(!consumption(7).some((row) => row.model === 'jev-smoke') && !daily(7).some((row) => row.model === 'jev-smoke'),
      'Jev obeys the same selected date window as session usage');
    const columns = db().prepare('PRAGMA table_info(suggest_usage)').all() as { name: string }[];
    check(columns.map((row) => row.name).sort().join(',') === 'at,estimated_cost_usd,id,input_tokens,model,output_tokens'
      && status().hasKey === false,
    'the ledger keeps only model and metering metadata, and no fixture credential was stored');
  } finally {
    globalThis.fetch = realFetch;
    SUGGEST_RATES.inputPerMTok = originalRate;
    db().prepare('DELETE FROM suggest_usage WHERE id > ?').run(start);
  }
}
