// Starting a session from the phone: project, agent, account (with what each
// plan has left), model (local ones too), and a card or none. Started on the
// Mac, in the project's folder, exactly as the Mac's New session starts it.
import { useEffect, useState } from 'react';
import { PROVIDERS, type Provider } from '@shared/model';
import { parseLocalModel } from '@shared/local-models';
import { Select } from '../components/Select';
import { LimitsLeft } from '../components/LimitsLeft';
import { Button, Segmented, useToast } from '../components/ui';
import { attempt, call, useQuery } from '../lib/api';
import { accountOption } from '../lib/accounts';
import { PROVIDER_LABEL } from '../lib/format';
import { useNav } from './nav';

export function NewSessionScreen({ projectId: initialProject, cardId: initialCard }: { projectId?: string; cardId?: string }) {
  const nav = useNav();
  const toast = useToast();
  const projects = useQuery('projects.list', {}, ['projects']);
  const usable = (projects.data ?? []).filter((p) => p.pathOk && !p.pausedAt);
  const [projectId, setProjectId] = useState(initialProject ?? '');
  const project = usable.find((p) => p.id === projectId) ?? usable[0];
  const [provider, setProvider] = useState<Provider>('claude');
  const [accountId, setAccountId] = useState('');
  const [model, setModel] = useState('');
  const [cardId, setCardId] = useState(initialCard ?? '');
  const [busy, setBusy] = useState(false);
  const accounts = useQuery('accounts.list', {}, ['accounts']);
  const cards = useQuery('cards.list', project ? { projectId: project.id } : null, ['board']);
  const catalogue = useQuery('sessions.models', provider === 'shell' || !project ? null : { provider, projectId: project.id }, ['accounts', 'local']);
  useEffect(() => { setAccountId(''); setModel(project?.localModel && provider !== 'shell' ? project.localModel : ''); }, [provider, project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (projects.data && !usable.length) return <p className="phone-empty">Open a project on your Mac first.</p>;
  if (!project) return null;
  const forAgent = (accounts.data ?? []).filter((a) => a.provider === provider);
  const preferred = provider === 'claude' || provider === 'codex' ? project.accounts[provider] ?? forAgent.find((a) => a.isDefault)?.id : undefined;
  const chosen = forAgent.find((a) => a.id === (accountId || preferred));
  const open = (cards.data ?? []).filter((c) => (c.status === 'ready' || c.status === 'inbox' || c.id === initialCard) && !c.live);
  const models = (catalogue.data?.models ?? []).filter((m) => m.local?.ready !== false);

  const start = async (): Promise<void> => {
    setBusy(true);
    const s = await attempt(() => call('sessions.start', {
      projectId: project.id, provider, cardId: cardId || null, accountId: chosen?.id ?? null,
      ...(provider !== 'shell' ? { model: model || null } : {}), cols: 100, rows: 32,
    }), (m) => toast(m, 'error'));
    setBusy(false);
    if (s) nav.go({ name: 'session', id: s.id });
  };

  return (
    <section className="phone-form" aria-labelledby="new-title">
      <h1 id="new-title" className="phone-title">New session</h1>
      <label><span>Project</span>
        <Select value={project.id} onChange={(v) => { setProjectId(v); setCardId(''); }} label="Project" options={usable.map((p) => ({ value: p.id, label: `${p.name} (${p.key})` }))} />
      </label>
      <div className="phone-field"><span>Agent</span>
        <Segmented<Provider> label="Agent" value={provider} onChange={setProvider} options={PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABEL[p] }))} />
      </div>
      {forAgent.length ? (
        <label><span>Account</span>
          <Select value={chosen?.id ?? ''} onChange={setAccountId} label="Account" options={forAgent.map((a) => accountOption(a))} />
          {chosen && chosen.signedIn !== 'no' && !parseLocalModel(model) ? <LimitsLeft usage={chosen.usage} full /> : null}
        </label>
      ) : null}
      {provider !== 'shell' ? (
        <label><span>Model</span>
          <Select value={model} onChange={setModel} label="Model" options={[
            { value: '', label: 'Default', detail: 'What this account uses unless told otherwise' },
            ...models.map((m) => ({ value: m.value, label: m.label, ...(m.detail ? { detail: m.detail } : {}), ...(m.local ? { group: 'On this Mac' } : {}) })),
          ]} />
        </label>
      ) : null}
      <label><span>Card</span>
        <Select value={cardId} onChange={setCardId} label="Card" options={[{ value: '', label: 'None, a one-off session' }, ...open.map((c) => ({ value: c.id, label: `${c.key} ${c.title}` }))]} />
      </label>
      <Button tone="primary" icon="terminal" disabled={busy} onClick={start}>{busy ? 'Starting…' : `Start ${PROVIDER_LABEL[provider]}`}</Button>
    </section>
  );
}
