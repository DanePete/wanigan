// The Commits tab: history as a graph in the left panel (this branch, or every
// branch), filtered by message or author, and the chosen commit read in full
// as the hero: who, when, its message, whether it is pushed, and each file's
// diff. A commit made for a card carries the card's key, which opens the card.
// J and K, or the arrow keys, move through the list.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { layoutGraph, type CommitDetail, type GitStatus } from '@shared/git';
import type { ProjectSummary } from '@shared/model';
import { forProject, useQuery } from '../../lib/api';
import { ago, plural } from '../../lib/format';
import { Icon } from '../../components/icons';
import { Button, EmptyState, IconButton, Segmented, useToast } from '../../components/ui';
import { Panel } from '../../components/Panel';
import { FileDiff, type DiffLayout } from '../../components/FileDiff';
import { GraphCell } from './Graph';
import { CardBadge, Ref, type Where } from './common';

const ROW = 48;
const MAX_LANES = 10;
const PAGE = 300;
const ALL_KEY = 'wanigan.git.allBranches';

const readAll = (): boolean => { try { return localStorage.getItem(ALL_KEY) === '1'; } catch { return false; } };

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function Commits({ project, where, status, list: listOpen, onList }: {
  project: ProjectSummary; where: Where; status: GitStatus;
  /** The history's panel is shown (the toolbar's list button). */
  list: boolean; onList: (on: boolean) => void;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [all, setAll] = useState(readAll);
  const pickAll = (on: boolean): void => {
    setAll(on);
    try { localStorage.setItem(ALL_KEY, on ? '1' : '0'); } catch { /* a convenience for this viewer only */ }
  };
  const [typed, setTyped] = useState('');
  const query = useDebounced(typed.trim(), 250);
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [all, query, where.cardId]);
  const log = useQuery('git.log', { ...where, all, query, limit }, ['git'], forProject(project.id));
  const commits = useMemo(() => log.data?.commits ?? [], [log.data]);
  // A filtered list has gaps, so it is a list, not a graph.
  const rows = useMemo(() => (query ? null : layoutGraph(commits)), [commits, query]);
  const width = rows ? Math.min(MAX_LANES, Math.max(1, ...rows.map((r) => r.width))) : 0;

  const [selected, setSelected] = useState<string | null>(null);
  const chosen = selected ?? commits[0]?.hash ?? null;
  const index = commits.findIndex((c) => c.hash === chosen);
  const list = useRef<HTMLUListElement>(null);
  const move = (by: number): void => {
    const next = commits[Math.max(0, Math.min(commits.length - 1, (index < 0 ? 0 : index) + by))];
    if (next) setSelected(next.hash);
  };
  useEffect(() => {
    if (!chosen) return;
    document.getElementById(`commit-${uid}-${chosen}`)?.scrollIntoView({ block: 'nearest' });
  }, [chosen, uid]);

  // J/K and the arrows, unless something is being typed or a dialog is open.
  const keys = useRef(move);
  keys.current = move;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || t.matches('textarea, input, select') || t.closest('.xterm, [role="dialog"], .drawer'))) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); keys.current(1); }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); keys.current(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const detail = useQuery('git.show', chosen ? { ...where, hash: chosen } : null, ['git'], forProject(project.id));

  if (log.error) return <EmptyState icon="alert" title="Git could not read the history">{log.error.message}</EmptyState>;
  if (status.unborn) return <EmptyState icon="commit" title="No commits yet">{status.branch ?? 'This branch'} has no commits. Make the first one from Changes.</EmptyState>;

  const counted = log.data ? (query
    ? `${plural(commits.length, 'match', 'matches')}${log.data.more ? '+' : ''}${log.data.searched && !log.data.searched.all ? ` in the newest ${log.data.searched.read.toLocaleString()}` : ''}`
    : `${commits.length}${log.data.more ? '+' : ''} commits`) : 'Reading…';
  return (
    <div className="commits">
      <Panel side="left" open={listOpen} onClose={() => onList(false)} className="commits-list" label="History" title={<span role="status">{counted}</span>}
        resizable sizeKey="git-history" size={440} minSize={320} maxSize={720}
        tabs={(
          <div className="commits-toolbar">
            <Segmented size="s" label="Which history" value={all ? 'all' : 'here'} onChange={(v) => pickAll(v === 'all')} options={[
              { value: 'here', label: 'This branch', hint: `${status.branch ?? 'HEAD'} and what it came from` },
              { value: 'all', label: 'All branches', hint: 'Every local and remote branch, and tags' },
            ]} />
            <label className="search-field commits-filter">
              <Icon name="search" size={14} />
              <span className="visually-hidden">Filter commits by message or author</span>
              <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Message or author" spellCheck={false}
                onKeyDown={(e) => { if (e.key === 'Escape' && typed) { e.stopPropagation(); setTyped(''); } }} />
            </label>
          </div>
        )}>
        {log.data && !commits.length ? (
          <EmptyState title={query ? 'No commit matches' : 'No commits'}>{query ? `No commit’s message or author holds “${query}”.` : 'There is nothing in this history yet.'}</EmptyState>
        ) : (
          <ul className={`commit-rows${rows ? ' graphed' : ''}`} ref={list} role="listbox" aria-label="Commits" tabIndex={0} data-tour="commits-list"
            aria-activedescendant={chosen ? `commit-${uid}-${chosen}` : undefined} style={{ '--graph-w': `${rows ? 18 + (width - 1) * 14 : 0}px` } as React.CSSProperties}>
            {commits.map((c, i) => (
              <li key={c.hash} id={`commit-${uid}-${c.hash}`} role="option" aria-selected={c.hash === chosen}
                className={`commit-row${c.hash === chosen ? ' on' : ''}${c.parents.length > 1 ? ' is-merge' : ''}`} onClick={() => { setSelected(c.hash); list.current?.focus({ preventScroll: true }); }}>
                {rows?.[i] ? <GraphCell row={rows[i]!} height={ROW} width={width} merge={c.parents.length > 1} head={c.hash === status.head} /> : null}
                <span className="commit-main">
                  <span className="commit-line">
                    {c.cardKey ? <CardBadge cardKey={c.cardKey} /> : null}
                    {c.refs.map((r) => <Ref key={`${r.kind}:${r.name}`} name={r.name} kind={r.kind} current={!!r.current} />)}
                    <span className="commit-subject">{c.subject}</span>
                  </span>
                  <span className="commit-meta">
                    <span className="commit-author" data-tip={c.email}>{c.author}</span>
                    <time className="commit-when" dateTime={new Date(c.at).toISOString()} data-tip={new Date(c.at).toLocaleString()}>{ago(c.at)}</time>
                    <span className="commit-hash mono">{c.short}</span>
                  </span>
                </span>
              </li>
            ))}
            {log.data?.more ? (
              <li className="commit-more"><Button size="s" tone="quiet" onClick={() => setLimit((n) => n + PAGE)}>Show {PAGE} more</Button></li>
            ) : null}
          </ul>
        )}
      </Panel>
      <div className="commit-pane" data-tour="commits-reader">
        {detail.error ? <EmptyState icon="alert" title="Git could not read the commit">{detail.error.message}</EmptyState>
          : detail.data ? <CommitView project={project} where={where} commit={detail.data} onSelect={setSelected} />
            : chosen ? <p className="git-wait faint">Reading the commit…</p> : null}
      </div>
    </div>
  );
}

const LAYOUT_KEY = 'wanigan.diff.layout';

function CommitView({ project, where, commit, onSelect }: { project: ProjectSummary; where: Where; commit: CommitDetail; onSelect: (hash: string) => void }) {
  const toast = useToast();
  const [layout] = useState<DiffLayout>(() => { try { return localStorage.getItem(LAYOUT_KEY) === 'split' ? 'split' : 'unified'; } catch { return 'unified'; } });
  const copy = (): void => {
    void navigator.clipboard.writeText(commit.hash).then(() => toast('Copied the commit’s full hash.', 'done'), () => toast('The clipboard is not available here.', 'error'));
  };
  const initials = commit.author.split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase();
  return (
    <article className="commit-view" aria-label={`Commit ${commit.short}`}>
      <header className="commit-view-head">
        <div className="commit-view-title">
          {commit.cardKey ? <CardBadge cardKey={commit.cardKey} /> : null}
          <h2>{commit.subject}</h2>
        </div>
        {commit.body ? <p className="commit-body">{commit.body}</p> : null}
        <div className="commit-facts">
          <span className="commit-avatar" aria-hidden="true">{initials}</span>
          <span className="commit-by">
            <strong>{commit.author}</strong> <span className="faint">{commit.email}</span>
            <span className="commit-date">{new Date(commit.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · {ago(commit.at)}</span>
          </span>
        </div>
        <div className="commit-ids">
          <span className="commit-sha mono" data-tip={commit.hash}>{commit.hash.slice(0, 12)}</span>
          <IconButton icon="copy" size="s" label="Copy the full hash" onClick={copy} />
          {commit.parents.length ? (
            <span className="commit-parents">
              {commit.parents.length > 1 ? 'Merge of' : 'After'}{' '}
              {commit.parents.map((p, i) => (
                <span key={p}>{i ? ' and ' : ''}<button type="button" className="linkish mono" onClick={() => onSelect(p)} data-tip="Show this commit">{p.slice(0, 7)}</button></span>
              ))}
            </span>
          ) : <span className="commit-parents">The first commit</span>}
          <span className={`commit-pushed${commit.pushedTo.length ? '' : ' not'}`}>
            {commit.pushedTo.length ? <>On {commit.pushedTo.slice(0, 3).map((r) => <Ref key={r} name={r} kind="remote" />)}{commit.pushedTo.length > 3 ? ` and ${commit.pushedTo.length - 3} more` : ''}</> : 'Not pushed yet'}
          </span>
        </div>
        {commit.refs.length ? <div className="commit-refs">{commit.refs.map((r) => <Ref key={`${r.kind}:${r.name}`} name={r.name} kind={r.kind} current={!!r.current} />)}</div> : null}
      </header>
      <div className="commit-files-head">
        <strong>{plural(commit.files.length, 'file')} changed</strong>
        <span className="add">+{commit.additions}</span>
        <span className="del">−{commit.deletions}</span>
        {commit.parents.length > 1 ? <span className="commit-files-note">against its first parent</span> : null}
      </div>
      <div className="commit-diffs">
        {commit.files.map((f) => (
          <FileDiff key={f.path} projectId={project.id} cardId={where.cardId} file={f} layout={layout} notes={[]} onRemove={() => {}}
            given={{ path: f.path, diff: f.diff ?? '', truncated: f.truncated || f.diff === null }} />
        ))}
      </div>
    </article>
  );
}
