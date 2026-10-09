// The Branches tab: every local branch and every remote one, with where each
// stands against its upstream and whether it is merged here. Switch, make a
// branch, merge one into the branch checked out (a conflict is left for the
// owner, with Abort beside it), and delete one: merged branches go quietly; a
// branch with work nowhere else needs "delete anyway", which says how much.
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { branchNameProblem, type BranchInfo, type GitStatus, type MergePreview } from '@shared/git';
import type { ProjectSummary } from '@shared/model';
import { attempt, call, forProject, useQuery } from '../../lib/api';
import { gitHref } from '../../lib/router';
import { ago, plural } from '../../lib/format';
import { Icon } from '../../components/icons';
import { Select } from '../../components/Select';
import { Button, Empty, useToast } from '../../components/ui';
import { CardBadge, Confirm, Ref, agentName, placeOf, type Where } from './common';

export interface BranchesHandle { newBranch(): void; focusFilter(): void }

type Pending =
  | { kind: 'merge'; branch: BranchInfo; preview: MergePreview | null }
  | { kind: 'delete'; branch: BranchInfo };

export const Branches = forwardRef<BranchesHandle, { project: ProjectSummary; where: Where; status: GitStatus; onReload: () => void }>(function Branches({ project, where, status, onReload }, handle) {
  const toast = useToast();
  const fail = (m: string): void => toast(m, 'error');
  const data = useQuery('git.branches', where, ['git'], forProject(project.id));
  const [filter, setFilter] = useState('');
  const [making, setMaking] = useState(false);
  const [name, setName] = useState('');
  const [from, setFrom] = useState('');
  const [wantsSwitch, setSwitchTo] = useState(true);
  const [pending, setPending] = useState<Pending | null>(null);
  const filterBox = useRef<HTMLInputElement>(null);
  const nameBox = useRef<HTMLInputElement>(null);
  useImperativeHandle(handle, () => ({
    newBranch: () => { setMaking(true); requestAnimationFrame(() => nameBox.current?.focus()); },
    focusFilter: () => filterBox.current?.focus(),
  }), []);

  const current = data.data?.current ?? status.branch;
  const busy = status.agents.length > 0;
  // With an agent at work here, a new branch is made where it starts and nothing is switched.
  const switchTo = wantsSwitch && !busy;
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
  const problem = name.trim() ? branchNameProblem(name.trim()) : null;

  const act = async <T,>(work: () => Promise<T>, done: (r: T) => void): Promise<void> => {
    const r = await attempt(work, fail);
    if (r !== undefined) { done(r); onReload(); data.reload(); }
  };
  const create = (): Promise<void> => act(
    () => call('git.createBranch', { ...where, name: name.trim(), from: from || null, checkout: switchTo }),
    (r) => { toast(switchTo ? `Made ${r.branch} and switched to it.` : `Made ${r.branch}.`); setName(''); setMaking(false); },
  );
  const switchTo_ = (b: BranchInfo): Promise<void> => act(
    () => call('git.switch', { ...where, branch: b.name, remote: !!b.remote }),
    (r) => toast(`Switched to ${r.branch}.`),
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
    } else toast(r.outcome === 'up-to-date' ? `${current} already has everything on ${b.name}.` : r.outcome === 'fast-forward' ? `${current} moved up to ${b.name} (a fast-forward).` : `Merged ${b.name} into ${current} (${r.commit}).`);
  });
  const remove = (b: BranchInfo, force: boolean): Promise<void> => act(() => call('git.deleteBranch', { ...where, name: b.name, force }), (r) => {
    setPending(null);
    toast(r.lost ? `Deleted ${b.name} and ${plural(r.lost, 'commit')} only it had.` : `Deleted ${b.name}.`);
  });

  if (data.error) return <div className="view-pad error-text">{data.error.message}</div>;

  const row = (b: BranchInfo) => (
    <li key={`${b.remote ?? ''}${b.name}`} className={`branch-row${b.current ? ' current' : ''}`}>
      <span className="branch-mark" aria-hidden="true">{b.current ? <Icon name="check" size={14} /> : <Icon name="branch" size={14} />}</span>
      <span className="branch-main">
        <span className="branch-name-line">
          <span className="branch-name mono" title={b.name}>{b.name}</span>
          {b.current ? <span className="branch-flag">checked out</span> : null}
          {b.cardKey ? <CardBadge cardKey={b.cardKey} /> : null}
          {b.worktree ? <span className="branch-flag" title={b.worktree}>in a worktree</span> : null}
          {b.merged && !b.current ? <span className="branch-flag merged" title={`Everything on it is already in ${current}`}>merged</span> : null}
        </span>
        <span className="branch-last">
          {b.subject ? <span className="branch-subject" title={b.subject}>{b.subject}</span> : null}
          {b.at ? <span className="faint"> · {ago(b.at)}{b.author ? ` by ${b.author}` : ''}</span> : null}
        </span>
      </span>
      <span className="branch-track">
        {b.upstream ? (
          <>
            <Ref name={b.upstream} kind="remote" />
            {b.upstreamGone ? <span className="branch-gone" title="Its branch on the remote was deleted">gone</span> : (
              <span className="aheadbehind" aria-label={`${b.ahead} ahead, ${b.behind} behind`}>
                {b.ahead ? <span title={`${plural(b.ahead, 'commit')} not on ${b.upstream}`}>↑{b.ahead}</span> : null}
                {b.behind ? <span title={`${plural(b.behind, 'commit')} on ${b.upstream} not here`}>↓{b.behind}</span> : null}
                {!b.ahead && !b.behind ? <span className="faint">in step</span> : null}
              </span>
            )}
          </>
        ) : b.remote ? null : <span className="faint small">not pushed</span>}
      </span>
      <span className="branch-row-actions">
        {b.current ? null : (
          <>
            <Button size="s" onClick={() => switchTo_(b)} disabled={busy || !!b.worktree} title={busyWhy ?? (b.worktree ? `Checked out in ${b.worktree}` : `Check out ${b.name} here`)}>
              {b.remote ? 'Check out' : 'Switch'}
            </Button>
            {current ? (
              <Button size="s" tone="quiet" icon="merge" onClick={() => askMerge(b)} disabled={busy || !!status.operation} title={busyWhy ?? `Merge ${b.name} into ${current}`}>Merge</Button>
            ) : null}
            {b.remote ? null : (
              <Button size="s" tone="quiet" icon="trash" onClick={() => setPending({ kind: 'delete', branch: b })} aria-label={`Delete ${b.name}`} title={b.worktree ? `Checked out in ${b.worktree}` : `Delete ${b.name}`} disabled={!!b.worktree}>Delete</Button>
            )}
          </>
        )}
      </span>
    </li>
  );

  return (
    <div className="branches view-pad-tight">
      <div className="toolbar branches-toolbar">
        <label className="search-field">
          <Icon name="search" size={14} />
          <span className="visually-hidden">Filter branches</span>
          <input ref={filterBox} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter branches" spellCheck={false} />
        </label>
        <span className="toolbar-end">
          <Button tone={making ? 'quiet' : 'plain'} icon="plus" size="s" onClick={() => { setMaking((m) => !m); requestAnimationFrame(() => nameBox.current?.focus()); }} aria-expanded={making}>New branch</Button>
        </span>
      </div>
      {making ? (
        <form className="branch-new" onSubmit={(e) => { e.preventDefault(); if (name.trim() && !problem) void create(); }} aria-label="New branch">
          <label className="visually-hidden" htmlFor="branch-new-name">Name of the new branch</label>
          <input id="branch-new-name" ref={nameBox} className="mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="feature/name" spellCheck={false} autoComplete="off"
            aria-invalid={!!problem} aria-describedby="branch-new-why" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setMaking(false); } }} />
          <span className="faint small">from</span>
          <Select label="Start the branch from" size="s" value={from} onChange={setFrom} options={[
            { value: '', label: current ? `${current} (checked out)` : 'HEAD', detail: 'Where you are now' },
            ...(data.data?.local ?? []).filter((b) => !b.current).map((b) => ({ value: b.name, label: b.name, group: 'Local' })),
            ...(data.data?.remote ?? []).map((b) => ({ value: b.name, label: b.name, group: 'Remote' })),
          ]} />
          <label className="branch-new-switch">
            <input type="checkbox" checked={switchTo} onChange={(e) => setSwitchTo(e.target.checked)} disabled={busy} title={busyWhy} />
            Switch to it
          </label>
          <Button tone="primary" size="s" type="submit" disabled={!name.trim() || !!problem} title={!name.trim() ? 'Name the branch first' : problem ?? undefined}>Make the branch</Button>
          <p id="branch-new-why" className={`branch-new-why small${problem ? ' error-text' : ' faint'}`} role="status">
            {problem ?? (switchTo ? 'Your uncommitted changes come with you to the new branch.'
              : busy ? 'Made where it starts, without switching: an agent is working here.' : 'Made where it starts; nothing here changes.')}
          </p>
        </form>
      ) : null}
      {!data.data ? <p className="faint view-pad">Reading branches…</p> : (
        <>
          <section className="branch-group" aria-labelledby="branches-local">
            <h3 id="branches-local" className="branch-group-head">Local <span className="faint">{local.length}</span></h3>
            {local.length ? <ul className="branch-list">{local.map(row)}</ul> : <p className="faint small">No local branch matches.</p>}
          </section>
          {remoteGroups.map(([remote, list]) => (
            <section key={remote} className="branch-group" aria-labelledby={`branches-${remote}`}>
              <h3 id={`branches-${remote}`} className="branch-group-head">On {remote} <span className="faint">{list.length}</span></h3>
              <ul className="branch-list">{list.map(row)}</ul>
            </section>
          ))}
          {!remoteGroups.length && !q ? <Empty title="No remote branches">{status.remotes.length ? 'Fetch to see what the remote has.' : 'This repository has no remote yet.'}</Empty> : null}
        </>
      )}

      {pending?.kind === 'merge' ? (
        <Confirm title={`Merge ${pending.branch.name} into ${current}?`} act={pending.preview?.incoming === 0 ? 'Nothing to merge' : 'Merge'}
          disabled={!pending.preview || pending.preview.incoming === 0} onClose={() => setPending(null)} onAct={() => merge(pending.branch)}>
          {!pending.preview ? <p className="faint">Reading what it brings in…</p> : pending.preview.incoming === 0 ? (
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
                  <li key={c.hash}><span className="mono faint">{c.short}</span> {c.subject} <span className="faint">· {c.author}, {ago(c.at)}</span></li>
                ))}
              </ul>
              {pending.preview.incoming > pending.preview.commits.length ? <p className="faint small">and {pending.preview.incoming - pending.preview.commits.length} more.</p> : null}
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
