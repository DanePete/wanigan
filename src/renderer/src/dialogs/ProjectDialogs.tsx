import { Select } from '../components/Select';
import { accountOption, accountWho } from '../lib/accounts';
import { useState } from 'react';
import { ACCOUNT_PROVIDERS, type AccountProvider, type ProjectSummary } from '@shared/model';
import { localModelLabel, localModelValue } from '@shared/local-models';
import { attempt, call, useQuery } from '../lib/api';
import { navigate } from '../lib/router';
import { plural } from '../lib/format';
import { Button, Dialog, Field, useToast } from '../components/ui';

const AGENT: Record<AccountProvider, string> = { claude: 'Claude Code', codex: 'Codex' };

export function PauseDialog({ project, onClose }: { project: ProjectSummary; onClose: () => void }) {
  const toast = useToast();
  const live = useQuery('sessions.list', { projectId: project.id, live: true }, ['sessions']);
  const agents = (live.data ?? []).filter((s) => s.provider !== 'shell').length;
  const shells = (live.data?.length ?? 0) - agents;
  const [wrapUp, setWrapUp] = useState(true);
  const pause = async (): Promise<void> => {
    const r = await attempt(() => call('projects.pause', { id: project.id, wrapUp }), (m) => toast(m, 'error'));
    if (!r) return;
    toast(r.asked ? `${project.name} paused. ${plural(r.asked, 'agent')} will be asked to wrap up when each is next idle.` : `${project.name} paused.`);
    onClose();
  };
  return (
    <Dialog title={`Pause ${project.name}?`} onClose={onClose}
      footer={<><Button tone="quiet" onClick={onClose}>Cancel</Button><Button tone="primary" icon="pause" onClick={() => pause()}>Pause project</Button></>}>
      <ul className="plain-list">
        <li>No new sessions start here, and agents cannot take new cards.</li>
        <li>Nothing running is stopped. Sessions keep going until they finish or you stop them.</li>
        <li>Resume at any time; everything picks up where it was.</li>
      </ul>
      {agents ? (
        <label className="check-row">
          <input type="checkbox" checked={wrapUp} onChange={(e) => setWrapUp(e.target.checked)} />
          <span>
            Ask the {plural(agents, 'live agent')} to wrap up
            <span className="faint small"> — each finishes its current step, notes where things stand on its card, and stops.</span>
          </span>
        </label>
      ) : null}
      {shells ? <p className="faint small">{plural(shells, 'shell')} will keep running as {shells === 1 ? 'it is' : 'they are'}.</p> : null}
    </Dialog>
  );
}

export function ProjectSettingsDialog({ project, onClose }: { project: ProjectSummary; onClose: () => void }) {
  const toast = useToast();
  const fail = (m: string): void => toast(m, 'error');
  const accounts = useQuery('accounts.list', {}, ['accounts']);
  const [name, setName] = useState(project.name);
  const [key, setKey] = useState(project.key);
  const [setup, setSetup] = useState(project.setupCommand ?? '');
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    const changed = name.trim() !== project.name || key.trim().toUpperCase() !== project.key;
    const setupChanged = setup.trim() !== (project.setupCommand ?? '');
    if (changed || setupChanged) {
      const r = await attempt(() => call('projects.update', {
        id: project.id, ...(changed ? { name: name.trim(), key: key.trim() } : {}), ...(setupChanged ? { setupCommand: setup.trim() } : {}),
      }), setError);
      if (!r) return;
      if (r.key !== project.key) navigate({ name: 'project', projectKey: r.key, view: 'board' });
    }
    onClose();
  };

  const setAccount = (provider: AccountProvider, accountId: string): void => {
    void attempt(() => call('projects.setAccount', { id: project.id, provider, accountId: accountId || null }), fail);
  };

  return (
    <Dialog title={`${project.name} settings`} onClose={onClose} width={560}
      footer={<><Button tone="quiet" onClick={onClose}>Cancel</Button><Button tone="primary" onClick={() => save()}>Save</Button></>}>
      <div className="field-row">
        <Field label="Name">{(id) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Key" hint="Prefixes card keys, like NS-12.">{(id) => (
          <input id={id} className="mono key-input" value={key} maxLength={6} onChange={(e) => setKey(e.target.value.toUpperCase())} />
        )}</Field>
      </div>
      <p className="faint small mono">{project.path}</p>

      {project.git ? (
        <label className="check-row">
          <input type="checkbox" checked={project.isolate}
            onChange={(e) => void attempt(() => call('projects.update', { id: project.id, isolate: e.target.checked }), fail)} />
          <span>
            Card sessions work on their own branch
            <span className="faint small"> — each card gets a git worktree, so agents on different cards never share files. You merge each one after review.</span>
          </span>
        </label>
      ) : null}
      {project.git ? (
        <Field label="Setup command" hint="Runs in each new card worktree as a shell session on the card, beside the agent, so you see it work or fail. Files the repository’s .worktreeinclude names and git ignores, such as .env, are copied in first. Kept in Wanigan, never in the repository.">{(id) => (
          <input id={id} className="mono" value={setup} maxLength={500} placeholder="npm install, ddev start, composer install…"
            onChange={(e) => setSetup(e.target.value)} />
        )}</Field>
      ) : null}

      <h3 className="dialog-section">Accounts</h3>
      <p className="faint small">New sessions here use these accounts. You can still pick another when starting a session.</p>
      {ACCOUNT_PROVIDERS.map((provider) => {
        const list = (accounts.data ?? []).filter((a) => a.provider === provider);
        const fallback = list.find((a) => a.isDefault);
        return (
          <Field key={provider} label={AGENT[provider]}>{(id) => (
            <Select id={id} value={project.accounts[provider] ?? ''} onChange={(v) => setAccount(provider, v)} options={[
              fallback ? { ...accountOption(fallback, 'Your default'), value: '', detail: [fallback.label, accountWho(fallback)].filter(Boolean).join(' · ') } : { value: '', label: 'Your default' },
              ...list.filter((a) => !a.isDefault).map((a) => accountOption(a)),
            ]} />
          )}</Field>
        );
      })}
      <LocalModelDefault project={project} />
      <h3 className="dialog-section">Close this project</h3>
      <p className="faint small">It leaves the rail; its cards, sessions and history are kept, and opening the folder again brings it all back. Nothing in the folder is touched.</p>
      <Button size="s" tone="danger" disabled={project.liveSessions > 0} title={project.liveSessions ? 'Stop its live sessions first' : undefined}
        onClick={() => attempt(() => call('projects.archive', { id: project.id }), setError).then((r) => {
          if (r) { toast(`${project.name} closed.`); onClose(); navigate({ name: 'needs' }); }
        })}>
        Close project
      </Button>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
    </Dialog>
  );
}

/**
 * The local model a project's new sessions start on. Shown only when there is
 * one on this Mac, or the project already has one set: optional, like the rest.
 */
function LocalModelDefault({ project }: { project: ProjectSummary }) {
  const toast = useToast();
  const status = useQuery('local.status', {}, ['local']);
  const s = status.data;
  const offered = s ? [
    ...s.lmstudio.models.map((m) => ({ value: localModelValue('lmstudio', m.id), label: localModelLabel(localModelValue('lmstudio', m.id)) ?? m.id, detail: 'LM Studio' })),
    ...s.ollama.models.map((m) => ({ value: localModelValue('ollama', m.id), label: m.id, detail: 'Ollama or NVIDIA PAIR' })),
  ] : [];
  if (!offered.length && !project.localModel) return null;
  const set = (value: string): void => {
    void attempt(() => call('projects.update', { id: project.id, localModel: value || null }), (m) => toast(m, 'error'));
  };
  const current = project.localModel && !offered.some((o) => o.value === project.localModel)
    ? [{ value: project.localModel, label: localModelLabel(project.localModel) ?? project.localModel, detail: 'Not on this Mac now' }] : [];
  return (
    <>
      <h3 className="dialog-section">Local model</h3>
      <p className="faint small">New sessions here start on this model, which runs on this Mac. You can still pick another when starting a session.</p>
      <Field label="Start new sessions on">{(id) => (
        <Select id={id} value={project.localModel ?? ''} onChange={set} options={[
          { value: '', label: 'The agent’s own model', detail: 'Claude’s or OpenAI’s, as the account uses' },
          ...current,
          ...offered.map((o) => ({ ...o, group: 'On this Mac' })),
        ]} />
      )}</Field>
    </>
  );
}
