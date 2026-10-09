import { Select } from '../components/Select';
import { useState } from 'react';
import { CARD_TYPES, PRIORITIES, type CardType, type Priority, type ProjectSummary } from '@shared/model';
import { attempt, bridge, call } from '../lib/api';
import { keyLabel } from '@shared/shortcuts';
import { openCard } from '../lib/router';
import { TYPE_LABEL } from '../lib/format';
import { Button, Dialog, Field, IconButton, Segmented, useToast } from '../components/ui';

export function NewCardDialog({ projects, initial, onClose }: {
  projects: ProjectSummary[];
  initial: { projectId?: string; status?: 'inbox' | 'ready' };
  onClose: () => void;
}) {
  const toast = useToast();
  const [projectId, setProjectId] = useState(initial.projectId ?? projects[0]?.id ?? '');
  const [type, setType] = useState<CardType>('task');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [criteria, setCriteria] = useState<string[]>([]);
  const [criterion, setCriterion] = useState('');
  const [priority, setPriority] = useState<Priority>(2);
  const [status, setStatus] = useState<'inbox' | 'ready'>(initial.status ?? 'ready');
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [drafted, setDrafted] = useState<string | null>(null);
  const project = projects.find((p) => p.id === projectId);
  const mac = bridge().platform === 'darwin';

  const draft = async (): Promise<void> => {
    const note = [title, body].filter((s) => s.trim()).join('\n\n');
    if (!note.trim() || !project) return;
    setDrafting(true);
    const r = await attempt(() => call('cards.draft', { projectId, note }), (m) => toast(m, 'error'));
    setDrafting(false);
    if (!r) return;
    setType(r.draft.type);
    setTitle(r.draft.title);
    setBody(r.draft.body);
    setCriteria(r.draft.criteria);
    setPriority(r.draft.priority);
    setDrafted(`Drafted by Claude Code${r.costUsd !== null ? `, which reported $${r.costUsd.toFixed(2)}` : ''}. ${r.draft.why} Edit anything before creating.`);
  };

  const submit = async (open: boolean): Promise<void> => {
    if (!title.trim() || !projectId || busy) return;
    setBusy(true);
    const card = await attempt(() => call('cards.create', { projectId, type, title, body, priority, status }), (m) => toast(m, 'error'));
    if (card) {
      const pending = criterion.trim() ? [...criteria, criterion.trim()] : criteria;
      for (const text of pending) await attempt(() => call('criteria.add', { cardId: card.id, text }), (m) => toast(m, 'error'));
    }
    setBusy(false);
    if (!card) return;
    onClose();
    if (open) openCard(card.key); else toast(`${card.key} created.`);
  };

  const addCriterion = (): void => {
    if (!criterion.trim()) return;
    setCriteria((c) => [...c, criterion.trim()]);
    setCriterion('');
  };

  return (
    <Dialog
      title="New card"
      onClose={onClose}
      width={600}
      footer={
        <>
          <span className="dialog-hint"><kbd>{keyLabel('Mod', mac)}</kbd><kbd>{keyLabel('Enter', mac)}</kbd> create and open</span>
          <Button tone="quiet" onClick={onClose}>Cancel</Button>
          <Button tone="primary" onClick={() => submit(false)} disabled={!title.trim() || busy || drafting}>Create card</Button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); void submit(false); }} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(true); } }}>
        {projects.length > 1 ? (
          <Field label="Project">{(id) => (
            <Select id={id} value={projectId} onChange={setProjectId} options={projects.map((p) => ({ value: p.id, label: `${p.name} (${p.key})` }))} />
          )}</Field>
        ) : null}
        <div className="field"><span className="field-label">Type</span>
          <Segmented<CardType> label="Type" value={type} onChange={setType} options={CARD_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))} />
        </div>
        <Field label="Title">{(id) => <input id={id} data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing, or a rough note" />}</Field>
        <Field label="Description" hint="Agents read this when they take the card.">{(id) => (
          <textarea id={id} rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
        )}</Field>
        <div className="draft-row">
          <Button size="s" icon="search" onClick={() => draft()} disabled={drafting || !(title.trim() || body.trim())}>
            {drafting ? 'Claude is reading the project…' : 'Draft with Claude'}
          </Button>
          <span className="faint small">
            {drafted ?? 'Turns a rough note into a clear card with criteria, reading the project with read-only tools. Uses a turn of your plan.'}
          </span>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="new-criterion">Acceptance criteria</label>
          {criteria.length ? (
            <ul className="draft-criteria">
              {criteria.map((c, i) => (
                <li key={`${i}-${c}`}>
                  <span>{c}</span>
                  <IconButton icon="close" label={`Remove “${c}”`} onClick={() => setCriteria((all) => all.filter((_, j) => j !== i))} />
                </li>
              ))}
            </ul>
          ) : null}
          <input id="new-criterion" value={criterion} onChange={(e) => setCriterion(e.target.value)} placeholder="Something checkable, then Enter"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); addCriterion(); } }} />
        </div>
        <div className="field-row">
          <div className="field"><span className="field-label">Priority</span>
            <Segmented<Priority> label="Priority" value={priority} onChange={setPriority} options={PRIORITIES.map((p) => ({ value: p, label: `P${p}` }))} />
          </div>
          <div className="field"><span className="field-label">Column</span>
            <Segmented<'inbox' | 'ready'> label="Column" value={status} onChange={setStatus} options={[{ value: 'inbox', label: 'Inbox' }, { value: 'ready', label: 'Ready' }]} />
          </div>
        </div>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
