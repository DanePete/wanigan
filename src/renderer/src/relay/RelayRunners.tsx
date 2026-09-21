import { useEffect, useState } from 'react';
import type { AgentAccount, LaunchModelCatalogue, ProviderInfo, RelayStageKey } from '@shared/types';
import { intersectChoices, launchFieldChoices } from '@shared/launch-fields';
import { Hint } from '../components/bits';
import { STAGE_WORD } from './facts';

/**
 * Who runs each stage of a relay.
 *
 * A relay is a chain of stages, and the operator's question about it is not
 * "which model" but "who does what": a cheap or local assistant can build, a
 * stronger one can clean up after it, and every one of them has an account
 * that pays. This is that question asked once per stage, on one rail, with
 * the answer written in words a person reads — "Codex · local (PAIR) · Work ·
 * gpt-oss 20B" — and a form under it that offers only what the chosen
 * assistant actually declares: its accounts, its live model list, and the
 * effort levels that model declares. Nothing is typed from memory.
 *
 * The rail shows every stage, the two that run no agent included, because a
 * relay the operator cannot see whole is a relay they cannot reason about. The
 * estimate and verify stages say what runs them instead; the review stage
 * says who decides.
 *
 * The draft is the renderer's; main validates every choice again before a
 * row is written, and refuses a model or effort the profile does not declare.
 */

/** The stages an operator can put a runner on. */
export type RunnerKey = Extract<RelayStageKey, 'plan' | 'implement' | 'refine'>;
export const RUNNER_KEYS: readonly RunnerKey[] = ['plan', 'implement', 'refine'];

/** The rail, in order. */
const RAIL: readonly RelayStageKey[] = ['plan', 'estimate', 'implement', 'refine', 'verify', 'review'];

export type RunnerDraft = { providerId: string; model: string; effort: string; accountId: string };
export type RunnersDraft = Record<RunnerKey, RunnerDraft>;

/** The one way to say "not the relay's account" without naming another. */
export const INHERIT_NONE = '\u0000none';

export const emptyRunners = (): RunnersDraft =>
  ({ plan: blank(), implement: blank(), refine: blank() });
const blank = (): RunnerDraft => ({ providerId: '', model: '', effort: '', accountId: '' });

const BLURB: Record<RelayStageKey, string> = {
  plan: 'Reads the outcome, maps the change and names the risks. Makes no edits.',
  estimate: 'Wanigan prices the stages ahead from this project’s own history. No model runs.',
  implement: 'Builds the change in an isolated worktree.',
  refine: 'A second assistant reads the build against the outcome, fixes what is wrong and tidies. Optional.',
  verify: 'Runs the project’s checks on the tree as it stands. No model runs.',
  review: 'You decide: approve, request changes, or reject.',
};

/** What is known about one assistant, read once and kept for the form's life. */
type ProviderFacts = {
  accounts: AgentAccount[] | null;
  catalogue: LaunchModelCatalogue | null;
  error: string | null;
};

/** A backend that costs nothing to run and lives on this machine or its LAN. */
export const isLocalProvider = (provider: Pick<ProviderInfo, 'backendId'>): boolean => provider.backendId === 'pair';

export default function RelayRunners({ providers, relayProviderId, relayAccountLabel, draft, refineOn, disabled, onChange, onRefine }: {
  providers: ProviderInfo[];
  relayProviderId: string;
  /** The relay-level account's label, or null when stages resolve the ordinary way. */
  relayAccountLabel: string | null;
  draft: RunnersDraft;
  refineOn: boolean;
  disabled: boolean;
  onChange: (key: RunnerKey, patch: Partial<RunnerDraft>) => void;
  onRefine: (on: boolean) => void;
}) {
  const [open, setOpen] = useState<RunnerKey | null>(null);
  const [facts, setFacts] = useState<Record<string, ProviderFacts>>({});

  const providerOf = (key: RunnerKey): ProviderInfo | undefined =>
    providers.find((row) => row.id === (draft[key].providerId || relayProviderId));

  // Read an assistant's accounts and models the first time a stage resolves to
  // it, and never again for this form. A read that fails is shown as a failed
  // read on that stage rather than as an empty list.
  const inUse = [...new Set(RUNNER_KEYS.map((key) => providerOf(key)?.id).filter((id): id is string => !!id))];
  useEffect(() => {
    let live = true;
    for (const id of inUse) {
      if (facts[id]) continue;
      setFacts((value) => ({ ...value, [id]: { accounts: null, catalogue: null, error: null } }));
      void Promise.all([window.wanigan.accounts.listForProvider(id), window.wanigan.providers.modelCatalogue(id)])
        .then(([accounts, catalogue]) => { if (live) setFacts((value) => ({ ...value, [id]: { accounts, catalogue, error: null } })); })
        .catch((cause: unknown) => {
          if (live) setFacts((value) => ({ ...value, [id]: { accounts: [], catalogue: null, error: cause instanceof Error ? cause.message : String(cause) } }));
        });
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the set of assistants in use, which is what changes the reads
  }, [inUse.join('|')]);

  const summary = (key: RunnerKey): string => {
    const provider = providerOf(key);
    if (!provider) return 'No assistant chosen';
    const row = draft[key];
    const known = facts[provider.id];
    const account = row.accountId === INHERIT_NONE ? 'its usual account'
      : row.accountId ? (known?.accounts?.find((a) => a.id === row.accountId)?.label ?? 'chosen account')
        : relayAccountLabel ?? 'its usual account';
    const model = row.model ? (known?.catalogue?.rows.find((r) => r.value === row.model)?.label ?? row.model) : 'default model';
    const effort = row.effort ? ` · ${row.effort} effort` : '';
    return `${provider.label} · ${account} · ${model}${effort}`;
  };

  return (
    <ol className="rl-runners" aria-label="Who runs each stage">
      {RAIL.map((stage, index) => {
        const agent = (RUNNER_KEYS as readonly string[]).includes(stage);
        const key = stage as RunnerKey;
        const off = stage === 'refine' && !refineOn;
        const fixed = !agent;
        return (
          <li key={stage} className="rl-runner" data-fixed={fixed || undefined} data-off={off || undefined}>
            <div className="rl-runner-head">
              <span className="rl-runner-n" aria-hidden="true">{index + 1}</span>
              <span className="rl-runner-name">{STAGE_WORD[stage]}</span>
              <span className="rl-runner-summary">
                {stage === 'estimate' ? 'Wanigan, from history' : stage === 'verify' ? 'The project’s checks' : stage === 'review' ? 'You'
                  : off ? 'Not part of this relay' : summary(key)}
              </span>
              {stage === 'refine' && (
                <label className="rl-runner-toggle">
                  <input type="checkbox" checked={refineOn} disabled={disabled}
                    onChange={(event) => { onRefine(event.target.checked); if (!event.target.checked && open === 'refine') setOpen(null); }} />
                  Add this stage
                </label>
              )}
              {agent && !off && (
                <button type="button" className="btn btn-sm" aria-expanded={open === key}
                  aria-label={`Change who runs the ${STAGE_WORD[stage].toLowerCase()} stage`}
                  disabled={disabled} onClick={() => setOpen(open === key ? null : key)}>
                  {open === key ? 'Done' : 'Change'}
                </button>
              )}
            </div>
            <p className="rl-runner-blurb">{BLURB[stage]}</p>
            {agent && !off && open === key && (
              <RunnerFields stage={key} providers={providers} relayProviderId={relayProviderId} relayAccountLabel={relayAccountLabel}
                row={draft[key]} facts={facts[providerOf(key)?.id ?? '']} disabled={disabled} onChange={(patch) => onChange(key, patch)} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function RunnerFields({ stage, providers, relayProviderId, relayAccountLabel, row, facts, disabled, onChange }: {
  stage: RunnerKey; providers: ProviderInfo[]; relayProviderId: string; relayAccountLabel: string | null;
  row: RunnerDraft; facts: ProviderFacts | undefined; disabled: boolean; onChange: (patch: Partial<RunnerDraft>) => void;
}) {
  const word = STAGE_WORD[stage];
  const provider = providers.find((p) => p.id === (row.providerId || relayProviderId));
  const relayProvider = providers.find((p) => p.id === relayProviderId);
  const rows = facts?.catalogue?.rows ?? [];
  const chosen = rows.find((r) => r.value === row.model) ?? null;
  // The effort levels this assistant declares for the chosen model, or for any
  // of its models when none is chosen yet — the same intersection main uses.
  const levels = provider ? launchFieldChoices(provider, 'effort') : { supported: false as const };
  const efforts = !levels.supported ? []
    : chosen ? intersectChoices(levels.choices, chosen.efforts).map((c) => c.value)
      : levels.choices.map((c) => c.value);
  return (
    <div className="rl-runner-fields">
      <label>
        <span className="label">Assistant</span>
        <select className="field" aria-label={`${word} assistant`} value={row.providerId} disabled={disabled}
          onChange={(event) => onChange({ providerId: event.target.value, model: '', effort: '', accountId: '' })}>
          <option value="">Same as the relay{relayProvider ? ` (${relayProvider.label})` : ''}</option>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.label}{isLocalProvider(p) ? ' · local, unpriced' : ''}</option>)}
        </select>
      </label>
      <label>
        <span className="label">Account</span>
        {facts?.accounts === null || facts === undefined ? (
          <select className="field" aria-label={`${word} account`} disabled><option>Reading accounts…</option></select>
        ) : facts.accounts.length === 0 ? (
          <select className="field" aria-label={`${word} account`} disabled><option>Uses its current login</option></select>
        ) : (
          <select className="field" aria-label={`${word} account`} value={row.accountId} disabled={disabled}
            onChange={(event) => onChange({ accountId: event.target.value })}>
            <option value="">{row.providerId || !relayAccountLabel ? 'Its usual account' : `Same as the relay (${relayAccountLabel})`}</option>
            {!row.providerId && relayAccountLabel && <option value={INHERIT_NONE}>Not the relay’s — its usual account</option>}
            {facts.accounts.map((a) => <option key={a.id} value={a.id}>{a.label}{a.isDefault ? ' (default)' : ''}</option>)}
          </select>
        )}
      </label>
      <label>
        <span className="label">Model</span>
        {facts?.catalogue === null || facts === undefined ? (
          <select className="field" aria-label={`${word} model`} disabled><option>Reading models…</option></select>
        ) : (
          <select className="field" aria-label={`${word} model`} value={row.model} disabled={disabled}
            onChange={(event) => onChange({ model: event.target.value, effort: '' })}>
            <option value="">Assistant default</option>
            {rows.map((r) => <option key={r.value} value={r.value}>{r.label}{r.observed ? ' · seen running' : ''}</option>)}
          </select>
        )}
      </label>
      <label>
        <span className="label">Effort</span>
        <select className="field" aria-label={`${word} effort`} value={row.effort} disabled={disabled || efforts.length === 0}
          onChange={(event) => onChange({ effort: event.target.value })}>
          <option value="">{efforts.length === 0 ? 'Not offered here' : 'Default'}</option>
          {efforts.map((level) => <option key={level} value={level}>{level}</option>)}
        </select>
      </label>
      {facts?.error && <div className="rl-runner-note"><Hint>Could not read this assistant’s accounts or models: {facts.error}</Hint></div>}
      {facts?.catalogue?.note && !facts.error && <div className="rl-runner-note"><Hint>{facts.catalogue.note}</Hint></div>}
    </div>
  );
}
