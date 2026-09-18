import { egressReport } from './egress';
import { getSetting, setSetting } from './settings';
import { clearKey, enabled, estimatedUsd, setEnabled, setKey, status, suggestPipeline, suggestRoute, SUGGEST_HOST, SUGGEST_PATH } from './modules/suggest';
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

    const route = await suggestRoute('implement', 'add a retry to the uploader', CANDIDATES);
    check(route.suggestion === null && route.deliberation === null && route.usage === null,
      'asking for a route without a credential yields nothing rather than throwing', route);

    const pipeline = await suggestPipeline('add a retry to the uploader', PHASES);
    check(pipeline === null, 'and asking which stages to run yields nothing', pipeline);
    check(phasesFor(PHASES, pipeline).join(',') === PHASES.join(','),
      'so the docket runs exactly the stages it declared', phasesFor(PHASES, pipeline));

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
    check(shape === 'capabilities,enabled,estimatedUsdPerCall,fingerprint,hasKey,host,stored',
      'status carries a fingerprint and no channel returns the key itself', shape);

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
  } finally {
    globalThis.fetch = realFetch;
    setSetting('suggest.enabled', before);
  }
}
