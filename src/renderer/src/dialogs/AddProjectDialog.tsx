import { useState } from 'react';
import type { AccountProvider, AgentFolder } from '@shared/model';
import { attempt, bridge, call, useQuery } from '../lib/api';
import { plural } from '../lib/format';
import { navigate } from '../lib/router';
import { Button, Dialog, Field, useToast } from '../components/ui';

export function AddProjectDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const choose = async (): Promise<void> => {
    const picked = await bridge().pickFolder();
    if (picked) { setPath(picked); setError(null); if (!name) setName(picked.split('/').filter(Boolean).pop() ?? ''); }
  };

  const open = async (): Promise<void> => {
    if (!path.trim()) return;
    const project = await attempt(() => call('projects.add', { path: path.trim(), ...(name.trim() ? { name: name.trim() } : {}) }), setError);
    if (!project) return;
    toast(`${project.name} is open. Its key is ${project.key}.`);
    onClose();
    navigate({ name: 'project', projectKey: project.key, view: 'board' });
  };

  return (
    <Dialog
      title="Open a project"
      onClose={onClose}
      footer={<><Button tone="quiet" onClick={onClose}>Cancel</Button><Button tone="primary" onClick={() => open()} disabled={!path.trim()}>Open project</Button></>}
    >
      <p className="faint">A project is a folder you work in: usually a repository. It gets its own board, sessions and history. Wanigan writes nothing into it.</p>
      <h3 className="dialog-section">Folder</h3>
      <Field label="Path">{(id) => (
        <div className="input-row">
          <input id={id} className="mono" value={path} onChange={(e) => { setPath(e.target.value); setError(null); }} placeholder="/Users/you/Projects/site" onKeyDown={(e) => { if (e.key === 'Enter') void open(); }} />
          <Button icon="folder" onClick={() => choose()}>Choose…</Button>
        </div>
      )}</Field>
      <Field label="Name" hint="Optional. Defaults to the folder’s name.">{(id) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      <AgentFolderList onError={setError} />
    </Dialog>
  );
}

const SHOWN = 6;
const AGENT_LABEL: Record<AccountProvider, string> = { claude: 'Claude Code', codex: 'Codex' };
const since = new Intl.RelativeTimeFormat(undefined, { numeric: 'always', style: 'short' });

/** "last 2 hr. ago", "last 1 day ago": how long since the newest conversation, in words that follow "last". */
function lastOne(at: number, now = Date.now()): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `last ${since.format(-minutes, 'minute')}`;
  if (minutes < 1440) return `last ${since.format(-Math.round(minutes / 60), 'hour')}`;
  return `last ${since.format(-Math.round(minutes / 1440), 'day')}`;
}

/**
 * Folders the agents have worked in lately, read from their own transcripts in
 * every account Wanigan knows. Nothing is chosen for the owner: one click opens one.
 */
function AgentFolderList({ onError }: { onError: (message: string) => void }) {
  const found = useQuery('projects.agentFolders', {}, ['projects']);
  const [all, setAll] = useState(false);
  const [opened, setOpened] = useState<string[]>([]);
  const folders = found.data?.folders ?? [];
  const shown = all ? folders : folders.slice(0, SHOWN);
  const add = async (f: AgentFolder): Promise<void> => {
    const project = await attempt(() => call('projects.add', { path: f.path }), onError);
    if (project) setOpened((o) => [...o, project.name]);
  };
  return (
    <section className="suggestions agent-folders" aria-labelledby="agent-folders-title">
      <h3 id="agent-folders-title" className="dialog-section">Folders your agents have worked in</h3>
      {found.error ? <p className="faint small">Wanigan could not read them: {found.error.message}</p>
        : !found.data ? <p className="faint small">Reading your agents’ conversations…</p>
          : !folders.length ? <p className="faint small">None in the last {found.data.days} days that are not open already.</p>
            : (
              <ul>
                {shown.map((f) => (
                  <li key={f.path}>
                    <span className="suggestion-text">
                      <span className="suggestion-name">{f.name}{f.git ? <span className="tag">git</span> : null}</span>
                      <span className="suggestion-path mono faint" title={f.path}>{f.path}</span>
                      <span className="suggestion-meta faint">
                        {plural(f.conversations, 'conversation')}, {lastOne(f.lastAt)} · {f.agents.map((a) => AGENT_LABEL[a]).join(' and ')}{f.git ? '' : ' · not a git repository'}
                      </span>
                    </span>
                    <Button size="s" onClick={() => add(f)} aria-label={`Open ${f.name}`}>Open</Button>
                  </li>
                ))}
              </ul>
            )}
      {folders.length > SHOWN ? (
        <button type="button" className="linkish small" aria-expanded={all} onClick={() => setAll((a) => !a)}>
          {all ? 'Show fewer' : `Show all ${folders.length}`}
        </button>
      ) : null}
      {opened.length ? <p className="faint small" role="status">Opened {opened.join(', ')}.</p> : null}
      {found.data ? (
        <p className="faint small">
          From the last {found.data.days} days of Claude Code and Codex conversations in your accounts. Read only.{found.data.cut ? ` ${found.data.cut}` : ''}
        </p>
      ) : null}
    </section>
  );
}
