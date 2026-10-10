import { useState } from 'react';
import type { ProjectSummary } from '@shared/model';
import { attempt, call, forProject, useQuery } from '../lib/api';
import { ago } from '../lib/format';
import { Button, NotAnswering, useSingleFlight, useToast } from '../components/ui';

export function DecisionsView({ project }: { project: ProjectSummary }) {
  const decisions = useQuery('decisions.list', { projectId: project.id }, ['decisions'], forProject(project.id));
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const once = useSingleFlight();

  const add = (): Promise<void> => once(async () => {
    if (!title.trim()) return;
    const ok = await attempt(() => call('decisions.add', { projectId: project.id, title, body }), (m) => toast(m, 'error'));
    if (ok) { setTitle(''); setBody(''); }
  });

  return (
    <div className="view-pad decisions">
      <p className="lede">Decisions are rules for this project. Every session that starts here is told them, and you can change them at any time.</p>
      <form className="decision-new" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label className="visually-hidden" htmlFor="decision-title">Decision</label>
        <input id="decision-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A decision, e.g. “Use pnpm, never npm”" />
        <label className="visually-hidden" htmlFor="decision-body">Why, or detail</label>
        <textarea id="decision-body" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Why, or any detail an agent needs (optional)" rows={2} />
        <div><Button tone="primary" type="submit" disabled={!title.trim()}>Record decision</Button></div>
      </form>
      {decisions.error ? <NotAnswering error={decisions.error} onRetry={decisions.reload} /> : decisions.data?.length ? (
        <ol className="decision-list">
          {decisions.data.map((d) => (
            <li key={d.id} className="decision">
              {editing === d.id ? (
                <DecisionEdit id={d.id} title={d.title} body={d.body} onDone={() => setEditing(null)} />
              ) : (
                <>
                  <div className="decision-text">
                    <p className="decision-title">{d.title}</p>
                    {d.body ? <p className="decision-body">{d.body}</p> : null}
                    <p className="faint decision-when">Recorded {ago(d.createdAt)}{d.updatedAt !== d.createdAt ? `, changed ${ago(d.updatedAt)}` : ''}</p>
                  </div>
                  <div className="decision-actions">
                    <Button size="s" tone="quiet" onClick={() => setEditing(d.id)}>Edit</Button>
                    <Button size="s" tone="quiet" onClick={() => attempt(() => call('decisions.remove', { id: d.id }), (m) => toast(m, 'error'))}>Withdraw</Button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ol>
      ) : decisions.data ? <p className="faint">No decisions yet.</p> : null}
    </div>
  );
}

function DecisionEdit({ id, title, body, onDone }: { id: string; title: string; body: string; onDone: () => void }) {
  const [t, setT] = useState(title);
  const [b, setB] = useState(body);
  const toast = useToast();
  const once = useSingleFlight();
  // A refused edit stays open with its text, to try again.
  const save = (): Promise<void> => once(() => attempt(() => call('decisions.update', { id, title: t, body: b }), (m) => toast(m, 'error'))
    .then((r) => { if (r) onDone(); }));
  return (
    <form className="decision-edit" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label className="visually-hidden" htmlFor={`dt-${id}`}>Decision</label>
      <input id={`dt-${id}`} value={t} onChange={(e) => setT(e.target.value)} />
      <label className="visually-hidden" htmlFor={`db-${id}`}>Detail</label>
      <textarea id={`db-${id}`} value={b} onChange={(e) => setB(e.target.value)} rows={2} />
      <div className="row-gap"><Button tone="primary" type="submit">Save</Button><Button tone="quiet" onClick={onDone}>Cancel</Button></div>
    </form>
  );
}
