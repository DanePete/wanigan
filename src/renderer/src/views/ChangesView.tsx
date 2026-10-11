// A project's Changes view: the git workbench. One toolbar holds where you
// are (the four parts as tabs, and the checkout: the project folder or a
// card's own worktree, its branch and where it stands against its upstream)
// and what you can do from anywhere in it (pull, push, fetch, stash, a new
// branch). Under it the part shown: the working tree with the diff as the
// hero, the history, the branches, the stashes. A merge (or rebase,
// cherry-pick, revert) git has not finished is the right panel beside the
// diff; an agent at work in the same checkout is said in one line, because it
// is why several acts wait.
import { useEffect, useMemo, useRef, useState } from 'react';
import { cardKeyOfBranch, type GitStatus, type RepoProblem } from '@shared/git';
import { LIVE_STATES, type CardSummary, type ProjectSummary } from '@shared/model';
import { attempt, call, forProject, useQuery } from '../lib/api';
import { GIT_TABS, gitHref, useLocation, type GitTab } from '../lib/router';
import { useGitIntent } from '../lib/git-intent';
import { useHow } from '../lib/how';
import { plural } from '../lib/format';
import { Icon } from '../components/icons';
import { InstallHint } from '../components/Install';
import { MenuButton, type MenuItem } from '../components/Menu';
import { NavTabs } from '../components/Tabs';
import { Panel } from '../components/Panel';
import { Toolbar } from '../components/Toolbar';
import { HowButton } from '../components/How';
import { Button, EmptyState, IconButton, NotAnswering, useToast } from '../components/ui';
import { WorkingTree, type WorkingTreeHandle } from './git/WorkingTree';
import { Commits } from './git/Commits';
import { Branches, NewBranchDialog, type BranchesHandle } from './git/Branches';
import { StashDialog, Stashes } from './git/Stashes';
import { PullRequestChip, RemoteActions } from './git/Remote';
import { ChangesHow } from './git/How';
import { Confirm, Ref, agentName, placeOf } from './git/common';

export { FileDiff } from '../components/FileDiff';

const PANEL_KEY = 'wanigan.git.list';
const readPanel = (): boolean => { try { return localStorage.getItem(PANEL_KEY) !== '0'; } catch { return true; } };

export function ChangesView({ project }: { project: ProjectSummary }) {
  const { branch, tab } = useLocation();
  const cards = useQuery('cards.list', { projectId: project.id }, ['board'], forProject(project.id));
  const branched = (cards.data ?? []).filter((c) => c.worktree);
  const scoped = branch ? branched.find((c) => c.key === branch) ?? null : null;
  const where = useMemo(() => ({ id: project.id, cardId: scoped?.id ?? null }), [project.id, scoped?.id]);
  const status = useQuery('git.status', where, ['git', 'sessions', 'board'], forProject(project.id));
  const how = useHow('changes');

  // Coming back to the window: the owner may have changed files in an editor meanwhile.
  const reload = status.reload;
  useEffect(() => {
    let last = 0;
    const back = (): void => { if (Date.now() - last > 1500) { last = Date.now(); reload(); } };
    window.addEventListener('focus', back);
    return () => window.removeEventListener('focus', back);
  }, [reload]);

  // The list beside the work (the files, the history, the stashes): shown unless put away, on this computer.
  const [list, setList] = useState(readPanel);
  const showList = (on: boolean): void => {
    setList(on);
    try { localStorage.setItem(PANEL_KEY, on ? '1' : '0'); } catch { /* a convenience for this viewer only */ }
  };
  const [dialog, setDialog] = useState<'branch' | 'stash' | null>(null);

  const tree = useRef<WorkingTreeHandle>(null);
  const branchesTab = useRef<BranchesHandle>(null);
  const ready = !!status.data && !status.data.problem;
  useGitIntent(ready && tab === 'changes', ['commit'], () => requestAnimationFrame(() => tree.current?.focusCommit()));
  useGitIntent(ready && tab === 'branches', ['switch'], () => requestAnimationFrame(() => branchesTab.current?.focusFilter()));
  useGitIntent(ready, ['branch'], () => setDialog('branch'));
  useGitIntent(ready, ['stash'], () => setDialog('stash'));

  const to = (t: GitTab, card: string | null | undefined = scoped?.key): string => gitHref(project.key, t, card);

  if (status.error) {
    // A refusal says why; anything else is the core not answering, which is not "nothing to commit".
    const code = (status.error as Error & { code?: string }).code;
    return code === 'refused' || code === 'invalid' || code === 'not_found'
      ? <EmptyState title="Git refused" icon="alert">{status.error.message}</EmptyState>
      : <NotAnswering error={status.error} onRetry={status.reload} />;
  }
  const s = status.data;
  if (!s) return <div className="git git-reading" aria-busy="true"><div className="toolbar-row git-toolbar" /><p className="git-wait faint">Reading git…</p></div>;
  if (s.problem) {
    return (
      <div className="git">
        {branched.length ? (
          <Toolbar label="Git" className="git-toolbar">
            <Checkout project={project} status={s} branched={branched} scoped={scoped} tab={tab} onBranch={() => setDialog('branch')} />
          </Toolbar>
        ) : null}
        <Problem problem={s.problem} path={s.path} />
      </div>
    );
  }

  const local = new Set([...s.conflicted, ...s.staged, ...s.changed, ...s.untracked].map((f) => f.path)).size;
  const count: Partial<Record<GitTab, number>> = { changes: local, stashes: s.stashes };
  const hasList = tab !== 'branches';
  const operation = s.operation ? <Operation where={where} status={s} cards={cards.data ?? []} onReload={reload} /> : null;
  return (
    <div className="git">
      <Toolbar label="Git" className="git-toolbar">
        {hasList ? (
          <IconButton icon="sidebar" size="s" label={list ? 'Hide the list' : 'Show the list'} aria-expanded={list} onClick={() => showList(!list)} />
        ) : null}
        <NavTabs label="Git" className="git-tabs tabs-s" tour="changes-tabs"
          items={GIT_TABS.map((t) => ({ href: to(t.tab), label: t.label, current: t.tab === tab, count: count[t.tab] ?? null }))} />
        <Checkout project={project} status={s} branched={branched} scoped={scoped} tab={tab} onBranch={() => setDialog('branch')} />
        <span className="git-toolbar-gap" />
        <PullRequestChip where={where} status={s} />
        <RemoteActions where={where} status={s} onReload={reload} />
        <IconButton icon="stash" size="s" label="Stash the changes" data-tour="changes-stash" onClick={() => setDialog('stash')} />
        <span className="git-how" data-tour="changes-how"><HowButton onClick={how.show} /></span>
      </Toolbar>
      {s.operation && tab !== 'changes' ? (
        <div className={`git-strip ${s.conflicted.length ? 'git-strip-needs' : ''}`} role="status">
          <Icon name={s.conflicted.length ? 'alert' : 'merge'} size={14} />
          <span className="git-strip-text">
            {operationTitle(s)} · {s.conflicted.length ? `${plural(s.conflicted.length, 'file')} left` : 'nothing left to resolve'}
          </span>
          <a className="git-strip-go" href={to('changes')}>Resolve in Changes</a>
        </div>
      ) : null}
      {s.agents.length ? (
        <div className="git-strip git-agents" role="note">
          <Icon name="terminal" size={14} />
          <span className="git-strip-text">
            {s.agents.map(agentName).join(' and ')} {s.agents.length === 1 ? 'is' : 'are'} working in {placeOf(s)}: switching, merging, pulling, stashing and discarding wait until {s.agents.length === 1 ? 'it stops' : 'they stop'}.
          </span>
        </div>
      ) : null}
      <div className="git-body">
        {tab === 'changes' ? <WorkingTree ref={tree} project={project} where={where} status={s} scoped={scoped} onReload={reload} list={list} onList={showList} aside={operation} /> : null}
        {tab === 'commits' ? <Commits project={project} where={where} status={s} list={list} onList={showList} /> : null}
        {tab === 'branches' ? <Branches ref={branchesTab} project={project} where={where} status={s} onReload={reload} onNew={() => setDialog('branch')} /> : null}
        {tab === 'stashes' ? <Stashes project={project} where={where} status={s} onReload={reload} list={list} onList={showList} onSave={() => setDialog('stash')} /> : null}
      </div>
      {dialog === 'branch' ? <NewBranchDialog project={project} where={where} status={s} onClose={() => setDialog(null)} onDone={reload} /> : null}
      {dialog === 'stash' ? <StashDialog where={where} status={s} onClose={() => setDialog(null)} onDone={reload} /> : null}
      {how.open ? <ChangesHow project={project} status={s} scoped={scoped} onClose={how.hide} /> : null}
    </div>
  );
}

/** "Merging NS-13 into main", in words. */
function operationTitle(s: GitStatus): string {
  const doing = { merge: 'Merging', rebase: 'Rebasing', 'cherry-pick': 'Cherry-picking', revert: 'Reverting' }[s.operation ?? 'merge'];
  return `${doing}${s.operationOf ? ` ${s.operationOf}` : ''}${s.branch && s.operation !== 'rebase' ? ` into ${s.branch}` : ''}`;
}

/**
 * Where you are: the branch checked out, where it stands against its upstream,
 * and (in a menu) the other checkouts, switching branch, and a new one.
 */
function Checkout({ project, status: s, branched, scoped, tab, onBranch }: {
  project: ProjectSummary; status: GitStatus; branched: CardSummary[]; scoped: CardSummary | null; tab: GitTab; onBranch: () => void;
}) {
  const toast = useToast();
  const items: MenuItem[] = [
    ...(branched.length ? [
      { id: 'folder', group: 'Checkout', label: 'The project folder', detail: project.path, kind: 'radio' as const, checked: !scoped,
        run: () => { window.location.hash = gitHref(project.key, tab, null); } },
      ...branched.map((c): MenuItem => ({
        id: `card-${c.id}`, group: 'Checkout', label: `${c.key} · ${c.title}`, detail: c.worktree?.branch ?? '', kind: 'radio', checked: c.id === scoped?.id,
        run: () => { window.location.hash = gitHref(project.key, tab, c.key); },
      })),
    ] : []),
    { id: 'switch', group: 'Branch', label: 'Switch branch…', icon: 'branch', keys: ['Mod', 'B'], disabled: !!s.problem,
      run: () => { window.location.hash = gitHref(project.key, 'branches', scoped?.key); } },
    { id: 'new', group: 'Branch', label: 'New branch…', icon: 'plus', keys: ['Mod', 'Shift', 'B'], disabled: !!s.problem, run: onBranch },
    ...(s.branch ? [{ id: 'copy', group: 'Branch', label: 'Copy the branch’s name', icon: 'copy' as const,
      run: () => { void navigator.clipboard.writeText(s.branch ?? '').then(() => toast(`Copied ${s.branch}.`), () => toast('The clipboard is not available here.', 'error')); } }] : []),
  ];
  const where = scoped ? `${scoped.key}’s worktree` : branched.length ? 'the project folder' : null;
  const standing = s.problem ? null : !s.branch ? 'HEAD points at a commit, not a branch'
    : s.upstream ? (s.upstreamGone ? `its branch on the remote, ${s.upstream}, was deleted`
      : `tracking ${s.upstream}: ${s.ahead || s.behind ? [s.ahead ? `${s.ahead} to push` : '', s.behind ? `${s.behind} to pull` : ''].filter(Boolean).join(', ') : 'in step'}`)
      : s.remotes.length ? 'not pushed yet' : 'no remote';
  const name = s.branch ?? (s.head ? `detached at ${s.head.slice(0, 7)}` : 'no branch');
  return (
    <MenuButton className="git-checkout" width={340} label={`Checkout: ${where ? `${where}, ` : ''}${name}${standing ? `, ${standing}` : ''}. Switch checkout or branch`}
      tip={`${where ? `${where[0]?.toUpperCase()}${where.slice(1)}: ` : ''}${name}${standing ? `, ${standing}` : ''}${s.unborn ? ', no commits yet' : ''}`} items={items}>
      <span className="git-checkout-in" data-tour="changes-branch">
        <Icon name="branch" size={14} />
        {scoped ? <span className="git-checkout-card">{scoped.key}</span> : null}
        {s.branch ? <span className="git-branch-name mono">{s.branch}</span>
          : <span className="git-branch-name">Detached <span className="mono">{s.head?.slice(0, 7)}</span></span>}
        {s.problem ? null : s.upstream ? (
          s.upstreamGone ? <span className="branch-gone">gone</span> : (
            <span className="aheadbehind" aria-hidden="true">
              {s.ahead ? <span>↑{s.ahead}</span> : null}
              {s.behind ? <span>↓{s.behind}</span> : null}
              {!s.ahead && !s.behind ? <Icon name="check" size={12} /> : null}
            </span>
          )
        ) : s.branch ? <span className="git-checkout-note">{s.remotes.length ? 'not pushed' : 'no remote'}</span> : null}
        <Icon name="down" size={12} className="git-checkout-twist" />
      </span>
    </MenuButton>
  );
}

/**
 * A merge (or rebase, cherry-pick, revert) git started and has not finished:
 * the right panel beside the conflicts. What it is, how many files are left,
 * and the ways out, each saying what it does. A merge of a card's branch can
 * also be handed to that card's agent.
 */
function Operation({ where, status, cards, onReload }: { where: { id: string; cardId: string | null }; status: GitStatus; cards: CardSummary[]; onReload: () => void }) {
  const toast = useToast();
  const fail = (m: string): void => toast(m, 'error');
  const [aborting, setAborting] = useState(false);
  if (!status.operation) return null;
  const op = status.operation;
  const left = status.conflicted.length;
  const busy = status.agents.length > 0;
  const busyWhy = busy ? `${agentName(status.agents[0]!)} is working here; this would change files under it` : undefined;
  const abort = async (): Promise<void> => {
    const r = await attempt(() => call('git.abort', where), fail);
    setAborting(false);
    if (r) { toast(`Aborted the ${op}: everything is as it was before it started.`, 'done'); onReload(); }
  };
  const carry = async (): Promise<void> => {
    const r = await attempt(() => call('git.continue', where), fail);
    if (r) { toast(`Continued the ${op}.`, 'done'); onReload(); }
  };
  // A card's branch being merged: its agent can bring the base into its branch and resolve there instead.
  // A merge stopped in a card's own worktree: its agent can resolve it where it is.
  const merging = cards.find((c) => c.key === cardKeyOfBranch(status.operationOf));
  const card = merging ?? (where.cardId ? cards.find((c) => c.id === where.cardId) : undefined);
  const session = card ? (card.holder && LIVE_STATES.has(card.holder.state) ? card.holder.sessionId : card.live?.sessionId ?? null) : null;
  const ask = async (): Promise<void> => {
    if (!card) return;
    const base = status.branch ?? 'its base';
    const files = status.conflicted.map((f) => `${f.path} (${f.conflict})`).join(', ');
    const text = merging ? [
      `Merging ${status.operationOf} into ${base} in the project folder conflicts in ${files}.`,
      `Please bring ${base} into your branch (git merge ${base}), resolve those conflicts there, run the tests, and commit, so ${card.key} merges cleanly.`,
    ].join(' ') : [
      `Merging ${status.operationOf ?? 'another branch'} into your branch ${base} stopped in conflicts in ${files}.`,
      `Please resolve them in your worktree, keeping what each side meant (git shows ours as ${base} and theirs as ${status.operationOf ?? 'the other branch'}), run the tests, and commit the merge.`,
    ].join(' ');
    const r = session
      ? await attempt(() => call('sessions.queue', { id: session, text }), fail).then((x) => x && `Asked ${card.key}’s agent; it gets the message when it is next idle.`)
      : await attempt(() => call('cards.comment', { id: card.id, body: text }), fail).then((x) => x && `Added to ${card.key}; the next session on it is told.`);
    if (r) toast(r, 'done');
  };
  const doing = { merge: 'Merging', rebase: 'Rebasing', 'cherry-pick': 'Cherry-picking', revert: 'Reverting' }[op];
  const what = { merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert' }[op];
  const undo = {
    merge: `Everything goes back to how ${status.branch ?? 'the branch'} was before the merge started (git merge --abort). Files you resolved, and anything staged since it started, lose those changes.`,
    rebase: 'The branch goes back to where it was before the rebase started (git rebase --abort). Commits already replayed are dropped from it; the original commits are untouched.',
    'cherry-pick': 'The branch goes back to before the cherry-pick (git cherry-pick --abort), and the files lose what it brought.',
    revert: 'The branch goes back to before the revert (git revert --abort), and the files lose what it changed.',
  }[op];
  // The file's diff, scrolled to and given the keyboard: already in view, the jump still lands somewhere a reader can follow.
  const jump = (path: string): void => {
    const slot = document.querySelector<HTMLElement>(`.diff-slot[data-path="${CSS.escape(path)}"]`);
    if (!slot) return;
    slot.scrollIntoView({ block: 'start' });
    if (!slot.hasAttribute('tabindex')) slot.tabIndex = -1;
    slot.focus({ preventScroll: true });
  };
  return (
    <Panel side="right" title={`${what} in progress`} className="git-operation" label={`${what} in progress`}>
      <div className={`git-op-head${left ? ' needs' : ''}`} role={left ? 'alert' : 'status'} data-tour="changes-operation">
        <p className="git-op-what">
          {doing}{status.operationOf ? <> <Ref name={status.operationOf} /></> : null}{status.branch && op !== 'rebase' ? <> into <Ref name={status.branch} current /></> : null}
          <span className="git-op-sep" aria-hidden="true"> · </span>
          <span className="git-op-left">{left ? `${plural(left, 'file')} left` : 'nothing left to resolve'}</span>
        </p>
        <p className="git-op-next">
          {left ? `Resolve each: choose ours, theirs or both for every conflict (or write the result), then mark the file resolved.${op === 'merge' ? ' When none are left, complete the merge from the commit box.' : ''}`
            : op === 'merge' ? 'Complete the merge from the commit box: it commits with the message git prepared, after checking it for secrets.'
              : `Continue the ${op} with the message git prepared.`}
        </p>
      </div>
      {left ? (
        <ul className="git-op-files" aria-label="Files still conflicting">
          {status.conflicted.map((f) => (
            <li key={f.path}>
              <button type="button" className="git-op-file" onClick={() => jump(f.path)} data-tip={`Show ${f.path}`}>
                <span className="fname">{f.path.split('/').pop()}</span>
                <span className="git-op-count">{f.hunks ? plural(f.hunks, 'conflict') : f.conflict}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="git-op-acts">
        {op !== 'merge' && !left ? <Button size="s" tone="primary" onClick={carry} disabled={busy} data-tip={busyWhy ?? `git ${op} --continue`}>Continue the {op}</Button> : null}
        {card && left && op === 'merge' ? (
          <Button size="s" icon="send" onClick={ask} data-tip={session ? `Queue a message to ${card.key}’s session listing the conflicts` : `No session is running on ${card.key}: the request goes on the card`}>
            Ask {card.key}’s agent
          </Button>
        ) : null}
        <Button size="s" tone="quiet" onClick={() => setAborting(true)} disabled={busy} data-tip={busyWhy ?? `Put everything back as it was before the ${op}`}>
          Abort the {op}
        </Button>
      </div>
      {aborting ? (
        <Confirm danger title={`Abort the ${op}?`} act={`Abort the ${op}`} onClose={() => setAborting(false)} onAct={abort}>
          <p>{undo}</p>
        </Confirm>
      ) : null}
    </Panel>
  );
}

function Problem({ problem, path }: { problem: RepoProblem; path: string }) {
  switch (problem.kind) {
    case 'no-git': return <EmptyState icon="alert" title="Git is not installed">Wanigan runs your own git, and could not find it on your login shell’s PATH. <InstallHint cli="git" /> Then come back.</EmptyState>;
    case 'missing': return <EmptyState icon="alert" title="The folder is gone">{path} is no longer there.</EmptyState>;
    case 'not-repo': return <EmptyState icon="branch" title="Not a git repository">{path} is not under git, so Wanigan cannot show what changed. Run git init there to start one.</EmptyState>;
    case 'bare': return <EmptyState icon="branch" title="A bare repository">{path} is a bare repository: it has no working files to change.</EmptyState>;
    case 'subfolder': return <EmptyState icon="folder" title="Part of a larger repository">This project is the folder {problem.prefix} inside the repository at {problem.top}. Commits, branches and pushes act on the whole repository, so open {problem.top} as a project to use them here.</EmptyState>;
    case 'unreadable': return <EmptyState icon="alert" title="Git could not read this folder">{problem.reason}.</EmptyState>;
  }
}
