// The card's project changes, isolated branch, and pull-request publishing.
import { useEffect, useState } from 'react';
import { LIVE_STATES, type CardDetail, type PullRequestPlan, type Session } from '@shared/model';
import { attempt, call, useQuery } from '../lib/api';
import { branchHref, gitHref, href } from '../lib/router';
import { plural } from '../lib/format';
import { Icon } from '../components/icons';
import { Confirm } from './git/common';
import { Button, useToast } from '../components/ui';

/** A pointer to the folder's uncommitted changes while a card is being worked or reviewed. */
export function ProjectChanges({ projectId, projectKey }: { projectId: string; projectKey: string }) {
  const changes = useQuery('projects.changes', { id: projectId }, ['sessions'], (_e, d) => (d as { projectId?: string })?.projectId === projectId);
  if (changes.error) return (
    <section className="drawer-section">
      <h3>Changes in the project</h3>
      <p className="error-text" role="alert">{changes.error.message}</p>
      <Button size="s" tone="quiet" onClick={changes.reload}>Retry</Button>
    </section>
  );
  if (!changes.data?.git || !changes.data.files.length) return null;
  return (
    <section className="drawer-section">
      <h3>Changes in the project</h3>
      <p className="changes-pointer">
        <a href={href({ name: 'project', projectKey, view: 'changes' })}>
          {changes.data.files.length === 1 ? '1 file' : `${changes.data.files.length} files`} changed
        </a>
        <span className="add">+{changes.data.additions}</span>
        <span className="del">−{changes.data.deletions}</span>
        <span className="faint small">uncommitted, in the whole folder, not only this card’s</span>
      </p>
    </section>
  );
}

/** The card's own branch: what it changed, and merging it back. */
export function Branch({ card, projectKey, folderAgents }: { card: CardDetail; projectKey: string; folderAgents: Session[] }) {
  const toast = useToast();
  const fail = (m: string): void => toast(m, 'error');
  const wt = card.worktree as NonNullable<CardDetail['worktree']>;
  const changes = useQuery('projects.changes', { id: card.projectId, cardId: card.id }, ['sessions', 'board'], (_e, d) => (d as { projectId?: string })?.projectId === card.projectId);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  /** Why the last merge stopped, when it was a conflict: then it can be resolved, handed to the agent, or left. */
  const [conflict, setConflict] = useState<string | null>(null);
  const files = changes.data?.files.length ?? 0;
  const merge = async (resolve: boolean): Promise<void> => {
    try {
      const r = await call('cards.merge', { id: card.id, resolve });
      setConfirming(false);
      setConflict(null);
      if (r.commit) toast(`Merged into ${wt.base} (${r.commit}).`);
      else {
        toast(`The merge is waiting in the project folder: resolve ${r.conflicts.length === 1 ? 'its 1 conflicted file' : `its ${r.conflicts.length} conflicted files`} in Changes.`);
        window.location.hash = gitHref(projectKey, 'changes');
      }
    } catch (error) {
      const e = error as Error & { code?: string };
      setConfirming(false);
      if (e.code === 'conflict') setConflict(e.message); else fail(e.message);
    }
  };
  const conflictFiles = conflict?.match(/It conflicted in (.+)\.$/)?.[1] ?? null;
  const agent = card.holder && LIVE_STATES.has(card.holder.state) ? card.holder.sessionId : card.live?.sessionId ?? null;
  const ask = async (): Promise<void> => {
    const text = `Merging ${wt.branch} into ${wt.base} conflicts${conflictFiles ? ` in ${conflictFiles}` : ''}. Please bring ${wt.base} into your branch (git merge ${wt.base}), resolve the conflicts there keeping both changes where they make sense, run the tests, and commit, so ${card.key} merges cleanly.`;
    const r = agent
      ? await attempt(() => call('sessions.queue', { id: agent, text }), fail).then((x) => x && 'Asked the agent: it gets the message when it is next idle.')
      : await attempt(() => call('cards.comment', { id: card.id, body: text }), fail).then((x) => x && 'No session is running on it: the request is on the card, for the next one.');
    if (r) { toast(r); setConflict(null); }
  };
  return (
    <section className="drawer-section">
      <h3>Branch</h3>
      <p className="branch-line">
        <span className="mono">{wt.branch}</span>
        <span className="faint small">from {wt.base}</span>
      </p>
      {changes.error ? (
        <div role="alert">
          <p className="error-text">{changes.error.message}</p>
          <Button size="s" tone="quiet" onClick={changes.reload}>Retry</Button>
        </div>
      ) : !changes.data ? <p className="faint small">Reading changes…</p> : (
        <p className="changes-pointer">
          <a href={branchHref(projectKey, card.key)}>{files === 1 ? '1 file' : `${files} files`} changed on this branch</a>
          {changes.data.additions ? <span className="add">+{changes.data.additions}</span> : null}
          {changes.data.deletions ? <span className="del">−{changes.data.deletions}</span> : null}
        </p>
      )}
      <div className="row-gap branch-actions">
        {confirming ? (
          <>
            <span className="small">Merge {wt.branch} into {wt.base} in {projectKey}’s folder?</span>
            <Button size="s" tone="primary" onClick={() => merge(false)}>Merge</Button>
            <Button size="s" tone="quiet" onClick={() => setConfirming(false)}>Cancel</Button>
          </>
        ) : (
          <>
            <Button size="s" onClick={() => setConfirming(true)} disabled={!!card.live || folderAgents.length > 0}
              title={card.live ? 'Stop the session first' : folderAgents.length ? `${folderAgents.map((s) => s.title).join(' and ')} ${folderAgents.length === 1 ? 'is' : 'are'} working in the project folder, and merging would change the files under ${folderAgents.length === 1 ? 'it' : 'them'}. Merge when ${folderAgents.length === 1 ? 'it stops' : 'they stop'}.` : undefined}>
              Merge into {wt.base}
            </Button>
            <Button size="s" tone="quiet" disabled={!!card.live} title={card.live ? 'Stop the session first' : undefined}
              onClick={() => setRemoving(true)}>
              Remove branch
            </Button>
          </>
        )}
      </div>
      {removing ? (
        <Confirm title="Remove branch and worktree?" act="Remove branch and worktree" danger onClose={() => setRemoving(false)}
          onAct={() => attempt(() => call('cards.removeWorktree', { id: card.id }), fail).then((r) => {
            if (r) { setRemoving(false); toast(`${wt.branch} removed.`); }
          })}>
          <p>Remove <span className="mono">{wt.branch}</span> and its worktree? Git refuses if there are unmerged commits or uncommitted changes.</p>
          <p className="mono small">{wt.path}</p>
        </Confirm>
      ) : null}
      {conflict ? (
        <div className="merge-conflict" role="alert">
          <p className="small">
            <strong>Merging {wt.branch} into {wt.base} conflicts{conflictFiles ? <> in <span className="mono">{conflictFiles}</span></> : null}.</strong>
            {' '}Git undid it, so nothing changed. Resolve it in the project folder, ask the agent to bring {wt.base} into its branch, or leave the branch as it is.
          </p>
          <div className="row-gap merge-conflict-actions">
            <Button size="s" tone="primary" onClick={() => merge(true)} title="Merge again, and leave the conflicts in the project folder to resolve in Changes">Resolve the conflicts</Button>
            <Button size="s" tone="quiet" icon="send" onClick={ask} title={agent ? 'Queue a message to its session: bring the base in, resolve on its branch, commit' : 'No session is running on it: the request goes on the card'}>Ask the agent</Button>
            <Button size="s" tone="quiet" onClick={() => setConflict(null)}>Leave the branch alone</Button>
          </div>
        </div>
      ) : null}
      {card.status === 'done' ? <PullRequest card={card} /> : null}
      <p className="faint small mono branch-path">{wt.path}</p>
    </section>
  );
}

/**
 * Ship an approved card: push its branch to origin and open a pull request with
 * the owner's gh. It says exactly what goes where before anything is pushed.
 */
function PullRequest({ card }: { card: CardDetail }) {
  const toast = useToast();
  const fail = (m: string): void => toast(m, 'error');
  const [plan, setPlan] = useState<PullRequestPlan | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setPlan(null); }, [card.id]);

  if (card.pullRequest) {
    return (
      <p className="branch-pr">
        <Icon name="link" size={14} />
        <span>Pull request</span>
        <a href={card.pullRequest} target="_blank" rel="noreferrer" className="mono">{card.pullRequest}</a>
      </p>
    );
  }
  if (!plan) {
    return (
      <div className="row-gap branch-actions">
        <Button size="s" icon="send" disabled={busy} onClick={() => {
          setBusy(true);
          void attempt(() => call('cards.pullRequestPlan', { id: card.id }), fail).then((p) => { setBusy(false); if (p) setPlan(p); });
        }}>Open a pull request…</Button>
      </div>
    );
  }
  return (
    <div className="pr-confirm">
      {plan.refusal ? <p className="small error-text">{plan.refusal}</p> : (
        <p className="small">
          Push <span className="mono">{plan.branch}</span> ({plural(plan.ahead, 'commit')} not in {plan.base}) to origin,{' '}
          <span className="mono">{plan.remote}</span>, then open a pull request into <span className="mono">{plan.base}</span> titled
          “{plan.title}”, with the card’s description, criteria and evidence as its body. GitHub sees it at once; nothing is merged.
        </p>
      )}
      <div className="row-gap">
        {!plan.refusal ? (
          <Button size="s" tone="primary" disabled={busy} onClick={() => {
            setBusy(true);
            void attempt(() => call('cards.openPullRequest', { id: card.id }), fail).then((r) => {
              setBusy(false);
              setPlan(null);
              if (r) toast(`Pull request opened: ${r.url}`);
            });
          }}>{busy ? 'Pushing…' : 'Push and open'}</Button>
        ) : null}
        <Button size="s" tone="quiet" onClick={() => setPlan(null)}>{plan.refusal ? 'Close' : 'Cancel'}</Button>
      </div>
    </div>
  );
}
