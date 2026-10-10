// A project's Decisions: the rules every session that starts here is told
// (core/briefing.ts reads them when a session starts). The list is the work;
// the chosen decision is read, changed or withdrawn in the reader panel beside
// it; a new one is recorded in a dialog from the toolbar.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Decision, ProjectSummary } from '@shared/model';
import { attempt, call, forProject, useQuery } from '../lib/api';
import { ago, plural } from '../lib/format';
import { Icon } from '../components/icons';
import { Panel, Section } from '../components/Panel';
import { Toolbar } from '../components/Toolbar';
import { Button, Dialog, EmptyState, Field, NotAnswering, useSingleFlight, useToast } from '../components/ui';
import { Confirm } from './git/common';
import '../styles/records.css';

export function DecisionsView({ project }: { project: ProjectSummary }) {
  const decisions = useQuery('decisions.list', { projectId: project.id }, ['decisions'], forProject(project.id));
  const toast = useToast();
  const [filter, setFilter] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState<Decision | null>(null);
  const [reader, setReader] = useState(true);
  const list = useRef<HTMLUListElement>(null);

  const q = filter.trim().toLowerCase();
  const all = useMemo(() => decisions.data ?? [], [decisions.data]);
  const shown = useMemo(() => all.filter((d) => !q || d.title.toLowerCase().includes(q) || d.body.toLowerCase().includes(q)), [all, q]);
  const current = shown.find((d) => d.id === chosen) ?? shown[0] ?? null;
  useEffect(() => { if (editing && editing !== current?.id) setEditing(null); }, [editing, current?.id]);

  const choose = (d: Decision | undefined, focus = false): void => {
    if (!d) return;
    setChosen(d.id);
    setReader(true);
    if (focus) requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(d.id)}"]`)?.focus());
  };
  const onKey = (e: KeyboardEvent<HTMLUListElement>): void => {
    if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest('input, textarea')) return;
    const at = current ? shown.indexOf(current) : -1;
    const step = e.key === 'ArrowDown' || e.key === 'j' ? 1 : e.key === 'ArrowUp' || e.key === 'k' ? -1 : 0;
    if (step) { e.preventDefault(); choose(shown[Math.max(0, Math.min(shown.length - 1, at + step))], true); }
    else if (e.key === 'Home') { e.preventDefault(); choose(shown[0], true); }
    else if (e.key === 'End') { e.preventDefault(); choose(shown.at(-1), true); }
  };

  const withdraw = async (d: Decision): Promise<void> => {
    const r = await attempt(() => call('decisions.remove', { id: d.id }), (m) => toast(m, 'error'));
    setWithdrawing(null);
    if (r) toast(`Withdrew “${d.title}”. Sessions that start from now on are not told it.`, 'done');
  };

  if (decisions.error) return <NotAnswering error={decisions.error} onRetry={decisions.reload} />;
  return (
    <div className="records">
      <Toolbar label="Decisions" className="records-toolbar">
        <label className="search-field records-filter" data-tour="decisions-filter">
          <Icon name="search" size={14} />
          <span className="visually-hidden">Filter decisions</span>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter decisions" spellCheck={false}
            onKeyDown={(e) => { if (e.key === 'Escape' && filter) { e.stopPropagation(); setFilter(''); } }} />
        </label>
        <span className="records-count" role="status">
          {decisions.data ? (q ? `${shown.length} of ${plural(all.length, 'decision')}` : `${plural(all.length, 'decision')} in force`) : ''}
        </span>
        <span className="records-gap" />
        <Button tone="primary" size="s" icon="plus" onClick={() => setAdding(true)} data-tour="decisions-new">New decision</Button>
      </Toolbar>
      <div className="records-body">
        <div className="records-work">
          {!decisions.data ? <p className="records-wait">Reading the decisions…</p>
            : !all.length ? (
              <EmptyState icon="decisions" title="No decisions yet" action={<Button tone="primary" icon="plus" onClick={() => setAdding(true)}>New decision</Button>}>
                Decisions are rules for this project, like “Use pnpm, never npm”. Every session that starts here is told them, and you can change them at any time.
              </EmptyState>
            ) : !shown.length ? (
              <EmptyState title="No decision matches">No decision’s words hold “{filter.trim()}”.</EmptyState>
            ) : (
              <ul className="records-list decision-list" aria-label="Decisions" ref={list} onKeyDown={onKey} data-tour="decisions-list">
                {shown.map((d) => (
                  <li key={d.id}>
                    <button type="button" className={`decision record${d.id === current?.id ? ' on' : ''}`} data-id={d.id}
                      aria-current={d.id === current?.id ? 'true' : undefined} tabIndex={d.id === current?.id ? 0 : -1} onClick={() => choose(d)}>
                      <span className="record-main">
                        <span className="decision-title record-title">{d.title}</span>
                        {d.body.trim() ? <span className="record-sub">{d.body.trim()}</span> : null}
                      </span>
                      <time className="record-when" dateTime={new Date(d.updatedAt).toISOString()}>{ago(d.updatedAt)}</time>
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </div>
        {current ? (
          <Panel side="right" open={reader} onClose={() => setReader(false)} className="records-reader" label="The decision" title="Decision"
            resizable sizeKey="decisions-reader" size={400} minSize={292} maxSize={640}>
            <div data-tour="decisions-reader">
              {editing === current.id ? (
                <DecisionEdit id={current.id} title={current.title} body={current.body} onDone={() => setEditing(null)} />
              ) : (
                <>
                  <h3 className="read-title">{current.title}</h3>
                  {current.body.trim() ? <p className="read-body">{current.body.trim()}</p> : <p className="read-none">No detail.</p>}
                  <Section title="In force">
                    <p className="read-fact">
                      Recorded {ago(current.createdAt)}{current.updatedAt !== current.createdAt ? `, changed ${ago(current.updatedAt)}` : ''}.
                      {' '}Every session that starts in {project.name} is told it.
                    </p>
                  </Section>
                  <div className="decision-actions read-acts">
                    <Button size="s" icon="pencil" onClick={() => setEditing(current.id)}>Edit</Button>
                    <Button size="s" tone="quiet" icon="trash" onClick={() => setWithdrawing(current)}>Withdraw</Button>
                  </div>
                </>
              )}
            </div>
          </Panel>
        ) : null}
      </div>
      {adding ? <NewDecision project={project} onClose={() => setAdding(false)} onMade={(id) => setChosen(id)} /> : null}
      {withdrawing ? (
        <Confirm danger title={`Withdraw “${withdrawing.title}”?`} act="Withdraw" onClose={() => setWithdrawing(null)} onAct={() => withdraw(withdrawing)}>
          <p>Sessions that start from now on are not told it. Sessions already running were told it when they started.</p>
        </Confirm>
      ) : null}
    </div>
  );
}

function NewDecision({ project, onClose, onMade }: { project: ProjectSummary; onClose: () => void; onMade: (id: string) => void }) {
  const toast = useToast();
  const once = useSingleFlight();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const add = (): Promise<void> => once(async () => {
    if (!title.trim()) return;
    const made = await attempt(() => call('decisions.add', { projectId: project.id, title, body }), (m) => toast(m, 'error'));
    if (!made) return;
    toast(`Recorded “${made.title}”. Sessions that start here are told it.`, 'done');
    onMade(made.id);
    onClose();
  });
  return (
    <Dialog title="New decision" onClose={onClose} width={520} footer={(
      <>
        <Button tone="quiet" onClick={onClose}>Cancel</Button>
        <Button tone="primary" type="submit" form="decision-new" disabled={!title.trim()}>Record decision</Button>
      </>
    )}>
      <form id="decision-new" className="decision-new" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <div className="field">
          <label htmlFor="decision-title">Decision</label>
          <input id="decision-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Use pnpm, never npm" data-autofocus />
        </div>
        <Field label="Why, or any detail an agent needs" hint="Optional. Every session that starts in this project is told the decision and this.">
          {(id) => <textarea id={id} value={body} onChange={(e) => setBody(e.target.value)} rows={4} />}
        </Field>
      </form>
    </Dialog>
  );
}

function DecisionEdit({ id, title, body, onDone }: { id: string; title: string; body: string; onDone: () => void }) {
  const [t, setT] = useState(title);
  const [b, setB] = useState(body);
  const toast = useToast();
  const once = useSingleFlight();
  // A refused edit stays open with its text, to try again.
  const save = (): Promise<void> => once(() => attempt(() => call('decisions.update', { id, title: t, body: b }), (m) => toast(m, 'error'))
    .then((r) => { if (r) { toast('Saved the decision.', 'done'); onDone(); } }));
  return (
    <form className="decision-edit" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="field">
        <label htmlFor={`dt-${id}`}>Decision</label>
        <input id={`dt-${id}`} value={t} onChange={(e) => setT(e.target.value)} autoFocus />
      </div>
      <div className="field">
        <label htmlFor={`db-${id}`}>Detail</label>
        <textarea id={`db-${id}`} value={b} onChange={(e) => setB(e.target.value)} rows={6} />
      </div>
      <div className="read-acts">
        <Button tone="quiet" size="s" onClick={onDone}>Cancel</Button>
        <Button tone="primary" size="s" type="submit" disabled={!t.trim()}>Save</Button>
      </div>
    </form>
  );
}
