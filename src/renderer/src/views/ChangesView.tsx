// A project's Changes view: the git workbench. Which checkout (the project
// folder, or a card's own worktree), the branch and where it stands against
// its upstream, the tabs (the working tree, Commits, Branches, Stashes), the
// remote actions, and what needs saying above them all: an operation in
// progress, or an agent at work in the same checkout.
import { useEffect, useMemo, useRef, useState } from 'react';
import { cardKeyOfBranch, type GitStatus, type RepoProblem } from '@shared/git';
import { LIVE_STATES, type CardSummary, type ProjectSummary } from '@shared/model';
import { attempt, call, forProject, useQuery } from '../lib/api';
import { GIT_TABS, gitHref, useLocation, type GitTab } from '../lib/router';
import { useGitIntent } from '../lib/git-intent';
import { plural } from '../lib/format';
import { Icon } from '../components/icons';
import { InstallHint } from '../components/Install';
import { Select } from '../components/Select';
import { Button, Empty, NotAnswering, useToast } from '../components/ui';
import { WorkingTree, type WorkingTreeHandle } from './git/WorkingTree';
import { Commits } from './git/Commits';
import { Branches, type BranchesHandle } from './git/Branches';
import { Stashes, type StashesHandle } from './git/Stashes';
import { PullRequestChip, RemoteActions } from './git/Remote';
import { Confirm, Ref, agentName, placeOf } from './git/common';

export { FileDiff } from '../components/FileDiff';

export function ChangesView({ project }: { project: ProjectSummary }) {
  const { branch, tab } = useLocation();
  const cards = useQuery('cards.list', { projectId: project.id }, ['board'], forProject(project.id));
  const branched = (cards.data ?? []).filter((c) => c.worktree);
  const scoped = branch ? branched.find((c) => c.key === branch) ?? null : null;
  const where = useMemo(() => ({ id: project.id, cardId: scoped?.id ?? null }), [project.id, scoped?.id]);
  const status = useQuery('git.status', where, ['git', 'sessions', 'board'], forProject(project.id));

  // Coming back to the window: the owner may have changed files in an editor meanwhile.
  const reload = status.reload;
  useEffect(() => {
    let last = 0;
    const back = (): void => { if (Date.now() - last > 1500) { last = Date.now(); reload(); } };
    window.addEventListener('focus', back);
    return () => window.removeEventListener('focus', back);
  }, [reload]);

  const tree = useRef<WorkingTreeHandle>(null);
  const branchesTab = useRef<BranchesHandle>(null);
  const stashesTab = useRef<StashesHandle>(null);
  const ready = !!status.data && !status.data.problem;
  useGitIntent(ready && tab === 'changes', ['commit'], () => requestAnimationFrame(() => tree.current?.focusCommit()));
  useGitIntent(ready && tab === 'branches', ['switch', 'branch'], (intent) => requestAnimationFrame(() => (intent === 'branch' ? branchesTab.current?.newBranch() : branchesTab.current?.focusFilter())));
  useGitIntent(ready && tab === 'stashes', ['stash'], () => requestAnimationFrame(() => stashesTab.current?.focusSave()));

  const scopePicker = branched.length ? (
    <Select label="Which checkout" size="s" className="git-scope" value={scoped?.key ?? ''}
      onChange={(v) => { window.location.hash = gitHref(project.key, tab, v || null); }}
      options={[{ value: '', label: 'The project folder', detail: project.path }, ...branched.map((c) => ({ value: c.key, label: `${c.key} · ${c.title}`, detail: c.worktree?.branch ?? '' }))]} />
  ) : null;

  if (status.error) {
    // A refusal says why; anything else is the core not answering, which is not "nothing to commit".
    const code = (status.error as Error & { code?: string }).code;
    return code === 'refused' || code === 'invalid' || code === 'not_found'
      ? <div className="view-pad error-text">{status.error.message}</div>
      : <NotAnswering error={status.error} onRetry={status.reload} />;
  }
  const s = status.data;
  if (s?.problem) return <><div className="toolbar">{scopePicker}</div><Problem problem={s.problem} path={s.path} /></>;
  if (!s) return <div className="view-pad faint">Reading git…</div>;

  const local = new Set([...s.conflicted, ...s.staged, ...s.changed, ...s.untracked].map((f) => f.path)).size;
  const count: Partial<Record<GitTab, number>> = { changes: local, stashes: s.stashes };
  return (
    <div className="git">
      <div className="gitbar">
        {scopePicker}
        <span className="gitbar-branch" aria-label="Branch">
          <Icon name="branch" size={15} />
          {s.branch ? <span className="gitbar-name mono" title={`${s.branch}${s.unborn ? ': no commits yet' : ''}`}>{s.branch}</span>
            : <span title="HEAD points at a commit, not a branch">Detached at <span className="mono">{s.head?.slice(0, 7)}</span></span>}
          {s.upstream ? (
            <span className="gitbar-up">
              <Icon name="chevron" size={12} />
              <Ref name={s.upstream} kind="remote" />
              {s.upstreamGone ? <span className="branch-gone" title="Its branch on the remote was deleted">gone</span> : (
                <span className="aheadbehind" aria-label={`${s.ahead} to push, ${s.behind} to pull`}>
                  {s.ahead ? <span title={`${plural(s.ahead, 'commit')} not on ${s.upstream}`}>↑{s.ahead}</span> : null}
                  {s.behind ? <span title={`${plural(s.behind, 'commit')} on ${s.upstream} not here`}>↓{s.behind}</span> : null}
                  {!s.ahead && !s.behind ? <span className="faint">in step</span> : null}
                </span>
              )}
            </span>
          ) : s.branch ? <span className="faint small">{s.remotes.length ? 'not pushed yet' : 'no remote'}</span> : null}
        </span>
        <nav className="git-tabs" aria-label="Git">
          {GIT_TABS.map((t) => (
            <a key={t.tab} href={gitHref(project.key, t.tab, scoped?.key)} className={t.tab === tab ? 'on' : ''} aria-current={t.tab === tab ? 'page' : undefined}>
              {t.label}{count[t.tab] ? <span className="count">{count[t.tab]}</span> : null}
            </a>
          ))}
        </nav>
        <span className="gitbar-end">
          <PullRequestChip where={where} status={s} />
          <RemoteActions where={where} status={s} onReload={reload} />
        </span>
      </div>
      <Operation where={where} status={s} cards={cards.data ?? []} onReload={reload} />
      {s.agents.length ? (
        <div className="banner banner-quiet git-agents" role="note">
          <Icon name="terminal" size={15} />
          <span className="banner-text">
            {s.agents.map(agentName).join(' and ')} {s.agents.length === 1 ? 'is' : 'are'} working in {placeOf(s)}: switching, merging, pulling, stashing and discarding wait until {s.agents.length === 1 ? 'it stops' : 'they stop'}.
          </span>
        </div>
      ) : null}
      <div className="git-body">
        {tab === 'changes' ? <WorkingTree ref={tree} project={project} where={where} status={s} scoped={scoped} onReload={reload} /> : null}
        {tab === 'commits' ? <Commits project={project} where={where} status={s} /> : null}
        {tab === 'branches' ? <Branches ref={branchesTab} project={project} where={where} status={s} onReload={reload} /> : null}
        {tab === 'stashes' ? <Stashes ref={stashesTab} project={project} where={where} status={s} onReload={reload} /> : null}
      </div>
    </div>
  );
}

/**
 * A merge (or rebase, cherry-pick, revert) git started and has not finished:
 * what it is, how many files are left, and the ways out, each saying what it
 * does. A merge of a card's branch can also be handed to that card's agent.
 */
function Operation({ where, status, cards, onReload }: { where: { id: string; cardId: string | null }; status: GitStatus; cards: CardSummary[]; onReload: () => void }) {
  const toast = useToast();
  const fail = (m: string): void => toast(m, 'error');
  const [aborting, setAborting] = useState(false);
  if (!status.operation) return null;
  const op = status.operation;
  const of = status.operationOf ? <> <Ref name={status.operationOf} /></> : null;
  const left = status.conflicted.length;
  const busy = status.agents.length > 0;
  const busyWhy = busy ? `${agentName(status.agents[0]!)} is working here; this would change files under it` : undefined;
  const abort = async (): Promise<void> => {
    const r = await attempt(() => call('git.abort', where), fail);
    setAborting(false);
    if (r) { toast(`Aborted the ${op}: everything is as it was before it started.`); onReload(); }
  };
  const carry = async (): Promise<void> => {
    const r = await attempt(() => call('git.continue', where), fail);
    if (r) { toast(`Continued the ${op}.`); onReload(); }
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
    if (r) toast(r);
  };
  const doing = { merge: 'Merging', rebase: 'Rebasing', 'cherry-pick': 'Cherry-picking', revert: 'Reverting' }[op];
  const undo = {
    merge: `Everything goes back to how ${status.branch ?? 'the branch'} was before the merge started (git merge --abort). Files you resolved, and anything staged since it started, lose those changes.`,
    rebase: 'The branch goes back to where it was before the rebase started (git rebase --abort). Commits already replayed are dropped from it; the original commits are untouched.',
    'cherry-pick': 'The branch goes back to before the cherry-pick (git cherry-pick --abort), and the files lose what it brought.',
    revert: 'The branch goes back to before the revert (git revert --abort), and the files lose what it changed.',
  }[op];
  return (
    <div className={`banner git-operation ${left ? 'banner-amber' : 'banner-quiet'}`} role={left ? 'alert' : 'status'}>
      <Icon name={left ? 'alert' : 'merge'} size={15} />
      <span className="banner-text">
        <strong>
          {doing}{of}{status.branch && op !== 'rebase' ? <> into <Ref name={status.branch} current /></> : null}
          {' · '}{left ? `${plural(left, 'file')} left` : 'nothing left to resolve'}
        </strong>
        {' '}
        {left ? `Resolve each below: choose ours, theirs or both for every conflict (or write the result), then mark the file resolved.${op === 'merge' ? ' When none are left, complete the merge from the commit box.' : ''}`
          : op === 'merge' ? 'Complete the merge from the commit box: it commits with the message git prepared, after checking it for secrets.'
            : `Continue the ${op} with the message git prepared.`}
      </span>
      {card && left && op === 'merge' ? (
        <Button size="s" tone="quiet" icon="send" onClick={ask} title={session ? `Queue a message to ${card.key}’s session listing the conflicts` : `No session is running on ${card.key}: the request goes on the card`}>
          Ask {card.key}’s agent
        </Button>
      ) : null}
      {op !== 'merge' && !left ? <Button size="s" tone="primary" onClick={carry} disabled={busy} title={busyWhy ?? `git ${op} --continue`}>Continue the {op}</Button> : null}
      <Button size="s" tone={left ? 'plain' : 'quiet'} onClick={() => setAborting(true)} disabled={busy} title={busyWhy ?? `Put everything back as it was before the ${op}`}>
        Abort the {op}
      </Button>
      {aborting ? (
        <Confirm danger title={`Abort the ${op}?`} act={`Abort the ${op}`} onClose={() => setAborting(false)} onAct={abort}>
          <p>{undo}</p>
        </Confirm>
      ) : null}
    </div>
  );
}

function Problem({ problem, path }: { problem: RepoProblem; path: string }) {
  switch (problem.kind) {
    case 'no-git': return <Empty title="Git is not installed">Wanigan runs your own git, and could not find it on your login shell’s PATH. <InstallHint cli="git" /> Then come back.</Empty>;
    case 'missing': return <Empty title="The folder is gone">{path} is no longer there.</Empty>;
    case 'not-repo': return <Empty title="Not a git repository">{path} is not under git, so Wanigan cannot show what changed. Run git init there to start one.</Empty>;
    case 'bare': return <Empty title="A bare repository">{path} is a bare repository: it has no working files to change.</Empty>;
    case 'subfolder': return <Empty title="Part of a larger repository">This project is the folder {problem.prefix} inside the repository at {problem.top}. Commits, branches and pushes act on the whole repository, so open {problem.top} as a project to use them here.</Empty>;
    case 'unreadable': return <Empty title="Git could not read this folder">{problem.reason}.</Empty>;
  }
}
