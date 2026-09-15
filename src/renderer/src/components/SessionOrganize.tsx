import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  TAG_COLORS, type OrganiseSnapshot, type OrganisedTag, type SectionRow, type TagColor,
} from '@shared/session-organize';
import { Chip, ConfirmNote, Note } from './bits';
import '../styles/helper-ux.css';

/**
 * Tags on a conversation and the Recent sections it is filed in — the
 * operator's own words about their own list. Every read and write goes through
 * main, which resolves a session id to its conversation, so a tag put on a
 * running tab is the same tag on the Recent row that conversation becomes.
 */

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const EMPTY: OrganiseSnapshot = { sessions: {}, sections: [], tags: [] };

/**
 * Tags, placements and sections for the ids a surface shows. Re-read when the
 * set of ids changes and after every write; a failed read keeps the last good
 * one and reports itself, because a tag row that silently empties reads as the
 * tags having been deleted.
 */
export function useOrganisation(ids: readonly string[]) {
  const [snapshot, setSnapshot] = useState<OrganiseSnapshot>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const key = useMemo(() => [...new Set(ids)].sort().join('|'), [ids]);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await window.wanigan.ux.organise(key ? key.split('|') : []);
      if (mine !== seq.current) return;
      setSnapshot(next);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(msg(e));
    }
  }, [key]);
  useEffect(() => { void reload(); }, [reload]);
  const tagsOf = useCallback((id: string): OrganisedTag[] => snapshot.sessions[id]?.tags ?? [], [snapshot]);
  return { snapshot, error, reload, tagsOf };
}

/** A tag, as a word with a colour beside it. The word is always there; the colour never carries it alone. */
export function TagChip({ tag }: { tag: OrganisedTag }) {
  return (
    <span className="ux-tag" data-color={tag.color}>
      <span className="ux-tag-dot" aria-hidden="true" />
      {tag.tag}
    </span>
  );
}

export function TagChips({ tags, label }: { tags: readonly OrganisedTag[]; label?: string }) {
  if (!tags.length) return null;
  return (
    <span className="ux-tags" aria-label={label ?? `Tags: ${tags.map((t) => t.tag).join(', ')}`}>
      {tags.map((t) => <TagChip key={t.norm} tag={t} />)}
    </span>
  );
}

/** A row of tag filters. Rendered only when some row on screen carries a tag. */
export function TagFilter({ tags, value, onChange, label }: {
  tags: readonly { tag: string; norm: string; color: TagColor; count: number }[];
  value: string | null;
  onChange: (norm: string | null) => void;
  label: string;
}) {
  if (!tags.length) return null;
  return (
    <div className="ux-tag-filter" role="group" aria-label={label}>
      <Chip pressed={value === null} onToggle={() => onChange(null)}>Any tag</Chip>
      {tags.map((t) => (
        <Chip key={t.norm} pressed={value === t.norm} count={t.count} onToggle={() => onChange(value === t.norm ? null : t.norm)}>
          <span className="ux-tag-dot" data-color={t.color} aria-hidden="true" />{t.tag}
        </Chip>
      ))}
    </div>
  );
}

const COLOR_WORD: Record<TagColor, string> = {
  blue: 'Blue', orange: 'Orange', green: 'Green', yellow: 'Yellow', violet: 'Violet', teal: 'Teal', red: 'Red', grey: 'Grey',
};

/**
 * Tags and a section for one conversation, inline under its row. Opened from
 * the tab's ⋯ and the Recent row's ⋯, and closed the same way.
 */
export function OrganisePanel({ sessionId, name, snapshot, onChanged, onError, showSectionOrder }: {
  sessionId: string;
  name: string;
  snapshot: OrganiseSnapshot;
  onChanged: () => void | Promise<void>;
  onError: (message: string) => void;
  /** Recent rows can be moved within their section; a live tab is not in Recent yet. */
  showSectionOrder: boolean;
}) {
  const own = snapshot.sessions[sessionId];
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      await onChanged();
      setSaid(done ?? null);
    } catch (e) {
      onError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  if (!own || !own.key) {
    return (
      <div className="ux-organise" role="group" aria-label={`Tags and section for ${name}`}>
        <Note tone="info">
          This session has no conversation id yet, so a tag or a section would have nothing to stay attached to.
          Tags become available once the agent has started its conversation.
        </Note>
      </div>
    );
  }

  const onThis = new Set(own.tags.map((t) => t.norm));
  const suggestions = snapshot.tags.filter((t) => !onThis.has(t.norm)).slice(0, 6);
  const section = own.placement ? snapshot.sections.find((s) => s.id === own.placement!.sectionId) ?? null : null;
  const add = (raw: string) => run(async () => {
    await window.wanigan.ux.addTags(sessionId, raw);
    setTyped('');
  }, `Tagged ${name}.`);

  return (
    <div className="ux-organise" role="group" aria-label={`Tags and section for ${name}`}>
      <div className="ux-organise-row">
        <span className="label">Tags</span>
        {own.tags.length === 0 && <span className="ux-cue">None yet.</span>}
        {own.tags.map((t) => (
          <span key={t.norm} className="ux-tag-edit">
            <TagChip tag={t} />
            <select className="field ux-color" value={t.color} disabled={busy}
                    aria-label={`Colour for the tag ${t.tag}`}
                    onChange={(e) => void run(() => window.wanigan.ux.setTagColor(t.tag, e.target.value as TagColor))}>
              {TAG_COLORS.map((c) => <option key={c} value={c}>{COLOR_WORD[c]}</option>)}
            </select>
            <button type="button" className="btn btn-sm" disabled={busy} aria-label={`Remove the tag ${t.tag} from ${name}`}
                    onClick={() => void run(() => window.wanigan.ux.removeTag(sessionId, t.tag))}>×</button>
          </span>
        ))}
      </div>
      <form className="ux-organise-row" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) void add(typed); }}>
        <input className="field ux-tag-input" value={typed} maxLength={200} disabled={busy}
               aria-label={`Add tags to ${name}, separated by commas`} placeholder="release-blocker, spike…"
               onChange={(e) => setTyped(e.target.value)} />
        <button type="submit" className="btn btn-sm" disabled={busy || !typed.trim()}>Add tag</button>
      </form>
      {suggestions.length > 0 && (
        <div className="ux-organise-row">
          <span className="ux-cue">In use:</span>
          {suggestions.map((t) => (
            <button key={t.norm} type="button" className="btn btn-sm ux-suggest" disabled={busy}
                    aria-label={`Add the tag ${t.tag} to ${name}`} onClick={() => void add(t.tag)}>
              <span className="ux-tag-dot" data-color={t.color} aria-hidden="true" />{t.tag}
            </button>
          ))}
        </div>
      )}
      <div className="ux-organise-row">
        <label className="ux-inline-label" htmlFor={`ux-section-${sessionId}`}>Section</label>
        <select id={`ux-section-${sessionId}`} className="field" disabled={busy || snapshot.sections.length === 0}
                value={own.placement?.sectionId ?? ''}
                onChange={(e) => void run(() => window.wanigan.ux.placeInSection(sessionId, e.target.value || null),
                  e.target.value ? 'Filed.' : 'Back in Recent.')}>
          <option value="">{snapshot.sections.length ? 'Not in a section' : 'No sections yet — create one in Recent'}</option>
          {snapshot.sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {showSectionOrder && section && (
          <>
            <button type="button" className="btn btn-sm" disabled={busy} aria-label={`Move ${name} up in ${section.name}`}
                    onClick={() => void run(() => window.wanigan.ux.moveInSection(sessionId, -1))}>↑</button>
            <button type="button" className="btn btn-sm" disabled={busy} aria-label={`Move ${name} down in ${section.name}`}
                    onClick={() => void run(() => window.wanigan.ux.moveInSection(sessionId, 1))}>↓</button>
          </>
        )}
      </div>
      <p className="ux-cue" role="status">{said ?? 'Tags and sections follow the conversation, so they stay when it is resumed.'}</p>
    </div>
  );
}

/** Creating a section, from the Recent heading. */
export function NewSectionForm({ onDone, onError }: { onDone: () => void | Promise<void>; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open) {
    return <button type="button" className="btn btn-sm ux-new-section" onClick={() => setOpen(true)}>+ Section</button>;
  }
  const submit = async () => {
    setBusy(true);
    try {
      await window.wanigan.ux.createSection(name);
      setName('');
      setOpen(false);
      await onDone();
    } catch (e) { onError(msg(e)); }
    finally { setBusy(false); }
  };
  return (
    <form className="ux-section-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <input className="field" autoFocus value={name} maxLength={80} disabled={busy} aria-label="Name for the new Recent section"
             placeholder="This week"
             onChange={(e) => setName(e.target.value)}
             onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); } }} />
      <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !name.trim()}>Create</button>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>Cancel</button>
    </form>
  );
}

/**
 * A section's heading in Recent: its name, how many conversations are on it,
 * and the controls that rename, reorder and delete it. Reordering is two
 * buttons with names, not a drag, so a keyboard reaches it the same way a
 * pointer does.
 */
export function SectionHeading({ section, index, total, count, onChanged, onError }: {
  section: SectionRow;
  index: number;
  total: number;
  count: number;
  onChanged: () => void | Promise<void>;
  onError: (m: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(section.name);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await onChanged(); }
    catch (e) { onError(msg(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="ux-section" data-section-id={section.id}>
      {renaming ? (
        <form className="ux-section-form" onSubmit={(e) => {
          e.preventDefault();
          void run(async () => { await window.wanigan.ux.renameSection(section.id, name); setRenaming(false); });
        }}>
          <input className="field" autoFocus value={name} maxLength={80} aria-label={`New name for the section ${section.name}`}
                 onChange={(e) => setName(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setRenaming(false); setName(section.name); } }} />
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !name.trim()}>Rename</button>
        </form>
      ) : (
        <div className="ux-section-head">
          <span className="label ux-section-name">{section.name}</span>
          <span className="ux-cue">{count}</span>
          <span className="ux-section-actions">
            <button type="button" className="btn btn-sm" disabled={busy} aria-label={`Rename the section ${section.name}`}
                    onClick={() => { setName(section.name); setRenaming(true); }}>✎</button>
            <button type="button" className="btn btn-sm" disabled={busy || index === 0} aria-label={`Move the section ${section.name} up`}
                    onClick={() => void run(() => window.wanigan.ux.moveSection(section.id, -1))}>↑</button>
            <button type="button" className="btn btn-sm" disabled={busy || index === total - 1} aria-label={`Move the section ${section.name} down`}
                    onClick={() => void run(() => window.wanigan.ux.moveSection(section.id, 1))}>↓</button>
            <button type="button" className="btn btn-sm" disabled={busy} aria-label={`Delete the section ${section.name}`}
                    onClick={() => setDeleting(true)}>×</button>
          </span>
        </div>
      )}
      {deleting && (
        <ConfirmNote what={<>Delete the section “{section.name}”? Its {count} conversation{count === 1 ? '' : 's'} go back to Recent; nothing is forgotten.</>}
                     verb="Delete section" busy={busy} onCancel={() => setDeleting(false)}
                     onRun={() => run(async () => { await window.wanigan.ux.deleteSection(section.id); setDeleting(false); })} />
      )}
      {count === 0 && !deleting && <p className="ux-cue ux-section-empty">Empty. File a conversation here from its ⋯ menu.</p>}
    </div>
  );
}
