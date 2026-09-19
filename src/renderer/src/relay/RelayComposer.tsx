import { PromptField } from '../prompt-actions/PromptField';
import { useEffect, useRef, useState } from 'react';
import type { AgentAccount, DocketNodeKind, ProviderInfo, RelayPreview, RelayRead, RelayRouteInput } from '@shared/types';
import { DEFAULT_MIN_CONFIDENCE } from '@shared/relay-route';
import { DEFAULT_RELAY_ROUTING, RELAY_ROUTING_PREFERENCES, type RelayRoutingSettings } from '@shared/relay-routing';
import { Explainer, Hint, Note, Section, SectionHead } from '../components/bits';
import { useViewMemory } from '../components/viewMemory';
import { AGENT_KINDS, KIND_WORD } from './facts';

const INHERIT_NONE = '\u0000none';

type RouteDraft = Record<string, { providerId: string; model: string; effort: string; accountId: string }>;

const emptyDraft = (providerId: string): RouteDraft =>
  Object.fromEntries(AGENT_KINDS.map((kind) => [kind, { providerId, model: '', effort: '', accountId: '' }]));

function toRoutes(draft: RouteDraft, fallback: string): RelayRouteInput {
  const routes: RelayRouteInput = {};
  for (const kind of AGENT_KINDS) {
    const row = draft[kind];
    if (!row) continue;
    const entry: { providerId?: string; model?: string; effort?: string; accountId?: string | null } = {};
    if (row.providerId && row.providerId !== fallback) entry.providerId = row.providerId;
    // null is sent deliberately: it is the one way to say "not the relay's
    // account" without naming a different one.
    if (row.accountId === INHERIT_NONE) entry.accountId = null;
    else if (row.accountId) entry.accountId = row.accountId;
    if (row.model.trim()) entry.model = row.model.trim();
    if (row.effort.trim()) entry.effort = row.effort.trim();
    if (Object.keys(entry).length) routes[kind] = entry;
  }
  return routes;
}

export default function RelayComposer({ projectId, providers, active, onCreated, onCancel, onPendingChange }: {
  projectId: string | null; providers: ProviderInfo[]; active: boolean;
  onCreated: (read: RelayRead) => void; onCancel?: () => void; onPendingChange: (pending: boolean) => void;
}) {
  const [intent, setIntent] = useState('');
  const [delivery, setDelivery] = useState(true);
  const [routing, setRouting] = useViewMemory<RelayRoutingSettings>('composer-routing', { ...DEFAULT_RELAY_ROUTING });
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const [draft, setDraft] = useState<RouteDraft>(() => emptyDraft(providers[0]?.id ?? ''));
  const [accountId, setAccountId] = useState('');
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountRetry, setAccountRetry] = useState(0);
  const [accountOptions, setAccountOptions] = useState<AgentAccount[] | null>(null);
  const [preview, setPreview] = useState<RelayPreview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const intentEl = useRef<HTMLTextAreaElement>(null);
  const pending = useRef(false);
  const manual = routing.mode === 'manual';

  useEffect(() => { if (active) intentEl.current?.focus(); }, [active]);
  useEffect(() => {
    if (!providerId && providers[0]) { setProviderId(providers[0].id); setDraft(emptyDraft(providers[0].id)); }
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

  const updateDraft = (kind: DocketNodeKind, patch: Partial<RouteDraft[string]>) => {
    setDraft((value) => ({ ...value, [kind]: { ...value[kind], ...patch } }));
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
      routing, routes: toRoutes(draft, providerId) }));
  });
  const create = () => act('create', async () => {
    if (!projectId) throw new Error('Choose a project before creating a relay.');
    const next = await window.wanigan.relay.create({ projectId, intent: intent.trim(), providerId,
      routing, routes: toRoutes(draft, providerId), accountId: accountId || undefined, delivery });
    setIntent(''); setPreview(null); onCreated(next);
  });
  const stageFields = <>
    <p>
      {manual ? 'Leave a field empty to use the profile default.'
        : 'Leave a field empty to use the profile default or an enabled routing suggestion.'}
      {' '}An override uses exactly the model or effort you enter.
    </p>
    <p>Use a model and effort supported by the selected profile. Invalid choices are refused before a session starts.</p>
    {AGENT_KINDS.map((kind) => (
      <div key={kind} className="row2">
        <label>
          <span className="label">{KIND_WORD[kind]} model</span>
          <input className="field" aria-label={`${KIND_WORD[kind]} model override`} value={draft[kind]?.model ?? ''}
            onChange={(e) => updateDraft(kind, { model: e.target.value })}
            placeholder="profile default" disabled={busy !== null} />
        </label>
        <label>
          <span className="label">{KIND_WORD[kind]} effort</span>
          <input className="field" aria-label={`${KIND_WORD[kind]} effort override`} value={draft[kind]?.effort ?? ''}
            onChange={(e) => updateDraft(kind, { effort: e.target.value })}
            placeholder="profile default" disabled={busy !== null} />
        </label>
        {accountOptions !== null && accountOptions.length > 0 && (
          <label>
            <span className="label">{KIND_WORD[kind]} account</span>
            <select className="field" aria-label={`${KIND_WORD[kind]} account override`}
              value={draft[kind]?.accountId ?? ''}
              onChange={(e) => updateDraft(kind, { accountId: e.target.value })}
              disabled={busy !== null}>
              <option value="">{accountId ? 'Same as the relay' : 'This project’s account'}</option>
              {accountId && <option value={INHERIT_NONE}>Not the relay’s — resolve normally</option>}
              {accountOptions.map((row) => (
                <option key={row.id} value={row.id}>{row.label}</option>
              ))}
            </select>
          </label>
        )}
      </div>
    ))}
  </>;
  return <div className="rl-composer" hidden={!active}>
    {error && <Note tone="error" onDismiss={() => setError(null)}>{error}</Note>}
    {providers.length === 0 && <Note tone="warn">Connect an agent profile in Settings before creating a relay.</Note>}
          <Section title="Create a relay" hint="Describe the outcome, choose who will work on it, then create the stages. You start the first stage separately.">
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
            <div className="rl-start-meta">
            <label>
              <span className="label">Profile</span>
              <select className="field" aria-label="Profile for this relay" value={providerId}
                onChange={(e) => {
                  setProviderId(e.target.value);
                  setDraft(emptyDraft(e.target.value)); setPreview(null);
                  // The account belonged to the old profile's harness; keeping
                  // it would offer a pin the new one cannot honour.
                  setAccountId('');
                }} disabled={busy !== null}>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </label>
            {/* Which account pays. Agent stages start hours apart, so leaving
                this to whatever the project defaults to by then is how a relay
                bills an account nobody chose — under a forecast whose whole
                purpose is knowing the cost first. */}
            {accountError ? (
              <Note tone="error" action={{ label: 'Retry accounts', run: () => setAccountRetry((value) => value + 1) }}>
                Could not read this profile’s accounts. {accountError}
              </Note>
            ) : accountOptions === null ? (
              <p className="faint">Reading the accounts this profile can use…</p>
            ) : accountOptions.length === 0 ? (
              <Hint>This profile uses its current login. Separate accounts are unavailable.</Hint>
            ) : (
              <label>
                <span className="label">Account</span>
                <select className="field" aria-label="Account every phase of this relay launches as" value={accountId}
                  onChange={(e) => { setAccountId(e.target.value); setPreview(null); }} disabled={busy !== null}>
                  <option value="">This project’s account, then the default</option>
                  {accountOptions.map((row) => (
                    <option key={row.id} value={row.id}>{row.label}{row.isDefault ? ' (default)' : ''}</option>
                  ))}
                </select>
              </label>
            )}
            </div>
            <div className="rl-start-meta">
              <label>
                <span className="label">Routing</span>
                <select className="field" aria-label="Relay routing mode" value={routing.mode}
                  onChange={event => updateRouting({ mode: event.target.value as RelayRoutingSettings['mode'] })}
                  disabled={busy !== null}>
                  <option value="auto">Auto</option>
                  <option value="manual">Manual</option>
                </select>
              </label>
              {!manual && <label>
                <span className="label">Auto preference</span>
                <select className="field" aria-label="Auto routing preference" value={routing.preference}
                  onChange={event => updateRouting({ preference: event.target.value as RelayRoutingSettings['preference'] })}
                  disabled={busy !== null}>
                  {RELAY_ROUTING_PREFERENCES.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>}
            </div>
            <Hint>{manual
              ? 'Use the profile defaults or choose a model and effort for each stage. Manual routing makes no JEV call.'
              : RELAY_ROUTING_PREFERENCES.find(option => option.value === routing.preference)?.description}</Hint>
            <Hint>Required tests and human review stay the same for every routing choice.</Hint>
            {!manual && <Hint>When enabled, JEV suggests models and effort within this profile. Suggesting routes and creating a relay each call it and may incur a cost. You can override any stage.</Hint>}
            <button className={busy === 'preview' ? 'btn rl-guess-asking' : 'btn'} onClick={() => void suggest()}
                    disabled={busy !== null || !intent.trim() || !providerId}>
              {busy === 'preview' ? (manual ? 'Previewing…' : 'Asking…') : manual ? 'Preview routes' : 'Suggest routes'}
            </button>
            {/* A disabled control that does not say why reads as a broken one.
                This is the only reason it is ever disabled with a profile set. */}
            {!intent.trim() && providerId && (
              <Hint>{manual
                ? 'Say what the relay should accomplish first, then preview the stage defaults and overrides.'
                : 'Say what the relay should accomplish first, and Suggest routes will ask which model and effort fit each phase.'}</Hint>
            )}

            {preview && !preview.asked && !manual && (
              <Note tone="info">
                No routing suggestion was used. Each stage will use the profile defaults or your overrides.
                Enable the routing suggester in Settings to get model and effort recommendations.
              </Note>
            )}

            {preview && (
              <div className="rl-guess">
                <div className="rl-guess-head">
                  <span className="rl-guess-run">Would run {preview.phases.map((p) => KIND_WORD[p]).join(' → ')}</span>
                  <span className="rl-guess-meta">
                    {preview.asked ? <>
                      Suggestion estimate: {preview.pipeline ? `${preview.pipeline.pipeline} · ` : ''}
                      {preview.estimatedUsd === null ? 'usage not reported' : `$${preview.estimatedUsd.toFixed(6)}`}
                    </> : manual ? 'Manual · no suggestion call' : 'Profile defaults · no suggestion call'}
                  </span>
                </div>

                <ol className="rl-guess-list">
                  {AGENT_KINDS.map((kind) => {
                    const row = preview.routes[kind];
                    const dropped = !preview.phases.includes(kind);
                    const proposed = row?.suggested ?? null;
                    const taken = row?.route.source === 'suggested';
                    const verdict = proposed ? (taken ? 'taken' : 'short') : undefined;
                    const shown = row?.route.model ?? null;
                    return (
                      <li key={kind} className="rl-guess-row" data-verdict={verdict} data-dropped={dropped || undefined}>
                        <span className="rl-guess-stage">{KIND_WORD[kind]}</span>
                        <span className="rl-guess-pick">
                          {dropped ? 'not run' : shown ?? 'profile default'}
                          {!dropped && row?.route.effort && <em> · {row.route.effort} effort</em>}
                        </span>
                        {proposed ? (
                          <>
                            <progress value={proposed.confidence} max={1}
                              aria-label={`${KIND_WORD[kind]} suggestion confidence`} />
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
                    Suggestions need at least {DEFAULT_MIN_CONFIDENCE.toFixed(2)} confidence. Below that, the profile default is kept.
                    Creating the relay asks again and records the result. You can override any agent stage below.
                  </> : manual
                    ? 'These are the profile defaults and your stage overrides. Creating the relay records these routes without a suggestion call.'
                    : 'These are the profile defaults and your stage overrides. Auto checks the routing suggester again when you create the relay.'}
                </p>
              </div>
            )}
            {manual ? <>
              <SectionHead label="Stage models and effort" />
              {stageFields}
            </> : <Explainer id="relay-overrides" title="Choose the model and effort for a stage yourself" defaultHidden>
              {stageFields}
            </Explainer>}

            <div className="rl-delivery-choice">
              <label><input type="checkbox" checked={delivery} disabled={busy !== null} onChange={event => setDelivery(event.target.checked)} /> Include git commit and deploy stages</label>
              <Hint>{delivery
                ? 'After review, explicitly commit the approved work and run your project’s deployment command. Configure the command in Deploy details after creating the relay. Neither action runs automatically.'
                : 'This relay will finish at the review decision.'}</Hint>
            </div>
            <div className="rl-start-actions"><button className="btn btn-primary" onClick={() => void create()} disabled={busy !== null || !intent.trim() || !providerId || !projectId || accountOptions === null}>
              {busy === 'create' ? 'Creating…' : 'Create relay'}
            </button>
            {onCancel && <button className="btn" disabled={busy !== null} onClick={onCancel}>Back to relay</button>}
            <span className="faint">Creating records the stages without launching a session.</span>
            </div>
          </Section>

  </div>;
}
