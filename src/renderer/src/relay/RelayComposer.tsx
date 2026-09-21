import { PromptField } from '../prompt-actions/PromptField';
import { useEffect, useRef, useState } from 'react';
import type { AccountLimits, AgentAccount, ProviderInfo, RelayPreview, RelayRead, RelayRouteInput, RelayStageKey } from '@shared/types';
import { DEFAULT_MIN_CONFIDENCE } from '@shared/relay-route';
import { DEFAULT_RELAY_ROUTING, RELAY_ROUTING_PREFERENCES, type RelayRoutingSettings } from '@shared/relay-routing';
import { Hint, Note, Section, SectionHead } from '../components/bits';
import { useViewMemory } from '../components/viewMemory';
import { STAGE_WORD } from './facts';
import RelayRunners, { INHERIT_NONE, RUNNER_KEYS, emptyRunners, isLocalProvider, type RunnerDraft, type RunnerKey, type RunnersDraft } from './RelayRunners';
import ModelEconomics from './ModelEconomics';
import { accountReadingNote } from '@shared/account-reading-note';

/**
 * Create a relay: say the outcome, say who runs each stage, keep the checks.
 *
 * The composer used to ask for a model and an effort as free text per stage,
 * under one assistant for the whole relay. The stage that matters most to an
 * operator with a local GPU and a frontier subscription — a cheap build
 * followed by a strong clean-up — could not be expressed at all, and a model
 * name typed from memory was refused only after Create. Now the rail is the
 * form: every stage on it, each agent stage with an assistant, an account and
 * a model chosen from what that assistant declares, and the clean-up stage
 * one checkbox away. Presets fill the common shapes in one press.
 */

const toRoutes = (draft: RunnersDraft, refineOn: boolean): RelayRouteInput => {
  const routes: RelayRouteInput = {};
  for (const key of RUNNER_KEYS) {
    if (key === 'refine' && !refineOn) continue;
    const row = draft[key];
    const entry: { providerId?: string; model?: string; effort?: string; accountId?: string | null } = {};
    if (row.providerId) entry.providerId = row.providerId;
    // null is sent deliberately: it is the one way to say "not the relay's
    // account" without naming a different one.
    if (row.accountId === INHERIT_NONE) entry.accountId = null;
    else if (row.accountId) entry.accountId = row.accountId;
    if (row.model.trim()) entry.model = row.model.trim();
    if (row.effort.trim()) entry.effort = row.effort.trim();
    // The clean-up stage is named even with nothing chosen for it: its
    // presence is what adds the stage, and main routes it on the relay's
    // assistant and that assistant's default.
    if (Object.keys(entry).length || key === 'refine') routes[key] = entry;
  }
  return routes;
};

export default function RelayComposer({ projectId, providers, active, onCreated, onCancel, onPendingChange }: {
  projectId: string | null; providers: ProviderInfo[]; active: boolean;
  onCreated: (read: RelayRead) => void; onCancel?: () => void; onPendingChange: (pending: boolean) => void;
}) {
  const [intent, setIntent] = useState('');
  const [delivery, setDelivery] = useState(true);
  const [automatic, setAutomatic] = useState(false);
  const [budget, setBudget] = useState('');
  const [routing, setRouting] = useViewMemory<RelayRoutingSettings>('composer-routing', { ...DEFAULT_RELAY_ROUTING });
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  // Remembered per view, so the shape an operator settles on — local builds,
  // frontier cleans up — is the shape the next relay opens with.
  const [runners, setRunners] = useViewMemory<RunnersDraft>('composer-runners', emptyRunners());
  const [refineOn, setRefineOn] = useViewMemory<boolean>('composer-refine', false);
  const [accountId, setAccountId] = useState('');
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountRetry, setAccountRetry] = useState(0);
  const [accountOptions, setAccountOptions] = useState<AgentAccount[] | null>(null);
  const [knownLimits, setKnownLimits] = useState<{ at: number; limits: AccountLimits[] } | null>(null);
  const [preview, setPreview] = useState<RelayPreview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const intentEl = useRef<HTMLTextAreaElement>(null);
  const pending = useRef(false);
  const manual = routing.mode === 'manual';

  useEffect(() => { if (active) intentEl.current?.focus(); }, [active]);
  useEffect(() => {
    if (!providerId && providers[0]) setProviderId(providers[0].id);
  }, [providerId, providers]);
  useEffect(() => {
    if (!providerId) { setAccountOptions([]); return; }
    let live = true;
    setAccountOptions(null); setAccountError(null);
    void window.wanigan.accounts.listForProvider(providerId)
      .then((rows) => { if (live) setAccountOptions(rows); })
      .catch((cause: unknown) => { if (live) setAccountError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { live = false; };
  }, [providerId, accountRetry]);

  // Only what a visit to Usage already established. Reading limits spends an
  // account probe, and opening this form must not start one.
  useEffect(() => {
    if (!active) return;
    let live = true;
    void window.wanigan.usage.known().then((known) => { if (live) setKnownLimits(known); }).catch(() => { if (live) setKnownLimits(null); });
    return () => { live = false; };
  }, [active]);
  // Said for a named account only. The ordinary resolution names none until launch.
  const accountReading = accountId ? accountReadingNote(knownLimits?.limits.find((row) => row.accountId === accountId), Date.now()) : null;
  const relayAccountLabel = accountId ? (accountOptions?.find((row) => row.id === accountId)?.label ?? null) : null;

  const updateRunner = (key: RunnerKey, patch: Partial<RunnerDraft>) => {
    setRunners((value) => ({ ...value, [key]: { ...value[key], ...patch } }));
    setPreview(null);
  };
  const updateRouting = (patch: Partial<RelayRoutingSettings>) => {
    setRouting(value => ({ ...value, ...patch }));
    setPreview(null);
  };
  const act = async (key: string, run: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; onPendingChange(true); setBusy(key); setError(null);
    try { await run(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pending.current = false; onPendingChange(false); setBusy(null); }
  };
  const suggest = () => act('preview', async () => {
    setPreview(await window.wanigan.relay.preview({ intent: intent.trim(), providerId,
      routing, routes: toRoutes(runners, refineOn), automaticProgress: automatic }));
  });
  const create = () => act('create', async () => {
    if (!projectId) throw new Error('Choose a project before creating a relay.');
    const next = await window.wanigan.relay.create({ projectId, intent: intent.trim(), providerId,
      routing, routes: toRoutes(runners, refineOn), accountId: accountId || undefined, delivery,
      previewReceipt: preview?.receipt, automation: automatic ? { budgetUsd: Number(budget) } : undefined });
    setIntent(''); setPreview(null); onCreated(next);
  });

  /* ── presets: the shapes a relay usually takes, filled in one press ──── */
  const local = providers.find(isLocalProvider) ?? null;
  const frontier = providers.find((p) => !isLocalProvider(p) && p.id !== local?.id) ?? null;
  const preset = (shape: 'local-then-frontier' | 'one' | 'second-opinion') => {
    setPreview(null);
    if (shape === 'one') { setRunners(emptyRunners()); setRefineOn(false); return; }
    if (shape === 'local-then-frontier' && local) {
      const cleaner = providerId !== local.id ? '' : (frontier?.id ?? '');
      setRunners({ ...emptyRunners(), implement: { providerId: local.id, model: '', effort: '', accountId: '' }, refine: { providerId: cleaner, model: '', effort: '', accountId: '' } });
      setRefineOn(true);
      return;
    }
    if (shape === 'second-opinion') {
      const other = providers.find((p) => p.id !== providerId) ?? null;
      setRunners({ ...emptyRunners(), refine: { providerId: other?.id ?? '', model: '', effort: '', accountId: '' } });
      setRefineOn(true);
    }
  };

  const shownStages: RelayStageKey[] = refineOn ? ['plan', 'implement', 'refine', 'review'] : ['plan', 'implement', 'review'];
  const runsIn = (key: RelayStageKey, phases: readonly string[]) => key === 'refine' ? phases.includes('implement') : phases.includes(key);

  return <div className="rl-composer" hidden={!active}>
    {error && <Note tone="error" onDismiss={() => setError(null)}>{error}</Note>}
    {providers.length === 0 && <Note tone="warn">Connect a coding assistant in Settings before creating a relay.</Note>}
          <Section title="Create a relay" hint="Say the outcome, choose who runs each stage, and keep the checks that prove it worked.">
            {/* A relay belongs to a project and this view has no picker of its
                own — the one in the header is app-wide. Without this the only
                signal was "No project" in the eyebrow and a Start button that
                stayed disabled without saying why. */}
            {!projectId && (
              <Note tone="warn">
                A relay runs inside a project, and none is chosen. Pick one from the folder menu at the top of the
                window — beside the Wanigan name — and this page will fill in.
              </Note>
            )}
            <div className="prompt-field-group">
              <label htmlFor="relay-intent"><span className="label">What should this relay accomplish?</span></label>
              <PromptField id="relay-intent" scopeKey={`relay:${projectId}:${providerId}`} purpose="relay intent" maxLength={12_000} className="field" aria-label="What should this relay accomplish" value={intent}
                onValueChange={value => { setIntent(value); setPreview(null); }} rows={4} ref={intentEl}
                placeholder="Fix checkout retries so one payment creates one order. Include what done looks like." disabled={busy !== null} />
            </div>

            <SectionHead label="Who runs each stage" />
            <div className="rl-start-meta">
              <label>
                <span className="label">Assistant for every stage unless a stage says otherwise</span>
                <select className="field" aria-label="Relay assistant" value={providerId}
                  onChange={(e) => {
                    setProviderId(e.target.value); setPreview(null);
                    // The account belonged to the old profile's harness; keeping
                    // it would offer a pin the new one cannot honour.
                    setAccountId('');
                  }} disabled={busy !== null}>
                  {providers.map((p) => <option key={p.id} value={p.id}>{p.label}{isLocalProvider(p) ? ' · local, unpriced' : ''}</option>)}
                </select>
              </label>
              {/* Which account pays. Agent stages start hours apart, so leaving
                  this to whatever the project defaults to by then is how a relay
                  bills an account nobody chose — under a forecast whose whole
                  purpose is knowing the cost first. */}
              {accountError ? (
                <Note tone="error" action={{ label: 'Retry accounts', run: () => setAccountRetry((value) => value + 1) }}>
                  Could not read this assistant’s accounts. {accountError}
                </Note>
              ) : accountOptions === null ? (
                <p className="faint">Reading the accounts this assistant can use…</p>
              ) : accountOptions.length === 0 ? (
                <Hint>This assistant uses its current login. Separate accounts are unavailable.</Hint>
              ) : (<>
                <label>
                  <span className="label">Account for every stage unless a stage says otherwise</span>
                  <select className="field" aria-label="Relay account" value={accountId}
                    onChange={(e) => { setAccountId(e.target.value); setPreview(null); }} disabled={busy !== null}>
                    <option value="">This project’s account, then the default</option>
                    {accountOptions.map((row) => (
                      <option key={row.id} value={row.id}>{row.label}{row.isDefault ? ' (default)' : ''}</option>
                    ))}
                  </select>
                </label>
                {accountReading && <div className="rl-account-reading"><Note tone={accountReading.tone}>{accountReading.text}</Note></div>}
              </>)}
            </div>

            <div className="rl-presets" role="group" aria-label="Relay presets">
              <button type="button" className="btn btn-sm" disabled={busy !== null || !local} onClick={() => preset('local-then-frontier')}
                aria-description={local ? `Build on ${local.label}, then clean up on ${providerId !== local.id ? 'the relay’s assistant' : (frontier?.label ?? 'another assistant')}` : 'Add the NVIDIA PAIR provider to build locally'}>
                Local builds, frontier cleans up
              </button>
              <button type="button" className="btn btn-sm" disabled={busy !== null || providers.length < 2} onClick={() => preset('second-opinion')}
                aria-description="Keep the relay’s assistant for planning and building, and add a clean-up stage on a different assistant">
                Second assistant cleans up
              </button>
              <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => preset('one')}
                aria-description="Every stage on the relay’s assistant and account, with no clean-up stage">
                One assistant for everything
              </button>
              <span className="faint">
                {local ? 'A local stage is unpriced and runs on your own hardware; the clean-up stage is where a stronger model checks its work.'
                  : 'Add the NVIDIA PAIR provider to build on a local model and let a frontier model clean up.'}
              </span>
            </div>

            <RelayRunners providers={providers} relayProviderId={providerId} relayAccountLabel={relayAccountLabel}
              draft={runners} refineOn={refineOn} disabled={busy !== null}
              onChange={updateRunner} onRefine={(on) => { setRefineOn(on); setPreview(null); }} />
            <Hint>Required checks and your final review stay the same whoever runs the stages. A choice an assistant does not offer is refused before anything starts.</Hint>

            <SectionHead label="Model choice" />
            <div className="rl-start-meta">
              <label>
                <span className="label">Choose models</span>
                <select className="field" aria-label="Choose models" value={routing.mode}
                  onChange={event => updateRouting({ mode: event.target.value as RelayRoutingSettings['mode'] })}
                  disabled={busy !== null}>
                  <option value="auto">Suggest where I left the default</option>
                  <option value="manual">Only what I chose above</option>
                </select>
              </label>
              {!manual && <label>
                <span className="label">What matters most?</span>
                <select className="field" aria-label="What matters most?" value={routing.preference}
                  onChange={event => updateRouting({ preference: event.target.value as RelayRoutingSettings['preference'] })}
                  disabled={busy !== null}>
                  {RELAY_ROUTING_PREFERENCES.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>}
            </div>
            <Hint>{manual
              ? 'Each stage runs on what you chose above, or its assistant’s default. Nothing is asked of a suggester.'
              : RELAY_ROUTING_PREFERENCES.find(option => option.value === routing.preference)?.description}</Hint>
            {!manual && <Hint>When enabled, JEV suggests a model and effort for a stage you left at the default, within that stage’s assistant. The clean-up stage is never suggested for. An unchanged preview is reused when you create the relay, so you do not pay for the same suggestion twice.</Hint>}
            <button className={busy === 'preview' ? 'btn rl-guess-asking' : 'btn'} onClick={() => void suggest()}
                    disabled={busy !== null || !intent.trim() || !providerId}>
              {busy === 'preview' ? (manual ? 'Previewing…' : 'Asking…') : manual ? 'Preview my choices' : 'Suggest models'}
            </button>
            {/* A disabled control that does not say why reads as a broken one.
                This is the only reason it is ever disabled with a profile set. */}
            {!intent.trim() && providerId && (
              <Hint>{manual
                ? 'Say what the relay should accomplish first, then preview the stages.'
                : 'Say what the relay should accomplish first, and Suggest models will ask which model and effort fit each stage you left at the default.'}</Hint>
            )}

            {preview && !preview.asked && !manual && (
              <Note tone="info">
                No model suggestion was used. Each stage runs on what you chose or its assistant’s default.
                Enable JEV model suggestions in Settings to get model and effort recommendations.
              </Note>
            )}

            {preview && (
              <div className="rl-guess">
                <div className="rl-guess-head">
                  <span className="rl-guess-run">Would run {[...preview.phases.slice(0, preview.phases.indexOf('implement') + 1), ...(refineOn && preview.phases.includes('implement') ? ['refine' as const] : []), ...preview.phases.slice(preview.phases.indexOf('implement') + 1)].map((p) => STAGE_WORD[p]).join(' → ')}</span>
                  <span className="rl-guess-meta">
                    {preview.asked ? <>
                      Suggestion estimate: {preview.pipeline ? `${preview.pipeline.pipeline} · ` : ''}
                      {preview.estimatedUsd === null ? 'usage not reported' : `$${preview.estimatedUsd.toFixed(6)}`}
                    </> : manual ? 'Only what I chose · no suggestion call' : 'Assistant defaults · no suggestion call'}
                  </span>
                </div>

                <ol className="rl-guess-list">
                  {shownStages.map((key) => {
                    const row = preview.routes[key];
                    const dropped = !runsIn(key, preview.phases);
                    const proposed = row?.suggested ?? null;
                    const taken = row?.route.source === 'suggested';
                    const verdict = proposed ? (taken ? 'taken' : 'short') : undefined;
                    const shown = row?.route.model ?? null;
                    return (
                      <li key={key} className="rl-guess-row" data-verdict={verdict} data-dropped={dropped || undefined}>
                        <span className="rl-guess-stage">{STAGE_WORD[key]}</span>
                        <span className="rl-guess-pick">
                          {dropped ? 'not run' : shown ?? 'assistant default'}
                          {!dropped && row?.route.effort && <em> · {row.route.effort} effort</em>}
                        </span>
                        {proposed ? (
                          <>
                            <progress value={proposed.confidence} max={1}
                              aria-label={`${STAGE_WORD[key]} suggestion confidence`} />
                            <span className="rl-guess-num">{proposed.confidence.toFixed(2)}</span>
                          </>
                        ) : <><span /><span className="rl-guess-num">—</span></>}
                        {/* The router's own sentence, which says who decided and
                            why — including a proposal it declined. */}
                        {row && <p className="rl-guess-why">{row.route.reason}</p>}
                        {dropped && preview.pipeline && (
                          <p className="rl-guess-why">
                            Proposed away by “{preview.pipeline.pipeline}” at confidence {preview.pipeline.confidence.toFixed(2)}.
                            The stages that check the work cannot be proposed away.
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ol>

                <p className="rl-guess-foot">
                  {preview.asked ? <>
                    Suggestions need at least {DEFAULT_MIN_CONFIDENCE.toFixed(2)} confidence. Below that, the assistant’s default is kept.
                    Creating the relay records this preview. It expires after 15 minutes or when your choices change. Confidence is not a measured chance of success.
                  </> : manual
                    ? 'These are your choices and the assistant defaults. Creating the relay records them without a suggestion call.'
                    : 'These are your choices and the assistant defaults. Creating the relay reuses this preview.'}
                </p>
              </div>
            )}
            <div className="rl-automation-options">
            <SectionHead label="How work progresses" />
            <label><input type="checkbox" checked={automatic} disabled={busy !== null}
              onChange={event => { setAutomatic(event.target.checked); setPreview(null); }} /> Advance automatically until final review</label>
            {automatic ? <>
              <label><span className="label">Agent spending limit (USD)</span>
                <input className="field" type="number" min="0.01" max="100000" step="0.01" value={budget}
                  placeholder="Choose a limit" disabled={busy !== null} onChange={event => setBudget(event.target.value)} />
              </label>
              <Hint>Starts ready stages, advances an accepted plan and verified work, and runs verification without a model. Failed checks may go back to the agent within the retry limit. Plan permission prompts and final review still need you.</Hint>
              <Hint>Stops new agent turns at the limit or when earlier cost is unreported. A running turn may exceed the limit; this is not a provider billing cap. Model suggestions are accounted for separately.</Hint>
            </> : <Hint>You start and advance each stage. Required checks still apply.</Hint>}
            </div>
            <ModelEconomics />

            <div className="rl-delivery-choice">
              <label><input type="checkbox" checked={delivery} disabled={busy !== null} onChange={event => setDelivery(event.target.checked)} /> Include git commit and deploy stages</label>
              <Hint>{delivery
                ? 'After review, explicitly commit the approved work and run your project’s deployment command. Configure the command in Deploy details after creating the relay. Neither action runs automatically.'
                : 'This relay will finish at the review decision.'}</Hint>
            </div>
            <div className="rl-start-actions"><button className="btn btn-primary" onClick={() => void create()} disabled={busy !== null || !intent.trim() || !providerId || !projectId || accountOptions === null || (automatic && (!Number.isFinite(Number(budget)) || Number(budget) <= 0 || Number(budget) > 100000))}>
              {busy === 'create' ? 'Creating…' : automatic ? 'Create and start relay' : 'Create relay'}
            </button>
            {onCancel && <button className="btn" disabled={busy !== null} onClick={onCancel}>Back to relay</button>}
            <span className="faint">{automatic ? 'Starts work with the allowance above. You make the final review decision.' : 'Creating records the stages without launching a session.'}</span>
            </div>
          </Section>

  </div>;
}
