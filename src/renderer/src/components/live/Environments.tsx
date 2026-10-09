// A site's hosted environments in the live view: the tabs (Local, then Dev,
// Test, Live as the host names them) and, in the site settings, what the
// project's files name, kept, renamed or added by the owner. Opening one sends
// requests to that site, only when the owner does; it opens read-only.
import { useState, type FormEvent } from 'react';
import type { LiveSite } from '@shared/live';
import type { LiveEnv, LiveEnvCandidate, LiveEnvs } from '@shared/live-envs';
import type { ProjectSummary } from '@shared/model';
import { attempt, call, forProject, useQuery } from '../../lib/api';
import { Button, Segmented, useToast } from '../ui';
import '../../styles/live-compare.css';

/** The tab value of the local site; environments are tabs by their id. */
export const LOCAL = 'local';

/** A project's environments, kept and found, refetched when the site's settings change. */
export function useEnvs(projectId: string, on = true): LiveEnvs | null {
  return useQuery('live.envs', on ? { projectId } : null, ['liveSite', 'projects'], forProject(projectId)).data ?? null;
}

/** What a hosted environment is, in one line: said wherever one can be opened. */
export const HOSTED_NOTE = 'Opening a hosted environment, or comparing with it, sends requests to that site, only when you do. '
  + 'It opens read-only, in a private session of its own: no cookies shared with your local site, never the helper’s token, '
  + 'its certificate checked as any browser would, and nothing sent that could change it.';

export function EnvTabs({ envs, value, onChange }: { envs: readonly LiveEnv[]; value: string | null; onChange: (id: string | null) => void }) {
  const options = [
    { value: LOCAL, label: 'Local', hint: 'The site on this Mac, following the agents' },
    ...envs.map((e) => ({ value: e.id, label: e.name, hint: `${e.url} · read-only` })),
  ];
  return (
    <div className="live-envs">
      <Segmented<string> size="s" label="Environment" value={value ?? LOCAL} options={options} onChange={(v) => onChange(v === LOCAL ? null : v)} />
    </div>
  );
}

/** In the site settings: the environments kept, what the project's files name besides, and a typed one. */
export function EnvironmentSettings({ project, site }: { project: ProjectSummary; site: LiveSite }) {
  const toast = useToast();
  const data = useEnvs(project.id);
  const [editing, setEditing] = useState<string | null>(null);
  const keep = async (env: { id?: string | null; name: string; url: string }): Promise<boolean> => {
    const done = await attempt(() => call('live.setEnv', { projectId: project.id, id: env.id ?? null, name: env.name, url: env.url }), (m) => toast(m, 'error'));
    return !!done;
  };
  const remove = async (env: LiveEnv): Promise<void> => {
    const done = await attempt(() => call('live.removeEnv', { projectId: project.id, id: env.id }), (m) => toast(m, 'error'));
    if (done) toast(`${env.name} is no longer a tab.`);
  };
  const keepAll = async (list: readonly LiveEnvCandidate[]): Promise<void> => {
    const taken = new Set((data?.envs ?? []).map((e) => e.name.toLowerCase()));
    for (const c of list) {
      if (taken.has(c.name.toLowerCase())) continue;
      if (await keep(c)) taken.add(c.name.toLowerCase());
    }
  };
  if (!site.url) return null;
  const envs = data?.envs ?? [];
  // One per name: when two files name a Live, the first is offered for Keep all; the other stays below to choose instead.
  const firstOfName = (data?.candidates ?? []).filter((c, i, all) => all.findIndex((x) => x.name.toLowerCase() === c.name.toLowerCase()) === i
    && !envs.some((e) => e.name.toLowerCase() === c.name.toLowerCase()));
  return (
    <section className="live-env-settings" aria-label="Hosted environments">
      <h3 className="live-section-title">Hosted environments</h3>
      <p className="small">Tabs beside Local, showing the same page on Dev, Test or Live, and what Compare lays over your local site.</p>
      <p className="faint small">{HOSTED_NOTE}</p>
      {envs.length ? (
        <ul className="live-env-list" aria-label="Kept environments">
          {envs.map((e) => (
            <li key={e.id} className="live-env-row">
              {editing === e.id ? (
                <EnvForm initial={e} submit="Save" onCancel={() => setEditing(null)} onSubmit={async (next) => { if (await keep({ ...next, id: e.id })) setEditing(null); }} />
              ) : (
                <>
                  <div className="live-env-text">
                    <span className="live-env-name">{e.name}</span>
                    <span className="mono small">{e.url}</span>
                    <span className="faint small">{e.found ? `Found in ${e.found}` : 'Typed by you'}</span>
                  </div>
                  <Button size="s" tone="quiet" onClick={() => setEditing(e.id)} aria-label={`Rename or readdress ${e.name}`}>Change</Button>
                  <Button size="s" tone="quiet" icon="trash" onClick={() => remove(e)} aria-label={`Remove ${e.name}`}>Remove</Button>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {data?.candidates.length ? (
        <div className="live-env-found">
          <div className="live-env-found-head">
            <span className="small">Found in the project’s files</span>
            {firstOfName.length > 1 ? <Button size="s" onClick={() => keepAll(firstOfName)}>Keep {firstOfName.map((c) => c.name).join(', ')}</Button> : null}
          </div>
          <ul className="live-env-list" aria-label="Environments found in the project’s files">
            {data.candidates.map((c) => (
              <li key={`${c.url}|${c.file}`} className="live-env-row">
                <div className="live-env-text">
                  <span className="live-env-name">{c.name}</span>
                  <span className="mono small">{c.url}</span>
                  <span className="faint small">{c.file}: {c.why}</span>
                </div>
                <Button size="s" onClick={() => keep(c)} aria-label={`Keep ${c.name} (${c.url})`}>Keep</Button>
              </li>
            ))}
          </ul>
        </div>
      ) : data && !envs.length ? (
        <p className="faint small">Nothing in the project names a hosted environment (Drush or WP-CLI aliases, a host’s config, Stage File Proxy’s origin). Add one below.</p>
      ) : null}
      {editing === 'new' ? (
        <EnvForm initial={{ name: '', url: '' }} submit="Add" onCancel={() => setEditing(null)} onSubmit={async (next) => { if (await keep(next)) setEditing(null); }} />
      ) : (
        <div className="live-actions"><Button size="s" tone="quiet" icon="plus" onClick={() => setEditing('new')}>Add an environment</Button></div>
      )}
    </section>
  );
}

function EnvForm({ initial, submit, onSubmit, onCancel }: {
  initial: { name: string; url: string }; submit: string; onSubmit: (env: { name: string; url: string }) => Promise<void>; onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [url, setUrl] = useState(initial.url);
  const [busy, setBusy] = useState(false);
  const send = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    await onSubmit({ name, url });
    setBusy(false);
  };
  return (
    <form className="live-env-form" onSubmit={send}>
      <label className="field-label" htmlFor="live-env-name">Name</label>
      <input id="live-env-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Live" maxLength={24} autoComplete="off" />
      <label className="field-label" htmlFor="live-env-url">Address</label>
      <input id="live-env-url" className="mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.example.com" spellCheck={false} autoComplete="off" />
      <div className="live-typed-actions">
        <Button tone="quiet" size="s" onClick={onCancel}>Cancel</Button>
        <Button type="submit" tone="primary" size="s" disabled={busy || !name.trim() || !url.trim()}>{busy ? 'Saving…' : submit}</Button>
      </div>
    </form>
  );
}
