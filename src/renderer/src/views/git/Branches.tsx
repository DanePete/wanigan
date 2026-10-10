// The Branches tab: every local branch and every remote one, as the work on
// the canvas, with where each stands against its upstream and whether it is
// merged here. Switch, merge one into the branch checked out (previewed in a
// dialog; a conflict is left for the owner, with Abort beside it), and delete
// one: merged branches go quietly; a branch with work nowhere else needs
// "delete anyway", which says how much. A new branch is a dialog the toolbar
// opens from any tab (NewBranchDialog).
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { branchNameProblem, type BranchInfo, type GitStatus, type MergePreview } from '@shared/git';
import type { ProjectSummary } from '@shared/model';
import { attempt, call, forProject, useQuery } from '../../lib/api';
import { gitHref } from '../../lib/router';
import { ago, plural } from '../../lib/format';
import { Icon } from '../../components/icons';
import { Select } from '../../components/Select';
import { Button, Dialog, EmptyState, tipProps, useToast } from '../../components/ui';
import { CardBadge, Confirm, Ref, agentName, placeOf, type Where } from './common';

export interface BranchesHandle { focusFilter(): void }

type Pending =
  | { kind: 'merge'; branch: BranchInfo; preview: MergePreview | null }
  | { kind: 'delete'; branch: BranchInfo };

export const Branches = forwardRef<BranchesHandle, { project: ProjectSummary; where: Where; status: GitStatus; onReload: () => void; onNew: () => void }>(function Branches({ project, where, status, onReload, onNew }, handle) {
  const toast = useToast();
  const fail = (m: string): void => toast(m, 'error');
  const data = useQuery('git.branches', where, ['git'], forProject(project.id));
  const [filter, setFilter] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const filterBox = useRef<HTMLInputElement>(null);
  useImperativeHandle(handle, () => ({ focusFilter: () => filterBox.current?.focus() }), []);

  const current = data.data?.current ?? status.branch;
  const busy = status.agents.length > 0;
  const busyWhy = busy ? `${agentName(status.agents[0]!)} is working in ${placeOf(status)}` : undefined;
  const q = filter.trim().toLowerCase();
  const shown = (list: BranchInfo[]): BranchInfo[] => list.filter((b) => !q || b.name.toLowerCase().includes(q) || (b.subject ?? '').toLowerCase().includes(q));
  const local = shown(data.data?.local ?? []);
  const remoteGroups = useMemo(() => {
    const groups = new Map<string, BranchInfo[]>();
    for (const b of data.data?.remote ?? []) {
      if (q && !b.name.toLowerCase().includes(q) && !(b.subject ?? '').toLowerCase().includes(q)) continue;
      const list = groups.get(b.remote ?? '') ?? [];
      list.push(b);
      groups.set(b.remote ?? '', list);
    }
    return [...groups];
  }, [data.data, q]);
  const act = async <T,>(work: () => Promise<T>, done: (r: T) => void): Promise<void> => {
    const r = await attempt(work, fail);
    if (r !== undefined) { done(r); onReload(); data.reload(); }
  };
  const switchTo_ = (b: BranchInfo): Promise<void> => act(
    () => call('git.switch', { ...where, branch: b.name, remote: !!b.remote }),
    (r) => toast(`Switched to ${r.branch}.`, 'done'),
  );
  const askMerge = async (b: BranchInfo): Promise<void> => {
    setPending({ kind: 'merge', branch: b, preview: null });
    const preview = await attempt(() => call('git.mergePreview', { ...where, branch: b.name }), fail);
    setPending((p) => (p?.kind === 'merge' && p.branch === b ? { ...p, preview: preview ?? null } : p));
  };
  const merge = (b: BranchInfo): Promise<void> => act(() => call('git.merge', { ...where, branch: b.name }), (r) => {
    setPending(null);
    if (r.outcome === 'conflict') {
      toast(`Merging ${b.name} conflicted in ${plural(r.conflicts.length, 'file')}. Resolve ${r.conflicts.length === 1 ? 'it' : 'them'} in Changes, or abort the merge.`, 'error');
      window.location.hash = gitHref(project.key, 'changes', status.cardKey);
    } else toast(r.outcome === 'up-to-date' ? `${current} already has everything on ${b.name}.` : r.outcome === 'fast-forward' ? `${current} moved up to ${b.name} (a fast-forward).` : `Merged ${b.name} into ${current} (${r.commit}).`, 'done');
  });
  const remove = (b: BranchInfo, force: boolean): Promise<void> => act(() => call('git.deleteBranch', { ...where, name: b.name, force }), (r) => {
    setPending(null);
    toast(r.lost ? `Deleted ${b.name} and ${plural(r.lost, 'commit')} only it had.` : `Deleted ${b.name}.`, 'done');
  });

  if (data.error) return <EmptyState icon="alert" title="Git could not read the branches">{data.error.message}</EmptyState>;

  const row = (b: BranchInfo) => (
    <li key={`${b.remote ?? ''}${b.name}`} className={`branch-row${b.current ? ' current' : ''}`}>
      <span className="branch-mark" aria-hidden="true">{b.current ? <Icon name="check" size={14} /> : <Icon name="branch" size={14} />}</span>
      <span className="branch-main">
        <span className="branch-name-line">
          <span className="branch-name mono" data-tip={b.name}>{b.name}</span>
          {b.current ? <span className="branch-flag">checked out</span> : null}
          {b.cardKey ? <CardBadge cardKey={b.cardKey} /> : null}
          {b.worktree ? <span className="branch-flag" data-tip={b.worktree}>in a worktree</span> : null}
          {b.merged && !b.current ? <span className="branch-flag merged" data-tip={`Everything on it is already in ${current}`}>merged</span> : null}
        </span>
        <span className="branch-last">
          {b.subject ? <span className="branch-subject">{b.subject}</span> : null}
          {b.at ? <span className="branch-when">{b.subject ? '· ' : ''}{ago(b.at)}{b.author ? ` by ${b.author}` : ''}</span> : null}
        </span>
      </span>
      <span className="branch-track">
        {b.upstream ? (
          <>
            <Ref name={b.upstream} kind="remote" />
            {b.upstreamGone ? <span className="branch-gone" data-tip="Its branch on the remote was deleted">gone</span> : (
              <span className="aheadbehind" aria-label={`${b.ahead} ahead, ${b.behind} behind`}>
                {b.ahead ? <span data-tip={`${plural(b.ahead, 'commit')} not on ${b.upstream}`}>↑{b.ahead}</span> : null}
                {b.behind ? <span data-tip={`${plural(b.behind, 'commit')} on ${b.upstream} not here`}>↓{b.behind}</span> : null}
                {!b.ahead && !b.behind ? <span className="faint">in step</span> : null}
              </span>
            )}
          </>
        ) : b.remote ? null : <span className="branch-note">not pushed</span>}
      </span>
      <span className="branch-row-actions">
        {b.current ? null : (
          <>
            <Button size="s" onClick={() => switchTo_(b)} disabled={busy || !!b.worktree} data-tip={busyWhy ?? (b.worktree ? `Checked out in ${b.worktree}` : `Check out ${b.name} here`)}>
              {b.remote ? 'Check out' : 'Switch'}
            </Button>
            {current ? (
              <Button size="s" tone="quiet" icon="merge" onClick={() => askMerge(b)} disabled={busy || !!status.operation} data-tip={busyWhy ?? `Merge ${b.name} into ${current}`}>Merge</Button>
            ) : null}
            {b.remote ? null : (
              <Button size="s" tone="quiet" icon="trash" onClick={() => setPending({ kind: 'delete', branch: b })} aria-label={`Delete ${b.name}`} data-tip={b.worktree ? `Checked out in ${b.worktree}` : `Delete ${b.name}`} disabled={!!b.worktree}>Delete</Button>
            )}
          </>
        )}
      </span>
    </li>
  );

  const total = (data.data?.local.length ?? 0) + (data.data?.remote.length ?? 0);
  return (
    <div className="branches">
      <div className="branches-sheet" data-tour="branches-list">
        <div className="branches-toolbar">
          <label className="search-field">
            <Icon name="search" size={14} />
            <span className="visually-hidden">Filter branches</span>
            <input ref={filterBox} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter branches" spellCheck={false}
              onKeyDown={(e) => { if (e.key === 'Escape' && filter) { e.stopPropagation(); setFilter(''); } }} />
          </label>
          <span className="branches-count" role="status">{data.data ? (q ? `${local.length + remoteGroups.reduce((n, [, l]) => n + l.length, 0)} of ${total}` : plural(total, 'branch', 'branches')) : ''}</span>
          <Button size="s" icon="plus" onClick={onNew} {...tipProps('New branch', 'git-branch')}>New branch</Button>
        </div>
        {!data.data ? <p className="git-wait faint">Reading branches…</p> : (
          <>
            <section className="branch-group" aria-labelledby="branches-local">
              <h3 id="branches-local" className="branch-group-head">Local <span className="branch-group-count">{local.length}</span></h3>
              {local.length ? <ul className="branch-list">{local.map(row)}</ul> : <p className="branch-none">No local branch matches.</p>}
            </section>
            {remoteGroups.map(([remote, list]) => (
              <section key={remote} className="branch-group" aria-labelledby={`branches-${remote}`}>
                <h3 id={`branches-${remote}`} className="branch-group-head">On {remote} <span className="branch-group-count">{list.length}</span></h3>
                <ul className="branch-list">{list.map(row)}</ul>
              </section>
            ))}
            {!remoteGroups.length && !q ? <EmptyState icon="branch" title="No remote branches">{status.remotes.length ? 'Fetch to see what the remote has.' : 'This repository has no remote yet.'}</EmptyState> : null}
          </>
        )}
      </div>

      {pending?.kind === 'merge' ? (
        <Confirm title={`Merge ${pending.branch.name} into ${current}?`} act={pending.preview?.incoming === 0 ? 'Nothing to merge' : 'Merge'}
          disabled={!pending.preview || pending.preview.incoming === 0} onClose={() => setPending(null)} onAct={() => merge(pending.branch)}>
          {!pending.preview ? <p className="git-wait faint">Reading what it brings in…</p> : pending.preview.incoming === 0 ? (
            <p>{current} already has every commit on {pending.branch.name}.</p>
          ) : (
            <>
              <p>
                {plural(pending.preview.incoming, 'commit')} come{pending.preview.incoming === 1 ? 's' : ''} in.{' '}
                {pending.preview.outgoing === 0
                  ? `${current} has nothing ${pending.branch.name} lacks, so it simply moves up to it (a fast-forward): no merge commit.`
                  : `Both have moved on since they parted, so git makes a merge commit. If both changed the same lines, the merge stops for you to resolve them, with Abort beside it.`}
              </p>
              <ul className="plain-commits">
                {pending.preview.commits.map((c) => (
                  <li key={c.hash}><span className="mono plain-sha">{c.short}</span> <span className="plain-subject">{c.subject}</span> <span className="plain-by">{c.author}, {ago(c.at)}</span></li>
                ))}
              </ul>
              {pending.preview.incoming > pending.preview.commits.length ? <p className="git-more">and {pending.preview.incoming - pending.preview.commits.length} more.</p> : null}
            </>
          )}
        </Confirm>
      ) : null}
      {pending?.kind === 'delete' ? (
        <Confirm danger={!pending.branch.merged} title={`Delete ${pending.branch.name}?`} act={pending.branch.merged ? 'Delete' : 'Delete anyway'}
          onClose={() => setPending(null)} onAct={() => remove(pending.branch, !pending.branch.merged)}>
          {pending.branch.merged ? (
            <p>Everything on it is already in {current}, so nothing is lost{pending.branch.upstream ? `; ${pending.branch.upstream} on the remote is left as it is` : ''}.</p>
          ) : (
            <p>
              {pending.branch.name} has commits that are not in {current}. Deleting it anyway loses the ones no other branch has, and Wanigan cannot bring them back.
              {pending.branch.upstream && !pending.branch.ahead ? ` They are on ${pending.branch.upstream}, so the remote still has them.` : ''}
            </p>
          )}
        </Confirm>
      ) : null}
    </div>
  );
});

/**
 * A new branch, from the toolbar on any tab (or ⌘⇧B): its name (checked as it
 * is typed), where it starts, and whether to switch to it. With an agent at
 * work in the checkout it is made where it starts and nothing is switched.
 */
export function NewBranchDialog({ project, where, status, onClose, onDone }: {
  project: ProjectSummary; where: Where; status: GitStatus; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const data = useQuery('git.branches', where, ['git'], forProject(project.id));
  const [name, setName] = useState('');
  const [from, setFrom] = useState('');
  const [wantsSwitch, setSwitchTo] = useState(true);
  const busy = status.agents.length > 0;
  const switchTo = wantsSwitch && !busy;
  const busyWhy = busy ? `${agentName(status.agents[0]!)} is working in ${placeOf(status)}` : undefined;
  const current = data.data?.current ?? status.branch;
  const problem = name.trim() ? branchNameProblem(name.trim()) : null;
  const create = async (): Promise<void> => {
    if (!name.trim() || problem) return;
    const r = await attempt(() => call('git.createBranch', { ...where, name: name.trim(), from: from || null, checkout: switchTo }), (m) => toast(m, 'error'));
    if (!r) return;
    toast(switchTo ? `Made ${r.branch} and switched to it.` : `Made ${r.branch}.`, 'done');
    onDone();
    onClose();
  };
  return (
    <Dialog title="New branch" onClose={onClose} width={520} footer={(
      <>
        <Button tone="quiet" onClick={onClose}>Cancel</Button>
        <Button tone="primary" type="submit" form="branch-new" disabled={!name.trim() || !!problem} data-tip={!name.trim() ? 'Name the branch first' : problem ?? undefined}>Make the branch</Button>
      </>
    )}>
      <form id="branch-new" className="branch-new" onSubmit={(e) => { e.preventDefault(); void create(); }} aria-label="New branch">
        <div className="field">
          <label htmlFor="branch-new-name">Branch name</label>
          <input id="branch-new-name" className="mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="feature/name" spellCheck={false} autoComplete="off"
            aria-invalid={!!problem} aria-describedby="branch-new-why" data-autofocus />
        </div>
        <div className="field">
          <label htmlFor="branch-new-from">Start it from</label>
          <Select id="branch-new-from" value={from} onChange={setFrom} options={[
            { value: '', label: current ? `${current} (checked out)` : 'HEAD', detail: 'Where you are now' },
            ...(data.data?.local ?? []).filter((b) => !b.current).map((b) => ({ value: b.name, label: b.name, group: 'Local' })),
            ...(data.data?.remote ?? []).map((b) => ({ value: b.name, label: b.name, group: 'Remote' })),
          ]} />
        </div>
        <label className="git-check branch-new-switch" data-tip={busyWhy}>
          <input type="checkbox" checked={switchTo} onChange={(e) => setSwitchTo(e.target.checked)} disabled={busy} />
          Switch to it
        </label>
        <p id="branch-new-why" className={`branch-new-why${problem ? ' error-text' : ''}`} role="status">
          {problem ?? (switchTo ? 'Your uncommitted changes come with you to the new branch.'
            : busy ? 'Made where it starts, without switching: an agent is working here.' : 'Made where it starts; nothing here changes.')}
        </p>
      </form>
    </Dialog>
  );
}
