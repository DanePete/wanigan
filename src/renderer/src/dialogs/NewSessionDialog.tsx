import { useEffect, useState } from 'react';
import { Select } from '../components/Select';
import { PROVIDERS, type Provider, type ProjectSummary } from '@shared/model';
import { attempt, call, useQuery } from '../lib/api';
import { navigate } from '../lib/router';
import { PROVIDER_LABEL } from '../lib/format';
import { Button, Dialog, Field, Segmented, useToast } from '../components/ui';
import { accountOption } from '../lib/accounts';
import { InstallHint } from '../components/Install';
import { LimitsLeft } from '../components/LimitsLeft';
import { RUNTIME_LABEL, moduleFor, parseLocalModel } from '@shared/local-models';
import type { ModelChoice } from '@shared/models';

const LAST_PROVIDER = 'wanigan.lastProvider';
/** The last model and effort chosen for each agent, so the next session starts the same way. */
const LAST_CHOICE = 'wanigan.lastModel';

interface Choice { model: string; effort: string }

const OTHER = '\u0000other';
const EFFORT_LABEL: Record<string, string> = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

function readChoice(provider: Provider): Choice {
  try {
    const all = JSON.parse(localStorage.getItem(LAST_CHOICE) ?? '{}') as Record<string, Partial<Choice>>;
    const c = all[provider] ?? {};
    return { model: typeof c.model === 'string' ? c.model : '', effort: typeof c.effort === 'string' ? c.effort : '' };
  } catch {
    return { model: '', effort: '' };
  }
}

/** The agent a project's local model runs under: its module's, or none to keep the one chosen. */
function localAgent(value: string | null | undefined): Provider | null {
  const local = parseLocalModel(value);
  return local ? moduleFor(local.runtime, local.id)?.agent ?? null : null;
}

/** Where a session starts: the project's local model when it has one, else the last choice for the agent. */
function startingChoice(provider: Provider, project: ProjectSummary | undefined): Choice {
  if (project?.localModel && provider !== 'shell') return { model: project.localModel, effort: '' };
  return readChoice(provider);
}

/** What a local model in the picker means, said under it. */
function localHint(m: ModelChoice | undefined, agent: string): string | undefined {
  if (!m?.local) return undefined;
  const where = `Runs on this Mac through ${RUNTIME_LABEL[m.local.runtime]}; nothing is sent to a model provider. The first start loads it, which can take a minute.`;
  return m.local.proven ? where : `${where} Not yet proven with ${agent}: it may not use tools reliably.`;
}

function writeChoice(provider: Provider, choice: Choice): void {
  try {
    const all = JSON.parse(localStorage.getItem(LAST_CHOICE) ?? '{}') as Record<string, Choice>;
    localStorage.setItem(LAST_CHOICE, JSON.stringify({ ...all, [provider]: choice }));
  } catch { /* a convenience only */ }
}

export function NewSessionDialog({ projects, initial, onClose }: {
  projects: ProjectSummary[];
  initial: { projectId?: string; cardId?: string };
  onClose: () => void;
}) {
  const toast = useToast();
  const [projectId, setProjectId] = useState(initial.projectId ?? projects[0]?.id ?? '');
  const [provider, setProvider] = useState<Provider>(() => {
    const fromProject = localAgent(projects.find((p) => p.id === (initial.projectId ?? projects[0]?.id))?.localModel);
    if (fromProject) return fromProject;
    try { const v = localStorage.getItem(LAST_PROVIDER); return PROVIDERS.includes(v as Provider) ? (v as Provider) : 'claude'; } catch { return 'claude'; }
  });
  const [cardId, setCardId] = useState(initial.cardId ?? '');
  const [busy, setBusy] = useState(false);
  const cards = useQuery('cards.list', projectId ? { projectId } : null, ['board']);
  const accounts = useQuery('accounts.list', {}, ['accounts']);
  const [accountId, setAccountId] = useState('');
  const [isolate, setIsolate] = useState<boolean | null>(null);
  // Off unless the owner turns it on, every time: it hands the session to Anthropic's relay.
  const [remote, setRemote] = useState(false);
  const available = (cards.data ?? []).filter((c) => (c.status === 'ready' || c.status === 'inbox' || c.id === initial.cardId) && !c.live);
  const project = projects.find((p) => p.id === projectId);
  const forAgent = provider === 'shell' ? [] : (accounts.data ?? []).filter((a) => a.provider === provider);
  const preferred = provider === 'claude' || provider === 'codex' ? project?.accounts[provider] ?? forAgent.find((a) => a.isDefault)?.id : undefined;
  const chosen = forAgent.find((a) => a.id === (accountId || preferred));
  // Said before Start, not after: the core would refuse with the same words.
  const missing = provider !== 'shell' && forAgent.length > 0 && forAgent.every((a) => !a.installed) ? provider : null;
  const card = available.find((c) => c.id === cardId);
  const ownBranch = card?.worktree ? true : (isolate ?? !!project?.isolate);
  // Model and effort: the agent's own list, read as the chosen account.
  const catalogue = useQuery('sessions.models', provider === 'shell' ? null : { provider, accountId: chosen?.id ?? null, projectId: projectId || null }, ['accounts', 'local']);
  const [choice, setChoice] = useState<Choice>(() => startingChoice(provider, project));
  const [typed, setTyped] = useState<string | null>(null);
  useEffect(() => { setTyped(null); }, [provider]);
  useEffect(() => { setChoice(startingChoice(provider, project)); }, [provider, project?.id, project?.localModel]); // eslint-disable-line react-hooks/exhaustive-deps
  // A project that starts on a local model starts on its agent too.
  useEffect(() => { const agent = localAgent(project?.localModel); if (agent) setProvider(agent); }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const models = catalogue.data?.models ?? [];
  const model = models.find((m) => m.value === choice.model);
  // A model the list no longer offers is dropped rather than sent, and a local
  // model is sent only once it is on this Mac.
  const modelValue = typed !== null ? typed.trim() : (model && model.local?.ready !== false) || (!model && catalogue.data?.source !== 'live' && choice.model && !parseLocalModel(choice.model)) ? choice.model : '';
  // A local model takes no effort setting.
  const efforts = model?.local ? [] : model?.efforts ?? catalogue.data?.efforts ?? [];
  const effortValue = efforts.includes(choice.effort) ? choice.effort : '';

  useEffect(() => { if (projectId !== initial.projectId) setCardId(''); }, [projectId, initial.projectId]);
  // Opened before the projects arrived (one was just added): take the first once they do.
  useEffect(() => { if (!projectId && projects[0]) setProjectId(initial.projectId ?? projects[0].id); }, [projects, projectId, initial.projectId]);
  useEffect(() => { setAccountId(''); }, [provider, projectId]);

  const start = async (): Promise<void> => {
    if (!projectId || busy || !project) return;
    setBusy(true);
    try { localStorage.setItem(LAST_PROVIDER, provider); } catch { /* convenience only */ }
    if (provider !== 'shell') writeChoice(provider, { model: modelValue, effort: effortValue });
    const session = await attempt(
      () => call('sessions.start', {
        projectId, provider, cardId: cardId || null, accountId: chosen?.id ?? null,
        ...(provider !== 'shell' ? { model: modelValue || null, effort: effortValue || null } : {}),
        ...(provider === 'claude' && remote ? { remote: true } : {}),
        ...(card && project?.git ? { isolate: ownBranch } : {}), cols: 120, rows: 32,
      }),
      (m) => toast(m, 'error'),
    );
    setBusy(false);
    if (!session) return;
    onClose();
    navigate({ name: 'session', projectKey: project.key, sessionId: session.id });
  };

  if (!projects.length) {
    return (
      <Dialog title="New session" onClose={onClose}>
        <p>Open a project first; a session runs inside a project folder.</p>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="New session"
      onClose={onClose}
      footer={<><Button tone="quiet" onClick={onClose}>Cancel</Button><Button tone="primary" icon="terminal" data-autofocus onClick={() => start()} disabled={busy || !project?.pathOk || !!project?.pausedAt}>Start {PROVIDER_LABEL[provider]}</Button></>}
    >
      <form onSubmit={(e) => { e.preventDefault(); void start(); }}>
        <Field label="Project">{(id) => (
          <Select id={id} value={projectId} onChange={setProjectId}
            options={projects.map((p) => ({ value: p.id, label: `${p.name} (${p.key})`, disabled: !p.pathOk, ...(p.pathOk ? {} : { detail: 'Folder missing' }) }))} />
        )}</Field>
        <div className="field"><span className="field-label">Agent</span>
          <Segmented<Provider> label="Agent" value={provider} onChange={setProvider} options={PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABEL[p] }))} />
          {missing ? <p className="field-hint" role="status">{PROVIDER_LABEL[missing]} is not installed. <InstallHint cli={missing} /></p> : null}
        </div>
        {forAgent.length ? (
          <Field label="Account" hint={chosen?.signedIn === 'no' ? 'This account is signed out. Sign it in from Accounts first, or pick another.' : undefined}>{(id) => (
            <Select id={id} value={chosen?.id ?? ''} onChange={setAccountId}
              // What each plan has left, so the session goes where there is room.
              options={forAgent.map((a) => accountOption(a, `${a.label}${a.id === preferred && project?.accounts[provider as 'claude' | 'codex'] ? ' · this project’s' : ''}`))} />
          )}</Field>
        ) : null}
        {chosen && chosen.signedIn !== 'no' && !parseLocalModel(modelValue) ? (
          <div className="account-limits" aria-label={`What ${chosen.label} has left`}><LimitsLeft usage={chosen.usage} full /></div>
        ) : null}
        {provider !== 'shell' ? (
          <div className="model-row">
            <Field label="Model" hint={localHint(model, PROVIDER_LABEL[provider]) ?? catalogue.data?.note ?? undefined}>{(id) => (
              <>
                <Select id={id} value={typed !== null ? OTHER : modelValue} onChange={(v) => {
                  if (v === OTHER) { setTyped(choice.model && !model ? choice.model : ''); return; }
                  setTyped(null);
                  setChoice((c) => ({ ...c, model: v }));
                }}
                  options={[
                    { value: '', label: 'Default', detail: 'What this account uses unless told otherwise' },
                    ...models.filter((m) => !m.local).map((m) => ({ value: m.value, label: m.label, ...(m.detail ? { detail: m.detail } : m.isDefault ? { detail: 'Codex’s default' } : {}) })),
                    { value: OTHER, label: 'Another model…', detail: 'Type an alias or a full model name' },
                    ...models.filter((m) => m.local).map((m) => ({
                      value: m.value, label: m.label, group: 'On this Mac', disabled: !m.local?.ready,
                      ...(m.detail ? { detail: m.detail } : {}),
                    })),
                  ]} />
                {typed !== null ? (
                  <input className="model-other" aria-label="Model name" placeholder={provider === 'claude' ? 'claude-opus-5-5' : provider === 'gemini' ? 'gemini-2.5-pro' : 'gpt-5.5'} value={typed} autoFocus
                    onChange={(e) => { setTyped(e.target.value); setChoice((c) => ({ ...c, model: e.target.value.trim() })); }} />
                ) : null}
              </>
            )}</Field>
            {efforts.length ? (
              <div className="field"><span className="field-label">Effort</span>
                <Segmented<string> label="Effort" size="s" value={effortValue} onChange={(effort) => setChoice((c) => ({ ...c, effort }))}
                  options={[{ value: '', label: 'Default' }, ...efforts.map((e) => ({ value: e, label: EFFORT_LABEL[e] ?? e }))]} />
              </div>
            ) : null}
          </div>
        ) : null}
        <Field label="Card" hint={cardId ? 'The session takes this card: it moves to Working and the agent is told about it.' : 'A one-off session: just a terminal. You can make it a card later.'}>{(id) => (
          <Select id={id} value={cardId} onChange={setCardId}
            options={[{ value: '', label: 'None, a one-off session' }, ...available.map((c) => ({ value: c.id, label: `${c.key} ${c.title}` }))]} />
        )}</Field>
        {card && project?.git ? (
          card.worktree ? (
            <p className="faint small">{card.key} works on its own branch, <span className="mono">{card.worktree.branch}</span>.</p>
          ) : (
            <label className="check-row">
              <input type="checkbox" checked={ownBranch} onChange={(e) => setIsolate(e.target.checked)} />
              <span>
                On its own branch
                <span className="faint small"> — a separate checkout (git worktree), so other sessions cannot touch its files. You merge it after review.</span>
              </span>
            </label>
          )
        ) : null}
        {provider === 'claude' ? (
          <label className="check-row">
            <input type="checkbox" checked={remote} onChange={(e) => setRemote(e.target.checked)} />
            <span>
              Reach this session from the Claude app (Remote Control)
              <span className="faint small"> — Anthropic relays the session, under its title. Claude may refuse if the account is not eligible.</span>
            </span>
          </label>
        ) : null}
        {project?.pausedAt ? <p className="small">{project.name} is paused. Resume it to start sessions here.</p> : null}
        {project ? <p className="faint small mono">{project.path}</p> : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
